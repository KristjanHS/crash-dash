/**
 * Composite scorers leaf (pure, no IO). Import shared engine primitives from ./scorers-core.js
 * ONLY.
 */

import { resolveBands, earlierCut, resolveMultiplier, type ThresholdConfig } from "./threshold-config.js";
import {
  type Indicator,
  type Observation,
  type Reading,
  type State,
  VELOCITY_WINDOW,
  CONFIRM_CLOSES,
} from "./domain-types.js";
import { at } from "./series-math.js";
import { velocitySigmaZSeries } from "./domain-fold.js";
import { ratioSpreadFiresHighward, type RatioSpreadDescriptor, type VelocityMeasure } from "./family-descriptor-core.js";
import {
  MA_WINDOW,
  FXH_AMBER,
  FXH_RED,
  GB_SYMBOLS,
  GB_AMBER,
  GB_RED,
  DISP_CORR,
  DISP_BASKET_RED,
  DISP_CORR_P,
  DISP_CORR_P_WINDOW,
  DISP_CORR_P_MIN_OBS,
  BULL_AMBER_P,
  BULL_RED_P,
  BULL_MIN_OBS,
  BULL_CUT_WINDOW,
  VT_BACKWARDATION_RATIO,
  VT_STREAK_AMBER,
  VT_STREAK_RED,
  CQS_CUT_BANDS,
  CQS_DESCRIPTOR,
  CG_DESCRIPTOR,
  BONOS_DESCRIPTOR,
  BUND_DESCRIPTOR,
  R6_DESCRIPTOR,
  ECY_EXPENSIVE_P,
  ECY_MIN_OBS,
  ECY_MAX_STALE_DAYS,
  CHART_DESCRIPTOR_OF,
  COMPOSITE_LEVEL_BAND_OF,
  POINT_BAND_CUTS_OF,
  RATIO_DESCRIPTOR_OF,
  VXNT_DESCRIPTOR,
  VXNT_K_WINDOW,
} from "./family-descriptor-rows.js";
import {
  buildReadings,
  ratioReadingSeries,
  finiteBandCuts,
  latest,
  mean,
  alignByDate,
  alignByDates,
  combineLevelVelocity,
  fixedLevelState,
} from "./scorers-core.js";
// Percentile helpers from their defining file ./percentile.js (zero-import leaf).
import { expandingPercentile, rollingPercentile, percentileRank, smaDeviation, PCT_MIN_OBS } from "./percentile.js";
import { isoDay } from "./dates.js";

// Stage 2a: unified ratio/spread scorer (CG · VT · EURC; BUND left for `scoreCurve`) over `ratioReadingSeries`, driven
// by `RatioSpreadDescriptor` (cuts/provenance in family-descriptor-rows.ts). Per-kind edge rules live in
// `ratioSpreadState`; the optional orthogonal levelBand leg in `percentileLevelState`/`levelBandHead`.
// R7 is NOT a member (3 inputs, 2-D state).

/**
 * Raw per-day state for a ratio/spread descriptor. `value` is the combined scalar the cut scores
 * (window return / ratio level / spread level); `amber`/`red` are RESOLVED bands (post-resolveBands).
 */
export function ratioSpreadState(
  value: number,
  desc: RatioSpreadDescriptor,
  amber: number,
  red: number,
): State {
  switch (desc.cutKind) {
    case "return":
      // Inclusive `≤`; a falling ratio (negative return) is the risk-off signal.
      if (value <= red) return "RED";
      if (value <= amber) return "AMBER";
      return "GREEN";
    case "level":
    case "spread":
      // HIGH (`level`, or a `direction: "HIGH"` spread): RED strict `>` (a flat curve at `red` is AMBER, N1); AMBER `≥`.
      if (ratioSpreadFiresHighward(desc)) {
        if (value > red) return "RED";
        if (value >= amber) return "AMBER";
        return "GREEN";
      }
      // LOW spread: both edges strict `<` (a spread at a cut is on the safe side). Falling spread = risk.
      if (value < red) return "RED";
      if (value < amber) return "AMBER";
      return "GREEN";
  }
}

/**
 * The optional second (LEVEL) leg's per-day state. HIGH: `≥` amber, `>` red; LOW (CG, default):
 * both edges strict `<`. Cuts are per-DAY (passed in, not read off a descriptor).
 * ⛔ THROWS on a non-finite cut — never a silent GREEN (the highest-cost failure: CG would look calm
 * for having no cut). `ratioSpreadReadingSeries` widens `baseOffset` past `levelBandHead` to keep this
 * unreachable; the guard turns a regression in that arithmetic into a crash.
 */
export function percentileLevelState(
  id: string,
  value: number,
  amber: number,
  red: number,
  direction: "HIGH" | "LOW" = "LOW",
): State {
  if (!Number.isFinite(amber) || !Number.isFinite(red)) {
    throw new Error(
      `[${id}] level-leg percentile cut is not finite (amber=${amber}, red=${red}) - ` +
        `the series head is inside levelBandHead; baseOffset must cover it. Refusing to score GREEN.`,
    );
  }
  if (direction === "HIGH") {
    if (value > red) return "RED";
    if (value >= amber) return "AMBER";
    return "GREEN";
  }
  if (value < red) return "RED";
  if (value < amber) return "AMBER";
  return "GREEN";
}

/**
 * The leading rows a `levelBand` cannot score — the ONE expression, so scorer/guard/probe/tests never
 * disagree on where CG's series starts. The DETRENDED arm sums `trendWindow − 1 + PCT_MIN_OBS` (the
 * deviation's leading NaNs are SKIPPED by expandingPercentile, not counted) — hence sum, not max.
 */
export function levelBandHead(lb: NonNullable<RatioSpreadDescriptor["levelBand"]>): number {
  if (lb.kind === "detrended-expanding-percentile") return lb.trendWindow - 1 + PCT_MIN_OBS;
  if (lb.kind === "rolling-percentile") return lb.minObs;
  return PCT_MIN_OBS;
}

/**
 * Stored rows a TAIL-EXACT recompute needs — the FULL rolling `window` (NOT `levelBandHead`, the first
 * scoreable day); the two diverge on the rolling kind where `window` > `minObs`. No live caller since
 * 2026-09-02 and nothing pins its behaviour; the next id to grow a ROLLING band owes it a test.
 */
export function levelBandTailDepth(lb: NonNullable<RatioSpreadDescriptor["levelBand"]>): number {
  if (lb.kind === "rolling-percentile") return lb.window;
  return levelBandHead(lb);
}

/**
 * Rows api/series.ts' re-score burns off the stored head. ⛔ The R6 and BONOS branches are FIRST and
 * unconditional, and must stay so: since 2026-09-02/09-04 neither carries a `levelBand`/`bandCuts`, so
 * the generic lookup below returns 0, yet both re-score on read (`COMPOSITE_RESTATE_OF`) with a
 * velocity σ warm-up (`moveLegBase`/`oatLegBase`) the read must burn off.
 * `dashboard.composites.test.ts` pins the premise.
 */
export function readPathHeadRows(id: string): number {
  if (id === "R6") return moveLegBase();
  if (id === "BONOS") return oatLegBase(BONOS_DESCRIPTOR.scorer.constants);
  const lb = RATIO_DESCRIPTOR_OF[id]?.levelBand ?? (COMPOSITE_RESTATE_OF[id] ? COMPOSITE_LEVEL_BAND_OF[id] : undefined);
  if (!(CHART_DESCRIPTOR_OF[id]?.bandCuts && lb)) return 0;
  return levelBandHead(lb);
}

/**
 * The scalar a `levelBand` scores per day — the raw combined series (plain arm) or its `trendWindow`
 * detrend. Exported so `api/series.ts` back-transforms its drawn cut through the SAME expression.
 */
export function levelBandValues(
  values: readonly number[],
  lb: NonNullable<RatioSpreadDescriptor["levelBand"]>,
): number[] {
  return lb.kind === "detrended-expanding-percentile"
    ? smaDeviation(values, lb.trendWindow)
    : [...values];
}

/**
 * The per-day cut series at fraction `p` over a `levelBand`'s scalar — expanding (the `*-percentile`
 * kinds) or trailing `window`/`minObs` (rolling). Scorer and the drawn band (api/series.ts) both route
 * here, so they can never disagree.
 */
export function levelBandCuts(
  values: readonly number[],
  lb: NonNullable<RatioSpreadDescriptor["levelBand"]>,
  p: number,
): number[] {
  return lb.kind === "rolling-percentile"
    ? rollingPercentile(values, p, lb.window, lb.minObs)
    : expandingPercentile(values, p);
}

/** ONE source of the per-date `cutKind` fold — `x−y` for "spread", `x/y` otherwise, inner-joined on
 *  date; a spread `meanWindow` then trails the mean, dropping its `meanWindow − 1` head. The unit `readings.value` stores. */
export function ratioSpreadValues(
  desc: RatioSpreadDescriptor,
  a: Observation[],
  b: Observation[],
): { dates: string[]; values: number[] } {
  const { dates, a: x, b: y } = alignByDate(a, b);
  if (desc.cutKind !== "spread") return { dates, values: x.map((v, i) => v / at(y, i)) };
  const spread = x.map((v, i) => v - at(y, i));
  const m = ratioSpreadMeanWindow(desc);
  if (m === 1) return { dates, values: spread };
  const means: number[] = [];
  let sum = 0;
  for (let i = 0; i < spread.length; i++) {
    sum += at(spread, i);
    if (i >= m) sum -= at(spread, i - m);
    if (i >= m - 1) means.push(sum / m);
  }
  return { dates: dates.slice(m - 1), values: means };
}

/** The trailing-mean span `ratioSpreadValues` applies — 1 (identity) unless a spread carries `meanWindow`. */
export function ratioSpreadMeanWindow(desc: RatioSpreadDescriptor): number {
  const m = desc.cutKind === "spread" ? (desc.meanWindow ?? 1) : 1;
  if (!Number.isInteger(m) || m < 1) throw new Error(`ratio-spread meanWindow must be a positive integer, got ${m}`);
  return m;
}

/** The aligned ratio/spread series as `Observation[]` (the stored `readings.value` unit) for the
 *  DB-first deep/tail fetch, re-scored via `ratioSpreadReadingSeriesFromValues` (§0.3). */
export function ratioSpreadPoints(desc: RatioSpreadDescriptor, a: Observation[], b: Observation[]): Observation[] {
  const { dates, values } = ratioSpreadValues(desc, a, b);
  // A date either leg carries `estimated` (a closes provider meta close) stays flagged, so the DB-first seam stores it `estimated`.
  const est = new Set([...a, ...b].filter((o) => o.estimated === true).map((o) => o.date));
  return dates.map((date, i) => (est.has(date) ? { date, value: at(values, i), estimated: true } : { date, value: at(values, i) }));
}

