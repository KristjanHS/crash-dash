/**
 * Lint: every descriptor-declared secondary scoring quantity has a drawn carrier — the R1 class.
 * Reads the same maps the scorer reads
 * (`SMOOTHED_LEVEL_OF[id].redWindow` → a second mean SERIES; `levelCuts` → moving mean-cut BANDS).
 * Blind spot: a quantity scored ONLY inside a bespoke scorer body (R8's Δ10-of-mean velocity leg,
 * `smoothedLevelReadingSeries` levelCuts arm — its sole secondary axis is the display-only probit) is not reached.
 */
import { describe, expect, it } from "vitest";
import { ALL_INDICATORS } from "./registry.js";
import { buildIndicatorChart } from "../api/indicators.js";
import { R8_MEAN_CUT_BANDS, SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";

describe("drawn lines explain the ribbon", () => {
  // Roster non-empty AND admits the ids each arm must bite — a mis-filtered roster passes forever.
  const RED_WINDOW = ALL_INDICATORS.filter((i) => SMOOTHED_LEVEL_OF[i.id]?.redWindow !== undefined);
  const LEVEL_CUTS = ALL_INDICATORS.filter((i) => i.postInversionCooldown?.levelCuts !== undefined);
  it("iterates a non-empty scored roster covering both arms", () => {
    expect(ALL_INDICATORS.length).toBeGreaterThan(20);
    expect(RED_WINDOW.map((i) => i.id)).toContain("R1");
    expect(LEVEL_CUTS.map((i) => i.id)).toContain("R8");
  });

  // Identity, not a count: a second mean WINDOW needs the `scored-mean` carrier itself drawn —
  // an unrelated extra primary line must NOT satisfy this arm.
  for (const i of RED_WINDOW) {
    it(`${i.id}: drawn carrier for its scored red-window mean`, () => {
      const scored = buildIndicatorChart(i).series.filter((s) => s.axis === "primary" && s.style === "scored-mean");
      expect(scored.length, `${i.id}: ${SMOOTHED_LEVEL_OF[i.id]!.redWindow}-obs mean is scored but no primary series carries it`).toBeGreaterThanOrEqual(1);
    });
  }
  // Identity, not a count: the mean-space cut pair itself must be drawn — an unrelated primary
  // perPoint band must NOT satisfy this arm.
  for (const i of LEVEL_CUTS) {
    it(`${i.id}: drawn moving-cut band for every mean-space levelCut`, () => {
      const spec = buildIndicatorChart(i);
      const drawn = new Set((Array.isArray(spec.bands) ? spec.bands : []).filter((b) => b.axis === "primary" && b.source === "perPoint").map((b) => b.fromPoint));
      for (const c of R8_MEAN_CUT_BANDS) {
        expect(drawn.has(c.key), `${i.id}: mean-space ${c.level} levelCut scored but its moving-cut band is not drawn`).toBe(true);
      }
    });
  }
});
