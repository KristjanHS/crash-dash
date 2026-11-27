import { beforeEach, describe, expect, test } from "vitest";
import type { FredOutage } from "./fred.js";
import { NTFY_BODY_MAX } from "./ntfy-limits.js";
import { InMemoryStore } from "./store-memory.js";
import { CRON_PRUNE_FRONTIER_DAYS, CRON_PRUNE_RETAIN_DAYS, PRUNE_DEGRADE_SCOPE, type AlertRecord, type DegradeEvent, type SeriesPoint, type StoredReading } from "./store.js";
import { ALL_INDICATORS } from "./registry.js";
import { COMPOSITE_COMPONENTS } from "./registry-composite.js";
import { markProviderFallback } from "./provider-fallback-latch.js";
import { noFreeSource } from "./no-free-source.js";
import { BOTTOM_INDICATORS, BREADTH_STORE_IDS, DOWNSIDE_DETECTOR_IDS, PENSION_INDICATORS, PRICE_INDICATORS, PRICE_SCORERS, RS_LEG_IDS, SLOW_INDICATORS } from "./registry-price.js";
import { INPUT_SERIES } from "./input-series.js";
import { codeVintages, diffVintages } from "./scorer-vintage.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { PRUNE_MIN_HEADROOM_MS, bandMailDue, buildStoredRows, carryRegressedRows, printsBeneathEstimates } from "./run-cycle-persist.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { fredOutageMessage, pushBand, pushFredOutage } from "./run-cycle-push.js";
import { REASSERT_AFTER_DAYS } from "./ladder.js";
import { SB_BENCH_ID, SB_STRAT_ID, legCloseQuotes } from "./scoreboard.js";
import { drainDegradeLog, drainLateDegrades, peekDegradeLog, resetDegradeLog } from "./tracks.js";
import { SEED_TAIL_SCOPE } from "./run-seeds.js";
import { LATE_NOTIFY_SEEN_SCOPE } from "./notify_format.js";
import {
  f1RedBothLegs,
  fredMock,
  monotonicClock,
  atUtcMin,
  installRunTestHooks,
  f7Flat,
  priorAlert,
  FIXTURE_ASOF,
  deepHcxCloses,
  fakeFeeds,
  fakeNotify,
  runCycleWith,
  type FakeNotify,
  seedHyoasCalib,
} from "./run.test-helpers.js";
import { DIAL_FAMILIES } from "./dial-assembly.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "./intraday.js";
import { RUN_FETCH_BUDGET_MS, RUN_HARD_DEADLINE_MS, clearRunBudget, markRunAnchor, runTimings, startRunBudget } from "./fetch-budget.js";
import { runSeedTail } from "./run-cycle-seed-tail.js";
import type { Reading } from "./domain-types.js";
import type { FeedPorts } from "./feed-ports.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

/** The calm ports with F1 stepped to a confirmed RED (one close ⇒ CRITICAL), `over` winning. */
const criticalFeeds = (over: Parameters<typeof fakeFeeds>[0] = {}) =>
  fakeFeeds({ fetchSeries: async (series) => (series === "BAMLH0A0HYM2" ? f1RedBothLegs(7) : fredMock(series)), ...over });
const OUTAGE: FredOutage = { failed: ["A", "B", "C"], total: 3, summaries: ["html"] };

const shiftDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
/** The cron prune's frontier floor for a run at `runAt`: since (runAt − CRON_PRUNE_FRONTIER_DAYS) − CRON_PRUNE_RETAIN_DAYS.
 *  A run-at older than now − CRON_PRUNE_RETAIN_DAYS and at/after this floor is a GC candidate. */
const pruneFloorFrom = (runAt: string): string => shiftDays(runAt, -(CRON_PRUNE_FRONTIER_DAYS + CRON_PRUNE_RETAIN_DAYS));
/** A shadowed vintage pair on one (id, date = the loser's run day): the `loserRunAt` row loses to a FINAL one a day newer,
 *  so a prune that reaches the loser deletes it — a GC pass is read off the rows the store still HOLDS, never a call. */
const seedShadowedPair = async (own: InMemoryStore, id: string, loserRunAt: string): Promise<void> => {
  const date = loserRunAt.slice(0, 10);
  await own.recordReadings([makeStoredReading(id, { date, value: 1 })], loserRunAt);
  await own.recordReadings([makeStoredReading(id, { date, value: 2 })], shiftDays(loserRunAt, 1));
};
const rowsHeld = (own: InMemoryStore, id: string): number => own.readings.filter((r) => r.indicatorId === id).length;

