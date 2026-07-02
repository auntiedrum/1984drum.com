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
  // cache-bust the JSON manifests with the same ?v= this script was loaded under, so a
  // returning visitor never gets a stale explore.json (e.g. one baked before LQIPs existed).
  var VER = (function () {
    var s = document.currentScript || (function () { var a = document.getElementsByTagName('script'); return a[a.length - 1]; })();
    var m = s && s.src && s.src.match(/[?&]v=([^&]+)/);
    return m ? ('?v=' + m[1]) : '';
  })();

  // mark the page so CSS can float the site nav transparently over the art and lock scroll
  document.body.classList.add('has-intro');
  document.documentElement.classList.add('intro-locked');

  // ---------- DOM ----------
  var canvas = root.querySelector('.intro__canvas');
  var cctx = canvas.getContext('2d');
  var btnPlay = root.querySelector('.intro__play-btn');
  var btnMute = root.querySelector('.intro__mute-btn');
  var btnPrev = root.querySelector('.intro__prev-btn');
  var btnNext = root.querySelector('.intro__next-btn');
  var trackEl = root.querySelector('.intro__track');
  var trackBtn = root.querySelector('.intro__track-btn');
  var trackListEl = root.querySelector('.intro__tracklist');
  // the title sits in a child span so the "Now Playing" label stays put; fall back to the
  // bar itself for older markup without the label/title split.
  var trackTitleEl = root.querySelector('.intro__track-title') || trackEl;
  var upnextTitleEl = root.querySelector('.intro__upnext-title');
  var upnextEl = root.querySelector('.intro__upnext');
  var countdownEl = root.querySelector('.intro__countdown');
  var volumeEl = root.querySelector('.intro__volume');
  var volumeTrackEl = root.querySelector('.intro__volume-track');
  var volumeFillEl = root.querySelector('.intro__volume-fill');
  var volumeKnobEl = root.querySelector('.intro__volume-knob');
  var seekEl = root.querySelector('.intro__seek');     // optional (may be absent now)
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
  // TRACKS_BASE holds the full-length tracks + their playlist manifest. The player is now a
  // playlist of whole tracks (real names from the filenames), NOT the old segmented DJ-blend
  // of short scraped clips. `clips.json` is still fetched for backwards safety but the audio
  // engine drives off `tracks` from tracklist.json.
  var TRACKS_BASE = '/assets/audio/tracklist/';
  var clips = [], gallery = [], tracks = [];   // gallery = ordered explore list (stills + video clips)
  Promise.all([
    fetch(BASE + 'clips.json' + VER).then(function (r) { return r.json(); }).catch(function () { return { clips: [] }; }),
    fetch(BASE + 'explore.json' + VER).then(function (r) { return r.json(); }),
    fetch(TRACKS_BASE + 'tracklist.json' + VER).then(function (r) { return r.json(); }).catch(function () { return { tracks: [] }; })
  ]).then(function (res) {
    clips = (res[0].clips || []);
    gallery = (res[1].explore || []);
    tracks = (res[2].tracks || []);
    initMontageRotation();     // pick one of the 4 pre-made montages for this visit
    setupLanding();
    fitCanvas();
    startVisuals();
    // PRE-BUILD the masonry now (off-screen) so it's instant + complete when opened: every
    // cell shows its baked LQIP immediately and the full thumbs stream in behind. Only THEN
    // do we offer the gallery toggle (grid-ready), so it never opens to an empty/broken grid.
    buildGrid();
    root.classList.add('grid-ready');
    // the mix runs from load, silent (muted). Browsers allow a muted/silent context; the
    // first user UNMUTE resumes + fades it in. Play button stays hidden until then.
    ensureCtx();
    startAudio();
    pickWord();
    refreshPlayerUI();
  }).catch(function () { landing.active = false; root.classList.remove('is-landing'); /* visuals just won't run */ });

  // ---------- landing: open on a live drawing clip, slowly zooming, while the montage loads ----------
  var landing = { active: true, media: null, start: 0, DUR: 8, deadline: 0, killTimer: null };
  function setupLanding() {
    var vids = gallery.filter(function (g) { return g.video; });
    if (!vids.length) { landing.active = false; return; }
    var pick = vids[Math.floor(visRand() * vids.length)];
    landing.media = getMedia(pick);                 // a playing, muted, looping clip
    root.classList.add('is-landing');               // CSS dims the chrome during landing
    preloadAround(0);                               // warm the montage's first pieces
    // GUARANTEED exit on a WALL-CLOCK deadline (not the throttle-prone visuals clock, and
    // immune to the landing video never decoding) — so the gallery toggle is never locked
    // out behind a stalled landing on mobile.
    landing.deadline = Date.now() + 9000;
    landing.killTimer = setTimeout(endLanding, 9000);
    if (landing.media) landing.media.addEventListener('error', endLanding);  // broken clip -> exit
  }
  // idempotent landing exit — the ONE place that clears the latch
  function endLanding() {
    if (!landing.active) return;
    landing.active = false;
    if (landing.killTimer) { clearTimeout(landing.killTimer); landing.killTimer = null; }
    root.classList.remove('is-landing');
    vis.cur = null;                                 // renderVisual splices the first piece in
    spliceAt = (typeof clock === 'number' ? clock : 0);
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
    // exit when the zoom completes AND the clip has started — OR the wall-clock deadline passes
    if ((p >= 1 && ready(landing.media)) || (landing.deadline && Date.now() > landing.deadline)) {
      endLanding();
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
  //  AUDIO — playlist of full tracks, short crossfades, 5s fade-in on unmute
  // ============================================================
  var actx = null, master = null, comp = null;
  var seq = [], sources = [], buffers = {};
  var audioStarted = false, audioOn = false;
  var buffersLoaded = false;   // the opening track(s) decoded and ready to play instantly
  var audioReady = false;      // buffers loaded AND the context is actually running
  var LOOP_TARGET = 560;   // only a fallback for seqDuration() before the playlist loads
  var FADE_IN = 5;         // exactly 5s
  var VOL = 0.85;
  var GRID_DUCK = 0.18;    // bed volume while the masonry grid is open (ducked under browsing)
  var aT0 = 0, loopTimer = null, clipWatch = null, lastClipIdx = -1;
  // prev/next must only be offered when audio can act INSTANTLY (opening buffers decoded +
  // context running) — otherwise on mobile a tap on a suspended/loading graph does nothing.
  // Reflect readiness as a class the CSS uses to reveal the arrows, and re-check on a light poll.
  function updateAudioReady() {
    var r = buffersLoaded && !!actx && actx.state === 'running';
    if (r) beginPlayback();   // first time the graph is live + loaded, start the playlist
    if (r !== audioReady) { audioReady = r; root.classList.toggle('audio-ready', audioReady); }
  }
  // Build the PLAYLIST: every full track, played start-to-finish, in the manifest's
  // energy-arc order (already sorted low->peak->low in tracklist.json), with a short
  // crossfade at each track boundary. This replaces the old segmented DJ-blend — `seq`
  // entries are now WHOLE tracks, each with its real name and true duration.
  var TRACK_XFADE = 2.0;     // seconds of crossfade between consecutive full tracks
  function buildSequence() {
    if (!tracks.length) return [];
    // fileById keyed for loadBuffer to resolve the exact filename to fetch.
    var out = [], at = 0;
    for (var n = 0; n < tracks.length; n++) {
      var tk = tracks[n];
      // a "clip" shape the rest of the engine already understands: id + dur + title, plus
      // `file` so loadBuffer fetches the right mp3. No `backbone`/bpm needed anymore.
      var clip = { id: tk.id, file: tk.file, title: tk.title, dur: tk.dur, e: tk.e, bright: tk.bright };
      var xf = n > 0 ? TRACK_XFADE : 0;
      at -= xf;
      out.push({ clip: clip, startAt: Math.max(0, at), dur: tk.dur, xfade: xf });
      at += tk.dur;
    }
    return out;
  }
  // full-track files live in TRACKS_BASE and carry their real filename (spaces->underscores),
  // so we resolve the URL from the clip's `file`. Keep a fallback to <id>.mp3 for safety.
  function trackFileFor(id) {
    for (var i = 0; i < tracks.length; i++) { if (tracks[i].id === id) return tracks[i].file; }
    return id + '.mp3';
  }
  function loadBuffer(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    return fetch(TRACKS_BASE + encodeURIComponent(trackFileFor(id)))
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
    actx.onstatechange = updateAudioReady;   // running<->suspended flips the arrows on/off
  }
  // ---- rolling full-track scheduler -----------------------------------------------------
  // A playlist of full tracks totals ~29 min of audio, so we CANNOT decode everything up front
  // or start 24 sources at once (the old segmented mix could — each piece was tiny). Instead we
  // keep a rolling window: schedule only the entries whose start time is within SCHED_AHEAD of
  // now, lazy-loading each track's buffer just before it's needed. `aT0` is still the ctx time
  // at which seq entry 0 (startAt 0) begins, so the whole positional model (currentSeqIndex,
  // countdown, up-next) is unchanged — the loop wraps every seqDuration() seconds.
  var SCHED_AHEAD = 25;      // seconds of lookahead to have audio queued
  var scheduledKeys = {};    // "<loopPass>:<seqIndex>" -> true, so we never double-schedule
  // Schedule seq entry `sIndex` for loop pass starting at `cycleStart`. `offset` (default 0) is
  // seconds INTO the track to begin from — used for a LATE start when the buffer only finished
  // decoding after the track's nominal start had already passed, so a slow track begins mid-way
  // instead of being dropped to full-duration silence.
  function scheduleEntry(sIndex, cycleStart, offset) {
    offset = offset || 0;
    var s = seq[sIndex];
    var buf = buffers[s.clip.id];
    if (!buf) return false;                   // not decoded yet — caller will retry next tick
    // guard the buffer length: never fade/stop past what the decoded buffer actually holds
    var playDur = Math.min(s.dur, buf.duration) - offset;
    if (playDur <= 0.05) return true;         // essentially over — nothing worth starting
    var src = actx.createBufferSource(); src.buffer = buf;
    var g = actx.createGain(); src.connect(g); g.connect(master);
    // on-time: start at the nominal clock slot. late: start ~now, from `offset` into the buffer.
    var st = offset > 0 ? (actx.currentTime + 0.02) : (cycleStart + s.startAt);
    var xf = Math.max(0.25, s.xfade);
    g.gain.setValueAtTime(0.0001, st);
    g.gain.linearRampToValueAtTime(1, st + Math.min(xf, playDur * 0.5));
    var fo = st + playDur - xf;
    g.gain.setValueAtTime(1, Math.max(st, fo));
    g.gain.linearRampToValueAtTime(0.0001, Math.max(st + 0.05, fo + xf));
    try { src.start(st, offset); } catch (e) {}
    try { src.stop(st + playDur + 0.05); } catch (e) {}
    src.onended = function () { var i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
    sources.push(src);
    return true;
  }
  // How near (in seconds) a track's start must be for us to KEEP its decoded buffer. Anything
  // outside this window (behind or far ahead) is evictable so memory stays bounded across the
  // ~29-min loop instead of holding all 24 decoded tracks at once.
  var KEEP_AHEAD = SCHED_AHEAD + 30, KEEP_BEHIND = 8;
  // signed seconds from `now` to the nearest upcoming start of seq entry `i` (>=0 ahead).
  function nearestStartDelta(i, now, dur) {
    var base = aT0 + seq[i].startAt;
    var k = Math.ceil((now - base) / dur);
    var next = base + k * dur;             // first occurrence at/after now
    var prev = next - dur;                 // the one just behind
    return { ahead: next - now, behind: now - prev };
  }
  function evictFarBuffers() {
    var now = actx.currentTime, dur = seqDuration();
    // build the set of ids worth keeping (currently sounding or within the keep window)
    var keep = {};
    for (var i = 0; i < seq.length; i++) {
      var d = nearestStartDelta(i, now, dur);
      if (d.ahead <= KEEP_AHEAD || d.behind <= (seq[i].dur + KEEP_BEHIND)) keep[seq[i].clip.id] = true;
    }
    for (var id in buffers) { if (!keep[id]) delete buffers[id]; }
  }
  // preload the buffers for the entries about to enter the scheduling window
  function preloadAhead(cycleStart) {
    var now = actx.currentTime, dur = seqDuration();
    for (var pass = 0; pass < 2; pass++) {
      var base = cycleStart + pass * dur;
      for (var i = 0; i < seq.length; i++) {
        var st = base + seq[i].startAt;
        if (st < now - 1) continue;
        if (st - now > SCHED_AHEAD + 20) break;      // far enough ahead; stop for this pass
        var id = seq[i].clip.id;
        if (!buffers[id]) loadBuffer(id).catch(function () {});
      }
    }
  }
  // walk the rolling window, scheduling every entry whose start is within SCHED_AHEAD and whose
  // buffer is ready. Runs on a light interval AND right after (re)anchoring.
  function pumpSchedule() {
    if (!actx || actx.state !== 'running' || !seq.length) return;
    var now = actx.currentTime, dur = seqDuration();
    preloadAhead(aT0 + Math.floor((now - aT0) / dur) * dur);
    // consider the current loop pass and the next one, IN TIME ORDER. If an entry that's due
    // isn't decoded yet we stop for this tick (don't schedule a later track ahead of a pending
    // earlier one, which would double up when the earlier buffer finally arrives) — it retries
    // next tick, in order.
    var startPass = Math.floor((now - aT0) / dur);
    outer:
    for (var pass = startPass; pass <= startPass + 1; pass++) {
      var cycleStart = aT0 + pass * dur;
      for (var i = 0; i < seq.length; i++) {
        var st = cycleStart + seq[i].startAt;
        var key = pass + ':' + i;
        if (st < now - 0.05) {
          // this entry's nominal start has passed. If it was never scheduled (its buffer wasn't
          // ready in time) but the buffer IS ready now and the track is still mostly unplayed,
          // start it LATE from the right offset rather than dropping it to silence. Otherwise
          // mark it done so we stop retrying a genuinely-passed entry.
          if (!scheduledKeys[key]) {
            var into = now - st;                      // seconds we're already into this track
            if (scheduleEntry(i, cycleStart, into)) scheduledKeys[key] = true;
          }
          continue;
        }
        if (st - now > SCHED_AHEAD) break outer;      // beyond the window for now
        if (scheduledKeys[key]) continue;
        if (scheduleEntry(i, cycleStart)) scheduledKeys[key] = true;
        else break outer;                             // buffer not ready — resume next tick
      }
    }
    // prune stale scheduled keys so the map doesn't grow without bound
    for (var k in scheduledKeys) {
      var p = parseInt(k.split(':')[0], 10);
      if (p < startPass) delete scheduledKeys[k];
    }
    evictFarBuffers();       // keep decoded audio bounded across the long loop
  }
  function stopAllSources() {
    sources.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) {} });
    sources.length = 0;
    scheduledKeys = {};
  }
  function seqDuration() { if (!seq.length) return LOOP_TARGET; var l = seq[seq.length - 1]; return l.startAt + l.dur; }
  var playbackStarted = false;
  function startAudio() {
    if (audioStarted) return; audioStarted = true;
    ensureCtx();
    seq = buildSequence();
    if (!seq.length) { buffersLoaded = true; updateAudioReady(); return; }
    // Lazy: only decode the FIRST track (and the second, for a gapless first boundary) before
    // declaring ready — the rest stream in via preloadAhead as playback rolls. This keeps the
    // ~29-min playlist from decoding all at once and lets audioReady fire quickly.
    var firstIds = [seq[0].clip.id];
    if (seq[1]) firstIds.push(seq[1].clip.id);
    Promise.all(firstIds.map(function (id) { return loadBuffer(id).catch(function () { return null; }); })).then(function () {
      buffersLoaded = true;
      updateAudioReady();
      if (actx.state === 'running') beginPlayback();   // desktop: may already be running
    });
  }
  // start the rolling scheduler from the live clock — runs once, the first time the context is
  // genuinely running with the opening buffers ready.
  function beginPlayback() {
    if (playbackStarted || !buffersLoaded || !actx || actx.state !== 'running') return;
    playbackStarted = true;
    var when = actx.currentTime + 0.12; aT0 = when;
    pumpSchedule();                  // queue the opening window now
    loopTimer = setInterval(pumpSchedule, 1000);
    // watch which track is sounding; keep the "Now Playing" title locked to it.
    clipWatch = setInterval(function () {
      if (!actx || actx.state !== 'running') return;
      var dur = seqDuration();
      var p = (actx.currentTime - aT0) % dur; if (p < 0) p += dur;
      var ci = seqIndexAt(p);
      if (ci !== lastClipIdx) { lastClipIdx = ci; pickWord(seq[ci] && seq[ci].clip); updateUpNext(); }
    }, 300);
    // live countdown to the end of the current track (ticks every second)
    if (!countdownTimer) countdownTimer = setInterval(tickCountdown, 500);
    updateUpNext();
  }
  function fadeAudio(target, secs) {
    if (!actx || !master) return;
    var now = actx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
    master.gain.linearRampToValueAtTime(Math.max(0.0001, target), now + secs);
  }
  // ---- player ----
  // The playlist is ALWAYS playing under the hood (starts silent on load — no gesture needed
  // because it's muted). The user's first UNMUTE fades it in mid-track and reveals the
  // play/pause control. Pause then suspends; play resumes. Next/Prev jump the live audio to
  // the next/previous FULL track in the playlist.
  var playing = true, muted = true, engaged = false;   // engaged = user has unmuted at least once

  // the DOMINANT (audible) seq entry at loop-position `p`. A track becomes "current" only once
  // the crossfade INTO it has finished — i.e. at startAt + xfade — so during the 2s overlap the
  // still-full-volume outgoing track stays current. This keeps the countdown running down to
  // 0:00 (instead of snapping to the next track ~2s early) and flips Now Playing / Up Next only
  // when the audio actually changes over. Entry 0 has xfade 0, so the loop-wrap (p≈0) still
  // selects it correctly.
  function seqIndexAt(p) {
    var ci = 0;
    for (var i = 0; i < seq.length; i++) { if (p >= seq[i].startAt + (seq[i].xfade || 0)) ci = i; }
    return ci;
  }
  // which clip is sounding right now -> its sequence entry's clip object (or null)
  function currentClip() {
    if (!actx || !seq.length) return null;
    var dur = seqDuration();
    var p = (actx.currentTime - aT0) % dur; if (p < 0) p += dur;
    return seq[seqIndexAt(p)] ? seq[seqIndexAt(p)].clip : null;
  }
  // the display title for a track: use its real name straight from the manifest. As a
  // defensive fallback (should a raw id ever reach here), turn the filename stem into a
  // display name — underscores to spaces, extension dropped — so "Track_8.mp3" -> "Track 8".
  function clipTitle(clip) {
    if (!clip) return '';
    var t = (clip.title || '').trim();
    if (t) return t;
    return (clip.id || '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
  }
  var lastTitle = '';
  // refresh the "Now Playing" title. Pass an explicit clip when the caller already knows
  // which track is about to sound (e.g. a jump, where the audio clock hasn't advanced to the
  // freshly-anchored position yet — reading currentClip() there races to the previous track).
  // Otherwise read whatever is sounding now.
  function pickWord(clip) {
    var name = clipTitle(clip || currentClip());
    lastTitle = name;
    if (trackTitleEl) trackTitleEl.textContent = name;
    if (trackEl) trackEl.setAttribute('title', name);
    return name;
  }

  var mutePromptEl = btnMute && btnMute.querySelector('.intro__mute-prompt');
  function refreshPlayerUI() {
    if (btnPlay) { btnPlay.classList.toggle('is-playing', playing); btnPlay.setAttribute('aria-pressed', playing ? 'true' : 'false'); }
    if (btnMute) {
      btnMute.classList.toggle('is-muted', muted); btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      // the hover pill prompts the OPPOSITE action of the current state
      var label = muted ? 'Turn audio on' : 'Turn audio off';
      if (mutePromptEl) mutePromptEl.textContent = label;
      btnMute.setAttribute('aria-label', label);
    }
    root.classList.toggle('audio-engaged', engaged);   // CSS reveals play/next/prev once engaged
    root.classList.toggle('is-muted-state', muted);    // CSS gates the volume slider on unmuted
  }
  // `audioOn` (used by grid-ducking) means "currently audible"
  function applyAudioLevel(secs) {
    audioOn = playing && !muted && !gridMode;
    // respect the grid duck: a pause/play or mute toggle WHILE the grid is open must not
    // un-duck the bed — only exitGrid (which clears gridMode first) restores full volume.
    var target = (playing && !muted) ? (gridMode ? GRID_DUCK : VOL) : 0.0001;
    fadeAudio(target, secs);
  }

  // ---- volume (the pop-up slider above the mute button) ----
  // VOL is the audible level when unmuted; the slider sets it and, if we're currently
  // audible, re-applies it live (a short fade so drags sound smooth, not zippered).
  function setVolume(frac, live) {
    VOL = Math.max(0, Math.min(1, frac));
    setVolumeUI(VOL);
    if (live && playing && !muted && !gridMode) fadeAudio(VOL <= 0.0001 ? 0.0001 : VOL, 0.06);
  }
  function setVolumeUI(frac) {
    var pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    if (volumeFillEl) volumeFillEl.style.height = pct + '%';
    if (volumeKnobEl) volumeKnobEl.style.bottom = pct + '%';
    if (volumeEl) volumeEl.setAttribute('aria-valuenow', String(pct));
  }
  // vertical slider: TOP = loud, BOTTOM = quiet. Fraction from a pointer/touch Y.
  function volFracFromEvent(e) {
    if (!volumeTrackEl) return VOL;
    var r = volumeTrackEl.getBoundingClientRect();
    var y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return Math.max(0, Math.min(1, 1 - y / r.height));
  }
  var volDragging = false;
  function onVolStart(e) {
    if (muted) return;                 // slider is inert while muted
    volDragging = true; if (volumeEl) volumeEl.classList.add('is-dragging');
    setVolume(volFracFromEvent(e), true);
    e.preventDefault(); e.stopPropagation();
  }
  function onVolMove(e) { if (volDragging) { setVolume(volFracFromEvent(e), true); e.preventDefault(); } }
  function onVolEnd() { if (volDragging) { volDragging = false; if (volumeEl) volumeEl.classList.remove('is-dragging'); } }
  if (volumeTrackEl) {
    volumeTrackEl.addEventListener('mousedown', onVolStart);
    window.addEventListener('mousemove', onVolMove);
    window.addEventListener('mouseup', onVolEnd);
    volumeTrackEl.addEventListener('touchstart', onVolStart, { passive: false });
    window.addEventListener('touchmove', onVolMove, { passive: false });
    window.addEventListener('touchend', onVolEnd);
  }
  setVolumeUI(VOL);

  // ---- mm:ss + up-next + countdown -------------------------------------------------------
  function fmtTime(secs) {
    secs = Math.max(0, Math.round(secs));
    var m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  // the sequence entry AFTER the current one whose display title actually differs — so
  // "Up Next" names a genuinely different track, not the next 3-second cross-fade slice of
  // the same one.
  function nextDistinctSeqIndex(from) {
    if (!seq.length) return -1;
    var name = clipTitle(seq[((from % seq.length) + seq.length) % seq.length].clip);
    for (var d = 1; d <= seq.length; d++) {
      var j = (from + d) % seq.length;
      if (clipTitle(seq[j].clip) !== name) return j;
    }
    return -1;
  }
  function updateUpNext() {
    if (!upnextTitleEl) return;
    if (!audioReady || !seq.length) { if (upnextEl) upnextEl.classList.remove('has-next'); return; }
    var ni = nextDistinctSeqIndex(currentSeqIndex());
    var name = ni >= 0 ? clipTitle(seq[ni].clip) : '';
    upnextTitleEl.textContent = name;
    if (upnextEl) upnextEl.classList.toggle('has-next', !!name);
  }
  // seconds left in whatever distinct-named track is sounding: sum this entry's remaining
  // time plus any immediately-following entries that share its title (the cross-fade slices).
  function secsLeftInTrack() {
    if (!actx || !seq.length) return 0;
    var dur = seqDuration();
    var pos = (actx.currentTime - aT0) % dur; if (pos < 0) pos += dur;
    var ci = currentSeqIndex();
    var name = clipTitle(seq[ci].clip);
    var end = seq[ci].startAt + seq[ci].dur;
    for (var d = 1; d < seq.length; d++) {
      var j = ci + d; if (j >= seq.length) break;   // don't wrap the loop boundary
      if (clipTitle(seq[j].clip) !== name) break;
      end = seq[j].startAt + seq[j].dur;
    }
    return Math.max(0, end - pos);
  }
  var countdownTimer = null;
  function tickCountdown() {
    if (!countdownEl) return;
    if (!audioReady || muted || !seq.length) { countdownEl.textContent = ''; return; }
    countdownEl.textContent = '-' + fmtTime(secsLeftInTrack());
  }

  // ---- track list (hover on desktop / tap on mobile) -------------------------------------
  // The mix is one long sequence of cross-faded clip slices; a "track" here is a run of
  // consecutive entries that share a display title. We build the menu as the ordered list of
  // those distinct tracks STARTING FROM whatever is playing now, so moving the cursor up the
  // list moves forward through what's coming — each row jumps the live audio to that track.
  var TRACKLIST_MAX = 24;   // rows shown (the mix has ~150 slices; keep the menu digestible)
  function distinctTrackRuns() {
    var runs = [], n = seq.length;
    for (var i = 0; i < n; i++) {
      var name = clipTitle(seq[i].clip);
      var last = runs[runs.length - 1];
      if (last && last.name === name) { last.end = seq[i].startAt + seq[i].dur; }
      else { runs.push({ index: i, name: name, start: seq[i].startAt, end: seq[i].startAt + seq[i].dur }); }
    }
    return runs;
  }
  var trackListBuilt = false;
  function buildTrackList() {
    if (!trackListEl || !seq.length) return;
    var runs = distinctTrackRuns();
    if (!runs.length) return;
    // find the run the playhead is in, and order the menu from there forward (wrapping)
    var ci = currentSeqIndex(), startRun = 0;
    for (var r = 0; r < runs.length; r++) { if (ci >= runs[r].index) startRun = r; }
    trackListEl.innerHTML = '';
    var count = Math.min(TRACKLIST_MAX, runs.length);
    // build BOTTOM-UP visually (newest addition on top) so the current track is nearest the
    // button and upcoming tracks are reached by moving the cursor UP, as asked.
    for (var k = count - 1; k >= 0; k--) {
      var run = runs[(startRun + k) % runs.length];
      var row = document.createElement('button');
      row.type = 'button'; row.className = 'intro__tracklist-item' + (k === 0 ? ' is-current' : '');
      row.setAttribute('role', 'menuitem');
      row.setAttribute('data-seq', String(run.index));
      var nm = document.createElement('span'); nm.className = 'intro__tracklist-name'; nm.textContent = run.name;
      var tm = document.createElement('span'); tm.className = 'intro__tracklist-time'; tm.textContent = fmtTime(run.end - run.start);
      row.appendChild(nm); row.appendChild(tm);
      trackListEl.appendChild(row);
    }
    trackListBuilt = true;
  }
  function openTrackList() {
    if (!trackListEl || !audioReady || !seq.length) return;
    buildTrackList();               // rebuild each open so it starts from the live playhead
    root.classList.add('tracklist-open');
    trackListEl.setAttribute('aria-hidden', 'false');
    if (trackBtn) trackBtn.setAttribute('aria-expanded', 'true');
    // open scrolled to the BOTTOM: the current track sits nearest the button and the visitor
    // moves the cursor UP through the list to reach what's coming (as requested).
    trackListEl.scrollTop = trackListEl.scrollHeight;
  }
  function closeTrackList() {
    root.classList.remove('tracklist-open');
    if (trackListEl) trackListEl.setAttribute('aria-hidden', 'true');
    if (trackBtn) trackBtn.setAttribute('aria-expanded', 'false');
  }
  var isTouch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));
  if (trackListEl) {
    trackListEl.addEventListener('click', function (e) {
      var item = e.target.closest('.intro__tracklist-item');
      if (!item) return;
      e.stopPropagation();
      var si = parseInt(item.getAttribute('data-seq'), 10);
      if (!isNaN(si)) jumpToSeqIndex(si);
      closeTrackList();
    });
  }
  if (trackEl) {
    // desktop: hover the whole Now-Playing block to reveal the list; leaving hides it.
    trackEl.addEventListener('mouseenter', function () { if (!isTouch) openTrackList(); });
    trackEl.addEventListener('mouseleave', function () { if (!isTouch) closeTrackList(); });
  }
  if (trackBtn) {
    // mobile (and click anywhere): tap the title to toggle the slide-up sheet.
    trackBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (root.classList.contains('tracklist-open')) closeTrackList();
      else openTrackList();
    });
  }
  // tap/click outside closes the sheet (mainly for the mobile bottom-sheet)
  document.addEventListener('click', function (e) {
    if (!root.classList.contains('tracklist-open')) return;
    if (trackEl && trackEl.contains(e.target)) return;
    closeTrackList();
  });
  function resumeCtx() {
    if (actx && actx.state === 'suspended') {
      var p = actx.resume();
      if (p && p.then) p.then(updateAudioReady);
    }
    updateAudioReady();
  }
  function setPlaying(on) {
    playing = on;
    if (on) {
      resumeCtx();
      applyAudioLevel(1.0);
    } else {
      applyAudioLevel(0.4);
      setTimeout(function () { if (!playing && actx && actx.state === 'running') actx.suspend(); }, 450);
    }
    refreshPlayerUI();
  }
  function setMuted(on) {
    muted = on;
    if (!on) {                                   // first unmute "engages" the player UI
      if (!engaged) { engaged = true; pickWord(); }
      resumeCtx();
      playing = true;
    }
    applyAudioLevel(on ? 0.25 : FADE_IN);        // fade the music IN over FADE_IN on unmute
    refreshPlayerUI();
    if (on) closeTrackList();                    // muting also dismisses the track sheet
    tickCountdown();
    updateUpNext();
  }
  // the sequence index sounding right now (0 if not started / not ready)
  function currentSeqIndex() {
    if (!actx || !seq.length) return 0;
    var dur = seqDuration();
    var posInLoop = (actx.currentTime - aT0) % dur; if (posInLoop < 0) posInLoop += dur;
    return seqIndexAt(posInLoop);
  }
  // re-anchor the live playlist so track `ci` starts "now". The shared core of both the
  // prev/next arrows and the track-list menu — it stops the sounding sources, moves the
  // playhead, re-primes the "Now Playing" title, and (since a jumped-to full track may not be
  // decoded yet) lazy-loads the target buffer first so the jump actually sounds.
  function anchorAt(ci) {
    // any anchor supersedes an in-flight async jump: clear pendingJump so a slower load that
    // was kicked off earlier can't later yank playback away from this, the user's latest choice.
    pendingJump = -1;
    ci = ((ci % seq.length) + seq.length) % seq.length;
    var targetOffset = seq[ci].startAt + 0.02;
    stopAllSources();
    var when = actx.currentTime + 0.05;
    aT0 = when - targetOffset;
    if (actx.state === 'suspended') actx.resume();
    playing = true;
    pumpSchedule();                // queue the target track (+ what follows) from the new anchor
    // Instant feedback: name it from the TARGET track (the audio clock hasn't moved yet).
    // Then drop lastClipIdx so the tight clipWatch poll re-confirms against what's REALLY
    // sounding a beat later — self-correcting any drift between this guess and the anchor.
    pickWord(seq[ci].clip);
    lastClipIdx = -1;
    refreshPlayerUI();
    updateUpNext();
    tickCountdown();
  }
  function jumpToSeqIndex(ci) {
    if (!audioReady || !actx || !seq.length) return;
    ci = ((ci % seq.length) + seq.length) % seq.length;
    var id = seq[ci].clip.id;
    if (buffers[id]) { anchorAt(ci); return; }
    // target not decoded yet — hold briefly, load it, then anchor. Mark a pending jump so a
    // second rapid click supersedes this one rather than double-anchoring.
    pendingJump = ci;
    pickWord(seq[ci].clip);          // name it immediately so the bar responds to the click
    loadBuffer(id).then(function () {
      if (pendingJump === ci) { pendingJump = -1; anchorAt(ci); }
    }).catch(function () { if (pendingJump === ci) pendingJump = -1; });
  }
  var pendingJump = -1;
  // jump the live audio to another clip in the sequence (+ a fresh word)
  function skipClip(dir) {
    if (!audioReady || !actx || !seq.length) return;   // never act on a not-ready graph
    jumpToSeqIndex(currentSeqIndex() + dir);
  }
  if (btnPlay) btnPlay.addEventListener('click', function (e) { e.stopPropagation(); setPlaying(!playing); });
  if (btnMute) btnMute.addEventListener('click', function (e) { e.stopPropagation(); setMuted(!muted); });
  if (btnPrev) btnPrev.addEventListener('click', function (e) { e.stopPropagation(); skipClip(-1); });
  if (btnNext) btnNext.addEventListener('click', function (e) { e.stopPropagation(); skipClip(1); });

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
  // Map an item's full-screen display source to its ~600px sibling for the grid tiles, which
  // render only ~116-320px wide. Loading the 1920px disp there is ~10-30x waste and was
  // saturating mobile bandwidth (≈30MB of stills) so the grid stalled/looked broken. Every
  // still has a _rw_600 variant; handles both URL shapes. Videos/missing -> unchanged.
  //   "<id>_rw_1920.jpg" -> "<id>_rw_600.jpg"   ;   "<id>.jpg" -> "<id>_rw_600.jpg"
  function thumbUrl(item) {
    var u = item.disp;
    if (item.video || !u) return u;
    if (/_rw_\d+\.(?:jpe?g|png|webp)$/i.test(u)) return u.replace(/_rw_\d+(\.(?:jpe?g|png|webp))$/i, '_rw_600$1');
    return u.replace(/(\.(?:jpe?g|png|webp))$/i, '_rw_600$1');
  }
  // Load the full-res thumb `url` into `imgEl` (currently showing its LQIP) and, once it
  // decodes, swap + reveal it sharp. Keeps RETRYING on a growing cooldown if the fetch stalls
  // or fails, so a tile is never left permanently blurred by a dropped/queued request. On the
  // first genuine 404-style error it falls back to `dispUrl` (the full-size source) once.
  var hdUpgradeSeq = 0;   // spreads the initial attempts so they don't all fire at once
  var HD_STALL = 8000;    // if a fetch neither loads nor errors within this, treat it as stalled
  function upgradeToHD(imgEl, url, dispUrl) {
    var attempt = 0, triedDisp = false, done = false, settled = false;
    function finish(src) {
      done = true;
      imgEl.src = src;
      imgEl.classList.remove('is-lqip');
      imgEl.classList.add('is-loaded');
    }
    function retry() {
      // one retry per attempt: guard so a late onerror + the stall watchdog can't both fire it
      if (settled || done || !imgEl.isConnected) return;
      settled = true;
      attempt++;
      // cooldown grows with each attempt (2s, 3.5s, 5s … capped at 12s) — back off politely
      var cooldown = Math.min(12000, 2000 + attempt * 1500);
      setTimeout(tryLoad, cooldown);
    }
    function tryLoad() {
      if (done || !imgEl.isConnected) return;    // cell removed / already HD -> stop
      settled = false;
      var probe = new Image();
      probe.decoding = 'async';
      probe.onload = function () { if (!done) finish(probe.src); };
      probe.onerror = function () {
        // a genuine error (not just slow): try the full-size source once, then keep retrying
        if (!triedDisp && dispUrl && probe.src.indexOf(dispUrl) < 0) { triedDisp = true; url = dispUrl; }
        retry();
      };
      probe.src = url;
      // WATCHDOG: a stalled/queued connection fires neither event — abandon & retry after
      // HD_STALL. That's the case that used to leave a tile blurred forever.
      setTimeout(function () {
        if (done || settled) return;
        if (!probe.complete || !probe.naturalWidth) { probe.onload = probe.onerror = null; retry(); }
      }, HD_STALL);
    }
    // stagger the FIRST attempt (~40ms apart) so 50+ tiles don't stampede the ~6-connection
    // pool at build — the pile-up is what stalls fetches and leaves tiles blurred.
    setTimeout(tryLoad, (hdUpgradeSeq++ % 60) * 40);
  }
  function makeCell(item, level) {
    var cell = document.createElement('div');
    cell.className = 'intro__cell' + (item.video ? ' is-video' : '');
    // RESERVE the tile's height from its known aspect ratio BEFORE the media loads.
    // The masonry is CSS-columns: without a reserved height a not-yet-loaded <img>
    // collapses to the UA default (~150px), so when the real (and, on repeats, the
    // async-pixelated) source finally decodes the cell jumps to its true height and
    // every tile below it reflows — that's what tore the gaps into the grid on scroll.
    // Pinning aspect-ratio up front keeps the column packing stable across the load.
    if (item.w && item.h) cell.style.aspectRatio = item.w + ' / ' + item.h;
    // never show a broken source — if the media fails to load, drop the whole cell.
    function dropCell() { if (cell.parentNode) cell.parentNode.removeChild(cell); }
    var media;
    if (item.video) {
      media = document.createElement('video');
      // preload='none': the grid pre-builds ~18 video cells on load; eager metadata fetches
      // (×2 with webm) blew past mobile's concurrent-decoder + connection limits, stalling the
      // whole grid. The clip still loads on hover/tap (wireClipCell calls play()).
      media.muted = true; media.loop = true; media.playsInline = true; media.preload = 'none';
      media.setAttribute('muted', ''); media.setAttribute('playsinline', '');
      // a baked first-frame poster (data-URI) so the cell shows an image instantly with
      // preload='none' — without it the tile would be a blank box until played.
      if (item.lqip) media.poster = item.lqip;
      // drop the WebM source where it can't play (Safari/iOS) so we never fetch a dead source
      var canWebm = !!media.canPlayType && !!media.canPlayType('video/webm').replace('no', '');
      if (item.webm && canWebm) { var sw = document.createElement('source'); sw.src = item.webm; sw.type = 'video/webm'; media.appendChild(sw); }
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
      var thumb = thumbUrl(item);
      if (level > 0) {
        // progressive pixelation: quarter the dimensions per loop (nearest-neighbour),
        // then let CSS stretch it back to size. (pixelateImage's probe.onerror -> disp.)
        pixelateImage(thumb, media, level, item.w || 600, item.h || 600);
      } else if (item.lqip) {
        // INSTANT placeholder: the baked tiny base64 LQIP shows immediately (zero network),
        // so the grid is never empty/broken. The light 600px thumb loads in the background
        // and fades over the placeholder once decoded (falling back to disp if no _rw_600).
        media.classList.add('is-lqip');
        media.src = item.lqip;
        // COOLDOWN-RETRY upgrade to HD: firing all ~53+ tile fetches at once saturates the
        // browser's ~6-connection cap; any that stall leave a tile stuck blurred forever (the
        // old single onload never fired, no retry). Instead each tile keeps trying its full
        // thumb on a growing cooldown until it decodes, so a stalled/dropped fetch self-heals
        // into HD rather than staying an LQIP. Stagger the first attempt so they don't all
        // stampede the connection pool at build time.
        upgradeToHD(media, thumb, item.disp);
      } else {
        media.src = thumb;
      }
    }
    return cell;
  }
  // each repeat appends the whole gallery again, pixelated by its loop level.
  // Re-appending in the SAME order each loop made identical thumbs land in the same
  // column slot loop-after-loop — and because CSS-columns flows top-to-bottom then
  // wraps, the tail of one pass and the head of the next often share a screen, so two
  // copies of a piece sat side by side. Each repeat is shuffled with a per-level seed
  // (deterministic, so reloads are stable) to scatter the copies apart; level 0 stays
  // in curated montage order.
  function shuffledForLevel(level) {
    if (level <= 0) return gallery.slice();
    var arr = gallery.slice(), r = rng((0x51a1e ^ (level * 0x9e3779b1)) >>> 0);
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function appendGallerySet(level) {
    shuffledForLevel(level).forEach(function (item) { masonryEl.appendChild(makeCell(item, level)); });
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
      // clicking the zoomed IMAGE closes it (back to the grid, same scroll spot). Only for
      // images — videos/YT embeds keep their own click (play/pause, scrubber, controls).
      el.style.cursor = 'zoom-out';
      el.addEventListener('click', function (e) { e.stopPropagation(); closeLightbox(); });
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
    if (audioOn) fadeAudio(GRID_DUCK, 0.6);     // duck the bed while browsing the grid
  }
  function exitGrid() {
    gridMode = false;
    root.classList.remove('is-grid');
    gridEl.setAttribute('aria-hidden', 'true');
    closeLightbox();
    freshMontage();                              // come back to a NEW montage
    applyAudioLevel(1.2);                         // un-duck (respects play/mute state)
  }
  // single top button: in the MONTAGE it opens the GALLERY (grid); in the GALLERY it
  // returns to a MONTAGE. Its label swaps to match (see CSS + the two label spans).
  function toggleGrid(e) {
    if (e) e.stopPropagation();
    if (landing.active) endLanding();            // tapping the wordmark escapes landing first
    if (root.classList.contains('is-grid')) exitGrid();   // -> play a montage
    else enterGrid();                                     // -> open the gallery
  }
  titleEl.addEventListener('click', toggleGrid);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (root.classList.contains('is-lightbox')) closeLightbox(); else if (gridMode) exitGrid(); }
  });
  // a phone backgrounded during landing freezes BOTH the visuals clock and setTimeout; on
  // return to foreground, re-check the wall-clock deadline so a stalled landing exits at once.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && landing.active && landing.deadline && Date.now() > landing.deadline) endLanding();
  });
})();