/**
 * Ratio/spread indicator as a FULL per-day `Reading[]` (oldest→newest): inner-join on date, apply the
 * combine op, score via `ratioSpreadState`, fold through CONFIRM_CLOSES (buildReadings). `level` is the
 * combined series, `delta20` its 20d change. Guard-light. Pure. `amber`/`red` OVERRIDE the descriptor
 * for the replay.ts grids.
 *
 * `desc.levelBand` (CG only) adds the ORTHOGONAL LEVEL leg, combined per day with the `cutKind` leg
 * BEFORE the confirm fold (buildReadings folds the COMBINED state, CG's cross-asset directional fold).
 * ⛔ `baseOffset` also covers `levelBandHead(lb)`: the head EMITS NO READING — do NOT degrade it to
 * velocity-only (ruled 2026-08-08).
 * ⚠ The level leg is NOT multiplier-scaled (the velocity leg is, via resolveBands) — see
 * `threshold-config.ts` §REACHABLE_IDS. The read path re-scores over the run path's own `readings` ∪
 * warm-up base (api/series.ts `warmupMergedSeries`), so drawn and scored cuts share one depth.
 */
export function ratioSpreadReadingSeries(
  indicator: Indicator,
  desc: RatioSpreadDescriptor,
  a: Observation[],
  b: Observation[],
  amber: number = desc.amber,
  red: number = desc.red,
): Reading[] {
  // A bespoke `scorer` owns its semantics (BUND → `scoreCurve`): the generic lattice would silently re-score it.
  if (desc.scorer) throw new Error(`ratioSpreadReadingSeries: ${indicator.id} carries bespoke scorer ${desc.scorer.ref}`);
  const { dates, values } = ratioSpreadValues(desc, a, b);
  const w = desc.window ?? VELOCITY_WINDOW;
  const lb = desc.levelBand;
  const base = ratioSpreadBaseOffset(desc);
  // One pass over the SAME `values` array the velocity leg scores. The level leg scores `levelValues`
  // (raw series or its detrend) and its cuts are the expanding percentiles OF THAT SAME array.
  const levelValues = lb ? levelBandValues(values, lb) : undefined;
  const levelAmberCuts = lb ? levelBandCuts(levelValues!, lb, lb.amberP) : undefined;
  const levelRedCuts = lb ? levelBandCuts(levelValues!, lb, lb.redP) : undefined;
  const built = ratioReadingSeries(indicator, values, dates, {
    minLength: base + 1,
    baseOffset: base,
    bands: { amber, red, firesHighward: ratioSpreadFiresHighward(desc) },
    classify: (i, v, aB, rB) => {
      const velocity = ratioSpreadState(
        desc.cutKind === "return" ? at(v, i) / at(v, i - w) - 1 : at(v, i),
        desc,
        aB!,
        rB!,
      );
      if (!lb) return velocity;
      const level = percentileLevelState(
        indicator.id,
        at(levelValues!, i),
        at(levelAmberCuts!, i),
        at(levelRedCuts!, i),
      );
      return combineLevelVelocity(desc.combine ?? "or", level, velocity);
    },
  });
  // Stamp each row's per-day level-leg cut under CG's wire keys so api/series.ts reads the persisted
  // cut (Stage 2.2). `built[j]` is at `values` index `base + j`; a non-finite head cut drops its key.
  if (!lb) return built;
  const bandRows = POINT_BAND_CUTS_OF[indicator.id];
  const amberKey = bandRows?.find((r) => r.level === "amber")?.key;
  const redKey = bandRows?.find((r) => r.level === "red")?.key;
  return built.map((r, j) => {
    const i = base + j;
    const entries: Array<readonly [string, number | null | undefined]> = [];
    if (amberKey !== undefined) entries.push([amberKey, levelAmberCuts![i]]);
    if (redKey !== undefined) entries.push([redKey, levelRedCuts![i]]);
    const bc = finiteBandCuts(entries);
    return bc ? { ...r, bandCuts: bc } : r;
  });
}

/** SINGLE touch point for the ratio-identity denominator: 0 for "spread" (`value − 0`), 1 otherwise
 *  (`value / 1`). NEVER restate inline — re-score stored values via `ratioSpreadReadingSeriesFromValues`. */
function identityDenominator(desc: RatioSpreadDescriptor): number {
  return desc.cutKind === "spread" ? 0 : 1;
}

/** Value-domain half of `ratioSpreadReadingSeries`: re-scores an ALREADY-COMBINED series (the stored
 *  `readings.value` unit) through the identity-denominator seam. ⛔ Strips `meanWindow` — the stored value IS the mean. */
export function ratioSpreadReadingSeriesFromValues(
  indicator: Indicator,
  desc: RatioSpreadDescriptor,
  points: Observation[],
): Reading[] {
  const denom = identityDenominator(desc);
  return ratioSpreadReadingSeries(
    indicator,
    { ...desc, meanWindow: undefined },
    points,
    points.map((p) => ({ date: p.date, value: denom })),
  );
}

/** CG's expanding-percentile base start — prod's `readings_warmup` head. Every CG writer and judge scores only dates ≥ it. */
export const CG_LEVEL_ANCHOR = "2006-09-11";

/** Deep-fetch span (calendar days) reaching `CG_LEVEL_ANCHOR` as of `now`, +7 d margin. */
export const cgLookbackDays = (now: Date): number =>
  Math.ceil((now.getTime() - Date.parse(`${CG_LEVEL_ANCHOR}T00:00:00Z`)) / 86_400_000) + 7;

/** THE aligned CG ratio every CG writer stores and scores — the cron confirmer and the restate. */
export function cgPoints(hg: Observation[], gc: Observation[]): Observation[] {
  return ratioSpreadPoints(CG_DESCRIPTOR, hg, gc).filter((p) => p.date >= CG_LEVEL_ANCHOR);
}

/** THE CG rows both writers persist (cron confirmer, restate): identical values ⇒ identical states. */
export function cgRows(indicator: Indicator, points: Observation[]): Reading[] {
  return ratioSpreadReadingSeriesFromValues(indicator, CG_DESCRIPTOR, points.filter((p) => p.date >= CG_LEVEL_ANCHOR));
}

/** The ONE expression of `ratioSpreadReadingSeries`' `baseOffset`: covers desc.window (a "return"
 *  window > VELOCITY_WINDOW) AND `levelBandHead(lb)` when present — else v[i-w] / NaN cuts read past the
 *  start → silent GREEN. Widened only for level-leg ids, so VT/EURC keep their start dates
 *  byte-for-byte. `ratioSpreadMinLen` derives from it; never restate the max inline. */
export function ratioSpreadBaseOffset(desc: RatioSpreadDescriptor): number {
  return Math.max(desc.window ?? VELOCITY_WINDOW, VELOCITY_WINDOW, desc.levelBand ? levelBandHead(desc.levelBand) : 0);
}

/** minLen = the scored series' `baseOffset` + CONFIRM_CLOSES + the mean head, so a too-short series never
 *  reaches `latest` empty with a misleading message. */
export function ratioSpreadMinLen(desc: RatioSpreadDescriptor): number {
  return ratioSpreadBaseOffset(desc) + CONFIRM_CLOSES + ratioSpreadMeanWindow(desc) - 1;
}

/** `scoreRatioSpread`'s min-obs guard + latest pick over an ALREADY-scored series. `got` = aligned
 *  closes scored. */
export function latestRatioSpread(indicator: Indicator, desc: RatioSpreadDescriptor, series: Reading[], got: number): Reading {
  return latest(indicator, series, ratioSpreadMinLen(desc), got, "aligned closes");
}

export function scoreRatioSpread(
  indicator: Indicator,
  desc: RatioSpreadDescriptor,
  a: Observation[],
  b: Observation[],
): Reading {
  const { a: x } = alignByDate(a, b);
  return latestRatioSpread(indicator, desc, ratioSpreadReadingSeries(indicator, desc, a, b), x.length);
}

/** VXNT's denominator leg `VXVCLS × k_D`, k_D = median VXNCLS/VIXCLS over the `window` aligned closes
 *  strictly before D; fewer ⇒ D skipped. A d-row `estimated` on any leg stays flagged. */
export function vxnTermDenominator(
  vxn: Observation[],
  vix: Observation[],
  vix3m: Observation[],
  window: number = VXNT_K_WINDOW,
): Observation[] {
  const r = alignByDate(vxn, vix);
  const ratios = r.a.map((v, i) => v / at(r.b, i));
  const est = new Set([...vxn, ...vix, ...vix3m].filter((o) => o.estimated === true).map((o) => o.date));
  const d3 = alignByDate(vxn, vix3m);
  const out: Observation[] = [];
  let n = 0; // count of `r.dates` strictly before the current d (both ascending)
  for (let j = 0; j < d3.dates.length; j++) {
    const d = at(d3.dates, j);
    while (n < r.dates.length && at(r.dates, n) < d) n++; // n = length past r's tail (VIX lags VIX3M)
    if (n < window) continue;
    const sorted = ratios.slice(n - window, n).sort((x, y) => x - y);
    const mid = window >> 1;
    const k = window % 2 === 1 ? at(sorted, mid) : (at(sorted, mid - 1) + at(sorted, mid)) / 2;
    const value = at(d3.b, j) * k;
    if (!(value > 0)) continue;
    out.push(est.has(d) ? { date: d, value, estimated: true } : { date: d, value });
  }
  return out;
}

/** VXNT per-day series: VT's ratio-spread scorer over VXNCLS ÷ `vxnTermDenominator`. */
export function vxnTermReadingSeries(
  indicator: Indicator,
  vxn: Observation[],
  vix: Observation[],
  vix3m: Observation[],
): Reading[] {
  return ratioSpreadReadingSeries(indicator, VXNT_DESCRIPTOR, vxn, vxnTermDenominator(vxn, vix, vix3m));
}

export function scoreVxnTerm(indicator: Indicator, vxn: Observation[], vix: Observation[], vix3m: Observation[]): Reading {
  const denom = vxnTermDenominator(vxn, vix, vix3m);
  const series = ratioSpreadReadingSeries(indicator, VXNT_DESCRIPTOR, vxn, denom);
  return latestRatioSpread(indicator, VXNT_DESCRIPTOR, series, denom.length);
}

