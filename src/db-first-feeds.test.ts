/**
 * Direct-arm tests for the per-feed DB-first specs (rung 9):
 * each feed's deep-vs-tail decision is driven straight through `resolveDbFirstArm` with a
 * seeded `InMemoryStore` — no scoring cycle. The specs are the SAME objects the production sites
 * spread into `dbFirstOrDirect` (confirmers.ts / run-dbfirst.ts / tracks.ts), so a retuned
 * `needRows` or a dropped `readOnly`/`warmup` flag reds here without a cycle.
 *
 * Division of labour: the generic seam mechanics (boundary at `== needRows`, persist-on-deep,
 * never-delete, `minRows` read cap, persist-error swallow) are owned by `series-db-first.test.ts`;
 * the one-cycle-per-arm WIRING pins (each site actually routes its fetch through the seam,
 * observable as the options each feed was asked with) stay in `run.wiring.feeds.test.ts`.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import { dbFirstReadCap, dbFirstSeries, resolveDbFirstArm, type DbFirstFeedSpec } from "./series-db-first.js";
import { R6_DB_FIRST_FEED, R7_LEG_IDS, r7LegFeed, r7LegLoopDeep } from "./confirmers.js";
import { CG_DB_FIRST_FEED } from "./db-first-specs.js";
import { r4DbFirstFeed, breadthFeed, CORE_LOOP_DB_FIRST, SOFT_PRICE_SYMBOLS } from "./run-dbfirst.js";
import { DFII10_ORIGIN } from "./backfill-depth.js";
import { PRICE_SCORERS } from "./registry-price.js";
import { R5_SLOW_DB_FIRST_FEED } from "./tracks.js";
import { SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";
import { CHART_DESCRIPTOR_OF } from "./family-descriptor-rows.js";
import { ecyReadingSeries } from "./scorers-composite.js";
import { ECY } from "./registry-fred.js";
import { BREADTH_STORE_IDS, breadthCloseReadingSeries } from "./registry-price.js";
import { CG } from "./registry-composite.js";
import { INDICATORS } from "./registry-fred.js";
import { type Observation, type State } from "./domain-types.js";
import { resetProviderFallbacks } from "./prices.js";
import { latchProviderFallbackViaRealHop } from "./test-helpers.js";

const RUN_AT = "2026-09-01T00:00:00.000Z";
// The provider-fallback latch is module state on a shared worker — a sibling file's hop must not hold breadth rewrites here.
beforeEach(() => resetProviderFallbacks());
const dateAt = (i: number): string => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const greenRows = (id: string, rows: number): StoredReading[] =>
  Array.from({ length: rows }, (_, i) => ({
    date: dateAt(i),
    indicatorId: id,
    value: 1,
    delta20: 0,
    rawState: "GREEN" as State,
    state: "GREEN" as State,
    decision: null,
  }));
const seeded = async (id: string, rows: number): Promise<InMemoryStore> => {
  const s = new InMemoryStore();
  // Stamped after the last seeded date's cutoff: FINAL rows (an EOD merge drops provisional ones, C1).
  await s.recordReadings(greenRows(id, rows), `${dateAt(rows)}T22:00:00.000Z`);
  return s;
};

// One row per DB-first spec factory, by the feed the run.wiring.feeds cycle pins it under. The other
// breadth symbols share `breadthFeed`'s needRows (SPY's tail arm is pinned in the read-only describe);
// the R7 legs (`r7LegFeed`) are pinned per leg by the one-row-short test below.
const FEEDS: ReadonlyArray<[string, DbFirstFeedSpec]> = [
  ["R6 ^MOVE", R6_DB_FIRST_FEED],
  ["CG copper/gold ratio", CG_DB_FIRST_FEED],
  ["R4 / ECY DFII10", r4DbFirstFeed(RUN_AT)],
  ["R5 / slow-track VIXCLS", R5_SLOW_DB_FIRST_FEED],
  ["breadth QQQ", breadthFeed("QQQ")],
];

describe("per-feed arm decision - direct resolveDbFirstArm over each production spec", () => {
  for (const [name, feed] of FEEDS) {
    test(`${name}: empty store ⇒ DEEP; a store at needRows ⇒ TAIL`, async () => {
      const empty = await resolveDbFirstArm(new InMemoryStore(), feed);
      expect(empty).toMatchObject({ arm: "deep", have: 0 });
      const full = await resolveDbFirstArm(await seeded(feed.id, feed.needRows), feed);
      expect(full).toMatchObject({ arm: "tail", have: feed.needRows });
    });
  }

  test("premise: every spec asks a real depth (a zeroed needRows would green the loop above vacuously)", () => {
    for (const [name, feed] of FEEDS) expect(feed.needRows, name).toBeGreaterThan(100);
  });

  // ECY (2026-09-29 root cause): a seed-depth read cap joined ~36 F7×DFII10 months against the
  // ECY_MIN_OBS floor — ECY omitted on every run, however deep the store grew. A store full back to
  // DFII10's origin must TAIL (the deep-arm trigger stays under its real row count) and read ALL of it.
  test("R4 / ECY DFII10: a store full back to DFII10's origin tails, reads every row, and scores ECY", async () => {
    const feed = r4DbFirstFeed(RUN_AT);
    const DAY = 86_400_000;
    // Real DFII10 density (~250/yr: every 24th weekday a holiday) minus R4's ~20-row velocity warm-up.
    const weekdays: string[] = [];
    let allWeekdays = 0;
    for (let t = Date.parse(DFII10_ORIGIN), i = 0; t <= Date.parse(RUN_AT); t += DAY) {
      if (new Date(t).getUTCDay() % 6 === 0) continue;
      allWeekdays++;
      if (i++ % 24 !== 23) weekdays.push(new Date(t).toISOString().slice(0, 10));
    }
    expect(dbFirstReadCap(feed)).toBeGreaterThanOrEqual(allWeekdays);
    const stored = weekdays.slice(20);
    const s = new InMemoryStore();
    await s.recordReadings(
      stored.map((date) => ({ ...greenRows(feed.id, 1)[0]!, date })),
      "2020-01-01T00:00:00.000Z",
    );
    const { arm, merged } = await resolveDbFirstArm(s, feed);
    expect(arm).toBe("tail");
    expect(merged.size).toBe(stored.length);
    const dfii10 = [...merged].map(([date, value]) => ({ date, value }));
    const f7 = [...new Set(weekdays.map((d) => `${d.slice(0, 7)}-01`))].map((date) => ({ date, value: 30 }));
    expect(ecyReadingSeries(ECY, f7, dfii10).length).toBeGreaterThan(0);
  });

  test("one DB leg one row short stays DEEP while its sibling TAILs (per-leg stores, per-leg arms)", async () => {
    const s = new InMemoryStore();
    await s.recordReadings(greenRows("R3", r7LegFeed("R3").needRows - 1), RUN_AT);
    await s.recordReadings(greenRows("R2", r7LegFeed("R2").needRows), RUN_AT);
    expect((await resolveDbFirstArm(s, r7LegFeed("R3"))).arm).toBe("deep");
    expect((await resolveDbFirstArm(s, r7LegFeed("R2"))).arm).toBe("tail");
  });
});

describe("breadth SPY reuse is READ-ONLY; a minted BR_* id persists (§6.2)", () => {
  const tailPoint: Observation = { date: "2041-06-01", value: 500 };
  const deepMustNotRun = async (): Promise<Observation[]> => {
    throw new Error("a full store must take the tail arm");
  };

  test("SPY: the tail arm merges the fetch for the read but writes NOTHING under the SPY id", async () => {
    const spec = breadthFeed("SPY");
    expect(spec.readOnly).toBe(true); // the §6.2 flag, read off the production spec
    const s = await seeded("SPY", spec.needRows);
    const before = (await s.getSeries("SPY", 100_000)).length;
    const res = await dbFirstSeries(s, {
      ...spec,
      runAt: RUN_AT,
      fetchDeep: deepMustNotRun,
      fetchTail: async () => [tailPoint],
      score: (pts) => breadthCloseReadingSeries(BREADTH_STORE_IDS["SPY"]!, pts),
    });
    expect(res.arm).toBe("tail");
    expect(res.points.some((p) => p.date === tailPoint.date)).toBe(true); // merged for the read…
    expect((await s.getSeries("SPY", 100_000)).length).toBe(before); // …never written
  });

  test("contrast (non-vacuity): BR_QQQ is NOT read-only - the same tail write lands", async () => {
    const spec = breadthFeed("QQQ");
    expect(spec.readOnly).toBe(false);
    const s = await seeded(spec.id, spec.needRows);
    const before = (await s.getSeries(spec.id, 100_000)).length;
    await dbFirstSeries(s, {
      ...spec,
      runAt: RUN_AT,
      fetchDeep: deepMustNotRun,
      fetchTail: async () => [tailPoint],
      score: (pts) => breadthCloseReadingSeries(BREADTH_STORE_IDS["QQQ"]!, pts),
    });
    expect((await s.getSeries(spec.id, 100_000)).length).toBe(before + 1);
  });

  // R1: the spec's `holdFinal` is bound to its own symbol.
  test("a QQQ hop holds BR_QQQ's FINAL rewrite; un-hopped QQQE's BR_* is rewritten", async () => {
    const rewrites = async (sym: string): Promise<number> => {
      const spec = breadthFeed(sym);
      const s = await seeded(spec.id, spec.needRows);
      const last = dateAt(spec.needRows - 1);
      await dbFirstSeries(s, {
        ...spec,
        runAt: RUN_AT,
        fetchDeep: deepMustNotRun,
        fetchTail: async () => [{ date: last, value: 2 }], // stored FINAL is 1
        score: (pts) => breadthCloseReadingSeries(BREADTH_STORE_IDS[sym]!, pts),
      });
      return s.readings.filter((r) => r.indicatorId === spec.id && r.date === last).length - 1;
    };
    try {
      await latchProviderFallbackViaRealHop("QQQ");
      expect(await rewrites("QQQ")).toBe(0);
      expect(await rewrites("QQQE")).toBe(1);
    } finally {
      resetProviderFallbacks();
    }
  });
});

// CG's `warmup: true` round trip, direct: the deep arm
// persists the head the scorer burned, that head COUNTS toward the next run's arm, and the tail arm
// writes no head. The scorer stub burns a fixed HEAD of the merged series (production's real burn is
// `ratioSpreadMinLen`); the flag itself comes off the production spec.
describe("CG warm-up head - deep arm persists it, the arm counts it, the tail arm writes none", () => {
  const HEAD = 3;
  const burnHead = (pts: Observation[]) =>
    pts.slice(HEAD).map((p) => ({
      indicator: CG,
      date: p.date,
      level: p.value,
      delta20: 0,
      rawState: "GREEN" as State,
      state: "GREEN" as State,
    }));

  test("deep arm: the burned head lands in warm-up, below the first reading, and counts toward the arm", async () => {
    const s = new InMemoryStore();
    const fetched = Array.from({ length: 10 }, (_, i) => ({ date: dateAt(i), value: 1 }));
    await dbFirstSeries(s, {
      ...CG_DB_FIRST_FEED,
      runAt: RUN_AT,
      fetchDeep: async () => fetched,
      fetchTail: async () => {
        throw new Error("an empty store must take the deep arm");
      },
      score: burnHead,
    });
    const warm = await s.getWarmup("CG", 100_000);
    const readings = await s.getSeries("CG", 100_000);
    expect(warm.length).toBe(HEAD); // every fetched date is in exactly one table
    expect(readings.length).toBe(fetched.length - HEAD);
    expect(warm.every((w) => w.date < readings[0]!.date)).toBe(true);
    // The union counts toward the NEXT arm decision — and only because of the warmup flag.
    expect((await resolveDbFirstArm(s, CG_DB_FIRST_FEED)).have).toBe(fetched.length);
    expect((await resolveDbFirstArm(s, { ...CG_DB_FIRST_FEED, warmup: undefined })).have).toBe(fetched.length - HEAD);
  });

  test("tail arm writes no head", async () => {
    const s = await seeded("CG", CG_DB_FIRST_FEED.needRows);
    const res = await dbFirstSeries(s, {
      ...CG_DB_FIRST_FEED,
      runAt: RUN_AT,
      fetchDeep: async () => {
        throw new Error("a full store must take the tail arm");
      },
      fetchTail: async () => [{ date: "2041-01-01", value: 1 }],
      score: burnHead,
    });
    expect(res.arm).toBe("tail");
    expect((await s.getWarmup("CG", 100_000)).length).toBe(0);
  });
});

describe("DB-first roster statics (moved from run.wiring.test.ts, rung 9)", () => {
  const legSeries = (id: string): string => INDICATORS.find((i) => i.id === id)!.series;

  test("R7_LEG_IDS name the registry ids whose `series` ARE the steepener's legs, in scorer order", () => {
    expect(R7_LEG_IDS.map(legSeries)).toEqual(CHART_DESCRIPTOR_OF.R7!.seriesIds);
  });

  test("the memo/DB split is the registry's: R1 (post-inversion ⇒ loop-deep) rides the memo, DGS2/DGS10 go DB-first", () => {
    expect(R7_LEG_IDS.filter((id) => r7LegLoopDeep(id))).toEqual(["R1"]);
    expect(R7_LEG_IDS.filter((id) => !r7LegLoopDeep(id))).toEqual(["R3", "R2"]);
  });

  // R1 left the DB-first roster 2026-09-04: its stored value is the 21-obs MEAN, so the tail arm
  // merged means back in as raw closes and re-smoothed them every run (prod: 0.796→0.790 over 3 crons).
  test("a smoothed-level id is never DB-first: CORE_LOOP_DB_FIRST ∩ SMOOTHED_LEVEL_OF is empty", () => {
    expect(Object.keys(SMOOTHED_LEVEL_OF).length).toBeGreaterThan(0); // premise: the pin has a subject
    expect(Object.keys(SMOOTHED_LEVEL_OF).filter((id) => CORE_LOOP_DB_FIRST.has(id))).toEqual([]);
  });

  test("SOFT_PRICE_SYMBOLS is derived: only-soft-consumed symbols, SPY (hard F6/SPCONC/RS_LEG input) excluded", () => {
    expect(PRICE_SCORERS.filter((s) => s.soft).flatMap((s) => s.inputs)).toContain("SPY"); // premise: a soft row reads SPY
    expect(SOFT_PRICE_SYMBOLS.has("SPY")).toBe(false);
  });
});
