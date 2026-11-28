/**
 * Bespoke price scorers (Stage 5b.2 split — internal-graph LEAF of the
 * `scorers-*.ts` split): the single/dual-input price scorers built on the shared
 * engine — F4 semis, F5 breadth, F6 rel-strength, F13 credit appetite, F8 memory
 * gate, the downside-break detectors (+ their two load-time window asserts), the
 * NVDA MA200 gate and GT global trend. Pure, no IO. Imports `scorers-core.js` +
 * domain/family-descriptor ONLY (never the registry — keeps the DAG
 * acyclic: registry → scorers-price → scorers-core).
 */

import {
  type Indicator,
  type Observation,
  type Reading,
  type State,
  CONFIRM_CLOSES,
  STATE_RANK,
} from "./domain-types.js";
import { at } from "./series-math.js";
import { rollingPercentile } from "./percentile.js";
import {
  // Stage 2b.1 bespoke cuts — USED below, sourced from the descriptor instances.
  F4_AMBER_RET,
  F4_RED_RET,
  MU_AMBER,
  MU_RED,
  MU_MA_MULT,
  BREADTH_AMBER_P,
  BREADTH_RED_P,
  BREADTH_CUT_WINDOW,
  BREADTH_MAX_CUT_WINDOW,
  type BreadthConfig,
  BREADTH_CONFIG_OF,
  HCX_SYMBOLS,
  type RatioVsMaConfig,
  RATIO_VS_MA_CONFIG_OF,
  type ReturnOrMaConfig,
  RETURN_OR_MA_CONFIG_OF,
  // Stage 2b.2 shared price windows + F13/DB_* cuts — USED below, sourced from
  // PRICE_WINDOWS / F13_DESCRIPTOR / DB_{SMH,XLK}_DESCRIPTOR.
  MA_WINDOW,
  RET_WINDOW,
  HIGH_WINDOW,
  HIGH_WINDOW_SHORT,
  MA_SHORT,
  DOWNSIDE_AMBER,
  DOWNSIDE_RED,
  DOWNSIDE_CUT_OVERRIDES,
  rsCuts,
  type RsCuts,
  EXSH_GATE_DESCRIPTOR,
} from "./family-descriptor-rows.js";

// Re-exported: the RS parameter-row resolver moved beside its table (family-descriptor-rows.ts) so the
// registry's chart bands read the same row as the scorer; existing importers keep this path.
export { rsCuts };
import {
  ratioReadingSeries,
  latest,
  mean,
  maxOf,
  alignByDate,
  alignByDates,
  derivedReadingSeries,
  decisionAt,
  resolvedDerivedBands,
} from "./scorers-core.js";

// --- Price-momentum indicators (Phase 4 Stage 2) ---------------------------
//
// F4 (semis) and F5 (breadth) don't fit the FRED level+velocity shape, so each
// gets a bespoke pure scorer below. They still produce a `Reading` so they flow
// through scoring + persistence unchanged: `level` is the headline series
// value and `delta20` its HONEST 20-trading-day change of that level, while the
// confirmed `state` comes from the bespoke rule folded through the same
// CONFIRM_CLOSES buffer as the FRED indicators. the alert path only reads
// `state`+`channel`, so the bespoke shape never pollutes the FRED-clean score.

// The trailing price windows (MA_WINDOW/RET_WINDOW/HIGH_WINDOW) live on the SHARED
// `PRICE_WINDOWS` object (family-descriptor-rows.ts, Stage 2b.2 — no single family owns them);
// imported above for use here and re-exported at the top of the file.

// Invariant: scoreSemis's first iteration (i = MA_WINDOW-1) reads s[i-RET_WINDOW],
// which is in-bounds only when MA_WINDOW > RET_WINDOW. Both are exported+tunable, so
// assert it at load: a violation would otherwise silently score every day GREEN
// (negative index → undefined → NaN ≤ threshold is false) on a can-trigger indicator.
if (MA_WINDOW <= RET_WINDOW) {
  throw new Error(`[F4] MA_WINDOW (${MA_WINDOW}) must exceed RET_WINDOW (${RET_WINDOW})`);
}

// Same invariant, same failure mode, on the two-leg ratio-vs-MA rule: `ratioVsMaReadingSeries`'s
// classify starts at i = maWindow−1 and reads v[i − retWindow], in-bounds only when
// maWindow > retWindow. Both live on each id's `RATIO_VS_MA_CONFIG_OF` row and both are tunable,
// and a violation is SILENT: negative index → undefined → d20 = NaN → every `NaN <= cut` is false
// → the id scores GREEN forever with no throw and a green suite. Assert PER DESCRIPTOR at load, so
// a second id (FDX) on this route inherits the guard rather than adding a second module `throw`.
/** @internal */
export function assertRatioVsMaWindows(id: string, cfg: RatioVsMaConfig): void {
  if (cfg.maWindow <= cfg.retWindow) {
    throw new Error(`[${id}] maWindow (${cfg.maWindow}) must exceed retWindow (${cfg.retWindow})`);
  }
}
for (const [id, cfg] of Object.entries(RATIO_VS_MA_CONFIG_OF)) assertRatioVsMaWindows(id, cfg);

// F4's return cuts live on `F4_DESCRIPTOR`, F6's MA window + cut on `F6_DESCRIPTOR`
// (via `RS_CUT_OVERRIDES`), and F8's momentum bands + MA200 headroom on `F8_DESCRIPTOR`
// (family-descriptor-rows.ts, Stage 2b.1 — the measurement/provenance prose moved with them).
// The legacy names are imported above for use here and re-exported at the top of the file.


/**
 * F4 semis momentum (v4 §4, plan Task C). Per day: Amber when SMH is below its
 * MA200 AND ≥15% down over ~6mo; Red when ≥25% down over ~6mo AND NVDA is below
 * its own MA200. Raw state per day, then the CONFIRM_CLOSES buffer (via
 * buildReadings) — same confirmation discipline as the FRED indicators. Pure: no IO.
 */
