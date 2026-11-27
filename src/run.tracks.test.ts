import { beforeEach, describe, expect, test } from "vitest";
import type { FeedPorts } from "./feed-ports.js";
import { InMemoryStore } from "./store-memory.js";
import type { Store, StoredReading } from "./store.js";
import { TRACKS, type TrackCtx } from "./tracks.js";
import { makeStoredReading } from "./test-helpers.js";
import * as vixTerm from "./vix_term.js";
import type { Observation } from "./domain-types.js";
import { LADDER } from "./families.js";
import { runScoringCycle } from "./run-cycle.js";
import { seedLegClosesOnCron, wallClock } from "./run-seeds.js";
import { seedGrowthRsOnCron } from "./run-seeds.js";
import { buildStoredRows } from "./run-cycle-persist.js";
import { runSeedTail } from "./run-cycle-seed-tail.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { PERSIST_N, SLOW_HIGH_WINDOW } from "./slow.js";
import { NAV_BASE, SB_BENCH_ID, SB_STRAT_ID, legCloseId, offLadderLegCloseId, navReadingRow } from "./scoreboard.js";
import { growthRsId } from "./growth.js";
import { Y1_MIN_LEGS, Y1_MIN_OBS } from "./y1.js";
import { CALM_GEO, CALM_MOVE, FIXTURE_ASOF, dailyDatesEndingAt, fakeFeeds, fakeNotify, fredFlat, fredMock, installRunTestHooks, monotonicClock, priceCalm, priorAlert, runCycleWith, type FakeFeeds } from "./run.test-helpers.js";
import { INTRADAY_CUTOFF_UTC_MIN, isProvisional } from "./intraday.js";
import { priceLegReadingSeries } from "./pension.js";
import { inputSeriesIdOf } from "./input-series.js";
import { readEnv, type Env } from "./config.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// A ^VIX / ^VIX3M pair resolving to a confirmed CAPITULATION-WATCH: 20d calm
// baseline then 5 closes deep in the capitulation zone (VIX 45 ≥ VIX_CAP 35, ratio
// 1.125 ≥ BACKWARD_CUT, no rollover/easing yet). BOTTOM-FORMING's receding logic is
// unit-tested in bottom.test.ts; this fixture proves the run loop (`run-cycle-confirmers.ts`) WIRING + isolation.
// vixDate(i): the i-th ISO day (oldest-first) of a window ENDING at the shared asOf (FIXTURE_ASOF).
// Every print lands on or before asOf: a vix date AFTER asOf would leak a future print into the
// daily containment grid and re-arm the very coverage floor this anchoring removes.
const VIX_DATE_SPAN = 125;
const vixDate = (i: number): string =>
  new Date(Date.parse(FIXTURE_ASOF) - (VIX_DATE_SPAN - 1 - i) * 86_400_000).toISOString().slice(0, 10);
function vixCapitulation(): { front: Observation[]; back: Observation[] } {
  const front: Observation[] = [];
  const back: Observation[] = [];
  for (let i = 0; i < 25; i++) {
    const inCap = i >= 20;
    front.push({ date: vixDate(i), value: inCap ? 45 : 20 });
    back.push({ date: vixDate(i), value: inCap ? 40 : 22 });
  }
  return { front, back };
}

