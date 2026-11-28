/**
 * Chart rail (Stage 4) — family chart-spec builders replacing the id-branches of
 * `buildChartInner` (api/indicators.ts). Import SINK: imported ONLY by `api/indicators.ts`
 * (and transitively by `src/goldens/dispatch.ts` through it) — no `src/` module may import
 * this file without a transitive cycle walk first (spec §1.4).
 *
 * Slice 4.1: the four non-id routes live here (downside, derived-kind, generic
 * hasLevel/hasVelocity, context-only sentinel). Slice 4.2 adds the bespoke-builder route
 * (`BESPOKE_BUILDERS` via `CHART_PARAMS_OF[id].builder` — GB first) and the ratio-spread
 * family route (shared `displayBandChart` shape over `RATIO_DESCRIPTOR_OF`). Slice 4.3 adds
 * the dual-axis route (`dualAxisChart` — F2 declarative; F1 via its exposure-sourced
 * `buildF1Chart` bespoke ref). Slice 4.4 completes the rail: FXH/DISP bespoke builders and
 * route 7 (`contextChart` — the F7 capePct displayBands); `buildChartInner` is deleted.
 */
import { calibLegsFor } from "./domain-cuts.js";
import { cusumParams } from "./domain-legs.js";
import { DOWNSIDE_DETECTOR_IDS } from "./registry-price.js";
import { downsideCuts } from "./scorers-price.js";
import { MA_WINDOW } from "./family-descriptor-rows.js";
import {
  VELOCITY_WINDOW,
  type Indicator,
  type DerivedView,
  type Thresholds,
  type PostInversionCooldown,
  type DrawdownLeg,
} from "./domain-types.js";
import { ratioSpreadFiresHighward, type FamilyChartParams } from "./family-descriptor-core.js";
import {
  CHART_PARAMS_OF,
  DISP_BASKET_RED,
  DISP_CORR,
  DISP_CORR_P,
  DISP_CORR_P_WINDOW,
  FAMILY_OF,
  GB_AMBER,
  GB_RED,
  CURVE_DESCRIPTOR_OF,
  VELOCITY_Z_CONSTANTS_OF,
  R6_DESCRIPTOR,
  CQS_CUT_BANDS,
  CQS_DESCRIPTOR,
  RATIO_DESCRIPTOR_OF,
  SECOND_LEG_CHART_OF,
  CHART_DESCRIPTOR_OF,
  POINT_BAND_CUTS_OF,
  PRICE_WINDOWS,
  XDEV_GATE_DESCRIPTOR,
  POINT_BAND_SIGMA_CUTS,
  SIGMA_REF_KEY,
  POST_INVERSION_BAND,
  R1_DRAWDOWN_BAND,
  R8_MEAN_CUT_BANDS,
  F3_VELOCITY_BAND,
  SYNTH_AMBER_PCTILE,
  R7_CUT_BANDS,
  BULL_AMBER_P,
  BULL_RED_P,
  SMOOTHED_LEVEL_OF,
  GEO_HYBRID_DESCRIPTOR_OF,
} from "./family-descriptor-rows.js";
import { resolveBands } from "./threshold-config.js";
// Direct src/gates.ts import (like fred.ts in api/series.ts) — single source shared with the /series emitter.
import { GATES, maMultSuffix, type GateDef } from "./gates.js";
// F1's detail-chart window + Δ30d overlay span single-source from the exposure engine
// constants (E1 feedback batch, Stage 3): a retune moves the drawn line WITH the score.
// `exposure.ts` value-imports `registry-fred`/`registry-composite`/`scorers-core`/`slow`, so
// `registry-fred.ts`/`registry-composite.ts`/`family-descriptor-rows.ts` importing it would close a
// value cycle (`registry.ts` would not) — hence F1 stays a bespoke builder here.
import { ARM_RANGE_WINDOW, ARM_ROC_WINDOW } from "./exposure.js";
import { SEMIS_MOVE_MEDIAN, SEMIS_VOL_MEDIAN, SPIT_YEN_GATE } from "./ladder-jobs.js";
// price-accel's scoring cuts, from their defining file `slow.ts`.
import {
  ACCEL_AMBER_PCTILE,
  ACCEL_RED_PCTILE,
  NEAR_HIGH_FRAC,
  PERSIST_M,
  PERSIST_N,
  VIX_LOW_PCTILE,
} from "./slow.js";
// F3's synth level percentile — the perPoint band LABEL single-sources it (never a literal `85`).
import type { ChartAxis, ChartBand, ChartSeries, ChartSpec } from "./api/types.js";
import type { CurveDescriptor } from "./scorers-composite.js";

/** The downside-break detector ids (registry DOWNSIDE_DETECTORS) — their detail charts plot
 *  the derived drawdown, not the stored close (Part A, 2026-07-21). Both DB_SMH and DB_XLK
 *  (2026-07-23) are WIRED to the notify path via the WATCH-capped `ew` escalator floor. This
 *  drawdown chart spec is a rendering concern independent of wiring, but it is NOT
 *  symbol-agnostic: the cuts are PER DETECTOR (`downsideCuts` — both −5/−8 today, separately tunable),
 *  so the branch below resolves them off the id (see its comment). */
const DOWNSIDE_IDS = new Set(DOWNSIDE_DETECTOR_IDS);

/** The per-observation word for a velocity span, taken from the indicator's own OBSERVATION
 *  grid — a weekly-observed series' `delta20` spans `velocityWindow` WEEKS, not days, so the
 *  shared "Δ<n>d" caption would name a span the line does not carry.
 *  Absent cadence = daily (the wire's documented default).
 *
 *  ⚠ TRAP — `cadence` is the RELEASE schedule, and for some ids that is NOT the observation
 *  grid `delta20` steps over. G1/BRENT declare `cadence: "weekly"` for the EIA release (and their
 *  `lagAfterDays`), but `DCOILWTICO`/`DCOILBRENTEU` return BUSINESS-DAY rows, so their spans are
 *  TRADING DAYS and a "w" caption is simply wrong — at a 60-observation window, "Δ60w" names
 *  60 weeks against 60 business days, a 5× error.
 *  They declare the id-level `obsCadence: "daily"` (`domain-types.ts`), which is why every call
 *  site here passes `i.obsCadence ?? i.cadence` and never `i.cadence` alone. F9/F11 were carriers
 *  until 2026-08-10, when `USDU`/`CNY=X` (`FEED_OF`, registry.ts) collapsed their grids onto
 *  `cadence: "daily"`; the older `dualAxis.obsCadence` stays retired.
 *  ⚠ The field stays load-bearing rather than redundant: G1/BRENT take the derived chart route,
 *  and the field is live for `notify_format`'s unit word + the FE velocity-span chips. */
function obsWord(cadence: Indicator["cadence"]): string {
  return cadence === "weekly" ? "w" : cadence === "monthly" ? "mo" : cadence === "quarterly" ? "q" : "d";
}

/** The ONE composer for a velocity SPAN caption — `"Δ<window><obs-word>"` (`"Δ20d"`,
 *  `"Δ60d"`, `"Δ4w"`). Deliberately NO spelled-out gloss ("(20-day change)"): the
 *  dual-axis route has never emitted one, and a second phrasing of the same span would be a
 *  second source for it. Both halves resolve from the indicator — the SPAN from the caller's
 *  already-resolved `velocityWindow ?? VELOCITY_WINDOW`, the WORD from `obsCadence ?? cadence`
 *  — so a window retune moves line and caption together with no constant restated.
 *
 *  Two callers, differing only in the id-name prefix, and that difference is the FE's, not a
 *  style choice: the dual-axis SECONDARY caption names its own line against a level line on
 *  the same chart (`"IG OAS Δ20d (right, dashed)"`), while the velocity-only PRIMARY caption
 *  lands in the legend's metric slot, which `public/detail-chart.js` (`velocityLabelUnit`)
 *  already prefixes with `meta.label` — prefixing here too would render "Broad USD Broad USD Δ60d". */
function velocitySpanWord(i: Indicator, velWindow: number): string {
  return `Δ${velWindow}${obsWord(i.obsCadence ?? i.cadence)}`;
}

/** `CHART_PARAMS_OF` lookup — routes 1 (builder ref), 5 (dualAxis) and 7 (displayBands)
 *  all key off it; undefined for every id without declarative chart params. */
function chartParamsOf(i: Indicator): FamilyChartParams | undefined {
  return CHART_PARAMS_OF[i.id];
}

/** Bespoke ChartSpec builders (design §3.2 escape hatch), resolved from
 *  `chart.builder.ref` (`BespokeRef`). Slice 4.2: `buildGbChart`; slice 4.3:
 *  `buildF1Chart`; slice 4.4: `buildFxhChart`/`buildDispChart`. An unknown ref THROWS
 *  loudly in `buildFamilyChart` (same convention as `FAMILY_OF`'s missing-id throw in
 *  registry.ts). */
const BESPOKE_BUILDERS: Record<
  string,
  (i: Indicator, derived: DerivedView | undefined) => ChartSpec
> = {
  buildGbChart,
  buildCqsChart,
  buildBtpChart,
  buildCurveChart,
  buildMoveChart,
  buildF1Chart,
  buildF3Chart,
  buildR8Chart,
  buildR7Chart,
  buildFxhChart,
  buildDispChart,
  buildPriceAccelChart,
  buildComplacencyVixChart,
  buildComplacencyHighChart,
};

/**
 * Family dispatch replacing `buildChartInner` (spec §2 — all 8 routes live since slice
 * 4.4). Internal order preserves the §1.1 branch outcomes exactly — every listed id-set
 * is disjoint from the routes above it.
 */
export function buildFamilyChart(
  i: Indicator,
  derived: DerivedView | undefined,
  capeCuts?: CapeCardCuts | null,
): ChartSpec {
  const spec = withToggleOverlays(i, withRv10(i, withDelta5(i, buildFamilyChartSpec(i, derived, capeCuts))));
  // Stamp the FE layout key: descriptor declaration first, else the spec-shape derivation —
  // the EXACT sniff the FE falls back to on an old payload, so the stamp cannot flip a layout.
  return { ...spec, renderer: CHART_DESCRIPTOR_OF[i.id]?.renderer ?? rendererForSpec(spec) };
}

/** Lookback of the display-only fast-Δ line (`DELTA5_OVERLAY`), in observations. @internal */
export const DELTA5_WINDOW = 5;
/** Per-id opt-in: a display-only blue Δ5 line with NO cuts — user ask 2026-10-10. Always on its own HIDDEN
 *  `fit` scale fitted to the plot — no ticks, no margin, never sharing (so never stretching) an existing
 *  axis — with a faint zero line and its number in the hover only. Both are `single` layout. @internal */
export const DELTA5_OVERLAY: ReadonlySet<string> = new Set(["F1", "CCC"]);
function withDelta5(i: Indicator, spec: ChartSpec): ChartSpec {
  if (!DELTA5_OVERLAY.has(i.id)) return spec;
  const line: ChartSeries = {
    axis: "primary",
    // The level difference on EVERY id: the line sits on its own `fit` scale, so it reads in the re-entry rules' units.
    compute: "delta",
    window: DELTA5_WINDOW,
    style: "trend",
    label: velocitySpanWord(i, DELTA5_WINDOW),
    fit: true,
  };
  return { ...spec, series: [...spec.series, line], lead: Math.max(spec.lead ?? 0, DELTA5_WINDOW) };
}

/** The FE's spec-shape sniff (public/detail-chart.js `genericDetailChart`), expression for
 *  expression — `chart-rail.test.ts` pins every declared `renderer` against it. @internal */
export function rendererForSpec(spec: ChartSpec): "single" | "fx" | "derived" {
  const primSeries = spec.series.filter((s) => s.axis === "primary");
  const secSeries = spec.series.filter((s) => s.axis === "secondary");
  const secAxisSpec = spec.axes.find((a) => a.id === "secondary");
  const isFx = primSeries.some((s) => s.style === "leg" || s.style === "envelope");
  const isDerived = !isFx && secAxisSpec != null && secSeries.some((s) => s.fromPoint === "decision");
  return isFx ? "fx" : isDerived ? "derived" : "single";
}

