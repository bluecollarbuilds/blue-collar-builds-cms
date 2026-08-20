/**
 * agent.mjs — the Planner. Turns a client's plain-English request into a
 * structured change-set of {op:'set', id, value} against a site's content
 * model. It can ONLY reference existing field ids; it never emits HTML/code.
 * Uses the AI provider/key from config (set in the Agency Console), else a
 * deterministic local matcher.
 */
import Anthropic from '@anthropic-ai/sdk';
import { aiCreds, plannerMode } from './config.mjs';

export { plannerMode };

function catalogue(schema, content) {
  return Object.entries(schema).map(([id, d]) => ({
    id, label: d.label, group: d.group, type: d.type,
    rich: d.rich ? d.allow : false,
    current: String(content[id] ?? '').slice(0, 120),
  }));
}

const SYSTEM = `You are the Planner for a website CMS. A non-technical client describes a change in plain English; you translate it into a precise change-set.

HARD RULES:
- You may ONLY edit fields from the supplied catalogue, addressed by their "id".
- Output operations of the form {"op":"set","id":"<field id>","value":"<new value>"}.
- You CANNOT add, remove, reorder, or restructure anything, and you CANNOT write HTML, CSS, JS or code. Plain text only — unless a field's "rich" lists allowed inline tags, in which case use ONLY those tags and preserve existing decorative markup.
- Match intent to the right field by label, group and current value. If several match, pick the most likely or split into multiple set ops.
- Keep the client's tone and rough copy length. Never invent facts (prices, stats, names) the client didn't give.
- If you can't map the request to any field, return an empty changes array and say why in "summary".

Always respond by calling emit_changeset.`;

const TOOL = {
  name: 'emit_changeset',
  description: 'Return the planned edits to the website content model.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      changes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id', 'value'] } },
    },
    required: ['summary', 'changes'],
  },
};

async function anthropicPlan(command, content, schema, creds) {
  const client = new Anthropic({ apiKey: creds.key });
  const msg = await client.messages.create({
    model: creds.model, max_tokens: 1500, system: SYSTEM, tools: [TOOL],
    tool_choice: { type: 'tool', name: 'emit_changeset' },
    messages: [{ role: 'user', content: `Editable fields (catalogue):\n${JSON.stringify(catalogue(schema, content))}\n\nClient request: "${command}"` }],
  });
  const tool = msg.content.find((b) => b.type === 'tool_use');
  if (!tool) return { summary: "I couldn't interpret that.", changeset: [] };
  const { summary, changes = [] } = tool.input;
  return { summary, changeset: changes.map((c) => ({ op: 'set', id: c.id, value: c.value })) };
}

async function openrouterPlan(command, content, schema, creds) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: creds.model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Editable fields (catalogue):\n${JSON.stringify(catalogue(schema, content))}\n\nClient request: "${command}"` }],
      tools: [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } }],
      tool_choice: { type: 'function', function: { name: TOOL.name } },
    }),
  });
  const j = await res.json();
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return { summary: j.error?.message || "I couldn't interpret that.", changeset: [] };
  const { summary, changes = [] } = JSON.parse(call.function.arguments);
  return { summary, changeset: changes.map((c) => ({ op: 'set', id: c.id, value: c.value })) };
}

const STOP = new Set(['the', 'to', 'a', 'an', 'and', 'change', 'make', 'set', 'update', 'edit', 'please', 'say', 'says', 'it', 'our', 'my', 'is', 'be', 'should', 'into', 'on', 'for', 'of', 'this', 'that', 'with']);
function extractValue(command) {
  const m =
    command.match(/(?:to|say|says|reads?|=|:)\s+["“](.+?)["”]\s*$/i) ||
    command.match(/["“](.+?)["”]/) ||
    command.match(/(?:change|set|make|update)\b.*?\b(?:to|say|says|reads?)\s+(.+)$/i) ||
    command.match(/(?:to|=|:)\s+(.+)$/i);
  return m ? m[1].trim().replace(/[.\s]+$/, '') : null;
}
function localPlan(command, content, schema) {
  const value = extractValue(command);
  const words = command.toLowerCase().replace(/["“”]/g, '').split(/\W+/).filter((w) => w && !STOP.has(w));
  let best = null;
  for (const [id, d] of Object.entries(schema)) {
    const hay = `${d.label} ${d.group} ${String(content[id] ?? '')}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length > 3 ? 2 : 1;
    if (score > (best?.score ?? 0)) best = { id, score, def: d };
  }
  if (!best || best.score < 3 || !value) {
    return { summary: `(Local mode) Couldn't confidently match that. Add an AI key in the Agency Console for full natural-language editing — or quote the exact text, e.g. change "old text" to "new text".`, changeset: [] };
  }
  return { summary: `Set ${best.def.label} to "${value}".`, changeset: [{ op: 'set', id: best.id, value }] };
}

export async function plan(command, content, schema) {
  const creds = aiCreds();
  try {
    if (creds.provider === 'openrouter') return await openrouterPlan(command, content, schema, creds);
    if (creds.provider === 'anthropic') return await anthropicPlan(command, content, schema, creds);
    return localPlan(command, content, schema);
  } catch (e) {
    return { summary: `Planner error: ${e.message}. Falling back to local matching.`, changeset: localPlan(command, content, schema).changeset };
  }
}
