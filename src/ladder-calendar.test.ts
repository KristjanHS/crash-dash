import { describe, expect, it } from "vitest";
import type { LadderCalendar, LadderEvent } from "./ladder-live.js";
import { mergeCalendar } from "./ladder-calendar.js";

const cal = (event: string, date = "2026-11-19", over: Partial<LadderCalendar> = {}): LadderCalendar => ({ date, sign: "real_yield", event, matters: "—", verified: false, ...over });
const refusals = (stored: LadderCalendar[], adds: LadderCalendar[], events: LadderEvent[] = []): string[] => {
  const out: string[] = [];
  mergeCalendar(stored, adds, events, (n) => out.push(n));
  return out;
};

describe("calendar dedupe", () => {
  it("an add refuses on the folded key with a shared sign within ±1 d; a different sign or a 2-day gap passes", () => {
    expect(refusals([cal("10-year TIPS reopening auction", "2026-11-20")], [cal("10y TIPS reopening auction")])).toHaveLength(1);
    expect(refusals([cal("Barings BDC Q3 (after the close)")], [cal("Barings BDC Q3 results")])).toHaveLength(1);
    expect(refusals([], [cal("FOMC + SEP"), cal("FOMC (SEP)")]), "an earlier add in the same patch counts").toHaveLength(1);
    expect(refusals([cal("10-year TIPS reopening auction", "2026-11-21")], [cal("10y TIPS reopening auction")])).toEqual([]);
    expect(refusals([cal("10-year TIPS reopening auction", "2026-11-19", { sign: "hbm" })], [cal("10y TIPS reopening auction")])).toEqual([]);
    const ev = { date: "2026-11-19", event: "10-year TIPS reopening auction", signs: ["hbm", "real_yield"], escalationIf: "", fizzleIf: "", holds: [], secondary: true, status: "" };
    expect(refusals([], [cal("10y TIPS reopening auction")], [ev])).toEqual(['calendarAdd "10y TIPS reopening auction": duplicates event "10-year TIPS reopening auction" (2026-11-19) — patch that row instead']);
  });
  it("a near add warns, a disjoint one passes silently", () => {
    const { calendar, delta } = mergeCalendar([cal("10-year TIPS reopening auction"), cal("Nov CPI", "2026-12-10")], [cal("US Nov CPI", "2026-12-10"), cal("Government funding deadline", "2026-12-11")], [], () => expect.unreachable());
    expect(calendar.map((c) => c.event)).toEqual(["10-year TIPS reopening auction", "Nov CPI", "US Nov CPI", "Government funding deadline"]);
    expect(delta).toEqual(["calendar possible dup: US Nov CPI (2026-12-10) ~ Nov CPI (2026-12-10)"]);
  });
});
