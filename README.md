# 1984drum.com

Static art portfolio for **1984drum** (Peter McClory), self-hosted on GitHub Pages.
Migrated from Adobe Portfolio — fully independent of any Adobe service.

## Structure

```
/                              index.html  (= the "Fragments of Infinity" landing page)
/new-work, /everything         gallery index pages
/contact                       contact form (Formspree)
/fragments-of-infinity-2022    project pages
/fragments-of-infinity-2021
/sketchbook
/early-work
/graphite-studies-2007-2016
/swap-or-burn
assets/img/                    all artwork + thumbnails (self-hosted, no external CDN)
assets/css/                    fonts.css, main.css, theme.css, app.css
assets/js/app.js               lazy-load + lightbox + mobile nav (replaces Adobe's 355 KB bundle)
assets/fonts/                  Roboto Slab (free replacement for Adobe's "Museo Slab")
CNAME                          custom domain (1984drum.com)
.nojekyll                      serve files as-is, no Jekyll processing
```

## ⚠️ One thing you must do: the contact form

The contact form posts to **Formspree** (a free form backend, since GitHub Pages
can't process forms itself). It currently uses a placeholder endpoint.

To activate it:
1. Sign up free at https://formspree.io and create a form (use your own email).
2. Formspree gives you an endpoint like `https://formspree.io/f/abcdwxyz`.
3. In `contact.html`, replace `YOUR_FORM_ID` in the form `action` with your real id.

Until then, the form looks correct but submissions won't be delivered.

## Editing the site

Everything is plain HTML/CSS/JS — edit the files directly and push. To add a new
artwork to a project page, copy an existing `<div class="project-module module image ...">`
block, drop the new image in `assets/img/`, and point `data-src` / `src` at it.

## Notes on the migration

- All images were downloaded from Adobe's CDN and are now served locally.
- Adobe analytics/tracking, page-transition code, and instrumentation attributes
  were stripped.
- The original font ("Museo Slab", Adobe Fonts) was replaced with the visually
  similar, freely licensed **Roboto Slab**, self-hosted as a single variable woff2.
