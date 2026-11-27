import { describe, expect, test } from "vitest";
import { NOWCAST_LEG_SYMBOLS, NOWCAST_SCORED_IDS, estimatorOf, extendWithEstimate, intradayNowcastPoints } from "./nowcast-score.js";
import { withStoredLegs } from "./input-series.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { InMemoryStore } from "./store-memory.js";
import { priceLegReadingSeries } from "./pension.js";
import { nowcastOilSpot } from "./oil-nowcast.js";
import type { Observation } from "./domain-types.js";

const D0 = "2026-09-28";
const D1 = "2026-09-29";
const prints = (v: number): Observation[] => [
  { date: "2026-09-25", value: v },
  { date: D0, value: v },
];

describe("extendWithEstimate (L2)", () => {
  test("appends estimates dated after the newest print, oldest first; drops those on or before it; none ⇒ unchanged", () => {
    const p = prints(3);
    expect(extendWithEstimate(p, [{ date: D1, value: 3.4 }])).toEqual([...p, { date: D1, value: 3.4, source: "proxyCarry", estimated: true }]);
    expect(extendWithEstimate(p, [{ date: D0, value: 3.4 }])).toBe(p);
    expect(extendWithEstimate(p, [])).toBe(p);
    expect(extendWithEstimate([], [{ date: D1, value: 1 }])).toEqual([{ date: D1, value: 1, source: "proxyCarry", estimated: true }]);
    const ests = [{ date: "2026-09-30", value: 3.6 }, { date: D0, value: 9 }, { date: D1, value: 3.4 }];
    expect(extendWithEstimate(p, ests)).toEqual([...p, { date: D1, value: 3.4, source: "proxyCarry", estimated: true }, { date: "2026-09-30", value: 3.6, source: "proxyCarry", estimated: true }]);
  });
});

describe("intradayNowcastPoints (L2)", () => {
  const closes = new Map<string, Observation[]>();
  const up = (a: number, b: number): Observation[] => [
    { date: D0, value: a },
    { date: D1, value: b },
  ];
  // Oil futures up 10% ⇒ spot estimate above the print.
  closes.set(estimatorOf("G1", "carry-log").leads[0], up(60, 66));
  closes.set(estimatorOf("BRENT", "carry-log").leads[0], up(65, 65)); // flat
  const fetchCloses = async (symbol: string): Promise<Observation[]> => {
    const c = closes.get(symbol);
    if (!c) throw new Error(`unmocked ${symbol}`);
    return c;
  };

  test("every roster id gets a D1 point when its proxy printed D1; the G1 move carries the sign of the proxy", async () => {
    const pts = await intradayNowcastPoints({ G1: prints(60), BRENT: prints(65) }, fetchCloses);
    expect([...pts.keys()].sort()).toEqual([...NOWCAST_SCORED_IDS].sort());
    for (const id of NOWCAST_SCORED_IDS) expect(pts.get(id)?.map((o) => o.date)).toEqual([D1]);
    expect(pts.get("G1")![0]!.value).toBeGreaterThan(60);
    expect(pts.get("BRENT")![0]!.value).toBeCloseTo(65, 8);
  });

  test("a proxy that throws or has no D1 bar yields no point for its id only; empty prints are skipped", async () => {
    const flaky = async (symbol: string): Promise<Observation[]> => {
      if (symbol === estimatorOf("BRENT", "carry-log").leads[0]) throw new Error("boom");
      return fetchCloses(symbol);
    };
    expect([...(await intradayNowcastPoints({ G1: prints(60), BRENT: prints(65) }, flaky)).keys()]).toEqual(["G1"]);
    const noBar = async (symbol: string): Promise<Observation[]> =>
      symbol === estimatorOf("G1", "carry-log").leads[0] ? [{ date: D0, value: 60 }] : fetchCloses(symbol);
    expect([...(await intradayNowcastPoints({ G1: prints(60), BRENT: [] }, noBar)).keys()]).toEqual([]);
  });
});

describe("intradayNowcastPoints over withStoredLegs", () => {
  // The prod shape (2026-10-02, then on the EU legs): the live feed has no bar on the newest print's date; the store holds it.
  const leg = estimatorOf("G1", "carry-log").leads[0];
  const g1Prints: Observation[] = [
    { date: "2026-09-30", value: 60 },
    { date: "2026-10-01", value: 62 },
  ];
  const full = [{ date: "2026-09-30", value: 60 }, { date: "2026-10-01", value: 61 }, { date: "2026-10-02", value: 61.5 }];
  const live = async (symbol: string): Promise<Observation[]> => (symbol === leg ? full.filter((o) => o.date !== "2026-10-01") : []);

  test("a live feed missing the newest print's date anchors on that print via the stored bar", async () => {
    const store = new InMemoryStore();
    await store.recordReadings(priceLegReadingSeries(leg, full.slice(0, 2)), "2026-10-01T22:00:00.000Z");
    const feed = withStoredLegs(store, NOWCAST_LEG_SYMBOLS, live, NOWCAST_MAX_CARRY_DAYS + 1, { now: new Date("2026-10-02T17:30:00Z"), onFail: () => undefined });
    const g1 = async (f: (s: string) => Promise<Observation[]>) => (await intradayNowcastPoints({ G1: g1Prints, BRENT: [] }, f)).get("G1");

    const anchored = nowcastOilSpot(g1Prints, full, estimatorOf("G1", "carry-log").beta)!;
    expect(anchored.fromDate).toBe("2026-10-01");
    expect(await g1(feed)).toEqual([{ date: "2026-10-02", value: anchored.value, source: "proxyCarry", estimated: true }]);
    // Live-only walks back to the 09-30 print — the defect this pins.
    expect((await g1(live))![0]!.value).not.toBeCloseTo(anchored.value, 6);
  });
});
