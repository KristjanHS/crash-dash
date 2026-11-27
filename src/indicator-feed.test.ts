/**
 * The graft helper
 * `graftTreasuryHeadFor` (the single Treasury-head touch point). The `./treasury.js` fetch is injected at
 * the `fetchColumn` param (never the network); the REAL `graftTreasuryHead` equality gate + `MIN_OVERLAP_ROWS`
 * are kept, so the gate's behaviour is exercised, not stubbed.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type fetchTreasuryColumn, MIN_OVERLAP_ROWS } from "./treasury.js";
import { graftTreasuryHeadFor } from "./indicator-feed.js";
import type { Observation } from "./domain-types.js";

const fetchColumn = vi.fn<typeof fetchTreasuryColumn>();

// FRED history ending 2026-09-17 (its last obs); ≥5 dates for the overlap gate to ESTABLISH.
const FRED: Observation[] = [
  { date: "2026-09-10", value: 4.95 },
  { date: "2026-09-11", value: 4.96 },
  { date: "2026-09-14", value: 4.97 },
  { date: "2026-09-15", value: 5.0 },
  { date: "2026-09-16", value: 5.01 },
  { date: "2026-09-17", value: 4.94 },
];
// A fat current-year Treasury column: 6 matching overlap dates + one date NEWER than FRED's last.
const FAT_CURRENT: Observation[] = [...FRED.map((o) => ({ ...o })), { date: "2026-09-18", value: 5.01 }];

const RUN_AT = "2026-09-18T22:00:00.000Z"; // 18:00 ET; year 2026

beforeEach(() => fetchColumn.mockReset());

describe("graftTreasuryHeadFor - the single Treasury-head touch point (S2)", () => {
  test("an id ABSENT from TREASURY_HEAD_OF is returned UNTOUCHED (same reference), with NO fetch", async () => {
    const out = await graftTreasuryHeadFor("F1", FRED, RUN_AT, fetchColumn);
    expect(out).toBe(FRED); // identity — R1/T7 rides this exact branch
    expect(fetchColumn).not.toHaveBeenCalled();
  });

  test("a FAT current-year column grafts the head in ONE fetch, for the run's year", async () => {
    fetchColumn.mockResolvedValueOnce(FAT_CURRENT);
    const out = await graftTreasuryHeadFor("R4", FRED, RUN_AT, fetchColumn);
    expect(fetchColumn).toHaveBeenCalledTimes(1);
    expect(fetchColumn).toHaveBeenCalledWith("real", "10 YR", 2026);
    expect(out).toHaveLength(FRED.length + 1);
    expect(out.at(-1)).toEqual({ date: "2026-09-18", value: 5.01, source: "quote", estimated: true });
  });

  test("A3 January fallback: a THIN current-year column + a FAT prior year grafts, in exactly TWO fetches", async () => {
    const JAN_RUN_AT = "2027-01-05T22:00:00.000Z"; // year 2027
    const fredJan: Observation[] = [
      { date: "2026-12-22", value: 4.2 },
      { date: "2026-12-23", value: 4.21 },
      { date: "2026-12-24", value: 4.22 },
      { date: "2026-12-28", value: 4.23 },
      { date: "2026-12-29", value: 4.24 },
      { date: "2026-12-30", value: 4.25 },
      { date: "2026-12-31", value: 4.26 }, // last FRED obs
    ];
    // current year (2027) too thin for the gate (2 < MIN_OVERLAP_ROWS), both dates NEWER than FRED's last
    const thinCurrent: Observation[] = [
      { date: "2027-01-02", value: 4.3 },
      { date: "2027-01-05", value: 4.31 },
    ];
    // prior year (2026) fat: 7 matching overlap dates
    const fatPrior: Observation[] = fredJan.map((o) => ({ ...o }));
    fetchColumn.mockResolvedValueOnce(thinCurrent).mockResolvedValueOnce(fatPrior);

    const out = await graftTreasuryHeadFor("R2", fredJan, JAN_RUN_AT, fetchColumn);
    expect(fetchColumn).toHaveBeenCalledTimes(2);
    expect(fetchColumn).toHaveBeenNthCalledWith(1, "nominal", "10 YR", 2027);
    expect(fetchColumn).toHaveBeenNthCalledWith(2, "nominal", "10 YR", 2026); // year - 1
    expect(out).toHaveLength(fredJan.length + thinCurrent.length);
    expect(out.at(-1)).toEqual({ date: "2027-01-05", value: 4.31, source: "quote", estimated: true });
  });

  test("an unreachable feed ([] both years) returns the FRED series INTACT", async () => {
    fetchColumn.mockResolvedValue([]);
    const out = await graftTreasuryHeadFor("R3", FRED, RUN_AT, fetchColumn);
    expect(out).toEqual(FRED); // graft degraded to FRED (T5)
  });
});

// A3 fallback predicate BOUNDARY (Fix 2): the gate ESTABLISHES on `matched.size >= MIN_OVERLAP_ROWS`
// (DISTINCT dates shared with FRED, treasury.ts), but a graft only appends rows STRICTLY newer than FRED's
// last date — so the head row(s) never count toward `matched`. At EXACTLY `MIN_OVERLAP_ROWS` current-year
// rows (MIN_OVERLAP_ROWS-1 overlapping + 1 head) the gate fails (matched = MIN_OVERLAP_ROWS-1) while the
// old `rows.length < MIN_OVERLAP_ROWS` predicate stayed false, so the fallback did NOT fire and the graft
// silently degraded on the one boundary day. The predicate now measures the FRED overlap, closing it.
describe("graftTreasuryHeadFor - A3 fallback fires at the MIN_OVERLAP_ROWS boundary (Fix 2)", () => {
  const N = MIN_OVERLAP_ROWS;
  const JAN_RUN_AT = "2027-01-08T22:00:00.000Z"; // year 2027
  // Sequential UTC calendar days from a base — the gate only compares date strings, so weekends are moot.
  const ymd = (base: string, offset: number): string => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  // A canonical date→value map, so FRED and the Treasury columns AGREE on every shared date (equality gate).
  const dec = Array.from({ length: N }, (_, i) => ({ date: ymd("2026-12-01T00:00:00Z", i), value: 4.1 + i * 0.01 }));
  const janOverlap = Array.from({ length: N - 1 }, (_, i) => ({ date: ymd("2027-01-04T00:00:00Z", i), value: 4.3 + i * 0.01 }));
  const headRow = { date: ymd("2027-01-04T00:00:00Z", N - 1), value: 4.99 }; // strictly newer than FRED's last
  const fredBoundary: Observation[] = [...dec, ...janOverlap]; // last FRED obs = last janOverlap date
  const currentYearAtBoundary: Observation[] = [...janOverlap.map((o) => ({ ...o })), headRow];
  const priorYearFat: Observation[] = dec.map((o) => ({ ...o }));

  test("EXACTLY MIN_OVERLAP_ROWS current-year rows STILL grafts (measures FRED overlap, not raw row count)", async () => {
    expect(N).toBeGreaterThan(1); // premise: the fixture only discriminates while N-1 overlap rows exist
    expect(currentYearAtBoundary).toHaveLength(MIN_OVERLAP_ROWS); // fixture sized FROM the constant, not restating 5
    fetchColumn.mockResolvedValueOnce(currentYearAtBoundary).mockResolvedValueOnce(priorYearFat);
    const out = await graftTreasuryHeadFor("R3", fredBoundary, JAN_RUN_AT, fetchColumn);
    // The fallback FIRED at the boundary — the raw-count predicate (`N < N` false) would have stopped at ONE.
    expect(fetchColumn).toHaveBeenCalledTimes(2);
    expect(fetchColumn).toHaveBeenNthCalledWith(1, "nominal", "2 YR", 2027);
    expect(fetchColumn).toHaveBeenNthCalledWith(2, "nominal", "2 YR", 2026); // year - 1
    // Gate ESTABLISHED via the prior-year overlap ⇒ the head is grafted (raw-count bug would leave FRED intact).
    expect(out).toHaveLength(fredBoundary.length + 1);
    expect(out.at(-1)).toEqual({ ...headRow, source: "quote", estimated: true });
  });
});
