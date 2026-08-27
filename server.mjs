/**
 * server.mjs — multi-site, MULTI-PAGE, framework-agnostic CMS.
 *
 * A SITE has many PAGES. Each page is a frozen template + content model.
 *   sites/<name>/
 *     site.json                 { order:[slug], home, pages:{slug:{title,path}} }
 *     pages/<slug>/             template.html · content.json · schema.json · meta.json
 *     versions/<seq>.json       immutable snapshot of ALL pages
 *     releases/<seq>/           built static: index.html (home) + <slug>.html
 *     access.json               client magic-link token (hashed)
 *
 * Edits → Guardian → per-page draft → Publish → version (all pages) → static
 * release (atomic pointer). render/guardian/agent/structure are page-agnostic.
 */
import express from 'express';
import { load } from 'cheerio';
import { readFileSync, writeFileSync as _wfs, mkdirSync, readdirSync, existsSync, rmSync as _rm } from 'node:fs';
import { store, initStore, hydrateToFs, closeStore, PERSISTED_PREFIXES } from './lib/store.mjs';
import { createMirrorQueue } from './lib/mirror-queue.mjs';
import { memberByKey, touchMember, atLeast, listMembers, publicMember, addMember, rotateKey, revokeMember, setRole, ROLES } from './lib/team.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from './lib/render.mjs';
import { validate } from './lib/guardian.mjs';
import { plan, plannerMode } from './lib/agent.mjs';
import { autotag } from './lib/autotag.mjs';
import { resyncContent } from './lib/resync.mjs';
import { applyStructure } from './lib/structure.mjs';
import { deployer, vercelDeploy, vercelWhoami } from './lib/deploy.mjs';
import { effectiveSeo, SEO_FIELDS, STYLE_SPEC, sectionList } from './lib/fields.mjs';
import { getConfig, setConfig, aiCreds } from './lib/config.mjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ADMIN_KEY = process.env.ADMIN_KEY || 'owner-dev';
/* Dev mode = nobody set a real key. Some conveniences (editing a site that has
   no access configured yet, without any key at all) only make sense on a laptop;
   on a deployed instance they would make every not-yet-handed-off site
   world-editable, so they are gated on this. */
const DEV_MODE = ADMIN_KEY === 'owner-dev';
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
// Constant-time comparison — a plain === leaks match length/prefix via timing.
const keyEquals = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const ROOT = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(ROOT, 'sites');
mkdirSync(SITES_DIR, { recursive: true });

/* ── persistence mirror ──
   The filesystem stays the fast local working copy. When MongoDB is connected,
   every write/delete under sites/ is mirrored to the DB in real time, and a fresh
   host hydrates from the DB on boot — so the data lives in Mongo, portable across hosts. */
const relOf = (p) => { const s = String(p); if (!s.startsWith(ROOT)) return null; return s.slice(ROOT.length).replace(/^[/\\]/, '').replace(/\\/g, '/'); };
// What gets pushed up to Mongo. PERSISTED_PREFIXES is shared with hydrateToFs()
// so the write side and the read-back side can't drift apart — anything mirrored
// up must come back down on a fresh host. Releases are rebuildable, so excluded.
const mirrorable = (rel) => !!rel && PERSISTED_PREFIXES.some((p) => rel.startsWith(p)) && !rel.includes('/releases/');
/* Mirror operations run through ONE promise chain, so they reach Mongo in the
   order the filesystem saw them. Firing them off independently raced: an ingest
   does rmSync(siteDir) then immediately writes the new pages, and a delete that
   landed after those writes wiped the fresh files — leaving a site.json in the
   DB whose pages were gone, which then crashed every boot. */
const mirrorQueue = createMirrorQueue({ onError: (label, e) => console.error('[mirror]', label, e.message) });
const enqueueMirror = (label, fn) => mirrorQueue.enqueue(label, fn);
/** Wait for every queued mirror write to reach the database. */
const flushMirror = () => mirrorQueue.flush();

function mirrorWrite(p) {
  if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return;
  // Read the bytes NOW rather than inside the queued task — by the time the queue
  // drains this file may already have been deleted or rewritten.
  let put;
  try {
    if (rel.endsWith('.json')) { const v = JSON.parse(readFileSync(p, 'utf8')); put = () => store.putJSON(rel, v); }
    else if (/\.(html|log|txt)$/.test(rel)) { const v = readFileSync(p, 'utf8'); put = () => store.putText(rel, v); }
    else { const v = readFileSync(p); put = () => store.putBuf(rel, v); }
  } catch (e) { return console.error('[mirror] read', rel, e.message); }
  enqueueMirror(`write ${rel}`, put);
}
function mirrorDel(p) {
  if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return;
  enqueueMirror(`del ${rel}`, () => store.del(rel));
}
// mirror-aware drop-ins for the real fs calls (every existing call site uses these names unchanged)
function writeFileSync(p, data, opts) { _wfs(p, data, opts); mirrorWrite(p); }
function rmSync(p, opts) { _rm(p, opts); mirrorDel(p); }

const sites = {}; // name -> { pages:{slug:{templateHtml,schema,content,sections,collections}}, order, home, pagesMeta, draft:{slug:state}, versions, head, access }
const brokenSites = {}; // name -> why it could not be loaded, so the console can say so

const siteDir = (name) => join(SITES_DIR, name.replace(/[^a-z0-9_-]/gi, ''));
const pageDir = (name, slug) => join(siteDir(name), 'pages', String(slug).replace(/[^a-z0-9_-]/gi, ''));
const versionsDir = (name) => join(siteDir(name), 'versions');
function withBase(html) { return html.replace('<head>', '<head><base href="/">'); }

/* ───── load / migrate ───── */
function readPage(name, slug) {
  const pd = pageDir(name, slug);
  const meta = existsSync(join(pd, 'meta.json')) ? JSON.parse(readFileSync(join(pd, 'meta.json'), 'utf8')) : {};
  return {
    templateHtml: readFileSync(join(pd, 'template.html'), 'utf8'),
    schema: JSON.parse(readFileSync(join(pd, 'schema.json'), 'utf8')),
    content: JSON.parse(readFileSync(join(pd, 'content.json'), 'utf8')),
    sections: meta.sections || [],
    collections: meta.collections || [],
  };
}
function writePage(name, slug, p) {
  const pd = pageDir(name, slug);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, 'template.html'), p.templateHtml);
  writeFileSync(join(pd, 'content.json'), JSON.stringify(p.content, null, 2));
  writeFileSync(join(pd, 'schema.json'), JSON.stringify(p.schema, null, 2));
  writeFileSync(join(pd, 'meta.json'), JSON.stringify({ sections: p.sections, collections: p.collections }, null, 2));
}
function writeCfg(name) {
  const s = sites[name];
  writeFileSync(join(siteDir(name), 'site.json'), JSON.stringify({ order: s.order, home: s.home, pages: s.pagesMeta, vercel: s.vercel || null }, null, 2));
}

/* ───── drafts: staged-but-not-live edits, persisted so a Save survives reload/restart ───── */
const draftFile = (name, slug) => join(pageDir(name, slug), 'draft.json');
function writeDraft(name, slug, state) {
  const pd = pageDir(name, slug); mkdirSync(pd, { recursive: true });
  writeFileSync(draftFile(name, slug), JSON.stringify(state));
}
function clearDrafts(name) {
  const s = sites[name];
  for (const slug of Object.keys(s.draft)) rmSync(draftFile(name, slug), { force: true });
  s.draft = {};
}

