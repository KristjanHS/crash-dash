// Case 1 Stage 3 — smoke test for the spec-driven `genericDetailChart`.
//
// Drives the NEW generic renderer on one fixture per chart category, building a
// realistic `meta.chart` from the REAL api/indicators chart-spec builder
// (`buildIndicatorChart` over `ALL_INDICATORS`) so the spec shape matches
// production. This stage only proves each category RENDERS — a non-empty `svg`
// string + a well-formed `detail` seam.
//
// Plain `.js` (like detail-chart.test.js) so vitest collects it while tsc skips it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { genericDetailChart, SERIES_HOOKS, MA_WINDOWS, HIGH_WINDOWS } from "./detail-chart.js";
import { MA_OVERLAY_WINDOW, DELTA5_WINDOW } from "../src/chart-rail.ts";
import { XDEV_GATE_DESCRIPTOR } from "../src/family-descriptor-rows.ts";
import { formatDerived, formatValue } from "./chart-primitives.js";
import { expectValid } from "./chart-test-helpers.js";
import { CH, LONG_WINDOW, plotW, plotH } from "./chart-primitives.js";
import { ALL_INDICATORS } from "../src/registry.ts";
// DB_SMH is a GLOBAL-channel detector: off ALL_INDICATORS, so it comes from its own registry row.
import { DB_SMH } from "../src/registry-price.ts";
import { estimateSlot } from "../src/estimate-slot.ts";
import { buildIndicatorChart } from "../api/indicators.ts";
import { wireFitToggle, SHOW_FIT_CLASS } from "./fit-toggle.js";

/** Lazy memo: a pure render shared by the tests of one describe, computed on first use. */
const once = (f) => {
  let v;
  return () => (v ??= f());
};

const byId = (id) => {
  const i = ALL_INDICATORS.find((x) => x.id === id);
  if (!i) throw new Error(`fixture indicator ${id} not found in ALL_INDICATORS`);
  return i;
};

// Build a meta with the REAL chart spec + the top-level fields the renderer reads
// (id/label/unit/cadence/thresholds). `extra` overrides per case.
const metaFor = (id, extra = {}) => {
  const i = byId(id);
  return {
    id: i.id,
    label: i.label,
    unit: i.unit ?? "%",
    cadence: i.cadence,
    thresholds: i.thresholds,
    chart: buildIndicatorChart(i),
    ...extra,
  };
};

/** The describes below count `class="band"` lines to assert PRIMARY-axis off-range/stagger
 *  behaviour, so they need a carrier whose spec ships a full amber+red LEVEL pair and nothing else
 *  drawable — F2 since 2026-08-30, when R1 retired its `amberLevel` and its spec stopped emitting
 *  an amber threshold band (it also carries a second axis whose bounds draw as band lines).
 *  `primaryAxisOnly` keeps stripping any secondary half so a carrier that gains one still lands
 *  here. Derived from the live spec (never a hand-written one), so a primary-axis change still
 *  reaches them. R1's own bands are pinned in `chart-rail.test.ts` + `detail-chart.test.js`. */
const primaryAxisOnly = (id, extra = {}) => {
  const m = metaFor(id, extra);
  const c = m.chart;
  return {
    ...m,
    chart: {
      ...c,
      axes: c.axes.filter((a) => a.id !== "secondary"),
      series: c.series.filter((x) => x.axis !== "secondary"),
      bands: c.bands === "context-only" ? c.bands : c.bands.filter((b) => b.axis !== "secondary"),
    },
  };
};

const pt = (date, value, state, x = {}) => ({ date, value, state, ...x });

// The shared { svg, detail } render contract (`expectValid`) now lives in
// ./chart-test-helpers.js — imported above and reused by detail-chart.test.js's
// per-id ALL_INDICATORS render loop, which subsumes the former "one fixture per
// chart category (renders)" describe (every id now gets a real render-contract
// assert there; the per-category `toContain` substrings it added were low-signal).

