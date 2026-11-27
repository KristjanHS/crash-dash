// Render tests for the Zone D detail-chart layer (detail-chart.js). Plain `.js` so vitest's default
// `**/*.test.js` glob collects it while `tsc` ignores it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { detailChart, sampleForDate, splitLegend, pointField, SIDEBAR_W, SERIES_HOOKS, HIGH_WINDOWS, formatLevelDelta, fxPctTerms } from "./detail-chart.js";
import { DISP_CORR, DISP_CORR_P, DISP_CORR_P_WINDOW } from "../src/family-descriptor-rows";
import { expectValid } from "./chart-test-helpers.js";
import { CH, PLOT_W, COMPACT_CH, STACK_CH, STACK_AXIS_X, plotH, axisNameY, RIBBON_H, formatDerived, formatMagnitude, formatValue, esc } from "./chart-primitives.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
// Cross-boundary imports into the TS modules under src/ + api/ are EXTENSIONLESS: vite's
// `.js`→`.ts` extension swap fires only for TypeScript importers, so a plain `.js` test
// must let vite's default resolver pick the `.ts` file (there is no `.js` sibling). This
// file is tsc-ignored (`.js`), so the repo's "`.js` on relative imports" prod convention
// (dev-workflow.md §Import convention) does not apply — that rule guards the Node ESM
// runtime, which never loads this test. FE-side rule: `frontend.md` §"A `public/*.test.js`
// importing a TS module must NOT use a `.js` specifier".
import { ALL_INDICATORS } from "../src/registry";
import { cusumAlarmBound, cusumRedBound } from "../src/domain-legs";
import { buildIndicatorChart } from "../api/indicators";
import { resolveBands } from "../src/threshold-config";
import { POST_INVERSION_BAND, R1_DRAWDOWN_BAND } from "../src/family-descriptor-rows";
import { XDEV_GATE_DESCRIPTOR } from "../src/family-descriptor-rows";
import { T10Y3M_DRAWDOWN } from "../src/registry-fred";
import { VT_AMBER_RATIO, VT_RED_RATIO } from "../src/family-descriptor-rows";
import { decisionAt } from "../src/scorers-core.ts";

// Minimal point factory; per-path extras (decision / delta20 / havenLegs / leg) are
// spread in by each fixture.
const pt = (date, value, state, extra = {}) => ({ date, value, state, ...extra });

const byId = (id) => ALL_INDICATORS.find((i) => i.id === id);
// The real builder spec per render path — fixtures ride the shipped `buildIndicatorChart` output.
const SPEC = Object.fromEntries(["FXH", "F6", "R1", "R3", "VT"].map((id) => [id, buildIndicatorChart(byId(id))]));

describe("detailChart - one representative id per render path", () => {
  it("FXH - bespoke haven-move chart (3 legs + envelope + price 2nd axis)", () => {
    const meta = {
      id: "FXH",
      label: "FX havens (EUR/CHF/JPY bid)",
      unit: "",
      chart: SPEC.FXH,
    };
    const pts = [
      pt("2026-01-02", 1.08, "GREEN", { havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } }),
      pt("2026-01-03", 1.079, "GREEN", { havenLegs: { eur: 0.012, chf: 0.018, jpy: 0.009 } }),
      pt("2026-01-04", 1.071, "AMBER", { havenLegs: { eur: 0.028, chf: 0.031, jpy: 0.015 } }),
      pt("2026-01-05", 1.06, "RED", { havenLegs: { eur: 0.052, chf: 0.061, jpy: 0.04 } }),
    ];
    const eff = { effAmber: 0.02, effRed: 0.05 };
    const r = detailChart(meta, pts, eff);
    expect(r.detail.n).toBe(4);
    expect(r.svg.match(/<path class="line" [^>]*stroke="var\(--ink-dim\)" stroke-width="1" \/>/g)).toHaveLength(3);
    expect(r.svg.match(/<path class="line" [^>]*stroke="var\(--ink\)" stroke-width="2" \/>/g)).toHaveLength(1);
    expect(r.svg).toContain(`>amber ${formatDerived(eff.effAmber, "%")}</text>`);
    expect(r.svg).toContain(`>red ${formatDerived(eff.effRed, "%")}</text>`);
    expect(r.detail.samples[3].readout).toBe("2026-01-05 · EUR 5.2% · CHF 6.1% · JPY 4.0% · worst 6.1% · 1.06 · RED");
    // The dot rides the worst-of envelope on the PRIMARY axis, not the price on ax2: the envelope
    // rises monotonically across the fixture (0.005 → 0.061) while the price FALLS (1.08 → 1.06),
    // so an envelope-borne dotY strictly decreases (higher value = smaller y) where a price-borne
    // one would strictly increase. The price y still occupies the column (`ys` = price + 3 legs +
    // envelope), and the chip carries the three legs after the state letter.
    const dotYs = r.detail.samples.map((s) => s.dotY);
    for (let i = 1; i < dotYs.length; i++) expect(dotYs[i]).toBeLessThan(dotYs[i - 1]);
    expect(r.detail.samples[3].ys).toHaveLength(5);
    expect(r.detail.samples[3].chip).toMatch(/R · EUR \S+ · CHF \S+ · JPY \S+$/);
  });

  it("FXH - a mid-series point without legs reads a leg gap, not warmup", () => {
    const meta = { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", unit: "", chart: SPEC.FXH };
    const pts = [
      pt("2026-01-02", 1.08, "GREEN", { havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } }),
      pt("2026-01-03", 1.071, "AMBER"), // single-date leg gap: no havenLegs, stored state intact
      pt("2026-01-04", 1.06, "RED", { havenLegs: { eur: 0.052, chf: 0.061, jpy: 0.04 } }),
    ];
    const r = detailChart(meta, pts, { effAmber: 0.02, effRed: 0.05 });
    expect(r.detail.samples[1].readout).toContain("leg gap (feed)");
    expect(r.detail.samples[1].readout).toContain("AMBER");
    // The dot rides the envelope, so a leg-gap day has NO dot (a finite price no longer earns one)
    // and the column's occupancy collapses to the price y alone.
    expect(r.detail.samples[1].dotY).toBeNull();
    expect(r.detail.samples[1].ys).toHaveLength(1);
    // Warmup copy is reserved for the no-legs-anywhere fallback; legs exist here.
    expect(r.svg).not.toContain("history accruing");
    expect(r.detail.samples[1].readout).not.toContain("history accruing");
  });

  it("F6 - derived-kind chart (value left, decision + bands on 2nd axis)", () => {
    const meta = {
      id: "F6",
      label: "Semis rel-strength - SMH/SPY vs MA200",
      unit: "",
      derived: { kind: "maSpread", window: 200, amber: null, red: 0, label: "SMH/SPY % vs MA200", unit: "%" },
      chart: SPEC.F6,
    };
    const pts = [
      pt("2026-01-02", 220.5, "GREEN", { decision: 0.03 }),
      pt("2026-01-03", 221.1, "GREEN", { decision: 0.01 }),
      pt("2026-01-04", 218.4, "RED", { decision: -0.06 }),
      pt("2026-01-05", 214.0, "RED", { decision: -0.12 }),
    ];
    const r = detailChart(meta, pts, { effAmber: undefined, effRed: undefined });
    expect(r.detail.n).toBe(4);
    // Value line on the primary axis, ONE derived decision line on ax2 — the derived layout.
    expect([...r.svg.matchAll(/<path class="line" [^>]*>/g)]).toHaveLength(1);
    expect([...r.svg.matchAll(/<path class="line-derived"[^>]*>/g)]).toHaveLength(1);
    // Crosshair-linking contract: every sample carries its point's ISO date.
    expect(r.detail.samples.map((s) => s.date)).toEqual(pts.map((p) => p.date));
  });

  it("R1 - generic level chart (value + level bands on primary axis)", () => {
    const meta = {
      id: "R1",
      label: "Term spread 10y-3m",
      unit: "",
      thresholds: { amberLevel: 0.5, redLevel: 0.0 },
      direction: "LOW",
      chart: SPEC.R1,
    };
    const pts = [
      pt("2026-01-02", 0.82, "GREEN"),
      pt("2026-01-03", 0.61, "GREEN"),
      pt("2026-01-04", 0.44, "AMBER", { leg: "op" }),
      pt("2026-01-05", -0.05, "RED", { leg: "op" }),
    ];
    const r = detailChart(meta, pts, {});
    expect(r.detail.n).toBe(4);
    expect(r.svg).toContain(`>${esc(SPEC.R1.bands.find((b) => b.level === "red").label)}</text>`);
    expect(r.svg).toContain("<title>2026-01-05 RED - via level cut</title>");
    expect(r.detail.samples[3].readout).toBe("2026-01-05 · -0.05 · RED");
    // Crosshair-linking contract: every sample carries its point's ISO date.
    expect(r.detail.samples.map((s) => s.date)).toEqual(pts.map((p) => p.date));
  });

  it("R1 - the 63-obs mean draws as a SECOND primary line, SOLID at --trend-line (scored, not derived)", () => {
    const meta = {
      id: "R1",
      label: "Term spread 10y-3m",
      unit: "",
      thresholds: { amberLevel: 0.5, redLevel: 0.0 },
      direction: "LOW",
      chart: SPEC.R1,
    };
    // redMean carried per point ⇒ the second primary line has data to draw.
    const pts = [
      pt("2026-01-02", 0.82, "GREEN", { redMean: 0.4 }),
      pt("2026-01-03", 0.61, "GREEN", { redMean: 0.2 }),
      pt("2026-01-04", 0.44, "AMBER", { leg: "op", redMean: 0.05 }),
      pt("2026-01-05", -0.05, "RED", { leg: "op", redMean: -0.12 }),
    ];
    const r = detailChart(meta, pts, {});
    // Primary value line stays `class="line"` at --ink; the mean is its own `line-scored` path.
    const scored = [...r.svg.matchAll(/<path class="line-scored"[^>]*>/g)].map((m) => m[0]);
    expect(scored).toHaveLength(1);
    expect(scored[0]).toContain("stroke=\"var(--trend-line)\"");
    expect(scored[0]).toContain('stroke-width="1.25"');
    expect(scored[0]).not.toContain("stroke-dasharray");
    // Both primary lines present: the value line and the scored mean.
    expect([...r.svg.matchAll(/<path class="line" [^>]*>/g)]).toHaveLength(1);
    // Legend names the second line and its hue; the hover reads out its value.
    expect(r.svg).toContain("63-obs mean (blue)");
    expect(r.detail.samples[3].readout).toContain("63-obs mean -0.12");
  });

  it("compact opt-in - squat viewBox + compressed y", () => {
    const meta = {
      id: "R1",
      label: "Term spread 10y-3m",
      unit: "",
      thresholds: { amberLevel: 0.5, redLevel: 0.0 },
      direction: "LOW",
      chart: SPEC.R1,
    };
    const pts = [
      pt("2026-01-02", 0.82, "GREEN"),
      pt("2026-01-03", 0.61, "GREEN"),
      pt("2026-01-04", 0.44, "AMBER", { leg: "op" }),
      pt("2026-01-05", -0.05, "RED", { leg: "op" }),
    ];
    const def = detailChart(meta, pts, {});
    const compact = detailChart(meta, pts, {}, { compact: true });
    expect(def.svg).toContain(`viewBox="0 0 ${CH.w} ${CH.h}"`);
    expect(compact.svg).toContain(`viewBox="0 0 ${COMPACT_CH.w} ${COMPACT_CH.h}"`);
    // Width untouched ⇒ identical sample x; squat plot ⇒ the dot y moves.
    expect(compact.detail.samples.map((s) => s.x)).toEqual(def.detail.samples.map((s) => s.x));
    expect(compact.detail.samples[0].dotY).not.toBe(def.detail.samples[0].dotY);
    // Ribbon height stays RIBBON_H under compact (only the plot squats).
    expect(compact.svg).toContain(`height="${RIBBON_H}"`);

    // The `geo` opt (stack takeover): explicit geometry wins over the compact mapping, the chart's
    // name is rotated into the LEFT MARGIN (no head band — it must cost the stack no height), and
    // the bottom axis-x dates go. The date span rides NOWHERE on the stack any more (dropped from
    // the legend 2026-09-13 — the hover readout carries dates). The stack legend opening with the
    // label ONCE is pinned by the caption-redesign "#1" row below.
    const stack = detailChart(meta, pts, {}, { compact: true, geo: STACK_CH });
    expect(stack.svg).toContain(`viewBox="0 0 ${STACK_CH.w} ${STACK_CH.h}"`);
    expect(stack.svg).toContain('<text class="chart-name" x="11"');
    expect(stack.svg).toContain('transform="rotate(-90 ');
    expect(stack.svg).toContain(`>${meta.label} (${meta.id})</text>`);
    expect(stack.svg).not.toContain(`${pts[0].date} → ${pts[pts.length - 1].date}`);
    expect(stack.svg).not.toContain('class="axis-x"');
    // The PRIMARY axis is named in its own left-margin lane, right of the chart name and pinned to
    // the plot floor (bottom-aligned) — the stack has no caption block to carry it.
    expect(stack.svg).toContain(`<text class="axis-name" transform="rotate(-90 ${STACK_AXIS_X} ${axisNameY(STACK_CH)})"`);
    expect(stack.svg).toContain(`y="${axisNameY(STACK_CH)}">value${meta.unit ? ` (${meta.unit})` : ""}</text>`);
    // Stack-only: the default frame names its PRIMARY axis in the caption/legend above, not in the
    // margin — asserted by its text (R1 is single-axis, so no secondary lane can echo it).
    expect(def.svg).not.toContain(`>value${meta.unit ? ` (${meta.unit})` : ""}</text>`);
    // ...and the default (non-stack) frame keeps the span OFF its legend - the axis prints it.
    expect(def.svg.slice(def.svg.indexOf('<p class="chart-legend"'))).not.toContain(
      `${pts[0].date} → ${pts[pts.length - 1].date}`,
    );
    // The primary-axis clause: `<label>, <unit> (left)` — the side in parens, never a bare word.
    expect(def.svg).toContain(`${meta.label}${meta.unit ? `, ${meta.unit}` : ""} (left)`);
    // Class parity (frontend.md): the head classes resolve in styles.css.
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain(".chart-name");
    // The one pin of the [USER] 2026-08-29 ruling: 9px (11px clipped long names).
    expect(css.match(/^\.chart \.chart-name \{[^}]*\}/m)[0]).toMatch(/font-size: 9px;/);
  });

  it("every render path names its PRIMARY axis in the stack's left margin (and none does off-stack)", () => {
    // `axis1Label` is wired into all four renderers, but the representative-id cases above render
    // on the CH frame, where it is `showHead`-gated to "". Without this, a broken label expression
    // on the fx / fx-degraded / derived paths (the three the R1 stack case does not reach) ships
    // green. Each case asserts the axis-name element AND the label the path resolves.
    const lane = `<text class="axis-name" transform="rotate(-90 ${STACK_AXIS_X} ${axisNameY(STACK_CH)})"`;
    const stackOf = (meta, pts, eff) => detailChart(meta, pts, eff, { geo: STACK_CH }).svg;

    // fx (worst-of haven move on the primary axis)
    const fxMeta = { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", unit: "", chart: SPEC.FXH };
    const fxPts = [
      pt("2026-01-02", 1.08, "GREEN", { havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } }),
      pt("2026-01-05", 1.06, "RED", { havenLegs: { eur: 0.052, chf: 0.061, jpy: 0.04 } }),
    ];
    const fx = stackOf(fxMeta, fxPts, { effAmber: 0.02, effRed: 0.05 });
    expect(fx).toContain(lane);
    // The spec carries NO primary label (asserted, so the fallback below is not a vacuous echo),
    // so the renderer's own default names the axis.
    expect(SPEC.FXH.axes.find((a) => a.id === "primary").label).toBeUndefined();
    expect(fx).toContain(`${axisNameY(STACK_CH)}">haven move</text>`);

    // fx DEGRADED (no havenLegs anywhere ⇒ the price series takes the primary axis)
    const fxFallback = stackOf(
      fxMeta,
      [pt("2026-01-02", 1.08, "GREEN"), pt("2026-01-05", 1.06, "RED")],
      { effAmber: 0.02, effRed: 0.05 },
    );
    expect(fxFallback).toContain(lane);
    expect(fxFallback).toContain("haven-move history accruing"); // really the degraded branch
    // Degraded ⇒ the PRICE series is what the primary axis now carries, and what names it.
    expect(fxFallback).toContain(`${axisNameY(STACK_CH)}">price</text>`);

    // derived (value left, decision on the 2nd axis) — the label is the primary axis' own name
    const f6Meta = {
      id: "F6",
      label: "Semis rel-strength - SMH/SPY vs MA200",
      unit: "",
      derived: { kind: "maSpread", window: 200, amber: null, red: 0, label: "SMH/SPY % vs MA200", unit: "%" },
      chart: SPEC.F6,
    };
    const f6 = stackOf(
      f6Meta,
      [pt("2026-01-02", 220.5, "GREEN", { decision: 0.03 }), pt("2026-01-05", 214.0, "RED", { decision: -0.12 })],
      {},
    );
    expect(f6).toContain(lane);
    expect(f6).toContain(`${axisNameY(STACK_CH)}">${f6Meta.derived.label}</text>`);
    // Two axis names on a two-axis stack chart: primary in the left lane, secondary at `w - 3`.
    expect(f6.match(/class="axis-name"/g)).toHaveLength(2);

    // Off-stack (CH) frames name their axis in the caption block, never in the margin.
    expect(detailChart(f6Meta, [pt("2026-01-02", 220.5, "GREEN", { decision: 0.03 })], {}).svg).not.toContain(lane);

    // Class parity (frontend.md): the emitted class resolves in the sheet, with the anchor that
    // makes the rotated text bottom-aligned (a presentation attribute would lose to `.axis-y`).
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css.match(/^\.chart \.axis-name \{[^}]*\}/m)[0]).toMatch(/text-anchor: start;/);
  });

  it("the travelling chip dates with a 2-digit YEAR; the docked bar keeps the full ISO date", () => {
    const meta = { id: "VT", label: "VIX term structure", unit: "", thresholds: {}, chart: SPEC.VT };
    const pts = [pt("2025-12-31", VT_AMBER_RATIO - 0.05, "GREEN"), pt("2026-01-05", VT_RED_RATIO + 0.07, "RED")];
    const { samples } = detailChart(meta, pts, {}).detail;
    // The century is the ONLY token dropped: a scrub across a multi-year window stays unambiguous
    // ([USER], 2026-08-29 - the old `MM-DD` form did not).
    expect(samples[0].chip.startsWith("25-12-31 ")).toBe(true);
    expect(samples[1].chip.startsWith("26-01-05 ")).toBe(true);
    expect(samples[1].readout.startsWith("2026-01-05 ")).toBe(true);
  });

  it("R3 - generic velocity chart (Δ20 + velocity bands)", () => {
    const meta = {
      id: "R3",
      label: "10y velocity",
      unit: "",
      thresholds: { amberVelocity: 0.4, redVelocity: 0.7 },
      chart: SPEC.R3,
    };
    const pts = [
      pt("2026-01-02", 4.1, "GREEN", { delta20: 0.12 }),
      pt("2026-01-03", 4.25, "GREEN", { delta20: 0.28 }),
      pt("2026-01-04", 4.55, "AMBER", { delta20: 0.48, leg: "vel-op" }),
      pt("2026-01-05", 4.9, "RED", { delta20: 0.78, leg: "vel-op" }),
    ];
    const r = detailChart(meta, pts, {});
    expect(r.detail.n).toBe(4);
    // ONE primary line, plotted from delta20 (not value): the state-worst days read their state.
    expect([...r.svg.matchAll(/<path class="line" [^>]*>/g)]).toHaveLength(1);
    expect(r.detail.samples[2].readout).toContain("AMBER");
    expect(r.detail.samples[3].readout).toContain("RED");
    expect(r.detail.samples.map((s) => s.date)).toEqual(pts.map((p) => p.date));
  });

  it("VT - display-band overlay chart (ratio value + the inclusive-amber / strict-red band pair)", () => {
    const meta = {
      id: "VT",
      label: "VIX term structure",
      unit: "",
      thresholds: {},
      chart: SPEC.VT,
    };
    // One point per band, DERIVED from the shipped pair so a VT retune keeps each point in the
    // band its state names (the states are supplied, not scored — this is a RENDER pin).
    const pts = [
      pt("2026-01-02", VT_AMBER_RATIO - 0.05, "GREEN"),
      pt("2026-01-03", VT_AMBER_RATIO - 0.02, "GREEN"),
      pt("2026-01-04", (VT_AMBER_RATIO + VT_RED_RATIO) / 2, "AMBER"),
      pt("2026-01-05", VT_RED_RATIO + 0.07, "RED"),
    ];
    const r = detailChart(meta, pts, {});
    expect(r.detail.n).toBe(4);
    // Both display-band cuts draw with their spec labels, DERIVED from the shipped pair.
    expect(r.svg).toContain(`amber ≥${VT_AMBER_RATIO.toFixed(2)}`);
    expect(r.svg).toContain(`red &gt;${VT_RED_RATIO.toFixed(2)}`); // `>` rides HTML-escaped in the SVG
    expect(r.detail.staticYs).toHaveLength(2);
    expect(r.detail.samples.map((s) => s.date)).toEqual(pts.map((p) => p.date));
  });
});

