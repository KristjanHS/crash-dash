/**
 * Data layer for the VIX bottom-signal track: one degrading wrapper per leg, VIXCLS
 * (front) and VXVCLS (3-month), requested through the injected `fetchSeries` port, then
 * a pure date-align of the two legs into a {date, vix, vix3m, ratio}[] series.
 *
 * Today both ids are refused (see below), so neither leg is fetched from any source and
 * the track runs degraded ([] legs, null verdict) every cycle. The alignment and the
 * SAME-VENDOR invariant are kept for a future free source: the VIX/VIX3M ratio lives near
 * 1.0, so the two legs must come from one vendor on one publication calendar — a
 * cross-vendor timing skew would corrupt it.
 *
 * History: both legs moved from the closes provider to FRED on 2026-07-26 (IS-6 rung A; why, next
 * paragraph); the FRED ids were later refused too (the paragraph after).
 *
 * Why the move off the closes provider: its `^`-prefixed INDEX path died on 2026-07-17
 * — `^VIX3M` (and `^MOVE`) froze at that date while ordinary tickers kept flowing, which
 * pinned the whole VT ratio's denominator and the persisted VIX/VIX3M bottom legs with
 * it, silently, while the board read GREEN. Continuity was verified before the swap:
 * the closes feed's `^VIX3M` vs FRED `VXVCLS` over 496 overlapping dates (2024-07-25..2026-07-17)
 * agree to max |Δ| = 0.0000 (float-width noise only) — the series are the same numbers.
 *
 * Both ids are refused at the FRED seam (`fred-series-policy.ts`: the owner bars
 * redistribution), so `fetchSeries` throws `NoFreeSourceError` for them before any
 * request and this wrapper degrades the track to [].
 *
 * Posture: `fetchVixSeries` DEGRADES to [] on any feed failure (GEO/EBP/slow
 * convention) rather than throwing — the bottom track is a low-stakes off-ladder
 * signal that must never abort the fast core. `fetchSeries` (fred.ts) already retries
 * and throws on a hard failure; this wrapper converts that to [].
 */

import type { Observation } from "./domain-types.js";

/** FRED series ids for the front + 3-month VIX legs (were the closes feed's `^VIX`/`^VIX3M`); both refused by `REFUSED_SERIES`. */
export const VIX_SYMBOL = "VIXCLS";
export const VIX3M_SYMBOL = "VXVCLS";

/** One date with both legs aligned and the front/back ratio. */
export interface TermPoint {
  date: string;
  vix: number; // VIXCLS front
  vix3m: number; // VXVCLS 3-month
  ratio: number; // vix / vix3m — >1 backwardation (fear), <1 contango (calm)
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Daily closes for one VIX leg (VIXCLS / VXVCLS) via the injected `fetchFn`, oldest→newest;
 * DEGRADES to [] on any error — logged through `onFail`, never thrown, so a feed failure
 * can't abort the fast core. In production `fetchFn` is `fetchSeries`, which refuses both
 * ids with `NoFreeSourceError` before any request, so this returns [] every run. Any
 * source's parsing/window lives behind `fetchFn`; there is no bespoke parser here.
 */
export async function fetchVixSeries(
  series: string,
  fetchFn: (series: string) => Promise<Observation[]>,
  // The cron passes warn + `recordDegrade` (VT can fire alerts); other callers warn only.
  onFail: (scope: string, err: unknown) => void = (scope, err) => console.warn(`${scope}: ${msg(err)}`),
): Promise<Observation[]> {
  try {
    return await fetchFn(series);
  } catch (err) {
    onFail(`[vix_term] ${series} unavailable from FRED - VT omitted, bottom track null (not CALM) this run`, err);
    return [];
  }
}

/**
 * Date-align the front + 3-month legs into a {date, vix, vix3m, ratio}[] series,
 * oldest→newest. Inner-join by date: a date present in only one leg is DROPPED
 * (a single-leg ratio would be meaningless). Inputs are assumed sorted (the
 * parsers sort); the join is keyed by date string so order-independence is safe.
 * A non-positive vix3m is dropped (a zero/negative denominator can't yield a sane
 * ratio). Pure: no IO.
 */
export function alignTermStructure(front: Observation[], back: Observation[]): TermPoint[] {
  const backByDate = new Map(back.map((o) => [o.date, o.value]));
  const points: TermPoint[] = [];
  for (const f of front) {
    const vix3m = backByDate.get(f.date);
    if (vix3m === undefined || vix3m <= 0) continue;
    points.push({ date: f.date, vix: f.value, vix3m, ratio: f.value / vix3m });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return points;
}
