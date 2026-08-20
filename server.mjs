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
import { store, initStore, hydrateToFs } from './lib/store.mjs';
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
import { randomBytes, createHash } from 'node:crypto';

const ADMIN_KEY = process.env.ADMIN_KEY || 'owner-dev';
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const ROOT = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(ROOT, 'sites');
mkdirSync(SITES_DIR, { recursive: true });

/* ── persistence mirror ──
   The filesystem stays the fast local working copy. When MongoDB is connected,
   every write/delete under sites/ is mirrored to the DB in real time, and a fresh
   host hydrates from the DB on boot — so the data lives in Mongo, portable across hosts. */
const relOf = (p) => { const s = String(p); if (!s.startsWith(ROOT)) return null; return s.slice(ROOT.length).replace(/^[/\\]/, '').replace(/\\/g, '/'); };
const mirrorable = (rel) => rel && rel.startsWith('sites/') && !rel.includes('/releases/');
function mirrorWrite(p) {
  if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return;
  (async () => { try {
    if (rel.endsWith('.json')) await store.putJSON(rel, JSON.parse(readFileSync(p, 'utf8')));
    else if (/\.(html|log|txt)$/.test(rel)) await store.putText(rel, readFileSync(p, 'utf8'));
    else await store.putBuf(rel, readFileSync(p));
  } catch (e) { console.error('[mirror] write', rel, e.message); } })();
}
function mirrorDel(p) { if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return; store.del(rel).catch((e) => console.error('[mirror] del', rel, e.message)); }
// mirror-aware drop-ins for the real fs calls (every existing call site uses these names unchanged)
function writeFileSync(p, data, opts) { _wfs(p, data, opts); mirrorWrite(p); }
function rmSync(p, opts) { _rm(p, opts); mirrorDel(p); }

const sites = {}; // name -> { pages:{slug:{templateHtml,schema,content,sections,collections}}, order, home, pagesMeta, draft:{slug:state}, versions, head, access }

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

