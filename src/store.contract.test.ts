import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import { CRON_PRUNE_RETAIN_DAYS, BACKFILL_PRUNE_RETAIN_DAYS, type CalibrationParam, type DegradeEvent, type Store, type StoredReading } from "./store.js";
import { admin, alert, hasDb, supa, truncate } from "./store.test-helpers.js";
import { toStoredReadings } from "./store-project.js";
import { alertRow } from "./store-rows.js";
import type { PersistedPanel } from "./dial-assembly.js";
import type { RunInputs } from "./run-inputs.js";
import { makeDial } from "./test-helpers.js";
import { sweepSupersededEstimates } from "./estimated.js";
import type { Indicator, Reading } from "./domain-types.js";

/** ISO date `offsetDays` from `base` (negative = earlier) — for cadence fixtures. */
const isoDay = (base: string, offsetDays: number): string => {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const cuts = { levelAmber: -0.224, levelRed: -0.3526 };

const reading = (over: Partial<StoredReading> = {}): StoredReading => ({
  date: "2026-06-25",
  indicatorId: "F1",
  value: 4.2,
  delta20: 0.3,
  rawState: "AMBER",
  state: "GREEN",
  decision: null,
  ...over,
});

const calib = (over: Partial<CalibrationParam> = {}): CalibrationParam => ({
  market: null,
  mode: null,
  channel: "credit",
  metric: "evt_level_red",
  value: 1.23,
  ciLow: 1.0,
  ciHigh: 1.5,
  method: "evt_gpd",
  nEvents: 6,
  windowStart: "2010-01-01",
  windowEnd: "2026-06-01",
  notes: "stage-2",
  computedAt: "2026-06-25T21:00:00.000Z",
  ...over,
});

/**
 * One contract, both implementations. `InMemoryStore` is a test-only fake (never
 * returned by getStore) — running it through the SAME assertions as the real
 * `SupabaseStore` is what keeps the fake faithful: a behaviour the fake gets
 * wrong but Postgres gets right (or vice-versa) fails here instead of silently
 * diverging. Every assertion goes through the `Store` interface — no peeking at
 * `InMemoryStore.readings` or raw PostgREST rows — so the two stay interchangeable.
 *
 * `makeStore` returns a fresh, empty store per test (the Supabase variant
 * truncates); ordering-sensitive reads use explicit increasing `firedAt`/`runAt`
 * so append-order (fake) and `order by` (Postgres) agree.
 */
function storeContract(
  name: string,
  makeStore: () => Promise<Store>,
  register: (name: string, fn: () => void) => void = describe,
): void {
  register(name, () => {
    let store: Store;
    beforeEach(async () => {
      store = await makeStore();
    });

    test("recordWarmup upserts on (indicator, date); getWarmup is oldest→newest, capped to the newest `limit`", async () => {
      const rows = (v: number) => ["2024-01-02", "2024-01-01", "2024-01-03"].map((date) => ({ indicatorId: "CG", date, value: v }));
      await store.recordWarmup(rows(1), "2026-01-01T00:00:00.000Z");
      await store.recordWarmup(rows(2), "2026-01-02T00:00:00.000Z"); // second write wins, no duplicates
      await store.recordWarmup([{ indicatorId: "R1", date: "2024-01-01", value: 9 }], "2026-01-02T00:00:00.000Z");
      expect(await store.getWarmup("CG", 100)).toEqual([
        { date: "2024-01-01", value: 2 },
        { date: "2024-01-02", value: 2 },
        { date: "2024-01-03", value: 2 },
      ]);
      expect(await store.getWarmup("CG", 2)).toEqual([
        { date: "2024-01-02", value: 2 },
        { date: "2024-01-03", value: 2 },
      ]);
      expect(await store.getWarmup("CG", 0)).toEqual([]);
    });

    describe("scorer_vintage", () => {
      const vintage = (over: Partial<import("./store.js").ScorerVintageRow> = {}) => ({
        indicator_id: "F1",
        config_hash: "abc123abc123",
        logic_version: 1,
        stamped_at: "2026-09-05T00:00:00+00:00",
        ...over,
      });

      test("recordScorerVintage upserts on indicator_id — the second stamp wins, one row", async () => {
        await store.recordScorerVintage([vintage()]);
        await store.recordScorerVintage([vintage({ config_hash: "def456def456", logic_version: 2 })]);
        expect(await store.getScorerVintages()).toEqual([
          vintage({ config_hash: "def456def456", logic_version: 2 }),
        ]);
      });

      test("recordScorerVintage([]) is a no-op (no request, nothing written)", async () => {
        await store.recordScorerVintage([]);
        expect(await store.getScorerVintages()).toEqual([]);
      });
    });

    test("intraday verdict slot: put/get round-trips the whole record (panel + dial blobs), a second put overwrites, clear empties (L1)", async () => {
      expect(await store.getIntradayVerdict()).toBeNull();
      const day = alert({ firedAt: "2026-06-26T12:00:00.000Z", date: "2026-06-26", level: "WATCH" });
      await store.putIntradayVerdict(day);
      const got = await store.getIntradayVerdict();
      expect(got?.firedAt).toBe(day.firedAt);
      expect(got?.level).toBe("WATCH");
      expect(got?.dialState).toEqual(day.dialState);
      expect(got?.panelState).toEqual(day.panelState);
      // The slot is NOT alert_log: the notify baseline stays empty.
      expect(await store.getLastAlert()).toBeNull();
      await store.putIntradayVerdict(alert({ firedAt: "2026-06-26T15:00:00.000Z", date: "2026-06-26" }));
      expect((await store.getIntradayVerdict())?.firedAt).toBe("2026-06-26T15:00:00.000Z");
      await store.clearIntradayVerdict();
      expect(await store.getIntradayVerdict()).toBeNull();
      await store.clearIntradayVerdict(); // idempotent on an empty slot
    });

    test("recordIntradayRun commits the readings AND the slot (run_at = the run), overwriting an older slot; no alert_log row", async () => {
      await store.putIntradayVerdict(alert({ firedAt: "2026-06-25T12:00:00.000Z", date: "2026-06-25" }));
      const runAt = "2026-06-26T12:00:00.000Z";
      await store.recordIntradayRun([reading({ date: "2026-06-26", value: 7 })], runAt, alert({ firedAt: runAt, date: "2026-06-26", level: "WATCH" }));
      expect((await store.getReadingsForRun(runAt)).map((r) => [r.date, r.value])).toEqual([["2026-06-26", 7]]);
      const slot = await store.getIntradayVerdict();
      expect([slot?.firedAt, slot?.level]).toEqual([runAt, "WATCH"]);
      expect(await store.getLastAlert()).toBeNull();
    });

    test("rewriteIntradayVerdict rewrites only the run that still holds the slot — a newer run's slot is left alone", async () => {
      const older = alert({ firedAt: "2026-06-26T12:00:00.000Z", date: "2026-06-26", level: "WATCH" });
      await store.putIntradayVerdict(older);
      expect(await store.rewriteIntradayVerdict({ ...older, level: "WARNING" })).toBe(1);
      expect((await store.getIntradayVerdict())?.level).toBe("WARNING");
      await store.putIntradayVerdict(alert({ firedAt: "2026-06-26T13:00:00.000Z", date: "2026-06-26", level: "OK" }));
      expect(await store.rewriteIntradayVerdict(older)).toBe(0);
      expect([(await store.getIntradayVerdict())?.firedAt, (await store.getIntradayVerdict())?.level]).toEqual(["2026-06-26T13:00:00.000Z", "OK"]);
    });

    test("checkSchema resolves when the DB has every column the code reads", async () => {
      // InMemory: a trivial no-op. Supabase: a real zero-row projection of every
      // column — fails loud here if a migration the code expects wasn't pushed.
      await expect(store.checkSchema()).resolves.toBeUndefined();
    });

    test("recordReadings appends every run's readings, addressable by run_at (vintage capture)", async () => {
      await store.recordReadings([reading(), reading({ indicatorId: "F2" })], "2026-06-25T21:00:00.000Z");
      // A later run re-stores the same (date, indicator) — must NOT overwrite; both runs persist.
      await store.recordReadings([reading({ value: 9.9 })], "2026-06-26T21:00:00.000Z");

      const run1 = await store.getReadingsForRun("2026-06-25T21:00:00.000Z");
      const run2 = await store.getReadingsForRun("2026-06-26T21:00:00.000Z");
      expect(run1).toHaveLength(2);
      expect(run2).toHaveLength(1);
      expect(run2[0]).toMatchObject({ indicatorId: "F1", value: 9.9, rawState: "AMBER", state: "GREEN" });
      // The internal run_at stamp must NOT leak into the returned shape — TS won't
      // catch the leak (excess props are assignable) and toMatchObject ignores it.
      expect(run2[0]).not.toHaveProperty("runAt");
      // An unknown run (orphaned partial run) yields nothing.
      expect(await store.getReadingsForRun("1999-01-01T00:00:00.000Z")).toEqual([]);
    });

    test("getReadingVersions returns every vintage of one (id, date) in insert order, runAt set", async () => {
      await store.recordReadings([reading({ value: 1 }), reading({ indicatorId: "F2" })], "2026-06-25T21:00:00.000Z");
      // Inserted with an OLDER run_at: insert order, not run_at order.
      await store.recordReadings([reading({ value: 2, estimated: true }), reading({ date: "2026-06-24" })], "2026-06-24T21:00:00.000Z");
      const vs = await store.getReadingVersions("F1", reading().date);
      expect(vs.map((v) => [v.value, v.runAt === undefined ? undefined : Date.parse(v.runAt), v.estimated ?? false])).toEqual([
        [1, Date.parse("2026-06-25T21:00:00.000Z"), false],
        [2, Date.parse("2026-06-24T21:00:00.000Z"), true],
      ]);
    });

    test("recordReadings is a no-op for an empty batch", async () => {
      await store.recordReadings([], "2026-06-25T21:00:00.000Z");
      expect(await store.getReadingsForRun("2026-06-25T21:00:00.000Z")).toEqual([]);
    });

    test("round-trips the derived `decision` value - non-null for a derived id, null for a non-derived id", async () => {
      // Case 2: the cron-captured decision variable must survive the write+read for BOTH stores
      // (the SupabaseStore path proves the new `decision` column is written AND read back, not
      // silently dropped — the mode-cell trap). A non-derived id stores null.
      const runAt = "2026-07-15T21:00:00.000Z";
      await store.recordReadings(
        [reading({ indicatorId: "F6", decision: -0.037 }), reading({ indicatorId: "R1", decision: null })],
        runAt,
      );
      const rows = (await store.getReadingsForRun(runAt)).sort((a, b) => a.indicatorId.localeCompare(b.indicatorId));
      expect(rows.map((r) => r.indicatorId)).toEqual(["F6", "R1"]);
      expect(rows[0]!.decision).toBe(-0.037); // derived id round-trips the captured scalar
      expect(rows[1]!.decision).toBeNull(); // non-derived id persists null
    });

    test("round-trips `band_cuts` - the resolved cut object for a scored id, null for none", async () => {
      // Stage 2.1: the cut the scorer used is persisted per reading. recordRun (NOT
      // recordReadings) so the SupabaseStore path proves record_run's jsonb_populate_recordset
      // picks the new band_cuts column up BY NAME - a dropped key would read back null and fail
      // here. The null case proves an unscored id persists null without throwing.
      const runAt = "2026-08-20T21:00:00.000Z";
      const cuts = { levelAmber: -0.224, levelRed: -0.3526, velAmber: 0.061 };
      await store.recordRun(
        [reading({ indicatorId: "F3", bandCuts: cuts }), reading({ indicatorId: "F1", bandCuts: null })],
        runAt,
        alert({ level: "OK", date: "2026-08-20", firedAt: runAt }),
      );
      const rows = (await store.getReadingsForRun(runAt)).sort((a, b) => a.indicatorId.localeCompare(b.indicatorId));
      expect(rows.map((r) => r.indicatorId)).toEqual(["F1", "F3"]);
      expect(rows[0]!.bandCuts).toBeNull(); // unscored id persists null, no throw
      expect(rows[1]!.bandCuts).toEqual(cuts); // scored id round-trips its cut object verbatim
    });

    test("round-trips `estimated` through recordRun - an estimate reads back flagged, a final row unflagged", async () => {
      const runAt = "2026-10-02T18:31:00.000Z";
      await store.recordRun(
        [reading({ indicatorId: "F1", estimated: true }), reading({ indicatorId: "F2" })],
        runAt,
        alert({ level: "OK", date: "2026-10-02", firedAt: runAt }),
      );
      const rows = (await store.getReadingsForRun(runAt)).sort((a, b) => a.indicatorId.localeCompare(b.indicatorId));
      expect(rows.map((r) => [r.indicatorId, r.estimated])).toEqual([["F1", true], ["F2", undefined]]);
    });

    test("no series read path serves a `carried` key, even off a row written with one", async () => {
      const runAt = "2026-10-02T18:31:00.000Z";
      const stray = { ...reading({ date: "2026-10-02", estimated: true }), carried: true } as StoredReading;
      await store.recordRun([stray], runAt, alert({ level: "OK", date: "2026-10-02", firedAt: runAt }));
      const served = [
        ...(await store.getSeries("F1", 5)),
        ...(await store.getSeriesBulk(["F1"], { limit: 2 })).get("F1")!, // readings_newest_n
        ...(await store.getSeriesBulk(["F1"], { limit: 1 })).get("F1")!, // readings_newest
        ...(await store.getReadingVersions("F1", "2026-10-02")),
      ];
      expect(served.map((p) => p.estimated)).toEqual([true, true, true, true]);
      expect(served.filter((p) => "carried" in p)).toEqual([]);
    });

    test("E7: a final row beats a NEWER estimate on every read path; an estimate alone is served flagged", async () => {
      // F1 06-25: final at 21:00, estimate written LATER at 23:00. F1 06-24 and F2 06-25: estimate only.
      await store.recordReadings([reading({ date: "2026-06-24", value: 40, estimated: true })], "2026-06-24T23:00:00.000Z");
      await store.recordReadings([reading({ value: 1 })], "2026-06-25T21:00:00.000Z");
      await store.recordReadings(
        [reading({ value: 50, estimated: true }), reading({ indicatorId: "F2", value: 60, estimated: true })],
        "2026-06-25T23:00:00.000Z",
      );
      const series = await store.getSeries("F1", 5);
      expect(series.map((p) => [p.date, p.value, p.estimated])).toEqual([["2026-06-24", 40, true], ["2026-06-25", 1, undefined]]);
      expect((await store.getSeriesBulk(["F1"], { limit: 2 })).get("F1")).toEqual(series); // readings_newest_n
      const newest = await store.getSeriesBulk(["F1", "F2"], { limit: 1 }); // readings_newest
      expect(newest.get("F1")!.map((p) => [p.value, p.estimated])).toEqual([[1, undefined]]);
      expect(newest.get("F2")!.map((p) => [p.value, p.estimated])).toEqual([[60, true]]);
    });

    test("same-class tie on an identical runAt: every read path and prune keep the SECOND insert (id desc)", async () => {
      const runAt = "2026-06-25T21:00:00.000Z";
      await store.recordReadings([reading({ value: 1 })], runAt);
      await store.recordReadings([reading({ value: 2 })], runAt);
      expect((await store.getSeries("F1", 5)).map((p) => p.value)).toEqual([2]); // readings_latest
      expect((await store.getSeriesBulk(["F1"], { limit: 1 })).get("F1")!.map((p) => p.value)).toEqual([2]); // readings_newest
      expect((await store.getSeriesBulk(["F1"], { limit: 3 })).get("F1")!.map((p) => p.value)).toEqual([2]); // readings_newest_n
      expect(await store.pruneShadowedReadings(["F1"])).toBe(1);
      expect((await store.getReadingsForRun(runAt)).map((r) => r.value)).toEqual([2]);
    });

    test("E3 sweep falsifier: print lands → the estimate row is gone and the latest read returns the print", async () => {
      const estRun = "2026-10-02T18:31:00.000Z";
      await store.recordReadings([reading({ date: "2026-10-02", value: 50, estimated: true })], estRun);
      expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(0); // no print yet: the estimate stands
      await store.recordReadings([reading({ date: "2026-10-02", value: 9 })], "2026-10-02T22:00:00.000Z");
      expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(1);
      expect(await store.getReadingsForRun(estRun)).toEqual([]);
      expect((await store.getSeries("F1", 5)).map((p) => [p.date, p.value, p.estimated])).toEqual([["2026-10-02", 9, undefined]]);
    });

    test("deleteNonEstimatesOnDates keeps the `estimated` row on its date; deleteEstimatesOnDates is its mirror", async () => {
      await store.recordReadings([reading({ date: "2026-10-02", value: 50, estimated: true })], "2026-10-02T18:31:00.000Z");
      await store.recordReadings([reading({ date: "2026-10-02", value: 9 })], "2026-10-02T12:00:00.000Z");
      expect(await store.deleteNonEstimatesOnDates("F1", ["2026-10-02"])).toBe(1);
      expect((await store.getSeries("F1", 5)).map((p) => [p.value, p.estimated])).toEqual([[50, true]]);
      expect(await store.deleteEstimatesOnDates("F1", ["2026-10-02"])).toBe(1);
      expect(await store.getSeries("F1", 5)).toEqual([]);
    });

    test("deleteNonEstimatesOnDates(…, pinAlertRuns) spares an alert run's FINAL row (`run_at` = a `fired_at`)", async () => {
      const firedAt = "2026-10-02T22:00:00.000Z";
      await store.recordRun([reading({ date: "2026-10-02", value: 1 })], firedAt, alert({ date: "2026-10-02", firedAt }));
      await store.recordReadings([reading({ date: "2026-10-02", value: 2 })], "2026-10-03T12:00:00.000Z");
      expect(await store.deleteNonEstimatesOnDates("F1", ["2026-10-02"], true)).toBe(1); // the non-alert one only
      expect((await store.getReadingsForRun(firedAt)).map((r) => r.value)).toEqual([1]);
    });

    test("deleteProvisionalOnDates deletes only a date's provisional NON-estimate rows: its FINAL row and its estimate stay", async () => {
      await store.recordReadings([reading({ date: "2026-10-02", value: 1 })], "2026-10-02T12:00:00.000Z"); // provisional
      await store.recordReadings([reading({ date: "2026-10-02", value: 2, estimated: true })], "2026-10-02T13:00:00.000Z");
      await store.recordReadings([reading({ date: "2026-10-01", value: 3 })], "2026-10-02T12:00:00.000Z"); // FINAL: past 10-01's cutoff
      await store.recordReadings([reading({ date: "2026-10-01", value: 4 })], "2026-10-01T12:00:00.000Z"); // provisional sibling
      expect(await store.deleteProvisionalOnDates("F1", ["2026-10-01", "2026-10-02"])).toBe(2);
      expect((await store.getSeries("F1", 5)).map((p) => [p.date, p.value, p.estimated])).toEqual([["2026-10-01", 3, undefined], ["2026-10-02", 2, true]]);
      expect(await store.deleteProvisionalOnDates("F1", ["2026-10-01", "2026-10-02"])).toBe(0);
    });

    test("deleteProvisionalOnDates never deletes an alert run's row (`run_at` = a `fired_at`): a forced EOD run before the cutoff", async () => {
      const firedAt = "2026-10-02T14:00:00.000Z";
      await store.recordRun([reading({ date: "2026-10-02", value: 1 })], firedAt, alert({ date: "2026-10-02", firedAt }));
      await store.recordReadings([reading({ date: "2026-10-02", value: 2 })], "2026-10-02T12:00:00.000Z"); // an older daytime head
      expect(await store.deleteProvisionalOnDates("F1", ["2026-10-02"])).toBe(1);
      expect((await store.getReadingsForRun(firedAt)).map((r) => r.value)).toEqual([1]);
    });

    test("deleteEstimatesOnDates' `before` bound deletes only older runs' estimates (I6)", async () => {
      for (const [value, runAt] of [[1, "2026-10-02T12:00:00.000Z"], [2, "2026-10-02T13:00:00.000Z"]] as const)
        await store.recordReadings([reading({ date: "2026-10-02", value, estimated: true })], runAt);
      expect(await store.deleteEstimatesOnDates("F1", ["2026-10-02"], "2026-10-02T13:00:00.000Z")).toBe(1);
      expect((await store.getSeries("F1", 5)).map((p) => p.value)).toEqual([2]);
    });

    test("deleteEstimatesOnDates never deletes an alert run's row (`run_at` = a `fired_at`): it survives a `before` dedup and the E3 sweep", async () => {
      const firedAt = "2026-10-02T22:00:00.000Z";
      await store.recordRun([reading({ date: "2026-10-02", value: 1, estimated: true })], firedAt, alert({ date: "2026-10-02", firedAt }));
      await store.recordReadings([reading({ date: "2026-10-02", value: 2, estimated: true })], "2026-10-02T23:00:00.000Z");
      expect(await store.deleteEstimatesOnDates("F1", ["2026-10-02"], "2026-10-03T12:00:00.000Z")).toBe(1); // the non-alert one only
      await store.recordReadings([reading({ date: "2026-10-02", value: 9 })], "2026-10-03T22:00:00.000Z");
      expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(0);
      expect((await store.getReadingsForRun(firedAt)).map((r) => [r.value, r.estimated])).toEqual([[1, true]]);
      expect((await store.getSeries("F1", 5)).map((p) => [p.value, p.estimated])).toEqual([[9, undefined]]); // the print serves
    });

    test("dated deletes past IN_LIST_CHUNK dates (450) delete every row and sum the per-chunk counts", async () => {
      const dates = Array.from({ length: 450 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
      await store.recordReadings(dates.map((date) => reading({ date })), "2026-10-02T12:00:00.000Z");
      await store.recordReadings(dates.map((date) => reading({ date, indicatorId: "F2", estimated: true })), "2026-10-02T13:00:00.000Z");
      expect(await store.deleteReadingsOnDates("F1", dates)).toBe(450);
      expect(await store.getSeries("F1", 1000)).toEqual([]);
      expect(await store.deleteEstimatesOnDates("F2", dates)).toBe(450);
      expect(await store.getSeries("F2", 1000)).toEqual([]);
    });

    test("getEstimateDates lists each id's raw estimate dates from `from` on, a FINAL-shadowed one included", async () => {
      await store.recordReadings([reading({ date: "2026-10-01", estimated: true }), reading({ date: "2026-10-02", estimated: true }), reading({ date: "2026-10-02", indicatorId: "F2" })], "2026-10-02T18:00:00.000Z");
      await store.recordReadings([reading({ date: "2026-10-02", value: 9 })], "2026-10-02T22:00:00.000Z");
      expect([...(await store.getEstimateDates(["F1", "F2"], "2026-10-02"))]).toEqual([["F1", ["2026-10-02"]]]);
      expect((await store.getEstimateDates(["F1"], "2026-09-01")).get("F1")).toEqual(["2026-10-01", "2026-10-02"]);
    });

    test("recordRun persists the run's readings and its alert together (atomic write)", async () => {
      const runAt = "2026-06-25T21:00:00.000Z";
      await store.recordRun(
        [reading({ value: 1.1 }), reading({ indicatorId: "F2", value: 2.2 })],
        runAt,
        alert({
          level: "WARNING",
          date: "2026-06-25",
          firedAt: runAt,
          // Non-null on purpose: record_run()'s INSERT names its columns explicitly and
          // silently drops any p_alert key it omits (the 2026-07-03 mode-cell bug). A
          // fixture of nulls round-trips green through a broken RPC and guards nothing,
          // so a tier column must carry a value a dropped key cannot reproduce.
          bottomState: "CALM",
          ratio: 1.12,
        }),
      );

      const persisted = await store.getReadingsForRun(runAt);
      expect(persisted).toHaveLength(2);
      expect(persisted.map((r) => r.indicatorId).sort()).toEqual(["F1", "F2"]);
      const last = await store.getLastAlert();
      expect(last?.level).toBe("WARNING");
      expect(last?.firedAt).toContain("2026-06-25");
      expect(last?.ratio).toBeCloseTo(1.12);
    });

    test("E12 display_dial_state/display_panel_state round-trip via recordRun; narrow read omits the display panel", async () => {
      const runAt = "2026-06-25T21:00:00.000Z";
      const displayDial = makeDial({ rung: 9, positionP: 0.9 });
      const displayPanel = {
        globalPanel: [], displayPanel: [], heldMemberState: {},
        cissHistory: [{ id: "F1", history: [{ state: "GREEN" }, { state: "RED" }] }],
      } as unknown as PersistedPanel;
      await store.recordRun([], runAt, alert({ firedAt: runAt, dialState: makeDial(), displayDialState: displayDial, displayPanelState: displayPanel }));
      const narrow = await store.getLastAlert();
      expect(narrow?.dialState).toEqual(makeDial());
      expect(narrow?.displayDialState).toEqual(displayDial);
      expect(narrow).not.toHaveProperty("displayPanelState");
      const wide = await store.getLastAlert({ withPanel: true });
      expect(wide?.displayPanelState).toEqual(displayPanel);
    });

    test("run_inputs round-trips via recordRun on a withRunInputs read only; the served reads and the intraday slot never carry it", async () => {
      const runAt = "2026-06-25T21:00:00.000Z";
      const runInputs = { v: 1, refs: { last: null, prevDay: null, lastPush: null }, geoFlags: 2, crisisStage: 0, scored: [], lastBands: [null], exposurePosture: "Core", fallShape: null, spDistToHigh: null, nearHighTol: 0.02, stamps: { F1: { ageDays: 3, lag: true, unit: "slots" } } } as RunInputs;
      await store.recordRun([], runAt, alert({ firedAt: runAt, runInputs }));
      expect((await store.getLastAlert({ withRunInputs: true }))?.runInputs).toEqual(runInputs);
      expect(await store.getLastAlert({ withPanel: true })).not.toHaveProperty("runInputs");
      await store.putIntradayVerdict(alert({ firedAt: "2026-06-26T15:00:00.000Z", runInputs }));
      expect(await store.getIntradayVerdict()).not.toHaveProperty("runInputs");
    });

    test("updateRunTrace rewrites timings + degraded on the row at firedAt only; a served read carries both", async () => {
      const runAt = "2026-06-25T21:00:00.000Z";
      const other = "2026-06-24T21:00:00.000Z";
      await store.recordRun([], other, alert({ firedAt: other, degraded: [] }));
      await store.recordRun([], runAt, alert({ firedAt: runAt, level: "WATCH", degraded: [] }));
      const timings = { cold: true, anchorMs: 9100, marks: { persist: 31400, tail: 44000 } };
      const degraded = [{ scope: "[seed-tail] seed non-live this run", reason: "[input-series] BBB seed non-live this run: aborted", effect: "trace" as const }];
      expect(await store.updateRunTrace(runAt, { timings, degraded })).toBe(1);
      expect(await store.updateRunTrace("2026-06-23T21:00:00.000Z", { timings, degraded })).toBe(0);
      const [row, prior] = await store.getRecentAlerts(2);
      expect([row?.timings, row?.degraded, row?.level]).toEqual([timings, degraded, "WATCH"]);
      expect([prior?.timings, prior?.degraded]).toEqual([undefined, []]);
    });

    test("getAlertAt reads the row at exactly one fired_at (run_inputs opt-in); an unmatched instant is null", async () => {
      const runInputs = { v: 1, refs: { last: null, prevDay: null, lastPush: null }, geoFlags: 0, crisisStage: 0, scored: [], lastBands: [], exposurePosture: null, fallShape: null, spDistToHigh: null, nearHighTol: null, stamps: {} } as RunInputs;
      await store.recordRun([], "2026-06-24T21:00:00.000Z", alert({ firedAt: "2026-06-24T21:00:00.000Z", level: "WATCH" }));
      await store.recordRun([], "2026-06-25T21:00:00.000Z", alert({ firedAt: "2026-06-25T21:00:00.000Z", level: "WARNING", runInputs }));
      await store.recordAlert(alert({ firedAt: "2026-06-26T21:00:00.000Z", level: "CRITICAL" }));
      const at = await store.getAlertAt("2026-06-25T21:00:00.000Z", { withRunInputs: true });
      expect(at?.level).toBe("WARNING");
      expect(at?.runInputs).toEqual(runInputs);
      expect(await store.getAlertAt("2026-06-25T21:00:00.000Z")).not.toHaveProperty("runInputs");
      expect(await store.getAlertAt("2026-06-25T21:00:00.001Z")).toBeNull();
    });

    test("record_run round-trips every non-default tier_state / degraded / r4 / rerisk field through the RPC (column-drift guard)", async () => {
      // The alert() fixture defaults these to null / [] / 0, so a column named in ALERT_COLS but NOT
      // in record_run's INSERT (or a bare `add column default 0`) would read back the default through
      // the prod atomic write and pass silently (the mode-cell / held_sleeve drift trap,
      // .claude/rules/migrations.md). Only a NON-default value per field catches that drift.
      const runAt = "2026-06-25T21:00:00.000Z";
      // ⚠ Both `scope` strings are OPAQUE jsonb payload: the RPC stores and returns them verbatim, so
      // they are DELIBERATELY NOT pinned to any producer's wording (that would make this file a second
      // source for `run-cycle-fred.ts`'s literal).
      const degraded: DegradeEvent[] = [
        { scope: "[baa10y] Baa10y feed unavailable - CQS card non-live this run", reason: "fetch 503", effect: "notify" },
        { scope: "[FXH] FX havens unavailable - Flight family FX leg non-live this run", reason: "timeout", effect: "trace" },
      ];
      const fields = {
        slowScore: 2,
        slowBand: "ELEVATED",
        bottomState: "BOTTOM-FORMING",
        vix: 38.2,
        vix3m: 34.1,
        ratio: 1.12,
        degraded,
        r4Phase: "reentry",
        r4ReentryRung: 8,
        reriskConfirmCount: 1,
      } as const;
      await store.recordRun([], runAt, alert({ firedAt: runAt, ...fields, r4EntryFiredAt: "2026-06-05T21:00:00.000Z" }));

      const last = await store.getLastAlert();
      expect(last).toMatchObject(fields);
      // timestamptz may re-format the zone (+00:00 vs .000Z): compare the instant — a dropped column reads back null → NaN.
      expect(Date.parse(last!.r4EntryFiredAt!)).toBe(Date.parse("2026-06-05T21:00:00.000Z"));
    });

    test("getLastAlert returns null when empty, then the newest by fired_at (camelCase round-trip)", async () => {
      expect(await store.getLastAlert()).toBeNull();

      await store.recordAlert(alert({ level: "WATCH", firedAt: "2026-06-25T21:00:00.000Z" }));
      await store.recordAlert(alert({ level: "WARNING", firedAt: "2026-06-26T21:00:00.000Z" }));

      const last = await store.getLastAlert();
      expect(last?.level).toBe("WARNING");
      // Every domain field survives the round-trip (snake_case ↔ camelCase for Supabase).
      expect(last).toMatchObject({ date: "2026-06-25", fin: 2, rate: 0, geoFlags: 0, coincident: "GREEN", finReds: 0 });
      // fired_at → firedAt mapping survives too (toContain, not exact: Postgres
      // timestamptz formats the offset differently from the literal ISO input).
      expect(last?.firedAt).toContain("2026-06-26");
    });

    test("getLastPush returns the newest PUSHED run, skipping silent runs", async () => {
      expect(await store.getLastPush()).toBeNull();

      await store.recordAlert(alert({ level: "WARNING", firedAt: "2026-06-24T21:00:00.000Z", pushedAt: "2026-06-24T21:00:00.000Z" }));
      await store.recordAlert(alert({ level: "WARNING", firedAt: "2026-06-25T21:00:00.000Z", pushedAt: null })); // silent same-level
      await store.recordAlert(alert({ level: "CRITICAL", firedAt: "2026-06-26T21:00:00.000Z", pushedAt: "2026-06-26T21:00:00.000Z" }));

      const last = await store.getLastPush();
      expect(last?.level).toBe("CRITICAL");
      expect(last?.pushedAt).toContain("2026-06-26");
    });

    test("a superseding row (rederived_from) is SERVED and read by scoring, and skipped by every notify baseline", async () => {
      const original = "2026-06-25T21:00:00.000Z";
      const superseding = "2026-06-25T21:00:00.001Z";
      // Superseding row written FIRST: the winner is max fired_at, never insert order.
      await store.recordRun([], superseding, alert({ level: "CRITICAL", firedAt: superseding, rederivedFrom: original, pushedAt: superseding, slowBand: "ELEVATED", dialBand: "CRITICAL" }));
      await store.recordRun([], original, alert({ level: "WATCH", firedAt: original, pushedAt: original, slowBand: "CALM", dialBand: "WATCH" }));

      const served = await store.getLastAlert();
      expect(served?.level).toBe("CRITICAL");
      expect(Date.parse(served!.rederivedFrom!)).toBe(Date.parse(original));
      expect((await store.getRecentAlerts(5)).map((a) => a.level)).toEqual(["CRITICAL"]);
      expect((await store.getLastAlertBefore("2026-06-26"))?.level).toBe("CRITICAL");

      const baseline = await store.getLastAlert({ notifyBaseline: true });
      expect(baseline?.level).toBe("WATCH");
      expect(baseline).not.toHaveProperty("rederivedFrom");
      expect((await store.getLastPush())?.level).toBe("WATCH");
      expect(await store.getLastBand("slowBand")).toBe("CALM");
      expect(await store.getLastBand("dialBand")).toBe("WATCH");
      expect([await store.getLastBandBefore("slowBand", "2026-06-26"), await store.getLastBandBefore("dialBand", "2026-06-26")]).toEqual(["ELEVATED", "CRITICAL"]);
    });

    test("deleteRederived drops the original's superseding rows + their readings, never the original's", async () => {
      const original = "2026-06-25T21:00:00.000Z";
      const superseding = "2026-06-25T21:00:00.002Z";
      const other = "2026-06-24T21:00:00.002Z";
      const r = (indicatorId: string) => ({ date: "2026-06-25", indicatorId, value: 1, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: null });
      await store.recordRun([r("F1")], original, alert({ firedAt: original }));
      await store.recordRun([r("F1"), r("F4")], superseding, alert({ firedAt: superseding, rederivedFrom: original }));
      await store.recordRun([r("F1")], other, alert({ firedAt: other, rederivedFrom: "2026-06-24T21:00:00.000Z" }));
      expect(await store.deleteRederived(original)).toBe(1);
      expect(await store.getReadingsForRun(superseding)).toEqual([]);
      expect(await store.getAlertAt(superseding)).toBeNull();
      expect((await store.getReadingsForRun(original)).map((x) => x.indicatorId)).toEqual(["F1"]);
      expect((await store.getAlertAt(other))?.rederivedFrom).toBeDefined();
      expect(await store.deleteRederived(original)).toBe(0);
    });

    test("getLastBand returns the newest NON-NULL band per column, skipping degraded runs (2026-06-28 dup-notify regression)", async () => {
      // One shared behaviour across the BandField columns: a real band followed by
      // degraded (null-band) runs. The unconditional latest row is null, but getLastBand
      // must return the last REAL band — so a healthy run next won't read CALM and re-fire
      // the transition (the dup-notify bug, and its bottomState analogue).
      expect(await store.getLastBand("slowBand")).toBeNull();
      expect(await store.getLastBand("bottomState")).toBeNull();
      expect(await store.getLastBand("dialBand")).toBeNull();

      // A real band on every column, then two degraded (all-null, via alert()'s defaults) runs.
      await store.recordAlert(
        alert({
          firedAt: "2026-06-28T08:00:00.000Z",
          slowScore: 2,
          slowBand: "ELEVATED",
          bottomState: "CAPITULATION-WATCH",
          dialBand: "WARNING",
        }),
      );
      await store.recordAlert(alert({ firedAt: "2026-06-28T10:00:00.000Z" }));
      await store.recordAlert(alert({ firedAt: "2026-06-28T12:00:00.000Z" }));

      expect(await store.getLastBand("slowBand")).toBe("ELEVATED");
      expect(await store.getLastBand("bottomState")).toBe("CAPITULATION-WATCH");
      expect(await store.getLastBand("dialBand")).toBe("WARNING");
    });

    test("getRecentAlerts returns newest-first by fired_at, capped at limit", async () => {
      expect(await store.getRecentAlerts(10)).toEqual([]);

      await store.recordAlert(alert({ level: "WATCH", firedAt: "2026-06-24T21:00:00.000Z" }));
      await store.recordAlert(alert({ level: "WARNING", firedAt: "2026-06-25T21:00:00.000Z" }));
      await store.recordAlert(alert({ level: "CRITICAL", firedAt: "2026-06-26T21:00:00.000Z" }));

      expect((await store.getRecentAlerts(2)).map((a) => a.level)).toEqual(["CRITICAL", "WARNING"]);
    });

    // The same-fired-date collapse is "max fired_at wins", NOT "last inserted wins". Every other
    // fixture here records in strictly ASCENDING firedAt, so the two rules agree and the
    // divergence went untested — InMemoryStore actually implemented last-inserted (scan the log
    // in reverse) while SupabaseStore orders `fired_at DESC` on the wire. This fixture inserts
    // the LATER run FIRST, so an insertion-order fake returns the 09:00 row and goes red.
    test("same-date collapse picks max fired_at even when rows are recorded out of order", async () => {
      await store.recordAlert(
        alert({ date: "2026-06-30", level: "CRITICAL", firedAt: "2026-06-30T21:00:00.000Z", r4Phase: "cash" }),
      );
      await store.recordAlert(
        alert({ date: "2026-06-30", level: "WATCH", firedAt: "2026-06-30T09:00:00.000Z", r4Phase: "equity" }),
      );

      const recent = await store.getRecentAlerts(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.level).toBe("CRITICAL");
      expect(recent[0]!.firedAt).toContain("21:00:00");

      expect(await store.getAlertsSince("2026-06-30")).toEqual([{ date: "2026-06-30", r4Phase: "cash" }]);
    });

    // The tie-break every collapse docblock stresses — a same-second re-run, or a backfill
    // inserting a whole day at one timestamp — was asserted in prose and pinned by NO fixture:
    // every other case here uses distinct firedAt values, so `max fired_at` alone decides them
    // and the tiebreaker never runs. With fired_at IDENTICAL, only the secondary key can pick a
    // winner: `id DESC` in the alert_log_recent RPC, insertion-index DESC in InMemoryStore. Both
    // mean "the later INSERT is the later run", so this fixture goes red on either store the
    // moment a tiebreaker is dropped or reversed.
    test("same-date collapse breaks an exact fired_at tie on insert order (later run wins)", async () => {
      const tied = "2026-07-02T21:00:00.000Z";
      await store.recordAlert(alert({ date: "2026-07-02", level: "WATCH", firedAt: tied, r4Phase: "equity" }));
      await store.recordAlert(alert({ date: "2026-07-02", level: "CRITICAL", firedAt: tied, r4Phase: "cash" }));

      const recent = await store.getRecentAlerts(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.level).toBe("CRITICAL");

      // The divergence this fixture once only DOCUMENTED: SupabaseStore resolved the same tie the
      // OPPOSITE way — the EARLIER insert's "equity" — because the query carried no secondary key and
      // the collapse kept whichever row came back first. `getAlertsSince` feeds `timeInCashShare`, so a
      // tied day counted the superseded run. Fixed by `.order("id", desc)` in the query; asserted on
      // BOTH stores here, so dropping or reversing either tiebreaker goes red.
      expect(await store.getAlertsSince("2026-07-02")).toEqual([{ date: "2026-07-02", r4Phase: "cash" }]);
    });

    // The collapse key is the UTC calendar date of the instant — SQL
    // `(fired_at at time zone 'utc')::date`, JS `toISOString().slice(0,10)` (store-rows.ts).
    // Nothing pinned that they agree ACROSS a midnight boundary, where a local-time reading of
    // either would fold these two runs into one date and halve the window.
    test("fired-date is the UTC date: runs either side of UTC midnight are two dates", async () => {
      await store.recordAlert(alert({ date: "2026-07-05", level: "WATCH", firedAt: "2026-07-05T23:30:00.000Z" }));
      await store.recordAlert(alert({ date: "2026-07-06", level: "CRITICAL", firedAt: "2026-07-06T00:30:00.000Z" }));

      const recent = await store.getRecentAlerts(10);
      expect(recent.map((a) => a.level)).toEqual(["CRITICAL", "WATCH"]);
    });

    test("getSeries returns one point per date (latest vintage), oldest→newest, capped at limit", async () => {
      expect(await store.getSeries("F1", 10)).toEqual([]);

      await store.recordReadings([reading({ date: "2026-06-23", value: 1.0 })], "2026-06-23T21:00:00.000Z");
      await store.recordReadings([reading({ date: "2026-06-24", value: 2.0 })], "2026-06-24T21:00:00.000Z");
      // A later run re-stores 2026-06-24 (a revision) — the latest run_at must win.
      await store.recordReadings([reading({ date: "2026-06-24", value: 2.5 })], "2026-06-25T21:00:00.000Z");
      // Same run carries another indicator on the newest date — must be filtered out.
      await store.recordReadings(
        [reading({ date: "2026-06-25", value: 3.0 }), reading({ date: "2026-06-25", indicatorId: "F2", value: 9.9 })],
        "2026-06-25T21:00:00.000Z",
      );

      const series = await store.getSeries("F1", 10);
      expect(series.map((p) => [p.date, p.value])).toEqual([
        ["2026-06-23", 1.0],
        ["2026-06-24", 2.5], // revised vintage wins
        ["2026-06-25", 3.0], // F2 excluded
      ]);
      // State fields + the WINNING vintage's run_at (A1 isProvisional); no indicatorId. Epoch compare: PG emits +00:00.
      expect(series[0]).toMatchObject({ delta20: 0.3, rawState: "AMBER", state: "GREEN" });
      expect(series.map((p) => Date.parse(p.runAt ?? ""))).toEqual(
        ["2026-06-23T21:00:00.000Z", "2026-06-25T21:00:00.000Z", "2026-06-25T21:00:00.000Z"].map(Date.parse),
      );
      expect(series[0]).not.toHaveProperty("indicatorId");
      // limit keeps the MOST-recent N dates (oldest→newest within that window).
      expect((await store.getSeries("F1", 2)).map((p) => p.date)).toEqual(["2026-06-24", "2026-06-25"]);
    });

    test("getSeries returns `limit` distinct dates even when the NEWEST date has many revisions (P5: no over-fetch truncation)", async () => {
      // The old SupabaseStore fetched min(limit*5, 10000) rows ordered obs_date DESC,
      // run_at DESC, then deduped in JS. The revisions must land on the NEWEST date to
      // reproduce the bug: ordered obs_date DESC, that date's rows come first, so with
      // limit=2 (cap = 10) the 12 revisions of 2026-06-24 fill the window before
      // 2026-06-23 is ever reached — the old code returns a one-element series. (Put
      // them on the older date and the old code passes, proving nothing.) The SQL view
      // is one row per date, so the revision count is irrelevant; both stores must
      // return the full `limit` distinct dates.
      for (let i = 0; i < 12; i++) {
        const runAt = `2026-06-24T${String(i).padStart(2, "0")}:00:00.000Z`;
        await store.recordReadings([reading({ date: "2026-06-24", value: i })], runAt);
      }
      await store.recordReadings([reading({ date: "2026-06-23", value: 100 })], "2026-06-23T21:00:00.000Z");

      // limit=2 wants both dates; the 12 revisions of the newest date must not starve it.
      const series = await store.getSeries("F1", 2);
      expect(series.map((p) => [p.date, p.value])).toEqual([
        ["2026-06-23", 100],
        ["2026-06-24", 11], // latest revision wins
      ]);
    });

    test("getSeries range-anchors [from,to] BEFORE the limit - an old window survives the newest-N cap (E3 review regression)", async () => {
      // Seed MORE dates (15) than the fetch cap we pass (limit=3), so we sit in the
      // failing regime: total stored rows exceed the limit. The OLD implementation had
      // no range param — it ordered obs_date DESC, took the newest 3, and left range
      // filtering to the caller, so a window in the OLD 12 rows filtered down to []. The
      // new code pushes gte/lte into the query, so the old window is reachable.
      for (let d = 10; d <= 24; d++) {
        const date = `2026-06-${String(d).padStart(2, "0")}`;
        await store.recordReadings([reading({ date, value: d })], `${date}T21:00:00.000Z`);
      }
      // An OLD range (11..13), well below the newest 3 rows (22,23,24): the newest-N cap
      // would starve it. Range-anchored, it returns exactly those three dates.
      const old = await store.getSeries("F1", 3, { from: "2026-06-11", to: "2026-06-13" });
      expect(old.map((p) => [p.date, p.value])).toEqual([
        ["2026-06-11", 11],
        ["2026-06-12", 12],
        ["2026-06-13", 13],
      ]);
      // Either bound alone works; `to` alone still honors the newest-N cap WITHIN the window.
      expect((await store.getSeries("F1", 2, { to: "2026-06-13" })).map((p) => p.date)).toEqual([
        "2026-06-12",
        "2026-06-13",
      ]);
      expect((await store.getSeries("F1", 5, { from: "2026-06-22" })).map((p) => p.date)).toEqual([
        "2026-06-22",
        "2026-06-23",
        "2026-06-24",
      ]);
      // No range ⇒ byte-compatible with the old signature (newest-N, oldest→newest).
      expect((await store.getSeries("F1", 3)).map((p) => p.date)).toEqual([
        "2026-06-22",
        "2026-06-23",
        "2026-06-24",
      ]);
    });

    test("getSeriesBulk == getSeries per id, in input order, every id present (Supabase↔InMemory parity)", async () => {
      // Empty ids ⇒ empty map (no query). One round trip for many ids otherwise.
      expect([...(await store.getSeriesBulk([], { limit: 10 })).keys()]).toEqual([]);

      // Two ids on an ALIGNED daily calendar (so the SupabaseStore's global newest-N*K
      // heuristic returns exactly the per-id newest-N, matching the fake's exact path),
      // plus a requested-but-unseeded id that must come back present-and-empty.
      for (let d = 20; d <= 26; d++) {
        const date = `2026-06-${d}`;
        await store.recordReadings([reading({ indicatorId: "F1", date, value: d })], `${date}T21:00:00.000Z`);
        await store.recordReadings([reading({ indicatorId: "F2", date, value: d + 100 })], `${date}T21:00:00.000Z`);
      }

      const bulk = await store.getSeriesBulk(["F2", "F1", "MISSING"], { limit: 3 });
      // Map preserves the INPUT id order (F2 before F1) and includes the empty MISSING id.
      expect([...bulk.keys()]).toEqual(["F2", "F1", "MISSING"]);
      expect(bulk.get("MISSING")).toEqual([]);
      // Each bucket byte-equals the single-series read (latest `limit` dates, oldest→newest).
      expect(bulk.get("F1")).toEqual(await store.getSeries("F1", 3));
      expect(bulk.get("F2")).toEqual(await store.getSeries("F2", 3));
      // Vacuity: the read actually returns rows, capped to the newest 3 dates.
      expect(bulk.get("F1")!.map((p) => p.date)).toEqual(["2026-06-24", "2026-06-25", "2026-06-26"]);

      // The optional range flows through to each series identically to getSeries(range).
      const ranged = await store.getSeriesBulk(["F1", "F2"], { limit: 5, range: { from: "2026-06-21", to: "2026-06-23" } });
      expect(ranged.get("F1")).toEqual(await store.getSeries("F1", 5, { from: "2026-06-21", to: "2026-06-23" }));
      expect(ranged.get("F1")!.map((p) => p.date)).toEqual(["2026-06-21", "2026-06-22", "2026-06-23"]);
    });

    test("getSeriesBulk limit:1 serves the newest latest-vintage row per id (readings_newest fast path == getSeries)", async () => {
      // limit:1 takes the readings_newest RPC in the SupabaseStore (the /lab freshness-stamp
      // timeout fix) — pin it to getSeries parity where the paths could disagree: the newest
      // obs_date REVISED under a later run_at must serve the revision (obs_date desc, run_at
      // desc), and an unseeded id must stay present-and-empty (absence, never a fabricated row).
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-25", value: 1 })], "2026-06-25T21:00:00.000Z");
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-26", value: 2 })], "2026-06-26T21:00:00.000Z");
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-26", value: 3 })], "2026-06-27T09:00:00.000Z");

      const bulk = await store.getSeriesBulk(["F1", "MISSING"], { limit: 1 });
      expect([...bulk.keys()]).toEqual(["F1", "MISSING"]);
      expect(bulk.get("F1")).toEqual(await store.getSeries("F1", 1));
      expect(bulk.get("F1")!.map((p) => [p.date, p.value])).toEqual([["2026-06-26", 3]]);
      expect(bulk.get("MISSING")).toEqual([]);
    });

    test("getSeriesBulk (limit>1) collapses ≥2 runs on one obs_date to the max-run_at vintage (readings_newest_n == getSeries)", async () => {
      // The exact collapse a naive `order by obs_date desc limit n` breaks by returning the same
      // date twice: two runs revise 2026-06-26, and the general-path RPC must serve ONLY the later
      // run_at (the readings_latest vintage rule), never the same obs_date twice.
      //
      // `limit: 2` is load-bearing, not incidental. The RPC must return `limit` DISTINCT dates so
      // the bucket reaches `limit` and the shortfall repair does NOT fire — otherwise a broken RPC's
      // short/duplicate bucket is silently re-fetched through getSeries (readings_latest, which
      // collapses correctly) and the falsifier is masked. With three stored dates and limit 2, a
      // correct RPC returns the newest two DISTINCT dates {25→v2, 26→v99}; a broken
      // `order by obs_date desc limit 2` returns the two newest ROWS — both 2026-06-26 — starving
      // 2026-06-25 out, which this asserts against.
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-24", value: 1 })], "2026-06-24T21:00:00.000Z");
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-25", value: 2 })], "2026-06-25T21:00:00.000Z");
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-26", value: 3 })], "2026-06-26T21:00:00.000Z");
      await store.recordReadings([reading({ indicatorId: "F1", date: "2026-06-26", value: 99 })], "2026-06-27T09:00:00.000Z");

      const bulk = await store.getSeriesBulk(["F1"], { limit: 2 });
      // Parity with the single-series read (readings_latest), and the concrete shape: the newest
      // two DISTINCT dates, 2026-06-26 carrying the LATER run's value (99) exactly once (never 3).
      expect(bulk.get("F1")).toEqual(await store.getSeries("F1", 2));
      expect(bulk.get("F1")!.map((p) => [p.date, p.value])).toEqual([
        ["2026-06-25", 2],
        ["2026-06-26", 99],
      ]);
    });

    test("getSeriesBulk (limit>1) range-anchors [from] and [from,to] per id, matching getSeries(range)", async () => {
      for (let d = 20; d <= 26; d++) {
        const date = `2026-06-${d}`;
        await store.recordReadings([reading({ indicatorId: "F1", date, value: d })], `${date}T21:00:00.000Z`);
        await store.recordReadings([reading({ indicatorId: "F2", date, value: d + 100 })], `${date}T21:00:00.000Z`);
      }

      // `limit` sized STRICTLY BELOW each window's in-window date count: a correct RPC returns a
      // FULL `limit`-bucket so the shortfall repair does NOT fire and mask the RPC behind getSeries.

      // {from} only: everything on/after 2026-06-23 (23,24,25,26 in window), newest 3 of those.
      const fromOnly = await store.getSeriesBulk(["F1", "F2"], { limit: 3, range: { from: "2026-06-23" } });
      expect(fromOnly.get("F1")).toEqual(await store.getSeries("F1", 3, { from: "2026-06-23" }));
      expect(fromOnly.get("F2")).toEqual(await store.getSeries("F2", 3, { from: "2026-06-23" }));
      expect(fromOnly.get("F1")!.map((p) => p.date)).toEqual(["2026-06-24", "2026-06-25", "2026-06-26"]);

      // {from,to}: a bounded old window (21,22,23) survives the newest-N cap, newest 2 of those.
      const fromTo = await store.getSeriesBulk(["F1", "F2"], { limit: 2, range: { from: "2026-06-21", to: "2026-06-23" } });
      expect(fromTo.get("F1")).toEqual(await store.getSeries("F1", 2, { from: "2026-06-21", to: "2026-06-23" }));
      expect(fromTo.get("F2")).toEqual(await store.getSeries("F2", 2, { from: "2026-06-21", to: "2026-06-23" }));
      expect(fromTo.get("F1")!.map((p) => p.date)).toEqual(["2026-06-22", "2026-06-23"]);
    });

    test("getSeriesBulk repairs a sparse-cadence member starved by the global newest-K*N window (== getSeries per id)", async () => {
      // Reproduces the fail-toward-calm dial bug: the SupabaseStore fetches the newest
      // ids.length*limit rows GLOBALLY (obs_date DESC) then buckets per id. Two DENSE daily
      // members deep enough (140 days) that the newest 3*90=270 global rows are consumed by
      // their recent dates BEFORE reaching a sparse member's older rows — so the sparse member
      // (monthly cadence, 90 rows every 30d ⇒ its newest 90 obs_dates span ~2670 days) is
      // starved to ~5 bucketed rows unless the shortfall re-fetch fires. The InMemory fake
      // takes the exact per-id path already, so this pins BOTH stores to getSeries parity.
      const anchor = "2026-06-30";
      const dense = Array.from({ length: 140 }, (_, i) => reading({ indicatorId: "F1", date: isoDay(anchor, -i), value: i }));
      const dense2 = Array.from({ length: 140 }, (_, i) => reading({ indicatorId: "F2", date: isoDay(anchor, -i), value: 1000 + i }));
      const sparse = Array.from({ length: 90 }, (_, i) => reading({ indicatorId: "SPARSE", date: isoDay(anchor, -i * 30), value: 500 + i }));
      await store.recordReadings(dense, `${anchor}T21:00:00.000Z`);
      await store.recordReadings(dense2, `${anchor}T21:00:00.000Z`);
      await store.recordReadings(sparse, `${anchor}T21:00:00.000Z`);

      const bulk = await store.getSeriesBulk(["F1", "SPARSE", "F2"], { limit: 90 });
      // The sparse member is NOT starved: its bucket equals the exact per-id read (all 90 rows),
      // not the ~5 that survive the dense-window cut.
      expect(bulk.get("SPARSE")).toEqual(await store.getSeries("SPARSE", 90));
      expect(bulk.get("SPARSE")).toHaveLength(90);
      // The dense members are unaffected — still the newest 90 dates, equal to the per-id read.
      expect(bulk.get("F1")).toEqual(await store.getSeries("F1", 90));
      expect(bulk.get("F2")).toEqual(await store.getSeries("F2", 90));
      expect(bulk.get("F1")).toHaveLength(90);
    });

    test("getSeriesBulk returns a genuinely-short series whole, re-fetching once without looping", async () => {
      // A member with fewer rows than `limit` in the store: the shortfall re-fetch returns the
      // same short series once (still < limit) — proving the shortfall path terminates and does
      // not loop trying to reach `limit` rows that don't exist.
      await store.recordReadings(
        [
          reading({ indicatorId: "SHORT", date: "2026-06-20", value: 1 }),
          reading({ indicatorId: "SHORT", date: "2026-06-21", value: 2 }),
          reading({ indicatorId: "SHORT", date: "2026-06-22", value: 3 }),
        ],
        "2026-06-22T21:00:00.000Z",
      );
      const bulk = await store.getSeriesBulk(["SHORT"], { limit: 90 });
      expect(bulk.get("SHORT")).toEqual(await store.getSeries("SHORT", 90));
      expect(bulk.get("SHORT")).toHaveLength(3);
    });

    // Each case runs as a full sweep AND through the frontier branch (`since` makes the shadower fresh), which prod always takes.
    test.each([undefined, "2026-06-25T10:30:00.000Z"])("pruneShadowedReadings keeps only the served vintage, for the given ids only (since=%s)", async (since) => {
      await store.recordReadings([reading({ value: 1.0 }), reading({ indicatorId: "F2", value: 9.9 })], "2026-06-25T10:00:00.000Z");
      await store.recordReadings([reading({ value: 2.0 }), reading({ indicatorId: "F2", value: 8.8 })], "2026-06-25T11:00:00.000Z"); // shadows both

      expect(await store.pruneShadowedReadings(["F1"], null, true, since)).toBe(1);
      expect((await store.getSeries("F1", 10)).map((p) => p.value)).toEqual([2.0]); // latest vintage survives
      // ids not named are untouched — F2's shadowed vintage is still there
      expect((await store.getReadingsForRun("2026-06-25T10:00:00.000Z")).map((r) => r.indicatorId)).toEqual(["F2"]);
      expect(await store.pruneShadowedReadings(["F1"], null, true, since)).toBe(0); // already single-vintage
      expect(await store.pruneShadowedReadings([], null, true, since)).toBe(0); // empty = no-op
    });

    test.each([undefined, "2026-06-25T21:00:00.000Z"])("E7: pruneShadowedReadings keeps the final, deleting the NEWER estimate it shadows (since=%s)", async (since) => {
      await store.recordReadings([reading({ value: 1 })], "2026-06-25T21:00:00.000Z");
      await store.recordReadings([reading({ value: 50, estimated: true })], "2026-06-25T23:00:00.000Z");
      expect(await store.pruneShadowedReadings(["F1"], null, true, since)).toBe(1);
      expect(await store.getReadingsForRun("2026-06-25T23:00:00.000Z")).toEqual([]);
      expect((await store.getSeries("F1", 5)).map((p) => p.value)).toEqual([1]);
    });

    test("D5: null ids = GC scope - prunes an id the caller never named", async () => {
      // THE point of D5. Write-scoping could never delete these rows: the cron passes only the
      // ids it wrote this run, so an id that stops being written is excluded from every future
      // prune forever. `null` makes eligibility a pure function of age.
      const [old, latest] = [daysAgo(120), daysAgo(1)];
      await store.recordReadings([reading({ indicatorId: "ORPHAN", value: 1.0 })], old!);
      await store.recordReadings([reading({ indicatorId: "ORPHAN", value: 2.0 })], latest!); // shadows it

      // Named-ids scope with a DIFFERENT id: the shadowed ORPHAN row is untouched (the old bug).
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS)).toBe(0);
      expect(await store.getSeries("ORPHAN", 10)).toHaveLength(1); // readings_latest already collapses
      expect(await store.getReadingsForRun(old!)).toHaveLength(1); // …but the dead vintage is still there

      // GC scope, same floor: now it goes.
      expect(await store.pruneShadowedReadings(null, CRON_PRUNE_RETAIN_DAYS)).toBe(1);
      expect(await store.getReadingsForRun(old!)).toHaveLength(0);
      expect(await store.getReadingsForRun(latest!)).toHaveLength(1); // inside the floor — spared
    });

    test("D5: null ids + null floor RAISES - an unfloored blanket prune is unrepresentable", async () => {
      await store.recordReadings([reading({ value: 1.0 })], "2026-06-25T10:00:00.000Z");
      await store.recordReadings([reading({ value: 2.0 })], "2026-06-25T11:00:00.000Z");

      await expect(store.pruneShadowedReadings(null)).rejects.toThrow(/retention floor/);
      await expect(store.pruneShadowedReadings(null, null)).rejects.toThrow(/retention floor/);
      // Nothing was deleted by the rejected call.
      expect(await store.getReadingsForRun("2026-06-25T10:00:00.000Z")).toHaveLength(1);
    });

    test("FINDING 1: the retention floor spares recent provenance and still collapses the long tail", async () => {
      // The cron re-writes the SAME obs_date on consecutive runs (weekends, monthly series), so
      // every one of those rows is a distinct run's observation, not a redundant re-insert. Ages
      // are relative to real `now` because the floor is a wall-clock window.
      const [old, prev, latest] = [daysAgo(120), daysAgo(2), daysAgo(1)];
      await store.recordReadings([reading({ value: 1.0 })], old!); // long tail — eligible
      await store.recordReadings([reading({ value: 2.0 })], prev!); // yesterday's run — MUST survive
      await store.recordReadings([reading({ value: 3.0 })], latest!); // today's run — the served vintage

      // Unfloored (the pre-fix cron behavior, still the backfill's) would delete BOTH shadowed rows.
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS)).toBe(1);
      expect(await store.getReadingsForRun(old!)).toHaveLength(0); // past the floor — collapsed
      // The audit trail the floor exists to protect: a PAST run still resolves to its own row.
      expect(await store.getReadingsForRun(prev!)).toHaveLength(1);
      expect(await store.getReadingsForRun(latest!)).toHaveLength(1);

      // No floor ⇒ unchanged semantics for the backfill caller.
      expect(await store.pruneShadowedReadings(["F1"])).toBe(1);
      expect((await store.getSeries("F1", 10)).map((p) => p.value)).toEqual([3.0]);
    });

    test("FINDING 1+2: the alert-run pin spares a CRON vintage the backfill's temporal floor would delete", async () => {
      // The floor cannot see WHO wrote a shadowed row, and 3 days is no margin (the routine
      // Fri→Mon cron gap is already 72h). A cron run 10 days old is past the backfill floor and
      // survives only because its run_at is an alert_log.fired_at (migration 20260723120000).
      const [cronRun, backfillRun] = [daysAgo(10), daysAgo(0)];
      await store.recordReadings([reading({ value: 1.0 })], cronRun!);
      await store.recordAlert(alert({ firedAt: cronRun! })); // every cron run writes a fired_at
      await store.recordReadings([reading({ value: 2.0 })], backfillRun!); // a pass shadows it

      // Backfill semantics (pin defaults ON): eligible by age, ineligible by pin.
      expect(await store.pruneShadowedReadings(["F1"], BACKFILL_PRUNE_RETAIN_DAYS)).toBe(0);
      expect(await store.getReadingsForRun(cronRun!)).toHaveLength(1); // /lab's BAND members survive

      // The cron's own long-tail GC is the one caller that opts out — still collapses it.
      expect(await store.pruneShadowedReadings(["F1"], BACKFILL_PRUNE_RETAIN_DAYS, false)).toBe(1);
      expect(await store.getReadingsForRun(cronRun!)).toHaveLength(0);
    });

    // Frontier (`since`, migration 20261020120000): only rows that became deletable since `since` are visited —
    // (1) a shadower written at/after it, or (2) run_at in [since − R, now − R). R = CRON_PRUNE_RETAIN_DAYS here.
    test("frontier (1) newly shadowed: a shadower written at/after `since` makes an old row deletable", async () => {
      const [old, fresh] = [daysAgo(40), daysAgo(1)]; // `old` sits outside branch (2)'s floor window
      await store.recordReadings([reading({ value: 1.0 })], old);
      await store.recordReadings([reading({ value: 2.0 })], fresh); // shadows it
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS, true, daysAgo(2))).toBe(1);
      expect(await store.getReadingsForRun(old)).toHaveLength(0);
      expect(await store.getReadingsForRun(fresh)).toHaveLength(1);
    });

    test("frontier (2) newly past floor: a row crossing now − R inside [since − R, now − R) is deletable", async () => {
      // Both vintages predate `since`, so branch (1) cannot reach the pair — only the floor crossing can.
      const [shadowed, shadower] = [daysAgo(CRON_PRUNE_RETAIN_DAYS + 1.5), daysAgo(CRON_PRUNE_RETAIN_DAYS + 1)];
      await store.recordReadings([reading({ value: 1.0 })], shadowed);
      await store.recordReadings([reading({ value: 2.0 })], shadower);
      expect(await store.pruneShadowedReadings(null, CRON_PRUNE_RETAIN_DAYS, false, daysAgo(3))).toBe(1);
      expect(await store.getReadingsForRun(shadowed)).toHaveLength(0);
      expect(await store.getReadingsForRun(shadower)).toHaveLength(1);
    });

    test("frontier: the alert-run pin still spares a candidate row", async () => {
      const [cronRun, fresh] = [daysAgo(40), daysAgo(1)];
      await store.recordReadings([reading({ value: 1.0 })], cronRun);
      await store.recordAlert(alert({ firedAt: cronRun }));
      await store.recordReadings([reading({ value: 2.0 })], fresh); // branch (1) candidate
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS, true, daysAgo(2))).toBe(0);
      expect(await store.getReadingsForRun(cronRun)).toHaveLength(1);
    });

    test("frontier: a deletable row outside both windows survives `since`, and the full sweep (null) takes it", async () => {
      // Shadowed and past the floor, but its shadower predates `since` and it crossed the floor before it.
      const [shadowed, shadower] = [daysAgo(40), daysAgo(35)];
      await store.recordReadings([reading({ value: 1.0 })], shadowed);
      await store.recordReadings([reading({ value: 2.0 })], shadower);
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS, true, daysAgo(2))).toBe(0);
      expect(await store.getReadingsForRun(shadowed)).toHaveLength(1);
      expect(await store.pruneShadowedReadings(["F1"], CRON_PRUNE_RETAIN_DAYS, true, null)).toBe(1);
      expect(await store.getReadingsForRun(shadowed)).toHaveLength(0);
    });

    test("recordCalibration appends; getCalibration returns the LATEST vintage per (channel, metric)", async () => {
      expect(await store.getCalibration()).toEqual([]);

      // Two channels, one with a full row and one with every nullable field null —
      // exercises the null-coercion in rowToCalibration / the fake's pass-through.
      await store.recordCalibration([
        calib({ channel: "credit", metric: "evt_level_red", value: 1.0, computedAt: "2026-06-24T21:00:00.000Z" }),
        calib({
          channel: "rate",
          metric: "depth_thresh",
          value: 2.0,
          ciLow: null,
          ciHigh: null,
          method: "quantile",
          nEvents: null,
          windowStart: null,
          windowEnd: null,
          notes: null,
          computedAt: "2026-06-24T21:00:00.000Z",
        }),
      ]);
      // A later run re-publishes credit/evt_level_red (a new vintage) — must NOT
      // overwrite; the latest computed_at wins, the older row stays in the table.
      await store.recordCalibration([
        calib({ channel: "credit", metric: "evt_level_red", value: 1.5, computedAt: "2026-06-25T21:00:00.000Z" }),
      ]);

      const latest = await store.getCalibration();
      const byKey = new Map(latest.map((p) => [`${p.channel}/${p.metric}`, p]));
      expect(latest).toHaveLength(2); // one row per (channel, metric)

      // credit: the newer vintage (value 1.5) wins.
      expect(byKey.get("credit/evt_level_red")).toMatchObject({ value: 1.5, method: "evt_gpd", nEvents: 6 });
      expect(byKey.get("credit/evt_level_red")?.computedAt).toContain("2026-06-25");

      // rate: nullable fields survive the round-trip as null (not NaN / "null").
      expect(byKey.get("rate/depth_thresh")).toMatchObject({
        value: 2.0,
        ciLow: null,
        ciHigh: null,
        nEvents: null,
        windowStart: null,
        windowEnd: null,
        notes: null,
      });
    });

    test("getCalibration keys the vintage per (market, mode, channel, metric) - cell rows don't collapse with legacy null/null rows", async () => {
      await store.recordCalibration([
        // Legacy shared row + one per-cell row for the SAME (channel, metric):
        // distinct cells, so BOTH must survive the latest-vintage collapse.
        calib({ metric: "vix_evt_level_red", value: 47.0, computedAt: "2026-07-01T00:00:00.000Z" }),
        calib({
          market: "ndx",
          mode: "crash",
          metric: "vix_evt_level_red",
          value: 39.5,
          computedAt: "2026-07-01T00:00:00.000Z",
        }),
      ]);
      // A later vintage re-publishes ONLY the (ndx, crash) cell — must supersede
      // that cell alone, leaving the legacy row's vintage untouched.
      await store.recordCalibration([
        calib({
          market: "ndx",
          mode: "crash",
          metric: "vix_evt_level_red",
          value: 41.2,
          computedAt: "2026-07-02T00:00:00.000Z",
        }),
      ]);

      const latest = await store.getCalibration();
      expect(latest).toHaveLength(2);
      const byCell = new Map(latest.map((p) => [`${p.market}/${p.mode}`, p]));
      expect(byCell.get("null/null")).toMatchObject({ value: 47.0, market: null, mode: null });
      expect(byCell.get("ndx/crash")).toMatchObject({ value: 41.2, market: "ndx", mode: "crash" });
      expect(byCell.get("ndx/crash")?.computedAt).toContain("2026-07-02");
    });

    test("recordCalibration is a no-op for an empty batch", async () => {
      await store.recordCalibration([]);
      expect(await store.getCalibration()).toEqual([]);
    });

    test("getAlertsSince returns the {date, r4Phase} slice of rows with obs_date >= since, oldest→newest", async () => {
      expect(await store.getAlertsSince("2026-01-01")).toEqual([]);

      await store.recordAlert(alert({ date: "2026-06-01", firedAt: "2026-06-01T21:00:00.000Z", r4Phase: "cash" }));
      await store.recordAlert(alert({ date: "2026-06-20", firedAt: "2026-06-20T21:00:00.000Z", r4Phase: null }));
      await store.recordAlert(alert({ date: "2026-06-25", firedAt: "2026-06-25T21:00:00.000Z", r4Phase: "equity" }));

      // The boundary row (obs_date === since) is INCLUDED; the older row is filtered out.
      expect(await store.getAlertsSince("2026-06-20")).toEqual([
        { date: "2026-06-20", r4Phase: null },
        { date: "2026-06-25", r4Phase: "equity" },
      ]);
      // A wide-open window returns every row, oldest→newest, r4Phase round-tripped.
      expect(await store.getAlertsSince("2026-01-01")).toEqual([
        { date: "2026-06-01", r4Phase: "cash" },
        { date: "2026-06-20", r4Phase: null },
        { date: "2026-06-25", r4Phase: "equity" },
      ]);
    });

    test("getCashPriors(n) is the {date, dialTargetRung} slice of getRecentAlerts(n) (Supabase↔InMemory parity)", async () => {
      expect(await store.getCashPriors(10)).toEqual([]);

      await store.recordAlert(alert({ date: "2026-06-01", firedAt: "2026-06-01T21:00:00.000Z", dialTargetRung: 8 }));
      await store.recordAlert(alert({ date: "2026-06-20", firedAt: "2026-06-20T21:00:00.000Z", dialTargetRung: null }));
      // Same fired-date, recorded LATER-run-FIRST: the collapse must keep the max-fired_at row
      // identically to getRecentAlerts, so the slice matches even under out-of-order inserts.
      await store.recordAlert(alert({ date: "2026-06-25", firedAt: "2026-06-25T21:00:00.000Z", dialTargetRung: 3 }));
      await store.recordAlert(alert({ date: "2026-06-25", firedAt: "2026-06-25T09:00:00.000Z", dialTargetRung: 7 }));

      const slice = (await store.getRecentAlerts(10)).map((a) => ({ date: a.date, dialTargetRung: a.dialTargetRung }));
      expect(await store.getCashPriors(10)).toEqual(slice);
      // Concrete pin (newest-first, one row per fired-date, latest run wins ⇒ rung 3 not 7).
      expect(await store.getCashPriors(2)).toEqual([
        { date: "2026-06-25", dialTargetRung: 3 },
        { date: "2026-06-20", dialTargetRung: null },
      ]);
    });
  });
}