describe("runScoringCycle - VIX bottom track (Stage 4, off-ladder isolation)", () => {
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });

  const feedCapitulation = (): void => {
    const cap = vixCapitulation();
    feeds.fetchVixSeries.mockImplementation(async (s) =>
      s === vixTerm.VIX_SYMBOL ? cap.front : cap.back,
    );
    // R5/VIXCLS (FRED) is R5's LEVEL feed — a SEPARATE feed from the ^VIX/^VIX3M bottom-track
    // legs above. 15 is a realistic spot-VIX level for a vol shock and stays < R5 amber 20, so R5
    // remains GREEN and nothing but the VT capitulation track moves the dial.
    // ⚠ This raise is now INERT, kept only for fixture realism: it used to arm `VOLSHOCK_VIX_FLOOR`
    // (=10), which the 2026-07-16 L1 Stage 2 two-key rework RETIRED along with `volShockSelection`
    // and `VT_SELECT_WEIGHT` (see the `t1dial.ts` docblock). Verified 2026-07-26 by dropping VIXCLS
    // to the fredMock default — all 65 tests of the then-undivided `run.test.ts` stayed green
    // (that file was split by subject 2026-08-09; this one holds the bottom-track subset).
    feeds.fetchSeries.mockImplementation(async (series) =>
      series === "VIXCLS" ? fredFlat(15) : fredMock(series),
    );
  };

  test("confirmed CAPITULATION-WATCH persists bottom_state + pushes its OWN tier; a THROWING bottom push stays isolated (row persists, no push_error)", async () => {
    feedCapitulation();
    // Target the bottom tier by title: the main band pushes FIRST (OK → WATCH), and a main-push failure DOES stamp push_error.
    const notify = fakeNotify({
      pushNtfy: async (m) => {
        if (m?.title?.startsWith("crash-dash bottom")) throw new Error("ntfy 503");
      },
    });

    const env: Env = { NTFY_TOPIC: "tracks-test-env" };
    const alert = await runScoringCycle(wallClock, { env, feeds, store, geo: CALM_GEO, notify });

    // DEC-B4(i) (2026-07-18) MOVED THIS TIER — read the whole note before "fixing" it.
    // The two-key model still holds (credit + rates green ⇒ unarmed ⇒ the dial can never reach the
    // crisis rungs 7–9), but the unarmed CEILING is no longer a flat 3: this fixture is live-and-RED
    // on TWO coincident families (volatility via the VT backwardation ratio 1.125, AND trend), so
    // r=2 ⇒ the graded unarmed floor = 1 + 5×(2/3) = 4.33 ⇒ dangerScore 0.42 ⇒ Caution ⇒ WATCH.
    // The verdict was OK under the retired boolean override (which floored at r=3 only, so r=2 fell
    // to the flat cap of 3 → Calm). This is the ruled behaviour, not a regression — but it IS a
    // notify-tier move the plan did not predict, so it is pinned here explicitly.
    expect(alert.level).toBe("WATCH");
    // The confirmed bottom state rides ON the alert (no separate bottom readings rows).
    expect(alert.bottomState).toBe("CAPITULATION-WATCH");
    // Stage 5: the live numbers driving the state ride on the alert too (latest aligned
    // point of the capitulation fixture: front 45, back 40 → ratio 1.125).
    expect(alert.vix).toBe(45);
    expect(alert.vix3m).toBe(40);
    expect(alert.ratio).toBeCloseTo(45 / 40);
    const persisted = await store.getReadingsForRun(alert.firedAt);
    expect(persisted.some((r) => r.indicatorId.toLowerCase().includes("bottom"))).toBe(false);
    // TWO pushes since DEC-B4(i): the main band now rises OK → WATCH (an upward change ⇒ a main
    // push), alongside the off-ladder bottom tier on its OWN title. The tier separation is what
    // this pins — the bottom read still pushes independently of whatever the main band did.
    expect(notify.pushNtfy).toHaveBeenCalledTimes(2);
    expect(notify.pushNtfy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "crash-dash bottom - CALM -> CAPITULATION-WATCH" }),
      expect.anything(),
    );
    // The bottom tier pushes through the cycle's own env object (identity, so a re-read can't pass).
    expect(notify.pushNtfy.mock.calls.find(([m]) => m.title.startsWith("crash-dash bottom"))?.[1].env).toBe(env);
    // Off-ladder tiers have no pushed_at column: the bottom failure is console-only, never push_error.
    expect(alert.pushError).toBeNull();
    const last = await store.getLastAlert();
    expect(last).not.toBeNull();
    expect(last?.pushError).toBeNull();
  });

  test("baseline skips degraded runs (getLastBand('bottomState')): a null-feed run between two WATCH runs doesn't re-fire", async () => {
    // Count only BOTTOM-tier pushes (distinct "crash-dash bottom" title). The global
    // auto-hold (i7a) is a SEPARATE trigger that legitimately fires here — VIX toggling
    // present→empty moves the vl-family danger field, so the calmest-in-band held sleeve
    // shifts and the ladder push fires. That is the auto-hold working, not the bottom
    // track re-firing; this test isolates the bottom baseline invariant from it.
    const notify = fakeNotify();
    const bottomPushes = (): number =>
      notify.pushNtfy.mock.calls.filter((c) => c[0]?.title?.startsWith("crash-dash bottom")).length;

    // One clock per run, one DAY apart — the cron's one-run-per-day regime this invariant
    // lives in; same-day replace (record_run) would delete run 1's WATCH row under run 2.
    // Runs 1 and 2 are SEEDED rows: the WATCH row, then a degraded run's bottom_state = null.
    await store.recordAlert(
      priorAlert({ date: "2024-01-01", firedAt: "2024-01-01T21:00:00.000Z", bottomState: "CAPITULATION-WATCH" }),
    );
    await store.recordAlert(priorAlert({ date: "2024-01-02", firedAt: "2024-01-02T21:00:00.000Z", bottomState: null }));

    // Run 3: healthy capitulation again → WATCH. The notify baseline is the last
    // NON-NULL state (WATCH from run 1) via getLastBand("bottomState") — NOT run 2's null —
    // so WATCH -> WATCH is not upward and must NOT re-fire. Reading last.bottomState
    // instead (the dup-notify clobber) would see null → CALM baseline → re-push.
    feedCapitulation();
    const healthy = await runCycleWith(feeds, store, monotonicClock("2024-01-03T21:00:00.000Z"), { notify });
    expect(healthy.bottomState).toBe("CAPITULATION-WATCH"); // vacuity guard: the transition re-scored
    expect(bottomPushes()).toBe(0); // NOT 1
  });
});