// highBandState: generic HIGH-firing classifier (rising/widening = risk). RED strict `>` (a value at
// `red` is AMBER, N1); AMBER inclusive `≥`. Shared by the spread velocity leg, the CQS EBP-bridge, and
// `displayBandChart` (chart-rail.ts) so the drawn caption and the scored edge agree.
export function highBandState(value: number, amber: number, red: number): State {
  if (value > red) return "RED";
  if (value >= amber) return "AMBER";
  return "GREEN";
}

// CQS EBP-bridge: `bridge(t) = spread(t) − spread(anchor)`, spread = BAA10Y − AAA10Y inner-joined by
// date; anchor = monthEnd(latest EBP label) (R2). Scored on z = Δ ÷ trailing σ of same-horizon Δs; σ ≤
// sigmaFloor or no EBP/anchor ⇒ GREEN, Δ=0 (R5). Stored `level` is Δ (yield points). Cuts on
// CQS_DESCRIPTOR (family-descriptor-rows.ts) — ONE source.

/** Month-END of an EBP label (R2): label `2026-07-01` → `2026-07-31`. */
function ebpAnchorDate(labelIso: string): string {
  const [y, m] = labelIso.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y!, m, 0)));
}

/** Index of the rightmost element of `sortedAsc` that is ≤ `target`; −1 if none. */
function atOrBefore(sortedAsc: string[], target: string): number {
  let lo = 0,
    hi = sortedAsc.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(sortedAsc, mid) <= target) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Population σ of `xs` (NaN for none; the one caller passes ≥ VELOCITY_WINDOW). */
function popStd(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sumSq = xs.reduce((a, b) => {
    const dev = b - m; // one Δ, not two: a lone `b + m` in (b − m)(b − m) sums back to Σ(b − m)² since Σb = n·m
    return a + dev * dev;
  }, 0);
  return Math.sqrt(sumSq / xs.length);
}

/**
 * Per-day bridge Δ (`values`), z and the trailing σ it was divided by — index-aligned; `z`/`sigma`
 * are `undefined` on the same days (no anchor / too few same-horizon Δs / sub-floor σ).
 * ⚠ THE ONE OWNER of the bridge's σ — `creditBridgeReadingSeries` divides by it, `creditBridgeCutSeries`
 * multiplies the z cuts BACK by it; a second derivation would let drawn and scored disagree.
 */
function creditBridgeSeries(
  baa: Observation[],
  aaa: Observation[],
  ebp: Observation[],
  c: { sigmaWindow: number; sigmaFloor: number },
): { values: number[]; dates: string[]; z: Array<number | undefined>; sigma: Array<number | undefined> } {
  const { dates, a: x, b: y } = alignByDate(baa, aaa);
  const spread = x.map((v, i) => v - at(y, i));
  const n = spread.length;
  const values = new Array<number>(n).fill(0);
  const z = new Array<number | undefined>(n).fill(undefined);
  const sigma = new Array<number | undefined>(n).fill(undefined);
  const anchors = ebp.map((o) => ebpAnchorDate(o.date)).sort((p, q) => p.localeCompare(q));
  for (let t = 0; t < n; t++) {
    const ai = atOrBefore(anchors, at(dates, t));
    if (ai < 0) continue; // no anchor active yet (R5: or none at all) ⇒ GREEN, Δ=0
    const aIdx = atOrBefore(dates, at(anchors, ai)); // spread index at/before the active anchor
    if (aIdx < 0) continue;
    const L = t - aIdx;
    values[t] = at(spread, t) - at(spread, aIdx);
    if (L <= 0) continue; // anchor is today ⇒ Δ=0, no call
    const from = Math.max(L, t - c.sigmaWindow + 1);
    const diffs: number[] = [];
    for (let j = from; j <= t; j++) diffs.push(at(spread, j) - at(spread, j - L));
    if (diffs.length < VELOCITY_WINDOW) continue; // too few same-horizon Δs for an honest σ ⇒ GREEN
    const sd = popStd(diffs);
    if (!(sd > c.sigmaFloor)) continue; // R3: degenerate σ ⇒ GREEN, never an exploded z
    sigma[t] = sd;
    z[t] = at(values, t) / sd;
  }
  return { values, dates, z, sigma };
}

/**
 * Full per-day bridge `Reading[]` (oldest→newest): Δ is the stored/plotted `level`, state comes
 * from the z-classifier. R5 anchor-loss days fold GREEN (never dropped). Pure: no IO.
 */
export function creditBridgeReadingSeries(
  indicator: Indicator,
  baa: Observation[],
  aaa: Observation[],
  ebp: Observation[],
): Reading[] {
  const { zAmber, zRed, sigmaWindow, sigmaFloor } = CQS_DESCRIPTOR.scorer.constants;
  const { values, dates, z } = creditBridgeSeries(baa, aaa, ebp, { sigmaWindow, sigmaFloor });
  // Guard-light: `sigmaWindow` caps the σ trailing window only, never the series length — short
  // history keeps scoring GREEN until σ is honest (R5 anchor-loss + short-fixture paths survive).
  return ratioReadingSeries(indicator, values, dates, {
    minLength: VELOCITY_WINDOW + 1,
    baseOffset: VELOCITY_WINDOW,
    classify: (i) => {
      const zi = at(z, i);
      return zi === undefined ? "GREEN" : highBandState(zi, zAmber, zRed);
    },
  });
}

/**
 * The bridge's two MOVING band cuts back-transformed into Δ units: `cut(t) = z* × σ(t)`, the exact
 * inverse of the scorer's `z = Δ ÷ σ(t)`. Multiples come off CQS_DESCRIPTOR.scorer.constants via
 * CQS_CUT_BANDS' `from` — never restated. A date with `undefined` σ yields `undefined` cuts and the
 * emitter DROPS the key (a 0 would paint a cut at the axis origin). Read by api/series.ts' overlay only.
 */
export function creditBridgeCutSeries(
  baa: Observation[],
  aaa: Observation[],
  ebp: Observation[],
): { dates: string[]; cuts: Record<string, Array<number | undefined>> } {
  const c = CQS_DESCRIPTOR.scorer.constants;
  const { dates, sigma } = creditBridgeSeries(baa, aaa, ebp, c);
  const cuts: Record<string, Array<number | undefined>> = {};
  for (const b of CQS_CUT_BANDS) cuts[b.key] = sigma.map((sd) => (sd === undefined ? undefined : c[b.from] * sd));
  return { dates, cuts };
}

/** Latest confirmed bridge reading; throws (via `latest`) on too few joined closes. Anchor loss is GREEN, not a throw. */
export function scoreCreditBridge(
  indicator: Indicator,
  baa: Observation[],
  aaa: Observation[],
  ebp: Observation[],
): Reading {
  const series = creditBridgeReadingSeries(indicator, baa, aaa, ebp);
  return latest(indicator, series, 1, series.length, "bridge days");
}

// Sovereign-spread VELOCITY leg (the BONOS two-leg scorer's velocity half): worst-of two Δbp horizons over one
// trailing σ, on a spread already in bp. Cuts on the id's descriptor `scorer.constants` — the ONE source.

/**
 * Per-day velocity z for a spread series, index-aligned (`undefined` where uncovered). THE SINGLE owner
 * of `velFrom` and the `(m − 1) + k + VELOCITY_WINDOW` offset (the GLOBAL VELOCITY_WINDOW, never the leg's velWindow)
 * — `oatLegSeries` and api/series.ts' velZ series share it, never re-derive it.
 */
export function oatVelocityZ(
  values: readonly number[],
  c: { velWindow: number; velSigmaWindow: number; measure: VelocityMeasure; endpointMean?: number },
): Array<number | undefined> {
  // Log arm only: measure the tail past the last non-positive close — log of a non-positive value is
  // NaN and poisons every later prefix sum. The bp arm z-scores the raw change from index 0.
  const velFrom = c.measure === "log" ? values.reduce<number>((acc, v, i) => (v > 0 ? acc : i), -1) + 1 : 0;
  const tail = values.slice(velFrom);
  const logged = c.measure === "log" ? tail.map((v) => Math.log(v)) : tail;
  // Trailing m-close endpoint mean (absent ⇒ 1 = raw): Δw and σ both run on the smoothed series.
  const m = c.endpointMean ?? 1;
  const measured = logged.slice(m - 1).map((_, j) => mean(logged, j, j + m - 1));
  const { z } = velocitySigmaZSeries(measured, c.velWindow, {
    window: c.velSigmaWindow,
    minObs: c.velSigmaWindow,
  });
  const out = new Array<number | undefined>(values.length).fill(undefined);
  // z[k] aligns to measured[k + VELOCITY_WINDOW] = values[velFrom + (m − 1) + k + VELOCITY_WINDOW].
  for (let k = 0; k < z.length; k++) out[velFrom + m - 1 + k + VELOCITY_WINDOW] = z[k];
  return out;
}

/** A spread velocity leg's scorer constants — the id descriptor's `scorer.constants`, an argument so a probe can
 *  score a variant through the shipped `oatLegSeries`/`oatLegBase`. */
export interface OatConstants {
  velWindow: number;
  velSlowWindow: number;
  velSigmaWindow: number;
  measure: VelocityMeasure;
  endpointMean: number;
  zAmber: number;
  zRed: number;
}

/**
 * Per-day spread velocity scoring off the already-combined bp series — the worst-of the velWindow / velSlowWindow
 * z states and its leg TOKEN, index-aligned (`undefined` below `base`, the σ warm-up). THE ONE OWNER
 * of the velocity leg's per-day semantics. LEG TOKEN: `vel-z` when the velWindow arm carries the day's state
 * (a tie included), else `vel-z-slow`; none on GREEN. A read-time recompute needs no second feed.
 */
export function oatLegSeries(
  values: readonly number[],
  c: OatConstants,
): {
  base: number;
  state: Array<State | undefined>;
  leg: Array<string | undefined>;
} {
  const base = oatLegBase(c);
  // `oatVelocityZ` owns velFrom + the offset; this call site never re-derives them.
  const fastZ = oatVelocityZ(values, c);
  const slowZ = oatVelocityZ(values, { ...c, velWindow: c.velSlowWindow });
  // σ≤0 (a flat spread) ⇒ z undefined ⇒ that arm degrades GREEN, never NaN.
  const arm = (z: number | undefined): State => (z === undefined ? "GREEN" : highBandState(z, c.zAmber, c.zRed));
  const state = new Array<State | undefined>(values.length).fill(undefined);
  const leg = new Array<string | undefined>(values.length).fill(undefined);
  for (let i = base; i < values.length; i++) {
    const fast = arm(fastZ[i]);
    const day = combineLevelVelocity("or", fast, arm(slowZ[i]));
    state[i] = day;
    leg[i] = day === "GREEN" ? undefined : fast === day ? "vel-z" : "vel-z-slow";
  }
  return { base, state, leg };
}

