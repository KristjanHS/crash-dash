// crash-dash — Pension drawdown blend math (pure).
//
// The EUR-drawdown engine: a dated, chain-linked book of sleeve weights (`DatedWeights`)
// blended into a synthetic portfolio `P` whose trailing-peak drawdown maps to a 4-band
// verdict (CALM / DIP / CORRECTION / BEAR) at the cut-points below. The J4 server-side owner
// track was retired 2026-09-07; what survives here is the pure blend math + cut constants,
// consumed by `/api/config` (the cut-points) and the `/journal` drawdown parity test
// (`public/journal-drawdown.test.js`), which hand-ports these functions to the browser.
//
// PURE (no IO, no time): every function takes already-fetched, date-aligned data and returns
// plain data. Correctness rule: the headline drawdown is the drawdown of the BLENDED `P`
// series, NOT a weighted average of per-leg drawdowns — the sleeves peak on different days.

import { confirmedSeries } from "./domain-fold.js";
import { type Observation } from "./domain-types.js";
import type { StoredReading } from "./store.js";

/**
 * Confirmed pension-track band, ranked CALM < DIP < CORRECTION < BEAR. Mirrors the
 * BottomState / SlowBand off-ladder band enums. The cut-points that map a portfolio
 * drawdown to one of these are calibration-locked below.
 */
export type PensionBand = "CALM" | "DIP" | "CORRECTION" | "BEAR";

/**
 * The sleeves a dated pension book can name — the vocabulary its `DatedWeights` segments and
 * `PensionLeg.eur` maps are keyed by. Instrument ids, not fetch tickers (`SP500IT` is fetched
 * as `XLK`) or store ids. Kept as the blend math's key type after the server-side owner track
 * was retired (J4); a caller supplies its own dated book.
 */
type SleeveId = "SPY" | "VEA" | "SP500IT" | "EU-Fin" | "SMH" | "VWO" | "VGK" | "XDEV";

/**
 * Portfolio weights as a sleeve→fraction map; the fractions of ONE dated segment sum
 * to 1 (validated in `pension_holdings.ts`). Partial: a segment names only the sleeves
 * it actually holds, and an absent sleeve is weight 0, not a hole.
 */
export type PensionWeights = Partial<Record<SleeveId, number>>;

/**
 * One effective-dated holdings segment: the weights in force from `from` (ISO date,
 * inclusive) until the next segment's `from`. The user keeps switching ETFs, so the
 * book is a dated series, never a fixed split.
 */
interface DatedWeightSegment {
  from: string;
  weights: PensionWeights;
}

/** The dated history, oldest→newest, strictly ascending in `from`. */
export type DatedWeights = DatedWeightSegment[];

/**
 * One date-aligned day: every joined sleeve's value already converted to EUR
 * (`USD ÷ DEXUSEU`). A sleeve-keyed map rather than the old fixed `{ us, nx }` pair —
 * the book switches ETFs, so which sleeves exist is data, not a type (Stage 2).
 *
 * ⚠ The key set VARIES by day (Stage 9 / R1): only the sleeves WEIGHTED on `date` are
 * guaranteed present — unweighted ones left-join and are simply absent on a day their feed
 * does not cover. Never index `eur` without an `undefined` check.
 */
export interface PensionLeg {
  date: string;
  eur: SleeveValues;
}

/** EUR value per sleeve on one aligned day. Same partial shape as `PensionWeights`. */
type SleeveValues = Partial<Record<SleeveId, number>>;

// --- Calibration-locked band cut-points (re-approved 2026-07-31) -----------------
//
// Grid-searched on the 2007→2026 EUR `P` series (frozen output: scripts/backtest/pension_calibration.json;
// the pension_calibration.py generator was deleted 2026-08-15, see git history) and approved as v1 2026-06-29. LIVE
// provenance: re-approved UNCHANGED on 2026-07-31 for the effective-dated, chain-linked
// blend — option (A),
// ruled on the counterfactual arm's evidence. A drawdown is classified
// by the deepest cut it has breached. More negative = more severe.

/** DIP floor: portfolio drawdown at/below this (but above CORRECTION) is a DIP. */
export const PENSION_DIP = -0.15;
/** CORRECTION floor: drawdown at/below this (but above BEAR) is a CORRECTION. */
export const PENSION_CORRECTION = -0.2;
/** BEAR floor: drawdown at/below this is a BEAR. */
export const PENSION_BEAR = -0.35;

/**
 * Load-time ordering invariant: the cut-points must be strictly more severe in order
 * and all be genuine (negative) drawdown fractions. A bad edit trips this at import,
 * not silently at runtime (mirrors bottom.ts's window-ordering guards).
 */
if (!(PENSION_DIP > PENSION_CORRECTION && PENSION_CORRECTION > PENSION_BEAR)) {
  throw new Error(
    `pension: cut-points must satisfy DIP(${PENSION_DIP}) > CORRECTION(${PENSION_CORRECTION}) > BEAR(${PENSION_BEAR})`,
  );
}
if (!(PENSION_DIP < 0)) throw new Error(`pension: cut-points must be negative drawdowns (DIP=${PENSION_DIP})`);