export function semisReadingSeries(
  indicator: Indicator,
  smh: Observation[],
  nvda: Observation[],
): Reading[] {
  const { dates, a: s, b: n } = alignByDate(smh, nvda);
  // F4's return cuts are LOW-is-bad declines (negative) ⇒ firesHighward=false (m<1 lifts the
  // cut toward zero, firing earlier). Identity at the shipped 1.0 config. `n` (aligned NVDA,
  // equal length to `s`) is closure-captured for the Red MA200 gate. Guard-after is safe here
  // (no headline map: values === s already; note (a)).
  return ratioReadingSeries(indicator, s, dates, {
    minLength: MA_WINDOW,
    baseOffset: MA_WINDOW - 1,
    bands: { amber: F4_AMBER_RET, red: F4_RED_RET, firesHighward: false },
    classify: (i, v, aB, rB) => {
      const smhMA = mean(v, i - MA_WINDOW + 1, i);
      const nvdaMA = mean(n, i - MA_WINDOW + 1, i);
      const ret = at(v, i) / at(v, i - RET_WINDOW) - 1;
      if (ret <= rB! && at(n, i) < nvdaMA) return "RED";
      if (at(v, i) < smhMA && ret <= aB!) return "AMBER";
      return "GREEN";
    },
  });
}

export function scoreSemis(indicator: Indicator, smh: Observation[], nvda: Observation[]): Reading {
  const { a: s } = alignByDate(smh, nvda);
  const minLen = MA_WINDOW + CONFIRM_CLOSES; // enough days for ≥CONFIRM_CLOSES raw states to confirm
  return latest(indicator, semisReadingSeries(indicator, smh, nvda), minLen, s.length, "aligned closes");
}

// F5/SPCONC dynamic-band cut PROBABILITIES — the ONE source is `family-descriptor-rows.ts` (the
// sanctioned tunable layer); imported above for `breadthReadingSeries` and re-exported so every
// existing importer (dashboard.price-scorers.test.ts among them) still resolves the RELSTR way.
export { BREADTH_AMBER_P, BREADTH_RED_P, BREADTH_CUT_WINDOW, BREADTH_MAX_CUT_WINDOW };

/**
 * Strict-prior distance-from-high: `dist[i] = values[i] / max(values[i−HIGH_WINDOW+1 … i−1]) − 1`,
 * the prior ~12-mo window EXCLUDING today (so `dist` may exceed 0 on a new-high day — this is NOT
 * `derivedValue`'s inclusive `highDist`, which caps at 0). Exported so `breadthReadingSeries` and the
 * read-path band cuts share ONE expression (`indicator-loop.md` §A retune is a ONE-place edit). Convention: `NaN` (never
 * null — keeps the return a plain `number[]`) for `i < HIGH_WINDOW−1`, which have no full prior window;
 * `breadthCutSeries` SKIPS those NaNs, and callers never emit an unranked (NaN-cut) day.
 */
export function breadthDistSeries(values: number[], highWindow: number = HIGH_WINDOW): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = highWindow - 1; i < n; i++) {
    let priorHigh = at(values, i - highWindow + 1);
    for (let j = i - highWindow + 2; j < i; j++) if (at(values, j) > priorHigh) priorHigh = at(values, j);
    out[i] = at(values, i) / priorHigh - 1;
  }
  return out;
}

/**
 * The ONE cut expression for the breadth ids — a ROLLING percentile over the caller's window, minObs =
 * the window (a partial window would rank today against a handful of points). Exported because the
 * read path draws these cuts too (`api/series.ts` `pointBandCutSeries`); a second `rollingPercentile`
 * call there would be the same threshold in two places.
 * ⚠ The defaults are F5's config — every id but F5 MUST pass its own `breadthConfig(id)` window.
 *
 * ⚠ ROLLING, not expanding (ruled 2026-08-29): the expanding cut was flat by construction — being at
 * a 12-mo high is the top tail in EVERY regime, so its cut sat within a hair of 0 forever (measured on
 * the prod dist series: 0.02pp of travel over a 10.87pp axis). The cost is that the band re-arms in a
 * calm regime and desensitizes in a sustained melt-up; the pair was lifted to hold the fire rate.
 */
export function breadthCutSeries(
  dist: readonly number[],
  p: number,
  cutWindow: number = BREADTH_CUT_WINDOW,
  minObs: number = BREADTH_CUT_WINDOW,
): number[] {
  return rollingPercentile(dist, p, cutWindow, minObs);
}

/**
 * The per-day breadth ladder for ONE config direction, factored out so the mirrored `"low"` arm
 * is TESTABLE directly (not dead-by-construction): RED before AMBER on both sides. `"high"` (near a
 * high is the risk) fires `dist >= cut`; `"low"` (deep below the high is the risk) fires the mirror
 * `dist <= cut`. A NaN cut would classify GREEN in both directions, so callers never emit an
 * unranked (NaN-cut) day — `breadthReadingSeries` filters them out.
 */
export function breadthClassify(
  i: number,
  dist: readonly number[],
  amberCut: readonly number[],
  redCut: readonly number[],
  direction: "high" | "low",
): State {
  const low = direction === "low";
  if (low ? at(dist, i) <= at(redCut, i) : at(dist, i) >= at(redCut, i)) return "RED";
  if (low ? at(dist, i) <= at(amberCut, i) : at(dist, i) >= at(amberCut, i)) return "AMBER";
  return "GREEN";
}

/** Resolve a breadth config off the indicator id (throws on an unregistered id — only F5/SPCONC,
 *  and later a LOW twin, route here). The `downsideCuts`/`hasOwn` prototype-safety pattern. */
export function breadthConfig(id: string): BreadthConfig {
  if (!Object.hasOwn(BREADTH_CONFIG_OF, id)) {
    throw new Error(`[breadth] no BREADTH_CONFIG_OF entry for id "${id}"`);
  }
  return BREADTH_CONFIG_OF[id]!;
}

/**
 * F5 breadth (v4 §4, channel CONTEXT — feeds the dial + trend family, not FIN). Full rolling-
 * percentile band on the strict-prior distance-from-high (`breadthDistSeries`): being AT/ABOVE a high
 * is the risk, so RED when `dist[i] ≥` its RED cut, AMBER when `≥` the AMBER cut, else GREEN. Both cut
 * series come from `breadthCutSeries`, computed ONCE and captured in the closure (the scorers-composite
 * level-leg precedent). Pure: no IO.
 */
