/**
 * mirror-order.mjs — the ordering guarantee the database mirror depends on.
 *
 * This is the exact property whose absence corrupted production: an ingest's
 * "delete the whole site" landed AFTER the writes that recreated its pages,
 * leaving a site.json whose pages no longer existed.
 *
 *   node test/mirror-order.mjs
 */
import { createMirrorQueue } from '../lib/mirror-queue.mjs';

let pass = 0, fail = 0;
const chk = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}`); console.log(`        expected ${e}`); console.log(`        actual   ${a}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── a slow task cannot be overtaken by a later one ──');
{
  // The real shape of the bug: a slow delete queued first, fast writes after.
  const done = [];
  const q = createMirrorQueue();
  q.enqueue('del', async () => { await sleep(40); done.push('delete-site'); });
  q.enqueue('w1', async () => { done.push('write-template'); });
  q.enqueue('w2', async () => { done.push('write-content'); });
  await q.flush();
  chk('delete settles before the writes that follow it', done, ['delete-site', 'write-template', 'write-content']);
}

console.log('\n── ordering holds with mixed durations ──');
{
  const done = [];
  const q = createMirrorQueue();
  const delays = [30, 0, 15, 0, 25];
  delays.forEach((ms, i) => q.enqueue(`t${i}`, async () => { await sleep(ms); done.push(i); }));
  await q.flush();
  chk('tasks finish in enqueue order', done, [0, 1, 2, 3, 4]);
}

console.log('\n── one failure must not stall or reorder the rest ──');
{
  const done = [];
  const errors = [];
  const q = createMirrorQueue({ onError: (label, e) => errors.push(`${label}:${e.message}`) });
  q.enqueue('ok1', async () => { done.push('a'); });
  q.enqueue('boom', async () => { throw new Error('mongo down'); });
  q.enqueue('ok2', async () => { done.push('b'); });
  await q.flush();
  chk('later tasks still run after a failure', done, ['a', 'b']);
  chk('the failure is reported with its label', errors, ['boom:mongo down']);
}

console.log('\n── flush waits for everything queued ──');
{
  let finished = 0;
  const q = createMirrorQueue();
  for (let i = 0; i < 5; i++) q.enqueue(`t${i}`, async () => { await sleep(10); finished++; });
  chk('work is pending before flush', q.pending, 5);
  await q.flush();
  chk('all tasks completed after flush', finished, 5);
  chk('nothing left pending', q.pending, 0);
}

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail > 0 ? 1 : 0);
