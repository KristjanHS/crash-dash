/**
 * The per-run fetch memo the feed adapters share (`fred.ts`, `treasury.ts`, `prices.ts`): one
 * keyed map of in-flight PROMISES, so concurrent callers arriving before the first fetch settles
 * all await the same request — one network round-trip, not N.
 *
 * Contract (pinned once, in `run-memo.test.ts`):
 *  · a hit serves the stored promise; a miss calls `load()` exactly once and stores its promise;
 *  · a REJECTED load is evicted — caching the failure would pin one blip for the rest of the run —
 *    and only if its own entry is still the one stored (a newer entry is never clobbered);
 *  · `ttlMs` bounds an entry's life against `now()` (default `performance.now`; unset `ttlMs` = lives until
 *    the next `start()`/`stop()`);
 *  · `copy` runs on every value handed out, so no caller can mutate what a sibling is served;
 *  · UNARMED (`stop()`, or the default before `start()`), every `get` goes straight to `load()`.
 *
 * ⛔ Lifetime: an adapter keeps its memo unarmed by default and arms it per run (`start()` drops
 * every entry). An always-armed memo (`armed: true`) needs a `ttlMs`, or a warm lambda serves one
 * run's vintage to the next. Zero imports by design — keeps its test in the shared vitest project.
 */

export interface RunMemoOptions<V> {
  /** Start armed. Default `false`: every `get` is a pass-through until `start()`. */
  armed?: boolean;
  /** Entry lifetime in ms, read off `now()`; an expired entry is re-fetched. Unset = no expiry. */
  ttlMs?: number;
  /** The clock `ttlMs` is read against. Default `performance.now`; a test injects a counter clock. */
  now?: () => number;
  /** Applied to every value handed out (hit, miss and unarmed alike). Unset = the shared value itself. */
  copy?: (value: V) => V;
}

export interface RunMemo<K, V> {
  /** Arm a fresh memo, dropping every entry. */
  start(): void;
  /** Disarm: drop every entry, and every later `get` goes to `load()`. */
  stop(): void;
  /** The memoized `load()` for `key`. */
  get(key: K, load: () => Promise<V>): Promise<V>;
}

interface Entry<V> {
  expires: number;
  promise: Promise<V>;
}

export function runMemo<K, V>(opts: RunMemoOptions<V> = {}): RunMemo<K, V> {
  const { ttlMs, copy, now: clock = () => performance.now() } = opts;
  let entries: Map<K, Entry<V>> | null = opts.armed === true ? new Map() : null;
  const out = (p: Promise<V>): Promise<V> => (copy ? p.then(copy) : p);
  return {
    start() {
      entries = new Map();
    },
    stop() {
      entries = null;
    },
    get(key, load) {
      const map = entries; // captured: a re-arm mid-flight never receives this run's eviction
      if (!map) return out(load());
      const now = clock();
      const hit = map.get(key);
      if (hit && hit.expires > now) return out(hit.promise);
      const promise = load();
      map.set(key, { expires: ttlMs === undefined ? Infinity : now + ttlMs, promise });
      promise.catch(() => {
        if (map.get(key)?.promise === promise) map.delete(key);
      });
      return out(promise);
    },
  };
}