// Best-known public base URL for a site (owner can set s.domain; else last Vercel URL; else placeholder).
function siteBase(name) {
  const s = sites[name];
  let b = s.domain || (s.vercel?.lastUrl ? s.vercel.lastUrl : '') || `https://${name}.com`;
  if (!/^https?:\/\//.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '');
}
const pagePath = (s, slug) => (slug === s.home ? '/' : `/${slug}`);
// SEO infra: sitemap.xml + robots.txt (auto-generated from the page list).
function sitemapXml(name) {
  const s = sites[name], base = siteBase(name);
  const urls = s.order
    .filter((slug) => (s.pages[slug]?.content?.['seo:robots'] || 'index,follow').indexOf('noindex') === -1)
    .map((slug) => `  <url><loc>${base}${pagePath(s, slug)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
function robotsTxt(name) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteBase(name)}/sitemap.xml\n`;
}
// Build the full static bundle for a site (every page + uploaded images + SEO infra) for Vercel.
function siteFiles(name) {
  const s = sites[name];
  const files = s.order.map((slug) => ({ file: fileFor(s, slug), data: publishedPageHtml(name, slug) }));
  files.push({ file: 'sitemap.xml', data: sitemapXml(name) });
  files.push({ file: 'robots.txt', data: robotsTxt(name) });
  const up = join(siteDir(name), 'uploads');
  if (existsSync(up)) for (const f of readdirSync(up)) files.push({ file: `u/${name}/${f}`, data: readFileSync(join(up, f)).toString('base64'), encoding: 'base64' });
  return files;
}

// Deploy a site to the agency's Vercel (best-effort; never blocks the publish result hard).
async function deployVercel(name) {
  const s = sites[name];
  const token = getConfig().vercelToken;
  if (!token || !s.vercel?.project) return null;
  try {
    const r = await vercelDeploy({ token, teamId: getConfig().vercelTeam, project: s.vercel.project, files: siteFiles(name) });
    s.vercel.lastUrl = r.alias || r.url; s.vercel.lastDeploy = new Date().toISOString();
    writeCfg(name);
    return { ok: true, url: s.vercel.lastUrl };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Old single-page sites → migrate into pages/home and reseed the timeline.
function migrate(name) {
  const dir = siteDir(name);
  if (existsSync(join(dir, 'site.json'))) return;
  if (!existsSync(join(dir, 'template.html'))) return;
  const home = pageDir(name, 'home');
  mkdirSync(home, { recursive: true });
  for (const f of ['template.html', 'content.json', 'schema.json', 'meta.json']) {
    if (existsSync(join(dir, f))) { writeFileSync(join(home, f), readFileSync(join(dir, f))); rmSync(join(dir, f)); }
  }
  writeFileSync(join(dir, 'site.json'), JSON.stringify({ order: ['home'], home: 'home', pages: { home: { title: 'Home', path: '/' } } }, null, 2));
  rmSync(versionsDir(name), { recursive: true, force: true });
  rmSync(join(dir, 'releases'), { recursive: true, force: true });
  rmSync(join(dir, 'head.json'), { force: true });
}

function loadSite(name) {
  const dir = siteDir(name);
  migrate(name);
  if (!existsSync(join(dir, 'site.json'))) return null;
  const cfg = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
  const pages = {};
  for (const slug of cfg.order) pages[slug] = readPage(name, slug);
  sites[name] = {
    pages, order: cfg.order, home: cfg.home, pagesMeta: cfg.pages, vercel: cfg.vercel || null,
    draft: {}, versions: [], head: -1,
    access: existsSync(join(dir, 'access.json')) ? JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')) : null,
  };
  for (const slug of cfg.order) { const df = draftFile(name, slug); if (existsSync(df)) { try { sites[name].draft[slug] = JSON.parse(readFileSync(df, 'utf8')); } catch {} } }
  loadVersions(name);
  if (deployer.current(dir) == null && sites[name].head >= 0) buildRelease(name, sites[name].head);
  return sites[name];
}

/* ───── the page the editor is working against (draft if staged) ───── */
const pageState = (s, slug) => s.draft[slug] || s.pages[slug];
const hasDraft = (s) => Object.keys(s.draft).length > 0;
const fileFor = (s, slug) => (slug === s.home ? 'index.html' : `${slug}.html`);

// Inject a tiny script so live/deployed forms post submissions back to the CMS inbox.
function wireForms(html, name) {
  const ep = `${(getConfig().publicUrl || 'http://localhost:4321').replace(/\/+$/, '')}/api/forms/${name}`;
  const script = `<script>(function(){var EP=${JSON.stringify(ep)};document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={_page:location.pathname};new FormData(f).forEach(function(v,k){if(typeof v==='string')d[k]=v;});fetch(EP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(){f.innerHTML='<p style="padding:18px;font-size:16px;text-align:center">✓ Thanks — we\\'ve got your message.</p>';}).catch(function(){});});});})();</script>`;
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}
function publishedPageHtml(name, slug) {
  const p = sites[name].pages[slug];
  return wireForms(withBase(render(p.templateHtml, p.schema, p.content)), name);
}

/* ───── deploy: build the whole static site for a version ───── */
function buildRelease(name, seq) {
  const s = sites[name];
  const files = s.order.map((slug) => ({ path: fileFor(s, slug), content: publishedPageHtml(name, slug) }));
  deployer.stage(siteDir(name), seq, files);
  deployer.activate(siteDir(name), seq);
}

/* ───── versions: snapshot ALL pages + site config ───── */
function loadVersions(name) {
  const s = sites[name];
  const dir = versionsDir(name);
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b));
  if (!files.length) { s.versions = []; s.head = -1; saveVersion(name, 'Initial version'); return; }
  s.versions = files.map((f) => { const v = JSON.parse(readFileSync(join(dir, f), 'utf8')); return { seq: v.seq, ts: v.ts, summary: v.summary }; });
  const hp = join(siteDir(name), 'head.json');
  s.head = existsSync(hp) ? JSON.parse(readFileSync(hp, 'utf8')).head : s.versions[s.versions.length - 1].seq;
}

function saveVersion(name, summary) {
  const s = sites[name];
  const dir = versionsDir(name);
  mkdirSync(dir, { recursive: true });
  const seq = (s.versions.length ? Math.max(...s.versions.map((v) => v.seq)) : -1) + 1;
  const pages = {};
  for (const slug of s.order) { const p = s.pages[slug]; pages[slug] = { template: p.templateHtml, schema: p.schema, content: p.content, sections: p.sections, collections: p.collections }; }
  const state = { order: s.order, home: s.home, pagesMeta: s.pagesMeta, pages };
  writeFileSync(join(dir, `${seq}.json`), JSON.stringify({ seq, ts: new Date().toISOString(), summary, state }, null, 2));
  s.versions.push({ seq, ts: new Date().toISOString(), summary });
  s.head = seq;
  writeFileSync(join(siteDir(name), 'head.json'), JSON.stringify({ head: seq }));
  buildRelease(name, seq);
}

function restoreVersion(name, seq) {
  const s = sites[name];
  const f = join(versionsDir(name), `${seq}.json`);
  if (!existsSync(f)) return false;
  const { state } = JSON.parse(readFileSync(f, 'utf8'));
  s.order = state.order; s.home = state.home; s.pagesMeta = state.pagesMeta; s.pages = {}; s.draft = {};
  for (const slug of state.order) {
    const ps = state.pages[slug];
    s.pages[slug] = { templateHtml: ps.template, schema: ps.schema, content: ps.content, sections: ps.sections || [], collections: ps.collections || [] };
    writePage(name, slug, s.pages[slug]);
  }
  writeCfg(name);
  s.head = seq;
  writeFileSync(join(siteDir(name), 'head.json'), JSON.stringify({ head: seq }));
  buildRelease(name, seq);
  return true;
}

/* One line per action, per site. `actor` identifies the person — with team keys
   in play, a bare role no longer says who did anything. Older lines predate the
   actor field and carry only `role`; readers must tolerate both. */
function auditLog(name, actor, entry) {
  const p = join(siteDir(name), 'audit.log');
  const a = actor || {};
  const line = { at: new Date().toISOString(), actor: { id: a.id || null, name: a.name || null, role: a.role || 'owner' }, role: a.role || 'owner', ...entry };
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + JSON.stringify(line) + '\n');
}
/* The resolved actor, or a safe default for paths that run before/without auth. */
const actorOf = (req) => req.actor || { id: null, name: null, role: req.role || 'owner' };

// boot
{
  const m = await initStore();                       // connect Mongo if MONGODB_URI is set
  if (m.mode === 'mongodb') {
    if (m.migrated) console.log(`MongoDB connected (db: ${m.db}) — migrated ${m.migrated} files from disk on first run.`);
    else { const n = await hydrateToFs(); console.log(`MongoDB connected (db: ${m.db}) — hydrated ${n} files from the database.`); }
  }
  // One unreadable site must never take the whole CMS down — every other client's
  // editor and live site depend on this process starting. Skip it loudly instead.
  for (const d of readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try { loadSite(d.name); }
    catch (e) {
      brokenSites[d.name] = e.message;
      console.error(`[boot] site "${d.name}" could not be loaded and was skipped — ${e.message}`);
      console.error(`[boot] re-ingest it from the console to repair it (its pages are missing from storage).`);
      delete sites[d.name];
    }
  }
  const broken = Object.keys(brokenSites);
  if (broken.length) console.error(`[boot] ${broken.length} site(s) skipped: ${broken.join(', ')}`);
}

/* ───────────────────────────── app ───────────────────────────── */
const app = express();
app.use(express.json({ limit: '16mb' }));
app.set('trust proxy', 1);                    // behind the host's proxy, req.ip = the visitor
// CORS is open ONLY for form capture — live client sites post here from their own
// domains. Nothing else is meant to be called cross-origin, so nothing else gets it.
app.use('/api/forms', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/assets', express.static(join(ROOT, 'site/assets')));
app.use('/editor', express.static(join(ROOT, 'editor')));
app.use('/admin', express.static(join(ROOT, 'admin')));

const get = (req) => req.query.site || req.body?.site;
const pageOf = (req, s) => { const p = req.query.page || req.body?.page || s.home; return s.pages[p] || s.draft[p] ? p : s.home; };
const need = (req, res) => { const s = sites[get(req)]; if (!s) res.status(404).json({ error: `Unknown site "${get(req)}"` }); return s; };
const providedKey = (req) => req.query.key || req.headers['x-edit-key'] || req.body?.key;

const STAFF_ROLES = ['owner', 'admin', 'editor'];
const isStaff = (role) => STAFF_ROLES.includes(role);

/* ── brute-force limiting ──
   Client passwords can be short, so unlimited guessing is not acceptable. Only
   FAILED attempts count (a key was presented and matched nothing); once an IP is
   over the limit, every keyed request from it is refused until the window rolls,
   valid keys included — that lockout is the point of the brake. */
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = Number(process.env.CMS_AUTH_RATE_LIMIT || 60);
const authFails = new Map();                       // ip -> { n, at }
function recordAuthFail(ip) {
  if (authFails.size > 5000) { const cut = Date.now() - AUTH_WINDOW_MS; for (const [k, v] of authFails) if (v.at < cut) authFails.delete(k); }
  const e = authFails.get(ip);
  if (!e || Date.now() - e.at > AUTH_WINDOW_MS) authFails.set(ip, { n: 1, at: Date.now() });
  else e.n++;
}
function rateLimited(req, res) {
  const e = authFails.get(req.ip);
  if (providedKey(req) && e && Date.now() - e.at <= AUTH_WINDOW_MS && e.n >= AUTH_MAX_FAILS) {
    res.status(429).json({ error: 'Too many failed sign-in attempts from this address — wait a few minutes and try again.' });
    return true;
  }
  return false;
}

/* Resolve the caller to an actor, first match winning:
     1. ADMIN_KEY        → root owner. Break-glass: works even if the member
                           store is empty, corrupt, or unreachable.
     2. a member key     → that member, at their own role
     3. the site's token → the client for this one site
     4. anything else    → role 'none'
   Memoised on `req` so a request crossing several guards only looks up once. */
async function resolveActor(req) {
  if (req.actor) return req.actor;
  const key = providedKey(req);
  let actor = { id: null, name: null, role: 'none' };
  if (key && keyEquals(key, ADMIN_KEY)) {
    actor = { id: 'root', name: 'Owner key', role: 'owner' };
  } else if (key) {
    const m = await memberByKey(key);
    if (m) {
      actor = { id: m.id, name: m.name, role: m.role };
      touchMember(m.id);                                  // fire-and-forget activity stamp
    } else {
      const s = sites[get(req)];
      if (s?.access?.tokenHash && sha256(key) === s.access.tokenHash) {
        actor = { id: null, name: s.access.clientName || 'Client', role: 'client' };
      } else {
        recordAuthFail(req.ip);                           // a key was presented and matched nothing
      }
    }
  }
  req.actor = actor;
  req.role = actor.role;                                  // kept for existing call sites
  return actor;
}

async function authWrite(req, res, next) {
  const s = sites[get(req)];
  if (!s) return next();
  if (rateLimited(req, res)) return;
  const a = await resolveActor(req);
  if (isStaff(a.role) || a.role === 'client') return next();
  // Keyless editing of a site with no access configured is a LAPTOP convenience.
  // On a deployed instance (a real ADMIN_KEY is set) it would make every
  // not-yet-handed-off site editable by anyone who guesses its name.
  if (DEV_MODE && !s.access?.tokenHash) { req.actor = { id: null, name: 'Local', role: 'owner' }; req.role = 'owner'; return next(); }
  return res.status(401).json({ error: 'This site requires a valid editor link.' });
}

/* Guard factory. owner ≥ admin ≥ editor, so requireRole('admin') admits owners. */
function requireRole(needed) {
  return async (req, res, next) => {
    if (rateLimited(req, res)) return;
    const a = await resolveActor(req);
    if (atLeast(a.role, needed)) return next();
    return res.status(401).json({ error: `This action needs ${needed} access or higher.` });
  };
}
const requireOwner = requireRole('owner');   // credentials + team management
const requireAdmin = requireRole('admin');   // client relationships
const requireStaff = requireRole('editor');  // any team member

function injectEditor(html, schema) {
  const richIds = Object.entries(schema).filter(([, d]) => d.rich).map(([id]) => id);
  const overlay = `
<style id="cms-ee">
  [data-cms]:focus{outline:none !important}
  .cms-edited{}
  .cmsL{position:fixed;pointer-events:none;z-index:2147483600;border:2px solid #0a72ef;border-radius:5px;display:none;transition:all .06s ease}
  .cmsL.sel{border-color:#0a72ef;box-shadow:0 0 0 4px rgba(10,114,239,.16)}
  .cmsTag{position:fixed;pointer-events:none;z-index:2147483601;background:#0a72ef;color:#fff;font:600 11px/1 'Geist',system-ui,sans-serif;padding:4px 8px;border-radius:6px;display:none;white-space:nowrap}
  .cmsBar{position:fixed;z-index:2147483602;display:none;gap:1px;background:#141416;border-radius:10px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 1px #2c2c32;pointer-events:auto;font-family:'Geist',system-ui,sans-serif}
  .cmsBar button{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:#ededed;height:30px;padding:0 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:500}
  .cmsBar button:hover{background:#26262b}
  .cmsBar button.rm:hover{background:#ff5b4f;color:#fff}
  .cmsBar .sep{width:1px;align-self:stretch;background:#2c2c32;margin:4px 2px}
  .cmsFlash{position:fixed;pointer-events:none;z-index:2147483599;border:2px solid #27c93f;border-radius:8px;display:none;box-shadow:0 0 0 4px rgba(39,201,63,.18);transition:opacity .4s ease}
  /* section-level selection (click the background of a block) */
  .cmsSect{position:fixed;pointer-events:none;z-index:2147483598;border:2px dashed #a05cf0;border-radius:9px;display:none;background:rgba(160,92,240,.06);transition:all .06s ease}
  .cmsSTag{position:fixed;pointer-events:none;z-index:2147483601;background:#a05cf0;color:#fff;font:600 11px/1 'Geist',system-ui,sans-serif;padding:4px 9px;border-radius:6px;display:none;white-space:nowrap;display:none}
  .cmsSBar{position:fixed;z-index:2147483602;display:none;gap:1px;background:#141416;border-radius:10px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 1px #2c2c32;pointer-events:auto;font-family:'Geist',system-ui,sans-serif}
  .cmsSBar button{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:#ededed;height:30px;padding:0 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:500}
  .cmsSBar button:hover{background:#26262b}
</style>
<script>window.__CMS={rich:${JSON.stringify(richIds)}};</script>
<script>(function(){
  var RICH=new Set(window.__CMS.rich);
  function send(id,value){parent.postMessage({type:'cms-edit',id:id,value:value},'*');}
  function isImg(el){return el.hasAttribute('data-cms-img');}
  function idOf(el){return el.getAttribute('data-cms')||el.getAttribute('data-cms-img');}
  function selInfo(el){var a=el.closest('a');return {type:'cms-select',id:idOf(el),tag:el.tagName,text:(el.innerText||'').trim(),href:a?(a.getAttribute('href')||''):null,img:isImg(el)};}
  function kind(el){var t=el.tagName.toLowerCase();if(isImg(el))return el.tagName==='VIDEO'?'Video':'Image';if(/^h[1-6]$/.test(t))return 'Heading';if(t==='a')return 'Link';if(t==='button'||el.closest('button'))return 'Button';if(t==='li')return 'List item';if(t==='blockquote')return 'Quote';return 'Text';}
  // floating chrome (portal — robust over any site CSS)
  var box=document.createElement('div');box.className='cmsL';
  var tag=document.createElement('div');tag.className='cmsTag';
  var bar=document.createElement('div');bar.className='cmsBar';
  var flash=document.createElement('div');flash.className='cmsFlash';
  var sbox=document.createElement('div');sbox.className='cmsSect';
  var stag=document.createElement('div');stag.className='cmsSTag';
  var sbar=document.createElement('div');sbar.className='cmsSBar';
  document.documentElement.appendChild(box);document.documentElement.appendChild(tag);document.documentElement.appendChild(bar);document.documentElement.appendChild(flash);
  document.documentElement.appendChild(sbox);document.documentElement.appendChild(stag);document.documentElement.appendChild(sbar);
  // sections = the same blocks the Sections navigator uses
  var SECTIONS=[].slice.call(document.querySelectorAll('header, main > section, body > section, section, footer')).filter(function(el){return el.offsetHeight>40;});
  var csec=null;
  function sectionOf(el){var n=el;while(n&&n!==document.body){if(SECTIONS.indexOf(n)>-1)return n;n=n.parentElement;}return null;}
  function sectionLabel(sec){var t=sec.tagName.toLowerCase();if(t==='header')return 'Header';if(t==='footer')return 'Footer';var h=sec.querySelector('h1,h2,h3');if(h&&(h.innerText||'').trim())return (h.innerText||'').trim().slice(0,42);if(sec.id)return sec.id.replace(/[-_]/g,' ');return 'Section';}
  function clearSection(){csec=null;sbox.style.display='none';stag.style.display='none';sbar.style.display='none';}
  function placeSection(){if(!csec)return;var r=csec.getBoundingClientRect();sbox.style.display='block';sbox.style.left=(r.left-2)+'px';sbox.style.top=(r.top-2)+'px';sbox.style.width=(r.width)+'px';sbox.style.height=(r.height)+'px';
    var bh=sbar.offsetHeight||38;var top=r.top>bh+30?(r.top-bh-10):(r.top+10);
    stag.style.display='block';stag.textContent='◳ '+sectionLabel(csec);stag.style.left=(r.left)+'px';stag.style.top=Math.max(6,top-2)+'px';
    sbar.style.display='flex';sbar.style.top=Math.max(6,top)+'px';sbar.style.left=Math.min(r.left+96,window.innerWidth-sbar.offsetWidth-8)+'px';}
  function selectSection(sec){deselect();csec=sec;sbar.innerHTML='';
    var b=document.createElement('button');b.innerHTML='✎ Edit this section';b.onclick=function(e){e.preventDefault();e.stopPropagation();var first=sec.querySelector('[data-cms],[data-cms-img]');if(first){clearSection();select(first);first.scrollIntoView&&0;}};sbar.appendChild(b);
    placeSection();parent.postMessage({type:'cms-section',label:sectionLabel(sec)},'*');}
  function flashEl(el){if(!el)return;var r=el.getBoundingClientRect();flash.style.display='block';flash.style.opacity='1';flash.style.left=(r.left-3)+'px';flash.style.top=(r.top-3)+'px';flash.style.width=(r.width+2)+'px';flash.style.height=(r.height+2)+'px';clearTimeout(flash._t);flash._t=setTimeout(function(){flash.style.opacity='0';setTimeout(function(){flash.style.display='none';},400);},1000);}
  var current=null;
  function showHover(el){if(el===current)return;var r=el.getBoundingClientRect();box.classList.remove('sel');box.style.display='block';box.style.left=(r.left-2)+'px';box.style.top=(r.top-2)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';tag.style.display='block';tag.textContent=kind(el);tag.style.left=r.left+'px';tag.style.top=Math.max(2,r.top-23)+'px';}
  function hideHover(){if(!current){box.style.display='none';tag.style.display='none';}}
  function colItems(col){return [].slice.call(document.querySelectorAll('[data-cms-item="'+col+'"]'));}
  function placeSel(){if(!current)return;var r=current.getBoundingClientRect();box.classList.add('sel');box.style.display='block';box.style.left=(r.left-2)+'px';box.style.top=(r.top-2)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';
    var bh=bar.offsetHeight||38,bw=bar.offsetWidth||190;
    // toolbar ABOVE the element with a gap; flip BELOW only when too near the top (so it never sits over the page nav)
    var above=r.top>bh+58;var top=above?(r.top-bh-12):(r.bottom+12);
    var left=Math.min(Math.max(8,r.left),window.innerWidth-bw-8);
    bar.style.display='flex';bar.style.top=Math.max(8,top)+'px';bar.style.left=left+'px';
    // the kind tag rides with the toolbar so they don't both cover the element
    tag.style.display='block';tag.textContent=kind(current);tag.style.left=left+'px';tag.style.top=(above?top-19:top+bh+3)+'px';}
  function buildBar(el){
    bar.innerHTML='';
    function add(label,fn,cls){var b=document.createElement('button');b.innerHTML=label;if(cls)b.className=cls;b.onclick=function(e){e.preventDefault();e.stopPropagation();fn();};bar.appendChild(b);}
    function sep(){var s=document.createElement('span');s.className='sep';bar.appendChild(s);}
    if(isImg(el))add('🖼 Replace',function(){parent.postMessage({type:'cms-open',panel:'image',id:idOf(el)},'*');});
    else add('✎ Edit',function(){el.focus();});
    if(el.closest('a'))add('🔗 Link',function(){parent.postMessage({type:'cms-open',panel:'link',id:idOf(el)},'*');});
    add('↕ Style',function(){parent.postMessage({type:'cms-open',panel:'style',id:idOf(el)},'*');});
    var item=el.closest('[data-cms-item]');
    if(item&&!item.hasAttribute('data-cms')){var col=item.getAttribute('data-cms-item');sep();
      add('⧉ Duplicate',function(){parent.postMessage({type:'cms-structure',op:'add_item',col:col,index:colItems(col).indexOf(item)},'*');});
      add('🗑',function(){parent.postMessage({type:'cms-structure',op:'remove_item',col:col,index:colItems(col).indexOf(item)},'*');},'rm');
    }
  }
  function deselect(){current=null;box.style.display='none';tag.style.display='none';bar.style.display='none';document.querySelectorAll('.cms-sel').forEach(function(x){x.classList.remove('cms-sel');});parent.postMessage({type:'cms-deselect'},'*');}
  function select(el){clearSection();document.querySelectorAll('.cms-sel').forEach(function(x){x.classList.remove('cms-sel');});current=el;el.classList&&el.classList.add('cms-sel');buildBar(el);placeSel();parent.postMessage(selInfo(el),'*');}
  // click the background of a block → highlight that whole section; click truly-empty space → deselect
  document.addEventListener('mousedown',function(e){
    if(e.target.closest('[data-cms],[data-cms-img]')||e.target.closest('.cmsBar')||e.target.closest('.cmsSBar'))return;
    var sec=sectionOf(e.target);
    if(sec){selectSection(sec);}else{deselect();clearSection();}
  },true);
  // hover + click wiring
  document.querySelectorAll('[data-cms],[data-cms-img]').forEach(function(el){
    el.addEventListener('mouseenter',function(){showHover(el);});
    el.addEventListener('mouseleave',hideHover);
    if(isImg(el)){el.style.cursor='pointer';el.addEventListener('click',function(e){e.preventDefault();select(el);});}
  });
  document.querySelectorAll('[data-cms]').forEach(function(el){
    var id=el.getAttribute('data-cms');
    el.setAttribute('contenteditable', RICH.has(id)?'true':'plaintext-only');
    el.addEventListener('focus',function(){select(el);});
    el.addEventListener('click',function(){select(el);});
    el.addEventListener('keydown',function(e){if(e.key==='Enter'&&!RICH.has(id)){e.preventDefault();el.blur();}if(e.key==='Escape')el.blur();});
    el.addEventListener('input',placeSel);
    el.addEventListener('blur',function(){el.classList.add('cms-edited');send(id,RICH.has(id)?el.innerHTML:el.innerText);});
  });
  // links to other pages navigate; other links just select for editing
  document.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(e){var href=a.getAttribute('href')||'';if(href.indexOf('/live/')>-1){e.preventDefault();e.stopPropagation();parent.postMessage({type:'cms-nav',href:href},'*');}else{e.preventDefault();}},true);});
  document.querySelectorAll('button[id],form').forEach(function(el){el.addEventListener('click',function(e){if(!e.target.closest('[data-cms-img]'))e.preventDefault();},true);});
  window.addEventListener('scroll',function(){hideHover();placeSel();placeSection();},true);
  window.addEventListener('resize',function(){placeSel();placeSection();});
  window.addEventListener('message',function(e){var d=e.data;if(!d)return;
    if(d.type==='apply-style'){var el=document.querySelector('[data-cms="'+d.id+'"],[data-cms-img="'+d.id+'"]');if(!el)return;if(d.value==='')el.style.removeProperty(d.css);else el.style.setProperty(d.css,d.value);el.classList.add('cms-edited');placeSel();}
    if(d.type==='set-text'){var t=document.querySelector('[data-cms="'+d.id+'"]');if(t){t.innerText=d.value;t.classList.add('cms-edited');placeSel();}}
    if(d.type==='set-img'){var im=document.querySelector('[data-cms-img="'+d.id+'"]');if(im){im.setAttribute('src',d.value);im.classList.add('cms-edited');placeSel();}}
    if(d.type==='focus-el'){var f=document.querySelector('[data-cms="'+d.id+'"],[data-cms-img="'+d.id+'"]');if(f)select(f);}
    if(d.type==='scroll-to'){var sc=document.querySelector(d.sel);if(sc){var top=0,n=sc;while(n){top+=n.offsetTop||0;n=n.offsetParent;}var se=document.scrollingElement||document.documentElement;se.scrollTop=Math.max(0,top-16);setTimeout(function(){flashEl(sc);},40);}}
    if(d.type==='flash'){(d.ids||[]).forEach(function(id){flashEl(document.querySelector('[data-cms="'+id+'"],[data-cms-img="'+id+'"]'));});}
    if(d.type==='select-in'){var sec=document.querySelector(d.sel);if(sec){var first=sec.querySelector('[data-cms],[data-cms-img]')||(sec.matches('[data-cms],[data-cms-img]')?sec:null);if(first)select(first);}}
  });
})();</script>`;
  return html.replace('</body>', overlay + '</body>');
}

app.get('/', (_req, res) => res.redirect('/editor/'));

// LIVE site (static release). Home + each page.
app.get('/live/:name', (req, res) => {
  if (!sites[req.params.name]) return res.status(404).send('Unknown site');
  const html = deployer.liveHtml(siteDir(req.params.name), 'index.html');
  res.type('html').send(html || 'Not published yet');
});
app.get('/live/:name/:slug', (req, res) => {
  if (!sites[req.params.name]) return res.status(404).send('Unknown site');
  const html = deployer.liveHtml(siteDir(req.params.name), `${req.params.slug.replace(/[^a-z0-9_-]/gi, '')}.html`);
  if (!html) return res.status(404).send('No such page');
  res.type('html').send(html);
});

// Editable preview of a page.
app.get('/s/:name', (req, res) => {
  const s = sites[req.params.name];
  if (!s) return res.status(404).send('Unknown site');
  const slug = s.pages[req.query.page] ? req.query.page : s.home;
  const a = pageState(s, slug);
  let html = withBase(render(a.templateHtml, a.schema, a.content));
  if (req.query.edit) html = injectEditor(html, a.schema);
  res.type('html').send(html);
});

app.get('/api/sites', requireStaff, (_req, res) => res.json({
  plannerMode: plannerMode(),
  // Sites that failed to load are reported rather than silently missing, so a
  // broken one is visible in the console instead of looking deleted.
  broken: Object.entries(brokenSites).map(([name, error]) => ({ name, error })),
  sites: Object.keys(sites).map((name) => {
    const s = sites[name];
    return { name, pages: s.order.length, handedOff: !!s.access?.tokenHash, authMode: s.access?.mode || (s.access?.tokenHash ? 'link' : null), client: s.access?.clientName || null, requireApproval: !!s.access?.requireApproval, versions: s.versions.length, vercelProject: s.vercel?.project || null, vercelUrl: s.vercel?.lastUrl || null };
  }),
}));

// Who am I? owner (agency, sees all sites) vs client (one site, simple editor).
app.get('/api/me', async (req, res) => {
  if (rateLimited(req, res)) return;
  const s = sites[get(req)];
  const a = await resolveActor(req);
  let role = a.role;
  if (DEV_MODE && role === 'none' && s && !s.access?.tokenHash) role = 'owner'; // laptop only — see authWrite
  // 'locked' = the site has a password set but no/wrong key was given → show the login gate
  const locked = role === 'none' && !!(s && s.access?.tokenHash);
  res.json({
    role,
    // `staff` is what the editor should branch on, not role === 'owner' — admins
    // and editors are team members too and must get the team UI, never the gated
    // client one.
    staff: isStaff(role),
    canApprove: isStaff(role),
    actor: { id: a.id, name: a.name, role },
    locked, hasAccess: !!(s && s.access?.tokenHash), requireApproval: !!(s && s.access?.requireApproval),
    clientName: s?.access?.clientName || null, site: get(req), plannerMode: plannerMode(),
  });
});

app.get('/api/pages', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  res.json({ order: s.order, home: s.home, pages: s.order.map((slug) => ({ slug, ...s.pagesMeta[slug], home: slug === s.home, dirty: !!s.draft[slug] })) });
});

/* ───── fetching live pages (shared by ingest, page-add and discovery) ─────
   Sites are captured from their built output over plain HTTP — no repo, no build.
   Note this never runs JavaScript, so a client-rendered SPA yields only its shell;
   server-rendered and static sites (Astro, Next, Hugo, plain HTML) come through whole. */
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGES = 40;                       // cap per ingest, so one call can't run away
const MAX_FETCH_BYTES = 8 * 1024 * 1024;    // a real page is well under this
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|css|js|mjs|json|txt|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|dmg|exe)$/i;

