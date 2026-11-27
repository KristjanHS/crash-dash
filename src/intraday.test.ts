import { describe, expect, test } from "vitest";
import {
  INTRADAY_CUTOFF_UTC_MIN,
  SESSION_CLOSE_UTC_MIN,
  finalDates,
  isIntradayCronRun,
  isProvisional,
  provisionalBefore,
  readIntradaySlot,
  servedVerdict,
} from "./intraday.js";
import { INPUT_SERIES } from "./input-series.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_COMPONENTS } from "./registry-composite.js";

const D = "2026-09-29";
const cutoffMs = Date.parse(`${D}T00:00:00Z`) + INTRADAY_CUTOFF_UTC_MIN * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const pgForm = (ms: number): string => iso(ms).replace(".000Z", "+00:00"); // PostgREST timestamptz text

describe("isProvisional", () => {
  test("written on D before the cutoff ⇒ provisional; at/after it or on D+1 ⇒ final", () => {
    expect(isProvisional({ date: D, runAt: `${D}T15:00:00Z` })).toBe(true);
    expect(isProvisional({ date: D, runAt: iso(cutoffMs - 1) })).toBe(true);
    expect(isProvisional({ date: D, runAt: iso(cutoffMs) })).toBe(false);
    expect(isProvisional({ date: D, runAt: `${D}T22:00:00Z` })).toBe(false);
    expect(isProvisional({ date: D, runAt: "2026-09-30T10:00:00Z" })).toBe(false);
  });

  test("no runAt ⇒ never provisional", () => {
    expect(isProvisional({ date: D })).toBe(false);
  });

  test("`+00:00` offset form compares as epoch ms (a string compare flips the at-cutoff case)", () => {
    expect(isProvisional({ date: D, runAt: pgForm(cutoffMs - 60_000) })).toBe(true);
    expect(isProvisional({ date: D, runAt: pgForm(cutoffMs) })).toBe(false);
  });
});

describe("per-feed session close (the 2026-11-06 `isProvisional` ruling)", () => {
  test("the map's keys are exactly the DRAM snapshot source ids (closing before the UTC cutoff) ∪ the closes-feed `=X`-fed ids (48 h) ∪ COPPER", () => {
    const snapshot = INPUT_SERIES.filter((s) => s.feed === "snapshot").map((s) => s.id);
    const fx = (sym: string | undefined) => sym?.endsWith("=X") === true;
    const fxIds = new Set([
      ...[...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].filter((i) => fx(i.series)).map((i) => i.id),
      ...Object.values(COMPOSITE_COMPONENTS).flat().filter((c) => fx(c.symbol)).map((c) => c.id),
      ...INPUT_SERIES.filter((s) => fx(s.symbol ?? s.id)).map((s) => s.id),
    ]);
    expect([fxIds.has("F17"), fxIds.has("CMP_FXH_DEXJPUS"), fxIds.has("DEXUSEU")]).toEqual([true, true, true]);
    expect(Object.keys(SESSION_CLOSE_UTC_MIN).sort()).toEqual([...snapshot, ...fxIds, "COPPER"].sort());
    for (const id of snapshot) expect(SESSION_CLOSE_UTC_MIN[id]).toBeLessThan(INTRADAY_CUTOFF_UTC_MIN);
    expect(new Set([...fxIds].map((id) => SESSION_CLOSE_UTC_MIN[id])).size).toBe(1);
  });

  test("an `=X` row for D is provisional until D+2 00:00Z: 1 ms before = provisional, the bound itself = final", () => {
    const bound = provisionalBefore(D, "F17");
    expect(bound).toBe("2026-10-01T00:00:00.000Z");
    expect([isProvisional({ date: D, runAt: iso(Date.parse(bound) - 1) }, "F17"), isProvisional({ date: D, runAt: bound }, "F17")]).toEqual([true, false]);
  });

  // Prod 2026-10-26: the 22:56Z EOD row held HG=F's last trade (6.5515 vs settle 6.508); 11-04's 11-05 04:56Z row held the settle.
  test("a COPPER EOD write is provisional; its next-morning rewrite is final", () => {
    const at = (iso: string) => isProvisional({ date: "2026-10-26", runAt: iso }, "COPPER");
    expect([at("2026-10-26T22:56:06Z"), at("2026-10-27T07:26:18Z")]).toEqual([true, false]);
  });
});

