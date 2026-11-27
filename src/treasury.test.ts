/**
 * The parser and the equality gate.
 * Fixtures are CAPTURED bytes (2026-09-20 fetch of both curves, trimmed to 09/04–09/18), so a Treasury
 * format change breaks these rather than silently grafting nothing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MIN_OVERLAP_ROWS,
  fetchTreasuryColumn,
  fetchTreasuryCurveSafe,
  graftTreasuryHead,
  parseTreasuryCurveCsv,
  startTreasuryMemo,
  stopTreasuryMemo,
} from "./treasury.js";
import type { Observation } from "./domain-types.js";

/** Captured nominal curve. 09/07 (Labor Day) is ABSENT — Treasury omits holidays, never blanks them. */
const NOMINAL_CSV = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
09/18/2026,3.97,3.98,4.10,4.14,4.24,4.24,4.44,4.76,4.83,4.86,4.93,5.01,5.38,5.34
09/17/2026,3.97,3.98,4.09,4.12,4.23,4.20,4.40,4.67,4.75,4.78,4.86,4.94,5.32,5.29
09/16/2026,3.96,4.00,4.07,4.14,4.24,4.22,4.45,4.74,4.82,4.86,4.94,5.01,5.39,5.35
09/15/2026,3.93,4.00,4.06,4.11,4.19,4.17,4.39,4.67,4.76,4.83,4.91,5.00,5.40,5.36
09/14/2026,3.94,4.00,4.06,4.11,4.18,4.18,4.37,4.65,4.73,4.80,4.88,4.97,5.37,5.34
09/11/2026,3.93,3.99,4.05,4.07,4.15,4.12,4.35,4.63,4.69,4.78,4.87,4.96,5.38,5.35
09/10/2026,3.91,3.93,4.01,4.00,4.11,4.07,4.28,4.56,4.63,4.75,4.84,4.95,5.39,5.37
09/09/2026,3.81,3.88,3.93,3.95,4.06,4.01,4.17,4.43,4.49,4.61,4.71,4.83,5.28,5.28
09/08/2026,3.81,3.88,3.91,3.94,4.02,4.00,4.15,4.39,4.44,4.57,4.68,4.80,5.26,5.25
09/04/2026,3.79,3.83,3.90,3.91,4.00,3.98,4.13,4.37,4.45,4.54,4.65,4.78,5.25,5.24`;

/** Captured real curve — note `10 YR`, where the nominal file writes `10 Yr`. */
const REAL_CSV = `Date,"5 YR","7 YR","10 YR","20 YR","30 YR"
09/18/2026,2.55,2.60,2.68,2.93,3.09
09/17/2026,2.46,2.52,2.61,2.87,3.04
09/16/2026,2.51,2.59,2.68,2.93,3.09
09/15/2026,2.42,2.51,2.62,2.90,3.07
09/14/2026,2.40,2.49,2.60,2.89,3.05
09/11/2026,2.38,2.48,2.60,2.89,3.07
09/10/2026,2.29,2.41,2.55,2.87,3.05
09/09/2026,2.20,2.32,2.46,2.79,2.98`;

const obs = (rows: Array<[string, number]>): Observation[] => rows.map(([date, value]) => ({ date, value }));

/** FRED-shaped R4 history: the real 10Y through 09/17 — one day behind the Treasury fixture. */
const FRED_R4 = obs([
  ["2026-09-09", 2.46],
  ["2026-09-10", 2.55],
  ["2026-09-11", 2.60],
  ["2026-09-14", 2.60],
  ["2026-09-15", 2.62],
  ["2026-09-16", 2.68],
  ["2026-09-17", 2.61],
]);

const treasuryR4 = () => parseTreasuryCurveCsv(REAL_CSV).get("10 YR")!;

describe("parseTreasuryCurveCsv", () => {
  test("splits the quoted header and keys every tenor UPPERCASED, oldest→newest", () => {
    const nominal = parseTreasuryCurveCsv(NOMINAL_CSV);
    expect([...nominal.keys()]).toEqual([
      "1 MO", "1.5 MONTH", "2 MO", "3 MO", "4 MO", "6 MO",
      "1 YR", "2 YR", "3 YR", "5 YR", "7 YR", "10 YR", "20 YR", "30 YR",
    ]);
    expect(nominal.get("10 YR")!.at(0)).toEqual({ date: "2026-09-04", value: 4.78 });
    expect(nominal.get("10 YR")!.at(-1)).toEqual({ date: "2026-09-18", value: 5.01 });
    expect(nominal.get("2 YR")!.at(-1)).toEqual({ date: "2026-09-18", value: 4.76 });
  });

  test("a holiday is an ABSENT row, not a gap value — 09/07 never appears", () => {
    const dates = parseTreasuryCurveCsv(NOMINAL_CSV).get("10 YR")!.map((o) => o.date);
    expect(dates).not.toContain("2026-09-07");
    expect(dates).toContain("2026-09-04");
    expect(dates).toContain("2026-09-08");
  });

  test("blank and N/A cells are skipped PER COLUMN — one gap never truncates a sibling tenor", () => {
    const gappy = `Date,"2 Yr","10 Yr","20 Yr"