// Case 5 — pending-confirmation hatch: a point whose rawState ≠ state renders a
// diagonal-hatch overlay (raw state's color pattern) over the confirmed cell,
// plus the pattern defs and a legend note; a fully-confirmed window emits none.
describe("genericDetailChart - pending-confirmation hatch (Case 5)", () => {
  const meta = () => metaFor("R1", { thresholds: { amberLevel: 0.5, redLevel: 0.0 } });

  it("hatches the rawState≠state window with the RAW state's pattern", () => {
    const pts = [
      pt("2026-01-02", 0.82, "GREEN"),
      pt("2026-01-03", 0.44, "GREEN", { rawState: "AMBER" }), // breached, awaiting confirm
      pt("2026-01-04", 0.41, "AMBER", { rawState: "AMBER" }), // confirmed — no hatch
    ];
    const r = genericDetailChart(meta(), pts, {});
    expect(r.svg).toContain('<pattern id="pend-AMBER"');
    expect(r.svg.match(/url\(#pend-AMBER\)/g)).toHaveLength(1); // only the pending cell
    // The copy names the ROW's own close, never a live buffer depth: new rows diverge on
    // stand-down closes (directional fold, 2026-08-26) and stored pre-IS-5 history still can too.
    // #8 (caption redesign 2026-09-13): the hatch explainer is HOVER-ONLY — present in the
    // hatched cell's <title>, absent from the caption (and everywhere else in the markup).
    expect(r.svg).toMatch(/<title>[^<]*\(raw AMBER, unconfirmed on this close\)/);
    expect(r.svg).not.toContain("hatch =");
    expect(r.svg).not.toContain("2-close");
  });

  it("emits no defs/overlay/legend when raw and confirmed states agree", () => {
    const pts = [pt("2026-01-02", 0.82, "GREEN", { rawState: "GREEN" }), pt("2026-01-03", 0.8, "GREEN")];
    const r = genericDetailChart(meta(), pts, {});
    expect(r.svg).not.toContain("pend-");
    expect(r.svg).not.toContain("hatch =");
  });
});

// F1 lowRise credit-leg hook: the whole-array
// SERIES_HOOK computes v[i] − min(window ending at i), gapping below the window and across a null.
// The window rides the series (`s.window`), mirroring scorers-core.ts derivedValue("lowRise").
describe("SERIES_HOOKS.lowRise - rise from the trailing low", () => {
  const arr = (values, window) => SERIES_HOOKS.lowRise(values.map((v) => ({ value: v })), { window });

  it("computes v[i] − min(inclusive window) and gaps the first window−1 indices", () => {
    // window 3: i<2 → gap; i=2 min(10,8,12)=8→4; i=3 min(8,12,9)=8→1; i=4 min(12,9,7)=7→0.
    expect(arr([10, 8, 12, 9, 7], 3)).toEqual([null, null, 4, 1, 0]);
  });

  it("gaps every index whose inclusive window touches a null value", () => {
    // window 3, null at index 1: the windows ending at 2 and 3 include it ⇒ gap; the window ending at
    // 4 (indices 2,3,4 = 12,9,7) clears it ⇒ 7 − 7 = 0. Proves the gap tracks the window, not the row.
    expect(arr([10, null, 12, 9, 7], 3)).toEqual([null, null, null, null, 0]);
  });

  it("returns all-gap when the series carries no usable window (nothing to draw)", () => {
    expect(SERIES_HOOKS.lowRise([{ value: 5 }, { value: 6 }], {})).toEqual([null, null]);
  });
});

// Case 4 — gate-aware decision line: a compound-rule id's spec (real builder) carries
// `gates` + `gatedBy` on the decision series; the renderer draws the line undimmed and
// carries the gate as information only — the rule in the legend, "gate off" in the hover
// readout (the f4GateNote replacement). Keyed off the contract — the F8/F4 metas below
// differ only in spec.
describe("genericDetailChart - gate-aware decision line (Case 4)", () => {
  it("F8: readout + legend carry the gate info, never the dim/dashed mark", () => {
    const meta = metaFor("F8");
    const pts = [
      pt("2026-01-02", 100, "GREEN", { decision: -0.02, gates: { belowMA200: false } }),
      // ret6 crosses the amber band here but the gate is OFF — the very confusion Case 4 renders.
      pt("2026-01-03", 96, "GREEN", { decision: -0.1, gates: { belowMA200: false } }),
      pt("2026-01-04", 92, "AMBER", { decision: -0.12, gates: { belowMA200: true } }),
      pt("2026-01-05", 90, "AMBER", { decision: -0.13, gates: { belowMA200: true } }),
    ];
    const r = genericDetailChart(meta, pts, {});
    expectValid(r, 4);
    expect(r.svg).toContain('class="line-derived"');
    // The gate INFO is retained (informational): the rule, a legend clause pointing at the hover
    // "gate off" readout, and the readout itself stay — but the legend must NOT describe the
    // dim/dashed mark this renderer no longer draws.
    expect(r.svg).toContain("also requires MU below its 200-day MA");
    expect(r.svg).toContain("hover reads “gate off” where no gate is active");
    expect(r.svg).not.toContain("dim/dashed");
    expect(r.detail.samples[0].readout).toContain("gate off");
    expect(r.detail.samples[2].readout).not.toContain("gate off");
  });

  it("F8: the MA200 overlay is drawn at the gate's +10% line and the legend says so", () => {
    const meta = metaFor("F8");
    // The spec's trend series carries the server-derived scale + label (single-sourced from
    // MU_MA_MULT) — the line the reader sees IS the condition the ribbon is scored against.
    const trend = meta.chart.series.find((x) => x.compute === "ma200");
    expect(trend.scale).toBeCloseTo(1.1, 10);
    // 200 points so the overlay's window is warm, flat at 100 ⇒ MA200 = 100 ⇒ line at 110. The MA is
    // computed over the full array (the lead buffer); a 20-point user window keeps the render cheap.
    const pts = Array.from({ length: 201 }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 100, "GREEN", { decision: 0.5 }));
    const r = genericDetailChart(meta, pts, {}, CH, 20);
    // The legend is HTML-escaped at the seam, so the apostrophe arrives as an entity.
    expect(r.svg).toContain("MU&#39;s 200-day MA +10% (left, orange long-dashed)");
    expect(r.detail.samples.at(-1).readout).toContain("MU's 200-day MA +10% 110");
  });

  it("F8: the white MA50 sits in the hidden `.fit-lines` group behind one `.fit-toggle` key; the orange MA200 gate line stays outside", () => {
    const meta = metaFor("F8");
    const len = MA_OVERLAY_WINDOW.ma200 + 20;
    const pts = Array.from({ length: len }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 100 + i, "GREEN", { decision: 0.05 }));
    const r = genericDetailChart(meta, pts, {}, CH, 20);
    const group = r.svg.match(/<g class="fit-lines">([\s\S]*?)<\/g>/)?.[1] ?? "";
    expect(group).toMatch(/<path class="line-toggle" [^>]*stroke="var\(--trend-line-white\)"/);
    expect(group).not.toContain("var(--trend-line-2)");
    expect(r.svg.replace(group, "")).toMatch(/<path class="line-trend" [^>]*stroke="var\(--trend-line-2\)"/);
    expect(r.svg).toContain(`<span title="${MA_OVERLAY_WINDOW.ma50}-day MA (white)"><button class="fit-toggle tog-key" type="button">${MA_OVERLAY_WINDOW.ma50}-day MA</button></span>`);
    const last = r.detail.samples.at(-1);
    expect(last.readout).toContain(`${MA_OVERLAY_WINDOW.ma50}-day MA ${formatValue(100 + (len - 1) - (MA_OVERLAY_WINDOW.ma50 - 1) / 2, meta.unit)}`);
    expect(last.fitYs).toHaveLength(1);
  });

  it("EXSH_GATE: MA50 white + MA200 orange on the price axis, decision line blue, all three named in the legend", () => {
    const meta = metaFor("EXSH_GATE");
    const trends = meta.chart.series.filter((x) => x.style === "trend");
    expect(trends.map((x) => x.compute)).toEqual(["ma50", "ma200"]);
    expect(trends.every((x) => x.axis === "primary")).toBe(true);
    // The lead buffer covers the LONGER window, so MA200 is defined at the visible left edge.
    expect(meta.chart.lead).toBe(Math.max(...Object.values(MA_OVERLAY_WINDOW)));
    // A rising line ⇒ the two means differ (MA50 sits above MA200), so both draw distinctly.
    const len = MA_OVERLAY_WINDOW.ma200 + 20;
    const pts = Array.from({ length: len }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 100 + i, "GREEN", { decision: 0.05 }));
    // A 20-point user window draws only the warm tail; both MAs still compute over the full lead.
    const r = genericDetailChart(meta, pts, {}, CH, 20);
    const strokes = [...r.svg.matchAll(/<path class="line-trend"[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
    expect(strokes).toEqual(["var(--trend-line-white)", "var(--trend-line-2)"]);
    expect(r.svg).toContain(`${MA_OVERLAY_WINDOW.ma50}-day MA (left, white dashed)`);
    expect(r.svg).toContain(`${MA_OVERLAY_WINDOW.ma200}-day MA (left, orange dashed)`);
    // The decision line (close % vs MA200) takes the blue no trend line on this chart uses, named in the legend.
    expect(r.svg).toMatch(/<path class="line-derived" [^>]*stroke="var\(--trend-line\)"/);
    expect(r.svg).toMatch(/\(right, blue dashed\)/);
    // Hover reads BOTH means at the last point, computed off the fixture (mean of the trailing w closes).
    const meanLast = (w) => 100 + (len - 1) - (w - 1) / 2;
    const last = r.detail.samples.at(-1).readout;
    expect(last).toContain(`${MA_OVERLAY_WINDOW.ma50}-day MA ${meanLast(MA_OVERLAY_WINDOW.ma50)}`);
    expect(last).toContain(`${MA_OVERLAY_WINDOW.ma200}-day MA ${meanLast(MA_OVERLAY_WINDOW.ma200)}`);
  });

  it("AT1: MA200 on the ratio axis in the trend hue, distinct from the ratio and %-vs-MA50 strokes", () => {
    const meta = metaFor("AT1");
    const trends = meta.chart.series.filter((x) => x.style === "trend");
    expect(trends.map((x) => x.compute)).toEqual(["ma200"]);
    expect(trends[0].axis).toBe("primary");
    expect(meta.chart.lead).toBe(MA_OVERLAY_WINDOW.ma200);
    const len = MA_OVERLAY_WINDOW.ma200 + 20;
    const pts = Array.from({ length: len }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 1 + i / 1000, "GREEN", { decision: 0.01 }));
    const r = genericDetailChart(meta, pts, {}, CH, 20); // 20-point user window: every drawn sample is warm
    const strokes = [...r.svg.matchAll(/<path class="line-trend"[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
    expect(strokes).toEqual(["var(--trend-line)"]); // AT1's MA200 stays blue (EXSH_GATE's tones are per-id)
    expect(r.svg).toMatch(/<path class="line" [^>]*stroke="var\(--ink\)"/);
    expect(r.svg).toMatch(/<path class="line-derived" [^>]*stroke="var\(--ink-dim\)"/);
    expect(r.svg).toContain(`${MA_OVERLAY_WINDOW.ma200}-day MA`);
    // The crosshair chip carries the MA200 too (the hover bar's readout already did).
    const last = r.detail.samples.at(-1);
    const ma = last.readout.match(new RegExp(`${MA_OVERLAY_WINDOW.ma200}-day MA ([^ ]+)`))[1];
    expect(last.chip).toContain(`MA${MA_OVERLAY_WINDOW.ma200} ${ma}`);
  });

  it("AT1: a cold sample (MA200 window not yet full) carries no MA tag on its chip", () => {
    // Own short fixture: 20 points never fill the 200-obs window, so the first sample is cold.
    const pts = Array.from({ length: 20 }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 1 + i / 1000, "GREEN", { decision: 0.01 }));
    const r = genericDetailChart(metaFor("AT1"), pts, {});
    expect(r.detail.samples[0].chip).not.toContain("MA");
  });

  it("MA_WINDOWS (client mirror) matches the server's MA_OVERLAY_WINDOW, and ma50 is that window's mean", () => {
    expect({ ...MA_WINDOWS, ...HIGH_WINDOWS }).toEqual(MA_OVERLAY_WINDOW);
    const w = MA_OVERLAY_WINDOW.ma50;
    const ma = SERIES_HOOKS.ma50(Array.from({ length: w + 5 }, (_, i) => ({ value: i })));
    expect(ma[w - 2]).toBeNull();
    expect(ma[w - 1]).toBeCloseTo((w - 1) / 2, 10);
  });

  it("F4 two-gate OR: readout flags only the both-off window; both rules in the legend", () => {
    const meta = metaFor("F4");
    const pts = [
      pt("2026-01-02", 260, "GREEN", { decision: -0.01, gates: { smhBelowMA200: false, nvdaBelowMA200: true } }),
      pt("2026-01-03", 250, "GREEN", { decision: -0.05, gates: { smhBelowMA200: false, nvdaBelowMA200: false } }),
      pt("2026-01-04", 240, "GREEN", { decision: -0.09, gates: { smhBelowMA200: false, nvdaBelowMA200: false } }),
      pt("2026-01-05", 230, "AMBER", { decision: -0.16, gates: { smhBelowMA200: true, nvdaBelowMA200: false } }),
    ];
    const r = genericDetailChart(meta, pts, {});
    expectValid(r, 4);
    // The `on`/anyOff computation is retained: the both-off middle window still reads "gate off"
    // in the hover readout, any-gate-on points do not.
    expect(r.detail.samples[0].readout).not.toContain("gate off");
    expect(r.detail.samples[1].readout).toContain("gate off");
    expect(r.detail.samples[3].readout).not.toContain("gate off");
    expect(r.svg).toContain("amber also requires SMH below its 200-day MA");
    expect(r.svg).toContain("red also requires NVDA below its 200-day MA");
  });

  it("partially-unknown gates never dim: a point carrying only the cross flag draws normally", () => {
    const meta = metaFor("F4");
    // Emission-side reality (api/series.ts gatedSeries): keys resolve independently, so a
    // point can carry the cross flag while the own flag's MA window is uncovered (omitted).
    // A missing listed key is UNKNOWN — potentially on — so even a false cross flag alone
    // must not grey the line; only the fully-resolved both-false point dims.
    const pts = [
      pt("2026-01-02", 260, "GREEN", { decision: -0.01, gates: { nvdaBelowMA200: false } }),
      pt("2026-01-03", 250, "GREEN", { decision: -0.05, gates: { smhBelowMA200: false } }),
      pt("2026-01-04", 240, "GREEN", { decision: -0.09, gates: { smhBelowMA200: false, nvdaBelowMA200: false } }),
      pt("2026-01-05", 230, "GREEN", { decision: -0.11, gates: { smhBelowMA200: false, nvdaBelowMA200: false } }),
    ];
    const r = genericDetailChart(meta, pts, {});
    expectValid(r, 4);
    expect(r.detail.samples[0].readout).not.toContain("gate off");
    expect(r.detail.samples[1].readout).not.toContain("gate off");
    // Vacuity guard: the same false flags, fully resolved, DO dim.
    expect(r.detail.samples[2].readout).toContain("gate off");
    expect(r.detail.samples[3].readout).toContain("gate off");
  });

  it("old payload without per-point gates never reads “gate off” (unknown ≠ off)", () => {
    const meta = metaFor("F8");
    const pts = [pt("2026-01-02", 96, "GREEN", { decision: -0.1 }), pt("2026-01-03", 95, "GREEN", { decision: -0.11 })];
    const r = genericDetailChart(meta, pts, {});
    expect(r.detail.samples.every((s) => !s.readout.includes("gate off"))).toBe(true);
  });
});

// `chartTitle` (detail-chart.js) composes the chart's accessible title and is module-private BY
// DESIGN: pin the RENDERED `<svg aria-label>` (`chartOpen` in chart-primitives.js emits
// `aria-label="${esc(label)}"`; the renderer returns an SVG STRING, so no jsdom), not an exported
// helper. Expectations derive from the registry row, never hand-typed labels. The degraded case: a
// label-less meta must fall back to the id, not render the string "undefined".
describe("genericDetailChart - the chart's accessible title (Addendum D3)", () => {
  const ariaLabel = (svg) => svg.match(/aria-label="([^"]*)"/)?.[1];
  const pts = [pt("2026-01-02", 3.1, "GREEN"), pt("2026-01-03", 3.2, "GREEN")];
  const render = (id, extra) => ariaLabel(genericDetailChart(metaFor(id, extra), pts, {}).svg);

  it("a meta with no label degrades to the id - never the string \"undefined\"", () => {
    // The exact pin carries BOTH claims the hardening owes, so neither gets its own assertion: a
    // `not.toContain("undefined")` / `not.toContain("(")` after this line could never red
    // independently (a failed expect throws, so they run only once `title` is already "F1 history"),
    // and testing-project.md rules such a companion out — fold the rationale into the exact pin instead.
    // "F1 history" states it: the id is the fallback NAME (no "undefined"), and with no label there
    // is no distinct id segment left to append (no parens).
    expect(render("F1", { label: undefined })).toBe(`${byId("F1").id} history`);
  });

  it("an id that ADDS information renders beside the label (the contrast case)", () => {
    const i = byId("F1"); // label "HY OAS" ≠ id "F1" ⇒ idIfDistinct keeps the id
    expect(render("F1")).toBe(`${i.label} (${i.id}) history`);
  });

  it("an id that merely RESTATES the label is dropped (Rule 2 / C-b-1)", () => {
    const i = byId("OVX"); // label === id ⇒ idIfDistinct returns ""
    expect(render("OVX")).toBe(`${i.label} history`);
  });
});

// ---------------------------------------------------------------------------
// E1 batch, Stage 2 — client chart machinery (windowed compute hook + non-decision
// secondary axis in the single-layout). GUARDED: no server spec emits window/lead/
// roc30 yet, so these drive SYNTHETIC specs. Every EXISTING id's render contract lives in
// detail-chart.test.js's per-id render loop.
// ---------------------------------------------------------------------------

describe("SERIES_HOOKS.roc30 - 30-day rate-of-change compute hook (E1 Stage 2)", () => {
  it("nulls the first 30 indices, computes v[i]−v[i−30] after, propagates null gaps", () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, value: i * 2 }));
    pts[3].value = null; // a null in the value series (the i−30 partner of index 33)
    pts[35].value = null; // a null at the point's OWN index
    const roc = SERIES_HOOKS.roc30(pts);
    // First 30 indices have no 30-back partner ⇒ null.
    for (let i = 0; i < 30; i++) expect(roc[i]).toBeNull();
    // v[i] − v[i−30] once a partner exists.
    expect(roc[30]).toBe(pts[30].value - pts[0].value); // 60 − 0
    expect(roc[31]).toBe(pts[31].value - pts[1].value); // 62 − 2
    expect(roc[34]).toBe(pts[34].value - pts[4].value); // 68 − 8 (both defined)
    // Null on EITHER endpoint ⇒ the ROC gap propagates.
    expect(roc[33]).toBeNull(); // partner pts[3].value is null
    expect(roc[35]).toBeNull(); // the point's own value is null
  });
});

