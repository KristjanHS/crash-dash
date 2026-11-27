/**
 * Data layer: daily ADJUSTED closes for the price indicators (F4/F5/F6/F8/F13 and the per-leg price members),
 * behind one function so a provider swap is a one-file edit, mirroring fred.ts (v4 §9).
 *
 * No free source serves daily adjusted closes, so `fetchDailyCloses` throws `NoFreeSourceError` for every symbol
 * before any request; the callers' `degrade()` turns that into a degraded indicator rather than an aborted run.
 * Adjusted (split/dividend) closes are what a source must yield: NVDA's 2024 10:1 split would wreck a raw-close
 * MA200 / 6-mo return.
 */

import type { Observation } from "./domain-types.js";
import { NoFreeSourceError } from "./no-free-source.js";
import { cachedCloses, clearPriceCache, type PriceDeps } from "./price-cache.js";
import { providerFallbackHopped, resetProviderFallbackLatch } from "./provider-fallback-latch.js";

/** Indices (`^VIX`), FX (`EURUSD=X`), futures (`HG=F`) and exchange-suffixed listings (`XDEV.DE`): never a
 *  US end-of-day equity/ETF bar, so never held by `finalRewriteHeld`. */
const notAnEodTicker = (symbol: string): boolean =>
  symbol.startsWith("^") || symbol.endsWith("=X") || symbol.endsWith("=F") || /\.[A-Za-z]+$/.test(symbol);

/** Intraday-run switch (`startPriceFeed`, armed per run beside `startFredMemo`). */
let intradayFeed = false;

/** Arm the per-run price-feed mode; clears the memo so a warm lambda never serves the other mode's series. */
export function startPriceFeed(opts: { intraday?: boolean } = {}): void {
  intradayFeed = opts.intraday === true;
  clearPriceCache(); // a warm lambda never serves the other mode's series
}

/** True ⇒ this run's `symbol` closes are not primary-served: never rewrite a FINAL row with them. */
export function finalRewriteHeld(symbol: string): boolean {
  return !notAnEodTicker(symbol) && (providerFallbackHopped(symbol) || intradayFeed);
}

/** Strict-primary-feed latch (`--require-primary-feed`). With no source there is no fallback to refuse, so it is
 *  inert here; `null` restores the default (test seam). */
export function setRequirePrimaryFeed(_on: boolean | null): void {}

/** One provider→provider hop taken for one symbol on this run. With no source none is ever recorded. */
export interface ProviderFallback {
  symbol: string;
  /** The provider that failed. */
  from: string;
  /** The provider tried next. */
  to: string;
  /** The failure WITHOUT the symbol — the drain's dedup key. */
  summary: string;
}

/** Drop the run's provider-hop state. Called at `runScoringCycle` entry (mirroring `resetKeyedFallbacks()`). */
export function resetProviderFallbacks(): void {
  resetProviderFallbackLatch();
}

/** Take + clear the provider hops recorded since the last drain (run-cycle-persist.ts) — always empty here. */
export function drainProviderFallbacks(): ProviderFallback[] {
  return [];
}

/**
 * Daily adjusted closes, oldest→newest. `{ deep: true }` asks for the bounded ~20y history (the one-shot backfill);
 * the daily callers omit it. ⚠ `lookbackDays` REQUIRES `{ deep: true }` — it throws otherwise.
 *
 * No free source: every symbol throws `NoFreeSourceError`, before any request. The per-run symbol memo
 * (`cachedCloses`, price-cache.ts) still fronts the loader, so a source swap is the loader alone.
 */
export async function fetchDailyCloses(
  symbol: string,
  { deep = false, lookbackDays }: { deep?: boolean; lookbackDays?: number } & PriceDeps,
): Promise<Observation[]> {
  // `lookbackDays` is DEEP-ONLY: a shallow caller gets a fixed 2y window and the bound would be DROPPED silently —
  // a window-gated scorer handed a third of the history it asked for scores a different model. Throw instead.
  if (lookbackDays !== undefined && !deep) {
    throw new Error(`fetchDailyCloses(${symbol}): lookbackDays is deep-only — pass { deep: true } with it`);
  }
  return cachedCloses(symbol, deep, lookbackDays, () => Promise.reject(new NoFreeSourceError(symbol)));
}