/* The server fetches URLs people type in. It must never be usable to read the
   host's own network — localhost, the cloud metadata service, internal services.
   Hostname-literal checks (not full DNS pinning); URL capture is staff-only, so
   this is a second layer, not the only one. Tests opt out to reach their local
   fixture server via CMS_ALLOW_PRIVATE_FETCH=1. */
const PRIVATE_HOST_RE = /^(localhost|.*\.(local|localhost|internal|home\.arpa))$/i;
function isPrivateIp(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^(::1?|::ffff:.*|f[cd][0-9a-f]{2}:.*|fe80:.*)$/i.test(h);
}
function assertFetchableUrl(u) {
  if (process.env.CMS_ALLOW_PRIVATE_FETCH === '1') return;
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) URLs can be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RE.test(host) || isPrivateIp(host)) throw new Error('that address is not reachable from here');
}

async function fetchText(url) {
  assertFetchableUrl(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  assertFetchableUrl(r.url || url);          // a redirect must not smuggle us somewhere private
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_FETCH_BYTES) throw new Error('page too large to ingest');
  const text = await r.text();
  if (text.length > MAX_FETCH_BYTES) throw new Error('page too large to ingest');
  return { text, type: r.headers.get('content-type') || '' };
}
async function fetchHtml(url) {
  const { text, type } = await fetchText(url);
  if (type && !/text\/html|application\/xhtml/i.test(type)) throw new Error(`not an HTML page (${type.split(';')[0]})`);
  return text;
}

