import { describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import { SupabaseStore, type LegPillarRow, type Store, type StoredReading } from "./store.js";
import { alert, hasDb, truncate } from "./store.test-helpers.js";
import { retainable } from "./retention.js";
import { keep, readingIds } from "./store-keep.js";

// The retention seam: every row-bearing store writer drops the rows its `retain` policy refuses.
// The injected policy refuses id "X", so each filtered writer must visibly drop X rows and keep Y rows.
const refuseX = (id: string) => id !== "X";

/** Writers that persist indicator-keyed rows — each routes them through `keep()` (`store-keep.ts`). */
const FILTERED = ["recordReadings", "recordRun", "recordIntradayRun", "recordWarmup", "putLegPillars"] as const;

/** Writers outside the seam, each with its reason. The alert_log writers are NOT value-free: `run_inputs`
 *  carries per-id levels (`run-inputs.ts` `globalReadings`/`heads`), unfiltered by this seam. */
const EXEMPT: Record<string, string> = {
  recordAlert: "alert_log row — kept; its run_inputs carries per-id levels, unfiltered",
  putIntradayVerdict: "intraday slot of alert_log — kept; run_inputs as recordAlert",
  rewriteIntradayVerdict: "rewrites the alert_log slot — kept; run_inputs as recordAlert",
  backfillDialState: "fills an alert_log dial column — kept",
  updateRunTrace: "fills alert_log trace columns — kept",
  recordCalibration: "keyed (channel, metric), carries no indicator level",
  recordScorerVintage: "per-id config hash + logic version, no level",
};

/** Methods that cannot add a row: reads (incl. private read helpers) and removals. Every OTHER
 *  prototype method is presumed a writer and must be classified above — an unknown verb reds. */
const NON_WRITER = /^(get|list|check|last|readingsOf$|maxRowsProbe$)|^(delete|prune|clear)/;

const writersOf = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor" && !NON_WRITER.test(n));

describe("retention seam - writer classification", () => {
  test.each([
    ["InMemoryStore", InMemoryStore.prototype],
    ["SupabaseStore", SupabaseStore.prototype],
  ])("every %s writer is either filtered or exempt with a reason", (_name, proto) => {
    const writers = writersOf(proto);
    const unclassified = writers.filter((w) => !(FILTERED as readonly string[]).includes(w) && !(w in EXEMPT));
    expect(unclassified, "a new store writer must be added to FILTERED or EXEMPT").toEqual([]);
    // The classification names real methods — a renamed writer can't leave a stale entry behind.
    expect([...FILTERED, ...Object.keys(EXEMPT)].filter((w) => !writers.includes(w))).toEqual([]);
  });
});

const RUN_AT = "2026-06-25T21:00:00.000Z";

const reading = (indicatorId: string): StoredReading => ({
  date: "2026-06-25",
  indicatorId,
  value: 1,
  delta20: 0,
  rawState: "GREEN",
  state: "GREEN",
  decision: null,
});

const pillar = (sleeve: string, basis: string): LegPillarRow => ({
  obsDate: "2026-06-25",
  sleeve,
  superGroup: "MOM",
  value: 0.5,
  estimated: false,
  basis,
  generator: "g1",
});

const readIds = async (store: Store) => (await store.getReadingsForRun(RUN_AT)).map((r) => r.indicatorId).sort();

function retentionContract(name: string, make: () => Promise<Store>, d: typeof describe = describe) {
  d(`retention seam - ${name} filtered writers drop refused ids`, () => {
    test("recordReadings", async () => {
      const store = await make();
      await store.recordReadings([reading("X"), reading("Y")], RUN_AT);
      expect(await readIds(store)).toEqual(["Y"]);
    });

    test("recordRun drops the refused reading and still records the alert", async () => {
      const store = await make();
      await store.recordRun([reading("X"), reading("Y")], RUN_AT, alert({ firedAt: RUN_AT, date: "2026-06-25" }));
      expect(await readIds(store)).toEqual(["Y"]);
      expect(await store.getLastAlert()).not.toBeNull();
    });

    test("recordIntradayRun drops the refused reading and still writes the slot", async () => {
      const store = await make();
      await store.recordIntradayRun([reading("X"), reading("Y")], RUN_AT, alert({ firedAt: RUN_AT, date: "2026-06-25" }));
      expect(await readIds(store)).toEqual(["Y"]);
      expect(await store.getIntradayVerdict()).not.toBeNull();
    });

    test("recordWarmup", async () => {
      const store = await make();
      const row = (indicatorId: string) => ({ indicatorId, date: "2026-06-25", value: 1 });
      await store.recordWarmup([row("X"), row("Y")], RUN_AT);
      expect(await store.getWarmup("X", 10)).toEqual([]);
      expect(await store.getWarmup("Y", 10)).toHaveLength(1);
    });

    test("putLegPillars keeps a row only when every basis member is retainable", async () => {
      const store = await make();
      const written = await store.putLegPillars([pillar("a", "X,Y"), pillar("b", "Y"), pillar("c", "")]);
      expect(written).toBe(2);
      expect(await store.getLegPillarSeries("a", "MOM", "g1", 10)).toEqual([]);
      expect(await store.getLegPillarSeries("b", "MOM", "g1", 10)).toHaveLength(1);
      expect(await store.getLegPillarSeries("c", "MOM", "g1", 10)).toHaveLength(1);
    });
  });
}

retentionContract("InMemoryStore", async () => new InMemoryStore(refuseX));

retentionContract(
  "SupabaseStore (integration - local Supabase)",
  async () => {
    await truncate();
    return new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, refuseX);
  },
  describe.runIf(hasDb) as typeof describe,
);

describe("retention seam - default policy", () => {
  test("a store built without a policy keeps exactly what retainable() keeps", async () => {
    const rows = ["F1", "F4", "LEGP_SPY", "X"].map(reading);
    const store = new InMemoryStore();
    await store.recordReadings(rows, RUN_AT);
    expect(await readIds(store)).toEqual(keep(rows, readingIds, retainable).map((r) => r.indicatorId).sort());
  });
});