function auditLog(name, entry) {
  const p = join(siteDir(name), 'audit.log');
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// boot
{
  const m = await initStore();                       // connect Mongo if MONGODB_URI is set
  if (m.mode === 'mongodb') {
    if (m.migrated) console.log(`MongoDB connected (db: ${m.db}) — migrated ${m.migrated} files from disk on first run.`);
    else { const n = await hydrateToFs(); console.log(`MongoDB connected (db: ${m.db}) — hydrated ${n} files from the database.`); }
  }
  for (const d of readdirSync(SITES_DIR, { withFileTypes: true })) if (d.isDirectory()) loadSite(d.name);
}

/* ───────────────────────────── app ───────────────────────────── */
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use((req, res, next) => {
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
const isOwner = (req) => providedKey(req) === ADMIN_KEY;
function authWrite(req, res, next) {
  const s = sites[get(req)];
  if (!s) return next();
  if (isOwner(req)) { req.role = 'owner'; return next(); }
  if (!s.access?.tokenHash) { req.role = 'owner'; return next(); }
  if (providedKey(req) && sha256(providedKey(req)) === s.access.tokenHash) { req.role = 'client'; return next(); }
  return res.status(401).json({ error: 'This site requires a valid editor link.' });
}
function requireOwner(req, res, next) { if (isOwner(req)) return next(); return res.status(401).json({ error: 'Owner key required.' }); }

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

app.get('/api/sites', (_req, res) => res.json({
  plannerMode: plannerMode(),
  sites: Object.keys(sites).map((name) => {
    const s = sites[name];
    return { name, pages: s.order.length, handedOff: !!s.access?.tokenHash, authMode: s.access?.mode || (s.access?.tokenHash ? 'link' : null), client: s.access?.clientName || null, requireApproval: !!s.access?.requireApproval, versions: s.versions.length, vercelProject: s.vercel?.project || null, vercelUrl: s.vercel?.lastUrl || null };
  }),
}));

// Who am I? owner (agency, sees all sites) vs client (one site, simple editor).
app.get('/api/me', (req, res) => {
  const s = sites[get(req)];
  const key = providedKey(req);
  let role = 'none';
  if (key === ADMIN_KEY) role = 'owner';
  else if (s && s.access?.tokenHash && key && sha256(key) === s.access.tokenHash) role = 'client';
  else if (s && !s.access?.tokenHash) role = 'owner'; // not handed off yet → dev/owner
  // 'locked' = the site has a password set but no/wrong key was given → show the login gate
  const locked = role === 'none' && !!(s && s.access?.tokenHash);
  res.json({ role, locked, hasAccess: !!(s && s.access?.tokenHash), requireApproval: !!(s && s.access?.requireApproval), clientName: s?.access?.clientName || null, site: get(req), plannerMode: plannerMode() });
});

app.get('/api/pages', (req, res) => {
  const s = need(req, res); if (!s) return;
  res.json({ order: s.order, home: s.home, pages: s.order.map((slug) => ({ slug, ...s.pagesMeta[slug], home: slug === s.home, dirty: !!s.draft[slug] })) });
});

app.post('/api/ingest', requireOwner, async (req, res) => {
  const name = String(req.body?.name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!name) return res.status(400).json({ error: 'Need a site name.' });
  let html = req.body?.html, baseUrl = req.body?.baseUrl;
  if (!html && req.body?.url) {                               // fetch the built site server-side
    try { const u = String(req.body.url); const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); html = await r.text(); baseUrl = baseUrl || u; }
    catch (e) { return res.status(400).json({ error: 'Could not fetch that URL — ' + e.message }); }
  }
  if (!html) return res.status(400).json({ error: 'Provide a URL or paste the page HTML.' });
  const { templateHtml, content, schema, sections, collections } = autotag(html, baseUrl);
  const dir = siteDir(name);
  rmSync(dir, { recursive: true, force: true }); // fresh site
  writePage(name, 'home', { templateHtml, content, schema, sections, collections });
  sites[name] = { pages: {}, order: ['home'], home: 'home', pagesMeta: { home: { title: req.body?.title || 'Home', path: '/' } }, draft: {}, versions: [], head: -1, access: null };
  writeCfg(name);
  loadSite(name);
  res.json({ ok: true, name, pages: 1, fields: Object.keys(schema).length, collections: collections.length });
});

// Re-sync: re-ingest a REDESIGNED template for an existing site WITHOUT losing the client's edits.
// Matches each edited slot to a slot in the new design by role + content, carries the value over.
app.post('/api/resync', requireOwner, async (req, res) => {
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
  auditLog(name, { role: 'owner', action: 'resync', page: slug, kept: carried.length, dropped: dropped.length });
  const vercel = await deployVercel(name);
  res.json({ ok: true, page: slug, kept: carried.length, dropped, vercel });
});

app.get('/api/state', (req, res) => {
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

app.post('/api/render', (req, res) => {
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
function applyAndCommit(name, pendingByPage, role) {
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
  auditLog(name, { role: role || 'owner', action: 'publish', version: s.head, summary });
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
  auditLog(get(req), { role: req.role || 'owner', action: 'save', saved: r.saved });
  res.json({ ok: true, saved: r.saved });
});

// Submit for review: a client stages edits + flags them for the owner to approve. Not live.
app.post('/api/submit-review', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  const r = stageDraft(get(req), pendingByPage);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  if (!hasDraft(s)) return res.status(400).json({ error: 'Nothing to submit.' });
  const note = String(req.body?.note || '').slice(0, 500);
  setReview(get(req), { pending: true, by: req.role || 'client', at: new Date().toISOString(), note });
  auditLog(get(req), { role: req.role || 'client', action: 'submit', note });
  res.json({ ok: true });
});
app.get('/api/review', (req, res) => { const s = need(req, res); if (!s) return; res.json(getReview(get(req))); });
app.post('/api/review/approve', requireOwner, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const r = applyAndCommit(get(req), {}, 'owner');   // the staged draft holds the client's changes
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));
  auditLog(get(req), { role: 'owner', action: 'approve', version: s.head });
  const vercel = await deployVercel(get(req));
  res.json({ ok: true, head: r.head, vercel });
});
app.post('/api/review/reject', requireOwner, (req, res) => {
  const s = need(req, res); if (!s) return;
  const note = String(req.body?.note || '').slice(0, 500);
  if (req.body?.discard) clearDrafts(get(req));
  clearReview(get(req));
  auditLog(get(req), { role: 'owner', action: 'reject', note });
  res.json({ ok: true });
});

// Activity feed: the audit trail, newest first (owner only).
app.get('/api/audit', requireOwner, (req, res) => {
  const s = need(req, res); if (!s) return;
  const f = join(siteDir(get(req)), 'audit.log');
  const lines = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, 200);
  res.json({ entries });
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
  const r = applyAndCommit(get(req), pendingByPage, req.role);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));                                   // an owner publish also clears any pending review
  const vercel = await deployVercel(get(req));             // push to the agency's Vercel if connected
  res.json({ ok: true, head: r.head, published: r.totalEdits, liveUrl: `/live/${get(req)}`, vercel });
});