describe("buildStoredRows - D9 scoreboard NAV chain (SB_STRAT / SB_BENCH write path)", () => {
  // Two closes spanning prior SB date (2026-01-27) → this run's asOf (2026-01-30):
  // the 3-day gap is absorbed as one multi-day ratio.
  const closes = (a: number, b: number): Observation[] => [
    { date: "2026-01-27", value: a },
    { date: "2026-01-30", value: b },
  ];
  const seedPriorSbRows = (bench = 100, date = "2026-01-27") =>
    store.recordReadings(
      [navReadingRow(SB_STRAT_ID, date, 100), navReadingRow(SB_BENCH_ID, date, bench)],
      `${date}T22:00:00.000Z`, // past INTRADAY_CUTOFF_UTC_MIN: a FINAL row
    );
  // Held S&P 500 → SXR8.DE up 10%; benchmark ACWI up 20%; EURUSD=X flat 1 so the USD→EUR conversion stays 48/40.
  const feed = (over: Record<string, Observation[]> = {}): FakeFeeds =>
    fakeFeeds({
      fetchDailyCloses: async (symbol) =>
        over[symbol] ?? (symbol === "SXR8.DE" ? closes(50, 55) : symbol === "ACWI" ? closes(40, 48) : symbol === "EURUSD=X" ? closes(1, 1) : priceCalm(symbol)),
    });
  const sbRows = async (feeds: FeedPorts = fakeFeeds()) => {
    const ctx = { opts: {}, store, runAt: "2026-01-30T22:00:00.000Z", feeds } as unknown as RunBase;
    const { sbStoredReadings } = await buildStoredRows(ctx, priorAlert({ date: "2026-01-30" }), priorAlert(), [], { downside: [], rs: [] });
    return (id: string) => sbStoredReadings.find((r) => r.indicatorId === id);
  };

  test("seed run (no prior SB rows) writes NAV_BASE for both ids, display-only GREEN", async () => {
    const row = await sbRows();
    expect(row(SB_STRAT_ID)).toMatchObject({ date: "2026-01-30", value: NAV_BASE, state: "GREEN", rawState: "GREEN" });
    expect(row(SB_BENCH_ID)).toMatchObject({ date: "2026-01-30", value: NAV_BASE });
  });

  // Equal priors make a per-id MIX-UP invisible: the bulk-read swap (cron-runtime §2 item 1) reading
  // SB_BENCH's prior into `prevStrat` left the whole 4512-test suite green.
  test("each NAV chains off ITS OWN prior row across the multi-day gap - distinct priors, so a per-id mix-up reddens", async () => {
    await seedPriorSbRows(200);
    const row = await sbRows(feed());
    expect(row(SB_STRAT_ID)?.date).toBe("2026-01-30");
    expect(row(SB_STRAT_ID)?.value).toBeCloseTo(110, 9); // 100 × 55/50 — NOT 220 (the bench prior)
    expect(row(SB_BENCH_ID)?.value).toBeCloseTo(240, 9); // 200 × 48/40 — NOT 120 (the strat prior)
  });

  // the closes provider meta source: a D close from the meta quote.
  test.each([
    { symbol: "SXR8.DE", from: 50, to: 55, est: SB_STRAT_ID, final: SB_BENCH_ID, nav: 110 },
    { symbol: "ACWI", from: 40, to: 48, est: SB_BENCH_ID, final: SB_STRAT_ID, nav: 120 },
  ])("$symbol's meta-closed D stamps $est's D row `estimated`; $final stays FINAL", async ({ symbol, from, to, est, final, nav }) => {
    await seedPriorSbRows(100, "2026-01-29");
    const row = await sbRows(feed({ [symbol]: [{ date: "2026-01-27", value: from }, { date: "2026-01-30", value: to, estimated: true }] }));
    expect([row(est)?.date, row(est)?.estimated === true]).toEqual(["2026-01-30", true]);
    expect(row(est)?.value).toBeCloseTo(nav, 9);
    expect(row(final)?.estimated === true).toBe(false);
  });

  test.each([
    { symbol: "SXR8.DE", est: SB_STRAT_ID, final: SB_BENCH_ID },
    { symbol: "ACWI", est: SB_BENCH_ID, final: SB_STRAT_ID },
  ])("`estimateAnchored`: $symbol's meta-closed D with no FINAL $est row on D-1 writes no $est row; $final still FINAL", async ({ symbol, est, final }) => {
    await seedPriorSbRows(); // newest prior 2026-01-27: the previous session 2026-01-29 holds nothing
    const row = await sbRows(feed({ [symbol]: [{ date: "2026-01-27", value: 50 }, { date: "2026-01-30", value: 55, estimated: true }] }));
    expect(row(est)).toBeUndefined();
    expect([row(final)?.date, row(final)?.estimated === true]).toEqual(["2026-01-30", false]);
  });

  test("price-feed failure degrades to NO SB rows without throwing", async () => {
    await seedPriorSbRows();
    const row = await sbRows(
      fakeFeeds({
        fetchDailyCloses: async (symbol) => {
          if (symbol === "ACWI") throw new Error("closes feed down");
          return priceCalm(symbol);
        },
      }),
    );
    expect([row(SB_STRAT_ID), row(SB_BENCH_ID)]).toEqual([undefined, undefined]);
  });
});