// ---------------------------------------------------------------------------
// Real-builder-spec render smoke over EVERY ALL_INDICATORS id: `detailChart` is now
// a thin wrapper delegating to `genericDetailChart` (the old bespoke per-id renderers
// were deleted once parity was proven), so a self-parity assertion would be a
// tautology. Instead this exercises the generic renderer end-to-end on the SHARED
// `buildIndicatorChart` spec per category and asserts a real { svg, detail } contract
// (valid SVG + legend + well-formed pointer seam) — a per-category renderer crash or
// empty output fails here.
// ---------------------------------------------------------------------------

// Replicates api/indicators.ts `scaleDerived` (module-private) so the legacy
// `meta.derived` is the SAME resolved descriptor the chart spec's baked `derived`
// bands come from (both single-sourced through resolveBands) — else a tuned id
// (F6/F8) would diverge from its own spec band.
function scaleDerived(d, id) {
  if (!d) return d;
  const { amber, red } = resolveBands(id, d.amber, d.red);
  return amber === d.amber && red === d.red ? d : { ...d, amber, red };
}

// Build a realistic `meta` for one indicator: the wire-edge legacy fields the bespoke
// renderer dispatches on, plus the declarative `chart` from the shared builder.
function buildMeta(i) {
  return {
    id: i.id,
    label: i.label,
    unit: i.unit ?? "%", // mirror api/indicators.ts wire-edge materialization
    cadence: i.cadence,
    direction: i.direction,
    thresholds: i.thresholds,
    derived: scaleDerived(i.derived, i.id),
    chart: buildIndicatorChart(i),
  };
}

// Four distinct rows carrying every point field any category might reference; each
// fixture keeps only the fields its spec's series actually plot (category-appropriate).
const ROWS = [
  { date: "2026-01-02", value: 220.5, state: "GREEN", delta20: 0.12, decision: 0.03, havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } },
  { date: "2026-01-03", value: 221.1, state: "GREEN", delta20: 0.28, decision: 0.01, havenLegs: { eur: 0.012, chf: 0.018, jpy: 0.009 } },
  { date: "2026-01-04", value: 218.4, state: "AMBER", decision: -0.06, delta20: 0.48, havenLegs: { eur: 0.028, chf: 0.031, jpy: 0.015 }, leg: "op" },
  { date: "2026-01-05", value: 214.0, state: "RED", decision: -0.12, delta20: 0.78, havenLegs: { eur: 0.052, chf: 0.061, jpy: 0.04 }, leg: "op" },
];

// Which point fields the spec's series reference (drives category-appropriate points).
function fieldsUsed(spec) {
  const uses = new Set();
  for (const s of spec.series) {
    if (s.compute === "havenEnvelope" || s.fromPoint?.startsWith("havenLegs.")) uses.add("havenLegs");
    else if (s.fromPoint) uses.add(s.fromPoint);
  }
  return uses;
}

// A `trailingReturn` primary reads `value` over `window` prior rows: lead in with that many, or it is warmup-only.
const warmupLead = (spec) => Math.max(0, ...spec.series.filter((s) => s.compute === "trailingReturn").map((s) => s.window));

function fixturePts(spec) {
  const uses = fieldsUsed(spec);
  const lead = warmupLead(spec);
  if (lead > 0) uses.add("value");
  const leadRows = Array.from({ length: lead }, (_, k) => ({ date: `2025-12-${String(k + 1).padStart(2, "0")}`, value: 220 + k / 10, state: "GREEN" }));
  return [...leadRows, ...ROWS].map((r) => {
    const p = { date: r.date, state: r.state };
    if (uses.has("value")) p.value = r.value;
    if (uses.has("delta20")) p.delta20 = r.delta20;
    if (uses.has("decision")) p.decision = r.decision;
    if (uses.has("havenLegs")) p.havenLegs = r.havenLegs;
    if (r.leg) p.leg = r.leg;
    return p;
  });
}

// One smoke row per distinct meta shape (numbers zeroed, copy dropped); the title lists every id it stands for.
const SHAPE_COPY = /label|title|caption|note|legend|name|tip/i;
const shapeKey = (meta) =>
  JSON.stringify({ ...meta, id: undefined }, (k, v) =>
    typeof v === "number" ? 0 : typeof v === "string" && k === "fromDate" ? "D" : typeof v === "string" && SHAPE_COPY.test(k) ? undefined : v,
  );
const SHAPES = [...Map.groupBy(ALL_INDICATORS.map(buildMeta), shapeKey).values()];

