/**
 * Pins for the slot-excusal term (`market-closures.ts`), the fix for 2026-10-13's "17 of 123 feeds behind":
 *  1. FRED's publisher calendar covers every id the run fetches through `fred.fetchSeries`.
 *  2. A publisher closure is NOT a source closure (F1 prints Columbus Day; FRED posts it a day late).
 *     Likewise R2 on a Saturday-New-Year Friday (2027-12-31): FRED is closed, SIFMA only early-closes.
 *  3. R6 (MOVE) closes on the SIFMA days — read off prod rows, not assumed.
 * Red demo: with `isSlotExcused` returning false, cases 2–3 fail; with `PUBLISHER_CLOSURES.FRED.ids` emptied, case 1 fails;
 * with `US_RATES.holidays` set back to the bare `US_FEDERAL_HOLIDAYS`, the 2027-12-31 case fails.
 */
import { describe, expect, it } from "vitest";
import { FEED_OF, INDICATORS } from "./registry-fred.js";
import { isPublisherClosed, isSlotExcused, isTargetClosed, MARKET_CLOSURES, PUBLISHER_CLOSURES, US_FEDERAL_HOLIDAYS } from "./market-closures.js";
import { isSourceHoliday, MARKET_CALENDARS } from "./source-holidays.js";

const COLUMBUS = "2026-10-12";
const VETERANS = "2026-11-11";
const GOOD_FRIDAY = "2026-04-03";
const SAT_NEW_YEAR_FRIDAY = "2027-12-31";