/**
 * First scored spread-velocity day — shared by `oatLegSeries`/`scoreBonosSpread`/the fixture.
 * The velocity σ warm-up (+ `endpointMean − 1` smoothing closes) is the only head; `levelBandHead` went with its band (2026-09-04),
 * do NOT reintroduce it without a band. NOT defined off `moveLegBase` — a future leg moves one id alone.
 */
export function oatLegBase(
  c: Pick<OatConstants, "velWindow" | "velSlowWindow" | "velSigmaWindow" | "endpointMean">,
): number {
  return Math.max(VELOCITY_WINDOW, c.velSigmaWindow + Math.max(c.velWindow, c.velSlowWindow)) + c.endpointMean - 1;
}

/**
 * Stored ^MOVE rows a TAIL-EXACT `moveLegSeries` recompute needs — the R6 DB-first read floor: the
 * velocity warm-up (`velSigmaWindow + velWindow` = 255) + CONFIRM_CLOSES. Since 2026-09-02 R6 has no
 * level leg; the `Math.max`/`levelBandTailDepth` term is gone — do NOT reintroduce without a band.
 */
export function moveScoreRows(): number {
  const { velWindow, velSigmaWindow } = R6_DESCRIPTOR.scorer.constants;
  return velSigmaWindow + velWindow + CONFIRM_CLOSES;
}

// Two-leg sovereign spread (bp), `combine: "or"` — the velocity leg (`oatLegSeries` on the descriptor's
// `scorer.constants`) OR the absolute pair off the indicator's `thresholds` (`fixedLevelState`, the R6 leg).
// LEG TOKEN: `vel-z`/`vel-z-slow` when velocity carries the day's state (a tie included), else `level`; none on GREEN.

/** Per-day two-leg spread state + leg token off an already-bp series, index-aligned (`undefined` below `base`). */
export function btpLegSeries(
  indicator: Indicator,
  values: readonly number[],
  desc: typeof BONOS_DESCRIPTOR,
): { base: number; state: Array<State | undefined>; leg: Array<string | undefined> } {
  const vel = oatLegSeries(values, desc.scorer.constants);
  const state = new Array<State | undefined>(values.length).fill(undefined);
  const leg = new Array<string | undefined>(values.length).fill(undefined);
  for (let i = vel.base; i < values.length; i++) {
    const v = at(vel.state, i)!;
    const day = combineLevelVelocity(desc.combine, fixedLevelState(indicator, at(values, i)), v);
    state[i] = day;
    leg[i] =
      day === "GREEN"
        ? undefined
        : v === day
          ? vel.leg[i]
          : "level";
  }
  return { base: vel.base, state, leg };
}

// BONOS Spanish−German 10y spread (contagion S1): the two legs over `BONOS_DESCRIPTOR` + `BONOS.thresholds`.

/** Per-day `Reading[]` for the Bonos−Bund spread: inner-join, (es − de) × 100 bp — the ONE conversion. Pure. */
export function bonosSpreadReadingSeries(indicator: Indicator, es10y: Observation[], de10y: Observation[]): Reading[] {
  const { dates, a: x, b: y } = alignByDate(es10y, de10y);
  return bonosReadingSeriesFromValues(indicator, x.map((v, i) => (v - at(y, i)) * 100), dates);
}

/** Value-domain half (stored `readings.value` is already bp) — `COMPOSITE_RESTATE_OF.BONOS`. Pure. */
function bonosReadingSeriesFromValues(indicator: Indicator, values: number[], dates: string[]): Reading[] {
  const { base, state, leg } = btpLegSeries(indicator, values, BONOS_DESCRIPTOR);
  return ratioReadingSeries(indicator, values, dates, {
    minLength: base + 1,
    baseOffset: base,
    classify: (i) => at(state, i)!,
    legOf: (i) => leg[i],
  });
}

/** Latest confirmed Bonos−Bund reading; throws (via `latest`) on too few ALIGNED closes. */
export function scoreBonosSpread(indicator: Indicator, es10y: Observation[], de10y: Observation[]): Reading {
  const { a: x } = alignByDate(es10y, de10y);
  const minLen = oatLegBase(BONOS_DESCRIPTOR.scorer.constants) + CONFIRM_CLOSES;
  return latest(indicator, bonosSpreadReadingSeries(indicator, es10y, de10y), minLen, x.length, "aligned closes");
}

// R6 MOVE bond-market implied-vol level: a single-series `scoreBonosSpread` mirror over ^MOVE closes,
// `combine: "or"` (worst-of) across a VELOCITY leg (z of Δlog5, R6_DESCRIPTOR.scorer.constants) and
// the ABSOLUTE pair off R6.thresholds. Cuts on R6_DESCRIPTOR + registry thresholds — ONE source.
// ⛔ It shed a percentile LEVEL leg twice (2026-08-31, 2026-09-02); do NOT re-add one — reasoning on
// R6_DESCRIPTOR's docblock.

/**
 * First scored ^MOVE day — shared by `moveLegSeries`/`latestMove`/`readPathHeadRows`/the fixture.
 * Equals `moveScoreRows()` minus CONFIRM_CLOSES, but NOT defined off it: one is a STORED-ROW floor,
 * this a SCORED-DAY offset, and a future leg moves one without the other. The absolute leg never binds.
 */
export function moveLegBase(): number {
  const { velWindow, velSigmaWindow } = R6_DESCRIPTOR.scorer.constants;
  return Math.max(VELOCITY_WINDOW, velSigmaWindow + velWindow);
}

/**
 * Per-day MOVE state off the raw level series — worst-of the OR'd legs, index-aligned (`undefined`
 * below `base`). The absolute leg rides the same `base`. `oatVelocityZ` owns the velocity offset.
 */
export function moveLegSeries(
  indicator: Indicator,
  values: readonly number[],
): { base: number; state: Array<State | undefined> } {
  const { velWindow, velSigmaWindow, measure, zAmber, zRed } = R6_DESCRIPTOR.scorer.constants;
  const base = moveLegBase();
  const velZ = oatVelocityZ(values, { velWindow, velSigmaWindow, measure });
  const state = new Array<State | undefined>(values.length).fill(undefined);
  for (let i = base; i < values.length; i++) {
    const zi = velZ[i];
    // σ≤0 (a flat series) ⇒ z undefined ⇒ the velocity leg degrades GREEN, never NaN.
    const vl: State = zi === undefined ? "GREEN" : highBandState(zi, zAmber, zRed);
    const abs = fixedLevelState(indicator, at(values, i));
    state[i] = [vl, abs].reduce<State>((acc, s) => combineLevelVelocity(R6_DESCRIPTOR.combine, acc, s), "GREEN");
  }
  return { base, state };
}

/** Full per-day `Reading[]` for ^MOVE (oldest→newest): raw closes as `level`, state from the
 *  two-leg worst-of (`moveLegSeries`). Pure: no IO. */
export function moveReadingSeries(indicator: Indicator, observations: Observation[]): Reading[] {
  return moveReadingSeriesFromValues(
    indicator,
    observations.map((o) => o.value),
    observations.map((o) => o.date),
  );
}

/** The value-domain half of `moveReadingSeries` — raw ^MOVE closes (the unit `readings.value`
 *  stores for R6) + dates, scored through `moveLegSeries`. `COMPOSITE_RESTATE_OF.R6` runs this
 *  over the stored payload so the served ribbon is the cron's own two-leg verdict. Pure. */
export function moveReadingSeriesFromValues(indicator: Indicator, values: number[], dates: string[]): Reading[] {
  const { base, state } = moveLegSeries(indicator, values);
  return ratioReadingSeries(indicator, values, dates, {
    minLength: base + 1,
    baseOffset: base,
    classify: (i) => at(state, i)!,
  });
}

/**
 * id → the composite re-score api/series.ts runs over a stored payload's OWN value+date columns, so
 * the served ribbon is recomputed beside the drawn cuts and can't contradict them. Each is the
 * value-domain half of the cron scorer (stored value already in the scorer's unit — no conversion).
 * `readPathHeadRows` reads membership here to size the stored head.
 */
export const COMPOSITE_RESTATE_OF: Readonly<
  Record<string, (indicator: Indicator, values: number[], dates: string[]) => Reading[]>
> = {
  R6: moveReadingSeriesFromValues,
  BONOS: bonosReadingSeriesFromValues,
};

/** Latest confirmed ^MOVE reading; throws (via `latest`) on too few closes. */
export function scoreMoveLevel(indicator: Indicator, observations: Observation[]): Reading {
  return latestMove(indicator, moveReadingSeries(indicator, observations), observations.length);
}

/** `scoreMoveLevel`'s min-observation guard + latest pick over an ALREADY-scored series. `got` =
 *  closes scored. */
export function latestMove(indicator: Indicator, series: Reading[], got: number): Reading {
  const minLen = moveLegBase() + CONFIRM_CLOSES;
  return latest(indicator, series, minLen, got, "closes");
}

// T2.2 copper/gold ratio (CONTEXT confirmer — never solo/CRITICAL, amplifies an elevated GEO signal).
// Cuts/provenance → CG_DESCRIPTOR; scored through the unified stack (scoreRatioSpread + CG_DESCRIPTOR).

// VT VIX term-structure backwardation: scored bespoke off the ratio LEVEL (HIGH; RED strict `>`,
// AMBER inclusive `≥` — N1), NOT a 20d return and NOT classify() (registry thresholds:{}). COINCIDENT;
// VT's confirmed .state feeds the dial's volatility family, never solo-trips. Cuts/N1 provenance →
// VT_DESCRIPTOR. Edge inclusivity is a SPLIT convention — keep descriptor/block-header/registry.ts/
// public/indicator-desc.js in sync. Scored through the unified stack (scoreRatioSpread + VT_DESCRIPTOR).

// VT VIX backwardation PERSISTENCE leg (R3): the count of CONSECUTIVE most-recent days in
// BACKWARDATION (ratio > 1.00, near-term vol above 3-month), a DISTINCT leg over VT's shared legs
// scored off the STREAK, not the level (the ratio-LEVEL cuts stay byte-unchanged). NOTIFY-EXCLUDED
// (EW-13): rides the CONTEXT identity `VTP` (passed in, registry.ts), added to NO dial family and NO
// roll-up — persisted + charted since 2026-07-31, never notify.