describe("detailChart renders every ALL_INDICATORS spec shape (valid SVG + detail seam)", () => {
  for (const metas of SHAPES) {
    it(`${metas.map((m) => m.id).join(" ")} - real builder spec renders a valid { svg, detail } with a finite ys seam`, () => {
      const meta = metas[0];
      const spec = meta.chart;
      const pts = fixturePts(spec);

      // eff per category: FXH bands ride the effective envelope. Case 3 — bands may be the
      // "context-only" sentinel (unbanded ids); treat it as empty here.
      const bandsArr = Array.isArray(spec.bands) ? spec.bands : [];
      const isFx = bandsArr.some((b) => b.source === "effective");
      let eff = {};
      if (isFx) eff = { effAmber: 0.02, effRed: 0.05 };

      const r = detailChart(meta, pts, eff);
      expectValid(r, pts.length);

      // ys seam (S3): every drawn line's y rides each sample — a non-empty ys carrying dotY,
      // never a null/NaN (universal across FX legs, derived trends, single overlays, R7 cuts).
      const { samples } = r.detail;
      expect(samples.length).toBeGreaterThan(0);
      for (const s of samples) {
        expect(Array.isArray(s.ys)).toBe(true);
        for (const y of s.ys) expect(Number.isFinite(y)).toBe(true);
        // A finite-primary sample rides its dotY in ys; a null-primary sample (F13 warmup) carries
        // dotY:null and omits it (S4 phantom-dot fix) — its other drawn lines may still fill ys.
      }
      const dotted = samples.filter((s) => Number.isFinite(s.dotY));
      expect(dotted.length).toBeGreaterThan(0);
      for (const s of dotted) {
        expect(s.ys.length).toBeGreaterThan(0);
        expect(s.ys).toContain(s.dotY);
      }
      // The warm-up lead rows have no prior to return over: each is a null-primary sample whose dotY is
      // null, never NaN or a plot-floor y (the phantom-dot fix). A lead-free shape may still carry none.
      const undotted = samples.filter((s) => !Number.isFinite(s.dotY));
      expect(undotted.length).toBeGreaterThanOrEqual(warmupLead(spec));
      for (const s of undotted) expect(s.dotY).toBeNull();
      expect(Array.isArray(r.detail.staticYs)).toBe(true);
      for (const y of r.detail.staticYs) expect(Number.isFinite(y)).toBe(true);
    });
  }

  it("at least one shape carries warm-up lead rows, so the null-dotY partition above is exercised", () => {
    expect(SHAPES.some((metas) => warmupLead(metas[0].chart) > 0)).toBe(true);
  });
});

describe("phantom dotY suppressed at a null-primary sample (S4)", () => {
  // A null primary value would otherwise map to a FINITE plot-floor y (yAt(null) ≠ NaN), painting a
  // phantom crosshair dot over a data gap and poisoning parkY's floor band. dotY must be null there
  // and contribute nothing to ys.
  it("a null-primary sample carries dotY:null and no null/NaN in ys", () => {
    const meta = buildMeta(ALL_INDICATORS.find((i) => i.id === "F6"));
    const pts = [
      pt("2026-01-02", 220.5, "GREEN", { decision: 0.1 }),
      pt("2026-01-03", null, "GREEN", { decision: 0.1 }),
      pt("2026-01-04", 218.4, "AMBER", { decision: 0.1 }),
    ];
    const { samples } = detailChart(meta, pts, {}).detail;
    const gap = samples.find((s) => s.date === "2026-01-03");
    expect(gap.dotY).toBeNull();
    expect(gap.ys).not.toContain(null);
    for (const y of gap.ys) expect(Number.isFinite(y)).toBe(true);
    // The finite-primary neighbours keep a real dotY that rides ys (the S3 invariant is intact).
    const live = samples.find((s) => s.date === "2026-01-02");
    expect(Number.isFinite(live.dotY)).toBe(true);
    expect(live.ys).toContain(live.dotY);
  });
});

describe("detailChart - degrade / null-gap edge paths", () => {
  it("FXH fallback - no point carries havenLegs (old payload) ⇒ lone price line, history-accruing legend", () => {
    const meta = buildMeta(ALL_INDICATORS.find((i) => i.id === "FXH"));
    const pts = [
      pt("2026-01-02", 1.08, "GREEN"),
      pt("2026-01-03", 1.079, "GREEN"),
      pt("2026-01-04", 1.071, "AMBER"),
      pt("2026-01-05", 1.06, "RED"),
    ];
    const r = detailChart(meta, pts, { effAmber: 0.02, effRed: 0.05 });
    expectValid(r, 4);
    // Degrade marker: the legs axis collapses to the lone EURUSD=X price series with
    // an explicit "history accruing" note (detail-chart.js FXH fallback branch).
    expect(r.svg).toContain("EURUSD=X price");
    expect(r.svg).toContain("haven-move history accruing");
  });

  it("derived null-decision - every decision is null ⇒ derived line degrades to history-accruing", () => {
    const meta = buildMeta(ALL_INDICATORS.find((i) => i.id === "F6"));
    const pts = [
      pt("2026-01-02", 220.5, "GREEN", { decision: null }),
      pt("2026-01-03", 221.1, "GREEN", { decision: null }),
      pt("2026-01-04", 218.4, "AMBER", { decision: null }),
      pt("2026-01-05", 214.0, "RED", { decision: null }),
    ];
    const r = detailChart(meta, pts, {});
    expectValid(r, 4);
    // A latest-null derived readout renders the "— history accruing" degrade (no live
    // value baked into the legend), and every sample readout stays a string.
    expect(r.svg).toContain("history accruing");
  });

  it("meta without a chart spec (stale cached payload / un-mirrored mock) degrades, not throws", () => {
    // Review CRITICAL: pre-guard, `genericDetailChart` dereferenced `spec.axes` unguarded,
    // so a payload predating the chart API (or a mock meta without `chart`) crashed the
    // whole detail tab. Now it renders a harmless message + an EMPTY detail seam.
    const meta = { id: "F1", label: "HY OAS", unit: "%", thresholds: { amberLevel: 4.5, redLevel: 6.0 } };
    const pts = [pt("2026-01-02", 3.5, "GREEN"), pt("2026-01-03", 3.6, "GREEN")];
    const r = detailChart(meta, pts, {});
    expect(r.svg).toContain("chart spec unavailable");
    expect(r.svg).toContain("HY OAS"); // Addendum C: the message names the LABEL, not the bare id (Rule 2)
    expect(r.detail).toEqual({ n: 0, samples: [], staticYs: [] });
  });
});

// --- OVX: the scalar LEVEL pair on the derived layout ---------------------------------
// OVX scores level-OR-spike, so its spec carries a primary `threshold` pair beside the
// secondary spike pair. `genericDerived` resolved only perPoint + secondary bands, so the
// level cuts were in the spec and on no pixel — the chart showed one leg of an OR.
describe("OVX's primary level pair reaches the chart (derived layout)", () => {
  const OVX = ALL_INDICATORS.find((i) => i.id === "OVX");
  const spec = buildIndicatorChart(OVX);
  const level = spec.bands.filter((b) => b.source === "threshold" && b.axis === "primary");
  const cell = { amberLevel: OVX.thresholds.amberLevel, redLevel: OVX.thresholds.redLevel };
  const meta = { id: "OVX", label: OVX.label, unit: OVX.unit ?? "", derived: OVX.derived, chart: spec, thresholds: OVX.thresholds };

  it("the spec really carries a primary level pair AND a secondary spike pair", () => {
    expect(level.map((b) => b.level)).toEqual(["amber", "red"]);
    expect(spec.bands.filter((b) => b.axis === "secondary").map((b) => b.level)).toEqual(["amber", "red"]);
  });

  // Values BRACKET the cell pair, so amber sits inside the plotted domain (a drawn line) and
  // red above it (the ▲ edge marker) — both visible forms in one render.
  const pts = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"].map((date, k) => ({
    date,
    value: cell.amberLevel - 3 + k * 2,
    decision: 0.01 * k,
    state: k > 2 ? "AMBER" : "GREEN",
  }));
  const { svg } = detailChart(meta, pts, {});

  it("draws the primary level cuts - in-domain as a line, off-domain as an edge marker", () => {
    // The MARKUP, not the legend: a band-label per cut, one drawn line, one ▲ edge marker.
    const labels = [...svg.matchAll(/<text class="band-label"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toContain(`amber ${cell.amberLevel}`);
    expect(labels).toContain(`red ${cell.redLevel}`);
    expect(svg).toContain("▲");
    expect(svg).toContain(`level amber ${cell.amberLevel} · red ${cell.redLevel}`);
  });
});

// --- R1: per-point (moving) primary band cuts on the derived layout -------------------
// CG gained a PRIMARY amber/red pair (`source:"perPoint"`, drawn from each point's
// `bandCuts`) alongside its existing SECONDARY derived pair. `genericDerived` reconstructs
// the secondary-axis descriptor by finding the amber/red bands in `spec.bands`, and
// chart-rail pushes the primary bands FIRST — so a lookup by LEVEL alone returns the
// primary band, whose `value` is absent (the value is per-point), and the right-axis cut
// silently vanishes from the chart. The axis filter is what keeps the two pairs apart.
describe("perPoint primary bands do not hijack the secondary axis (CG)", () => {
  const CG = ALL_INDICATORS.find((i) => i.id === "CG");
  const spec = buildIndicatorChart(CG);
  const perPoint = spec.bands.filter((b) => b.source === "perPoint" && b.axis === "primary");
  const secondary = spec.bands.filter((b) => b.axis === "secondary");

  // Vacuity floor: the whole case is about an id carrying BOTH pairs at once.
  it("CG's spec really carries a primary perPoint pair AND a secondary derived pair", () => {
    expect(perPoint.map((b) => b.level)).toEqual(["amber", "red"]);
    expect(secondary.map((b) => b.level)).toEqual(["amber", "red"]);
    // The primary pair carries NO scalar — its value is the per-point series.
    for (const b of perPoint) expect(b.value).toBeUndefined();
  });

  const meta = { id: "CG", label: CG.label, unit: CG.unit ?? "%", derived: CG.derived, chart: spec };
  // The cuts must sit INSIDE the plotted value domain to be drawn at all — a cut below the
  // window's own minimum is dropped by design (a band must never drag the y-domain), which is
  // also the regime where the ratio has NOT dipped to its percentile. So the fixture puts the
  // value line down onto its cuts, the interesting case. The LAST point drops `levelRed`
  // to exercise the missing-key gap.
  const pts = [
    { date: "2026-01-02", value: 0.00195, decision: 0.004, state: "GREEN", bandCuts: { levelAmber: 0.00191, levelRed: 0.0019 } },
    { date: "2026-01-03", value: 0.00193, decision: -0.006, state: "AMBER", bandCuts: { levelAmber: 0.001909, levelRed: 0.001899 } },
    { date: "2026-01-04", value: 0.00189, decision: -0.03, state: "RED", bandCuts: { levelAmber: 0.001908, levelRed: 0.001898 } },
    { date: "2026-01-05", value: 0.0019, decision: -0.01, state: "AMBER", bandCuts: { levelAmber: 0.001907 } },
  ];
  const { svg } = detailChart(meta, pts, {});
  // Newest finite cut for a wire key, read off the fixture itself.
  const newestCut = (key) =>
    [...pts].reverse().map((p) => p.bandCuts?.[key]).find((v) => typeof v === "number");

  it("the SECONDARY readout still renders the secondary pair's own cuts", () => {
    // The auto label secondaryAxis composes for a band with no spec `label`. With the axis
    // filter removed, `dAmber`/`dRed` resolve off the PRIMARY perPoint bands, whose `value`
    // is undefined ⇒ both bands are filtered out and NEITHER string appears.
    for (const b of secondary) {
      expect(svg, `secondary ${b.level} cut label`).toContain(`${b.level} ${formatDerived(b.value, spec.axes[1].unit)}`);
    }
  });

  it("each perPoint band draws its own gap-broken dashed cut path", () => {
    const paths = [...svg.matchAll(/<path class="band-cut"[^>]*>/g)].map((m) => m[0]);
    expect(paths).toHaveLength(perPoint.length);
    expect(paths.some((p) => p.includes("var(--state-amber)"))).toBe(true);
    expect(paths.some((p) => p.includes("var(--state-red)"))).toBe(true);
    for (const p of paths) expect(p).toContain('stroke-dasharray="4 3"');
    // The composed label reaches the legend (the p-percentile text chart-rail built),
    // HTML-escaped like every other legend segment, with the LATEST cut rendered through the
    // magnitude rule — a bare 2dp would print the false "0.00" for a ratio this small.
    // DERIVED, never transcribed: the label comes from the spec (whose percentile text is
    // composed off `CG_DESCRIPTOR.levelBand`) and the number from the fixture's own newest
    // cut, so a retune of either moves this expectation with it.
    for (const b of perPoint) {
      expect(svg).toContain(`${b.label.replace(/</g, "&lt;")} now ${formatMagnitude(newestCut(b.fromPoint))}`);
    }
  });

  it("a point missing a cut key is a GAP, never a band at 0", () => {
    // levelRed is absent on the last point; a `0` there would sit far below the plotted
    // domain and the path would still be one unbroken run. The red path must therefore be
    // SHORTER (fewer points) than the amber one, which is present on all four.
    const redPath = svg.match(/<path class="band-cut"[^>]*var\(--state-red\)[^>]*d="([^"]*)"/)?.[1]
      ?? svg.match(/<path class="band-cut" d="([^"]*)"[^>]*var\(--state-red\)/)?.[1];
    const amberPath = svg.match(/<path class="band-cut" d="([^"]*)"[^>]*var\(--state-amber\)/)?.[1];
    expect(amberPath, "amber cut path parsed out of the SVG").toBeTruthy();
    expect(redPath, "red cut path parsed out of the SVG").toBeTruthy();
    const count = (d) => d.split(/[ML]/).filter(Boolean).length;
    expect(count(redPath)).toBe(pts.length - 1);
    expect(count(amberPath)).toBe(pts.length);
  });

  // A perPoint cut pinned ENTIRELY outside the plotted domain used to vanish twice over — no
  // line (correct: it must not drag the y-domain) AND no legend segment (wrong: the reader
  // then cannot tell "no cut computed" from "cut below the plotted range" from "broken").
  // This is the COMMON regime for CG: the level leg is meant to fire on a minority of days, so on
  // a typical window the ratio sits above both of its own expanding cuts (the descriptor's
  // `amberP`/`redP`) and both are below the frame.
  describe("a perPoint cut outside the plotted domain keeps an edge marker and a legend segment", () => {
    const offPts = pts.map((p, i) => ({
      ...p,
      value: 0.0025 + i * 0.00001, // the value line lifted clear ABOVE both cuts
      bandCuts: p.bandCuts,
    }));
    const { svg: offSvg } = detailChart(meta, offPts, {});

    it("draws no cut LINE (the band must not drag the y-domain)", () => {
      expect(offSvg).not.toContain('class="band-cut"');
    });

    it("emits the ▼ edge marker the scalar-band path uses", () => {
      const markers = [...offSvg.matchAll(/<text class="band-marker"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      // One per perPoint band whose newest cut is finite; levelRed is absent on the LAST point
      // but present earlier, so both bands still report a value.
      expect(markers).toHaveLength(perPoint.length);
      for (const m of markers) expect(m).toBe("▼");
    });

    it("keeps each cut's legend segment, marked as off-plot", () => {
      for (const b of perPoint) {
        expect(offSvg).toContain(
          `${b.label.replace(/</g, "&lt;")} now ${formatMagnitude(newestCut(b.fromPoint))} (below plot)`,
        );
      }
      // ...and does NOT claim a dashed line the reader cannot find.
      expect(offSvg).not.toContain("(left, dashed)");
    });
  });
});

