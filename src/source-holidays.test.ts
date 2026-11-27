import { describe, expect, it } from "vitest";
import { isSourceHoliday, MARKET_CALENDARS, NO_HOLIDAY_IDS, prevSession } from "./source-holidays.js";
import { DAILY_ROSTER } from "./last-print.js";
import { ANCHOR_ROSTER } from "./estimated.js";
import { ALL_INDICATORS } from "./registry.js";
import { legCloseQuotes, SB_BENCH_ID, SB_STRAT_ID } from "./scoreboard.js";

describe("MARKET_CALENDARS", () => {
  it("every calendar covers the current UTC year — add next year's closures when this reds", () => {
    const year = new Date().getUTCFullYear();
    const newest = Object.entries(MARKET_CALENDARS).map(([m, c]) => [m, Math.max(...c.holidays.map((d) => Number(d.slice(0, 4))))]);
    expect(newest.filter(([, y]) => (y as number) < year)).toEqual([]);
  });

  it("a SIFMA-only close (Columbus, Veterans Day) is a holiday for a Treasury id, not for an equity id", () => {
    const [columbus, veterans] = ["2026-10-12", "2027-11-11"];
    expect([isSourceHoliday("R2", columbus), isSourceHoliday("R2", veterans)]).toEqual([true, true]);
    expect([isSourceHoliday("SPY", columbus), isSourceHoliday("SPY", veterans)]).toEqual([false, false]);
  });

  it("an early-close Good Friday is a holiday for equities and CQS (union), not for a Treasury id", () => {
    const goodFriday = "2026-04-03";
    expect(["SPY", "CQS", "R2"].map((id) => isSourceHoliday(id, goodFriday))).toEqual([true, true, false]);
  });
});

describe("anchor-roster calendar coverage", () => {
  const onCalendar = new Set(Object.values(MARKET_CALENDARS).flatMap((c) => c.ids));

  it("every ANCHOR_ROSTER id sits on ≥1 calendar or on the named no-holiday allowlist (never both)", () => {
    expect(ANCHOR_ROSTER.filter((id) => onCalendar.has(id) === NO_HOLIDAY_IDS.includes(id))).toEqual([]);
  });

  it("a euro-area feed (continental feedTimeZone or a Xetra `.DE` series) sits on TARGET unless allowlisted", () => {
    const euro = ALL_INDICATORS.filter((i) => DAILY_ROSTER.includes(i.id) && (/^Europe\/(?!London)/.test(i.feedTimeZone ?? "") || i.series.endsWith(".DE")));
    expect(euro.map((i) => i.id)).toContain("EXSH_GATE"); // non-vacuity: the `.DE` arm reaches a Xetra id
    const onTarget = (id: string) => [MARKET_CALENDARS.TARGET, MARKET_CALENDARS.XETRA].some((c) => c.ids.includes(id));
    expect(euro.map((i) => i.id).filter((id) => !onTarget(id) && !NO_HOLIDAY_IDS.includes(id))).toEqual([]);
  });

  it("a Xetra `.DE` line also closes Dec 24 + Dec 31, which an ECB fixing prints", () => {
    expect([prevSession("LEGP_EUFIN", "2026-12-28"), prevSession("LEGP_EUFIN", "2027-01-04"), prevSession("ESTR", "2026-12-28")]).toEqual(["2026-12-23", "2026-12-30", "2026-12-24"]);
  });

  it("TARGET closures come off `isTargetClosed`: Easter Monday + May 1 close the euro ids, not NYSE ids", () => {
    expect(["2026-04-06", "2026-05-01"].map((d) => [isSourceHoliday("ESTR", d), isSourceHoliday("SPY", d)])).toEqual([[true, false], [true, false]]);
  });

  it("chained display lines sit on their venue: a `.DE` LEGP_* closes TARGET (May 1), the SB pair NYSE (Thanksgiving)", () => {
    const venue = (id: string) => [isSourceHoliday(id, "2026-05-01"), isSourceHoliday(id, "2026-11-26")];
    const got = legCloseQuotes().map(([id, q]) => [id, ...venue(id), q.ticker.endsWith(".DE")]);
    expect(got.filter(([, may1, thanks, de]) => may1 !== de || thanks === de)).toEqual([]);
    expect(got.some(([, , , de]) => de)).toBe(true); // non-vacuity: the `.DE` arm is exercised
    expect([SB_STRAT_ID, SB_BENCH_ID].map(venue)).toEqual([[false, true], [false, true]]);
  });
});