/**
 * Count of CONSECUTIVE most-recent backwardation days (ratio > VT_BACKWARDATION_RATIO): inner-join,
 * form VIX÷VIX3M, walk BACKWARD from the last close, stop at the first non-backwardation day. 0 on empty.
 */
export function backwardationStreak(vix: Observation[], vix3m: Observation[]): number {
  const { a: v, b: t } = alignByDate(vix, vix3m);
  let streak = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    if (at(v, i) / at(t, i) > VT_BACKWARDATION_RATIO) streak++;
    else break;
  }
  return streak;
}

/** Streak → State: 10+ RED, 5+ AMBER, else GREEN (EW-11/12). */
export function vixTermPersistenceState(streak: number): State {
  return streak >= VT_STREAK_RED ? "RED" : streak >= VT_STREAK_AMBER ? "AMBER" : "GREEN";
}

/**
 * The persistence leg as a Reading PER aligned close (oldest→newest) on the CONTEXT identity (`VTP`).
 * `level` = the streak AS OF that close (incremental forward walk), so the tail is byte-identical to
 * `backwardationStreak`. ⛔ Do NOT run the CONFIRM_CLOSES fold — the streak count IS the confirmation
 * (rawState === state); folding would break the exact "5 → Amber" edge.
 */
export function vixTermPersistenceReadingSeries(
  indicator: Indicator,
  vix: Observation[],
  vix3m: Observation[],
): Reading[] {
  const { dates, a: v, b: t } = alignByDate(vix, vix3m);
  const out: Reading[] = [];
  let streak = 0;
  for (let i = 0; i < dates.length; i++) {
    streak = at(v, i) / at(t, i) > VT_BACKWARDATION_RATIO ? streak + 1 : 0;
    const state = vixTermPersistenceState(streak);
    out.push({
      indicator,
      date: at(dates, i),
      level: streak,
      delta20: 0,
      rawState: state,
      state,
      decision: streak,
    });
  }
  return out;
}

/**
 * The persistence leg as a single Reading on the CONTEXT identity (`VTP`) — the tail of the series
 * builder above (one rule, one implementation); the empty fallback keeps the disjoint/empty contract
 * (date "", streak 0, GREEN). CONTEXT, off every roll-up and dial family ⇒ persisted + charted, never notify.
 */
export function scoreVixTermPersistence(
  indicator: Indicator,
  vix: Observation[],
  vix3m: Observation[],
): Reading {
  return (
    vixTermPersistenceReadingSeries(indicator, vix, vix3m).at(-1) ?? {
      indicator,
      date: "",
      level: 0,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
      decision: 0,
    }
  );
}

// EURC ECB euro-curve inversion (GLOBAL): the euro AAA spot-curve slope SR_10Y − SR_3M (ECB, ecb.ts),
// direction LOW (mirror R1) — a flattening/negative spread is the danger, closing #R1's US-Treasury-
// rally blind spot. Scored bespoke off the spread LEVEL, registry thresholds:{}, no `derived` (needs
// both tenors). Cuts/provenance → EURC_DESCRIPTOR; scored through the unified stack (scoreRatioSpread).

// 10y−2y curve scorer (BUND): bespoke, OFF the
// unified stack — worst-of three legs; every knob on the id's `CURVE_DESCRIPTOR_OF` row (`amber`/`red` + `scorer.constants`).

/** The curve scorer's knobs — `BUND_DESCRIPTOR.scorer.constants` by default, an argument so a probe can score a variant. */
export interface BundConstants {
  velAmber: number;
  velRed: number;
  escDrop2y: number;
  escWindow: number;
}

/** Leg (a): the slope's Δ (pp), two-sided — AMBER at |Δ| ≥ `velAmber`, RED at ≥ `velRed` (both inclusive). */
export function bundVelocityState(delta: number, c: BundConstants = BUND_DESCRIPTOR.scorer.constants): State {
  const d = Math.abs(delta);
  if (d >= c.velRed) return "RED";
  if (d >= c.velAmber) return "AMBER";
  return "GREEN";
}

/** Leg (b): ONE cut — AMBER below the RESOLVED `amber` (strict `<`, `ratioSpreadState`'s spread edge), else GREEN. */
export function bundLevelState(slope: number, amber: number): State {
  return slope < amber ? "AMBER" : "GREEN";
}

/** Leg (c): RED when the 2y Δ ≤ −`escDrop2y` and the slope was < 0 at most `escWindow` obs ago (today = 0). */
export function bundResteepState(d2y: number, obsSinceInversion: number, c: BundConstants = BUND_DESCRIPTOR.scorer.constants): State {
  return d2y <= -c.escDrop2y && obsSinceInversion <= c.escWindow ? "RED" : "GREEN";
}

/** Obs BUND's legs look back before a day scores in full: the Δ window + leg (c)'s inversion memory (conservative
 *  sum; the confirm fold rides inside). `scripts/backfill.ts` leads the Y10/Y02 feeds by it. */
export function bundLegHead(c: BundConstants = BUND_DESCRIPTOR.scorer.constants): number {
  return VELOCITY_WINDOW + c.escWindow;
}

/** The curve scorer's descriptor shape — a `CURVE_DESCRIPTOR_OF` row. */
export interface CurveDescriptor {
  amber: number;
  red: number;
  scorer: { constants: BundConstants };
}

/**
 * Per-day curve legs off the date-aligned slope (10y − 2y) and 2y arrays, index-aligned (`undefined` below
 * `VELOCITY_WINDOW`). `amber` = leg (b)'s RESOLVED cut. THE ONE OWNER of the leg semantics
 * (`probe-bund-velocity.ts` imports it). An inversion before index 0 is invisible — feed `bundLegHead()` extra obs.
 */
export function bundLegSeries(
  slope: readonly number[],
  y02: readonly number[],
  amber: number,
  c: BundConstants = BUND_DESCRIPTOR.scorer.constants,
): Array<{ delta: number; a: State; b: State; c: State; state: State } | undefined> {
  const w = VELOCITY_WINDOW;
  let lastInv = -Infinity;
  return slope.map((s, i) => {
    if (s < 0) lastInv = i;
    if (i < w) return undefined;
    const delta = s - at(slope, i - w);
    const a = bundVelocityState(delta, c);
    const b = bundLevelState(s, amber);
    const cc = bundResteepState(at(y02, i) - at(y02, i - w), i - lastInv, c);
    return { delta, a, b, c: cc, state: combineLevelVelocity("or", combineLevelVelocity("or", a, b), cc) };
  });
}

/** Full per-day curve `Reading[]`: inner-join 10y/2y, `level` = the slope, state = `bundLegSeries`' worst-of. Pure. */
export function curveReadingSeries(
  indicator: Indicator,
  d: CurveDescriptor,
  y10: Observation[],
  y02: Observation[],
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): Reading[] {
  const { dates, a: x, b: two } = alignByDate(y10, y02);
  const slope = x.map((v, i) => v - at(two, i));
  // Leg (b)'s amber resolves exactly as the unified stack's did (the multiplier seam, `REACHABLE_IDS`).
  const lvl = resolveBands(indicator.id, d.amber, d.red, false, config);
  const legs = bundLegSeries(slope, two, lvl.amber, d.scorer.constants);
  return ratioReadingSeries(indicator, slope, dates, {
    minLength: VELOCITY_WINDOW + 1,
    baseOffset: VELOCITY_WINDOW,
    classify: (i) => at(legs, i)!.state,
  });
}

/** Latest confirmed curve reading; throws (via `latest`) below `VELOCITY_WINDOW` + CONFIRM_CLOSES aligned closes. */
export function scoreCurve(indicator: Indicator, d: CurveDescriptor, y10: Observation[], y02: Observation[]): Reading {
  const { a: x } = alignByDate(y10, y02);
  return latest(indicator, curveReadingSeries(indicator, d, y10, y02), VELOCITY_WINDOW + CONFIRM_CLOSES, x.length, "aligned closes");
}

// FXH FX-haven composite (GLOBAL): a 20d "haven-bid" move over three `=X` FX pairs —
// EURUSD=X (USD per EUR), CHF=X (CHF per USD), JPY=X (JPY per USD). Each leg's haven-bid signed move =
// −(20d return): a FALLING series is danger (POLARITY IS LOAD-BEARING — all three fall in a flight-to-
// safety; Stage 4.2 tests assert each sign, so a flip fails loudly). Worst-of (max) classified against
// FXH_AMBER/FXH_RED, direction HIGH, edges inclusive (≥). Feeds ONLY the T1 dial's Flight family via
// GLOBAL_FAMILIES. Own closes-provider fetches (×3), NOT in INDICATORS/PRICE_SCORERS/…; series:"EURUSD=X" is the
// primary/charted leg. FXH_AMBER/FXH_RED live on FXH_DESCRIPTOR (family-descriptor-rows.ts).

/**
 * Raw FX-haven state from the worst-of 20d haven-bid move. Direction HIGH: Red ≥ FXH_RED, Amber ≥
 * FXH_AMBER, both edges inclusive (matching scoreOil's return bands).
 */
export function fxHavenState(
  havenMove: number,
  amber: number = FXH_AMBER,
  red: number = FXH_RED,
): State {
  if (havenMove >= red) return "RED";
  if (havenMove >= amber) return "AMBER";
  return "GREEN";
}

/**
 * Pure per-day FX-haven move series (oldest→newest) shared by scorer and read-API. Inner-joins the 3
 * FX series (alignByDates); each day with a full 20d lookback gets each leg's −(20d return) haven-bid
 * move (polarity is load-bearing, see block header) and the WORST-OF (max). `eurMove`/`chfMove`/`jpyMove`
 * the per-leg moves, `havenMove[i] = max(...)`; first VELOCITY_WINDOW days dropped. Pure: no IO.
 */
export function fxHavenMoveSeries(
  usEur: Observation[], // EURUSD=X (USD per EUR) — primary/charted
  chfUsd: Observation[], // CHF=X (CHF per USD)
  jpyUsd: Observation[], // JPY=X (JPY per USD)
): {
  dates: string[];
  eurMove: number[];
  chfMove: number[];
  jpyMove: number[];
  havenMove: number[];
} {
  const { dates, values } = alignByDates([usEur, chfUsd, jpyUsd]);
  const [eur = [], chf = [], jpy = []] = values;

  const outDates: string[] = [];
  const eurMove: number[] = [];
  const chfMove: number[] = [];
  const jpyMove: number[] = [];
  const havenMove: number[] = [];
  for (let i = VELOCITY_WINDOW; i < eur.length; i++) {
    // Each leg's haven-bid move = −(20d return): a FALLING series is the danger.
    const e = -(at(eur, i) / at(eur, i - VELOCITY_WINDOW) - 1);
    const c = -(at(chf, i) / at(chf, i - VELOCITY_WINDOW) - 1);
    const j = -(at(jpy, i) / at(jpy, i - VELOCITY_WINDOW) - 1);
    outDates.push(at(dates, i));
    eurMove.push(e);
    chfMove.push(c);
    jpyMove.push(j);
    havenMove.push(Math.max(e, c, j)); // worst-of = strongest single haven bid
  }
  return { dates: outDates, eurMove, chfMove, jpyMove, havenMove };
}