// --- Stage A: the legend may not promise dashed cut lines the axis does not carry ------
// F9 names two scorer legs (`vel-z` + `vel-cusum`) and its σ cuts are per-point moving
// values that regularly sit OUTSIDE the plotted Δ60 domain — a band must never drag the
// y-domain (D0-a), so on those windows zero cut paths are drawn while the legend still
// read "; dashed lines = the exact cuts it scores against". The claim is composed from the
// drawn-cut COUNT, so the two fixtures below differ only in where the cuts sit.
describe("scorer legend only promises dashed cut lines when a cut was actually drawn", () => {
  const F9 = ALL_INDICATORS.find((i) => i.id === "F9");
  const spec = buildIndicatorChart(F9);
  const meta = { id: "F9", label: F9.label, unit: F9.unit ?? "", thresholds: F9.thresholds, chart: spec };
  const eff = { effAmber: 1, effRed: 2, scorerLegs: ["vel-z", "vel-cusum"], confirmCloses: 0 };
  const DATES = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  // Δ60 values span 0.10…0.13; cut placement is the ONLY difference between the two runs.
  const build = (amberCut, redCut) =>
    DATES.map((date, i) => ({
      date,
      value: 0.1 + i * 0.01,
      delta20: 0.1 + i * 0.01,
      state: "AMBER",
      leg: "vel-cusum",
      bandCuts: { velSigmaAmber: amberCut, velSigmaRed: redCut },
    }));
  const PROMISE = "dashed lines = the exact cuts it scores against";

  // Vacuity floor: this id really does name legs (so `scorerLegend` renders) and really
  // does carry a perPoint σ pair (so the cuts CAN be off-frame). Without both, neither
  // branch below discriminates anything.
  it("the fixture reaches the regime - F9 names scorer legs and carries a perPoint σ pair", () => {
    expect(spec.bands.filter((b) => b.source === "perPoint").map((b) => b.fromPoint)).toEqual([
      "velSigmaAmber",
      "velSigmaRed",
    ]);
    expect(eff.scorerLegs.length).toBeGreaterThan(1);
  });

  it("cuts INSIDE the plotted domain draw paths and keep the promise", () => {
    const { svg } = detailChart(meta, build(0.115, 0.125), eff);
    expect(svg).toContain('class="band-cut"');
    expect(svg).toContain(PROMISE);
    expect(svg).not.toContain("no cut line is in frame");
  });

  it("cuts entirely OFF the plotted domain draw nothing and drop the promise", () => {
    const { svg } = detailChart(meta, build(9, 12), eff);
    expect(svg).not.toContain('class="band-cut"');
    expect(svg).not.toContain(PROMISE);
    // No served bounds on this eff ⇒ the line-count fallback, with no hover hint (dropped 2026-09-13).
    expect(svg).toContain("no cut line is in frame on this axis");
    expect(svg).not.toContain("hover the ribbon");
    // The scorer phrase itself is unaffected: the legend still names what scored the bar (#6
    // form — F9's two vel legs, same-day family).
    expect(svg).toContain("scored on velocity-z + sustained drift · same-day");
  });

  // #7: with `eff.legBounds` served (keyed like scorerLegs), the off-domain caption prints each
  // active leg's amber/red values — judged against the axis that leg scores on (F9 is a
  // velocity-mode chart, so its `vel-*` legs judge against the PRIMARY Δ domain) — then the
  // hover hint. By contract every served non-null bound is ALREADY in the plotted Δ-axis units
  // (`activeLegBounds` velZref-inverts the σ legs server-side), so the fixture's 9/12 are Δ-axis
  // values the primary formatter renders verbatim; `vel-cusum` (an accumulator with no Δ-axis
  // image) is served null at BOTH severities and must get NO clause at all. Values DERIVED from
  // the fixture's own cut placement, never a restated registry cut.
  it("cuts OFF the domain with served legBounds print per-leg amber/red values, no hover hint", () => {
    const OFF_AMBER = 9;
    const OFF_RED = 12;
    const bounded = {
      ...eff,
      scorerLegs: ["vel-z", "vel-z-fast", "vel-cusum"],
      legBounds: {
        "vel-z": { amber: OFF_AMBER, red: OFF_RED },
        "vel-z-fast": { amber: OFF_AMBER, red: null },
        "vel-cusum": { amber: null, red: null },
      },
    };
    const { svg } = detailChart(meta, build(OFF_AMBER, OFF_RED), bounded);
    expect(svg).not.toContain('class="band-cut"');
    // Both bounds sit ABOVE the plotted Δ60 domain (0.10…0.13), formatted with the primary
    // formatter (unit-less velocity axis).
    const v = (x) => formatValue(x, "");
    // Both legs' bounds have an image (the ▲ edge markers), so they list under "dashed lines =" with
    // the above-plot note on each VALUE — never under "not drawn".
    expect(svg).toContain(
      `dashed lines = velocity-z amber ${v(OFF_AMBER)} (above plot) / red ${v(OFF_RED)} (above plot) · fast velocity-z amber ${v(OFF_AMBER)} (above plot)`,
    );
    expect(svg).not.toContain("not drawn:");
    // A null band is omitted — no dangling "/ red".
    expect(svg).not.toContain(`fast velocity-z amber ${v(OFF_AMBER)} (above plot) /`);
    expect(svg).not.toContain("hover the ribbon");
    // A leg whose bounds are BOTH null is skipped whole — no bounds clause at all: neither a
    // valued one ("sustained drift amber …") nor an empty stub right before the hover hint
    // (which is what an un-filtered null/null leg would render). "sustained drift" itself still
    // appears in the scored-on clause and the per-point ribbon tooltips.
    expect(svg).not.toContain("sustained drift amber");
    expect(svg).not.toMatch(/sustained drift\s*·\s*hover/);
    expect(svg).not.toContain("no cut line is in frame");
  });
});

// --- Stage C: the CUSUM accumulator gets the SECONDARY axis (S⁺ + its flat `h` bound) ---------
// F9's second scorer leg (`vel-cusum`) fires on `S⁺ ≥ h`, a quantity with no home on the Δ60
// axis — so an amber block it scored had no on-screen cue at all. Stage C puts S⁺ on the right
// axis beside a flat amber `h` band. `pointField` is a CLOSED if/else, so without its `cusum`
// arm the series resolves null at EVERY point and the line renders empty with every other test
// still green — which is what the non-degenerate assertion below exists to catch.
describe("F9 CUSUM accumulator on the secondary axis", () => {
  const F9 = ALL_INDICATORS.find((i) => i.id === "F9");
  const spec = buildIndicatorChart(F9);
  const meta = { id: "F9", label: F9.label, unit: F9.unit ?? "", thresholds: F9.thresholds, chart: spec };
  const eff = { effAmber: 1, effRed: 2, scorerLegs: ["vel-z", "vel-cusum"], confirmCloses: 0 };
  const secSeries = spec.series.filter((s) => s.axis === "secondary");
  const secBands = spec.bands.filter((b) => b.axis === "secondary");
  // DERIVED, never transcribed: each bound comes from its ONE reader (`cusumAlarmBound` for the
  // warning limit, `cusumRedBound` for the action limit), so a retune moves these expectations
  // with the drawn lines, their printed values and the leg's fire tests together.
  const H = cusumAlarmBound(F9.thresholds.velocitySigma);
  const H_RED = cusumRedBound(F9.thresholds.velocitySigma);

  it("the spec declares the S⁺ axis, its series and BOTH tiers, each labelled with its own value", () => {
    const secAxis = spec.axes.find((a) => a.id === "secondary");
    expect(secAxis).toMatchObject({ side: "right", unit: "", format: "value" });
    expect(secAxis.label).toContain("S⁺");
    expect(secSeries).toEqual([{ axis: "secondary", fromPoint: "cusum", style: "primary" }]);
    expect(secBands).toEqual([
      { level: "amber", axis: "secondary", source: "derived", value: H, label: `h ${H.toFixed(2)}` },
      { level: "red", axis: "secondary", source: "derived", value: H_RED, label: `red ${H_RED.toFixed(2)}` },
    ]);
    // Vacuity floor: a bound of 0 would make "value: …" pass against an absent/zeroed band value
    // and the band would sit on the axis' own zero line, indistinguishable from no bound. The
    // ordering guard is what keeps the two tiers from collapsing into one drawn line.
    expect(H).toBeGreaterThan(0);
    expect(H_RED).toBeGreaterThan(H);
  });

  // The CONTRAST case: every other velocity id must keep the single-axis spec it had. R3 is a
  // plain velocity id (no `velocitySigma`), so the whole `sig ?` branch must add nothing to it.
  it("a velocity id WITHOUT velocitySigma keeps its single-axis spec", () => {
    const R2 = ALL_INDICATORS.find((i) => i.id === "R3");
    // Premise: R3 really is on the same `hasVelocity` branch, minus the σ config.
    expect(R2.thresholds.velocitySigma).toBeUndefined();
    expect(R2.thresholds.amberVelocity ?? R2.thresholds.redVelocity).not.toBeUndefined();
    const r2 = buildIndicatorChart(R2);
    expect(r2.axes.map((a) => a.id)).toEqual(["primary"]);
    expect(r2.series.map((s) => s.axis)).toEqual(["primary"]);
    expect(r2.bands.every((b) => (b.axis ?? "primary") === "primary")).toBe(true);
    expect(JSON.stringify(r2)).not.toContain("cusum");
  });

  // S⁺ rises across the window and crosses `h` on the last two days — the regime the axis exists
  // to show. Δ60 is flat-ish so the primary line is not what moves.
  const DATES = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
  const CUSUMS = [0.4, 1.2, 2.1, H + 0.5, H + 1.5];
  const build = (cusums) =>
    DATES.map((date, i) => ({
      date,
      value: 0.1 + i * 0.001,
      delta20: 0.1 + i * 0.001,
      state: "AMBER",
      leg: "vel-cusum",
      bandCuts: { velSigmaAmber: 0.105, velSigmaRed: 0.108 },
      ...(cusums[i] === undefined ? {} : { cusum: cusums[i] }),
    }));
  // The secondary line's own path element (the primary line is `class="line"`).
  const derivedPath = (svg) => svg.match(/<path class="line-derived" d="([^"]*)"/)?.[1];
  const pointCount = (d) => d.split(/[ML]/).filter((s) => s.trim()).length;

  it("renders a NON-DEGENERATE S⁺ path - the exact failure a missing `pointField` arm produces", () => {
    const rendered = detailChart(meta, build(CUSUMS), eff);
    const { svg } = rendered;
    const d = derivedPath(svg);
    // Without the `cusum` arm in `pointField` every value is null ⇒ `pathFor` returns "" ⇒ the
    // <path> element is omitted entirely. Both halves are asserted so either shape reds.
    expect(d, "the S⁺ line must be drawn at all").toBeTruthy();
    expect(pointCount(d), "every point carries an S⁺ reading").toBe(DATES.length);
    // ...and the drawn ys must actually VARY — an all-equal path would mean the field resolved to
    // one constant (e.g. a `?? 0` fallback) rather than the fixture's rising accumulator.
    const ys = [...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => m[2]);
    expect(new Set(ys).size, "the S⁺ trace must vary, not sit flat").toBeGreaterThan(1);
    // Both bounds are drawn, each labelled with its NAME and its own resolved value — not the
    // auto "amber <value>"/"red <value>" label the renderer emits for an unlabelled band.
    expect(svg).toContain(`>h ${H.toFixed(2)}</text>`);
    expect(svg).toContain(`>red ${H_RED.toFixed(2)}</text>`);
    // ...and the legend names the right axis for it.
    expect(svg).toContain("(right, dashed)");
    expect(svg).toContain("S⁺ (sustained drift)");
    expectValid(rendered, DATES.length);
  });

  it("a point missing `cusum` is a GAP, never a reading at 0", () => {
    // A 0 on the accumulator axis is a REAL value ("drift fully decayed"), so a warm-up day
    // rendered at 0 is indistinguishable from a measurement. Drop the middle day: the path must
    // therefore lose a point AND break into two runs.
    const withGap = [...CUSUMS];
    withGap[2] = undefined;
    const { svg } = detailChart(meta, build(withGap), eff);
    const d = derivedPath(svg);
    expect(d).toBeTruthy();
    expect(pointCount(d)).toBe(DATES.length - 1);
    // Two runs ⇒ two `M` move commands (an unbroken 4-point line would carry exactly one).
    expect((d.match(/M/g) ?? []).length, "the gap must BREAK the line into two runs").toBe(2);
  });
});