function buildFamilyChartSpec(
  i: Indicator,
  derived: DerivedView | undefined,
  capeCuts?: CapeCardCuts | null,
): ChartSpec {
  const params = chartParamsOf(i);
  if (params?.builder) {
    const build = BESPOKE_BUILDERS[params.builder.ref];
    if (!build) throw new Error(`chart-rail: unknown chart builder ref "${params.builder.ref}" (id ${i.id})`);
    return build(i, derived);
  }
  if (DOWNSIDE_IDS.has(i.id)) return downsideChart(i);
  if (derived && derived.kind !== "identity") return derivedChart(i, derived);
  // Ratio-spread family route — reached only by the NON-derived, builder-less members (VT, EURC):
  // CG's registry entry carries `derived`, caught by the derived route above (spec §1.2); BUND
  // takes its `buildCurveChart` builder ref above (the velocity leg needs a second axis).
  // Direction is single-sourced with the SCORER via `ratioSpreadFiresHighward` (family-descriptor-core.ts):
  // VT `"level"` / a `direction: "HIGH"` spread → ≥ / > labels; EURC/BUND LOW `"spread"` → < / <.
  if (FAMILY_OF[i.id] === "ratio-spread") {
    const desc = RATIO_DESCRIPTOR_OF[i.id];
    if (!desc) throw new Error(`chart-rail: ratio-spread id "${i.id}" has no RATIO_DESCRIPTOR_OF entry`);
    return displayBandChart(i, desc.amber, desc.red, ratioSpreadFiresHighward(desc));
  }
  // Dual-axis route (slice 4.3) — declarative `dualAxis` params (F2 via
  // `CHART_PARAMS_OF`; F1 renders the same shape but arrives through its `buildF1Chart`
  // builder ref above, because its window/lead constants are exposure-sourced — §1.4).
  if (params?.dualAxis) return dualAxisChart(i, params);
  const generic = genericThresholdChart(i, params);
  if (generic) return generic;
  // Context route (slice 4.4) — declarative `displayBands` with `valueFrom: "capePct"`
  // (F7). A degraded feed passes `capeCuts == null` ⇒ `contextChart` returns undefined ⇒
  // fall through to the context-only sentinel (the unchanged fail-safe: never a bogus line).
  if (params?.displayBands) {
    const ctx = contextChart(i, params, capeCuts ?? null);
    if (ctx) return ctx;
  }
  return contextOnlySpec(i, params);
}

// GB — bespoke ref (family "composite", so the ratio-spread route can't reach it) sharing
// the displayBand shape: scoreGlobalBreadth scores the participation FRACTION 0..1 (the
// stored `value`), direction LOW, strict `<` (globalBreadthState): amber below GB_AMBER,
// red below GB_RED. firesHighward=false (LOW positive cut moves UP toward danger under m<1).
function buildGbChart(i: Indicator): ChartSpec {
  return displayBandChart(i, GB_AMBER, GB_RED, false);
}

// CQS — the EBP-bridge (2026-08-16): the stored `value` is the bridge Δ (yield points), so the card
// paints the bridge, not the retired spread LEVEL. The scoring cuts live in z-space and are per-date
// MOVING (σ varies), which is why this drew band-less until 2026-08-20; the cut pair now rides the
// `perPoint` transport in Δ UNITS — `api/series.ts`' `withCreditBridgeCuts` multiplies each z back by
// the SAME `σ(t)` the scorer divided by (`creditBridgeCutSeries`, scorers-composite.ts), so the drawn
// line and the classified state are one model (U3).
// F9's `velocityBandsFor` / CG's expanding percentile are the same transport.
//
// ⚠ The label COMPOSES the multiple off `CQS_DESCRIPTOR.scorer.constants` via `CQS_CUT_BANDS`' `from`
// key — never a literal, so an R9 retune moves the caption with the line. Two decimals with trailing
// zeros stripped, matching `velocityBandsFor`'s caption rule (1.25 → "1.25σ", 2.0 → "2σ").
//
// ⚠ A day whose σ is undefined (no EBP anchor / too few same-horizon Δs / sub-floor σ) emits NO key,
// so the polyline BREAKS there rather than dropping to 0 — R5's silent-GREEN days are visibly
// un-called, not falsely calm at a zero cut.
/** @internal */
export function buildCqsChart(i: Indicator): ChartSpec {
  const c = CQS_DESCRIPTOR.scorer.constants;
  return {
    axes: [{ id: "primary", side: "left", unit: i.unit ?? "", format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands: CQS_CUT_BANDS.map(
      (b): ChartBand => ({
        level: b.level,
        axis: "primary",
        source: "perPoint",
        fromPoint: b.key,
        label: `${b.level} ${+c[b.from].toFixed(2)}σ of same-horizon Δ`,
      }),
    ),
  };
}

// BONOS — TWO scored legs (`scoreBonosSpread`, combine "or", worst-of), and both are drawn:
//   · ABSOLUTE— the registry `thresholds` bp pair on the PRIMARY axis in the plain severity hues ([USER]
//               2026-09-25 retired the lavender `pair: "level"` hue). Read off `i.thresholds` — the ONE
//               source, never restated.
//               A bandless chart under a level-leg card is the R6 2026-08-30 failure (see the R6 note).
//   · VELOCITY— its z on the SECONDARY axis beside its flat zAmber/zRed bounds; constants read via
//               `VELOCITY_Z_CONSTANTS_OF[id]` (the id's OWN row).
// ⛔ NO `perPoint` block — the id carries no `POINT_BAND_CUTS_OF` row and no `levelBand`.
function buildBtpChart(i: Indicator): ChartSpec {
  const velCfg = VELOCITY_Z_CONSTANTS_OF[i.id];
  if (!velCfg) throw new Error(`buildBtpChart: ${i.id} has no VELOCITY_Z_CONSTANTS_OF row`);
  const { velWindow, velSlowWindow, velSigmaWindow, zAmber, zRed } = velCfg;
  const t = i.thresholds;
  const zLabel = `velocity z (worst of Δ${velWindow}/Δ${velSlowWindow} bp · ${velSigmaWindow}d σ)`;
  return {
    axes: [
      { id: "primary", side: "left", unit: i.unit ?? "", format: "value" },
      { id: "secondary", side: "right", unit: "", format: "value", label: zLabel },
    ],
    // ONE secondary series only — genericSingle draws `secArrs[0]` and silently drops a second.
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      { axis: "secondary", fromPoint: "velZ", style: "primary" },
    ],
    bands: [
      // Emitted PER SIDE off the registry pair (`buildMoveChart`'s shape): a cut the registry does not
      // ship must not become a captioned line whose value resolves `undefined` on the wire.
      ...(t.amberLevel != null
        ? [{ level: "amber", axis: "primary", source: "threshold", metric: "level" } as ChartBand]
        : []),
      ...(t.redLevel != null
        ? [{ level: "red", axis: "primary", source: "threshold", metric: "level" } as ChartBand]
        : []),
      // Secondary-axis σ bounds LAST (legend order); both read off the id's own constants, never restated.
      { level: "amber", axis: "secondary", source: "displayBand", value: zAmber, label: `amber ${+zAmber.toFixed(2)}σ` },
      { level: "red", axis: "secondary", source: "displayBand", value: zRed, label: `red ${+zRed.toFixed(2)}σ` },
    ],
  };
}

// BUND: `scoreCurve` is worst-of three legs, and the
// two drawable ones are drawn. F2's stored-delta dual-axis SHAPE (`dualAxisChart`) supplies the axes + series — the
// persisted `delta20` IS leg (a)'s slope Δ (`bundLegSeries` and `velocityDeltaAt` read the same window) — and the
// bands are composed here, because the curve ids' `thresholds: {}` leaves that shape's registry-sourced pairs empty.
//   · VELOCITY (a) — TWO-SIDED `|Δ| ≥ velAmber/velRed` (`bundVelocityState`, inclusive), so each cut is drawn at BOTH
//               signs on the secondary axis. Read off the id's `CURVE_DESCRIPTOR_OF` row, never restated; NOT routed
//               through `resolveBands` because the scorer compares the raw constants.
//   · LEVEL (b) — the resolved amber cut only (`bundLevelState` caps the level at AMBER, so a red LEVEL line would
//               name a state the leg can never produce — the complacency-vix argument). `resolveBands` is the
//               SAME seam `curveReadingSeries` resolves through.
//   · (c) the 2y re-steepen escalation is NOT drawn: stored rows carry only the slope, not the 2y leg.
function buildCurveChart(i: Indicator): ChartSpec {
  const d = (CURVE_DESCRIPTOR_OF as Readonly<Record<string, CurveDescriptor>>)[i.id];
  if (!d) throw new Error(`chart-rail: curve id "${i.id}" has no CURVE_DESCRIPTOR_OF entry`);
  const spec = dualAxisChart(i, { dualAxis: { unit: i.unit ?? "", compute: "storedDelta" } });
  const { amber } = resolveBands(i.id, d.amber, d.red, false);
  const { velAmber, velRed } = d.scorer.constants;
  const vel = (level: "amber" | "red", cut: number): ChartBand[] => [
    { level, axis: "secondary", source: "displayBand", value: cut, label: `${level} ≥+${cut.toFixed(2)}` },
    { level, axis: "secondary", source: "displayBand", value: -cut, label: `${level} ≤−${cut.toFixed(2)}` },
  ];
  return {
    ...spec,
    bands: [
      { level: "amber", axis: "primary", source: "displayBand", value: amber, label: `amber <${amber.toFixed(2)} (level caps at amber)` },
      ...vel("amber", velAmber),
      ...vel("red", velRed),
    ],
  };
}

// R6 MOVE — TWO scored legs (`scoreMoveLevel`, combine "or", worst-of), and both are drawn:
//   · ABSOLUTE— the registry `thresholds` pair (105/130), the MOVE-native regime map. DOTTED
//               (`style: "evt"`, F1's second-cut-pair convention), a convention kept from when a
//               second primary-axis pair shared the plot. Read off `i.thresholds` — the ONE source
//               (C7), never restated.
//   · VELOCITY— its z on the SECONDARY axis beside the flat zAmber/zRed bounds, exactly as BONOS.
//
// ⚠ WHY IT EXISTS (2026-08-30, [USER]-reported): R6 shipped a remap with NO chart row, so the detail
// chart drew the absolute pair ALONE while a rolling-band AMBER fired off a line nobody could see —
// an AMBER card beside a value line 30+ points below the only visible cut. A chart that contradicts
// its own state is the failure this builder closes. The percentile leg itself was deleted 2026-09-02
// (`R6_DESCRIPTOR` docblock), so the invariant now holds the easy way: every scored leg is drawn
// because every scored leg has a fixed line. ⛔ NO `perPoint` block — R6 carries no `POINT_BAND_CUTS_OF`
// row and no `levelBand`; re-adding a percentile cut here means re-adding the leg first.
function buildMoveChart(i: Indicator): ChartSpec {
  const { velWindow, velSigmaWindow, zAmber, zRed } = R6_DESCRIPTOR.scorer.constants;
  const t = i.thresholds;
  return {
    axes: [
      { id: "primary", side: "left", unit: i.unit ?? "", format: "value" },
      {
        id: "secondary",
        side: "right",
        unit: "",
        format: "value",
        label: `velocity z (Δlog${velWindow} · ${velSigmaWindow}d σ)`,
      },
    ],
    // ONE secondary series only — genericSingle draws `secArrs[0]` and silently drops a second.
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      { axis: "secondary", fromPoint: "velZ", style: "primary" },
    ],
    bands: [
      // Emitted PER SIDE off the registry pair (R1's shape): a level cut the registry does not ship
      // must not become a captioned line whose value resolves `undefined` on the wire.
      ...(t.amberLevel != null
        ? [{ level: "amber", axis: "primary", source: "threshold", metric: "level", style: "evt" } as ChartBand]
        : []),
      ...(t.redLevel != null
        ? [{ level: "red", axis: "primary", source: "threshold", metric: "level", style: "evt" } as ChartBand]
        : []),
      // Secondary-axis bounds LAST — the renderer resolves the primary cuts first and the legend
      // prints them in this order. Both σ bounds read off the descriptor, never restated.
      { level: "amber", axis: "secondary", source: "displayBand", value: zAmber, label: `amber ${+zAmber.toFixed(2)}σ` },
      { level: "red", axis: "secondary", source: "displayBand", value: zRed, label: `red ${+zRed.toFixed(2)}σ` },
    ],
  };
}

