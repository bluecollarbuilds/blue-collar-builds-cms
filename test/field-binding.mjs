/**
 * field-binding.mjs — the guarantee that an edit lands in the field the client
 * actually clicked.
 *
 * Being wrong here is not a cosmetic bug: it silently rewrites the wrong copy in
 * a client's repository. So these cover the cases that broke text matching —
 * a heading split into several nodes, the same sentence appearing twice, a
 * bound element nested inside another — plus the refusals that stop a write
 * going somewhere it does not belong.
 *
 *   node test/field-binding.mjs
 */
import { readBindings, verifyBindings, getField, setField, parsePath, splitSource } from '../lib/bind.mjs';

let pass = 0, fail = 0;
const chk = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}`); console.log(`        expected ${e}`); console.log(`        actual   ${a}`); fail++; }
};
const throws = (name, fn, needle) => {
  try { fn(); console.log(`  FAIL  ${name}`); console.log('        expected it to refuse, but it returned'); fail++; }
  catch (e) {
    if (e.message.includes(needle)) { console.log(`  PASS  ${name}`); pass++; }
    else { console.log(`  FAIL  ${name}`); console.log(`        message lacked ${JSON.stringify(needle)}: ${e.message}`); fail++; }
  }
};

console.log('\n── paths address objects and array members ──');
chk('dots split into segments', parsePath('hero.heading'), ['hero', 'heading']);
chk('digits become array indices', parsePath('hero.highlights.2'), ['hero', 'highlights', 2]);
chk('reads a nested value', getField({ hero: { heading: 'Hi' } }, 'hero.heading'), 'Hi');
chk('reads an array member', getField({ h: { l: ['a', 'b'] } }, 'h.l.1'), 'b');
chk('absent path reads as undefined', getField({ hero: {} }, 'hero.nope'), undefined);
chk('absent path through a missing parent', getField({}, 'a.b.c'), undefined);

console.log('\n── a field may name a file other than the page default ──');
chk('bare path uses the document source', splitSource('hero.heading', 'pages/home.json'), { source: 'pages/home.json', path: 'hero.heading' });
chk('prefixed path overrides it', splitSource('locations/mason-oh.json#hero.heading', 'pages/home.json'), { source: 'locations/mason-oh.json', path: 'hero.heading' });

console.log('\n── writing copies rather than mutates ──');
{
  const before = { hero: { heading: 'Old', highlights: ['a', 'b'] } };
  const after = setField(before, 'hero.heading', 'New');
  chk('returns the new value', after.hero.heading, 'New');
  chk('leaves the original untouched', before.hero.heading, 'Old');
  chk('siblings survive', after.hero.highlights, ['a', 'b']);
  chk('array member is writable', setField(before, 'hero.highlights.1', 'z').hero.highlights, ['a', 'z']);
}

console.log('\n── writes that would invent structure are refused ──');
// Each of these means the site and the CMS disagree about the content shape.
// Failing loudly is the point: silently creating a key produces a content file
// the site never reads and an edit the client thinks went live.
throws('unknown field', () => setField({ hero: {} }, 'hero.heading', 'x'), 'no field "hero.heading"');
throws('unknown parent', () => setField({}, 'hero.heading', 'x'), 'no field "hero"');
throws('object addressed as array', () => setField({ hero: { a: 1 } }, 'hero.0', 'x'), 'is not an array');
throws('array addressed as object', () => setField({ hero: ['a'] }, 'hero.name', 'x'), 'is not an object');
throws('empty path', () => setField({ a: 1 }, '', 'x'), 'empty field path');

console.log('\n── reading a rendered page ──');
{
  // The heading is split around its emphasised phrase, exactly as the reference
  // site renders it — the case that made text matching unworkable.
  const html = `<html><body data-cms-source="pages/home.json">
    <h1 data-cms="hero.heading">Clean Gutters <span class="hl">Every Season</span></h1>
    <p data-cms="hero.intro">  Skip   the ladder.  </p>
    <ul><li><span data-cms="hero.highlights.0">Two cleanings</span></li></ul>
    <p>Not editable — no attribute.</p>
  </body></html>`;
  const { source, bindings } = readBindings(html);
  chk('finds the document source', source, 'pages/home.json');
  chk('finds every bound field', bindings.map((b) => b.path), ['hero.heading', 'hero.intro', 'hero.highlights.0']);
  chk('a split heading reads as one whole value', bindings[0].text, 'Clean Gutters Every Season');
  chk('unbound copy is not offered for editing', bindings.length, 3);
  chk('each field carries its file', bindings[1].source, 'pages/home.json');
}

console.log('\n── a bound element inside another is not edited twice ──');
{
  // Without this the outer write clobbers the inner one, and which of the two
  // wins depends on click order — a bug that only appears for some clients.
  const html = `<body data-cms-source="p.json"><div data-cms="a"><span data-cms="a.b">x</span></div></body>`;
  chk('only the outer field binds', readBindings(html).bindings.map((b) => b.path), ['a']);
}

console.log('\n── the same sentence twice stays unambiguous ──');
{
  const html = `<body data-cms-source="p.json">
    <h2 data-cms="services.heading">Get A Quote</h2><a data-cms="cta.label">Get A Quote</a></body>`;
  const content = { services: { heading: 'Get A Quote' }, cta: { label: 'Get A Quote' } };
  const r = verifyBindings(html, { 'p.json': content });
  chk('both verify against their own field', [r.bound, r.ok, r.problems.length], [2, 2, 0]);
  chk('editing one leaves the other alone', setField(content, 'cta.label', 'Book Now').services.heading, 'Get A Quote');
}

console.log('\n── drift between the page and its content is reported, not guessed at ──');
{
  const html = `<body data-cms-source="p.json">
    <h1 data-cms="hero.heading">Rendered</h1>
    <p data-cms="hero.gone">Orphan</p>
    <p data-cms="hero.highlights">A list, not a string</p>
    <p data-cms="other.json#x.y">Elsewhere</p>
    <p data-cms="loose">No source</p></body>`;
  const r = verifyBindings(html, { 'p.json': { hero: { heading: 'Stored', highlights: ['a'] } } });
  const kinds = Object.fromEntries(r.problems.map((p) => [p.path, p.kind]));
  chk('text that no longer matches', kinds['hero.heading'], 'text-differs');
  chk('field removed from the content file', kinds['hero.gone'], 'missing-field');
  chk('field that is not editable text', kinds['hero.highlights'], 'not-text');
  chk('field naming a file we do not have', kinds['x.y'], 'missing-file');
  chk('nothing verified', r.ok, 0);
}
{
  const r = verifyBindings(`<body><h1 data-cms="a">x</h1></body>`, {});
  chk('a page with no source at all', r.problems[0].kind, 'no-source');
}

console.log('\n── whitespace differs freely between JSON and HTML ──');
{
  // The browser collapses runs of whitespace, and Astro indents markup, so the
  // rendered text of a multi-node field is never byte-identical to the JSON.
  const html = `<body data-cms-source="p.json"><h1 data-cms="h">Two\n   Lines</h1></body>`;
  chk('collapsed whitespace still verifies', verifyBindings(html, { 'p.json': { h: 'Two Lines' } }).ok, 1);
}

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail > 0 ? 1 : 0);
