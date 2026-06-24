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

  var MIX_SECONDS = 19 * 60;        // target tape length
  var SAVE_WINDOW = 30;             // seconds to save before it explodes
  // debug hook: ?mix=SECONDS&save=SECONDS to test the full finish/save flow quickly
  try {
    var _q = new URLSearchParams(location.search);
    if (_q.get('mix')) MIX_SECONDS = parseInt(_q.get('mix'), 10) || MIX_SECONDS;
    if (_q.get('save')) SAVE_WINDOW = parseInt(_q.get('save'), 10) || SAVE_WINDOW;
  } catch (e) {}
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
  var canvas = root.querySelector('.bb__screen canvas');
  var cctx = canvas.getContext('2d');
  var elTime = root.querySelector('.bb__time');
  var elStatus = root.querySelector('.bb__status');
  var elVU = root.querySelector('.bb__vu');
  var btnPlay = root.querySelector('.bb__btn--play');
  var btnNew = root.querySelector('.bb__btn--new');
  var volRange = root.querySelector('[data-ctl="volume"]');
  var spdRange = root.querySelector('[data-ctl="speed"]');
  var volOut = root.querySelector('[data-out="volume"]');
  var spdOut = root.querySelector('[data-out="speed"]');

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
    var seq = [], used = {};
    // start on a low-energy clip
    var start = pool.reduce(function (m, c) { return c.e < m.e ? c : m; }, pool[0]);
    seq.push(start); used[start.id] = 1;
    var total = start.dur;
    while (total < MIX_SECONDS) {
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
    // compute xfades + schedule times
    var out = [], at = 0;
    for (var s = 0; s < seq.length; s++) {
      var c = seq[s];
      var xf = 0;
      if (s > 0) {
        var db = Math.abs(eff(seq[s - 1].bpm) - eff(c.bpm));
        xf = db < 6 ? 3 : db < 14 ? 2 : db < 28 ? 1.2 : 0.6;
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
    masterGain.connect(ctx.destination);
    // a light analyser for the VU meter
    analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    masterGain.connect(analyser);
  }
  var analyser = null, vuData = null;

  // schedule the whole sequence from a given elapsed `offset` (seconds)
  function schedule(fromOffset) {
    stopSources();
    var now = ctx.currentTime + 0.06;
    t0 = now - fromOffset / speed;
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
  function kb() { var a = visRand(); return { z0: 1.05 + visRand() * 0.05, z1: 1.15 + visRand() * 0.06, px: Math.cos(a * 6.28) * 0.05, py: Math.sin(a * 6.28) * 0.05 }; }
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

  var SWAP_EVERY = 7; // seconds between art changes
  function renderVisual(elapsed) {
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    var now = elapsed;
    if (!vis.cur) { vis.cur = getImg(pickArt(currentEnergy(now)).disp); vis.curKB = kb(); vis.curBorn = now; vis.lastSwap = now; }
    // time to swap?
    if (now - vis.lastSwap > SWAP_EVERY && !vis.next) {
      vis.next = getImg(pickArt(currentEnergy(now)).disp); vis.nextKB = kb(); vis.nextStart = now;
    }
    var curLife = Math.min(1, (now - vis.curBorn) / (SWAP_EVERY + 2));
    drawCover(vis.cur, vis.curKB, curLife, 1);
    if (vis.next) {
      var p = Math.min(1, (now - vis.nextStart) / 1.6); // 1.6s dissolve
      drawCover(vis.next, vis.nextKB, Math.min(1, (now - vis.nextStart) / (SWAP_EVERY + 2)), p);
      if (p >= 1) { vis.cur = vis.next; vis.curKB = vis.nextKB; vis.curBorn = vis.nextStart; vis.next = null; vis.lastSwap = now; }
    }
  }

  // ---------- main loop ----------
  function fmt(s) { s = Math.max(0, Math.floor(s)); var m = Math.floor(s / 60); return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); }
  function setStatus(s) { if (elStatus) elStatus.textContent = s; }
  function tick() {
    if (!playing) return;
    var elapsed = (ctx.currentTime - t0) * speed;
    if (elapsed >= MIX_SECONDS) { finishMix(); return; }
    renderVisual(elapsed);
    elTime.textContent = fmt(elapsed) + ' / ' + fmt(MIX_SECONDS);
    drawVU();
    rafId = requestAnimationFrame(tick);
  }
  function drawVU() {
    if (!analyser || !elVU) return;
    if (!vuData) vuData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(vuData);
    var bars = elVU.children, n = bars.length;
    var avg = 0; for (var i = 0; i < vuData.length; i++) avg += vuData[i]; avg /= vuData.length;
    var lvl = Math.min(n, Math.round(avg / 255 * n * 1.8));
    for (var b = 0; b < n; b++) {
      bars[b].className = b < lvl ? (b > n - 3 ? 'hot' : 'on') : '';
    }
  }

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
    playing = false; cancelAnimationFrame(rafId);
    root.classList.remove('is-playing'); btnPlay.classList.remove('is-playing');
    setStatus('PAUSE'); setPlayIcon(false);
  }
  function resume() {
    ensureCtx(); if (ctx.state === 'suspended') ctx.resume();
    schedule(offset);
    playing = true; root.classList.add('is-playing'); btnPlay.classList.add('is-playing');
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
  if (btnNew) btnNew.addEventListener('click', function () { stopSources(); started = false; startNewMix(); });

  // volume + speed
  function applyVolume() { if (masterGain) masterGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02); }
  volRange.addEventListener('input', function () {
    volume = parseFloat(volRange.value); volOut.textContent = Math.round(volume * 100) + '%'; applyVolume();
  });
  spdRange.addEventListener('input', function () {
    var was = playing ? (ctx.currentTime - t0) * speed : offset;
    speed = parseFloat(spdRange.value); spdOut.textContent = speed.toFixed(2) + '×';
    sources.forEach(function (s) { try { s.playbackRate.setTargetAtTime(speed, ctx.currentTime, 0.05); } catch (e) {} });
    // reschedule so timing stays correct at the new rate
    if (playing) { offset = was; schedule(offset); }
  });

  // ---------- finish + ephemeral save ----------
  function finishMix() {
    playing = false; ended = true; cancelAnimationFrame(rafId); stopSources();
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

  // init control labels + shelf
  volRange.value = volume; volOut.textContent = Math.round(volume * 100) + '%';
  spdRange.value = speed; spdOut.textContent = speed.toFixed(2) + '×';
  setPlayIcon(false);
  renderShelf();
})();
