import { describe, expect, test } from "vitest";
import {
  activeLegBounds,
  axisClass,
  cusumParams,
  effectiveCuts,
  evaluateLegs,
  operativePairUsable,
  winningLeg,
  type LegSeverity,
} from "./domain-legs.js";
import type { CalibrationCuts } from "./domain-cuts.js";
import type { Direction, Thresholds } from "./domain-types.js";
import { indicator } from "./dashboard.test-helpers.js";

// A σ-units velocity block carrying the fast arm AND the full CUSUM knob triple.
const SIGMA: NonNullable<Thresholds["velocitySigma"]> = {
  window: 60,
  minObs: 40,
  fastWindow: 10,
  cusumK: 0.5,
  cusumH: 4,
  cusumHRed: 8,
};

const fired = (
  sev: LegSeverity,
  t: Thresholds,
  o: { level?: number; delta20?: number; dir?: Direction; cuts?: CalibrationCuts; z?: number; velZ?: number; cusum?: number; velZFast?: number },
) =>
  Object.fromEntries(
    evaluateLegs(sev, o.level ?? 0, o.delta20 ?? 0, t, o.dir ?? "HIGH", o.cuts, o.z, o.velZ, o.cusum, o.velZFast).map(
      (l) => [l.leg, l.fired],
    ),
  );

describe("axisClass", () => {
  test("velocity, vel-sigma and vel-cusum are velocity-class; level and sigma are level-class", () => {
    expect(["velocity", "vel-sigma", "vel-cusum"].map((a) => axisClass(a as never))).toEqual([
      "velocity",
      "velocity",
      "velocity",
    ]);
    expect(axisClass("level")).toBe("level");
    expect(axisClass("sigma")).toBe("level");
  });
});

describe("cusumParams - the knob triple is all-or-nothing", () => {
  test("all three present resolves the triple; any one missing declines the leg", () => {
    expect(cusumParams(SIGMA)).toEqual({ k: 0.5, alarm: 4, red: 8 });
    for (const drop of ["cusumK", "cusumH", "cusumHRed"] as const)
      expect(cusumParams({ ...SIGMA, [drop]: undefined }), drop).toBeUndefined();
  });
});

describe("evaluateLegs", () => {
  test("measured is true exactly where a calibration cut backs the leg", () => {
    const t: Thresholds = { amberLevel: 1, amberVelocity: 1 };
    const measured = (cuts: CalibrationCuts) =>
      Object.fromEntries(evaluateLegs("Amber", 0, 0, t, "HIGH", cuts).map((l) => [l.leg, l.measured]));
    expect(measured({ evtAmber: 5, zAmber: 1, velEvtAmber: 2, velZAmber: 1 })).toMatchObject({
      evt: true,
      z: true,
      "vel-evt": true,
      "vel-z": true,
    });
    expect(measured({})).toMatchObject({ evt: false, z: false, "vel-evt": false, "vel-z": false });
  });

  test("σ id: registry velocity pair backs vel-z/vel-z-fast (never vel-op); registry-constant legs are unmeasured", () => {
    const legs = evaluateLegs("Amber", 0, 0, { amberVelocity: 2, velocitySigma: SIGMA }, "HIGH");
    const by = Object.fromEntries(legs.map((l) => [l.leg, l]));
    expect(by["vel-op"]!.bound).toBeUndefined();
    expect(by["vel-z"]!.bound).toBe(2);
    expect(by["vel-z-fast"]).toMatchObject({ bound: 2, measured: false });
    expect(by["vel-cusum"]).toMatchObject({ bound: 4, measured: false });
  });

  test("convention level leg is strict for a LOW id: fires below the cut, not at it", () => {
    const t: Thresholds = { amberLevel: 0.5 };
    expect(fired("Amber", t, { level: 0.5, dir: "LOW" }).op).toBe(false);
    expect(fired("Amber", t, { level: 0.4, dir: "LOW" }).op).toBe(true);
  });

  test("measured/σ/accumulator legs are inclusive: each fires AT its bound and not just below", () => {
    // A measured vel-op cut REPLACES the strict convention comparison with the inclusive one.
    const plain: Thresholds = { amberVelocity: 9 };
    const cuts: CalibrationCuts = { velOpAmber: 2, velEvtAmber: 2, zAmber: 1.5, velZAmber: 1 };
    const at = fired("Amber", plain, { cuts, delta20: 2, z: 1.5, velZ: 1 });
    const below = fired("Amber", plain, { cuts, delta20: 1.9, z: 1.4, velZ: 0.9 });
    expect([at["vel-op"], at["vel-evt"], at.z, at["vel-z"]]).toEqual([true, true, true, true]);
    expect([below["vel-op"], below["vel-evt"], below.z, below["vel-z"]]).toEqual([false, false, false, false]);

    const sigma: Thresholds = { amberVelocity: 2, velocitySigma: SIGMA };
    const sAt = fired("Amber", sigma, { velZFast: 2, cusum: 4 });
    const sBelow = fired("Amber", sigma, { velZFast: 1.9, cusum: 3.9 });
    expect([sAt["vel-z-fast"], sAt["vel-cusum"]]).toEqual([true, true]);
    expect([sBelow["vel-z-fast"], sBelow["vel-cusum"]]).toEqual([false, false]);
  });

  test("vel-cusum fires off the accumulator alone (no velocity z that day)", () => {
    const r = fired("Red", { redVelocity: 3, velocitySigma: SIGMA }, { cusum: 8 });
    expect(r["vel-cusum"]).toBe(true);
    expect(r["vel-z"]).toBe(false);
  });
});