// --- Pure-logic fake: always runs (DB-free + fast) ----------------------------
storeContract("InMemoryStore", async () => new InMemoryStore());

storeContract(
  "SupabaseStore (integration - local Supabase)",
  async () => {
    await truncate();
    return supa!;
  },
  describe.runIf(hasDb),
);

// The persistence projection carries the scorer's cut onto the stored row (Stage 2.1) — the
// pure step feeding `recordRun`, so the round-trip above rests on this. Store-independent.
describe("toStoredReadings - carries the scorer's band_cuts onto the stored row", () => {
  const scored = (id: string, bandCuts: Reading["bandCuts"]): Reading => ({
    indicator: { id } as unknown as Indicator,
    date: "2026-08-20",
    level: 4.2,
    delta20: 0.3,
    rawState: "AMBER",
    state: "GREEN",
    decision: null,
    bandCuts,
  });

  test("a resolved cut projects verbatim; an absent one projects null", () => {
    const [withCut, noCut] = toStoredReadings([scored("F3", cuts), scored("F1", undefined)]);
    expect(withCut!.bandCuts).toEqual(cuts);
    expect(noCut!.bandCuts).toBeNull();
  });
});

// --- getOverrides date filtering -----------------------------------------------
//
// NOT in storeContract: there is no app-side write path for overrides (recording =
// manual insert, D9 Fork 2), so each impl seeds its own way — the InMemory fake via
// its public `overrides` array, Supabase via a raw admin insert (the manual-insert
// affordance itself).