/** "https://x.com/services/plumbing/" → "services-plumbing"; a bare origin → "home". */
function slugFromUrl(url) {
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url); }
  path = path.replace(/\/+$/, '').replace(/\.(html?|php)$/i, '');
  return path.split('/').filter(Boolean).join('-').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
}
const cleanSlug = (raw, fallback) => String(raw || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
const prettify = (slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const titleFromHtml = (html, fallback) => {
  try { const t = load(html)('head > title').first().text().trim(); if (t) return t.slice(0, 60); } catch {}
  return fallback;
};
/** Free `slug` of collisions against pages already in `taken`. */
function uniqueSlug(slug, taken) {
  if (!taken[slug]) return slug;
  for (let n = 2; ; n++) { const s = `${slug}-${n}`.slice(0, 40); if (!taken[s]) return s; }
}

/** Map with bounded concurrency, preserving input order. `fn` must not throw. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* Find a site's other pages: its sitemap first (Astro, Next, Hugo and friends all
   emit one), else the same-origin links on the page itself. Best-effort — the
   caller decides what to actually ingest. */
async function discoverPages(startUrl) {
  const origin = new URL(startUrl).origin;
  const found = new Set();
  const keep = (href) => {
    let u; try { u = new URL(href, startUrl); } catch { return; }
    if (u.origin !== origin || !/^https?:$/.test(u.protocol)) return;
    if (ASSET_RE.test(u.pathname)) return;
    u.hash = ''; u.search = '';
    found.add(u.href.replace(/(.)\/$/, '$1'));           // drop a trailing slash, keep "https://x.com/"
  };
  const locsOf = (xml) => { const $ = load(xml, { xmlMode: true }); return $('loc').map((_, el) => $(el).text().trim()).get(); };

  for (const path of ['/sitemap-index.xml', '/sitemap.xml', '/sitemap-0.xml']) {
    try {
      const { text } = await fetchText(origin + path);
      if (!/<(urlset|sitemapindex)/i.test(text)) continue;
      if (/<sitemapindex/i.test(text)) {
        for (const child of locsOf(text).slice(0, 5)) {
          try { locsOf((await fetchText(child)).text).forEach(keep); } catch {}
        }
      } else locsOf(text).forEach(keep);
      if (found.size) break;
    } catch {}
  }
  if (!found.size) {                                      // no sitemap → read the page's own links
    try { const $ = load(await fetchHtml(startUrl)); $('a[href]').each((_, el) => keep($(el).attr('href'))); } catch {}
  }
  keep(startUrl);                                         // the starting page always belongs
  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/* List the pages of a live site without ingesting anything, so the console can
   offer them for selection. */
app.post('/api/discover', requireStaff, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Need a URL to look at.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'That does not look like a URL.' }); }
  try {
    const urls = (await discoverPages(url)).slice(0, MAX_PAGES);
    res.json({ ok: true, urls, pages: urls.map((u) => ({ url: u, slug: slugFromUrl(u), path: new URL(u).pathname || '/' })) });
  } catch (e) { res.status(400).json({ error: `Could not read that site — ${e.message}` }); }
});