export function breadthReadingSeries(
  indicator: Indicator,
  qqq: Observation[],
  qqqe: Observation[],
): Reading[] {
  const cfg = breadthConfig(indicator.id);
  const { dates, a: q, b: e } = alignByDate(qqq, qqqe);
  const ratio = q.map((v, i) => v / at(e, i));
  // `values` stays the ratio (so `level` and the persisted `decision`/highDist line are unchanged —
  // the plotted-series switch to `dist` is Stage 2b, R3). The dynamic band scores the SEPARATE
  // `dist` leg (the CG level-leg precedent: capture the derived series + its cut arrays in the
  // closure). Both cut series computed ONCE; no `bands`/`resolveBands` — the cut is dynamic per-point.
  const dist = breadthDistSeries(ratio, cfg.highWindow);
  const amberCut = breadthCutSeries(dist, cfg.amberP, cfg.cutWindow, cfg.minObs);
  const redCut = breadthCutSeries(dist, cfg.redP, cfg.cutWindow, cfg.minObs);
  const rows = ratioReadingSeries(indicator, ratio, dates, {
    minLength: cfg.highWindow,
    baseOffset: cfg.highWindow - 1,
    // Firing side + RED-before-AMBER order come from `cfg.direction`.
    classify: (i) => breadthClassify(i, dist, amberCut, redCut, cfg.direction),
  });
  // Emit ONLY ranked days: an unranked (NaN-cut) day would classify a false GREEN, and a shallow
  // caller's tail re-shadow persisted it over the cron's ranked rows (F5/SPCONC, 2026-10-03).
  const idxOf = new Map(dates.map((d, i) => [d, i]));
  return rows.filter((r) => Number.isFinite(at(redCut, idxOf.get(r.date)!)) && Number.isFinite(at(amberCut, idxOf.get(r.date)!)));
}

/**
 * Aligned closes the dynamic band needs before it can form a single confirmed state:
 * (HIGH_WINDOW−1) for the first strict-prior high, +`BREADTH_MAX_CUT_WINDOW` for the first finite
 * rolling-percentile cut, +CONFIRM_CLOSES to confirm it. ONE floor for every breadth row, taken at
 * the DEEPEST id's window — `registry-price.ts` derives the FETCH depth (`BREADTH_LOOKBACK_DAYS`)
 * from it, so a per-id window change can never under-feed a sibling.
 */
export const BREADTH_MIN_CLOSES = HIGH_WINDOW + BREADTH_MAX_CUT_WINDOW + CONFIRM_CLOSES;

/**
 * True once enough ALIGNED closes exist for the latest day's rolling-percentile cut to be finite
 * (ranked) — the SAME `BREADTH_MIN_CLOSES` guard `scoreBreadth` throws on, as a soft predicate; the
 * guard-light PRICE_SCORERS rows call this to DROP the leg below it (fail-soft, no batch-collapsing
 * throw). Single source: no restated cut, no restated threshold.
 */
export function breadthBandRanked(qqq: Observation[], qqqe: Observation[]): boolean {
  return alignByDate(qqq, qqqe).a.length >= BREADTH_MIN_CLOSES;
}

/** @internal */
export function scoreBreadth(indicator: Indicator, qqq: Observation[], qqqe: Observation[]): Reading {
  const { a: q } = alignByDate(qqq, qqqe);
  // Below the rankable window the band cannot form; throw the "need N aligned closes" guard rather
  // than returning GREEN forever. aligned length === dist length (alignByDate returns equal-length
  // arrays). The PRICE_SCORERS rows wrap this in a guard-light `.at(-1)` so the throw cannot take
  // the whole price batch down (2026-08-21) — the depth that keeps it from firing is the fetch
  // window, `BREADTH_LOOKBACK_DAYS`.
  return latest(indicator, breadthReadingSeries(indicator, qqq, qqqe), BREADTH_MIN_CLOSES, q.length, "aligned closes");
}

/**
 * HCX hyperscaler-capex basket as a daily-rebalanced EQUAL-WEIGHT return chain (oldest→newest):
 * per aligned day the four constituents' simple returns are averaged, and the index compounds
 * `I_t = I_{t-1} * (1 + mean(r))`, `I_0 = 1`. Rebase-to-start and raw-price-average are rejected
 * (both let one name dominate — performance drift / split re-weighting); the return chain equal-
 * weights every day. The four HCX_SYMBOLS are INNER-JOINED by date via `alignByDates`, so a day
 * absent from ANY constituent is dropped entirely — no forward-fill, no 3-name day (a partial
 * basket is not the metric). Empty/degenerate join ⇒ []. Pure: no IO.
 */
export function hcxBasketSeries(bySymbol: Record<string, Observation[]>): Observation[] {
  const cols = HCX_SYMBOLS.map((sym) => bySymbol[sym] ?? []);
  const { dates, values } = alignByDates(cols);
  if (dates.length === 0) return [];
  const out: Observation[] = [{ date: at(dates, 0), value: 1 }];
  let idx = 1;
  for (let t = 1; t < dates.length; t++) {
    let sum = 0;
    for (const col of values) sum += at(col, t) / at(col, t - 1) - 1;
    idx *= 1 + sum / values.length;
    out.push({ date: at(dates, t), value: idx });
  }
  return out;
}

/**
 * Day-over-day ratio above which a step is a BASE BREAK (a re-anchored chained index), not a market
 * move. `hcxBasketSeries` compounds `I_0 = 1` at whatever day its fetch window opens, so two cron
 * writers at different fetch depths persist the SAME basket on bases far apart (measured on prod:
 * ~17.75× across the 08-27→08-28 join). The gap this constant sits in is wide and empty: an equal-
 * weight 4-name mega-cap basket ÷ SPY is damped twice (a 4-name average, then a market-relative
 * ratio), so even a 1987-scale −23% market day moves it well under 1.5× — every REAL daily step is
 * below 4×, while a base re-anchor is an order of magnitude above it (17.75×). 4× is thus safely
 * above any session move and far below any base break; no real chained-index return can reach it.
 * @internal
 */
export const CHAIN_BREAK_RATIO = 4;

// Quiet-market bound on the largest consecutive basket factor. Every REAL daily HCX step is well under
// 1.5× (the constant above: a 4-name average ÷ SPY, damped twice), so a `maxRatio` at or above this is a
// base-fetch artifact — including a sub-CHAIN_BREAK_RATIO one the splice never touched. The read path
// emits `maxChainRatio` ONLY above this bound, so a healthy payload stays byte-identical (no field) and
// the response-size budget cannot trip.
export const CHAIN_QUIET_RATIO = 1.5;