// --- Census: every series `fromPoint` any builder emits owes a `pointField` arm ------------------
// `pointField` is a CLOSED if/else returning null otherwise, so a spec naming a field with no arm
// draws an EMPTY line silently with a green typecheck (the velZ regression that motivated this).
// This walks the LIVE spec set (`buildIndicatorChart` over every indicator) rather than a fixed
// list, so a new builder field cannot slip past — the guard fails until its arm is added.
describe("pointField arm census over every builder's ChartSpec", () => {
  // A synthetic point with a sentinel at `path` (dotted → nested); a resolved arm returns it, a
  // missing arm returns null. `0`/`""` are excluded as sentinels since `?? null` would swallow them.
  const SENTINEL = 42.5;
  const probe = (path) => {
    const [head, tail] = path.split(".");
    return tail === undefined ? { [head]: SENTINEL } : { [head]: { [tail]: SENTINEL } };
  };
  // Series carrying a `compute` hook resolve via SERIES_HOOKS/COMPUTE_HOOKS, not pointField — skip.
  const seriesFields = [
    ...new Set(
      ALL_INDICATORS.flatMap((i) => buildIndicatorChart(i).series)
        .filter((s) => s.fromPoint != null && s.compute == null)
        .map((s) => s.fromPoint),
    ),
  ];

  it("collected a NON-TRIVIAL field set including velZ - the census is not vacuous", () => {
    expect(seriesFields.length).toBeGreaterThan(3);
    expect(seriesFields).toContain("velZ"); // the field whose missing arm this census exists to catch
  });

  it.each(seriesFields)("`%s` resolves through a pointField arm", (path) => {
    expect(pointField(probe(path), path), `no pointField arm for series fromPoint "${path}"`).toBe(SENTINEL);
  });
});

describe("sampleForDate - date-linked crosshair pairing", () => {
  // Uneven, gapped grid so nearest/tie cases are non-degenerate; only `date` matters here.
  const samples = [{ date: "2026-01-02" }, { date: "2026-01-06" }, { date: "2026-01-13" }];

  it("exact match returns that sample", () => {
    expect(sampleForDate(samples, "2026-01-06")).toBe(samples[1]);
  });

  it("nearest between two dates wins (1d beats 6d)", () => {
    expect(sampleForDate(samples, "2026-01-12")).toBe(samples[2]);
  });

  it("equidistant tie picks the EARLIER sample (strict <)", () => {
    // 2026-01-04 is 2 days from both neighbours.
    expect(sampleForDate(samples, "2026-01-04")).toBe(samples[0]);
  });

  it("dates outside the [first, last] range return null", () => {
    expect(sampleForDate(samples, "2026-01-01")).toBeNull();
    expect(sampleForDate(samples, "2026-01-14")).toBeNull();
  });

  it("empty samples return null", () => {
    expect(sampleForDate([], "2026-01-06")).toBeNull();
  });
});

describe("splitLegend - compare stack re-slots legends below all charts", () => {
  it("splits a real render at its trailing legend and recomposes byte-identically", () => {
    const meta = { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", unit: "", chart: SPEC.FXH };
    const pts = [
      pt("2026-01-02", 1.08, "GREEN", { havenLegs: { eur: 0.005, chf: 0.004, jpy: 0.002 } }),
      pt("2026-01-03", 1.06, "RED", { havenLegs: { eur: 0.052, chf: 0.061, jpy: 0.04 } }),
    ];
    const r = detailChart(meta, pts, { effAmber: 0.02, effRed: 0.05 });
    const s = splitLegend(r.svg);
    expect(s.chart + s.legend).toBe(r.svg);
    expect(s.legend.startsWith('<p class="chart-legend"')).toBe(true);
    expect(s.chart).not.toContain("chart-legend");
    expect(s.legend.endsWith("</p>")).toBe(true);
  });

  it("legend-less input passes through with an empty legend", () => {
    expect(splitLegend("<svg></svg>")).toEqual({ chart: "<svg></svg>", legend: "" });
  });
});

// --- genericSingle secondary axis: N-series generalization + R7's moving cuts ----------
// axis-2 unions ALL secondary series into ONE domain and draws one path per series; a non-gated
// N=1 series (F1's ROC / R8's probit) MUST stay byte-identical — that is the regression pin. R7
// adds two gated legs + four moving cuts scaled against the ax2 range WITHOUT joining its domain (D0-a).
describe("genericSingle secondary axis - N=1 stays single-path (F1-ROC-shaped regression pin)", () => {
  // One secondary series, no gate — the exact shape F1's roc30 / R8's probit take on this layout.
  const meta = {
    id: "F1LIKE",
    label: "IG OAS",
    unit: "%",
    chart: {
      axes: [
        { id: "primary", side: "left", unit: "%", format: "value" },
        { id: "secondary", side: "right", unit: "%", format: "derived", label: "Δ20d" },
      ],
      series: [
        { axis: "primary", fromPoint: "value", style: "primary" },
        { axis: "secondary", fromPoint: "delta20", style: "derived" },
      ],
      bands: [],
    },
  };
  const pts = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"].map((date, k) => ({
    date,
    value: 3.0 + k * 0.1,
    delta20: 0.02 * (k - 1),
    state: "GREEN",
  }));
  const { svg, detail } = detailChart(meta, pts, {});

  it("draws EXACTLY ONE dim/dashed derived line and NO gate-off faint path", () => {
    const derivedLines = [...svg.matchAll(/<path class="line-derived"[^>]*>/g)].map((m) => m[0]);
    expect(derivedLines).toHaveLength(1);
    // No `pair` on this spec ⇒ the pre-pairing ink-dim stroke, byte-identical.
    expect(derivedLines[0]).toContain('stroke="var(--ink-dim)"');
    // The gate-off styling (only R7 emits it) must never appear for a non-gated N=1 series.
    expect(svg).not.toContain('opacity="0.35"');
    // No gate machinery reaches a non-gated series' hover readout.
    for (const s of detail.samples) expect(s.readout).not.toContain("gate off");
  });

  it("keeps the single-series readout, ys pair and legend clause", () => {
    expect(detail.samples[0].readout).toBe("2026-01-02 · 3.00% · Δ20d -2.0% · GREEN");
    for (const s of detail.samples) expect(s.ys).toHaveLength(2);
    expect(svg).toContain("IG OAS, % (left) · Δ20d (right, dashed) · 4 days");
  });
});

// R7 LEFT the context-only sentinel: T10Y3M primary + both Δ20 legs + four moving ranked cuts on
// the secondary. Uses the REAL builder spec so a spec regression can't ship green.
describe("R7 - two secondary legs + four moving cuts + the shortEndDriven shade (genericSingle)", () => {
  const R7 = ALL_INDICATORS.find((i) => i.id === "R7");
  if (!R7) throw new Error("R7 missing from ALL_INDICATORS - census moved under the test");
  const spec = buildIndicatorChart(R7);
  const meta = { id: "R7", label: R7.label, unit: R7.unit ?? "", chart: spec };

  // Vacuity floor: the whole case is an id carrying TWO secondary legs + four secondary perPoint cuts.
  it("the real spec carries two secondary legs and four secondary perPoint cuts", () => {
    expect(spec.bands).not.toBe("context-only");
    expect(spec.series.filter((s) => s.axis === "secondary" && s.style === "leg")).toHaveLength(2);
    expect(spec.bands.filter((b) => b.source === "perPoint" && b.axis === "secondary")).toHaveLength(4);
  });

  // SYNTHETIC cuts — render inputs only, never the live ranked values (which move daily). Padded
  // leg domain admits steepAmber/steepRed/dropAmber as drawn lines; dropRed −1.32 sits BELOW the
  // frame (▼ edge marker + "below plot"). p4 drops the drop cuts ⇒ a gap; p2's gate is OFF ⇒ faint.
  const cut = { r7DropAmber: -0.59, r7DropRed: -1.32, r7SteepAmber: 0.33, r7SteepRed: 0.63 };
  const pts = [
    { date: "2026-01-02", value: 0.2, state: "GREEN", bullLegs: { drop: -0.1, steep: 0.15 }, bandCuts: { ...cut }, gates: { shortEndDriven: true } },
    { date: "2026-01-03", value: 0.1, state: "GREEN", bullLegs: { drop: -0.45, steep: 0.4 }, bandCuts: { ...cut }, gates: { shortEndDriven: false } },
    { date: "2026-01-04", value: 0.05, state: "AMBER", bullLegs: { drop: -0.62, steep: 0.55 }, bandCuts: { ...cut }, gates: { shortEndDriven: true } },
    { date: "2026-01-05", value: 0.0, state: "GREEN", bullLegs: { drop: -0.3, steep: 0.2 }, bandCuts: { r7SteepAmber: 0.33, r7SteepRed: 0.63 }, gates: { shortEndDriven: true } },
  ];
  const { svg, detail } = detailChart(meta, pts, {});

  it("draws BOTH leg lines (N-series axis-2) plus the in-domain cut paths", () => {
    // Two dim/dashed leg lines: the on-segments of both legs (gate-off p2 splits one into a faint run).
    const derivedLines = [...svg.matchAll(/<path class="line-derived"[^>]*>/g)];
    expect(derivedLines.length).toBeGreaterThanOrEqual(2);
    // The three in-domain cuts each draw a band-cut path; dropRed is off-domain (no line).
    const cutPaths = [...svg.matchAll(/<path class="band-cut"[^>]*>/g)];
    expect(cutPaths.length).toBe(3);
  });

  it("legs and cuts share the pair hue; cut severity rides weight/dash, never color", () => {
    // Every leg segment — gate-on AND the faint gate-off run — carries its leg's pair hue.
    const derivedLines = [...svg.matchAll(/<path class="line-derived"[^>]*>/g)].map((m) => m[0]);
    expect(derivedLines.some((l) => l.includes('stroke="var(--pair-drop)"'))).toBe(true);
    expect(derivedLines.some((l) => l.includes('stroke="var(--pair-steep)"'))).toBe(true);
    expect(derivedLines.every((l) => !l.includes("var(--ink-dim)"))).toBe(true);
    // Drawn cuts in spec order: dropAmber, steepAmber, steepRed (dropRed sits below plot).
    const [dropAmber, steepAmber, steepRed] = [...svg.matchAll(/<path class="band-cut"[^>]*>/g)].map((m) => m[0]);
    expect(dropAmber).toContain('stroke="var(--pair-drop)"');
    expect(steepAmber).toContain('stroke="var(--pair-steep)"');
    expect(steepRed).toContain('stroke="var(--pair-steep)"');
    // Amber keeps today's stroke; red = heavier + denser dash (severity never rides color alone).
    for (const amber of [dropAmber, steepAmber]) {
      expect(amber).toContain('stroke-width="1.25"');
      expect(amber).toContain('stroke-dasharray="4 3"');
    }
    expect(steepRed).toContain('stroke-width="1.75"');
    expect(steepRed).toContain('stroke-dasharray="2 2"');
  });

  it("cut chips + the leg legend take the pair hue; the amber/red words stay in the legend text", () => {
    const chips = [...svg.matchAll(/<text class="band-chip"([^>]*)>([^<]+)</g)];
    const chipOf = (tag) => chips.find((m) => m[2] === tag)[1];
    expect(chipOf("2A")).toContain('fill="var(--pair-drop)"');
    expect(chipOf("sR")).toContain('fill="var(--pair-steep)"');
    // The off-plot dropRed ▼ edge label is pair-hued too (bandCutSvg hue override) — and shows
    // only its chip, the full name being one line down in the legend.
    const edge = [...svg.matchAll(/<text class="band-label"([^>]*)>([^<]+)</g)].find((m) => m[2] === "2R");
    expect(edge[1]).toContain('fill="var(--pair-drop)"');
    // The amber/red words survive where they are now read: the legend, keyed by the chip.
    expect(svg).toContain("2A = 2y drop amber");
    expect(svg).toContain("sR = steepening red");
    // Legend names each leg in its own hue.
    // CLASS, not an inline style: prod's CSP (`style-src 'self'`) drops a style attribute, so the
    // legend entry painted uncoloured while the SVG strokes beside it (presentation attributes,
    // ungoverned by CSP) kept their hue.
    expect(svg).toContain('<span class="dc-pair-drop">Δ20 2y</span>');
    expect(svg).toContain('<span class="dc-pair-steep">Δ20 steepening</span>');
  });

  it("both pair hues resolve - styles.css defines the vars the strokes reference", () => {
    // An undefined var is an INVALID stroke that silently paints nothing.
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain("--pair-drop:");
    expect(css).toContain("--pair-steep:");
  });

  it("every DRAWN secondary cut carries a chip in the RIGHT MARGIN, staggered clear of the others", () => {
    const tags = [...svg.matchAll(/<text class="band-chip"([^>]*)>([^<]+)</g)];
    // One per in-domain cut — the off-plot dropRed rides the ▼ edge marker instead.
    expect(tags.map((m) => m[2]).sort()).toEqual(["2A", "sA", "sR"]);
    // The whole point (`[USER]` 2026-08-29): every chip sits OUTSIDE the plot frame, so none of
    // them can cover the newest observations at the plot's right edge.
    const xs = tags.map((m) => Number(/\bx="([\d.]+)"/.exec(m[1])[1]));
    for (const x of xs) expect(x).toBeGreaterThan(CH.ml + PLOT_W);
    // ...and still inside the viewBox, chip width included.
    for (const x of xs) expect(x + 12).toBeLessThanOrEqual(CH.w);
    const ys = tags.map((m) => Number(/\by="([\d.]+)"/.exec(m[1])[1]));
    expect(ys).toHaveLength(3);
    const gaps = ys.flatMap((a, i) => ys.slice(i + 1).map((b) => Math.abs(a - b)));
    expect(gaps).toHaveLength(3);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(10);
    // Every chip is keyed in the legend, so a 2-glyph tag is never orphaned.
    for (const t of tags.map((m) => m[2])) expect(svg).toContain(`${t} = `);
  });

  it("no long cut label is left over the plot (the block that buried the lines)", () => {
    const inPlot = [...svg.matchAll(/<text class="band-label"([^>]*)>([^<]+)</g)];
    // The only surviving band-label is the ▼ edge marker's, and it is a chip now too.
    expect(inPlot.map((m) => m[2])).toEqual(["2R"]);
  });

  it("dropRed sits below the frame ⇒ a ▼ edge marker + a 'below plot' legend note", () => {
    expect(svg).toContain("▼");
    expect(svg).toContain("(below plot)");
    // The value it lost on-plot is still readable — in the legend, keyed by its chip.
    expect(svg).toContain("2R = 2y drop red");
  });

  it("the gate-off day draws a faint (dim) leg segment and reads 'gate off' in the hover", () => {
    expect(svg).toContain('opacity="0.35"');
    // p2 is the gate-off point.
    expect(detail.samples[1].readout).toContain("gate off");
    // Non-gate-off days do not.
    expect(detail.samples[0].readout).not.toContain("gate off");
  });

  it("a gate-off leg run shares its gate-ON sibling's dash — opacity carries the whole degrade", () => {
    // Backlog #37: the gate-off run used a TIGHTER `2 4` dash, which fragmented a long gate-off
    // stretch into speckle. Both runs of a derived leg now carry the derived-line `3 2`, so the
    // faint run reads as the same line. Guard the tight dash specifically — a bare
    // "no dasharray" assertion would wrongly pass if the gate-off run ever went solid, which
    // would invert the degrade against its dashed sibling.
    const faint = [...svg.matchAll(/<path class="line-derived"[^>]*opacity="0\.35"[^>]*>/g)].map((m) => m[0]);
    expect(faint.length).toBeGreaterThan(0);
    for (const p of faint) {
      expect(p).toContain('stroke-dasharray="3 2"');
      expect(p).not.toContain('stroke-dasharray="2 4"');
    }
  });

  it("the gate legend copy ships (gateLegend reused off spec.gates)", () => {
    expect(svg).toContain("also requires the 2y drop drives the steepening");
  });

  it("ys carries the secondary legs + drawn moving cuts, not just dotY", () => {
    // p1 draws the primary value + both Δ20 legs + the three in-domain moving cuts on ax2 (dropRed
    // sits below plot ⇒ no line, no ys entry). So ys has strictly more than the lone primary y.
    const s0 = detail.samples[0];
    expect(s0.ys).toContain(s0.dotY);
    expect(s0.ys).toHaveLength(6);
    expect(detail.samples[3].ys).toHaveLength(5); // p4 carries no drop cuts
    expect(s0.readout).toBe("2026-01-02 · 0.2 · Δ20 2y -0.1 · Δ20 steepening 0.15 · GREEN");
    for (const y of s0.ys) expect(Number.isFinite(y)).toBe(true);
  });
});

