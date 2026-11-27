/**
 * Slow "bubble-state" track (Phase 3 Stage 1) — a mechanical
 * Minsky/Kindleberger fuel composite, running alongside the fast
 * OK/WATCH/WARNING/CRITICAL ladder.
 *
 * This module is pure (no IO, no time): every function takes already-fetched
 * series and returns plain data, and it imports NOTHING from `ladder.ts`. Its
 * *verdict* surface is disjoint from the fast band — the slow track speaks
 * CALM/ELEVATED/DE-RISK, not AlertLevel, and lives on its own notification tier.
 *
 * ⚠ It is NOT isolated in the export direction, despite what this header claimed
 * until 2026-07-20: `synth-cuts.ts` imports `expandingPercentile` + `PCT_MIN_OBS`
 * through here, and the run loop (`run-cycle-fred.ts`/`run-dbfirst.ts`) calls `synth-cuts.ts` on the cron notify path; since
 * 2026-08-08 CG's scored level leg reads `expandingPercentile` too. Those stats
 * helpers therefore DO move the fast verdict — change them as shared infrastructure,
 * not as slow-track internals. They now LIVE in `./percentile.js` (see §Helpers).
 *
 * Stage 1 scope (archived):
 * two indicators, each 0–2 —
 *   1. Price acceleration — QQQ ~63-trading-day return vs its own percentile.
 *   2. Complacency — VIX in its bottom decile + QQQ near its 252-day high.
 * Their sum maps to a proportional band with a rollout guard (see classifyBand).
 * Stage 2+ adds margin-debt / IPO / breadth / put-call; the activeCount-driven
 * band math already generalises to more indicators.
 *
 * NOTE on the data window: the QQQ percentile/high use only the closes passed in
 * (a shallow `fetchDailyCloses` call's fixed 2-year window ≈ 440 trading days). A longer history is a
 * later upgrade; the limitation is documented, not hidden.
 */

import {
  type Observation,
  type State,
  CONFIRM_CLOSES,
} from "./domain-types.js";
import { deriveConfirmedState } from "./domain-fold.js";
import type { StoredReading } from "./store.js";
import { quantile, percentileRank } from "./percentile.js";
import { isoDay } from "./dates.js";

// --- Tunable constants -----------------------------------------------------

/** Price-acceleration: ~3-month (trading-day) trailing return window. */
export const ACCEL_WINDOW = 63;
/** Need ≥30 trailing returns for a non-degenerate percentile (live ~2y ≈ 440). */
const MIN_ACCEL_OBS = ACCEL_WINDOW + 30;
/** Return percentiles that score the price-acceleration leg 1 / 2. */
export const ACCEL_AMBER_PCTILE = 0.8; // ≥80th → 1
export const ACCEL_RED_PCTILE = 0.95; // ≥95th → 2

/**
 * Complacency: ~12-month rolling-high window for the "near the high" leg. Named
 * with the SLOW_ prefix to avoid a collision with family-descriptor-rows.ts's own
 * HIGH_WINDOW (Stage B's run.ts imports from both modules).
 */
export const SLOW_HIGH_WINDOW = 252;
/** "Near the high" = within this fraction of the 252-day high. */
export const NEAR_HIGH_FRAC = 0.98;
/** Persistence: the near-high leg scores 1 iff ≥ PERSIST_M of the last PERSIST_N closes
 * are within NEAR_HIGH_FRAC of their own trailing 252d high (ruled 2026-08-15). */
export const PERSIST_M = 15;
export const PERSIST_N = 21;
/** VIX "bottom decile" cut. */
export const VIX_LOW_PCTILE = 0.1;
/** Need a usable window for a 10th-percentile VIX cut. */
export const MIN_VIX_OBS = 60;

/**
 * Duration-of-calm (T3.2) — UNVALIDATED starting prior, backtest-gated (Phase-2).
 *
 * A distinct, HIGHER cut than `VIX_LOW_PCTILE=0.1`: the bottom-decile cut is far too
 * strict to sustain a multi-month RUN (VIX only rarely sits in its own 10th percentile,
 * so a 63-day run below it is ~impossible). The median (`0.5`) defines the "calm regime"
 * whose PERSISTENCE — not its depth — is the fragility signal. These two constants are
 * unvalidated priors; the §6 backtest must sweep `SLOW_CALM_PCTILE × SLOW_CALM_RUN_MIN`
 * (e.g. 63 vs 126) before they are trusted.
 */
