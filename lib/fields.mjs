/**
 * fields.mjs — SEO + style + link "virtual fields", stored in the page content
 * map under prefixed keys so they flow through pending → Guardian → publish:
 *   seo:<field>            page SEO/meta (title, description, favicon, og…)
 *   style:<cms-id>:<prop>  bounded per-element style (spacing, type, align)
 *   link:<cms-id>          href for a link/button element
 */
import { load } from 'cheerio';

/* ── Elementor-style controls, hard-bounded ── */
export const STYLE_SPEC = {
  marginTop:     { css: 'margin-top',     min: -8, max: 160, unit: 'px', label: 'Space above' },
  marginBottom:  { css: 'margin-bottom',  min: -8, max: 160, unit: 'px', label: 'Space below' },
  paddingTop:    { css: 'padding-top',    min: 0,  max: 160, unit: 'px', label: 'Padding top' },
  paddingBottom: { css: 'padding-bottom', min: 0,  max: 160, unit: 'px', label: 'Padding bottom' },
  fontSize:      { css: 'font-size',      min: 10, max: 96,  unit: 'px', label: 'Text size' },
  lineHeight:    { css: 'line-height',    min: 0.9, max: 2.4, unit: '',  label: 'Line spacing' },
  letterSpacing: { css: 'letter-spacing', min: -2, max: 8,   unit: 'px', label: 'Letter spacing' },
  textAlign:     { css: 'text-align',     enum: ['left', 'center', 'right', 'justify'], label: 'Alignment' },
};
export function clampStyle(prop, val) {
  const s = STYLE_SPEC[prop];
  if (!s) return null;
  if (s.enum) return s.enum.includes(val) ? val : null;
  let n = parseFloat(val);
  if (Number.isNaN(n)) return null;
  n = Math.max(s.min, Math.min(s.max, n));
  return `${n}${s.unit}`;
}

/* ── SEO fields, plain-English, grouped (Basics / Social / Advanced) ── */
export const SEO_FIELDS = [
  { key: 'focuskw', label: 'Focus keyphrase', group: 'Focus', limit: 60, hint: 'The main thing this page should rank for. We score the page against it.' },
  { key: 'title', label: 'Page title', group: 'Basics', limit: 60, hint: 'The clickable headline in Google. Keep under 60 characters.' },
  { key: 'description', label: 'Description', group: 'Basics', limit: 160, hint: 'The grey summary under the title in Google. ~155 characters.' },
  { key: 'ogImage', label: 'Share image', group: 'Social', image: true, limit: 300, hint: 'The big picture shown when the page is shared (1200×630). Blank = no image card.' },
  { key: 'ogTitle', label: 'Title when shared', group: 'Social', limit: 70, hint: 'Headline on the share card. Blank = uses your page title.' },
  { key: 'ogDescription', label: 'Text when shared', group: 'Social', limit: 200, hint: 'Blurb on the share card. Blank = uses your description.' },
  { key: 'robots', label: 'Show this page on Google?', group: 'Advanced', enum: ['index,follow', 'noindex,nofollow'], enumLabels: { 'index,follow': 'Yes — show it in Google', 'noindex,nofollow': 'No — hide it' }, hint: 'Hide pages like "thank you" or drafts.' },
  { key: 'canonical', label: 'Canonical URL', group: 'Advanced', limit: 200, hint: 'Leave blank unless this page duplicates another — then paste that page’s URL.' },
  { key: 'favicon', label: 'Favicon (tab icon)', group: 'Site', image: true, limit: 300, hint: 'Applies to the WHOLE site. The little icon in the browser tab — a square image (32×32).' },
];
const SEO_KEYS = SEO_FIELDS.map((f) => f.key);

export function effectiveSeo(templateHtml, content) {
  const $ = load(templateHtml, { decodeEntities: false });
  const seo = {
    title: $('head > title').text().trim(),
    description: $('meta[name="description"]').attr('content') || '',
    slug: '',
    favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || '',
    canonical: $('link[rel="canonical"]').attr('href') || '',
    robots: $('meta[name="robots"]').attr('content') || 'index,follow',
    ogTitle: $('meta[property="og:title"]').attr('content') || '',
    ogDescription: $('meta[property="og:description"]').attr('content') || '',
    ogImage: $('meta[property="og:image"]').attr('content') || '',
  };
  for (const k of SEO_KEYS) { const v = content[`seo:${k}`]; if (v != null && v !== '') seo[k] = v; }
  return seo;
}