describe("runScoringCycle - wiring (fetch → score → persist → push)", () => {
  describe("email fan-out", () => {
    test("delivered push ⇒ sendBandEmail gets the SAME message + every subscriber row, even when the seam THROWS; forceEmail re-mails without a push", async () => {
      const feeds = criticalFeeds();
      // Non-null carry: only then can "the provisional block never ran" be told apart from "reset to null".
      const carried = new Date(Date.now() - (REASSERT_AFTER_DAYS + 1) * 86_400_000).toISOString();
      await store.recordAlert(makeAlert({ level: "OK", provisionalPushedAt: carried }));
      store.subscribers.push("a@x.test", "b@x.test");
      // The fan-out is driven through a REJECTING seam: `sendBandEmail` never throws in prod (it
      // swallows), so this is the belt — a thrown seam leaves the alert row and push_error untouched.
      const notify = fakeNotify();
      notify.sendBandEmail.mockRejectedValue(new Error("brevo down"));
      const alert = await runCycleWith(feeds, store, undefined, { notify });
      // A one-close credit RED confirms same-day (instant-up): the BAND pushes once, the provisional path stays inert.
      expect(alert.level).toBe("CRITICAL");
      expect(notify.pushNtfy).toHaveBeenCalledOnce();
      expect(notify.pushNtfy.mock.calls[0]![0].title).toContain("CRITICAL");
      expect(alert.provisionalPushedAt).toBe(carried);
      expect(alert.pushedAt).toBe(alert.firedAt);
      expect(alert.pushError).toBeNull();
      const row = await store.getLastAlert();
      expect(row?.provisionalPushedAt).toBe(carried);
      expect(row?.pushError).toBeNull();
      expect(row?.pushedAt).toEqual(alert.pushedAt);
      expect(notify.sendBandEmail).toHaveBeenCalledOnce();
      const [msg, recipients] = notify.sendBandEmail.mock.calls[0]!;
      expect(msg).toBe(notify.pushNtfy.mock.calls[0]![0]);
      expect(recipients).toEqual(["a@x.test", "b@x.test"]);

      // forceEmail (Stage 5 verify switch): a same-band re-run with the flag mails the current band, pushes nothing.
      notify.sendBandEmail.mockClear();
      notify.pushNtfy.mockClear();
      const forced = await runCycleWith(feeds, store, undefined, { forceEmail: true, notify });
      expect(forced.pushedAt).toBeNull();
      expect(notify.pushNtfy).not.toHaveBeenCalled();
      expect(notify.sendBandEmail).toHaveBeenCalledOnce();
      const [forcedMsg, forcedTo] = notify.sendBandEmail.mock.calls[0]!;
      expect(forcedMsg.title).toBeTruthy();
      expect(forcedTo).toEqual(["a@x.test", "b@x.test"]);
    });

    test("a same-close cron re-run pushes once and re-derives the same state", async () => {
      const feeds = criticalFeeds();
      const notify = fakeNotify();
      const first = await runCycleWith(feeds, store, () => atUtcMin(FIXTURE_ASOF, 22 * 60), { notify });
      const second = await runCycleWith(feeds, store, () => atUtcMin(FIXTURE_ASOF, 23 * 60), { notify });
      const pick = (a: AlertRecord) => [a.date, a.level, a.dialBand, a.heldSleeve, a.heldDays, a.reriskConfirmCount, a.r4Phase, a.bandReason];
      expect([first.level, first.pushedAt, second.pushedAt]).toEqual(["CRITICAL", first.firedAt, null]);
      expect(notify.pushNtfy).toHaveBeenCalledOnce();
      expect(pick(second)).toEqual(pick(first));
    });

    test("a SUPPRESSED band push (blank NTFY_TOPIC) persists pushed_at null and mails nobody", async () => {
      const notify = fakeNotify({ ntfyPushEnabled: () => false });
      store.subscribers.push("a@x.test");
      const alert = await runCycleWith(criticalFeeds(), store, undefined, { notify });
      expect([alert.level, (await store.getLastAlert())?.pushedAt]).toEqual(["CRITICAL", null]);
      expect(notify.sendBandEmail).not.toHaveBeenCalled();
    });

    test("an INTRADAY cycle with forceEmail (the weekend `?email=force` cron) mails nobody and writes no alert_log row", async () => {
      const notify = fakeNotify();
      store.subscribers.push("a@x.test");
      await runCycleWith(criticalFeeds(), store, undefined, { intraday: true, forceEmail: true, notify });
      expect([store.alerts.length, store.intradayVerdict?.level]).toEqual([0, "CRITICAL"]); // the slot proves the cycle ran
      expect(notify.sendBandEmail).not.toHaveBeenCalled();
    });

    test("a FRED-wide outage sends its own notice and persists the outcome on `degraded`", async () => {
      const feeds = criticalFeeds({ fredOutage: () => ({ failed: ["BAMLH0A0HYM2", "DGS10", "DGS2"], total: 3, summaries: ["html"] }) });
      const notify = fakeNotify();
      const alert = await runCycleWith(feeds, store, undefined, { notify });
      const titles = notify.pushNtfy.mock.calls.map((c) => c[0]?.title);
      expect(titles).toContain("FRED outage - 3/3 series failed");
      expect(titles.some((t) => t?.includes("CRITICAL"))).toBe(true); // the band push still goes out
      expect((await store.getLastAlert())?.degraded ?? []).toContainEqual({ scope: "[fred] outage - 3/3 series failed", reason: "ntfy outage notice sent", effect: "trace" });
      expect(alert.pushedAt).toBe(alert.firedAt);
    });

    test("a THROWING outage notice never costs the run: row persists, failure on `degraded`, band push untouched", async () => {
      const notify = fakeNotify({
        pushNtfy: async (m) => {
          if (m.title.startsWith("FRED outage")) throw new Error("ntfy 503");
        },
      });
      const alert = await runCycleWith(criticalFeeds({ fredOutage: () => OUTAGE }), store, undefined, { notify });
      expect((await store.getLastAlert())?.degraded).toContainEqual({ scope: "[fred] outage - 3/3 series failed", reason: "ntfy outage notice failed: ntfy 503", effect: "trace" });
      expect(alert.pushedAt).toBe(alert.firedAt);
      expect(alert.pushError).toBeNull();
    });
  });

  test("the outage notice body stays inside NTFY_BODY_MAX however large the HTML-derived causes are", () => {
    const summaries = Array.from({ length: 10 }, (_, i) => `unexpected header "<!doctype html>${"x".repeat(5000)}${i}"`);
    const body = fredOutageMessage({ failed: ["A", "B", "C"], total: 3, summaries }).body;
    expect(body).toContain("Re-run the prod scoring cron once FRED is back");
    expect(body.length).toBeLessThanOrEqual(NTFY_BODY_MAX);
  });

  test("an intraday run never sends the FRED outage notice", async () => {
    // The port WOULD report an outage: only the intraday guard keeps the notice unsent.
    const notify = fakeNotify();
    expect(await pushFredOutage({ opts: { intraday: true }, feeds: fakeFeeds({ fredOutage: () => OUTAGE }), notify, env: {} } as unknown as RunBase)).toBeNull();
    expect(notify.pushNtfy).not.toHaveBeenCalled();
  });
});

describe("pushBand - the band push records its OUTCOME on the row", () => {
  const FIRED = "2026-01-30T22:00:00.000Z";
  const CARRIED = "2026-01-01T00:00:00.000Z";
  const message = { title: "CRITICAL", body: "b" };
  const prov = { title: "PROVISIONAL", body: "p" };
  let notify: FakeNotify;
  beforeEach(() => {
    notify = fakeNotify();
  });
  const run = async (intraday: boolean, provisional = false) => {
    const alert = makeAlert({ firedAt: FIRED, pushedAt: FIRED, pushError: null, provisionalPushedAt: FIRED });
    const last = makeAlert({ provisionalPushedAt: CARRIED });
    await pushBand({ opts: { intraday }, env: {}, notify } as unknown as RunBase, alert, last, { push: true, message }, { push: provisional, message: provisional ? prov : null, candidate: null });
    return alert;
  };

  test("delivered: pushed_at stays the firedAt stamp, no error", async () => {
    const a = await run(false);
    expect(notify.pushNtfy.mock.calls.map((c) => c[0].title)).toEqual(["CRITICAL"]);
    expect([a.pushedAt, a.pushError]).toEqual([FIRED, null]);
  });

  test("throwing: pushed_at cleared, push_error latched", async () => {
    notify.pushNtfy.mockRejectedValue(new Error("ntfy 503"));
    const a = await run(false);
    expect([a.pushedAt, a.pushError]).toEqual([null, "ntfy 503"]);
  });

  test("a throwing provisional alone restores the carried stamp and never latches push_error", async () => {
    notify.pushNtfy.mockImplementation(async (m) => {
      if (m.title === "PROVISIONAL") throw new Error("ntfy 503");
    });
    const a = await run(false, true);
    expect([a.pushedAt, a.pushError, a.provisionalPushedAt]).toEqual([FIRED, null, CARRIED]);
  });

  test("suppressed off-prod (blank NTFY_TOPIC): both stamps cleared/restored, no error latched", async () => {
    notify.ntfyPushEnabled.mockReturnValue(false);
    const a = await run(false, true);
    expect(notify.pushNtfy).toHaveBeenCalledTimes(2); // returns normally; nothing left the process
    expect([a.pushedAt, a.pushError, a.provisionalPushedAt]).toEqual([null, null, CARRIED]);
  });

  test("intraday: nothing sent, pushed_at cleared", async () => {
    const a = await run(true, true);
    expect(notify.pushNtfy).not.toHaveBeenCalled();
    expect([a.pushedAt, a.provisionalPushedAt]).toEqual([null, FIRED]);
  });

  test("bandMailDue: a delivered push mails, a cleared pushed_at mails nobody, force bypasses the gate", () => {
    expect([bandMailDue(true, FIRED, false), bandMailDue(true, null, false), bandMailDue(false, null, true), bandMailDue(false, FIRED, false)]).toEqual([true, false, true, false]);
  });
});

