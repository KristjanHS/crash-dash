/**
 * Direct unit tests for `buildIndicatorChart` (api/indicators.ts) — the store-free chart
 * specs the handler suite used to reach only through GET(). Wiring pins stay there.
 */
import { describe, expect, test } from "vitest";

import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import {
  VT_AMBER_RATIO,
  VT_RED_RATIO,
  DISP_BASKET_RED,
  DISP_CORR,
  MU_MA_MULT,
} from "../src/family-descriptor-rows.js";
import { maMultSuffix } from "../src/gates.js";
import { ACCEL_AMBER_PCTILE, ACCEL_RED_PCTILE } from "../src/slow.js";
import type { ChartBand } from "../src/api/types.js";
import { tradingToCalendarDays } from "../src/family-descriptor-core.js";
import {
  POST_INVERSION_BAND,
  R8_MEAN_CUT_BANDS,
  SMOOTHED_LEVEL_OF,
  DETAIL_WINDOW,
  DETAIL_WINDOW_DAYS,
} from "../src/family-descriptor-rows.js";
import { buildIndicatorChart } from "./indicators.js";

const SERVED = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS];
const byId = (id: string) => SERVED.find((i) => i.id === id)!;
const chartOf = (id: string) => buildIndicatorChart(byId(id));

describe("buildIndicatorChart - perPoint band spec", () => {
  test("R1 declares the post-inversion floor cut as a perPoint band; R8 its mean-space pair", () => {
    // Premise pair: both ids carry a rung; R8's `levelCuts` makes its pair mean-space.
    expect(byId("R1").postInversionCooldown).toBeDefined();
    expect(byId("R8").postInversionCooldown!.levelCuts).toBeDefined();
    expect(SMOOTHED_LEVEL_OF.R8).toBeDefined();
    // R1's rung runs over the plotted mean: one moving line, no drawdown cut.
    expect(SMOOTHED_LEVEL_OF.R1?.redWindow).toBeDefined();
    expect(byId("R1").drawdownLeg).toBeUndefined();
    const r1Bands = chartOf("R1").bands as ChartBand[];
    const perPointR1 = r1Bands.filter((b) => b.source === "perPoint");
    expect(
      perPointR1.map((b) => [b.fromPoint, b.level]),
      "R1's one moving amber line reads the shared wire key",
    ).toEqual([[POST_INVERSION_BAND.key, POST_INVERSION_BAND.level]]);
    const r8Bands = chartOf("R8").bands as ChartBand[];
    const perPoint = r8Bands.filter((b) => b.source === "perPoint");
    expect(
      perPoint.map((b) => [b.fromPoint, b.level]),
      "R8 draws its two mean-space cut lines off the wire keys",
    ).toEqual(R8_MEAN_CUT_BANDS.map((b) => [b.key, b.level]));
  });

  test("a σ-unit velocity pair rides a per-DAY moving band, never a scalar cut line (F9)", () => {
    const f9 = byId("F9");
    // Premise: F9 IS the σ id and DOES carry a velocity pair.
    expect(f9.thresholds.velocitySigma, "F9 must still be the σ-unit id").toBeDefined();
    expect(f9.thresholds.amberVelocity, "F9 must still carry a velocity pair").toBeGreaterThan(0);
    const bands = buildIndicatorChart(f9).bands;
    expect(bands, "F9 is banded, not context-only").not.toBe("context-only");
    expect(
      (bands as ChartBand[]).filter((b) => b.source === "threshold"),
      "a σ id must declare no scalar-resolved band",
    ).toEqual([]);
    // Label composed off the registry multiple; `+v.toFixed(2)` mirrors `velocityBandsFor`.
    const sigmaLabel = (level: string, v: number): string => `${level} ${+v.toFixed(2)}σ`;
    // Primary (Δ60) axis only: the secondary `h` band is a different axis with its own suite.
    expect(
      (bands as ChartBand[])
        .filter((b) => (b.axis ?? "primary") === "primary")
        .map((b) => [b.level, b.source, b.fromPoint, b.label]),
    ).toEqual([
      ["amber", "perPoint", "velSigmaAmber", sigmaLabel("amber", f9.thresholds.amberVelocity!)],
      ["red", "perPoint", "velSigmaRed", sigmaLabel("red", f9.thresholds.redVelocity!)],
    ]);
  });
});

