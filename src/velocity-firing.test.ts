/**
 * D3 Stage 2.2 — the read-only `velocityFiringCount` diagnostic derived beside `bandReason`
 * in `run-core.ts`. Pins the four ways the count can be wrong: a velocity-attributed dual-axis fire
 * must count, the SAME id level-attributed must not, a GREEN id must not, and the velocity-ONLY
 * ids (R2/R3/R4) must not — their every fire is a velocity fire by construction, so letting them
 * in would leak the tautology §1 excludes definitionally.
 */
import { describe, expect, test } from "vitest";
import {
  DUAL_AXIS_IDS,
  LEG_ORDER,
  isVelocityLeg,
  velocityFiringCount,
} from "./domain-legs.js";
import { type State } from "./domain-types.js";

/** Minimal `Reading`-shaped double — `velocityFiringCount` reads only these three fields. */
function reading(id: string, state: State, leg?: string) {
  return { indicator: { id }, state, ...(leg === undefined ? {} : { leg }) };
}

describe("isVelocityLeg", () => {
  test("exactly the six velocity-class legs of LEG_ORDER are velocity", () => {
    // `vel-cusum` (the one-sided CUSUM persistence leg)
    // is velocity-class: its accumulator sums VELOCITY z's.
    expect(LEG_ORDER.filter(isVelocityLeg)).toEqual(["vel-op", "vel-evt", "vel-z", "vel-z-fast", "vel-z-slow", "vel-cusum"]);
  });

  test("the level-class legs - including the LEVEL z-score `z` - are not velocity", () => {
    expect(LEG_ORDER.filter((l) => !isVelocityLeg(l))).toEqual(["op", "evt", "z"]);
  });

  test("an absent leg (attribution suppressed / unscored reading) is not velocity", () => {
    expect(isVelocityLeg(undefined)).toBe(false);
  });
});

describe("velocityFiringCount", () => {
  test("all three velocity legs count", () => {
    expect(
      velocityFiringCount([
        reading("F1", "RED", "vel-op"),
        reading("F2", "AMBER", "vel-evt"),
        // CCC, not F9: F9 LEFT `DUAL_AXIS_IDS` on 2026-08-07 when its level axis was retired,
        // so it is now excluded by the
        // velocity-ONLY tautology rule and could never contribute a third fire here.
        reading("CCC", "RED", "vel-z"),
      ]),
    ).toBe(3);
  });

  test("the SAME id firing on a level leg does NOT count", () => {
    for (const leg of ["op", "evt", "z"]) {
      expect(velocityFiringCount([reading("F1", "RED", leg)])).toBe(0);
    }
  });

  test("the velocity-ONLY ids R2/R3/R4 do NOT count - the tautology exclusion must not leak", () => {
    expect(
      velocityFiringCount([
        reading("R2", "RED", "vel-op"),
        reading("R3", "AMBER", "vel-evt"),
        reading("R4", "RED", "vel-z"),
      ]),
    ).toBe(0);
  });

  test("mixed run: only the dual-axis velocity fires are counted", () => {
    expect(
      velocityFiringCount([
        reading("F1", "RED", "vel-op"), // counts
        reading("F2", "AMBER", "op"), // level-attributed
        // T10YIE, not F9 (2026-08-07): this arm exists to prove a GREEN DUAL-AXIS id doesn't count.
        // Post-retirement F9 would be excluded by POPULATION instead, silently duplicating the
        // R2 arm below and leaving the GREEN reason unexercised in the mixed run.
        reading("T10YIE", "GREEN", "vel-op"), // not firing
        reading("F10", "AMBER", "vel-evt"), // counts
        reading("R2", "RED", "vel-op"), // velocity-ONLY, excluded
        reading("VT", "RED", "vel-op"), // not in the population
        // F3, not BAA10Y (2026-08-11, BAA10Y indicator retired): this arm exists to prove an
        // UNATTRIBUTED reading (`Reading.leg` undefined) doesn't count. It must use a CURRENT
        // `DUAL_AXIS_IDS` member — a non-member would be excluded by POPULATION instead, silently
        // duplicating the VT arm above and leaving the no-attribution reason unexercised.
        reading("F3", "RED"), // no attribution
      ]),
    ).toBe(2);
  });

  test("every id in the population is actually counted (no hardcoded subset)", () => {
    const all = DUAL_AXIS_IDS.map((id) => reading(id, "RED", "vel-op"));
    expect(velocityFiringCount(all)).toBe(DUAL_AXIS_IDS.length);
  });
});