app.post('/api/ingest', requireStaff, async (req, res) => {
  const name = String(req.body?.name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!name) return res.status(400).json({ error: 'Need a site name.' });

  // Ingest always starts a site from scratch, so re-running it over a live site
  // would destroy its content, version history and client edits. Make that an
  // explicit choice rather than something a repeated name can do silently.
  if (sites[name] && !req.body?.replace) {
    return res.status(409).json({
      exists: true,
      error: `"${name}" already exists. To add more pages to it, use "Add page from URL" in its editor. To wipe it and start over, confirm the replace.`,
    });
  }

  // Accept a list of URLs (multi-page), a single URL, or pasted HTML.
  const raw = Array.isArray(req.body?.urls) ? req.body.urls : (req.body?.url ? [req.body.url] : []);
  const urls = [...new Set(raw.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_PAGES);
  const pasted = req.body?.html;
  if (!urls.length && !pasted) return res.status(400).json({ error: 'Provide a URL (or several), or paste the page HTML.' });

  // Fetch everything up front — nothing is written until at least one page is good,
  // so a dead URL can never leave a half-built site behind.
  const fetched = (urls.length)
    ? await mapLimit(urls, 4, async (u) => {
        try { return { ok: true, url: u, html: await fetchHtml(u) }; }
        catch (e) { return { ok: false, url: u, error: e.message }; }
      })
    : [{ ok: true, url: req.body?.baseUrl || null, html: pasted }];

  const good = fetched.filter((f) => f.ok);
  const failed = fetched.filter((f) => !f.ok).map(({ url, error }) => ({ url, error }));
  if (!good.length) return res.status(400).json({ error: `Could not fetch ${failed[0].url} — ${failed[0].error}`, failed });
  // The FIRST url is the home page — the anchor everything else hangs off. If it
  // failed, refusing beats silently promoting some subpage to home.
  if (!fetched[0].ok) {
    return res.status(400).json({ error: `The first URL is the home page and it could not be fetched (${fetched[0].error}) — fix that one and retry.`, failed });
  }

  // Replacing a site keeps its RELATIONSHIPS even though its content restarts:
  // the client's password/link and the Vercel project it deploys to. Losing
  // those on a repair re-ingest would lock the client out and break publishing.
  // Read them from disk, not just memory — a broken site being repaired was
  // never loaded, but its access.json may still be there.
  const readJsonIf = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
  const prior = {
    access: sites[name]?.access ?? readJsonIf(join(siteDir(name), 'access.json')),
    vercel: sites[name]?.vercel ?? (readJsonIf(join(siteDir(name), 'site.json'))?.vercel || null),
  };

  rmSync(siteDir(name), { recursive: true, force: true });   // fresh site
  delete brokenSites[name];                                  // a re-ingest is the repair path
  const s = sites[name] = { pages: {}, order: [], home: 'home', pagesMeta: {}, draft: {}, versions: [], head: -1, access: prior.access, vercel: prior.vercel };
  mkdirSync(siteDir(name), { recursive: true });
  if (prior.access) writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(prior.access, null, 2));

  const added = [];
  good.forEach((f, i) => {
    const isHome = i === 0;                                  // the first page that loaded becomes home
    const slug = isHome ? 'home' : uniqueSlug(slugFromUrl(f.url), s.pagesMeta);
    const tagged = autotag(f.html, f.url || req.body?.baseUrl);
    writePage(name, slug, tagged);
    s.order.push(slug);
    s.pagesMeta[slug] = {
      title: isHome ? (req.body?.title || titleFromHtml(f.html, 'Home')) : titleFromHtml(f.html, prettify(slug)),
      path: isHome ? '/' : `/${slug}`,
    };
    added.push({ slug, url: f.url, title: s.pagesMeta[slug].title, fields: Object.keys(tagged.schema).length });
  });

  writeCfg(name);
  loadSite(name);
  res.json({
    ok: true, name,
    pages: added.length,
    fields: added.reduce((n, a) => n + a.fields, 0),
    collections: (sites[name].pages[sites[name].home]?.collections || []).length,
    added, failed,
  });
});