describe("SERIES_HOOKS.ma200 - 200-obs trailing-mean overlay (the belowMA gates' own line)", () => {
  it("nulls until the window is full, then equals the trailing 200-obs mean; any null in the window voids it", () => {
    const pts = Array.from({ length: 210 }, (_, i) => ({ date: `d${i}`, value: i }));
    const ma = SERIES_HOOKS.ma200(pts);
    // Index 198 has only 199 observations behind it — an incomplete mean would read as a real level.
    expect(ma[198]).toBeNull();
    // First full window: mean(0..199) = 99.5. Derived from the fixture, not a typed constant.
    expect(ma[199]).toBeCloseTo((0 + 199) / 2, 10);
    expect(ma[209]).toBeCloseTo((10 + 209) / 2, 10);
    // A null anywhere in the window voids the mean, and only for the windows containing it.
    const gapped = pts.map((p, i) => (i === 205 ? { ...p, value: null } : p));
    const maGap = SERIES_HOOKS.ma200(gapped);
    expect(maGap[205]).toBeNull();
    expect(maGap[209]).toBeNull(); // 205 is still inside the 200-obs window
    expect(maGap[204]).toBeCloseTo((5 + 204) / 2, 10); // window ends before the gap
  });
});

// A synthetic single-layout spec carrying a NON-decision (roc30) secondary series +
// a window/lead override — the shape Stage 3 will emit for F1. Primary keeps its
// threshold cuts; the secondary rides axis-2.
const singleWithSecondary = (window, lead) => ({
  id: "F1",
  label: "HY OAS",
  unit: "%",
  cadence: "daily",
  thresholds: { amberLevel: 4.5, redLevel: 6.0 },
  chart: {
    window,
    lead,
    axes: [
      { id: "primary", side: "left", unit: "%", format: "value" },
      { id: "secondary", side: "right", unit: "pp", format: "value", label: "OAS Δ30d" },
    ],
    series: [
      { axis: "primary", fromPoint: "value", style: "primary" },
      { axis: "secondary", compute: "roc30", style: "derived" },
    ],
    bands: [
      { level: "amber", axis: "primary", source: "threshold", metric: "level" },
      { level: "red", axis: "primary", source: "threshold", metric: "level" },
      { level: "amber", axis: "secondary", source: "displayBand", value: 0.5, label: "ARM +50bp/30d" },
      { level: "amber", axis: "secondary", source: "displayBand", value: 0.28, style: "approach", label: "approach +28bp/30d" },
    ],
  },
});

describe("ys seam - the secondary-axis line rides each sample (S3)", () => {
  it("a primary + one secondary line ⇒ ys = [dotY, secondaryY], both finite, no null/NaN", () => {
    const meta = singleWithSecondary(504, 30);
    // roc30 is defined across the whole visible window (the 30-pt lead is consumed), so every
    // sample draws BOTH the primary value line and the secondary ROC line — and the bands here are
    // static (threshold + displayBand), so nothing else occupies a per-column y.
    const pts = Array.from({ length: 534 }, (_, i) => pt(`d${i}`, 4 + i * 0.01, "GREEN"));
    const { samples } = genericDetailChart(meta, pts, {}).detail;
    expect(samples.length).toBe(504);
    // Exactly the two drawn lines: the primary (pushed first ⇒ dotY) and the secondary ROC.
    const s0 = samples[0];
    expect(s0.ys).toEqual([s0.dotY, expect.any(Number)]);
    expect(s0.ys.every(Number.isFinite)).toBe(true);
  });
});

describe("genericSingle - window/lead slice with a windowed compute (E1 Stage 2)", () => {
  it("renders only the trailing `window` points; the `lead` buffer feeds the hook but never draws (no leading ROC gap)", () => {
    const meta = singleWithSecondary(504, 30);
    // 534 pts = 504 visible + 30 lead. Monotonic value ⇒ roc30 defined (non-null)
    // from index 30 onward, so the sliced window's first ROC is already defined.
    const pts = Array.from({ length: 534 }, (_, i) => pt(`d${i}`, 4 + i * 0.01, "GREEN"));
    const r = genericDetailChart(meta, pts, {});
    // Only the visible window is drawn.
    expect(r.detail.n).toBe(504);
    // First rendered x-date is pts[30] (534 − 504), i.e. the lead was consumed, not drawn.
    expect(r.svg).toContain(">d30</text>");
    expect(r.detail.samples[0].readout).toContain("d30");
    // No leading ROC gap: the first VISIBLE sample already carries the derived term.
    expect(r.detail.samples[0].readout).toContain("OAS Δ30d");
  });
});

// DATE-anchored window (ChartSpec.fromDate — the aligned-start ids). The visible slice starts at
// the first point whose date ≥ the anchor, SUPERSEDING the trailing-count `window`, so ids sampled
// differently share one start date. Dates are fixed-width (`d00`..) so lexicographic `>=` matches ISO.
const singleWithFromDate = (fromDate) => {
  const m = singleWithSecondary(504, 30);
  m.chart = { ...m.chart, fromDate };
  return m;
};

describe("genericSingle - DATE-anchored window (fromDate)", () => {
  it("slices at the first point whose date ≥ fromDate, ignoring the count `window`; pre-anchor points warm roc30 but never draw", () => {
    const pts = Array.from({ length: 40 }, (_, i) => pt(`d${String(i).padStart(2, "0")}`, 4 + i * 0.01, "GREEN"));
    const r = genericDetailChart(singleWithFromDate("d30"), pts, {});
    // 10 visible (d30..d39). The count window (504 ⇒ all 40 under the old slice) is superseded.
    expect(r.detail.n).toBe(10);
    expect(r.detail.samples[0].readout).toContain("d30");
    expect(r.svg).toContain(">d30</text>");
    // roc30 defined at the FIRST visible point: the 30 pre-anchor points (d00..d29) warmed it.
    expect(r.detail.samples[0].readout).toContain("OAS Δ30d");
  });

  it("clamps to full history when the whole series predates the anchor (stale feed ⇒ never empty)", () => {
    const pts = Array.from({ length: 5 }, (_, i) => pt(`d0${i}`, 4 + i, "GREEN"));
    const r = genericDetailChart(singleWithFromDate("d99"), pts, {});
    expect(r.detail.n).toBe(5);
  });
});

// The `5y` chip (LONG_WINDOW > DETAIL_LIMIT) EXPANDS instead of tightening: past the id's count
// window, and past a date anchor. Contrast: a narrower chip still tightens (min) on the same data.
describe("window chip - LONG_WINDOW expands past the default span", () => {
  it("count mode: draws LONG_WINDOW trailing points, where a 126 chip still tightens", () => {
    const pts = Array.from({ length: LONG_WINDOW + 40 }, (_, i) => pt(`d${String(i).padStart(4, "0")}`, 4 + i * 0.001, "GREEN"));
    expect(genericDetailChart(singleWithSecondary(504, 30), pts, {}, CH, LONG_WINDOW).detail.n).toBe(LONG_WINDOW);
    expect(genericDetailChart(singleWithSecondary(504, 30), pts, {}, CH, 126).detail.n).toBe(126);
  });

  it("date mode: slices at the (widened) anchor, never a trailing count, so aligned ids share one start", () => {
    const pts = Array.from({ length: LONG_WINDOW + 40 }, (_, i) => pt(`d${String(i).padStart(4, "0")}`, 4 + i * 0.001, "GREEN"));
    expect(genericDetailChart(singleWithFromDate("d0010"), pts, {}, CH, LONG_WINDOW).detail.n).toBe(LONG_WINDOW + 30);
  });
});

describe("genericDerived - DATE-anchored window (fromDate)", () => {
  it("slices at the first point whose date ≥ fromDate, not the trailing DETAIL_LIMIT count", () => {
    const meta = metaFor("F13"); // maSpread derived-kind: value primary + server `decision` secondary
    meta.chart = { ...meta.chart, fromDate: "d30" };
    const pts = Array.from({ length: 40 }, (_, i) =>
      pt(`d${String(i).padStart(2, "0")}`, 100 + i, "GREEN", { decision: 0.01 * i }));
    const r = genericDetailChart(meta, pts, {});
    expect(r.detail.n).toBe(10); // d30..d39
    expect(r.detail.samples[0].readout).toContain("d30");
    expect(r.svg).toContain(">d30</text>");
  });
});

describe("genericDetailChart - a non-decision secondary (E1 Decision 3)", () => {
  it("a NON-decision (roc30) secondary paints cut lines + axis-2 label + secondary band + dashed ROC line", () => {
    const meta = singleWithSecondary(undefined, undefined); // no window ⇒ trailing DETAIL_LIMIT (no-op here)
    // Data 4.00–4.39 keeps the primary amber cut (4.5)… above frame, so use a spread
    // that brackets it: 4.00 → 5.95 ⇒ amber 4.5 draws as an in-range band LINE.
    const pts = Array.from({ length: 40 }, (_, i) => pt(`d${i}`, 4 + i * 0.05, "GREEN"));
    const r = genericDetailChart(meta, pts, {});
    expect((r.svg.match(/class="band"/g) || []).length).toBeGreaterThanOrEqual(1); // primary cut line(s)
    expect(r.svg).toContain("OAS Δ30d"); // secondary axis-2 label
    expect(r.svg).toContain("ARM +50bp/30d"); // secondary band prefers its custom label over the "<kind> <value>" auto-label
    // The approach tier (style:"approach") draws as a SECOND secondary band: its LINE
    // at half strength (exactly one opacity), its LABEL full-strength amber; the real
    // ARM cut stays full-strength.
    expect(r.svg).toContain("approach +28bp/30d");
    expect((r.svg.match(/opacity="\.5"/g) || []).length).toBe(1);
    expect(r.svg).toContain('class="line-derived"'); // dashed ROC path
  });
});

