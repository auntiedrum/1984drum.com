/*
 * app.js — minimal, dependency-free replacement for Adobe Portfolio's runtime.
 * Provides the three behaviours the static site actually needs:
 *   1. Lazy-loading of gallery / content images (data-src -> src).
 *   2. A click-to-zoom lightbox for content images, with prev/next + keyboard.
 *   3. The mobile hamburger nav and the back-to-top control.
 *
 * No analytics, no tracking, no page-transition machinery — just the parts a
 * visitor sees. Original site shipped a 355 KB minified bundle for this.
 */
(function () {
  'use strict';

  /* ---------- 1. Lazy-load images ---------- */
  // Each lazy image carries data-src / data-srcset / data-sizes placeholders.
  // We promote them to real attributes as they approach the viewport.
  function loadImage(img) {
    if (img.dataset.loaded) return;
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    if (img.dataset.sizes) img.sizes = img.dataset.sizes;
    if (img.dataset.src) img.src = img.dataset.src;
    img.dataset.loaded = '1';
    // `is-loaded` drives our fade-in; `image-loaded` is what the theme CSS keys
    // off to clear the grey placeholder background on grid/cover images.
    img.classList.add('is-loaded', 'image-loaded');
  }

  // Reveal the masonry grid (theme ships it `visibility: hidden`, expecting JS).
  // The CSS override in app.css handles the no-JS case; this matches the
  // original behaviour for anything keyed off the `.grid--ready` class.
  Array.prototype.slice.call(document.querySelectorAll('.grid--main')).forEach(function (g) {
    g.classList.add('grid--ready');
  });

  var lazyImgs = Array.prototype.slice.call(document.querySelectorAll('img.js-lazy'));

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          loadImage(e.target);
          obs.unobserve(e.target);
        }
      });
    }, { rootMargin: '400px 0px' }); // start loading a bit before they scroll in
    lazyImgs.forEach(function (img) { io.observe(img); });
  } else {
    // Old browsers: just load everything up front.
    lazyImgs.forEach(loadImage);
  }

  /* ---------- 2. Lightbox ---------- */
  // Content images are wrapped in <div class="js-lightbox" data-src="<full-res>">.
  var lightboxItems = Array.prototype.slice.call(document.querySelectorAll('.js-lightbox[data-src]'));

  if (lightboxItems.length) {
    var overlay = document.createElement('div');
    overlay.className = 'lb-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<button class="lb-close" aria-label="Close">&times;</button>' +
      '<button class="lb-prev" aria-label="Previous">&#8249;</button>' +
      '<button class="lb-next" aria-label="Next">&#8250;</button>' +
      '<img class="lb-img" alt="">';
    document.body.appendChild(overlay);

    var lbImg = overlay.querySelector('.lb-img');
    var current = -1;

    function show(i) {
      if (i < 0) i = lightboxItems.length - 1;
      if (i >= lightboxItems.length) i = 0;
      current = i;
      var src = lightboxItems[i].getAttribute('data-src');
      var inner = lightboxItems[i].querySelector('img');
      lbImg.alt = inner ? (inner.getAttribute('alt') || '') : '';
      lbImg.src = src;
    }
    function open(i) {
      show(i);
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lb-locked');
    }
    function close() {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lb-locked');
      lbImg.removeAttribute('src');
    }

    lightboxItems.forEach(function (item, i) {
      item.style.cursor = 'zoom-in';
      item.addEventListener('click', function (ev) {
        ev.preventDefault();
        open(i);
      });
    });

    overlay.querySelector('.lb-close').addEventListener('click', close);
    overlay.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(current - 1); });
    overlay.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); show(current + 1); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay || e.target === lbImg) close(); });
    document.addEventListener('keydown', function (e) {
      if (!overlay.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(current - 1);
      else if (e.key === 'ArrowRight') show(current + 1);
    });
  }

  /* ---------- 3. Mobile nav + back-to-top ---------- */
  var hamburger = document.querySelector('.js-hamburger');
  var respNav = document.querySelector('.js-responsive-nav');
  var closeNav = document.querySelector('.js-close-responsive-nav');

  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    if (respNav) respNav.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (hamburger) hamburger.addEventListener('click', function () {
    setNav(!document.body.classList.contains('nav-open'));
  });
  if (closeNav) closeNav.addEventListener('click', function () { setNav(false); });
  if (respNav) {
    respNav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') setNav(false); // close after picking a page
    });
  }

  // Back-to-top links (both the inline one and the fixed floating button).
  Array.prototype.slice.call(document.querySelectorAll('.back-to-top a, .js-back-to-top')).forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Show the floating back-to-top button only after scrolling down a bit.
  var fixedTop = document.querySelector('.js-back-to-top');
  if (fixedTop) {
    var onScroll = function () {
      fixedTop.classList.toggle('is-visible', window.pageYOffset > 600);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- 4. Footer copyright year ---------- */
  // Keep the footer year current. The HTML ships a hard-coded fallback year so the
  // footer is correct even without JS; this just bumps it on each new year.
  var yearEl = document.getElementById('copyright-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