// Re-sync: re-ingest a REDESIGNED template for an existing site WITHOUT losing the client's edits.
// Matches each edited slot to a slot in the new design by role + content, carries the value over.
app.post('/api/resync', requireStaff, async (req, res) => {
  const name = String(req.body?.site || req.body?.name || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const slug = (req.body?.page && s.pages[req.body.page]) ? req.body.page : s.home;
  let html = req.body?.html, baseUrl = req.body?.baseUrl;
  if (!html && req.body?.url) {
    try { const u = String(req.body.url); const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); html = await r.text(); baseUrl = baseUrl || u; }
    catch (e) { return res.status(400).json({ error: 'Could not fetch that URL — ' + e.message }); }
  }
  if (!html) return res.status(400).json({ error: 'Provide a URL or paste the new design HTML.' });
  const tagged = autotag(html, baseUrl);
  const old = s.pages[slug];
  let oldOriginal = {};                                       // baseline = the page's content at first ingest (version 0)
  try { const v0 = JSON.parse(readFileSync(join(versionsDir(name), '0.json'), 'utf8')); oldOriginal = v0.state?.pages?.[slug]?.content || {}; } catch {}
  const { content, carried, dropped } = resyncContent(old.templateHtml, oldOriginal, old.content, tagged.templateHtml, tagged.content);
  s.pages[slug] = { templateHtml: tagged.templateHtml, schema: tagged.schema, content, sections: tagged.sections, collections: tagged.collections };
  writePage(name, slug, s.pages[slug]);
  saveVersion(name, `re-synced "${slug}" to a new design · kept ${carried.length} client edit${carried.length !== 1 ? 's' : ''}${dropped.length ? ` · ${dropped.length} to review` : ''}`);
  auditLog(name, actorOf(req), { action: 'resync', page: slug, kept: carried.length, dropped: dropped.length });
  const vercel = await deployVercel(name);
  res.json({ ok: true, page: slug, kept: carried.length, dropped, vercel });
});

app.get('/api/state', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const a = pageState(s, slug);
  const groups = {};
  for (const [id, d] of Object.entries(a.schema)) (groups[d.group] ||= []).push({ id, ...d, value: a.content[id] });
  // overlay any pending seo:* values so the panel reflects unsaved edits
  const seo = effectiveSeo(a.templateHtml, a.content);
  res.json({ plannerMode: plannerMode(), site: get(req), page: slug, groups, fieldCount: Object.keys(a.schema).length, collections: a.collections, dirty: !!s.draft[slug], seo, seoFields: SEO_FIELDS, styleSpec: STYLE_SPEC, sections: sectionList(a.templateHtml) });
});

app.post('/api/plan', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const a = pageState(s, pageOf(req, s));
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'Empty command.' });
  const { summary, changeset } = await plan(command, a.content, a.schema);
  const g = validate(changeset, a);
  res.json({ summary, plannerMode: plannerMode(), diff: g.diff, candidate: g.candidate, ok: g.ok, errors: g.errors, warnings: g.warnings });
});

app.post('/api/render', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const a = pageState(s, pageOf(req, s));
  const merged = req.body?.content && typeof req.body.content === 'object' ? { ...a.content, ...req.body.content } : a.content;
  let html = withBase(render(a.templateHtml, a.schema, merged));
  if (req.query.edit) html = injectEditor(html, a.schema);
  res.type('html').send(html);
});

// add / remove a collection item on a page (staged in that page's draft)
app.post('/api/structure', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const { op, col, index } = req.body || {};
  const base = s.draft[slug] || { ...s.pages[slug], schema: { ...s.pages[slug].schema }, content: { ...s.pages[slug].content }, sections: [...s.pages[slug].sections] };
  const r = applyStructure(base, op, col, index);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    const $ = load(render(r.templateHtml, r.schema, r.content));
    for (const sel of base.sections) if ($(sel).length === 0) return res.status(400).json({ error: `Blocked: "${sel}" would disappear.` });
  } catch (e) { return res.status(400).json({ error: `Could not apply safely (${e.message}).` }); }
  s.draft[slug] = { templateHtml: r.templateHtml, schema: r.schema, sections: base.sections, collections: base.collections, content: r.content };
  writeDraft(get(req), slug, s.draft[slug]);
  res.json({ ok: true, message: r.message });
});

app.post('/api/discard', authWrite, (req, res) => { const s = need(req, res); if (!s) return; clearDrafts(get(req)); res.json({ ok: true }); });

const isEditable = (base, id) => base.schema[id] || id.startsWith('seo:') || id.startsWith('style:') || id.startsWith('link:');
// Stage browser edits into the persisted per-page draft (survives reload) — does NOT go live.
function stageDraft(name, pendingByPage) {
  const s = sites[name];
  const touched = new Set([...Object.keys(s.draft), ...Object.keys(pendingByPage).filter((sl) => Object.keys(pendingByPage[sl] || {}).length)]);
  if (!touched.size) return { ok: true, saved: 0 };
  let saved = 0;
  for (const slug of touched) {
    if (!s.pages[slug]) continue;
    const base = s.draft[slug] || s.pages[slug];
    const pend = pendingByPage[slug] || {};
    const changeset = Object.keys(pend).filter((id) => isEditable(base, id) && pend[id] !== base.content[id]).map((id) => ({ op: 'set', id, value: pend[id] }));
    if (!changeset.length && !s.draft[slug]) continue;
    let finalContent = base.content;
    if (changeset.length) {
      const g = validate(changeset, base);
      if (!g.ok) return { error: `Blocked on "${slug}"`, errors: g.errors };
      finalContent = g.candidate; saved += changeset.length;
    }
    s.draft[slug] = { templateHtml: base.templateHtml, schema: base.schema, sections: base.sections, collections: base.collections, content: finalContent };
    writeDraft(name, slug, s.draft[slug]);
  }
  return { ok: true, saved };
}
// Commit staged draft + pending edits → one immutable version (does NOT deploy — caller does).
function applyAndCommit(name, pendingByPage, actor) {
  const s = sites[name];
  const touched = new Set([...Object.keys(s.draft), ...Object.keys(pendingByPage).filter((sl) => Object.keys(pendingByPage[sl] || {}).length)]);
  if (!touched.size) return { error: 'Nothing to publish.' };
  let totalEdits = 0, structural = false;
  for (const slug of touched) {
    if (!s.pages[slug]) continue;
    const base = s.draft[slug] || s.pages[slug];
    if (s.draft[slug]) structural = true;
    const pend = pendingByPage[slug] || {};
    const changeset = Object.keys(pend).filter((id) => isEditable(base, id) && pend[id] !== base.content[id]).map((id) => ({ op: 'set', id, value: pend[id] }));
    let finalContent = base.content;
    if (changeset.length) {
      const g = validate(changeset, base);
      if (!g.ok) return { error: `Blocked on "${slug}"`, errors: g.errors };
      finalContent = g.candidate; totalEdits += changeset.length;
    }
    s.pages[slug] = { templateHtml: base.templateHtml, schema: base.schema, sections: base.sections, collections: base.collections, content: finalContent };
    writePage(name, slug, s.pages[slug]);
  }
  clearDrafts(name);
  const bits = [];
  if (totalEdits) bits.push(`${totalEdits} text edit${totalEdits > 1 ? 's' : ''}`);
  if (structural) bits.push('layout change');
  if (touched.size > 1) bits.push(`${touched.size} pages`);
  const summary = bits.join(' · ') || 'Published';
  saveVersion(name, summary);
  auditLog(name, actor, { action: 'publish', version: s.head, summary });
  return { ok: true, summary, totalEdits, head: s.head };
}
// ─── approval gate (client edits wait for owner sign-off before going live) ───
const reviewFile = (name) => join(siteDir(name), 'review.json');
const getReview = (name) => { const f = reviewFile(name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { pending: false }; };
const setReview = (name, obj) => writeFileSync(reviewFile(name), JSON.stringify(obj, null, 2));
const clearReview = (name) => rmSync(reviewFile(name), { force: true });

// Save: stage all current edits into a persisted draft — does NOT go live.
app.post('/api/save', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  const r = stageDraft(get(req), pendingByPage);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  if (!r.saved && !hasDraft(s)) return res.status(400).json({ error: 'Nothing to save.' });
  auditLog(get(req), actorOf(req), { action: 'save', saved: r.saved });
  res.json({ ok: true, saved: r.saved });
});

/* Stage the caller's edits as a draft and flag them for owner sign-off. Returns
   false once it has already answered `res` with an error. Shared by
   /api/submit-review and by /api/publish when a client is under the gate. */
