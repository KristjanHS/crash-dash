import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearPriceCache } from "./price-cache.js";
import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import { INDICATORS } from "./registry-fred.js";
import type { Observation } from "./domain-types.js";
import { SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";
import { runScoringCycle } from "./run-cycle.js";
import { makeFredLoop, breadthFeed, r4DbFirstFeed } from "./run-dbfirst.js";
import { DFII10_ORIGIN } from "./backfill-depth.js";
import { F7_REPAIR_MONTHS, backfillCapeOnCron } from "./run-seeds.js";
import { priceLegReadingSeries } from "./pension.js";
import { provenanceDegradeEvents } from "./run-cycle-persist.js";
import { MIN_OVERLAP_ROWS } from "./treasury.js";
import { realFeeds, type FeedPorts } from "./feed-ports.js";
import { BREADTH_LOOKBACK_DAYS } from "./registry-price.js";
import { RUN_FETCH_BUDGET_MS, clearRunBudget, markRunAnchor } from "./fetch-budget.js";
import { R5_SLOW_DB_FIRST_FEED } from "./tracks.js";
import { makeStoredReading } from "./test-helpers.js";
import {
  PRICE_UP_LEN,
  dailyDatesEndingAt,
  deepHcxCloses,
  FIXTURE_ASOF,
  fakeFeeds,
  fakeNotify,
  type FakeFeeds,
  fredMock,
  fredMockAt,
  monotonicClock,
  atUtcMin,
  installRunTestHooks,
  runCycleWith,
  CALM_GEO,
  seedHyoasCalib,
} from "./run.test-helpers.js";
import { MA_WINDOW } from "./family-descriptor-rows.js";
import {
  R6_DB_FIRST_FEED,
  R6_MOVE_LOOKBACK_DAYS,
  R7_LEG_IDS,
  r7LegFeed,
  r7LegLoopDeep,
} from "./confirmers.js";
import { CG_DB_FIRST_FEED } from "./db-first-specs.js";
import { TAIL_DAYS, deepArmSince, needRowsForSeedDepth, tailSince14 } from "./series-db-first.js";
import { cgLookbackDays } from "./scorers-composite.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "./intraday.js";
import { readEnv } from "./config.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// `rows` consecutive daily GREEN readings for one id, ending `endIso` (default the day BEFORE the
// fixture asOf) — the shape every DB-first describe seeds, differing only in id/value/end.
const SEED_RUN_AT = "2026-01-01T00:00:00.000Z";
const seededGreenRows = (
  id: string,
  rows: number,
  opts: { value?: number; endIso?: string } = {},
): StoredReading[] => {
  const { value = 1, endIso = "2026-01-29" } = opts;
  const end = Date.parse(`${endIso}T00:00:00Z`);
  return Array.from({ length: rows }, (_, i) => ({
    date: new Date(end - (rows - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    indicatorId: id,
    value,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
    decision: null,
  }));
};

describe("runScoringCycle - NVDA history backfill + run_at invariant (D3 / load-bearing)", () => {
  // The NVDA gate series spans MA_WINDOW..end of priceUp(); the LATEST rides the
  // commit path (run_at = firedAt); the rest are backfilled under a DISTINCT run_at
  // so /status never sees them.
  // Mirrors priceUp()'s dates exactly — it now derives from the shared fixture anchor
  // (dailyDatesEndingAt(PRICE_UP_LEN), ending at FIXTURE_ASOF), NOT the retired 2024-01-01 window.
  const priceDate = (i: number): string => dailyDatesEndingAt(PRICE_UP_LEN)[i]!;
  const SERIES_DAYS = PRICE_UP_LEN - MA_WINDOW + 1; // = nvdaGateReadingSeries length for priceUp()

  test("first run backfills all historical gate days and seeds the CAPE leg (F7, W1-l); /status sees one NVDA row and no F7; /series sees the full history; every drain's hops persist as ONE deduped event per hop", async () => {
    const cape: Observation[] = [
      { date: "2026-04-01", value: 40 },
      { date: "2026-05-01", value: 41 },
      { date: "2026-06-01", value: 41.94 },
    ];
    const feeds = fakeFeeds({
      fetchCape: async () => cape,
      drainKeyedFallbacks: () => [{ series: "DGS10", summary: "HTTP 401" }],
      // The flagship failure: a quota-capped primary fails every symbol of the run identically.
      drainProviderFallbacks: () => [
        { symbol: "SPY", from: "primary", to: "fallback", summary: "HTTP 429 Too Many Requests" },
        { symbol: "QQQ", from: "primary", to: "fallback", summary: "HTTP 429 Too Many Requests" },
      ],
    });
    // Pre-seed ONE historical computable date with a sentinel value under an OLD
    // run_at — backfill must skip it (only-missing) and never overwrite it.
    const seededDate = priceDate(MA_WINDOW - 1); // first computable day
    await store.recordReadings(
      [makeStoredReading("NVDA", { date: seededDate, value: -999 })],
      atUtcMin(seededDate, INTRADAY_CUTOFF_UTC_MIN), // a FINAL vintage — a provisional one A2 rewrites
    );

    const clock = monotonicClock();
    const alert = await runCycleWith(feeds, store, clock);

    // (b) THE INVARIANT: /status reads readings by the alert's firedAt; backfill
    // rows carry a distinct run_at, so exactly ONE NVDA row (today's commit
    // reading) surfaces there — not the ~60 historical days.
    const nvdaAtFired = (await store.getReadingsForRun(alert.firedAt)).filter(
      (r) => r.indicatorId === "NVDA",
    );
    expect(nvdaAtFired).toHaveLength(1);
    expect(nvdaAtFired[0]!.date).toBe(priceDate(PRICE_UP_LEN - 1)); // the latest computable day

    // (c) /series (latest-vintage view) returns the FULL backfilled history.
    const series = await store.getSeries("NVDA", 2000);
    expect(series).toHaveLength(SERIES_DAYS);
    expect(series[0]!.date).toBe(priceDate(MA_WINDOW - 1));
    expect(series[series.length - 1]!.date).toBe(priceDate(PRICE_UP_LEN - 1));

    // (a) ONLY missing dates were inserted: the pre-seeded date kept its sentinel
    // vintage (backfill skipped it), proving it wasn't re-inserted.
    expect(series.find((p) => p.date === seededDate)!.value).toBe(-999);

    // Before W1-l the cron READ F7 (assembleDial) but never SEEDED it — the multiplier was dark in prod.
    const f7 = await store.getSeries("F7", 5000);
    expect(f7.map((p) => p.date)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(f7.at(-1)!.value).toBe(41.94);
    // run_at invariant: the seed runs AFTER recordRun with a distinct run_at — a reorder would leak F7 into /status here.
    expect((await store.getReadingsForRun(alert.firedAt)).filter((r) => r.indicatorId === "F7")).toHaveLength(0);
    // Re-run: one served row per date (rows past the 2024 clock's month are open-month estimates, rewritten in place).
    await backfillCapeOnCron(store, clock, feeds.fetchCape);
    expect(await store.getSeries("F7", 5000)).toHaveLength(3);

    const hops = (alert.degraded ?? []).filter((e) => /fell back to/.test(e.scope));
    expect(hops).toEqual([
      { scope: "[fred] keyed API fell back to keyless CSV (1 series)", reason: "DGS10 - HTTP 401", effect: "trace" },
      { scope: "[prices] primary fell back to fallback (2 symbols)", reason: "SPY, QQQ - HTTP 429 Too Many Requests", effect: "trace" }, // ONE summary for two symbols: deduped
    ]);
    // ...and it is on the PERSISTED row, not only the returned object (the drain sits ahead of `recordRun`).
    expect((await store.getLastAlert())?.degraded).toEqual(expect.arrayContaining(hops));
  });
});

describe("backfillCapeOnCron - open month `estimated`, closed months value-repaired", () => {
  const cape = (pairs: [string, number][]): (() => Promise<Observation[]>) => async () => pairs.map(([date, value]) => ({ date, value }));
  const at = (iso: string): (() => string) => () => iso;
  const f7Rows = (s: InMemoryStore, date: string) => s.readings.filter((r) => r.indicatorId === "F7" && r.date === date).map((r) => ({ value: r.value, estimated: r.estimated === true }));

  test("the open month is stored `estimated` over a frozen FINAL, replaced next run, and lands FINAL alone once the month closes", async () => {
    const s = new InMemoryStore();
    await s.recordReadings([makeStoredReading("F7", { date: "2026-11-01", value: 41.38 })], "2026-11-02T22:00:00.000Z");
    await backfillCapeOnCron(s, at("2026-11-07T12:00:00.000Z"), cape([["2026-10-01", 40.6], ["2026-11-01", 41.0]]));
    expect(f7Rows(s, "2026-11-01")).toEqual([{ value: 41.0, estimated: true }]);
    expect(f7Rows(s, "2026-10-01")).toEqual([{ value: 40.6, estimated: false }]);
    await backfillCapeOnCron(s, at("2026-11-08T12:00:00.000Z"), cape([["2026-10-01", 40.6], ["2026-11-01", 41.5]]));
    expect(f7Rows(s, "2026-11-01")).toEqual([{ value: 41.5, estimated: true }]);
    await backfillCapeOnCron(s, at("2026-12-02T12:00:00.000Z"), cape([["2026-10-01", 40.6], ["2026-11-01", 41.7], ["2026-12-01", 42.0]]));
    expect(f7Rows(s, "2026-11-01")).toEqual([{ value: 41.7, estimated: false }]);
    expect(f7Rows(s, "2026-12-01")).toEqual([{ value: 42.0, estimated: true }]);
  });

  test("a fetch missing the open month (head-row parse miss) keeps the stored open-month FINAL — the head does not regress", async () => {
    const s = new InMemoryStore();
    await s.recordReadings([makeStoredReading("F7", { date: "2026-11-01", value: 41.38 })], "2026-11-02T22:00:00.000Z");
    await backfillCapeOnCron(s, at("2026-11-07T12:00:00.000Z"), cape([["2026-09-01", 39.9], ["2026-10-01", 40.6]]));
    expect(f7Rows(s, "2026-10-01"), "premise: the run wrote").toEqual([{ value: 40.6, estimated: false }]);
    expect(f7Rows(s, "2026-11-01")).toEqual([{ value: 41.38, estimated: false }]);
  });

  test("a changed FINAL row is repaired only inside the last F7_REPAIR_MONTHS closed months; an unchanged one is not rewritten", async () => {
    expect(F7_REPAIR_MONTHS).toBeGreaterThan(0);
    const s = new InMemoryStore();
    const back = (k: number): string => new Date(Date.UTC(2026, 10 - k, 1)).toISOString().slice(0, 10); // k closed months before Nov 2026
    const [edge, outside, unchanged] = [back(F7_REPAIR_MONTHS), back(F7_REPAIR_MONTHS + 1), back(1)];
    await s.recordReadings(priceLegReadingSeries("F7", [outside, edge, unchanged].map((date) => ({ date, value: 30 }))), "2026-10-15T22:00:00.000Z");
    await backfillCapeOnCron(s, at("2026-11-07T12:00:00.000Z"), cape([[outside, 31], [edge, 31], [unchanged, 30]]));
    const served = new Map((await s.getSeries("F7", 10)).map((p) => [p.date, p.value]));
    expect([served.get(outside), served.get(edge), served.get(unchanged)]).toEqual([30, 31, 30]);
    expect(f7Rows(s, unchanged), "unchanged: no second vintage").toHaveLength(1);
  });
});

// Audit rank 3: the core INDICATORS fetch loop was the only un-degrade-wrapped network
// block — one FRED rejection rejected the Promise.all, 500'd the cron, and left a permanent
// vintage gap. These pin the per-indicator degrade: a single fetch failure must NOT abort
// the run; the indicator falls back to its last-persisted series, or goes non-live if none.
describe("runScoringCycle - core-loop FRED degrade (audit rank 3)", () => {
  // A SMOOTHED_LEVEL_OF id persists the trailing MEAN as `value`, so the fallback's implicit
  // "stored value == feed value" contract breaks for it — it must go non-live, not mean-of-means.
  test("a smoothed-level id refuses the stored-series fallback; F1 takes it, dropping a PROVISIONAL row (C1) and never scoring an `estimated` one (E2)", async () => {
    const smoothed = INDICATORS.filter((i) => SMOOTHED_LEVEL_OF[i.id]);
    expect(smoothed.length).toBeGreaterThan(0); // premise: the exclusion has a subject
    const f1Hist: StoredReading[] = Array.from({ length: 30 }, (_, i) =>
      makeStoredReading("F1", { date: `2026-01-${String(i + 1).padStart(2, "0")}` }),
    );
    await store.recordReadings(f1Hist, "2026-01-30T22:00:00Z");
    // An intraday run's row for 01-31, written 10:00 UTC (before the cutoff) ⇒ provisional.
    await store.recordReadings([makeStoredReading("F1", { date: "2026-01-31", value: 9 })], "2026-01-31T10:00:00Z");
    const estimate = makeStoredReading("F1", { date: "2026-02-02", value: 9, estimated: true });
    await store.recordReadings([estimate], "2026-02-02T22:00:00Z");
    const seed: StoredReading[] = [];
    for (const { id } of smoothed) {
      for (let i = 0; i < 60; i++)
        seed.push(
          makeStoredReading(id, {
            date: `2026-01-${String((i % 30) + 1).padStart(2, "0")}`,
          }),
        );
    }
    await store.recordReadings(seed, "2026-01-30T00:00:00Z");

    const rejected = new Set([
      ...smoothed.map((i) => i.series),
      "BAMLH0A0HYM2",
    ]);
    // R8 (the smoothed id) left FRED for the NTFS feed 2026-08-13 — fail its OWN seam too, so the
    // exclusion below tests the fallback refusal, not a green gsw stub.
    const feeds = fakeFeeds({
      fetchSeries: async (series: string) =>
        rejected.has(series) ? Promise.reject(new Error("FRED 503")) : fredMock(series),
      fetchNtfsSeries: async () => Promise.reject(new Error("GSW 503")),
    });

    const alert = await runCycleWith(feeds, store);
    const ids = new Set(
      (await store.getReadingsForRun(alert.firedAt)).map((r) => r.indicatorId),
    );
    for (const { id } of smoothed) expect(ids).not.toContain(id);
    const f1 = (await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "F1");
    expect(f1?.date).toBe("2026-01-30"); // discriminator: the raw-value ids still fall back, on the last final date
    expect(store.readings.filter((r) => r.indicatorId === "F1" && r.date === estimate.date && r.estimated === true)).toHaveLength(1);
  });

  // A refused id (the owner bars redistribution) reaches the real FRED seam with its own injected set, so this
  // holds whatever `REFUSED_SERIES` lists; the hooks' fetch backstop reds on any wire request.
  test("credit ids refused at the FRED seam: the run completes and persists, F1's trace is kind no-free-source, the CQS bridge and dial hold", async () => {
    const refused = new Set(["BAMLH0A0HYM2", "BAMLC0A0CM", "BAMLC0A4CBBB", "BAMLH0A3HYC", "BAMLEMCBPIOAS", "BAA10Y", "AAA10Y"]);
    const feeds = fakeFeeds({
      fetchSeries: (series, o) => (refused.has(series) ? realFeeds.fetchSeries(series, { ...o, refusedSeries: refused }) : fredMock(series)),
    });
    const alert = await runCycleWith(feeds, store);
    expect(await store.getLastAlert({ withPanel: true, withRunInputs: true })).toEqual(alert);
    const degraded = alert.degraded ?? [];
    expect(degraded.find((e) => e.scope.startsWith("[F1] "))?.kind).toBe("no-free-source");
    // `degrade()` swallows a throw into a scoped event, so "no throw" = no event under these scopes.
    expect(degraded.filter((e) => /^\[(CQS|display-dial)\]/.test(e.scope))).toEqual([]);
  });
});

// DATA-4 — the run-wide fetch budget (fetch-budget.ts). This is the ONE test that validates
// RUN_FETCH_BUDGET_MS, so it stubs GLOBAL fetch rather than the feed seams: the property under
// test lives INSIDE fred.ts/prices.ts/ecb.ts/vix_term.ts (each composing the run
// deadline onto its own per-attempt timeout), and a mocked `fetchSeries` would fake away exactly
// that. Fake timers make the per-attempt `AbortSignal.timeout`s (native timers, unfaked) unable
// to fire, which is the point: what ends this run can ONLY be the budget.
describe("runScoringCycle - run-wide fetch budget (DATA-4)", () => {
  // The fake-clock tail the run may spend AFTER the deadline fires: each remaining phase's `fredRetry`
  // policy, run by feed-http.ts's `withRetry` loop, sleeps one FRED_RETRY_BACKOFF_MS before giving up on an already-aborted signal.
  // Bounded by design — it must stay well inside what `RUN_HARD_DEADLINE_MS` leaves past `RUN_FETCH_BUDGET_MS`.
  const POST_DEADLINE_SLACK_MS = 10_000;

  beforeEach(() => {
    clearPriceCache();
    clearRunBudget();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearRunBudget();
  });

  test("every feed hangs: the cycle still persists, on the budget", async () => {
    // A stalled datacenter-IP feed: the request never answers and never errors — it ends only
    // when the caller's signal aborts it (exactly what real fetch does).
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // no signal ⇒ hangs forever (the pre-budget world for that call site)
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    // The cycle ALWAYS reaches persist: read off the injected store's STATE at two FAKE-clock checkpoints in [budget, budget + slack].
    // FRED/prices/vix/ECB (+ memo, outage, drains) stay REAL ports — the budget lives INSIDE those clients; the rest calm.
    const feeds = fakeFeeds({
      fetchSeries: realFeeds.fetchSeries,
      fetchDailyCloses: realFeeds.fetchDailyCloses,
      fetchVixSeries: realFeeds.fetchVixSeries,
      fetchEcbSeries: realFeeds.fetchEcbSeries,
      startFredMemo: realFeeds.startFredMemo,
      fredOutage: realFeeds.fredOutage,
      drainKeyedFallbacks: realFeeds.drainKeyedFallbacks,
      drainProviderFallbacks: realFeeds.drainProviderFallbacks,
    });
    // Anchored as the cron entry anchors it, so the cycle's own `startRunBudget` clock is the one measured against it.
    markRunAnchor(performance.now(), 0);
    const cycle = runScoringCycle(monotonicClock(), { env: readEnv(), feeds, store, geo: CALM_GEO, notify: fakeNotify() });
    await vi.advanceTimersByTimeAsync(RUN_FETCH_BUDGET_MS - 1);
    // Vacuity guard on the fixture: a run that persisted BEFORE the deadline would mean the feeds
    // weren't really hanging, and the budget would be untested by this test.
    expect(await store.getLastAlert()).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + POST_DEADLINE_SLACK_MS); // the deadline + the post-deadline retry-backoff tail
    // THE GUARANTEE: a persisted run (not a 500 with an empty write), within the slack.
    expect(await store.getLastAlert()).not.toBeNull();
    await vi.runAllTimersAsync(); // whatever post-persist tail remains
    const alert = await cycle;
    expect(await store.getLastAlert({ withPanel: true, withRunInputs: true })).toEqual(alert);
    // ...and the budget is the mechanism that ended it: the abort reached each feed's EXISTING
    // degrade path, which recorded it exactly as it records a timeout.
    const degraded = alert.degraded ?? [];
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.some((e) => /run fetch budget/.test(e.reason))).toBe(true);
  });
});

// PROVENANCE DRAINS (DATA-2 + the FRED keyed fallback) — run-cycle folds each collector's
// per-item records into ONE deduped degrade event per hop. Both blocks were covered only
// INCIDENTALLY until 2026-08-20: the DATA-4 hanging-feed test above produced a `closes→stooq` hop
// on a keyless run, and deleting the stooq tier took that with it. The hole was
// invisible on a laptop — the local env's feed keys changed which feed paths ran, so
// run-cycle.ts read 95% functions locally and 91.25% on CI, under its 93 floor. The NVDA first-run
// cycle drives both blocks on purpose, so the coverage no longer depends on which feed keys happen to be in
// the environment running the suite.
//
// SEAM: the two collectors' drain functions, not the feeds behind them. WHAT gets recorded is
// prices.ts's / fred.ts's own contract (covered in their suites); what run-cycle owns — and all
// this block does — is the FOLD: one event per hop, every symbol/series listed, summaries deduped.
describe("runScoringCycle - provenance drains fold into one deduped degrade event", () => {
  test("the fold: ONE event per hop naming every series/symbol; nothing recorded ⇒ no event", () => {
    const http401 = "HTTP 401 Unauthorized";
    expect(provenanceDegradeEvents([{ series: "BAMLH0A0HYM2", summary: http401 }, { series: "DGS10", summary: http401 }], [])).toEqual([
      { scope: "[fred] keyed API fell back to keyless CSV (2 series)", reason: `BAMLH0A0HYM2, DGS10 - ${http401}` },
    ]);
    expect(provenanceDegradeEvents([], [])).toEqual([]);
    expect(provenanceDegradeEvents([], [{ symbol: "QQQ", from: "primary", to: "fallback", summary: "y" }])).toEqual([
      { scope: "[prices] primary fell back to fallback (1 symbol)", reason: "QQQ - y" },
    ]);
  });
});

// DB-first cron feeds (stage 4.2 / §6.2) — the per-feed WIRING pins, thinned to ONE CYCLE PER ARM
// (was seven describes / ~17 cycles). The arm
// decision itself is direct-tested in db-first-feeds.test.ts (`resolveDbFirstArm` over each
// production spec, seeded InMemoryStore), the generic seam mechanics in series-db-first.test.ts,
// and the SPY read-only + CG warm-up round trips moved to direct `dbFirstSeries` calls there. What
// only a real cycle can prove is that each SITE routes its fetch through the arm — the fetch mocks
// ignore their options, so the arm is observable ONLY through the options each feed was asked with.
// The seeded/TAIL cycle is the discriminating pin: a site bypassing the seam still fetches deep on
// an empty store (same-looking ask) but keeps fetching deep on a full one, which reds the tail asks.
describe("DB-first cron feeds - one cycle per arm wires every site through the seam", () => {
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });
  // FIXED run clock: `deepArmSince` is sized off `runAt`, so the seeded row counts and each site's
  // shallow check read the same date (no UTC-midnight flake).
  const RUN_AT = "2026-08-31T12:00:00.000Z";
  const run = () => runCycleWith(feeds, store, monotonicClock(RUN_AT));
  const MINT_IDS = ["BR_QQQ", "BR_QQQE", "BR_RSP"] as const;
  const DEEP_SYMS = ["QQQ", "QQQE", "RSP", "SPY"] as const;
  const dbLegs = R7_LEG_IDS.filter((id) => !r7LegLoopDeep(id));
  const memoLegs = R7_LEG_IDS.filter((id) => r7LegLoopDeep(id));
  const legSeries = (id: string): string =>
    INDICATORS.find((i) => i.id === id)!.series;
  const seedRows = async (
    id: string,
    rows: number,
    value?: number,
  ): Promise<void> => {
    await store.recordReadings(
      seededGreenRows(id, rows, value === undefined ? {} : { value }),
      SEED_RUN_AT,
    );
  };
  // ^MOVE and GC=F have one caller each, so their arm reads off the raw asks; HG=F's second caller is the
  // COPPER input seed (`{ deep: true }` unseeded, `{}` seeded), asked after CG. The breadth
  // symbols are also fetched by OTHER consumers (HCX `{deep:true}`, the shallow default), but the
  // breadth path is the only `lookbackDays`-bearing ask for them.
  /** An ask's window shape — the run clock (`now`) is pinned once, in the empty-store test's clock block; the run `env` is
   *  feed config, not part of the DEEP/TAIL ask, so it is dropped too. */
  const shapeOf = <T extends { now?: unknown; env?: unknown }>(o: T | undefined): Omit<T, "now" | "env"> | undefined => {
    if (o === undefined) return undefined;
    const shape: Partial<T> = { ...o };
    delete shape.now;
    delete shape.env;
    return shape as Omit<T, "now" | "env">;
  };
  /** A fetch's `now` in epoch ms — FRED takes a `Date`, prices a `() => number` thunk. */
  const nowMs = (o: { now?: Date | (() => number) } | undefined): number | undefined =>
    o?.now === undefined ? undefined : typeof o.now === "function" ? o.now() : o.now.getTime();
  const priceAsks = (sym: string) =>
    feeds.fetchDailyCloses.mock.calls.filter((c) => c[0] === sym)
      .map((c) => shapeOf(c[1]));
  const breadthAsks = (sym: string) =>
    priceAsks(sym).filter((o) => o?.lookbackDays !== undefined);
  // FRED sites: only the `since`-shaped asks (DEEP `deepArmSince` / TAIL `tailSince14`) tell the arm
  // apart — the core loop's own bounded fetches (undefined opts) are filtered out, and the input-series
  // seed's raw-id `fullHistory` catch-up (P1.1) is censused on its own.
  const fredOpts = (series: string) =>
    feeds.fetchSeries.mock.calls.filter((c) => c[0] === series)
      .map((c) => shapeOf(c[1]));
  const sinceAsks = (series: string) =>
    fredOpts(series).filter((o) => o?.since !== undefined);
  const fullAsks = (series: string) =>
    fredOpts(series).filter((o) => o?.fullHistory === true);
  // Each FRED-loop DB-first id beside the R7 legs, with the series its site fetches.
  const FRED_SITES = [
    ["R4", "DFII10"],
    ["R5", "VIXCLS"],
  ] as const;

  test("empty store ⇒ every site fetches its DEEP arm shape and the history lands under its id (§0.2)", async () => {
    // Clock block: tag each feed ask with whether the store already HOLDS the run's alert at ask time —
    // the scoring path is every ask before the persist point, the post-persist seeds every ask after it.
    const persisted = () => store.alerts.length > 0;
    const tagged: Array<{ feed: "fred" | "price"; series: string; ms: number | undefined; afterPersist: boolean }> = [];
    const fredBase = feeds.fetchSeries.getMockImplementation()!;
    feeds.fetchSeries.mockImplementation(async (s, o) => {
      tagged.push({ feed: "fred", series: s, ms: nowMs(o), afterPersist: persisted() });
      return fredBase(s, o);
    });
    const priceBase = feeds.fetchDailyCloses.getMockImplementation()!;
    feeds.fetchDailyCloses.mockImplementation(async (s, o) => {
      tagged.push({ feed: "price", series: s, ms: nowMs(o), afterPersist: persisted() });
      return priceBase(s, o);
    });
    await run();
    // Every FRED/price ask carries `now`; a scoring-path ask carries the run's `runAt` EXACTLY, a post-persist
    // seed ask a LATER tick of the same injected clock — never a wall-clock read.
    const runMs = Date.parse(RUN_AT);
    const scoring = tagged.filter((t) => !t.afterPersist);
    // vacuity floor: the scoring path really asked both feeds
    expect(["fred", "price"].filter((f) => !scoring.some((t) => t.feed === f))).toEqual([]);
    expect(scoring.filter((t) => t.ms !== runMs).map((t) => [t.series, t.ms])).toEqual([]);
    const seedNows = tagged.filter((t) => t.afterPersist).map((t) => [t.series, t.ms] as const);
    expect(seedNows.length).toBeGreaterThan(0);
    expect(seedNows.filter(([, ms]) => ms === undefined || ms <= runMs || ms > runMs + 1_000)).toEqual([]);
    // R6: one ^MOVE fetch at the named 1500d-era ask; the scored closes persist under R6.
    expect(priceAsks("^MOVE")).toEqual([
      { deep: true, lookbackDays: R6_MOVE_LOOKBACK_DAYS },
    ]);
    expect((await store.getSeries("R6", 100_000)).length).toBeGreaterThan(1);
    // §6.2 breadth: each deep symbol at the BREADTH_LOOKBACK_DAYS ask; the three minted ids persist
    // (SPY is READ-ONLY — its no-write half is direct-tested in db-first-feeds.test.ts).
    for (const sym of DEEP_SYMS)
      expect(breadthAsks(sym), sym).toEqual([
        { deep: true, lookbackDays: BREADTH_LOOKBACK_DAYS },
      ]);
    for (const id of MINT_IDS)
      expect((await store.getSeries(id, 100_000)).length, id).toBeGreaterThan(
        1,
      );
    // R7's DB legs: bounded `deepArmSince` (never inception), persisted under their own ids, and the
    // seed's raw-id catch-up is the ONLY `fullHistory` ask; the memo leg (R1) never asks `since`.
    for (const id of dbLegs) {
      expect(sinceAsks(legSeries(id)), id).toEqual([
        { since: deepArmSince(new Date(RUN_AT)) },
      ]);
      expect(fullAsks(legSeries(id)), id).toEqual([{ fullHistory: true }]);
      expect((await store.getSeries(id, 100_000)).length, id).toBeGreaterThan(
        1,
      );
    }
    for (const id of memoLegs) expect(sinceAsks(legSeries(id)), id).toEqual([]);
    expect((await store.getSeries("R7", 10)).length).toBe(1); // the composite still scores off the merged legs
    // R5 (the slow track's VIXCLS): the bounded deep shape; R4 (ECY's DFII10) reaches DFII10's origin —
    // ECY's rank pool is the whole join, and a seed-depth ask starves ECY_MIN_OBS. Both persisted.
    for (const [id, series] of FRED_SITES) {
      expect(sinceAsks(series), id).toEqual([
        { since: id === "R4" ? DFII10_ORIGIN : deepArmSince(new Date(RUN_AT)) },
      ]);
      expect(fullAsks(series), id).toEqual([{ fullHistory: true }]);
      expect((await store.getSeries(id, 100_000)).length, id).toBeGreaterThan(
        1,
      );
    }
    // CG: both legs deep to the anchor, the aligned ratio landing under CG; then COPPER's first seed at the SAME ask (one memo key).
    const cgDeep = { deep: true, lookbackDays: cgLookbackDays(new Date(RUN_AT)) };
    expect(priceAsks("HG=F")).toEqual([cgDeep, cgDeep]);
    expect(priceAsks("GC=F")).toEqual([cgDeep]);
    expect((await store.getSeries("CG", 100_000)).length).toBeGreaterThan(1);
   });

  test("a store past every needRows ⇒ every site asks its TAIL shape only (a seam bypass keeps asking deep)", async () => {
    await seedRows("R6", R6_DB_FIRST_FEED.needRows, 80);
    for (const sym of DEEP_SYMS)
      await seedRows(breadthFeed(sym).id, breadthFeed(sym).needRows, 100);
    for (const id of dbLegs) await seedRows(id, r7LegFeed(id).needRows);
    for (const [id] of FRED_SITES)
      await seedRows(
        id,
        id === "R4"
          ? r4DbFirstFeed(RUN_AT).needRows
          : R5_SLOW_DB_FIRST_FEED.needRows,
      );
    await seedRows("CG", CG_DB_FIRST_FEED.needRows); // flat 1 = a GREEN stored ratio; readings alone reach needRows
    await seedRows("COPPER", 30); // a seeded COPPER input asks `{}`, so a CG `{ deep: true }` bypass still reds below
    const R1_NEED = needRowsForSeedDepth();
    await seedRows("R1", R1_NEED);
    await run();
    expect(priceAsks("^MOVE")).toEqual([
      { deep: true, lookbackDays: TAIL_DAYS },
    ]);
    for (const sym of DEEP_SYMS)
      expect(breadthAsks(sym), sym).toEqual([
        { deep: true, lookbackDays: TAIL_DAYS },
      ]);
    for (const id of dbLegs) {
      expect(sinceAsks(legSeries(id)), id).toEqual([{ since: tailSince14(new Date(RUN_AT)) }]);
      expect(fullAsks(legSeries(id)), id).toEqual([{ fullHistory: true }]); // never a DB-arm fullHistory — the one ask is the seed's catch-up
    }
    for (const [id, series] of FRED_SITES) {
      expect(sinceAsks(series), id).toEqual([{ since: tailSince14(new Date(RUN_AT)) }]);
      expect(fullAsks(series), id).toEqual([{ fullHistory: true }]);
    }
    expect(priceAsks("HG=F")).toEqual([
      { deep: true, lookbackDays: TAIL_DAYS },
      {},
    ]);
    expect(priceAsks("GC=F")).toEqual([
      { deep: true, lookbackDays: TAIL_DAYS },
    ]);
    // R1 is never DB-first (left the roster 2026-09-04 — smoothed id): even on a deep store its
    // T10Y3M stays the direct arm — only fullHistory asks (the loop's + R7's memo + the input seed's,
    // one wire fetch under the run memo), never a `since`, and the run stores ONE new R1 row.
    for (const id of memoLegs) {
      expect(sinceAsks(legSeries(id)), id).toEqual([]);
      expect(fullAsks(legSeries(id)).length, id).toBeGreaterThan(0);
    }
    expect((await store.getSeries("R1", 100_000)).length).toBe(R1_NEED + 1);
  });
});

