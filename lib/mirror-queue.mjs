/**
 * mirror-queue.mjs — a one-at-a-time task queue for database mirroring.
 *
 *   The filesystem is the working copy; every write and delete under it is
 *   mirrored to MongoDB. Those mirror calls MUST reach the database in the same
 *   order the filesystem saw them, or they corrupt each other:
 *
 *     ingest does  rmSync(siteDir)      -> delete everything under sites/<name>
 *            then  writePage(...) x4    -> write the new pages
 *
 *   Fired off independently, the delete's `deleteMany` could land after those
 *   writes and wipe the fresh files — leaving a site.json in the database whose
 *   pages were gone, which crashed the server on every subsequent boot.
 *
 *   Serialising is enough here: mirroring is a background trickle, not a hot
 *   path, and correctness matters far more than parallelism.
 */

export function createMirrorQueue({ onError } = {}) {
  let chain = Promise.resolve();
  let pending = 0;

  return {
    /** Queue `fn`; it runs only after everything queued before it has settled. */
    enqueue(label, fn) {
      pending++;
      chain = chain
        .then(fn)
        .catch((e) => { if (onError) onError(label, e); })   // one failure must not stall the rest
        .finally(() => { pending--; });
      return chain;
    },
    /** Resolves once every queued task has finished. */
    flush() { return chain; },
    get pending() { return pending; },
  };
}
