// The DISP ribbon/chart correlate. Redesign 2026-07-22:
// the 20d BASKET return is the de-risk
// TRIGGER and correlation is a single CONFIRM gate. So the roles on the chart are:
//
//   drawn  — the basket return (persisted per point as `decision`), one RED band at
//            DISP_BASKET_RED (−2.5%). The AMBER tier (−2.5%..0) has no band line; the ribbon
//            colours it from the stored state.
//   gated  — the corr level, as ONE GATES.DISP confirm gate (appliesTo "both").
//
// The ribbon COLOUR comes from the stored state (`dispersionState`), NOT the gate flag. The
// gate flag (`atOrAboveCutFlags`, `>=`) is a display DIMMING hint and is off-by-one at corr
// EXACTLY 0.75: the predicate is STRICT `> 0.75` (GREEN at 0.75) while the flag is `>=` (on at
// 0.75). That single boundary is asserted below as the intended display edge.
//
// PROVEN NON-VACUOUS: the grid expectation is re-stated in the POSITIVE form (independent of the
// production `!(...)` idiom), so a change to DISP_CORR, DISP_BASKET_RED, or the strictness makes
// `dispersionState` disagree with it. Both were run red (corr cut → 0.7; depth cut → 0) before
// this was committed.
import { describe, it, expect } from "vitest";

import { GATES, atOrAboveCutFlags, atOrAboveRollingMaxFlags, belowMAFlags, rollingMaxValues } from "./gates.js";
import { dispersionState } from "./scorers-composite.js";
import { DISP_CORR, DISP_BASKET_RED } from "./family-descriptor-rows.js";
import { levelGateOn } from "./scorers-core.js";
import { GEO_HYBRID_DESCRIPTOR_OF } from "./family-descriptor-rows.js";
import { earlierCut, resolveMultiplier } from "./threshold-config.js";

/**
 * The DISP cut gates, narrowed off the `rule` discriminant. Every DISP def is expected
 * to be a cut gate; the length pin below fails loudly if one ever isn't, rather than
 * letting this filter silently drop it and shrink what the correlate tests.
 */
const dispCutGates = GATES.DISP!.flatMap((g) => (g.rule === "atOrAboveCut" ? [g] : []));

/** The DISP cut gate defs, by key, as the wire ships them. */
const dispGates = Object.fromEntries(dispCutGates.map((g) => [g.key, g]));

/** Reproduce api/series.ts gatedSeries' flag computation for a single corr value. */
function gateFlagsFor(meanCorr: number): Record<string, boolean> {
  const m = resolveMultiplier("DISP");
  return Object.fromEntries(
    dispCutGates.map((def) => [def.key, atOrAboveCutFlags([meanCorr], earlierCut(def.cut, true, m))[0]!]),
  );
}

/**
 * The redesigned predicate, re-stated in the POSITIVE form so it is an INDEPENDENT oracle for
 * `dispersionState` (finite inputs only — NaN handling is pinned in dashboard.composites.test.ts). A
 * mutation to the corr cut, the depth cut, or the strict `>` makes the two disagree.
 */
function expected(corr: number, basket: number): "GREEN" | "AMBER" | "RED" {
  if (basket >= 0) return "GREEN"; // negative-basket gate
  if (corr <= DISP_CORR) return "GREEN"; // STRICT confirm gate: at/below the cut is GREEN
  return basket < DISP_BASKET_RED ? "RED" : "AMBER"; // basket DEPTH splits the tiers
}

describe("GATES.DISP - the drawn-vs-gated split (redesign 2026-07-22)", () => {
  it("declares exactly ONE corr confirm gate, appliesTo both, inclusive-flag and multiplier-free", () => {
    // One cut gate now — the AMBER/RED split moved to the basket axis, so the corr axis no longer
    // distinguishes the tiers. The `rule`-narrowing filter cannot quietly shrink the set.
    expect(dispCutGates).toHaveLength(GATES.DISP!.length);
    expect(dispCutGates.map((g) => [g.key, g.appliesTo, g.rule, g.cut])).toEqual([
      ["corrAtOrAboveCut", "both", "atOrAboveCut", DISP_CORR],
    ]);
    // The RAW constant, not pre-multiplied: resolution belongs to the consumer, so a config
    // multiplier change takes effect without a redeploy.
    expect(dispGates.corrAtOrAboveCut!.cut).toBe(DISP_CORR);
  });

  it("cut gates carry no MA window - they have no lookback, so every point gets a flag", () => {
    for (const def of GATES.DISP!) expect("window" in def).toBe(false);
    // No null left-edge hole (contrast belowMAFlags, which nulls the first window−1).
    expect(atOrAboveCutFlags([0.1, 0.9, 0.5], 0.5)).toEqual([false, true, true]);
    expect(belowMAFlags([1, 2, 3], 2)[0]).toBeNull();
  });
});