// A raw carrier's two amber lines are DIFFERENT LEGS on the PRIMARY axis — the rung's
// post-inversion floor and the always-on regime-relative drawdown cut — and both ride
// `source:"perPoint"`. The spec tags the drawdown cut `pair:"drop"` (2026-08-30), but `perPointCuts`
// once hard-coded the severity hue, so the two legs painted the SAME amber and the tag was inert on
// this route. Live R1 left the raw arm 2026-08-31 (smoothed, no drawdown leg), so the case rides a
// FIXTURE carrier — R1's shape under a non-smoothed same-family id wearing `T10Y3M_DRAWDOWN` —
// through the real builder, so a builder regression still cannot ship green.
describe("raw carrier - the paired primary moving cut takes its LEG hue, the pair-less one keeps severity", () => {
  const liveR1 = ALL_INDICATORS.find((i) => i.id === "R1");
  if (!liveR1) throw new Error("R1 missing from ALL_INDICATORS - census moved under the test");
  const R1 = { ...liveR1, id: "R3", drawdownLeg: T10Y3M_DRAWDOWN };
  const spec = buildIndicatorChart(R1);
  const meta = { id: "R1", label: R1.label, unit: R1.unit ?? "", chart: spec };
  const perPoint = spec.bands.filter((b) => b.source === "perPoint" && (b.axis ?? "primary") === "primary");

  // Vacuity floor: the case is an id carrying TWO primary moving cuts, exactly one of them paired —
  // and live R1 is NOT that id any more (asserted, so the fixture is not a redundant copy).
  it("the fixture spec carries both moving amber cuts, only the drawdown one paired; live R1 carries one", () => {
    expect(buildIndicatorChart(liveR1).bands.filter((b) => b.source === "perPoint").map((b) => b.fromPoint)).toEqual([POST_INVERSION_BAND.key]);
    expect(perPoint.map((b) => b.fromPoint)).toEqual([POST_INVERSION_BAND.key, R1_DRAWDOWN_BAND.key]);
    // Same SEVERITY on both — which is why the hue has to carry the leg identity.
    expect(perPoint.map((b) => b.level)).toEqual([POST_INVERSION_BAND.level, R1_DRAWDOWN_BAND.level]);
    expect(perPoint.map((b) => b.pair)).toEqual([undefined, "drop"]);
  });

  // Both cuts INSIDE the plotted value domain (a cut below the window's own minimum is dropped by
  // design), so both draw a line to take a hue.
  const pts = [
    { date: "2026-01-02", value: 0.55, state: "GREEN", shortMove: -0.05, bandCuts: { postInvAmber: 0.4, drawdownAmber: 0.36 } },
    { date: "2026-01-03", value: 0.45, state: "GREEN", shortMove: 0.02, bandCuts: { postInvAmber: 0.4, drawdownAmber: 0.36 } },
    { date: "2026-01-04", value: 0.38, state: "AMBER", shortMove: -0.12, bandCuts: { postInvAmber: 0.4, drawdownAmber: 0.35 } },
    { date: "2026-01-05", value: 0.34, state: "AMBER", shortMove: 0.0, bandCuts: { postInvAmber: 0.4, drawdownAmber: 0.35 } },
  ];
  const { svg } = detailChart(meta, pts, {});

  it("the drawdown cut is BLUE and the post-inversion floor stays amber", () => {
    const paths = [...svg.matchAll(/<path class="band-cut"[^>]*>/g)].map((m) => m[0]);
    // Spec order: the rung floor, then the drawdown cut.
    expect(paths).toHaveLength(perPoint.length);
    const [floor, drawdown] = paths;
    expect(floor).toContain('stroke="var(--state-amber)"');
    expect(drawdown).toContain('stroke="var(--pair-drop)"');
    // Severity is unchanged by the hue swap: both are amber legs, so both keep the amber stroke.
    for (const p of paths) {
      expect(p).toContain('stroke-width="1.25"');
      expect(p).toContain('stroke-dasharray="4 3"');
    }
  });

  // `--pair-drop:` resolution is owned by the R7 describe's "both pair hues resolve" test.

  // Off-domain, the cut keeps its ▼ edge marker — which must carry the leg hue too, or the line
  // changes colour the moment it leaves the frame.
  it("an off-plot paired cut keeps the pair hue on its edge marker", () => {
    const offPts = pts.map((p, i) => ({ ...p, value: 1.2 + i * 0.01 }));
    const { svg: offSvg } = detailChart(meta, offPts, {});
    const labels = [...offSvg.matchAll(/<text class="band-label"([^>]*)>([^<]+)</g)];
    // Matched by the spec's OWN label, never a transcription of it.
    const labelOf = (key) => perPoint.find((b) => b.fromPoint === key).label;
    const drawdown = labels.find((m) => m[2].startsWith(labelOf(R1_DRAWDOWN_BAND.key)));
    expect(drawdown, "the drawdown cut's edge label").toBeTruthy();
    expect(drawdown[1]).toContain('fill="var(--pair-drop)"');
    const floor = labels.find((m) => m[2].startsWith(labelOf(POST_INVERSION_BAND.key)));
    expect(floor[1]).toContain('fill="var(--state-amber)"');
  });
});


// DISP B2 deepener (2026-09-09, Stage 2): the rolling-p90 correlation cut is threaded onto the wire
// (`corrP90`) and drawn as its OWN per-day line on the corr axis, beside the static DISP_CORR gate
// band. Two pins the golden (spec-only) and the pointField census (arm-only) cannot make: that the
// gate band actually PAINTS on this derived route (it sat in the spec but on no pixel until this
// stage), and that the deepener line renders in a hue DISTINCT from the amber gate band on the same
// axis. Labels/values are COMPOSED from the constants, never retyped.
describe("DISP deepener line + gate band render distinctly on the corr axis", () => {
  const spec = buildIndicatorChart(ALL_INDICATORS.find((i) => i.id === "DISP"));
  const meta = { id: "DISP", label: "Global dispersion", unit: "%", cadence: "daily", chart: spec };
  // Warm-up head (no corrP90) then settled days — proves the line gaps on the NaN head, never 0.
  const pts = [];
  for (let k = 0; k < 30; k++) {
    const warm = k < 4;
    pts.push(
      pt(`2026-02-${String(k + 1).padStart(2, "0")}`, 0.6 + 0.008 * k, "AMBER", {
        decision: -0.01,
        rawState: "AMBER",
        ...(warm ? {} : { corrP90: 0.72 + 0.004 * k }),
      }),
    );
  }
  const { svg } = detailChart(meta, pts, {});

  it("paints the static DISP_CORR gate band (label composed from DISP_CORR)", () => {
    // esc() turns ">" into "&gt;" — the label composes off DISP_CORR, so a retune moves it.
    expect(svg).toContain(`corr&gt;${DISP_CORR} confirms`);
    // The gate band draws in the amber state hue.
    expect(svg).toMatch(/stroke="var\(--state-amber\)"/);
  });

  it("draws the p90 deepener as a DISTINCT trend line, labelled from the two constants", () => {
    // The deepener is a `trend`-styled line in the blue trend hue — NOT amber, so it can never
    // collide with the gate band on the same axis.
    expect(svg).toMatch(/<path class="line-trend"[^>]*stroke="var\(--trend-line\)"/);
    const label = `rolling p${+(DISP_CORR_P * 100).toFixed(1)} corr deepener (${DISP_CORR_P_WINDOW}d)`;
    expect(svg).toContain(label);
  });

  it("gaps the deepener line on the warm-up head, never drawing a spurious 0 cut", () => {
    // The trend path is gap-broken: with a 4-day warm-up head carrying no corrP90, its `d` starts at
    // the first SETTLED day, so it holds ONE run (a single "M"), never a run bridging from the head.
    const d = svg.match(/<path class="line-trend"[^>]*\bd="([^"]*)"/)[1];
    // ONE contiguous run (a single M): the settled days are consecutive, so no interior gap.
    expect((d.match(/M/g) || []).length).toBe(1);
    // The invariant a lone-M count cannot see: the run must START at the first SETTLED day, not
    // bridge from day 0. `pathD` emits one vertex command (M, then each L) per DRAWN point, so the
    // vertex count equals the number of days that actually carry a `corrP90` — DERIVED from the
    // fixture, never the total. A `?? 0` head (drawing the warm days at 0) draws all 30 and
    // over-counts here while the M count stays 1, so this is the assertion that bites the gap.
    const settledCount = pts.filter((p) => p.corrP90 != null).length;
    expect(settledCount).toBeLessThan(pts.length); // vacuity floor: the head really is unsettled
    expect((d.match(/[ML]/g) || []).length).toBe(settledCount);
  });
});

