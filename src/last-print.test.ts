import { describe, expect, it } from "vitest";

import { CADENCE_OF } from "./feed-lag.js";
import { DAILY_ROSTER, lastPrintTag } from "./last-print.js";
import { recentMarketDay } from "./source-holidays.js";

// Ids picked off the registry walk by cadence, never a hand list (E22: the set is the registry's).
const idOf = (c: string, daily = false): string => {
  const hit = [...CADENCE_OF].find(([id, cad]) => cad === c && DAILY_ROSTER.includes(id) === daily);
  if (!hit) throw new Error(`no ${c} id in CADENCE_OF`);
  return hit[0];
};
const WEEKLY = idOf("weekly");
const MONTHLY = idOf("monthly");
const DAILY = idOf("daily", true);
const WEEKLY_DAILY_GRID = idOf("weekly", true); // weekly release, daily grid (oil)
const REF = "2026-10-03"; // a Saturday: the recent market day is Friday
const daysBack = (n: number): string => new Date(Date.parse(REF) - n * 86_400_000).toISOString().slice(0, 10);

describe("lastPrintTag (E22)", () => {
  it("a weekly/monthly id always tags its newest print, calendar days to the ref date, cadence from the registry", () => {
    expect(lastPrintTag(WEEKLY, { date: daysBack(5) }, REF)).toEqual({ date: daysBack(5), days: 5, cadence: "weekly", reason: "cadence" });
    expect(lastPrintTag(MONTHLY, { date: daysBack(0) }, REF)).toEqual({ date: REF, days: 0, cadence: "monthly", reason: "cadence" });
  });

  it("a daily id tags a print dated before its recent market day at once; on that day it does not", () => {
    expect(recentMarketDay(DAILY, REF)).toBe(daysBack(1)); // premise: Friday is DAILY's session
    expect(lastPrintTag(DAILY, { date: daysBack(1) }, REF)).toBeUndefined();
    expect(lastPrintTag(DAILY, { date: daysBack(2) }, REF)).toEqual({ date: daysBack(2), days: 2, cadence: "daily", reason: "cap" });
  });

  it("a weekly-release id on the daily grid tags like a daily id, never on cadence", () => {
    expect(lastPrintTag(WEEKLY_DAILY_GRID, { date: daysBack(1) }, REF)).toBeUndefined();
    expect(lastPrintTag(WEEKLY_DAILY_GRID, { date: daysBack(2) }, REF)).toMatchObject({
      days: 2,
      cadence: "weekly",
      reason: "cap", // the FE tooltip keys on this, never on `cadence`
    });
  });

  it("an estimated head or no head never tags; a head past the ref date floors at 0", () => {
    expect(lastPrintTag(WEEKLY, { date: daysBack(5), estimated: true }, REF)).toBeUndefined();
    expect(lastPrintTag(DAILY, { date: daysBack(2), estimated: true }, REF)).toBeUndefined();
    expect(lastPrintTag(WEEKLY, undefined, REF)).toBeUndefined();
    expect(lastPrintTag(WEEKLY, { date: "2026-10-04" }, REF)?.days).toBe(0);
  });
});
