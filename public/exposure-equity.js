/**
 * W5-b Stage 5.2 — the `/lab` side of the DEC-15 wire: read the CURRENT posture's equity weight
 * off `/api/exposure` so `cashClaimHtml` can size the footer cash chip with the same scalar the
 * push uses (`resolveCash`'s standing non-equity %).
 *
 * Constraint 3: NO new handler — this consumes the existing `/api/exposure` (slice E1), which
 * already returns `equityPct: number | null` (null = degraded posture, never a fabricated Core).
 *
 * Lives in its own seam module rather than in `cash-overlay-view.js` (declared pure/IO-free) or
 * `lab.js` (module-level DOM/localStorage side effects, so vitest can never import it). No
 * module-level side effects here either — the fetch is injectable, so the test drives both the
 * success and the failure edge without jsdom or a network.
 */
import { API_TIMEOUT_MS, baseFetch, request } from "./http.js";

/** Pure projection: an `/api/exposure` body → its equity weight, or null when absent/degraded.
 *  ⚠ `0` is a REAL weight (a Defensive-style posture), so this must never use truthiness. */
export function equityPctFrom(resp) {
  const v = resp && resp.equityPct;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Fetch the current posture's equity weight. NEVER throws and NEVER fabricates a weight:
 *  a non-ok response, a transport failure, malformed JSON, or a degraded body all yield `null`,
 *  which `cashClaimHtml` renders as the unsized ("not yet sized") chip.
 *  @param {typeof fetch} [fetchImpl] injectable for tests; defaults to http.js `baseFetch` (the global fetch). */
export async function loadEquityPct(fetchImpl = baseFetch) {
  try {
    const res = await request("/api/exposure", { fetchImpl, timeoutMs: API_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    return equityPctFrom(await res.json());
  } catch {
    return null;
  }
}

/**
 * A refreshable holder for the equity weight. Unlike `loadDangerModel`'s lifetime memo — which
 * caches a STATIC constant table — `equityPct` is CURRENT state: it changes whenever the cron
 * flips posture, so a page-lifetime memo would freeze the chip until a reload, and (because
 * `loadEquityPct` resolves rather than rejects) a single transient failure would pin it at
 * "not yet sized" forever. So the promise here dedupes only an IN-FLIGHT request; each
 * `load()` after settle re-issues (the handler's `s-maxage=60` absorbs the poll volume).
 *
 * A failed refresh resolves to `null` — UNSIZED, never the last good value: `loadEquityPct`'s
 * "never fabricate a weight" property covers a stale weight too.
 */
export function makeEquityPctLoader(fetchImpl) {
  let inFlight = null;
  let current = null;
  return {
    /** Latest settled weight, or null when unsized/degraded. */
    get value() {
      return current;
    },
    /** Resolves when a fresh (or the in-flight) read has settled. Never rejects. */
    load() {
      if (inFlight) return inFlight;
      inFlight = loadEquityPct(fetchImpl)
        .then((pct) => {
          current = pct;
          return pct;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
