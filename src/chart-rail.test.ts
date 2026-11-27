/**
 * Stage 4.4 — the ONE golden-blind branch (stage-4 spec §1.3): F7's capePct displayBands.
 * `buildIndicatorChart` takes no cuts, so the committed golden pins only F7's
 * context-only FALLBACK — nothing else asserts the rendered bands/labels, and the move into
 * `contextChart` (src/chart-rail.ts) could silently drop them with everything green. No other
 * new tests here by design: goldens + chart-bands.test.ts cover every other moved branch.
 */
import { describe, expect, it } from "vitest";
import { buildFamilyChart, contextChart, DELTA5_OVERLAY, DELTA5_WINDOW, dualAxisChart, MA_OVERLAY_WINDOW, MA_OVERLAYS, MOVE_MEDIAN, rendererForSpec, RV10_OVERLAY, RV10_WINDOW, TOGGLE_OVERLAYS, VOL_MEDIAN } from "./chart-rail.js";
import { GATES } from "./gates.js";
import {
  CHART_DESCRIPTOR_OF,
  CHART_PARAMS_OF,
  F3_VELOCITY_BAND,
  R1_DRAWDOWN_BAND,
  R7_CUT_BANDS,
  FAMILY_OF,
  SMOOTHED_LEVEL_OF,
  POST_INVERSION_BAND,
  BULL_AMBER_P,
  BULL_RED_P,
  VELOCITY_Z_CONSTANTS_OF,
  POINT_BAND_CUTS_OF,
  SECOND_LEG_CHART_OF,
  FDX_DESCRIPTOR,
  HCX_BAND,
  EXSH_GATE_DESCRIPTOR,
  XDEV_GATE_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";
import { CONFIRM_CLOSES } from "./domain-types.js";
import {
  HYGLQD_AMBER,
  HYGLQD_D20_AMBER,
  HYGLQD_D20_RED,
  HYGLQD_MA,
  HYGLQD_RED,
  HYGLQD_RET_WINDOW,
} from "./family-descriptor-rows.js";
import { creditAppetiteReadingSeries, scoreCreditAppetite } from "./scorers-price.js";
import type { ChartBand } from "./api/types.js";
import type { Indicator } from "./domain-types.js";
import { T10Y3M_DRAWDOWN } from "./registry-fred.js";

describe("chart rail - F7 capePct context route (golden-blind, spec §1.3)", () => {
  const f7 = ALL_INDICATORS.find((i) => i.id === "F7");
  if (!f7) throw new Error("F7 missing from ALL_INDICATORS - census moved under the test");
  const f7Params = CHART_PARAMS_OF.F7;
  if (!f7Params) throw new Error("CHART_PARAMS_OF.F7 missing - the declarative entry moved under the test");

  it("renders both capePct bands, and null/partial cuts fall through (undefined)", () => {
    const spec = contextChart(f7, f7Params, { amber: 31.2, red: 36.8 });
    expect(spec).toBeDefined();
    // Values resolved at request time from the expanding percentile of the stored history;
    // labels compose the declared `p` per level, byte-exact incl. toFixed(1).
    expect(spec!.bands).toEqual([
      { level: "amber", axis: "primary", source: "displayBand", value: 31.2, label: "amber ≥31.2 (p80 of own history)" },
      { level: "red", axis: "primary", source: "displayBand", value: 36.8, label: "red ≥36.8 (p95 of own history)" },
    ]);
    // Degraded feed (cuts null) — or a declared level with NO resolved cut — ⇒ the builder
    // returns undefined and the dispatch falls through to `"context-only"` — never a bogus line.
    expect(contextChart(f7, f7Params, null)).toBeUndefined();
    expect(contextChart(f7, f7Params, { amber: 31.2 })).toBeUndefined();
  });
});

/**
 * Stage 2 slice 2 — the velocity caption is
 * composed from the id's OWN `velocityWindow` and its OWN observation grid, never a literal.
 * The golden pins the resulting STRINGS; this pins the two RESOLUTIONS the string is built
 * from, which the golden cannot see (it regenerates from whatever expression ships, so a
 * cadence-keyed word would have rebaselined to "Δ60w" with every suite green).
 */
describe("chart rail - velocity-axis caption resolution", () => {
  const byId = (id: string) => {
    const i = ALL_INDICATORS.find((x) => x.id === id);
    if (!i) throw new Error(`${id} missing from ALL_INDICATORS - census moved under the test`);
    return i;
  };
  const labelOf = (id: string, axis: "primary" | "secondary") =>
    buildFamilyChart(byId(id), undefined).axes.find((a) => a.id === axis)?.label;

  it("F9 - velocity-only PRIMARY axis: span from velocityWindow, word from the observation grid (NOT cadence)", () => {
    const f9 = byId("F9");
    // F9 left the weekly H.10 release for daily `USDU` 2026-08-10: release and grid agree, so the
    // caption resolves "d" through the plain fallback. The release≠grid carriers are G1/BRENT now,
    // and they take the DERIVED chart route, not this branch — the test name's chart-route carrier
    // is gone; this pins the daily fallback arm plus the span's single-sourcing.
    expect(f9.cadence).toBe("daily");
    expect(f9.obsCadence).toBeUndefined();
    // Span single-sourced from the registry — no window literal here, so a retune moves the
    // expectation with the line.
    expect(labelOf("F9", "primary")).toBe(`Δ${f9.velocityWindow}d`);
    // And say the failure mode out loud: the 5× error a caption composed off a weekly word produces.
    expect(labelOf("F9", "primary")).not.toBe(`Δ${f9.velocityWindow}w`);
  });

  it("F3 - the weekly arm is still reachable: a genuinely weekly-OBSERVED id still captions 'w'", () => {
    const f3 = byId("F3");
    // No `obsCadence`: NFCI is published weekly AND observed weekly, so the fallback to
    // `cadence` is the right answer. Without this arm the F9 fix would be indistinguishable
    // from hardcoding "d" everywhere.
    expect(f3.obsCadence).toBeUndefined();
    expect(f3.cadence).toBe("weekly");
    expect(labelOf("F3", "secondary")).toBe(`NFCI Risk Δ${f3.velocityWindow}w`);
  });
});

/**
 * R7 bespoke bull-steepener overlay (2026-08-14 `[USER]`).
 * R7 LEFT the context-only sentinel: it now draws T10Y3M primary + both Δ20 legs on the secondary,
 * carrying the four moving ranked cuts. Values single-sourced from `R7_CUT_BANDS`/`BULL_*_P`, so a
 * key rename or a probability retune moves the expectation with the spec.
 */
/**
 * RAW-carrier fixture for the drawdown-leg + short-leg-gate chart paths: R1's registry shape under a
 * NON-smoothed `fred-level-velocity` id, wearing `T10Y3M_DRAWDOWN`. Live R1 left both paths
 * 2026-08-31 (a `SMOOTHED_LEVEL_OF` row gates `dd` and the gate axis off; no `drawdownLeg`), so the
 * code stays pinned here on the fixture — `buildFamilyChart` routes on `FAMILY_OF[i.id]`, hence R2.
 */
const RAW_CARRIER = (() => {
  const r1 = ALL_INDICATORS.find((i) => i.id === "R1");
  if (!r1) throw new Error("R1 missing from ALL_INDICATORS - census moved under the test");
  if (FAMILY_OF.R2 !== FAMILY_OF.R1 || SMOOTHED_LEVEL_OF.R2) throw new Error("fixture id R2 must share R1's family and carry no smoothed row");
  return { ...r1, id: "R3", drawdownLeg: T10Y3M_DRAWDOWN };
})();

describe("chart rail - the drawdown cut line is RUNG-INDEPENDENT", () => {
  const r1 = RAW_CARRIER;

  it("a carrier with a drawdownLeg and NO postInversionCooldown still draws the drawdown cut", () => {
    // The scorer's leg is always-on by construction (it never reads the rung's arming), so the DRAWN
    // line must not be gated on the rung either — otherwise such a carrier scores AMBER off the leg
    // and paints nothing, breaking "score and drawn line are one expression". This is the guard
    // that keeps a raw carrier honest.
    const rungless = { ...r1, postInversionCooldown: undefined };
    const bands = buildFamilyChart(rungless, undefined).bands;
    if (bands === "context-only") throw new Error("R1 must not route to context-only");
    const perPoint = bands.filter((b) => b.source === "perPoint");
    expect(perPoint.map((b) => b.fromPoint), "the drawdown line survives; the rung's floor does not").toEqual([
      R1_DRAWDOWN_BAND.key,
    ]);
    expect(perPoint[0]!.level).toBe(R1_DRAWDOWN_BAND.level);
  });
});

/**
 * R1's short-leg gate axis (2026-08-30 `[USER]`). Both moving amber cuts carry an AND-condition on
 * a SECOND series with no image on the value axis — measured over the served window, 105 of 400
 * days painted RED with the spread ABOVE the drawn red line, every one a bull-steepener escalation.
 * The gate's decision variable now takes the secondary axis with its bounds drawn. Every value here
 * derives from the registry objects, so a knob retune moves the expectation with the line.
 */
describe("chart rail - a raw carrier's short-leg gate rides the secondary axis", () => {
  const r1 = RAW_CARRIER;
  const PI = r1.postInversionCooldown!;
  const DD = r1.drawdownLeg!;
  const spec = buildFamilyChart(r1, undefined);
  const bands = spec.bands === "context-only" ? [] : spec.bands;
  const sec = bands.filter((b) => b.axis === "secondary");

  it("declares the axis and plots `shortMove` on it", () => {
    expect(spec.axes.find((a) => a.id === "secondary"), "the raw carrier must carry a secondary axis").toBeDefined();
    expect(spec.series.filter((s) => s.axis === "secondary").map((s) => s.fromPoint)).toEqual(["shortMove"]);
    // The axis caption is COMPOSED off the resolved window + feed id, never restated.
    expect(spec.axes.find((a) => a.id === "secondary")!.label).toContain(String(PI.shortLegWindow));
    expect(spec.axes.find((a) => a.id === "secondary")!.label).toContain(PI.shortLegSeries);
  });

  it("draws the escalation bound as RED at the negated drop threshold", () => {
    const red = sec.filter((b) => b.level === "red");
    expect(red.map((b) => b.value), "one red bound, at -shortLegDropBp/100 (a FALL is negative)").toEqual([
      -PI.shortLegDropBp / 100,
    ]);
    expect(red[0]!.source).toBe("derived");
    expect(red[0]!.label, "the bound names the bp value it was composed from").toContain(`${PI.shortLegDropBp}bp`);
    // While the knobs coincide this ONE line also carries the drawdown gate's negative side, so it
    // must not read as RED-only — on an unarmed day the live condition there is the amber gate.
    expect(red[0]!.label, "the folded-mirror label names BOTH conditions").toContain("move gate");
  });

  it("draws the drawdown move gate as ONE amber bound while the two knobs coincide", () => {
    const amber = sec.filter((b) => b.level === "amber");
    // The gate is on |move|, so it has a mirror bound — suppressed while a rung line already sits
    // on that y. At today's equal knobs that is exactly one drawn amber line, on the positive side.
    expect(PI.shortLegDropBp, "guard: this expectation assumes the knobs still coincide").toBe(DD.gateBp);
    expect(amber.map((b) => b.value)).toEqual([DD.gateBp / 100]);
  });

  it("draws the mirror bound once the knobs diverge - the |move| gate is two-sided", () => {
    const diverged = { ...r1, drawdownLeg: { ...DD, gateBp: DD.gateBp * 2 } };
    const b = buildFamilyChart(diverged, undefined).bands;
    if (b === "context-only") throw new Error("the raw carrier must not route to context-only");
    const amber = b.filter((x) => x.axis === "secondary" && x.level === "amber");
    expect(amber.map((x) => x.value!).sort((x, y) => x - y)).toEqual([-DD.gateBp / 50, DD.gateBp / 50]);
    // …and with each condition back on its own line, the red bound drops the folded gloss.
    const red = b.find((x) => x.axis === "secondary" && x.level === "red")!;
    expect(red.label, "no fold ⇒ the escalation bound names only itself").not.toContain("move gate");
  });

  it("drops the drawdown bounds when its gate window is NOT the plotted one", () => {
    // One line cannot honestly serve two windows: `api/series.ts` plots the rung's, so a gate on a
    // different window would be a bound drawn against a line that does not score it.
    const offWindow = { ...r1, drawdownLeg: { ...DD, gateWindow: DD.gateWindow + 1 } };
    const b = buildFamilyChart(offWindow, undefined).bands;
    if (b === "context-only") throw new Error("the raw carrier must not route to context-only");
    const secBands = b.filter((x) => x.axis === "secondary");
    expect(secBands.map((x) => x.level), "only the rung's escalation bound survives").toEqual(["red"]);
  });

  it("leaves a rung-less, drawdown-less id single-axis", () => {
    const bare = { ...r1, postInversionCooldown: undefined, drawdownLeg: undefined };
    const s2 = buildFamilyChart(bare, undefined);
    expect(s2.axes.some((a) => a.id === "secondary"), "no gate ⇒ no second axis").toBe(false);
    expect(s2.series.every((x) => x.axis === "primary")).toBe(true);
  });
});

/**
 * Live R1 (2026-08-31): a two-window smoothed
 * carrier — the rung runs over the SAME `window`-obs mean the chart plots, so its floor line is
 * exact and drawn; it scores no escalation and no drawdown leg, so no gate axis and no second cut.
 */
describe("chart rail - live R1 draws the mean-space rung floor alone, single-axis", () => {
  const r1 = ALL_INDICATORS.find((i) => i.id === "R1");
  if (!r1) throw new Error("R1 missing from ALL_INDICATORS - census moved under the test");
  const smoothed = SMOOTHED_LEVEL_OF[r1.id];
  const spec = buildFamilyChart(r1, undefined);
  const bands = spec.bands === "context-only" ? [] : spec.bands;

  it("premise: R1 is the two-window smoothed carrier with a rung and no drawdown leg", () => {
    expect(smoothed?.redWindow).toBeDefined();
    expect(r1.postInversionCooldown?.levelCuts).toBeUndefined();
    expect(r1.drawdownLeg).toBeUndefined();
  });

  it("one perPoint band — the rung floor on the wire key — and no secondary axis or series", () => {
    const perPoint = bands.filter((b) => b.source === "perPoint");
    expect(perPoint.map((b) => [b.fromPoint, b.level, b.axis])).toEqual([[POST_INVERSION_BAND.key, POST_INVERSION_BAND.level, "primary"]]);
    expect(perPoint[0]!.label, "the label names the plotted mean's window").toContain(`${smoothed!.window}-obs mean`);
    expect(spec.axes.map((a) => a.id)).toEqual(["primary"]);
    expect(bands.some((b) => b.axis === "secondary"), "no gate bounds").toBe(false);
    expect(bands.some((b) => b.fromPoint === R1_DRAWDOWN_BAND.key), "no drawdown cut").toBe(false);
  });

  it("draws the redWindow mean RED scores on as a SECOND primary scored-mean series", () => {
    const prim = spec.series.filter((s) => s.axis === "primary");
    expect(prim.map((s) => s.fromPoint)).toEqual(["value", "redMean"]);
    const redMean = prim.find((s) => s.fromPoint === "redMean")!;
    expect(redMean.style).toBe("scored-mean");
    expect(redMean.label).toBe(`${smoothed!.redWindow}-obs mean`);
  });

  it("the redLevel threshold band names the DRAWN quarter mean it now carries (parenthetical shed)", () => {
    const red = bands.filter((b) => b.source === "threshold" && b.level === "red");
    expect(red).toHaveLength(1);
    expect(red[0]!.label).toContain(`${smoothed!.redWindow}-obs mean <`);
    expect(red[0]!.label).not.toContain("Amber");
    expect(red[0]!.label).not.toContain(`${smoothed!.window}-obs`);
  });
});

describe("chart rail - R7 bull-steepener builder route", () => {
  const r7 = ALL_INDICATORS.find((i) => i.id === "R7");
  if (!r7) throw new Error("R7 missing from ALL_INDICATORS - census moved under the test");

  it("routes to buildR7Chart (NOT context-only) with two secondary legs + the four moving cuts + the gate", () => {
    const spec = buildFamilyChart(r7, undefined);
    // It must have LEFT the sentinel — the whole point of the overlay.
    expect(spec.bands).not.toBe("context-only");
    // Two Δ20 legs on the secondary axis, both gated by shortEndDriven.
    const legs = spec.series.filter((s) => s.axis === "secondary" && s.style === "leg");
    expect(legs.map((s) => s.fromPoint)).toEqual(["bullLegs.drop", "bullLegs.steep"]);
    expect(legs.every((s) => s.gatedBy?.includes("shortEndDriven"))).toBe(true);
    expect(legs.every((s) => typeof s.label === "string" && s.label.length > 0)).toBe(true);
    // The primary stays the stored T10Y3M value line.
    expect(spec.series.filter((s) => s.axis === "primary")).toEqual([{ axis: "primary", fromPoint: "value", style: "primary" }]);
    // The four perPoint cuts, keys single-sourced from R7_CUT_BANDS (a rename moves this with the spec).
    const cuts = Array.isArray(spec.bands) ? spec.bands.filter((b) => b.source === "perPoint" && b.axis === "secondary") : [];
    expect(cuts.map((b) => b.fromPoint)).toEqual(R7_CUT_BANDS.map((c) => c.key));
    expect(cuts.map((b) => b.level)).toEqual(R7_CUT_BANDS.map((c) => c.level));
    // Labels compose off the tail probabilities, never restated — amber→BULL_AMBER_P, red→BULL_RED_P.
    const amberCut = cuts.find((b) => b.level === "amber");
    const redCut = cuts.find((b) => b.level === "red");
    expect(amberCut!.label).toContain(`p${+(BULL_AMBER_P * 100).toFixed(1)}`);
    expect(redCut!.label).toContain(`p${+(BULL_RED_P * 100).toFixed(1)}`);
    // The gate declaration backing gateLegend on the client.
    expect(spec.gates?.map((g) => g.key)).toEqual(["shortEndDriven"]);
  });
});

/**
 * BONOS chart (btp-bund B9) through the id-generic `buildBtpChart`. TWO scored legs (combine "or"): the
 * absolute bp pair off the id's `thresholds` AND the shared sovereign velocity z — so BOTH are drawn (a bandless
 * chart under a level-leg card is the R6 2026-08-30 failure).
 */
describe.each(["BONOS"] as const)("chart rail - %s level bands", (id) => {
  const ind = ALL_INDICATORS.find((i) => i.id === id);
  if (!ind) throw new Error(`${id} missing from ALL_INDICATORS - census moved under the test`);

  it("draws the absolute pair on the primary axis as registry threshold bands", () => {
    const spec = buildFamilyChart(ind, undefined);
    const bands = Array.isArray(spec.bands) ? spec.bands : [];
    // Premise: the registry ships BOTH level cuts and no per-point row.
    expect(ind.thresholds.amberLevel).toBeDefined();
    expect(ind.thresholds.redLevel).toBeDefined();
    expect(POINT_BAND_CUTS_OF[id]).toBeUndefined();
    const prim = bands.filter((b) => (b.axis ?? "primary") === "primary");
    // Plain severity hues — no `pair` hue (the lavender level hue was retired [USER] 2026-09-25), no evt dotting.
    expect(prim.map((b) => [b.level, b.source, b.metric, b.pair, b.style])).toEqual([
      ["amber", "threshold", "level", undefined, undefined],
      ["red", "threshold", "level", undefined, undefined],
    ]);
    expect(bands.filter((b) => b.source === "perPoint")).toEqual([]);
  });
});

/**
 * BONOS velocity leg (Ruling 4): the z is DRAWN on a SECONDARY axis beside its zAmber/zRed σ
 * bounds, read off the id's OWN `VELOCITY_Z_CONSTANTS_OF` row (never a restated literal). Exactly ONE
 * secondary series — genericSingle draws secArrs[0] only, so a second would be dropped silently — and the
 * non-decision secondary series keeps the spec on the `single` renderer, not the derived layout.
 */
describe.each(["BONOS"] as const)("chart rail - %s velocity z on the secondary axis", (id) => {
  const ind = ALL_INDICATORS.find((i) => i.id === id);
  if (!ind) throw new Error(`${id} missing from ALL_INDICATORS - census moved under the test`);

  it("draws the z line with its two σ bounds off the id's OWN constants row", () => {
    const spec = buildFamilyChart(ind, undefined);
    const bands = Array.isArray(spec.bands) ? spec.bands : [];
    expect(spec.axes.some((a) => a.id === "secondary")).toBe(true);
    expect(spec.series.filter((s) => s.axis === "secondary").map((s) => s.fromPoint)).toEqual(["velZ"]);
    const { zAmber, zRed } = VELOCITY_Z_CONSTANTS_OF[id]!;
    const sigmaBands = bands.filter((b) => b.source === "displayBand" && b.axis === "secondary");
    expect(sigmaBands.find((b) => b.level === "amber")?.value).toBe(zAmber);
    expect(sigmaBands.find((b) => b.level === "red")?.value).toBe(zRed);
    expect(spec.renderer).toBe("single");
  });
});

/**
 * Stage 8 (A5) — every DECLARED `CHART_DESCRIPTOR_OF.renderer` must equal the FE shape-sniff
 * (`rendererForSpec` mirrors public/detail-chart.js expression for expression), so the stamped
 * key can never flip a layout an old payload would have sniffed differently.
 */
describe("chart rail - declared renderer equals the FE shape-sniff", () => {
  const declared = Object.entries(CHART_DESCRIPTOR_OF).filter(([, d]) => d.renderer);
  it("at least one id declares a renderer (census can't go vacuous)", () => {
    expect(declared.length).toBeGreaterThan(0);
  });
  for (const [id, d] of declared) {
    it(`${id} - stamps "${d.renderer}" and the shape derivation agrees`, () => {
      const i = ALL_INDICATORS.find((x) => x.id === id);
      if (!i) throw new Error(`${id} missing from ALL_INDICATORS - census moved under the test`);
      const spec = buildFamilyChart(i, undefined);
      expect(spec.renderer).toBe(d.renderer);
      expect(rendererForSpec(spec)).toBe(d.renderer);
    });
  }
});

/**
 * `api/series.ts`'s `pointBandBranch` runs `pointBandCutSeries` only for a descriptor carrying `bandCuts`
 * and NO `branch`, and the `GATES` branch pre-empts it — so a `POINT_BAND_CUTS_OF` row without that
 * descriptor row, under a bespoke branch that ignores `bandCuts`, or on a gate id silently draws no cut.
 * Two sanctioned exceptions: `ecyJoin` reads `desc.bandCuts` itself, and F3's cuts are PERSISTED by its
 * scorer and ride `recomputedSeries`' `attachSynthBandCuts` (the `?detail=1` path) with no descriptor row.
 * A new id must pick a side here, never land in neither.
 */
describe("chart rail - every POINT_BAND_CUTS_OF id reaches a per-point-cut branch", () => {
  const PERSISTED_CUT_IDS = new Set(["F3"]);
  const BANDCUT_READING_BRANCHES = new Set(["ecyJoin"]);
  const ids = Object.keys(POINT_BAND_CUTS_OF);
  it("census can't go vacuous, and every persisted-cut exception is still a live row", () => {
    expect(ids.length).toBeGreaterThan(PERSISTED_CUT_IDS.size);
    for (const id of PERSISTED_CUT_IDS) expect(ids).toContain(id);
  });
  for (const id of PERSISTED_CUT_IDS) {
    it(`${id} - persisted-cut id: its descriptor carries no bandCuts`, () => {
      expect(CHART_DESCRIPTOR_OF[id]?.bandCuts).toBeUndefined();
    });
  }
  for (const id of ids.filter((x) => !PERSISTED_CUT_IDS.has(x))) {
    it(`${id} - its descriptor references its own row on a bandCuts-reading route`, () => {
      const d = CHART_DESCRIPTOR_OF[id];
      expect(d?.bandCuts).toBe(POINT_BAND_CUTS_OF[id]);
      expect([undefined, ...BANDCUT_READING_BRANCHES]).toContain(d?.branch);
      expect(GATES[id]).toBeUndefined();
    });
  }
});

/**
 * 2026-08-29 — the two-leg id draws BOTH legs (`SECOND_LEG_CHART_OF`). Closes the standing
 * "F13's PRIMARY leg is invisible" defect: the derived route owns one `derived` slot, so before
 * this the d20 leg had no line and no cut on the chart, and a reader watching the ms50 line dip
 * under its drawn red band saw an AMBER card with no drawable reason (RED is the AND of both legs).
 *
 * 2026-08-29 (later the same day) — the two legs were SPLIT ACROSS THE TWO AXES: d20 takes the
 * primary (the unscored ratio line is dropped), ms50 keeps the secondary. Same units, different
 * magnitudes, so one shared axis squashed the fast leg and stacked four cuts into one band.
 *
 * The falsifier is the one named in `docs/backlog.md`: on a fixture the REAL scorer calls non-GREEN
 * while the ms50 leg sits CLEAR of its amber cut, some DRAWN series must cross a DRAWN band —
 * evaluated over EVERY axis through the spec's own `compute`/`window` declaration, so it fails the
 * moment a leg's series or its cut pair leaves the spec (and is indifferent to which axis holds it).
 */
describe("chart rail - F13 draws both scorer legs (two-leg id)", () => {
  const f13 = ALL_INDICATORS.find((i) => i.id === "F13");
  if (!f13) throw new Error("F13 missing from ALL_INDICATORS - census moved under the test");
  const second = SECOND_LEG_CHART_OF.F13;
  if (!second) throw new Error("SECOND_LEG_CHART_OF.F13 missing - the declarative entry moved under the test");
  // `f13.derived` unscaled - the `?mult=` display scaling (api/indicators.ts `scaleDerived`) is
  // identity at the shipped config and touches the ms50 pair only, never the raw d20 cuts.
  const spec = buildFamilyChart(f13, f13.derived);
  const bands = spec.bands as ChartBand[];

  it("the second leg TAKES the primary axis (the price line is dropped), windowed off the descriptor", () => {
    const d20 = spec.series.filter((s) => s.compute === second.compute);
    expect(d20).toHaveLength(1);
    // Single-sourced from the descriptor via the table - a `retWindow` retune moves the line.
    expect(d20[0]!.window).toBe(HYGLQD_RET_WINDOW);
    expect(d20[0]!.axis).toBe("primary");
    // The unscored HYG/LQD ratio gives up the left axis - that IS the range separation.
    expect(spec.series.some((s) => s.fromPoint === "value")).toBe(false);
    // Left axis now reads in the leg's own units (fractions), so the FE must format it `derived`.
    const prim = spec.axes.find((a) => a.id === "primary");
    expect(prim?.unit).toBe("%");
    expect(prim?.format).toBe("derived");
    expect(spec.axes.find((a) => a.id === "secondary")?.unit).toBe("%");
  });

  it("both cut pairs are drawn, one pair per axis, each tagged by leg", () => {
    const scalar = bands.filter((b) => typeof b.value === "number");
    // The d20 pair rides the axis its LINE is on; the ms50 pair stays with the decision line.
    expect(scalar.filter((b) => b.axis === "primary").map((b) => b.value)).toEqual([
      HYGLQD_D20_AMBER,
      HYGLQD_D20_RED,
    ]);
    expect(scalar.filter((b) => b.axis === "secondary").map((b) => b.value)).toEqual([HYGLQD_AMBER, HYGLQD_RED]);
    // Every label names its leg, and no two labels collide (both pairs share one legend line).
    expect(new Set(scalar.map((b) => b.label)).size).toBe(scalar.length);
    for (const b of scalar) expect(b.label).toContain(b.level === "amber" ? "amber" : "red");
    expect(scalar.filter((b) => b.label?.includes(second.tag))).toHaveLength(2);
    expect(scalar.filter((b) => b.label?.includes(second.siblingTag))).toHaveLength(2);
  });

  it("a non-GREEN day with the ms50 leg CLEAR still crosses a drawn band (the standing falsifier)", () => {
    // The `dashboard.price-scorers.test.ts` AND-row fixture: a steep climb with a 20-day pullback,
    // so d20 is past its RED cut while ms50 stays above its own red cut. The card is AMBER.
    const PN = HYGLQD_MA + CONFIRM_CLOSES + HYGLQD_RET_WINDOW + 40;
    const hyg = Array.from({ length: PN + 1 }, (_, i) => {
      const turn = PN - 20;
      return {
        date: `d${String(i).padStart(4, "0")}`,
        value: i <= turn ? 100 * 1.004 ** i : 100 * 1.004 ** turn * 0.998 ** (i - turn),
      };
    });
    const lqd = hyg.map((o) => ({ date: o.date, value: 100 }));
    const reading = scoreCreditAppetite(f13, hyg, lqd);
    expect(reading.state).not.toBe("GREEN");

    // Evaluate every series the spec declares ON EITHER AXIS, exactly as the FE hook does:
    // `decision` is the persisted ms50, `trailingReturn` is v[i]/v[i-window] - 1 over the plotted
    // `value` (which for F13 IS the ratio). Then ask whether any drawn line is at/below a drawn cut.
    const series = creditAppetiteReadingSeries(f13, hyg, lqd);
    const last = series.at(-1)!;
    const ratio = series.map((r) => r.level);
    const drawn = spec.series.map((s) =>
      s.compute === "trailingReturn" ? ratio.at(-1)! / ratio.at(-1 - s.window!)! - 1 : last.decision!,
    );
    // The PREMISE that makes this row discriminate: the ms50 leg is clear of its own amber cut,
    // so the pre-2026-08-29 chart (ms50 line + ms50 bands only) drew NOTHING to explain the ribbon.
    expect(last.decision!).toBeGreaterThan(HYGLQD_AMBER);
    const cuts = bands.filter((b) => typeof b.value === "number").map((b) => b.value!);
    expect(drawn.some((v) => cuts.some((c) => v <= c))).toBe(true);
  });
});

/**
 * Stage-1 chart-wiring residue (2026-08-29): the two AVGO chart-only legs shipped without their
 * id→cut-line tables, so `/lab` drew no amber/red threshold lines for either. FDX is F13's two-leg
 * shape (ms50 `derived` + d20 `SECOND_LEG_CHART_OF`); HCX is F5/SPCONC's breadth shape (per-point
 * cuts via `derivedChart`). Both reach the derivedChart route only through their `derived` block —
 * the missing block was also the `decision: null` root cause. Every value is off the descriptor.
 */
describe("chart rail - FDX draws both scorer legs (F13's two-leg shape)", () => {
  const fdx = CHART_ONLY_INDICATORS.find((i) => i.id === "FDX");
  if (!fdx) throw new Error("FDX missing from CHART_ONLY_INDICATORS - census moved under the test");
  if (!fdx.derived) throw new Error("FDX lost its derived block - the maSpread decision line / route is gone");
  const second = SECOND_LEG_CHART_OF.FDX;
  if (!second) throw new Error("SECOND_LEG_CHART_OF.FDX missing - the d20 leg would go undrawn");
  const spec = buildFamilyChart(fdx, fdx.derived);
  const bands = spec.bands as ChartBand[];
  const k = FDX_DESCRIPTOR.scorer.constants;

  it("d20 takes the primary axis (ratio line dropped), ms50 the secondary - both windowed off FDX_DESCRIPTOR", () => {
    const d20 = spec.series.filter((s) => s.compute === second.compute);
    expect(d20).toHaveLength(1);
    expect(d20[0]!.window).toBe(k.retWindow);
    expect(d20[0]!.axis).toBe("primary");
    expect(spec.series.some((s) => s.fromPoint === "value")).toBe(false);
    // ms50 rides the secondary as the persisted `decision` (the maSpread derived line).
    expect(spec.series.some((s) => s.axis === "secondary" && s.fromPoint === "decision")).toBe(true);
    expect(rendererForSpec(spec)).toBe("derived");
  });

  it("both cut pairs are drawn, one pair per axis, each off the descriptor", () => {
    const scalar = bands.filter((b) => typeof b.value === "number");
    // d20 pair on the primary (its line's axis); ms50 pair on the secondary (the decision line).
    expect(scalar.filter((b) => b.axis === "primary").map((b) => b.value)).toEqual([k.d20Amber, k.d20Red]);
    expect(scalar.filter((b) => b.axis === "secondary").map((b) => b.value)).toEqual([k.amber, k.red]);
    // Every band names its leg; the two pairs never collide on one legend line.
    expect(new Set(scalar.map((b) => b.label)).size).toBe(scalar.length);
    expect(scalar.filter((b) => b.label?.includes(second.tag))).toHaveLength(2);
    expect(scalar.filter((b) => b.label?.includes(second.siblingTag))).toHaveLength(2);
  });
});

describe("chart rail - HCX draws its per-point breadth cuts (F5/SPCONC's shape, LOW twin)", () => {
  const hcx = CHART_ONLY_INDICATORS.find((i) => i.id === "HCX");
  if (!hcx) throw new Error("HCX missing from CHART_ONLY_INDICATORS - census moved under the test");
  if (!hcx.derived) throw new Error("HCX lost its derived block - the highDist route / decision line is gone");
  const spec = buildFamilyChart(hcx, hcx.derived);
  const bands = spec.bands as ChartBand[];
  const cuts = POINT_BAND_CUTS_OF.HCX!;

  it("emits both moving breadth cuts on the primary axis, keyed + p off HCX_BAND", () => {
    expect(cuts.length).toBe(2);
    const perPoint = bands.filter((b) => b.source === "perPoint");
    expect(perPoint.map((b) => b.fromPoint)).toEqual(["breadthAmber", "breadthRed"]);
    expect(perPoint.every((b) => b.axis === "primary")).toBe(true);
    // Single-sourced: the drawn cuts ARE the HCX_BAND percentiles, never restated in the map.
    expect(cuts.map((c) => c.p)).toEqual([HCX_BAND.amberP, HCX_BAND.redP]);
    // LOW twin: the labels read `<p` (the mirrored side), not F5/SPCONC's `>p`.
    expect(perPoint.every((b) => b.label?.includes("<p"))).toBe(true);
  });
});

/**
 * F3 (NFCIRISK) — Stage 1: the four synth legs' cuts are MOVING, so the chart draws them as
 * `source:"perPoint"` lines off `bandCuts` (level pair primary, velocity amber secondary) instead of
 * the static `threshold`/`legBands` pair that froze at the dead PRIORS fallback. Velocity RED is
 * dropped — F3's prior defines no `redVelocity`, so no value exists for a red velocity line.
 */
describe("chart rail - F3 moving synth cut bands (Stage 1)", () => {
  const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
  if (!f3) throw new Error("F3 missing from ALL_INDICATORS - census moved under the test");
  const spec = buildFamilyChart(f3, undefined);
  const bands = Array.isArray(spec.bands) ? spec.bands : [];

  it("has ZERO source:'threshold' bands — every band is a moving perPoint cut that resolves to a series", () => {
    expect(bands.length).toBeGreaterThan(0); // vacuity floor
    expect(bands.filter((b) => b.source === "threshold")).toEqual([]);
    // Every band is perPoint and resolves to a series: it carries a fromPoint (drawn off point.bandCuts).
    const perPoint = bands.filter((b) => b.source === "perPoint");
    expect(perPoint).toEqual(bands);
    for (const b of perPoint) expect(typeof b.fromPoint).toBe("string");
    // Level pair on the primary axis — keys single-sourced from POINT_BAND_CUTS_OF.F3 (a rename moves this).
    const f3cuts = POINT_BAND_CUTS_OF.F3!;
    expect(f3cuts.length).toBe(2);
    const prim = bands.filter((b) => b.source === "perPoint" && b.axis === "primary");
    expect(prim.map((b) => b.fromPoint)).toEqual(f3cuts.map((c) => c.key));
    // Velocity AMBER on the secondary axis (F3_VELOCITY_BAND), and NO red velocity twin (dropped).
    const sec = bands.filter((b) => b.axis === "secondary");
    expect(sec.map((b) => [b.fromPoint, b.level])).toEqual([[F3_VELOCITY_BAND.key, F3_VELOCITY_BAND.level]]);
    expect(sec.some((b) => b.level === "red")).toBe(false);
    // legBands is gone — perPoint bands never swap in the eff composite.
    expect(spec.legBands).toBeUndefined();
  });
});

describe("chart rail - dualAxis.refSigma", () => {
  it("a refSigma on a non-σ id throws — the API emits no σ key there, so the line would be silently absent", () => {
    const r4 = ALL_INDICATORS.find((x) => x.id === "R4")!;
    expect(r4.thresholds.velocitySigma, "premise: R4 is not a σ id").toBeUndefined();
    expect(() => dualAxisChart(r4, { dualAxis: { unit: "%", compute: "storedDelta", refSigma: 1 } })).toThrow(
      /needs thresholds\.velocitySigma/,
    );
  });
});

describe("chart rail - EXSH_GATE MA overlays", () => {
  it("draw the scorer's own MA windows (the overlays ARE its MA50/MA200 crosses)", () => {
    const { maShortWindow, trendWindow } = EXSH_GATE_DESCRIPTOR.scorer.constants;
    expect(MA_OVERLAYS.EXSH_GATE!.map((o) => MA_OVERLAY_WINDOW[o.compute])).toEqual([maShortWindow, trendWindow]);
  });
});

describe("chart rail - TOGGLE_OVERLAYS (Value XDEV)", () => {
  const c = XDEV_GATE_DESCRIPTOR.scorer.constants;
  it("single-layout ids, or derived ones with toggle series only (genericDerived has no fit axis); zone scales = 1 − the descriptor cut", () => {
    for (const [id, o] of Object.entries(TOGGLE_OVERLAYS)) {
      const i = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].find((x) => x.id === id)!;
      const renderer = buildFamilyChart(i, i.derived).renderer;
      expect(["single", "derived"], id).toContain(renderer);
      for (const s of o.series) expect((s.toggle === true && !(renderer === "derived" && s.fit)) || (s.fit === true && renderer === "single"), `${id} ${s.compute}`).toBe(true);
    }
    const zones = TOGGLE_OVERLAYS.XDEV!.series.filter((s) => s.cut && s.compute === "high60").map((s) => s.scale);
    expect(zones).toEqual([1 - c.zoneOpen, 1 - c.zoneT2, 1 - c.zoneT3]);
  });
  it("EU-Fin EXSH: RV20 (fit, the probe's RV_SLOW_N) + MA50 + MA200 (toggle), four distinct hues with RV10; lead covers MA200", () => {
    const i = ALL_INDICATORS.find((x) => x.id === "LEGP_EUFIN")!;
    const spec = buildFamilyChart(i, i.derived);
    const trend = spec.series.filter((s) => s.fit || s.toggle);
    expect(trend.map((s) => [s.compute, s.tone ?? "trend"])).toEqual([["rv10", "trend"], ["rv20", "cyan"], ["ma50", "white"], ["ma200", "alt"]]);
    expect(spec.lead).toBe(MA_OVERLAY_WINDOW.ma200);
  });
  it("HY spreads (F1/CCC): one orange (alt) toggle MA200 on the primary scale beside the Δ5 fit line; lead covers MA200", () => {
    for (const id of ["F1", "CCC"]) {
      const i = ALL_INDICATORS.find((x) => x.id === id)!;
      const spec = buildFamilyChart(i, i.derived);
      expect(spec.series.filter((s) => s.toggle).map((s) => [s.axis, s.compute, s.tone ?? "trend"]), id).toEqual([["primary", "ma200", "alt"]]);
      expect(spec.lead, id).toBeGreaterThanOrEqual(MA_OVERLAY_WINDOW.ma200);
    }
  });
  it("MU (F8): a toggled white MA50 beside the always-on orange (alt) MA200 gate line; lead covers MA200", () => {
    const i = ALL_INDICATORS.find((x) => x.id === "F8")!;
    const spec = buildFamilyChart(i, i.derived);
    const ma = spec.series.filter((s) => s.compute === "ma50" || s.compute === "ma200");
    expect(ma.map((s) => [s.axis, s.compute, s.tone, s.toggle === true, s.readout === true])).toEqual([
      ["primary", "ma200", "alt", false, false],
      ["primary", "ma50", "white", true, true],
    ]);
    expect(spec.lead).toBeGreaterThanOrEqual(MA_OVERLAY_WINDOW.ma200);
  });
  it("MOVE (R6) + VXSMH: exactly one toggled MOVE_MEDIAN / VOL_MEDIAN median line on the primary scale; lead covers its window", () => {
    for (const [id, m] of [["R6", MOVE_MEDIAN], ["VXSMH", VOL_MEDIAN]] as const) {
      const i = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].find((x) => x.id === id)!;
      const spec = buildFamilyChart(i, i.derived);
      const med = spec.series.filter((s) => s.compute === "median");
      expect(med.map((s) => [s.axis, s.window, s.scale, s.toggle === true]), id).toEqual([["primary", m.window, m.mult, true]]);
      expect(spec.lead, id).toBeGreaterThanOrEqual(m.window);
    }
  });
  it("lead covers high60, the veto σ window and RV10 — and buildFamilyChart carries it", () => {
    expect(TOGGLE_OVERLAYS.XDEV!.lead).toBe(Math.max(MA_OVERLAY_WINDOW.high60, c.sigmaWindow + c.vetoWindow));
    const xdev = ALL_INDICATORS.find((x) => x.id === "XDEV")!;
    expect(buildFamilyChart(xdev, xdev.derived).lead).toBe(Math.max(TOGGLE_OVERLAYS.XDEV!.lead, RV10_WINDOW));
  });
});

