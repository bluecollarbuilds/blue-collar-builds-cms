/**
 * json-edit.mjs — change one value in a JSON file and touch nothing else.
 *
 *   WHY NOT JSON.parse → edit → JSON.stringify
 *   Because the file is in a git repository that people read. The reference
 *   site's home.json groups its sections with blank lines and orders its keys
 *   the way a person would; re-serialising it flattens all of that, so a client
 *   changing one headline produces a diff touching every line of the file.
 *   Nobody can review that, and the second edit conflicts with the first over
 *   whitespace neither person changed.
 *
 *   So we edit the TEXT: find the exact span the old value occupies and swap
 *   only those characters. Formatting, key order, comments-by-convention,
 *   trailing newline — all preserved byte-for-byte. The commit shows one line.
 *
 * Path segments address objects and arrays alike, matching lib/bind.mjs:
 * `hero.highlights.2` is the third member of the highlights array.
 */

const WS = /\s/;

/**
 * Byte span of the value at `path`, or null if the path is not present.
 * Returns { start, end } — indices into `text`.
 */
export function locateValue(text, path) {
  const want = String(path).split('.').filter((s) => s !== '');
  let i = 0;
  let found = null;

  const ws = () => { while (i < text.length && WS.test(text[i])) i++; };
  const at = (n) => `position ${n}`;

  function scanString() {
    const start = i;
    i++;                                                  // opening quote
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }         // escape: skip the pair
      if (text[i] === '"') { i++; return { start, end: i }; }
      i++;
    }
    throw new Error(`unterminated string at ${at(start)}`);
  }

  function scanValue(cur) {
    ws();
    const start = i;
    const c = text[i];

    if (c === '{') {
      i++; ws();
      if (text[i] === '}') i++;
      else for (;;) {
        ws();
        if (text[i] !== '"') throw new Error(`expected a key at ${at(i)}`);
        const k = scanString();
        ws();
        if (text[i] !== ':') throw new Error(`expected ':' at ${at(i)}`);
        i++;
        scanValue([...cur, JSON.parse(text.slice(k.start, k.end))]);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        throw new Error(`expected ',' or '}' at ${at(i)}`);
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') i++;
      else {
        let n = 0;
        for (;;) {
          scanValue([...cur, String(n++)]);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; break; }
          throw new Error(`expected ',' or ']' at ${at(i)}`);
        }
      }
    } else if (c === '"') {
      scanString();
    } else if (c === undefined) {
      throw new Error('unexpected end of file');
    } else {
      // number, true, false, null — runs until a delimiter
      while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
      if (i === start) throw new Error(`unexpected character ${JSON.stringify(c)} at ${at(i)}`);
    }

    // Compared as strings so an array index and a numeric object key address
    // alike, which is how getField/setField already behave.
    if (found === null && cur.length === want.length && cur.every((s, k) => String(s) === want[k])) {
      found = { start, end: i };
    }
  }

  scanValue([]);
  return found;
}

/**
 * Return `text` with the value at `path` replaced. Throws if the path is not
 * already present — this never creates a field, for the same reason setField
 * does not: a path the file does not have means the site and the CMS disagree
 * about the content shape, and inventing a key produces a field the site never
 * reads and an edit the client believes went live.
 */
export function setJsonValue(text, path, value) {
  const loc = locateValue(text, path);
  if (!loc) throw new Error(`"${path}" is not in this content file`);
  return text.slice(0, loc.start) + JSON.stringify(value) + text.slice(loc.end);
}