/**
 * R8 — the 21-obs term-spread mean on the PRIMARY axis under its armed mean-space cut pair
 * (`levelCuts` per-point lines, the SAME `meanLevelCutSeries` the scorer reads — labels composed
 * off the pctile knobs, never literals), plus the recession probit on the SECONDARY. Both new
 * series were candidates for the right axis and the units decide it: the mean is in the same
 * percentage points as the spread and IS the persisted `value`, so it belongs on the left; the
 * probit is a 0–100% probability, a different domain.
 *
 * The probit line is a MONOTONE transform of the primary, so it traces the same shape mirrored. That
 * is the point, not a redundancy — the right axis is a probability RULER for reading the level, which
 * is also why it carries no bands and scores nothing (display-only, 2026-08-09 ruling).
 *
 * ⚠ `genericSingle` draws `secArrs[0]` ONLY — a second secondary series would be silently dropped.
 */
function buildR8Chart(i: Indicator): ChartSpec {
  const lc = i.postInversionCooldown?.levelCuts;
  return {
    axes: [
      { id: "primary", side: "left", unit: i.unit ?? "%", format: "value", label: i.label },
      { id: "secondary", side: "right", unit: "%", format: "value", label: "recession prob (12m)" },
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      { axis: "secondary", compute: "probit", style: "derived", label: "modelled 12m recession probability" },
    ],
    bands: lc
      ? R8_MEAN_CUT_BANDS.map(
          (c): ChartBand => ({
            level: c.level,
            axis: "primary",
            source: "perPoint",
            fromPoint: c.key,
            label: `${c.level} <p${+(lc[c.level].pctile * 100).toFixed(1)} of anchored mean pool (armed)`,
          }),
        )
      : [
          { level: "amber", axis: "primary", source: "threshold", metric: "level" },
          { level: "red", axis: "primary", source: "threshold", metric: "level" },
        ],
  };
}

// R7 — bespoke bull-steepener overlay (2026-08-14 `[USER]`).
// T10Y3M spread on the PRIMARY axis (the stored `value`, drawn as today); BOTH Δ20 legs
// (`bullLegs.drop`/`.steep`) on the SECONDARY, carrying the four moving ranked cuts. The cuts'
// probabilities are BULL_AMBER_P/BULL_RED_P (R7_DESCRIPTOR) — labels compose off them, never
// restated. Both legs `gatedBy: ["shortEndDriven"]`: gate-off days shade dim on the client.
function buildR7Chart(_i: Indicator): ChartSpec {
  const pct = (level: "amber" | "red") => +((level === "amber" ? BULL_AMBER_P : BULL_RED_P) * 100).toFixed(1);
  const pairOf = (key: string) => (key.startsWith("r7Drop") ? "drop" : "steep");
  const legWord = (key: string) => (pairOf(key) === "drop" ? "2y drop" : "steepening");
  return {
    // 756 obs (~3y), not DETAIL_LIMIT's 365: at 365 the secondary domain is [-0.42, +0.54] and BOTH
    // ranked drop cuts fall below plot as ▼ markers. Widening reaches [-0.73, +0.61], so `dropAmber`
    // draws as a real line. Ruled 2026-08-14 over hand-setting the cuts, which would have collapsed
    // AMBER onto the `shortEndDriven` gate (45 → 408 non-GREEN of 3,758; `npm run probe:r7-cuts` C).
    window: 756,
    axes: [
      { id: "primary", side: "left", unit: "pp", format: "value", label: "T10Y3M" },
      { id: "secondary", side: "right", unit: "pp", format: "derived", label: "Δ20 2y / steepening" },
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      { axis: "secondary", fromPoint: "bullLegs.drop", style: "leg", label: "Δ20 2y", gatedBy: ["shortEndDriven"], pair: "drop" },
      { axis: "secondary", fromPoint: "bullLegs.steep", style: "leg", label: "Δ20 steepening", gatedBy: ["shortEndDriven"], pair: "steep" },
    ],
    bands: R7_CUT_BANDS.map(
      (c): ChartBand => ({
        level: c.level,
        axis: "secondary",
        source: "perPoint",
        fromPoint: c.key,
        label: `${legWord(c.key)} ${c.level} p${pct(c.level)}`,
        // 2-glyph chip (leg initial + severity initial) — what actually paints, out in the right
        // margin. Four full labels stacked at the plot's right edge sat over the newest ~4 months
        // of both legs (`[USER]` 2026-08-29); the full label above still keys the legend entry.
        shortLabel: `${pairOf(c.key) === "drop" ? "2" : "s"}${c.level === "amber" ? "A" : "R"}`,
        pair: pairOf(c.key),
      }),
    ),
    gates: [{ key: "shortEndDriven", label: "the 2y drop drives the steepening", appliesTo: "both" }],
  };
}

