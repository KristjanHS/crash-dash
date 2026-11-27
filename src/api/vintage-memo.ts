/**
 * Per-vintage instance memo for the read handlers' heavy bulk reads (P12.a).
 *
 * WHY: every edge MISS on the public page (`/overview` → `/api/lab?hist=20`,
 * `/api/series?detail=1`) re-pays the same per-vintage bulk work — the ~5000-row-per-id
 * synth history load (`loadSynthHistories`, three full-history reads) and the per-member
 * state history (`fetchCissHistory`). Those inputs move ONLY when a new cron run lands (a new
 * verdict `firedAt`), so a warm lambda instance should pay them once per vintage, not once
 * per request.
 *
 * ONE-ENTRY INVARIANT: the map holds AT MOST ONE entry per `name` — a call with a different
 * `firedAt` REPLACES the entry rather than accumulating keys, so the memo can never grow
 * beyond the fixed set of names and never serves a superseded vintage.
 *
 * INVALIDATION: the nightly cron's vintage change is the invalidator — a new run persists a
 * new `firedAt`, the next request keys on it, and the stale entry is replaced. (The cron's
 * edge-tag purge handles the CDN layer; this memo is the lambda-instance layer beneath it.)
 * A REJECTED loader deletes its own entry so the next request retries instead of caching
 * the failure. A RESOLVED value failing `opts.cacheIf` evicts the same way (the value still
 * goes to this caller): those consumers' loaders swallow store failures into an EMPTY result
 * (`loadSynthHistories` on /series ⇒ empty map, `fetchCissHistory` ⇒ all-empty histories), so without
 * this a transient failure on a vintage's first MISS would pin the degraded-empty result for
 * the whole vintage on a warm instance. An empty/absent `firedAt` (degraded store, no run
 * yet) BYPASSES the memo entirely — the loader runs uncached, exactly the pre-memo behavior.
 */
const memo = new Map<string, { firedAt: string; promise: Promise<unknown> }>();

export function memoByVintage<T>(
  name: string,
  firedAt: string | null | undefined,
  loader: () => Promise<T>,
  opts?: { cacheIf?: (value: T) => boolean },
): Promise<T> {
  if (!firedAt) return loader(); // no vintage key ⇒ no caching, never a "" bucket
  const hit = memo.get(name);
  if (hit && hit.firedAt === firedAt) return hit.promise as Promise<T>;
  const promise = loader();
  memo.set(name, { firedAt, promise }); // replaces any older-vintage entry: one entry per name
  promise.then(
    (value) => {
      // Self-evict a resolved-but-uncacheable value (see docblock) — same ownership guard.
      if (opts?.cacheIf && !opts.cacheIf(value) && memo.get(name)?.promise === promise)
        memo.delete(name);
    },
    () => {
      // Self-evict on rejection so the next call retries — but only if the entry is still
      // OURS (a newer vintage may have replaced it while this loader was in flight).
      if (memo.get(name)?.promise === promise) memo.delete(name);
    },
  );
  return promise;
}

/** Test seam: clears every entry so suites sharing the module-level map stay isolated. */
export function resetVintageMemo(): void {
  memo.clear();
}
