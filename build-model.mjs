/**
 * build-model.mjs
 * One-time pass: read the raw Northline site, tag every editable node with a
 * stable data-cms id, and extract a typed content model.
 *
 * Outputs:
 *   site/template.html  — structure-frozen template (data-cms="<id>" markers)
 *   content.json        — the editable values, keyed by id
 *   schema.json         — id -> {type, label, group, rich, allow}
 *
 * The AI only ever sees/edits content.json values. template.html (structure +
 * CSS + scripts) is never touched by the model. That is the master guardrail.
 */
import { load } from 'cheerio';
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('./site/index.html', import.meta.url), 'utf8');
const $ = load(html, { decodeEntities: false });

const schema = {};   // id -> { type, label, group, rich, allow }
const content = {};  // id -> value (string)
let auto = 0;

/** assign an id to a single element and record it */
function record(el, { id, type = 'text', label, group, rich = false, allow = [] }) {
  const $el = $(el);
  id = id || `node-${++auto}`;
  if (type === 'image') {
    $el.attr('data-cms-img', id);
    content[id] = $el.attr('src') || '';
  } else {
    $el.attr('data-cms', id);
    content[id] = rich ? $el.html().trim() : $el.text().trim();
  }
  schema[id] = { type, label, group, rich, allow };
  return id;
}

/** tag every match of a selector, suffixing ids by index when >1 */
function tagAll(sel, base, opts) {
  const els = $(sel).toArray();
  els.forEach((el, i) => {
    const id = els.length > 1 ? `${base}-${i + 1}` : base;
    const label = els.length > 1 ? `${opts.label} ${i + 1}` : opts.label;
    record(el, { ...opts, id, label });
  });
}

/* ───────────────────────── META ───────────────────────── */
record($('head > title')[0], { id: 'meta-title', label: 'Browser tab title', group: 'Page settings' });
record($('meta[name="description"]')[0], { id: 'meta-description', label: 'SEO description', group: 'Page settings' });
// store meta description from attr, not text
content['meta-description'] = $('meta[name="description"]').attr('content') || '';
schema['meta-description'].type = 'meta-attr';

/* ───────────────────────── NAV ───────────────────────── */
tagAll('.nav__links .nav__link', 'nav-link', { label: 'Nav link', group: 'Navigation' });
record($('.nav__cta .btn--ghost')[0], { id: 'nav-login', label: 'Login button', group: 'Navigation', rich: true, allow: ['span'] });
record($('.nav__cta .btn--primary')[0], { id: 'nav-cta', label: 'Primary nav button', group: 'Navigation', rich: true, allow: ['span'] });

/* ───────────────────────── HERO ───────────────────────── */
record($('.hero__copy .pill')[0], { id: 'hero-pill', label: 'Availability badge', group: 'Hero', rich: true, allow: ['span'] });
record($('#hero-title')[0], { id: 'hero-title', label: 'Hero headline', group: 'Hero', rich: true, allow: ['em', 'br'] });
record($('.hero__subhead')[0], { id: 'hero-subhead', label: 'Hero subheadline', group: 'Hero' });
const heroBtns = $('.hero__cta .btn').toArray();
record(heroBtns[0], { id: 'hero-cta-primary', label: 'Hero primary button', group: 'Hero', rich: true, allow: ['span'] });
record(heroBtns[1], { id: 'hero-cta-ghost', label: 'Hero secondary button', group: 'Hero' });
record($('.hero__video')[0], { id: 'hero-image', type: 'image', label: 'Hero image', group: 'Hero' });

/* ───────────────────────── LOGO STRIP ───────────────────────── */
record($('.logos__label')[0], { id: 'logos-label', label: 'Logo strip caption', group: 'Client logos' });
tagAll('.logos__row img', 'logo', { type: 'image', label: 'Client logo', group: 'Client logos' });

/* ───────────── helper: tag a standard section header (eyebrow / h2 / lead) ───────────── */
function tagHead(sectionSel, group) {
  const head = $(sectionSel).find('.s-head').first();
  const eb = head.find('.eyebrow')[0];      if (eb) record(eb, { id: `${group}-eyebrow`, label: `${group} eyebrow`, group });
  const h2 = head.find('h2')[0];            if (h2) record(h2, { id: `${group}-title`, label: `${group} heading`, group });
  const lead = head.find('.lead')[0];       if (lead) record(lead, { id: `${group}-lead`, label: `${group} intro`, group });
}

/* ───────────────────────── PROCESS ───────────────────────── */
tagHead('#process', 'Process');
$('#process .pipe').each((i, el) => {
  const n = i + 1;
  record($(el).find('.pipe__label')[0], { id: `process-${n}-label`, label: `Stage ${n} label`, group: 'Process', rich: true, allow: ['span'] });
  record($(el).find('h3')[0], { id: `process-${n}-title`, label: `Stage ${n} title`, group: 'Process' });
  record($(el).find('p')[0], { id: `process-${n}-copy`, label: `Stage ${n} copy`, group: 'Process' });
});

/* ───────────────────────── SERVICES ───────────────────────── */
tagHead('#services', 'Services');
$('#services .svc').each((i, el) => {
  const n = i + 1;
  record($(el).find('h4')[0], { id: `svc-${n}-title`, label: `Service ${n} title`, group: 'Services' });
  record($(el).find('p')[0], { id: `svc-${n}-copy`, label: `Service ${n} copy`, group: 'Services' });
});