// Shared displayBand shape (VT / EURC family route + the GB bespoke ref) — the
// plotted stored `value` IS the scored decision variable; its display-only bands are
// routed through the SAME resolveBands seam the scorers use (Stage 3.2), so a config
// multiplier moves the drawn line WITH the scored cut — no drift. Labels are composed
// from the SAME resolved values as the bands (review #3); toFixed(2) keeps the historical
// 2-decimal ratio formatting. HIGH direction (firesHighward): amber inclusive (≥), red
// strict (>). LOW direction: strict `<` on both edges.
function displayBandChart(
  i: Indicator,
  amber: number,
  red: number,
  firesHighward: boolean,
): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  const { amber: a, red: r } = resolveBands(i.id, amber, red, firesHighward);
  return {
    axes: [{ id: "primary", side: "left", unit, format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands: firesHighward
      ? [
          { level: "amber", axis: "primary", source: "displayBand", value: a, label: `amber ≥${a.toFixed(2)}` },
          { level: "red", axis: "primary", source: "displayBand", value: r, label: `red >${r.toFixed(2)}` },
        ]
      : [
          { level: "amber", axis: "primary", source: "displayBand", value: a, label: `amber <${a.toFixed(2)}` },
          { level: "red", axis: "primary", source: "displayBand", value: r, label: `red <${r.toFixed(2)}` },
        ],
  };
}

/**
 * The SLOW bubble legs' shared one-axis shape (price-accel + the two complacency legs).
 * They are NOT the context-only channels their `thresholds: {}` suggests: `slowStoredReadings`
 * persists each component's `metric` — a percentile RANK or a price FRACTION — and every one of
 * slow.ts's cuts is stated on that same axis, so the lines plot directly against the stored value.
 *
 * Deliberately NOT `displayBandChart`: that shape hard-codes the HIGH ≥/> and LOW </< edge pairs,
 * while every cut here is INCLUSIVE on both sides (`>=` / `<=` in the scorers), so each caller
 * composes its own label off the constant it draws. Also NOT routed through `resolveBands` — these
 * are hand-set constants outside `CALIB_MAP`, and a multiplier seam would be a second source.
 * These bands ARE the Zone-D bubble tab's cut lines: that tab renders each leg through the same
 * `detailChart` the indicator-detail tab uses (2026-09-02), so it reads its cuts off THIS spec.
 * The hand-mirrored `public/scoring-cuts.js` table it used to compose them from is deleted —
 * one source, and the two views of a leg cannot disagree by construction.
 */
function slowLegChart(i: Indicator, bands: ChartBand[]): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  return {
    axes: [{ id: "primary", side: "left", unit, format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands,
  };
}

// price-accel (2026-08-30 `[USER]`) — stored `value` = the percentile RANK of the latest 63d QQQ
// return, and the cuts are percentiles too, so both plot on the 0–1 axis. The ONE slow leg with a
// real amber/red PAIR (`latest >= red ? 2 : latest >= amber ? 1 : 0`, `scorePriceAccel`).
function buildPriceAccelChart(i: Indicator): ChartSpec {
  return slowLegChart(i, [
    {
      level: "amber",
      axis: "primary",
      source: "displayBand",
      value: ACCEL_AMBER_PCTILE,
      label: `amber ≥${ACCEL_AMBER_PCTILE.toFixed(2)}`,
    },
    {
      level: "red",
      axis: "primary",
      source: "displayBand",
      value: ACCEL_RED_PCTILE,
      label: `red ≥${ACCEL_RED_PCTILE.toFixed(2)}`,
    },
  ]);
}

// complacency-vix (2026-08-30 `[USER]`) — stored `value` = where the latest VIX sits in its own
// distribution (`vixPctile`), and the cut is the bottom-decile percentile `VIX_LOW_PCTILE`, so the
// line plots on that axis. ONE band, and it is AMBER: the leg is binary (`vixLow ? 1 : 0`), so its
// persisted state is GREEN or AMBER and a RED line would name a state this row can never take.
// LOW-firing and INCLUSIVE (`vixLatest <= quantile(...)`) ⇒ `≤`.
function buildComplacencyVixChart(i: Indicator): ChartSpec {
  return slowLegChart(i, [
    {
      level: "amber",
      axis: "primary",
      source: "displayBand",
      value: VIX_LOW_PCTILE,
      label: `amber ≤${VIX_LOW_PCTILE.toFixed(2)}`,
    },
  ]);
}

// complacency-high (2026-08-30 `[USER]`) — stored `value` = QQQ as a fraction of its trailing 252d
// high (`distFraction`, →1 at the high) and the cut is `NEAR_HIGH_FRAC` on exactly that fraction
// (`qCloses[j] >= NEAR_HIGH_FRAC * h`), so the line plots directly. Binary leg ⇒ one AMBER band,
// same argument as complacency-vix. HIGH-firing and INCLUSIVE ⇒ `≥`.
//
// ⚠ The label carries the m-of-n PERSISTENCE (`PERSIST_M` of `PERSIST_N`, composed off the
// constants) because the line alone would over-promise: the leg scores 1 only when ENOUGH of the
// last N closes sat above it, so a single day poking over the line need not colour the ribbon.
// That gap is the honest read of one static line against a persistence rule — the alternative,
// plotting the m-of-n count instead, would abandon the axis the stored value is on.
//
// ⚠ NOT the D-B divergence escalator's tolerance: `alert-band.ts` compares this SAME `distFraction`
// against the CALIBRATED `qqq_nearhigh_tol` row (`run-cycle-exposure.ts`). Different cut, different consumer,
// and it is deliberately not drawn here — this chart is the slow leg's.
function buildComplacencyHighChart(i: Indicator): ChartSpec {
  return slowLegChart(i, [
    {
      level: "amber",
      axis: "primary",
      source: "displayBand",
      value: NEAR_HIGH_FRAC,
      label: `amber ≥${NEAR_HIGH_FRAC.toFixed(2)} (${PERSIST_M} of ${PERSIST_N}d)`,
    },
  ]);
}

// F1 (HY OAS) — bespoke ref: the dual-axis SHAPE is shared with F2 below, but F1's
// window (504d visible) + Δ30d overlay span single-source from the EXPOSURE engine
// constants (`ARM_RANGE_WINDOW`/`ARM_ROC_WINDOW`), which the runtime-leaf descriptor layer
// cannot import (§1.4 cycle) — so the params are assembled HERE, in the import sink.
// Every DRAWABLE scoring leg is on it (2026-07-23 `[USER]`): the operative level pair
// (registry's hand-set `thresholds.amberLevel`/`redLevel` — the same fallback `legBounds`' `op` leg takes) and the
// 30d velocity pair on the right axis. The 4th leg — regime-z on the Baa10y PROXY series —
// has no HY-OAS level to draw, so the renderer tags the days it fired under the ribbon.
function buildF1Chart(i: Indicator): ChartSpec {
  const spec = dualAxisChart(i, {
    // The span in the label is INTERPOLATED from `ARM_ROC_WINDOW`, never typed — same reason
    // `exposure.ts`'s `summarize` interpolates its `bp/30d` string. The two are equal at 30 by
    // coincidence, not by construction, so a typed "30d" WOULD draw a different span under an
    // unchanged label if the constant were ever retuned. That retune has NOT happened — this was
    // latent, never output-wrong (I6, 2026-08-08).
    dualAxis: { unit: "pp", label: `OAS Δ${ARM_ROC_WINDOW}d`, compute: "roc", window: ARM_ROC_WINDOW },
    window: ARM_RANGE_WINDOW,
    lead: ARM_ROC_WINDOW,
    legBands: true,
  });
  // ⚠ The displayOnly `lowRise` block is NOT drawn (reverted 2026-08-30 `[USER]`): its amber onset
  // landed on the SAME level axis as the operative level cuts, in the same amber
  // dash, so the card showed two amber threshold lines for two different quantities and neither was
  // distinguishable at a glance. The block stays PERSISTED (`decisionAt`, served as `decision` on
  // /api/series) — the Iran playbook's Stage-3 credit sign still reads it; it just has no pixel.
  // Every line on this chart is therefore a line that scores.
  return spec;
}

// F3 (NFCIRISK) — bespoke ref: the F2 stored-delta dual-axis SHAPE, but its four synth legs' cuts are
// MOVING (expanding percentile of level and |Δ|), so the static `threshold`/`legBands` band pair
// dualAxisChart emits would freeze the axes at the dead PRIORS fallback — the
// "amber-only velocity axis draws its degrade prior" trap. Here every band is `source:"perPoint"`,
// read off the `bandCuts` api/series computes per date off the same history the recompute scores:
// the level pair on the primary (POINT_BAND_CUTS_OF.F3) and velocity AMBER on the secondary
// (F3_VELOCITY_BAND). The velocity-RED band is DROPPED — F3's prior defines no `redVelocity`, so no
// value exists and the pair-emitter's phantom red line has no home (Stage 1).
function buildF3Chart(i: Indicator): ChartSpec {
  const spec = dualAxisChart(i, { dualAxis: { unit: "", compute: "storedDelta" } });
  const perPoint = (POINT_BAND_CUTS_OF[i.id] ?? []).map(
    (c): ChartBand => ({
      level: c.level,
      axis: "primary",
      source: "perPoint",
      fromPoint: c.key,
      label: `${c.level} >p${+(c.p * 100).toFixed(1)} of own history`,
    }),
  );
  return {
    ...spec,
    bands: [
      ...perPoint,
      {
        level: F3_VELOCITY_BAND.level,
        axis: "secondary",
        source: "perPoint",
        fromPoint: F3_VELOCITY_BAND.key,
        label: `${F3_VELOCITY_BAND.level} >p${+(SYNTH_AMBER_PCTILE * 100).toFixed(1)} of |Δ|`,
      },
    ],
  };
}

// Shared dual-axis shape (F2 declarative route, F1 bespoke ref) — BOTH scoring
// legs are drawable, and a leg with no line on screen is a state nobody can explain
// (2026-07-23 `[USER]`). Primary = the level against the level pair; right axis = the
// client-computed velocity-window change against the velocity pair. Both band pairs are
// `threshold`, i.e. read from the registry thresholds — the SAME constants the scorer
// compares — so this chart IS the picture of when those legs fire. `legBands: true` keeps
// the renderer on the per-leg pairs and never swaps in the worst-of `effAmber/effRed`
// composite. The secondary series is non-decision, so the client's `isDerived` dispatch
// (fromPoint === "decision") routes it to genericSingle.
//
// F2 (2026-07-28 `[USER]`) takes the SAME shape through `compute: "storedDelta"`: its
// velocity pair (registry `amberVelocity`/`redVelocity`) scored while nothing on screen could explain a bar
// it coloured. It plots the persisted `delta20` instead of a client roc — that column IS the
// scored variable, so no compute hook, no `lead`, and no second definition of the window.
// `legBands` stays OFF for F2 (unlike F1): its primary level bands keep taking the
// `eff` composite exactly as before, so this change adds an axis and moves no existing line.
// That is safe, not lucky — and since 2026-08-06 it is safe for a STRONGER reason than the one
// this note used to give. The old argument was that F2's borrowed Baa10y regime-z leg carried no
// `zref*` (suppressed for proxy ids in `resolveCuts` since 2026-07-23), so `effectiveCuts` could
// not invert it onto F2's own axis and dropped it. That leg was retired OUTRIGHT on both F1 and F2
// on 2026-08-06, and Stage 5.2 deleted the proxy-z
// path with it — there is no borrowed bound left to invert or drop. Either way the composite IS the registry
// level pair. Measured and pinned for both ids in `src/effective-cuts.test.ts` — F1 keeps
// `legBands` as the structural guard should the leg ever be un-retired.
/** @internal */
export function dualAxisChart(i: Indicator, params: FamilyChartParams): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  const da = params.dualAxis;
  if (!da) throw new Error(`chart-rail: dualAxisChart requires dualAxis params (id ${i.id})`);
  // The velocity span this axis SHOWS is the one the scorer USED: `buildReadings` writes
  // `delta20` over `indicator.velocityWindow ?? VELOCITY_WINDOW` (scorers-core.ts), and both
  // the stored-delta series and the composed axis label read that same resolution — a
  // per-indicator window retune moves line and caption together, with no constant restated.
  const velWindow = i.velocityWindow ?? VELOCITY_WINDOW;
  const stored = da.compute === "storedDelta";
  // Wire-vocabulary tripwire (spec §6): ChartSpec has no parameterized roc compute — only
  // the named `"roc30"` hook. A future window retune is a ChartSpec EXTENSION (frozen this
  // stage), so any other window THROWS loudly instead of silently drawing a mislabeled axis.
  if (!stored && da.window !== 30) {
    throw new Error(
      `chart-rail: dualAxis window ${da.window} (id ${i.id}) has no ChartSpec compute - only "roc30" exists; extending the wire vocabulary is a stop condition (stage-4 spec §6)`,
    );
  }
  // The stored route has NO window of its own — the column already carries the scored span.
  // A declared one that disagrees would put a caption on a line it does not describe, so it
  // is a loud error rather than a silently-preferred override.
  if (stored && da.window != null && da.window !== velWindow) {
    throw new Error(
      `chart-rail: dualAxis window ${da.window} (id ${i.id}) contradicts the scored velocity window ${velWindow}; the storedDelta route plots the persisted delta20 column and takes its span from velocityWindow`,
    );
  }
  // `refSigma` is a σ multiple: on a non-σ id `withSigmaOverlays` emits no key, so the line would be silently absent.
  if (da.refSigma != null && i.thresholds.velocitySigma === undefined) {
    throw new Error(`chart-rail: dualAxis.refSigma (id ${i.id}) needs thresholds.velocitySigma`);
  }
  return {
    axes: [
      { id: "primary", side: "left", unit, format: "value" },
      {
        id: "secondary",
        side: "right",
        unit: da.unit,
        // A relative-speed id's stored Δ is a fraction: "derived" + unit "%" renders it ×100.
        format: i.velocityMode === "relative" ? "derived" : "value",
        // The id-level `obsCadence` (when declared) names the OBSERVATION grid where `i.cadence`
        // names the release schedule — see the trap note on `obsWord`. The SPAN stays the
        // resolved velocity window either way, so no constant is restated at the declaration site.
        // A label already ending in "Δ" (R4 "10y RY Δ") folds into the span word — "10y RY
        // Δ20d", never "… Δ Δ20d".
        label:
          da.label ??
          (i.label.endsWith("Δ")
            ? `${i.label}${velocitySpanWord(i, velWindow).slice(1)}`
            : `${i.label} ${velocitySpanWord(i, velWindow)}`),
      },
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      stored
        ? { axis: "secondary", fromPoint: "delta20", style: "derived" }
        : { axis: "secondary", compute: "roc30", style: "derived" },
    ],
    // A pair the registry declares no cut for is OMITTED, not served unresolvable (R4 is
    // velocity-only; an empty threshold cell would leave the FE a band with no value).
    bands: [
      ...(i.thresholds.amberLevel != null || i.thresholds.redLevel != null
        ? ([
            { level: "amber", axis: "primary", source: "threshold", metric: "level" },
            { level: "red", axis: "primary", source: "threshold", metric: "level" },
          ] as ChartBand[])
        : []),
      ...(i.thresholds.amberVelocity != null || i.thresholds.redVelocity != null
        ? velocityBandsFor(i.thresholds, "secondary")
        : []),
      // Display-only reference multiple (`dualAxis.refSigma`) — drawn faint + dotted beside the scored pair, never a cut.
      ...(da.refSigma != null
        ? ([
            {
              level: "amber",
              axis: "secondary",
              source: "perPoint",
              fromPoint: SIGMA_REF_KEY,
              label: `${+da.refSigma.toFixed(2)}σ ref`,
              style: "approach",
              sigmaMultiple: da.refSigma,
            },
          ] as ChartBand[])
        : []),
    ],
    ...(params.window != null ? { window: params.window } : {}),
    ...(params.lead != null ? { lead: params.lead } : {}),
    ...(params.legBands ? { legBands: true } : {}),
  };
}

// FXH — bespoke haven-move (%) primary: 3 leg lines + a worst-of envelope + effective
// bands; EURUSD=X price on the secondary axis, no bands.
function buildFxhChart(i: Indicator): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  const axes: ChartAxis[] = [
    { id: "primary", side: "left", unit: "%", format: "derived" },
    { id: "secondary", side: "right", unit, format: "value", label: `${i.label} price` },
  ];
  const series: ChartSeries[] = [
    { axis: "primary", fromPoint: "havenLegs.eur", style: "leg" },
    { axis: "primary", fromPoint: "havenLegs.chf", style: "leg" },
    { axis: "primary", fromPoint: "havenLegs.jpy", style: "leg" },
    { axis: "primary", compute: "havenEnvelope", style: "envelope" },
    { axis: "secondary", fromPoint: "value", style: "derived" },
  ];
  const bands: ChartBand[] = [
    { level: "amber", axis: "primary", source: "effective" },
    { level: "red", axis: "primary", source: "effective" },
  ];
  return { axes, series, bands };
}

// DISP (Case 3/4) — bespoke composite with thresholds:{} + no `derived`.
// Case-4 gated layout. Redesign 2026-07-22: the basket RETURN is the de-risk trigger
// and correlation only CONFIRMS it.
// The legs are split by role:
//   drawn  — the basket return (persisted per point as `decision`), TWO bands: a RED band at
//            DISP_BASKET_RED (−2.5%) where RED begins, and an AMBER band at the zero line
//            where the AMBER tier (−2.5%..0) begins. The ribbon also colours each tier from
//            the (re-scored) state. displayBand ⇒ NOT multiplied (DISP is out of CALIB_MAP,
//            so there is no multiplier anyway; the amber onset IS the literal zero line).
//   gated  — the corr level, as ONE GATES.DISP confirm gate (appliesTo "both"), AND — since
//            2026-09-08 — as a DRAWN primary-axis band at DISP_CORR. The gate flag alone dimmed
//            the basket line without ever showing WHERE the corr cut sits, so the one condition
//            that can veto both tiers was invisible on the axis it lives on; the reader could not
//            tell a near-miss from a rout. It is `level:"amber"` because it gates the AMBER onset
//            (and RED inherits it) — there is no separate corr cut per tier. The
//            AMBER/RED split is still on the BASKET axis, not the corr axis. The multiplier is
//            applied gate-side in api/series.ts, so this branch resolves no cuts at all.
//
// ⚠ Every band LABEL here is COMPOSED from DISP_CORR / DISP_BASKET_RED, never retyped
// (`indicator-loop.md` §A retune is a ONE-place edit). The literal "corr>0.75" / "−2.5%" strings this file used to
// carry are exactly the rot that left `public/indicator-desc.js` advertising the DELETED
// correlation-band design (amber 0.55 / red 0.70) for seven weeks after the 2026-07-22 redesign.
// `fromPoint: "decision"` on the secondary axis is load-bearing, not cosmetic: it
// is what flips detail-chart.js to the derived layout, the only layout that renders
// gates (see the note in src/gates.ts).
// DISP has NO `derived` DerivedView descriptor (3-series composite), so the shape
// is hand-built here, as F1 hand-builds its own above.
/** Basket-depth cut as axis text: −0.025 → "−2.5%" (the secondary axis is drawn in %). */
const basketText = (cut: number): string => `${(cut * 100).toFixed(1).replace("-", "\u2212")}%`;
/** The corr confirm condition as label text — composed once, reused by all three band labels. */
const CORR_TEXT = `corr>${DISP_CORR}`;

