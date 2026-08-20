/**
 * store.mjs — pluggable persistence layer.
 *
 *   Every piece of site data (pages, content, versions, drafts, access, audit,
 *   forms, uploads, config) is addressed by a PATH KEY, e.g. "sites/rocket/site.json".
 *   The server reads/writes through `store.*` instead of touching the filesystem
 *   directly, so the same code works on either backend:
 *
 *     • filesystem  (default)         — keys map to files under the project root.
 *     • MongoDB     (MONGODB_URI set) — keys map to docs in one `cms_blobs` collection.
 *
 *   The fs adapter is synchronous internally (so behaviour is identical to before),
 *   but everything is exposed as async so the Mongo adapter can do real network IO.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (key) => join(ROOT, key);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ───────────────────────── filesystem adapter ───────────────────────── */
const fsAdapter = {
  mode: 'filesystem',
  async getJSON(key) { const p = abs(key); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
  async putJSON(key, obj) { const p = abs(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2)); },
  async getText(key) { const p = abs(key); return existsSync(p) ? readFileSync(p, 'utf8') : null; },
  async putText(key, str) { const p = abs(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, str); },
  async appendText(key, str) { const p = abs(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + str); },
  async getBuf(key) { const p = abs(key); return existsSync(p) ? readFileSync(p) : null; },
  async putBuf(key, buf) { const p = abs(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); },
  async exists(key) { return existsSync(abs(key)); },
  async del(key) { rmSync(abs(key), { force: true, recursive: true }); },
  async listDirs(prefix) { const p = abs(prefix); if (!existsSync(p)) return []; return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); },
  async listFiles(prefix) { const p = abs(prefix); if (!existsSync(p)) return []; return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); },
};

/* ───────────────────────── MongoDB adapter ───────────────────────── */
function makeMongoAdapter(coll) {
  return {
    mode: 'mongodb',
    __coll: coll,
    async getJSON(key) { const d = await coll.findOne({ _id: key }); return d ? (d.json ?? null) : null; },
    async putJSON(key, obj) { await coll.updateOne({ _id: key }, { $set: { kind: 'json', json: obj } }, { upsert: true }); },
    async getText(key) { const d = await coll.findOne({ _id: key }); return d ? (d.text ?? null) : null; },
    async putText(key, str) { await coll.updateOne({ _id: key }, { $set: { kind: 'text', text: str } }, { upsert: true }); },
    async appendText(key, str) { const d = await coll.findOne({ _id: key }); await coll.updateOne({ _id: key }, { $set: { kind: 'text', text: (d && d.text ? d.text : '') + str } }, { upsert: true }); },
    async getBuf(key) { const d = await coll.findOne({ _id: key }); return d && d.b64 ? Buffer.from(d.b64, 'base64') : null; },
    async putBuf(key, buf) { await coll.updateOne({ _id: key }, { $set: { kind: 'buf', b64: Buffer.from(buf).toString('base64') } }, { upsert: true }); },
    async exists(key) { return !!(await coll.findOne({ _id: key }, { projection: { _id: 1 } })); },
    async del(key) { await coll.deleteOne({ _id: key }); await coll.deleteMany({ _id: { $regex: '^' + reEsc(key) + '/' } }); }, // exact key OR everything under it (a "dir")
    async listDirs(prefix) {
      const pre = prefix.endsWith('/') ? prefix : prefix + '/';
      const docs = await coll.find({ _id: { $regex: '^' + reEsc(pre) } }, { projection: { _id: 1 } }).toArray();
      const set = new Set();
      for (const d of docs) { const rest = d._id.slice(pre.length); const parts = rest.split('/'); if (parts.length > 1 && parts[0]) set.add(parts[0]); }
      return [...set];
    },
    async listFiles(prefix) {
      const pre = prefix.endsWith('/') ? prefix : prefix + '/';
      const docs = await coll.find({ _id: { $regex: '^' + reEsc(pre) } }, { projection: { _id: 1 } }).toArray();
      const set = new Set();
      for (const d of docs) { const rest = d._id.slice(pre.length); const parts = rest.split('/'); if (parts.length === 1 && parts[0]) set.add(parts[0]); }
      return [...set];
    },
  };
}

/* live binding — server.mjs imports { store } and always hits the active backend */
export let store = fsAdapter;
let _client = null;

export async function initStore() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri || /<[^>]+>/.test(uri)) { store = fsAdapter; return { mode: 'filesystem' }; } // unset, or still has a <placeholder>
  try {
    const { MongoClient } = await import('mongodb');
    _client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await _client.connect();
    const dbName = process.env.MONGODB_DB || 'northline_cms';
    const coll = _client.db(dbName).collection('cms_blobs');
    await coll.estimatedDocumentCount();             // forces an auth'd round-trip; throws here if creds are bad
    const mongo = makeMongoAdapter(coll);
    const count = await coll.estimatedDocumentCount();
    let migrated = 0;
    if (count === 0) migrated = await seedFromFs(mongo);   // first boot against an empty DB → migrate the local fs in
    store = mongo;
    return { mode: 'mongodb', db: dbName, migrated };
  } catch (e) {
    console.error(`[store] MongoDB connection failed — staying on the filesystem. (${e.message})`);
    try { if (_client) await _client.close(); } catch {}
    _client = null; store = fsAdapter;
    return { mode: 'filesystem', error: e.message };
  }
}

export async function closeStore() { if (_client) await _client.close(); }

/* Pull every `sites/…` doc from Mongo down to the local fs cache (used on a host
   that already has data in Mongo — e.g. a second/new server). */
export async function hydrateToFs() {
  if (store.mode !== 'mongodb' || !store.__coll) return 0;
  const docs = await store.__coll.find({ _id: { $regex: '^sites/' } }).toArray();
  let n = 0;
  for (const d of docs) {
    const p = abs(d._id); mkdirSync(dirname(p), { recursive: true });
    if (d.kind === 'json') writeFileSync(p, JSON.stringify(d.json, null, 2));
    else if (d.kind === 'text') writeFileSync(p, d.text || '');
    else if (d.kind === 'buf') writeFileSync(p, Buffer.from(d.b64 || '', 'base64'));
    n++;
  }
  return n;
}

/* Walk the local working dir and copy every site file + config into the store. */
async function seedFromFs(target) {
  let n = 0;
  const put = async (key) => {
    const p = abs(key);
    if (key.endsWith('.json')) { try { await target.putJSON(key, JSON.parse(readFileSync(p, 'utf8'))); } catch { await target.putText(key, readFileSync(p, 'utf8')); } }
    else if (key.endsWith('.html') || key.endsWith('.log') || key.endsWith('.txt')) await target.putText(key, readFileSync(p, 'utf8'));
    else await target.putBuf(key, readFileSync(p));
    n++;
  };
  const walk = async (rel) => {
    const p = abs(rel);
    if (!existsSync(p)) return;
    for (const d of readdirSync(p, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (d.name === 'releases') continue; await walk(childRel); } // releases are rebuildable artifacts
      else await put(childRel);
    }
  };
  await walk('sites');
  if (existsSync(abs('cms-config.json'))) await put('cms-config.json');
  return n;
}
