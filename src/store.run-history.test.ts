import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import type { Store } from "./store.js";
import { alert, hasDb, supa, truncate } from "./store.test-helpers.js";

// Run-history reads over the append-only write path (20260717010000 dropped record_run's same-day
// delete): N rows per UTC fired-date, collapsed ONCE at the read layer (max fired_at per UTC date
// wins). One body, both stores — the fake compares ISO strings / JS Dates, Postgres compares
// timestamptz (and renders `+00:00`), so the two must agree on every bucket and cutoff below.
function runHistoryContract(
  name: string,
  makeStore: () => Promise<Store>,
  register: (name: string, fn: () => void) => void = describe,
): void {
  register(name, () => {
    let store: Store;
    beforeEach(async () => {
      store = await makeStore();
    });

    // An intraday re-run, then the evening cron — one UTC date, distinct fired_at.
    const seedTwoRunsOneDate = async () => {
      await store.recordRun([], "2026-07-16T09:00:00.000Z", alert({ date: "2026-07-16", firedAt: "2026-07-16T09:00:00.000Z", level: "WATCH", dialBand: "WATCH", heldDays: 3, r4Phase: "cash" }));
      await store.recordRun([], "2026-07-16T21:00:00.000Z", alert({ date: "2026-07-16", firedAt: "2026-07-16T21:00:00.000Z", level: "CRITICAL", dialBand: "CRITICAL", heldDays: 4, r4Phase: "equity" }));
    };

    test("prev-state reads over a recordRun-seeded two-row date still resolve to the LATER run", async () => {
      await seedTwoRunsOneDate();

      // Guards against the fixture going vacuous: if the write path ever collapses the date
      // again, the reads below would pass trivially and hide it.
      expect(await store.getAlertAt("2026-07-16T09:00:00.000Z")).not.toBeNull();

      // STOP CONDITION (audit Stage 1.2): an EARLIER-run answer here (WATCH / heldDays 3) means
      // append-only breaks hold-counting on the live path — every prev-state read would resolve
      // to a stale intraday row. Report it; do NOT adjust these assertions to match.
      expect(
        await store.getLastBandBefore("dialBand", "2026-07-17"),
        "getLastBandBefore did not resolve to the LAST run of a recordRun-seeded UTC date - append-only is unsafe for hold-counting (audit Stage 1.2 STOP condition); report as a finding, do not adjust this assertion",
      ).toBe("CRITICAL");
      expect(
        await store.getLastAlertBefore("2026-07-17"),
        "getLastAlertBefore did not resolve to the LAST run of a recordRun-seeded UTC date - append-only is unsafe for hold-counting (audit Stage 1.2 STOP condition); report as a finding, do not adjust this assertion",
      ).toMatchObject({ level: "CRITICAL", heldDays: 4 });
    });

    // The plain one-date collapse (max fired_at wins) is owned by store.contract.test.ts's
    // "same-date collapse picks max fired_at even when rows are recorded out of order".
    test("`limit` counts DATES, not rows - a re-run must not starve the window", async () => {
      // The latest-N-then-filter trap: 3 dates, the newest carrying TWO runs = 4 rows. A
      // `slice(-limit)`-then-collapse would take 3 ROWS (2026-07-16 twice + 07-15) and return
      // only 2 DATES, silently dropping 2026-07-14 out of a window that asked for 3.
      await store.recordRun([], "2026-07-14T21:00:00.000Z", alert({ date: "2026-07-14", firedAt: "2026-07-14T21:00:00.000Z", level: "OK" }));
      await store.recordRun([], "2026-07-15T21:00:00.000Z", alert({ date: "2026-07-15", firedAt: "2026-07-15T21:00:00.000Z", level: "WATCH" }));
      await seedTwoRunsOneDate();

      expect((await store.getRecentAlerts(3)).map((r) => r.level)).toEqual(["CRITICAL", "WATCH", "OK"]);
    });

    test("rows sharing an obs_date but fired on DIFFERENT dates both survive (fired-date, never obs_date)", async () => {
      // The regime that discriminates the two keys: an intraday run before the 21:05 UTC same-day-bar
      // cutoff carries yesterday's obs_date, so an obs_date-keyed collapse would eat a legitimate close.
      await store.recordRun([], "2026-07-16T21:00:00.000Z", alert({ date: "2026-07-16", firedAt: "2026-07-16T21:00:00.000Z", level: "OK", r4Phase: "cash" }));
      await store.recordRun([], "2026-07-17T09:00:00.000Z", alert({ date: "2026-07-16", firedAt: "2026-07-17T09:00:00.000Z", level: "WATCH", r4Phase: "equity" }));

      expect((await store.getRecentAlerts(10)).map((r) => r.level)).toEqual(["WATCH", "OK"]);
      expect(await store.getAlertsSince("2026-01-01")).toEqual([
        { date: "2026-07-16", r4Phase: "cash" },
        { date: "2026-07-16", r4Phase: "equity" },
      ]);
    });

    describe("getLastAlertBefore / getLastBandBefore - scoring prev-state cutoff (strictly before UTC midnight)", () => {
      test("same-day row excluded, latest prior fired-day row returned (notify baseline still the absolute latest)", async () => {
        await store.recordAlert(alert({ firedAt: "2026-07-14T21:00:00.000Z", level: "OK" }));
        await store.recordAlert(alert({ firedAt: "2026-07-15T21:00:00.000Z", level: "WATCH" }));
        await store.recordAlert(alert({ firedAt: "2026-07-16T09:00:00.000Z", level: "WARNING" })); // intraday, today
        expect((await store.getLastAlertBefore("2026-07-16"))!.level).toBe("WATCH");
        expect((await store.getLastAlert())!.level).toBe("WARNING");
      });

      test("no prior-day row → null; a midnight-stamped row counts as same-day (strict cutoff)", async () => {
        await store.recordAlert(alert({ firedAt: "2026-07-16T00:00:00.000Z" }));
        expect(await store.getLastAlertBefore("2026-07-16")).toBeNull();
      });

      test("getLastBandBefore skips same-day AND degraded (null) rows to the last prior real band", async () => {
        await store.recordAlert(alert({ firedAt: "2026-07-14T21:00:00.000Z", dialBand: "WARNING" }));
        await store.recordAlert(alert({ firedAt: "2026-07-15T21:00:00.000Z", dialBand: null })); // degraded run
        await store.recordAlert(alert({ firedAt: "2026-07-16T09:00:00.000Z", dialBand: "CRITICAL" })); // today
        expect(await store.getLastBandBefore("dialBand", "2026-07-16")).toBe("WARNING");
        expect(await store.getLastBand("dialBand")).toBe("CRITICAL");
      });
    });
  });
}

runHistoryContract("InMemoryStore - run history", async () => new InMemoryStore());

// CI-only (truncating makeStore; DB_TESTS=1 against a disposable stack).
runHistoryContract(
  "SupabaseStore - run history (integration)",
  async () => {
    await truncate();
    return supa!;
  },
  describe.runIf(hasDb),
);