describe("InMemoryStore.getOverrides", () => {
  test("filters obs_date >= since (boundary included), oldest→newest, null note preserved", async () => {
    const store = new InMemoryStore();
    expect(await store.getOverrides("2026-01-01")).toEqual([]);

    store.overrides.push(
      { obsDate: "2026-06-25", note: "panic sold" },
      { obsDate: "2026-06-01", note: null },
      { obsDate: "2025-06-01", note: "last year - must be filtered" },
    );

    expect(await store.getOverrides("2026-06-01")).toEqual([
      { obsDate: "2026-06-01", note: null },
      { obsDate: "2026-06-25", note: "panic sold" },
    ]);
    expect(await store.getOverrides("2026-06-02")).toEqual([{ obsDate: "2026-06-25", note: "panic sold" }]);
  });
});

describe.runIf(hasDb)("readings_newest{,_n} RPCs carry band_cuts (read-path column parity)", () => {
  beforeEach(truncate);

  // getSeriesBulk does NOT read `readings_latest`: limit:1 goes through the `readings_newest`
  // RPC and limit>1 through `readings_newest_n`, each PINNING its projection in a
  // `returns table (...)` signature. So a column added to the table + the view still misses
  // those two paths (20260902073000 is the migration that closed it for band_cuts).
  //
  // The parity is asserted DIRECTLY against the RPCs, not through getSeriesBulk — routing
  // through the store would pass against a column-less RPC (rowToSeriesPoint's `?? null`
  // masks a missing column) and pin nothing.

  beforeEach(async () => {
    // recordRun (not recordReadings) so the row travels the atomic prod write path that
    // actually populates band_cuts. F1 carries a cut, R1 persists null (an unscored id).
    await supa!.recordRun(
      [reading({ indicatorId: "F1", date: "2026-08-20", bandCuts: cuts }), reading({ indicatorId: "R1", date: "2026-08-20", bandCuts: null })],
      "2026-08-20T21:00:00.000Z",
      alert({ level: "OK", date: "2026-08-20", firedAt: "2026-08-20T21:00:00.000Z" }),
    );
  });

  test("readings_newest returns band_cuts verbatim (cut object for a scored id, null for an unscored one)", async () => {
    const { data, error } = await admin!.rpc("readings_newest", { p_ids: ["F1", "R1"] });
    expect(error).toBeNull();
    const rows = (data as Array<Record<string, unknown>>).sort((a, b) => String(a.indicator_id).localeCompare(String(b.indicator_id)));
    expect(rows.map((r) => r.indicator_id)).toEqual(["F1", "R1"]);
    // `toEqual(cuts)` — not just "defined": a projection that dropped the column reads back
    // undefined here, and one that served the wrong row's cut fails on the value.
    expect(rows[0]!.band_cuts).toEqual(cuts);
    expect(rows[1]!.band_cuts).toBeNull();
  });

  test("readings_newest_n returns band_cuts verbatim through the general (limit>1) path", async () => {
    const { data, error } = await admin!.rpc("readings_newest_n", { p_ids: ["F1", "R1"], p_limit: 5, p_from: null, p_to: null });
    expect(error).toBeNull();
    const rows = (data as Array<Record<string, unknown>>).sort((a, b) => String(a.indicator_id).localeCompare(String(b.indicator_id)));
    expect(rows.map((r) => r.indicator_id)).toEqual(["F1", "R1"]);
    expect(rows[0]!.band_cuts).toEqual(cuts);
    expect(rows[1]!.band_cuts).toBeNull();
  });
});