describe("cron prune placement", () => {
  /** A store whose cron prune THROWS (the failure is an input) and notes, per call, what the run had done by then. */
  class PruneThrowStore extends InMemoryStore {
    readonly atPrune: { alertRows: number; pushesSent: number }[] = [];
    constructor(readonly notify: FakeNotify) {
      super();
      seedHyoasCalib(this);
    }
    override pruneShadowedReadings(): Promise<number> {
      this.atPrune.push({ alertRows: this.alerts.length, pushesSent: this.notify.pushNtfy.mock.calls.length });
      return Promise.reject(new Error("statement timeout"));
    }
  }

  test("EOD: after the push is sent (so never in it), before recordRun; a throw persists on the row's degraded; intraday never prunes", async () => {
    const own = new PruneThrowStore(fakeNotify());
    const feeds = criticalFeeds();
    await runCycleWith(feeds, own, undefined, { notify: own.notify });
    // At the prune: the band push already sent (1), the alert row not yet written (0 ⇒ recordRun still ahead).
    expect(own.atPrune).toEqual([{ alertRows: 0, pushesSent: 1 }]);
    expect((await own.getLastAlert())?.degraded).toContainEqual({ scope: PRUNE_DEGRADE_SCOPE, reason: "statement timeout", effect: "trace" });

    await runCycleWith(feeds, own, undefined, { intraday: true, notify: own.notify });
    expect(own.atPrune).toHaveLength(1);
  });

  test("EOD with < PRUNE_MIN_HEADROOM_MS to the hard deadline: the prune is SKIPPED (recordRun keeps its headroom) and the skip persists", async () => {
    // A pair the run's prune WOULD delete (the GC_SCOPE shape the monotonicity test below proves a real prune GCs).
    const runAt = `${FIXTURE_ASOF}T22:00:00.000Z`;
    await seedShadowedPair(store, "GC_PROBE", shiftDays(pruneFloorFrom(runAt), 2));
    await runCycleWith(fakeFeeds(), store, monotonicClock(runAt), { msUntilHardDeadline: () => PRUNE_MIN_HEADROOM_MS - 1 });
    expect(rowsHeld(store, "GC_PROBE")).toBe(2); // the shadowed loser survives: no prune ran
    expect((await store.getLastAlert())?.degraded).toContainEqual({ scope: PRUNE_DEGRADE_SCOPE, reason: "skipped - too close to the run hard deadline", effect: "trace" });
  });
});