/**
 * FX-haven composite as a FULL per-day `Reading[]` (oldest→newest): worst-of the 3 legs' 20d haven-bid
 * move (fxHavenState), folded through CONFIRM_CLOSES. `level` = the EURUSD=X close. Pure: no IO.
 */
export function fxHavenReadingSeries(
  indicator: Indicator,
  usEur: Observation[], // EURUSD=X (USD per EUR) — primary/charted
  chfUsd: Observation[], // CHF=X (CHF per USD)
  jpyUsd: Observation[], // JPY=X (JPY per USD)
  amber: number = FXH_AMBER,
  red: number = FXH_RED,
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): Reading[] {
  const { havenMove } = fxHavenMoveSeries(usEur, chfUsd, jpyUsd);

  // Re-align EURUSD=X for level/delta20 (buildReadings reads its closes over the same aligned dates).
  const { dates, values } = alignByDates([usEur, chfUsd, jpyUsd]);
  const eur = at(values, 0);
  // Config seam: a stronger haven bid is more danger, fires HIGH (≥) ⇒ firesHighward=true.
  const { amber: aB, red: rB } = resolveBands(indicator.id, amber, red, true, config);
  const rawStates: State[] = havenMove.map((m) => fxHavenState(m, aB, rB));
  return buildReadings(indicator, eur, dates, rawStates, VELOCITY_WINDOW);
}

export function scoreFxHaven(
  indicator: Indicator,
  usEur: Observation[],
  chfUsd: Observation[],
  jpyUsd: Observation[],
): Reading {
  const { values } = alignByDates([usEur, chfUsd, jpyUsd]);
  const aligned = values[0]?.length ?? 0; // 3-way inner-join length — the real usable days
  const minLen = VELOCITY_WINDOW + CONFIRM_CLOSES; // enough aligned days for ≥CONFIRM_CLOSES raw states
  return latest(indicator, fxHavenReadingSeries(indicator, usEur, chfUsd, jpyUsd), minLen, aligned, "aligned closes");
}

// GB_SYMBOLS (fixed-order basket) and GB_AMBER/GB_RED live on GB_DESCRIPTOR (family-descriptor-rows.ts);
// imported + re-exported above.

/**
 * Raw GB state from the participation fraction (0..1). Direction LOW (thin participation = danger):
 * Red < GB_RED, Amber < GB_AMBER, both edges strict `<`.
 */
export function globalBreadthState(
  participation: number,
  amber: number = GB_AMBER,
  red: number = GB_RED,
): State {
  if (participation < red) return "RED";
  if (participation < amber) return "AMBER";
  return "GREEN";
}

/**
 * GB global breadth as a FULL per-day `Reading[]`: the fraction of breadth ETFs above their OWN MA200.
 * Symbols with < MA_WINDOW obs are DROPPED from the denominator (not counted below-MA=0, which would
 * fake a collapse); survivors inner-joined, scored (globalBreadthState), folded through CONFIRM_CLOSES.
 * `level` = participation. Guard-light: no survivors / < MA_WINDOW aligned days → []. Pure: no IO.
 */
export function globalBreadthReadingSeries(
  indicator: Indicator,
  bySymbol: Record<string, Observation[]>,
  amber: number = GB_AMBER,
  red: number = GB_RED,
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): Reading[] {
  // Drop symbols too short for their own MA200 — excluded from the denominator, never counted 0.
  const survivors = GB_SYMBOLS.map((s) => bySymbol[s] ?? []).filter((s) => s.length >= MA_WINDOW);
  const { dates, values } = alignByDates(survivors);
  const L = dates.length;
  // Participation per day = fraction above own MA200. An EXPANDING window before 200d exists keeps
  // the series real-valued (delta20 never reads NaN); only days with a FULL 200-day window emit.
  const part: number[] = [];
  for (let i = 0; i < L; i++) {
    const start = Math.max(0, i - MA_WINDOW + 1);
    let above = 0;
    for (const col of values) if (at(col, i) > mean(col, start, i)) above++;
    part.push(above / values.length);
  }
  const baseOffset = MA_WINDOW - 1;
  // Config seam: LOW direction — thin participation is the risk ⇒ firesHighward=false.
  const { amber: aB, red: rB } = resolveBands(indicator.id, amber, red, false, config);
  const rawStates: State[] = [];
  for (let i = baseOffset; i < L; i++) rawStates.push(globalBreadthState(at(part, i), aB, rB));
  return buildReadings(indicator, part, dates, rawStates, baseOffset);
}

export function scoreGlobalBreadth(
  indicator: Indicator,
  bySymbol: Record<string, Observation[]>,
): Reading {
  const series = globalBreadthReadingSeries(indicator, bySymbol);
  const minLen = MA_WINDOW + CONFIRM_CLOSES; // enough aligned days for ≥CONFIRM_CLOSES raw states
  // Aligned length = series.length + baseOffset, so the guard counts real usable days.
  return latest(indicator, series, minLen, series.length + (MA_WINDOW - 1), "aligned closes");
}

// DISP global dispersion (GLOBAL): are SPY (US) · FEZ (Europe) · EEM (EM) falling TOGETHER? Metric =
// rolling 20d MEAN PAIRWISE return-correlation, GATED by a NEGATIVE 20d basket return. Broad AND down
// = danger (feeds the dial's Dispersion family + the §5 +1 tail bump). `channel:"GLOBAL"`. Own price
// fetches (SPY reused, FEZ/EEM new), NOT in INDICATORS/PRICE_SCORERS/….
//
// NaN GUARD (LOAD-BEARING): a zero-variance leg gives 0/0 = NaN. TWO-TIERED — SOME pairs degenerate ⇒
// each contributes 0 with the denominator held at 3 (the day scores off live pairs); EVERY pair
// degenerate ⇒ `meanPairwiseCorr` returns NaN, `dispersionReadingSeries` DROPS such days off the TAIL
// and `scoreDispersion` THROWS when the LAST aligned close got no reading (DISP degrades out of the
// family) rather than persisting a fabricated GREEN. A REAL-variance fixture is required to reach any reading.

/**
 * Raw dispersion state (redesign 2026-07-22). NEGATIVE basket AND `meanCorr > corrCut` (STRICT) both
 * required; basket DEPTH splits the tiers:
 *   RED    basket < DISP_BASKET_RED (−2.5%)
 *   AMBER  basket ∈ [DISP_BASKET_RED, 0), DEEPENED to RED when meanCorr >= corrP90 (B2, 2026-09-08)
 *   GREEN  basket ≥ 0 (or NaN), OR corr ≤ corrCut (or NaN)
 */
export function dispersionState(
  meanCorr: number,
  basketReturn: number,
  corrCut: number = DISP_CORR,
  corrP90: number = NaN,
): State {
  // ⚠ NaN-SAFE on BOTH gates, must stay so: `!(x < 0)` is NOT `x >= 0`. A NaN basket/corr makes the
  // inner compare FALSE ⇒ `!(...)` TRUE ⇒ GREEN (fail-safe). The positive form would let NaN reach RED
  // — a false push. `alignByDates` filters only `undefined`, not finiteness, so 0/0 can reach here.
  if (!(basketReturn < 0)) return "GREEN"; // basket not negative (or NaN) ⇒ no de-risk
  if (!(meanCorr > corrCut)) return "GREEN"; // corr confirm fails (or NaN) ⇒ GREEN [STRICT >]
  if (basketReturn < DISP_BASKET_RED) return "RED"; // depth splits the tiers
  // B2 deepener: corr ≥ its own rolling p90 lifts the shallow tier. `>= NaN` is FALSE, so a warm-up
  // (or no cut) is a NO-OP, never a spurious RED — pinned in the scorer tests.
  return meanCorr >= corrP90 ? "RED" : "AMBER";
}

/**
 * Pearson correlation over [w0, w1], or `null` when DEGENERATE (a zero-variance leg ⇒ 0/0 = NaN, so
 * correlation is undefined, not 0). The caller decides what undefined means (block header's two tiers).
 */
