/*
 * genesis.js — "Fragments of Infinity" looping image animation.
 *
 * Cycles through a sequence of AI-generated island/treehouse frames that have been
 * pre-ordered by visual similarity (so each morphs into a look-alike neighbour and
 * the loop closes seamlessly). Each frame gets a slow, continuous Ken-Burns pan &
 * zoom so it always feels cinematic and alive, and frames merge into one another
 * with a soft, feathered organic dissolve (a long cross-fade modulated by smooth
 * low-frequency noise — flowing, not pixelated).
 *
 * A looping ambient soundscape sits alongside, muted by default with an unmute toggle.
 *
 * Self-contained, no dependencies. Driven by a #genesis container in the HTML.
 */
(function () {
  'use strict';

  var root = document.getElementById('genesis');
  if (!root) return;

  var FRAME_COUNT = parseInt(root.getAttribute('data-frames'), 10) || 0;
  var BASE = root.getAttribute('data-base') || 'assets/anim/';
  if (!FRAME_COUNT) return;

  var HOLD_MS = 3200;        // how long before the dissolve to the next frame begins
  var TRANSITION_MS = 2200;  // long, soft cross-dissolve so frames truly merge
  var CYCLE_MS = HOLD_MS + TRANSITION_MS; // total time each frame "owns"

  var canvas = root.querySelector('.genesis__canvas');
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // ---- Load frames ----
  var images = new Array(FRAME_COUNT);
  var loaded = 0;
  function pad(i) { return (i < 10 ? '0' : '') + i; }
  function preload(i) {
    var im = new Image();
    im.onload = function () { loaded++; if (loaded === 1) { fit(); } };
    im.src = BASE + 'frame' + pad(i) + '.webp';
    images[i] = im;
  }

  // ---- Canvas sizing (devicePixelRatio aware) ----
  var W = 0, H = 0, dpr = 1;
  function fit() {
    var rect = root.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 660 / 1100); // frames are 1100x660
    canvas.style.height = H + 'px';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  // ---- Ken-Burns motion ----------------------------------------------------
  // Each frame index gets a deterministic, gentle pan+zoom path. We vary the
  // direction per frame (using the index) so consecutive frames drift differently,
  // but every move is slow and subtle. Motion is continuous across hold+dissolve.
  function kbParams(i) {
    // pseudo-random but stable per index
    var a = Math.sin(i * 12.9898) * 43758.5453; a -= Math.floor(a); // 0..1
    var b = Math.sin(i * 78.233) * 12543.123;   b -= Math.floor(b);
    var ang = a * Math.PI * 2;
    return {
      z0: 1.06 + b * 0.04,           // start zoom 1.06..1.10
      z1: 1.14 + a * 0.05,           // end zoom   1.14..1.19 (always zooming in)
      px: Math.cos(ang) * 0.05,      // pan vector x (fraction of width)
      py: Math.sin(ang) * 0.05       // pan vector y
    };
  }

  // Draw frame `i` cover-fit, with Ken-Burns transform driven by t in 0..1
  // (t = how far through this frame's own life we are), at the given alpha.
  function drawFrame(i, t, alpha) {
    var im = images[i];
    if (!im || !im.complete || !im.naturalWidth) return;
    var kb = kbParams(i);
    var z = kb.z0 + (kb.z1 - kb.z0) * t;          // interpolate zoom
    // base cover-fit dims at zoom 1
    var ir = im.naturalWidth / im.naturalHeight, br = W / H, bw, bh;
    if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
    var dw = bw * z, dh = bh * z;
    // pan: move from -pan/2 to +pan/2 across the frame's life, centred
    var panX = (kb.px * t - kb.px * 0.5) * W;
    var panY = (kb.py * t - kb.py * 0.5) * H;
    var dx = (W - dw) / 2 + panX;
    var dy = (H - dh) / 2 + panY;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(im, dx, dy, dw, dh);
    ctx.restore();
  }

  // ---- Soft feathered noise mask (built once, low-res, smooth) --------------
  // A blurred value-noise field. During a dissolve we cross-fade globally AND
  // bias the per-region alpha by this field so the merge happens in organic
  // patches rather than a uniform fade or hard blocks. It's drawn smoothed
  // (bilinear) so it reads as flowing cloud-like dissolve, never pixels.
  var noiseCanvas = document.createElement('canvas');
  var noiseReady = false;
  (function buildNoise() {
    var NW = 48, NH = 28;
    noiseCanvas.width = NW; noiseCanvas.height = NH;
    var nctx = noiseCanvas.getContext('2d');
    var img = nctx.createImageData(NW, NH);
    // simple smoothed value noise: average a few random octaves
    function rnd(x, y, s) { var v = Math.sin((x * 127.1 + y * 311.7) * s) * 43758.5453; return v - Math.floor(v); }
    for (var y = 0; y < NH; y++) {
      for (var x = 0; x < NW; x++) {
        var v = 0.5 * rnd(x, y, 1) + 0.3 * rnd(x * 0.5, y * 0.5, 2.3) + 0.2 * rnd(x * 0.25, y * 0.25, 4.7);
        var o = (y * NW + x) * 4;
        var c = Math.round(v * 255);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = c; img.data[o + 3] = 255;
      }
    }
    nctx.putImageData(img, 0, 0);
    noiseReady = true;
  })();

  // Offscreen for compositing the incoming frame with a feathered mask
  var off = document.createElement('canvas');
  var octx = off.getContext('2d');

  function drawDissolve(fromI, toI, p, tFrom, tTo) {
    // p: 0..1 dissolve progress. Smooth ease.
    var e = p * p * (3 - 2 * p); // smoothstep
    // 1) old frame (still Ken-Burns moving) as the base, fully opaque
    drawFrame(fromI, tFrom, 1);
    // 2) incoming frame onto offscreen, masked by a softened threshold of the
    //    noise field that widens with progress -> patches grow and feather in.
    if (off.width !== canvas.width || off.height !== canvas.height) { off.width = canvas.width; off.height = canvas.height; }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // draw incoming frame (Ken-Burns) into offscreen
    (function () {
      var im = images[toI]; if (!im || !im.complete || !im.naturalWidth) return;
      var kb = kbParams(toI);
      var z = kb.z0 + (kb.z1 - kb.z0) * tTo;
      var ir = im.naturalWidth / im.naturalHeight, br = W / H, bw, bh;
      if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
      var dw = bw * z, dh = bh * z;
      var panX = (kb.px * tTo - kb.px * 0.5) * W;
      var panY = (kb.py * tTo - kb.py * 0.5) * H;
      octx.drawImage(im, (W - dw) / 2 + panX, (H - dh) / 2 + panY, dw, dh);
    })();
    // build the feathered alpha mask for the incoming frame:
    // keep the incoming pixels where (noise < threshold-band). The band is wide
    // and the noise is upscaled smoothly => soft, growing organic reveal.
    if (noiseReady) {
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.globalCompositeOperation = 'destination-in';
      octx.imageSmoothingEnabled = true; // smooth upscaling => feathered edges
      // Two overlaid passes: a global fade (e) + a noise-biased reveal, combined
      // by drawing the smoothed noise with an alpha that ramps with progress.
      // Simpler & robust: alpha = clamp((e*1.6 - noise*0.6)) — approximate by
      // drawing noise at low alpha then a flat fill at alpha e.
      // Pass A: organic patches — draw smoothed inverted noise, alpha grows with e
      octx.globalAlpha = Math.min(1, e * 1.15);
      octx.drawImage(noiseCanvas, 0, 0, off.width, off.height);
      // Pass B: ensure full reveal by the end — flat alpha = e^1.5
      octx.globalAlpha = Math.pow(e, 1.6);
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, off.width, off.height);
      octx.globalAlpha = 1;
      octx.globalCompositeOperation = 'source-over';
    }
    // 3) composite the feathered incoming frame over the old one
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset; drawFrame manages its own transform via W/H coords
  }

  // ---- Timeline ------------------------------------------------------------
  // A single global clock. At time `now`, we're on frame `cur` for CYCLE_MS,
  // holding for HOLD_MS then dissolving to next over TRANSITION_MS. Ken-Burns
  // `t` for a frame runs 0..1 across its full CYCLE so motion is continuous.
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var startClock = null;
  function clk() { return ((window.performance && performance.now) ? performance.now() : Date.now()); }

  // Each frame's Ken-Burns motion runs across its ENTIRE visible life — from the
  // moment it begins fading in, through its hold, until it finishes fading out —
  // as one continuous timeline. So a frame's `t` is the SAME function of the clock
  // whether it's currently the incoming or the outgoing frame: no snap at handoff.
  //
  // Frame i "owns" the slot starting at i*CYCLE_MS. It becomes visible TRANSITION_MS
  // earlier (its fade-in) and stays until (i+1)*CYCLE_MS (end of its fade-out), so
  // its life spans LIFE = TRANSITION_MS + CYCLE_MS.
  var LIFE = CYCLE_MS + TRANSITION_MS;

  // Ken-Burns t (0..1) for the frame occupying global slot `slot`, at absolute
  // `elapsed` ms. slot can exceed FRAME_COUNT or be the "next" slot; the image
  // index is slot % FRAME_COUNT. t is continuous and clamped to [0,1].
  function frameT(slot, elapsed) {
    var lifeStart = slot * CYCLE_MS - TRANSITION_MS; // when this frame began fading in
    var t = (elapsed - lifeStart) / LIFE;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  function render() {
    if (loaded === 0) return;
    if (startClock === null) startClock = clk();
    var elapsed = clk() - startClock;
    var slot = Math.floor(elapsed / CYCLE_MS);
    var into = elapsed - slot * CYCLE_MS; // 0..CYCLE_MS within the current slot
    var idx = ((slot % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
    var next = (idx + 1) % FRAME_COUNT;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (into < HOLD_MS || prefersReduced) {
      // hold: just the current frame, continuing its single motion path
      drawFrame(idx, frameT(slot, elapsed), 1);
    } else {
      // dissolve: outgoing (slot) and incoming (slot+1) each evaluated on their
      // OWN continuous life-timeline, so neither jumps when the slot advances.
      var p = (into - HOLD_MS) / TRANSITION_MS; // 0..1
      drawDissolve(idx, next, p, frameT(slot, elapsed), frameT(slot + 1, elapsed));
    }
  }

  // Drive rendering with a setInterval so it keeps running even when
  // requestAnimationFrame is throttled (background tab / some headless renderers).
  // The interval paints directly; we don't gate on rAF (that could deadlock if rAF
  // never fires). ~33ms ≈ 30fps, smooth enough for the slow pan and long dissolve.
  setInterval(render, 33);
  render(); // paint immediately once the first frame is available

  // ---- Init ----
  fit();
  window.addEventListener('resize', fit);
  for (var i = 0; i < FRAME_COUNT; i++) preload(i);

  // ---- Audio: muted by default, unmute toggle ----
  var audio = root.querySelector('.genesis__audio');
  var btn = root.querySelector('.genesis__sound');
  if (audio && btn) {
    var on = false;
    function renderBtn() {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
      btn.title = on ? 'Mute soundscape' : 'Play soundscape';
    }
    btn.addEventListener('click', function () {
      on = !on;
      audio.muted = !on;
      if (on) { audio.play().catch(function () {}); }
      renderBtn();
    });
    renderBtn();
  }
})();