// obs_date monotonicity guard (run-cycle persist seam): a run whose feed is a session behind an
// earlier run must not commit an OLDER observation as this run's reading — carry the stored row forward.
describe("obs_date monotonicity guard (run-cycle persist seam)", () => {

  test("a run committing an older obs_date does not regress the stored row", async () => {
    // Plain `fredMock` for DFII10: this test asserts EBP monotonicity only (never ECY), and the DB-first
    // R4 seam (2026-08-31) now persists the DFII10 full-history it fetches. `dfii10Ramp` dates ride the
    // WALL CLOCK (`ecyMonthDate`), so they'd land NEWER than the core loop's Jan-2026 R4 row and trip a
    // spurious, calendar-dependent R4 carry. `fredMock` gives both arms the same Jan-2026 window ⇒ equal
    // obs_date ⇒ no R4 carry, isolating the EBP assertion below.
    const feeds = fakeFeeds(); // EBP feed ends 2026-01-30
    await store.recordReadings(f7Flat(), "2020-01-01T00:00:00.000Z");
    // The cron prune's scoping, read off what survives it. Ids are off the registry, so the run never writes them: only the
    // GC scope (`null` ids) reaches them. Every loser but GC_RETAIN's is older than now − CRON_PRUNE_RETAIN_DAYS.
    const RUN_AT = "2026-02-16T00:00:00.000Z";
    const floor = pruneFloorFrom(RUN_AT);
    expect(CRON_PRUNE_RETAIN_DAYS).toBeGreaterThan(4); // premise: GC_SCOPE/GC_PINNED's pairs fit inside the floor window
    await seedShadowedPair(store, "GC_SCOPE", shiftDays(floor, 1)); // a candidate ⇒ GC'd
    const pinnedAt = shiftDays(floor, 3);
    await seedShadowedPair(store, "GC_PINNED", pinnedAt); // loser = an alert run ⇒ GC'd only unpinned
    await store.recordAlert(priorAlert({ date: pinnedAt.slice(0, 10), firedAt: pinnedAt }));
    // Inside the retain floor (the DB-server clock), and a fresh key (≥ since) ⇒ a candidate the floor keeps.
    await seedShadowedPair(store, "GC_RETAIN", shiftDays(new Date().toISOString(), -2));
    await seedShadowedPair(store, "GC_FRONTIER", shiftDays(floor, -3)); // before the frontier floor, stale key ⇒ never a candidate
    // Seed a NEWER, FINAL EBP obs_date (run_at AT its cutoff) than the run will fold, sentinel value.
    await store.recordReadings(
      [makeStoredReading("EBP", { date: "2026-02-15", value: -0.5 })],
      atUtcMin("2026-02-15", INTRADAY_CUTOFF_UTC_MIN),
    );

    const alert = await runCycleWith(feeds, store, monotonicClock(RUN_AT));

    const rows = await store.getReadingsForRun(alert.firedAt);
    const ebpRow = rows.find((r) => r.indicatorId === "EBP");
    // Carried forward: this run's committed EBP row is the stored 2026-02-15 sentinel, not the folded 2026-01-30.
    expect(ebpRow?.date).toBe("2026-02-15");
    expect(ebpRow?.value).toBe(-0.5);
    // The monotonicity degrade reaches the persisted alert, and EBP is the ONLY carried id.
    const monoEvents = (alert.degraded ?? []).filter((d) => d.scope.startsWith("[monotonicity]"));
    expect(monoEvents.map((d) => d.scope.split(" ")[1])).toEqual(["EBP"]);

    // Info-B4/D5/A1b: the prune is GC-scoped, floored, unpinned and frontier-bounded; a throw degrades (placement: the describe above); one clean vintage row per id.
    // D5: GC scope, NOT write scope. Passing this run's ids is what let an id that stops being
    // written be excluded from every future prune forever (migration 20260719120000).
    // FINDING 1: the cron MUST floor the prune. Unfloored, the next run's prune deletes this run's
    // rows for every indicator whose obs_date has not advanced (weekends, monthly series) — the
    // per-run provenance getReadingsForRun/trace-fired.ts read is then gone, irreversibly.
    // Frontier: `since` = this run's runAt (= firedAt) minus the overlap window — so a
    // shadowed loser older than its floor (GC_FRONTIER) is not a candidate. Rows held: 1 = loser GC'd, 2 = kept.
    expect(["GC_SCOPE", "GC_PINNED", "GC_RETAIN", "GC_FRONTIER"].map((id) => [id, rowsHeld(store, id)])).toEqual([
      ["GC_SCOPE", 1],
      ["GC_PINNED", 1],
      ["GC_RETAIN", 2],
      ["GC_FRONTIER", 2],
    ]);
    expect(await store.getLastAlert({ withPanel: true, withRunInputs: true })).toEqual(alert);
    expect((await store.getReadingsForRun(alert.firedAt)).length).toBeGreaterThan(0);
    const vintages = await store.getScorerVintages();
    expect(vintages.map((r) => r.indicator_id).sort()).toEqual(ALL_INDICATORS.map((i) => i.id).sort());
    expect(diffVintages(codeVintages(new Date()), vintages)).toEqual({ drift: [], stampOnly: [] });
  });

  test("an `estimated` newest does not disarm the guard: the run guards against the newest PRINT beneath it (E3)", async () => {
    await store.recordReadings([makeStoredReading("EBP", { date: "2026-02-13", value: -0.5, bandCuts: { amber: 2 } })], atUtcMin("2026-02-13", INTRADAY_CUTOFF_UTC_MIN));
    await store.recordReadings([{ ...makeStoredReading("EBP", { date: "2026-02-15", value: 9 }), estimated: true }], atUtcMin("2026-02-15", INTRADAY_CUTOFF_UTC_MIN));
    const newest = await store.getSeriesBulk(["EBP"], { limit: 1 });
    await printsBeneathEstimates(store, newest);
    const { rows, events } = carryRegressedRows([makeStoredReading("EBP", { date: "2026-01-30" })], newest);
    expect(rows.map((r) => [r.date, r.value, r.bandCuts])).toEqual([["2026-02-13", -0.5, { amber: 2 }]]);
    expect(events).toEqual([{ scope: "[monotonicity] EBP obs_date regressed - carried stored row forward", reason: "run 2026-01-30 < stored 2026-02-13" }]);
  });

  test("a PROVISIONAL stored newest is not carried: the run's older reading passes through, no event", () => {
    const d = "2026-02-02";
    const provisional: SeriesPoint = { date: d, value: -0.5, delta20: 0, rawState: "GREEN", state: "GREEN", runAt: atUtcMin(d, INTRADAY_CUTOFF_UTC_MIN - 1) };
    const row = makeStoredReading("EBP", { date: FIXTURE_ASOF });
    expect(carryRegressedRows([row], new Map([["EBP", [provisional]]]))).toEqual({ rows: [row], events: [] });
  });

  /** The guard's newest-stored read: `getSeriesBulk(ids, { limit: 1 })` over the persisted ids (EBP among them). */
  const isGuardRead = (ids: string[], opts: { limit: number; range?: unknown }): boolean => opts.limit === 1 && opts.range === undefined && ids.includes("EBP");
  const SKIP_SCOPE = "[monotonicity] guard skipped this run - newest-stored read failed";
  const ebpOf = async (alert: AlertRecord) => (await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "EBP");

  test("a failed newest-stored bulk read skips the guard: the run's older EBP row persists uncarried, one trace degrade", async () => {
    class BulkThrowStore extends InMemoryStore {
      override getSeriesBulk(ids: string[], opts: { limit: number; range?: { from?: string; to?: string } }): Promise<Map<string, SeriesPoint[]>> {
        return isGuardRead(ids, opts) ? Promise.reject(new Error("bulk read timeout")) : super.getSeriesBulk(ids, opts);
      }
    }
    store = new BulkThrowStore();
    seedHyoasCalib(store);
    await store.recordReadings(f7Flat(), "2020-01-01T00:00:00.000Z");
    await store.recordReadings([makeStoredReading("EBP", { date: "2026-02-15", value: -0.5 })], atUtcMin("2026-02-15", INTRADAY_CUTOFF_UTC_MIN));
    const alert = await runCycleWith(fakeFeeds(), store, monotonicClock("2026-02-16T00:00:00.000Z"));
    expect((await ebpOf(alert))?.date).toBe("2026-01-30");
    expect((alert.degraded ?? []).filter((d) => d.scope.startsWith("[monotonicity]"))).toEqual([{ scope: SKIP_SCOPE, reason: "bulk read timeout", effect: "trace" }]);
  });

  test("a failed print-beneath-estimate read keeps the bulk-read newest: EBP carries the stored ESTIMATE, plus the skip degrade", async () => {
    class PrintThrowStore extends InMemoryStore {
      armed = false;
      override async getSeriesBulk(ids: string[], opts: { limit: number; range?: { from?: string; to?: string } }): Promise<Map<string, SeriesPoint[]>> {
        const out = await super.getSeriesBulk(ids, opts); // the fake reads per id via getSeries: arm only once it resolves
        if (isGuardRead(ids, opts)) this.armed = true;
        return out;
      }
      override getSeries(id: string, limit: number, range?: { from?: string; to?: string }): Promise<SeriesPoint[]> {
        if (!this.armed || id !== "EBP") return super.getSeries(id, limit, range);
        this.armed = false;
        return Promise.reject(new Error("print read timeout"));
      }
    }
    store = new PrintThrowStore();
    seedHyoasCalib(store);
    await store.recordReadings(f7Flat(), "2020-01-01T00:00:00.000Z");
    await store.recordReadings([makeStoredReading("EBP", { date: "2026-02-13", value: -0.5 })], atUtcMin("2026-02-13", INTRADAY_CUTOFF_UTC_MIN));
    await store.recordReadings([{ ...makeStoredReading("EBP", { date: "2026-02-15", value: 9 }), estimated: true }], atUtcMin("2026-02-15", INTRADAY_CUTOFF_UTC_MIN));
    const alert = await runCycleWith(fakeFeeds(), store, monotonicClock("2026-02-16T00:00:00.000Z"));
    expect((alert.degraded ?? []).filter((d) => d.scope.startsWith("[monotonicity]"))).toEqual([
      { scope: SKIP_SCOPE, reason: "print read timeout", effect: "trace" },
      { scope: "[monotonicity] EBP obs_date regressed - carried stored row forward", reason: "run 2026-01-30 < stored 2026-02-15", effect: "trace" },
    ]);
    expect([(await ebpOf(alert))?.date, (await ebpOf(alert))?.value]).toEqual(["2026-02-15", 9]);
  });

  test("an intraday run carries a FINAL past-date head of a finalRewriteHeld id over its own value; keyless-only + estimated heads stay writable; EOD rewrites", async () => {
    const SAT = "2026-01-31"; // feeds end FIXTURE_ASOF (Fri): every row this run writes is past-dated
    const EOD_AT = `${FIXTURE_ASOF}T22:55:00.000Z`;
    const held = ["HCX", ...(COMPOSITE_COMPONENTS["HCX"] ?? []).map((c) => c.id)];
    const legs = held.slice(1);
    expect(legs.length).toBeGreaterThan(0);
    // Off-default fields: the carried row must be the stored row whole, never a value-only rebuild.
    const eodRow = (id: string) => makeStoredReading(id, { date: FIXTURE_ASOF, value: -0.5, delta20: 0.25, rawState: "RED", state: "AMBER", decision: 1.5, bandCuts: { amber: 2, red: 3 } });
    await store.recordReadings([...held, "INS_RS"].map(eodRow), EOD_AT);
    await store.recordReadings([{ ...makeStoredReading("CMP_GB_SPY", { date: FIXTURE_ASOF, value: -9 }), estimated: true }], EOD_AT);
    // persistRun's own write (at runAt; the db-first seam stamps runAt − 1 ms and holds FINAL priors on its own).
    const persisted = (id: string, runAt: string) => store.readings.some((r) => r.indicatorId === id && r.date === FIXTURE_ASOF && r.runAt === runAt);
    const [INTRA_AT, EOD2_AT] = [`${SAT}T12:00:00.000Z`, `${SAT}T22:55:00.000Z`];

    // deepHcxCloses: the calm closes degrade the HCX parent out, which would leave its half of the hold unexercised.
    // Its FIXTURE_ASOF closes are `estimated`, marking every held (id, D) estimate-sourced: the carried FINAL row stays unstamped.
    const [deep, hcxSyms] = [deepHcxCloses(), new Set((COMPOSITE_COMPONENTS["HCX"] ?? []).map((c) => c.symbol))];
    const estHead: typeof deep = async (...a) => (await deep(...a)).map((o) => (hcxSyms.has(a[0]) && o.date === FIXTURE_ASOF ? { ...o, estimated: true } : o));
    const intra = await runCycleWith(fakeFeeds({ fetchDailyCloses: estHead }), store, monotonicClock(INTRA_AT), { intraday: true });
    const intraHcx = store.readings.filter((r) => /^(HCX|CMP_HCX_)/.test(r.indicatorId) && r.date < SAT && r.runAt !== EOD_AT);
    expect(intraHcx.map((r) => r.runAt)).toEqual(held.map(() => INTRA_AT));
    expect(intraHcx.map(({ runAt: _runAt, ...r }) => r).sort((a, b) => a.indicatorId.localeCompare(b.indicatorId))).toEqual(held.map(eodRow).sort((a, b) => a.indicatorId.localeCompare(b.indicatorId)));
    expect((intra.degraded ?? []).filter((d) => d.scope.startsWith("[final-hold]")).map((d) => d.scope.split(" ")[1]).sort()).toEqual([...held].sort());
    expect(persisted("INS_RS", INTRA_AT)).toBe(true); // EXH5.DE/EXSA.DE are keyless-only: never held
    expect(persisted("CMP_GB_SPY", INTRA_AT)).toBe(true);

    const calm = fakeFeeds(); // EOD with a GOOGL provider hop: finalRewriteHeld(GOOGL), yet EOD rewrites
    const hop = fakeFeeds({ fetchDailyCloses: (...a) => (a[0] === "GOOGL" && markProviderFallback("GOOGL"), calm.fetchDailyCloses(...a)) });
    await runCycleWith(hop, store, monotonicClock(EOD2_AT));
    expect(legs.filter((id) => !persisted(id, EOD2_AT))).toEqual([]);
  });

  test("an intraday run's board keeps every id the prior EOD run wrote; a held past-date id serves the EOD value", async () => {
    const [EOD_AT, INTRA_AT] = [`${FIXTURE_ASOF}T22:55:00.000Z`, "2026-01-31T12:00:00.000Z"];
    const eod = await store.getReadingsForRun((await runCycleWith(fakeFeeds(), store, monotonicClock(EOD_AT))).firedAt);
    const intra = await runCycleWith(fakeFeeds(), store, monotonicClock(INTRA_AT), { intraday: true });
    const served = new Map((await store.getReadingsForRun(intra.firedAt)).map((r) => [r.indicatorId, r]));
    expect(eod.length).toBeGreaterThan(0);
    const intradayOmits = new Set([SB_STRAT_ID, SB_BENCH_ID]); // the scoreboard chain is EOD-only by design (`buildStoredRows`)
    expect(eod.map((r) => r.indicatorId).filter((id) => !served.has(id) && !intradayOmits.has(id))).toEqual([]);
    const pastDated = eod.filter((r) => served.get(r.indicatorId)?.date === r.date);
    expect(pastDated.length).toBeGreaterThan(0);
    expect(pastDated.filter((r) => served.get(r.indicatorId)?.value !== r.value).map((r) => r.indicatorId)).toEqual([]);
  });
});

