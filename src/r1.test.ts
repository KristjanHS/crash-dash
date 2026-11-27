import { describe, expect, it } from "vitest";
import {
  R1_FLOOR_RUNG,
  R1_UP_CONFIRM,
  computeR1,
} from "./r1.js";

describe("computeR1 - cold start", () => {
  it("seats at target with no walk when priorRung is null", () => {
    const r = computeR1(6, null, 0);
    expect(r.nextRung).toBe(6);
    expect(r.path).toEqual([]);
    expect(r.stepsRemaining).toBe(0);
    expect(r.direction).toBe("hold");
    expect(r.reason).toBe("cold start - seat at target");
  });
});

describe("computeR1 - hold at target", () => {
  it("reports direction hold and an empty path when targetRung === priorRung", () => {
    const r = computeR1(4, 4, 0);
    expect(r).toMatchObject({ nextRung: 4, direction: "hold", stepsRemaining: 0, atFloor: false });
    expect(r.path).toEqual([]);
  });

  it("flags atFloor when it is already parked on the floor", () => {
    expect(computeR1(9, 9, 0).atFloor).toBe(true);
  });
});

describe("computeR1 - de-risk (R1_STEP_DOWN)", () => {
  // Pins R1_STEP_DOWN: a step of 2 would emit [4,6,8,9] — 4 elements, not 7.
  it("a rung-2 → rung-9 de-risk produces a 7-element path, one rung apart", () => {
    const r = computeR1(9, 2, 0);
    expect(r.path).toEqual([3, 4, 5, 6, 7, 8, 9]);
    // One rung per close — never a jump to the floor.
    expect(r.nextRung).toBe(3);
    expect(r.direction).toBe("derisk");
    expect(r.stepsRemaining).toBe(7);
    expect(r.atFloor).toBe(false);
  });

  it("de-risk ignores reriskConfirmCount entirely - down fires easier than up", () => {
    for (const count of [0, R1_UP_CONFIRM]) {
      expect(computeR1(7, 4, count).nextRung).toBe(5);
      expect(computeR1(7, 4, count).direction).toBe("derisk");
    }
  });
});

describe("computeR1 - re-risk (R1_STEP_UP, R1_UP_CONFIRM)", () => {
  // Pins R1_STEP_UP: asserts the literal rung 8 from a rung-9 prior, so a step of 2 (→ 7) goes red.
  it("re-risk advances exactly one rung per close once confirmed", () => {
    const r = computeR1(2, 9, R1_UP_CONFIRM);
    expect(r.nextRung).toBe(8);
    expect(r.direction).toBe("rerisk");
    expect(r.path).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(r.stepsRemaining).toBe(7);
  });

  // Pins R1_UP_CONFIRM: literal counts, so a value of 3 leaves count 2 holding and goes red.
  it("re-risk holds at priorRung while reriskConfirmCount < R1_UP_CONFIRM and advances at exactly R1_UP_CONFIRM", () => {
    expect(computeR1(3, 6, 0)).toMatchObject({ nextRung: 6, direction: "hold" });
    expect(computeR1(3, 6, 1)).toMatchObject({ nextRung: 6, direction: "hold" });
    expect(computeR1(3, 6, 2)).toMatchObject({ nextRung: 5, direction: "rerisk" });
  });

  it("an unconfirmed re-risk still publishes the pending walk for /lab", () => {
    const r = computeR1(3, 6, 0);
    expect(r.path).toEqual([5, 4, 3]);
    expect(r.stepsRemaining).toBe(3);
    expect(r.reason).toContain("0/2");
  });
});

describe("computeR1 - floor (R1_FLOOR_RUNG)", () => {
  // Pins R1_FLOOR_RUNG: asserts the literal 9, so a floor of 10 emits a 10 and goes red.
  it("targetRung 12 clamps nextRung and every path element to R1_FLOOR_RUNG", () => {
    expect(computeR1(12, 2, 0).path).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(computeR1(12, 8, 0).nextRung).toBe(9);
    expect(computeR1(12, 8, 0).atFloor).toBe(true);
  });

  it("clamps a cold start above the floor too - never off-ladder into cash", () => {
    expect(computeR1(12, null, 0).nextRung).toBe(9);
    expect(computeR1(12, null, 0).atFloor).toBe(true);
  });

  it("an already-floored prior with an above-floor target is a no-op hold", () => {
    expect(computeR1(12, 9, 0)).toMatchObject({ nextRung: 9, direction: "hold", atFloor: true });
  });
});

describe("computeR1 - non-finite targetRung", () => {
  // Without the clampRung guard this HANGS rather than failing: clampRung(NaN) is NaN, the
  // `target === prior` equality is false, and buildPath's `while (cursor !== to)` never terminates
  // (still spinning at 1e6 iterations). The explicit timeout makes a regression fail fast instead of
  // wedging the whole suite.
  it.each([NaN, Infinity, -Infinity])(
    "terminates and seats on the defensive floor for targetRung %p",
    (target) => {
      const r = computeR1(target, 4, 0);
      expect(r.path).toEqual([5, 6, 7, 8, 9]);
      expect(r.nextRung).toBe(5);
      expect(r.direction).toBe("derisk");
    },
    2000,
  );

  it(
    "terminates on a non-finite target from an already-floored prior",
    () => {
      expect(computeR1(NaN, 9, 0)).toMatchObject({
        nextRung: R1_FLOOR_RUNG,
        direction: "hold",
        atFloor: true,
        stepsRemaining: 0,
      });
    },
    2000,
  );
});

describe("computeR1 - path construction", () => {
  it("is exclusive of priorRung and inclusive of targetRung, both directions", () => {
    const down = computeR1(6, 3, 0);
    expect(down.path).toEqual([4, 5, 6]);

    const up = computeR1(3, 6, R1_UP_CONFIRM);
    expect(up.path).toEqual([5, 4, 3]);
  });
});