// The A1 repair rests on TWO runtime premises:
// (1) R2/R3 take r7LegSeries's DB arm (they are NOT loop-deep — owned by db-first-feeds.test.ts), so the
// grafted Treasury head is PERSISTED under its own id; and (2) that DB seam re-persists a stored
// grafted date whose FRED value later differs, over its 14d tail (owned by series-db-first.test.ts's tail arm).
// If a leg took the direct arm instead, nothing would persist and A1's repair would be undelivered.
describe("Treasury head A1 repair - the DB-arm premises the correction-overwrite rests on (S2)", () => {
  // Fix 1: the core FRED loop must thread the RUN's clock (`dbFirst.runAt`) into the Treasury year, or a
  // replay/restate against a historical clock fetches the wrong Treasury column AND grafts a different
  // vintage than fetchR4DeepInputs / r7LegSeries (which DO use runAt) — re-opening the two-vintage split A2 closed.
  test("makeFredLoop's core-loop fetch uses the RUN's year for the Treasury column, not the wall clock", async () => {
    const RUN_YEAR = 2021;
    expect(new Date().getUTCFullYear()).not.toBe(RUN_YEAR); // non-vacuity: the run clock differs from the wall clock
    // Empty FRED history ⇒ the A3 prior-year fallback is skipped, so exactly ONE Treasury fetch — for the run's year.
    const feeds = fakeFeeds({ fetchSeries: async () => [] });
    const treasury = feeds.fetchTreasuryColumn;
    const loop = makeFredLoop({
      env: {},
      dbFirst: {
        store: new InMemoryStore(),
        runAt: `${RUN_YEAR}-06-15T22:00:00.000Z`,
        feeds,
      },
      calib: [],
      synthLoad: { histories: new Map(), lastDate: new Map() },
      postInversionShortLeg: Promise.resolve([]),
    });
    await loop.fredLoopObservations(INDICATORS.find((i) => i.id === "R4")!); // R4 → TREASURY_HEAD_OF real/"10 YR"
    expect(treasury).toHaveBeenCalledWith("real", "10 YR", RUN_YEAR);
    expect(treasury).not.toHaveBeenCalledWith(
      "real",
      "10 YR",
      new Date().getUTCFullYear(),
    );
  });
});