// the trailing `estimated` SB rows re-link FINAL off the newest FINAL row, and the next row chains off the re-linked level.
describe("buildStoredRows - SB_STRAT/SB_BENCH trailing re-link write-back", () => {
  const [PRE, D, D2, NEXT] = ["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"];
  const held = { heldSleeve: "Value", r4Phase: "equity" as const }; // XDEV.DE, EUR-quoted
  const heldBeforeD2 = { heldSleeve: "S&P IT", r4Phase: "equity" as const }; // QDVE.DE — a switch, so the second day must chain off D's level
  // Stored: PRE FINAL at 100, then `estimated` rows on `estDays` at 999; the feed's `estimatedOn` obs is `estimated`.
  /** `getLastAlertBefore(failsOn)` rejects — the failure is an input (no store spy). */
  class AlertReadFailStore extends InMemoryStore {
    constructor(private readonly failsOn?: string) {
      super();
    }
    override async getLastAlertBefore(d: string): Promise<AlertRecord | null> {
      if (d === this.failsOn) throw new Error("alert read failed");
      return super.getLastAlertBefore(d);
    }
  }
  const sbFor = async (estDays: string[], estimatedOn?: string, alertThrowsOn?: string) => {
    const runDate = estDays.includes(D2) ? NEXT : D2;
    const at = (vals: number[]) => [PRE, D, D2, NEXT].map((date, i) => ({ date, value: vals[i]!, ...(date === estimatedOn ? { estimated: true as const } : {}) }));
    const feed: Record<string, ReturnType<typeof at>> = { "EURUSD=X": at([1, 1, 1, 1]), ACWI: at([100, 110, 121, 133.1]), "XDEV.DE": at([50, 60, 66, 72.6]), "QDVE.DE": at([10, 10, 15, 15]) };
    const feeds = fakeFeeds({ fetchDailyCloses: async (symbol) => (feed[symbol] ?? []).filter((o) => o.date <= runDate) });
    const own = new AlertReadFailStore(alertThrowsOn);
    // The prior runs each walked date reads its sleeve off: D's prev-state holds Value, the second day's (D's own run) S&P IT.
    await own.recordAlert(makeAlert({ date: PRE, firedAt: `${PRE}T22:00:00.000Z`, ...held }));
    await own.recordAlert(makeAlert({ date: D, firedAt: `${D}T22:00:00.000Z`, ...heldBeforeD2 }));
    await own.recordReadings(
      [SB_STRAT_ID, SB_BENCH_ID].flatMap((id) => [makeStoredReading(id, { date: PRE, value: 100 }), ...estDays.map((date) => makeStoredReading(id, { date, value: 999, estimated: true }))]),
      `${PRE}T22:00:00.000Z`,
    );
    const ctx = { opts: {}, store: own, feeds, runAt: `${runDate}T22:00:00.000Z` } as unknown as RunBase;
    const { sbStoredReadings } = await buildStoredRows(ctx, makeAlert({ date: runDate }), makeAlert(held), [], { downside: [], rs: [] });
    return { row: (id: string, date: string) => sbStoredReadings.find((r) => r.indicatorId === id && r.date === date) };
  };

  test("official D inputs: D re-written FINAL off PRE, D+1 compounds off the re-linked level", async () => {
    const { row } = await sbFor([D]);
    expect(row(SB_STRAT_ID, D)?.value).toBeCloseTo(120); // 100 × 60/50
    expect(row(SB_BENCH_ID, D)?.value).toBeCloseTo(110); // 100 × 110/100
    expect([row(SB_STRAT_ID, D)?.estimated, row(SB_BENCH_ID, D)?.estimated]).toEqual([undefined, undefined]);
    expect(row(SB_STRAT_ID, D2)?.value).toBeCloseTo(132); // 120 × 66/60, not 999 × 1.1
    expect(row(SB_BENCH_ID, D2)?.value).toBeCloseTo(121);
  });

  test("two consecutive estimated days: both re-linked FINAL oldest→newest, each on its own date's alert read", async () => {
    const { row } = await sbFor([D, D2]);
    // 100 × 60/50; × 15/10 (the second day's own sleeve, off D's level — a second-day step on D's read would give 132); × 72.6/66 (prevDay's sleeve)
    expect([D, D2, NEXT].map((d) => row(SB_STRAT_ID, d)?.value.toFixed(6))).toEqual(["120.000000", "180.000000", "198.000000"]);
    expect([D, D2, NEXT].map((d) => row(SB_BENCH_ID, d)?.value.toFixed(6))).toEqual(["110.000000", "121.000000", "133.100000"]);
    expect([D, D2].map((d) => row(SB_STRAT_ID, d)?.estimated)).toEqual([undefined, undefined]);
  });

  test("D input still estimate-sourced: no FINAL D row, and D+1 chained off the stored estimate is never written (`estimateAnchored`)", async () => {
    const { row } = await sbFor([D], D);
    expect([row(SB_STRAT_ID, D), row(SB_BENCH_ID, D)]).toEqual([undefined, undefined]);
    expect([row(SB_STRAT_ID, D2), row(SB_BENCH_ID, D2)]).toEqual([undefined, undefined]);
  });

  // A throw degrades and stops only SB_STRAT; a still-estimate-sourced second-day obs (shared FX) stops both walks silently.
  test.each([
    { stop: "throws", estimatedOn: undefined, throwsOn: D2, degraded: [`[SB] ${SB_STRAT_ID} re-link stopped - estimate rows stay estimated`], nextFinal: [false, true] },
    { stop: "is still estimate-sourced", estimatedOn: D2, throwsOn: undefined, degraded: [], nextFinal: [false, false] },
  ])("walk stops mid-way at D2 ($stop): NEXT chained off the stored D2 estimate is never written; a completed walk's NEXT is FINAL", async ({ estimatedOn, throwsOn, degraded, nextFinal }) => {
    resetDegradeLog();
    const { row } = await sbFor([D, D2], estimatedOn, throwsOn);
    expect(peekDegradeLog().map((e) => e.scope)).toEqual(degraded);
    expect([row(SB_STRAT_ID, D)?.value.toFixed(6), row(SB_STRAT_ID, D)?.estimated, row(SB_STRAT_ID, D2)]).toEqual(["120.000000", undefined, undefined]);
    const final = (id: string) => { const r = row(id, NEXT); return r !== undefined && r.estimated !== true; };
    expect([final(SB_STRAT_ID), final(SB_BENCH_ID), row(SB_STRAT_ID, NEXT)]).toEqual([...nextFinal, undefined]);
  });
});

