/**
 * deploy.mjs — the deploy seam. Publishing = render a static bundle, STAGE it
 * immutably (keyed by version), then ATOMICALLY activate it (flip one pointer).
 * The live site is just "read pointer → serve that immutable release", so it can
 * never half-deploy and rollback is an instant pointer flip.
 *
 * LocalAdapter implements this on disk today. A CloudflareAdapter /
 * VercelAdapter would implement the SAME interface (stage = upload bundle,
 * activate = re-alias the production domain) with zero pipeline changes.
 *
 *   interface DeployAdapter {
 *     stage(siteDir, versionId, files)  // write release, NO cutover
 *     activate(siteDir, versionId)       // atomic pointer flip → live
 *     current(siteDir)                   // active versionId or null
 *     exportTo(siteDir, destDir)         // standalone static export (eject)
 *   }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class LocalAdapter {
  releasesDir(siteDir) { return join(siteDir, 'releases'); }

  // files: [{ path, content }]  — path relative to the release root
  stage(siteDir, versionId, files) {
    const dir = join(this.releasesDir(siteDir), String(versionId));
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const dest = join(dir, f.path);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, f.content);
    }
    return { releaseRef: String(versionId), path: dir };
  }

  // The ONLY "go live" step — atomic single-pointer write.
  activate(siteDir, versionId) {
    mkdirSync(this.releasesDir(siteDir), { recursive: true });
    writeFileSync(join(this.releasesDir(siteDir), 'current.json'), JSON.stringify({ versionId: String(versionId), at: new Date().toISOString() }));
  }

  current(siteDir) {
    const p = join(this.releasesDir(siteDir), 'current.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')).versionId;
  }

  // Serve a file from the active release (index.html, or <slug>.html for a page).
  liveHtml(siteDir, file = 'index.html') {
    const v = this.current(siteDir);
    if (v == null) return null;
    const p = join(this.releasesDir(siteDir), String(v), file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  hasRelease(siteDir, versionId) {
    return existsSync(join(this.releasesDir(siteDir), String(versionId), 'index.html'));
  }

  // Eject: copy the active release + local assets into a standalone folder the
  // agency can hand over or `vercel deploy`.
  exportTo(siteDir, destDir) {
    const v = this.current(siteDir);
    if (v == null) throw new Error('Nothing published to export.');
    mkdirSync(destDir, { recursive: true });
    cpSync(join(this.releasesDir(siteDir), String(v)), destDir, { recursive: true });
    const assets = join(siteDir, '..', '..', 'site', 'assets'); // legacy local assets (northline)
    if (existsSync(assets)) cpSync(assets, join(destDir, 'assets'), { recursive: true });
    return { destDir, files: readdirSync(destDir) };
  }
}

export const deployer = new LocalAdapter();

/**
 * Push a built site to the agency's Vercel as a new production deployment.
 * files = [{ file, data, encoding? }]. No Git, no build step — the client's
 * site updates in seconds.
 *
 *   Files are uploaded by CONTENT HASH first, then the deployment references
 *   them by sha. Two reasons this matters once a bundle carries a real build:
 *     · a whole build output runs to tens of MB, which is not something to put
 *       in one JSON request body
 *     · Vercel already has any blob whose sha it has seen, so the unchanged
 *       parts — the function bundle, every image — upload once and are skipped
 *       on every later publish. Editing a headline then re-publishes in seconds.
 *
 *   https://vercel.com/docs/rest-api/endpoints/deployments
 */
const VERCEL_API = 'https://api.vercel.com';
const qs = (teamId) => (teamId ? `?teamId=${encodeURIComponent(teamId)}` : '');

/** Upload one blob. Vercel de-duplicates by digest, so repeats are cheap. */
async function uploadFile(token, teamId, buf) {
  const sha = createHash('sha1').update(buf).digest('hex');
  const res = await fetch(`${VERCEL_API}/v2/files${qs(teamId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'x-vercel-digest': sha,
      'Content-Length': String(buf.length),
    },
    body: buf,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json())?.error?.message || detail; } catch {}
    throw new Error(`upload failed (${detail})`);
  }
  return { sha, size: buf.length };
}

/** Run tasks with bounded concurrency, preserving order. */
async function inParallel(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function vercelDeploy({ token, teamId, project, files, onProgress }) {
  if (!token) throw new Error('No Vercel token connected.');
  if (!project) throw new Error('This site is not linked to a Vercel project.');

  const blobs = files.map((f) => ({
    file: f.file,
    buf: Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), f.encoding === 'base64' ? 'base64' : 'utf8'),
  }));

  let done = 0;
  const uploaded = await inParallel(blobs, 8, async (b) => {
    const r = await uploadFile(token, teamId, b.buf);
    if (onProgress) onProgress(++done, blobs.length);
    return { file: b.file, sha: r.sha, size: r.size };
  });

  const res = await fetch(`${VERCEL_API}/v13/deployments${qs(teamId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: project,
      target: 'production',
      // No framework and no build step: whatever the bundle contains is what
      // ships, including a Build Output config.json and functions/ if present.
      projectSettings: { framework: null },
      files: uploaded,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `Vercel error ${res.status}`);
  return { id: j.id, url: j.url ? `https://${j.url}` : null, alias: (j.alias && j.alias[0]) || null, files: uploaded.length };
}

/** Validate a Vercel token (and resolve the account name). */
export async function vercelWhoami(token, teamId) {
  const res = await fetch('https://api.vercel.com/v2/user', { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || 'Invalid token');
  return j.user?.username || j.user?.email || 'connected';
}
