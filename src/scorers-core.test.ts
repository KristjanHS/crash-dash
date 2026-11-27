// Mutation-driven edge pins for scorers-core.ts (A3m-3): each test kills a decision mutant the
// subject suites left alive, incl. the oil config-multiplier direction pin (m ≠ 1 via the `config` param).
import { describe, expect, test } from "vitest";
import { byId, flatN, indicator } from "./dashboard.test-helpers.js";
import type { DerivedView, DrawdownLeg, Indicator, Observation, PostInversionCooldown, Reading } from "./domain-types.js";
import { POST_INVERSION_BAND, R8_MEAN_CUT_BANDS } from "./family-descriptor-rows.js";
import type { ThresholdConfig } from "./threshold-config.js";
import {
  armedExpandingCutSeries,
  buildReadings,
  decisionAt,
  derivedFiresHighward,
  derivedRawStateSeries,
  derivedReadingSeries,
  drawdownCutSeries,
  drawdownLegSeries,
  finiteBandCuts,
  fixedLevelState,
  indicatorLegSeries,
  indicatorReadingSeries,
  lagCalendarsFrom,
  levelGateState,
  maxOf,
  meanLevelCutSeries,
  minOf,
  oilReadingSeries,
  postInversionCutSeries,
  postInversionFloorSeries,
  ratioReadingSeries,
  resolvedDerivedBands,
  scoreDerived,
  scoreDerivedDecision,
  scoreIndicator,
  shortMoveSeries,
  signedShortMoveSeries,
  smoothedLevelReadingSeries,
  steepenerBullSeries,
} from "./scorers-core.js";

const day = (i: number): string => `d${String(i).padStart(2, "0")}`;
const obs = (values: readonly number[], date: (i: number) => string = day): Observation[] =>
  values.map((value, i) => ({ date: date(i), value }));
const dv = (over: Partial<DerivedView>): DerivedView => ({ kind: "return", amber: null, red: null, label: "x", unit: "", ...over });
const raw = (rs: readonly Reading[]) => rs.map((r) => r.rawState);

describe("buildReadings / ratioReadingSeries / finiteBandCuts", () => {
  test("buildReadings folds by default: an improved raw day holds the worse confirmed state", () => {
    const rs = buildReadings(indicator({}), [1, 2, 3], ["a", "b", "c"], ["RED", "GREEN", "GREEN"], 0);
    expect(rs.map((r) => `${r.state}/${r.rawState}`)).toEqual(["RED/RED", "RED/GREEN", "GREEN/GREEN"]);
  });

  test("ratioReadingSeries returns [] below minLength even when baseOffset leaves room", () => {
    const spec = { minLength: 5, baseOffset: 0, classify: () => "GREEN" as const };
    expect(ratioReadingSeries(indicator({}), [1, 2, 3, 4], ["a", "b", "c", "d"], spec)).toEqual([]);
  });

  test("ratioReadingSeries blanks the leg on a day raw and confirmed disagree (confirm omitted = on)", () => {
    const states = ["RED", "GREEN", "GREEN", "GREEN"] as const;
    const rs = ratioReadingSeries(indicator({}), [1, 2, 3, 4], ["a", "b", "c", "d"], {
      minLength: 1,
      baseOffset: 0,
      classify: (i) => states[i]!,
      legOf: () => "lvl",
    });
    expect(rs.map((r) => r.leg)).toEqual(["lvl", undefined, "lvl", "lvl"]);
    expect(rs.map((r) => r.rawLeg)).toEqual(["lvl", "lvl", "lvl", "lvl"]);
  });

  test("ratioReadingSeries with legOf and no scored day (minLength ≤ length ≤ baseOffset) returns [] without folding", () => {
    const spec = { minLength: 1, baseOffset: 1, classify: () => "GREEN" as const, legOf: () => "x" };
    expect(ratioReadingSeries(indicator({}), [1], ["a"], spec)).toEqual([]);
  });

  test("finiteBandCuts drops a NaN leg", () => {
    expect(finiteBandCuts([["a", NaN], ["b", 1]])).toEqual({ b: 1 });
  });
});