/**
 * Splice a chained index that carries more than one base onto its FIRST segment's base (lossless: a
 * scale-invariant metric like `breadthDistSeries` is unchanged by the constant per-segment factor).
 * Walks the RAW consecutive ratio `v[i]/v[i-1]` — invariant to the base WITHIN a writer's segment — and
 * at a step outside `[1/CHAIN_BREAK_RATIO, CHAIN_BREAK_RATIO]` rescales the ENTIRE remaining tail by the
 * factor that makes it continuous with the preceding good value (`out[i] === out[i-1]`). The one
 * unrecoverable value is the junction-day return itself, assumed 0 — an error of exactly one daily basket
 * return, typically sub-percent but several percent on a violent day, NOT a fixed small bound. Multiple
 * breaks repeat (each further rescales the running multiplier). Non-finite / non-positive values cannot
 * form a ratio, so they neither trigger nor anchor a splice — they pass through untouched and never poison
 * the tail factor. Pure: no IO. Returns the tail values on the first base, the indices repaired, and
 * `maxRatio` = the LARGEST observed consecutive factor `max(r, 1/r) ≥ 1` (1 when no finite pair exists) —
 * so a break BELOW CHAIN_BREAK_RATIO, which `breaks` cannot see, is still observable to the caller.
 */
export function spliceChainedIndex(values: number[]): { values: number[]; breaks: number[]; maxRatio: number } {
  const n = values.length;
  const out = new Array<number>(n);
  const breaks: number[] = [];
  let mult = 1;
  let maxRatio = 1;
  let prevRaw = NaN; // last finite, positive RAW value — the within-segment ratio base AND the splice anchor
  for (let i = 0; i < n; i++) {
    const raw = at(values, i);
    if (Number.isFinite(raw) && raw > 0 && Number.isFinite(prevRaw) && prevRaw > 0) {
      const r = raw / prevRaw;
      const factor = r >= 1 ? r : 1 / r; // fold to ≥1 so an up- and down-break of equal magnitude rank equal
      if (factor > maxRatio) maxRatio = factor;
      if (r > CHAIN_BREAK_RATIO || r < 1 / CHAIN_BREAK_RATIO) {
        // Base break: pick the tail multiplier so this point lands on the previous good spliced value
        // (`prevRaw * mult`). anchor and raw are both finite & positive here ⇒ never NaN/Infinity.
        mult = (prevRaw * mult) / raw;
        breaks.push(i);
      }
    }
    out[i] = Number.isFinite(raw) ? raw * mult : raw;
    if (Number.isFinite(raw) && raw > 0) prevRaw = raw;
  }
  return { values: out, breaks, maxRatio };
}

/**
 * HCX chart-only leg: the equal-weight basket ÷ SPY scored on the generalized breadth band with
 * `direction: "low"` (deep below the basket/SPY 12-mo high is the risk). Reuses `scoreBreadth`
 * verbatim — the basket is the numerator, SPY the denominator — so the BREADTH_MIN_CLOSES rankable
 * guard and the `latest()` fold are shared with F5/SPCONC. `breadthConfig("HCX")` resolves the LOW
 * ladder off HCX_BAND (family-descriptor-rows.ts).
 */
export function scoreHcx(indicator: Indicator, bySymbol: Record<string, Observation[]>, spy: Observation[]): Reading {
  return scoreBreadth(indicator, hcxBasketSeries(bySymbol), spy);
}


// --- F13 HYG/LQD credit appetite (CONTEXT) ---------------------------------
//
// The leading, rate-clean credit-appetite read: HYG (high-yield ETF) / LQD (investment-grade
// ETF) nets out the shared rates/duration move, isolating credit-risk appetite — and ETF flows
// reprice ~1–3 days ahead of the cash-OAS members (F1). LOW-is-bad on BOTH legs.
// TWO-LEG rule (2026-08-08). Per day
// i ≥ HYGLQD_MA−1, with ratio = hyg[i]/lqd[i]:
//   ms50 = ratio[i] / mean(ratio[i−HYGLQD_MA+1 … i]) − 1     (the position leg, second)
//   d20  = ratio[i] / ratio[i−HYGLQD_RET_WINDOW] − 1         (the velocity leg, PRIMARY)
//   RED   when d20 ≤ HYGLQD_D20_RED   AND ms50 ≤ HYGLQD_RED
//   AMBER when d20 ≤ HYGLQD_D20_AMBER OR  ms50 ≤ HYGLQD_AMBER
// AND-at-Red / OR-at-Amber is NOT new — it is exactly `combineLevelVelocity`'s `"split"`
// lattice (scorers-core.ts), already shipped on CG (`CG_DESCRIPTOR.combine`): RED iff BOTH
// legs are RED, AMBER iff EITHER leg is non-GREEN. This classify open-codes that lattice over
// two numeric legs instead of routing through the primitive (a backlog entry proposes the
// refactor); `dashboard.price-scorers.test.ts` carries a truth-table test either way, so an accidental
// AND/AND or OR/OR swap is not silently green. ≤ edges throughout, mirroring F6's LOW direction.
// HYGLQD_MA > HYGLQD_RET_WINDOW, so the MA window still binds `minLength` — asserted at load
// below (the guard next to F4's MA_WINDOW/RET_WINDOW assert).
// Dual-input, modeled on relStrengthReadingSeries: inner-join HYG·LQD on date
// (alignByDate), fold raw states through the CONFIRM_CLOSES buffer (buildReadings).
// `level` = the ratio; the persisted `decision` = the ms50 leg, single-sourced
// via decisionAt off the registry F13 `derived` (kind "maSpread", window HYGLQD_MA).
//
// ⚠ OWED — THE PRIMARY LEG IS NOT DRAWN. As shipped, `chart-rail.ts` routes F13 through the
// generic `derivedChart` on its `derived` block, so the detail chart draws the ms50 line and
// the ms50 amber/red bands and NOTHING ELSE: there is no F13 route and no second computed
// series for d20. Output-visible consequence: a day can paint AMBER while the only drawn line
// sits comfortably in green territory (the `shaped(1.004, 0.998, 20)` fixture in
// `dashboard.price-scorers.test.ts` is exactly that — its ms50 is positive, above the amber band, yet the
// ribbon is AMBER off the undrawn d20 leg). Drawing d20 as a second computed series on the same
// secondary axis (both legs are % deviations of the same ratio, so they share units) is the
// remaining rung — see `docs/backlog.md`. Until it lands, treat the chart as showing ONE of the
// two legs.
//
// ⚠ ASYMMETRIC SEAM — the threshold multiplier reaches ONE of these four cuts. The ms50 pair
// (HYGLQD_AMBER/HYGLQD_RED) is passed as `spec.bands` and therefore routed through
// `resolveBands` (src/threshold-config.ts), so it scales; the d20 pair
// (HYGLQD_D20_AMBER/HYGLQD_D20_RED) is read straight off the imported descriptor constants
// inside `classify` and does NOT. F13 is in `REACHABLE_IDS` with a live 1.0 entry, so nothing
// scales today — but a non-1.0 F13 multiplier would pass `validateMultiplierConfig` and move
// only `red` (HYGLQD_AMBER is negative zero, immovable under the |v|-relative earliness form),
// i.e. a partial no-op the validator is structurally unable to detect. Same shape as CG's
// velocity-only reach (`REACHABLE_IDS`' CG note) and `scoreOil`'s §4.9 note; recorded here so a
// future F13 override is read as one-of-four, not all-of-four.
//
// ⚠ `VELOCITY_WINDOW` currently EQUALS `HYGLQD_RET_WINDOW`, so the persisted `delta20` on every
// F13 reading happens to be bit-identical to the d20 leg the scorer classifies. That is an
// ACCIDENT of two independently tunable constants, not a contract: retuning `retWindow` on
// `F13_DESCRIPTOR` silently decouples them and `delta20` stops being the scored leg. Nothing
// reads it as such today — don't start.
//
// Channel CONTEXT here is NOT notify-neutral post-O2:
// the confirmed state flows via GLOBAL_FAMILIES → computeFamilyPanel → the T1 dial's credit
// family (a Red CAN move the dial/push) + the Value-leg RAG. Guard-light (returns []
// below the MA window, cold-start safe). STARTING PRIORS — uncalibrated, calibrate before trusting the cuts.
// Pure: no IO.
// The MA window + both cuts live on `F13_DESCRIPTOR` (family-descriptor-rows.ts, Stage 2b.2 — the
// single-source/negative-zero provenance prose moved with them); imported above, re-exported
// at the top of the file, so the probes and tests keep resolving the same symbols.