describe("chart rail - DELTA5_OVERLAY", () => {
  it("the spec carries exactly one Δ5 fit series on exactly the opted-in ids", () => {
    for (const i of ALL_INDICATORS) {
      const spec = buildFamilyChart(i, i.derived);
      const d5 = spec.series.filter((s) => s.window === DELTA5_WINDOW && s.style === "trend");
      expect(d5.length, i.id).toBe(DELTA5_OVERLAY.has(i.id) ? 1 : 0);
      if (!d5.length) continue;
      // Only `genericSingle` splits `fit` out — any other layout would draw it on the primary scale.
      expect(spec.renderer, i.id).toBe("single");
      expect(d5[0]!.fit, i.id).toBe(true);
      // A level Δ on every id — a relative-mode speed leg included, so it reads in the re-entry rules' units.
      expect(d5[0]!.compute, i.id).toBe("delta");
    }
  });
});

describe("chart rail - RV10_OVERLAY", () => {
  it("exactly the opted-in ids carry one id-agnostic RV10 fit line (window = the descriptor rvWindow) on a single layout", () => {
    expect(RV10_WINDOW).toBe(XDEV_GATE_DESCRIPTOR.scorer.constants.rvWindow);
    for (const i of ALL_INDICATORS) {
      const spec = buildFamilyChart(i, i.derived);
      const rv = spec.series.filter((s) => s.compute === "rv10");
      expect(rv.length, i.id).toBe(RV10_OVERLAY.has(i.id) ? 1 : 0);
      if (!rv.length) continue;
      expect(rv[0], i.id).toEqual({ axis: "primary", compute: "rv10", style: "trend", label: `RV${RV10_WINDOW}`, fit: true });
      expect(spec.renderer, i.id).toBe("single");
      expect(spec.lead ?? 0, i.id).toBeGreaterThanOrEqual(RV10_WINDOW);
    }
  });
});

