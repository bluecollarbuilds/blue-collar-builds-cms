/**
 * autotag.mjs — the universal ingester. Given ANY rendered HTML (static site,
 * React/Vue/Svelte SPA snapshot, AI-built page — doesn't matter), it finds the
 * editable content leaves and produces a frozen template + content model.
 *
 * No per-site code. The rule that makes it general:
 *   tag an element when it has non-empty DIRECT text (its own text nodes) —
 *   that naturally targets leaf text holders (h1, p, the <span> inside a
 *   button) and skips structural containers. Inline children (em/strong/span/
 *   br/a) are kept as an allowed formatting whitelist; images/videos are tagged
 *   by source.
 */
import { load } from 'cheerio';

const INLINE = new Set(['em', 'strong', 'b', 'i', 'span', 'br', 'a', 'small', 'sup', 'sub', 'mark', 'code', 'u', 'abbr', 'time']);
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'path', 'head', 'title', 'meta', 'link']);
// Tags whose text we never want to treat as editable copy on its own.
const SKIP_TEXT_TAGS = new Set(['html', 'body', 'header', 'footer', 'main', 'section', 'nav', 'ul', 'ol', 'div', 'article', 'aside', 'form']);

/** Direct (immediate) text of a node, ignoring descendants. */
function directText($, el) {
  let t = '';
  for (const c of el.children || []) if (c.type === 'text') t += c.data;
  return t.replace(/\s+/g, ' ').trim();
}