// --- Alignment + EUR conversion --------------------------------------------------

/**
 * Project one PENSION leg's raw price/rate `Observation[]` into `StoredReading[]` for
 * persistence (`SPY`/`VEA` USD adj-close, `DEXUSEU` USD-per-EUR). These legs have NO
 * Green/Amber/Red scorer — they are stored for deep-history reads + charting only, and
 * the PENSION channel feeds no alert roll-up — so `rawState = state = "GREEN"`
 * is a NOT-NULL placeholder no scorer ever reads. `delta20` is the REAL change over 20
 * observations (0 until 20 exist) so `/api/series?id=SPY` shows a true delta, not a
 * permanent 0 (which would read as a data-quality bug). Pure; input must be oldest→newest.
 */
export function priceLegReadingSeries(id: string, obs: Observation[]): StoredReading[] {
  return obs.map((o, i) => ({
    date: o.date,
    indicatorId: id,
    value: o.value,
    delta20: i >= 20 ? o.value - obs[i - 20]!.value : 0,
    rawState: "GREEN",
    state: "GREEN",
    decision: null, // raw stored leg (no scorer/derived descriptor) — never a decision variable
  }));
}

/**
 * The weights in force on `obsDate` (ISO): the LAST segment whose `from` is at or before it.
 * Throws below the earliest segment rather than defaulting — a date the book has no answer
 * for is a bug in the caller's window, not a 50/50 portfolio. Pure; `series` is the dated
 * history to resolve against (the caller owns the book after J4 retired the server track).
 */
export function effectiveWeights(obsDate: string, series: DatedWeights): PensionWeights {
  let held: PensionWeights | undefined;
  for (const seg of series) {
    if (seg.from <= obsDate) held = seg.weights;
    else break;
  }
  if (held === undefined) {
    throw new Error(
      `[pension] no holdings segment covers ${obsDate} (earliest is ${series[0]?.from ?? "<empty>"})`,
    );
  }
  return held;
}

// --- Pure series math ------------------------------------------------------------

/**
 * Trailing-peak drawdown for each day: `dd_t = v_t / max(v_{≤t}) − 1`, in [−1, 0].
 * The running max only ever rises, so a new high resets the drawdown to 0. Pure.
 */
export function drawdownSeries(values: number[]): number[] {
  const out: number[] = [];
  let peak = -Infinity;
  for (const v of values) {
    if (v > peak) peak = v;
    out.push(peak > 0 ? v / peak - 1 : 0);
  }
  return out;
}

/**
 * The blended synthetic portfolio `P` over the EFFECTIVE-DATED holdings history,
 * **chain-linked at every switch date** (Stage 3; ruling Q2 pick (i)).
 *
 * Within one holdings segment the shape is unchanged from Stage 2 — a constant-weight
 * blend rebased to the segment's own base day:
 *   `P_t = P_base · Σ_sleeve w_s · (v_s,t / v_s,base)`
 * (a daily-rebalanced approximation of a periodically-rebalanced portfolio — the
 * documented §5 simplification). The whole series is rebased to `1` on day 0, which
 * equals the weight sum because `validateHoldings` pins every segment to 1.
 *
 * **Chain-link convention:** a segment whose `from` first covers aligned day `d` takes
 * `d − 1` as its base, so `P_{d−1}` carries over untouched and the `d−1 → d` return is
 * earned by the NEW book — the user holds the new sleeves *on* `from`, so `from`'s own
 * close-to-close return is theirs. The join is therefore continuous by construction: no
 * step, no re-peaking, and the trailing-peak drawdown of `P` spans the switch. This is
 * what makes the §14 rule enforceable across a rebalance — the drawdown is of the
 * blended `P`, NEVER a weighted average of per-leg (or per-segment) drawdowns.
 *
 * **Dark-base guard (why `d − 1` is only the FIRST candidate).** At `d − 1` the incoming
 * sleeves are still UNWEIGHTED, so the Stage-9 weighted-only join merely left-joins them and
 * a legitimately absent value is expected: the sleeves trade on different venues (`EU-Fin` on
 * Xetra, `SP500IT` on NYSE), and `legCloseReadingRows` skips a leg's venue holidays outright.
 * A hard throw there would be permanent — the history is fixed, so EVERY later run would
 * degrade the whole track to null over one dark day. So the base is the NEWEST day at or
 * before `d − 1` that prices every positively-weighted INCOMING sleeve; the level carried
 * over is that day's `P`, and the intervening days' return is re-earned by the new book (a
 * bounded, documented discontinuity — days, not a lost track). When NO earlier day prices the
 * incoming book at all, the base falls back to `d` itself and the level carries `P_{d−1}`
 * unchanged: `blendAt(d, d)` is exactly the weight sum (1), so the level is continuous and
 * only the switch day's own return is forfeited.
 *
 * A weight-carrying sleeve absent from the aligned legs THROWS rather than contributing
 * 0: silently dropping a term would rescale `P` (a 100%-SP500IT book would score as a
 * flat 0-return series and read permanently CALM). Zero-weight sleeves are skipped, so a
 * segment may name only what it holds. That is the correct posture — a book NOBODY can
 * price is not a CALM book — and it is now the only shape that throws: a book priceable
 * on its own days but dark on the chain-link base is handled by the guard above, since
 * the base is chosen (or forfeited) rather than assumed.
 *
 * Precondition: each weighted sleeve's value at its segment's base day > 0 (the rebasing
 * denominator) — guaranteed by aligned real-price inputs; a zero base price yields
 * NaN/Infinity that would propagate to a spurious permanent BEAR.
 *
 * Pure + fixture-injectable: `series` is the dated history to resolve against.
 */