/** Resolve a ratio-vs-MA config off the indicator id (throws on an unregistered id — only F13,
 *  and later FDX, route here). The `breadthConfig`/`hasOwn` prototype-safety pattern. */
export function ratioVsMaConfig(id: string): RatioVsMaConfig {
  if (!Object.hasOwn(RATIO_VS_MA_CONFIG_OF, id)) {
    throw new Error(`[ratioVsMa] no RATIO_VS_MA_CONFIG_OF entry for id "${id}"`);
  }
  return RATIO_VS_MA_CONFIG_OF[id]!;
}

export function ratioVsMaReadingSeries(
  indicator: Indicator,
  hyg: Observation[],
  lqd: Observation[],
): Reading[] {
  const cfg = ratioVsMaConfig(indicator.id);
  const { dates, a: h, b: l } = alignByDate(hyg, lqd);
  const ratio = h.map((v, i) => v / at(l, i));
  // LOW-is-bad decline ⇒ firesHighward=false. Guard (minLength cfg.maWindow ≡ live `h.length < maWindow`)
  // applied after the pure length-preserving ratio map — note (a).
  return ratioReadingSeries(indicator, ratio, dates, {
    minLength: cfg.maWindow,
    baseOffset: cfg.maWindow - 1,
    bands: { amber: cfg.amber, red: cfg.red, firesHighward: false },
    classify: (i, v, aB, rB) => {
      const ma = mean(v, i - cfg.maWindow + 1, i);
      const ms = at(v, i) / ma - 1;
      // baseOffset maWindow−1 ≥ retWindow (per-descriptor load-time guard at the top of this file),
      // so v[i − retWindow] always exists here.
      const d20 = at(v, i) / at(v, i - cfg.retWindow) - 1;
      if (d20 <= cfg.d20Red && ms <= rB!) return "RED";
      if (d20 <= cfg.d20Amber || ms <= aB!) return "AMBER";
      return "GREEN";
    },
  });
}

export function scoreRatioVsMa(indicator: Indicator, hyg: Observation[], lqd: Observation[]): Reading {
  const cfg = ratioVsMaConfig(indicator.id);
  const { a: h } = alignByDate(hyg, lqd);
  // First scored index = maWindow−1 (inclusive MA window); +CONFIRM_CLOSES more to confirm a state.
  const minLen = cfg.maWindow + CONFIRM_CLOSES;
  return latest(indicator, ratioVsMaReadingSeries(indicator, hyg, lqd), minLen, h.length, "aligned closes");
}

/** Resolve a return-or-MA config off the indicator id (throws on an unregistered id — `hasOwn` pattern). @internal */
export function returnOrMaConfig(id: string): ReturnOrMaConfig {
  if (!Object.hasOwn(RETURN_OR_MA_CONFIG_OF, id)) {
    throw new Error(`[returnOrMa] no RETURN_OR_MA_CONFIG_OF entry for id "${id}"`);
  }
  return RETURN_OR_MA_CONFIG_OF[id]!;
}

/** HIGH-firing worst-of: the `derived` return leg OR level ÷ MA − 1, each inclusive (`>=`). */
function highState(d: number | null, amber: number | null, red: number | null): State {
  if (d === null) return "GREEN";
  if (red !== null && d >= red) return "RED";
  if (amber !== null && d >= amber) return "AMBER";
  return "GREEN";
}

export function returnOrMaSpreadReadingSeries(indicator: Indicator, closes: Observation[]): Reading[] {
  const cfg = returnOrMaConfig(indicator.id);
  const dv = indicator.derived;
  if (!dv || dv.kind !== "return" || dv.window == null) {
    throw new Error(`[${indicator.id}] returnOrMaSpread needs a "return" derived descriptor`);
  }
  const values = closes.map((o) => o.value);
  const dates = closes.map((o) => o.date);
  const ret = resolvedDerivedBands(indicator);
  const baseOffset = Math.max(dv.window, cfg.maWindow - 1);
  // LEG TOKEN (BONOS pattern): `return` when the plotted move carries the day (tie included), else `ma<N>`.
  const leg: Array<string | undefined> = [];
  return ratioReadingSeries(indicator, values, dates, {
    minLength: baseOffset + 1,
    baseOffset,
    bands: { amber: cfg.maAmber, red: cfg.maRed, firesHighward: true },
    classify: (i, v, aB, rB) => {
      const retState = highState(decisionAt(dv, v, i), ret.amber, ret.red);
      const maState = highState(at(v, i) / mean(v, i - cfg.maWindow + 1, i) - 1, aB, rB);
      const day = STATE_RANK[maState] > STATE_RANK[retState] ? maState : retState;
      leg[i] = day === "GREEN" ? undefined : day === retState ? "return" : `ma${cfg.maWindow}`;
      return day;
    },
    legOf: (i) => leg[i], // read after `classify` ran for the same i (ratioReadingSeries' loop order)
  });
}