function stageForReview(req, res, pendingByPage) {
  const name = get(req), s = sites[name];
  const r = stageDraft(name, pendingByPage);
  if (r.error) { res.status(400).json({ error: r.error, errors: r.errors }); return false; }
  if (!hasDraft(s)) { res.status(400).json({ error: 'Nothing to submit.' }); return false; }
  const note = String(req.body?.note || '').slice(0, 500);
  setReview(name, { pending: true, by: req.role || 'client', at: new Date().toISOString(), note });
  auditLog(name, actorOf(req), { action: 'submit', note });
  return true;
}
/* Is this request a client edit on a site whose owner must sign off first?
   The editor already routes such clients to submit-review, but that is UI only —
   this is what actually stops a hand-crafted request from skipping the queue. */
const gatedClient = (req, s) => req.role === 'client' && !!s.access?.requireApproval;

// Submit for review: a client stages edits + flags them for the owner to approve. Not live.
app.post('/api/submit-review', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  if (!stageForReview(req, res, pendingByPage)) return;
  res.json({ ok: true });
});
app.get('/api/review', authWrite, (req, res) => { const s = need(req, res); if (!s) return; res.json(getReview(get(req))); });
app.post('/api/review/approve', requireStaff, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const r = applyAndCommit(get(req), {}, actorOf(req));   // the staged draft holds the client's changes
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));
  auditLog(get(req), actorOf(req), { action: 'approve', version: s.head });
  const vercel = await deployVercel(get(req));
  res.json({ ok: true, head: r.head, vercel });
});
app.post('/api/review/reject', requireStaff, (req, res) => {
  const s = need(req, res); if (!s) return;
  const note = String(req.body?.note || '').slice(0, 500);
  if (req.body?.discard) clearDrafts(get(req));
  clearReview(get(req));
  auditLog(get(req), actorOf(req), { action: 'reject', note });
  res.json({ ok: true });
});

// Activity feed: the audit trail, newest first (owner only).
const readAudit = (name) => {
  const f = join(siteDir(name), 'audit.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
app.get('/api/audit', requireStaff, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const a = await resolveActor(req);
  let entries = readAudit(get(req)).reverse();
  // Editors see their own actions only; admins and owners see everything.
  if (!atLeast(a.role, 'admin')) entries = entries.filter((e) => e.actor?.id && e.actor.id === a.id);
  res.json({ entries: entries.slice(0, 200), scope: atLeast(a.role, 'admin') ? 'all' : 'self' });
});

/* Cross-site activity — "what did my team do this week", which the per-site log
   cannot answer. Admin and above, since it spans every client. */
app.get('/api/activity', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entries = [];
  for (const name of Object.keys(sites)) for (const e of readAudit(name)) entries.push({ ...e, site: name });
  entries.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  res.json({ entries: entries.slice(0, limit) });
});

// ─── forms: live-site submissions captured into an in-product inbox ───
const formsFile = (name) => join(siteDir(name), 'forms.json');
const getForms = (name) => { const f = formsFile(name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []; };
const saveForms = (name, arr) => writeFileSync(formsFile(name), JSON.stringify(arr, null, 2));
// NOTE: specific routes MUST be declared before the catch-all /api/forms/:site capture route.
app.get('/api/forms', authWrite, (req, res) => { const s = need(req, res); if (!s) return; res.json({ submissions: getForms(get(req)) }); });
app.post('/api/forms/read', authWrite, (req, res) => { const s = need(req, res); if (!s) return; saveForms(get(req), getForms(get(req)).map((x) => ({ ...x, read: true }))); res.json({ ok: true }); });
app.post('/api/forms/delete', authWrite, (req, res) => { const s = need(req, res); if (!s) return; saveForms(get(req), getForms(get(req)).filter((x) => x.id !== req.body?.id)); res.json({ ok: true }); });
app.options('/api/forms/:site', (req, res) => res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').end());
app.post('/api/forms/:site', (req, res) => {                 // PUBLIC — the live site posts here (CORS open)
  res.set('Access-Control-Allow-Origin', '*');
  const name = String(req.params.site).replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site' });
  const fields = {};
  for (const [k, v] of Object.entries(req.body || {})) { if (k !== '_page' && typeof v === 'string' && k.length < 60) fields[k.slice(0, 60)] = v.slice(0, 2000); }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Empty submission' });
  const arr = getForms(name);
  arr.unshift({ id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), at: new Date().toISOString(), page: String(req.body?._page || '').slice(0, 80), read: false, fields });
  saveForms(name, arr.slice(0, 500));
  res.json({ ok: true });
});

// Publish ALL staged edits across pages → one version → static deploy.
app.post('/api/publish', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  // Approval gate: a gated client never reaches the live site. Their edits stage
  // as a draft and queue for the owner instead of publishing.
  if (gatedClient(req, s)) {
    if (!stageForReview(req, res, pendingByPage)) return;
    return res.json({ ok: true, pendingReview: true });
  }
  const r = applyAndCommit(get(req), pendingByPage, actorOf(req));
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));                                   // an owner publish also clears any pending review
  const vercel = await deployVercel(get(req));             // push to the agency's Vercel if connected
  res.json({ ok: true, head: r.head, published: r.totalEdits, liveUrl: `/live/${get(req)}`, vercel });
});

app.get('/api/versions', authWrite, (req, res) => { const s = need(req, res); if (!s) return; res.json({ head: s.head, versions: s.versions }); });

app.post('/api/version/restore', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const seq = Number(req.body?.seq);
  if (!restoreVersion(get(req), seq)) return res.status(400).json({ error: `No version ${seq}.` });
  auditLog(get(req), actorOf(req), { action: 'restore', version: seq });
  res.json({ ok: true, head: s.head });
});
app.post('/api/rollback', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const idx = s.versions.findIndex((v) => v.seq === s.head);
  if (idx <= 0) return res.status(400).json({ error: 'Already at the earliest version.' });
  restoreVersion(get(req), s.versions[idx - 1].seq);
  res.json({ ok: true, head: s.head });
});

/* ───── PAGE MANAGEMENT (WordPress-style) — auto-versioned + deployed ───── */
app.post('/api/pages/add', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const fromUrl = String(req.body?.url || '').trim();

  // From a URL: capture a page that already exists on the live site, exactly as
  // ingest does — but slotted into this site rather than replacing it. This is how
  // a multi-page site gets its remaining pages, and how pages added to the real
  // site later get pulled in.
  let captured = null, title, slug;
  if (fromUrl) {
    // Capture-from-URL makes the SERVER fetch an address the caller chose. That
    // stays a staff tool — a client link must never be able to aim our fetcher.
    // Clients keep the blank/article templates below.
    if (!isStaff(req.role)) return res.status(401).json({ error: 'Only team members can capture pages from a URL.' });
    try { new URL(fromUrl); } catch { return res.status(400).json({ error: 'That does not look like a URL.' }); }
    let html;
    try { html = await fetchHtml(fromUrl); }
    catch (e) { return res.status(400).json({ error: `Could not fetch that URL — ${e.message}` }); }
    captured = autotag(html, fromUrl);
    slug = cleanSlug(req.body?.slug || slugFromUrl(fromUrl), `page-${s.order.length}`);
    title = String(req.body?.title || titleFromHtml(html, prettify(slug))).slice(0, 60);
  } else {
    title = String(req.body?.title || 'New Page').slice(0, 60);
    slug = cleanSlug(req.body?.slug || title, `page-${s.order.length}`);
  }
  slug = uniqueSlug(slug, s.pagesMeta);

  const template = req.body?.template || 'blank';
  const home = s.pages[s.home];
  if (captured) {
    s.pages[slug] = captured;
  } else if (template === 'blank' || template === 'article') {
    // Build a new page reusing the site's head/header/footer (instant native styling),
    // swapping <main> for a starter layout, then autotag so it's fully editable.
    const $ = load(home.templateHtml, { decodeEntities: false });
    $('[data-cms],[data-cms-img],[data-cms-item],[data-cms-collection]').each((_, el) => { for (const a of ['data-cms', 'data-cms-img', 'data-cms-item', 'data-cms-collection']) $(el).removeAttr(a); });
    if ($('head > title').length) $('head > title').text(`${title}`);
    const body = template === 'article'
      ? `<article style="max-width:760px;margin:0 auto;padding:80px 24px"><p style="font-family:monospace;font-size:13px;text-transform:uppercase;letter-spacing:.1em;opacity:.6">Article</p><h1 style="font-size:44px;line-height:1.1;letter-spacing:-.03em;margin:10px 0 8px">${title}</h1><p style="opacity:.6;font-size:14px;margin-bottom:34px">By Your Name · 5 min read</p><p style="font-size:17px;line-height:1.75;margin-bottom:20px">Write your opening paragraph here. Set the scene and tell the reader why this matters.</p><h2 style="font-size:26px;letter-spacing:-.02em;margin:34px 0 12px">A subheading</h2><p style="font-size:17px;line-height:1.75;margin-bottom:20px">Keep writing your article. Click any of this text to edit it, or describe changes in the chat.</p><p style="font-size:17px;line-height:1.75">Add as many paragraphs as you like.</p></article>`
      : `<section style="max-width:900px;margin:0 auto;padding:90px 24px"><h1 style="font-size:48px;line-height:1.08;letter-spacing:-.03em;margin:0 0 12px">${title}</h1><h2 style="font-size:21px;line-height:1.4;font-weight:500;opacity:.72;margin:0 0 24px;max-width:60ch">Add a subheading that tells visitors what this page is about.</h2><p style="font-size:17px;line-height:1.7;max-width:62ch;opacity:.85">This is your new page. Click any text to edit it, add sections, or describe what you want in the chat.</p></section>`;
    if ($('main').length) $('main').html(body); else $('body').append(`<main>${body}</main>`);
    const tagged = autotag($.html());
    s.pages[slug] = { templateHtml: tagged.templateHtml, schema: tagged.schema, content: tagged.content, sections: tagged.sections, collections: tagged.collections };
  } else {
    const src = s.pages[s.pages[req.body?.from] ? req.body.from : s.home]; // duplicate an existing page
    s.pages[slug] = { templateHtml: src.templateHtml, schema: { ...src.schema }, content: { ...src.content }, sections: [...src.sections], collections: [...src.collections] };
  }
  s.order.push(slug);
  s.pagesMeta[slug] = { title, path: `/${slug}` };
  writePage(get(req), slug, s.pages[slug]);
  writeCfg(get(req));
  saveVersion(get(req), captured ? `captured page "${title}" from ${fromUrl}` : `added page "${title}"`);
  res.json({
    ok: true, slug, title,
    fields: Object.keys(s.pages[slug].schema).length,
    captured: !!captured,
    liveUrl: `/live/${get(req)}/${slug}`,
  });
});

