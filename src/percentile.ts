/**
 * Zero-import percentile leaf. Three of these pure stats helpers + `PCT_MIN_OBS` lived in
 * `slow.ts` until 2026-08-08 (CG level leg, R2); `smaDeviation` was BORN here the same day
 * (the CG detrend).
 *
 * NOTHING is imported here, deliberately: this file must stay safe for any node of the
 * scorer DAG to depend on. `slow.ts` re-exports all four symbols, so no pre-existing
 * caller changed (`synth-cuts.ts`, `api/series.ts`, the test suites).
 */

/**
 * Linear-interpolated quantile (type-7, numpy/Excel default) over an ASCENDING
 * sorted array. `p` in [0, 1]. Empty → NaN.
 */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

/**
 * Minimum PRE-t observations before an expanding percentile is meaningful: one
 * trading year. An 85th/95th taken on less is noise, and these cuts fire the notify
 * path — so the primitive degrades to NaN rather than to a confident-looking number
 * read off twenty points. Callers gate on `Number.isFinite`.
 */
export const PCT_MIN_OBS = 252;

/**
 * Point-in-time (expanding-window) percentile — the look-ahead-clean cut the
 * calibration path needs for the ids with NO harness vintage (F3/F11 today — F9 LEFT
 * the seam 2026-08-08 for a rolling-σ z; whose
 * `registry.ts` thresholds are hand-typed `PRIORS — uncalibrated`). Those now
 * resolve through `CALIB_MAP` (`synthPriors`, Stage 6.2b) with the PRIOR as the injected
 * value; Stage 6.3 swaps in this percentile. It is ALSO the cut source for CG's scored
 * level leg (`ratioSpreadReadingSeries`, since 2026-08-08) and for the per-point band
 * cuts `api/series.ts` emits.
 *
 * Mirrors `expandingZ`'s convention exactly: `pct_t = quantile(values_{<t}, p)`,
 * computed strictly from PRE-t observations, so the value on day t is exactly the
 * cut a live run would have seen that day — no in-sample leakage. This makes the
 * house rule ("apply point-in-time, NOT as a fixed full-sample quantile" —
 * `calibration.json`'s own `notes`) the implementation rather than a caveat
 * attached to a full-sample number.
 *
 * `NaN` until `minObs` (default `PCT_MIN_OBS`; ECY passes its monthly-aware `ECY_MIN_OBS`)
 * prior observations exist.
 *
 * ⛔ NON-FINITE INPUTS ARE SKIPPED, never inserted (2026-08-08, the CG detrend). A NaN in
 * `sorted` breaks the binary search's ordering invariant and corrupts EVERY later quantile —
 * and `smaDeviation` below yields exactly that: `window − 1` leading NaNs. Skipping means the
 * min-obs count is a count of FINITE observations, so the first finite cut lands at
 * `(first finite index) + PCT_MIN_OBS`. The day itself also emits NaN, so a non-finite value
 * can never be scored against a finite cut (`percentileLevelState` throws rather than
 * silently returning GREEN).
 *
 * There is deliberately NO Python twin (Stage 6.1):
 * the retired `stats.py` had no percentile counterpart — `percentile_ci` was an unrelated
 * bootstrap CI — and unlike `expanding_z`, which the retired `harness.py` called (it survives
 * as `scripts/backtest/expanding-z.ts`), nothing offline would have called this. A twin would
 * have been dead Python maintained solely to be compared against.
 */
export function expandingPercentile(values: readonly number[], p: number, minObs: number = PCT_MIN_OBS): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const sorted: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sorted.length >= minObs) out[i] = quantile(sorted, p);
    // Insert AFTER reading the cut — including values[i] would leak day t into its
    // own threshold, the look-ahead this function exists to prevent.
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      out[i] = NaN;
      continue;
    }
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, v);
  }
  return out;
}

/**
 * ROLLING-window analog of `expandingPercentile`: `pct_t = quantile(finite values in [t−window, t), p)`,
 * strictly PRE-t, NaN until `minObs` finite predecessors sit in the window. Non-finite inputs skipped,
 * never counted — the same look-ahead-clean convention (the measurement-arm twin `detrendedRollingRank` went with
 * `derive-oat-cuts.ts` 2026-09-04; this is the runtime one).
 */
