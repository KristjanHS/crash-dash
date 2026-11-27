// R5: a `redacted` /api/series payload — a licensed
// id as served, points stripped to date + state — renders the ribbon-only frame: no level,
// axis, cut, Δ or value chip anywhere in the markup or readout. Plain `.js`, no jsdom.
import { describe, expect, it } from "vitest";
import { detailChart, ribbonOnlyChart } from "./detail-chart.js";
import { renderDetailTab } from "./detail-tab.js";
import { guardToken, isCurrent } from "./app-state.js";
import { topIndicatorsFor } from "./leg-top.js";
import { STACK_CH, esc } from "./chart-primitives.js";
import { ALL_INDICATORS } from "../src/registry";
import { buildIndicatorChart } from "../api/indicators";

const meta = (i) => ({ id: i.id, label: i.label, unit: i.unit ?? "%", cadence: i.cadence, chart: buildIndicatorChart(i) });
const F1 = ALL_INDICATORS.find((i) => i.id === "F1");
const F8 = ALL_INDICATORS.find((i) => i.id === "F8");

// The R7 wire shape: date/state/rawState/leg?/provisional?/estimated? only — one pending cell.
const RED_PTS = [
  { date: "2026-01-02", state: "GREEN", rawState: "GREEN" },
  { date: "2026-01-05", state: "GREEN", rawState: "AMBER" },
  { date: "2026-01-06", state: "AMBER", rawState: "AMBER", leg: "op" },
  { date: "2026-01-07", state: "RED", rawState: "RED", leg: "vel-op" },
  { date: "2026-01-08", state: "RED", rawState: "RED", provisional: true },
];
const FULL_PTS = RED_PTS.map((p, i) => ({ ...p, value: 3.1 + i * 0.7, delta20: 0.2 * i }));
// Envelope cut numbers a redacted body might still carry — the frame must ignore them.
const EFF = { effAmber: 4.5, effRed: 6.25, scorerLegs: ["op"], confirmCloses: 2 };

/** Rendered TEXT (tags dropped) minus ISO dates and the chart's own name tokens. Any digit left is a level. */
function strayDigits(html, m) {
  let t = html.replace(/<[^>]*>/g, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ");
  for (const tok of [esc(m.label ?? ""), esc(m.id ?? "")].filter(Boolean)) t = t.split(tok).join(" ");
  return t.match(/\S*\d\S*/g);
}

describe("ribbon-only frame (R5) for a redacted payload", () => {
  it("F1 redacted: no line, no axis/cut/Δ text, a ribbon cell per point, readout = date · STATE", () => {
    const m = meta(F1);
    const r = detailChart(m, RED_PTS, EFF, { redacted: true });
    expect(strayDigits(r.svg, m)).toBeNull();
    expect(r.svg).not.toContain("<path");
    expect(r.svg).not.toContain('class="axis-y"');
    for (const p of RED_PTS) expect(r.svg).toContain(`<title>${p.date} ${p.state}`);
    expect(r.svg).toContain("(raw AMBER, unconfirmed on this close)");
    expect(r.detail.samples.map((s) => s.readout)).toEqual([
      "2026-01-02 · GREEN",
      "2026-01-05 · GREEN",
      "2026-01-06 · AMBER",
      "2026-01-07 · RED",
      "2026-01-08 · RED · INTRADAY",
    ]);
    for (const s of r.detail.samples) {
      expect(s.dotY).toBeNull();
      expect(s.chip.replace(/^\d{2}-\d{2}-\d{2}/, "")).not.toMatch(/\d/);
    }
  });

  it("every ALL_INDICATORS id, single and stacked frame: no stray digit", () => {
    for (const i of ALL_INDICATORS) {
      const m = meta(i);
      for (const geo of [undefined, STACK_CH]) {
        const r = detailChart(m, RED_PTS, EFF, { redacted: true, geo });
        expect([i.id, strayDigits(r.svg, m)]).toEqual([i.id, null]);
        for (const s of r.detail.samples) expect([i.id, s.readout]).toEqual([i.id, expect.stringMatching(/^\d{4}-\d{2}-\d{2} · (GREEN|AMBER|RED)( · INTRADAY)?$/)]);
      }
    }
  });

  it("an estimated tail never enters the ribbon; empty input is a sane empty frame", () => {
    const m = meta(F1);
    const r = ribbonOnlyChart(m, [...RED_PTS, { date: "2026-01-09", state: "RED", estimated: true }]);
    expect(r.detail.n).toBe(RED_PTS.length);
    expect(r.svg).not.toContain("2026-01-09");
    const e = ribbonOnlyChart(m, []);
    expect(e.detail.n).toBe(0);
    expect(strayDigits(e.svg, m)).toBeNull();
  });

  it("the same id unredacted still draws its level line and y-axis", () => {
    const r = detailChart(meta(F1), FULL_PTS, EFF);
    expect(r.svg).toContain('class="line"');
    expect(r.svg).toContain('class="axis-y"');
  });
});

describe("detail-tab wires series.redacted into the ribbon-only frame", () => {
  async function paint(m, series) {
    const writes = [];
    const setStates = [];
    const state = { indicators: [m], zoneD: { tab: "detail", indicatorId: m.id, legId: null, compareIds: [null, null] }, familyOrder: [] };
    await renderDetailTab({ id: "zone-d-panel" }, state, {
      getMemberWeight: async () => null,
      fetchSeries: async () => series,
      topIndicatorsFor,
      guardToken,
      isCurrent,
      setState: (slice, patch) => setStates.push(patch),
      setHTML: (_el, html) => writes.push(html),
    });
    return { html: writes.at(-1), details: setStates.at(-1).details };
  }

  it("redacted F8: one ribbon-only chart, readout date · STATE", async () => {
    const m = meta(F8);
    const { html, details } = await paint(m, { unit: m.unit, redacted: true, ...EFF, points: RED_PTS });
    expect(html.match(/<svg class="chart"/g)).toHaveLength(1);
    const chart = html.slice(html.indexOf("<svg"), html.lastIndexOf("</svg>"));
    expect(chart).not.toContain("<path");
    expect(strayDigits(chart, m)).toBeNull();
    expect(details[0].samples[0].readout).toBe("2026-01-02 · GREEN");
  });

  it("unredacted F1 through the tab still draws the line", async () => {
    const { html } = await paint(meta(F1), { unit: "%", ...EFF, points: FULL_PTS });
    expect(html).toContain('class="line"');
  });
});