function buildDispChart(i: Indicator): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  return {
    axes: [
      { id: "primary", side: "left", unit, format: "value" },
      { id: "secondary", side: "right", unit: "%", format: "value", label: "20d basket return" },
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      // The B2 deepener cut as its OWN per-day line on the corr axis (`SeriesPointDTO.corrP90`,
      // api/series.ts) — a `meanCorr` at/above it turns a gated AMBER day RED. `style:"trend"` paints
      // it in the blue trend hue, DISTINCT from the amber DISP_CORR gate band on the same axis (a
      // moving cut vs the static gate); it is not amber, so the two never collide. The label COMPOSES
      // the percentile + window from the two constants, never a retyped literal (§2.3 /
      // `indicator-loop.md` §A retune is a ONE-place edit). A warm-up gap (absent `corrP90`) breaks the line, never 0.
      {
        axis: "primary",
        fromPoint: "corrP90",
        style: "trend",
        // ONE DECIMAL, trailing zero stripped (`+(…).toFixed(1)`), NOT `Math.round` — a
        // half-percentile is a legal cut and rounding one silently MISSTATES the drawn line (see
        // `derivedChart`'s docblock, §2.1). Inert at today's 0.90 (`+"90.0"` is `90` ⇒ "p90").
        label: `rolling p${+(DISP_CORR_P * 100).toFixed(1)} corr deepener (${DISP_CORR_P_WINDOW}d)`,
      },
      { axis: "secondary", fromPoint: "decision", style: "derived", gatedBy: GATES.DISP!.map((g) => g.key) },
    ],
    bands: [
      { level: "amber", axis: "secondary", source: "displayBand", value: 0, label: `amber <0% · ${CORR_TEXT}` },
      { level: "red", axis: "secondary", source: "displayBand", value: DISP_BASKET_RED, label: `red <${basketText(DISP_BASKET_RED)} · ${CORR_TEXT}` },
      // The confirm gate, drawn on its OWN axis: below this line neither tier can fire whatever
      // the basket does. `value` is the RAW cut — DISP is out of CALIB_MAP so no multiplier applies.
      { level: "amber", axis: "primary", source: "displayBand", value: DISP_CORR, label: `${CORR_TEXT} confirms` },
    ],
    gates: GATES.DISP!.map((g) => ({ key: g.key, label: g.label, appliesTo: g.appliesTo })),
  };
}

