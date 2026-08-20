/**
 * structure.mjs — V2 structural operations (add / remove / duplicate items in a
 * detected collection). These mutate the TEMPLATE (not just content), so they
 * run on a draft and are constrained: you can only clone/remove within a known
 * collection, never touch arbitrary DOM. Returns a new template + schema, or an
 * error. The Guardian's structural invariant still gates the result on publish.
 */
import { load } from 'cheerio';

const MAX_ITEMS = 12;

function maxId(schema) {
  let m = 0;
  for (const id of Object.keys(schema)) { const n = parseInt(String(id).replace(/\D/g, ''), 10); if (n > m) m = n; }
  return m;
}

/** Apply a structural op. op ∈ {add_item, remove_item}. */
export function applyStructure({ templateHtml, schema, content }, op, colId, index) {
  const $ = load(templateHtml, { decodeEntities: false });
  const container = $(`[data-cms-collection="${colId}"]`).first();
  if (!container.length) return { error: `Unknown collection "${colId}".` };
  const items = container.find(`> [data-cms-item="${colId}"]`).length
    ? container.find(`> [data-cms-item="${colId}"]`)
    : $(`[data-cms-item="${colId}"]`);
  if (!items.length) return { error: `Collection "${colId}" has no items.` };

  const nextSchema = { ...schema };
  const nextContent = { ...content };

  if (op === 'add_item') {
    if (items.length >= MAX_ITEMS) return { error: `This section is capped at ${MAX_ITEMS} items.` };
    const srcIdx = index != null && items[index] ? index : items.length - 1;
    const src = items.eq(srcIdx);
    const clone = $(src.clone());
    // Re-key every tagged node inside the clone so it gets fresh, unique fields.
    let next = maxId(nextSchema);
    clone.removeClass('cms-edited');
    clone.find('.cms-edited').removeClass('cms-edited');
    const retag = (sel, attr) => {
      const self = clone.is(`[${attr}]`) ? clone : null;
      const all = [...(self ? [self.get(0)] : []), ...clone.find(`[${attr}]`).toArray()];
      for (const node of all) {
        const oldId = node.attribs[attr];
        const newId = `cms-${++next}`;
        node.attribs[attr] = newId;
        if (schema[oldId]) { nextSchema[newId] = { ...schema[oldId] }; nextContent[newId] = content[oldId]; }
      }
    };
    retag('data-cms', 'data-cms');
    retag('data-cms-img', 'data-cms-img');
    src.after(clone);
    return { templateHtml: $.html(), schema: nextSchema, content: nextContent, message: `Added a new item (now ${items.length + 1}).` };
  }

  if (op === 'remove_item') {
    if (items.length <= 1) return { error: 'Can’t remove the last item in a section.' };
    const idx = index != null && items[index] ? index : items.length - 1;
    const victim = items.eq(idx);
    const ids = [];
    victim.find('[data-cms],[data-cms-img]').each((_, e) => { ids.push(e.attribs['data-cms'] || e.attribs['data-cms-img']); });
    if (victim.is('[data-cms],[data-cms-img]')) ids.push(victim.attr('data-cms') || victim.attr('data-cms-img'));
    for (const id of ids) delete nextSchema[id];
    victim.remove();
    return { templateHtml: $.html(), schema: nextSchema, content: nextContent, message: `Removed an item (now ${items.length - 1}).` };
  }

  return { error: `Unknown structural op "${op}".` };
}
