/*
 * intro.js — full-screen homepage intro overlay.
 *
 * On homepage load (once per session/day), a fixed full-viewport overlay cycles the
 * abstract drawing time-lapse clips on a canvas with a slow Ken-Burns drift and soft
 * cross-dissolves — muted. A single "tap for sound" control unmutes a live, tape-deck-
 * style music mix built in-browser from the clip stems, fading in over 5 seconds.
 *
 * Scrolling or clicking "enter" dismisses the intro: it fades out and the music fades
 * out + stops, revealing the normal Fragments page underneath. The island animation
 * (#genesis) and its own soundscape toggle are untouched.
 *
 * No dependencies. Driven by #intro markup injected on the homepage only.
 */
(function () {
  'use strict';

  var root = document.getElementById('intro');
  if (!root) return;

  var BASE = root.getAttribute('data-base') || '/assets/tape/';
  var SHOW_KEY = 'intro-seen-v1';
  var SHOW_TTL = 12 * 60 * 60 * 1000; // once per ~half-day

  // ---- once-per-session/day gate: if seen recently, don't show the intro at all ----
  try {
    var seen = parseInt(localStorage.getItem(SHOW_KEY) || '0', 10);
    if (seen && (Date.now() - seen) < SHOW_TTL) { root.parentNode && root.parentNode.removeChild(root); return; }
  } catch (e) {}
  function markSeen() { try { localStorage.setItem(SHOW_KEY, String(Date.now())); } catch (e) {} }

  // lock page scroll while the intro is up
  document.documentElement.classList.add('intro-open');
  root.classList.add('is-open');

  // ---------- DOM ----------
  var canvas = root.querySelector('.intro__canvas');
  var cctx = canvas.getContext('2d');
  var btnSound = root.querySelector('.intro__sound');
  var btnEnter = root.querySelector('.intro__enter');

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
  var clips = [], videos = [];
  Promise.all([
    fetch(BASE + 'clips.json').then(function (r) { return r.json(); }),
    fetch(BASE + 'art.json').then(function (r) { return r.json(); })
  ]).then(function (res) {
    clips = (res[0].clips || []);
    videos = (res[1].art || []).filter(function (a) { return a.video; });
    fitCanvas();
    startVisuals();
  }).catch(function () { /* still show the overlay; visuals just won't run */ });

  // ============================================================
  //  VISUALS — cycle the drawing clips on canvas, Ken-Burns + dissolve
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
  function getVideo(v) {
    var key = v.disp;
    if (mediaCache[key]) return mediaCache[key];
    var el = document.createElement('video');
    el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
    el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
    if (v.webm) { var sw = document.createElement('source'); sw.src = v.webm; sw.type = 'video/webm'; el.appendChild(sw); }
    var sm = document.createElement('source'); sm.src = v.disp; sm.type = 'video/mp4'; el.appendChild(sm);
    el._ready = false;
    el.addEventListener('loadeddata', function () { el._ready = true; });
    el.play().catch(function () {});
    mediaCache[key] = el; return el;
  }
  function vReady(m) { return m && m.readyState >= 2 && m.videoWidth > 0; }

  function kb() {
    var a = visRand();
    return { z0: 1.04 + visRand() * 0.03, z1: 1.12 + visRand() * 0.05, px: Math.cos(a * 6.28) * 0.04, py: Math.sin(a * 6.28) * 0.035 };
  }
  function drawCover(m, k, t, alpha) {
    if (!vReady(m)) return;
    if (m.paused) m.play().catch(function () {});
    var z = k.z0 + (k.z1 - k.z0) * t;
    var ir = m.videoWidth / m.videoHeight, br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    var dw = bw * z, dh = bh * z;
    var panX = (k.px * t - k.px * 0.5) * W, panY = (k.py * t - k.py * 0.5) * H;
    cctx.save(); cctx.globalAlpha = alpha;
    try { cctx.drawImage(m, (W - dw) / 2 + panX, (H - dh) / 2 + panY, dw, dh); } catch (e) {}
    cctx.restore();
  }

  // shuffled play order so we cycle all clips without immediate repeats
  var order = [], orderIdx = 0;
  function nextVideo() {
    if (!videos.length) return null;
    if (orderIdx >= order.length) {
      order = videos.slice();
      for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(visRand() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
      orderIdx = 0;
    }
    return getVideo(order[orderIdx++]);
  }

  var vis = { cur: null, curKB: null, curBorn: 0, next: null, nextKB: null, nextStart: 0, lastSwap: 0 };
  var SWAP_EVERY = 6.0;   // each clip is ~8s; show ~6s then dissolve so motion stays fresh
  var DISSOLVE = 1.6;
  var KB_SPAN = SWAP_EVERY + DISSOLVE + 1.5;
  var clock = 0, lastT = 0, visTimer = null;

  function renderVisual(now) {
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    if (!vis.cur) { vis.cur = nextVideo(); vis.curKB = kb(); vis.curBorn = now; vis.lastSwap = now; }
    if (now - vis.lastSwap > SWAP_EVERY && !vis.next) {
      vis.next = nextVideo(); vis.nextKB = kb(); vis.nextStart = now;
    }
    drawCover(vis.cur, vis.curKB, Math.min(1, (now - vis.curBorn) / KB_SPAN), 1);
    if (vis.next) {
      var p = Math.min(1, (now - vis.nextStart) / DISSOLVE);
      var e = p * p * (3 - 2 * p);
      drawCover(vis.next, vis.nextKB, Math.min(1, (now - vis.nextStart) / KB_SPAN), e);
      if (p >= 1) { vis.cur = vis.next; vis.curKB = vis.nextKB; vis.curBorn = vis.nextStart; vis.next = null; vis.lastSwap = now; }
    }
  }
  function tick() {
    var t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (!lastT) lastT = t;
    clock += Math.min(0.1, t - lastT); lastT = t;
    renderVisual(clock);
  }
  function startVisuals() {
    if (visTimer) return;
    // drive with setInterval (survives background-tab rAF throttling, like genesis/tape)
    visTimer = setInterval(tick, 40);
    var raf = function () { if (!dismissed) { tick(); requestAnimationFrame(raf); } };
    requestAnimationFrame(raf);
  }

  // ============================================================
  //  AUDIO — live tape-deck-style looping mix, 5s fade-in on unmute
  // ============================================================
  var actx = null, master = null, comp = null;
  var seq = [], sources = [], buffers = {};
  var audioStarted = false, audioOn = false;
  var LOOP_TARGET = 150;   // seconds of mix to schedule per loop pass
  var FADE_IN = 5;         // exactly 5s as requested
  var VOL = 0.85;
  var aT0 = 0, loopTimer = null;

  function eff(b) { while (b > 160) b /= 2; while (b < 80) b *= 2; return b; }
  function cost(a, b) {
    var db = Math.abs(eff(a.bpm) - eff(b.bpm));
    var de = Math.abs(a.e - b.e) * 140;
    var dbr = Math.abs(a.bright - b.bright) / 70;
    return db * 2.2 + de + dbr;
  }
  // build a coherent looping sequence (energy arc, nearest-neighbour, no repeats in a row)
  function buildSequence() {
    var pool = clips.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(mixRand() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    function arc(p) { return 0.2 + 0.7 * Math.sin(Math.min(p, 0.9) / 0.9 * Math.PI); }
    var s = [], used = {};
    var start = pool.reduce(function (m, c) { return c.e < m.e ? c : m; }, pool[0]);
    s.push(start); used[start.id] = 1; var total = start.dur;
    while (total < LOOP_TARGET) {
      var last = s[s.length - 1], pos = total / LOOP_TARGET, best = null, bestC = 1e9;
      for (var k = 0; k < pool.length; k++) {
        var c = pool[k];
        if (c.id === last.id) continue;
        var penalty = used[c.id] ? 60 : 0;
        var sc = cost(last, c) + Math.abs(c.e - arc(pos)) * 120 + penalty + mixRand() * 8;
        if (sc < bestC) { bestC = sc; best = c; }
      }
      if (!best) break;
      s.push(best); used[best.id] = (used[best.id] || 0) + 1; total += best.dur;
    }
    var out = [], at = 0;
    for (var n = 0; n < s.length; n++) {
      var cl = s[n], xf = 0;
      if (n > 0) { var d = Math.abs(eff(s[n - 1].bpm) - eff(cl.bpm)); xf = d < 6 ? 1.5 : d < 14 ? 1 : d < 28 ? 0.6 : 0.3; }
      at -= xf;
      out.push({ clip: cl, startAt: Math.max(0, at), dur: cl.dur, xfade: xf });
      at += cl.dur;
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

  // schedule the sequence once, starting at ctx time `when`
  function scheduleOnce(when) {
    seq.forEach(function (s) {
      var buf = buffers[s.clip.id]; if (!buf) return;
      var src = actx.createBufferSource(); src.buffer = buf;
      var g = actx.createGain(); src.connect(g); g.connect(master);
      var st = when + s.startAt;
      var xf = Math.max(0.25, s.xfade);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(1, st + xf);
      var fadeOutAt = st + s.dur - xf;
      g.gain.setValueAtTime(1, Math.max(st, fadeOutAt));
      g.gain.linearRampToValueAtTime(0.0001, fadeOutAt + xf);
      try { src.start(st); } catch (e) {}
      try { src.stop(st + s.dur + 0.05); } catch (e) {}
      sources.push(src);
    });
  }

  function seqDuration() {
    if (!seq.length) return LOOP_TARGET;
    var lastSeg = seq[seq.length - 1];
    return lastSeg.startAt + lastSeg.dur;
  }

  function startAudio() {
    if (audioStarted) return;
    audioStarted = true;
    ensureCtx();
    seq = buildSequence();
    var ids = []; seq.forEach(function (s) { if (ids.indexOf(s.clip.id) < 0) ids.push(s.clip.id); });
    // load enough to start, then loop
    Promise.all(ids.slice(0, 6).map(loadBuffer)).then(function () {
      if (dismissed) return;
      var when = actx.currentTime + 0.1;
      aT0 = when;
      scheduleOnce(when);
      // re-schedule on a loop so the music never ends while the intro is up
      var dur = seqDuration();
      loopTimer = setInterval(function () {
        if (dismissed || !actx) return;
        var ahead = aT0 + dur - actx.currentTime;
        if (ahead < dur * 0.5) { aT0 = aT0 + dur; scheduleOnce(aT0); }
      }, 2000);
      // lazy-load the rest
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
      fadeAudio(VOL, FADE_IN);     // 5-second fade-in
    } else {
      fadeAudio(0.0001, 0.6);
    }
    btnSound.classList.toggle('is-on', on);
    btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnSound.querySelector('.intro__sound-label').textContent = on ? 'Sound on' : 'Tap for sound';
  }
  btnSound.addEventListener('click', function (e) { e.stopPropagation(); setSound(!audioOn); });

  // ============================================================
  //  DISMISS — fade out everything, reveal the page
  // ============================================================
  var dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    markSeen();
    // fade music out + stop
    if (actx && master) {
      fadeAudio(0.0001, 1.0);
      setTimeout(function () {
        try { sources.forEach(function (s) { try { s.stop(); } catch (e) {} }); } catch (e) {}
        if (loopTimer) clearInterval(loopTimer);
        if (actx && actx.close) actx.close().catch(function () {});
      }, 1100);
    }
    if (visTimer) clearInterval(visTimer);
    document.documentElement.classList.remove('intro-open');
    root.classList.add('is-leaving');
    setTimeout(function () {
      root.classList.remove('is-open');
      if (root.parentNode) root.parentNode.removeChild(root);
    }, 750);
  }

  // dismiss on the explicit "enter" button, on a click anywhere on the stage
  // (but not the sound button), on scroll intent, or Escape.
  if (btnEnter) btnEnter.addEventListener('click', function (e) { e.stopPropagation(); dismiss(); });
  root.addEventListener('click', function () { dismiss(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Enter') dismiss(); });
  // any scroll/wheel/touch-move intent dismisses and lets the page take over
  window.addEventListener('wheel', function () { dismiss(); }, { passive: true });
  window.addEventListener('touchmove', function () { dismiss(); }, { passive: true });
})();