describe("off-range band cuts - data-anchored frame + ▼/▲ markers (D0-a)", () => {
  const bandLines = (svg) => (svg.match(/class="band"/g) || []).length;

  it("generic level: below-frame red → ▼ marker + true value, no band line; frame stays data-anchored", () => {
    // Data spans [0.30, 1.00]; amber 0.5 in range, red 0.0 far below.
    // Old implementation folded 0.0 into the domain (bottom tick would read 0.00
    // and red would draw as a flat line on the axis) — all three asserts fail on it.
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.5, redLevel: 0.0 } });
    const pts = [
      pt("2026-01-02", 1.0, "GREEN"),
      pt("2026-01-03", 0.62, "GREEN"),
      pt("2026-01-04", 0.44, "AMBER", { leg: "op" }),
      pt("2026-01-05", 0.3, "AMBER", { leg: "op" }),
    ];
    const r = genericDetailChart(meta, pts, {});
    expectValid(r, 4);
    expect(r.svg).toContain("▼");
    expect(r.svg).toContain("red 0.00");
    expect(bandLines(r.svg)).toBe(1); // amber only — no full line for the off-range red
    // y ticks sit at lo+padY / hi-padY = the DATA extent: the band no longer stretched the frame.
    expect(r.svg).toContain(">0.30%<");
    expect(r.svg).toContain(">1.00%<");
  });

  it("generic level: above-frame cut → ▲ marker at the top edge", () => {
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.5, redLevel: 2.0 } });
    const pts = [pt("2026-01-02", 0.6, "GREEN"), pt("2026-01-03", 0.4, "AMBER", { leg: "op" })];
    const r = genericDetailChart(meta, pts, {});
    expect(r.svg).toContain("▲");
    expect(r.svg).toContain("red 2.00");
    expect(bandLines(r.svg)).toBe(1);
  });

  it("FXH move axis: effective cut above every move → ▲ marker, frame follows legs/envelope only", () => {
    const meta = metaFor("FXH");
    const pts = [
      pt("2026-01-02", 1.08, "GREEN", { havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } }),
      pt("2026-01-03", 1.079, "GREEN", { havenLegs: { eur: 0.012, chf: 0.018, jpy: 0.009 } }),
    ];
    const r = genericDetailChart(meta, pts, { effAmber: 0.01, effRed: 0.5 });
    expectValid(r, 2);
    expect(r.svg).toContain("▲"); // red 0.5 far above the ~0.002–0.018 moves
    expect(bandLines(r.svg)).toBe(1); // amber in range still draws its line
  });

  it("two cuts off the same edge stack - distinct marker y positions, no overprint", () => {
    // Data 0.30–1.00, BOTH cuts below the frame: markers must not share a baseline.
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.1, redLevel: 0.0 } });
    const pts = [pt("2026-01-02", 1.0, "GREEN"), pt("2026-01-03", 0.3, "GREEN")];
    const r = genericDetailChart(meta, pts, {});
    const markerYs = [...r.svg.matchAll(/class="band-marker"[^>]*\by="([\d.]+)"/g)].map((m) => m[1]);
    expect(markerYs).toHaveLength(2);
    expect(new Set(markerYs).size).toBe(2);
    expect(bandLines(r.svg)).toBe(0);
  });

  it("in-range bands are untouched: both lines draw, no markers", () => {
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.5, redLevel: 0.0 } });
    const pts = [pt("2026-01-02", 0.82, "GREEN"), pt("2026-01-03", -0.05, "RED", { leg: "op" })];
    const r = genericDetailChart(meta, pts, {});
    expect(bandLines(r.svg)).toBe(2);
    expect(r.svg).not.toContain("band-marker");
  });
});

// A spec that draws its MEASURED legs explicitly (any `style:"evt"` band — F1) opts out of the
// worst-of `eff` composite. The server no longer produces such a composite — no `zref*` reaches a
// proxy id, so `effectiveCuts` drops the leg (pinned in src/effective-cuts.test.ts) — so this
// drives the RENDERER directly with a synthetic `eff` (2.17/2.29 below): it pins that the flag
// still ignores a composite, whatever a future vintage puts in one.
describe("genericSingle - a spec drawing its measured legs ignores the eff composite", () => {
  it("F1: the level band draws the registry priors, not effAmber/effRed", () => {
    const meta = metaFor("F1", { thresholds: { amberLevel: 3.0, redLevel: 3.2 } });
    const pts = Array.from({ length: 40 }, (_, i) => pt(`d${String(i).padStart(2, "0")}`, 2.9 + (i % 5) * 0.1, "GREEN"));
    const r = genericDetailChart(meta, pts, { effAmber: 2.168771, effRed: 2.289319 });
    expect(r.svg).toContain("amber 3.00");
    expect(r.svg).toContain("red 3.20");
    // The composite's own numbers appear nowhere — below the frame they would render as ▼ markers.
    expect(r.svg).not.toContain("2.17");
    expect(r.svg).not.toContain("2.29");
  });
});

// The scorer legend NAMES the served legs (`SeriesResponse.scorerLegs` = `activeLegs`) and the
// served confirmation buffer — it must never restate the leg set in prose (the copy advertised an
// EVT level leg for months after F1's was retired). Asserts the SHAPE of that derivation, not any
// cut value, so a retune/leg change moves the copy without touching this test.
describe("scorer legend is derived from the served legs, never hardcoded", () => {
  const render = (eff) => {
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.5, redLevel: 0.0 } });
    const pts = [pt("2026-01-02", 0.82, "GREEN"), pt("2026-01-03", -0.05, "RED", { leg: "op" })];
    return genericDetailChart(meta, pts, eff).svg;
  };

  it("names each served leg (level-axis first, ' cut' stripped in this clause) and the served confirm buffer", () => {
    const svg = render({ effAmber: 0.5, effRed: 0.0, scorerLegs: ["op", "vel-op", "z"], confirmCloses: 2 });
    // #6: `scored on <legs> · <n>-close confirm` — legPhrase output with a trailing " cut"
    // stripped here only ("level", "velocity"), level-axis legs before `vel-` legs.
    expect(svg).toContain("scored on level + regime-z + velocity · 2-close confirm");
    expect(svg).not.toContain("bar = full scorer");
    // The retired-leg regression: a leg the server did not serve is never named.
    expect(svg).not.toContain("EVT");
  });

  it("degrades honestly: no served legs ⇒ confirm clause alone; 0 closes ⇒ same-day", () => {
    const svg = render({ effAmber: 0.5, effRed: 0.0, confirmCloses: 0 });
    expect(svg).toContain("same-day");
    expect(svg).not.toContain("scored on");
    expect(svg).not.toContain("no confirmation buffer");
  });

  it("a null confirmCloses omits the confirm clause", () => {
    const svg = render({ effAmber: 0.5, effRed: 0.0, scorerLegs: ["op"], confirmCloses: null });
    expect(svg).toContain("scored on level");
    expect(svg).not.toContain("confirm");
    expect(svg).not.toContain("same-day");
  });
});

// Rung B2 — two CLOSE in-range cuts must not overprint their labels (the F1 first-axis
// amber/red pair painted on top of each other at eyeball time). Close labels stagger;
// well-separated labels keep the exact pre-B2 placement (line y − 3).
describe("band-label collision avoidance (Rung B2)", () => {
  const labelYs = (svg) => [...svg.matchAll(/class="band-label"[^>]*\by="([\d.]+)"/g)].map((m) => Number(m[1]));

  it("two near-identical cuts stagger their labels ≥10px apart", () => {
    // Data 0.30–1.00; cuts 0.50 vs 0.48 ⇒ line ys ~4px apart — old code put both
    // labels at y−3, i.e. overprinted within 4px.
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.5, redLevel: 0.48 } });
    const pts = [pt("2026-01-02", 1.0, "GREEN"), pt("2026-01-03", 0.3, "GREEN")];
    const r = genericDetailChart(meta, pts, {});
    const ys = labelYs(r.svg);
    expect(ys).toHaveLength(2);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(10);
  });

  it("well-separated cuts keep the default just-above-the-line placement", () => {
    const meta = primaryAxisOnly("F2", { thresholds: { amberLevel: 0.8, redLevel: 0.35 } });
    const pts = [pt("2026-01-02", 1.0, "GREEN"), pt("2026-01-03", 0.3, "GREEN")];
    const r = genericDetailChart(meta, pts, {});
    const lineYs = [...r.svg.matchAll(/class="band"[^>]*\by1="([\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = labelYs(r.svg);
    expect(ys).toHaveLength(2);
    ys.forEach((ly, i) => expect(ly).toBeCloseTo(lineYs[i] - 3, 1));
  });
});

