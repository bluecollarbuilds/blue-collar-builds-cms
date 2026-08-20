/**
 * resync.mjs — content-preserving re-ingest.
 *
 * When the agency does a "huge lift" (redesigns the code/template) and re-ingests,
 * we must NOT lose the client's edits. Slot ids are sequential (`cms-1`…) so they
 * are NOT stable across a redesign — we therefore match a client's edited slot to a
 * slot in the NEW template by ROLE + CONTENT, then carry the client's value over.
 *
 *   - role family: heading / text / cta / list / image  (robust to tag tweaks)
 *   - match key:   the slot's ORIGINAL design text (so "the box that used to say X"
 *                  maps to "the box that says X-ish in the new design"), exact → fuzzy → position
 *   - only the slots the client actually CHANGED (vs the original design) are carried,
 *     so your new design's fresh copy is kept everywhere the client didn't touch.
 *   - style:* / link:* keys are remapped to the new ids; seo:* carry 1:1.
 */
import { load } from 'cheerio';

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 0;
  if (a === b) return 1;
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function familyOf($, el, isImg) {
  if (isImg) return 'image';
  const t = (el.tagName || el.name || '').toLowerCase();
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'li') return 'list';
  if (t === 'a' || t === 'button' || $(el).closest('a,button').length) return 'cta';
  return 'text';
}
function slotsOf(tpl, textOf) {
  const $ = load(tpl); const out = [];
  $('[data-cms],[data-cms-img]').each((i, el) => {
    const isImg = $(el).is('[data-cms-img]');
    const id = $(el).attr('data-cms') || $(el).attr('data-cms-img');
    out.push({ id, fam: familyOf($, el, isImg), text: norm(textOf(id)), order: i, used: false });
  });
  return out;
}

/**
 * @param oldTpl,oldOriginal  the template + ORIGINAL (pre-edit) content at ingest time
 * @param oldCurrent          the client's CURRENT content (their edits live here)
 * @param newTpl,newContent   the redesigned template + its fresh default content
 * @returns { content, carried[], dropped[] }
 */
export function resyncContent(oldTpl, oldOriginal, oldCurrent, newTpl, newContent) {
  const oldSlots = slotsOf(oldTpl, (id) => oldOriginal[id]);   // match on the ORIGINAL design text
  const newSlots = slotsOf(newTpl, (id) => newContent[id]);    // new design's fresh defaults
  const result = { ...newContent };
  const idMap = {}, carried = [], dropped = [];

  // a slot counts as "edited" if the client's current value differs from the original
  // (when there's no baseline, oldOriginal is empty → any non-empty value counts → carry-all)
  const edited = oldSlots.filter((o) => { const cur = norm(oldCurrent[o.id]); return cur !== '' && cur !== o.text; });

  for (const o of edited) {
    const cands = newSlots.filter((n) => !n.used && n.fam === o.fam);
    let pick = null, best = -1;
    for (const n of cands) {
      const posScore = 1 - Math.min(1, Math.abs(n.order - o.order) / 20);
      const score = o.fam === 'image'
        ? (1 - Math.min(1, Math.abs(n.order - o.order) / 8))             // images: nearest position wins
        : (o.text && n.text && o.text === n.text ? 1.2 : sim(o.text, n.text)) + posScore * 0.001;
      if (score > best) { best = score; pick = n; }
    }
    const accept = pick && (o.fam === 'image' || best >= 1.2 || best >= 0.34 || cands.length === 1);
    if (accept) {
      pick.used = true; idMap[o.id] = pick.id; result[pick.id] = oldCurrent[o.id];
      carried.push({ fam: o.fam, value: String(oldCurrent[o.id]).slice(0, 60) });
    } else {
      dropped.push({ fam: o.fam, value: String(oldCurrent[o.id]).slice(0, 60) });
    }
  }

  // remap per-element style/link keys to the new ids; carry SEO 1:1
  for (const [k, v] of Object.entries(oldCurrent)) {
    const ms = k.match(/^style:(.+):([a-zA-Z]+)$/); if (ms) { if (idMap[ms[1]]) result[`style:${idMap[ms[1]]}:${ms[2]}`] = v; continue; }
    const ml = k.match(/^link:(.+)$/);              if (ml) { if (idMap[ml[1]]) result[`link:${idMap[ml[1]]}`] = v; continue; }
    if (k.startsWith('seo:')) result[k] = v;
  }
  return { content: result, carried, dropped };
}