export const SLOW_CALM_PCTILE = 0.5; // VIX ≤ its own median = "calm regime"
export const SLOW_CALM_RUN_MIN = 63; // ~3mo sustained calm (trading days); deliberately conservative

/** Proportional band ratios (ratio = score / (2 × activeCount)). */
const ELEVATED_RATIO = 0.5; // ≥0.50 → ELEVATED
const DE_RISK_RATIO = 0.75; // ≥0.75 → DE-RISK (once enough indicators exist)
/**
 * Rollout guard: until at least this many indicators are active, DE-RISK requires
 * ALL active indicators maxed (score === 2 × activeCount) rather than the plain
 * ≥0.75 ratio — avoids a hair-trigger DE-RISK off one strong leg when only a
 * couple of collinear indicators exist. With 2 active (max 4): CALM 0–1,
 * ELEVATED 2–3, DE-RISK 4.
 */
const ROLLOUT_MIN_ACTIVE = 4;

// --- Types -----------------------------------------------------------------

/** A single 0–2 bubble-fuel contributor. */
export interface SlowComponent {
  id: string; // "price-accel" | "complacency" | "complacency-vix" | "complacency-high"
  label: string;
  score: 0 | 1 | 2;
  /**
   * The CONTINUOUS value behind the score — the percentile rank (price-accel,
   * complacency-vix) or distance fraction (complacency-high), ∈ [0, 1]. Persistence
   * writes it to `readings.value` (the schema's "level"); the score/state are
   * derivations. OPTIONAL on purpose: the rolled-up `complacency` scored component
   * has no single metric, and `notify_tier.test.ts`'s SlowComponent fixtures omit it
   * — a required field would break those at compile. Absent ⇒ persistence falls back
   * to `score` (see `slowStoredReadings`).
   */
  metric?: number;
}

/**
 * The slow band. Display name for ELEVATED is "ELEVATED-BUBBLE-STATE";
 * the enum value is kept short for code/persistence. Deliberately disjoint from
 * the fast AlertLevel so the two tracks can never be confused.
 */
export type SlowBand = "CALM" | "ELEVATED" | "DE-RISK";

export interface SlowVerdict {
  band: SlowBand;
  score: number; // Σ component scores
  activeCount: number; // # of indicators present
  maxScore: number; // 2 × activeCount
  ratio: number; // score / maxScore (0 when no active indicators)
  components: SlowComponent[]; // SCORED set [price-accel, complacency] — drives band + notify
  /**
   * OBSERVABILITY set [price-accel, complacency-vix, complacency-high] — `complacency`
   * split into its two binary legs for per-id persistence/charting. Optional so
   * hand-built `SlowVerdict` test literals (which only exercise the notify path) keep
   * compiling; `computeSlowVerdict` always populates it, and the persistence call site
   * falls back to `components` when absent.
   */
  observability?: SlowComponent[];
  /**
   * T3.2 duration-of-calm signal — `true` when VIX has sat at/below its median for a
   * confirmed run ≥ SLOW_CALM_RUN_MIN. Derived ONLY from the duration-of-calm leg; it NEVER
   * touches the slow band/score/ratio (those stay a pure roll-up of the SCORED `components`).
   * Default `false`. Stage 5 threads this to floor the FAST verdict OK→WATCH; here it is
   * computed-but-inert (this leg is unwired — verdict-invisible).
   *
   * OPTIONAL for the same reason as `observability`: hand-built `SlowVerdict` test literals
   * (notify_tier.test.ts, dashboard.notify.test.ts) exercise only the notify path and omit it — a
   * required field would break those at compile. `computeSlowVerdict` ALWAYS populates it
   * (defaulting to `false`); read sites treat absent as `false`.
   */
  fragileCalm?: boolean;
  /**
   * D-B — QQQ distance-to-252d-high fraction (∈(0,1], →1 = at the high), carried through
   * from `scoreSlow` so the divergence escalator (alert-band.ts) can read it off the slow
   * track without re-scoring. Band/score/ratio never touch it. OPTIONAL for the same reason
   * as `observability`/`fragileCalm`: hand-built `SlowVerdict` test literals omit it;
   * `computeSlowVerdict` populates it when passed, read sites treat absent as `null`.
   */
  spDistToHigh?: number;
}

