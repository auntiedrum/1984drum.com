/*
 * mosaic.js — one-page justified-rows mosaic of every artwork.
 *
 * Layout: a Flickr/Google-Photos style "justified" mosaic. Tiles keep their exact
 * aspect ratios; each row is scaled to a common height so it fills the container
 * width edge-to-edge, with a 4px gutter between tiles and above each row. Reflows
 * on resize (the row packing is recomputed for the current width).
 *
 * Order: tiles are placed in priority order (highest-rated first, top-left then
 * down). Each tile carries a 1–10 rating control; ratings persist in localStorage.
 * Changing a rating re-sorts and re-lays-out live. A baked default order/ratings can
 * be shipped via the data on each tile so visitors see the curated arrangement.
 *
 * Click a tile (not its rating control) to open it in the shared lightbox (app.js).
 */
(function () {
  'use strict';

  var root = document.getElementById('mosaic');
  if (!root) return;

  var GUTTER = 4;                 // px between tiles and above rows
  var TARGET_ROW_H = 260;         // preferred row height (tiles scale around this)
  var STORE_KEY = 'mosaic-ratings-v1';

  // Read the tile data emitted in the HTML: each .mosaic__item carries
  // data-full, data-src (display), data-srcset, data-w, data-h, data-id,
  // data-rating (baked default), data-order (baked default order index).
  var items = Array.prototype.slice.call(root.querySelectorAll('.mosaic__item')).map(function (el, i) {
    return {
      el: el,
      id: el.getAttribute('data-id'),
      w: parseFloat(el.getAttribute('data-w')) || 4,
      h: parseFloat(el.getAttribute('data-h')) || 3,
      bakedRating: parseFloat(el.getAttribute('data-rating')) || 0,
      bakedOrder: parseInt(el.getAttribute('data-order'), 10),
      img: el.querySelector('img')
    };
  });
  items.forEach(function (it) {
    it.ar = it.w / it.h;
    // make each tile keyboard-focusable and announce it as an "open" button
    it.el.setAttribute('tabindex', '0');
    it.el.setAttribute('role', 'button');
    it.el.setAttribute('aria-label', (it.img && it.img.getAttribute('alt')) ? ('Open artwork: ' + it.img.getAttribute('alt')) : 'Open artwork');
  });

  // ---- ratings (localStorage overlay on top of baked defaults) ----
  var ratings = {};
  try { ratings = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { ratings = {}; }
  function ratingOf(it) {
    return (it.id in ratings) ? ratings[it.id] : it.bakedRating; // user rating overrides baked
  }
  function saveRatings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ratings)); } catch (e) {}
  }

  // ---- ordering: rating desc, then baked order, then DOM order (stable) ----
  function sortItems() {
    items.forEach(function (it, i) { if (it._dom === undefined) it._dom = i; });
    return items.slice().sort(function (a, b) {
      var ra = ratingOf(a), rb = ratingOf(b);
      if (rb !== ra) return rb - ra;                 // higher rating first
      var oa = isNaN(a.bakedOrder) ? a._dom : a.bakedOrder;
      var ob = isNaN(b.bakedOrder) ? b._dom : b.bakedOrder;
      return oa - ob;
    });
  }

  // ---- justified-rows layout ----
  // Greedy: accumulate tiles into a row until the row (at TARGET_ROW_H) would
  // overflow the container width, then scale that row's height so it fits exactly.
  function layout() {
    var containerW = root.clientWidth;
    if (containerW <= 0) return;
    var ordered = sortItems();
    // reflect order in the DOM (so tab/source order matches visual order)
    ordered.forEach(function (it) { root.appendChild(it.el); });

    // Pack tiles into rows. When adding a tile would overflow the row at the
    // target height, decide whether the row fits BETTER with or without that tile
    // (closest-fit), so the justified row height stays centred near the target
    // instead of being systematically short.
    var rows = [];
    var row = [], rowAR = 0;
    function rowHeightFor(ar, count) {
      var gutters = (count - 1) * GUTTER;
      return (containerW - gutters) / ar; // exact-fit height for this row
    }
    ordered.forEach(function (it) {
      var newAR = rowAR + it.ar;
      var gutters = row.length * GUTTER; // gutters if we add this tile (row.length tiles already)
      var widthAtTarget = newAR * TARGET_ROW_H + gutters;
      if (widthAtTarget >= containerW && row.length > 0) {
        // closest-fit: compare resulting row height with vs without the new tile
        var hWith = rowHeightFor(newAR, row.length + 1);
        var hWithout = rowHeightFor(rowAR, row.length);
        if (Math.abs(hWith - TARGET_ROW_H) < Math.abs(hWithout - TARGET_ROW_H)) {
          row.push(it); rowAR = newAR;          // including it lands closer to target
          rows.push({ tiles: row }); row = []; rowAR = 0;
        } else {
          rows.push({ tiles: row });            // close the row without it
          row = [it]; rowAR = it.ar;
        }
      } else {
        row.push(it); rowAR = newAR;
      }
    });
    if (row.length) rows.push({ tiles: row, last: true });

    rows.forEach(function (r) {
      var tiles = r.tiles;
      var n = tiles.length;
      var gutters = (n - 1) * GUTTER;
      var sumAR = tiles.reduce(function (s, t) { return s + t.ar; }, 0) || 1;
      // exact row height so the row fills (containerW - gutters)
      var rowH = (containerW - gutters) / sumAR;
      // The last (partial) row is never stretched taller than the target — render
      // it at its natural target-ish height and left-align (leave the trailing gap).
      if (r.last) rowH = Math.min(rowH, TARGET_ROW_H);
      var rowHr = Math.round(rowH);
      // Distribute rounding so the row's tiles + gutters sum EXACTLY to the available
      // width (last row excepted): track remaining width, give the last tile the rest.
      var avail = containerW - gutters;
      var used = 0;
      tiles.forEach(function (it, ci) {
        var w;
        if (!r.last && ci === n - 1) {
          w = avail - used;                 // last tile absorbs the rounding remainder
        } else {
          w = Math.round(it.ar * rowH);
          used += w;
        }
        if (w < 1) w = 1;
        it.el.style.width = w + 'px';
        it.el.style.height = rowHr + 'px';
        it.el.style.marginRight = (ci < n - 1) ? GUTTER + 'px' : '0';
        it.el.style.marginBottom = GUTTER + 'px';
      });
    });
  }

  // throttle resize with rAF
  var raf = null;
  function scheduleLayout() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = null; layout(); });
  }
  window.addEventListener('resize', scheduleLayout);

  // lazy-load tile images (they ship with data-src like the galleries). Add the
  // fade-in class only once the real image has actually decoded, so the .35s
  // opacity transition reveals the artwork (not the placeholder) and a 404 stays
  // hidden rather than fading an empty box in.
  function loadImg(img) {
    if (img.dataset.loaded) return;
    img.dataset.loaded = '1';
    img.addEventListener('load', function () { img.classList.add('is-loaded'); }, { once: true });
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    if (img.dataset.src) img.src = img.dataset.src;
    // if it's already complete (cached), the load event may not fire — reveal now
    if (img.complete && img.naturalWidth > 1) img.classList.add('is-loaded');
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (e) { if (e.isIntersecting) { loadImg(e.target); obs.unobserve(e.target); } });
    }, { rootMargin: '600px 0px' });
    items.forEach(function (it) { io.observe(it.img); });
  } else {
    items.forEach(function (it) { loadImg(it.img); });
  }

  // ---- rating control per tile ----
  function buildRating(it) {
    var bar = document.createElement('div');
    bar.className = 'mosaic__rate';
    var label = document.createElement('span');
    label.className = 'mosaic__rate-val';
    function refresh() {
      var r = ratingOf(it);
      label.textContent = r ? r : '–';
      it.el.setAttribute('data-current-rating', r || 0);
    }
    // a compact 1–10 control: minus / value / plus, plus a clear
    var dec = document.createElement('button'); dec.type = 'button'; dec.textContent = '−'; dec.className = 'mosaic__rate-btn';
    var inc = document.createElement('button'); inc.type = 'button'; inc.textContent = '+'; inc.className = 'mosaic__rate-btn';
    function setR(v) {
      v = Math.max(0, Math.min(10, v));
      if (v === 0) delete ratings[it.id]; else ratings[it.id] = v;
      saveRatings(); refresh(); scheduleLayout();
    }
    dec.addEventListener('click', function (e) { e.stopPropagation(); setR((ratingOf(it) || 0) - 1); });
    inc.addEventListener('click', function (e) { e.stopPropagation(); setR((ratingOf(it) || 0) + 1); });
    bar.appendChild(dec); bar.appendChild(label); bar.appendChild(inc);
    bar.addEventListener('click', function (e) { e.stopPropagation(); });
    it.el.appendChild(bar);
    refresh();
  }
  items.forEach(buildRating);

  // ---- click/keyboard tile -> accessible lightbox ----
  var overlay = document.createElement('div');
  overlay.className = 'lb-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Artwork viewer');
  overlay.innerHTML = '<button class="lb-close" aria-label="Close">&times;</button>' +
    '<button class="lb-prev" aria-label="Previous">&#8249;</button>' +
    '<button class="lb-next" aria-label="Next">&#8250;</button><img class="lb-img" alt="">';
  document.body.appendChild(overlay);
  var lbImg = overlay.querySelector('.lb-img');
  var lbClose = overlay.querySelector('.lb-close');
  var curIdx = -1;
  var lastFocus = null; // tile to restore focus to on close
  function visualOrder() { return Array.prototype.slice.call(root.querySelectorAll('.mosaic__item')); }
  function openAt(i, triggerEl) {
    var els = visualOrder();
    if (!els.length) return;
    if (i < 0) i = els.length - 1; if (i >= els.length) i = 0;
    curIdx = i;
    var el = els[i];
    lbImg.src = el.getAttribute('data-full');
    lbImg.alt = el.getAttribute('aria-label') ? el.getAttribute('aria-label').replace(/^Open artwork:?\s*/, '') : '';
    if (triggerEl) lastFocus = triggerEl;
    overlay.classList.add('is-open');
    document.body.classList.add('lb-locked');
    lbClose.focus(); // move focus into the modal
  }
  function close() {
    overlay.classList.remove('is-open');
    document.body.classList.remove('lb-locked');
    lbImg.removeAttribute('src');
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); } // restore focus to the tile
  }
  root.addEventListener('click', function (e) {
    var tile = e.target.closest('.mosaic__item');
    if (!tile || e.target.closest('.mosaic__rate')) return;
    openAt(visualOrder().indexOf(tile), tile);
  });
  // keyboard: Enter/Space on a focused tile opens it (ignoring the rating controls)
  root.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var tile = e.target.closest && e.target.closest('.mosaic__item');
    if (!tile || tile !== e.target || e.target.closest('.mosaic__rate')) return;
    e.preventDefault();
    openAt(visualOrder().indexOf(tile), tile);
  });
  lbClose.addEventListener('click', close);
  overlay.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); openAt(curIdx - 1); });
  overlay.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); openAt(curIdx + 1); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay || e.target === lbImg) close(); });
  document.addEventListener('keydown', function (e) {
    if (!overlay.classList.contains('is-open')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowLeft') { openAt(curIdx - 1); return; }
    if (e.key === 'ArrowRight') { openAt(curIdx + 1); return; }
    if (e.key === 'Tab') {
      // trap focus within the overlay's buttons while the modal is open
      var focusables = Array.prototype.slice.call(overlay.querySelectorAll('button'));
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (focusables.indexOf(document.activeElement) === -1) { e.preventDefault(); first.focus(); }
    }
  });

  // ---- "Copy order" helper for baking (visible via the rating toolbar) ----
  var bakeBtn = root.parentElement.querySelector('.mosaic__bake');
  if (bakeBtn) {
    bakeBtn.addEventListener('click', function () {
      var ordered = sortItems();
      var payload = ordered.map(function (it, i) { return { id: it.id, rating: ratingOf(it), order: i }; });
      var text = JSON.stringify(payload);
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
      bakeBtn.textContent = 'Copied order ✓';
      setTimeout(function () { bakeBtn.textContent = 'Copy curated order'; }, 1800);
    });
  }

  // initial layout (uses intrinsic data dims, not loaded image sizes). The first
  // pass runs while the page is still short (no vertical scrollbar yet); its own
  // height output then summons the scrollbar and shrinks clientWidth, so we relayout
  // on the next frames once the scrollbar state has settled — otherwise rows render
  // a scrollbar-width too wide and trigger a horizontal scrollbar.
  layout();
  requestAnimationFrame(function () { requestAnimationFrame(layout); });
  setTimeout(layout, 120);
  window.addEventListener('load', layout);
})();