export function scoreReturnOrMaSpread(indicator: Indicator, closes: Observation[]): Reading {
  const cfg = returnOrMaConfig(indicator.id);
  const window = indicator.derived?.window ?? 0;
  // First scored index = baseOffset; +CONFIRM_CLOSES more to confirm a state (the F13 guard's shape).
  const minLen = Math.max(window, cfg.maWindow - 1) + 1 + CONFIRM_CLOSES;
  return latest(indicator, returnOrMaSpreadReadingSeries(indicator, closes), minLen, closes.length);
}

// Legacy names kept re-exported so no consumer moves (registry-price, backfill, probes, tests).
export const creditAppetiteReadingSeries = ratioVsMaReadingSeries;
export const scoreCreditAppetite = scoreRatioVsMa;

// --- F8 Micron memory-cycle (MU) -------------------------------------------
//
// A noisy single-name proxy for the DRAM/NAND memory cycle → SOFT confirming member.
// Compound AND-gate (modeled on scoreNvdaGate + F4's compound rule): per day i ≥
// MA_WINDOW, ret6 = MU[i]/MU[i−RET_WINDOW] − 1, belowMA = MU[i] < MA200(MU,i)·MU_MA_MULT. RED
// when ret6 ≤ MU_RED AND belowMA; AMBER when belowMA AND ret6 ≤ MU_AMBER; else GREEN.
// Single-input, folded through the CONFIRM_CLOSES buffer (buildReadings). Guard-light
// (returns [] below MA_WINDOW obs, cold-start safe). Pure: no IO.
export function memGateReadingSeries(indicator: Indicator, mu: Observation[]): Reading[] {
  const s = mu.map((o) => o.value);
  const dates = mu.map((o) => o.date);
  // Single-input compound AND-gate. minLength MA_WINDOW ≡ live `mu.length < MA_WINDOW` guard
  // (s.length === mu.length). LOW-is-bad decline ⇒ firesHighward=false.
  return ratioReadingSeries(indicator, s, dates, {
    minLength: MA_WINDOW,
    baseOffset: MA_WINDOW - 1,
    bands: { amber: MU_AMBER, red: MU_RED, firesHighward: false },
    classify: (i, v, aB, rB) => {
      const ma = mean(v, i - MA_WINDOW + 1, i) * MU_MA_MULT;
      const ret = at(v, i) / at(v, i - RET_WINDOW) - 1;
      const belowMA = at(v, i) < ma;
      if (belowMA && ret <= rB!) return "RED";
      if (belowMA && ret <= aB!) return "AMBER";
      return "GREEN";
    },
  });
}

export function scoreMemGate(indicator: Indicator, mu: Observation[]): Reading {
  const minLen = MA_WINDOW + CONFIRM_CLOSES; // enough days for ≥CONFIRM_CLOSES raw states to confirm
  return latest(indicator, memGateReadingSeries(indicator, mu), minLen, mu.length);
}

// --- Downside-break detector (slice 2, 2026-07-13) -------------------------
//
// A FASTER downside price flag than F4's 6-mo/MA200 rule: per-symbol drawdown
// from a ~3-mo rolling high, GATED by a MA50 trend filter, over the US-tech
// proxies {SMH, NVDA, QQQ}. Drawdown reacts on the fall (death-cross/MA200 lag by
// construction — parent design §S-2). Runs per SINGLE symbol's close series (the
// caller invokes it once per symbol — SMH/NVDA are aligned upstream via
// alignByDate, QQQ is standalone). Graded G/A/R and folded through the same
// CONFIRM_CLOSES buffer as the other price scorers, so it flows through the shared
// Reading shape. Pure: no IO.

// The default (DB_SMH) pair and DB_XLK's own pair live on `DB_SMH_DESCRIPTOR` /
// `DB_XLK_DESCRIPTOR`, and the per-id `DOWNSIDE_CUT_OVERRIDES` table is DERIVED off the latter
// (family-descriptor-rows.ts, Stage 2b.2 — the retune + "separate entry, not a mirror" + "REGISTRATION
// is what the seam is" prose moved with them). All four cuts + the table are imported above and
// re-exported at the top of the file.

/**
 * The cut pair for a downside-break detector id: the `overrides` entry when present, else the
 * default pair. ONE home for the per-id pair, read by BOTH the scorer
 * (`downsideBreakReadingSeries`) and the DISPLAY path (api/indicators.ts's baked band lines),
 * so a per-id cut can never desync from its drawn line. The `threshold-config` multiplier seam
 * still scales whatever this returns (`resolveBands`, inside `ratioReadingSeries`). `overrides`
 * is injectable for tests ONLY — prod always takes the module table.
 */
export function downsideCuts(
  id: string,
  overrides: Readonly<Record<string, Readonly<{ amber: number; red: number }>>> = DOWNSIDE_CUT_OVERRIDES,
): { amber: number; red: number } {
  // `hasOwn`, not `overrides[id] ?? …`: a bare index reads the prototype chain, so an id like
  // "toString" would return a Function whose `.amber` is undefined ⇒ `dd <= undefined` is always
  // false ⇒ that detector scores GREEN forever. Unreachable with today's DB_* ids; cheap to close.
  return Object.hasOwn(overrides, id) ? { ...overrides[id]! } : { amber: DOWNSIDE_AMBER, red: DOWNSIDE_RED };
}
// The downside detectors' trailing windows (~3-mo rolling high + MA50 trend gate) live on the
// shared `PRICE_WINDOWS` object as `highShort`/`maShort` (family-descriptor-rows.ts, Stage 2b.2);
// imported above and re-exported at the top of the file.