export function rollingPercentile(
  values: readonly number[],
  p: number,
  window: number,
  minObs: number = PCT_MIN_OBS,
): number[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`rollingPercentile: window must be a positive integer, got ${window}`);
  }
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const buf: number[] = [];
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]!;
      if (Number.isFinite(v)) buf.push(v);
    }
    if (buf.length < minObs) continue;
    buf.sort((a, b) => a - b);
    out[i] = quantile(buf, p);
  }
  return out;
}

/**
 * DEVIATION FROM OWN TRAILING TREND: `values[i] / mean(values[i−window+1 … i]) − 1`, i.e. how
 * far above (+) or below (−) its own `window`-observation simple moving average each point sits.
 * The first `window − 1` entries are `NaN` — the SMA has no full window there — which is the
 * convention `expandingPercentile` above is explicitly NaN-safe for.
 *
 * WHY IT LIVES HERE (2026-08-08): CG's level leg scores
 * this deviation rather than the raw HG÷GC level, because a non-stationary level sits under any
 * low percentile of any long window once it drifts (gold's 2024–26 run pinned CG at a permanent
 * AMBER). The scored scalar (`ratioSpreadReadingSeries`) and the DRAWN cut (`api/series.ts`,
 * which back-transforms the cut to ratio units for the primary axis) must be the same detrend,
 * so the expression sits once, in this zero-import stats leaf, and both import it.
 *
 * `window < 1` is a caller bug, not a degrade: it would make the mean of an empty window.
 *
 * ⚠ NON-FINITE INPUTS POISON THE WHOLE TAIL, not just the overlapping window: the running sum
 * carries forward, and once `NaN`/`±Infinity` enters it no later subtraction removes it, so every
 * subsequent output is non-finite. Callers owe finite `values` — this is documented rather than
 * guarded so the hot loop stays a single pass (a scan would be a second one).
 */
export function smaDeviation(values: readonly number[], window: number): number[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`smaDeviation: window must be a positive integer, got ${window}`);
  }
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]!;
    if (i >= window) sum -= values[i - window]!;
    if (i >= window - 1) out[i] = values[i]! / (sum / window) - 1;
  }
  return out;
}

/**
 * Percentile RANK of `x` within an ASCENDING `sorted` array: the fraction of values
 * `≤ x`, ∈ (0, 1] when `x` is a member. This is the continuous "how far into the
 * distribution" measure the scorers expose as `metric` — distinct from `quantile`,
 * which returns the threshold VALUE at a given fraction. Empty → NaN.
 */
export function percentileRank(sorted: readonly number[], x: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  let count = 0;
  for (const v of sorted) if (v <= x) count++;
  return count / n;
}

/** One history-ranking site: which of the two rankers it uses, and over what. */
export interface RankerSite {
  /** Symbol SOURCE, not window shape: `expanding` = `percentile.ts` helpers (which host BOTH
   *  `expandingPercentile` AND rolling `rollingPercentile`); `rolling-ecdf` = `leg-percentile.ts`. */
  readonly ranker: "expanding" | "rolling-ecdf";
  /** The constant that sizes the ranker's window (`ECY_MIN_OBS` = ECY's monthly-aware floor). */
  readonly via: "PCT_MIN_OBS" | "ECY_MIN_OBS" | "BULL_MIN_OBS" | "ECDF_WINDOW" | "BREADTH_CUT_WINDOW";
  /** Non-test files that import a ranker symbol for this site. */
  readonly files: readonly string[];
  /** What is ranked against its own history here. */
  readonly ranks: string;
}

/**
 * ANSWER KEY — every "where does this value sit in its own history" site and its ranker.
 *
 * ⚠ **DATA ONLY — nothing ranks through this table.** `ranker` labels the symbol SOURCE, not the
 * window shape: `expanding` = the `percentile.ts` helpers (which host BOTH `expandingPercentile`,
 * min `PCT_MIN_OBS` obs, AND `rollingPercentile` — so a rolling-window level cut, memberless since
 * 2026-09-04, would sit under this label via `levelBandCuts`), `rolling-ecdf` = `leg-percentile.ts` (newest `ECDF_WINDOW` closes).
 * The two SOURCES must NOT be merged — they answer different questions and collapsing them moves the
 * board. `percentile.sites.test.ts` is the half that works: it reads
 * each listed file's real imports, and pins COMPLETENESS — a ranker import anywhere under `src/`,
 * `api/` or `scripts/` that is not named here fails, INCLUDING one imported through `slow.ts`'s
 * re-export of these symbols (the walk resolves that hop; direct-specifier matching alone hid six
 * sites until 2026-08-09).
 */