// G0 Stage 0.2 — seedGrowthRsOnCron: cache the cross-sectional RS (`GRS_*`) off the `LEGP_*`
// closes, in the post-recordRun seed tail immediately after seedLegClosesOnCron. `runSeedTail` runs
// with a price feed whose newest close lands on the run's asOf, so seedLegClosesOnCron actually
// writes today's LEGP row — the row the ordering pin depends on.
describe("runSeedTail - G0 growth-RS cron seed (Stage 0.2)", () => {
  const D = "2026-01-30"; // the run's asOf (newest FRED + newest price date); today's LEGP lands here
  const dayMs = 86_400_000;

  // 253 (= Y1_MIN_OBS) contiguous daily dates ending the day BEFORE D — the cron adds D itself.
  const histDates: string[] = Array.from({ length: Y1_MIN_OBS }, (_, i) =>
    new Date(Date.UTC(2026, 0, 29) - (Y1_MIN_OBS - 1 - i) * dayMs).toISOString().slice(0, 10),
  );

  // Per-leg pre-seed history with DISTINCT drift + a deterministic wobble, so the cross-section is
  // non-degenerate (sd > 0) AND dailyVol > 0 (a perfectly geometric series has zero return variance
  // and computeLegRs would drop every leg). Values need not be realistic — only distinct.
  const legHistoryRows = (i: number): StoredReading[] =>
    histDates.map((date, t) =>
      navReadingRow(
        legCloseId(LADDER[i]!),
        date,
        (100 + i * 5) * Math.pow(1.0004 + i * 0.00005, t) * (1 + 0.02 * Math.sin(t * 0.7 + i)),
      ),
    );

  // A rising daily price series ending exactly at D (so legCloseReadingRows finds a close at asOf
  // for every leg ticker → today's LEGP row is written). ^MOVE gets a flat calm series (R6 GREEN).
  // Length: the slow track's near-high m-of-n min (SLOW_HIGH_WINDOW + PERSIST_N − 1 = 272) + margin.
  const PRICE_LEN = SLOW_HIGH_WINDOW + PERSIST_N + 7;
  const priceSeriesEndingAtD = (flat?: number): Observation[] =>
    Array.from({ length: PRICE_LEN }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 30) - (PRICE_LEN - 1 - i) * dayMs).toISOString().slice(0, 10),
      value: flat ?? 100 * Math.pow(1.001, i),
    }));
  const priceMockD = async (symbol: string): Promise<Observation[]> =>
    symbol === "^MOVE" ? priceSeriesEndingAtD(CALM_MOVE) : priceSeriesEndingAtD();

  const seedLegHistory = async (s: InMemoryStore = store): Promise<void> => {
    for (let i = 0; i < LADDER.length; i++) {
      await s.recordReadings(legHistoryRows(i), "2025-01-01T00:00:00.000Z");
    }
  };

  const calmFeeds = (): FakeFeeds => fakeFeeds({ fetchSeries: fredMock, fetchDailyCloses: priceMockD, fetchEbp: async () => fredFlat(1) });

  const seedTail = (s: InMemoryStore = store, feeds: FeedPorts = calmFeeds()): Promise<void> =>
    runSeedTail({ store: s, clock: monotonicClock(`${D}T22:00:00.000Z`), feeds } as unknown as RunBase, [], D);

  /** The bulk read the growth seed starves on — a failing store is an input, not a spy. */
  class BulkReadFailStore extends InMemoryStore {
    override async getSeriesBulk(): Promise<never> {
      throw new Error("bulk read failed");
    }
  }

  test("one seed tail seeds GRS_* for ≥ Y1_MIN_LEGS legs, newest GRS_* date === newest LEGP_* date (reddens if the seeds are swapped)", async () => {
    await seedLegHistory();

    await seedTail();

    const newestOf = async (id: string): Promise<string | undefined> =>
      (await store.getSeries(id, Y1_MIN_OBS + 40)).map((p) => p.date).sort().at(-1);

    // Pick a leg the cross-section actually ranked (has a GRS row) and compare its GRS/LEGP axes.
    let checked = 0;
    for (const sleeve of LADDER) {
      const grsDate = await newestOf(growthRsId(sleeve));
      if (grsDate === undefined) continue;
      expect(grsDate).toBe(D); // today's close is on the axis → RS dated today
      expect(grsDate).toBe(await newestOf(legCloseId(sleeve)));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(Y1_MIN_LEGS); // the seed claim itself + vacuity guard: the cycle ranked ≥ Y1_MIN_LEGS legs
  });

  test("D's `estimated` LEGP row is on the GRS axis like the push - GRS dated D, not D-1", async () => {
    await seedLegHistory();
    await store.recordReadings(LADDER.map((sl, i) => ({ ...navReadingRow(legCloseId(sl), D, 120 + i), estimated: true })), "2026-01-30T22:00:00.000Z");
    await seedGrowthRsOnCron(store, monotonicClock("2026-01-30T23:00:00.000Z"), D);
    const grsDates = await Promise.all(LADDER.map(async (sl) => (await store.getSeries(growthRsId(sl), 5)).at(-1)?.date));
    expect(grsDates.filter((d) => d === D).length).toBeGreaterThanOrEqual(Y1_MIN_LEGS);
  });

  test("starve-first: a rejecting getSeriesBulk leaves the seed tail green and writes zero GRS_* rows", async () => {
    const failing = new BulkReadFailStore();
    await seedLegHistory(failing);

    await expect(seedTail(failing)).resolves.toBeUndefined();

    let grsRows = 0;
    for (const sleeve of LADDER) {
      grsRows += (await failing.getSeries(growthRsId(sleeve), 10)).length;
    }
    expect(grsRows).toBe(0);
    // LEGP was still written (seedLegClosesOnCron is independent of the growth seed's failure).
    expect((await failing.getSeries(legCloseId(LADDER[0]!), 10)).length).toBeGreaterThan(0);
  });
});

