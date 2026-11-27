// Behavior tests for the alert-ladder chart seam (plain `.js`: vitest collects it, tsc skips it).
// The chart's own geometry is chart-primitives' (`xAt`/`yAt`), imported here rather than restated,
// so a frame change moves both the chart and its expectations.
import { describe, it, expect } from "vitest";
import { ladderChart } from "./ladder-chart.js";
import { CH, xAt, yAt } from "./chart-primitives.js";

const CFG = { alertRank: { OK: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 } };
// /api/history order: NEWEST first. The chart reverses it.
const HISTORY = [
  { date: "2026-08-03", level: "CRITICAL", pushedAt: "2026-08-03T06:00:00Z" },
  { date: "2026-08-02", level: "WATCH", pushedAt: null },
  { date: "2026-08-01", level: "OK", pushedAt: null },
];

describe("ladderChart - the pointer-readout seam", () => {
  it("returns one sample per run, oldest first, on the drawn dot's coordinates", () => {
    const { detail } = ladderChart(HISTORY, CFG);
    expect(detail.n).toBe(3);
    expect(detail.samples.map((s) => s.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(detail.samples[2]).toMatchObject({
      x: xAt(2, 3, CH),
      dotY: yAt(3, 0, 3, CH), // CRITICAL = the top rung
    });
    // `ys` is the per-column line occupancy the chip's parking walk reads: the stepped
    // line is the only per-column mark, so each sample occupies exactly its own rung.
    expect(detail.samples.map((s) => s.ys)).toEqual([0, 1, 3].map((r) => [yAt(r, 0, 3, CH)]));
  });

  it("degrades an off-ladder level to the bottom rung rather than a gap", () => {
    // Reachable on a stored row whose level predates the served alertRank.
    const { detail } = ladderChart([{ date: "2026-08-01", level: "RETIRED", pushedAt: null }], CFG);
    expect(detail.samples[0].dotY).toBe(yAt(0, 0, 3, CH));
    expect(detail.samples[0].chip).toBe("26-08-01 · RETIRED");
  });

  it("draws a pushed run as the ringed alert-coloured dot and a silent one faint", () => {
    const { svg } = ladderChart(HISTORY, CFG);
    expect(svg).toContain('r="3.5" fill="var(--alert-critical)"');
    expect(svg).toContain('r="1.6" fill="var(--ink-dim)"');
  });

  it("reads out the level and whether that run pushed", () => {
    const { detail } = ladderChart(HISTORY, CFG);
    expect(detail.samples[2].readout).toBe("2026-08-03 · CRITICAL · pushed run");
    expect(detail.samples[1].readout).toBe("2026-08-02 · WATCH · silent run");
    // The travelling chip carries the compact date; the ● marks a pushed run.
    expect(detail.samples[2].chip).toBe("26-08-03 · CRITICAL ●");
    expect(detail.samples[1].chip).toBe("26-08-02 · WATCH");
  });

  it("emits the hover layer and the slot the scrub handler pairs samples with", () => {
    const { svg } = ladderChart(HISTORY, CFG);
    expect(svg).toContain('<g class="hover-layer"');
    expect(svg).toContain('class="xhair"');
    expect(svg).toContain('class="hover-chip"'); // chip form, as on the detail charts
  });

  it("carries the rung gridlines as staticYs so the chip parks clear of them", () => {
    const { detail } = ladderChart(HISTORY, CFG);
    expect(detail.staticYs).toEqual([0, 1, 2, 3].map((r) => yAt(r, 0, 3, CH)));
  });

  it("takes the rung set and order from the served alertRank, never a hardcoded ladder", () => {
    const twoRung = ladderChart([{ date: "2026-08-01", level: "HIGH", pushedAt: null }], {
      alertRank: { LOW: 0, HIGH: 1 },
    });
    expect(twoRung.detail.staticYs).toEqual([yAt(0, 0, 1, CH), yAt(1, 0, 1, CH)]);
    expect(twoRung.detail.samples[0].dotY).toBe(yAt(1, 0, 1, CH));
    expect(twoRung.svg).toContain(">HIGH</text>");
    expect(twoRung.svg).not.toContain(">CRITICAL</text>");
  });
});
