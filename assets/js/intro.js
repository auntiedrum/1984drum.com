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
    initMontageRotation();     // pick one of the 4 pre-made montages for this visit
    setupLanding();
    fitCanvas();
    startVisuals();
  }).catch(function () { /* overlay still shows; visuals just won't run */ });

  // ---------- landing: open on a live drawing clip, slowly zooming, while the montage loads ----------
  var landing = { active: true, media: null, start: 0, DUR: 8 };
  function setupLanding() {
    var vids = gallery.filter(function (g) { return g.video; });
    if (!vids.length) { landing.active = false; return; }
    var pick = vids[Math.floor(visRand() * vids.length)];
    landing.media = getMedia(pick);                 // a playing, muted, looping clip
    root.classList.add('is-landing');               // CSS hides the chrome during landing
    preloadAround(0);                               // warm the montage's first pieces
  }
  function drawLanding(now) {
    if (!landing.start) landing.start = now;
    var p = Math.min(1, (now - landing.start) / landing.DUR);
    var m = landing.media;
    var z = 1.0 + 0.18 * (p * p * (3 - 2 * p));      // slow eased zoom-in ~1.0 -> 1.18
    if (ready(m)) {
      if (m._isVideo && m.paused) m.play().catch(function () {});
      var ir = mW(m) / mH(m), br = W / H, bw, bh;
      if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
      var dw = bw * z, dh = bh * z;
      cctx.save();
      cctx.globalAlpha = 1;
      if (cctx.filter !== undefined) cctx.filter = GRADE;
      try { cctx.drawImage(m, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) {}
      cctx.restore();
    } else {
      cctx.fillStyle = '#06100c'; cctx.fillRect(0, 0, W, H);
    }
    drawFilmOverlay(now);
    // once the zoom completes AND the clip has really started, splice into the montage
    if (p >= 1 && ready(landing.media)) {
      landing.active = false;
      root.classList.remove('is-landing');
      vis.cur = null;                                // renderVisual splices the first piece in
      spliceAt = now;
    }
  }

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
    return {
      z0: 1.04 + visRand() * 0.03, z1: 1.12 + visRand() * 0.05,
      dir: a * 6.28, jitter: 0.6 + visRand() * 0.5,
      // per-piece sway seed + irregular phase offsets (organic, not a clean L-R sine)
      seed: visRand() * 1000,
      pOff: [visRand() * 6.28, visRand() * 6.28, visRand() * 6.28],
      // per-piece ZOOM rhythm: its own tempo + amplitude + phase so the breathing varies
      zTempo: 0.5 + visRand() * 0.7, zAmp: 0.02 + visRand() * 0.05, zPhase: visRand() * 6.28,
      // per-piece rotation tempo so the wobble cadence differs too
      rTempo: 0.6 + visRand() * 0.7
    };
  }
  // smooth pseudo-random "drift then settle" value in [-1,1] from a few mismatched, slow
  // sines (incommensurate frequencies never repeat cleanly → organic sway that holds then
  // moves rather than a steady oscillation). `s` shifts the whole pattern per piece/axis.
  function organic(tt, s) {
    var v = Math.sin(tt * 0.31 + s) * 0.55
          + Math.sin(tt * 0.73 + s * 1.7) * 0.30
          + Math.sin(tt * 1.13 + s * 2.3) * 0.15;
    // soft-clip + slight easing so it lingers near the extremes (feels like settling)
    return Math.max(-1, Math.min(1, v * 1.15));
  }
  // the 70s grade — faded, warm, slightly desaturated. Applied to the source pixels as
  // we draw. (The drawing clips are already baked filmic; a touch more is harmless and
  // keeps the whole frame consistent.)
  var GRADE = 'sepia(0.32) saturate(0.78) contrast(0.94) brightness(1.05)';
  function drawCover(m, k, t, alpha) {
    if (!ready(m)) return;
    if (m._isVideo && m.paused) m.play().catch(function () {});
    var ir0 = mW(m) / mH(m), br0 = W / H;
    var overflowRatio = ir0 > br0 ? (ir0 / br0) : (br0 / ir0);   // 1 = fits, >1 = cropped
    // MOST of the work reads top -> bottom: any piece that's taller-than-wide or roughly
    // square (image AR <= ~1.05). Genuine wide panoramas keep a horizontal pan instead.
    var imgAR = mW(m) / mH(m);
    var readsDown = imgAR <= 1.05;
    // Judder vs drift is decided by the PIECE's own shape, not the frame: genuinely tall
    // drawings (portrait, AR < ~0.8) get the stepped analogue film-roll; near-square ones
    // (~0.8–1.05) get a calm smooth downward drift.
    var strongRoll = imgAR < 0.8;

    // COVER-FIT everything: stills and clips both FILL the whole screen. The 16mm film look
    // (grade + grain overlay) is kept. Base zoom is modest now — if the handheld movement
    // exposes a frame edge, that's fine: the NEXT piece is drawn behind (see renderVisual).
    var ir = mW(m) / mH(m), br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    // Ken-Burns base zoom + a per-piece breathing rhythm (own tempo/amplitude/phase) so the
    // zoom never feels uniform across pieces.
    var hc = clock * (0.9 + k.jitter * 0.5);             // per-piece sway clock
    var zBase = 1.07 + 0.07 * (t * t * (3 - 2 * t));
    var zBreath = k.zAmp * organic(clock * k.zTempo, k.seed + k.zPhase);
    var z = zBase + zBreath;
    var dw = bw * z, dh = bh * z;
    var maxY = (dh - H) / 2, maxX = (dw - W) / 2;
    // faster directional drift across the dwell
    var phase = (t - 0.5);
    var panX = Math.cos(k.dir) * maxX * 0.9 * phase;
    var panY = Math.sin(k.dir) * maxY * 0.9 * phase;
    if (readsDown) panY = (0.28 - phase * 0.7) * maxY;

    // HANDHELD SWAY: organic, irregular — drifts one way, settles, then moves again (not a
    // clean L-R oscillation). Sideways stronger than vertical. Allowed to push past the
    // edge; the backing layer covers any exposed margin.
    var swayX = organic(hc, k.pOff[0]) * W * 0.030;
    var swayY = organic(hc * 0.85, k.pOff[1] + 2.0) * H * 0.018;
    panX += swayX; panY += swayY;
    // bigger handheld rotation wobble, also organic + per-piece tempo
    var rot = organic(clock * k.rTempo, k.pOff[2] + 1.1) * 0.018;

    var bx = (W - dw) / 2 + panX, by = (H - dh) / 2 + panY;
    cctx.save();
    cctx.globalAlpha = alpha;
    if (cctx.filter !== undefined) cctx.filter = GRADE;
    cctx.translate(W / 2, H / 2); cctx.rotate(rot); cctx.translate(-W / 2, -H / 2);
    try { cctx.drawImage(m, bx, by, dw, dh); } catch (e) {}
    cctx.restore();
  }

  // ---- film grain + vignette overlay (the 70s vibe, drawn over the whole frame) ----
  var grainTile = null, grainSize = 180, vignetteCache = null, vigKey = '';
  function buildGrain() {
    grainTile = document.createElement('canvas');
    grainTile.width = grainSize; grainTile.height = grainSize;
    var g = grainTile.getContext('2d');
    var img = g.createImageData(grainSize, grainSize);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = (visRand() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 38;                    // grain strength (alpha)
    }
    g.putImageData(img, 0, 0);
  }
  function ensureVignette() {
    var key = W + 'x' + H;
    if (vigKey === key && vignetteCache) return;
    vigKey = key;
    vignetteCache = document.createElement('canvas');
    vignetteCache.width = W; vignetteCache.height = H;
    var g = vignetteCache.getContext('2d');
    var grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.72);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.7, 'rgba(20,12,4,0.12)');
    grd.addColorStop(1, 'rgba(15,8,2,0.52)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
  }
  function drawFilmOverlay(now) {
    if (!grainTile) buildGrain();
    ensureVignette();
    // moving grain — tile it with a per-frame offset so it shimmers like real film
    var ox = ((visRand() * grainSize) | 0), oy = ((visRand() * grainSize) | 0);
    cctx.save();
    cctx.globalCompositeOperation = 'overlay';
    cctx.globalAlpha = 0.9;
    for (var y = -oy; y < H; y += grainSize) {
      for (var x = -ox; x < W; x += grainSize) {
        cctx.drawImage(grainTile, x, y);
      }
    }
    cctx.restore();
    // vignette
    cctx.save();
    cctx.globalAlpha = 1;
    cctx.drawImage(vignetteCache, 0, 0);
    cctx.restore();
    // subtle whole-frame brightness flicker (warm), like a worn projector lamp
    var flick = 0.04 * Math.sin(now * 4.1) + 0.025 * Math.sin(now * 11.3);
    if (flick > 0) {
      cctx.save();
      cctx.globalCompositeOperation = 'overlay';
      cctx.fillStyle = 'rgba(255,238,200,' + Math.min(0.06, flick) + ')';
      cctx.fillRect(0, 0, W, H);
      cctx.restore();
    }
  }

  // timeline state: a current index into `gallery`, with Ken-Burns + dissolve between items.
  var idx = 0;                 // current item index
  var vis = { cur: null, curKB: null, curBorn: 0, next: null, nextIdx: 0, nextKB: null, nextStart: 0 };
  var SWAP_EVERY = 4.0;        // reveal more work (~4s/piece)
  var KB_SPAN = SWAP_EVERY + 1.5;
  var spliceAt = -1;           // ctx-clock time of the last cut (for the splice flicker)
  var clock = 0, lastT = 0, visTimer = null;
  var scrubbing = false;

  function setCaption(item) {
    if (!capEl) return;
    capEl.textContent = '';   // minimal: no captions on the montage
  }
  function preloadAround(i) {
    for (var d = 1; d <= 2; d++) {
      var a = gallery[(i + d) % gallery.length], b = gallery[(i - d + gallery.length) % gallery.length];
      if (a) getMedia(a); if (b) getMedia(b);
    }
  }
  // jump straight to an item (used by scrub) — a hard splice cut
  function gotoIndex(i, now) { cutTo(i, now); }

  // cut straight to an index — like a fresh frame spliced into the reel. Sets a splice
  // flicker that the overlay flashes for a frame or two at the join.
  function cutTo(i, now) {
    i = ((i % gallery.length) + gallery.length) % gallery.length;
    idx = i;
    vis.cur = getMedia(gallery[i]); vis.curKB = kb(); vis.curBorn = now; vis.next = null;
    // the piece that will be revealed BEHIND the current one if its handheld movement
    // exposes a frame edge (so the margin shows the next image, never black).
    var ni = (i + 1) % gallery.length;
    backIdx = ni; backMedia = getMedia(gallery[ni]);
    spliceAt = now;
    setCaption(gallery[i]); preloadAround(i);
  }
  var backIdx = 0, backMedia = null;
  // draw a piece as a STATIC full-cover fill (no handheld motion) — used as the backing
  // layer behind the current piece.
  function drawStaticCover(m) {
    if (!ready(m)) return;
    if (m._isVideo && m.paused) m.play().catch(function () {});
    var ir = mW(m) / mH(m), br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    var z = 1.04, dw = bw * z, dh = bh * z;
    cctx.save();
    cctx.globalAlpha = 1;
    if (cctx.filter !== undefined) cctx.filter = GRADE;
    try { cctx.drawImage(m, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) {}
    cctx.restore();
  }

  function renderVisual(now) {
    if (!gallery.length) return;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    // LANDING: open on a live drawing clip, slowly zooming, until it splice-cuts to the montage
    if (landing.active) { drawLanding(now); return; }
    // first piece: splice it in
    if (!vis.cur) { cutTo(0, now); }
    // advance automatically (unless scrubbing). Hard CUT to the next — no transition, like a splice.
    if (!scrubbing && (now - vis.curBorn) > SWAP_EVERY) {
      cutTo((idx + 1) % gallery.length, now);
    }
    // backing layer: the NEXT piece, static & full-cover, so any edge the current piece's
    // handheld movement exposes reveals the upcoming image rather than black.
    if (backMedia) drawStaticCover(backMedia);
    // draw the current piece on top, full-frame with its handheld motion
    drawCover(vis.cur, vis.curKB, Math.min(1, (now - vis.curBorn) / KB_SPAN), 1);
    // the 70s film vibe over everything: grain, vignette, lamp flicker — plus the splice flash
    drawFilmOverlay(now);
    drawSplice(now);
    // keep the scrub bar in sync with auto-advance
    if (!scrubbing) setSeekUI(idx / Math.max(1, gallery.length - 1));
  }

  // a 1–2 frame flash / jump / grain-burst at each cut, like a film splice through the gate
  function drawSplice(now) {
    var dt = now - spliceAt;
    if (dt < 0 || dt > 0.13) return;
    var k0 = 1 - dt / 0.13;                 // 1 -> 0 over ~130ms
    cctx.save();
    // brief warm flash
    cctx.globalAlpha = 0.5 * k0 * k0;
    cctx.fillStyle = 'rgba(255,246,225,1)';
    cctx.fillRect(0, 0, W, H);
    // a couple of black splice bars that flick down the frame
    cctx.globalAlpha = 0.55 * k0;
    cctx.fillStyle = '#000';
    var barY = (1 - k0) * H;
    cctx.fillRect(0, barY, W, Math.max(2, H * 0.012));
    cctx.fillRect(0, barY - H * 0.5, W, Math.max(2, H * 0.01));
    cctx.restore();
  }

  function tick() {
    var t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (!lastT) lastT = t;
    if (gridMode) { lastT = t; return; }   // grid view: pause the film render
    clock += Math.min(0.1, t - lastT); lastT = t;
    renderVisual(clock);
  }
  var gridMode = false;
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
  var LOOP_TARGET = 560;   // ~9 min loop — long enough to cycle through all the scraped clips
  var FADE_IN = 5;         // exactly 5s
  var VOL = 0.85;
  var aT0 = 0, loopTimer = null;

  function eff(b) { while (b > 160) b /= 2; while (b < 80) b *= 2; return b; }
  function trackOf(id) { return id.replace(/-[a-z]$/, ''); }
  function cost(a, b) {
    return Math.abs(eff(a.bpm) - eff(b.bpm)) * 2.2 + Math.abs(a.e - b.e) * 140 + Math.abs(a.bright - b.bright) / 70;
  }
  var FEATURE_ID = 'xtwittermfrst';     // the X/Twitter clip — surface it early & in full
  function buildSequence() {
    var pool = clips.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(mixRand() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    function arc(p) { return 0.2 + 0.7 * Math.sin(Math.min(p, 0.9) / 0.9 * Math.PI); }
    var s = [], used = {}, trackUsed = {}, bbRun = 0;
    function note(c) { used[c.id] = (used[c.id] || 0) + 1; if (c.backbone) trackUsed[trackOf(c.id)] = (trackUsed[trackOf(c.id)] || 0) + 1; }
    // START on the X/Twitter clip if present (early & full length), else a low-energy piece
    var feature = pool.filter(function (c) { return c.id === FEATURE_ID; })[0];
    var start = feature || pool.reduce(function (m, c) {
      var mk = (m.backbone ? -1 : 0) + m.e, ck = (c.backbone ? -1 : 0) + c.e;
      return ck < mk ? c : m;
    }, pool[0]);
    s.push(start); note(start); var total = start.dur, sinceBackbone = 0;
    while (total < LOOP_TARGET) {
      var last = s[s.length - 1], pos = total / LOOP_TARGET, best = null, bestC = 1e9;
      bbRun = last.backbone ? bbRun + 1 : 0;
      sinceBackbone = last.backbone ? 0 : sinceBackbone + 1;
      for (var k = 0; k < pool.length; k++) {
        var c = pool[k]; if (c.id === last.id) continue;
        // Strong reuse penalty so the mix cycles through ALL clips for variety (everything's
        // short now, ≤30s, so we can balance Pete's tracks and the IG/X clips EVENLY).
        var penalty = (used[c.id] || 0) * 240;
        // gently alternate texture <-> backbone so neither clusters (even blend throughout)
        var typeBias = (last && c.backbone === last.backbone) ? 28 : 0;
        // don't play two sections of the SAME Pete track close together
        var sameTrack = c.backbone ? (trackUsed[trackOf(c.id)] || 0) * 24 : 0;
        if (c.backbone && last.backbone && trackOf(c.id) === trackOf(last.id)) sameTrack += 200;
        var sc = cost(last, c) * 0.45 + Math.abs(c.e - arc(pos)) * 85 + penalty + typeBias + sameTrack + mixRand() * 16;
        if (sc < bestC) { bestC = sc; best = c; }
      }
      if (!best) break;
      s.push(best); note(best); total += best.dur;
    }
    var out = [], at = 0;
    for (var n = 0; n < s.length; n++) {
      var cl = s[n], xf = 0;
      // smoother, longer crossfades between clips (gentler blends than before)
      if (n > 0) { var d = Math.abs(eff(s[n - 1].bpm) - eff(cl.bpm)); xf = d < 6 ? 3.0 : d < 14 ? 2.4 : d < 28 ? 1.8 : 1.2; }
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

  // ============================================================
  //  MASONRY GRID  <->  MONTAGE  (toggled by the 1984drum wordmark)
  // ============================================================
  var titleEl = root.querySelector('.intro__title');
  var gridEl = root.querySelector('.intro__grid');
  var masonryEl = root.querySelector('.intro__grid-masonry');
  var lightboxEl = root.querySelector('.intro__lightbox');
  var lightboxStage = root.querySelector('.intro__lightbox-stage');
  var lightboxClose = root.querySelector('.intro__lightbox-close');
  var gridBuilt = false;

  var loopLevel = 0;          // how many times the grid has repeated (drives pixelation)
  function makeCell(item, level) {
    var cell = document.createElement('div');
    cell.className = 'intro__cell' + (item.video ? ' is-video' : '');
    // never show a broken source — if the media fails to load, drop the whole cell.
    function dropCell() { if (cell.parentNode) cell.parentNode.removeChild(cell); }
    var media;
    if (item.video) {
      media = document.createElement('video');
      media.muted = true; media.loop = true; media.playsInline = true; media.preload = 'metadata';
      media.setAttribute('muted', ''); media.setAttribute('playsinline', '');
      if (item.webm) { var sw = document.createElement('source'); sw.src = item.webm; sw.type = 'video/webm'; media.appendChild(sw); }
      var sm = document.createElement('source'); sm.src = item.disp; sm.type = 'video/mp4'; media.appendChild(sm);
      media.addEventListener('error', dropCell);
      cell.appendChild(media);
      var bar = document.createElement('div'); bar.className = 'intro__cell-bar';
      var fill = document.createElement('div'); fill.className = 'intro__cell-bar-fill';
      bar.appendChild(fill); cell.appendChild(bar);
      wireClipCell(cell, media, bar, fill);
      cell.addEventListener('click', function (e) {
        if (e.target.closest('.intro__cell-bar')) return;
        openLightbox(item);
      });
      // pixelate repeated video thumbs too (CSS pixelated rendering on the <video>)
      if (level > 0) pixelateMedia(media, level);
    } else {
      media = document.createElement('img');
      media.loading = 'lazy'; media.decoding = 'async';
      media.addEventListener('error', dropCell);   // broken source -> remove the cell
      if (item.w && item.h) { media.width = item.w; media.height = item.h; }
      cell.appendChild(media);
      cell.addEventListener('click', function () { openLightbox(item); });
      if (level > 0) {
        // progressive pixelation: quarter the dimensions per loop (nearest-neighbour),
        // then let CSS stretch it back to size.
        pixelateImage(item.disp, media, level, item.w || 600, item.h || 600);
      } else {
        media.src = item.disp;
      }
    }
    return cell;
  }
  // each repeat appends the whole gallery again, pixelated by its loop level
  function appendGallerySet(level) {
    gallery.forEach(function (item) { masonryEl.appendChild(makeCell(item, level)); });
  }
  function buildGrid() {
    masonryEl.innerHTML = '';
    loopLevel = 0;
    appendGallerySet(0);     // first, clean pass
    gridBuilt = true;
  }

  // downscale by 1/4^level with smoothing OFF, then point the <img> at the blocky result;
  // CSS (image-rendering: pixelated) stretches it back to full size.
  function pixelateImage(src, imgEl, level, w, h) {
    var probe = new Image();
    probe.onload = function () {
      var factor = Math.pow(4, level);
      var sw = Math.max(1, Math.round(probe.naturalWidth / factor));
      var sh = Math.max(1, Math.round(probe.naturalHeight / factor));
      var c = document.createElement('canvas'); c.width = sw; c.height = sh;
      var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      g.drawImage(probe, 0, 0, sw, sh);
      imgEl.classList.add('is-pixelated');
      try { imgEl.src = c.toDataURL('image/png'); } catch (e) { imgEl.src = src; }
    };
    probe.onerror = function () { imgEl.src = src; };
    probe.src = src;
  }
  function pixelateMedia(el, level) { el.classList.add('is-pixelated'); el.style.imageRendering = 'pixelated'; }

  // hover plays the clip; the bar reflects/seeks progress; a click that isn't a drag opens it.
  function wireClipCell(cell, media, bar, fill) {
    var dragging = false, moved = false;
    cell.addEventListener('mouseenter', function () { media.play().catch(function () {}); });
    cell.addEventListener('mouseleave', function () { if (!dragging) { try { media.pause(); } catch (e) {} } });
    media.addEventListener('timeupdate', function () {
      if (media.duration) fill.style.width = (media.currentTime / media.duration * 100) + '%';
    });
    function seekAt(clientX) {
      var r = bar.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      if (media.duration) { media.currentTime = frac * media.duration; fill.style.width = (frac * 100) + '%'; }
    }
    bar.addEventListener('mousedown', function (e) { dragging = true; moved = false; seekAt(e.clientX); e.stopPropagation(); e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (dragging) { moved = true; seekAt(e.clientX); } });
    window.addEventListener('mouseup', function () { dragging = false; });
    bar.addEventListener('touchstart', function (e) { dragging = true; seekAt(e.touches[0].clientX); e.stopPropagation(); }, { passive: true });
    bar.addEventListener('touchmove', function (e) { if (dragging) seekAt(e.touches[0].clientX); }, { passive: true });
    bar.addEventListener('touchend', function () { dragging = false; });
  }

  function openLightbox(item) {
    lightboxStage.innerHTML = '';
    var el;
    if (item.video && item.yt) {
      // the full drawing time-lapse, embedded & playing from YouTube
      el = document.createElement('iframe');
      el.className = 'intro__yt';
      el.src = 'https://www.youtube-nocookie.com/embed/' + item.yt + '?autoplay=1&mute=1&rel=0&modestbranding=1';
      el.allow = 'autoplay; encrypted-media; picture-in-picture';
      el.setAttribute('allowfullscreen', '');
      el.setAttribute('frameborder', '0');
    } else if (item.video) {
      el = document.createElement('video');
      el.controls = true; el.autoplay = true; el.loop = true; el.playsInline = true;
      if (item.webm) { var sw = document.createElement('source'); sw.src = item.webm; sw.type = 'video/webm'; el.appendChild(sw); }
      var sm = document.createElement('source'); sm.src = item.disp; sm.type = 'video/mp4'; el.appendChild(sm);
    } else {
      el = document.createElement('img');
      el.src = item.full || item.disp;            // high-res, clean (no film effect)
      el.alt = 'Artwork';
    }
    lightboxStage.appendChild(el);
    root.classList.add('is-lightbox');
    lightboxEl.setAttribute('aria-hidden', 'false');
  }
  function closeLightbox() {
    root.classList.remove('is-lightbox');
    lightboxEl.setAttribute('aria-hidden', 'true');
    lightboxStage.innerHTML = '';   // also stops the YouTube iframe
  }
  lightboxClose.addEventListener('click', function (e) { e.stopPropagation(); closeLightbox(); });
  lightboxEl.addEventListener('click', function (e) { if (e.target === lightboxEl) closeLightbox(); });

  // INFINITE SCROLL: near the bottom, append the whole gallery again — each repeat more
  // pixelated than the last (quartered nearest-neighbour, then stretched back).
  var appending = false;
  gridEl.addEventListener('scroll', function () {
    if (appending) return;
    if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 500) {
      appending = true;
      loopLevel++;
      appendGallerySet(loopLevel);
      setTimeout(function () { appending = false; }, 300);
    }
  });

  // ---- 4 pre-made montages, rotated per visit ----
  // Four FIXED seeds -> four distinct, deterministic gallery orders. Each visit plays the
  // next of the four (remembered in localStorage); the wordmark play-button also advances.
  var MONTAGE_SEEDS = [0x1984d, 0x0c0ffee, 0x5eed42, 0xbada55];
  var baseGallery = null, montageIndex = 0;
  function montageOrder(seed) {
    var arr = baseGallery.slice(), r = rng(seed >>> 0);
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function applyMontage(which) {
    montageIndex = ((which % MONTAGE_SEEDS.length) + MONTAGE_SEEDS.length) % MONTAGE_SEEDS.length;
    gallery = montageOrder(MONTAGE_SEEDS[montageIndex]);
    idx = 0; vis.cur = null; vis.next = null; backMedia = null; spliceAt = -1;
  }
  function initMontageRotation() {
    baseGallery = gallery.slice();
    var last = -1;
    try { last = parseInt(localStorage.getItem('montage-idx-v1'), 10); } catch (e) {}
    if (isNaN(last)) last = -1;
    var next = (last + 1) % MONTAGE_SEEDS.length;
    try { localStorage.setItem('montage-idx-v1', String(next)); } catch (e) {}
    applyMontage(next);
  }
  // advance to the next of the four montages (wordmark play-button)
  function freshMontage() {
    applyMontage(montageIndex + 1);
    try { localStorage.setItem('montage-idx-v1', String(montageIndex)); } catch (e) {}
  }

  function enterGrid() {
    gridMode = true;
    if (!gridBuilt) buildGrid();
    root.classList.add('is-grid');
    gridEl.setAttribute('aria-hidden', 'false');
    if (audioOn) fadeAudio(0.18, 0.6);          // duck the bed while browsing the grid
  }
  function exitGrid() {
    gridMode = false;
    root.classList.remove('is-grid');
    gridEl.setAttribute('aria-hidden', 'true');
    closeLightbox();
    freshMontage();                              // come back to a NEW montage
    if (audioOn) fadeAudio(VOL, 1.2);
  }
  // wordmark: in the MONTAGE it opens the GALLERY (grid); in the GALLERY it returns to /
  // plays a MONTAGE. Its hover label/icon swap to match (see CSS + the markup spans).
  titleEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (landing.active) return;                  // ignore during the opening landing
    if (root.classList.contains('is-grid')) exitGrid();   // -> play a montage
    else enterGrid();                                     // -> open the gallery
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (root.classList.contains('is-lightbox')) closeLightbox(); else if (gridMode) exitGrid(); }
  });
})();
