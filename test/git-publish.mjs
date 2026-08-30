/**
 * git-publish.mjs — publishing an edit into the site's repository.
 *
 * The whole point of the git-backed model is that the CMS cannot break the
 * site, so these check the refusals as hard as the successes: an edit is
 * either committed correctly or not committed at all, and the client is told
 * which. A fake GitHub stands in for the network, so the logic is exercised
 * exactly as it will run.
 *
 *   node test/git-publish.mjs
 */
import { setJsonValue, locateValue } from '../lib/json-edit.mjs';
import { createGitHub, publishEdits, PublishRefused } from '../lib/git-publish.mjs';

let pass = 0, fail = 0;
const chk = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}`); console.log(`        expected ${e}`); console.log(`        actual   ${a}`); fail++; }
};
const rejects = async (name, fn, needle) => {
  try { await fn(); console.log(`  FAIL  ${name}`); console.log('        expected a refusal, but it went ahead'); fail++; }
  catch (e) {
    if (String(e.message).includes(needle)) { console.log(`  PASS  ${name}`); pass++; }
    else { console.log(`  FAIL  ${name}`); console.log(`        message lacked ${JSON.stringify(needle)}: ${e.message}`); fail++; }
  }
};

/* ─────────────────────────── the file editor ─────────────────────────── */

// Deliberately formatted the way a person formats a content file: blank lines
// between sections, mixed nesting. All of it must survive an edit.
const FILE = `{
  "seo": {
    "title": "Gutter Cleaning in Cincinnati",
    "noindex": false
  },

  "hero": {
    "heading": "Clean Gutters, No Ladder",
    "highlights": ["Two cleanings a year", "Photo proof", "Insured"],
    "primaryCta": { "label": "Get A Quote", "href": "/get-a-quote" }
  },

  "counts": [1, 2, 3]
}
`;

console.log('\n── one value changes, the file does not ──');
{
  const after = setJsonValue(FILE, 'hero.heading', 'Gutters, Handled');
  chk('the new value is there', JSON.parse(after).hero.heading, 'Gutters, Handled');
  chk('exactly one line differs', diffLines(FILE, after), 1);
  chk('blank lines survive', (after.match(/\n\n/g) || []).length, (FILE.match(/\n\n/g) || []).length);
  chk('the trailing newline survives', after.endsWith('}\n'), true);
  chk('key order is untouched', Object.keys(JSON.parse(after)), ['seo', 'hero', 'counts']);
  chk('nothing else changed value', JSON.parse(after).seo, JSON.parse(FILE).seo);
}

console.log('\n── every kind of path ──');
{
  chk('nested object', JSON.parse(setJsonValue(FILE, 'seo.title', 'X')).seo.title, 'X');
  chk('array member', JSON.parse(setJsonValue(FILE, 'hero.highlights.1', 'X')).hero.highlights, ['Two cleanings a year', 'X', 'Insured']);
  chk('deeper object', JSON.parse(setJsonValue(FILE, 'hero.primaryCta.label', 'Book')).hero.primaryCta.label, 'Book');
  chk('a sibling array is untouched', JSON.parse(setJsonValue(FILE, 'hero.highlights.0', 'X')).counts, [1, 2, 3]);
}

console.log('\n── text that would break a naive editor ──');
{
  // A value containing a brace, a quote and a backslash: a scanner that counts
  // delimiters without understanding escapes lands in the wrong place, and the
  // wrong copy gets rewritten with no error.
  const tricky = `{ "a": "he said \\"hi\\" }", "b": "keep me" }`;
  const out = setJsonValue(tricky, 'a', 'new');
  chk('escapes do not confuse the scan', JSON.parse(out), { a: 'new', b: 'keep me' });
  chk('quotes in the new value are escaped', JSON.parse(setJsonValue(tricky, 'b', 'say "hi"')).b, 'say "hi"');
  chk('newlines in the new value are escaped', JSON.parse(setJsonValue(tricky, 'b', 'a\nb')).b, 'a\nb');
  chk('a unicode value round-trips', JSON.parse(setJsonValue(tricky, 'b', 'café — 100% ✓')).b, 'café — 100% ✓');
}

console.log('\n── a path the file does not have is refused, never created ──');
{
  chk('an absent path locates as null', locateValue(FILE, 'hero.nope'), null);
  try { setJsonValue(FILE, 'hero.nope', 'x'); console.log('  FAIL  refuses an unknown field'); fail++; }
  catch (e) { chk('refuses an unknown field', e.message.includes('not in this content file'), true); }
}

/* ─────────────────────────── the publish ─────────────────────────── */

/** An in-memory GitHub: one branch, a few files, and a real fast-forward check. */
function fakeGitHub({ files, failRefTimes = 0 }) {
  const state = { files: { ...files }, head: 'sha-head', tree: 'sha-tree', commits: [], blobs: {}, trees: {}, refFails: failRefTimes };
  const json = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace('https://api.github.com', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (!String(opts.headers?.Authorization || '').startsWith('Bearer ')) return json({ message: 'Bad credentials' }, 401);

    if (/\/git\/ref\/heads\//.test(path)) return json({ object: { sha: state.head } });
    if (/\/git\/commits\/sha-/.test(path)) return json({ tree: { sha: state.tree } });
    if (/\/contents\//.test(path)) {
      const p = decodeURIComponent(path.split('/contents/')[1].split('?')[0]);
      if (!(p in state.files)) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(state.files[p], 'utf8').toString('base64'), encoding: 'base64', sha: `blob-${p}` });
    }
    if (path.endsWith('/git/blobs')) {
      const sha = `blob-${Object.keys(state.blobs).length}`;
      state.blobs[sha] = body.content;
      return json({ sha });
    }
    if (path.endsWith('/git/trees')) {
      const sha = `tree-${Object.keys(state.trees).length}`;
      state.trees[sha] = body.tree;
      return json({ sha });
    }
    if (path.endsWith('/git/commits')) {
      const sha = `commit-${state.commits.length}`;
      state.commits.push({ sha, message: body.message, tree: body.tree, parents: body.parents, author: body.author });
      return json({ sha });
    }
    if (/\/git\/refs\/heads\//.test(path)) {
      if (state.refFails > 0) { state.refFails--; return json({ message: 'Update is not a fast forward' }, 422); }
      // Apply the commit, the way a real push would.
      for (const entry of state.trees[state.commits.at(-1).tree]) state.files[entry.path] = state.blobs[entry.sha];
      state.head = body.sha; state.tree = state.commits.at(-1).tree;
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `unexpected ${path}` }, 500);
  };
  return { state, gh: createGitHub({ token: 'github_pat_test', repo: 'acme/site', branch: 'main', fetchImpl }) };
}

const CONTENT = { 'src/content/pages/home.json': FILE, 'src/content/quote/get-a-quote.json': `{\n  "pageIntro": { "heading": "Get A Quote" }\n}\n` };

console.log('\n── an edit becomes a commit ──');
{
  const { state, gh } = fakeGitHub({ files: CONTENT });
  const r = await publishEdits({ gh, message: 'Update hero heading', author: { name: 'CMS', email: 'cms@x.test' },
    edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Gutters, Handled' }] });
  chk('one file changed', r.changed, 1);
  chk('the commit is reported back', typeof r.commit.sha, 'string');
  chk('the branch moved to it', state.head, r.commit.sha);
  chk('the repo now holds the new copy', JSON.parse(state.files['src/content/pages/home.json']).hero.heading, 'Gutters, Handled');
  chk('and still holds everything else', JSON.parse(state.files['src/content/pages/home.json']).counts, [1, 2, 3]);
  chk('formatting survived the round trip', diffLines(FILE, state.files['src/content/pages/home.json']), 1);
  chk('the message is the one we gave', state.commits[0].message, 'Update hero heading');
}

console.log('\n── several files, still ONE commit ──');
{
  // Two commits would mean two builds and a window where the site is half
  // updated — the client sees one of their two changes live.
  const { state, gh } = fakeGitHub({ files: CONTENT });
  const r = await publishEdits({ gh, message: 'Two files',
    edits: [
      { source: 'pages/home.json', path: 'hero.heading', value: 'A' },
      { source: 'pages/home.json', path: 'seo.title', value: 'B' },
      { source: 'quote/get-a-quote.json', path: 'pageIntro.heading', value: 'C' },
    ] });
  chk('two files written', r.changed, 2);
  chk('in a single commit', state.commits.length, 1);
  chk('home has both of its edits', [JSON.parse(state.files['src/content/pages/home.json']).hero.heading,
    JSON.parse(state.files['src/content/pages/home.json']).seo.title], ['A', 'B']);
  chk('the quote page has its own', JSON.parse(state.files['src/content/quote/get-a-quote.json']).pageIntro.heading, 'C');
}

console.log('\n── publishing what the repo already says is not a commit ──');
{
  // An empty commit still triggers a build and a deployment. Re-publishing an
  // unchanged page must cost nothing.
  const { state, gh } = fakeGitHub({ files: CONTENT });
  const r = await publishEdits({ gh, message: 'No change',
    edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Clean Gutters, No Ladder' }] });
  chk('nothing changed', r.changed, 0);
  chk('no commit was made', state.commits.length, 0);
  chk('no commit reported', r.commit, undefined);
}

console.log('\n── edits that must be refused rather than guessed at ──');
{
  const { state, gh } = fakeGitHub({ files: CONTENT });
  const bad = (edits) => () => publishEdits({ gh, message: 'x', edits });
  await rejects('a field the file no longer has', bad([{ source: 'pages/home.json', path: 'hero.gone', value: 'x' }]), 'no longer part of');
  await rejects('a field that is not text', bad([{ source: 'pages/home.json', path: 'hero.highlights', value: 'x' }]), 'not text');
  await rejects('a content file that was deleted', bad([{ source: 'pages/nope.json', path: 'a', value: 'x' }]), 'not in the repository');
  await rejects('an edit with no file', bad([{ path: 'a', value: 'x' }]), 'which content file');
  await rejects('a value that is not text', bad([{ source: 'pages/home.json', path: 'seo.title', value: 42 }]), 'cannot be edited here');
  chk('and none of them committed anything', state.commits.length, 0);
}

console.log('\n── copy changed in the repo is not silently overwritten ──');
{
  // A developer edits the headline in the repo while a client has the editor
  // open. Winning that race silently throws the developer's work away.
  const { state, gh } = fakeGitHub({ files: CONTENT });
  await rejects('the stale edit is refused',
    () => publishEdits({ gh, message: 'x', edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Mine', was: 'What the CMS saw earlier' }] }),
    'changed in the repository since this edit began');
  chk('the repo is untouched', JSON.parse(state.files['src/content/pages/home.json']).hero.heading, 'Clean Gutters, No Ladder');
  chk('nothing was committed', state.commits.length, 0);

  const ok = await publishEdits({ gh, message: 'x',
    edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Mine', was: 'Clean Gutters, No Ladder' }] });
  chk('an edit that matches goes through', ok.changed, 1);

  // Whitespace differs freely between the rendered page and the file, so the
  // check must not fail on it.
  const { gh: gh2 } = fakeGitHub({ files: CONTENT });
  chk('collapsed whitespace still matches',
    (await publishEdits({ gh: gh2, message: 'x', edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'New', was: '  Clean Gutters,\n  No Ladder ' }] })).changed, 1);
}

console.log('\n── someone else pushes mid-publish ──');
{
  const { state, gh } = fakeGitHub({ files: CONTENT, failRefTimes: 1 });
  const r = await publishEdits({ gh, message: 'Retry me', edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Z' }] });
  chk('the publish retries against the new head', r.changed, 1);
  chk('and lands', JSON.parse(state.files['src/content/pages/home.json']).hero.heading, 'Z');
}
{
  // Something is pushing continuously. Looping forever is worse than stopping
  // and telling a person.
  const { gh } = fakeGitHub({ files: CONTENT, failRefTimes: 5 });
  await rejects('it gives up after one retry',
    () => publishEdits({ gh, message: 'x', edits: [{ source: 'pages/home.json', path: 'hero.heading', value: 'Z' }] }),
    'not a fast forward');
}

console.log('\n── the token never reaches an error message ──');
{
  const { gh } = fakeGitHub({ files: {} });
  try { await gh.getFile('src/content/pages/home.json', 'sha-head'); }
  catch (e) { chk('the failure says what, not who', e.message.includes('github_pat_test'), false); }
  const bad = createGitHub({ token: 'github_pat_secret', repo: 'a/b', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"Bad credentials"}' }) });
  try { await bad.head(); } catch (e) { chk('nor on a bad token', e.message, 'GitHub: Bad credentials (GET /repos/a/b/git/ref/heads/main)'); }
}

console.log('\n── refusing a repo we cannot address ──');
{
  try { createGitHub({ token: 't', repo: 'justaname' }); console.log('  FAIL  refuses a repo without an owner'); fail++; }
  catch (e) { chk('refuses a repo without an owner', e.message.includes('owner/name'), true); }
  try { createGitHub({ token: '', repo: 'a/b' }); console.log('  FAIL  refuses a missing token'); fail++; }
  catch (e) { chk('refuses a missing token', e.message.includes('No GitHub token'), true); }
}

function diffLines(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail > 0 ? 1 : 0);
