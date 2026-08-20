/**
 * sanitize.mjs — the low-level safety primitives shared by the Guardian and the
 * renderer. Nothing the AI proposes is ever trusted; it is sanitized here.
 */
import { load } from 'cheerio';

// For "rich" fields we permit a tiny whitelist of inline tags and only safe
// attributes on them. Everything else is unwrapped (kept as text) or dropped.
const SAFE_ATTRS = {
  span: ['class', 'style', 'aria-hidden'],
  em: [],
  br: [],
  strong: [],
};

const DANGER_RE = /<\s*(script|iframe|object|embed|link|meta|style|form|input)\b|on\w+\s*=|javascript:|data:text\/html/i;
// control characters (keep \\t and \\n)
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** True if a value contains anything that could execute or escape the field. */
export function hasInjection(value) {
  return DANGER_RE.test(String(value));
}

/** Strip a value down to plain text: no tags, no control chars, length-capped. */
export function plainify(value, max = 4000) {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(CONTROL_RE, '')
    .trim()
    .slice(0, max);
}

/** Sanitize rich HTML to a tag allowlist, dropping everything dangerous. */
export function sanitizeRich(htmlStr, allow = [], max = 6000) {
  const $ = load(`<rt>${String(htmlStr)}</rt>`, { decodeEntities: false }, false);
  $('script, style, iframe, object, embed, link, meta, form, input').remove();
  $('rt *').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (!allow.includes(tag)) {
      $(el).replaceWith($(el).contents()); // unwrap: keep text, drop tag
      return;
    }
    const allowed = SAFE_ATTRS[tag] || [];
    for (const attr of Object.keys(el.attribs || {})) {
      const v = el.attribs[attr];
      const bad = !allowed.includes(attr) || /^on/i.test(attr) || /javascript:/i.test(v);
      if (bad) $(el).removeAttr(attr);
      if (attr === 'style' && /url\(|expression|javascript:|@import/i.test(v)) $(el).removeAttr('style');
    }
  });
  return ($('rt').html() || '').slice(0, max);
}

/** Image src must be a relative asset path or a plain http(s) URL — never data:/js:. */
export function isSafeImageUrl(value) {
  const v = String(value).trim();
  if (/^(assets|\/)/.test(v) && !/[<>]/.test(v)) return true;
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}