describe.runIf(hasDb)("SupabaseStore.getOverrides (integration - local Supabase)", () => {
  beforeEach(truncate);

  test("filters obs_date >= since (boundary included), oldest→newest, null note preserved", async () => {
    expect(await supa!.getOverrides("2026-01-01")).toEqual([]);

    // Seed via a raw admin insert — the real (manual) write path for overrides.
    const { error } = await admin!.from("overrides").insert([
      { obs_date: "2026-06-25", note: "panic sold" },
      { obs_date: "2026-06-01", note: null },
      { obs_date: "2025-06-01", note: "last year - must be filtered" },
    ]);
    expect(error).toBeNull();

    expect(await supa!.getOverrides("2026-06-01")).toEqual([
      { obsDate: "2026-06-01", note: null },
      { obsDate: "2026-06-25", note: "panic sold" },
    ]);
    expect(await supa!.getOverrides("2026-06-02")).toEqual([{ obsDate: "2026-06-25", note: "panic sold" }]);
  });
});

// --- record_run atomicity (Supabase-only) -------------------------------------
//
// The whole point of P4: a partial failure must roll back BOTH inserts, leaving no
// orphaned readings. Forced by an invalid p_alert (fin is not an integer) so the
// readings insert succeeds but the alert insert throws INSIDE the same transaction
// → the function rolls back. There's no way to provoke this through the typed
// recordRun (every AlertRecord field is well-typed), so call the RPC raw via the
// admin client. InMemoryStore has no transaction to test, so this is Supabase-only.
describe.runIf(hasDb)("record_intraday_run atomicity (rollback)", () => {
  beforeEach(truncate);
  test("a failing slot upsert (null row) rolls back the run's readings, and the slot stays empty", async () => {
    const runAt = "2026-06-26T12:00:00.000Z";
    const goodReading = { obs_date: "2026-06-26", indicator_id: "F1", value: 4.2, delta20: 0.3, raw_state: "AMBER", state: "GREEN", run_at: runAt };
    const { error } = await admin!.rpc("record_intraday_run", { p_readings: [goodReading], p_run_at: runAt, p_slot: null });
    expect(error).not.toBeNull();
    expect([await supa!.getReadingsForRun(runAt), await supa!.getIntradayVerdict()]).toEqual([[], null]);
  });
});