describe("buildIndicatorChart - declarative chart spec", () => {
  const BAND_SOURCES = new Set(["derived", "displayBand", "threshold", "effective", "perPoint"]);

  test("CCC draws both scoring axes: the level pair AND the velocity pair its velocity leg scores", () => {
    const chart = chartOf("CCC");
    const bands = chart.bands as Array<{ axis: string; source: string; metric?: string }>;
    for (const axis of ["primary", "secondary"]) {
      const metric = axis === "primary" ? "level" : "velocity";
      expect(bands.filter((b) => b.axis === axis && b.source === "threshold" && b.metric === metric)).toHaveLength(2);
    }
    // The secondary line plots the PERSISTED delta the velocity leg scored.
    expect(chart.series.find((s) => s.axis === "secondary")!.fromPoint).toBe("delta20");
    expect(chart.axes.find((a) => a.id === "secondary")!.label).toMatch(/Δ\d+d$/);
  });

  test("own-MA gate overlays carry the gate's OWN line: F8 scaled by MU_MA_MULT, F4 bare", () => {
    const trendOf = (id: string) => chartOf(id).series.find((s) => s.compute === "ma200")!;
    // F8's gate is `MU < MA200·MU_MA_MULT`: scale + label both derive from the one constant.
    const f8 = trendOf("F8");
    expect(f8.scale).toBe(MU_MA_MULT);
    expect(f8.label).toBe(`MU's 200-day MA ${maMultSuffix(MU_MA_MULT)}`);
    // F4's gate is a BARE `< MA200` — no scale, no label override.
    const f4 = trendOf("F4");
    expect(f4.scale).toBeUndefined();
    expect(f4.label).toBeUndefined();
  });

  test("every served id builds a well-formed chart (coverage: none skipped)", () => {
    let exercised = 0;
    const served: [string, ChartBand][] = [];
    for (const i of SERVED) {
      const chart = buildIndicatorChart(i);
      expect(chart.axes.length, `${i.id} axes`).toBeGreaterThan(0);
      const axisIds = new Set(chart.axes.map((a) => a.id));
      expect(chart.series.length, `${i.id} series`).toBeGreaterThan(0);
      for (const s of chart.series) expect(axisIds.has(s.axis), `${i.id} series axis ${s.axis}`).toBe(true);
      // bands is real ChartBand[] OR the "context-only" sentinel (nothing to axis-check).
      const bands = chart.bands === "context-only" ? [] : chart.bands;
      for (const b of bands) {
        expect(BAND_SOURCES.has(b.source), `${i.id} band source ${b.source}`).toBe(true);
        expect(axisIds.has(b.axis), `${i.id} band axis ${b.axis}`).toBe(true);
        served.push([i.id, b]);
      }
      exercised++;
    }
    // Baked bands carry a finite value; render-time bands none; perPoint names its wire key.
    const isBaked = (b: ChartBand): boolean => b.source === "derived" || b.source === "displayBand";
    const perPoint = served.filter(([, b]) => b.source === "perPoint");
    const baked = served.filter(([, b]) => isBaked(b));
    const renderTime = served.filter(([, b]) => !isBaked(b));
    expect(perPoint.length).toBeGreaterThan(0);
    expect(baked.length).toBeGreaterThan(0);
    expect(renderTime.length).toBeGreaterThan(0);
    for (const [id, b] of perPoint) expect(typeof b.fromPoint, `${id} ${b.level} perPoint band names its wire key`).toBe("string");
    for (const [id, b] of baked) expect(Number.isFinite(b.value), `${id} ${b.level} baked value`).toBe(true);
    for (const [id, b] of renderTime) expect(b.value, `${id} ${b.level} render-time band has no baked value`).toBeUndefined();
    // Coverage pin derived from the two registry exports, never a hand-typed number.
    expect(exercised).toBe(ALL_INDICATORS.length + CHART_ONLY_INDICATORS.length);
  });

  test("aligned-start ids carry the shared date-anchored window (fromDays); a count-window id doesn't", () => {
    // ALIGNED_WINDOW_IDS share one calendar start via DETAIL_WINDOW_DAYS instead of a COUNT window.
    for (const id of ["F1", "F3", "F13", "SPY", "VT", "DISP"]) {
      expect(chartOf(id).fromDays, `${id} fromDays`).toBe(DETAIL_WINDOW_DAYS);
    }
    expect(DETAIL_WINDOW_DAYS).toBe(tradingToCalendarDays(DETAIL_WINDOW));
    // A non-enrolled id keeps the count window — no fromDays.
    expect(chartOf("R1").fromDays).toBeUndefined();
  });

  test("a neighbor id (F2) carries no window/lead - the override is F1-only", () => {
    const f2 = chartOf("F2");
    expect(f2.window).toBeUndefined();
    expect(f2.lead).toBeUndefined();
  });

  test("F2 chart: velocity pair drawn on a secondary axis fed by the STORED delta20", () => {
    const f2 = byId("F2");
    const chart = buildIndicatorChart(f2);
    // The pair really is scored — without it this whole axis would be drawing nothing.
    expect(f2.thresholds.amberVelocity).toBeGreaterThan(0);
    expect(f2.thresholds.redVelocity).toBeGreaterThan(0);

    const axis2 = chart.axes.find((a) => a.id === "secondary");
    expect(axis2?.side).toBe("right");
    // Caption composed from the SCORED window (F2 takes the VELOCITY_WINDOW default).
    expect(axis2?.label).toBe(`IG OAS Δ${VELOCITY_WINDOW}d`);

    const sec = chart.series.find((s) => s.axis === "secondary");
    expect(sec?.fromPoint).toBe("delta20");
    expect(sec?.compute).toBeUndefined();

    const bands = chart.bands;
    if (bands === "context-only") throw new Error("F2 must declare real bands");
    const secBands = bands.filter((b) => b.axis === "secondary");
    expect(secBands.map((b) => b.level).sort()).toEqual(["amber", "red"]);
    for (const b of secBands) {
      expect(b.source).toBe("threshold");
      expect(b.metric).toBe("velocity");
      expect(b.value).toBeUndefined(); // resolved client-side from the mode cell, never baked
    }
    // The level pair is untouched; F2 stays off `legBands`.
    const primary = bands.filter((b) => (b.axis ?? "primary") === "primary");
    expect(primary.map((b) => b.level).sort()).toEqual(["amber", "red"]);
    for (const b of primary) expect(b.metric).toBe("level");
    expect(chart.legBands).toBeUndefined();
  });

  test("VT drift guard: chart amber/red bands === the scorer's ratio constants", () => {
    // Single-sources VT's drawn bands to VT_AMBER_RATIO/VT_RED_RATIO.
    const bands = chartOf("VT").bands;
    if (bands === "context-only") throw new Error("VT must declare real bands");
    const amber = bands.find((b) => b.level === "amber")!;
    const red = bands.find((b) => b.level === "red")!;
    expect(amber.source).toBe("displayBand");
    expect(amber.value).toBe(VT_AMBER_RATIO);
    expect(red.source).toBe("displayBand");
    expect(red.value).toBe(VT_RED_RATIO);
    // Labels COMPOSED from the constants, so a retuned ratio can't leave a stale printed number.
    expect(amber.label).toBe(`amber ≥${VT_AMBER_RATIO.toFixed(2)}`); // inclusive amber edge (ratio ≥ cut)
    expect(red.label).toBe(`red >${VT_RED_RATIO.toFixed(2)}`); // STRICT red edge (ratio > cut)
  });

  test("price-accel: one primary-axis percentile cut pair, labelled `≥` on BOTH edges (scorePriceAccel is inclusive)", () => {
    const chart = chartOf("price-accel");
    const bands = chart.bands;
    if (bands === "context-only") throw new Error("price-accel must declare real bands");
    expect(chart.axes.map((a) => a.id)).toEqual(["primary"]); // no 2nd axis
    expect(bands.map((b) => [b.level, b.axis, b.value, b.label])).toEqual([
      ["amber", "primary", ACCEL_AMBER_PCTILE, `amber ≥${ACCEL_AMBER_PCTILE.toFixed(2)}`],
      ["red", "primary", ACCEL_RED_PCTILE, `red ≥${ACCEL_RED_PCTILE.toFixed(2)}`],
    ]);
  });

  test("DISP draws the BASKET leg and gates the corr leg - both arms still explained", () => {
    const chart = chartOf("DISP");
    const bands = chart.bands;
    if (bands === "context-only") throw new Error("DISP must declare real bands");

    // Two bands on the SECONDARY (basket) axis — amber at the zero onset, red at the depth
    // cut — and one on the PRIMARY (corr) axis: the drawn confirm gate.
    expect(bands.map((b) => [b.level, b.axis, b.value])).toEqual([
      ["amber", "secondary", 0],
      ["red", "secondary", DISP_BASKET_RED],
      ["amber", "primary", DISP_CORR],
    ]);
    // displayBand ⇒ never multiplied (DISP is out of CALIB_MAP).
    expect(bands.every((b) => b.source === "displayBand")).toBe(true);
    // Labels COMPOSED from the two constants, asserted by CONTAINMENT so a retune survives.
    expect(bands.every((b) => b.label!.includes(`corr>${DISP_CORR}`))).toBe(true);
    expect(bands.find((b) => b.level === "red")!.label).toContain(`${(DISP_BASKET_RED * 100).toFixed(1)}`.replace("-", "−"));

    // The decision series reads `decision` (the basket) — selects the derived layout client-side.
    const decisionSeries = chart.series.find((s) => s.fromPoint === "decision")!;
    expect(decisionSeries.axis).toBe("secondary");
    // ONE confirm gate (appliesTo "both"): a dimmed stretch means "corr below the confirm cut".
    expect(decisionSeries.gatedBy).toEqual(["corrAtOrAboveCut"]);
    expect(chart.gates!.map((g) => g.appliesTo)).toEqual(["both"]);
    // The full label copy, composed from the same two constants (never retyped).
    const corrText = `corr>${DISP_CORR}`;
    const basketText = `${(DISP_BASKET_RED * 100).toFixed(1).replace("-", "−")}%`;
    expect(bands.map((b) => b.label)).toEqual([
      `amber <0% · ${corrText}`,
      `red <${basketText} · ${corrText}`,
      `${corrText} confirms`,
    ]);
  });
});
