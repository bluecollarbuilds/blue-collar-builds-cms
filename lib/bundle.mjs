/**
 * bundle.mjs — ingesting a site from its BUILT OUTPUT (an `astro build` dist/
 * folder, zipped) rather than by fetching and re-deriving it from the live URL.
 *
 *   WHY THIS IS THE PRIMARY PATH
 *   Rebuilding a site from fetched HTML is lossy in ways that cannot be patched:
 *     · scripts had to be stripped, which kills every JS-driven behaviour — a
 *       mobile menu that JS closes on load stays stuck open forever
 *     · responsive images carry srcset/sizes and <picture><source>; miss one
 *       attribute and the browser picks the broken candidate over the good one
 *     · anything the server rendered differently for a bot, lazy-loaded, or
 *       injected at runtime simply is not in the fetched HTML
 *
 *   The dist/ folder has none of those problems: it is the exact set of files
 *   that already works when deployed. We take the HTML files as editable pages
 *   and everything else verbatim, changing nothing we do not have to.
 */
import { unzipSync, strFromU8 } from 'fflate';

const HTML_RE = /\.html?$/i;
/* Files a build emits that should never become pages or ship as assets. */
const IGNORE_RE = /(^|\/)(\.DS_Store|Thumbs\.db|\.git\/|__MACOSX\/|node_modules\/)/;

/** Zip entries often sit under a single wrapper dir ("dist/"); strip it. */
export function stripCommonPrefix(paths) {
  const dirs = paths.map((p) => p.split('/')[0]);
  const first = dirs[0];
  if (paths.length > 1 && dirs.every((d) => d === first) && paths.every((p) => p.includes('/'))) {
    return (p) => p.slice(first.length + 1);
  }
  return (p) => p;
}

/** "about/index.html" -> "about";  "index.html" -> "";  "contact.html" -> "contact" */
export function slugFromFile(file) {
  const p = file.replace(HTML_RE, '').replace(/\/index$/i, '');
  return p === 'index' ? '' : p;
}

/** The URL path a built HTML file is served at. */
export const routeOfFile = (file) => '/' + slugFromFile(file);

/**
 * Read a zipped build into { pages, assets }.
 *   pages  — [{ file, route, slug, html }]  every .html, in a stable order
 *   assets — [{ path, bytes }]              everything else, byte-for-byte
 * Throws with a clear message when the zip contains no HTML at all.
 */
export function readBundle(buf, { maxFiles = 3000, maxBytes = 200 * 1024 * 1024 } = {}) {
  let files;
  try { files = unzipSync(new Uint8Array(buf)); }
  catch (e) { throw new Error(`could not read that .zip — ${e.message}`); }

  const names = Object.keys(files).filter((n) => !n.endsWith('/') && !IGNORE_RE.test(n));
  if (!names.length) throw new Error('that .zip is empty');
  if (names.length > maxFiles) throw new Error(`too many files (${names.length}, limit ${maxFiles})`);

  const unwrap = stripCommonPrefix(names);
  const pages = [];
  const assets = [];
  let total = 0;

  for (const name of names) {
    const rel = unwrap(name).replace(/^\/+/, '');
    if (!rel || rel.split('/').some((s) => s === '..' || s === '.')) continue;
    const bytes = files[name];
    total += bytes.length;
    if (total > maxBytes) throw new Error('bundle is too large');
    if (HTML_RE.test(rel)) pages.push({ file: rel, route: routeOfFile(rel), slug: slugFromFile(rel), html: strFromU8(bytes) });
    else assets.push({ path: rel, bytes: Buffer.from(bytes) });
  }

  if (!pages.length) throw new Error('no .html files found — is this the built output folder (dist/) rather than the source?');

  // Home first, then shallowest paths, so the site's entry point anchors it.
  pages.sort((a, b) => {
    if (!a.slug) return -1;
    if (!b.slug) return 1;
    const d = a.file.split('/').length - b.file.split('/').length;
    return d || a.file.localeCompare(b.file);
  });
  return { pages, assets, bytes: total };
}