describe("superseding verdict on an official write-back (the EOD cron's re-derive)", () => {
  const D = FIXTURE_ASOF;
  const DM1 = "2026-01-29";
  const ORIG = `${DM1}T22:55:00.000Z`;
  const known = new Set(ALL_INDICATORS.map((i) => i.id));
  const roster = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].filter((id) => known.has(id));
  // D−1's run read every dial member as an estimated RED close; the calm feeds' gap-fill lands the official D−1 closes.
  const seedEstimatedRun = () =>
    store.recordRun(roster.map((id) => makeStoredReading(id, { date: DM1, state: "RED", rawState: "RED", estimated: true })), ORIG,
      priorAlert({ date: DM1, firedAt: ORIG, level: "CRITICAL", dialBand: "CRITICAL" }));
  const superseding = () => store.alerts.filter((a) => a.rederivedFrom != null && Date.parse(a.rederivedFrom) === Date.parse(ORIG));

  test("EOD: D−1's row is superseded (never pushed) before the run's prev-state read", async () => {
    await seedEstimatedRun();
    const alert = await runCycleWith(fakeFeeds(), store, monotonicClock(`${D}T22:55:00.000Z`));
    const [row] = superseding();
    expect(superseding()).toHaveLength(1);
    expect(row!.pushedAt).toBeNull();
    expect(row!.dialBand).not.toBe("CRITICAL");
    expect(Date.parse(alert.runInputs!.refs.prevDay!)).toBe(Date.parse(row!.firedAt)); // scoring prev-state = the superseding row
    expect(Date.parse(alert.runInputs!.refs.last!)).toBe(Date.parse(ORIG)); // notify baseline = the original
  });

  test("an intraday run writes the same D−1 official closes but never re-derives", async () => {
    await seedEstimatedRun();
    await runCycleWith(fakeFeeds(), store, monotonicClock(atUtcMin(D, INTRADAY_CUTOFF_UTC_MIN - 5)), { intraday: true });
    const finalDm1 = store.readings.filter((r) => r.date === DM1 && r.estimated !== true && roster.includes(r.indicatorId));
    expect(finalDm1.length).toBeGreaterThan(0); // premise: gap-fill DID land official D−1 closes
    expect(superseding()).toEqual([]);
  });
});

