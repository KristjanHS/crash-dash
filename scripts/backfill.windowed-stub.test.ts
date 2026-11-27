import { describe, expect, it } from "vitest";
import type { Observation } from "../src/domain-types.js";
import { HCX_FETCH_OPTS } from "../src/registry-composite.js";
import { isoDaysBefore, SCORED_WARMUP_DAYS } from "./backfill.js";
import { FEED_DAYS, FRED_WEEKLY_OBS_DAY, STUB_NOW, isWeeklyFred, windowedStub } from "./backfill.test-helpers.js";

const w = windowedStub(FEED_DAYS);
const nowIso = STUB_NOW.toISOString().slice(0, 10);
const since = isoDaysBefore(STUB_NOW, SCORED_WARMUP_DAYS);

// [arg, full fetch, windowed fetch] — the full arm is each feed's no-window / floor-reaching call.
const ROWS: [string, () => Promise<Observation[]>, () => Promise<Observation[]>][] = [
  ["FRED since", () => w.fetchFred("DGS10", { fullHistory: true }), () => w.fetchFred("DGS10", { since })],
  ["FRED since (monthly)", () => w.fetchFred("CPIAUCSL", { fullHistory: true }), () => w.fetchFred("CPIAUCSL", { since })],
  ["prices lookbackDays", () => w.fetchPrices("SPY", HCX_FETCH_OPTS), () => w.fetchPrices("SPY", { deep: true, lookbackDays: SCORED_WARMUP_DAYS })],
  ["ECB startPeriod", () => w.fetchEcb("ESTR"), () => w.fetchEcb("ESTR", { startPeriod: since })],
  ["sovereign-quote from/to", () => w.fetchSovereignDaily("DE10Y-DE", "1900-01-01", nowIso), () => w.fetchSovereignDaily("DE10Y-DE", since, nowIso)],
];

describe("windowedStub", () => {
  it.each(ROWS)("%s: full ends at STUB_NOW; the window is a strictly shorter tail of it", async (_arg, full, windowed) => {
    const f = await full();
    const win = await windowed();
    expect(f.at(-1)?.date).toBe(nowIso);
    expect(win.length).toBeGreaterThan(0);
    expect(win.length).toBeLessThan(f.length);
    expect(win).toEqual(f.slice(f.length - win.length));
  });

  it("FRED weekly: NFCIRISK prints once a week on FRED_WEEKLY_OBS_DAY; `since` is a strictly shorter tail", async () => {
    expect(isWeeklyFred("NFCIRISK")).toBe(true);
    const f = await w.fetchFred("NFCIRISK", { fullHistory: true });
    const win = await w.fetchFred("NFCIRISK", { since });
    expect(f.filter((o) => new Date(o.date).getUTCDay() !== FRED_WEEKLY_OBS_DAY)).toEqual([]);
    expect(f.at(-1)!.date > isoDaysBefore(STUB_NOW, 7)).toBe(true);
    expect(win.length).toBeGreaterThan(0);
    expect(win.length).toBeLessThan(f.length);
    expect(win).toEqual(f.slice(f.length - win.length));
  });
});