// F7 / CAPE — DISPLAY-ONLY expanding-percentile band lines (2026-08-11 `[USER]`; replaced the
// 30y-mean `capeMean` line). CAPE is NON-scored (thresholds:{}, no `derived`), so it would
// otherwise fall to the `context-only` sentinel and draw no line. Bands are HIGH-firing (rich
// deepens danger): amber/red ABOVE the p-quantile of CAPE's own expanding stored history. The
// cuts are resolved ONCE in the GET handler (`capeBandLevels`, api/indicators.ts) and threaded
// per level. Fail-safe: a degraded feed passes `capeCuts == null` (or a level with no resolved
// cut) ⇒ returns undefined ⇒ the dispatch falls through to context-only (the value-only gray
// path) rather than a bogus line.
/** Per-level resolved `valueFrom:"capePct"` cut values (api/indicators.ts). */
export type CapeCardCuts = Readonly<Partial<Record<"amber" | "red", number>>>;
/** @internal */
export function contextChart(
  i: Indicator,
  params: FamilyChartParams,
  capeCuts: CapeCardCuts | null,
): ChartSpec | undefined {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  const declared = params.displayBands ?? [];
  const bands: ChartBand[] = [];
  for (const b of declared) {
    if (b.valueFrom === "capePct") {
      const cut = capeCuts?.[b.level];
      if (cut == null) return undefined; // degraded feed — fall through to the sentinel
      bands.push({
        level: b.level,
        axis: "primary",
        source: "displayBand",
        value: cut,
        label: `${b.level} ≥${cut.toFixed(1)} (p${Math.round((b.p ?? 0) * 100)} of own history)`,
      });
    } else if (b.valueFrom === "perPoint") {
      // ECY — a per-DATE moving cut; the value travels on the wire (`SeriesPointDTO.bandCuts`),
      // keyed by the id's `POINT_BAND_CUTS_OF` row. No row for this level ⇒ nothing drawable.
      const cut = (POINT_BAND_CUTS_OF[i.id] ?? []).find((c) => c.level === b.level);
      if (cut == null) return undefined;
      bands.push({
        level: b.level,
        axis: "primary",
        source: "perPoint",
        fromPoint: cut.key,
        ...(b.label ? { label: b.label } : {}),
      });
    } else if (b.value != null) {
      bands.push({ level: b.level, axis: "primary", source: "displayBand", value: b.value, ...(b.label ? { label: b.label } : {}) });
    }
  }
  if (bands.length === 0) return undefined;
  return {
    axes: [{ id: "primary", side: "left", unit, format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands,
  };
}

// DB_SMH / DB_XLK — downside-break detail graph (Part A, 2026-07-21; DB_XLK 2026-07-23).
// Both are WIRED to notify via the WATCH-capped `ew` escalator floor.
// The /api/series bespoke branch re-scores the stored closes and
// emits the DRAWDOWN (close ÷ 63d-high − 1) × 100 as `value`, so this is a state-ribbon chart
// on a percent DRAWDOWN axis with the detector's OWN cuts as displayBand lines. Both legs of
// that pair come from the SAME two seams the SCORER uses — `downsideCuts(id)` (per-detector
// priors, both −5/−8 since the 2026-07-23 retunes) THEN `resolveBands` (the threshold-config multiplier) —
// so neither a per-id retune nor a config edit can move the ribbon while the drawn line stays
// frozen. LOW-is-bad: a deeper (more negative) drawdown is worse, so amber/red are ≤ cuts.
function downsideChart(i: Indicator): ChartSpec {
  const cuts = downsideCuts(i.id);
  const { amber, red } = resolveBands(i.id, cuts.amber, cuts.red, false);
  // Case 4 on a SINGLE-axis id: the scored variable IS the primary line here, so the drawdown
  // itself is `gatedBy` the MA50 trend gate and `genericSingle` dims the stretches where a band
  // cross cannot fire. Second primary series = that gate's own line in drawdown space
  // (`SeriesPointDTO.gateLine`), so "the drawdown is under the red cut but the line sits BELOW
  // the gate line" is readable off the picture instead of being invisible.
  const gateDefs = GATES[i.id];
  return {
    axes: [{ id: "primary", side: "left", unit: "%", format: "value", label: "drawdown from 3-mo high" }],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary", ...(gateDefs ? { gatedBy: gateDefs.map((g) => g.key) } : {}) },
      ...(gateDefs
        ? [
            {
              axis: "primary" as const,
              fromPoint: "gateLine" as const,
              style: "trend" as const,
              label: `${i.series} ${PRICE_WINDOWS.maShort}-day MA (as drawdown) - below it, the gate is on`,
            },
          ]
        : []),
    ],
    ...(gateDefs ? { gates: gateDefs.map((g) => ({ key: g.key, label: g.label, appliesTo: g.appliesTo })) } : {}),
    bands: [
      { level: "amber", axis: "primary", source: "displayBand", value: amber * 100, label: `amber ≤${(amber * 100).toFixed(0)}%` },
      { level: "red", axis: "primary", source: "displayBand", value: red * 100, label: `red ≤${(red * 100).toFixed(0)}%` },
    ],
  };
}

/** The EU-Fin re-entry ladder's slow realized-vol window (`rv20` hook) — mirrors the probe's `RV_SLOW_N`
 *  (scripts/probe-eufin-tranches.ts) and client `RV_PANEL.rvSlowWindow`, both parity-pinned in `rv-panel.test.js`. @internal */
export const RV20_WINDOW = 20;
/** Trailing window per overlay hook (MAs = mean; `high60` = inclusive max) — scorer constants, never bare; mirrored by
 *  `public/detail-chart.js` `MA_WINDOWS` + `HIGH_WINDOWS`, parity-pinned in its test. @internal */
export const MA_OVERLAY_WINDOW = {
  ma50: PRICE_WINDOWS.maShort,
  ma200: MA_WINDOW,
  high60: XDEV_GATE_DESCRIPTOR.scorer.constants.highWindow,
} as const;
type MaOverlay = keyof typeof MA_OVERLAY_WINDOW;
type ChartTone = NonNullable<ChartSeries["tone"]>;
/** One display-only MA line: the compute hook + its stroke tone (`ChartSeries.tone`; absent ⇒ the
 *  default `--trend-line` blue, the hue every other trend overlay uses). */
type MaOverlaySpec = Readonly<{ compute: MaOverlay; tone?: ChartTone }>;
/** Per-id opt-in: display-only trailing-MA lines on the PRICE axis of a derived-route chart, in
 *  draw order. Display-only except EXSH_GATE, whose MA50/MA200 ARE its scorer's crosses (window parity
 *  pinned in `chart-rail.test.ts`); an own-MA GATE draws via `GATES`. Tones are per id. @internal */
export const MA_OVERLAYS: Readonly<Record<string, readonly MaOverlaySpec[]>> = {
  // EU-Fin re-entry gate's three checks on the close — user ask 2026-10-06: every trend line its OWN
  // hue, in an order starting from white (MA50 white, MA200 orange; the decision line blue, below).
  EXSH_GATE: [
    { compute: "ma50", tone: "white" },
    { compute: "ma200", tone: "alt" },
  ],
  AT1: [{ compute: "ma200" }], // XAT1/EXHA ratio's long trend beside its MA50-spread leg — user ask 2026-10-06
};
/** Per-id stroke tone of the secondary DECISION line (absent ⇒ the renderer's `--ink-dim`). Only where the
 *  MA overlays above already took the other hues, so the decision line is the chart's third trend hue. */
const DECISION_TONE: Readonly<Record<string, ChartTone>> = { EXSH_GATE: "trend" };

/** One € zone line = the inclusive `highWindow`-close high × (1 − cut): the close at which the
 *  `offHigh ≤ −cut` edge fires (`offHigh`, src/ladder-jobs.ts), drawn on the price axis. Scale + label composed off the cut, never restated. */
const zoneOverlay = (cut: number, tag: string, level: "amber" | "red", style?: "approach"): ChartSeries => {
  const m = +(1 - cut).toFixed(6);
  return {
    axis: "primary",
    compute: "high60",
    scale: m,
    style: "step",
    toggle: true,
    cut: { level, ...(style ? { style } : {}) },
    label: `${tag} (${m} × ${MA_OVERLAY_WINDOW.high60}-close high)`,
  };
};
/** A display-only orange (`alt`, EU-Fin's MA200 hue) MA200 on the primary scale, behind the shared `.fit-toggle` —
 *  not the default blue, which the Δ5 fit line on the same toggle already wears (user ruling 2026-10-14). */
const MA200_TOGGLE: { series: readonly ChartSeries[]; lead: number } = {
  series: [{ axis: "primary", compute: "ma200", style: "trend", tone: "alt", toggle: true, readout: true }],
  lead: MA_OVERLAY_WINDOW.ma200,
};
/** spit's real-yield escalation member (`SPIT_RULES.ESC_REAL_DELTA_N` / `ESC_REAL_DELTA`, scripts/probe-spit-tranches.ts)
 *  — restated because `src/` never imports `scripts/`; `scripts/probe-spit-tranches.test.ts` pins both fields to the source. @internal */
export const R4_ESC = { window: 120, value: 0.75 } as const;
/** semis' move / vxsmh escalation members, off the semis source (`ladder-jobs.ts`) — never restate a literal here.
 *  sp500's `c4` (`SP500_RULES.C4_N` × `C4_K`) stays its own literal, pinned to MOVE_MEDIAN by its probe test. @internal */
export const MOVE_MEDIAN = SEMIS_MOVE_MEDIAN;
/** @internal */
export const VOL_MEDIAN = SEMIS_VOL_MEDIAN;
/** MOVE (R6) + VXSMH — user ask 2026-10-24: display-only `mult × window`-close median behind the shared toggle. */
const medianToggle = (m: { window: number; mult: number }): { series: readonly ChartSeries[]; lead: number } => ({
  series: [{ axis: "primary", compute: "median", window: m.window, scale: m.mult, style: "trend",
             label: `${m.mult}× ${m.window}d median`, toggle: true, readout: true }],
  lead: m.window,
});
/** Per-id display-only overlays riding the shared `.fit-lines` toggle (hidden by default, one legend
 *  `.fit-toggle` flips them with the Δ5 lines) + the lead they need. Value XDEV — user ask 2026-10-10: the
 *  60-close high, the three € zone lines and the −σ veto-breach days as dots (RV10 rides `RV10_OVERLAY`). @internal */
export const TOGGLE_OVERLAYS: Readonly<Record<string, { series: readonly ChartSeries[]; lead: number }>> = {
  XDEV: ((c) => ({
    series: [
      { axis: "primary", compute: "high60", style: "step", tone: "alt", toggle: true },
      zoneOverlay(c.zoneOpen, "T1 zone", "amber", "approach"),
      zoneOverlay(c.zoneT2, "T2 zone", "amber"),
      zoneOverlay(c.zoneT3, "T3 zone", "red"),
      {
        axis: "primary",
        compute: "vetoBreach",
        style: "dots",
        toggle: true,
        cut: { level: "red" },
        label: `veto day (daily log return under −${c.vetoSd}σ)`,
      },
    ],
    // high60 reads `highWindow − 1` prior closes; the veto cap's σ ends `vetoWindow` back over `sigmaWindow`
    // returns (`sigmaWindow + vetoWindow` prior closes) — the longer wins.
    lead: Math.max(MA_OVERLAY_WINDOW.high60, c.sigmaWindow + c.vetoWindow),
  }))(XDEV_GATE_DESCRIPTOR.scorer.constants),
  // EU-Fin EXSH — user ask 2026-10-11: the re-entry ladder's other trends beside its RV10, each its own hue, all
  // on the RV10 toggle: RV20 (the T3 vol rung's window, on RV10's shared fit scale), MA50 and MA200 (the T3 price
  // rung's and gate's windows). All are computed on THIS chart's series — the chained total-return level — not the
  // gate's EXSH_GATE adjClose, so their € values differ from eufin.md's `close: x/MA200` (the crosses roughly agree);
  // their values print in the expanded readout only (`readout`), RV10 alone keeps its chip term.
  LEGP_EUFIN: {
    series: [
      { axis: "primary", compute: "rv20", style: "trend", tone: "cyan", label: `RV${RV20_WINDOW}`, fit: true, readout: true },
      { axis: "primary", compute: "ma50", style: "trend", tone: "white", toggle: true, readout: true },
      { axis: "primary", compute: "ma200", style: "trend", tone: "alt", toggle: true, readout: true },
    ],
    lead: Math.max(RV20_WINDOW, MA_OVERLAY_WINDOW.ma50, MA_OVERLAY_WINDOW.ma200),
  },
  // HY credit spreads — user ask 2026-10-14: the level's MA200 trend on the Δ5 toggle (display-only, no cut).
  ...Object.fromEntries(["F1", "CCC"].map((id) => [id, MA200_TOGGLE])),
  // Semis SEC0 — user ask 2026-11-03: the leg's MA200 trend on the shared toggle (display-only, no cut).
  LEGP_SEMIS: MA200_TOGGLE,
  R6: medianToggle(MOVE_MEDIAN),
  VXSMH: medianToggle(VOL_MEDIAN),
  // MU — user ask 2026-10-20: a display-only white MA50 on the price axis behind the shared toggle (MA200 = the gate line).
  F8: {
    series: [{ axis: "primary", compute: "ma50", style: "trend", tone: "white", toggle: true, readout: true }],
    lead: MA_OVERLAY_WINDOW.ma50,
  },
  // 10y real yield — user ask 2026-10-14: a display-only blue Δ63 (one quarter of closes) behind the shared toggle
  // beside the scored Δ20d. User ask 2026-10-24: an orange Δ120 beside it with a faint line at spit's real-yield
  // escalation cut (`R4_ESC`). The two Δ lines SHARE one fitted scale (the renderer pools `delta` hooks), so
  // their zero lines align and magnitudes compare; the virtual scale never grows the chart.
  R4: ((w) => ({
    series: [
      { axis: "primary", compute: "delta", window: w, style: "trend", label: `Δ${w}d`, fit: true },
      {
        axis: "primary",
        compute: "delta",
        window: R4_ESC.window,
        style: "trend",
        tone: "alt",
        label: `Δ${R4_ESC.window}d`,
        fit: true,
        readout: true,
        ref: { value: R4_ESC.value, label: `spit esc +${Math.round(R4_ESC.value * 100)}bp` },
      },
    ],
    lead: Math.max(w, R4_ESC.window),
  }))(63),
};
/** Annualised realized-vol window of the `rv10` hook — the descriptor's `rvWindow` (mirrored client-side as `RV_PANEL`). @internal */
export const RV10_WINDOW = XDEV_GATE_DESCRIPTOR.scorer.constants.rvWindow;
/** Per-id opt-in: a display-only RV10 line (annualised realized vol of the plotted closes) on its own hidden `fit`
 *  scale — off by default behind the shared `.fit-toggle`, its value (a percent) in the hover only. Id-agnostic:
 *  a new id opts in with one row here, no renderer change. Single layout only (`genericSingle` splits `fit` out). @internal */
export const RV10_OVERLAY: ReadonlySet<string> = new Set(["XDEV", "LEGP_EUFIN"]);
function withRv10(i: Indicator, spec: ChartSpec): ChartSpec {
  if (!RV10_OVERLAY.has(i.id)) return spec;
  const line: ChartSeries = { axis: "primary", compute: "rv10", style: "trend", label: `RV${RV10_WINDOW}`, fit: true };
  return { ...spec, series: [...spec.series, line], lead: Math.max(spec.lead ?? 0, RV10_WINDOW) };
}
function withToggleOverlays(i: Indicator, spec: ChartSpec): ChartSpec {
  const o = TOGGLE_OVERLAYS[i.id];
  if (!o) return spec;
  return { ...spec, series: [...spec.series, ...o.series], lead: Math.max(spec.lead ?? 0, o.lead) };
}

// Derived-kind (F4/F5/F6/F8/G1/NVDA/CG/GT) — value on the primary axis, the decision line
// on the secondary axis with amber/red bands baked from the resolved DerivedView.
function derivedChart(i: Indicator, derived: DerivedView): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  // A TWO-LEG scorer's second leg (`SECOND_LEG_CHART_OF` — F13's d20) takes the PRIMARY axis, and
  // the plotted price/ratio line is dropped: the two legs are fractions of the SAME quantity but
  // live on different magnitudes (F13's d20 swings ~±4%, its ms50 ~±1%), so sharing one axis
  // squashed the fast leg and stacked four cut lines into one band. One leg per axis gives each its
  // own range — the reason the ratio itself, which is not scored and carries no cut, gives up the
  // left axis. A one-leg id keeps `value` on the primary, byte-identical.
  const second = SECOND_LEG_CHART_OF[i.id];
  const axes: ChartAxis[] = [
    second
      ? { id: "primary", side: "left", unit: derived.unit, format: "derived", label: second.tag }
      : { id: "primary", side: "left", unit, format: "value" },
    { id: "secondary", side: "right", unit: derived.unit, format: "derived", label: derived.label },
  ];
  // Case 4: a compound-rule id (GATES — F4/F8) declares its gate conditions on the
  // spec and marks the DECISION series `gatedBy` them, so the generic renderer dims/
  // dashes the line where no gate is on (single-sourced with the /series emitter).
  const gateDefs = GATES[i.id];
  const series: ChartSeries[] = [
    second
      ? { axis: "primary", compute: second.compute, window: second.window, style: "primary", label: second.label }
      : { axis: "primary", fromPoint: "value", style: "primary" },
    {
      axis: "secondary",
      fromPoint: "decision",
      style: "derived",
      ...(gateDefs ? { gatedBy: gateDefs.map((g) => g.key) } : {}),
      ...(DECISION_TONE[i.id] ? { tone: DECISION_TONE[i.id] } : {}),
    },
  ];
  // A compound-rule id whose gate is "own price below its OWN MA200" (F8's belowMA200,
  // F4's smhBelowMA200) gets that MA drawn as a second PRIMARY line — same price axis, so
  // the reader can SEE why a band cross on the right axis did not turn the ribbon: the
  // decision line alone is half the AND-rule. Cross-series gates (F4's NVDA leg) are not
  // drawable on this id's axis and stay legend-only.
  // The overlay is drawn at the gate's OWN line — MA200 × the def's `maMult` (F8: +10%) —
  // and carries the matching legend name, both derived from the single `MU_MA_MULT`
  // constant via the gate def, so the orange (`alt`, the house MA200 hue) line and the scored condition cannot drift.
  const ownMaGate = gateDefs?.find((g) => g.rule === "belowMA" && g.source === "own" && g.window === MA_WINDOW);
  if (ownMaGate) {
    const m = (ownMaGate.rule === "belowMA" && ownMaGate.maMult) || 1;
    const suffix = maMultSuffix(m);
    series.push({
      axis: "primary",
      compute: "ma200",
      style: "trend",
      tone: "alt",
      ...(m === 1 ? {} : { scale: m, label: `${i.series}'s 200-day MA ${suffix}` }),
    });
  }
  // Display-only trailing-MA overlays (`MA_OVERLAYS`) — drawn on the price axis for ids with NO
  // own-MA gate; an id the gate branch above already drew an MA200 for skips that hook.
  const maOverlays = (MA_OVERLAYS[i.id] ?? []).filter((o) => !(ownMaGate && o.compute === "ma200"));
  for (const { compute, tone } of maOverlays) {
    series.push({ axis: "primary", compute, style: "trend", ...(tone ? { tone } : {}) });
  }
  // The trailing-peak gate's own line (G1/BRENT): the rolling prior-`window` peak, computed
  // server-side per point (`SeriesPointDTO.rollingMax`, api/series.ts), so the reader can SEE
  // the level the price must breach before a band cross can fire. Years composed off the gate
  // def's own window — never restated.
  const peakGate = gateDefs?.find(
    (g): g is Extract<GateDef, { rule: "atOrAboveRollingMax" }> => g.rule === "atOrAboveRollingMax",
  );
  if (peakGate) {
    series.push({
      axis: "primary",
      fromPoint: "rollingMax",
      style: "trend",
      label: `trailing ${Math.round(peakGate.window / 252)}-year peak`,
    });
    // The graded level leg's AMBER rung (`levelGateState`): the same peak scaled by the
    // descriptor's own `peakProximity` — never retyped, so a retune moves line and score together.
    const prox = GEO_HYBRID_DESCRIPTOR_OF[i.id]?.scorer.constants.peakProximity;
    if (prox != null) {
      series.push({
        axis: "primary",
        fromPoint: "rollingMax",
        scale: prox,
        style: "trend",
        label: `amber proximity (${Math.round(prox * 100)}% of peak)`,
      });
    }
  }
  const bands: ChartBand[] = [];
  // An id can carry BOTH a `derived` block and its own level pair — OVX does (level pair OR a
  // 5-session spike, `OVX_DESCRIPTOR.combine === "or"`). Before R5b this route drew only the
  // secondary pair, so gaining a `derived` block SILENTLY dropped such an id's level band and the
  // chart tested one leg while the scorer tested two. Draw the level pair whenever the id has one;
  // it stays `threshold`, i.e. the same registry cuts the scorer reads, resolved at render.
  // NOT a per-id branch: every OTHER derived-route id ships `thresholds: {}`, so this adds no line
  // anywhere else — `golden-charts.json` is the proof
  //.
  // `calibLegsFor` rides along for the same reason `genericThresholdChart` carries it (see the
  // block there): an id whose level cuts live ENTIRELY in the published vintage has no registry
  // prior to test and would come back bandless. Vacuous today — no id is in that position — but
  // asymmetric without it, since a future vintage-only id landing on the DERIVED route would be
  // silently bandless while its generic-route sibling drew fine.
  const t = i.thresholds ?? {};
  const calibLevel = calibLegsFor(i.id).level;
  if (t.amberLevel != null || calibLevel)
    bands.push({ level: "amber", axis: "primary", source: "threshold", metric: "level" });
  if (t.redLevel != null || calibLevel)
    bands.push({ level: "red", axis: "primary", source: "threshold", metric: "level" });
  // PER-POINT (MOVING) primary cuts — an id whose level band is a per-DATE SERIES, not a
  // scalar, so it can ride neither `derived`'s baked value nor `threshold`'s registry pair
  // (CG's expanding-percentile HG÷GC cuts). The values travel per point on the wire
  // (`SeriesPointDTO.bandCuts[fromPoint]`, emitted by api/series.ts off the SAME
  // `POINT_BAND_CUTS_OF` map), so a percentile retune moves the spec, the label and the payload
  // in one edit. The label COMPOSES the percentile off `p` — never a restated literal.
  //
  // ⚠ ONE DECIMAL, trailing zero stripped (`+(…).toFixed(1)`), NOT `Math.round`: a half-percentile
  // is a legal cut and rounding one silently MISSTATES the drawn line (CG's 2026-08-08 redP 0.075
  // captioned itself "<p8" while the line sat at p7.5). Integer percentiles are unaffected —
  // `+"15.0"` is `15` — so no existing label moved.
  //
  // ⚠ WHAT THE PERCENTILE IS OF is part of the caption, not decoration: on a DETRENDED level
  // band (CG since 2026-08-08) the cut is the p-th percentile of the value's DEVIATION FROM ITS
  // OWN `trendWindow` TREND, back-transformed to ratio units for this axis. A label still
  // reading "of own history" would name the arm the leg was retired FROM. The window is READ OFF
  // the descriptor's `levelBand.trendWindow` — never restated here.
  const levelBand = RATIO_DESCRIPTOR_OF[i.id]?.levelBand;
  const ofWhat =
    levelBand?.kind === "detrended-expanding-percentile"
      ? `of own dev from ${levelBand.trendWindow}d trend`
      : "of own history";
  for (const c of POINT_BAND_CUTS_OF[i.id] ?? [])
    bands.push({
      level: c.level,
      axis: "primary",
      source: "perPoint",
      fromPoint: c.key,
      // Direction-aware: `<p` for a LOW-firing cut (CG), `>p` where a HIGH percentile is the
      // risk (F5/SPCONC — `firesHighward`), so the drawn legend matches the scorer's `dist >= cut` rule.
      label: `${c.level} ${c.firesHighward ? ">" : "<"}p${+(c.p * 100).toFixed(1)} ${ofWhat}`,
    });
  // The two legs' cuts now sit on DIFFERENT axes (the second leg rides the primary — see the axes
  // block), but both pairs still carry a leg TAG: the legend prints them in one line, and "amber
  // 0.0%" twice under one name is unreadable whichever axis each is on. The value is composed off
  // the cut — never a restated literal. `≤` is the scorer's own comparison (both legs are `<=`).
  const legCut = (level: "amber" | "red", v: number, tag: string, axis: "primary" | "secondary"): ChartBand => ({
    level,
    axis,
    source: "derived",
    value: v,
    label: `${level} ${tag} ≤${(v * 100).toFixed(1)}%`,
  });
  if (derived.amber != null)
    bands.push(
      second
        ? legCut("amber", derived.amber, second.siblingTag, "secondary")
        : { level: "amber", axis: "secondary", source: "derived", value: derived.amber },
    );
  if (derived.red != null)
    bands.push(
      second
        ? legCut("red", derived.red, second.siblingTag, "secondary")
        : { level: "red", axis: "secondary", source: "derived", value: derived.red },
    );
  if (second) {
    bands.push(legCut("amber", second.amber, second.tag, "primary"), legCut("red", second.red, second.tag, "primary"));
  }
  return {
    axes,
    series,
    bands,
    // An MA overlay needs its window of leading points before the visible window or its first
    // window-many days render as a gap — the LONGEST drawn window wins; detail-tab.js takes
    // max(derived.window, lead).
    ...(ownMaGate || maOverlays.length
      ? { lead: Math.max(ownMaGate ? MA_WINDOW : 0, ...maOverlays.map((o) => MA_OVERLAY_WINDOW[o.compute])) }
      : {}),
    ...(gateDefs ? { gates: gateDefs.map(({ key, label, appliesTo }) => ({ key, label, appliesTo })) } : {}),
  };
}