// Case 4 (DISP) — a SECONDARY-axis band's custom label must reach a pixel, not the auto-label
// "red 0.0%".
describe("genericDerived - secondary-axis band label (DISP)", () => {
  const dispPts = [
    pt("2026-01-02", 0.42, "GREEN", { decision: 0.03 }),
    pt("2026-01-03", 0.66, "AMBER", { decision: -0.02, rawState: "AMBER" }),
    pt("2026-01-06", 0.81, "RED", { decision: -0.05, rawState: "RED" }),
  ];

  it("paints the spec's band label, not the auto '<kind> <value>' fallback", () => {
    const r = genericDetailChart(metaFor("DISP"), dispPts, {});
    const labels = [...r.svg.matchAll(/class="band-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // The three bands DISP declares carry the shipped copy verbatim: two on the SECONDARY axis
    // (AMBER onset at 0, RED depth cut) and — since Stage 2 (2026-09-09) — the PRIMARY-axis
    // DISP_CORR gate band, which now PAINTS (it sat in the spec but on no pixel before this stage).
    expect(labels).toEqual([
      "amber &lt;0% · corr&gt;0.75",
      "red &lt;−2.5% · corr&gt;0.75",
      "corr&gt;0.75 confirms",
    ]);
    // ...and specifically NOT the auto-label the 2-tuple path produced.
    expect(r.svg).not.toContain(">red 0.0");
  });
});

// Case 4 on a SINGLE-axis id (DB_SMH/DB_XLK, 2026-08-18) — the downside detectors' scored
// variable IS the primary drawdown line, so the MA50 trend gate has no secondary line to ride.
// Prod served DB_SMH GREEN at a −11.2% drawdown (past its drawn −8% red cut) because SMH had
// crossed back above its MA50, and the chart said nothing: `genericSingle` now dims the PRIMARY
// line over a gate-off stretch and draws the gate's own line in drawdown space.
describe("genericSingle - gated PRIMARY line (downside detectors)", () => {
  const dbMeta = () => {
    const i = DB_SMH;
    return { id: i.id, label: i.label, unit: i.unit ?? "%", cadence: i.cadence, thresholds: i.thresholds, chart: buildIndicatorChart(i) };
  };
  // The prod signature: a deep drawdown throughout, the gate ON for the first two closes (RED)
  // and OFF for the last two — the drawdown line still under the red cut, the state back to GREEN.
  const dbPts = [
    pt("2026-08-12", -12.5, "RED", { gates: { belowMA50: true }, gateLine: -4 }),
    pt("2026-08-13", -11.9, "RED", { gates: { belowMA50: true }, gateLine: -4.2 }),
    pt("2026-08-14", -12.1, "GREEN", { gates: { belowMA50: false }, gateLine: -13 }),
    pt("2026-08-17", -11.2, "GREEN", { gates: { belowMA50: false }, gateLine: -13.4 }),
  ];

  it("dims the drawdown line where the MA50 gate is off, and explains it in the legend", () => {
    const r = genericDetailChart(dbMeta(), dbPts, {});
    expectValid(r, dbPts.length);
    // TWO primary paths — the gate-ON run at full ink, the gate-OFF run faded + tighter-dashed.
    const lines = [...r.svg.matchAll(/<path class="line" [^>]*>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.includes('opacity="0.35"'))).toHaveLength(1);
    // The legend names the gate (composed off PRICE_WINDOWS.maShort, never typed) + the dim rule.
    expect(r.svg).toContain("SMH below its 50-day MA");
    expect(r.svg).toContain("dim/dashed where no gate is active");
    // …and the gate's own line rides along, so "how far from the gate" is readable.
    expect(r.svg).toContain('class="line-derived"');
    expect(r.svg).toContain("(as drawdown)");
    // Hover: the gate-off closes say so, the gate-on ones don't.
    expect(r.detail.samples[0].readout).not.toContain("gate off");
    expect(r.detail.samples[3].readout).toContain("gate off");
  });

  it("the hover readout carries the gate line's own value, named by its lead clause", () => {
    const r = genericDetailChart(dbMeta(), dbPts, {});
    // The drawn MA50 line is a number a reader wants at the crosshair, not just a shape: each
    // sample reads out ITS OWN gateLine beside the drawdown.
    expect(r.detail.samples[0].readout).toContain("SMH 50-day MA (as drawdown) -4");
    expect(r.detail.samples[3].readout).toContain("SMH 50-day MA (as drawdown) -13.4");
    // …and the legend's explanatory tail stays OUT of the one-line readout.
    expect(r.detail.samples[0].readout).not.toContain("the gate is on");
  });

  it("a point with no gateLine reads out the drawdown alone (no empty MA term)", () => {
    const partial = dbPts.map((p, i) => (i === 1 ? (({ gateLine, ...rest }) => rest)(p) : p));
    const r = genericDetailChart(dbMeta(), partial, {});
    expect(r.detail.samples[1].readout).not.toContain("50-day MA");
    expect(r.detail.samples[0].readout).toContain("50-day MA");
  });

  it("an all-gate-on window keeps ONE undimmed primary path", () => {
    const onlyOn = dbPts.map((p) => ({ ...p, gates: { belowMA50: true } }));
    const r = genericDetailChart(dbMeta(), onlyOn, {});
    const lines = [...r.svg.matchAll(/<path class="line" [^>]*>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(1);
    expect(r.svg).not.toContain('opacity="0.35"');
    expect(r.svg).not.toContain("dim/dashed where no gate is active");
  });

  it("a payload with NO gate flags degrades to the plain line (unknown is never dimmed)", () => {
    const bare = dbPts.map(({ gates, gateLine, ...p }) => p);
    const r = genericDetailChart(dbMeta(), bare, {});
    const lines = [...r.svg.matchAll(/<path class="line" [^>]*>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(1);
    expect(r.svg).not.toContain('opacity="0.35"');
  });
});

/**
 * 2026-08-29 — the derived layout draws BOTH legs of a two-leg id (F13's d20, `SECOND_LEG_CHART_OF`),
 * one per AXIS: d20 on the primary (in place of the unscored ratio line), ms50 on the secondary.
 * Drives the REAL F13 spec. Before the first half of this arc the layout drew `decision` alone and
 * resolved its bands with a `find` by level, so the second leg's line AND its cut pair were both
 * silently absent; before the second, both legs shared one axis and overlapped.
 */
describe("genericDerived - a two-leg id draws one leg per axis, with both cut pairs (F13)", () => {
  const meta = metaFor("F13");
  const w = meta.chart.series.find((s) => s.compute === "trailingReturn").window;
  // A ratio that climbs, then falls hard over the last `w` points: the d20 leg goes deeply
  // negative while the ms50 `decision` (served, so set explicitly) stays positive.
  const pts = Array.from({ length: 2 * w + 10 }, (_, i) => {
    const turn = 2 * w + 9 - w;
    const value = i <= turn ? 0.75 * 1.001 ** i : 0.75 * 1.001 ** turn * 0.997 ** (i - turn);
    return pt(`d${String(i).padStart(3, "0")}`, value, "AMBER", { decision: 0.008 });
  });
  const r = genericDetailChart(meta, pts, {});

  it("draws the d20 leg as the SOLID primary line and ms50 as the lone dashed secondary", () => {
    expectValid(r, pts.length);
    // One ink line (d20, primary) + one ink-dim dash (ms50, secondary). The ratio has no line.
    expect((r.svg.match(/class="line-derived"/g) || []).length).toBe(1);
    expect((r.svg.match(/<path class="line" /g) || []).length).toBe(1);
    // The d20 line's warm-up is GAPPED, not drawn from x=0: its first `w` points have no return.
    const primary = r.svg.match(/<path class="line" d="M([\d.]+) /)[1];
    expect(Number(primary)).toBeGreaterThan(CH.ml);
  });

  it("draws BOTH cut pairs, each label naming its leg", () => {
    // 4 band lines (2 legs × amber/red), now two per axis — a `find`-by-level resolver draws 2.
    expect((r.svg.match(/class="band"/g) || []).length).toBe(4);
    for (const b of meta.chart.bands.filter((b) => typeof b.value === "number")) {
      expect(r.svg).toContain(b.label);
    }
  });

  it("the legend and the hover readout both name the primary leg with its own number", () => {
    const d20Axis = meta.chart.axes.find((a) => a.id === "primary").label;
    // The left axis is the d20 leg now, so the legend says so instead of "price left".
    expect(r.svg).toContain(`${d20Axis} (left)`);
    const lastReadout = r.detail.samples.at(-1).readout;
    expect(lastReadout).toContain(d20Axis);
    // The drawn number is the SCORED leg: v[i]/v[i-w] - 1 over the plotted ratio, deeply
    // negative here while the ms50 term the card also shows is positive.
    const last = pts.at(-1).value / pts.at(-1 - w).value - 1;
    expect(last).toBeLessThan(0);
    expect(lastReadout).toContain(`${(last * 100).toFixed(1)}%`);
  });

  it("SERIES_HOOKS.trailingReturn gaps its warm-up and never fabricates a 0", () => {
    const arr = SERIES_HOOKS.trailingReturn(pts, { window: w });
    expect(arr.slice(0, w).every((v) => v === null)).toBe(true);
    expect(arr[w]).toBeCloseTo(pts[w].value / pts[0].value - 1, 12);
    // No window on the series ⇒ all-gap (never a silently-wrong span).
    expect(SERIES_HOOKS.trailingReturn(pts, {}).every((v) => v === null)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S4b — the oil nowcast on the detail chart (E8 retired F1's HYG nowcast): `eff.oasEst` = the wire's BRENT/G1 `oilEst`.
// Both carry `derived: {kind:"return"}`, so they route to genericDerived. Estimate sits ABOVE the price range (85 vs 70–72)
// so an unextended y-domain would clip it — the discriminating regime for the domain join.
describe("genericDerived - oasEst dashed neutral estimate on the value line (S4b)", () => {
  const estPts = () => [
    pt("2026-09-11", 70, "GREEN", { decision: 0.05 }),
    pt("2026-09-14", 71, "GREEN", { decision: 0.06 }),
    pt("2026-09-15", 70.5, "GREEN", { decision: 0.04 }),
    pt("2026-09-16", 72, "GREEN", { decision: 0.07 }),
    pt("2026-09-17", 71.5, "GREEN", { decision: 0.05 }),
  ];
  const oasEst = { date: "2026-09-19", value: 85, fromDate: "2026-09-17" };
  const estBlock = (svg) => {
    const m = svg.match(/<g data-oas-est="[^"]*">.*?<\/g>/s);
    return m ? m[0] : null;
  };

  it("(a) BRENT (derived route) draws the dashed segment + end marker + ESTIMATED label, no state tone", () => {
    const r = genericDetailChart(metaFor("BRENT"), estPts(), { oasEst });
    // Confirm it really took the derived route (the `decision` secondary axis is drawn).
    expect(r.svg).toContain("20-day return");
    const g = estBlock(r.svg);
    expect(g).not.toBeNull();
    expect(g).toContain('stroke-dasharray="4 3"');
    expect(g).toContain('stroke="var(--ink-dim)"');
    expect(g).toContain("<circle");
    expect(g).toContain("ESTIMATED · from 2026-09-17");
    expect(g).not.toContain("--state-amber");
    expect(g).not.toContain("--state-red");
    expect(g).not.toContain("--state-green");
    // The estimate endpoint lies strictly inside the plotted y-frame (domain-join worked).
    const c = g.match(/<circle cx="([\d.]+)" cy="([\d.]+)"/);
    const cy = Number(c[2]);
    expect(cy).toBeGreaterThan(CH.mt);
    expect(cy).toBeLessThan(CH.mt + plotH(CH));
    // Hover readout is sample-driven; the virtual slot is the last sample, never in the ribbon/count.
    expect(r.svg).not.toContain("2026-09-19 GREEN");
    expect(r.detail.samples.at(-1).readout).toContain("ESTIMATED · from 2026-09-17");
    expect(r.detail.samples.at(-1).date).toBe("2026-09-19");
  });

  it("(b) G1 without oasEst paints no estimate", () => {
    const r = genericDetailChart(metaFor("G1"), estPts(), {});
    expect(r.svg).not.toContain("data-oas-est");
    expect(r.svg).not.toContain("ESTIMATED");
  });

  it("(c) the estimate endpoint lies inside the plotted x/y frame, full window and under a window chip", () => {
    for (const userWindow of [null, 3]) {
      const r = genericDetailChart(metaFor("G1"), estPts(), { oasEst }, CH, userWindow);
      const g = estBlock(r.svg);
      expect(g).not.toBeNull();
      const c = g.match(/<circle cx="([\d.]+)" cy="([\d.]+)"/);
      expect(c).not.toBeNull();
      const [cx, cy] = [Number(c[1]), Number(c[2])];
      expect(cx).toBeGreaterThan(CH.ml);
      expect(cx).toBeLessThanOrEqual(CH.ml + plotW(CH));
      // Strictly inside vertically: an unextended y-domain would clamp/overshoot past mt.
      expect(cy).toBeGreaterThan(CH.mt);
      expect(cy).toBeLessThan(CH.mt + plotH(CH));
    }
  });

  it("(d) a fromDate that is not the last plotted real point's date draws nothing", () => {
    const stale = { ...oasEst, fromDate: "2026-09-16" };
    const r = genericDetailChart(metaFor("G1"), estPts(), { oasEst: stale });
    expect(r.svg).not.toContain("data-oas-est");
    expect(r.svg).not.toContain("ESTIMATED");
  });

  it("(e) an eff lacking oasEst is inert on the derived route (byte-identical to no eff)", () => {
    const pts = estPts();
    const withEff = genericDetailChart(metaFor("BRENT"), pts, { effAmber: 0.15, effRed: 0.25 });
    const withoutEff = genericDetailChart(metaFor("BRENT"), pts, {});
    expect(withEff.svg).toBe(withoutEff.svg);
    expect(withEff.detail).toEqual(withoutEff.detail);
  });
});

// BONOS: the ABSOLUTE bp pair draws in the plain severity hues — [USER] 2026-09-25 retired the lavender
// `pair:"level"` hue (2026-09-24) and its legend key.
describe("genericSingle - BONOS's static level pair in the severity hues", () => {
  it("draws both cuts plain amber/red dashed, with no pair hue or pair legend", () => {
    const meta = metaFor("BONOS");
    // Data spans the pair with margin — the y-domain is data-driven, and an off-frame cut draws a
    // ▼/▲ marker (no <line>), which is a different branch from the one under test.
    const { amberLevel: a, redLevel: r } = meta.thresholds;
    const pts = Array.from({ length: 40 }, (_, i) => pt(`d${String(i).padStart(2, "0")}`, a - 10 + (i * (r - a + 20)) / 39, "GREEN"));
    const { svg } = genericDetailChart(meta, pts, undefined);
    // The <line> template spans two source lines — match across them, never per line.
    expect(svg).not.toContain("--pair-");
    expect(svg).not.toContain("dc-pair-");
    // Primary level pair + secondary σ pair: two <line>s per severity hue, all plain "4 3" dashed.
    expect(svg.match(/<line class="band"[^>]*stroke="var\(--state-amber\)" stroke-dasharray="4 3"/g) ?? []).toHaveLength(2);
    expect(svg.match(/<line class="band"[^>]*stroke="var\(--state-red\)" stroke-dasharray="4 3"/g) ?? []).toHaveLength(2);
  });
});

// `/api/series` flags an intraday run's in-progress point `provisional: true`; the chart labels it INTRADAY.
describe("genericSingle - INTRADAY label on an intraday run's provisional tail", () => {
  const pts = (flagLast) => [
    pt("2026-09-24", 3.0, "GREEN"),
    { ...pt("2026-09-25", 3.1, "GREEN"), provisional: !flagLast || undefined },
    { ...pt("2026-09-29", 3.2, "GREEN"), ...(flagLast ? { provisional: true } : {}) },
  ];

  it("labels the last point when it is provisional, and names it in the caption", () => {
    const r = genericDetailChart(metaFor("F1"), pts(true), {});
    expect(r.svg).toContain('data-intraday="2026-09-29"');
    expect(r.svg).toContain("INTRADAY · 2026-09-29");
    expect(r.svg).toContain("replaced by the EOD close");
  });

  it("no label when the last point is final (a non-last provisional point is ignored)", () => {
    expect(genericDetailChart(metaFor("F1"), pts(false), {}).svg).not.toContain("INTRADAY");
  });
});

// Nowcast anchor hole: on a nowcast-scored id /api/series serves the intraday row as
// `estimated: true` (it IS the stored same-day estimate) and `oasEst`/`oilEst` anchors on the FINAL print before it.
// The chart draws the ESTIMATED continuation off that final point — the estimated row is never ALSO a close / bare INTRADAY.
describe("an `estimated` provisional tail renders ESTIMATED-headed, never a bare INTRADAY (Defect 2)", () => {
  const EST_DATE = "2026-09-19";
  const finals = (extra = () => ({})) =>
    ["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"].map((d, i) =>
      pt(d, 70 + i * 0.5, "GREEN", extra(i)),
    );
  const estTail = (extra = {}) => ({ ...pt(EST_DATE, 71, "GREEN", extra), provisional: true, estimated: true });
  const est = { date: EST_DATE, value: 85, fromDate: "2026-09-17" };

  it("the estimate chains off the last FINAL point and replaces the estimated row", () => {
    const pts = [...finals(() => ({ decision: 0.05 })), estTail({ decision: 0.05 })];
    const r = genericDetailChart(metaFor("G1"), pts, { oasEst: est });
    expect(r.svg).toContain("ESTIMATED · from 2026-09-17");
    expect(r.svg).not.toContain("data-intraday");
    expect(r.svg).not.toContain("INTRADAY");
    // One x-slot per final close + the virtual estimate slot — the estimated row is not drawn as a close too.
    expect(r.detail.samples.map((s) => s.date)).toEqual([...finals().map((p) => p.date), EST_DATE]);
    expect(r.detail.samples.at(-1).readout).toContain("ESTIMATED · from 2026-09-17");
  });

  it("a 2-day estimated tail chains off the print before BOTH rows (estimateSlot's anchor)", () => {
    const pts = [...finals(), { ...pt("2026-09-18", 70.8, "GREEN"), estimated: true }, estTail()];
    const slot = estimateSlot(pts);
    expect(slot?.fromDate).toBe("2026-09-17");
    const r = genericDetailChart(metaFor("G1"), pts, { oasEst: slot });
    expect(r.svg).toContain('data-oas-est="2026-09-17"');
    expect(r.detail.samples.map((s) => s.date)).toEqual([...finals().map((p) => p.date), EST_DATE]);
  });

  it("an estimated provisional tail with no served estimate reads ESTIMATED · INTRADAY, headed by ESTIMATED", () => {
    const r = genericDetailChart(metaFor("G1"), [...finals(() => ({ decision: 0.05 })), estTail({ decision: 0.05 })], {});
    expect(r.svg).toContain(`data-estimated="${EST_DATE}"`);
    expect(r.svg).toContain(`>ESTIMATED · INTRADAY · ${EST_DATE}</text>`);
    expect(r.svg).toContain(`last point ESTIMATED · INTRADAY (${EST_DATE}, replaced by the final print)`);
    expect(r.svg).not.toContain("data-intraday");
    expect(r.detail.samples.at(-1).readout).toMatch(/ · ESTIMATED · INTRADAY$/);
  });

  it("a provisional estimate slot reads ESTIMATED · INTRADAY on its label, legend and readout", () => {
    const pts = [...finals(() => ({ decision: 0.05 })), estTail({ decision: 0.05 })];
    const r = genericDetailChart(metaFor("G1"), pts, { oasEst: { ...est, provisional: true } });
    expect(r.svg).toContain(">ESTIMATED · INTRADAY · from 2026-09-17</text>");
    expect(r.svg).toContain("dashed gray = ESTIMATED · INTRADAY · from 2026-09-17");
    expect(r.detail.samples.at(-1).readout).toContain("ESTIMATED · INTRADAY · from 2026-09-17");
  });
});

// An EOD-run estimate (the 22:00 cron, or a weekend re-run before the final print lands) is stored `estimated`
// WITHOUT `provisional` — prod Sat 2026-10-10: F1/XDEV/LEGP_* (single) + EXSH_GATE (derived), no `oilEst`.
// It must still read ESTIMATED on the chart, in the caption and in its hover readout.
describe("an EOD `estimated` tail (no `provisional`) still reads ESTIMATED", () => {
  const EST_DATE = "2026-10-09";
  const series = (extra = {}) => [
    pt("2026-10-07", 3.0, "GREEN", extra),
    pt("2026-10-08", 3.1, "GREEN", extra),
    { ...pt(EST_DATE, 3.2, "GREEN", extra), estimated: true },
  ];

  it.each([
    ["F1", {}],
    ["EXSH_GATE", { decision: 0.05 }],
  ])("%s labels the estimated last point, names it in the caption, marks its readout", (id, extra) => {
    const r = genericDetailChart(metaFor(id), series(extra), {});
    expect(r.svg).toContain(`data-estimated="${EST_DATE}"`);
    expect(r.svg).toContain(`ESTIMATED · ${EST_DATE}`);
    expect(r.svg).toContain("replaced by the final print");
    expect(r.svg).not.toContain("INTRADAY");
    expect(r.detail.samples.at(-1).readout).toContain("ESTIMATED");
    expect(r.detail.samples.at(-2).readout).not.toContain("ESTIMATED");
  });
});

// Display-only Δ5 line (`DELTA5_OVERLAY`, chart-rail.ts — user ask 2026-10-10): blue, no cuts, always on a
// VIRTUAL axis — own fitted scale, no ticks/margin, never stretching an existing axis — with a faint zero line;
// value in the hover only.
describe("Δ5 overlay", () => {
  const W = DELTA5_WINDOW;
  const ticks = (svg) => [...svg.matchAll(/class="axis-y[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
  const bandCount = (svg) => (svg.match(/class="band(-cut)?"/g) ?? []).length;
  // F1 is date-anchored (`fromDays`); drop it so the fixture's synthetic dates all stay visible.
  const meta5 = (id) => {
    const m = metaFor(id);
    return { ...m, chart: { ...m.chart, fromDays: undefined } };
  };
  // An oscillating level whose Δ5 (−6..15) sits far outside the level (60..78) — a shared scale would move ticks.
  const osc = Array.from({ length: 40 }, (_, i) => pt(`d${String(i).padStart(2, "0")}`, 60 + (i % 7) * 3, "GREEN", { velZ: 0.5, delta20: 0.05 }));
  // CCC re-quoted in bp carries the formatter's bp arm: no opted-in id is bp-quoted.
  const bp5 = () => ({ ...meta5("CCC"), unit: "bp" });
  const bpR = once(() => genericDetailChart(bp5(), osc, {}));
  const f1R = once(() => genericDetailChart(meta5("F1"), osc, {}));

  it("delta hook = v[i] − v[i−window], null before warm and across a gap", () => {
    const pts = [1, 2, 4, 7, null, 16, 22, 29, 37].map((v, i) => pt(`d${i}`, v, "GREEN"));
    expect(SERIES_HOOKS.delta(pts, { window: 2 })).toEqual([null, null, 3, 5, null, 9, null, 13, 15]);
    expect(SERIES_HOOKS.delta(pts, {}).every((v) => v == null)).toBe(true);
  });

  // CCC + F1 are the opted-in ids: the DELTA5_OVERLAY census in chart-rail.test.ts proves they share one spec path.
  it.each(["CCC", "F1"])("%s: blue line on its own fitted scale — no tick, band or axis-domain change on either axis", (id) => {
    const meta = meta5(id);
    const bare = { ...meta, chart: { ...meta.chart, series: meta.chart.series.filter((s) => !s.fit) } };
    const r = genericDetailChart(meta, osc, {});
    const b = genericDetailChart(bare, osc, {});
    expect(r.svg).toMatch(/<path class="line-trend"[^>]*stroke="var\(--trend-line\)"/);
    expect(b.svg).not.toContain("line-trend");
    // Same primary AND secondary tick text ⇒ no axis was stretched.
    expect(ticks(r.svg)).toEqual(ticks(b.svg));
    expect(bandCount(r.svg)).toBe(bandCount(b.svg));
    expect(r.svg).toContain("Δ5d (blue, own scale - value on hover)");
    // The line rides each sample's `fitYs` (parked around only while shown), never the always-on `ys`.
    expect(r.detail.samples.at(-1).ys).toEqual(b.detail.samples.at(-1).ys);
    expect(r.detail.samples.at(-1).fitYs.length).toBe(1);
    // OWN fitted scale: the line spans the plot height to within its 8% pad (top ≈ 7%, bottom ≈ 93%).
    const d = r.svg.match(/<path class="line-trend" d="([^"]+)"/)[1];
    const ysFit = [...d.matchAll(/[ML]\s*[\d.-]+[ ,]([\d.-]+)/g)].map((m) => +m[1]);
    expect(Math.min(...ysFit)).toBeGreaterThanOrEqual(CH.mt);
    expect(Math.min(...ysFit)).toBeLessThan(CH.mt + plotH(CH) * 0.1);
    expect(Math.max(...ysFit)).toBeGreaterThan(CH.mt + plotH(CH) * 0.9);
    expect(Math.max(...ysFit)).toBeLessThanOrEqual(CH.mt + plotH(CH));
  });

  it("faint zero line sits at the fit scale's 0 when Δ5 crosses it, absent when it does not", () => {
    const r = bpR();
    const z = r.svg.match(/<line data-fit-zero [^>]*y1="([\d.]+)"[^>]*opacity="0\.2"/);
    expect(z).not.toBeNull();
    // 0 sits at (hi + pad) / (hi − lo + 2·pad) of the height down from the top, pad = 0.08·(hi − lo).
    const d5 = osc.slice(W).map((p, i) => p.value - osc[i].value);
    const [lo, hi] = [Math.min(...d5), Math.max(...d5)];
    expect(lo < 0 && hi > 0).toBe(true);
    const pad = 0.08 * (hi - lo);
    expect(+z[1]).toBeCloseTo(CH.mt + plotH(CH) * ((hi + pad) / (hi - lo + 2 * pad)), 0);
    const rising = Array.from({ length: 40 }, (_, i) => pt(`d${String(i).padStart(2, "0")}`, 60 + i * i + 40 * i, "GREEN", { velZ: 0.5 }));
    expect(genericDetailChart(bp5(), rising, {}).svg).not.toContain("data-fit-zero");
  });

  it("a cold series (no Δ5 yet) draws no line and names none in the legend", () => {
    const pts = Array.from({ length: W }, (_, i) => pt(`d${i}`, 60 + i, "GREEN", { velZ: 0.5 }));
    const r = genericDetailChart(bp5(), pts, {});
    expect(r.svg).not.toContain("line-trend");
    expect(r.svg).not.toContain("Δ5d");
  });

  it("hover reads the Δ5 as a level difference: bp-quoted in bp, F1 in pp (never a relative %)", () => {
    const bp = bpR().detail.samples.at(-1).readout;
    expect(bp).toContain(`Δ5d ${osc.at(-1).value - osc.at(-1 - W).value}`);
    // A %-quoted level's difference is percentage points, never a "%" that reads as relative.
    const f1 = f1R().detail.samples.at(-1).readout;
    expect(f1).toContain(`Δ5d ${(osc.at(-1).value - osc.at(-1 - W).value).toFixed(2)}pp`);
    // …and its Δ30d axis is the same kind of quantity, so it reads pp on the same hover line.
    expect(f1).toMatch(/OAS Δ30d -?[\d.]+pp/);
    // A bp-quoted level names its unit: "-6bp", matching the re-entry rule's spread points.
    expect(bp).toContain(`Δ5d ${osc.at(-1).value - osc.at(-1 - W).value}bp`);
  });

  it("the on-chart chip carries the Δ5 too; a cold sample's chip names none", () => {
    const r = bpR();
    expect(r.detail.samples.at(-1).chip).toContain(`Δ5d ${osc.at(-1).value - osc.at(-1 - W).value}bp`);
    expect(r.detail.samples[0].chip).not.toContain("Δ5d");
    // The chip reuses the hover's fitFmt: a %-quoted level's Δ5 reads pp there too, never a relative %.
    const f1 = f1R().detail.samples.at(-1).chip;
    expect(f1).toContain(`Δ5d ${(osc.at(-1).value - osc.at(-1 - W).value).toFixed(2)}pp`);
  });

  it("off by default: lines sit in the shared `.fit-lines` group, the legend clause is its `.fit-toggle`, both styled", () => {
    const svg = bpR().svg;
    expect(svg).toMatch(/<g class="fit-lines">(<line data-fit-zero [^>]*\/>)?<path class="line-trend"/);
    expect(svg).toContain('<button class="fit-toggle" type="button">Δ5d (blue, own scale - value on hover)</button>');
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chart \.fit-lines \{\s*display: none;/);
    expect(css).toMatch(/\.show-fit \.chart \.fit-lines \{\s*display: inline;/);
    // Both chart-hosting pages (index → app.js, /overview → overview.js) wire the one shared switch.
    for (const f of ["app.js", "overview.js"])
      expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), f).toMatch(/^wireFitToggle\(document\);$/m);
  });
});

// A value-only id's stored state is a placeholder GREEN: BOTH layouts must stroke its ribbon neutral,
// never calm. KBE / F8 ride the derived layout (worstDrop / return line), SPY the single one.
describe("value-only ribbon (meta.valueOnly) on the single AND derived layouts", () => {
  const cellFills = (svg) => [...svg.matchAll(/height="[^"]+"\s+fill="([^"]+)"><title>/g)].map((m) => m[1]);
  const pts = Array.from({ length: 60 }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 100 - i / 4, "GREEN", { decision: -0.05 }));
  it.each([
    ["SPY", false],
    ["KBE", true],
    ["F8", true],
  ])("%s: gray cells with valueOnly, state-green without (derived layout = %s)", (id, derived) => {
    const on = genericDetailChart(metaFor(id, { valueOnly: true }), pts, {}).svg;
    const off = genericDetailChart(metaFor(id), pts, {}).svg;
    expect(/class="line-derived"/.test(on), `${id} layout`).toBe(derived);
    expect(cellFills(off).length).toBeGreaterThan(0);
    expect(new Set(cellFills(off))).toEqual(new Set(["var(--state-green)"]));
    expect(new Set(cellFills(on))).toEqual(new Set(["var(--ink-dim)"]));
  });

});

// Value XDEV's toggle overlays (user ask 2026-10-10): the 60-close high, the three € zone lines, the veto-day
// dots and RV10 (own fit scale) — all hidden in the shared `.fit-lines` group behind the Δ5 `.fit-toggle`.
describe("Value XDEV toggle overlays", () => {
  const c = XDEV_GATE_DESCRIPTOR.scorer.constants;
  // A gently oscillating EUR close (σ of daily log returns ≈ 0.5%) with two −6% days well past the lead.
  const BREACH = [150, 175];
  const closes = [];
  for (let i = 0; i < 200; i++) closes.push(i === 0 ? 100 : closes[i - 1] * (BREACH.includes(i) ? 0.94 : 1 + 0.006 * Math.sin(i * 1.7)));
  const xpts = closes.map((v, i) => pt(`d${String(i).padStart(3, "0")}`, v, "GREEN"));
  const group = (svg) => svg.match(/<g class="fit-lines">([\s\S]*?)<\/g>/)?.[1] ?? "";
  const ticks = (svg) => [...svg.matchAll(/class="axis-y[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
  const xdevR = once(() => genericDetailChart(metaFor("XDEV"), xpts, {}));
  const xdevBare = once(() => {
    const meta = metaFor("XDEV");
    return genericDetailChart({ ...meta, chart: { ...meta.chart, series: meta.chart.series.filter((s) => !s.toggle && !s.fit) } }, xpts, {});
  });

  // Zone scales (1 − the descriptor cut) and the lead are chart-rail.test.ts's TOGGLE_OVERLAYS rows.
  it("only XDEV, EU-Fin, MU, the HY MA200 ids, Semis SEC0 and MOVE (median) carry toggle overlays among ALL_INDICATORS; XDEV's zones are amber/amber/red steps, each labelled off its descriptor cut", () => {
    for (const i of ALL_INDICATORS) {
      const spec = buildIndicatorChart(i);
      const tog = spec.series.filter((s) => s.toggle || s.cut || s.style === "dots" || s.compute === "vetoBreach");
      expect(tog.length, i.id).toBe({ XDEV: 5, LEGP_EUFIN: 2, LEGP_SEMIS: 1, F8: 1, F1: 1, CCC: 1, R6: 1 }[i.id] ?? 0);
    }
    const spec = buildIndicatorChart(byId("XDEV"));
    expect(spec.renderer).toBe("single"); // only `genericSingle` splits `fit` out (XDEV carries RV10)
    const zones = spec.series.filter((s) => s.cut && s.compute === "high60");
    expect(zones.map((s) => [s.cut.level, s.cut.style, s.style])).toEqual([
      ["amber", "approach", "step"],
      ["amber", undefined, "step"],
      ["red", undefined, "step"],
    ]);
    expect(zones.map((s) => s.label)).toEqual(
      [["T1", c.zoneOpen], ["T2", c.zoneT2], ["T3", c.zoneT3]].map(([t, cut]) => `${t} zone (${+(1 - cut).toFixed(6)} × ${c.highWindow}-close high)`),
    );
    expect(spec.series.filter((s) => s.toggle && !s.cut).map((s) => [s.compute, s.style])).toEqual([["high60", "step"]]);
    const rv = spec.series.filter((s) => s.fit);
    expect(rv.map((s) => [s.compute, s.label, s.toggle])).toEqual([["rv10", `RV${c.rvWindow}`, undefined]]);
  });

  it("vetoBreach marks the close exactly on the days the log return sits under the −σ cap", () => {
    const b = SERIES_HOOKS.vetoBreach(xpts);
    const hit = b.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
    expect(hit).toEqual(BREACH);
    for (const i of hit) expect(b[i]).toBe(closes[i]);
  });

  it("every overlay draws inside the hidden `.fit-lines` group and never moves the € axis; legend clauses are `.fit-toggle`s", () => {
    const [r, bare] = [xdevR(), xdevBare()];
    const g = group(r.svg);
    const outside = r.svg.replace(g, "");
    expect(outside).not.toMatch(/line-toggle|toggle-dot|line-trend/);
    expect((g.match(/<path class="line-toggle"/g) ?? []).length).toBe(4); // high60 + three zones
    expect(g).toMatch(/<path class="line-toggle"[^>]*stroke="var\(--state-amber\)"[^>]*stroke-dasharray="1 3" opacity=".5"/);
    expect(g).toMatch(/<path class="line-toggle"[^>]*stroke="var\(--state-red\)"/);
    expect(g).toMatch(/<path class="line-trend"[^>]*stroke="var\(--trend-line\)"/); // RV10 on its own fit scale
    expect(ticks(r.svg)).toEqual(ticks(bare.svg));
    // One red dot per breach day, at that day's x.
    const cx = [...g.matchAll(/<circle class="toggle-dot" cx="([^"]+)"[^>]*fill="var\(--state-red\)"/g)].map((m) => +m[1]);
    expect(cx).toEqual(BREACH.map((i) => +r.detail.samples[i].x.toFixed(1)));
    expect(bare.svg).not.toContain("fit-lines");
    const buttons = [...r.svg.matchAll(/<button class="fit-toggle[^"]*" type="button">([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toHaveLength(2);
    expect(buttons[1]).toBe(`RV${c.rvWindow} (blue, own scale - value on hover)`);
    // The full roster rides the toggle key's wrapper `title`; every zone in frame ⇒ no "(below frame)" note.
    const title = r.svg.match(/<span title="([^"]*)"><button class="fit-toggle tog-key"/)?.[1] ?? "";
    expect(title).toContain(`T1 zone (${+(1 - c.zoneOpen).toFixed(6)} × ${c.highWindow}-close high) (amber dotted)`);
    expect(title).toContain("red dots");
    expect(title).not.toContain("frame)");
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chart \.line-toggle,\s*\.chart \.toggle-dot \{/);
  });

  it("the toggle key is a short one-line label in neutral ink, the RV10 fit button untouched", () => {
    const r = xdevR();
    expect(r.svg).toContain('<button class="fit-toggle tog-key" type="button">zones · veto days</button>');
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.fit-toggle\.tog-key \{\s*color: var\(--ink\);/);
    expect(r.svg).toContain(`<button class="fit-toggle" type="button">RV${c.rvWindow} (blue, own scale - value on hover)</button>`);
  });

  it("a zone whose newest level sits off-frame gets a ▼ edge marker inside `.fit-lines` and keeps its legend name; in-frame zones get none", () => {
    const edgeMarks = (svg) =>
      [...group(svg).matchAll(/<text class="band-marker"[^>]*fill="([^"]+)">([▼▲])<\/text>\s*<text class="band-label"[^>]*>([^<]*)</g)].map((m) => [m[2], m[1], m[3]]);
    // Default fixture: the −6% days drag the frame down past every zone ⇒ all three draw, no marker.
    const inFrame = xdevR();
    expect(inFrame.svg).not.toContain("band-marker");
    // Calm closes (±<1%): the frame hugs the price, so every zone (≥ 3% under the 60-close high) is below it.
    const calm = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.004 * Math.sin(i * 1.7)));
    const cpts = calm.map((v, i) => pt(`d${String(i).padStart(3, "0")}`, v, "GREEN"));
    const meta = metaFor("XDEV");
    const r = genericDetailChart(meta, cpts, {});
    const high = SERIES_HOOKS.high60(cpts).at(-1);
    const fmt = (v) => formatValue(v, meta.unit);
    expect(edgeMarks(r.svg)).toEqual([
      ["▼", "var(--state-amber)", `T1 zone ${fmt(high * +(1 - c.zoneOpen).toFixed(6))}`],
      ["▼", "var(--state-amber)", `T2 zone ${fmt(high * +(1 - c.zoneT2).toFixed(6))}`],
      ["▼", "var(--state-red)", `T3 zone ${fmt(high * +(1 - c.zoneT3).toFixed(6))}`],
    ]);
    expect(r.svg.replace(group(r.svg), "")).not.toContain("band-marker"); // hidden with the lines, never on the default chart
    const title = r.svg.match(/<span title="([^"]*)"><button class="fit-toggle tog-key"/)?.[1] ?? "";
    expect(title).toContain(`T3 zone (${+(1 - c.zoneT3).toFixed(6)} × ${c.highWindow}-close high) (red dashed) (below frame)`);
    expect(r.svg).toContain('<button class="fit-toggle tog-key" type="button">zones</button>'); // calm ⇒ no veto day to name
  });

  it("RV10's hover + chip value prints as an annualised percent; the € overlays add no chip term", () => {
    const r = xdevR();
    const rv = SERIES_HOOKS.rv10(xpts).at(-1);
    const last = r.detail.samples.at(-1);
    expect(last.chip).toContain(`RV${c.rvWindow} ${formatDerived(rv, "%")}`);
    expect(last.readout).toContain(`RV${c.rvWindow} ${formatDerived(rv, "%")}`);
    expect(last.chip).toMatch(/RV10 \d+\.\d%/);
    expect(last.chip).not.toMatch(/zone|high/);
    expect(last.fitYs.length).toBeGreaterThan(1); // the hidden lines' y's ride `fitYs`, never `ys`
    // …and never leak into the always-on `ys` (the default chip dodge): every sample matches the bare render.
    expect(r.detail.samples.map((s) => s.ys)).toEqual(xdevBare().detail.samples.map((s) => s.ys));
  });
});

// EU-Fin EXSH (user ask 2026-10-11): RV20 + MA50 + MA200 ride RV10's toggle, each its own hue; RV10 and RV20 pool ONE fit scale.
describe("genericDetailChart - LEGP_EUFIN trend overlays", () => {
  // Calm, then a loud stretch, then calm: RV10 swings wider than RV20, so pooled vs own scales tell apart.
  const closes = [];
  for (let i = 0; i < 300; i++) closes.push(i === 0 ? 100 : closes[i - 1] * (1 + (i > 230 && i < 250 ? 0.03 : 0.004) * Math.sin(i * 1.7)));
  const xpts = closes.map((v, i) => pt(`d${String(i).padStart(3, "0")}`, v, "GREEN"));
  const group = (svg) => svg.match(/<g class="fit-lines">([\s\S]*?)<\/g>/)?.[1] ?? "";
  const ys = (svg, stroke) => {
    const d = svg.match(new RegExp(`<path class="line-trend" d="([^"]+)"[^>]*stroke="${stroke.replace(/[()]/g, "\\$&")}"`))?.[1] ?? "";
    return [...d.matchAll(/[ML]\s*[\d.]+[ ,]([\d.]+)/g)].map((m) => Number(m[1]));
  };
  const span = (a) => Math.max(...a) - Math.min(...a);
  const eufinR = once(() => genericDetailChart(metaFor("LEGP_EUFIN"), xpts, {}));

  it("all four lines hide in the toggle group, each in its own hue", () => {
    const g = group(eufinR().svg);
    const strokes = [...g.matchAll(/<path class="line-(?:trend|toggle)"[^>]*stroke="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(strokes).toEqual(["var(--trend-line)", "var(--trend-line-2)", "var(--trend-line-cyan)", "var(--trend-line-white)"].sort());
  });

  it("RV10 and RV20 share one fitted scale — RV20's calmer line spans less height than RV10's", () => {
    const svg = eufinR().svg;
    const [rv10, rv20] = [ys(svg, "var(--trend-line)"), ys(svg, "var(--trend-line-cyan)")];
    expect(rv10.length && rv20.length).toBeGreaterThan(0);
    expect(span(rv20)).toBeLessThan(span(rv10) * 0.9);
    expect(svg).toContain("RV20 (cyan, shared RV scale - value on hover)");
  });

  it("RV20, MA50 and MA200 print in the expanded readout only — the chip keeps RV10 alone", () => {
    const last = eufinR().detail.samples.at(-1);
    const [rv10, rv20] = [SERIES_HOOKS.rv10(xpts).at(-1), SERIES_HOOKS.rv20(xpts).at(-1)];
    const [ma50, ma200] = [SERIES_HOOKS.ma50(xpts).at(-1), SERIES_HOOKS.ma200(xpts).at(-1)];
    for (const term of [`RV10 ${formatDerived(rv10, "%")}`, `RV20 ${formatDerived(rv20, "%")}`, `50-day MA ${formatValue(ma50, "€")}`, `200-day MA ${formatValue(ma200, "€")}`])
      expect(last.readout).toContain(term);
    expect(last.chip).toContain(`RV10 ${formatDerived(rv10, "%")}`);
    expect(last.chip).not.toMatch(/RV20|MA/);
  });
});

describe("genericDetailChart - R4 Δ63 + Δ120 on one shared Δ scale with the spit-esc reference", () => {
  // A real yield wobbling ±5bp around 2%: both Δ lines cross 0 and stay far below the +0.75 reference,
  // so an OWN scale per line (or a ref left out of the extent) would stretch each to the full plot height.
  const rpts = Array.from({ length: 300 }, (_, i) => pt(`d${String(i).padStart(3, "0")}`, 2 + 0.05 * Math.sin(i / 15), "GREEN", { delta20: 0.01 }));
  const r4R = once(() => genericDetailChart(metaFor("R4"), rpts, {}));
  const group = (svg) => svg.match(/<g class="fit-lines">([\s\S]*?)<\/g>/)?.[1] ?? "";
  const ys = (svg, stroke) => {
    const d = svg.match(new RegExp(`<path class="line-trend" d="([^"]+)"[^>]*stroke="${stroke.replace(/[()]/g, "\\$&")}"`))?.[1] ?? "";
    return [...d.matchAll(/[ML]\s*[\d.]+[ ,]([\d.]+)/g)].map((m) => Number(m[1]));
  };

  it("the pooled scale keeps both lines low beside a top-of-frame ref line, under ONE zero hairline", () => {
    const g = group(r4R().svg);
    const [d63, d120] = [ys(g, "var(--trend-line)"), ys(g, "var(--trend-line-2)")];
    expect(d63.length && d120.length).toBeGreaterThan(0);
    for (const line of [d63, d120]) expect(Math.min(...line)).toBeGreaterThan(CH.mt + plotH(CH) * 0.5);
    const ref = g.match(/<line data-fit-ref [^>]*y1="([\d.]+)"[^>]*stroke="var\(--trend-line-2\)"/);
    expect(ref).not.toBeNull();
    expect(+ref[1]).toBeLessThan(CH.mt + plotH(CH) * 0.1);
    expect(g.match(/data-fit-zero/g)).toHaveLength(1);
  });

  it("the legend names both lines' shared scale and the reference", () => {
    const svg = r4R().svg;
    expect(svg).toContain("Δ63d (blue, shared Δ scale - value on hover)");
    expect(svg).toContain("Δ120d (orange, shared Δ scale, spit esc +75bp line - value on hover)");
  });

  it("Δ120d prints in the expanded readout only — the chip keeps Δ63d", () => {
    const last = r4R().detail.samples.at(-1);
    expect(last.readout).toMatch(/Δ120d -?[\d.]+/);
    expect(last.chip).toMatch(/Δ63d -?[\d.]+/);
    expect(last.chip).not.toContain("Δ120d");
  });
});

// ── fit toggle (ex-fit-toggle.test.js) ──────────────────────────────────────────────────────────
describe("wireFitToggle", () => {
  const fakeDoc = () => {
    const cls = new Set();
    let onClick;
    return {
      cls,
      click: (hit) => onClick({ target: { closest: (sel) => (hit && sel === ".fit-toggle" ? {} : null) } }),
      addEventListener: (type, fn) => type === "click" && (onClick = fn),
      documentElement: { classList: { toggle: (c) => (cls.has(c) ? cls.delete(c) : cls.add(c)) } },
    };
  };

  it("off by default; a .fit-toggle click flips the root class, any other click leaves it", () => {
    const d = fakeDoc();
    wireFitToggle(d);
    expect(d.cls.has(SHOW_FIT_CLASS)).toBe(false);
    d.click(false);
    expect(d.cls.has(SHOW_FIT_CLASS)).toBe(false);
    d.click(true);
    expect(d.cls.has(SHOW_FIT_CLASS)).toBe(true);
    d.click(true);
    expect(d.cls.has(SHOW_FIT_CLASS)).toBe(false);
  });
});