describe("genericSingle - PENSION ids carry a % change right axis (R4)", () => {
  const ind = ALL_INDICATORS.find((i) => i.id === "SPY");
  const meta = { id: ind.id, label: ind.label, channel: ind.channel, unit: "€", thresholds: {}, chart: buildIndicatorChart(ind) };
  const pts = [100, 105, 110, 120].map((v, i) => ({ date: `2026-01-0${i + 1}`, value: v, state: "GREEN" }));

  it("anchors the % on the FULL served series' first value, even when windowed", () => {
    expect(ind.channel).toBe("PENSION");
    const r = detailChart(meta, pts, null, { window: 3 }); // visible 105..120; baseline stays 100
    expect(r.svg).toContain(">€105.00</text>");
    expect(r.svg).toContain(">20.00%</text>"); // 120 / 100 − 1 (a window-rebase would read 14.29%)
    expect(r.svg).toContain(">5.00%</text>");
    expect(r.svg).not.toContain(">0.00%</text>");
    expect(r.svg).toContain(">% change</text>");
    expect(r.detail.samples[0].readout).toBe("2026-01-02 · €105.00 · 5.00% · GREEN");
    // Unwindowed, the low tick IS the baseline ⇒ 0.00%.
    expect(detailChart(meta, pts, null).svg).toContain(">0.00%</text>");
  });

  it("excludes the spec's `lead` from the baseline - the 0% sits at the default frame's first close", () => {
    // spec.window 3 over 4 served points ⇒ the first point (100) is lead only (an MA200 toggle's warm-up).
    const r = detailChart({ ...meta, chart: { ...meta.chart, window: 3, lead: 1 } }, pts, null);
    expect(r.svg).toContain(">0.00%</text>"); // the low tick 105 IS the baseline
    expect(r.svg).toContain(">14.29%</text>"); // 120 / 105 − 1 (a lead-anchored base would read 20.00%)
    expect(r.svg).not.toContain(">20.00%</text>");
  });

  it("draws no % change axis on a non-PENSION id", () => {
    const r = detailChart({ ...meta, channel: "CONTEXT" }, pts, null, { window: 3 });
    expect(r.svg).not.toContain("% change");
    expect(r.svg).not.toContain(">20.00%</text>");
    expect(r.detail.samples[0].readout).toBe("2026-01-02 · €105.00 · GREEN");
  });

  it("draws no % change axis when every value is null (a redacted series has no base)", () => {
    const svg = detailChart(meta, pts.map((p) => ({ ...p, value: null })), null).svg;
    expect(svg).not.toContain("% change");
    expect(svg).not.toContain(">0.00%</text>");
  });
});

describe("edge state stripes - the current colour read at both frame edges without hunting the ribbon's right end", () => {
  const meta = { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", unit: "", chart: SPEC.FXH };
  const legs = (eur) => ({ havenLegs: { eur, chf: eur, jpy: eur } });
  const eff = { effAmber: 0.02, effRed: 0.05 };
  const run = (pts, opts) => detailChart(meta, pts, eff, opts).svg;

  it("paints the NEWEST point's confirmed state over the plot band, at x=0 AND flush right, SIDEBAR_W wide", () => {
    const svg = run([pt("2026-01-02", 1.08, "GREEN", legs(0.005)), pt("2026-01-05", 1.06, "RED", legs(0.061))]);
    // Newest = RED, so the stripe is RED even though the window opens GREEN. Geometry is the plot
    // band (mt .. mt+plotH), never the card, so the stripe lines up with the drawn series.
    const band = `y="${CH.mt}" width="${SIDEBAR_W}" height="${plotH(CH).toFixed(2)}"`;
    expect(svg).toContain(`data-state-sidebar="RED" x="0" ${band}`);
    // The right twin (2026-09-30): same rect at the frame's far edge, so a pinch-zoom into the
    // right half still shows the colour.
    expect(svg).toContain(`data-state-sidebar="RED" x="${CH.w - SIDEBAR_W}" ${band}\n    fill="var(--state-red)"><title>2026-01-05 RED</title>`);
    // One stripe per EDGE, not one per point (that is the ribbon's job).
    expect(svg.match(/data-state-sidebar=/g)).toHaveLength(2);
  });

  it("follows the geometry it is handed - the stacked frame's shorter plot band", () => {
    const pts = [pt("2026-01-02", 1.08, "GREEN", legs(0.005)), pt("2026-01-05", 1.06, "AMBER", legs(0.028))];
    const svg = run(pts, { geo: STACK_CH });
    const band = `y="${STACK_CH.mt}" width="${SIDEBAR_W}" height="${plotH(STACK_CH).toFixed(2)}"`;
    expect(svg).toContain(`x="0" ${band}`);
    expect(svg).toContain(`x="${STACK_CH.w - SIDEBAR_W}" ${band}`);
    expect(plotH(STACK_CH)).not.toBe(plotH(CH)); // the assertions above would pass vacuously if they matched
  });

  it("mirrors the ribbon on a pending newest close - confirmed fill plus the raw state's hatch", () => {
    const svg = run([
      pt("2026-01-02", 1.08, "GREEN", legs(0.005)),
      pt("2026-01-05", 1.06, "AMBER", { ...legs(0.028), rawState: "RED" }),
    ]);
    expect(svg).toContain(`data-state-sidebar="AMBER"`);
    expect(svg).toContain(`fill="var(--state-amber)"><title>2026-01-05 AMBER (raw RED, unconfirmed on this close)</title>`);
    // The hatch overlay reuses the ribbon's own defs: same <svg>, so the pattern must be present.
    const hatch = (x) => `<rect x="${x}" y="${CH.mt}" width="${SIDEBAR_W}" height="${plotH(CH).toFixed(2)}" fill="url(#pend-RED)" pointer-events="none" />`;
    expect(svg).toContain(hatch(0));
    expect(svg).toContain(hatch(CH.w - SIDEBAR_W)); // the right twin hatches too
    expect(svg).toContain('<pattern id="pend-RED"');
  });
});

describe("zoneD.window chips - draw-only trailing slice", () => {
  const dates = (n) => Array.from({ length: n }, (_, k) => new Date(Date.UTC(2025, 0, 1 + k)).toISOString().slice(0, 10));
  const linePts = (n) => dates(n).map((date, k) => pt(date, 1 + k * 0.001, "GREEN", { decision: 0.01 }));

  it("count id: the id's own spec.window stays the cap - min(userWindow, spec.window)", () => {
    const meta = { id: "VT", label: "Value/tech ratio", unit: "", chart: { ...SPEC.VT, window: 40 } };
    const pts = linePts(70);
    const r = detailChart(meta, pts, {}, { window: 63 });
    expect(r.detail.n).toBe(40); // spec.window 40 < user 63
  });

  it("date-anchored id: window wins only when SHORTER than the anchor span - max(anchor, len-N)", () => {
    const pts = linePts(100);
    const meta = { id: "VT", label: "Value/tech ratio", unit: "", chart: { ...SPEC.VT, fromDate: pts[30].date } };
    const short = detailChart(meta, pts, {}, { window: 63 });
    expect(short.detail.n).toBe(63); // len-63 = 37 > anchor 30 -> the window cuts
    expect(short.detail.samples[0].date).toBe(pts[37].date);
    const long = detailChart(meta, pts, {}, { window: 252 });
    expect(long.detail.n).toBe(70); // window >= anchor span -> the anchor cut holds
    expect(long.detail.samples[0].date).toBe(pts[30].date);
  });

  it("derived layout (genericDerived): window 63 keeps the trailing 63 of 70 points", () => {
    const meta = { id: "F6", label: "Semis rel-strength", unit: "", chart: SPEC.F6 };
    const pts = linePts(70);
    const r = detailChart(meta, pts, { effAmber: undefined, effRed: undefined }, { window: 63 });
    expect(r.detail.n).toBe(63);
    expect(r.detail.samples[0].date).toBe(pts[7].date);
  });

  const fxMeta = { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", unit: "", chart: SPEC.FXH };
  const fxEff = { effAmber: 0.02, effRed: 0.05 };
  const fxPts = (n) =>
    dates(n).map((date, k) =>
      pt(date, 1.05 + k * 0.001, "GREEN", { havenLegs: { eur: 0.0001 * k, chf: 0.00005 * k, jpy: 0.00002 * k } }));

  it("FXH (genericFx): window 63 draws the trailing 63 points on BOTH axes", () => {
    const pts = fxPts(70);
    const r = detailChart(fxMeta, pts, fxEff, { window: 63 });
    expect(r.detail.n).toBe(63);
    expect(r.detail.samples[0].date).toBe(pts[7].date);
    expect(r.detail.samples.at(-1).date).toBe(pts.at(-1).date);
    // Both axes slice together: every drawn column still snaps to all 5 lines - the EURUSD price
    // on the secondary axis plus the 3 legs + worst-of envelope on the primary.
    expect(r.detail.samples.every((s) => s.ys.length === 5)).toBe(true);
  });
});

// --- Caption redesign (2026-09-13 rulings #1–#9) on an
// F1-shaped fixture (genericSingle: level chart + roc30 secondary axis, scorerLegs
// ["op","vel-op"], 2-close family). Bounds/cuts here are FIXTURE constants, never registry values.
describe("detail-chart caption redesign - per-ruling rows on the F1 fixture", () => {
  const F1 = ALL_INDICATORS.find((i) => i.id === "F1");
  const meta = {
    id: "F1",
    label: F1.label,
    unit: F1.unit ?? "%",
    thresholds: { amberLevel: 3.0, redLevel: 3.2 },
    chart: buildIndicatorChart(F1),
  };
  // In-frame data band 2.9…3.3 (its roc30 is 0 everywhere: period-5 cycle, 30 ≡ 0 mod 5).
  const pts = Array.from({ length: 40 }, (_, i) =>
    pt(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, 2.9 + (i % 5) * 0.1, "GREEN"),
  );
  // Served bounds, keyed like scorerLegs: op in-frame amber / above-plot red on the PRIMARY (%)
  // axis; vel-op far above the roc30 secondary domain.
  const OP_AMBER = 3.0;
  const OP_RED = 5.0;
  const VEL_AMBER = 99;
  const eff = {
    effAmber: 3.0,
    effRed: 3.2,
    scorerLegs: ["op", "vel-op"],
    confirmCloses: 2,
    legBounds: { op: { amber: OP_AMBER, red: OP_RED }, "vel-op": { amber: VEL_AMBER, red: null } },
  };
  const legendOf = (svg) => svg.slice(svg.indexOf('<p class="chart-legend"'));
  const caption = legendOf(detailChart(meta, pts, eff).svg);
  const stackCaption = legendOf(detailChart(meta, pts, eff, { geo: STACK_CH }).svg);
  const secAxis = meta.chart.axes.find((a) => a.id === "secondary");
  // Mirrors the renderer's `dFmt` exactly: only a "pp" value axis takes `formatLevelDelta`.
  const vFmt = (v) =>
    secAxis?.format === "derived" ? formatDerived(v, secAxis.unit) : secAxis?.unit === "pp" ? formatLevelDelta(v, "pp") : formatValue(v, secAxis?.unit ?? "");

  it("#1: the caption opens with the label ONCE on both frames - no duplicate name lead, no date span", () => {
    // 2026-09-13: the stack frame used to prefix "<label> · <first> → <last> · " ahead of a payload
    // that ALREADY opened with the label (the compare stack read "HY OAS · … · HY OAS, % left").
    // The name lead now yields to a label-led payload, and the date span is gone on every frame.
    expect(stackCaption.startsWith(`<p class="chart-legend">${F1.label}, ${meta.unit} (left)`)).toBe(true);
    expect(stackCaption).not.toContain(`${F1.label} · ${F1.label}`);
    expect(stackCaption).not.toContain("\u2192");
    expect(caption.startsWith(`<p class="chart-legend">${F1.label}, ${meta.unit} (left)`)).toBe(true);
    // Right after the primary-axis clause: what the indicator measures (the explainer's `tip`,
    // period dropped) — one sentence, then the rest of the caption.
    const tip = esc(INDICATOR_DESC.F1.tip.replace(/\.\s*$/, "")); // HTML-escaped like the render
    expect(caption).toContain(`(left) — ${tip} · `);
    expect(caption).toContain(` · ${pts.length} days`);
  });

  it("#7: each active leg's served bounds print on its own axis, grouped by whether its cuts are drawn", () => {
    // op judges against the PRIMARY (%) axis. Its served red (5.0) has NO image (the drawn static
    // red is effRed 3.2), so the leg lists under "not drawn:" — its amber, which IS the drawn
    // amber line, says "(dashed)" on the value; its red carries the above-plot note.
    expect(caption).toContain(
      `not drawn: level cut amber ${formatValue(OP_AMBER, meta.unit)} (dashed) / red ${formatValue(OP_RED, meta.unit)} (above plot)`,
    );
    // vel-op keeps its FULL phrase here (the strip is #6-only) and judges against the Δ axis.
    expect(caption).toContain(`velocity cut amber ${vFmt(VEL_AMBER)} (above plot)`);
    // No served bound is drawn ⇒ no "dashed lines =" claim at all; the hover hint is gone (2026-09-13).
    expect(caption).not.toContain("dashed lines =");
    expect(caption).not.toContain("hover the ribbon");
    expect(caption).not.toContain("no cut line is in frame");
    // Bounds absent ⇒ the line-count fallback: a static line IS drawn here, so the promise.
    const bare = legendOf(detailChart(meta, pts, { ...eff, legBounds: undefined }).svg);
    expect(bare).toContain("dashed lines = the exact cuts it scores against");
    expect(bare).not.toContain("hover the ribbon");
  });

  it("#7b: a leg whose served pair IS the drawn static pair lists under `dashed lines =`; an undrawn leg's off-plot note stays on its own value", () => {
    // R2's shape (2026-09-13 report): the vel-op pair is the drawn static band pair, the EVT/z pairs
    // have no image; the old guide printed all three flat, so "red 0.8494 (above plot)" sat beside
    // an in-frame red line. Fixture: eff's drawn pair = the op leg's served pair.
    const drawnEff = {
      ...eff,
      scorerLegs: ["op", "evt"],
      legBounds: { op: { amber: eff.effAmber, red: eff.effRed }, evt: { amber: 3.1, red: 50 } },
    };
    const c = legendOf(detailChart(meta, pts, drawnEff).svg);
    const f = (v) => formatValue(v, meta.unit);
    expect(c).toContain(`dashed lines = level cut amber ${f(eff.effAmber)} / red ${f(eff.effRed)} · not drawn: EVT tail amber ${f(3.1)} / red ${f(50)} (above plot)`);
    expect(c).not.toContain(`red ${f(eff.effRed)} (above plot)`);
  });

  it("velocity-mode caption opens label-led: `<label> Δ<span>, <unit> (left)`, never a bare span", () => {
    // R2 ("10y Δ") folds into the span word; a plain label gets a space. Both name WHAT the Δ is of.
    const R2 = ALL_INDICATORS.find((i) => i.id === "R3");
    const r2Meta = { id: "R3", label: R2.label, unit: R2.unit ?? "%", thresholds: R2.thresholds, chart: buildIndicatorChart(R2) };
    const r2Pts = Array.from({ length: 30 }, (_, i) => ({ ...pt(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, 4.5, "GREEN"), delta20: 0.1 }));
    const span = r2Meta.chart.axes.find((a) => a.id === "primary").label;
    const c = legendOf(detailChart(r2Meta, r2Pts, { effAmber: 0.2, effRed: 0.27 }).svg);
    // A Δ of a %-quoted yield is percentage POINTS: ", pp", never ", %" (which reads as a relative change).
    expect(r2Meta.unit).toBe("%");
    expect(c.startsWith(`<p class="chart-legend">${R2.label}${span.slice(1)}, pp (left)`)).toBe(true);
    expect(c).not.toContain(`>${span} (left)`);
    // The stack head does not repeat the label ahead of a label-led body.
    const stack = legendOf(detailChart(r2Meta, r2Pts, { effAmber: 0.2, effRed: 0.27 }, { geo: STACK_CH }).svg);
    expect(stack).not.toContain(`${R2.label} · ${R2.label}`);
  });
});

describe("high60 hook - inclusive trailing max (the descriptor's 60-close high)", () => {
  const w = XDEV_GATE_DESCRIPTOR.scorer.constants.highWindow;
  // A flat 1.0 series of w + 10 closes with one spike `back` closes before the last point.
  const spikeAt = (back) => {
    const n = w + 10;
    return Array.from({ length: n }, (_, i) => ({ value: i === n - 1 - back ? 5 : 1 }));
  };

  it("mirrors the descriptor's highWindow", () => {
    expect(HIGH_WINDOWS.high60).toBe(w);
  });

  it("includes the close w-1 back (window = the day itself + w-1 prior), excludes the one w back", () => {
    expect(SERIES_HOOKS.high60(spikeAt(w - 1)).at(-1)).toBe(5);
    expect(SERIES_HOOKS.high60(spikeAt(w)).at(-1)).toBe(1);
    expect(SERIES_HOOKS.high60(spikeAt(0)).at(-1)).toBe(5); // today itself is in its own window
  });

  it("is null for the first w-1 points (window not full), defined from index w-1; a null in the window gaps", () => {
    const pts = Array.from({ length: w + 5 }, (_, i) => ({ value: i + 1 }));
    const h = SERIES_HOOKS.high60(pts);
    expect(h.slice(0, w - 1).every((v) => v === null)).toBe(true);
    expect(h[w - 1]).toBe(w);
    expect(h.at(-1)).toBe(w + 5);
    pts[w + 2] = { value: null };
    const g = SERIES_HOOKS.high60(pts);
    expect(g[w + 2]).toBeNull();
    expect(g.at(-1)).toBeNull();
  });
});

describe("detailChart - held-fund proxy segment (/api/series `proxy`)", () => {
  const meta = { id: "LEGP_SEMIS", label: "Semis SEC0", unit: "€", valueOnly: true, chart: buildIndicatorChart(byId("LEGP_SEMIS")) };
  const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));
  const series = (from, n) => days(from, n).map((d, i) => pt(d, 100 + i, "GREEN"));
  const proxy = { source: "SMH", until: "2021-08-06" };
  const shade = (svg) => svg.match(/<rect data-proxy-until="2021-08-06" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/);

  it("a join inside the window: shade spans x(start)..x(until); only pre-join readouts say proxy (SMH)", () => {
    const r = detailChart(meta, series("2021-07-30", 14), { proxy });
    const s = r.detail.samples;
    const m = shade(r.svg);
    expect(m, "shade rect emitted").not.toBeNull();
    expect(Number(m[1])).toBeCloseTo(s[0].x, 1);
    expect(Number(m[1]) + Number(m[2])).toBeCloseTo(s.find((p) => p.date === "2021-08-06").x, 1);
    expect(s.find((p) => p.date === "2021-08-05").readout).toContain("proxy (SMH)");
    expect(s.find((p) => p.date === "2021-08-06").readout).not.toContain("proxy");
    expect(s.at(-1).readout).not.toContain("proxy");
  });

  it("a window entirely before the join: shade clamps at the plot's right edge", () => {
    const m = shade(detailChart(meta, series("2021-07-01", 10), { proxy }).svg);
    expect(Number(m[1]) + Number(m[2])).toBeCloseTo(CH.ml + PLOT_W, 1);
  });

  it("`until` left of the window: no shade, no proxy readout — byte-identical to a proxy-less render", () => {
    const pts = series("2021-09-01", 14);
    const r = detailChart(meta, pts, { proxy });
    expect(r.svg).not.toContain("data-proxy-until");
    expect(r.detail.samples.filter((p) => p.readout.includes("proxy"))).toEqual([]);
    expect(r).toEqual(detailChart(meta, pts, {}));
  });
});

