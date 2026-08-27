/**
 * assets.mjs — mirroring a captured site's CSS, images and fonts.
 *
 *   WHY THIS EXISTS
 *   A Vercel deployment is a COMPLETE snapshot of the site, not a patch. Publishing
 *   a bundle of just HTML therefore deletes everything else that was there — including
 *   the /_astro/*.css the captured HTML links to. The result is a live site with no
 *   styling at all, destroyed by its own publish.
 *
 *   So whatever the CMS publishes has to carry the whole site with it. On capture we
 *   download every same-origin asset the page references and keep it alongside the
 *   content; every publish then ships those files too, at their original paths, so
 *   `/_astro/main.css` still resolves after the deploy replaces the site.
 *
 *   Cross-origin assets (a CDN, Google Fonts) are deliberately LEFT ALONE — they are
 *   served by someone else and keep working, and mirroring them would mean re-hosting
 *   third-party files we do not control.
 */

const ASSET_MARK = '/__cms-asset/';

/* Attributes pointing at something the page needs in order to render. `script` is
   included because a built bundle keeps its JavaScript — that JS is precisely what
   a fetched-HTML capture used to throw away. */
const ASSET_ATTRS = [
  ['link[href]', 'href'],
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['img[srcset]', 'srcset'],
  ['source[src]', 'src'],
  ['source[srcset]', 'srcset'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
  ['object[data]', 'data'],
];

export { ASSET_MARK };

/** "https://x.com/_astro/a.css?v=1" -> "_astro/a.css". Null if unusable or unsafe. */
export function assetPathOf(url, origin, base) {
  let u;
  try { u = new URL(url, base || origin || undefined); } catch { return null; }
  if (u.origin !== origin) return null;                 // third-party: leave it alone
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!path || path.endsWith('/')) return null;         // a page, not a file
  // Refuse anything that could escape the asset directory.
  if (path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  if (!/^[\w.\-/@%+]+$/.test(path)) return null;
  return path;
}

/** A srcset is "url 1x, url 2x" — map each url, keep the descriptors. */
const mapSrcset = (value, fn) => value.split(',').map((part) => {
  const seg = part.trim();
  if (!seg) return null;
  const sp = seg.indexOf(' ');
  const url = sp === -1 ? seg : seg.slice(0, sp);
  const rest = sp === -1 ? '' : seg.slice(sp);
  return fn(url) + rest;
}).filter(Boolean).join(', ');

/**
 * Every same-origin asset URL the document references, plus a rewrite step.
 * Returns { urls, rewrite } — call rewrite(keptSet) once you know which were
 * actually mirrored, so anything that failed to download keeps its original
 * absolute URL rather than pointing at a file we do not have.
 */
export function collectHtmlAssets($, origin, base) {
  const found = new Map();                              // raw attr value -> asset path
  const seen = [];

  for (const [sel, attr] of ASSET_ATTRS) {
    $(sel).each((_, el) => {
      const raw = el.attribs?.[attr];
      if (!raw) return;
      const note = (u) => { const p = assetPathOf(u, origin, base); if (p) found.set(u, p); return u; };
      if (attr === 'srcset') mapSrcset(raw, note); else note(raw);
      seen.push({ el, attr });
    });
  }

  const rewrite = (kept) => {
    const swap = (u) => (kept.has(u) ? ASSET_MARK + found.get(u) : u);
    for (const { el, attr } of seen) {
      const raw = el.attribs?.[attr];
      if (!raw) continue;
      el.attribs[attr] = attr === 'srcset' ? mapSrcset(raw, swap) : swap(raw);
    }
  };

  return { urls: [...found.keys()], rewrite };
}

/**
 * CSS pulls in its own files — fonts, background images, @import-ed sheets — and
 * those break just as loudly as a missing stylesheet. Returns the URLs found
 * (absolute) and a rewrite that swaps in local paths for the ones we kept.
 */
export function collectCssAssets(css, cssUrl, origin) {   // cssUrl doubles as the base
  const found = new Map();
  const RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
  for (const m of css.matchAll(RE)) {
    const raw = (m[2] ?? m[4] ?? '').trim();
    if (!raw || /^(data:|blob:|#)/i.test(raw)) continue;
    let abs; try { abs = new URL(raw, cssUrl).href; } catch { continue; }
    if (assetPathOf(abs, origin)) found.set(raw, abs);
  }
  const rewrite = (kept) => css.replace(RE, (whole, q1, u1, q3, u4) => {
    const raw = (u1 ?? u4 ?? '').trim();
    const abs = found.get(raw);
    if (!abs || !kept.has(abs)) return whole;
    // Root-relative from the CSS file's own location works wherever the sheet sits.
    const local = ASSET_MARK + assetPathOf(abs, origin);
    return u1 != null ? `url(${q1}${local}${q1})` : `@import ${q3}${local}${q3}`;
  });
  return { urls: [...found.values()], rewrite };
}

/** Swap the internal marker for wherever the assets are actually being served. */
export const resolveAssetUrls = (html, prefix) =>
  String(html).split(ASSET_MARK).join(prefix ? `${prefix.replace(/\/+$/, '')}/` : '/');