describe("EOD post-tail trace write (updateRunTrace)", () => {
  /** Captures what the post-tail write sends — the in-memory row is the run's own object, so a read-back can't tell a skipped write. */
  class TraceStore extends InMemoryStore {
    readonly traces: Parameters<InMemoryStore["updateRunTrace"]>[] = [];
    /** What the commit-point write carried, copied (the row object is mutated post-tail). */
    atRecord: { degraded: DegradeEvent[]; marks: string[] } | null = null;
    constructor() {
      super();
      seedHyoasCalib(this);
    }
    override recordRun(readings: StoredReading[], runAt: string, alert: AlertRecord): Promise<void> {
      this.atRecord = { degraded: [...(alert.degraded ?? [])], marks: Object.keys(alert.timings?.marks ?? {}) };
      return super.recordRun(readings, runAt, alert);
    }
    override updateRunTrace(...args: Parameters<InMemoryStore["updateRunTrace"]>): Promise<number> {
      this.traces.push(args);
      return super.updateRunTrace(...args);
    }
  }

  test("the trace write keeps the commit-point events and appends the seed-tail failure; marks run from load to pushTail", async () => {
    const own = new TraceStore();
    // A failed sovereign-quote leg fetch is a PRE-drain event the post-tail rewrite must keep.
    const feeds = fakeFeeds({ fetchNtfsSeries: () => Promise.reject(new Error("aborted")), fetchSovereignBars: () => Promise.reject(new Error("sovereign down")) });
    // The cron's commit-point purge hook: runs after the alert row commits, before any seed-tail task settles.
    let atCommit: { recorded: boolean; marks: string[] } | null = null;
    const onCommitted = async (): Promise<void> => {
      atCommit = { recorded: own.atRecord !== null, marks: Object.keys(runTimings()?.marks ?? {}) };
    };
    const alert = await runCycleWith(feeds, own, undefined, { onCommitted });
    expect(atCommit).toEqual({ recorded: true, marks: expect.arrayContaining(["persist"]) });
    expect(atCommit!.marks.some((k) => k.startsWith("tail"))).toBe(false);
    expect(own.traces).toHaveLength(1);
    const [firedAt, trace] = own.traces[0]!;
    expect(firedAt).toBe(alert.firedAt);
    expect(trace.degraded.filter((e) => e.scope === SEED_TAIL_SCOPE && e.reason.includes("NTFS"))).toEqual([
      { scope: SEED_TAIL_SCOPE, reason: "[input-series] NTFS seed non-live this run: aborted", effect: "trace", late: "notify" },
    ]);
    const base = ["load", "fred", "confirmers", "globals", "confirmersWait", "estimates", "cqs", "assemble", "push"];
    expect(own.atRecord?.degraded.length).toBeGreaterThan(0);
    expect(trace.degraded.slice(0, own.atRecord!.degraded.length)).toEqual(own.atRecord!.degraded);
    const phaseOnly = (ks: string[]) => ks.filter((k) => !/^(tail|ecb|conf|cqs)\./.test(k));
    expect(phaseOnly(own.atRecord!.marks)).toEqual(base);
    const marks = Object.keys(trace.timings?.marks ?? {});
    expect(phaseOnly(marks)).toEqual([...base, "persist", "purge", "tail", "pushTail"]);
    expect(marks).toEqual(expect.arrayContaining(["tail.cape", "tail.legs", "tail.inputs", "ecb.ESTR", "ecb.EURGBP", "cqs.BAA10Y", "cqs.AAA10Y", "cqs.EBP"]));
    expect(marks.some((k) => k.startsWith("conf."))).toBe(true);
    // The ECB fetches start at cycle start, so they settle before the FRED batch does.
    expect(marks.indexOf("ecb.EURGBP")).toBeLessThan(marks.indexOf("fred"));
  });

  // `priorLateNotifyEvents`: a seed failing every night pushes once. Two real
  // cycles over one store, NTFS aborting each night: run 1 surfaces the prior row's late event and commits the
  // seen marker with its row (before `recordRun`); run 2 reads run 1's row (event + marker) and stays silent on it.
  test("a chronic late-notify seed failure surfaces once: the seen marker rides the committed row, the next night is silent", async () => {
    const own = new TraceStore();
    const NTFS_FAIL = "[input-series] NTFS seed non-live this run: aborted";
    await own.recordAlert(makeAlert({ degraded: [{ scope: SEED_TAIL_SCOPE, reason: NTFS_FAIL, effect: "trace", late: "notify" }] }));
    const feeds = fakeFeeds({ fetchNtfsSeries: () => Promise.reject(new Error("aborted")) });
    const mark = { scope: LATE_NOTIFY_SEEN_SCOPE, reason: `${SEED_TAIL_SCOPE}: [input-series] NTFS`, effect: "trace" };
    const tailLines = (n: ReturnType<typeof fakeNotify>) => n.pushNtfy.mock.calls.filter(([m]) => m.body.includes("last run's seed tail"));
    const n1 = fakeNotify();
    await runCycleWith(feeds, own, undefined, { notify: n1 });
    expect(tailLines(n1)).toHaveLength(1);
    expect(own.atRecord?.degraded).toContainEqual(mark);
    // Run 2's `last` carries the event again (run 1's tail failed too), so its silence is the marker's doing.
    expect(own.traces.at(-1)?.[1].degraded).toContainEqual({ scope: SEED_TAIL_SCOPE, reason: NTFS_FAIL, effect: "trace", late: "notify" });
    const n2 = fakeNotify();
    await runCycleWith(feeds, own, undefined, { notify: n2 });
    expect(tailLines(n2)).toHaveLength(0);
    expect(own.atRecord?.degraded).toContainEqual(mark);
  });
});

