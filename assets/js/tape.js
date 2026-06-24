/*
 * tape.js — the Tape Deck engine.
 *
 * Each play builds a GENUINELY NEW ~19-minute mix in the browser from the source
 * clips (Web Audio API): a seeded random sequence ordered for tempo/energy
 * coherence, with beat-aware crossfades. The central boombox screen shows the
 * artwork, mood-matched to the current clip's energy, with Ken-Burns drift and a
 * soft dissolve between pieces. Controls: Play<->Pause, Volume, Speed.
 *
 * If a listener hears the full ~19 minutes, they get 30s to name & save the mix
 * (we persist its SEED + sequence so it can be replayed identically); otherwise it
 * "explodes" and is gone for good.
 *
 * No dependencies. Driven by #tape-deck markup on /tape-deck.
 */
(function () {
  'use strict';

  var root = document.getElementById('tape-deck');
  if (!root) return;

  var MIX_SECONDS = 19 * 60;        // target tape length (always the full 19 min)
  var SAVE_WINDOW = 30;             // seconds to save before it explodes
  var BASE = root.getAttribute('data-base') || '/assets/tape/';

  // ---------- tiny seeded RNG (mulberry32) so a mix is reproducible from a seed ----------
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function newSeed() { return (Math.floor((Date.now() % 1e9) + Math.random() * 1e9)) >>> 0; }

  // ---------- state ----------
  var clips = [], art = [];
  var ctx = null, masterGain = null;
  var sequence = [];          // [{clip, startAt, dur, xfade}]
  var sources = [];           // scheduled AudioBufferSourceNodes
  var buffers = {};           // id -> decoded AudioBuffer (cache)
  var playing = false, started = false;
  var seedCur = 0;
  var t0 = 0;                 // ctx time when current mix (re)started
  var offset = 0;            // seconds already elapsed (for pause/resume)
  var rafId = null;
  var ended = false;
  var speed = 1, volume = 0.85;

  // ---------- DOM ----------
  var canvas = root.querySelector('.tape-stage__canvas') || root.querySelector('canvas');
  var cctx = canvas.getContext('2d');
  var elTime = root.querySelector('.bb__time');
  var elStatus = root.querySelector('.bb__status');
  var elVU = root.querySelector('.bb__vu');
  var btnPlay = root.querySelector('.bb__btn--play');
  var btnNew = root.querySelector('.bb__btn--new');
  var idle = root.querySelector('.tape-stage__idle');
  var btnFs = root.querySelector('.tape-fs');

  // ---------- load manifests ----------
  Promise.all([
    fetch(BASE + 'clips.json').then(function (r) { return r.json(); }),
    fetch(BASE + 'art.json').then(function (r) { return r.json(); })
  ]).then(function (res) {
    clips = res[0].clips || [];
    art = res[1].art || [];
    fitCanvas();
    drawIdle();
  }).catch(function () { setStatus('LOAD ERROR'); });

  // ---------- sequencing: build a coherent ~19min order from a seed ----------
  function eff(b) { while (b > 160) b /= 2; while (b < 80) b *= 2; return b; }
  function cost(a, b) {
    var db = Math.abs(eff(a.bpm) - eff(b.bpm));
    var de = Math.abs(a.e - b.e) * 140;
    var dbr = Math.abs(a.bright - b.bright) / 70;
    return db * 2.2 + de + dbr;
  }
  function buildSequence(seed) {
    var rand = rng(seed);
    var pool = clips.slice();
    // shuffle (seeded) then greedy nearest-neighbour for smoothness, with a gentle
    // energy arc so the tape breathes (calm -> peak -> calm), like the Journey mix.
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    function arc(p) { return 0.15 + 0.8 * Math.sin(Math.min(p, 0.85) / 0.85 * Math.PI * 0.92); }

    // The X/Twitter clip must always land in the first 3–6 minutes. Pull it out of
    // the normal greedy fill, and inject it once the running time crosses a seeded
    // target inside that window.
    var FEATURE_ID = 'xtwittermfrst';
    var featureClip = null;
    pool = pool.filter(function (c) { if (c.id === FEATURE_ID) { featureClip = c; return false; } return true; });
    // Target window 3:00–6:00. We inject the clip on the first iteration AFTER the
    // running total passes `featureAt`, so placement can overshoot by up to one
    // clip-length (~60s); aim the target at 185–290s so the actual start stays
    // comfortably inside the 180–360s window.
    var featureAt = featureClip ? (185 + rand() * 105) : -1;
    var featurePlaced = !featureClip;

    var seq = [], used = {};
    // start on a low-energy clip
    var start = pool.reduce(function (m, c) { return c.e < m.e ? c : m; }, pool[0]);
    seq.push(start); used[start.id] = 1;
    var total = start.dur;
    while (total < MIX_SECONDS) {
      // inject the feature clip when we reach its target time
      if (!featurePlaced && total >= featureAt) {
        seq.push(featureClip); used[featureClip.id] = 1; total += featureClip.dur; featurePlaced = true;
        continue;
      }
      var last = seq[seq.length - 1], pos = total / MIX_SECONDS, best = null, bestC = 1e9;
      for (var k = 0; k < pool.length; k++) {
        var c = pool[k];
        // allow reuse once we've run through everything, but never twice in a row
        var penalty = used[c.id] ? 60 : 0;
        if (c.id === last.id) continue;
        var sc = cost(last, c) + Math.abs(c.e - arc(pos)) * 120 + penalty + rand() * 8;
        if (sc < bestC) { bestC = sc; best = c; }
      }
      if (!best) break;
      seq.push(best); used[best.id] = (used[best.id] || 0) + 1; total += best.dur;
    }
    // safety: if the mix somehow ended before the window (shouldn't at 19 min), force it in
    if (!featurePlaced && featureClip) { seq.splice(Math.min(seq.length, 4), 0, featureClip); }
    // compute xfades + schedule times
    var out = [], at = 0;
    for (var s = 0; s < seq.length; s++) {
      var c = seq[s];
      var xf = 0;
      if (s > 0) {
        var db = Math.abs(eff(seq[s - 1].bpm) - eff(c.bpm));
        xf = db < 6 ? 1.5 : db < 14 ? 1 : db < 28 ? 0.6 : 0.3;
      }
      at -= xf; // overlap by the crossfade
      out.push({ clip: c, startAt: Math.max(0, at), dur: c.dur, xfade: xf });
      at += c.dur;
    }
    return out;
  }

  // ---------- audio loading / decoding ----------
  function loadBuffer(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    return fetch(BASE + 'clips/' + id + '.mp3')
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) { buffers[id] = buf; return buf; });
  }

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    // Gentle master "glue" limiter: catches the brief peak summing that happens when
    // two clips overlap during a crossfade, so transitions don't jump in level. Soft
    // knee, slow-ish attack/release so it's transparent, not pumping.
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;   // only acts on the loud overlap peaks
    comp.knee.value = 24;         // soft knee = transparent
    comp.ratio.value = 3;         // gentle
    comp.attack.value = 0.012;
    comp.release.value = 0.30;
    masterGain.connect(comp);
    comp.connect(ctx.destination);
    // analyser taps the post-limiter signal for the VU meter
    analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    comp.connect(analyser);
  }
  var analyser = null, vuData = null, comp = null;

  var FADE_IN = 6; // seconds — every mix eases up from silence
  // schedule the whole sequence from a given elapsed `offset` (seconds)
  function schedule(fromOffset) {
    stopSources();
    var now = ctx.currentTime + 0.06;
    t0 = now - fromOffset / speed;
    // gentle master fade-in when a mix starts from the very beginning (not on
    // pause/resume or seek, which schedule from a non-zero offset).
    if (masterGain) {
      masterGain.gain.cancelScheduledValues(now);
      if (fromOffset <= 0.05) {
        masterGain.gain.setValueAtTime(0.0001, now);
        masterGain.gain.linearRampToValueAtTime(volume, now + FADE_IN);
      } else {
        masterGain.gain.setValueAtTime(volume, now);
      }
    }
    sequence.forEach(function (seg) {
      var segStart = seg.startAt, segEnd = seg.startAt + seg.dur;
      if (segEnd <= fromOffset) return;            // already past
      var buf = buffers[seg.clip.id];
      if (!buf) return;                            // not loaded yet (will be on replay)
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;
      var g = ctx.createGain();
      src.connect(g); g.connect(masterGain);
      // crossfade envelope (equal-power-ish via linear ramps on gain)
      var startInClip = Math.max(0, fromOffset - segStart);
      var when = now + Math.max(0, (segStart - fromOffset)) / speed;
      var xf = Math.max(0.25, seg.xfade);
      g.gain.setValueAtTime(startInClip > 0 ? 1 : 0.0001, when);
      if (startInClip <= 0.01) g.gain.linearRampToValueAtTime(1, when + xf / speed);
      // fade out at end
      var fadeOutAt = when + (seg.dur - startInClip - xf) / speed;
      g.gain.setValueAtTime(1, Math.max(when, fadeOutAt));
      g.gain.linearRampToValueAtTime(0.0001, fadeOutAt + xf / speed);
      try { src.start(when, startInClip); } catch (e) {}
      try { src.stop(when + (seg.dur - startInClip) / speed + 0.05); } catch (e) {}
      sources.push(src);
    });
  }
  function stopSources() {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    sources = [];
  }

  // ---------- render the CURRENT mix offline -> MP3 -> download ----------
  // Re-runs the exact same sequence (same seed) in an OfflineAudioContext, mirroring
  // the live crossfade scheduling, then encodes the result to MP3 with lamejs.
  function renderMixToMp3(onProgress) {
    var SR = 44100, CH = 2;
    var total = MIX_SECONDS;
    var oac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(CH, Math.ceil(total * SR), SR);
    var master = oac.createGain();
    // same gentle fade-in as live playback, baked into the file
    master.gain.setValueAtTime(0.0001, 0);
    master.gain.linearRampToValueAtTime(volume, FADE_IN);
    var c = oac.createDynamicsCompressor();
    c.threshold.value = -12; c.knee.value = 24; c.ratio.value = 3; c.attack.value = 0.012; c.release.value = 0.30;
    master.connect(c); c.connect(oac.destination);
    // schedule every segment (speed fixed at 1 for the file)
    sequence.forEach(function (seg) {
      var buf = buffers[seg.clip.id];
      if (!buf) return;
      var src = oac.createBufferSource(); src.buffer = buf;
      var g = oac.createGain(); src.connect(g); g.connect(master);
      var when = seg.startAt;
      var xf = Math.max(0.25, seg.xfade);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(1, when + xf);
      var fadeOutAt = when + (seg.dur - xf);
      g.gain.setValueAtTime(1, Math.max(when, fadeOutAt));
      g.gain.linearRampToValueAtTime(0.0001, fadeOutAt + xf);
      try { src.start(when, 0, seg.dur); } catch (e) {}
    });
    return oac.startRendering().then(function (rendered) {
      // encode to MP3 (chunked, with progress), then free the buffer
      return encodeMp3(rendered, onProgress);
    });
  }

  function encodeMp3(audioBuffer, onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) { reject(new Error('encoder missing')); return; }
      var ch = Math.min(2, audioBuffer.numberOfChannels);
      var L = audioBuffer.getChannelData(0);
      var R = ch > 1 ? audioBuffer.getChannelData(1) : L;
      var n = L.length;
      var enc = new lamejs.Mp3Encoder(2, audioBuffer.sampleRate, 128);
      var BLOCK = 1152, parts = [], i = 0;
      function f2i(x) { x = x < -1 ? -1 : x > 1 ? 1 : x; return x < 0 ? x * 0x8000 : x * 0x7FFF; }
      function step() {
        var end = Math.min(i + BLOCK * 200, n); // ~200 frames per tick to stay responsive
        while (i < end) {
          var len = Math.min(BLOCK, n - i);
          var lc = new Int16Array(len), rc = new Int16Array(len);
          for (var k = 0; k < len; k++) { lc[k] = f2i(L[i + k]); rc[k] = f2i(R[i + k]); }
          var mp3 = enc.encodeBuffer(lc, rc);
          if (mp3.length) parts.push(new Int8Array(mp3));
          i += len;
        }
        if (onProgress) onProgress(i / n);
        if (i < n) { setTimeout(step, 0); }
        else {
          var last = enc.flush(); if (last.length) parts.push(new Int8Array(last));
          resolve(new Blob(parts, { type: 'audio/mpeg' }));
        }
      }
      step();
    });
  }

  // preload buffers for the sequence (first several eagerly, rest in background)
  function preloadSequence() {
    var ids = [];
    sequence.forEach(function (s) { if (ids.indexOf(s.clip.id) < 0) ids.push(s.clip.id); });
    // load first 4 before we start, rest lazily
    var head = ids.slice(0, 4), tail = ids.slice(4);
    return Promise.all(head.map(loadBuffer)).then(function () {
      tail.reduce(function (p, id) { return p.then(function () { return loadBuffer(id).catch(function () {}); }); }, Promise.resolve());
    });
  }

  // ---------- visuals (central screen) ----------
  var W = 0, H = 0, dpr = 1;
  function fitCanvas() {
    var r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', function () { fitCanvas(); if (!playing) drawIdle(); });

  function drawIdle() {
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    cctx.fillStyle = '#0c1a14'; cctx.fillRect(0, 0, W, H);
  }

  // pick the artwork best matching a target energy (mood-match), seeded
  var visRand = Math.random;
  function pickArt(targetE) {
    // candidates sorted by closeness to targetE, take a random one of the closest few
    var scored = art.map(function (a) { return { a: a, d: Math.abs(a.energy - targetE) + visRand() * 0.12 }; });
    scored.sort(function (x, y) { return x.d - y.d; });
    return scored[Math.floor(visRand() * Math.min(6, scored.length))].a;
  }

  // visual state: current + incoming image with Ken-Burns + dissolve
  var imgCache = {};
  function getImg(src) {
    if (imgCache[src]) return imgCache[src];
    var im = new Image(); im.src = src; imgCache[src] = im; return im;
  }
  var vis = { cur: null, curKB: null, curBorn: 0, next: null, nextKB: null, nextStart: 0, lastSwap: 0 };
  // slow, floaty Ken-Burns: very gentle zoom + slow pan in a random direction
  function kb() { var a = visRand(); return { z0: 1.04 + visRand() * 0.03, z1: 1.12 + visRand() * 0.05, px: Math.cos(a * 6.28) * 0.04, py: Math.sin(a * 6.28) * 0.035 }; }
  function drawCover(im, k, t, alpha) {
    if (!im || !im.complete || !im.naturalWidth) return;
    var z = k.z0 + (k.z1 - k.z0) * t;
    var ir = im.naturalWidth / im.naturalHeight, br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    var dw = bw * z, dh = bh * z;
    var panX = (k.px * t - k.px * 0.5) * W, panY = (k.py * t - k.py * 0.5) * H;
    cctx.save(); cctx.globalAlpha = alpha;
    cctx.drawImage(im, (W - dw) / 2 + panX, (H - dh) / 2 + panY, dw, dh);
    cctx.restore();
  }

  function currentEnergy(elapsed) {
    // energy of the clip currently sounding
    for (var i = 0; i < sequence.length; i++) {
      var s = sequence[i];
      if (elapsed >= s.startAt && elapsed < s.startAt + s.dur) return s.clip.e;
    }
    return 0.4;
  }

  // minimal: each artwork dwells a long while, drifting slowly, with a long soft
  // dissolve to the next. The Ken-Burns `t` runs across the whole dwell+dissolve
  // so motion is continuous and never resets.
  var SWAP_EVERY = 14;   // seconds an image holds before the next begins
  var DISSOLVE = 1.5;    // soft cross-dissolve (2x faster)
  var KB_SPAN = SWAP_EVERY + DISSOLVE + 2;
  function renderVisual(elapsed) {
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    var now = elapsed;
    if (!vis.cur) { vis.cur = getImg(pickArt(currentEnergy(now)).disp); vis.curKB = kb(); vis.curBorn = now; vis.lastSwap = now; }
    if (now - vis.lastSwap > SWAP_EVERY && !vis.next) {
      vis.next = getImg(pickArt(currentEnergy(now)).disp); vis.nextKB = kb(); vis.nextStart = now;
    }
    drawCover(vis.cur, vis.curKB, Math.min(1, (now - vis.curBorn) / KB_SPAN), 1);
    if (vis.next) {
      var p = Math.min(1, (now - vis.nextStart) / DISSOLVE);
      var e = p * p * (3 - 2 * p); // smoothstep
      drawCover(vis.next, vis.nextKB, Math.min(1, (now - vis.nextStart) / KB_SPAN), e);
      if (p >= 1) { vis.cur = vis.next; vis.curKB = vis.nextKB; vis.curBorn = vis.nextStart; vis.next = null; vis.lastSwap = now; }
    }
  }

  // ---------- main loop ----------
  function fmt(s) { s = Math.max(0, Math.floor(s)); var m = Math.floor(s / 60); return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); }
  function setStatus(s) { if (elStatus) elStatus.textContent = s; }
  // one render pass
  function renderFrame() {
    if (!playing) return;
    var elapsed = (ctx.currentTime - t0) * speed;
    if (elapsed >= MIX_SECONDS) { finishMix(); return; }
    renderVisual(elapsed);
    elTime.textContent = fmt(elapsed) + ' / ' + fmt(MIX_SECONDS);
    setSeekUI(elapsed / MIX_SECONDS);
  }
  // drive with rAF when it's running (smooth) AND a timer fallback (survives rAF
  // throttling, e.g. a backgrounded tab — the audio keeps playing regardless).
  function rafLoop() { if (!playing) return; renderFrame(); rafId = requestAnimationFrame(rafLoop); }
  function tick() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(rafLoop);
    if (!tickTimer) tickTimer = setInterval(function () { if (playing) renderFrame(); }, 40);
  }
  var tickTimer = null;

  // ---------- transport ----------
  function startNewMix() {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    ended = false;
    seedCur = newSeed();
    sequence = buildSequence(seedCur);
    vis = { cur: null, curKB: null, curBorn: 0, next: null, nextKB: null, nextStart: 0, lastSwap: 0 };
    offset = 0;
    root.classList.add('is-started');
    setStatus('MIXING…');
    preloadSequence().then(function () {
      schedule(0);
      playing = true; started = true;
      root.classList.add('is-playing'); btnPlay.classList.add('is-playing');
      setStatus('PLAY');
      setPlayIcon(true);
      tick();
    });
  }
  function pause() {
    if (!playing) return;
    offset = (ctx.currentTime - t0) * speed;
    stopSources();
    playing = false; cancelAnimationFrame(rafId); clearInterval(tickTimer); tickTimer = null;
    root.classList.remove('is-playing'); root.classList.add('is-paused'); btnPlay.classList.remove('is-playing');
    setStatus('PAUSE'); setPlayIcon(false);
  }
  function resume() {
    ensureCtx(); if (ctx.state === 'suspended') ctx.resume();
    schedule(offset);
    playing = true; root.classList.add('is-playing'); root.classList.remove('is-paused'); btnPlay.classList.add('is-playing');
    setStatus('PLAY'); setPlayIcon(true); tick();
  }
  function togglePlay() {
    if (!started || ended) { startNewMix(); return; }
    if (playing) pause(); else resume();
  }

  function setPlayIcon(isPlaying) {
    btnPlay.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>';
  }

  btnPlay.addEventListener('click', togglePlay);
  if (btnNew) btnNew.addEventListener('click', function () { stopSources(); started = false; root.classList.remove('is-paused'); startNewMix(); });
  // the big idle overlay also starts playback (click anywhere on the dark screen)
  if (idle) idle.addEventListener('click', function () { if (!started) startNewMix(); });
  // clicking the art itself toggles play/pause once started (but not the control bar)
  canvas.addEventListener('click', function () { if (started && !ended) togglePlay(); });

  // briefly reveal the control bar on any pointer move over the stage, then auto-hide
  var barHideTimer = null;
  root.addEventListener('pointermove', function () {
    root.classList.add('bar-show');
    clearTimeout(barHideTimer);
    barHideTimer = setTimeout(function () { if (playing) root.classList.remove('bar-show'); }, 2200);
  });

  // fullscreen toggle
  if (btnFs) btnFs.addEventListener('click', function (e) {
    e.stopPropagation();
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else {
      var fn = root.requestFullscreen || root.webkitRequestFullscreen;
      if (fn) { try { var p = fn.call(root); if (p && p.catch) p.catch(function () {}); } catch (x) {} }
    }
  });
  function onFs() { root.classList.toggle('is-fullscreen', !!(document.fullscreenElement === root || document.webkitFullscreenElement === root)); fitCanvas(); }
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);

  // ---------- download the current mix as MP3 ----------
  var btnDl = root.querySelector('.tape-dl');
  var downloading = false;
  function downloadCurrentMix() {
    if (downloading) return;
    if (!started || !sequence.length) { setStatus('PRESS PLAY FIRST'); return; }
    downloading = true;
    if (btnDl) btnDl.classList.add('is-busy');
    var wasStatus = elStatus ? elStatus.textContent : '';
    setStatus('PREP 0%');
    // make sure every clip in the sequence is decoded before offline render
    var ids = []; sequence.forEach(function (s) { if (ids.indexOf(s.clip.id) < 0) ids.push(s.clip.id); });
    Promise.all(ids.map(function (id) { return loadBuffer(id).catch(function () {}); }))
      .then(function () {
        setStatus('RENDERING…');
        return renderMixToMp3(function (p) { setStatus('ENCODING ' + Math.round(p * 100) + '%'); });
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var name = 'pete-tape-' + String(seedCur >>> 0) + '.mp3';
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        setStatus('DOWNLOADED');
        setTimeout(function () { if (elStatus && elStatus.textContent === 'DOWNLOADED') setStatus(playing ? 'PLAY' : 'PAUSE'); }, 2500);
      })
      .catch(function (e) { setStatus('DL FAILED'); })
      .then(function () { downloading = false; if (btnDl) btnDl.classList.remove('is-busy'); });
  }
  if (btnDl) btnDl.addEventListener('click', function (e) { e.stopPropagation(); downloadCurrentMix(); });

  // ---------- seek bar: click / drag to skip through the mix ----------
  var seek = root.querySelector('.tape-bar__seek');
  var seekFill = root.querySelector('.tape-bar__seek-fill');
  var seekKnob = root.querySelector('.tape-bar__seek-knob');
  function setSeekUI(frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (seekFill) seekFill.style.width = (frac * 100) + '%';
    if (seekKnob) seekKnob.style.left = (frac * 100) + '%';
    if (seek) seek.setAttribute('aria-valuenow', Math.round(frac * 100));
  }
  function seekTo(sec) {
    sec = Math.max(0, Math.min(MIX_SECONDS - 0.5, sec));
    offset = sec;
    setSeekUI(sec / MIX_SECONDS);
    elTime.textContent = fmt(sec) + ' / ' + fmt(MIX_SECONDS);
    // jump the art to the right mood for the new position
    vis = { cur: null, curKB: null, curBorn: 0, next: null, nextKB: null, nextStart: 0, lastSwap: 0 };
    if (started && !ended) {
      // load any clips needed around the new position, then reschedule from there
      ensureBuffersAround(sec).then(function () {
        if (playing) { schedule(sec); }   // resume from new point (t0 re-anchored in schedule)
        else { /* stay paused but remember new offset */ }
        renderVisual(sec);
      });
    }
  }
  // make sure the clips overlapping `sec` are decoded before we schedule from there
  function ensureBuffersAround(sec) {
    var need = [];
    sequence.forEach(function (s) {
      if (s.startAt < sec + 8 && s.startAt + s.dur > sec - 1 && !buffers[s.clip.id]) need.push(s.clip.id);
    });
    return Promise.all(need.map(function (id) { return loadBuffer(id).catch(function () {}); }));
  }
  if (seek) {
    var dragging = false;
    function fracFromEvent(e) {
      var r = seek.getBoundingClientRect();
      var x = (e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
      return (x - r.left) / r.width;
    }
    seek.addEventListener('pointerdown', function (e) {
      e.stopPropagation(); dragging = true; seek.classList.add('is-dragging');
      try { seek.setPointerCapture(e.pointerId); } catch (x) {}
      setSeekUI(fracFromEvent(e));
    });
    seek.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      setSeekUI(fracFromEvent(e));
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false; seek.classList.remove('is-dragging');
      seekTo(Math.max(0, Math.min(1, fracFromEvent(e))) * MIX_SECONDS);
    }
    seek.addEventListener('pointerup', endDrag);
    seek.addEventListener('pointercancel', endDrag);
    // keyboard: arrows nudge ±10s, Home/End jump
    seek.addEventListener('keydown', function (e) {
      if (!started) return;
      var cur = playing ? (ctx.currentTime - t0) * speed : offset;
      if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(cur + 10); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(cur - 10); }
      else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
      else if (e.key === 'End') { e.preventDefault(); seekTo(MIX_SECONDS - 30); }
    });
  }

  // ---------- finish + ephemeral save ----------
  function finishMix() {
    playing = false; ended = true; cancelAnimationFrame(rafId); clearInterval(tickTimer); tickTimer = null; stopSources();
    root.classList.remove('is-playing'); btnPlay.classList.remove('is-playing'); setPlayIcon(false);
    setStatus('SIDE A END'); elTime.textContent = fmt(MIX_SECONDS) + ' / ' + fmt(MIX_SECONDS);
    openSaveWindow();
  }

  var saveEl = document.querySelector('.tape-save');
  var boomEl = document.querySelector('.tape-boom');
  var saveTimer = null;
  function openSaveWindow() {
    if (!saveEl) return;
    saveEl.classList.add('is-open');
    var input = saveEl.querySelector('input'); input.value = '';
    var timerEl = saveEl.querySelector('.tape-save__timer');
    var left = SAVE_WINDOW, deadline = Date.now() + SAVE_WINDOW * 1000;
    timerEl.textContent = left + 's';
    input.focus();
    clearInterval(saveTimer);
    saveTimer = setInterval(function () {
      left = Math.ceil((deadline - Date.now()) / 1000);
      timerEl.textContent = Math.max(0, left) + 's';
      if (left <= 0) { clearInterval(saveTimer); explode(); }
    }, 200);
    saveEl.querySelector('.tape-save__keep').onclick = function () {
      var name = (input.value || '').trim() || ('Tape ' + new Date().toLocaleDateString());
      saveTape(name, seedCur);
      clearInterval(saveTimer); saveEl.classList.remove('is-open'); renderShelf();
      setStatus('SAVED: ' + name.toUpperCase().slice(0, 16));
    };
    saveEl.querySelector('.tape-save__let').onclick = function () { clearInterval(saveTimer); explode(); };
  }
  function explode() {
    if (saveEl) saveEl.classList.remove('is-open');
    if (boomEl) {
      boomEl.classList.add('is-on');
      setTimeout(function () { boomEl.classList.remove('is-on'); }, 700);
    }
    setStatus('LOST FOREVER');
    seedCur = 0; // the mix is gone
  }

  // saved tapes: persist {name, seed}. Replaying a seed rebuilds the identical mix.
  var SHELF_KEY = 'tape-deck-saved-v1';
  function getSaved() { try { return JSON.parse(localStorage.getItem(SHELF_KEY) || '[]'); } catch (e) { return []; } }
  function saveTape(name, seed) {
    var list = getSaved(); list.unshift({ name: name, seed: seed, at: Date.now() });
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(list.slice(0, 24))); } catch (e) {}
  }
  function playSaved(seed) {
    ensureCtx(); if (ctx.state === 'suspended') ctx.resume();
    stopSources(); ended = false; seedCur = seed;
    sequence = buildSequence(seed);
    vis = { cur: null, curKB: null, curBorn: 0, next: null, nextKB: null, nextStart: 0, lastSwap: 0 };
    offset = 0; root.classList.add('is-started'); setStatus('LOADING…');
    preloadSequence().then(function () {
      schedule(0); playing = true; started = true;
      root.classList.add('is-playing'); btnPlay.classList.add('is-playing'); setStatus('PLAY'); setPlayIcon(true); tick();
    });
  }
  var shelf = document.querySelector('.tape-shelf__list');
  function renderShelf() {
    if (!shelf) return;
    var list = getSaved();
    shelf.innerHTML = '';
    document.querySelector('.tape-shelf').style.display = list.length ? '' : 'none';
    list.forEach(function (t) {
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'tape-cassette';
      el.innerHTML = '<span class="reel"></span>' + escapeHtml(t.name);
      el.addEventListener('click', function () { playSaved(t.seed); });
      shelf.appendChild(el);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // init
  setPlayIcon(false);
  renderShelf();
})();