describe("PUBLISHER_CLOSURES.FRED", () => {
  it("covers every `INDICATORS`-loop id the FRED feed serves (FEED_OF reroutes excluded) plus the by-name FRED fetches", () => {
    const loopFred = INDICATORS.filter((i) => FEED_OF[i.id] === undefined).map((i) => i.id);
    expect(loopFred.length).toBeGreaterThan(5); // non-vacuity
    const byName = ["G1", "BRENT", "NG", "R7", "CQS", "CCC", "T10Y3M_RAW", "VXNCLS", "BBB"];
    const missing = [...loopFred, ...byName].filter((id) => !PUBLISHER_CLOSURES.FRED.ids.includes(id));
    expect(missing).toEqual([]);
  });

  it("is the federal-holiday list; the SIFMA full closes (US_RATES) are it minus the Saturday-New-Year Friday", () => {
    expect(PUBLISHER_CLOSURES.FRED.holidays).toBe(US_FEDERAL_HOLIDAYS);
    expect(MARKET_CLOSURES.US_RATES.holidays).toEqual(US_FEDERAL_HOLIDAYS.filter((d) => d !== SAT_NEW_YEAR_FRIDAY));
    expect(US_FEDERAL_HOLIDAYS).toContain(COLUMBUS);
    // Good Friday is NEVER federal (the inherited 2027 US_RATES list carried 03-26, caught in code review): 11 observed weekdays per year.
    expect(US_FEDERAL_HOLIDAYS.filter((d) => isTargetClosed(d) && !/-01-01$|-12-25$/.test(d))).toEqual([]);
    // 2027 carries a 12th: New Year 2028 falls on a Saturday, observed Fri 2027-12-31 — federal-only, NYSE + SIFMA stay open.
    for (const [y, n] of [["2026", 11], ["2027", 12]] as const) expect(US_FEDERAL_HOLIDAYS.filter((d) => d.startsWith(y)), y).toHaveLength(n);
    expect(US_FEDERAL_HOLIDAYS).toContain(SAT_NEW_YEAR_FRIDAY);
    expect(MARKET_CLOSURES.US.holidays).not.toContain(SAT_NEW_YEAR_FRIDAY);
    // Never a weekend: an excused Saturday would be a no-op at best and a sign the list rotted.
    expect(US_FEDERAL_HOLIDAYS.filter((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toEqual([]);
  });
});

describe("isTargetClosed - TARGET2 closing days (the euro sovereign legs' calendar)", () => {
  it("closes on the published TARGET2 holidays and stays open on the adjacent weekdays (every wrong day listed)", () => {
    // Good Friday / Easter Monday per the published TARGET2 calendars — independent of the computus under test.
    const CLOSED = [
      "2018-03-30", "2018-04-02", "2019-04-19", "2019-04-22", "2024-03-29", "2024-04-01", "2025-04-18", "2025-04-21",
      "2024-01-01", "2024-05-01", "2024-12-25", "2024-12-26",
    ];
    // Adjacent open days: Maundy Thursday, the Tuesday after Easter Monday, Dec 24/27, Jan 2, Apr 30.
    const OPEN = ["2018-03-29", "2018-04-03", "2024-03-28", "2024-04-02", "2025-04-17", "2024-12-24", "2024-12-27", "2024-01-02", "2024-04-30"];
    const rows = [...CLOSED.map((d) => [d, true] as const), ...OPEN.map((d) => [d, false] as const)];
    const wrong = rows.filter(([d, closed]) => isTargetClosed(d) !== closed).map(([d, closed]) => `${d} should be ${closed ? "closed" : "open"}`);
    expect(wrong).toEqual([]);
  });
});

describe("isSlotExcused - source ∪ publisher closures", () => {
  it("F1 (ICE BofA via FRED): Columbus Day is a publisher closure, not a source holiday — excused for slot age only", () => {
    expect(isSourceHoliday("F1", COLUMBUS)).toBe(false);
    expect(isPublisherClosed("F1", COLUMBUS)).toBe(true);
    expect(isSlotExcused("F1", COLUMBUS, 0)).toBe(true);
    expect(isSlotExcused("F1", "2026-10-13", 0)).toBe(false);
  });

  it("a publisher closure is excused only until FRED's first post day after it has passed (code-review finding on the Columbus fix)", () => {
    expect([0, 1, 2].map((post) => isSlotExcused("F1", COLUMBUS, post))).toEqual([true, true, false]);
    // A SOURCE closure stays excused forever — the value never exists.
    expect([0, 1, 2].map((post) => isSlotExcused("R2", COLUMBUS, post))).toEqual([true, true, true]);
  });

  it("R2 (H.15 via FRED): a Saturday-New-Year Friday is a FRED publisher closure, NOT a source closure (Treasuries trade; H.15 printed 2021-12-31)", () => {
    expect(isPublisherClosed("R2", SAT_NEW_YEAR_FRIDAY)).toBe(true);
    expect(isSourceHoliday("R2", SAT_NEW_YEAR_FRIDAY)).toBe(false);
    expect([0, 1, 2].map((post) => isSlotExcused("R2", SAT_NEW_YEAR_FRIDAY, post))).toEqual([true, true, false]);
  });

  it("R2 (H.15 via FRED): Columbus Day is both; an NYSE-only id (SPY, VIX) is not excused on it", () => {
    expect(isSourceHoliday("R2", COLUMBUS)).toBe(true);
    expect(isSlotExcused("R2", COLUMBUS, 2)).toBe(true);
    expect(["SPY", "VIX", "KBE_RS"].map((id) => isSlotExcused(id, COLUMBUS, 0))).toEqual([false, false, false]);
  });

  it("R6 (MOVE) closes on the SIFMA days AND the NYSE-only Good Friday (prod rows: no 2025-10-13 / 2025-11-11 / 2026-04-03 bar)", () => {
    expect([COLUMBUS, VETERANS, GOOD_FRIDAY].map((d) => isSlotExcused("R6", d, 2))).toEqual([true, true, true]);
    expect(MARKET_CALENDARS.US_RATES.ids).toContain("R6");
    expect(MARKET_CALENDARS.US.ids).toContain("R6");
  });

  it("a static-id calendar is a subset of the venue-augmented one (the leaf never drops an id source-holidays.ts lists)", () => {
    for (const [m, c] of Object.entries(MARKET_CLOSURES)) {
      const full = MARKET_CALENDARS[m as keyof typeof MARKET_CALENDARS];
      expect(full.holidays, m).toEqual(c.holidays);
      expect(c.ids.filter((id) => !full.ids.includes(id)), m).toEqual([]);
    }
    expect(MARKET_CALENDARS.XETRA.ids.length).toBeGreaterThan(MARKET_CLOSURES.XETRA.ids.length); // the `.DE` legs land
  });
});