/** Does this element hold a meaningful block of text directly? */
function isTextLeaf($, el) {
  if (SKIP.has(el.tagName) || SKIP_TEXT_TAGS.has(el.tagName)) return false;
  const dt = directText($, el);
  if (dt.length < 2) return false;                       // nothing real to edit
  if (/^[#•·|—–\-+/\\]+$/.test(dt)) return false;        // pure separators/icons
  return true;
}

/** Allowed inline tags actually present as children (for rich fields). */
function inlineChildren($, el) {
  const tags = new Set();
  $(el).children().each((_, c) => { if (INLINE.has(c.tagName)) tags.add(c.tagName); });
  return [...tags];
}

function groupOf($, el) {
  const sec = $(el).closest('section[id], header, footer, nav, main');
  if (!sec.length) return 'Page';
  const node = sec.get(0);
  const id = node.attribs?.id;
  if (id) return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return node.tagName.charAt(0).toUpperCase() + node.tagName.slice(1);
}

/**
 * A declared field's path already names it better than any guess from the
 * markup: `hero.primaryCta.label` beats `Link: "Get A Quote"`. Numbers are
 * array positions, so they read as "2." rather than as a name.
 */
function labelForPath(path) {
  const words = (s) => s.replace(/[-_]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
  const segs = String(path).split('.');
  return segs.map((seg, i) => (/^\d+$/.test(seg) ? `${Number(seg) + 1}.` : words(seg)))
    .join(' · ').replace(/ · (\d+\.)/g, ' $1');
}

function label(tag, text) {
  const kind = /^h[1-6]$/.test(tag) ? 'Heading' : tag === 'p' ? 'Text' : tag === 'li' ? 'List item'
    : tag === 'a' ? 'Link' : tag === 'button' ? 'Button' : tag === 'span' ? 'Text' : tag === 'blockquote' ? 'Quote' : 'Text';
  const snip = text.length > 38 ? text.slice(0, 36) + '…' : text;
  return `${kind}: "${snip}"`;
}

/** Make relative asset URLs absolute against the source origin so the snapshot
 *  renders correctly when served from a different origin. */
function absolutize($, baseUrl) {
  if (!baseUrl) return;
  const fix = (v) => {
    if (!v || /^(https?:|data:|blob:|#|mailto:|tel:)/i.test(v) || v.startsWith('//')) return v;
    try { return new URL(v, baseUrl).href; } catch { return v; }
  };
  // A srcset is "url 1x, url 2x" / "url 800w" — each url needs fixing, and the
  // descriptors must survive. Browsers PREFER srcset over src, so leaving these
  // alone means the browser picks a broken candidate over the good one.
  const fixSrcset = (v) => String(v).split(',').map((part) => {
    const seg = part.trim();
    if (!seg) return null;
    const sp = seg.search(/\s/);
    return sp === -1 ? fix(seg) : fix(seg.slice(0, sp)) + seg.slice(sp);
  }).filter(Boolean).join(', ');

  $('img[src], img[srcset], video[src], source[src], source[srcset], video[poster], link[href]').each((_, el) => {
    if (el.attribs.src != null) $(el).attr('src', fix(el.attribs.src));
    if (el.attribs.srcset != null) $(el).attr('srcset', fixSrcset(el.attribs.srcset));
    if (el.attribs.poster != null) $(el).attr('poster', fix(el.attribs.poster));
    if (el.attribs.href != null && el.tagName === 'link') $(el).attr('href', fix(el.attribs.href));
  });
}

/**
 * @param rawHtml  the page's markup
 * @param baseUrl  where it came from, so relative URLs can be absolutised
 * @param opts.keepScripts
 *   Keep the site's own <script> tags. Removing them makes a URL-fetched page a
 *   stable static snapshot, but it also deletes the behaviour the markup depends
 *   on — a mobile menu that ships open and is closed by JS on load stays open
 *   forever. When we have the real built files (a dist/ bundle), the scripts are
 *   part of the working site and are kept.
 */
export function autotag(rawHtml, baseUrl, opts = {}) {
  const $ = load(rawHtml, { decodeEntities: false });
  if (!opts.keepScripts) $('script').remove();
  // Autoplay videos must be muted or browsers block playback (poster-only).
  $('video[autoplay]').attr('muted', '').attr('playsinline', '');
  absolutize($, baseUrl);

  const schema = {};
  const content = {};
  let n = 0;

  /*
   * DECLARED FIELDS FIRST.
   *
   * A site built to the CMS contract states which content field produced each
   * element — `data-cms="hero.heading"`, with `data-cms-source` on <body>
   * naming the file. That is strictly better information than anything the
   * heuristic below can infer, and it is the only thing that lets an edit be
   * published back to the site's repository. So it wins, always:
   *
   *   · a declared element is registered under its own field path, never
   *     renamed to a generated id
   *   · nothing inside a declared element is tagged separately — the reference
   *     site's hero <h1> contains a <span> for its emphasised phrase, and
   *     tagging that span instead would edit half a headline
   *
   * Pages with no declared fields are untouched by this and fall through to the
   * heuristic exactly as before.
   */
  const declaredSource = $('[data-cms-source]').first().attr('data-cms-source') || null;
  $('[data-cms]').each((_, el) => {
    const node = $(el);
    if (node.parents('[data-cms]').length) return;          // outer field wins
    const raw = node.attr('data-cms');
    if (!raw) return;
    const hash = raw.indexOf('#');
    const source = hash === -1 ? declaredSource : (raw.slice(0, hash) || declaredSource);
    const path = hash === -1 ? raw : raw.slice(hash + 1);
    // Key by file AND path, so two content files using the same section name
    // cannot collide on a page that renders both.
    const id = `${source || ''}#${path}`;
    node.attr('data-cms', id);
    // Marks the subtree as spoken for. Also tells the editor this field can be
    // published back to the repo, which a heuristically-found one cannot.
    node.attr('data-cms-bound', '');
    schema[id] = {
      type: 'text',
      label: labelForPath(path),
      group: groupOf($, el),
      // Bound fields are plain text: the value goes into a JSON string, and the
      // site re-derives any inline markup from it on the next build.
      rich: false,
      allow: [],
      bound: { source, path },
    };
    content[id] = node.text().replace(/\s+/g, ' ').trim();
  });

  // TEXT leaves — walk in document order; tag the deepest meaningful text holders.
  $('*').each((_, el) => {
    // Inside (or at) a field the site already declared — leave it alone.
    if ($(el).closest('[data-cms-bound]').length) return;
    if (!isTextLeaf($, el)) return;
    // If a descendant is itself a text leaf, this is a container — skip it.
    let hasLeafChild = false;
    $(el).find('*').each((_, d) => { if (isTextLeaf($, d)) hasLeafChild = true; });
    if (hasLeafChild) return;

    const inl = inlineChildren($, el);
    const rich = inl.length > 0;
    const id = `cms-${++n}`;
    $(el).attr('data-cms', id);
    const value = rich ? ($(el).html() || '').trim() : directText($, el);
    schema[id] = { type: 'text', label: label(el.tagName, directText($, el)), group: groupOf($, el), rich, allow: rich ? inl : [] };
    content[id] = value;
  });

  // IMAGES + VIDEO POSTERS.
  $('img').each((_, el) => {
    const src = $(el).attr('src'); if (!src) return;
    const id = `cms-${++n}`;
    $(el).attr('data-cms-img', id);
    schema[id] = { type: 'image', label: `Image: ${$(el).attr('alt') || src.split('/').pop()}`.slice(0, 48), group: groupOf($, el), rich: false, allow: [] };
    content[id] = src;
  });
  $('video[poster]').each((_, el) => {
    const id = `cms-${++n}`;
    $(el).attr('data-cms-img', id);
    schema[id] = { type: 'image', label: 'Video poster', group: groupOf($, el), rich: false, allow: [] };
    content[id] = $(el).attr('poster');
  });

  // META + SEO — title, Google description, and social-share (OG) tags.
  const title = $('head > title');
  if (title.length) { title.attr('data-cms', `cms-${++n}`); schema[`cms-${n}`] = { type: 'text', label: 'Browser tab title', group: 'SEO & social', rich: false, allow: [] }; content[`cms-${n}`] = title.text().trim(); }
  const metaFields = [
    ['meta[name="description"]', 'Google meta description'],
    ['meta[property="og:title"]', 'Social share title'],
    ['meta[property="og:description"]', 'Social share description'],
    ['meta[property="og:image"]', 'Social share image URL'],
    ['meta[name="twitter:title"]', 'Twitter card title'],
    ['meta[name="twitter:description"]', 'Twitter card description'],
  ];
  for (const [sel, lbl] of metaFields) {
    const el = $(sel).first();
    if (!el.length || !el.attr('content')) continue;
    const id = `cms-${++n}`;
    el.attr('data-cms', id);
    schema[id] = { type: 'meta-attr', label: lbl, group: 'SEO & social', rich: false, allow: [] };
    content[id] = el.attr('content');
  }

  // COLLECTIONS — detect repeatable sibling structures (cards, list items,
  // tiers, nav links) so V2 can add/remove/duplicate them generically.
  const collections = detectCollections($);

  // Landmarks for the structural-invariant check.
  const sections = [];
  $('section[id], header, footer, main, nav').each((_, el) => {
    sections.push(el.attribs?.id ? `#${el.attribs.id}` : el.tagName);
  });

  return { templateHtml: $.html(), content, schema, sections: [...new Set(sections)], collections };
}

const ITEM_TAGS = new Set(['div', 'article', 'li', 'a', 'button', 'figure', 'blockquote', 'tr', 'details', 'section']);
const classSet = (el) => new Set((el.attribs?.class || '').split(/\s+/).filter(Boolean));
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Find sibling groups that repeat (same tag + similar classes) and contain
 *  tagged content. Annotate the container + items; return collection metadata. */
function detectCollections($) {
  const collections = [];
  let col = 0;
  $('*').each((_, parent) => {
    if ($(parent).attr('data-cms-collection')) return;
    const kids = ($(parent).children().toArray() || []).filter((c) => c.type === 'tag' && ITEM_TAGS.has(c.tagName));
    if (kids.length < 2) return;
    const used = new Set();
    for (let i = 0; i < kids.length; i++) {
      if (used.has(i)) continue;
      const ci = classSet(kids[i]);
      const group = [i];
      for (let j = i + 1; j < kids.length; j++) {
        if (used.has(j)) continue;
        if (kids[j].tagName === kids[i].tagName && jaccard(ci, classSet(kids[j])) >= 0.6) group.push(j);
      }
      if (group.length < 2) continue;
      const members = group.map((g) => kids[g]);
      const everyHasContent = members.every((m) => $(m).is('[data-cms],[data-cms-img]') || $(m).find('[data-cms],[data-cms-img]').length > 0);
      if (!everyHasContent) continue;
      col++; const id = `col${col}`;
      $(parent).attr('data-cms-collection', id);
      members.forEach((m, k) => { used.add(group[k]); $(m).attr('data-cms-item', id); });
      const sec = $(parent).closest('section[id], header, footer, nav, main');
      const gname = sec.length ? (sec.get(0).attribs?.id || sec.get(0).tagName) : 'Page';
      collections.push({ id, count: members.length, itemTag: members[0].tagName, label: `${gname} items` });
    }
  });
  return collections;
}
