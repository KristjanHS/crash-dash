/**
 * Shared leaf of the price feed: the IO seams every close source takes (`PriceDeps`), the bar shapes, the
 * fixed lookback, and the per-run symbol memo behind `fetchDailyCloses` (`prices.ts`). Imports no source.
 */

import type { Env } from "./config.js";
import type { Observation } from "./domain-types.js";
import type { FetchLike } from "./fetch-budget.js";
import { runMemo } from "./run-memo.js";

// ~400 calendar days back guarantees ≥252 trading days (F5's 12-mo high window).
export const LOOKBACK_DAYS = 400;

/** IO seams, each (but the required `now` + `env`) defaulting to the production source resolved PER CALL. ⚠ Not in the
 *  `fetchDailyCloses` memo key — a test swapping deps calls `clearPriceCache()` first. */
export interface PriceDeps {
  /** Default: `globalThis.fetch`, looked up at call time. */
  fetchImpl?: FetchLike;
  /** Required by the seam's signature; nothing in this tree reads it (daily closes have no free source). */
  env: Env;
  /** Clock (epoch ms) for a source's start/end window and tail checks. Required. */
  now: () => number;
  /** Operator-warning sink. Default `console.warn`; nothing in this tree emits to it (no source, so no notice). */
  warn?: (line: string) => void;
}

/** One intraday bar: `at` = bar-start UTC ISO stamp, `date` = its UTC (= US-session) day. */
export type Bar = { at: string; date: string; value: number };

/** One daily bar on the closes provider's UNADJUSTED quote basis (`open`/`close` from the same arrays — never mix with `adjclose`). */
export type OcBar = { date: string; open: number; close: number };

// ── Per-run symbol memo (audit rank 15 / Cost-B1) ──────────────────────────────
// DISP and the scoreboard deliberately re-fetch SPY/ACWI within one run (the run loop, `run-cycle.ts`),
// and the closes provider is a single point of failure — so memoize by symbol+range for a modest TTL and
// dedupe in-flight so parallel callers share ONE underlying request (`run-memo.ts`; a rejection is
// evicted, never pinned for the whole TTL). Unlike fred/treasury this memo is ALWAYS armed — the TTL is
// what bounds a warm lambda's reuse — and has no `copy`: every caller is handed the one shared array.
const PRICE_CACHE_TTL_MS = 5 * 60_000;
const priceCache = runMemo<string, Observation[]>({ armed: true, ttlMs: PRICE_CACHE_TTL_MS });

function cacheKey(symbol: string, deep: boolean, lookbackDays?: number): string {
  return `${symbol}|${deep ? "deep" : "shallow"}|${lookbackDays ?? ""}`;
}

/** The memoized series for symbol+range, loading it via `load` on a miss (in-flight callers share one load). */
export function cachedCloses(
  symbol: string,
  deep: boolean,
  lookbackDays: number | undefined,
  load: () => Promise<Observation[]>,
): Promise<Observation[]> {
  return priceCache.get(cacheKey(symbol, deep, lookbackDays), load);
}

/**
 * Reset the per-run price memo. Test-only isolation seam: the module-level cache would
 * otherwise leak resolved series across test cases (a stubbed fetch would appear
 * "never called" on the second lookup of the same symbol). Call in `beforeEach`.
 */
export function clearPriceCache(): void {
  priceCache.start();
}