describe("DISP ribbon correlate - state ⟺ basket-depth tier AND corr confirm", () => {
  // A grid that straddles the corr confirm cut and the basket depth cut on both signs.
  const corrs = [0.0, 0.3, 0.7, DISP_CORR - 0.01, DISP_CORR, DISP_CORR + 0.01, 0.8, 1.0];
  const baskets = [-0.2, -0.05, -0.03, DISP_BASKET_RED, -0.02, -0.0001, 0, 0.0001, 0.05];

  it("scores every grid cell exactly as the independent positive-form predicate", () => {
    for (const corr of corrs) {
      for (const basket of baskets) {
        expect({ corr, basket, s: dispersionState(corr, basket) }).toEqual({
          corr,
          basket,
          s: expected(corr, basket),
        });
      }
    }
  });

  it("BOUNDARY: at corr EXACTLY 0.75 the ribbon is GREEN (strict >) though the display flag is ON (>=)", () => {
    // The one point where the `>=` display gate and the strict `>` predicate diverge. The gate
    // flag dims the line ON, but the ribbon COLOUR (the state) is GREEN — intended display edge.
    for (const basket of baskets.filter((b) => b < 0)) {
      expect(dispersionState(DISP_CORR, basket)).toBe("GREEN");
    }
    expect(gateFlagsFor(DISP_CORR).corrAtOrAboveCut).toBe(true);
  });
});

// --- R5: the oil trailing-peak gate (atOrAboveRollingMax) ---------------------------------
//
// The oil family's `level: "trailing-peak"` leg reaches the chart as a GATE rather than a band.
// What these pin is the SEAM, not the numbers: the flag must equal the scorer's own
// `levelGateOn` wherever it emits one, and must emit nothing where it would have to guess.
describe("atOrAboveRollingMaxFlags - the drawn trailing-peak gate", () => {
  it("is null for exactly the first `window` points, and a real boolean after", () => {
    const flags = atOrAboveRollingMaxFlags([5, 4, 6, 3, 7, 2, 8], 3);
    expect(flags.slice(0, 3)).toEqual([null, null, null]);
    expect(flags.slice(3).every((f) => typeof f === "boolean")).toBe(true);
  });

  it("agrees with the scorer's levelGateOn at every covered index", () => {
    // Shaped so BOTH arms occur — an all-rising series would make the agreement vacuous.
    const values = [10, 12, 11, 9, 13, 8, 7, 14, 6, 15];
    const window = 3;
    const flags = atOrAboveRollingMaxFlags(values, window);
    for (let i = window; i < values.length; i++) expect(flags[i]).toBe(levelGateOn(values, i, window));
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it("excludes the point itself from the peak: a new high is ON, a tie is ON, a lower close is OFF", () => {
    expect(atOrAboveRollingMaxFlags([1, 2, 3, 4], 3)[3]).toBe(true);
    expect(atOrAboveRollingMaxFlags([1, 2, 3, 3], 3)[3]).toBe(true); // `>=`, not `>`
    expect(atOrAboveRollingMaxFlags([1, 2, 3, 2.9], 3)[3]).toBe(false);
  });

  it("rollingMaxValues is the flag's own max: null exactly where the flag is, flag ≡ value ≥ peak", () => {
    // Shaped so BOTH arms occur, as above — the drawn line and the dim/dash flag must not drift.
    const values = [10, 12, 11, 9, 13, 8, 7, 14, 6, 15];
    const window = 3;
    const peaks = rollingMaxValues(values, window);
    const flags = atOrAboveRollingMaxFlags(values, window);
    expect(peaks.slice(0, window)).toEqual([null, null, null]);
    for (let i = window; i < values.length; i++) {
      expect(peaks[i]).toBe(Math.max(...values.slice(i - window, i)));
      expect(flags[i]).toBe(values[i]! >= peaks[i]!);
    }
  });

  it("G1/BRENT declare the gate at their descriptor's window; an OR-combine id must NOT - its leg is a disjunct", () => {
    for (const id of ["G1", "BRENT"]) {
      const def = GATES[id]?.find((d) => d.rule === "atOrAboveRollingMax");
      expect(def, `${id} owes a trailing-peak gate def`).toBeDefined();
      // The window is DATA read off the descriptor — never retyped into gates.ts.
      expect(def!.rule === "atOrAboveRollingMax" && def!.window).toBe(
        GEO_HYBRID_DESCRIPTOR_OF[id]!.scorer.constants.levelWindow,
      );
      // ...and the id it is declared for really is the kind whose RED is gated by the at-peak
      // flag (`"split"` since 2026-08-11 — AMBER fires ungated, so the gate binds RED only).
      expect(GEO_HYBRID_DESCRIPTOR_OF[id]!.combine).toBe("split");
    }
    // gates.ts is AND-semantic: rendering an OR leg as a gate would dim stretches that fire.
    const orIds = Object.keys(GEO_HYBRID_DESCRIPTOR_OF).filter((id) => GEO_HYBRID_DESCRIPTOR_OF[id]!.combine === "or");
    expect(orIds.length).toBeGreaterThan(0);
    for (const id of orIds) expect(GATES[id], id).toBeUndefined();
  });
});