// Treasury source: on the EOD run D's Treasury head IS the
// scored reading, stored `estimated` (never FINAL); FRED's D+1 print of D lands FINAL and sweeps the estimate.
describe("Treasury head on the EOD run - D's reading is the head, stored `estimated`", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — Treasury prints it, FRED not yet
  const R2_IND = INDICATORS.find((i) => i.id === "R2")!;
  // A 10y jump past R2's red velocity cut: the head's raw state differs from the flat D-1 print's.
  const HEAD_10Y = 1 + R2_IND.thresholds.redVelocity! + 0.05;
  const SERIES_OF = { nominal: { "10 YR": "DGS10", "2 YR": "DGS2" }, real: { "10 YR": "DFII10" } } as const;
  // Each column = FRED's own last MIN_OVERLAP_ROWS prints through `fredEnd` (the equality gate establishes) + a head at `head`.
  const mountTreasury = (fredEnd: string, head: string): FeedPorts["fetchTreasuryColumn"] =>
    async (curve, column) => {
      const series = (SERIES_OF[curve] as Record<string, string>)[column];
      if (series === undefined) return [];
      const prints = (await fredMockAt(fredEnd)(series)).slice(-MIN_OVERLAP_ROWS);
      return [...prints, { date: head, value: series === "DGS10" ? HEAD_10Y : prints.at(-1)!.value }];
    };
  // R7's spread leg (T10Y3M, never Treasury-grafted) prints D, so R7 scores a D reading off the DGS2/DGS10 heads.
  const fredAt = (end: string, fetchTreasuryColumn: FeedPorts["fetchTreasuryColumn"]) =>
    fakeFeeds({ fetchSeries: async (series) => (series === "T10Y3M" ? fredMockAt(NEXT) : fredMockAt(end))(series), fetchTreasuryColumn });
  /** A store whose shadow GC can be switched off — an input, so the D+1 assert pins the estimate SWEEP, not the GC. */
  class GcSwitchStore extends InMemoryStore {
    gc = true;
    override async pruneShadowedReadings(...a: Parameters<InMemoryStore["pruneShadowedReadings"]>): Promise<number> {
      return this.gc ? super.pruneShadowedReadings(...a) : 0;
    }
  }
  let own: GcSwitchStore;
  beforeEach(() => {
    own = new GcSwitchStore();
    seedHyoasCalib(own);
  });
  const onNext = (id: string) => own.readings.filter((r) => r.indicatorId === id && r.date === NEXT);

  test("EOD: R2/R7's D run row is the head's scored reading, stored `estimated`, no R2/R3/R4/R7 D row FINAL; D+1 without a head: FRED's D print sweeps D's R4 estimate, and an unsourced id's own", async () => {
    const eod = await runCycleWith(fredAt(FIXTURE_ASOF, mountTreasury(FIXTURE_ASOF, NEXT)), own, monotonicClock(`${NEXT}T22:00:00.000Z`));
    const runRows = await own.getReadingsForRun(eod.firedAt);
    const r2 = runRows.find((r) => r.indicatorId === "R2");
    const r2Prev = (await own.getSeries("R2", 10)).find((p) => p.date === FIXTURE_ASOF);
    expect([r2?.date, r2?.estimated, r2?.value, r2?.rawState, r2Prev?.rawState]).toEqual([NEXT, true, HEAD_10Y, "RED", "GREEN"]);
    expect(runRows.find((r) => r.indicatorId === "R7" && r.date === NEXT)?.estimated).toBe(true);
    expect(onNext("R4").length).toBeGreaterThan(0); // premise: R4 scored (and its db-first seam wrote) D
    expect(["R2", "R3", "R4", "R7"].filter((id) => onNext(id).some((r) => r.estimated !== true))).toEqual([]);
    own.gc = false; // the GC would also drop a shadowed estimate — pin the sweep
    const loose = (id: string) => onNext(id).filter((r) => r.estimated === true && Date.parse(r.runAt) !== Date.parse(eod.firedAt));
    // R8 (weekly, off DAILY_ROSTER and every estimate-sourced roster): an estimate under a print on the same date.
    await own.recordReadings([makeStoredReading("R8", { date: NEXT, value: 1, estimated: true })], `${NEXT}T23:00:00.000Z`);
    await own.recordReadings([makeStoredReading("R8", { date: NEXT, value: 2 })], `${NEXT}T23:30:00.000Z`);
    // Treasury down: no D+1 head, nothing estimate-sourced
    await runCycleWith(fredAt(NEXT, async () => []), own, monotonicClock("2026-02-03T22:00:00.000Z"));
    expect((await own.getSeries("R4", 10)).find((p) => p.date === NEXT)).not.toHaveProperty("estimated");
    expect([loose("R4"), loose("R8")]).toEqual([[], []]);
  });
});