// Level branch of `genericThresholdChart` — reached when the id carries a registry level pair or a
// vintage-only `CALIB_MAP` level leg (see the caller). `t`/`unit` are the caller's materializations.
function levelThresholdChart(i: Indicator, t: Thresholds, unit: string): ChartSpec {
  const vintageOnly = t.amberLevel == null && t.redLevel == null && calibLegsFor(i.id).level;
  // Post-inversion amber floor: drawn ONLY where the plotted series IS the feed the rung is
  // anchored on — a raw carrier plots the raw closes; a two-window smoothed carrier (R1,
  // `SMOOTHED_LEVEL_OF[id].redWindow`) plots the `window`-obs mean and its rung runs over that
  // same mean (`smoothedLevelReadingSeries`), so the line is exact there too. A plain smoothed id
  // is dropped (raw-anchored rung under a mean plot) and a `levelCuts` carrier draws its own
  // mean-space pair via `buildR8Chart`.
  const smoothed = SMOOTHED_LEVEL_OF[i.id];
  const pi =
    i.postInversionCooldown?.levelCuts || (smoothed && smoothed.redWindow === undefined)
      ? undefined
      : i.postInversionCooldown;
  // A raw carrier's always-on drawdown leg draws a SECOND amber line off `drawdownCutSeries` —
  // raw-feed gated (a smoothed id plots the mean, where the raw-anchored cut is inexact).
  const dd = smoothed ? undefined : i.drawdownLeg;
  // SHORT-LEG GATE AXIS — RAW carriers only. Both moving amber cuts above carry an AND-condition
  // on a SECOND series — the rung's bull-steepener escalation (a firing rung day whose short leg
  // fell ≥ `shortLegDropBp` scores RED, `withPostInversionFloor`) and the drawdown leg's
  // direction-agnostic move gate — and neither has any image on the value axis. Measured
  // 2026-08-30 on then-raw R1 over the served window: 105 of 400 days painted RED with the plotted
  // spread ABOVE the drawn red line, up to 0.6pp above it, every one of them an escalation day. So
  // the gate's own decision variable (`shortMove`, served by `withPostInversionCut` off the SAME
  // walk the scorer gates on) gets the secondary axis, with its bounds drawn — the same remedy
  // F9's CUSUM leg took. The smoothed two-window arm scores NO escalation and NO drawdown leg
  // (ruled 2026-08-31), so it gets no gate axis: `gatePi` is the rung only where it escalates.
  // `gatePi` wins the window when both legs carry one: `api/series.ts` plots the rung's series, so
  // a drawdown gate on a DIFFERENT window would be a bound drawn against a line that does not
  // score it — those bands are dropped rather than drawn wrong.
  const gatePi = smoothed ? undefined : pi;
  const { bands: shortLegBands, shortLeg } = shortLegGate(gatePi, dd);
  return {
    axes: [
      { id: "primary", side: "left", unit, format: "value" },
      ...(shortLeg
        ? [
            {
              id: "secondary",
              side: "right",
              unit,
              format: "value",
              // Composed off the resolved window, never a literal — a retune moves the caption
              // with the line. `gatePi.shortLegSeries` names the feed so the axis is self-describing.
              label: `${gatePi?.shortLegSeries ?? "short leg"} Δ over ${shortLeg.window} obs`,
            } as ChartAxis,
          ]
        : []),
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      // Two-window smoothed carrier (R1): the redWindow mean RED scores on, drawn SOLID beside the
      // plotted `window` mean so the RED ribbon has a visible cause. Label composed off the window.
      ...(smoothed?.redWindow !== undefined
        ? [{ axis: "primary", fromPoint: "redMean", style: "scored-mean", label: `${smoothed.redWindow}-obs mean` } as ChartSeries]
        : []),
      ...(shortLeg ? [{ axis: "secondary", fromPoint: "shortMove", style: "primary" } as ChartSeries] : []),
    ],
    bands: [
      // Emitted PER SIDE (2026-08-30): R1 retired its `amberLevel`, and an unconditional pair would
      // ship a captioned amber line whose value resolves `undefined` on the wire. `vintageOnly`
      // keeps the caller's `calibLegsFor` standing guard alive UNCHANGED — an id with NO registry
      // level pair whose cuts live entirely in the published vintage still gets both bands for the
      // `effAmber/effRed` swap; an id that ships a pair is drawn side-by-side off that pair, as before.
      ...(t.amberLevel != null || vintageOnly
        ? [{ level: "amber", axis: "primary", source: "threshold", metric: "level" } as ChartBand]
        : []),
      ...(t.redLevel != null || vintageOnly
        ? [
            {
              level: "red",
              axis: "primary",
              source: "threshold",
              metric: "level",
              // Two-window smoothed carrier (R1): this band is where the DRAWN `redWindow`-mean
              // (the solid `scored-mean` series) crosses `redLevel` → RED. Label names that mean.
              ...(smoothed?.redWindow !== undefined
                ? { label: `${smoothed.redWindow}-obs mean < ${t.redLevel}` }
                : {}),
            } as ChartBand,
          ]
        : []),
      ...(pi
        ? [
            {
              level: POST_INVERSION_BAND.level,
              axis: "primary",
              source: "perPoint",
              fromPoint: POST_INVERSION_BAND.key,
              label: smoothed
                ? `post-inversion amber floor on the ${smoothed.window}-obs mean (releases on ${pi.releaseN} above)`
                : `post-inversion amber floor (releases on ${pi.releaseN} closes above)`,
            } as ChartBand,
          ]
        : []),
      ...(dd
        ? [
            {
              level: R1_DRAWDOWN_BAND.level,
              axis: "primary",
              source: "perPoint",
              fromPoint: R1_DRAWDOWN_BAND.key,
              label: `regime-relative drawdown cut (${dd.window}d high − ${dd.dropPp}pp)`,
              // BLUE, not amber ([USER] 2026-08-30): with the fixed 0.5 amber retired this and the
              // rung's floor are the two amber lines left, and they are DIFFERENT legs — the hue
              // carries that leg identity (the `pair` contract, ChartBand.pair), severity stays in
              // the "amber" level + the label text. `drop` is the drawdown/fall hue already.
              pair: "drop",
            } as ChartBand,
          ]
        : []),
      // Secondary-axis bounds LAST — the renderer resolves the primary threshold pair and the
      // moving perPoint cuts before the axis-2 pair, and the legend prints them in this order.
      ...shortLegBands,
    ],
  };
}

