/**
 * Gate off the data path: a gated page fires its PUBLIC /api reads, then awaits
 * the session gate — a stale-token renewal no longer sits on the data path. Anonymous discards are edge HITs.
 */
import { API_TIMEOUT_MS, baseFetch, request } from "./http.js";

const pending = new Map();
/** A boot prefetch nobody took this fast is never handed to a later poll/refocus as fresh. */
export const PREFETCH_TTL_MS = 30_000;

/** Start `urls` (deduped), then return `gate()` — never awaited before the fetches are in flight. */
export function prefetchThenGate(urls, gate, fetchImpl = baseFetch, now = Date.now) {
  for (const url of urls) {
    if (pending.has(url)) continue;
    const p = request(url, { fetchImpl, timeoutMs: API_TIMEOUT_MS });
    p.catch(() => {}); // an untaken prefetch (redirected visitor) must not surface as unhandled
    pending.set(url, { p, at: now() });
  }
  return gate();
}

/** `fetch`, but the first plain GET of a prefetched url takes that in-flight response (a body reads once). */
export function fetchOnce(url, init, now = Date.now, fetchImpl = baseFetch) {
  return takeOrFetch(url, init, now, fetchImpl);
}

/** `fetchOnce` whose miss goes through `fetchImpl` (app.js: the `apiFetch` seam the prefetch also used). */
export const fetchOnceVia = (fetchImpl, now = Date.now) => (url, init) => takeOrFetch(url, init, now, fetchImpl);

/** No init (undefined or null), or one carrying only a signal (`request`'s timeout): the prefetch answers it. */
const plainGet = (init) => init == null || (Object.keys(init).length === 1 && "signal" in init);

function takeOrFetch(url, init, now, fetchImpl) {
  const hit = plainGet(init) ? pending.get(url) : undefined;
  if (hit) {
    pending.delete(url);
    if (now() - hit.at < PREFETCH_TTL_MS) return hit.p;
  }
  // Forwards its caller's URL: api/security-headers.test.ts scans the fetchOnce call sites instead.
  return fetchImpl(url, init);
}

/** Forget every untaken prefetch: call once the boot load cycle settles, so no later cycle takes one. */
export function dropPrefetches() {
  pending.clear();
}
