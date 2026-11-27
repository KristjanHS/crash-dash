import { describe, expect, it } from "vitest";
import { levelSpread, nowcastLevelCarry, nowcastRatioCarry } from "./level-nowcast.js";

const obs = (pairs: [string, number][]) => pairs.map(([date, value]) => ({ date, value }));

describe("nowcastLevelCarry", () => {
  it("adds beta times the lead's move since the anchor print, dated at the lead's close", () => {
    const prints = obs([["2026-09-29", 4.5], ["2026-09-30", 4.6]]);
    const lead = obs([["2026-09-30", 4.0], ["2026-10-01", 4.2]]);
    const est = nowcastLevelCarry(prints, lead, 0.5);
    expect(est).toMatchObject({ date: "2026-10-01", fromDate: "2026-09-30" });
    expect(est?.value).toBeCloseTo(4.6 + 0.5 * 0.2, 12);
  });
});

describe("nowcastRatioCarry", () => {
  it("carries the print over the ratio's log return", () => {
    const prints = obs([["2026-09-30", 2.3]]);
    const num = obs([["2026-09-30", 100], ["2026-10-01", 101]]);
    const den = obs([["2026-09-30", 50], ["2026-10-01", 50]]);
    const est = nowcastRatioCarry(prints, num, den, 10);
    expect(est?.date).toBe("2026-10-01");
    expect(est?.value).toBeCloseTo(2.3 + 10 * Math.log(1.01), 12);
  });

  it("is null on a non-positive close", () => {
    const prints = obs([["2026-09-30", 2.3]]);
    expect(nowcastRatioCarry(prints, obs([["2026-09-30", 100], ["2026-10-01", 0]]), obs([["2026-09-30", 50], ["2026-10-01", 50]]), 1)).toBeNull();
  });
});

describe("levelSpread", () => {
  it("differences the legs on shared dates only (R1: US10Y − US3M)", () => {
    const ten = [{ date: "2026-10-01", value: 4.2 }, { date: "2026-10-02", value: 4.3 }, { date: "2026-10-05", value: 4.4 }];
    const three = [{ date: "2026-10-01", value: 4.0 }, { date: "2026-10-05", value: 3.9 }];
    expect(levelSpread(ten, three).map((o) => [o.date, +o.value.toFixed(6)])).toEqual([["2026-10-01", 0.2], ["2026-10-05", 0.5]]);
  });
});
