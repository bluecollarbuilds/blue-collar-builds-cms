/**
 * git-publish.mjs — publishing an edit by committing it to the site's repo.
 *
 *   THE MODEL
 *   The CMS does not build or deploy anything. It writes the client's words
 *   into the JSON the site is built from, commits that, and stops. The host
 *   sees the commit, runs the site's real build, and ships it. That is why a
 *   published edit cannot delete a redirect, strip a stylesheet, or break the
 *   quote form: the CMS never had a chance to. The build that goes live is the
 *   same build a developer would get from a clean clone.
 *
 *   WHAT THIS GUARANTEES
 *     · one commit per publish, however many files an edit touches, so the
 *       site builds once and never from a half-applied change
 *     · the file's formatting survives — see json-edit.mjs
 *     · a field changed in the repo since the CMS last read it is reported as a
 *       conflict rather than silently overwritten
 *     · every write is verified against a parsed round-trip before it is sent
 */
import { setJsonValue } from './json-edit.mjs';
import { getField, setField } from './bind.mjs';

const API = 'https://api.github.com';

/**
 * A thin client for one repository. `fetchImpl` is injectable so the publish
 * logic can be tested without a network.
 */
export function createGitHub({ token, repo, branch = 'main', fetchImpl = fetch }) {
  if (!token) throw new Error('No GitHub token for this site.');
  if (!repo || !repo.includes('/')) throw new Error(`"${repo}" is not an owner/name repository.`);

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'blue-collar-builds-cms',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      // Never let a token reach a log or a client. The path is enough to debug.
      const detail = json?.message || `HTTP ${res.status}`;
      const err = new Error(`GitHub: ${detail} (${method} ${path})`);
      err.status = res.status;
      err.githubMessage = json?.message || '';
      throw err;
    }
    return json;
  }

  return {
    repo,
    branch,

    /** The commit the branch currently points at, and its tree. */
    async head() {
      const ref = await call(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      const commit = await call(`/repos/${repo}/git/commits/${ref.object.sha}`);
      return { sha: ref.object.sha, treeSha: commit.tree.sha };
    },

    /** A text file's contents at a given commit. */
    async getFile(path, ref) {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const r = await call(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`);
      if (Array.isArray(r)) throw new Error(`${path} is a directory, not a content file.`);
      return { text: Buffer.from(r.content || '', r.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'), sha: r.sha };
    },

    /**
     * One commit carrying every changed file, then move the branch to it.
     * The ref update is NOT forced: if someone else pushed while we worked,
     * GitHub rejects it and the caller retries against the new head rather
     * than overwriting whatever they did.
     */
    async commit({ files, message, author, parentSha, baseTreeSha }) {
      const blobs = [];
      for (const f of files) {
        const blob = await call(`/repos/${repo}/git/blobs`, { method: 'POST', body: { content: f.text, encoding: 'utf-8' } });
        blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const tree = await call(`/repos/${repo}/git/trees`, { method: 'POST', body: { base_tree: baseTreeSha, tree: blobs } });
      const commit = await call(`/repos/${repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: [parentSha], ...(author ? { author, committer: author } : {}) },
      });
      await call(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false },
      });
      return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}` };
    },
  };
}

/** A publish that could not go ahead, with enough detail to tell a person why. */
export class PublishRefused extends Error {
  constructor(message, problems) { super(message); this.name = 'PublishRefused'; this.problems = problems; }
}

/**
 * Apply `edits` to the repository as a single commit.
 *
 * edits: [{ source, path, value, was? }]
 *   source — content file, relative to contentRoot ("pages/home.json")
 *   path   — field within it ("hero.heading")
 *   value  — the new text
 *   was    — what the CMS believed the field held. Supplied, a field that has
 *            since changed in the repo is refused instead of overwritten: the
 *            client is editing copy that no longer exists, and silently winning
 *            that race throws away whoever changed it.
 *
 * Returns { commit, files, changed } — or { changed: 0 } with no commit when
 * every edit already matches what the repo holds, which is the common case for
 * a re-publish and must not create an empty commit that triggers a build.
 */
export async function publishEdits({ gh, edits, message, author, contentRoot = 'src/content/', attempt = 0 }) {
  if (!edits?.length) return { changed: 0, files: [] };

  const head = await gh.head();
  const bySource = new Map();
  for (const e of edits) {
    if (!e.source) throw new PublishRefused('An edit did not say which content file it belongs to.', [e]);
    if (typeof e.value !== 'string') throw new PublishRefused(`"${e.path}" is not text and cannot be edited here.`, [e]);
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }

  const files = [];
  const problems = [];

  for (const [source, group] of bySource) {
    const path = contentRoot + source;
    let file;
    try { file = await gh.getFile(path, head.sha); }
    catch (err) {
      problems.push({ kind: 'missing-file', source, detail: err.githubMessage || err.message });
      continue;
    }

    let text = file.text;
    let object;
    try { object = JSON.parse(text); }
    catch (err) { problems.push({ kind: 'unreadable-file', source, detail: err.message }); continue; }

    let touched = 0;
    for (const e of group) {
      const current = getField(object, e.path);
      if (current === undefined) { problems.push({ kind: 'missing-field', ...e }); continue; }
      if (typeof current !== 'string') { problems.push({ kind: 'not-text', ...e, found: typeof current }); continue; }
      // Someone edited this field in the repo after the CMS read it.
      if (e.was !== undefined && collapse(e.was) !== collapse(current)) {
        problems.push({ kind: 'changed-in-repo', ...e, nowHolds: current });
        continue;
      }
      if (current === e.value) continue;                    // already says this

      // setField enforces the shape; setJsonValue does the surgical text edit.
      object = setField(object, e.path, e.value);
      text = setJsonValue(text, e.path, e.value);
      touched++;
    }

    if (!touched) continue;

    // Belt and braces: the text we are about to commit must parse back to
    // exactly the object we intended. A surgical edit that landed in the wrong
    // span would otherwise reach the client's repository.
    let roundTrip;
    try { roundTrip = JSON.parse(text); }
    catch (err) { problems.push({ kind: 'write-corrupted-file', source, detail: err.message }); continue; }
    if (JSON.stringify(roundTrip) !== JSON.stringify(object)) {
      problems.push({ kind: 'write-mismatch', source });
      continue;
    }
    files.push({ path, text });
  }

  if (problems.length) {
    throw new PublishRefused(
      problems.length === 1 ? describe(problems[0]) : `${problems.length} edits could not be published.`,
      problems
    );
  }
  if (!files.length) return { changed: 0, files: [] };

  try {
    const commit = await gh.commit({
      files, message, author, parentSha: head.sha, baseTreeSha: head.treeSha,
    });
    return { changed: files.length, files: files.map((f) => f.path), commit };
  } catch (err) {
    // Someone pushed between our read and our write. Re-read and apply again —
    // once. A second failure means something is pushing continuously and a
    // person should look rather than the CMS looping.
    const raced = err.status === 422 || /not a fast forward|is at (?!.*$)/i.test(err.githubMessage || '');
    if (raced && attempt === 0) {
      return publishEdits({ gh, edits, message, author, contentRoot, attempt: 1 });
    }
    throw err;
  }
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Plain language for the one-problem case, which is most of them. */
function describe(p) {
  switch (p.kind) {
    case 'missing-file': return `The content file ${p.source} is not in the repository any more.`;
    case 'unreadable-file': return `${p.source} is not valid JSON, so nothing can be written to it.`;
    case 'missing-field': return `"${p.path}" is no longer part of ${p.source}.`;
    case 'not-text': return `"${p.path}" holds a ${p.found}, not text.`;
    case 'changed-in-repo': return `"${p.path}" was changed in the repository since this edit began. Re-sync the site and make the change again.`;
    case 'write-corrupted-file': return `Writing to ${p.source} would have produced invalid JSON, so nothing was published.`;
    case 'write-mismatch': return `A write to ${p.source} did not land where it should have, so nothing was published.`;
    default: return 'This edit could not be published.';
  }
}
