import { describe, expect, it } from "vitest";
import { nowcastOilSpot, oilEstDivergence } from "./oil-nowcast.js";
import { estimatorOf } from "./nowcast-score.js";

const obs = (rows: [string, number][]) => rows.map(([date, value]) => ({ date, value }));

const BRENT = estimatorOf("BRENT", "carry-log");

describe("nowcastOilSpot", () => {
  const spot = obs([["2026-09-16", 59], ["2026-09-17", 60]]);
  const r = 0.01;

  it("carries the print over the future's log return, scaled by the id's own beta", () => {
    const future = obs([["2026-09-17", 70], ["2026-09-18", 70 * Math.exp(r)]]);
    expect(nowcastOilSpot(spot, future, BRENT.beta)).toEqual({
      date: "2026-09-18",
      fromDate: "2026-09-17",
      value: expect.closeTo(60 * Math.exp(BRENT.beta * r), 10),
    });
  });

  it("accumulates over a multi-session hole from the close at the print date", () => {
    const future = obs([["2026-09-17", 70], ["2026-09-18", 71], ["2026-09-21", 70 * Math.exp(2 * r)]]);
    const n = nowcastOilSpot(spot, future, BRENT.beta);
    expect(n).toMatchObject({ date: "2026-09-21", fromDate: "2026-09-17" });
    expect(n!.value).toBeCloseTo(60 * Math.exp(BRENT.beta * 2 * r), 10);
  });

  it("returns null rather than NaN on a non-positive price (WTI, 2020-04)", () => {
    const future = obs([["2026-09-17", 70], ["2026-09-18", 71]]);
    expect(nowcastOilSpot(obs([["2026-09-17", -37]]), future, BRENT.beta)).toBeNull();
    expect(nowcastOilSpot(spot, obs([["2026-09-17", -1], ["2026-09-18", 71]]), BRENT.beta)).toBeNull();
    expect(nowcastOilSpot(spot, obs([["2026-09-17", 70], ["2026-09-18", -1]]), BRENT.beta)).toBeNull();
  });
});

describe("oilEstDivergence (R6)", () => {
  // A print of 100 makes the percent delta exact: (est - 100) / 100 * 100 === est - 100.
  const est = (value: number) => ({ date: "2026-09-18", value, fromDate: "2026-09-17" });

  it("fires past the id's OWN cut in both directions, carrying the signed percent delta", () => {
    const up = oilEstDivergence(100, est(100 + BRENT.cutPct + 0.01), BRENT.cutPct);
    expect(up!.deltaPct).toBeCloseTo(BRENT.cutPct + 0.01, 10);
    const down = oilEstDivergence(100, est(100 - BRENT.cutPct - 0.01), BRENT.cutPct);
    expect(down!.deltaPct).toBeCloseTo(-(BRENT.cutPct + 0.01), 10);
  });

  it("is null at exactly the cut, below it, and on a null estimate", () => {
    expect(oilEstDivergence(100, est(100 + BRENT.cutPct), BRENT.cutPct)).toBeNull();
    expect(oilEstDivergence(100, est(100 + BRENT.cutPct - 0.01), BRENT.cutPct)).toBeNull();
    expect(oilEstDivergence(100, null, BRENT.cutPct)).toBeNull();
  });
});
