import { describe, expect, test } from "vitest";
import type { Observation } from "./domain-types.js";
import { alignTermStructure, fetchVixSeries } from "./vix_term.js";

// The closes provider `parseVixChart` suite retired 2026-07-26 with the parser itself: both legs
// now ride fred.ts's CSV path (VIXCLS/VXVCLS), whose parse is pinned in fred.test.ts.
const fetchSeries = async (series: string): Promise<Observation[]> => {
  if (series === "BOOM") throw new Error("503 Service Unavailable");
  return [{ date: "2021-01-01", value: 18.5 }];
};

describe("fetchVixSeries (FRED-sourced leg, degrade posture)", () => {
  // Load-bearing: a THROW here would abort the fast core mid-run. The empty array is the
  // bottom track's degraded sentinel (tracks.ts → bottom verdict null, NOT a false CALM). The
  // success row keeps the swallow from passing against a wrapper that returns [] unconditionally.
  test("passes the series through on success; swallows a hard FRED failure into [] rather than throwing", async () => {
    await expect(fetchVixSeries("VXVCLS", fetchSeries)).resolves.toEqual([{ date: "2021-01-01", value: 18.5 }]);
    await expect(fetchVixSeries("BOOM", fetchSeries)).resolves.toEqual([]);
  });
});

describe("alignTermStructure (inner-join the two legs by date)", () => {
  const obs = (date: string, value: number): Observation => ({ date, value });

  test("keeps shared dates, computes front/back ratio, sorts oldest → newest", () => {
    const front = [obs("2021-01-02", 40), obs("2021-01-01", 20)];
    const back = [obs("2021-01-01", 25), obs("2021-01-02", 32)];
    expect(alignTermStructure(front, back)).toEqual([
      { date: "2021-01-01", vix: 20, vix3m: 25, ratio: 20 / 25 },
      { date: "2021-01-02", vix: 40, vix3m: 32, ratio: 40 / 32 },
    ]);
  });

  test("drops dates missing either leg", () => {
    const front = [obs("2021-01-01", 20), obs("2021-01-02", 40), obs("2021-01-03", 30)];
    const back = [obs("2021-01-02", 32)]; // only the middle date overlaps
    expect(alignTermStructure(front, back)).toEqual([
      { date: "2021-01-02", vix: 40, vix3m: 32, ratio: 40 / 32 },
    ]);
  });

  test("drops a non-positive back leg (no sane ratio from a zero denominator)", () => {
    const front = [obs("2021-01-01", 20)];
    const back = [obs("2021-01-01", 0)];
    expect(alignTermStructure(front, back)).toEqual([]);
  });

  test("a fully degraded leg ([]) yields an empty aligned series (→ CALM downstream)", () => {
    expect(alignTermStructure([obs("2021-01-01", 20)], [])).toEqual([]);
    expect(alignTermStructure([], [obs("2021-01-01", 25)])).toEqual([]);
  });
});