describe("winningLeg", () => {
  test("an AND fold that fires on two legs names the composite, not its first part", () => {
    const t: Thresholds = { amberLevel: 1, redLevel: 2, amberVelocity: 1, redVelocity: 2 };
    expect(winningLeg(3, 3, t, "HIGH", { fold: { red: "and" } })).toBe("op+vel-op");
  });
});

describe("operativePairUsable", () => {
  test("a LOW (flipped) pair is usable when red sits below amber, not above", () => {
    expect(operativePairUsable(0.5, 0, true)).toBe(true);
    expect(operativePairUsable(0, 0.5, true)).toBe(false);
  });
});

describe("activeLegBounds - z leg inverted into plotted units", () => {
  const zCuts: CalibrationCuts = { zAmber: 1, zRed: 2, zrefMean: 10, zrefStd: 2 };

  test("HIGH id: mean + cut·std; LOW id: mean − cut·std", () => {
    expect(activeLegBounds(indicator({}), zCuts).z).toEqual({ amber: 12, red: 14 });
    expect(activeLegBounds(indicator({ direction: "LOW" }), zCuts).z).toEqual({ amber: 8, red: 6 });
  });

  test("a severity with no z-cut is null, the leg staying present", () => {
    expect(activeLegBounds(indicator({}), { ...zCuts, zRed: undefined }).z).toEqual({ amber: 12, red: null });
  });

  test("a degenerate or partial zref yields null, never a number", () => {
    for (const ref of [{ zrefMean: undefined }, { zrefStd: undefined }, { zrefStd: 0 }])
      expect(activeLegBounds(indicator({}), { ...zCuts, ...ref }).z, JSON.stringify(ref)).toEqual({
        amber: null,
        red: null,
      });
  });
});

describe("effectiveCuts - plotted-axis leg selection", () => {
  const t: Thresholds = { amberLevel: 1, redLevel: 2, amberVelocity: 5, redVelocity: 10 };

  test("a dual-axis id (F3) draws its LEVEL line; a velocity-only id (R2) draws only velocity legs", () => {
    expect(effectiveCuts(indicator({ id: "F3", thresholds: t }), {})).toEqual({ effAmber: 1, effRed: 2 });
    expect(effectiveCuts(indicator({ id: "R2", thresholds: t }), {})).toEqual({ effAmber: 5, effRed: 10 });
  });

  test("a degenerate or partial zref drops the z leg from the drawn line", () => {
    const r5 = indicator({ id: "R5", thresholds: { amberLevel: 25, redLevel: 35 } });
    const z = { zAmber: 1, zRed: 2 };
    for (const ref of [{ zrefStd: 5 }, { zrefMean: 20 }, { zrefMean: 20, zrefStd: 0 }])
      expect(effectiveCuts(r5, { ...z, ...ref }), JSON.stringify(ref)).toEqual({ effAmber: 25, effRed: 35 });
  });
});