describe("lagCalendarsFrom", () => {
  const MON = "2026-10-05";
  const TUE = "2026-10-06";
  const WED = "2026-10-07";
  const THU = "2026-10-08";
  const rd = (id: string, date: string, cadence?: Indicator["cadence"]): Reading =>
    ({ indicator: indicator({ id, cadence }), date, level: 0, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null }) as Reading;

  test("an id's fallback grid accumulates every reading date, not just the last", () => {
    const cal = lagCalendarsFrom([rd("A", MON), rd("A", TUE), rd("B", MON), rd("B", TUE)]);
    expect(cal.gridFor("A")?.dates).toEqual([MON, TUE]);
  });

  test("a collected feedDates grid is authoritative: the reading's own date is not folded in", () => {
    const cal = lagCalendarsFrom([rd("A", WED), rd("B", MON), rd("B", TUE)], new Set(), new Map([["A", [MON, TUE]]]));
    expect(cal.gridFor("A")?.dates).toEqual([MON, TUE]);
  });

  test("a non-daily id is never a containment candidate", () => {
    const cal = lagCalendarsFrom([rd("A", MON), rd("A", TUE), rd("B", MON), rd("B", TUE), rd("C", THU, "monthly")]);
    expect(cal.gridFor("A")?.dates).toEqual([MON, TUE]);
  });

  test("gridFor is memoised: a second call returns the same grid object", () => {
    const cal = lagCalendarsFrom([rd("A", MON), rd("A", TUE), rd("B", MON), rd("B", TUE)]);
    const first = cal.gridFor("A");
    expect(first).not.toBeNull();
    expect(cal.gridFor("A")).toBe(first);
  });
});

describe("derived decision variable", () => {
  test("decisionAt: identity is null even with a window; a windowed kind without a window is null", () => {
    expect(decisionAt(dv({ kind: "identity", window: 3 }), [1, 2, 3, 4], 3)).toBeNull();
    expect(decisionAt(dv({ kind: "lowRise" }), [1, 2, 3], 2)).toBeNull();
  });

  test("ratio kinds are null on a zero or negative base", () => {
    expect(decisionAt(dv({ kind: "maSpread", window: 2 }), [0, 0], 1)).toBeNull();
    expect(decisionAt(dv({ kind: "maSpread", window: 2 }), [-1, -1], 1)).toBeNull();
  });

  test("highDist reads the trailing window ending today, not a wider one", () => {
    expect(decisionAt(dv({ kind: "highDist", window: 3 }), [10, 1, 1, 1, 1], 4)).toBe(0);
  });

  test("worstDrop includes today and is null on a non-positive high", () => {
    expect(decisionAt(dv({ kind: "worstDrop", window: 3 }), [10, 10, 5], 2)).toBe(-0.5);
    expect(decisionAt(dv({ kind: "worstDrop", window: 3 }), [0, 0, 0], 2)).toBeNull();
    expect(decisionAt(dv({ kind: "worstDrop", window: 3 }), [-1, -1, -1], 2)).toBeNull();
  });

  test("minOf starts at `start`, never the slot before it", () => {
    expect(minOf([0, 5, 6], 1, 2)).toBe(5);
  });

  test("maxOf / minOf keep the FIRST of tied extremes (strict compare; toBe tells -0 from 0)", () => {
    expect(maxOf([-0, 0], 0, 1)).toBe(-0);
    expect(minOf([0, -0], 0, 1)).toBe(0);
  });

  test("derivedFiresHighward: highDist fires highward; a window-back kind with no amber band is highward", () => {
    expect(derivedFiresHighward(dv({ kind: "highDist", window: 3, amber: -0.1 }))).toBe(true);
    expect(derivedFiresHighward(dv({ kind: "return", window: 3, amber: null }))).toBe(true);
  });

  test("scoreDerivedDecision: a null decision is GREEN; a null amber band never fires", () => {
    expect(scoreDerivedDecision(indicator({ derived: dv({ kind: "return", window: 5, amber: 0, red: 0.1 }) }), null)).toBe("GREEN");
    expect(scoreDerivedDecision(indicator({ derived: dv({ kind: "return", window: 5, amber: null, red: 0.5 }) }), 0.1)).toBe("GREEN");
    expect(scoreDerivedDecision(indicator({ derived: dv({ kind: "maSpread", window: 5, amber: null, red: -0.5 }) }), -0.1)).toBe(
      "GREEN",
    );
  });

  test("resolvedDerivedBands / derivedRawStateSeries throw on an indicator with no derived block", () => {
    expect(() => resolvedDerivedBands(indicator({}))).toThrow("[X] no derived descriptor");
    expect(() => derivedRawStateSeries(indicator({}), obs([1, 2]))).toThrow("[X] no derived descriptor");
  });

  test("derivedRawStateSeries scores an identity descriptor from obs 0 on the raw value", () => {
    const ind = indicator({ derived: dv({ kind: "identity", amber: 5, red: 2 }) });
    expect(derivedRawStateSeries(ind, obs([1, 3, 7]))).toEqual(["RED", "AMBER", "GREEN"]);
  });

  test("derivedReadingSeries folds by default", () => {
    const ind = indicator({ derived: dv({ kind: "change", window: 1, amber: 1, red: 2 }) });
    const rs = derivedReadingSeries(ind, obs([0, 5, 5, 5]));
    expect(rs.map((r) => `${r.state}/${r.rawState}`)).toEqual(["RED/RED", "RED/GREEN", "GREEN/GREEN"]);
  });

  test("scoreDerived needs window + CONFIRM_CLOSES observations", () => {
    const ind = indicator({ derived: dv({ kind: "change", window: 5, amber: 1, red: 2 }) });
    expect(() => scoreDerived(ind, obs([1, 1, 1, 1, 1, 1]))).toThrow("need 7 observations, got 6");
  });
});

