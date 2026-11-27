/**
 * Family-descriptor TYPE freeze + id census (Stage 1.1).
 *
 * CYCLE DISCIPLINE (load-bearing): this module is a RUNTIME LEAF below the `domain-*.ts` split
 * (the `threshold-config.js` precedent). Its ONLY imports are top-level `import type`
 * from `./domain-types.js` — erased at runtime, so `domain → family-descriptor` (value) +
 * `family-descriptor → domain` (type-only) is transitively acyclic.
 *
 * PER-FAMILY FIELDS TABLE (the anti-rework contract — which fields each family uses):
 *
 * | Interface | `family` | Fields used | Members (census) |
 * |---|---|---|---|
 * | `FredFamilyDescriptor` | `"fred-level-velocity"` | `thresholds: Thresholds` (level and/or
 * |   velocity pairs — the convention/prior layer; `resolveCuts`/`CALIB_MAP`/`calibration.json`
 * |   remain the measured layer on top), `direction?`, `cadence?`, `velocityWindow?`
 * |   (`velocityWindow` = the per-id velocity span; carriers and their values live ONLY on the
 * |   `registry.ts` entries — deliberately not enumerated here, since a census parenthetical
 * |   rots on every id ADDED), `chart?: FamilyChartParams`
 * |   | F1 F2 F3 R1 R2 R3 R4 R5 F9 F10 F11 EBP R6 |
 * | `PriceDerivedDescriptor` | `"price-derived"` | `scorer: BespokeRef`,
 * |   `derived?: DerivedView`, `chart?: FamilyChartParams`
 * |   | F4 F5 F6 F8 F13 NVDA SPCONC DB_SMH DB_XLK (stragglers homed here:
 * |     `scoreDownsideBreak` over price feed, via the scorer escape hatch) |
 * | `RatioSpreadDescriptor` | `"ratio-spread"` | `inputs: readonly [string, string]`
 * |   (primary/secondary symbols), `cutKind: "return" | "level" | "spread"`, `window?`,
 * |   `amber`, `red`, `chart?: FamilyChartParams` — Stage 2a merges the four near-duplicate
 * |   scorers onto exactly these params
 * |   | CG VT EURC EPATH BUND |
 * | `CompositeDescriptor` | `"composite"` | `scorer: CompositeScorerRef` (constants = the
 * |   `CMP_*`/`FXH_*`/`GT_*`/`GB_*`/`DISP_*`/`BULL_*`/`VT_STREAK_*` groups, moved in Stage 2b),
 * |   `chart?: FamilyChartParams` (builder escape hatch) | FXH GT GB DISP R7 VTP
 * |     (R7 re-censused 2026-07-24 [USER ruling]: 3 input series, 2-D dominance state —
 * |     not expressible as a two-input ratio/spread; stage2a spec §4. VTP re-censused
 * |     2026-07-24 [USER ruling, stage2b spec §4 OQ-1 option A]: 3 tunables + a streak-banded
 * |     state, no CONFIRM_CLOSES fold — not expressible as `RatioSpreadDescriptor`) |
 * | `GeoHybridDescriptor` | `"geo-hybrid"` | `scorer: BespokeRef` (`scoreOil` for ALL THREE ids —
 * |   `scoreBrent` folded in 2026-08-06, OVX joined the same day; velocity constants
 * |   `G1_AMBER_RET`/`G1_RED_RET` + `BRENT_AMBER_ROC`/`BRENT_RED_ROC` moved in Stage 2b; the price
 * |   ids' VELOCITY window is still the shared `VELOCITY_WINDOW`, so there is no `G1_RET_WINDOW` to
 * |   home, but the LEVEL-gate window `levelWindow` and OVX's `velocityWindow` ARE
 * |   descriptor-resident), plus the `combine` + `level` sibling fields (see below),
 * |   `chart?: FamilyChartParams` | G1 BRENT OVX |
 *
 * Tagged (NOT in any family — design §2 "explicitly tagged raw/context"):
 * - `"context"`: F7 (never scored; chart = `displayBands` — `valueFrom: "capePct"`
 *   expanding-percentile bands, rendered by the chart rail's context route,
 *   `contextChart` in src/chart-rail.ts).
 * - `"raw"`: every id in `SLOW_INDICATORS`, `PENSION_INDICATORS`, `BOTTOM_INDICATORS`
 *   (off-ladder display/persist channels, no threshold semantics).
 *
 * Export names are FROZEN — Stages 2–4 only POPULATE; a reshape after this commit is a
 * stop-and-replan signal (design §7).
 */
