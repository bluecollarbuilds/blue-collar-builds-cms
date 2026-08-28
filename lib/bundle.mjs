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
/* OS and VCS noise a zip picks up. Deliberately NOT node_modules: a serverless
   function bundle ships its dependencies inside `<name>.func/node_modules/`, and
   dropping those leaves a function that cannot start. Only a node_modules at the
   very top of the bundle is source-tree noise worth skipping. */
const IGNORE_RE = /(^|\/)(\.DS_Store|Thumbs\.db|\.git\/|__MACOSX\/)/;
const ROOT_NODE_MODULES_RE = /^(?:[^/]+\/)?node_modules\//;

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
 * Where the servable pages live inside the bundle, and what must be carried
 * along untouched.
 *
 *   A modern build is not just pages. Vercel's Build Output (`.vercel/output/`)
 *   puts the pages under `static/`, and beside them keeps `config.json` — the
 *   redirects, cache headers and 404 rules — and `functions/`, the server code
 *   behind routes like /api/quote. A deployment REPLACES the site, so shipping
 *   only the pages silently deletes the redirects holding a client's search
 *   rankings and the endpoint their contact form posts to.
 *
 *   So: find the directory the pages live in, and treat everything outside it as
 *   opaque payload to be re-shipped byte-for-byte at its original path. The CMS
 *   never has to understand what those files do — only that they must survive.
 */
function findStaticRoot(names) {
  // Vercel Build Output: a config.json sitting next to a static/ directory.
  const cfg = names.find((n) => n === 'config.json' || n.endsWith('/config.json'));
  if (cfg) {
    const base = cfg.slice(0, cfg.length - 'config.json'.length);   // '' or '.vercel/output/'
    const staticPrefix = base + 'static/';
    if (names.some((n) => n.startsWith(staticPrefix) && HTML_RE.test(n))) return staticPrefix;
  }
  return '';                                                        // a plain dist/ folder
}

/**
 * Read a zipped build into { pages, assets, passthrough }.
 *   pages       — [{ file, route, slug, html }]  editable HTML, relative to the static root
 *   assets      — [{ path, bytes }]              CSS/images/JS beside them, same basis
 *   passthrough — [{ path, bytes }]              everything outside the static root, at its
 *                                                ORIGINAL path: config.json, functions/, etc.
 * Throws with a clear message when the zip contains no HTML at all.
 */
export function readBundle(buf, { maxFiles = 8000, maxBytes = 400 * 1024 * 1024 } = {}) {
  let files;
  try { files = unzipSync(new Uint8Array(buf)); }
  catch (e) { throw new Error(`could not read that .zip — ${e.message}`); }

  const names = Object.keys(files).filter((n) => !n.endsWith('/') && !IGNORE_RE.test(n)
    // a top-level node_modules is source-tree noise; one inside a .func bundle is
    // the function's own dependencies and must ship.
    && !(ROOT_NODE_MODULES_RE.test(n) && !n.includes('.func/')));
  if (!names.length) throw new Error('that .zip is empty');
  if (names.length > maxFiles) throw new Error(`too many files (${names.length}, limit ${maxFiles})`);

  const unwrap = stripCommonPrefix(names);
  const unwrapped = names.map((n) => ({ name: n, rel: unwrap(n).replace(/^\/+/, '') }))
    .filter(({ rel }) => rel && !rel.split('/').some((s) => s === '..' || s === '.'));

  const staticRoot = findStaticRoot(unwrapped.map((u) => u.rel));
  const pages = [];
  const assets = [];
  const passthrough = [];
  let total = 0;

  for (const { name, rel } of unwrapped) {
    const bytes = files[name];
    total += bytes.length;
    if (total > maxBytes) throw new Error('bundle is too large');

    if (staticRoot && !rel.startsWith(staticRoot)) {
      // Outside the pages directory: ship it back exactly as it came.
      passthrough.push({ path: rel, bytes: Buffer.from(bytes) });
      continue;
    }
    const inner = staticRoot ? rel.slice(staticRoot.length) : rel;
    if (!inner) continue;
    if (HTML_RE.test(inner)) pages.push({ file: inner, route: routeOfFile(inner), slug: slugFromFile(inner), html: strFromU8(bytes) });
    else assets.push({ path: inner, bytes: Buffer.from(bytes) });
  }

  if (!pages.length) throw new Error('no .html files found — is this the built output folder rather than the source?');

  // Home first, then shallowest paths, so the site's entry point anchors it.
  pages.sort((a, b) => {
    if (!a.slug) return -1;
    if (!b.slug) return 1;
    const d = a.file.split('/').length - b.file.split('/').length;
    return d || a.file.localeCompare(b.file);
  });
  return { pages, assets, passthrough, staticRoot, bytes: total };
}