// The short-leg gate axis's bounds (see `levelThresholdChart`) plus the window the axis plots —
// `shortLeg` is undefined when no bound survives, which keeps the spec single-axis.
function shortLegGate(
  gatePi: PostInversionCooldown | undefined,
  dd: DrawdownLeg | undefined,
): { bands: ChartBand[]; shortLeg: { window: number } | undefined } {
  const moveWindow = gatePi?.shortLegWindow ?? dd?.gateWindow;
  const gateOnPlottedWindow = dd !== undefined && dd.gateWindow === moveWindow;
  // When the two knobs coincide the drawdown gate's NEGATIVE bound lands on the rung's escalation
  // line and is suppressed below — so that one line carries BOTH conditions, and on an UNARMED
  // day the condition actually live there is the AMBER gate, not the RED escalation. The label
  // says so rather than over-signalling severity (review 2026-08-30); it reverts to the plain
  // escalation text the moment the knobs diverge and each gets its own line.
  const mirrorFolded = gateOnPlottedWindow && gatePi !== undefined && gatePi.shortLegDropBp === dd.gateBp;
  const bands: ChartBand[] = [
    ...(gatePi
      ? [
          {
            level: "red",
            axis: "secondary",
            source: "derived",
            value: -gatePi.shortLegDropBp / 100,
            // Kept SHORT ([USER] 2026-08-30) — the legend prints these beside the primary cuts and
            // a sentence-long caption crowded them out. Still composed off the knob, never a literal.
            label: mirrorFolded
              ? `−${gatePi.shortLegDropBp}bp: RED (armed), else move gate`
              : `−${gatePi.shortLegDropBp}bp: RED (armed)`,
          } as ChartBand,
        ]
      : []),
    ...(gateOnPlottedWindow
      ? [
          {
            level: "amber",
            axis: "secondary",
            source: "derived",
            value: dd.gateBp / 100,
            label: `±${dd.gateBp}bp: move gate`,
          } as ChartBand,
          // The gate is on |move|, so it has a mirror bound. It is drawn only where no rung line
          // already sits on that y — at today's equal knobs (10bp both) the two coincide and a
          // second line would overprint the first with a contradictory severity colour.
          ...(mirrorFolded
            ? []
            : [
                {
                  level: "amber",
                  axis: "secondary",
                  source: "derived",
                  value: -dd.gateBp / 100,
                  label: `±${dd.gateBp}bp: move gate`,
                } as ChartBand,
              ]),
        ]
      : []),
  ];
  const shortLeg = moveWindow !== undefined && bands.length > 0 ? { window: moveWindow } : undefined;
  return { bands, shortLeg };
}

// Generic level / velocity — bands resolve at render from meta.thresholds (per-field,
// eff-overridden). Level plots `value` against the level pair; velocity-only plots `delta20`
// against the velocity pair (matching the renderer's `velocityMode = !hasLevel && hasVelocity`).
// Returns undefined when the indicator carries neither pair (falls to the sentinel).
// `params` is consulted for the VISIBLE SPAN only (`window`), mirroring `dualAxisChart`'s
// `...(params.window != null ? …)` spread. A window-only `CHART_PARAMS_OF` row therefore reaches this
// route rather than diverting to the dual-axis/builder/displayBands ones — that is exactly how F11
// carries its 500-day span without gaining a second axis (`family-descriptor-rows.ts` §F11). The LEVEL
// branch takes no window today: no window-only id resolves to it, and adding one there is a separate
// decision, not an oversight.
function genericThresholdChart(i: Indicator, params?: FamilyChartParams): ChartSpec | undefined {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  const t = i.thresholds ?? {};
  // `calibLegsFor` is the second route onto the level axis: an id whose level cuts live ENTIRELY in
  // the published vintage carries no registry prior to test, and testing the prior alone would leave
  // it bandless. NO id is in that position today — verified 2026-08-06 over `ALL_INDICATORS`: every
  // id with a `CALIB_MAP` level leg also ships a registry level pair — so the clause is a standing
  // guard for the next vintage-only id, with no live example to name. The bands stay `threshold`, which the
  // renderer swaps for `effAmber/effRed` — and that is where the σ-cuts become drawable spread
  // levels (`effectiveCuts` inverts them through the zref distribution).
  const hasLevel = t.amberLevel != null || t.redLevel != null || calibLegsFor(i.id).level;
  const hasVelocity = t.amberVelocity != null || t.redVelocity != null;
  if (hasLevel) return levelThresholdChart(i, t, unit);
  if (hasVelocity) {
    // Velocity mode plots the stored delta unitless (the renderer formats with unit "").
    // The axis carries a composed `label` (Stage 2, 2026-08-07): emitting none is why the FE
    // fell back to the hardcoded "Δ20 (20-day change)", already wrong for every id with its own
    // `velocityWindow` and 3× wrong for F9's 60. Same composer as the dual-axis route.
    // A σ id whose CUSUM knobs resolve (F9; not the speed-only F11) additionally scores a
    // CUSUM leg (`vel-cusum`) whose accumulator has no
    // home on the Δw axis — S⁺ is in accumulator units and its bounds are not Δw numbers, so
    // drawing either on the primary axis would paint a wrong value (and `domain-legs.ts` forbids
    // those lines there). It gets the SECONDARY axis instead: the S⁺ trace plus BOTH tiers of the
    // two-tier leg (amber warning limit, red action limit — §3.6a), which is what makes a block
    // scored by `vel-cusum` explicable on screen rather than an un-cued colour.
    // Each bound is resolved through its ONE reader (`cusumAlarmBound`/`cusumRedBound`) and its
    // LABEL is COMPOSED off that resolved number — never restated — so a retune moves the drawn
    // line, its printed value and the fire test together. The label is spelled out because the
    // shared `bandLabel` renderer (`public/detail-chart.js`) prints a band's numeric value only
    // when the band declares NO custom label, and these two need names as well as numbers.
    // Every velocity id WITHOUT `velocitySigma` keeps the single-axis spec byte-identically
    // (the `?:` below adds nothing for them) — and so does a σ id that declines the persistence
    // leg (F11, ruling 5): the three spreads are gated on the RESOLVED knob triple, not on
    // `velocitySigma` presence, so it gets a single-axis spec with no S⁺ trace and no S⁺ bands
    // while `velocityBandsFor` still gives it the moving σ pair on the primary axis.
    const sig = t.velocitySigma ? cusumParams(t.velocitySigma) : undefined;
    // A DISPLAY-ONLY consumer gate drawn on the secondary axis (never with S⁺, which owns it): the
    // %-off-high line + its cut, so the Δ chart and the consumer's gate cell read in one unit.
    const oh = sig ? undefined : OFF_HIGH_OVERLAY_OF[i.id];
    return {
      axes: [
        {
          id: "primary",
          side: "left",
          unit: "",
          format: "value",
          label: velocitySpanWord(i, i.velocityWindow ?? VELOCITY_WINDOW),
        },
        ...(sig
          ? [
              {
                id: "secondary",
                side: "right",
                unit: "",
                format: "value",
                label: "S⁺ (sustained drift)",
              } as ChartAxis,
            ]
          : []),
        ...(oh ? [{ id: "secondary", side: "right", unit: "%", format: "value", label: `% off ${oh.n}-close high` } as ChartAxis] : []),
      ],
      series: [
        { axis: "primary", fromPoint: "delta20", style: "primary" },
        ...(sig ? [{ axis: "secondary", fromPoint: "cusum", style: "primary" } as ChartSeries] : []),
        ...(oh
          ? [{ axis: "secondary", compute: "offHigh", window: oh.n, scale: 100, style: "derived", label: `off ${oh.n}-close high` } as ChartSeries]
          : []),
      ],
      bands: [
        ...velocityBandsFor(t),
        ...(sig
          ? [
              {
                level: "amber",
                axis: "secondary",
                source: "derived",
                value: sig.alarm,
                label: `h ${sig.alarm.toFixed(2)}`,
              } as ChartBand,
              {
                level: "red",
                axis: "secondary",
                source: "derived",
                value: sig.red,
                label: `red ${sig.red.toFixed(2)}`,
              } as ChartBand,
            ]
          : []),
        ...(oh
          ? [
              {
                level: "amber",
                axis: "secondary",
                source: "derived",
                value: -oh.drop * 100,
                style: "evt",
                label: `${oh.who} −${+(oh.drop * 100).toFixed(2)}% (display only)`,
              } as ChartBand,
            ]
          : []),
      ],
      ...(params?.window != null ? { window: params.window } : {}),
    };
  }
  return undefined;
}

/** Velocity ids that draw a CONSUMER's %-off-high gate on their secondary axis — display only, the id's
 *  own ribbon never reads it (F17 fires on yen WEAKNESS; spit's gate trips on yen STRENGTH). */
const OFF_HIGH_OVERLAY_OF: Record<string, { n: number; drop: number; who: string }> = {
  F17: { ...SPIT_YEN_GATE, who: "spit yen gate" },
};

/**
 * The velocity pair's band shape — MOVING for a rolling-σ id, static otherwise.
 *
 * A `velocitySigma` id (F9) states its
 * cuts in σ MULTIPLES while this axis plots the RAW Δw, so a scalar band here would paint "1.5"
 * beside a Δ60 that lives in whole index points — the wrong number Stage 1 suppressed the pair to
 * avoid. The cut is a different raw value every day (`amber × σ(t)`), so it rides the same
 * `source: "perPoint"` transport CG's expanding percentile does: `api/series.ts` emits
 * `SeriesPointDTO.bandCuts[key]` per date off the SAME `POINT_BAND_SIGMA_CUTS` map keyed here, and
 * `detail-chart.js` draws it as a gap-breaking polyline. Every other velocity id keeps the static
 * `threshold` pair, byte-identical.
 *
 * ⚠ The label COMPOSES the multiple off the registry pair (`t[c.from]`) — never a literal, so an
 * F9 retune moves the caption with the line. Two decimals, trailing zeros stripped, so 1.5 prints
 * "1.5σ" and a half-step like 1.75 prints "1.75σ" rather than rounding into a false caption.
 */
function velocityBandsFor(t: Thresholds, axis: ChartBand["axis"] = "primary"): ChartBand[] {
  if (t.velocitySigma === undefined)
    return [
      { level: "amber", axis, source: "threshold", metric: "velocity" },
      { level: "red", axis, source: "threshold", metric: "velocity" },
    ];
  return POINT_BAND_SIGMA_CUTS.filter((c) => t[c.from] != null).map((c) => ({
    level: c.level,
    axis,
    source: "perPoint",
    fromPoint: c.key,
    label: `${c.level} ${+t[c.from]!.toFixed(2)}σ`,
  }));
}

// Identity / plain — one primary axis, GENUINELY unbanded ⇒ the explicit Case-3
// `"context-only"` sentinel (never a silent empty array). Members:
//   • SLOW id complacency-duration — the ONE still here, and NOT because it is unbandable: its
//     metric is the calm run length AS A FRACTION of `SLOW_CALM_RUN_MIN`, so its cut is the
//     constant 1.0 the axis is already normalised by. Drawable, deliberately undrawn (undecided —
//     the leg also folds `CONFIRM_CLOSES` before it fires, so the line under-promises the way
//     complacency-high's over-promises). ⚠ The other three SLOW ids LEFT this set 2026-08-30 for
//     `buildPriceAccelChart` / `buildComplacencyVixChart` / `buildComplacencyHighChart` above:
//     each stores a metric its cuts share an axis with.
//   • PENSION / BOTTOM track ids — off-ladder context channels, no threshold semantics.
// `params` is consulted for the VISIBLE SPAN only (`window`), the same spread `dualAxisChart` and
// `genericThresholdChart`'s velocity branch carry — that is how the pension comparators reach 500d
// (`family-descriptor-rows.ts` §comparators) while staying bandless.
function contextOnlySpec(i: Indicator, params?: FamilyChartParams): ChartSpec {
  const unit = i.unit ?? "%"; // mirror the wire-edge unit materialization above
  return {
    axes: [{ id: "primary", side: "left", unit, format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands: "context-only",
    ...(params?.window != null ? { window: params.window } : {}),
  };
}