import type { Thresholds, Direction, Cadence, DerivedView } from "./domain-types.js";

export type FamilyId =
  | "fred-level-velocity" // generic FRED/velocity classify family
  | "price-derived" // bespoke price scorers
  | "ratio-spread" // two-input ratio/spread scorers
  | "composite" // multi-input CMP_* composites
  | "geo-hybrid"; // G1 oil shock
export type FamilyTag = FamilyId | "raw" | "context"; // raw/context = charted/persisted, never scored by a family scorer

/** ESCAPE HATCH (design §3.1/§3.2): a bespoke scorer or chart builder is NAMED here, and its
 *  tunable constants live in `constants` (registry/descriptor-resident) — never module-level. */
export interface BespokeRef {
  ref: string; // exported fn name, e.g. "scoreDownsideBreak", "buildFxhChart"
  constants: Readonly<Record<string, number | null>>; // null = an absent cut leg (F6 amber)
}
/** Δ unit `oatVelocityZ` z-scores: `"log"` (Δlog, scale-free) or `"bp"` (the raw change). */
export const VELOCITY_MEASURES = ["log", "bp"] as const;
export type VelocityMeasure = (typeof VELOCITY_MEASURES)[number];
/** A composite's `BespokeRef`, whose constants may also carry a velocity leg's `measure`. */
export interface CompositeScorerRef {
  ref: string;
  constants: Readonly<Record<string, number | null | VelocityMeasure>>;
}

/** Declarative chart params (design §3.2) — designed against the two hardest cases:
 *  BAA10Y dual-axis and F7 CAPE-mean overlay. Stage 4 builds the per-family builders that
 *  render these into `ChartSpec` (src/api/types.ts); Stage 1 only freezes the shape.
 *
 *  WORKED HARDEST-CASE MAPPINGS (proof the type expresses the two §7-risk cases, so
 *  Stage 4 cannot discover it can't):
 *  - BAA10Y (the indicator retired 2026-08-11 — the dual-axis route it proved out now renders
 *    F2/R4/T10YIE/T5YIFR via `dualAxisChart`, src/chart-rail.ts). Its worked mapping was:
 *    `dualAxis: { unit: "", label: "Baa−10y Δ30d", compute: "roc", window: 30 }`,
 *    `lead: 30`, `legBands: true` — level band pair on primary from `thresholds`,
 *    velocity pair on the dualAxis, both `threshold`.
 *  - F7 (rendered by the chart rail's context route — `contextChart`, src/chart-rail.ts,
 *    since slice 4.4): `displayBands: [{ level: "amber", valueFrom: "capePct", p: 0.8 }, …]`;
 *    degraded feed (cuts `null`) falls through to the `"context-only"` sentinel. */
export interface FamilyChartParams {
  /** F1 case: right-hand RoC axis carrying the velocity band pair.
   *  `compute: "roc"` = the client recomputes the change from the plotted level (needs
   *  `window` + a matching `lead` warmup — only the `"roc30"` hook exists on the wire).
   *  `compute: "storedDelta"` (F2, 2026-07-28) = the axis plots the PERSISTED `delta20`
   *  column, i.e. the very number the velocity leg scored, so there is nothing to
   *  recompute and no warmup: omit `window`/`lead` and the span comes from the
   *  indicator's own `velocityWindow` (absent ⇒ the global `VELOCITY_WINDOW`). `label`
   *  is optional on that route — the rail composes "<label> Δ<window>d" from the same
   *  resolved window, so the axis caption cannot claim a span the line does not carry.
   *  The per-observation WORD in that composed caption comes from the indicator's own
   *  `obsCadence ?? cadence` (`domain-types.ts`). A nested `obsCadence` used to live here and
   *  RETIRED 2026-08-07: only a dual-axis id could carry it, which left F9 — same
   *  weekly-released / daily-observed shape, but no `CHART_PARAMS_OF` entry since its level
   *  axis was retired — unable to declare the grid at all. Neither field ever touched the
   *  span: that stays the one resolved `velocityWindow`. */
  dualAxis?: {
    unit: string;
    label?: string;
    compute: "roc" | "storedDelta";
    window?: number;
    /** DISPLAY-ONLY σ multiple drawn as a faint MOVING line on the secondary axis (`SIGMA_REF_KEY`),
     *  beside the scored σ pair — a reading aid, never a cut. `velocitySigma` ids only (`dualAxisChart` throws otherwise). */
    refSigma?: number;
  };
  /** F7/VT/EURC case: display-only band overlays. `valueFrom: "capePct"` = resolved at
   *  request time as the `p` expanding-percentile quantile of the id's own stored history
   *  (F7, api/indicators.ts `capeBandLevels`); `"static"` reads `value`; `"perPoint"` (ECY) is a
   *  per-DATE moving line read off the id's `POINT_BAND_CUTS_OF` wire key. One-sided bands
   *  allowed. */
  displayBands?: ReadonlyArray<{
    level: "amber" | "red";
    valueFrom: "static" | "capePct" | "perPoint";
    value?: number; // valueFrom:"static" only
    p?: number; // valueFrom:"capePct" only — the expanding-percentile quantile
    label?: string;
  }>;
  window?: number; // visible trading days (F1: ARM_RANGE_WINDOW)
  lead?: number; // undrawn leading points feeding a windowed compute (F1: vel window)
  fromDays?: number; // date-anchored window (aligned-start ids)
  legBands?: boolean; // per-leg band pairs; renderer must not swap in eff composite (F1)
  builder?: BespokeRef; // ESCAPE HATCH: bespoke ChartSpec builder (FXH, GB, DISP, F4-gate overlays)
}