describe("indicatorReadingSeries / scoreIndicator", () => {
  const calib = { zAmber: 1, zRed: 2, zrefMean: 10, zrefStd: 2 };

  test("an own-series-z id builds its z from calib (readings and legs); without calib it scores plain; a non-own id never does", () => {
    const R5 = byId("R5");
    const o = flatN(15, 30);
    expect(raw(indicatorReadingSeries(R5, o, calib)).every((s) => s === "RED")).toBe(true);
    expect(raw(indicatorReadingSeries(R5, o)).every((s) => s === "GREEN")).toBe(true);
    expect(raw(indicatorReadingSeries(indicator({}), o, calib)).every((s) => s === "GREEN")).toBe(true);
    expect(new Set(indicatorLegSeries(R5, o, calib))).toEqual(new Set(["z"]));
  });

  test("scoreIndicator needs VELOCITY_WINDOW + CONFIRM_CLOSES observations", () => {
    expect(() => scoreIndicator(indicator({}), flatN(1, 21))).toThrow("need 22 observations, got 21");
  });

  test("a drawdown-only leg lifts GREEN to AMBER on its firing days only", () => {
    const ind = indicator({
      thresholds: { amberLevel: 100, redLevel: 200 },
      drawdownLeg: { window: 3, dropPp: 1, gateWindow: 1, gateBp: 10 },
    });
    const values = [...Array<number>(21).fill(10), 8.5, 8.5, 10];
    const shorts = values.map((_, i) => (i === 21 ? 3.5 : 3));
    expect(raw(indicatorReadingSeries(ind, obs(values), undefined, undefined, obs(shorts)))).toEqual([
      "GREEN",
      "AMBER",
      "AMBER",
      "GREEN",
    ]);
  });

  test("the post-inversion floor: fire → AMBER, fire + escalation → RED, a RED raw day stays RED", () => {
    const cfg: PostInversionCooldown = {
      qualifyN: 2,
      floorLevel: 0.5,
      releaseN: 50,
      cutPctile: 0.5,
      cutWarmupObs: 1000,
      cutClamp: [-5, 5],
      cutAnchorDate: "d",
      shortLegSeries: "S",
      shortLegWindow: 1,
      shortLegDropBp: 10,
    };
    const ind = indicator({ direction: "LOW", thresholds: { amberLevel: -0.5, redLevel: -1 }, postInversionCooldown: cfg });
    const values = [...Array<number>(20).fill(1), -0.2, -0.2, -2, 0.2];
    const shorts = values.map((_, i) => (i === 23 ? 2.5 : 3));
    expect(raw(indicatorReadingSeries(ind, obs(values), undefined, undefined, obs(shorts)))).toEqual([
      "GREEN",
      "AMBER",
      "RED",
      "RED",
    ]);
  });
});

describe("level gates", () => {
  test("levelGateState is AMBER exactly at peak × proximity", () => {
    expect(levelGateState([10, 5], 1, 1, 0.5)).toBe("AMBER");
  });

  test("fixedLevelState: strict cuts in both directions", () => {
    const low = indicator({ direction: "LOW", thresholds: { amberLevel: 2, redLevel: 1 } });
    expect([0.5, 1, 1.5, 2, 3].map((l) => fixedLevelState(low, l))).toEqual(["RED", "AMBER", "AMBER", "GREEN", "GREEN"]);
    const high = indicator({ thresholds: { amberLevel: 1, redLevel: 2 } });
    expect([0.5, 2, 3].map((l) => fixedLevelState(high, l))).toEqual(["GREEN", "AMBER", "RED"]);
  });
});

