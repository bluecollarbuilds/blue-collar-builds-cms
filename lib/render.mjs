/**
 * render.mjs — deterministic, site-agnostic renderer. Given a frozen template,
 * its schema, and a content object, produce final HTML. Structure/CSS/scripts
 * come ONLY from the template; content fills tagged slots. Pure + trusted; the
 * AI can never reach it.
 */
import { load } from 'cheerio';
import { sanitizeRich, plainify, isSafeImageUrl } from './sanitize.mjs';
import { applySeo, applyStyles, applyLinks } from './fields.mjs';

export function render(templateHtml, schema, content) {
  const $ = load(templateHtml, { decodeEntities: false });
  for (const [id, def] of Object.entries(schema)) {
    const val = content[id];
    if (val == null) continue;
    if (def.type === 'image') {
      if (isSafeImageUrl(val)) $(`[data-cms-img="${id}"]`).attr('src', val);
      continue;
    }
    if (def.type === 'meta-attr') {
      $(`[data-cms="${id}"]`).attr('content', plainify(val, 500));
      continue;
    }
    const el = $(`[data-cms="${id}"]`);
    if (!el.length) continue;
    if (def.rich) el.html(sanitizeRich(val, def.allow));
    else el.text(plainify(val));
  }
  applyStyles($, content); // bounded per-element spacing/typography
  applyLinks($, content);  // link/button hrefs from link:* keys
  applySeo($, content);    // SEO + social tags from seo:* keys
  return $.html();
}