export function portfolioSeries(legs: PensionLeg[], series: DatedWeights): number[] {
  const out: number[] = [];
  let baseIdx = 0;
  // The level the segment's blend is multiplied onto. Tracked SEPARATELY from `baseIdx`
  // because the dark-base fallback needs the two to disagree: base `i` (the blend is 1
  // there) carried at `P_{i−1}` (the level that must not step).
  let baseLevel = 1;
  let held: PensionWeights | undefined;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const w = effectiveWeights(leg.date, series);
    if (w !== held) {
      // Switch date: rebase onto the newest PRIOR day that prices the incoming book, so
      // the level carries over and this day's return is the new book's. Day 0 has no
      // prior day — it is the origin, and `pricedBaseIdx` returns null there.
      const priced = pricedBaseIdx(legs, i, w);
      baseIdx = priced ?? i;
      baseLevel = (priced === null ? out[i - 1] : out[priced]) ?? 1;
      held = w;
    }
    out.push(blendAt(legs, i, baseIdx, w) * baseLevel);
  }
  return out;
}

/**
 * The newest index STRICTLY BEFORE `i` at which every positively-weighted sleeve of the
 * incoming book `weights` has a usable (present, > 0) EUR value — the chain-link base
 * `portfolioSeries` rebases onto — or `null` when no such day exists (day 0, or an incoming
 * book whose feeds start at `i`).
 *
 * `i − 1` is only the first candidate: the incoming sleeves are unweighted at the base, so
 * the weighted-only join does not guarantee them there and a venue holiday legitimately
 * leaves the base day dark. The walk is unbounded backwards because the alternative is
 * discarding the track permanently; in practice it stops within a holiday's length. Pure.
 */
function pricedBaseIdx(legs: PensionLeg[], i: number, weights: PensionWeights): number | null {
  const held = (Object.entries(weights) as [SleeveId, number][]).filter(([, w]) => w > 0);
  for (let j = i - 1; j >= 0; j--) {
    const eur = legs[j]!.eur;
    if (held.every(([sleeve]) => (eur[sleeve] ?? 0) > 0)) return j;
  }
  return null;
}

/**
 * One day's constant-weight blend of `legs[i]` against the segment base `legs[base]`:
 * `Σ_sleeve w_s · (v_s,i / v_s,base)`, which is exactly `1` at `i === base` for
 * sum-to-1 weights. Zero-weight sleeves are skipped; a weighted sleeve missing at the
 * base (or at `i`) throws — see `portfolioSeries`.
 */
function blendAt(legs: PensionLeg[], i: number, base: number, weights: PensionWeights): number {
  const baseEur = legs[base]!.eur;
  const leg = legs[i]!;
  let blend = 0;
  for (const [sleeve, w] of Object.entries(weights) as [SleeveId, number][]) {
    if (w <= 0) continue;
    const v0 = baseEur[sleeve];
    if (v0 === undefined || v0 <= 0) {
      throw new Error(
        `[pension] weighted sleeve ${sleeve} is absent from the aligned legs (or opens at ${String(v0)}) - cannot blend`,
      );
    }
    const v = leg.eur[sleeve];
    if (v === undefined) {
      throw new Error(`[pension] sleeve ${sleeve} missing on aligned day ${leg.date} - inner join is broken`);
    }
    blend += w * (v / v0);
  }
  return blend;
}

/**
 * Classify a (negative) portfolio drawdown into a band by the deepest cut it has
 * breached. Inclusive at the cut (`dd ≤ cut`), matching the §5 band table
 * (`−20% < dd ≤ −15%` ⇒ DIP). Pure.
 */
export function bandOf(dd: number): PensionBand {
  if (dd <= PENSION_BEAR) return "BEAR";
  if (dd <= PENSION_CORRECTION) return "CORRECTION";
  if (dd <= PENSION_DIP) return "DIP";
  return "CALM";
}

/**
 * Latest confirmed band: the per-day raw bands folded through the standard
 * CONFIRM_CLOSES buffer (the generic `confirmedSeries<PensionBand>` fold — the same
 * audited 2-close logic the fast ladder and the bottom track use) so a
 * one-day head-fake doesn't fire. Cannot reuse `deriveConfirmedState` directly (that
 * is hard-typed to the 3-value `State`), but shares its fold via the generic. Throws
 * on an empty series (the bootstrap needs ≥1 day). Pure.
 */
export function pensionConfirmBand(bands: PensionBand[], closes: number): PensionBand {
  return confirmedSeries(bands, closes).at(-1)!;
}

// --- Verdict ---------------------------------------------------------------------