describe("oilReadingSeries", () => {
  const OVX_SPIKE = dv({ kind: "return", window: 5, amber: 0.24, red: 0.35 });
  const ovx = (over: Partial<Indicator> = {}) =>
    indicator({ id: "OVX", thresholds: { amberLevel: 50, redLevel: 80 }, derived: OVX_SPIKE, ...over });
  const o = obs(Array<number>(25).fill(10));

  test("throws on an id with no geo-hybrid descriptor, and on a trailing-peak id with no derived block", () => {
    expect(() => oilReadingSeries(indicator({}), o)).toThrow("[X] no geo-hybrid descriptor");
    expect(() => oilReadingSeries(indicator({ id: "G1" }), o)).toThrow("[G1] no derived descriptor");
  });

  test("a fixed-band id refuses an extra registry threshold leg", () => {
    expect(() => oilReadingSeries(ovx({ thresholds: { amberLevel: 50, redLevel: 80, amberVelocity: 1 } }), o)).toThrow(
      "expects exactly the level pair",
    );
  });

  test.each([
    ["no derived block", undefined],
    ["kind", { ...OVX_SPIKE, kind: "change" as const }],
    ["window", { ...OVX_SPIKE, window: 6 }],
    ["amber", { ...OVX_SPIKE, amber: 0.25 }],
    ["red", { ...OVX_SPIKE, red: 0.36 }],
  ])("a fixed-band spike leg that does not mirror the descriptor throws (%s)", (_, derived) => {
    expect(() => oilReadingSeries(ovx({ derived }), o)).toThrow("must mirror");
  });

  test("the fixed-band spike leg fires highward under a multiplier ≠ 1 (config seam)", () => {
    const values = [...Array<number>(21).fill(10), 11.5];
    const half: ThresholdConfig = { multipliers: { OVX: { multiplier: 0.5 } } };
    expect(raw(oilReadingSeries(ovx(), obs(values), half)).at(-1)).toBe("AMBER"); // 0.15 ≥ 0.24·0.5
    expect(raw(oilReadingSeries(ovx(), obs(values), {})).at(-1)).toBe("GREEN"); // empty config ⇒ m = 1
  });

  test("the trailing-peak velocity leg threads the config multiplier (G1, m = 0.5)", () => {
    // 22 obs < levelWindow ⇒ the level leg is GREEN, so the raw state IS the velocity leg.
    const g1 = indicator({ id: "G1", derived: dv({ kind: "return", window: 20, amber: 0.2, red: 0.4 }) });
    const values = [...Array<number>(21).fill(10), 11.5];
    const half: ThresholdConfig = { multipliers: { G1: { multiplier: 0.5 } } };
    expect(raw(oilReadingSeries(g1, obs(values), half)).at(-1)).toBe("AMBER"); // 0.15 ≥ 0.2·0.5
    expect(raw(oilReadingSeries(g1, obs(values), {})).at(-1)).toBe("GREEN"); // 0.15 < 0.2
  });
});