// --- Helpers ---------------------------------------------------------------

/**
 * `quantile` / `PCT_MIN_OBS` / `expandingPercentile` / `percentileRank` MOVED to the
 * zero-import leaf `./percentile.js` on 2026-08-08 (CG level leg, R2) and are re-exported
 * here so every pre-existing caller keeps its import site; import the defining file.
 * Their docblocks moved with them — edit them there.
 * `PCT_MIN_OBS` certifies depth, not regime: check the window SPANS a stress event (F10 keyless = ~3y benign credit).
 */
export { quantile, PCT_MIN_OBS, expandingPercentile, percentileRank } from "./percentile.js";

// --- Scorers (each 0–2) ----------------------------------------------------

/**
 * Price acceleration (bubble fuel): the latest ~63-trading-day QQQ return vs the
 * percentile of all such returns over the available window. High sustained
 * momentum is late-cycle fuel. 0 if `<80th`, 1 if `≥80th`, 2 if `≥95th`. The
 * latest return is included in its own reference distribution ("its own
 * percentile over the available window"). Pure: no IO.
 */
export function scorePriceAccel(qqq: Observation[]): SlowComponent {
  if (qqq.length < MIN_ACCEL_OBS) {
    throw new Error(`[price-accel] need ${MIN_ACCEL_OBS} closes, got ${qqq.length}`);
  }
  const closes = qqq.map((o) => o.value);
  const returns: number[] = [];
  for (let i = ACCEL_WINDOW; i < closes.length; i++) {
    returns.push(closes[i]! / closes[i - ACCEL_WINDOW]! - 1);
  }
  const latest = returns[returns.length - 1]!;
  const sorted = [...returns].sort((a, b) => a - b);
  const red = quantile(sorted, ACCEL_RED_PCTILE);
  const amber = quantile(sorted, ACCEL_AMBER_PCTILE);
  const score: 0 | 1 | 2 = latest >= red ? 2 : latest >= amber ? 1 : 0;
  // Continuous metric: the percentile RANK of the latest return in its own distribution
  // (the cuts above are threshold VALUES, not the rank — this is a NEW computation, not a
  // discarded one). Forensic payload behind the 0/1/2 step. Score logic unchanged.
  const metric = percentileRank(sorted, latest);
  return { id: "price-accel", label: "Price acceleration (QQQ 63d return %ile)", score, metric };
}

/**
 * Complacency (bubble fuel): VIX sitting in its own bottom decile AND/OR QQQ
 * persistently near its 252-day high (≥ PERSIST_M of the last PERSIST_N closes within
 * `NEAR_HIGH_FRAC` of their own rolling high). Each leg is one point → 0 / 1 / 2.
 * Two collinear facets of one state, so they ADD (one 0–2 contributor) rather
 * than AND-gate (the rev2 anti-double-count fix). Params follow the (qqq, vix)
 * order shared by scorePriceAccel/scoreSlow — Observation[] is untyped by
 * series, so a consistent order is the only guard against a swapped call. Pure.
 *
 * Returns BOTH the rolled-up scored `component` (the one 0–2 contributor the band
 * math + notify consume — unchanged) AND its two binary `legs` carrying the
 * continuous metrics, for persistence/charting only. One computation; the legs ride
 * alongside the score and never feed the verdict. `distFraction` (QQQ as a fraction of
 * its trailing 252d high, ∈(0,1], →1 = at the high) is surfaced top-level as the SAME
 * value the near-high leg's `metric` carries (single-sourced) — the D-B divergence
 * escalator (alert-band.ts) reads it, so it must not be dredged from the leg by id.
 */