// Invariant: the first iteration (i = HIGH_WINDOW_SHORT-1) reads a trailing MA50
// window [i-MA_SHORT+1 .. i], in bounds on that first iteration only when
// HIGH_WINDOW_SHORT >= MA_SHORT. Both are exported+tunable, so assert it at load
// (mirrors the MA_WINDOW > RET_WINDOW guard): a violation would otherwise read a
// negative index → undefined → NaN and silently mis-score when the windows are
// re-tuned.
if (HIGH_WINDOW_SHORT < MA_SHORT) {
  throw new Error(`[downside] HIGH_WINDOW_SHORT (${HIGH_WINDOW_SHORT}) must be >= MA_SHORT (${MA_SHORT})`);
}

/**
 * Downside-break detector (parent design §2) — full per-day `Reading[]` series
 * (oldest→newest) over ONE symbol's closes. Per day: `dd = s[i]/hi − 1` where `hi`
 * is the inclusive HIGH_WINDOW_SHORT rolling high; `ma50 = mean` over the trailing
 * MA_SHORT days. Red when `dd ≤ red AND s[i] < ma50`; Amber when
 * `dd ≤ amber AND s[i] < ma50`; else GREEN — the (amber, red) pair is PER DETECTOR
 * (`downsideCuts`: DB_XLK's own pair, everything else the default — both −5/−8 today). Raw states fold through the
 * CONFIRM_CLOSES buffer (via buildReadings). `< HIGH_WINDOW_SHORT` closes → [] (guard-
 * light, as scoreSemis returns [] below MA_WINDOW). Pure: no IO.
 */
export function downsideBreakReadingSeries(indicator: Indicator, closes: Observation[]): Reading[] {
  const s = closes.map((o) => o.value);
  const dates = closes.map((o) => o.date);
  // Per-detector cuts (equal pairs today, separately tunable) — resolved off the id, never a
  // module constant, so a second detector's bands can't be scored with the first's.
  const cuts = downsideCuts(indicator.id);
  // Config seam: drawdown cuts are LOW-is-bad declines (negative) ⇒ firesHighward=false.
  return ratioReadingSeries(indicator, s, dates, {
    minLength: HIGH_WINDOW_SHORT, // < HIGH_WINDOW_SHORT closes → [] (guard-light, as scoreSemis below MA_WINDOW)
    baseOffset: HIGH_WINDOW_SHORT - 1,
    bands: { amber: cuts.amber, red: cuts.red, firesHighward: false },
    classify: (i, v, ddAmber, ddRed) => {
      const hi = maxOf(v, i - HIGH_WINDOW_SHORT + 1, i);
      const dd = at(v, i) / hi - 1;
      const ma50 = mean(v, i - MA_SHORT + 1, i);
      const belowMA = at(v, i) < ma50;
      if (dd <= ddRed! && belowMA) return "RED";
      if (dd <= ddAmber! && belowMA) return "AMBER";
      return "GREEN";
    },
    // The scored decision variable IS the drawdown `dd = close ÷ 63d-rolling-high − 1`,
    // captured per day (reusing the SAME maxOf rolling-high seam as `classify` above — the
    // gate condition is separate) so the read path (api/series.ts) can plot the drawdown
    // line + this detector's own band lines without re-deriving the rolling high.
    decisionOf: (i, v) => at(v, i) / maxOf(v, i - HIGH_WINDOW_SHORT + 1, i) - 1,
  });
}

export function scoreDownsideBreak(indicator: Indicator, closes: Observation[]): Reading {
  const minLen = HIGH_WINDOW_SHORT + CONFIRM_CLOSES; // enough closes for ≥CONFIRM_CLOSES raw states
  return latest(indicator, downsideBreakReadingSeries(indicator, closes), minLen, closes.length, "closes");
}

/**
 * Rel-strength breakdown — full per-day `Reading[]` over the `num/SPY` ratio: spread = ratio ÷
 * its own trailing MA`maWindow` − 1, AMBER at/below the amber cut, RED at/below red; a null leg
 * NEVER fires (the `!= null` guard is load-bearing — `s <= null` coerces to `s <= 0`). Row per id
 * via `rsCuts` (RS_SMH/RS_XLK: MA50 ew legs; F6: MA200 engine member); the `cuts` parameter is
 * injectable for tests ONLY — prod always resolves the module table. `level` = the ratio;
 * `decisionOf` = the spread (the persisted decision column the detail chart plots). Dual-input,
 * inner-joined on date (alignByDate). `< maWindow` aligned closes → [] (cold-start safe). Pure.
 */
export function relStrengthBreakReadingSeries(
  indicator: Indicator,
  numCloses: Observation[],
  spyCloses: Observation[],
  cuts: RsCuts = rsCuts(indicator.id),
): Reading[] {
  const { dates, a: n, b: m } = alignByDate(numCloses, spyCloses);
  const ratio = n.map((v, i) => v / at(m, i));
  const { maWindow, amber, red } = cuts;
  const spreadAt = (i: number, v: number[]) => at(v, i) / mean(v, i - maWindow + 1, i) - 1;
  // LOW-is-bad decline ⇒ firesHighward=false. Guard after the pure length-preserving ratio
  // map — note (a) in ratioReadingSeries' docblock.
  return ratioReadingSeries(indicator, ratio, dates, {
    minLength: maWindow,
    baseOffset: maWindow - 1,
    bands: { amber, red, firesHighward: false },
    classify: (i, v, aB, rB) => {
      const s = spreadAt(i, v);
      if (rB != null && s <= rB) return "RED";
      if (aB != null && s <= aB) return "AMBER";
      return "GREEN";
    },
    decisionOf: spreadAt,
  });
}

export function scoreRelStrengthBreak(indicator: Indicator, num: Observation[], spy: Observation[]): Reading {
  const { a: n } = alignByDate(num, spy);
  const minLen = rsCuts(indicator.id).maWindow + CONFIRM_CLOSES; // enough aligned closes for ≥CONFIRM_CLOSES raw states
  return latest(indicator, relStrengthBreakReadingSeries(indicator, num, spy), minLen, n.length, "aligned closes");
}

/** EXSH_GATE's constants row widened off the descriptor's `as const` literals (so a test can inject a cut). */
export type ExshGateCuts = { readonly [K in keyof typeof EXSH_GATE_DESCRIPTOR.scorer.constants]: number };