/* ───────────────────────── STATS ───────────────────────── */
tagHead('section[aria-labelledby="stats-title"]', 'Results');
$('.stats .stat').each((i, el) => {
  const n = i + 1;
  record($(el).find('.stat__num')[0], { id: `stat-${n}-num`, label: `Stat ${n} number`, group: 'Results', rich: true, allow: ['em', 'span'] });
  record($(el).find('.stat__label')[0], { id: `stat-${n}-label`, label: `Stat ${n} label`, group: 'Results' });
});

/* ───────────────────────── WORK ───────────────────────── */
tagHead('#work', 'Work');
$('#work .work__main, #work .work__side').each((i, el) => {
  const n = i + 1;
  record($(el).find('.work__cat')[0], { id: `work-${n}-cat`, label: `Project ${n} category`, group: 'Work' });
  record($(el).find('.work__title')[0], { id: `work-${n}-title`, label: `Project ${n} title`, group: 'Work' });
  record($(el).find('.work__copy')[0], { id: `work-${n}-copy`, label: `Project ${n} copy`, group: 'Work' });
});

/* ───────────────────────── PRICING ───────────────────────── */
tagHead('#pricing', 'Pricing');
$('#pricing .tier').each((i, el) => {
  const n = i + 1;
  record($(el).find('.tier__name h3')[0], { id: `tier-${n}-name`, label: `Tier ${n} name`, group: 'Pricing' });
  record($(el).find('.tier__copy')[0], { id: `tier-${n}-copy`, label: `Tier ${n} copy`, group: 'Pricing' });
  record($(el).find('.tier__price strong')[0], { id: `tier-${n}-price`, label: `Tier ${n} price`, group: 'Pricing', type: 'price' });
  record($(el).find('.tier__price span')[0], { id: `tier-${n}-term`, label: `Tier ${n} billing term`, group: 'Pricing' });
  $(el).find('.tier__list li').each((j, li) => {
    record(li, { id: `tier-${n}-feat-${j + 1}`, label: `Tier ${n} feature ${j + 1}`, group: 'Pricing' });
  });
  record($(el).find('.tier__cta .btn')[0], { id: `tier-${n}-cta`, label: `Tier ${n} button`, group: 'Pricing', rich: true, allow: ['span'] });
});

/* ───────────────────────── TESTIMONIALS ───────────────────────── */
tagHead('section[aria-labelledby="t-title"]', 'Testimonials');
$('.testimonials .t-card').each((i, el) => {
  const n = i + 1;
  record($(el).find('blockquote')[0], { id: `tst-${n}-quote`, label: `Testimonial ${n} quote`, group: 'Testimonials' });
  record($(el).find('.t-meta strong')[0], { id: `tst-${n}-name`, label: `Testimonial ${n} name`, group: 'Testimonials' });
  // role = trailing text after <strong> inside .t-meta — wrap it so it's addressable
  const meta = $(el).find('.t-meta');
  const strongHtml = $.html(meta.find('strong'));
  const roleText = meta.text().replace(meta.find('strong').text(), '').trim();
  meta.html(`${strongHtml}<span data-cms="tst-${n}-role">${roleText}</span>`);
  schema[`tst-${n}-role`] = { type: 'text', label: `Testimonial ${n} role`, group: 'Testimonials', rich: false, allow: [] };
  content[`tst-${n}-role`] = roleText;
  record($(el).find('.t-avatar img')[0], { id: `tst-${n}-avatar`, type: 'image', label: `Testimonial ${n} avatar`, group: 'Testimonials' });
});

/* ───────────────────────── FAQ ───────────────────────── */
tagHead('#faq', 'FAQ');
$('#faq details').each((i, el) => {
  const n = i + 1;
  record($(el).find('summary')[0], { id: `faq-${n}-q`, label: `FAQ ${n} question`, group: 'FAQ', rich: true, allow: ['span'] });
  record($(el).find('.faq__a')[0], { id: `faq-${n}-a`, label: `FAQ ${n} answer`, group: 'FAQ' });
});

/* ───────────────────────── CTA ───────────────────────── */
record($('#cta-title')[0], { id: 'cta-title', label: 'CTA heading', group: 'Call to action' });
record($('.banner p')[0], { id: 'cta-copy', label: 'CTA copy', group: 'Call to action' });
const ctaBtns = $('.banner__cta .btn').toArray();
record(ctaBtns[0], { id: 'cta-email', label: 'CTA email button', group: 'Call to action' });
record(ctaBtns[1], { id: 'cta-book', label: 'CTA book button', group: 'Call to action' });

/* ───────────────────────── FOOTER ───────────────────────── */
record($('.footer__brand p')[0], { id: 'footer-blurb', label: 'Footer blurb', group: 'Footer' });
$('.footer__col').each((i, el) => {
  const n = i + 1;
  record($(el).find('h5')[0], { id: `footer-col-${n}-title`, label: `Footer column ${n} title`, group: 'Footer' });
});
record($('.footer__bottom span:last-child')[0], { id: 'footer-copyright', label: 'Copyright line', group: 'Footer' });

/* ───────────────────────── WRITE ───────────────────────── */
writeFileSync(new URL('./site/template.html', import.meta.url), $.html());
writeFileSync(new URL('./content.json', import.meta.url), JSON.stringify(content, null, 2));
writeFileSync(new URL('./schema.json', import.meta.url), JSON.stringify(schema, null, 2));

const groups = [...new Set(Object.values(schema).map((s) => s.group))];
console.log(`✓ tagged ${Object.keys(schema).length} editable fields across ${groups.length} groups:`);
for (const g of groups) {
  const n = Object.values(schema).filter((s) => s.group === g).length;
  console.log(`   ${g.padEnd(18)} ${n}`);
}