describe("post-inversion cut walk", () => {
  const base = { qualifyN: 2, floorLevel: 0.5, releaseN: 3, cutWarmupObs: 100, cutAnchorDate: "d" };

  test("postInversionFloorSeries fires strictly below the armed cut, never on an unarmed day", () => {
    const cfg = { ...base, cutPctile: 0.5, cutClamp: [-1, 1] as [number, number] } as PostInversionCooldown;
    const values = [1, -1, -1, 0.2, 0.5, 0.8, 0.6, 0.7];
    expect(postInversionFloorSeries(values, cfg, values.map((_, i) => day(i)))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test("armedExpandingCutSeries: warm-up boundary, level release at exactly releaseN, one slot per obs", () => {
    const cfg = { qualifyN: 1, floorLevel: 1, releaseN: 2, cutWarmupObs: 3, cutAnchorDate: "d" };
    const values = [-5, -3, -4, 1, 1, -2];
    const cuts = armedExpandingCutSeries(values, cfg, values.map((_, i) => day(i)), [{ pctile: 0, clamp: [-100, 100], warmupHold: 99 }]);
    expect(cuts).toEqual([[99, 99, -5, -5, null, -5]]);
  });

  test("postInversionCutSeries throws when either the pctile or the clamp is missing", () => {
    const cfg = { ...base, shortLegSeries: "S", shortLegWindow: 1, shortLegDropBp: 10 };
    expect(() => postInversionCutSeries([1, 1], { ...cfg, cutClamp: [-1, 1] }, ["d0", "d1"])).toThrow("needs cutPctile+cutClamp");
    expect(() => postInversionCutSeries([1, 1], { ...cfg, cutPctile: 0.5 }, ["d0", "d1"])).toThrow("needs cutPctile+cutClamp");
  });

  test("meanLevelCutSeries throws without a levelCuts carrier", () => {
    const cfg = { ...base, shortLegSeries: "S", shortLegWindow: 1, shortLegDropBp: 10 };
    expect(() => meanLevelCutSeries([1], ["d0"], cfg)).toThrow("needs a levelCuts carrier");
  });
});

describe("short-leg moves", () => {
  test("steepenerBullSeries: a warm-up (null) move never fires, even at a zero drop", () => {
    expect(steepenerBullSeries([1, 1], { shortLegWindow: 1, shortLegDropBp: 0 })).toEqual([false, true]);
  });

  test("steepenerBullSeries 'either' fires on a rise too", () => {
    expect(steepenerBullSeries([1, 2], { shortLegWindow: 1, shortLegDropBp: 10 }, "either")).toEqual([false, true]);
  });

  test("signedShortMoveSeries is defined from i = w", () => {
    expect(signedShortMoveSeries([1, 3, 6], 1)).toEqual([null, 2, 3]);
  });

  test("shortMoveSeries skips an observation date the short leg lacks", () => {
    const o = obs([0, 0, 0]);
    expect(shortMoveSeries(o, [{ date: day(0), value: 1 }, { date: day(2), value: 4 }], 1)).toEqual([null, null, 3]);
  });
});

describe("drawdown leg", () => {
  test("drawdownCutSeries: null until the window fills, then max of the window ending today minus dropPp", () => {
    expect(drawdownCutSeries([1, 2, 3, 4], { window: 3, dropPp: 0.5, gateWindow: 1, gateBp: 0 })).toEqual([null, null, 2.5, 3.5]);
    expect(drawdownCutSeries([5, 1, 1, 1], { window: 2, dropPp: 0, gateWindow: 1, gateBp: 0 })).toEqual([null, 5, 1, 1]);
  });

  test("drawdownLegSeries fires only strictly below the cut AND under the gate", () => {
    const cfg: DrawdownLeg = { window: 3, dropPp: 1, gateWindow: 1, gateBp: 10 };
    const rs = drawdownLegSeries(obs([-5, -5, -6, -8, -6.5]), obs([0, 1, 0, 1, 0]), cfg);
    expect(rs).toEqual([false, false, false, true, false]);
  });
});

describe("smoothedLevelReadingSeries", () => {
  const cooldown = (over: Partial<PostInversionCooldown>): PostInversionCooldown => ({
    qualifyN: 1,
    floorLevel: 100,
    releaseN: 50,
    cutWarmupObs: 0,
    cutAnchorDate: "0000-00-00",
    shortLegSeries: "S",
    shortLegWindow: 1,
    shortLegDropBp: 10,
    ...over,
  });
  const iso = (i: number): string => `2026-01-${String(i + 1).padStart(2, "0")}`;
  const states = (rs: readonly Reading[]) => rs.map((r) => r.state);

  test("redWindow must be ≥ window (equal is fine)", () => {
    const o = obs([1, 2, 3, 4]);
    expect(() => smoothedLevelReadingSeries(indicator({}), o, 3, undefined, 2)).toThrow("redWindow must be an integer ≥ window");
    expect(() => smoothedLevelReadingSeries(indicator({}), o, 3, undefined, 3)).not.toThrow();
  });

  test("plain smoothed level: fixed bands on the mean, offset window−1, folded, padded with the first mean", () => {
    const ind = indicator({ thresholds: { amberLevel: 5, redLevel: 10 } });
    const rs = smoothedLevelReadingSeries(ind, obs([20, 20, 0, 0, 0]), 2);
    expect(rs[0]!.date).toBe(day(1));
    expect(rs[0]!.delta20).toBe(0);
    expect(raw(rs)).toEqual(["RED", "AMBER", "GREEN", "GREEN"]);
    expect(states(rs)[1]).toBe("RED");
  });

  test("the cooldown floor aligns to the mean series at window−1", () => {
    const ind = indicator({ direction: "LOW", thresholds: { amberLevel: -50, redLevel: -100 } });
    const cfg = cooldown({ floorLevel: 0.5, cutPctile: 0.5, cutWarmupObs: 100, cutClamp: [-5, 5] });
    const rs = smoothedLevelReadingSeries({ ...ind, postInversionCooldown: cfg }, obs([1, 1, 1, -1, 1, 1], iso), 2);
    expect(raw(rs)).toEqual(["GREEN", "GREEN", "AMBER", "GREEN", "GREEN"]);
  });

  test("redWindow: RED on the full redWindow mean (today included) strictly past redLevel, else AMBER on the mean", () => {
    const ind = indicator({ thresholds: { redLevel: 10 } });
    const rs = smoothedLevelReadingSeries(ind, obs([0, 0, 30, 0, 12, 10]), 1, undefined, 3);
    expect(raw(rs)).toEqual(["GREEN", "GREEN", "AMBER", "GREEN", "RED", "GREEN"]);
    expect(states(rs)[5]).toBe("RED");
  });

  test("redWindow + cooldown: the rung cut pools by the mean's own date; an unarmed (null) cut never fires", () => {
    const ind = indicator({ direction: "LOW", thresholds: { redLevel: -10 } });
    const cfg = cooldown({ floorLevel: 0.5, cutPctile: 0, cutWarmupObs: 1, cutClamp: [-100, 100], cutAnchorDate: iso(2) });
    const rs = smoothedLevelReadingSeries({ ...ind, postInversionCooldown: cfg }, obs([-5, 3, -1, 2], iso), 1, undefined, 1);
    expect(rs.map((r) => r.bandCuts?.[POST_INVERSION_BAND.key])).toEqual([0.5, 0.5, -1, -1]);
    const unarmed = cooldown({ qualifyN: 2, floorLevel: 0.5, cutPctile: 0, cutWarmupObs: 100, cutClamp: [-100, 100] });
    const rs2 = smoothedLevelReadingSeries({ ...ind, postInversionCooldown: unarmed }, obs([-1, 5], iso), 1, undefined, 1);
    expect(raw(rs2)).toEqual(["GREEN", "GREEN"]);
  });

  const r8 = (amber: [number, number], red: [number, number], over: Partial<PostInversionCooldown> = {}) =>
    cooldown({ levelCuts: { amber: { pctile: 0, clamp: amber }, red: { pctile: 0, clamp: red } }, ...over });

  test("levelCuts (LOW): strict mean < cut, a RED level stays RED, folded", () => {
    const ind = indicator({ direction: "LOW", thresholds: {}, postInversionCooldown: r8([-1, -1], [-3, -3]) });
    const rs = smoothedLevelReadingSeries(ind, obs([-0.5, 0, -1, -5, 0], iso), 1);
    expect(raw(rs)).toEqual(["GREEN", "GREEN", "GREEN", "RED", "GREEN"]);
    expect(states(rs)[4]).toBe("RED");
  });

  test("levelCuts (HIGH): strict mean > cut", () => {
    const ind = indicator({ thresholds: {}, postInversionCooldown: r8([-2, -2], [-1, -1]) });
    expect(raw(smoothedLevelReadingSeries(ind, obs([-3, -2, -1.5, 0], iso), 1))).toEqual(["GREEN", "GREEN", "AMBER", "RED"]);
  });

  test("levelCuts (HIGH): a rise is the velocity move", () => {
    const ind = indicator({ thresholds: { amberVelocity: 1 }, postInversionCooldown: r8([100, 100], [200, 200]) });
    expect(raw(smoothedLevelReadingSeries(ind, obs([-5, -5, -1], iso), 1))).toEqual(["GREEN", "GREEN", "AMBER"]);
  });

  test("levelCuts: the cut pool admits a mean by its own date", () => {
    const cfg = r8([-100, 100], [-100, 100], { cutWarmupObs: 1, cutAnchorDate: iso(2) });
    const rs = smoothedLevelReadingSeries(indicator({ thresholds: {}, postInversionCooldown: cfg }), obs([-5, 3, -1, 2], iso), 1);
    expect(rs.map((r) => r.bandCuts?.[R8_MEAN_CUT_BANDS[0].key])).toEqual([100, 100, -1, -1]);
  });
});