export function scoreComplacency(
  qqq: Observation[],
  vix: Observation[],
): { component: SlowComponent; legs: SlowComponent[]; distFraction: number } {
  if (vix.length < MIN_VIX_OBS) {
    throw new Error(`[complacency] need ${MIN_VIX_OBS} VIX closes, got ${vix.length}`);
  }
  const minQqq = SLOW_HIGH_WINDOW + PERSIST_N - 1;
  if (qqq.length < minQqq) {
    throw new Error(`[complacency] need ${minQqq} QQQ closes, got ${qqq.length}`);
  }

  const vixCloses = vix.map((o) => o.value);
  const vixLatest = vixCloses[vixCloses.length - 1]!;
  const vixSorted = [...vixCloses].sort((a, b) => a - b);
  const vixLow = vixLatest <= quantile(vixSorted, VIX_LOW_PCTILE);
  // Metric for the VIX leg: where the latest VIX sits in its own distribution (low ⇒
  // complacent). NOT derived by the score path — a new rank search.
  const vixPctile = percentileRank(vixSorted, vixLatest);

  const qCloses = qqq.map((o) => o.value);
  const qLatest = qCloses[qCloses.length - 1]!;
  // m-of-n persistence: each of the last PERSIST_N days is judged against its OWN
  // trailing 252d high (a per-day rolling high), never today's high for all N.
  let within = 0;
  let high = 0; // today's trailing high — set on the loop's final pass
  for (let j = qCloses.length - PERSIST_N; j < qCloses.length; j++) {
    let h = qCloses[j - SLOW_HIGH_WINDOW + 1]!;
    for (let i = j - SLOW_HIGH_WINDOW + 2; i <= j; i++) {
      if (qCloses[i]! > h) h = qCloses[i]!;
    }
    if (qCloses[j]! >= NEAR_HIGH_FRAC * h) within++;
    if (j === qCloses.length - 1) high = h;
  }
  const nearHigh = within >= PERSIST_M;
  // Metric for the near-high leg: QQQ as a fraction of its 252-day high (→1 ⇒ at the
  // high). One new line alongside the existing boolean.
  const distFraction = qLatest / high;

  const score = ((vixLow ? 1 : 0) + (nearHigh ? 1 : 0)) as 0 | 1 | 2;
  const component: SlowComponent = {
    id: "complacency",
    label: "Complacency (low VIX + near 252d high)",
    score,
  };
  // Each leg is binary (0/1) ⇒ its persisted state is GREEN or AMBER, never RED.
  const legs: SlowComponent[] = [
    {
      id: "complacency-vix",
      label: "Complacency - VIX percentile",
      score: (vixLow ? 1 : 0),
      metric: vixPctile,
    },
    {
      id: "complacency-high",
      label: "Complacency - distance to 252d high",
      score: (nearHigh ? 1 : 0),
      metric: distFraction,
    },
  ];
  return { component, legs, distFraction };
}

/**
 * Duration-of-calm (T3.2, bubble fuel) — UNVALIDATED starting prior, backtest-gated.
 *
 * The FRAGILITY of a *prolonged* low-vol regime: how long VIX has sat continuously at or
 * below its own median. A sustained run (≥ SLOW_CALM_RUN_MIN trading days) is the "fragile
 * calm" a vol-of-vol / Minsky read flags — persistence, not depth, is the signal (hence the
 * median cut, NOT the strict bottom-decile `VIX_LOW_PCTILE`). Binary by construction: AMBER
 * is the MAX, never RED (a long calm is elevated fuel, not an active crash).
 *
 * Data-window note: `cut = quantile(vixSorted, SLOW_CALM_PCTILE)` is taken over the SAME
 * whole array of passed closes that `scoreComplacency` uses (the shallow `fetchDailyCloses`/FRED 2-year
 * window). The last CONFIRM_CLOSES days therefore sit in the reference distribution that
 * classifies them — a negligible confirm-tail look-ahead, documented exactly as slow.ts's
 * QQQ-window note (module header) already does, not hidden.
 *
 * Pure: no IO, no time. Returns the observability `leg` (never scored into the band) and
 * the `fragileCalm` boolean the fast verdict will later floor on (Stage 5 — NOT here).
 */