// Lint (the closes provider meta source): EVERY `fetchDailyCloses` symbol serves a
// meta-close D obs; any fetch site that scores or persists it without `markEstimateSourced` leaves a FINAL D row.
describe("closes-provider meta close on EVERY symbol, EOD run - no id persists a FINAL D row", () => {
  const NEXT = "2026-02-02"; // the session after FIXTURE_ASOF (Fri)

  test("every row dated D is `estimated` (the run's, the seams', the post-persist tail's); EXSH_GATE's D run row is scored off the meta close", async () => {
    const base = deepHcxCloses(); // the calm fixture degrades HCX out — deepen it so its fetch site is covered too
    const symbols = new Set<string>();
    const feeds = fakeFeeds({
      fetchDailyCloses: async (symbol, opts) => {
        symbols.add(symbol);
        const calm = await base(symbol, opts);
        // EXSH.DE's meta close halves — past every EXSH_GATE cut, so D's state differs from D-1's calm one.
        return calm.length === 0 ? calm : [...calm, { date: NEXT, value: calm.at(-1)!.value * (symbol === "EXSH.DE" ? 0.5 : 1), estimated: true as const }];
      },
    });
    // A prior SB pair, so the NAV chain links off the fetched closes (an unseeded chain seeds at NAV_BASE, no input).
    await store.recordReadings(["SB_STRAT", "SB_BENCH"].map((id) => makeStoredReading(id, { date: "2026-01-29", value: 100 })), SEED_RUN_AT);
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    const gate = (await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "EXSH_GATE");
    const prev = (await store.getSeries("EXSH_GATE", 10)).find((p) => p.date === FIXTURE_ASOF);
    expect(prev).toBeDefined(); // premise: D-1 scored, so the state comparison is not vacuous
    expect([gate?.date, gate?.estimated, gate?.state === prev?.state]).toEqual([NEXT, true, false]);
    const onNext = store.readings.filter((r) => r.date === NEXT);
    expect(symbols.size).toBeGreaterThan(20); // premise: the global feeds, confirmers and seed tail all fetched
    expect(onNext.length).toBeGreaterThan(20); // premise: the meta close reached the store
    expect([...new Set(onNext.filter((r) => r.estimated !== true).map((r) => r.indicatorId))].sort()).toEqual([]);
    expect(onNext.filter((r) => r.indicatorId === "EXSH.DE").map((r) => r.estimated === true)).toEqual([true]);
  });
});