/**
 * EXSH_GATE — the held EU-Fin fund's 3-check re-entry gate ([USER] rule B, 2026-10-06) as a full per-day
 * `Reading[]`. Inputs EXSH.DE (the fund) and EXSA.DE (its STOXX Europe 600 parent), inner-joined on date
 * (`alignByDate`) so all three checks read ONE date grid. Rule (cuts + windows on `EXSH_GATE_DESCRIPTOR`,
 * whose docblock carries the edge convention): RED iff the close's spread vs its MA`trendWindow` is at/below
 * `red`; else AMBER iff the close's spread vs its MA`maShortWindow` is at/below `amberMa` OR the EXSH/EXSA
 * ratio's spread vs its own MA`rsWindow` is at/below `amberRs`; else GREEN. The RED leg rides the band seam
 * (`resolveBands`, the same pair the registry `derived` block draws); the two AMBER legs are the descriptor's
 * own pure crosses — there is no amber band on the plotted value. `level` = the EXSH close (the detail
 * chart's MA overlays read it); `decision` = close % vs MA`trendWindow`, so RED coincides with the value's
 * red band. `< trendWindow` aligned closes → [] (guard-light, as its two retired predecessor rows were).
 * `cuts` is injectable for tests ONLY — prod always reads the descriptor. Pure: no IO.
 */
export function exshGateReadingSeries(
  indicator: Indicator,
  exshCloses: Observation[],
  exsaCloses: Observation[],
  cuts: ExshGateCuts = EXSH_GATE_DESCRIPTOR.scorer.constants,
): Reading[] {
  const { dates, a: close, b: parent } = alignByDate(exshCloses, exsaCloses);
  const ratio = close.map((v, i) => v / at(parent, i));
  const { trendWindow, red, maShortWindow, amberMa, rsWindow, amberRs } = cuts;
  const spreadAt = (v: number[], i: number, w: number) => at(v, i) / mean(v, i - w + 1, i) - 1;
  return ratioReadingSeries(indicator, close, dates, {
    minLength: trendWindow,
    baseOffset: trendWindow - 1,
    bands: { amber: null, red, firesHighward: false },
    classify: (i, v, _aB, rB) => {
      if (rB != null && spreadAt(v, i, trendWindow) <= rB) return "RED";
      if (spreadAt(v, i, maShortWindow) <= amberMa || spreadAt(ratio, i, rsWindow) <= amberRs) return "AMBER";
      return "GREEN";
    },
    decisionOf: (i, v) => spreadAt(v, i, trendWindow),
  });
}

/**
 * NVDA vs its own MA200 — the gate that already arms F4's Red (scoreSemis trips Red
 * only when NVDA < its MA200). Surfaced as a standalone CONTEXT indicator so that
 * gate is visible day-by-day via the detail chart's state ribbon. Driven off NVDA's
 * `derived` ("maSpread" vs 0) with `confirm: false`: the displayed state mirrors the
 * RAW latest-day comparison the gate actually uses, so there is NO CONFIRM_CLOSES
 * buffer (rawState === state) and it never goes RED (red band is null; CONTEXT never
 * fires). Returns the FULL per-day series; scoreNvdaGate takes the last. Guard-light
 * (mirrors derivedRawStateSeries): returns [] under MA_WINDOW obs rather than
 * throwing — the throw now lives in scoreNvdaGate via `latest`.
 *
 * ⚠ "Mirrors the gate" is true for the WINDOW and the buffer, NOT for the edge: the card
 * classifies through `classifyDerived`'s INCLUSIVE LOW branch while F4's Red gate below
 * (`n[i]! < nvdaMA`) and `gates.ts`'s `belowMAFlags` stay STRICT, so on a `close === MA200`
 * day the ribbon reads AMBER and the gates read "not below". RULED INTENTIONAL 2026-08-09
 * [USER] — a card warns on touch, a gate trips only on breach; do NOT align them as a
 * cleanup. See `classifyDerived`'s docblock.
 */
export function nvdaGateReadingSeries(indicator: Indicator, nvda: Observation[]): Reading[] {
  return derivedReadingSeries(indicator, nvda, false);
}

export function scoreNvdaGate(indicator: Indicator, nvda: Observation[]): Reading {
  // No confirm buffer, so the min history is just MA_WINDOW (not +CONFIRM_CLOSES).
  return latest(indicator, nvdaGateReadingSeries(indicator, nvda), MA_WINDOW, nvda.length);
}

// --- GT global trend + GB global breadth (slice 1b Stage 5, GLOBAL channel) --
//
// Re-points the T1 dial's Trend family off the US-tech proxy (F4/F5/NVDA) onto a
// GLOBAL trend read: GT = ACWI (all-country world index) vs its own MA200; GB =
// breadth participation across seven region/style ETFs. F4/F5/NVDA STAY in
// ALL_INDICATORS (still scored via PRICE_SCORERS, still feeding the slow track + veto
// panel) — only the dial's trend FAMILY MEMBERSHIP re-points (GLOBAL_FAMILIES). Both
// feed ONLY the dial via GLOBAL_FAMILIES; GLOBAL is isolated from the verdict/notify/
// status. Unlike the capped US-tech proxy, GT is the REAL leading global trend leg, so
// it carries a real RED band (GT_RED, not NVDA's `red:null`).

// GT_AMBER/GT_RED live on `GT_DESCRIPTOR` (family-descriptor-rows.ts, Stage 2b.3); `registry.ts`
// reads them from there, this file only re-exports them.

/**
 * GT global trend as a FULL per-day Reading[] series (oldest→newest): ACWI's close vs
 * its own MA200 (the `maSpread` decision variable), folded through the CONFIRM_CLOSES
 * buffer. Reuses the generic `derivedReadingSeries`/maSpread machinery (the NVDA-gate
 * precedent) — the GT_AMBER/GT_RED bands are wired via the registry `derived` descriptor
 * — but with `confirm:true` (like oil / the other GLOBAL feeds) and a REAL red band, so
 * GT can go RED. Guard-light (returns [] under MA_WINDOW obs). Pure: no IO.
 */
export function globalTrendReadingSeries(indicator: Indicator, acwi: Observation[]): Reading[] {
  return derivedReadingSeries(indicator, acwi, true);
}

export function scoreGlobalTrend(indicator: Indicator, acwi: Observation[]): Reading {
  const minObs = MA_WINDOW + CONFIRM_CLOSES; // enough days for ≥CONFIRM_CLOSES raw states to confirm
  return latest(indicator, globalTrendReadingSeries(indicator, acwi), minObs, acwi.length);
}