describe("finalDates", () => {
  test("drops a provisional date, keeps an at-cutoff, runAt-less or later-day one", () => {
    const pts = [
      { date: "2026-09-27" },
      { date: "2026-09-28", runAt: "2026-09-29T10:00:00Z" },
      { date: D, runAt: iso(cutoffMs) },
      { date: "2026-09-30", runAt: iso(Date.parse("2026-09-30T00:00:00Z") + INTRADAY_CUTOFF_UTC_MIN * 60_000 - 1) },
    ];
    expect([...finalDates(pts)]).toEqual(["2026-09-27", "2026-09-28", D]);
  });

  test("an `estimated` row is never done, even when written after the cutoff (E3)", () => {
    const pts = [{ date: "2026-09-28", runAt: "2026-09-28T22:00:00Z", estimated: true }, { date: D, runAt: "2026-09-29T22:00:00Z", estimated: false }];
    expect([...finalDates(pts)]).toEqual([D]);
  });
});

describe("isIntradayCronRun", () => {
  test("a UTC Sat/Sun trigger is intraday even past the cutoff or with forceEmail; a weekday forceEmail is EOD", () => {
    expect(isIntradayCronRun(new Date("2026-11-14T22:30:00Z"))).toBe(true); // Sat, past 21:05
    expect(isIntradayCronRun(new Date("2026-11-15T07:30:00Z"), true)).toBe(true); // Sun, forceEmail
    expect(isIntradayCronRun(new Date("2026-11-13T10:00:00Z"), true)).toBe(false); // Fri daytime, forceEmail
    expect(isIntradayCronRun(new Date("2026-11-13T22:00:00Z"))).toBe(false); // Fri EOD
    expect(isIntradayCronRun(new Date("2026-11-13T10:00:00Z"))).toBe(true); // Fri daytime
  });
});

describe("servedVerdict", () => {
  const eod = { firedAt: "2026-09-29T22:00:00+00:00" }; // PostgREST form
  test("the slot wins only when strictly newer (epoch compare across `+00:00` / `Z`); null sides fall through", () => {
    expect(servedVerdict(eod, { firedAt: "2026-09-30T12:00:00.000Z" })?.firedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(servedVerdict(eod, { firedAt: "2026-09-29T22:00:00.000Z" })).toBe(eod);
    expect(servedVerdict(eod, { firedAt: "2026-09-29T12:00:00.000Z" })).toBe(eod);
    expect(servedVerdict(eod, null)).toBe(eod);
    expect(servedVerdict(null, null)).toBeNull();
  });
});

describe("readIntradaySlot", () => {
  test("a rejecting or synchronously-throwing slot read degrades to null AND logs; a good read passes through", async () => {
    const logged: string[] = [];
    const log = (msg: string): void => void logged.push(msg);
    const denied = { getIntradayVerdict: () => Promise.reject(new Error("permission denied for table intraday_verdict")) };
    const sync = { getIntradayVerdict: (): Promise<null> => { throw new Error("sync"); } };
    expect(await readIntradaySlot(denied, "lab", log)).toBeNull();
    expect(await readIntradaySlot(sync, "status", log)).toBeNull();
    expect(logged).toEqual([
      "[lab] intraday_verdict read failed - serving the EOD verdict:",
      "[status] intraday_verdict read failed - serving the EOD verdict:",
    ]);
    const slot = { firedAt: "2026-10-05T11:25:45.073Z" };
    expect(await readIntradaySlot({ getIntradayVerdict: async () => slot }, "lab", log)).toBe(slot);
    expect(logged).toHaveLength(2);
  });
});