describe.runIf(hasDb)("record_run atomicity (rollback)", () => {
  beforeEach(truncate);
  const runAt = "2026-06-25T21:00:00.000Z";
  // A pre-`estimated` build's payload: no `estimated` key (20261003130000's trigger coerces the NULL).
  const goodReading = { obs_date: "2026-06-25", indicator_id: "F1", value: 4.2, delta20: 0.3, raw_state: "AMBER", state: "GREEN", run_at: runAt };

  test("an old build's record_run payload without `estimated` still writes; the row reads back final", async () => {
    const goodAlert = alertRow(alert({ level: "OK", date: "2026-06-25", firedAt: runAt }));
    const { error } = await admin!.rpc("record_run", { p_readings: [goodReading], p_alert: goodAlert });
    expect(error).toBeNull();
    expect((await supa!.getReadingsForRun(runAt)).map((r) => [r.indicatorId, r.estimated])).toEqual([["F1", undefined]]);
  });

  test("a failing alert insert rolls back the run's readings (no orphans)", async () => {
    // fin must be an integer; "boom" fails `::integer` AFTER the readings insert,
    // so the transaction rolls back the readings already written this call.
    const badAlert = {
      obs_date: "2026-06-25",
      alert_level: "WATCH",
      fin: "boom",
      rate: 0,
      geo_flags: 0,
      coincident: "GREEN",
      fin_reds: 0,
      fired_at: runAt,
      pushed_at: null,
    };

    const { error } = await admin!.rpc("record_run", { p_readings: [goodReading], p_alert: badAlert });
    // 22P02 = invalid_text_representation (the `fin` cast to integer) — assert the
    // identity so the test proves it's the alert insert that failed, not something else.
    expect(error?.code).toBe("22P02");

    // Both inserts rolled back together: no orphaned readings, no alert.
    expect(await supa!.getReadingsForRun(runAt)).toEqual([]);
    expect(await supa!.getLastAlert()).toBeNull();
  });
});
