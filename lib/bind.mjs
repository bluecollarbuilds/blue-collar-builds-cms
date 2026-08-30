/**
 * bind.mjs — connecting what is on the screen to the field that produced it.
 *
 *   THE PROBLEM THIS SOLVES
 *   The editor shows a client their real, built site. They click a headline and
 *   type. To publish that we must write the new text into the right field of the
 *   right content file in the site's repository — and being wrong is not a
 *   cosmetic bug, it silently rewrites the wrong copy.
 *
 *   The tempting approach is to search the content file for the text that was on
 *   screen. It does not survive contact with a real site:
 *     · a heading split around an emphasised phrase renders as several nodes
 *     · two pages legitimately carry the same sentence
 *     · copy edited in the repo no longer matches what the CMS last ingested
 *     · text assembled in a template ("N years serving X") matches nothing
 *
 *   So the page states it instead. Each element rendered from a content field
 *   carries `data-cms` naming that field, and the document carries
 *   `data-cms-source` naming the file those fields live in:
 *
 *       <body data-cms-source="pages/home.json">
 *         <h1 data-cms="hero.heading">…</h1>
 *
 *   Nothing is inferred, so nothing can be inferred wrongly. This module reads
 *   those attributes, resolves paths against the JSON, and — importantly —
 *   checks that the two agree before anyone is allowed to depend on them.
 */
import { load } from 'cheerio';

/** Split 'hero.highlights.0' into ['hero','highlights',0]. */
export function parsePath(path) {
  return String(path).split('.').filter((s) => s !== '')
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/**
 * A binding may name a file other than the document's default, so that a page
 * assembled from several content files still addresses each field exactly:
 *   'hero.heading'                        -> the document's own source
 *   'locations/mason-oh.json#hero.heading'-> that file
 */
export function splitSource(raw, fallback) {
  const i = String(raw).indexOf('#');
  if (i === -1) return { source: fallback, path: String(raw) };
  return { source: String(raw).slice(0, i) || fallback, path: String(raw).slice(i + 1) };
}

/** Read `hero.highlights.0` out of a content object. `undefined` if absent. */
export function getField(obj, path) {
  let cur = obj;
  for (const seg of parsePath(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Return a copy of `obj` with `path` set to `value`.
 *
 * Copies rather than mutates so a rejected edit cannot leave a half-written
 * object behind, and refuses to invent structure: writing `hero.heading` into a
 * file with no `hero` is a sign the site and the CMS disagree about the content
 * shape, which must surface as an error rather than as a new stray key.
 */
export function setField(obj, path, value) {
  const segs = parsePath(path);
  if (!segs.length) throw new Error('empty field path');

  const walk = (node, i) => {
    const seg = segs[i];
    const wantArray = typeof seg === 'number';
    if (node == null || typeof node !== 'object' || Array.isArray(node) !== wantArray) {
      throw new Error(`cannot write "${path}": ${segs.slice(0, i).join('.') || '(root)'} is not ${wantArray ? 'an array' : 'an object'}`);
    }
    if (!(seg in node)) throw new Error(`cannot write "${path}": no field "${segs.slice(0, i + 1).join('.')}" in this content file`);
    const copy = Array.isArray(node) ? node.slice() : { ...node };
    copy[seg] = i === segs.length - 1 ? value : walk(node[seg], i + 1);
    return copy;
  };
  return walk(obj, 0);
}

/**
 * Every field the page declares, in document order.
 *   { source, bindings: [{ path, source, text, tag, index }] }
 *
 * `text` is what the browser shows for that element, which is what an editor
 * compares against. Elements nested inside another bound element are skipped:
 * a bound <h1> containing a bound <span> would otherwise be edited twice, and
 * the outer write would clobber the inner one.
 */
export function readBindings(html) {
  const $ = load(html);
  const source = $('[data-cms-source]').first().attr('data-cms-source') || null;
  const bindings = [];
  $('[data-cms]').each((index, el) => {
    const node = $(el);
    if (node.parents('[data-cms]').length) return;      // nested — outer wins
    const raw = node.attr('data-cms');
    if (!raw) return;
    const { source: src, path } = splitSource(raw, source);
    bindings.push({ path, source: src, text: node.text().trim(), tag: el.tagName, index });
  });
  return { source, bindings };
}

/**
 * Check the page and the content files actually agree, and report every way
 * they do not. This runs at ingest, before any editing is offered, so that a
 * site whose attributes have drifted from its content is known immediately
 * rather than discovered by a client whose edit went to the wrong place.
 *
 * `contents` maps a source filename to its parsed JSON.
 * Returns { bound, ok, problems: [{ kind, path, source, expected, found }] }.
 */
export function verifyBindings(html, contents) {
  const { bindings } = readBindings(html);
  const problems = [];
  let ok = 0;

  for (const b of bindings) {
    if (!b.source) { problems.push({ kind: 'no-source', ...b }); continue; }
    const content = contents[b.source];
    if (!content) { problems.push({ kind: 'missing-file', ...b }); continue; }

    const value = getField(content, b.path);
    if (value === undefined) { problems.push({ kind: 'missing-field', ...b }); continue; }
    if (typeof value !== 'string') { problems.push({ kind: 'not-text', ...b, found: typeof value }); continue; }

    // Whitespace differs freely between JSON and rendered HTML — the browser
    // collapses runs of it — so compare on collapsed whitespace, not verbatim.
    if (collapse(value) !== collapse(b.text)) {
      problems.push({ kind: 'text-differs', ...b, expected: value });
      continue;
    }
    ok++;
  }
  return { bound: bindings.length, ok, problems };
}

/**
 * Group a page's bindings by the field they name.
 *
 * One field can legitimately render in several places: the reference site's
 * pricing card labels appear once per tier, so `pricing.annualLabel` owns three
 * elements on the page. The editor has to treat those as one thing — editing
 * any of them changes the field, and every node showing it must update — or the
 * client sees two of the three change and reports the site as broken.
 *
 * Returns [{ source, path, text, nodes: [index] }] in first-appearance order.
 */
export function groupFields(bindings) {
  const byKey = new Map();
  for (const b of bindings) {
    const key = `${b.source || ''}#${b.path}`;
    const g = byKey.get(key);
    if (g) g.nodes.push(b.index);
    else byKey.set(key, { source: b.source, path: b.path, text: b.text, nodes: [b.index] });
  }
  return [...byKey.values()];
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();
