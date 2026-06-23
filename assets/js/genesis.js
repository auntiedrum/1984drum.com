/*
 * genesis.js — "Fragments of Infinity" looping image animation.
 *
 * Cycles through a sequence of AI-generated island/treehouse frames that have been
 * pre-ordered by visual similarity (so each morphs into a look-alike neighbour and
 * the loop closes seamlessly). Frames are held ~2s each, then cross over to the next
 * via an 8-bit ORDERED-DITHER "noise dissolve": pixels swap from the old frame to the
 * new one in a structured Bayer-matrix order, evoking a retro low-bit transition.
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
  var HOLD_MS = 2000;          // time each frame is shown
  var TRANSITION_MS = 900;     // length of the dither dissolve
  if (!FRAME_COUNT) return;

  var canvas = root.querySelector('.genesis__canvas');
  var ctx = canvas.getContext('2d');

  // ---- Pre-compute an ordered Bayer 8x8 dither threshold map (values 0..63) ----
  var BAYER8 = (function () {
    var m2 = [[0, 2], [3, 1]];
    function grow(m) {
      var n = m.length, s = n * 2, out = [];
      for (var y = 0; y < s; y++) {
        out[y] = [];
        for (var x = 0; x < s; x++) {
          var q = (y < n ? 0 : 2) + (x < n ? 0 : 1); // quadrant offset 0..3
          out[y][x] = 4 * m[y % n][x % n] + q;
        }
      }
      return out;
    }
    return grow(grow(m2)); // 2 -> 4 -> 8
  })();

  // ---- Load frames ----
  var images = new Array(FRAME_COUNT);
  var loaded = 0;
  function pad(i) { return (i < 10 ? '0' : '') + i; }
  function preload(i) {
    var im = new Image();
    im.onload = function () { images[i] = im; loaded++; if (loaded === 1) { fit(); draw(0); } };
    im.src = BASE + 'frame' + pad(i) + '.webp';
    images[i] = im;
  }

  // Canvas sizing: match the displayed box, account for devicePixelRatio for sharpness.
  var W = 0, H = 0, dpr = 1;
  function fit() {
    var rect = root.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(rect.width));
    // 16:9.6 frames (1100x660) -> keep that aspect
    H = Math.round(W * 660 / 1100);
    canvas.style.height = H + 'px';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawImageCover(im) {
    if (!im || !im.complete || !im.naturalWidth) return;
    // cover-fit into W x H
    var ir = im.naturalWidth / im.naturalHeight, br = W / H, dw, dh, dx, dy;
    if (ir > br) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
    else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
    ctx.drawImage(im, dx, dy, dw, dh);
  }

  function draw(i) { ctx.clearRect(0, 0, W, H); drawImageCover(images[i]); }

  // ---- Dither dissolve from frame `from` to `to`, progress 0..1 ----
  // We reveal `to` over `from` using a clip mask built from the Bayer threshold:
  // a pixel shows the new frame once progress passes its 8x8-tiled threshold.
  // To keep it cheap, we draw the new frame fully, then punch out (clear) the
  // not-yet-revealed cells and redraw the old frame there — done per dither cell.
  var maskCanvas = document.createElement('canvas');
  var maskCtx = maskCanvas.getContext('2d');

  function buildMask(progress) {
    // Build a small mask at dither resolution then scale up: 1 = show NEW frame.
    var cells = 64; // mask granularity (cols); rows scaled to aspect
    var rows = Math.round(cells * H / W);
    if (maskCanvas.width !== cells || maskCanvas.height !== rows) {
      maskCanvas.width = cells; maskCanvas.height = rows;
    }
    var img = maskCtx.createImageData(cells, rows);
    var d = img.data;
    var thresh = progress * 64; // 0..64
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cells; x++) {
        var t = BAYER8[y & 7][x & 7]; // 0..63
        var on = t < thresh ? 255 : 0;
        var o = (y * cells + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = on;
      }
    }
    maskCtx.putImageData(img, 0, 0);
  }

  function drawTransition(from, to, progress) {
    // old frame as background
    draw(from);
    // new frame, masked by the dither pattern
    buildMask(progress);
    ctx.save();
    // use the mask as a clip via globalCompositeOperation
    // 1) draw new frame to an offscreen, 2) keep only masked area, 3) composite.
    var off = drawTransition._off || (drawTransition._off = document.createElement('canvas'));
    var octx = drawTransition._octx || (drawTransition._octx = off.getContext('2d'));
    if (off.width !== canvas.width || off.height !== canvas.height) { off.width = canvas.width; off.height = canvas.height; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);
    // draw new frame cover-fit onto offscreen
    (function () {
      var im = images[to]; if (!im || !im.complete || !im.naturalWidth) return;
      var ir = im.naturalWidth / im.naturalHeight, br = W / H, dw, dh, dx, dy;
      if (ir > br) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
      else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
      octx.drawImage(im, dx, dy, dw, dh);
    })();
    // punch with mask (destination-in keeps new frame only where mask alpha>0)
    octx.globalCompositeOperation = 'destination-in';
    octx.imageSmoothingEnabled = false; // hard-edged 8-bit blocks
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
    octx.globalCompositeOperation = 'source-over';
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // composite offscreen (new-frame-masked) over the old frame
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.restore();
  }

  // ---- Animation loop ----
  var cur = 0;
  var state = 'hold';
  var tStart = 0;
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The clock is driven by a setInterval (which keeps running even when
  // requestAnimationFrame is throttled, e.g. a backgrounded tab) so the loop never
  // gets stuck. We use performance.now() for elapsed timing.
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function step() {
    var t = now();
    if (!tStart) tStart = t;
    var el = t - tStart;
    if (state === 'hold') {
      if (el >= HOLD_MS) {
        var next = (cur + 1) % FRAME_COUNT;
        if (images[next] && images[next].complete && images[next].naturalWidth) {
          state = 'trans'; tStart = t;
        } else {
          tStart = t; // next frame not ready yet — keep holding, try again
        }
      }
    } else { // transition
      var p = prefersReduced ? 1 : Math.min(1, el / TRANSITION_MS);
      drawTransition(cur, (cur + 1) % FRAME_COUNT, p);
      if (p >= 1) { cur = (cur + 1) % FRAME_COUNT; state = 'hold'; tStart = t; draw(cur); }
    }
  }

  // ~30fps tick: smooth enough for the dither dissolve, cheap, and timer-driven
  // so it survives rAF throttling. Redraw the held frame each tick too (covers
  // late-loading first frame / resize while holding).
  var ticker = setInterval(function () {
    if (state === 'hold') { draw(cur); }
    step();
  }, 33);

  // ---- Init ----
  fit();
  window.addEventListener('resize', function () { fit(); if (state === 'hold') draw(cur); });
  for (var i = 0; i < FRAME_COUNT; i++) preload(i);

  // ---- Audio: muted by default, unmute toggle ----
  var audio = root.querySelector('.genesis__audio');
  var btn = root.querySelector('.genesis__sound');
  if (audio && btn) {
    var on = false;
    function render() {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
      btn.title = on ? 'Mute soundscape' : 'Play soundscape';
    }
    btn.addEventListener('click', function () {
      on = !on;
      audio.muted = !on;
      if (on) { audio.play().catch(function () {}); }
      render();
    });
    render();
    // browsers require a user gesture; we start muted+paused and play on first unmute.
  }
})();