describe("fxPctTerms (F17 readout Δ as %)", () => {
  const pts = [100, 110, 105, 99].map((value) => ({ value }));
  it("Δ% vs the w-ago close", () => {
    expect(fxPctTerms(pts, 3, 3)).toEqual({ chg: "−1.0%" });
  });
  it("cold window ⇒ n/a change; missing window ⇒ null", () => {
    expect(fxPctTerms(pts, 1, 3).chg).toBe("n/a");
    expect(fxPctTerms(pts, 3, undefined)).toBeNull();
  });
});

describe("SERIES_HOOKS.offHigh (F17's spit yen-gate line)", () => {
  it("v / max of the inclusive window − 1; null before warm and across a gap", () => {
    const pts = [100, 110, 99, null, 120].map((value) => ({ value }));
    expect(SERIES_HOOKS.offHigh(pts.slice(0, 3), { window: 2 })).toEqual([null, 0, 99 / 110 - 1]);
    expect(SERIES_HOOKS.offHigh(pts, { window: 2 })[4]).toBeNull();
    expect(SERIES_HOOKS.offHigh(pts, {}).every((v) => v === null)).toBe(true);
  });
});

describe("SERIES_HOOKS.median (R6/VXSMH's MOVE_MEDIAN / VOL_MEDIAN toggle line)", () => {
  it("odd window = middle, even = mean of the two middles; null before warm, across a gap, and with no window", () => {
    const pts = [5, 1, 9, 3, null, 7].map((value) => ({ value }));
    expect(SERIES_HOOKS.median(pts.slice(0, 4), { window: 3 })).toEqual([null, null, 5, 3]);
    expect(SERIES_HOOKS.median(pts.slice(0, 4), { window: 2 })).toEqual([null, 3, 5, 6]);
    expect(SERIES_HOOKS.median(pts, { window: 2 }).slice(4)).toEqual([null, null]);
    expect(SERIES_HOOKS.median(pts, {}).every((v) => v === null)).toBe(true);
  });
});

// ── lowRise parity (ex-lowrise-parity.test.js) ──────────────────────────────────────────────────
// lowRise parity — the FE recompute vs the server's decisionAt arm.
//
// F1's `lowRise` credit leg is the FIRST derivedValue formula the FE RECOMPUTES for drawing (scored
// derived ids plot the persisted `decision` verbatim — scorers-core.ts:404 docblock). Two independent
// implementations of one formula — SERIES_HOOKS.lowRise (public/detail-chart.js) and the server's
// decisionAt → derivedValue("lowRise") arm (src/scorers-core.ts) — must agree, or the drawn line
// diverges from what the scorer would compute. This suite imports BOTH and pins the agreement.
//
// Plain `.js` so vitest collects it while tsc skips it; the TS import carries an explicit `.ts`
// specifier (frontend.md — the inverted `public/*.test.js` convention), the FE import a literal `.js`.
describe("lowRise parity - FE recompute vs the server decisionAt arm", () => {
  // The server's whole-array lowRise, assembled from the REAL decisionAt (the `window − 1` gap regime)
  // over the same DerivedView the persisted path uses.
  const serverSeries = (values, window) => values.map((_v, i) => decisionAt({ kind: "lowRise", window }, values, i));
  // The FE hook over the SAME numbers wrapped as wire points.
  const feSeries = (values, window) => SERIES_HOOKS.lowRise(values.map((v) => ({ value: v })), { window });

  it("agrees index-for-index over a null-free series, including the below-window gap regime", () => {
    // window 3 over 5 obs: indices 0,1 are the gap regime (i < window−1 ⇒ null); 2,3,4 carry the
    // value (min(10,8,12)=8→4; min(8,12,9)=8→1; min(12,9,7)=7→0).
    const values = [10, 8, 12, 9, 7];
    const server = serverSeries(values, 3);
    // Vacuity floor: the shared fixture really reaches BOTH regimes — a leading gap and a computed
    // value — so the equality below is not comparing two all-null arrays.
    expect(server[1]).toBeNull();
    expect(server[2]).toBe(4);
    expect(feSeries(values, 3)).toEqual(server);
  });
});

describe("genericSingle fit + secondary-axis overlays - characterization snapshots", () => {
  const metaOf = (id, chart) => {
    const i = byId(id);
    return { id: i.id, label: i.label, unit: i.unit ?? "%", cadence: i.cadence, thresholds: i.thresholds, channel: i.channel, chart: chart ?? buildIndicatorChart(i) };
  };
  const series = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, state: "GREEN", ...f(i) }));
  const closes = [100];
  for (let i = 1; i < 60; i++) closes.push(closes[i - 1] * (1 + 0.01 * Math.sin(i * 1.7)));
  const bonos = buildIndicatorChart(byId("BONOS"));
  const R7_CUTS = { r7DropAmber: -0.59, r7DropRed: -1.32, r7SteepAmber: 0.33, r7SteepRed: 0.63 };
  const velEff = (amber, red) => ({ effAmber: null, effRed: null, scorerLegs: ["vel-op"], legBounds: { "vel-op": { amber, red } } });
  const ROWS = {
    "R4: pooled Δ scale + ref + one zero; value/pp axis with threshold bands": () => {
      const meta = metaOf("R4");
      const pts = series(130, (i) => ({ value: 2 + 0.05 * Math.sin(i / 15), delta20: 0.01 * Math.sin(i / 7) }));
      return [meta, pts, velEff(meta.thresholds.amberVelocity, meta.thresholds.redVelocity)];
    },
    "LEGP_EUFIN: pooled RV scale; no secondary axis (PENSION % axis)": () => [metaOf("LEGP_EUFIN"), closes.map((v, i) => ({ date: `d${String(i).padStart(3, "0")}`, value: v, state: "GREEN" }))],
    "R7: gated two-leg derived axis, perPoint-only bands": () => [
      metaOf("R7"),
      [
        { date: "2026-01-02", value: 0.2, state: "GREEN", bullLegs: { drop: -0.1, steep: 0.15 }, bandCuts: { ...R7_CUTS }, gates: { shortEndDriven: true } },
        { date: "2026-01-03", value: 0.1, state: "GREEN", bullLegs: { drop: -0.45, steep: 0.4 }, bandCuts: { ...R7_CUTS }, gates: { shortEndDriven: false } },
        { date: "2026-01-04", value: 0.05, state: "AMBER", bullLegs: { drop: -0.62, steep: 0.55 }, bandCuts: { ...R7_CUTS }, gates: { shortEndDriven: true } },
        { date: "2026-01-05", value: 0.0, state: "GREEN", bullLegs: { drop: -0.3, steep: 0.2 }, bandCuts: { r7SteepAmber: 0.33, r7SteepRed: 0.63 }, gates: { shortEndDriven: true } },
      ],
      velEff(R7_CUTS.r7SteepAmber, R7_CUTS.r7SteepRed),
    ],
    "BONOS cold: no Δ5 yet; bp value-format axis": () => [metaOf("BONOS"), series(4, (i) => ({ value: 60 + i, velZ: 0.3 * i }))],
    "BONOS flat + a non-delta fit line: per-index keys, pad fallbacks": () => [
      metaOf("BONOS", { ...bonos, series: [...bonos.series, { axis: "primary", fromPoint: "delta20", fit: true, label: "Δ20 probe" }] }),
      series(12, () => ({ value: 70, velZ: 0.5, delta20: 0.5 })),
    ],
  };
  it.each(Object.keys(ROWS))("%s", (name) => {
    const [meta, pts, eff = {}] = ROWS[name]();
    expect(detailChart(meta, pts, eff)).toMatchSnapshot();
  });
});