/** Generic FRED/velocity classify family — level and/or velocity threshold pairs are the
 *  convention/prior layer; `resolveCuts`/`CALIB_MAP`/`calibration.json` remain the measured
 *  layer on top. */
export interface FredFamilyDescriptor {
  family: "fred-level-velocity";
  thresholds: Thresholds;
  direction?: Direction;
  cadence?: Cadence;
  /** Velocity-window sub-family — the per-id span; carriers and values live on the
   *  `registry.ts` entries, never enumerated here (that list rots on every id added). */
  velocityWindow?: number;
  chart?: FamilyChartParams;
}

/** Bespoke price scorers (F4/F5/F6/F8/F13/NVDA/SPCONC + the DB_* downside-break detectors). */
export interface PriceDerivedDescriptor {
  family: "price-derived";
  scorer: BespokeRef;
  derived?: DerivedView;
  chart?: FamilyChartParams;
}

/** Two-input ratio/spread scorers — Stage 2a merges the four near-duplicate scorers onto
 *  exactly these params. */
export interface RatioSpreadDescriptor {
  family: "ratio-spread";
  /** Primary/secondary symbols. */
  inputs: readonly [string, string];
  cutKind: "return" | "level" | "spread";
  window?: number;
  amber: number;
  red: number;
  /** `cutKind: "spread"` only: scored + PERSISTED value = trailing mean of the last `meanWindow` spreads
   *  (head rows emit nothing). Value-domain re-scores strip it (`ratioSpreadReadingSeriesFromValues`). */
  meanWindow?: number;
  /** `cutKind: "spread"` only: "HIGH" swaps the strict-`<` LOW edges for `"level"`'s (`>` red, `≥` amber). */
  direction?: "HIGH";
  /**
   * OPTIONAL SECOND LEG — a LEVEL band on the combined series, orthogonal to `cutKind`
   * (which describes the VELOCITY leg's scored scalar and edge rule). Absent on
   * `VT`/`EURC`/`BUND`, which therefore score exactly as before.
   *
   * `"expanding-percentile"`: the cuts are the `amberP`/`redP` quantiles of the value
   * series' OWN expanding, look-ahead-clean distribution (`expandingPercentile`,
   * src/percentile.ts) — scale-free by construction, so a structural drift in the level
   * cannot pin the band the way a fixed cut does (the retired `BRENT_RED_LEVEL = $100`).
   * Direction LOW with STRICT `<` edges, matching `cutKind: "spread"`.
   *
   * `"detrended-expanding-percentile"` (2026-08-08): the SAME expanding percentile, taken over
   * the value's DEVIATION FROM ITS OWN `trendWindow` TREND (`smaDeviation`, src/percentile.ts)
   * instead of over the raw value. Scale-free is not enough when the level is NON-STATIONARY: a
   * drifting series sits under any low percentile of any long window once it has drifted, which
   * is exactly what pinned CG at a permanent AMBER. Edges,
   * direction and the `amberP`/`redP` pair are unchanged — only the scored scalar moved.
   * ⚠ The scored head grows to `trendWindow − 1 + PCT_MIN_OBS`; the R2 ruling (emit NO reading
   * over an uncovered head, never a velocity-only degrade) carries over unchanged.
   *
   * `"rolling-percentile"` (2026-08-31, R6/N1): the percentile is taken over the RAW value (NO
   * detrend) on a trailing `window` with a `minObs` floor; scored head is `minObs`. Direction is the
   * CALL SITE's (`percentileLevelState`'s `direction` arg) — HIGH for R6, so RED > red / AMBER ≥ amber.
   * This is the IV-Rank percentile-OF-LEVEL the MOVE literature names, replacing L1's inverted detrend.
   */
  levelBand?:
    | { kind: "expanding-percentile"; amberP: number; redP: number }
    | { kind: "detrended-expanding-percentile"; trendWindow: number; amberP: number; redP: number }
    | { kind: "rolling-percentile"; window: number; minObs: number; amberP: number; redP: number };
  /**
   * How the level leg joins the velocity leg — `combineLevelVelocity` (scorers-core.ts),
   * the SAME lattice `GeoHybridDescriptor.combine` uses. Read only when `levelBand` is
   * set; defaults to `"or"`.
   */
  combine?: "and" | "or" | "split";
  /** A bespoke scorer that replaces the unified stack (BUND); `amber`/`red` then feed only its level leg. */
  scorer?: BespokeRef;
  chart?: FamilyChartParams;
}

