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

  // ---- Load frames (+ their afterimage "ghost" highlight layers) ----
  var images = new Array(FRAME_COUNT);
  var ghosts = new Array(FRAME_COUNT); // colour-inverted bright-region overlays
  var loaded = 0;
  function pad(i) { return (i < 10 ? '0' : '') + i; }
  function preload(i) {
    var im = new Image();
    im.onload = function () { loaded++; if (loaded === 1) { fit(); } };
    im.src = BASE + 'frame' + pad(i) + '.webp';
    images[i] = im;
    var gh = new Image();
    gh.src = BASE + 'ghost' + pad(i) + '.webp';
    ghosts[i] = gh;
  }

  // ---- Canvas sizing (devicePixelRatio aware) ----
  var W = 0, H = 0, dpr = 1;
  var FRAME_AR = 1100 / 660;
  function isFs() {
    return (document.fullscreenElement === root || document.webkitFullscreenElement === root);
  }
  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (isFs()) {
      // fill the screen, letterboxing to the frame aspect ratio
      var sw = window.innerWidth, sh = window.innerHeight;
      if (sw / sh > FRAME_AR) { H = sh; W = Math.round(sh * FRAME_AR); }
      else { W = sw; H = Math.round(sw / FRAME_AR); }
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    } else {
      var rect = root.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.round(W / FRAME_AR);
      canvas.style.width = '';
      canvas.style.height = H + 'px';
    }
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

  // ---- Retinal afterimage system -------------------------------------------
  // When a frame finishes (a transition begins), we "stamp" the bright/neon
  // shapes of the frame just stared at as a colour-INVERTED ghost. Each ghost
  // then drifts slowly, progressively blurs, and fades out over a random 5–10s —
  // mimicking the burn left on the retina after looking at something bright.
  var afterimages = [];        // active ghosts
  var lastStampedSlot = -1;    // so we stamp each frame exactly once

  // ---- Tunable parameters (exposed via the slider panel) -------------------
  // Defaults are deliberately bolder than the first pass so the effect is clearly
  // visible; tune live and read off the values to bake new defaults.
  var P = {
    intensity: 0.85,  // 0..2   overall brightness/opacity of the afterglow
    drama: 1.30,      // 0.4..2 contrast/punch of the glow (stacks + gamma)
    linger: 7.5,      // 3..16  base fade duration in seconds (±2s random)
    drift: 0.10,      // 0..0.4 how far ghosts wander as they fade (fraction of W)
    bloom: 10         // 0..30  max edge-blur (px) reached as the memory decays
  };

  function spawnAfterimage(frameIdx, elapsed, slot) {
    var gh = ghosts[frameIdx];
    if (!gh || !gh.complete || !gh.naturalWidth) return;
    var ang = Math.sin(slot * 9.17 + 1.3); // -1..1 drift direction seed
    afterimages.push({
      img: gh,
      kbIdx: frameIdx,          // reuse the frame's Ken-Burns path so it starts aligned
      kbTAtBirth: frameT(slot, elapsed),
      born: elapsed,
      lifeBase: slot,           // seed; actual life uses P.linger at draw time
      seedR: (Math.sin(slot * 41.3) * 0.5 + 0.5), // 0..1 stable per ghost
      dirX: Math.cos(ang * 3.1),
      dirY: Math.sin(ang * 2.3)
    });
    if (afterimages.length > 10) afterimages.shift(); // safety cap
  }

  function drawAfterimages(elapsed) {
    if (!afterimages.length || P.intensity <= 0) return;
    ctx.save();
    // additive glow: 'screen' lightens, so the inverted-colour ghost reads as a
    // luminous afterglow. Drama stacks the draw 1–2x with a gamma'd alpha for punch.
    ctx.globalCompositeOperation = 'screen';
    var passes = P.drama > 1.25 ? 2 : 1;
    for (var i = afterimages.length - 1; i >= 0; i--) {
      var a = afterimages[i];
      // lifetime driven live by the Linger control (so dragging it affects existing ghosts)
      var life = (P.linger + (a.seedR * 4 - 2)) * 1000; // ±2s spread
      if (life < 500) life = 500;
      var age = (elapsed - a.born) / life; // 0..1
      if (age >= 1) { afterimages.splice(i, 1); continue; }
      var fade = Math.pow(1 - age, 1.7);                       // ease-out lingering
      var alpha = Math.min(1, 0.32 * P.intensity * Math.pow(fade, 1 / P.drama));
      if (alpha < 0.008) { afterimages.splice(i, 1); continue; }
      var blurPx = (1 + age * P.bloom) * dpr;                  // grows with age
      var im = a.img;
      var kb = kbParams(a.kbIdx);
      var t = Math.min(1, a.kbTAtBirth + age * 0.25);
      var z = kb.z0 + (kb.z1 - kb.z0) * t;
      var ir = im.naturalWidth / im.naturalHeight, br = W / H, bw, bh;
      if (ir > br) { bh = H; bw = H * ir; } else { bw = W; bh = W / ir; }
      var dw = bw * z, dh = bh * z;
      var panX = (kb.px * t - kb.px * 0.5) * W + a.dirX * P.drift * age * W;
      var panY = (kb.py * t - kb.py * 0.5) * H + a.dirY * P.drift * age * H;
      ctx.filter = 'blur(' + blurPx.toFixed(1) + 'px)';
      var dx = (W - dw) / 2 + panX, dy = (H - dh) / 2 + panY;
      for (var pp = 0; pp < passes; pp++) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(im, dx, dy, dw, dh);
      }
    }
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
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
      // at the START of the dissolve, stamp the outgoing frame's afterimage once
      if (!prefersReduced && slot !== lastStampedSlot) {
        lastStampedSlot = slot;
        spawnAfterimage(idx, elapsed, slot);
      }
      drawDissolve(idx, next, p, frameT(slot, elapsed), frameT(slot + 1, elapsed));
    }

    // Shadows: dim the base imagery so the afterglow reads stronger / moodier.
    if (P.shadows > 0) {
      ctx.save();
      ctx.globalAlpha = P.shadows * 0.6;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // afterimages drawn on top of everything, glowing and fading
    if (!prefersReduced) drawAfterimages(elapsed);
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
  var soundOn = false;
  function setSound(on) {
    soundOn = on;
    if (audio) {
      audio.muted = !on;
      if (on) audio.play().catch(function () {});
    }
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
      btn.title = on ? 'Mute soundscape' : 'Play soundscape';
    }
  }
  if (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();      // don't trigger the fullscreen click on the canvas
      setSound(!soundOn);
    });
  }
  setSound(false); // start muted

  // ---- Click the piece to go fullscreen (auto-enables sound) ----------------
  function inFullscreen() {
    return document.fullscreenElement === root || document.webkitFullscreenElement === root;
  }
  function enterFullscreen() {
    var fn = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
    if (fn) {
      try { var pr = fn.call(root); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
    }
    setSound(true); // fullscreen turns sound ON (stays on after exit)
  }
  // click anywhere on the canvas/piece toggles fullscreen (the sound button stops
  // propagation so it won't also fullscreen). Hover affordance handled in CSS.
  canvas.addEventListener('click', function () {
    if (inFullscreen()) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (ex) { try { ex.call(document); } catch (e) {} }
    } else {
      enterFullscreen();
    }
  });
  // keep the canvas sized to the fullscreen viewport while fullscreen, and restore after
  function onFsChange() {
    root.classList.toggle('is-fullscreen', inFullscreen());
    fit();
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // Shadows dimming param (no longer slider-driven; kept at 0 by default).
  P.shadows = 0;
})();