app.post('/api/pages/delete', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = req.body?.slug;
  if (!s.pages[slug]) return res.status(404).json({ error: 'No such page.' });
  if (slug === s.home) return res.status(400).json({ error: "Can't delete the home page (set another page as home first)." });
  if (s.order.length <= 1) return res.status(400).json({ error: "Can't delete the only page." });
  delete s.pages[slug]; delete s.pagesMeta[slug]; delete s.draft[slug];
  s.order = s.order.filter((x) => x !== slug);
  rmSync(pageDir(get(req), slug), { recursive: true, force: true });
  writeCfg(get(req));
  saveVersion(get(req), `deleted page "${slug}"`);
  res.json({ ok: true });
});

app.post('/api/pages/home', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = req.body?.slug;
  if (!s.pages[slug]) return res.status(404).json({ error: 'No such page.' });
  s.home = slug;
  s.order.forEach((sl) => { s.pagesMeta[sl].path = sl === slug ? '/' : `/${sl}`; });
  writeCfg(get(req));
  saveVersion(get(req), `set "${slug}" as home`);
  res.json({ ok: true });
});

/* ───── OWNER / ADMIN ───── */
app.post('/api/admin/handoff', requireAdmin, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const token = randomBytes(24).toString('base64url');
  s.access = { ...(s.access || {}), tokenHash: sha256(token), clientName: req.body?.clientName || null, customDomain: req.body?.customDomain || null, createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, actorOf(req), { action: 'handoff', client: s.access.clientName });
  res.json({ ok: true, clientLink: `/editor/?site=${name}&key=${token}`, liveUrl: `/live/${name}` });
});
// Owner sets a chosen PASSWORD for a site — the client types it into a login gate (never needs to be in the URL).
app.post('/api/admin/set-password', requireAdmin, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const pw = String(req.body?.password || '');
  if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  s.access = { ...(s.access || {}), tokenHash: sha256(pw), clientName: req.body?.clientName || s.access?.clientName || null, requireApproval: req.body?.requireApproval != null ? !!req.body.requireApproval : !!s.access?.requireApproval, mode: 'password', createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, actorOf(req), { action: 'set-password', client: s.access.clientName });
  res.json({ ok: true, loginLink: `/editor/?site=${name}`, liveUrl: `/live/${name}` });
});
// Toggle whether this client's changes need owner approval before going live.
app.post('/api/admin/approval', requireAdmin, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  if (!s.access) s.access = { createdAt: new Date().toISOString() };
  s.access.requireApproval = !!req.body?.requireApproval;
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  res.json({ ok: true, requireApproval: s.access.requireApproval });
});
// Image upload — client picks a file; we store it under the site and return a URL.
app.post('/api/upload', authWrite, (req, res) => {
  if (!sites[get(req)]) return res.status(404).json({ error: 'Unknown site.' });
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(req.body?.dataUrl || '');
  if (!m || !/^image\//.test(m[1])) return res.status(400).json({ error: 'Please choose an image file.' });
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' }[m[1]] || 'png';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 12MB).' });
  const dir = join(siteDir(get(req)), 'uploads');
  mkdirSync(dir, { recursive: true });
  const fn = createHash('sha256').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  writeFileSync(join(dir, fn), buf);
  res.json({ ok: true, url: `/u/${get(req)}/${fn}` });
});
app.get('/u/:name/:file', (req, res) => {
  const f = join(siteDir(req.params.name), 'uploads', req.params.file.replace(/[^a-z0-9_.-]/gi, ''));
  if (!existsSync(f)) return res.sendStatus(404);
  res.sendFile(f);
});

// AI settings — paste an API key in the console; never returns the raw key.
app.get('/api/admin/config', requireOwner, (_req, res) => {
  const c = getConfig(); const creds = aiCreds();
  res.json({ hasKey: !!creds.key, provider: creds.provider, model: c.model || creds.model, hasVercel: !!c.vercelToken, vercelAccount: c.vercelAccount || null, vercelTeam: c.vercelTeam || null });
});
app.post('/api/admin/config', requireOwner, async (req, res) => {
  const patch = {};
  if (typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()) patch.apiKey = req.body.apiKey.trim();
  if (req.body?.provider) patch.provider = req.body.provider;
  if (req.body?.model) patch.model = req.body.model;
  if (req.body?.clearKey) patch.apiKey = '';
  if (req.body?.vercelTeam !== undefined) patch.vercelTeam = req.body.vercelTeam || '';
  if (typeof req.body?.vercelToken === 'string' && req.body.vercelToken.trim()) {
    try { patch.vercelAccount = await vercelWhoami(req.body.vercelToken.trim(), req.body.vercelTeam); patch.vercelToken = req.body.vercelToken.trim(); }
    catch (e) { return res.status(400).json({ error: 'Vercel: ' + e.message }); }
  }
  if (req.body?.clearVercel) { patch.vercelToken = ''; patch.vercelAccount = ''; }
  setConfig(patch);
  res.json({ ok: true, provider: aiCreds().provider, vercelAccount: getConfig().vercelAccount || null });
});

/* ───── TEAM (owner only) ─────
   A member's key is shown exactly once, at creation or rotation — only its hash
   is kept, so it can never be read back, only replaced. */
app.get('/api/admin/team', requireOwner, async (_req, res) => {
  res.json({ members: (await listMembers()).map(publicMember), roles: ROLES });
});
app.post('/api/admin/team/add', requireOwner, async (req, res) => {
  try {
    const { member, key } = await addMember({ name: req.body?.name, email: req.body?.email, role: req.body?.role });
    res.json({ ok: true, member, key, warning: 'Copy this key now — it cannot be shown again.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/team/rotate', requireOwner, async (req, res) => {
  try {
    const { member, key } = await rotateKey(String(req.body?.id || ''));
    res.json({ ok: true, member, key, warning: 'Copy this key now — it cannot be shown again.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/team/revoke', requireOwner, async (req, res) => {
  try { res.json({ ok: true, member: await revokeMember(String(req.body?.id || '')) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/team/role', requireOwner, async (req, res) => {
  try { res.json({ ok: true, member: await setRole(String(req.body?.id || ''), String(req.body?.role || '')) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* Offboard a site entirely — content, versions, uploads, forms, access, and the
   database copy (the rm is mirrored). The one genuinely destructive admin action,
   so the exact name must be typed back. The client's live Vercel deployment is
   NOT touched; their site keeps serving until repointed. */
app.post('/api/admin/site-delete', requireAdmin, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name] && !brokenSites[name]) return res.status(404).json({ error: 'Unknown site.' });
  if (String(req.body?.confirm || '') !== name) return res.status(400).json({ error: 'Type the site name exactly to confirm deletion.' });
  rmSync(siteDir(name), { recursive: true, force: true });
  delete sites[name];
  delete brokenSites[name];
  console.log(`[admin] site "${name}" deleted by ${req.actor?.name || 'owner'}`);
  res.json({ ok: true });
});

// Link a site to a Vercel project + deploy on demand.
app.post('/api/admin/site-vercel', requireAdmin, async (req, res) => {
  const s = sites[String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '')]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const name = String(req.body.site).replace(/[^a-z0-9_-]/gi, '');
  s.vercel = { ...(s.vercel || {}), project: String(req.body?.project || '').trim() };
  writeCfg(name);
  if (req.body?.deploy) { const r = await deployVercel(name); return res.json({ ok: true, deploy: r }); }
  res.json({ ok: true, project: s.vercel.project });
});

app.post('/api/admin/export', requireStaff, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site.' });
  try { const out = join(ROOT, 'dist', name); const r = deployer.exportTo(siteDir(name), out); res.json({ ok: true, dir: out, files: r.files }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 4321;
const server = app.listen(PORT, () => {
  console.log(`AI CMS (multi-site · multi-page) on http://localhost:${PORT}/`);
  console.log(`  agency console : http://localhost:${PORT}/admin/?key=${ADMIN_KEY}`);
  console.log(`Sites: ${Object.keys(sites).join(', ') || '(none)'} | Planner: ${plannerMode()}`);
});

/* A redeploy sends SIGTERM. Queued mirror writes live only in this process, so
   drain them before exiting or the last edits never reach the database. */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    if (mirrorQueue.pending) console.log(`[shutdown] flushing ${mirrorQueue.pending} pending write(s) to the database…`);
    try { await flushMirror(); } catch {}
    try { await closeStore(); } catch {}
    process.exit(0);
  });
}