// The 2026-11-06 `runSeedTail` ruling: a skipped or failed tail task records a degrade naming its ids.
// The tail runs post-drain (as in the cycle), so `drainLateDegrades` stores it `effect: "trace"` (after this run's push) with
// `late: "notify"` — the next EOD push surfaces it (`priorLateNotifyEvents`, notify_format.test.ts).
describe("runSeedTail - a skipped or failed task stores a trace degrade naming its ids, late-notify for the next push", () => {
  const D = FIXTURE_ASOF;
  const tail = (s: InMemoryStore, feeds: FeedPorts, backfill: Parameters<typeof runSeedTail>[1] = []): Promise<void> =>
    runSeedTail({ store: s, clock: monotonicClock(`${D}T22:00:00.000Z`), env: {}, feeds } as unknown as RunBase, backfill, D);
  const seedTailNotify = (): DegradeEvent[] => drainLateDegrades().filter((e) => e.scope === SEED_TAIL_SCOPE && e.late === "notify");

  // The cycle's order: the run row's drain precedes the tail, so every tail event is a late one.
  beforeEach(() => {
    resetDegradeLog();
    drainDegradeLog();
  });

  test("a rejected task: a late-notify degrade names its id, and the rejection is still rethrown", async () => {
    /** A failing probe read for the one backfill id is the input — every other task's reads stay green. */
    class ProbeFailStore extends InMemoryStore {
      override getSeries(...args: Parameters<InMemoryStore["getSeries"]>): Promise<SeriesPoint[]> {
        return args[0] === "NVDA" ? Promise.reject(new Error("probe down")) : super.getSeries(...args);
      }
    }
    const nvda = [{ date: D }] as unknown as Reading[];
    await expect(tail(new ProbeFailStore(), fakeFeeds(), [{ id: "NVDA", series: nvda, estimateDates: [] }])).rejects.toThrow("probe down");
    expect(seedTailNotify()).toEqual([{ scope: SEED_TAIL_SCOPE, reason: "[tail.NVDA] NVDA not seeded - task rejected: probe down", effect: "trace", late: "notify" }]);
  });

  test("a skipped input-series id (its feed aborted): a late-notify degrade names it", async () => {
    await expect(tail(store, fakeFeeds({ fetchNtfsSeries: () => Promise.reject(new Error("aborted")) }))).resolves.toBeUndefined();
    expect(seedTailNotify().filter((e) => e.reason.includes("NTFS"))).toEqual([
      { scope: SEED_TAIL_SCOPE, reason: "[input-series] NTFS seed non-live this run: aborted", effect: "trace", late: "notify" },
    ]);
  });

  test("a task unsettled at the run hard deadline is skipped: a late-notify degrade names its ids and the tail returns", async () => {
    // Anchored ~400 ms before the hard deadline (uptime 0 ⇒ the anchor is exactly the given instant).
    markRunAnchor(performance.now() - RUN_HARD_DEADLINE_MS + 400, 0);
    startRunBudget(RUN_FETCH_BUDGET_MS, performance.now(), () => undefined);
    try {
      const hung = fakeFeeds({ fetchCape: () => new Promise<never>(() => undefined) });
      await expect(tail(store, hung)).resolves.toBeUndefined();
      expect(seedTailNotify()).toContainEqual({ scope: SEED_TAIL_SCOPE, reason: "[tail.cape] F7 skipped - unsettled at the run hard deadline", effect: "trace", late: "notify" });
    } finally {
      clearRunBudget();
    }
  });

  test("deadline-abandoned tasks released after return: no write, no late degrade or mark; an earlier rejection is rethrown", async () => {
    let releaseCape!: () => void;
    let releaseNvda!: () => void;
    /** NVDA's probe read hangs, then rejects; F1's rejects at once — the pre-deadline failure beside the hung tasks. */
    class HungStore extends InMemoryStore {
      override getSeries(...args: Parameters<InMemoryStore["getSeries"]>): Promise<SeriesPoint[]> {
        if (args[0] === "F1") return Promise.reject(new Error("early down"));
        if (args[0] === "NVDA") return new Promise((_, reject) => (releaseNvda = () => reject(new Error("late down"))));
        return super.getSeries(...args);
      }
    }
    const own = new HungStore();
    const cape = new Promise<{ date: string; value: number }[]>((resolve) => (releaseCape = () => resolve([{ date: D, value: 30 }])));
    const one = [{ date: D }] as unknown as Reading[];
    markRunAnchor(performance.now() - RUN_HARD_DEADLINE_MS + 400, 0);
    startRunBudget(RUN_FETCH_BUDGET_MS, performance.now(), () => undefined);
    try {
      const backfill = [{ id: "F1", series: one, estimateDates: [] }, { id: "NVDA", series: one, estimateDates: [] }];
      await expect(tail(own, fakeFeeds({ fetchCape: () => cape }), backfill)).rejects.toThrow("early down");
      drainLateDegrades(); // the run's own (pre-return) events
      releaseCape();
      releaseNvda();
      await new Promise((r) => setTimeout(r, 20));
      expect(own.readings.filter((r) => r.indicatorId === "F7")).toEqual([]);
      expect(seedTailNotify()).toEqual([]);
      expect(Object.keys(runTimings()?.marks ?? {}).filter((k) => k === "tail.cape" || k === "tail.NVDA")).toEqual([]);
    } finally {
      clearRunBudget();
    }
  });
});

// A price port with no source (every symbol refused, no request): the run still completes and writes its alert row,
// and no price-fed row lands. The price-fed ids are DERIVED from the registries: price scorers, price-fed input
// series, registry rows and `LEGP_*` closes whose symbol the run asked the price port for, composite components on
// such a symbol, and a parent whose every component is one. A same-clock run served the calm closes checks that
// derivation is complete. Both ports are injected, so this holds whatever `prices.ts` serves.
describe("no free price source", () => {
  test("a run whose every price symbol is refused persists 0 price-fed rows and still writes its alert_log row", async () => {
    const feeds = fakeFeeds({ fetchDailyCloses: async (symbol) => noFreeSource(symbol) });
    await runCycleWith(feeds, store);
    const asked = new Set(feeds.fetchDailyCloses.mock.calls.map(([symbol]) => symbol));
    expect(asked, "premise: the run asked the price port").toContain("SPY");
    const components = Object.entries(COMPOSITE_COMPONENTS);
    const indicators = [ALL_INDICATORS, PENSION_INDICATORS, SLOW_INDICATORS, BOTTOM_INDICATORS, Object.values(BREADTH_STORE_IDS)].flat();
    const priceIds = new Set([
      ...asked,
      ...PRICE_INDICATORS.map((i) => i.id),
      ...DOWNSIDE_DETECTOR_IDS,
      ...RS_LEG_IDS,
      ...PRICE_SCORERS.map((p) => p.indicator.id),
      ...indicators.filter((i) => i.series !== undefined && asked.has(i.series)).map((i) => i.id),
      ...legCloseQuotes().filter(([, q]) => asked.has(q.ticker)).map(([id]) => id),
      ...INPUT_SERIES.filter((i) => i.feed === "price").map((i) => i.id),
      ...components.flatMap(([, cs]) => cs.filter((c) => asked.has(c.symbol)).map((c) => c.id)),
      ...components.filter(([, cs]) => cs.every((c) => asked.has(c.symbol))).map(([parent]) => parent),
    ]);
    const servedStore = new InMemoryStore();
    seedHyoasCalib(servedStore);
    await runCycleWith(fakeFeeds(), servedStore);
    const refusedIds = new Set(store.readings.map((r) => r.indicatorId));
    const servedOnly = [...new Set(servedStore.readings.map((r) => r.indicatorId))].filter((id) => !refusedIds.has(id));
    expect(servedOnly.length, "premise: serving the closes stores price-fed ids").toBeGreaterThan(0);
    expect(servedOnly.filter((id) => !priceIds.has(id)), "every id only a served run stores is in the derived set").toEqual([]);
    expect(store.readings.filter((r) => priceIds.has(r.indicatorId)).map((r) => r.indicatorId)).toEqual([]);
    expect(store.readings.length, "premise: the non-price rows still land").toBeGreaterThan(0);
    expect(store.alerts).toHaveLength(1);
    // The alert row's `run_inputs` blob carries per-id levels too (heads, global readings, stamps): none for a price-fed id.
    const levelIds = (s: InMemoryStore) => {
      const ri = s.alerts[0]?.runInputs;
      if (ri == null) throw new Error("premise: the alert row carries run_inputs");
      return [
        ...(ri.globalReadings ?? []).filter((r) => r.level !== null).map((r) => r.id),
        ...(ri.heads ?? []).filter((h) => h.value !== null).map((h) => h.indicatorId),
        ...Object.keys(ri.stamps),
      ];
    };
    expect(levelIds(servedStore).filter((id) => priceIds.has(id)).length, "premise: a served run's run_inputs carries price-fed levels").toBeGreaterThan(0);
    expect([...new Set(levelIds(store).filter((id) => priceIds.has(id)))]).toEqual([]);
  });
});