export const RANKER_BY_SITE = {
  cgLevelBand: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["src/scorers-composite.ts"],
    ranks: "the per-day level-leg cut of a ratio indicator (plain or SMA-detrended); a rolling-window band (memberless since 2026-09-04) would be `rollingPercentile` under this same `percentile.ts` source label",
  },
  bullSteepenerCuts: {
    ranker: "expanding",
    via: "BULL_MIN_OBS",
    files: ["src/scorers-composite.ts", "scripts/probe-r7-cuts.ts"],
    ranks: "R7's two legs - Δ20(2y) low tail and Δ20(steepening) high tail - each over a trailing BULL_CUT_WINDOW-day tail (`rollingPercentile`, still a `percentile.ts` symbol under this same source label)",
  },
  dispCorrP90: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["src/scorers-composite.ts", "api/series.ts", "scripts/probe-disp-grade.ts"],
    ranks:
      "DISP's mean pairwise corr against its own ROLLING `DISP_CORR_P_WINDOW` tail (`rollingPercentile`, " +
      "informative-masked) — the B2 deepener that lifts AMBER to RED; the read path re-ranks the SAME stored column",
  },
  ecyExpensiveCut: {
    ranker: "expanding",
    via: "ECY_MIN_OBS",
    files: ["src/scorers-composite.ts"],
    ranks: "each joined month's ECY against its own strict-prefix history - the scored rank (`decision`; `level` is ECY%)",
  },
  capeCardBands: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["api/indicators.ts"],
    ranks: "F7/CAPE's display-only p80/p95 band lines over its own stored monthly history",
  },
  slowTrack: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["src/slow.ts"],
    ranks: "QQQ price acceleration and the VIX complacency leg, over the closes passed in",
  },
  seriesApiBandCuts: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["api/series.ts"],
    ranks: "the DRAWN level-band cut - same helper as the scored one; a rolling-window band (memberless since 2026-09-04) routes through `levelBandCuts`, still a `percentile.ts` symbol",
  },
  sigmaCusumProbe: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["scripts/probe-sigma-cusum-candidacy.ts"],
    ranks: "the percentile baseline a candidate σ-z leg is measured against",
  },
  synthPriorCuts: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["src/synth-cuts.ts", "scripts/emit-synth-cuts.ts"],
    ranks:
      "the point-in-time 85th/95th level+velocity cuts for the synth-prior ids - computed in `synth-cuts.ts`, " +
      "reported by the golden emitter under the same min-obs warmth gate",
  },
  exposureArm: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["src/exposure.ts"],
    ranks: "today's F1 value against its own trailing `ARM_RANGE_WINDOW` of closes - the exposure arm's grind-up leg",
  },
  backtestCuts: {
    ranker: "expanding",
    via: "PCT_MIN_OBS",
    files: ["scripts/backtest/f1-percentile-cuts.ts", "scripts/backtest/event-study.ts"],
    ranks: "OFFLINE cut boundaries - HY OAS p66/p90 level+velocity, and the event study's EBP-calm terciles",
  },
  legPillarEcdf: {
    ranker: "rolling-ecdf",
    via: "ECDF_WINDOW",
    files: ["src/lab-served-field.ts", "scripts/probe-leg-percentile-depth.ts"],
    ranks: "today's EARLY-WARN pillar value against that leg's stored `leg_pillars` history",
  },
  dangerCeilingEcdf: {
    ranker: "rolling-ecdf",
    via: "ECDF_WINDOW",
    files: ["scripts/probe-danger-cut-percentile.ts"],
    ranks:
      "OFFLINE - each leg-close's `danger` against that leg's strict-prior window, the transformed-scale arm " +
      "of the CDF-normalisation measurement",
  },
  breadthBand: {
    ranker: "expanding",
    via: "BREADTH_CUT_WINDOW",
    files: ["src/scorers-price.ts"],
    ranks:
      "F5/SPCONC breadth - each day's strict-prior distance-from-high (`breadthDistSeries`) against its ROLLING " +
      "its OWN config window (F5 `BREADTH_CUT_WINDOW`, SPCONC 126 since the 2026-08-30 split), via the one shared `breadthCutSeries`; the fire-rate probe re-ranks the SAME `dist` array",
  },
} as const satisfies Record<string, RankerSite>;