/**
 * Characterization pin for `genericThresholdChart`'s LEVEL branch (ai-debt sweep 5.6): the full
 * spec over a variant matrix of the raw-carrier fixture (rung / drawdown leg / gate-window / knob
 * fold / smoothed-row arms, per-side level pairs, the `short leg` caption fallback) plus every live
 * id that ships a registry level pair. Pins output, not intent — the named-assertion suites above
 * carry the why.
 */
describe("chart rail - level-branch characterization (sweep 5.6)", () => {
  const r = RAW_CARRIER;
  const PI = r.postInversionCooldown!;
  const DD = r.drawdownLeg!;
  const variants: Record<string, Indicator> = {
    raw: r,
    rungless: { ...r, postInversionCooldown: undefined },
    ddless: { ...r, drawdownLeg: undefined },
    bare: { ...r, postInversionCooldown: undefined, drawdownLeg: undefined },
    diverged: { ...r, drawdownLeg: { ...DD, gateBp: DD.gateBp * 2 } },
    offWindow: { ...r, drawdownLeg: { ...DD, gateWindow: DD.gateWindow + 1 } },
    levelCuts: {
      ...r,
      postInversionCooldown: { ...PI, levelCuts: { amber: { pctile: 0.1, clamp: [0, 1] }, red: { pctile: 0.05, clamp: [-1, 0] } } },
    },
    amberOnly: { ...r, thresholds: { ...r.thresholds, redLevel: undefined } },
    redOnly: { ...r, thresholds: { ...r.thresholds, amberLevel: undefined } },
    smoothedRedWindowWithDd: { ...r, id: "R1" },
  };

  it.each(Object.keys(variants))("fixture variant %s", (k) => {
    expect(buildFamilyChart(variants[k]!, undefined)).toMatchSnapshot();
  });

  it("fixture variant smoothedNoRedWindow (R8's row shape on the generic route)", () => {
    // The only live plain-smoothed id (R8) takes its own builder, so the arm is reached by lending the
    // fixture id R8's row for this one call — restored in `finally` so no other test sees it.
    const rows = SMOOTHED_LEVEL_OF as Record<string, { window: number; redWindow?: number }>;
    if (rows[r.id]) throw new Error(`fixture id ${r.id} must carry no smoothed row`);
    rows[r.id] = { ...rows.R8! };
    try {
      expect(buildFamilyChart(r, undefined)).toMatchSnapshot();
    } finally {
      delete rows[r.id];
    }
  });

  it("every live id with a registry level pair", () => {
    const out: Record<string, unknown> = {};
    for (const i of ALL_INDICATORS) {
      if (i.thresholds?.amberLevel == null && i.thresholds?.redLevel == null) continue;
      out[i.id] = buildFamilyChart(i, i.derived);
    }
    expect(Object.keys(out).length, "premise: the sweep reaches live level ids").toBeGreaterThan(0);
    expect(out).toMatchSnapshot();
  });
});