export function applySeo($, content) {
  const seo = {};
  for (const k of SEO_KEYS) seo[k] = content[`seo:${k}`];
  const head = $('head'); if (!head.length) return;
  const upsert = (sel, create, attr, val) => {
    if (val == null || val === '') return;
    let el = $(sel); if (!el.length) { head.append(create); el = $(sel); }
    el.attr(attr, val);
  };
  if (seo.title) { if ($('head > title').length) $('head > title').text(seo.title); else head.append(`<title>${seo.title}</title>`); }
  upsert('meta[name="description"]', '<meta name="description">', 'content', seo.description);
  upsert('link[rel="icon"]', '<link rel="icon">', 'href', seo.favicon);
  upsert('link[rel="canonical"]', '<link rel="canonical">', 'href', seo.canonical);
  upsert('meta[name="robots"]', '<meta name="robots">', 'content', seo.robots);
  const ogT = seo.ogTitle || seo.title, ogD = seo.ogDescription || seo.description;
  upsert('meta[property="og:title"]', '<meta property="og:title">', 'content', ogT);
  upsert('meta[property="og:description"]', '<meta property="og:description">', 'content', ogD);
  upsert('meta[property="og:image"]', '<meta property="og:image">', 'content', seo.ogImage);
  if (seo.ogImage) { upsert('meta[name="twitter:card"]', '<meta name="twitter:card">', 'content', 'summary_large_image'); upsert('meta[name="twitter:image"]', '<meta name="twitter:image">', 'content', seo.ogImage); }
  upsert('meta[name="twitter:title"]', '<meta name="twitter:title">', 'content', ogT);
  upsert('meta[name="twitter:description"]', '<meta name="twitter:description">', 'content', ogD);
  // JSON-LD structured data (WebPage) — helps Google build a rich result
  $('script[type="application/ld+json"][data-cms-ld]').remove();
  const ttl = seo.ogTitle || seo.title, dsc = seo.ogDescription || seo.description;
  if (ttl) {
    const ld = { '@context': 'https://schema.org', '@type': 'WebPage', name: ttl };
    if (dsc) ld.description = dsc;
    if (seo.ogImage) ld.image = seo.ogImage;
    if (seo.canonical) ld.url = seo.canonical;
    head.append(`<script type="application/ld+json" data-cms-ld>${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
  }
}

export function applyStyles($, content) {
  const byId = {};
  for (const [k, v] of Object.entries(content)) {
    const m = k.match(/^style:(.+):([a-zA-Z]+)$/);
    if (!m) continue;
    const clean = clampStyle(m[2], v);
    if (clean == null) continue;
    (byId[m[1]] ||= {})[STYLE_SPEC[m[2]].css] = clean;
  }
  for (const [id, props] of Object.entries(byId)) {
    const el = $(`[data-cms="${id}"],[data-cms-img="${id}"]`).first();
    if (!el.length) continue;
    const existing = (el.attr('style') || '').replace(/;\s*$/, '');
    const add = Object.entries(props).map(([c, v]) => `${c}:${v}`).join(';');
    el.attr('style', (existing ? existing + ';' : '') + add);
  }
}

/** Outline a page into human-friendly sections for the editor's navigator. */
export function sectionList(templateHtml) {
  const $ = load(templateHtml, { decodeEntities: false });
  const out = [];
  const seen = new Set();
  $('header, main > section, body > section, section[id], footer').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id');
    const sel = id ? `#${id}` : el.tagName.toLowerCase();
    if (seen.has(sel)) return;
    seen.add(sel);
    const tag = (el.tagName || '').toLowerCase();
    let label = tag === 'header' ? 'Header' : tag === 'footer' ? 'Footer' : '';
    const h = $el.find('h1,h2,h3').first().text().trim();
    if (!label && h && h.length <= 42) label = h;
    if (!label && id) label = id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (!label) label = 'Section';
    out.push({ sel, label });
  });
  return out.slice(0, 30);
}

/** A safe href: http(s), root/relative path, anchor, mailto/tel. No javascript:. */
export function isSafeLink(v) {
  const s = String(v).trim();
  if (!s) return true;
  if (/^(javascript:|data:)/i.test(s)) return false;
  return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(s) || /^[\w.-]+\.[a-z]{2,}/i.test(s);
}
export function applyLinks($, content) {
  for (const [k, v] of Object.entries(content)) {
    if (!k.startsWith('link:')) continue;
    if (!isSafeLink(v)) continue;
    const id = k.slice(5);
    const el = $(`[data-cms="${id}"]`).first();
    if (!el.length) continue;
    const a = el.is('a') ? el : el.closest('a');
    if (a.length) a.attr('href', v);
  }
}