export function scoreDurationOfCalm(vix: Observation[]): {
  leg: SlowComponent;
  fragileCalm: boolean;
} {
  const rawStates = durationOfCalmRawStateSeries(vix);
  const confirmedLatest = deriveConfirmedState(rawStates, CONFIRM_CLOSES);
  const fragileCalm = confirmedLatest === "AMBER";

  const leg: SlowComponent = {
    id: "complacency-duration",
    label: "Complacency - duration of calm (VIX run-length below median)",
    score: fragileCalm ? 1 : 0,
    // Continuous metric: progress toward the run threshold (≥1 once sustained), for charting.
    // Reuses the same calm-run helper the raw-state series folds, so it can't drift from `rawStates`.
    metric: calmRunLengths(vix, SLOW_CALM_PCTILE).at(-1)! / SLOW_CALM_RUN_MIN,
  };
  return { leg, fragileCalm };
}

/**
 * Per-day trailing run-length of consecutive VIX closes at/below the `pctile` calm cut.
 * Single forward pass: reset on any close ABOVE the cut (a vol spike breaks the calm), else
 * extend the prior day's run. Shared source for both the raw-state series and the leg metric.
 * Pure: no IO, no time.
 */
function calmRunLengths(vix: Observation[], pctile: number): number[] {
  const closes = vix.map((o) => o.value);
  const sorted = [...closes].sort((a, b) => a - b);
  const cut = quantile(sorted, pctile);
  const runLen: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    runLen[i] = closes[i]! > cut ? 0 : (runLen[i - 1] ?? 0) + 1;
  }
  return runLen;
}

/**
 * Per-day binary calm raw-state series (oldest→newest): AMBER once the trailing calm run reaches
 * `runMin`, else GREEN. Never RED. Extracted (behavior-preserving) from `scoreDurationOfCalm` so the
 * backtest harness can sweep `pctile × runMin` through the REAL scorer (anti-drift: no reimplementation).
 * Production passes the shipped consts via the defaults ⇒ byte-identical to the prior inline body.
 */
export function durationOfCalmRawStateSeries(
  vix: Observation[],
  pctile: number = SLOW_CALM_PCTILE,
  runMin: number = SLOW_CALM_RUN_MIN,
): State[] {
  return calmRunLengths(vix, pctile).map((r) => (r >= runMin ? "AMBER" : "GREEN"));
}

/**
 * Score the slow track once, returning BOTH sets: the SCORED `components`
 * [price-accel, complacency] (verdict/notify input) and the OBSERVABILITY set
 * [price-accel, complacency-vix, complacency-high] (per-id persistence/charting, with
 * complacency split into its legs). Single computation — the run loop feeds the result
 * straight to `computeSlowVerdict`. Pure.
 */
export function scoreSlow(
  qqq: Observation[],
  vix: Observation[],
): { components: SlowComponent[]; observability: SlowComponent[]; fragileCalm: boolean; spDistToHigh: number } {
  const priceAccel = scorePriceAccel(qqq);
  const { component, legs, distFraction } = scoreComplacency(qqq, vix);
  // T3.2 duration-of-calm — an OBSERVABILITY-only leg (appended to `observability`, NOT
  // `components`): the band math stays 2-active, UNCHANGED. `fragileCalm` is surfaced for the
  // Stage-5 fast-verdict floor; it does NOT touch the slow band/score/ratio here.
  // ORDERING DEPENDENCY: `scoreDurationOfCalm` has no min-obs guard of its own — on an empty
  // `vix` it would emit a NaN `metric` into the persisted leg. It relies on `scoreComplacency`
  // above throwing on `vix.length < MIN_VIX_OBS` first (the degrade wrapper then nulls the
  // whole track), so it never sees a short array. Keep this call AFTER scoreComplacency.
  const { leg: durationLeg, fragileCalm } = scoreDurationOfCalm(vix);
  return {
    components: [priceAccel, component],
    observability: [priceAccel, ...legs, durationLeg],
    fragileCalm,
    // D-B — QQQ distance-to-252d-high fraction (∈(0,1], →1 = at the high), surfaced top-level
    // for the divergence escalator (alert-band.ts). Same value as the near-high leg's metric.
    spDistToHigh: distFraction,
  };
}

// --- Band mapping ----------------------------------------------------------

