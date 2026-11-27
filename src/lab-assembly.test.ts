import { describe, expect, test } from "vitest";

import { legHistoryLimitFor, prevTargetOf } from "./lab-assembly.js";
import { LADDER } from "./families.js";
import { velocitySigmaDepth } from "./domain-fold.js";
import { ALL_INDICATORS } from "./registry.js";

describe("prevTargetOf", () => {
  test("a LADDER sleeve maps to its rung; unknown or absent is a cold start (null), never rung 0", () => {
    expect(prevTargetOf(LADDER[3]!)).toBe(4);
    for (const held of ["Dogecoin", null, undefined]) {
      expect(prevTargetOf(held), String(held)).toBeNull();
    }
  });
});

// The leg-recompute's stored-history depth (review C1, 2026-08-08). It used to be one constant on
// the premise that the recompute needs "NO distributional window" — false for a ROLLING-σ id, whose
// `vel-z` leg needs `velocitySigma.minObs` historical Δw values and pays `velocityWindow` leading
// observations for each. At 60 rows F9 gets ZERO usable deltas, its only leg degrades dark, the
// recompute scores GREEN and `attributeLeg` declines every non-GREEN row `recompute-disagreed`.
// The requirement is DERIVED from each id's own registry config here, never restated.
describe("legHistoryLimitFor - per-id recompute depth", () => {
  test("a σ id is fetched deep enough to clear its own σ floor; every other id keeps the base depth", () => {
    const sigmaIds = ALL_INDICATORS.filter((i) => i.thresholds.velocitySigma);
    // Non-vacuity: this whole case is about a population that must not be empty.
    expect(sigmaIds.length, "no velocitySigma id left - this guard is inert").toBeGreaterThan(0);
    for (const ind of sigmaIds) {
      const cfg = ind.thresholds.velocitySigma!;
      const w = ind.velocityWindow ?? 20;
      // Usable Δw values inside the fetched window = rows − w. It must clear the ESTIMATOR's depth
      // (`minObs` is only the emit floor — a blended id's EWMA seed survives far past it) with room
      // to spare, so a handful of missing stored rows cannot silently re-cross it.
      expect(legHistoryLimitFor(ind) - w, `${ind.id} usable deltas`).toBeGreaterThan(velocitySigmaDepth(cfg));
    }
    // The contrast arm: a plain id must NOT pay the deep read.
    const plain = ALL_INDICATORS.find((i) => !i.thresholds.velocitySigma && i.id === "F10")!;
    expect(legHistoryLimitFor(plain)).toBeLessThan(legHistoryLimitFor(sigmaIds[0]!));
  });

  // ⚠ No descriptor-scored member in `DUAL_AXIS_IDS` since 2026-09-04 (it went velocity-only); the
  // composite branch this block once pinned is deleted with it (`legHistoryLimitFor` docblock).
});