/** The ONE ratio-spread direction source — scorer edges, `resolveBands` and the drawn chart all read it. */
export function ratioSpreadFiresHighward(desc: RatioSpreadDescriptor): boolean {
  return desc.cutKind === "level" || (desc.cutKind === "spread" && desc.direction === "HIGH");
}

/** Multi-input CMP_* composites (constants = the `CMP_*`/`FXH_*`/`GT_*`/`GB_*`/`DISP_*`
 *  groups, moved in Stage 2b). */
export interface CompositeDescriptor {
  family: "composite";
  scorer: CompositeScorerRef;
  // OPTIONAL second LEVEL leg + how it joins the scorer's own leg — mirrors
  // `RatioSpreadDescriptor.levelBand`/`combine`. MEMBERLESS since 2026-09-04 (the last sovereign
  // band deleted; R6's 2026-09-02) ⇒ undefined ⇒ no level leg ⇒ every composite scores byte-identically.
  levelBand?:
    | { kind: "expanding-percentile"; amberP: number; redP: number }
    | { kind: "detrended-expanding-percentile"; trendWindow: number; amberP: number; redP: number }
    | { kind: "rolling-percentile"; window: number; minObs: number; amberP: number; redP: number };
  combine?: "and" | "or" | "split";
  chart?: FamilyChartParams;
}

/**
 * The oil family (G1/WTI + BRENT + OVX), all scored by `scoreOil` since the 2026-08-06 merge — a
 * LEVEL leg and a VELOCITY leg joined by `combine`.
 *
 * `combine` and `level` are SIBLING FIELDS, not `scorer.constants` entries, because
 * `BespokeRef.constants` is `Readonly<Record<string, number>>` — strings have no home there (the
 * same reason `GB_SYMBOLS` sits module-level, see its docblock). Keeping them as data is the whole
 * point of the R3 merge: an OR ⇄ AND flip is a one-word edit here, and the tests read these fields
 * rather than hard-coding the expected combined state.
 *
 * The numeric knobs stay in `constants`: the velocity bands (`amberRet`/`redRet`,
 * `amberRoc`/`redRoc`, mirrored into the registry `derived` block for the ids that have one),
 * `levelWindow` (the trailing-peak lookback in TRADING days the level gate compares against) and
 * `velocityWindow` (OVX's spike window — mirrored into its registry `derived` block, which is what
 * `scoreOil` actually scores the spike leg against and what `derivedChart` draws).
 */
export interface GeoHybridDescriptor {
  family: "geo-hybrid";
  scorer: BespokeRef;
  /** How the level leg and the velocity band are joined — see `combineLevelVelocity`. */
  combine: "and" | "or" | "split";
  /**
   * WHICH level leg. `"trailing-peak"` — the binary Hamilton gate over `levelWindow` (the PRICE
   * ids). `"fixed"` — a severity BAND read off the indicator's own `thresholds.amberLevel`/
   * `redLevel`, i.e. exactly the level leg the generic `scoreIndicator` path scored before the id
   * joined this family (OVX's regime read).
   */
  level: "trailing-peak" | "fixed";
  chart?: FamilyChartParams;
}

/**
 * Trading days → calendar days (×365/252, rounded up) — the SOLE home of that ratio, so no caller
 * re-types it. Lives in this leaf (not `scripts/backfill.ts`, which re-exports it for its own
 * importers) because `DETAIL_WINDOW_DAYS` below needs it and `src/` must not import from `scripts/`.
 */
export function tradingToCalendarDays(tradingDays: number): number {
  return Math.ceil((tradingDays * 365) / 252);
}