function pairwiseCorr(a: number[], b: number[], w0: number, w1: number): number | null {
  const n = w1 - w0 + 1;
  let ma = 0;
  let mb = 0;
  for (let i = w0; i <= w1; i++) {
    ma += at(a, i);
    mb += at(b, i);
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = w0; i <= w1; i++) {
    const da = at(a, i) - ma;
    const db = at(b, i) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null; // zero variance ⇒ correlation UNDEFINED (not 0)
  return cov / Math.sqrt(va * vb);
}

/** Mean of the three pairwise SPY·FEZ·EEM correlations over [w0, w1]. A degenerate pair still counts
 *  in the DENOMINATOR (contributes 0) so one quiet leg can't silence live pairs; only when EVERY pair
 *  is degenerate does it return `NaN` (the caller's no-read signal, block header). */
function meanPairwiseCorr(rets: number[][], w0: number, w1: number): number {
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  let sum = 0;
  let live = 0;
  for (const [a, b] of pairs) {
    const c = pairwiseCorr(at(rets, a), at(rets, b), w0, w1);
    if (c === null) continue; // degenerate pair ⇒ contributes 0, denominator unchanged
    sum += c;
    live++;
  }
  if (live === 0) return NaN; // EVERY pair degenerate ⇒ no information in this window
  return sum / pairs.length;
}

/**
 * DISP as a FULL per-day `Reading[]` (oldest→newest): inner-join SPY·FEZ·EEM, form daily returns, per
 * day compute the mean pairwise 20d corr + 20d basket return, score (dispersionState), fold through
 * CONFIRM_CLOSES. `level` = mean pairwise corr. Guard-light; a TRAILING all-degenerate run is DROPPED
 * (block header), [] when no emitted day carries information. Pure: no IO.
 */
export function dispersionReadingSeries(
  indicator: Indicator,
  spy: Observation[],
  fez: Observation[],
  eem: Observation[],
  corrCut: number = DISP_CORR,
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): Reading[] {
  const { dates, values } = alignByDates([spy, fez, eem]);
  const [s = [], f = [], e = []] = values;

  // Daily simple returns per series (rets[k][i-1] ↔ price index i): length L-1.
  const rets = [s, f, e].map((v) => {
    const r: number[] = [];
    for (let i = 1; i < v.length; i++) r.push(at(v, i) / at(v, i - 1) - 1);
    return r;
  });

  // `level` per day = mean pairwise corr, must be real-valued END-TO-END (delta20 reads meanCorr[0]
  // and the backfill persists early readings; delta20 is NOT NULL). EXPANDING corr window (clamped w0)
  // before a full 20d window keeps it finite; for i ≥ VELOCITY_WINDOW the window is the SAME full 20d
  // slice, so emitted levels/states don't drift.
  const meanCorr: number[] = new Array<number>(s.length).fill(0);
  const informative: boolean[] = new Array<boolean>(s.length).fill(false);
  for (let i = 1; i < s.length; i++) {
    const m = meanPairwiseCorr(rets, Math.max(0, i - VELOCITY_WINDOW), i - 1);
    // NaN ⇒ every pair degenerate. The stored level stays real-valued (delta20 NOT NULL), so such a
    // day keeps the 0; the uninformative-TAIL case is handled below.
    meanCorr[i] = Number.isNaN(m) ? 0 : m;
    informative[i] = !Number.isNaN(m);
  }
  // The guard is PER-READ, not history-wide: a history-wide "was any day ever informative?" test lets
  // a frozen tail publish its forced-0 level as a fabricated GREEN. So DROP trailing degenerate days
  // (the last EMITTED day must carry ≥1 non-degenerate pair) and emit nothing when none survives
  // (scoreDispersion then throws, DISP degrades out of the family). INTERIOR degenerate days keep their
  // forced 0 and still emit — the level column must stay real-valued end-to-end for delta20's NOT NULL.
  let end = s.length - 1;
  while (end >= VELOCITY_WINDOW && !informative[end]) end--;
  if (end < VELOCITY_WINDOW) return [];
  // Config seam: the corr confirm gate fires HIGH (meanCorr > cut) ⇒ firesHighward=true.
  const m = resolveMultiplier(indicator.id, config);
  const cut = earlierCut(corrCut, true, m);
  // B2 deepener cut, per day. The percentile sees the INFORMATIVE-MASKED corr: a degenerate day's
  // forced 0 is a fabricated low that would drag the cut down (rollingPercentile skips non-finite).
  const corrP90 = rollingPercentile(
    meanCorr.map((v, i) => (informative[i] ? v : NaN)),
    DISP_CORR_P,
    DISP_CORR_P_WINDOW,
    DISP_CORR_P_MIN_OBS,
  );
  const rawStates: State[] = [];
  // Index-aligned to rawStates: the per-day 20d basket return, persisted as `decision`. DISP has NO
  // `derived` descriptor, so decisionAt would return null and the basket would be thrown away.
  const baskets: (number | null)[] = [];
  for (let i = VELOCITY_WINDOW; i <= end; i++) {
    const w0 = i - VELOCITY_WINDOW; // full 20d window backing the emitted level/state
    // 20d basket return = mean over the three series of price[i]/price[i-20] − 1.
    const basket = (at(s, i) / at(s, w0) - 1 + (at(f, i) / at(f, w0) - 1) + (at(e, i) / at(e, w0) - 1)) / 3;
    baskets.push(basket);
    rawStates.push(dispersionState(at(meanCorr, i), basket, cut, at(corrP90, i)));
  }
  return buildReadings(indicator, meanCorr, dates, rawStates, VELOCITY_WINDOW, true, baskets);
}

export function scoreDispersion(
  indicator: Indicator,
  spy: Observation[],
  fez: Observation[],
  eem: Observation[],
): Reading {
  const { dates, values } = alignByDates([spy, fez, eem]);
  const aligned = values[0]?.length ?? 0; // 3-way inner-join length — the real usable days
  const minLen = VELOCITY_WINDOW + CONFIRM_CLOSES; // enough aligned days for ≥CONFIRM_CLOSES raw states
  const series = dispersionReadingSeries(indicator, spy, fez, eem);
  // NO reading on the LAST aligned close but long-enough history ⇒ the all-degenerate case: throw with
  // its own message rather than let `latest` serve an older day or blame history length.
  if (series.at(-1)?.date !== dates.at(-1) && aligned >= minLen) {
    throw new Error(
      `[${indicator.id}] every pair has a zero-variance leg on the latest of ${aligned} aligned closes - no dispersion read`,
    );
  }
  return latest(indicator, series, minLen, aligned, "aligned closes");
}

// R7 bull-steepener composite (RATE confirmer): fires only when the 2y–10y curve STEEPENS (Δ10y −
// Δ2y > 0) driven by a 2y DROP (Δ2y < 0) that dominates (|Δ2y| ≥ the steepening). Composes DGS2 +
// DGS10; severity rides the tail-probability RANK of both legs (BULL_AMBER_P/BULL_RED_P). Cuts +
// provenance → R7_DESCRIPTOR. As a confirmer it raises severity once R1–R4 is elevated, never solo.

/**
 * Per-day DYNAMIC cuts for one R7 day: `drop*` = Δ20(2y) cuts (LOW, inclusive `≤`), `steep*` =
 * Δ20(steepening) cuts (HIGH, inclusive `≥`). NaN on any = still in the rank warm-up ⇒ no state.
 */
export type BullSteepenerCuts = { dropAmber: number; dropRed: number; steepAmber: number; steepRed: number };

/**
 * Raw bull-steepener state from the 20d changes in DGS2 and DGS10. `or` combine: RED on EITHER tail
 * (2y-drop OR steepening), AMBER on either amber tail.
 */
export function bullSteepenerState(d2y: number, d10y: number, cuts: BullSteepenerCuts): State {
  // Bull steepener = a 2y–10y steepening (dSteepen > 0) driven by a dominant 2y drop.
  const dSteepen = d10y - d2y; // 20d change in the 10y − 2y curve
  const shortEndDriven =
    dSteepen > 0 &&
    d2y < 0 &&
    Math.abs(d2y) >= dSteepen;
  if (!shortEndDriven) return "GREEN";
  if (d2y <= cuts.dropRed || dSteepen >= cuts.steepRed) return "RED";
  if (d2y <= cuts.dropAmber || dSteepen >= cuts.steepAmber) return "AMBER";
  return "GREEN";
}

/**
 * The R7 leg+cut series per aligned day. `dSteep` = 20d change in the 10y−2y curve, `shortEndDriven`
 * the shape gate applied before any cut fires. Warm-up days carry NaN legs / `false` gate.
 */
export type BullSteepenerLegs = {
  dates: string[];
  spread: number[];
  d10: number[];
  drop: number[];
  dSteep: number[];
  cuts: { dropAmber: number[]; dropRed: number[]; steepAmber: number[]; steepRed: number[] };
  shortEndDriven: boolean[];
};

/**
 * The ONE expression of R7's scored arithmetic, consumed by both `bullSteepenerReadingSeries` (cron/
 * backfill) and api/series.ts' R7 branch (drawn ink) — the same anti-drift seam as `fxHavenMoveSeries`.
 * Its ranking base is the T10Y3M∩DGS2∩DGS10 inner join — it starts at T10Y3M's first date, never
 * DGS2/DGS10's longer history; a probe or cut arm built on any other base is wrong.
 * Pure: no IO.
 */
export function bullSteepenerLegSeries(
  spreadObs: Observation[],
  dgs2Obs: Observation[],
  dgs10Obs: Observation[],
  mult = 1.0, // `resolveMultiplier("R7")`, DISP-style shared m only; drop cuts fire LOW, steep cuts HIGH
): BullSteepenerLegs {
  // Inner-join all three on common dates: 2y & 10y drive state, the term spread is the headline `level`.
  // Align 2y↔10y first, then intersect with the spread's dates (a missing day on any leg drops from all).
  const { dates: rateDates, a: g2, b: g10 } = alignByDate(dgs2Obs, dgs10Obs);
  const g2By = new Map(rateDates.map((d, i) => [d, at(g2, i)]));
  const g10By = new Map(rateDates.map((d, i) => [d, at(g10, i)]));
  const dates: string[] = [];
  const spread: number[] = [];
  const dgs2: number[] = [];
  const dgs10: number[] = [];
  for (const o of spreadObs) {
    if (!g2By.has(o.date)) continue;
    dates.push(o.date);
    spread.push(o.value);
    dgs2.push(g2By.get(o.date)!);
    dgs10.push(g10By.get(o.date)!);
  }
  // DYNAMIC cuts: rank each leg over a trailing BULL_CUT_WINDOW tail. The Δ arrays are NaN before
  // VELOCITY_WINDOW; rollingPercentile's NaN-skip + strict-pre-t lands the first finite cut at
  // VELOCITY_WINDOW + BULL_MIN_OBS = baseOffset (no warm-up day emits a NaN cut → no false GREEN).
  const drop = dgs2.map((v, i) => (i >= VELOCITY_WINDOW ? v - at(dgs2, i - VELOCITY_WINDOW) : NaN));
  const d10 = dgs10.map((v, i) => (i >= VELOCITY_WINDOW ? v - at(dgs10, i - VELOCITY_WINDOW) : NaN));
  // `d10[i] - drop[i]` is the SAME FP expression the pre-seam inline built (left-associative), so the
  // golden R7 pin cannot move.
  const dSteep = d10.map((v, i) => v - at(drop, i));
  return {
    dates,
    spread,
    d10,
    drop,
    dSteep,
    cuts: {
      dropAmber: rollingPercentile(drop, BULL_AMBER_P, BULL_CUT_WINDOW, BULL_MIN_OBS).map((c) => earlierCut(c, false, mult)),
      dropRed: rollingPercentile(drop, BULL_RED_P, BULL_CUT_WINDOW, BULL_MIN_OBS).map((c) => earlierCut(c, false, mult)),
      steepAmber: rollingPercentile(dSteep, 1 - BULL_AMBER_P, BULL_CUT_WINDOW, BULL_MIN_OBS).map((c) => earlierCut(c, true, mult)),
      steepRed: rollingPercentile(dSteep, 1 - BULL_RED_P, BULL_CUT_WINDOW, BULL_MIN_OBS).map((c) => earlierCut(c, true, mult)),
    },
    // Mirrors `bullSteepenerState`'s gate line; NaN comparisons are false, so warm-up is off.
    shortEndDriven: dSteep.map(
      (s, i) =>
        s > 0 &&
        at(drop, i) < 0 &&
        Math.abs(at(drop, i)) >= s,
    ),
  };
}

/**
 * R7 bull-steepener as a FULL per-day `Reading[]`, aligned to the T10Y3M/DGS2 inner-join at
 * `[VELOCITY_WINDOW..]`. `level` = the headline term spread; only confirmed `state` uses the composite
 * rule. Guard-light. Pure: no IO.
 */
export function bullSteepenerReadingSeries(
  indicator: Indicator,
  spreadObs: Observation[],
  dgs2Obs: Observation[],
  dgs10Obs: Observation[],
): Reading[] {
  const { dates, spread, d10, drop, cuts } = bullSteepenerLegSeries(
    spreadObs,
    dgs2Obs,
    dgs10Obs,
    resolveMultiplier(indicator.id),
  );
  // No `bands`: cuts are per-DAY, so no scalar pair to resolve/draw (the four moving lines reach the
  // chart as `bandCuts` via api/series.ts' R7 branch).
  const baseOffset = VELOCITY_WINDOW + BULL_MIN_OBS;
  return ratioReadingSeries(indicator, spread, dates, {
    minLength: baseOffset + 1,
    baseOffset,
    classify: (i) =>
      bullSteepenerState(at(drop, i), at(d10, i), {
        dropAmber: at(cuts.dropAmber, i),
        dropRed: at(cuts.dropRed, i),
        steepAmber: at(cuts.steepAmber, i),
        steepRed: at(cuts.steepRed, i),
      }),
  });
}

export function scoreBullSteepener(
  indicator: Indicator,
  spreadObs: Observation[],
  dgs2Obs: Observation[],
  dgs10Obs: Observation[],
): Reading {
  // Aligned length = the 3-way inner-join, the same series the reading series builds against.
  const series = bullSteepenerReadingSeries(indicator, spreadObs, dgs2Obs, dgs10Obs);
  const minLen = VELOCITY_WINDOW + BULL_MIN_OBS + CONFIRM_CLOSES;
  // `got` counts aligned closes IN, not scored days OUT — read off the 3-way join, NOT
  // `series.length + baseOffset` (which reports warm-up as input and hides a dead feed).
  const rateDates = new Set(alignByDate(dgs2Obs, dgs10Obs).dates);
  const aligned = spreadObs.reduce((n, o) => n + (rateDates.has(o.date) ? 1 : 0), 0);
  return latest(indicator, series, minLen, aligned, "aligned closes");
}

// ECY excess-CAPE-yield valuation × trend gate: ECY = 1/CAPE − DFII10/100, monthly (F7's CAPE points
// inner-joined with the last daily DFII10 of the month). Scored scalar (`decision`) = the expanding
// percentile RANK of each month's ECY in its strict-prefix history; `level` = ECY in PERCENT. Below
// ECY_MIN_OBS prior months NO reading. Cuts/provenance → ECY_DESCRIPTOR. No CONFIRM fold (monthly
// cadence + the GT gate are the confirmation).

/** Last available value per `YYYY-MM` month key (order-independent; the latest date wins). */
function lastPerMonth(obs: Observation[]): Map<string, Observation> {
  const best = new Map<string, Observation>();
  for (const o of obs) {
    const key = o.date.slice(0, 7);
    const cur = best.get(key);
    if (!cur || o.date > cur.date) best.set(key, o);
  }
  return best;
}

/** Calendar days between two ISO `YYYY-MM-DD` dates. */
const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);