// ── Venue-lagged legs (2026-08-19 prod defect) ───────────────────────────────────────────────
// `seedLegClosesOnCron` used to build rows for `[asOf]` ALONE. Seven of the nine legs quote Xetra
// (`.DE`) and that feed publishes a session LATER than the US one: at the 22:00 UTC
// cron the newest `.DE` close is `asOf - 1` (measured live 2026-08-19 — `XDEV.DE` newest 2026-08-17
// against `SMH` 2026-08-18). So `legCloseReadingRows` found no close at `asOf` for those seven and
// skipped them EVERY cron: prod holds ZERO cron-written `LEGP_*` rows for them since June, and
// `GRS_*` froze on the stale date-intersection (`rsAxisNewest`). Only the manual/backfill runs whose
// asOf happened to trail the feed ever wrote them. The seed now walks a bounded catch-up window, so
// each leg lands on its OWN newest close at or before `asOf`.
// The G0 describe above cannot see this: its price mock ends EVERY ticker exactly on `asOf`.
describe("seedLegClosesOnCron - a venue that publishes a day behind asOf still gets rows", () => {
  const D = "2026-01-30";
  const dayMs = 86_400_000;
  const seriesEndingAt = (last: string, len = 30): Observation[] =>
    Array.from({ length: len }, (_, i) => ({
      date: new Date(Date.parse(`${last}T00:00:00Z`) - (len - 1 - i) * dayMs).toISOString().slice(0, 10),
      value: 100 * Math.pow(1.001, i),
    }));
  // Xetra one session behind; the FX line is current.
  const lagMock = async (symbol: string): Promise<Observation[]> =>
    seriesEndingAt(symbol.endsWith(".DE") ? "2026-01-29" : D);
  const lagFeeds: Pick<FeedPorts, "fetchDailyCloses"> = { fetchDailyCloses: lagMock };

  test("all nine legs write, the .DE legs dated their own newest close - and a re-run is idempotent", async () => {
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(), D, lagFeeds);

    for (const sleeve of LADDER) {
      const rows = await store.getSeries(legCloseId(sleeve), 30);
      expect(rows.length, `${legCloseId(sleeve)} wrote no row`).toBeGreaterThan(0);
      expect(rows.at(-1)!.date <= D).toBe(true);
    }
    const before = await store.getSeries(legCloseId("EM"), 30);
    expect(before.at(-1)!.date).toBe("2026-01-29"); // its own venue date, not asOf

    await seedLegClosesOnCron(store, readEnv(), monotonicClock(), D, lagFeeds); // same asOf again (prod re-runs a day)
    const after = await store.getSeries(legCloseId("EM"), 30);
    expect(after.map((p) => p.date)).toEqual(before.map((p) => p.date)); // no backwards chaining, no duplicate date
    // R4: a FINAL date is never re-appended, whatever the feed served.
    expect(store.readings.filter((r) => r.indicatorId === legCloseId("EM") && r.date === "2026-01-29")).toHaveLength(1);
  });

  test("A8: a PROVISIONAL newest row is not the chain anchor - the EOD seed rewrites it final", async () => {
    const id = legCloseId("EM");
    await store.recordReadings([makeStoredReading(id, { date: "2026-01-28", value: 50 })], "2026-01-28T22:00:00.000Z");
    const provAt = new Date(Date.parse("2026-01-29T00:00:00Z") + (INTRADAY_CUTOFF_UTC_MIN - 1) * 60_000).toISOString();
    await store.recordReadings([makeStoredReading(id, { date: "2026-01-29", value: -1 })], provAt);

    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, lagFeeds);

    const d = (await store.getSeries(id, 5)).find((p) => p.date === "2026-01-29")!;
    expect({ provisional: isProvisional(d), value: d.value }).toEqual({ provisional: false, value: 50 * 1.001 });
  });

  test("A8: with NO final row in the window the newest (provisional) row still anchors - never a raw-close restart", async () => {
    const id = legCloseId("EM");
    const provAt = new Date(Date.parse("2026-01-28T00:00:00Z") + (INTRADAY_CUTOFF_UTC_MIN - 1) * 60_000).toISOString();
    await store.recordReadings([makeStoredReading(id, { date: "2026-01-28", value: 50 })], provAt);

    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, lagFeeds);

    expect((await store.getSeries(id, 5)).find((p) => p.date === "2026-01-29")?.value).toBe(50 * 1.001);
  });

  // Defect 3: the closes provider nulls EURUSD=X's D-1 bar, so a USD leg's D-1 close
  // converted at the PREVIOUS FX close. The stored `DEXUSEU` row fills the hole: the seed must write exactly what a
  // live feed carrying that D-1 FX bar writes (reference run on a fresh store). 2.0 vs the ~1.0 fixture FX discriminates.
  test("Defect 3: a USD leg converts D-1 at the stored EURUSD=X D-1 bar when the live FX feed nulls it", async () => {
    const dM1 = "2026-01-29";
    const withFx = (fx: Observation[]): Pick<FeedPorts, "fetchDailyCloses"> => ({
      fetchDailyCloses: async (symbol) => (symbol === "EURUSD=X" ? fx : seriesEndingAt(D)),
    });
    const fxFull = seriesEndingAt(D).map((o) => (o.date === dM1 ? { date: dM1, value: 2 } : o));
    const id = legCloseId("Semis");
    const ref = new InMemoryStore();
    await seedLegClosesOnCron(ref, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, withFx(fxFull));
    const want = (await ref.getSeries(id, 30)).find((p) => p.date === dM1)!.value;

    await store.recordReadings(priceLegReadingSeries(inputSeriesIdOf("EURUSD=X")!, [{ date: dM1, value: 2 }]), `${dM1}T22:00:00.000Z`);
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, withFx(fxFull.filter((o) => o.date !== dM1)));
    expect((await store.getSeries(id, 30)).find((p) => p.date === dM1)?.value).toBe(want);
  });

  // [USER] 2026-10-05 (LEGP_EUFIN missed Fri 2026-10-02 until Monday's EOD): the live `.DE` feed ended at D-1
  // (the closes provider null-closes the D bar until the next session — `closesMetaClose` in prices.ts now closes it). The settled evening `EXSH.DE` row (written after the EU close) is
  // the only copy of D — the seed must chain to it instead of waiting for the next EOD.
  test("a .DE leg whose live feed ends at D-1 chains to D from its settled stored evening row", async () => {
    const xetraD = "2026-01-29"; // lagMock: every .DE series ends here
    const dP1 = "2026-01-30";
    const id = legCloseId("EU-Fin");
    await store.recordReadings([makeStoredReading(id, { date: xetraD, value: 50 })], `${xetraD}T22:00:00.000Z`);
    const liveD = seriesEndingAt(xetraD).at(-1)!.value;
    await store.recordReadings(priceLegReadingSeries("EXSH.DE", [{ date: dP1, value: liveD * 1.02 }]), `${dP1}T18:31:00.000Z`);

    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${dP1}T22:00:00.000Z`), dP1, lagFeeds);
    const head = (await store.getSeries(id, 5)).find((p) => p.date === dP1);
    expect(head?.estimated).toBe(true); // the stored price, not the live vintage — a preview only
    expect(head?.value).toBeCloseTo(50 * 1.02, 10);

    // A mid-series null bar (the closes provider served D+1's in-progress bar but still not D — 2026-10-02):
    // D is a hole fill from the same stored price, so it stays an estimate.
    const dP2 = "2026-01-31";
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${dP2}T09:00:00.000Z`), dP1, {
      fetchDailyCloses: async (symbol) => (symbol.endsWith(".DE") ? seriesEndingAt(dP2).filter((o) => o.date !== dP1) : seriesEndingAt(dP2)),
    });
    expect((await store.getSeries(id, 5)).find((p) => p.date === dP1)?.estimated).toBe(true);

    // Next morning the live feed carries D: D re-chains FINAL off the live ratio (an ex-div lands here), superseding the estimate.
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${dP2}T10:00:00.000Z`), dP1, { fetchDailyCloses: async () => seriesEndingAt(dP1) });
    const final = (await store.getSeries(id, 5)).find((p) => p.date === dP1);
    expect({ estimated: final?.estimated === true, value: final?.value }).toEqual({ estimated: false, value: 50 * 1.001 });
  });

  test("`estimateAnchored`: two stored-only sessions write D-1 `estimated` off the FINAL D-2, and D off D-1's settled EU close", async () => {
    const [dM2, dM1] = ["2026-01-28", "2026-01-29"];
    const id = legCloseId("EU-Fin");
    await store.recordReadings([makeStoredReading(id, { date: dM2, value: 50 })], `${dM2}T22:00:00.000Z`);
    const v = seriesEndingAt(dM2).at(-1)!.value;
    await store.recordReadings(priceLegReadingSeries("EXSH.DE", [{ date: dM1, value: v * 1.02 }, { date: D, value: v * 1.04 }]), `${D}T18:31:00.000Z`);
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, {
      fetchDailyCloses: async (symbol) => (symbol === "EXSH.DE" ? seriesEndingAt(dM2) : lagMock(symbol)),
    });
    const rows = store.readings.filter((r) => r.indicatorId === id && r.date > dM2);
    expect(rows.map((r) => [r.date, r.estimated === true])).toEqual([[dM1, true], [D, true]]);
  });

  // the closes provider meta source: the live `.DE` feed closes D from the meta
  // quote (`estimated`) — a quote, not the settled bar, so LEGP's D row is `estimated` until D+1's bar re-chains it FINAL.
  test("a .DE leg's meta-closed D writes LEGP `estimated`; the settled bar re-chains D FINAL and sweeps the estimate", async () => {
    const xetraDm1 = "2026-01-29";
    const id = legCloseId("EU-Fin");
    await store.recordReadings([makeStoredReading(id, { date: xetraDm1, value: 50 })], `${xetraDm1}T22:00:00.000Z`);
    const v = seriesEndingAt(xetraDm1).at(-1)!.value;
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(`${D}T22:00:00.000Z`), D, {
      fetchDailyCloses: async (symbol) =>
        symbol === "EXSH.DE" ? [...seriesEndingAt(xetraDm1), { date: D, value: v * 1.02, estimated: true }] : lagMock(symbol),
    });
    const onD = () => store.readings.filter((r) => r.indicatorId === id && r.date === D);
    expect(onD().map((r) => r.estimated === true)).toEqual([true]);
    expect(onD()[0]!.value).toBeCloseTo(50 * 1.02, 10);

    await seedLegClosesOnCron(store, readEnv(), monotonicClock("2026-01-31T22:00:00.000Z"), D, { fetchDailyCloses: async () => seriesEndingAt(D) });
    expect(onD().map((r) => [r.estimated === true, r.value])).toEqual([[false, 50 * 1.001]]);
  });
});

// ── Off-ladder isolation (code-review 2026-09-22) ─────────────────────────────────────────────
// `LEGP_COMMOD` (LYTR.DE) once rode the SAME `Promise.all` as the nine ladder tickers, so a LYTR.DE
// rejection (`fetchDailyCloses` throws on total failure) aborted the whole cron seed — all nine
// ladder legs went unwritten. The off-ladder ticker now fetches in an isolated arm: its rejection
// logs one warn line and yields [] for LEGP_COMMOD, leaving the nine ladder LEGP_* seeds intact.
describe("seedLegClosesOnCron - a rejected off-ladder fetch still seeds the nine ladder legs", () => {
  const D = "2026-01-30";
  const dayMs = 86_400_000;
  const seriesEndingAt = (last: string, len = 30): Observation[] =>
    Array.from({ length: len }, (_, i) => ({
      date: new Date(Date.parse(`${last}T00:00:00Z`) - (len - 1 - i) * dayMs).toISOString().slice(0, 10),
      value: 100 * Math.pow(1.001, i),
    }));

  test("nine ladder LEGP_* rows written, no LEGP_COMMOD row, when the off-ladder feed rejects", async () => {
    await seedLegClosesOnCron(store, readEnv(), monotonicClock(), D, {
      fetchDailyCloses: async (symbol) => {
        if (symbol === "LYTR.DE") throw new Error("off-ladder feed down");
        return seriesEndingAt(D);
      },
    });

    for (const sleeve of LADDER) {
      const rows = await store.getSeries(legCloseId(sleeve), 30);
      expect(rows.length, `${legCloseId(sleeve)} wrote no row`).toBeGreaterThan(0); // nine legs seed despite the off-ladder reject
    }
    expect((await store.getSeries(offLadderLegCloseId("Commodities"), 30)).length).toBe(0); // rejected off-ladder → no COMMOD row
  });
});

/**
 * The slow track's live row is dated by QQQ's newest close, never the run's FRED-driven asOf
 * (Defect 4 — the bottom track's rule above, applied to slow).
 * Vacuity guard: QQQ's newest (07-10) and the run's asOf (07-17) DIFFER.
 */
describe("slow track storedSeries - dates the live row by QQQ's newest close, not the run", () => {
  const QQQ_LATEST = "2026-07-10";
  const RUN_ASOF = "2026-07-17";
  const weekdaysEndingAt = (n: number, end: string): string[] => {
    const out: string[] = [];
    for (let t = Date.parse(end); out.length < n; t -= 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    }
    return out;
  };

  test("every slow leg's newest row carries QQQ's newest date", async () => {
    const dates = weekdaysEndingAt(SLOW_HIGH_WINDOW + PERSIST_N + 30, QQQ_LATEST);
    const feeds = fakeFeeds({ fetchSeries: async () => dates.map((date) => ({ date, value: 15 })) });
    const slowTrack = TRACKS.find((t) => t.baselineField === "slowBand")!;
    const runAt = `${RUN_ASOF}T22:00:00.000Z`;
    const ctx = {
      store: {} as Store,
      qqq: dates.map((date, i) => ({ date, value: 100 * Math.pow(1.001, i) })),
      vixFront: [],
      vix3mBack: [],
      runAt,
      env: {},
      // No `seriesScorerFor` ⇒ the direct (fullHistory) arm; `dbFirst` here only carries the injected ports.
      dbFirst: { store: {} as Store, runAt, feeds },
    } satisfies TrackCtx;
    const series = [...(await slowTrack.score(ctx)).storedSeries(RUN_ASOF).values()];
    expect(series.length).toBeGreaterThan(0); // premise: the slow track scored
    for (const s of series) expect(s.at(-1)!.date).toBe(QQQ_LATEST);
    expect(series.flat().some((r) => r.date === RUN_ASOF)).toBe(false);
  });
});

/**
 * Review C1 (Stage 5, E2): the EOD R5 `estimated` head never reaches the slow track — its R5 feed is
 * DB-first, and `resolveDbFirstArm` merges prints only. Same feed, same QQQ, one store additionally
 * holding an extreme `estimated` R5 row on D (VIXCLS not yet posted): every slow projection — band
 * columns, the push decision + payload, the persisted legs — is identical. Vacuity guard: the
 * estimate (60) breaks the low-vol streak the prints (12) build, so a merged estimate moves the legs.
 */
describe("slow track - an `estimated` R5 row never scores into the slow band or its push (C1)", () => {
  test("slow projections are identical with and without a stored R5 estimate on D", async () => {
    const dates = dailyDatesEndingAt(SLOW_HIGH_WINDOW + PERSIST_N + 30, "2026-07-10");
    const D = dates.at(-1)!;
    const feeds = fakeFeeds({ fetchSeries: async () => dates.slice(0, -1).map((date) => ({ date, value: 12 })) });
    const slowTrack = TRACKS.find((t) => t.baselineField === "slowBand")!;
    const runAt = `${D}T22:00:00.000Z`;
    const project = async (s: InMemoryStore) => {
      const r = await slowTrack.score({
        store: s,
        qqq: dates.map((date, i) => ({ date, value: 100 * Math.pow(1.001, i) })),
        vixFront: [],
        vix3mBack: [],
        runAt,
        env: {},
        dbFirst: {
          store: s,
          runAt,
          feeds,
          seriesScorerFor: async () => (pts) =>
            pts.map((p) => ({ indicator: { id: "R5" } as never, date: p.date, level: p.value, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null })),
        },
      } satisfies TrackCtx);
      return { alert: r.alertFields, line: r.consoleLine, note: r.notification(null, D), series: [...r.storedSeries(D)] };
    };
    const withEst = new InMemoryStore();
    await withEst.recordReadings([makeStoredReading("R5", { date: D, value: 60, estimated: true })], runAt);
    const a = await project(withEst);
    expect("slowBand" in a.alert && a.alert.slowBand).toBeTruthy(); // premise: the slow track scored
    expect(a).toEqual(await project(new InMemoryStore()));
  });
});