/**
 * Map a composite score to a band, proportional to the active-indicator max.
 * `ratio = score / (2 × activeCount)`: CALM `<0.50` → ELEVATED `≥0.50` →
 * DE-RISK `≥0.75`. Rollout guard: while `activeCount < ROLLOUT_MIN_ACTIVE`,
 * DE-RISK requires the score at the active max (ALL active indicators at 2),
 * reverting to the plain `≥0.75` ratio once enough indicators exist. No active
 * indicators → CALM (degraded slow track). Pure.
 */
export function classifyBand(score: number, activeCount: number): SlowBand {
  if (activeCount <= 0) return "CALM";
  const maxScore = 2 * activeCount;
  const ratio = score / maxScore;
  const deRisk =
    activeCount < ROLLOUT_MIN_ACTIVE ? score === maxScore : ratio >= DE_RISK_RATIO;
  if (deRisk) return "DE-RISK";
  if (ratio >= ELEVATED_RATIO) return "ELEVATED";
  return "CALM";
}

// --- Persistence mapping (Stage 1B) ----------------------------------------

/**
 * Map a 0–2 slow component score to a fast-track `State` for the `readings` table
 * (which is typed GREEN/AMBER/RED). `0→GREEN`, `1→AMBER`, `2→RED` — decided
 * 2026-06-28. This is purely a persistence/observability
 * convenience: the SLOW channel feeds no alert roll-up, so this state never
 * feeds the fast verdict. Pure.
 */
function scoreToState(score: 0 | 1 | 2): State {
  return score === 2 ? "RED" : score === 1 ? "AMBER" : "GREEN";
}

/**
 * Project the slow components into `readings` rows for persistence + `/api/series`
 * observability: `value` = the continuous metric
 * (percentile rank /
 * fraction ∈ [0,1]) where present, falling back to the 0–2 score for any component
 * without a metric (the rolled-up `complacency`, never emitted via the observability
 * set). `delta20` = 0 on live runs (the backfill fills the real 20-obs change),
 * `state`/`rawState` via scoreToState. The `indicatorId` is the component id, lining
 * up with the `SLOW_INDICATORS` metadata.
 * `asOf` is the newest QQQ close the components were scored through (slow components are themselves
 * date-less; the live caller passes `qqq.at(-1).date`, the backfill each QQQ date). These
 * rows are written in the SAME atomic `record_run` as the fast readings but kept
 * OUT of the fast `readings` array passed to assembleRun/formatRunSummary, so they
 * never pollute the fast alert body or /status panel. Pure.
 */
export function slowStoredReadings(components: SlowComponent[], asOf: string): StoredReading[] {
  return components.map((c) => ({
    date: asOf,
    indicatorId: c.id,
    // The continuous metric IS the schema's "level" (`readings.value` is double
    // precision). Falls back to `score` for any component without a metric (the
    // rolled-up `complacency`, never emitted here once the observability set is wired).
    value: c.metric ?? c.score,
    delta20: 0, // live runs keep the hot path IO-free; the backfill fills real 20-obs deltas
    rawState: scoreToState(c.score),
    state: scoreToState(c.score),
  }));
}

/** Legs whose past-date value moves with the read's left edge (a whole-window percentile/quantile over a fixed-range
 *  read): the gap-fill sweep inserts them but never value-repairs them — a repair would rewrite the window every run. */
export const FETCH_EDGE_SCORED_IDS: ReadonlySet<string> = new Set(["price-accel", "complacency-vix", "complacency-duration"]);

/**
 * Trailing QQQ window, in CALENDAR days, that mirrors the shallow `fetchDailyCloses` 2-year window
 * the daily run scores against. The exact trading-day count drifts a little with the
 * calendar, but the metric is a percentile (robust to a few boundary days); the
 * parity test pins the point-in-time logic itself against this same window.
 */
const SLOW_QQQ_WINDOW_DAYS = 730;

/** ISO date (YYYY-MM-DD) `days` calendar-days before `iso`. UTC-safe. */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDay(d);
}

/**
 * The live-equivalent windows as of date `t`: QQQ trailing ~2 calendar years, VIX the
 * full history ≤ t. Shared by the backfill and its parity test so they cannot drift.
 * Both inputs must be oldest→newest; outputs preserve that order.
 */