app.get('/api/versions', (req, res) => { const s = need(req, res); if (!s) return; res.json({ head: s.head, versions: s.versions }); });

app.post('/api/version/restore', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const seq = Number(req.body?.seq);
  if (!restoreVersion(get(req), seq)) return res.status(400).json({ error: `No version ${seq}.` });
  auditLog(get(req), { role: req.role || 'owner', action: 'restore', version: seq });
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
app.post('/api/pages/add', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const title = String(req.body?.title || 'New Page').slice(0, 60);
  let slug = String(req.body?.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `page-${s.order.length}`;
  if (s.pages[slug]) slug = `${slug}-${s.order.length}`;
  const template = req.body?.template || 'blank';
  const home = s.pages[s.home];
  if (template === 'blank' || template === 'article') {
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
  saveVersion(get(req), `added page "${title}"`);
  res.json({ ok: true, slug, liveUrl: `/live/${get(req)}/${slug}` });
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
app.post('/api/admin/handoff', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const token = randomBytes(24).toString('base64url');
  s.access = { ...(s.access || {}), tokenHash: sha256(token), clientName: req.body?.clientName || null, customDomain: req.body?.customDomain || null, createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, { role: 'owner', action: 'handoff', client: s.access.clientName });
  res.json({ ok: true, clientLink: `/editor/?site=${name}&key=${token}`, liveUrl: `/live/${name}` });
});
// Owner sets a chosen PASSWORD for a site — the client types it into a login gate (never needs to be in the URL).
app.post('/api/admin/set-password', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const pw = String(req.body?.password || '');
  if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  s.access = { ...(s.access || {}), tokenHash: sha256(pw), clientName: req.body?.clientName || s.access?.clientName || null, requireApproval: req.body?.requireApproval != null ? !!req.body.requireApproval : !!s.access?.requireApproval, mode: 'password', createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, { role: 'owner', action: 'set-password', client: s.access.clientName });
  res.json({ ok: true, loginLink: `/editor/?site=${name}`, liveUrl: `/live/${name}` });
});
// Toggle whether this client's changes need owner approval before going live.
app.post('/api/admin/approval', requireOwner, (req, res) => {
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

// Link a site to a Vercel project + deploy on demand.
app.post('/api/admin/site-vercel', requireOwner, async (req, res) => {
  const s = sites[String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '')]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const name = String(req.body.site).replace(/[^a-z0-9_-]/gi, '');
  s.vercel = { ...(s.vercel || {}), project: String(req.body?.project || '').trim() };
  writeCfg(name);
  if (req.body?.deploy) { const r = await deployVercel(name); return res.json({ ok: true, deploy: r }); }
  res.json({ ok: true, project: s.vercel.project });
});

app.post('/api/admin/export', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site.' });
  try { const out = join(ROOT, 'dist', name); const r = deployer.exportTo(siteDir(name), out); res.json({ ok: true, dir: out, files: r.files }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  console.log(`AI CMS (multi-site · multi-page) on http://localhost:${PORT}/`);
  console.log(`  agency console : http://localhost:${PORT}/admin/?key=${ADMIN_KEY}`);
  console.log(`Sites: ${Object.keys(sites).join(', ') || '(none)'} | Planner: ${plannerMode()}`);
});