/** Gate-less valuation base: rank ≤ ECY_EXPENSIVE_P (inclusive, direction LOW) = expensive → AMBER. */
function ecyBaseState(rank: number): State {
  return rank <= ECY_EXPENSIVE_P ? "AMBER" : "GREEN";
}

/**
 * One joined MONTH of the ECY walk (oldest→newest): the month's ECY and the ASCENDING strict-prefix
 * history it is ranked against (every joined month BEFORE it, never itself). `sorted` is the walk's
 * LIVE buffer — read it synchronously in the loop body, never retain it. THE ONE join + ranking-base
 * expression, consumed by both `ecyReadingSeries` (state) and `ecyExpensiveCutSeries` (drawn line), so
 * ribbon and line rank against the SAME history.
 */
function* ecyJoinWalk(
  f7: Observation[],
  dfii10: Observation[],
): Generator<{ date: string; ecy: number; sorted: readonly number[] }> {
  const dfiiByMonth = lastPerMonth(dfii10);
  const joined = [...lastPerMonth(f7).values()]
    .filter(
      (p) => p.value > 0 && dfiiByMonth.has(p.date.slice(0, 7)),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ date: p.date, ecy: 1 / p.value - dfiiByMonth.get(p.date.slice(0, 7))!.value / 100 }));
  const sorted: number[] = [];
  for (const { date, ecy } of joined) {
    if (!Number.isFinite(ecy)) continue; // mirror expandingPercentile: never insert, never score
    if (sorted.length >= ECY_MIN_OBS) yield { date, ecy, sorted };
    // Insert AFTER yielding — including the month itself would leak it into its own rank.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(sorted, mid) < ecy) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, ecy);
  }
}

/**
 * The ECY series as one Reading per joined MONTH (oldest→newest) on the `ECY` identity. `decision` =
 * the expanding percentile RANK in its STRICT-PREFIX history; `level` = ECY ×100 (%). `state` is the
 * GATE-LESS base (expensive→AMBER) — GT's trend gate applies only at the live tail (`scoreEcy`). Rows
 * under ECY_MIN_OBS prior months emit nothing. Pure; [] on empty/disjoint.
 */
export function ecyReadingSeries(indicator: Indicator, f7: Observation[], dfii10: Observation[]): Reading[] {
  const out: Reading[] = [];
  for (const { date, ecy, sorted } of ecyJoinWalk(f7, dfii10)) {
    const rank = percentileRank(sorted, ecy);
    const state = ecyBaseState(rank);
    out.push({ indicator, date, level: ecy * 100, delta20: 0, rawState: state, state, decision: rank });
  }
  return out;
}

/** The ECY rows a run stores `estimated`: the newest (open) month always, a closed one while its last DFII10 obs is a
 *  Treasury head — the gap-fill writes a closed month FINAL once that obs is official (`GAP_FILL_DAYS_OF`). */
export function ecyEstimateDates(readings: readonly Reading[], dfii10: Observation[]): string[] {
  const byMonth = lastPerMonth(dfii10);
  return readings.filter((r, i) => i === readings.length - 1 || byMonth.get(r.date.slice(0, 7))?.estimated === true).map((r) => r.date);
}

/** THE ECY rows both writers persist — the cron (`confirmers.ts`, Treasury-grafted R4) and the restate (`backfill.ts`, FRED-only
 *  DFII10) — over the SAME live CAPE fetch (stored F7 on a failed fetch); FRED prints in date order, so a month the cron holds `estimated` is the restate's newest. */
export function ecyRows(indicator: Indicator, f7: Observation[], dfii10: Observation[]): { series: Reading[]; estimateDates: string[] } {
  const series = ecyReadingSeries(indicator, f7, dfii10);
  return { series, estimateDates: ecyEstimateDates(series, dfii10) };
}

/**
 * The exact AMBER boundary of `ecyBaseState` over an ASCENDING strict-prefix history — found with the
 * SAME `count / n ≤ p` comparison the rank uses, so a float edge can't split the two. NOT a type-7
 * `quantile` (interpolation would draw the line a fraction above the real boundary). Empty → NaN.
 */
export function ecyExpensiveCut(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  // The two FP-guard loops never move k for the shipped ECY_EXPENSIVE_P = 0.02: floor(p·n) already satisfies
  // both `k/n ≤ p` and `(k+1)/n > p` for every n ≤ 2e6 (exhaustively checked 2026-10-26) — mutate-equivalents.json rows.
  let k = Math.floor(ECY_EXPENSIVE_P * n);
  while (k + 1 <= n && (k + 1) / n <= ECY_EXPENSIVE_P) k++;
  while (k > 0 && k / n > ECY_EXPENSIVE_P) k--;
  return k < n ? at(sorted, k) : Infinity; // k === n only if p ≥ 1: every value ranks expensive
}

/**
 * The DRAWN amber line of the ECY chart, one cut per scored month, in the same units as `level` (%):
 * AMBER iff `level < cut`. Walks the identical join + strict-prefix buffer `ecyReadingSeries` ranks
 * against, so line and ribbon agree on every month by construction. Pure; [] under the floor.
 */
export function ecyExpensiveCutSeries(f7: Observation[], dfii10: Observation[]): { date: string; cut: number }[] {
  const out: { date: string; cut: number }[] = [];
  for (const { date, sorted } of ecyJoinWalk(f7, dfii10)) out.push({ date, cut: ecyExpensiveCut(sorted) * 100 });
  return out;
}

/**
 * The live ECY reading: the series tail GRADED by GT's confirmed trend — expensive & GT GREEN →
 * AMBER; expensive & GT AMBER/RED → RED; cheap → GREEN regardless (ruled O3). Returns null (caller
 * degrades) rather than fabricate when F7 is older than ECY_MAX_STALE_DAYS vs `now`, the window is
 * under the floor, or the read is expensive while GT is non-live (gtState === null).
 */
export function scoreEcy(
  indicator: Indicator,
  f7: Observation[],
  dfii10: Observation[],
  gtState: State | null,
  now: string,
): Reading | null {
  if (f7.length === 0) return null;
  const newestF7 = f7.reduce(
    (acc, o) =>
      o.date > acc ? o.date : acc,
    at(f7, 0).date,
  );
  if (daysBetween(newestF7, now) > ECY_MAX_STALE_DAYS) return null;
  const tail = ecyReadingSeries(indicator, f7, dfii10).at(-1);
  if (!tail) return null;
  // Stamp the tail's amber cut (drawn `* 100` units) so the read path draws the scored value (Slice 3.1).
  const amberKey = CHART_DESCRIPTOR_OF["ECY"]?.bandCuts?.find((c) => c.level === "amber")?.key;
  const bc = amberKey !== undefined ? finiteBandCuts([[amberKey, ecyExpensiveCutSeries(f7, dfii10).at(-1)?.cut]]) : undefined;
  const stamp = (r: Reading): Reading => (bc ? { ...r, bandCuts: bc } : r);
  if (tail.state === "GREEN") return stamp(tail); // cheap — GREEN regardless of the trend gate (O3)
  if (gtState === null) return null; // expensive but GT non-live — omit, never fabricate
  const state: State = gtState === "GREEN" ? "AMBER" : "RED";
  return stamp({ ...tail, rawState: state, state });
}