export function windowAsOf(
  qqq: Observation[],
  vix: Observation[],
  t: string,
): { qqqWin: Observation[]; vixWin: Observation[] } {
  const qFrom = isoMinusDays(t, SLOW_QQQ_WINDOW_DAYS);
  return {
    // Left boundary exclusive (`> qFrom`): a day exactly 730 days before t is dropped,
    // mirroring the trailing 2-year convention. Right boundary inclusive (≤ t).
    qqqWin: qqq.filter((o) => o.date > qFrom && o.date <= t),
    vixWin: vix.filter((o) => o.date <= t),
  };
}

/**
 * Pure point-in-time projection: one `StoredReading` per (observability id × date) for
 * every QQQ date on/after `cutoff` that has enough trailing history to score. `value`
 * is the continuous metric (via `slowStoredReadings`); `delta20` is the metric's change
 * over 20 emitted observations (0 until 20 exist). No IO, no `run_at` — the caller
 * stamps the vintage. Deterministic given the feeds.
 */
export function slowBackfillRows(
  qqq: Observation[],
  vix: Observation[],
  cutoff: string,
): StoredReading[] {
  const rows: StoredReading[] = [];
  // Per-id metric history (in emitted-date order) for the 20-obs delta lookback.
  const metricHistory = new Map<string, number[]>();

  for (const point of qqq) {
    const t = point.date;
    if (t < cutoff) continue;
    const { qqqWin, vixWin } = windowAsOf(qqq, vix, t);
    // SLOW_HIGH_WINDOW + PERSIST_N − 1 (272) ≥ MIN_ACCEL_OBS (93), so it gates both QQQ scorers.
    if (qqqWin.length < SLOW_HIGH_WINDOW + PERSIST_N - 1 || vixWin.length < MIN_VIX_OBS) continue;

    const observability: SlowComponent[] = scoreSlow(qqqWin, vixWin).observability;
    // Reuse the canonical projection (value=metric, state=scoreToState), then fill the
    // real 20-obs delta the live path leaves at 0.
    for (const row of slowStoredReadings(observability, t)) {
      let past = metricHistory.get(row.indicatorId);
      if (!past) {
        past = [];
        metricHistory.set(row.indicatorId, past); // set once on create; `past` is the live array thereafter
      }
      const prior = past.length >= 20 ? past[past.length - 20]! : undefined;
      rows.push({ ...row, delta20: prior === undefined ? 0 : row.value - prior });
      past.push(row.value);
    }
  }
  return rows;
}

// Notify-on-band-change moved to the generic NotifyTier (notify_tier.ts) +
// SLOW_TIER spec (slow_tier.ts): tracks.ts calls buildTierNotification
// over SLOW_TIER. The slow band's rank/tag/priority now live once in SLOW_TIER.bands.

/**
 * Roll the 0–2 SCORED components into a slow verdict. The optional `observability` set
 * (the same components with `complacency` split into its two legs) rides along for
 * persistence/charting. When OMITTED it stays `undefined` (NOT silently the scored set)
 * — the persistence site (the run loop) then falls back explicitly via `?? components`, so
 * the scored set never leaks a rolled-up `complacency` row into `/api/series`. The
 * band/score derive ONLY from the scored `components` — `observability` never touches
 * the math. Pure.
 */
export function computeSlowVerdict(
  components: SlowComponent[],
  observability?: SlowComponent[],
  fragileCalm = false,
  spDistToHigh?: number,
): SlowVerdict {
  const activeCount = components.length;
  const score = components.reduce((s, c) => s + c.score, 0);
  const maxScore = 2 * activeCount;
  const ratio = maxScore > 0 ? score / maxScore : 0;
  return {
    band: classifyBand(score, activeCount),
    score,
    activeCount,
    maxScore,
    ratio,
    components,
    observability,
    // T3.2 — derived ONLY from the duration-of-calm leg (passed in by the caller); it NEVER
    // touches band/score/ratio above. Defaults false so the existing 2-arg call site (tracks.ts)
    // stays verdict-invisible until Stage 5 threads the real value.
    fragileCalm,
    // D-B — carried through for the divergence escalator; never touches band/score/ratio.
    spDistToHigh,
  };
}
