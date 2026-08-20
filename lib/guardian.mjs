/**
 * guardian.mjs — the safety gate. Deterministic, no AI, site-agnostic. A
 * change-set only reaches the client for approval if every check passes.
 *
 *   1. whitelist op + known field   (can't touch anything untagged)
 *   2. injection scan               (no <script>, onerror=, javascript:)
 *   3. type sanity                  (prices have digits, images are URLs)
 *   4. sanitise to the field's tag allowlist (rich) / strip to text (plain)
 *   5. structural invariant         (re-render a COPY; every section + every
 *                                    tagged field must survive, no mass deletion)
 *   6. blast-radius                 (huge change-sets get flagged)
 */
import { load } from 'cheerio';
import { render } from './render.mjs';
import { hasInjection, sanitizeRich, plainify, isSafeImageUrl } from './sanitize.mjs';
import { clampStyle, STYLE_SPEC, SEO_FIELDS, isSafeLink } from './fields.mjs';

const ALLOWED_OPS = ['set'];
const MAX_CHANGES_BEFORE_CONFIRM = 20;
const SEO_MAP = Object.fromEntries(SEO_FIELDS.map((f) => [f.key, f]));

// Validate a seo:* or style:* virtual key. Returns {clean} or {error}.
function validateVirtual(id, value) {
  if (id.startsWith('seo:')) {
    const f = SEO_MAP[id.slice(4)];
    if (!f) return { error: `Unknown SEO field "${id}".` };
    if (hasInjection(value)) return { error: `${f.label}: blocked — contained markup/code.` };
    if (f.enum && !f.enum.includes(value)) return { error: `${f.label}: must be one of ${f.enum.join(', ')}.` };
    if ((f.key === 'ogImage' || f.key === 'canonical') && value && !isSafeImageUrl(value) && !/^https?:\/\//i.test(value)) return { error: `${f.label}: must be a valid URL.` };
    return { clean: plainify(value, (f.limit || 320) + 40) };
  }
  if (id.startsWith('style:')) {
    const m = id.match(/^style:(.+):([a-zA-Z]+)$/);
    if (!m || !STYLE_SPEC[m[2]]) return { error: `Unknown style "${id}".` };
    const clean = clampStyle(m[2], value);
    if (clean == null) return { error: `${STYLE_SPEC[m[2]].label}: "${value}" is out of range.` };
    return { clean };
  }
  if (id.startsWith('link:')) {
    if (!isSafeLink(value)) return { error: `Link: "${String(value).slice(0, 50)}" is not a valid URL.` };
    return { clean: String(value).trim() };
  }
  return null; // not virtual
}

export function validate(changeset, site) {
  const { content, schema, templateHtml, sections = [] } = site;
  const errors = [];
  const warnings = [];
  const applied = {};
  const diff = [];

  if (!Array.isArray(changeset) || changeset.length === 0) {
    return { ok: false, errors: ['The request produced no changes.'], warnings, applied, candidate: content, diff };
  }

  for (const change of changeset) {
    const { op = 'set', id, value } = change;
    const where = id || '(missing id)';
    if (!ALLOWED_OPS.includes(op)) { errors.push(`${where}: operation "${op}" is not allowed (this version only edits existing fields).`); continue; }

    // SEO / style / link virtual keys
    if (id && (id.startsWith('seo:') || id.startsWith('style:') || id.startsWith('link:'))) {
      const r = validateVirtual(id, value);
      if (r.error) { errors.push(r.error); continue; }
      const before = content[id] ?? '';
      if (r.clean === before) { continue; }
      applied[id] = r.clean;
      const label = id.startsWith('seo:') ? `SEO · ${SEO_MAP[id.slice(4)].label}` : id.startsWith('style:') ? `Style · ${STYLE_SPEC[id.split(':')[2]].label}` : 'Link';
      diff.push({ id, label, group: id.startsWith('seo:') ? 'SEO' : id.startsWith('style:') ? 'Style' : 'Link', from: before, to: r.clean });
      continue;
    }

    const def = schema[id];
    if (!def) { errors.push(`${where}: not an editable field — refused. The AI can only touch tagged content, never the layout or code.`); continue; }
    if (hasInjection(value)) { errors.push(`${def.label}: blocked — value contained code/markup that isn't allowed (possible injection).`); continue; }

    let clean;
    if (def.type === 'image') {
      if (!isSafeImageUrl(value)) { errors.push(`${def.label}: "${String(value).slice(0, 60)}" is not a valid image URL.`); continue; }
      clean = String(value).trim();
    } else if (def.rich) {
      clean = sanitizeRich(value, def.allow);
      if (clean !== String(value).trim()) warnings.push(`${def.label}: formatting tidied to approved tags (${def.allow.join(', ') || 'none'}).`);
    } else {
      clean = plainify(value);
      if (def.type === 'price' && !/\d/.test(clean)) warnings.push(`${def.label}: a price with no number ("${clean}") — double-check.`);
    }

    if (clean === '') warnings.push(`${def.label}: this will be left empty.`);
    const before = content[id] ?? '';
    if (clean === before) { warnings.push(`${def.label}: already set to this — no change.`); continue; }
    applied[id] = clean;
    diff.push({ id, label: def.label, group: def.group, from: before, to: clean });
  }

  if (Object.keys(applied).length === 0 && errors.length === 0) {
    return { ok: false, errors: ['No applicable changes after validation.'], warnings, applied, candidate: content, diff };
  }

  const candidate = { ...content, ...applied };

  if (Object.keys(applied).length) {
    try {
      const before$ = load(templateHtml);
      const beforeCount = before$('*').length;
      const $ = load(render(templateHtml, schema, candidate));
      for (const sel of sections) if ($(sel).length === 0) errors.push(`Structural check failed: "${sel}" would disappear. Rejected.`);
      const present = new Set();
      $('[data-cms]').each((_, el) => present.add(el.attribs['data-cms']));
      $('[data-cms-img]').each((_, el) => present.add(el.attribs['data-cms-img']));
      for (const id of Object.keys(schema)) if (!present.has(id)) errors.push(`Structural check failed: field "${id}" was lost during render.`);
      if ($('*').length < beforeCount * 0.7) errors.push('Structural check failed: too much of the page would be removed. Rejected.');
    } catch (e) {
      errors.push(`Structural check failed: page could not be re-rendered safely (${e.message}).`);
    }
  }

  if (diff.length > MAX_CHANGES_BEFORE_CONFIRM) warnings.push(`This touches ${diff.length} fields at once — review carefully before publishing.`);

  return { ok: errors.length === 0, errors, warnings, applied, candidate, diff };
}
