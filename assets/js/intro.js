/*
 * intro.js — the homepage art + music explorer (full-screen).
 *
 * The whole library — every artwork plus the abstract drawing time-lapse clips — cycles
 * full-screen with a slow Ken-Burns drift and soft cross-dissolves. A live, tape-deck-
 * style music mix is built in-browser and fades in over 5 seconds when the visitor taps
 * for sound (muted autoplay otherwise — browser policy).
 *
 * A scrub bar lets you move through the artwork at your own pace: drag to jump to any
 * piece; the auto-advance resumes from wherever you land. Music plays underneath as a bed.
 *
 * This IS the homepage (no "enter", no dismiss) — the nav stays on top so the galleries
 * are always reachable. It leaves the #genesis island piece and its soundscape untouched.
 *
 * Driven by #intro markup on the homepage. No dependencies.
 */
(function () {
  'use strict';

  var root = document.getElementById('intro');
  if (!root) return;

  var BASE = root.getAttribute('data-base') || '/assets/tape/';

  // mark the page so CSS can float the site nav transparently over the art and lock scroll
  document.body.classList.add('has-intro');
  document.documentElement.classList.add('intro-locked');

  // ---------- DOM ----------
  var canvas = root.querySelector('.intro__canvas');
  var cctx = canvas.getContext('2d');
  var btnSound = root.querySelector('.intro__sound');
  var seekEl = root.querySelector('.intro__seek');
  var seekFill = root.querySelector('.intro__seek-fill');
  var seekKnob = root.querySelector('.intro__seek-knob');
  var capEl = root.querySelector('.intro__caption');

  // ---------- seeded RNG (mulberry32) ----------
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var seed = (Math.floor((Date.now() % 1e9) + Math.random() * 1e9)) >>> 0;
  var visRand = rng(seed);
  var mixRand = rng((seed ^ 0x9e3779b9) >>> 0);

  // ---------- manifests ----------
  var clips = [], gallery = [];   // gallery = ordered explore list (stills + video clips)
  Promise.all([
    fetch(BASE + 'clips.json').then(function (r) { return r.json(); }),
    fetch(BASE + 'explore.json').then(function (r) { return r.json(); })
  ]).then(function (res) {
    clips = (res[0].clips || []);
    gallery = (res[1].explore || []);
    fitCanvas();
    startVisuals();
  }).catch(function () { /* overlay still shows; visuals just won't run */ });

  // ============================================================
  //  VISUALS — timeline over the whole gallery, scrubbable
  // ============================================================
  var W = 0, H = 0, dpr = 1;
  function fitCanvas() {
    var r = root.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', fitCanvas);

  var mediaCache = {};
  function getMedia(item) {
    var key = item.disp;
    if (mediaCache[key]) return mediaCache[key];
    var el;
    if (item.video) {
      el = document.createElement('video');
      el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
      el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
      if (item.webm) { var sw = document.createElement('source'); sw.src = item.webm; sw.type = 'video/webm'; el.appendChild(sw); }
      var sm = document.createElement('source'); sm.src = item.disp; sm.type = 'video/mp4'; el.appendChild(sm);
      el._isVideo = true; el.play().catch(function () {});
    } else {
      el = new Image(); el.decoding = 'async'; el.src = item.disp;
    }
    mediaCache[key] = el; return el;
  }
  function ready(m) {
    if (!m) return false;
    if (m._isVideo) return m.readyState >= 2 && m.videoWidth > 0;
    return m.complete && m.naturalWidth > 0;
  }
  function mW(m) { return m._isVideo ? m.videoWidth : m.naturalWidth; }
  function mH(m) { return m._isVideo ? m.videoHeight : m.naturalHeight; }

  function kb() {
    var a = visRand();
    return { z0: 1.04 + visRand() * 0.03, z1: 1.12 + visRand() * 0.05, px: Math.cos(a * 6.28) * 0.04, py: Math.sin(a * 6.28) * 0.035 };
  }
  function drawCover(m, k, t, alpha) {
    if (!ready(m)) return;
    if (m._isVideo && m.paused) m.play().catch(function () {});
    var z = k.z0 + (k.z1 - k.z0) * t;
    var ir = mW(m) / mH(m), br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    var dw = bw * z, dh = bh * z;
    var panX = (k.px * t - k.px * 0.5) * W, panY = (k.py * t - k.py * 0.5) * H;
    cctx.save(); cctx.globalAlpha = alpha;
    try { cctx.drawImage(m, (W - dw) / 2 + panX, (H - dh) / 2 + panY, dw, dh); } catch (e) {}
    cctx.restore();
  }

  // timeline state: a current index into `gallery`, with Ken-Burns + dissolve between items.
  var idx = 0;                 // current item index
  var vis = { cur: null, curKB: null, curBorn: 0, next: null, nextIdx: 0, nextKB: null, nextStart: 0 };
  var SWAP_EVERY = 7.0;        // seconds each piece holds before advancing
  var DISSOLVE = 1.4;
  var KB_SPAN = SWAP_EVERY + DISSOLVE + 1.5;
  var clock = 0, lastT = 0, visTimer = null;
  var scrubbing = false;

  function setCaption(item) {
    if (!capEl || !item) return;
    capEl.textContent = item.video ? 'Drawing — time-lapse' : (item.category || '');
  }
  function preloadAround(i) {
    for (var d = 1; d <= 2; d++) {
      var a = gallery[(i + d) % gallery.length], b = gallery[(i - d + gallery.length) % gallery.length];
      if (a) getMedia(a); if (b) getMedia(b);
    }
  }
  // jump straight to an item (used by scrub) — no dissolve, snap to it
  function gotoIndex(i, now) {
    i = ((i % gallery.length) + gallery.length) % gallery.length;
    idx = i;
    vis.cur = getMedia(gallery[i]); vis.curKB = kb(); vis.curBorn = now;
    vis.next = null;
    setCaption(gallery[i]);
    preloadAround(i);
  }

  function renderVisual(now) {
    if (!gallery.length) return;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    if (!vis.cur) { gotoIndex(0, now); }
    // advance automatically (unless actively scrubbing)
    if (!scrubbing && !vis.next && (now - vis.curBorn) > SWAP_EVERY) {
      vis.nextIdx = (idx + 1) % gallery.length;
      vis.next = getMedia(gallery[vis.nextIdx]); vis.nextKB = kb(); vis.nextStart = now;
    }
    drawCover(vis.cur, vis.curKB, Math.min(1, (now - vis.curBorn) / KB_SPAN), 1);
    if (vis.next) {
      var p = Math.min(1, (now - vis.nextStart) / DISSOLVE);
      var e = p * p * (3 - 2 * p);
      drawCover(vis.next, vis.nextKB, Math.min(1, (now - vis.nextStart) / KB_SPAN), e);
      if (p >= 1) {
        idx = vis.nextIdx;
        vis.cur = vis.next; vis.curKB = vis.nextKB; vis.curBorn = vis.nextStart; vis.next = null;
        setCaption(gallery[idx]); preloadAround(idx);
      }
    }
    // keep the scrub bar in sync with auto-advance
    if (!scrubbing) setSeekUI(idx / Math.max(1, gallery.length - 1));
  }

  function tick() {
    var t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (!lastT) lastT = t;
    clock += Math.min(0.1, t - lastT); lastT = t;
    renderVisual(clock);
  }
  function startVisuals() {
    if (visTimer) return;
    visTimer = setInterval(tick, 40); // survives background-tab rAF throttling
    var raf = function () { tick(); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }

  // ---------- scrub bar ----------
  function setSeekUI(frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (seekFill) seekFill.style.width = (frac * 100) + '%';
    if (seekKnob) seekKnob.style.left = (frac * 100) + '%';
    if (seekEl) seekEl.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }
  function seekToFrac(frac) {
    var i = Math.round(frac * (gallery.length - 1));
    gotoIndex(i, clock);
    setSeekUI(i / Math.max(1, gallery.length - 1));
  }
  function fracFromEvent(e) {
    var r = seekEl.getBoundingClientRect();
    var x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.max(0, Math.min(1, x / r.width));
  }
  function onScrubStart(e) {
    if (!gallery.length) return;
    scrubbing = true; seekEl.classList.add('is-dragging');
    seekToFrac(fracFromEvent(e));
    e.preventDefault();
  }
  function onScrubMove(e) { if (scrubbing) { seekToFrac(fracFromEvent(e)); e.preventDefault(); } }
  function onScrubEnd() { if (scrubbing) { scrubbing = false; seekEl.classList.remove('is-dragging'); vis.curBorn = clock; } }
  if (seekEl) {
    seekEl.addEventListener('mousedown', onScrubStart);
    window.addEventListener('mousemove', onScrubMove);
    window.addEventListener('mouseup', onScrubEnd);
    seekEl.addEventListener('touchstart', onScrubStart, { passive: false });
    window.addEventListener('touchmove', onScrubMove, { passive: false });
    window.addEventListener('touchend', onScrubEnd);
    // keyboard: arrows step through works
    seekEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { gotoIndex(idx + 1, clock); setSeekUI(idx / (gallery.length - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { gotoIndex(idx - 1, clock); setSeekUI(idx / (gallery.length - 1)); e.preventDefault(); }
    });
  }

  // ============================================================
  //  AUDIO — live tape-deck-style looping mix, 5s fade-in on unmute
  // ============================================================
  var actx = null, master = null, comp = null;
  var seq = [], sources = [], buffers = {};
  var audioStarted = false, audioOn = false;
  var LOOP_TARGET = 180;   // seconds of mix scheduled per loop pass
  var FADE_IN = 5;         // exactly 5s
  var VOL = 0.85;
  var aT0 = 0, loopTimer = null;

  function eff(b) { while (b > 160) b /= 2; while (b < 80) b *= 2; return b; }
  function trackOf(id) { return id.replace(/-[a-z]$/, ''); }
  function cost(a, b) {
    return Math.abs(eff(a.bpm) - eff(b.bpm)) * 2.2 + Math.abs(a.e - b.e) * 140 + Math.abs(a.bright - b.bright) / 70;
  }
  function buildSequence() {
    var pool = clips.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(mixRand() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    function arc(p) { return 0.2 + 0.7 * Math.sin(Math.min(p, 0.9) / 0.9 * Math.PI); }
    var s = [], used = {}, trackUsed = {};
    function note(c) { used[c.id] = (used[c.id] || 0) + 1; if (c.backbone) trackUsed[trackOf(c.id)] = (trackUsed[trackOf(c.id)] || 0) + 1; }
    // start on a low-energy backbone piece if we have one, else lowest energy overall
    var start = pool.reduce(function (m, c) {
      var mk = (m.backbone ? -1 : 0) + m.e, ck = (c.backbone ? -1 : 0) + c.e;
      return ck < mk ? c : m;
    }, pool[0]);
    s.push(start); note(start); var total = start.dur;
    while (total < LOOP_TARGET) {
      var last = s[s.length - 1], pos = total / LOOP_TARGET, best = null, bestC = 1e9;
      for (var k = 0; k < pool.length; k++) {
        var c = pool[k]; if (c.id === last.id) continue;
        var penalty = (used[c.id] || 0) * 45;
        var backboneBias = c.backbone ? -58 : 0;          // ~60% of airtime is Pete's tracks
        var sameTrack = 0;
        if (c.backbone) {
          sameTrack += (trackUsed[trackOf(c.id)] || 0) * 18;
          if (last.backbone && trackOf(last.id) === trackOf(c.id)) sameTrack += 120;
        }
        var sc = cost(last, c) + Math.abs(c.e - arc(pos)) * 120 + penalty + backboneBias + sameTrack + mixRand() * 10;
        if (sc < bestC) { bestC = sc; best = c; }
      }
      if (!best) break;
      s.push(best); note(best); total += best.dur;
    }
    var out = [], at = 0;
    for (var n = 0; n < s.length; n++) {
      var cl = s[n], xf = 0;
      if (n > 0) { var d = Math.abs(eff(s[n - 1].bpm) - eff(cl.bpm)); xf = d < 6 ? 1.5 : d < 14 ? 1 : d < 28 ? 0.6 : 0.3; }
      at -= xf; out.push({ clip: cl, startAt: Math.max(0, at), dur: cl.dur, xfade: xf }); at += cl.dur;
    }
    return out;
  }
  function loadBuffer(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    return fetch(BASE + 'clips/' + id + '.mp3')
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return actx.decodeAudioData(ab); })
      .then(function (buf) { buffers[id] = buf; return buf; });
  }
  function ensureCtx() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 0.0001;
    comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 24; comp.ratio.value = 3;
    comp.attack.value = 0.012; comp.release.value = 0.30;
    master.connect(comp); comp.connect(actx.destination);
  }
  function scheduleOnce(when) {
    seq.forEach(function (s) {
      var buf = buffers[s.clip.id]; if (!buf) return;
      var src = actx.createBufferSource(); src.buffer = buf;
      var g = actx.createGain(); src.connect(g); g.connect(master);
      var st = when + s.startAt, xf = Math.max(0.25, s.xfade);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(1, st + xf);
      var fo = st + s.dur - xf;
      g.gain.setValueAtTime(1, Math.max(st, fo));
      g.gain.linearRampToValueAtTime(0.0001, fo + xf);
      try { src.start(st); } catch (e) {}
      try { src.stop(st + s.dur + 0.05); } catch (e) {}
      sources.push(src);
    });
  }
  function seqDuration() { if (!seq.length) return LOOP_TARGET; var l = seq[seq.length - 1]; return l.startAt + l.dur; }
  function startAudio() {
    if (audioStarted) return; audioStarted = true;
    ensureCtx();
    seq = buildSequence();
    var ids = []; seq.forEach(function (s) { if (ids.indexOf(s.clip.id) < 0) ids.push(s.clip.id); });
    Promise.all(ids.slice(0, 6).map(loadBuffer)).then(function () {
      var when = actx.currentTime + 0.1; aT0 = when; scheduleOnce(when);
      var dur = seqDuration();
      loopTimer = setInterval(function () {
        if (!actx) return;
        if (aT0 + dur - actx.currentTime < dur * 0.5) { aT0 += dur; scheduleOnce(aT0); }
      }, 2000);
      ids.slice(6).reduce(function (p, id) { return p.then(function () { return loadBuffer(id).catch(function () {}); }); }, Promise.resolve());
    });
  }
  function fadeAudio(target, secs) {
    if (!actx || !master) return;
    var now = actx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
    master.gain.linearRampToValueAtTime(Math.max(0.0001, target), now + secs);
  }
  function setSound(on) {
    audioOn = on;
    if (on) {
      if (actx && actx.state === 'suspended') actx.resume();
      startAudio();
      fadeAudio(VOL, FADE_IN);   // 5-second fade-in
    } else {
      fadeAudio(0.0001, 0.6);
    }
    btnSound.classList.toggle('is-on', on);
    btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
    var lbl = btnSound.querySelector('.intro__sound-label');
    if (lbl) lbl.textContent = on ? 'Sound on' : 'Tap for sound';
  }
  btnSound.addEventListener('click', function (e) { e.stopPropagation(); setSound(!audioOn); });
})();