09/18/2026,4.76,5.01,
09/17/2026,4.67,,5.32
09/16/2026,4.74,5.01,N/A`;
    const parsed = parseTreasuryCurveCsv(gappy);
    expect(parsed.get("2 YR")!.map((o) => o.date)).toEqual(["2026-09-16", "2026-09-17", "2026-09-18"]);
    expect(parsed.get("10 YR")!.map((o) => o.date)).toEqual(["2026-09-16", "2026-09-18"]);
    expect(parsed.get("20 YR")!.map((o) => o.date)).toEqual(["2026-09-17"]);
  });

  test("CRLF bodies, a blank trailing line and a footer row all parse", () => {
    const parsed = parseTreasuryCurveCsv(`Date,"10 Yr"\r\n09/18/2026,5.01\r\n09/17/2026,4.94\r\nSource: US Treasury\r\n`);
    expect(parsed.get("10 YR")).toEqual(obs([["2026-09-17", 4.94], ["2026-09-18", 5.01]]));
  });

  test("an error page or a body with zero rate rows THROWS — never a silently-empty series", () => {
    expect(() => parseTreasuryCurveCsv("<html>503</html>")).toThrow(/unexpected header/);
    expect(() => parseTreasuryCurveCsv("")).toThrow(/empty body/);
    expect(() => parseTreasuryCurveCsv(`Date,"10 Yr"\nSource: US Treasury`)).toThrow(/no rate rows/);
  });
});

describe("graftTreasuryHead", () => {
  test("appends only rows STRICTLY newer than FRED's last, leaving FRED's own rows byte-identical", () => {
    const grafted = graftTreasuryHead(FRED_R4, treasuryR4());
    expect(grafted.slice(0, FRED_R4.length)).toEqual(FRED_R4);
    expect(grafted.slice(FRED_R4.length)).toEqual([{ date: "2026-09-18", value: 2.68, source: "quote", estimated: true }]);
    expect(grafted.slice(0, FRED_R4.length).some((o) => o.estimated === true)).toBe(false); // FRED prints stay official
  });

  test("is pure: same inputs ⇒ same appended rows, and neither input is mutated", () => {
    const fred = FRED_R4.map((o) => ({ ...o }));
    const treasury = treasuryR4();
    const a = graftTreasuryHead(fred, treasury);
    const b = graftTreasuryHead(fred, treasury);
    expect(a).toEqual(b);
    expect(fred).toEqual(FRED_R4);
    expect(treasury).toEqual(treasuryR4());
  });

  test("ONE disagreeing overlap row ⇒ the FRED series comes back unchanged", () => {
    const perturbed = treasuryR4().map((o) => (o.date === "2026-09-15" ? { ...o, value: o.value + 0.01 } : o));
    expect(graftTreasuryHead(FRED_R4, perturbed)).toBe(FRED_R4);
  });

  test("a mismatch on one tenor drops THAT column's head only — its sibling still grafts", () => {
    // U3, per-column: the nominal 10Y disagrees, the nominal 2Y does not.
    const nominal = parseTreasuryCurveCsv(NOMINAL_CSV);
    const fred10 = nominal.get("10 YR")!.filter((o) => o.date < "2026-09-18").map((o) => ({ ...o }));
    const fred2 = nominal.get("2 YR")!.filter((o) => o.date < "2026-09-18").map((o) => ({ ...o }));
    fred10[0]!.value += 0.05; // FRED and Treasury disagree on the oldest shared date

    expect(graftTreasuryHead(fred10, nominal.get("10 YR")!)).toBe(fred10);
    expect(graftTreasuryHead(fred2, nominal.get("2 YR")!).at(-1)).toEqual({ date: "2026-09-18", value: 4.76, source: "quote", estimated: true });
  });

  test("a thin overlap cannot ESTABLISH the gate — under MIN_OVERLAP_ROWS shared dates, no graft", () => {
    // The January case: Treasury's per-year CSV has only the new year's rows.
    const treasury = treasuryR4();
    const thinFred = FRED_R4.slice(-(MIN_OVERLAP_ROWS - 1));
    expect(thinFred).toHaveLength(MIN_OVERLAP_ROWS - 1);
    expect(graftTreasuryHead(thinFred, treasury)).toBe(thinFred);
    // One more shared date and the identical head grafts — so the bound, not the data, is what bit.
    const justEnough = FRED_R4.slice(-MIN_OVERLAP_ROWS);
    expect(graftTreasuryHead(justEnough, treasury).at(-1)).toEqual({ date: "2026-09-18", value: 2.68, source: "quote", estimated: true });
  });

  test("a dropped feed, an empty FRED series, or a Treasury head no newer than FRED all degrade to FRED", () => {
    expect(graftTreasuryHead(FRED_R4, [])).toBe(FRED_R4); // fetchTreasuryCurveSafe's empty-map path
    expect(graftTreasuryHead([], treasuryR4())).toEqual([]);
    const caughtUp = [...FRED_R4, { date: "2026-09-18", value: 2.68 }];
    expect(graftTreasuryHead(caughtUp, treasuryR4())).toBe(caughtUp);
  });

  test("FRED dates Treasury never printed are not counted as overlap, and are never rewritten", () => {
    const withExtra = [{ date: "2026-09-07", value: 9.99 }, ...FRED_R4];
    const grafted = graftTreasuryHead(withExtra, treasuryR4());
    expect(grafted.find((o) => o.date === "2026-09-07")).toEqual({ date: "2026-09-07", value: 9.99 });
    expect(grafted.at(-1)).toEqual({ date: "2026-09-18", value: 2.68, source: "quote", estimated: true });
  });

  test("distinct DATES clear the overlap floor, never duplicate rows", () => {
    // A duplicate-dated feed must not inflate the count past MIN_OVERLAP_ROWS on fewer real dates.
    const treasury = treasuryR4();
    const thinFred = FRED_R4.slice(-(MIN_OVERLAP_ROWS - 1));
    const duplicated = [...treasury, ...treasury].sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(duplicated.length).toBeGreaterThan(treasury.length);
    expect(graftTreasuryHead(thinFred, duplicated)).toBe(thinFred);
  });
});

describe("the per-run memo", () => {
  // Shared project: an earlier file's run cycle leaves the memo armed with its curves.
  beforeEach(() => stopTreasuryMemo());
  afterEach(() => stopTreasuryMemo());

  const stub = (impl: () => Promise<Response>) => vi.fn(impl);
  const ok = () => Promise.resolve(new Response(REAL_CSV, { status: 200 }));

  // The memo's own contract (unarmed default, rejection eviction, re-arm) is pinned once in
  // run-memo.test.ts; this proves the Treasury read rides it, with its deep copy.
  test("armed, two reads of one curve are ONE fetch, each a COPY down to the Observations", async () => {
    const spy = stub(ok);
    const deps = { fetchImpl: spy };
    startTreasuryMemo();
    const first = await fetchTreasuryCurveSafe("real", 2026, deps);
    first.delete("10 YR");
    first.get("5 YR")![0]!.value = 99;
    // R2 and R3 share the nominal CSV: the column reads below are served from the same fetch.
    expect((await fetchTreasuryColumn("real", "10 YR", 2026, deps)).length).toBeGreaterThan(0);
    expect((await fetchTreasuryColumn("real", "5 YR", 2026, deps))[0]!.value).not.toBe(99);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("a non-OK status degrades to an empty map, never a throw, and warns naming the curve", async () => {
    const fetchImpl = stub(() => Promise.resolve(new Response("nope", { status: 503 })));
    const warned: unknown[][] = [];
    expect((await fetchTreasuryCurveSafe("real", 2026, { fetchImpl, warn: (...a) => void warned.push(a) })).size).toBe(0);
    expect(warned.map((c) => String(c[0]))).toEqual(["[treasury] real 2026 curve fetch failed - FRED served without the same-day head:"]);
  });

  test("an armed run's `onFail` sink hears each failing (curve, year) ONCE, however many ids retry it", async () => {
    const fetchImpl = stub(() => Promise.resolve(new Response("nope", { status: 503 })));
    const failed: string[] = [];
    startTreasuryMemo({ onFail: (curve, year) => void failed.push(`${curve} ${year}`) });
    const deps = { fetchImpl, warn: () => {} };
    for (const curve of ["real", "real", "nominal"] as const) await fetchTreasuryCurveSafe(curve, 2026, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // failures are evicted, so each id retries the wire
    expect(failed).toEqual(["real 2026", "nominal 2026"]);
  });
});
