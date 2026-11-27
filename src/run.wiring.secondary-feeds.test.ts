import { describe, expect, test, vi } from "vitest";
import * as vixTerm from "./vix_term.js";
import { estimatorOf } from "./nowcast-score.js";
import { InMemoryStore } from "./store-memory.js";
import { priceLegReadingSeries } from "./pension.js";
import { isTargetClosed } from "./market-closures.js";
import * as scorersComposite from "./scorers-composite.js";
import { toStoredReadings } from "./store-project.js";
import { DOWNSIDE_DETECTOR_IDS, RS_LEG_IDS } from "./registry-price.js";
import { FEED_OF, INDICATORS } from "./registry-fred.js";
import { ID_SETS } from "./registry.js";
import { CHART_ONLY_IDS } from "./registry-composite.js";
import type { Observation, Reading } from "./domain-types.js";
import { scorePriceIndicators } from "./run-dbfirst.js";
import { createRunCtx } from "./run-cycle-ctx.js";
import { createGraft } from "./run-cycle-graft.js";
import { loadScoringInputs } from "./run-cycle-fred.js";
import { startConfirmersAndTracks } from "./run-cycle-confirmers.js";
import { SYNTH_HISTORY_LIMIT } from "./synth-cuts.js";
import { peekDegradeLog, resetDegradeLog } from "./tracks.js";
import { scoreGlobalFeeds } from "./run-cycle-feeds.js";
import { CG, VXNCLS, VXNT } from "./registry-composite.js";
import { ECY } from "./registry-fred.js";
import { G1 } from "./registry-geo.js";
import { deepArmSince, TAIL_DAYS } from "./series-db-first.js";
import type { FeedPorts } from "./feed-ports.js";
import { CG_DESCRIPTOR, VT_DESCRIPTOR } from "./family-descriptor-rows.js";
import { DEEP_LOOKBACK_DAYS } from "./lookback.js";
import { isoDay } from "./dates.js";
import type { SeriesPoint } from "./store.js";
import { SYNTH_PRIOR_IDS } from "./domain-cuts.js";
import { SB_BENCH_ID, SB_STRAT_ID } from "./scoreboard.js";
import {
  ALL_CMP_IDS,
  FIXTURE_ASOF,
  FRED_COUNT,
  cmpIds,
  sovereignGreen,
  deepVxntPorts,
  VXNT_DEEP_K,
  fredMock,
  monotonicClock,
  priceCalm,
  fakeFeeds,
  runCycleWith,
  seedHyoasCalib,
  type FakeFeeds,
  installRunTestHooks,
  f7Flat,
  dfii10Ramp,
  runWarns,
} from "./run.test-helpers.js";
import { readEnv } from "./config.js";
import { FAST_CONFIRMERS } from "./confirmers.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { ECY_MIN_OBS } from "./family-descriptor-rows.js";
import { backfillAll } from "../scripts/backfill.js";
import { stub } from "../scripts/backfill.test-helpers.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// The REAL leg fetch: a port test drives it over the FRED port.
const realFetchVixSeries = vixTerm.fetchVixSeries;
const RUN_AT = `${FIXTURE_ASOF}T22:55:00.000Z`;
/** The ports `realFeeds` binds to `noFreeSource` (plus the official-leg walk, whose index-EOD source is one). */
const NO_FREE_SOURCE_PORTS = ["fetchSovereignBars", "fetchSovereignQuote", "fetchDramSpot", "fetchOfficialLeg"] as const;

/** A store whose `getSeries` rejects on `failsOn(id, limit)` — the failure is an INPUT (no store spy); seeded like the hook store. */
class ReadFailStore extends InMemoryStore {
  constructor(private readonly failsOn: (id: string, limit: number) => boolean) {
    super();
    seedHyoasCalib(this);
  }
  override async getSeries(...a: Parameters<InMemoryStore["getSeries"]>): ReturnType<InMemoryStore["getSeries"]> {
    if (this.failsOn(a[0], a[1])) throw new Error("store read failed");
    return super.getSeries(...a);
  }
}

/** The confirmers + tracks stage alone on `feeds`/`own`, at the fixture close; returns this stage's degrade scopes. */
async function confirmerDegrades(feeds: FakeFeeds, own: InMemoryStore = store): Promise<string[]> {
  resetDegradeLog();
  const base = createRunCtx(monotonicClock(RUN_AT), { env: readEnv(), feeds, store: own });
  const { calib, seriesScorerFor } = await loadScoringInputs(base);
  await startConfirmersAndTracks(Object.assign(base, { graft: createGraft(base) }), calib, seriesScorerFor);
  return peekDegradeLog().map((e) => e.scope);
}

/** `fetchDailyCloses` with `symbol` rejecting `msg`, every other symbol the calm fixture. */
const closesRejecting = (symbol: string, msg: string): FeedPorts["fetchDailyCloses"] => async (s) =>
  s === symbol ? Promise.reject(new Error(msg)) : priceCalm(s);

/** The GLOBAL feed table alone (`scoreGlobalFeeds`) on a wall-clock ctx: its collected feed-date grids + each id's newest reading date. */
async function globalFeeds(feeds: FakeFeeds) {
  const base = createRunCtx(() => new Date().toISOString(), { env: readEnv(), feeds, store });
  const { calib } = await loadScoringInputs(base);
  const { feed } = await scoreGlobalFeeds(Object.assign(base, { graft: createGraft(base) }), calib);
  return { collected: base.feedDates, newestOf: (id: string) => feed(id).find((r) => r.indicator.id === id)?.date };
}

describe("runScoringCycle - wiring (fetch → score → persist → push)", () => {
  test("E7 GT-degraded: an expensive ECY tail with GT non-live persists NO row (deferred-resolve null)", async () => {
    const f7 = f7Flat();
    // Non-vacuity at the seam: the rising real yield makes the tail EXPENSIVE, so GT GREEN grades it AMBER.
    expect(scorersComposite.scoreEcy(ECY, f7, dfii10Ramp(1, 3), "GREEN", f7.at(-1)!.date)?.state).toBe("AMBER");

    // ONLY GT's ACWI leg down: gtState resolves null, so scoreEcy OMITS (never fabricates
    // a gate verdict) while every other id persists normally.
    const feeds = fakeFeeds({
      fetchSeries: async (series, opts) =>
        series === "DFII10" && (opts?.fullHistory || opts?.since !== undefined) ? dfii10Ramp(1, 3) : fredMock(series),
      fetchDailyCloses: closesRejecting("ACWI", "acwi feed unavailable"),
      fetchCape: async () => f7,
    });
    const b = await runCycleWith(feeds, store);
    const idsB = new Set(
      (await store.getReadingsForRun(b.firedAt)).map((r) => r.indicatorId),
    );
    expect(idsB).not.toContain("GT"); // premise: the gate input really went non-live this run
    expect(idsB).not.toContain("ECY");
    expect(idsB).toContain("R1"); // ...while the FRED core persisted normally
    expect(idsB).toContain("F4"); // ...and the rest of the price feed
    expect(b.degraded?.map((d) => d.scope)).toContain(
      "[ecy] ECY omitted this run",
    );
  });

  /** ECY's monthly CAPE + DFII10 inputs ending at FIXTURE_ASOF's month (`open`), and the restate's feed ports over them. */
  const ecyFixture = () => {
    const n = ECY_MIN_OBS + 12;
    const [y, m] = FIXTURE_ASOF.split("-").map(Number);
    const month = (i: number): string => {
      const abs = y! * 12 + (m! - 1) - (n - 1 - i);
      return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`;
    };
    const cape: Observation[] = Array.from({ length: n }, (_, i) => ({ date: month(i), value: 40.6 }));
    const dfii10: Observation[] = Array.from({ length: n }, (_, i) => ({ date: month(i), value: 3 - (2 * i) / (n - 1) }));
    const restateDeps: typeof stub = { ...stub, fetchCape: async () => cape, fetchFred: async (s, o) => (s === "DFII10" ? dfii10 : stub.fetchFred(s, o)) };
    return { cape, dfii10, closed: month(n - 2), open: month(n - 1), restateDeps };
  };

  type CronTwin = { series: Reading[]; estimateDates?: readonly string[] };
  /** One twin-writer world: the cron's store + feeds at `runAt`, the restate's store + deps (+ `years`), and the id's own post-checks. */
  type TwinWorld = {
    runAt: string;
    years?: number;
    own: InMemoryStore;
    feeds: FakeFeeds;
    restated: InMemoryStore;
    restateDeps: typeof stub;
    after: (cron: CronTwin, rows: Map<string, SeriesPoint>) => Promise<void>;
  };

  const ecyTwinWorld = async (): Promise<TwinWorld> => {
    const { cape, dfii10, closed, open, restateDeps } = ecyFixture();
    // The 2026-11-06 drift: the cron's stored F7 froze the closed month at its first-seen CAPE head.
    const own = new ReadFailStore(() => false);
    await own.recordReadings(cape.map((o) => makeStoredReading("F7", { date: o.date, value: o.date === closed ? 41.38 : o.value })), "2020-01-01T00:00:00.000Z");
    const feeds = fakeFeeds({
      fetchCape: async () => cape,
      fetchSeries: async (series, opts) => (series === "DFII10" && opts?.since !== undefined ? dfii10 : fredMock(series)),
    });
    const restated = new InMemoryStore();
    // A FINAL open-month row (the 11-06 restate's) the fixed restate must rewrite `estimated`.
    await restated.recordReadings([makeStoredReading("ECY", { date: open, value: 0 })], "2020-01-01T00:00:00.000Z");
    // ...and a cron run's open-month snapshot (`run_at` = its `fired_at`), which `getReadingsForRun` serves: it must survive.
    const firedAt = "2020-01-02T00:00:00.000Z";
    await restated.recordRun([makeStoredReading("ECY", { date: open, value: 7, estimated: true })], firedAt, makeAlert({ date: open, firedAt }));
    const after = async (cron: CronTwin, rows: Map<string, SeriesPoint>) => {
      expect(cron.estimateDates).toEqual([open]);
      expect(rows.get(closed)?.value).toBe(cron.series.find((r) => r.date === closed)?.level);
      expect(rows.get(closed)?.estimated).not.toBe(true);
      expect(rows.get(open)?.estimated).toBe(true);
      expect((await restated.getReadingsForRun(firedAt)).map((r) => [r.indicatorId, r.value])).toEqual([["ECY", 7]]);
      expect(restated.readings.some((r) => r.indicatorId === "ECY" && r.date === open && r.estimated !== true)).toBe(false); // the FINAL row is gone
    };
    return { runAt: RUN_AT, years: 100, own, feeds, restated, restateDeps, after };
  };

  // CG: the prod-default restate over the cron's own store (anchored warm-up head + scored rows), then the cron's next run.
  const cgTwinWorld = async (): Promise<TwinWorld> => {
    const runAt = "2026-11-06T22:55:00.000Z";
    const end = runAt.slice(0, 10);
    const [HG, GC] = CG_DESCRIPTOR.inputs;
    const legs = new Map<string, Observation[]>([[HG, []], [GC, []]]);
    // Every calendar day: even a specCutoff-pruned store clears `needRows`, so the cron takes the TAIL arm (weekdays fall under it).
    for (let d = new Date("2004-01-01T00:00:00Z"), i = 0; isoDay(d) <= end; d.setUTCDate(d.getUTCDate() + 1), i++) {
      legs.get(HG)!.push({ date: isoDay(d), value: 3 + 0.6 * Math.sin(i / 53) + 0.9 * Math.sin(i / 301) });
      legs.get(GC)!.push({ date: isoDay(d), value: 1000 + 300 * Math.sin(i / 997) });
    }
    const window = (sym: string, o?: { lookbackDays?: number }) =>
      legs.get(sym)!.filter((p) => p.date >= isoDay(new Date(Date.parse(runAt) - (o?.lookbackDays ?? DEEP_LOOKBACK_DAYS) * 86_400_000)));
    const own = new ReadFailStore(() => false);
    const history = scorersComposite.cgPoints(legs.get(HG)!, legs.get(GC)!).filter((p) => p.date < "2026-10-20");
    const scored = scorersComposite.cgRows(CG, history);
    await own.recordWarmup(history.filter((p) => p.date < scored[0]!.date).map((p) => ({ indicatorId: CG.id, ...p })), "2026-10-25T00:00:00.000Z");
    await own.recordReadings(toStoredReadings(scored), "2026-10-25T00:00:00.000Z"); // FINAL: run_at past every stored date
    const calm = fakeFeeds({}, end).fetchDailyCloses;
    const feeds = fakeFeeds({ fetchDailyCloses: async (s, o) => (legs.has(s) ? window(s, o) : calm(s, o)) }, end);
    const restateDeps: typeof stub = { ...stub, fetchPrices: async (s, o) => (legs.has(s) ? window(s, o) : stub.fetchPrices(s, o)) };
    const after = async ({ series }: CronTwin) => {
      expect(isoDay(new Date(Date.parse(runAt) - DEEP_LOOKBACK_DAYS * 86_400_000)) > scorersComposite.CG_LEVEL_ANCHOR, "premise: a plain 20-year fetch starts after CG_LEVEL_ANCHOR").toBe(true);
      const hgAsks = feeds.fetchDailyCloses.mock.calls.filter((c) => c[0] === HG).map((c) => c[1]?.lookbackDays);
      expect(hgAsks, "premise: the cron took the tail arm").toEqual([TAIL_DAYS]);
      expect(new Set(series.map((r) => r.state)).size, "premise: the level leg moves states").toBeGreaterThan(1);
      // An unbroken base from the anchor: every anchored scored date, none missing.
      const ref = scorersComposite.cgRows(CG, scorersComposite.cgPoints(legs.get(HG)!, legs.get(GC)!));
      expect(series.slice(0, -1).map((r) => r.date)).toEqual(ref.slice(0, series.length - 1).map((r) => r.date));
    };
    return { runAt, own, feeds, restated: own, restateDeps, after };
  };

  test.each([
    { id: "ECY", world: ecyTwinWorld },
    { id: "CG", world: cgTwinWorld },
  ])("$id twin writers: the restate and the cron's next run store one value + state per date", async ({ id, world }) => {
    const w = await world();
    const res = await backfillAll(w.restated, w.restateDeps, { ...(w.years !== undefined ? { years: w.years } : {}), now: new Date(w.runAt), only: [id], restate: [id] });
    expect(res.failures).toEqual([]);
    const rows = new Map((await w.restated.getSeries(id, 100_000)).map((p) => [p.date, p]));
    const base = createRunCtx(monotonicClock(w.runAt), { env: readEnv(), feeds: w.feeds, store: w.own });
    const { calib, seriesScorerFor } = await loadScoringInputs(base);
    const stage = await startConfirmersAndTracks(Object.assign(base, { graft: createGraft(base) }), calib, seriesScorerFor);
    stage.resolveGtState("GREEN");
    const cron = (await stage.scoredConfirmersP)[FAST_CONFIRMERS.findIndex((c) => c.id === id)]!;
    // The newest cron row is the run's gated scalar (`withNewest`), never a twin row.
    const shared = cron.series.slice(0, -1).filter((r) => rows.has(r.date));
    expect(shared.length).toBeGreaterThan(0);
    const split = shared.filter((r) => rows.get(r.date)!.value !== r.level || rows.get(r.date)!.state !== r.state);
    expect(split.map((r) => [r.date, r.level, r.state, rows.get(r.date)!.value, rows.get(r.date)!.state]).slice(0, 5)).toEqual([]);
    await w.after(cron, rows);
  });

  test("the ECY restate keeps an alert run's FINAL row on its estimate date, which then holds the date — logged, not silent", async () => {
    const { open, restateDeps } = ecyFixture();
    const store = new InMemoryStore();
    // A cron run's settled FINAL snapshot of the open month (`run_at` = its `fired_at`, past the obs date: not provisional).
    const firedAt = `${open.slice(0, 8)}02T23:00:00.000Z`;
    await store.recordRun([makeStoredReading("ECY", { date: open, value: 7 })], firedAt, makeAlert({ date: open, firedAt }));
    const res = await backfillAll(store, restateDeps, { years: 100, now: new Date(RUN_AT), only: ["ECY"], restate: ["ECY"] });
    expect(res.failures).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.map((c) => String(c[0]))).toContain(`[backfill] ECY: 1 estimate date(s) held by a settled stored row, not restated: ${open}`);
    expect((await store.getReadingsForRun(firedAt)).map((r) => [r.indicatorId, r.value, r.estimated === true])).toEqual([["ECY", 7, false]]);
    expect((await store.getSeries("ECY", 1000)).find((p) => p.date === open)?.value).toBe(7); // the cron's FINAL still serves
  });

  test.each([
    { intraday: false, effect: "notify" },
    { intraday: true, effect: "trace" },
  ])("a CAPE fetch failure on an intraday=$intraday run degrades at $effect, and ECY records no second notify", async ({ intraday, effect }) => {
    resetDegradeLog();
    const feeds = fakeFeeds({ fetchCape: () => Promise.reject(new Error("CAPE unavailable")) });
    const base = createRunCtx(monotonicClock(RUN_AT), { env: readEnv(), feeds, store, intraday });
    const { calib, seriesScorerFor } = await loadScoringInputs(base);
    const stage = await startConfirmersAndTracks(Object.assign(base, { graft: createGraft(base) }), calib, seriesScorerFor);
    stage.resolveGtState("GREEN");
    await stage.scoredConfirmersP;
    const ecy = peekDegradeLog().filter((e) => /^\[ecy\]/i.test(e.scope)).map((e) => [e.scope, e.effect]);
    expect(ecy).toEqual([["[ECY] CAPE fetch failed - ECY omitted this run", effect]]);
  });

  test("a full run fetches CAPE ONCE: ECY and the F7 seed share the run's memo", async () => {
    const feeds = fakeFeeds({ fetchCape: async () => f7Flat() });
    const own = new ReadFailStore(() => false);
    await runCycleWith(feeds, own, monotonicClock(RUN_AT));
    expect(own.readings.some((r) => r.indicatorId === "F7")).toBe(true); // premise: the F7 seed ran off that fetch
    expect(feeds.fetchCape).toHaveBeenCalledTimes(1);
  });

  test("the oil leg's live hole fills from its stored INPUT_SERIES row", async () => {
    const { leads: [leg], beta } = estimatorOf("G1", "carry-log");
    const full = await priceCalm(leg);
    const [base, hole] = [full.at(-3)!, full.at(-2)!]; // D-1 = the bar the live feed nulls; D-2 = the last WTI print
    // WTI prints end at D-2, so D-1 is the ONLY anchored carry session — reachable only through the filled hole.
    const feeds = fakeFeeds({
      fetchSeries: async (s) => (s === G1.series ? (await fredMock(s)).filter((o) => o.date <= base.date) : fredMock(s)),
      fetchDailyCloses: async (s) => (s === leg ? full.filter((x) => x.date !== hole.date) : priceCalm(s)),
    });
    await store.recordReadings(priceLegReadingSeries(leg, [{ date: hole.date, value: 4242 }]), `${hole.date}T22:00:00.000Z`);
    const alert = await runCycleWith(feeds, store, monotonicClock(RUN_AT));
    // ONE filled feed serves both the estimate points (`intradayNowcastPoints` → the stored `estimated` row) and the push clause.
    const print = (await fredMock(G1.series)).find((o) => o.date === base.date)!.value;
    const carried = print * Math.exp(beta * Math.log(4242 / base.value));
    const est = store.readings.find((r) => r.indicatorId === "G1" && r.date === hole.date && r.estimated);
    expect(est?.value).toBeCloseTo(carried, 9);
    expect(alert.runInputs?.oilEst?.G1).toMatchObject({ date: hole.date, fromDate: base.date });
    expect(alert.runInputs?.oilEst?.G1?.value).toBeCloseTo(carried, 9);
  });

  test("a synth-history store failure and a failed oil-futures close each land a recorded degrade", async () => {
    const leg = estimatorOf("G1", "carry-log").leads[0];
    const feeds = fakeFeeds({ fetchDailyCloses: closesRejecting(leg, "futures down") });
    const synthDown = new ReadFailStore((id, limit) => limit === SYNTH_HISTORY_LIMIT && SYNTH_PRIOR_IDS.includes(id));
    const scopes = await confirmerDegrades(feeds, synthDown);
    expect(scopes).toContain(`[synth] ${[...SYNTH_PRIOR_IDS].join("/")} history read failed - registry priors this run`);
    expect(scopes).toContain(`[oil-nowcast] ${leg} closes unavailable - estimate points omitted`);
  });

  // VT can fire alerts, so its omission must reach the persisted degrade trace, not the console alone.
  test.each([
    {
      cause: "a VIXCLS feed failure",
      arrange: (feeds: FakeFeeds) => {
        feeds.fetchVixSeries.mockImplementation(realFetchVixSeries); // the real leg fetch over the FRED port
        feeds.fetchSeries.mockImplementation(async (s) => (s === vixTerm.VIX_SYMBOL ? Promise.reject(new Error("fred down")) : fredMock(s)));
      },
      scope: `[vix_term] ${vixTerm.VIX_SYMBOL} unavailable from FRED - VT omitted, bottom track null (not CALM) this run`,
    },
    {
      cause: "a disjoint leg pair",
      arrange: (feeds: FakeFeeds) => {
        const live = feeds.fetchVixSeries.getMockImplementation()!;
        feeds.fetchVixSeries.mockImplementation(async (s, f) => (s === vixTerm.VIX3M_SYMBOL ? [{ date: "2000-01-03", value: 20 }] : live(s, f)));
      },
      scope: "[vix-term] volatility term-structure feed unavailable - coincident indicator omitted",
    },
    {
      cause: "a failed live-lead close (VT estimate)",
      arrange: (feeds: FakeFeeds) => {
        feeds.fetchDailyCloses.mockImplementation(closesRejecting(estimatorOf("VT", "leg-ratio").leads[0], "lead down"));
      },
      scope: "[nowcast] VT live legs unavailable - no VT estimate this run",
    },
  ])("VT omitted by $cause lands a recorded degrade", async ({ arrange, scope }) => {
    const feeds = fakeFeeds();
    arrange(feeds);
    expect(await confirmerDegrades(feeds)).toContain(scope);
  });

  test("sovereign-quote down: BONOS, BUND and their CMP_ rows drop out; every other registry id persists", async () => {
    const feeds = fakeFeeds({ fetchSovereignBars: () => Promise.reject(new Error("boom")) });

    const alert = await runCycleWith(feeds, store);
    const ids = new Set(
      (await store.getReadingsForRun(alert.firedAt)).map((r) => r.indicatorId),
    );
    const removed = ["BONOS", ...cmpIds("BONOS"), "BUND", ...cmpIds("BUND")];
    for (const id of removed) expect(ids).not.toContain(id);
    const kept = INDICATORS.map((i) => i.id).filter((id) => !removed.includes(id));
    expect(kept.length).toBeGreaterThan(0);
    for (const id of kept) expect(ids).toContain(id);
  });

  test("no injected sovereign/DRAM/official-leg ports: the sovereign spreads degrade kind no-free-source; the alert row lands", async () => {
    const feeds: Partial<FeedPorts> = fakeFeeds();
    for (const k of NO_FREE_SOURCE_PORTS) delete feeds[k];

    const alert = await runCycleWith(feeds, store);
    const tagged = new Set((alert.degraded ?? []).filter((e) => e.kind === "no-free-source").map((e) => /^\[(\w+)\]/.exec(e.scope)?.[1]));
    for (const id of ["BONOS", "BUND"]) expect(tagged).toContain(id);
    const viaRecord = (alert.degraded ?? []).filter((e) => /^\[sovereign-quote\]/.test(e.scope));
    expect(viaRecord.length).toBeGreaterThan(0);
    for (const e of viaRecord) expect(e).toMatchObject({ kind: "no-free-source" });
    expect((await store.getLastAlert())?.firedAt).toBe(alert.firedAt);
  });

  test("N3: ONE sovereign-quote pull per leg; BONOS and BUND join the one sovereign-quote DE10Y", async () => {
    // sovereign-quote DE10Y steps DOWN 10bp over its last 5 closes, so BONOS's spread and BUND's slope both read the stepped leg:
    // a join to any other DE10Y source lands 10bp off.
    const deBase = sovereignGreen("DE10Y-DE");
    const de10y = deBase.map((o, i) =>
      i >= deBase.length - 5 ? { ...o, value: o.value - 0.1 } : o,
    );
    const feeds = fakeFeeds({ fetchSovereignBars: async (symbol) => (symbol === "DE10Y-DE" ? de10y : sovereignGreen(symbol)) });

    const alert = await runCycleWith(feeds, store);
    const rows = await store.getReadingsForRun(alert.firedAt);
    // The pull count IS the subject (one sovereign-quote pull per leg), so this stays a call assert on the port.
    const calls = feeds.fetchSovereignBars.mock.calls.map(([symbol]) => symbol).sort();
    expect(calls).toEqual([
      "DE10Y-DE",
      "DE2Y-DE",
      "ES10Y-ES",
      "US10Y",
      "US2Y",
      "US3M",
    ]); // one pull each, two euro consumers; US10Y serves R1 AND R2 (Stage 5.2's EOD estimate leads)
    const deLast = de10y.at(-1)!.value;
    expect(rows.find((r) => r.indicatorId === "BONOS")?.value).toBeCloseTo((sovereignGreen("ES10Y-ES").at(-1)!.value - deLast) * 100, 9);
    const de2yLast = sovereignGreen("DE2Y-DE").at(-1)!.value;
    expect(rows.find((r) => r.indicatorId === "BUND")?.value).toBeCloseTo(deLast - de2yLast, 9);
    expect(rows.find((r) => r.indicatorId === "CMP_BUND_DE2Y")?.value).toBe(de2yLast);
    // The shared sovereign-quote 10y vintage rides BUND: it must be the sovereign-quote fixture, never another leg.
    expect(rows.find((r) => r.indicatorId === "CMP_BUND_DE10Y")?.value).toBe(deLast);
  });

  test("sovereign-quote legs drop TARGET-closed days; BONOS/BUND feed grids are the join with DE10Y-DE", async () => {
    // Every leg gains a Good Friday bar (2026-04-03) past its last close; DE10Y also lacks the fixture's last date.
    const GOOD_FRIDAY = "2026-04-03";
    expect(isTargetClosed(GOOD_FRIDAY)).toBe(true);
    const withHoliday = (obs: Observation[]) => [
      ...obs,
      { date: GOOD_FRIDAY, value: obs.at(-1)!.value + 0.5 },
    ];
    const feeds = fakeFeeds({
      fetchSovereignBars: async (symbol) => withHoliday(symbol === "DE10Y-DE" ? sovereignGreen(symbol).slice(0, -1) : sovereignGreen(symbol)),
    });

    const { collected, newestOf } = await globalFeeds(feeds);
    const legDates = sovereignGreen("ES10Y-ES").map((o) => o.date);
    const [deLastDate, esLastDate] = [legDates.at(-2)!, legDates.at(-1)!];
    expect(legDates).toContain("2026-01-01"); // non-vacuity: the fixture window spans a mid-series TARGET holiday
    for (const id of ["BONOS", "BUND"]) {
      expect(newestOf(id), `${id}: no reading on the holiday bar`).toBe(deLastDate);
      expect(collected.get(id), id).not.toContain("2026-01-01");
      expect(
        collected.get(id),
        `${id}: grid = join with DE10Y-DE`,
      ).not.toContain(esLastDate);
      expect(collected.get(id), id).toContain(deLastDate);
    }
  });

  test("secondary feeds down (price + oil + EBP): degrades to FRED-only without aborting the verdict (§5 pre-mortem)", async () => {
    // Price feed rejects; the oil series (DCOILWTICO, via the shared FRED fetch)
    // rejects too; the EBP confirmer feed rejects — all three secondary channels
    // must degrade independently of the credit/rate core, which keeps scoring.
    const feeds = fakeFeeds({
      fetchSeries: async (series) => {
        if (series === "DCOILWTICO") throw new Error("oil feed unavailable");
        if (series === "DCOILBRENTEU") throw new Error("brent feed unavailable");
        return fredMock(series);
      },
      fetchDailyCloses: () => Promise.reject(new Error("price feed unavailable")),
      fetchEbp: () => Promise.reject(new Error("ebp feed unavailable")),
      // ECY's live CAPE fetch fails too: a recorded degrade, never a silent CAPE-less score.
      fetchCape: () => Promise.reject(new Error("CAPE unavailable")),
    });
    const own = new ReadFailStore(() => false);

    const alert = await runCycleWith(feeds, own);

    // The FRED credit/rate core is untouched by the down price/oil/ebp feeds — every
    // registry indicator still scores, EXCEPT the ones `FEED_OF` routes to the (down) price
    // feed: F9/F11 moved there 2026-08-10 (F17 minted there the same day), and OVX joined at S6
    // (2026-09-20 oil-nowcast, `^OVX`) — all degrade WITH it, which is the point of the split.
    const ids = new Set(
      (await own.getReadingsForRun(alert.firedAt)).map((r) => r.indicatorId),
    );
    expect(alert.degraded?.map((d) => d.scope)).toEqual(
      expect.arrayContaining([
        "[oil-nowcast] DCOILWTICO prints unavailable - estimate points omitted",
        "[ECY] CAPE fetch failed - ECY omitted this run",
      ]),
    );
    const priceFed = INDICATORS.filter((i) => FEED_OF[i.id] === "prices").map(
      (i) => i.id,
    );
    expect(priceFed).toEqual(["F9", "F11", "OVX", "F17"]); // non-vacuity: the exclusion must name a real, non-empty set
    const survivors = INDICATORS.map((i) => i.id).filter((id) => !priceFed.includes(id));
    expect(survivors.length).toBeGreaterThan(0);
    for (const id of priceFed) expect(ids).not.toContain(id);
    for (const id of survivors) expect(ids).toContain(id);
    // ...and the only non-registry legs that survive ride FRED or their own live feed (none
    // of which are down here): EURC (own ECB feed),
    // BUND (own sovereign-quote legs),
    // R7 (FRED bull-steepener — only
    // DCOILWTICO throws), and the 2
    // scoreboard rows (first run ⇒ seed path, no fetch). F12 (FRED China impulse) rode this
    // list until its 2026-07-17 retirement (DEC-21). FXH rode it as a FRED FX triple until
    // 2026-08-10, when it moved to the closes-feed pairs and now degrades WITH the price feed.
    // ...plus the rank-11 component vintage rows of the composites that survived: EURC
    // (own ECB feed) and BUND (own sovereign-quote legs) still capture their raw closes;
    // FXH/GT/GB/DISP ride the down price feed so neither they nor their components persist.
    // CURATED census (feed topology — not a registry axis): survivors of THIS degraded feed
    // mix are a property of the mocked outage, so the list stays hand-curated.
    const EXPECTED_EXTRA = [
      "EURC",
      "R7",
      "SB_STRAT",
      "SB_BENCH",
      "BUND",
      "VXNCLS", // chart-only FRED level — survives on the calm fredMock (VXNT stays absent: fixture < its k window)
      "T10Y3M_RAW", // chart-only unsmoothed FRED T10Y3M — same calm fredMock
      "VXSMH", // chart-only index-only level — `fetchSeries` serves it, same calm fredMock
      "CQS",
      "ESTR",
      "EPATH",
      "HICP",
      "ECISS",
      "BONOS",
      "EURGBP",
      "CCC",
      // NG rides DHHNGSP (not the thrown DCOILWTICO/DCOILBRENTEU) — survives on the calm fredMock.
      "NG",
      ...cmpIds("EURC"),
      ...cmpIds("BUND"),
      ...cmpIds("BONOS"),
      // VT/VTP + the bottom track's VIX/VIX3M display-only legs SURVIVE: they ride the SHARED vix feed
      // (its own seam), which is NOT one of the three down here — `fakeFeeds` defaults it
      // to a calm live contango pair (slice 3) instead of [], so the volatility legs score/persist.
      "VT",
      "VTP",
      "VIX",
      "VIX3M",
    ];
    // Superset guard (same shape as the all-calm census): SB_* exempted by name; VTP too (persisted+
    // charted but absent from ALL_INDICATORS, like the SB_* rows — see registry-composite.ts).
    const KNOWN = new Set([
      ...ID_SETS.all,
      ...ALL_CMP_IDS,
      ...CHART_ONLY_IDS,
      SB_STRAT_ID,
      SB_BENCH_ID,
      "VTP",
    ]);
    for (const id of EXPECTED_EXTRA)
      expect(KNOWN.has(id), `unknown census id: ${id}`).toBe(true);
    for (const id of EXPECTED_EXTRA) expect(ids).toContain(id);
    // Everything that rides the down price feed (or the thrown oil/ebp feeds) is dropped this
    // run — asserted ABSENT so a regression that keeps scoring one off a stale value fails here:
    // the direct price/oil/ebp legs (F4/F5/NVDA/G1/BRENT/EBP/R6/CG), the price-derived registry legs
    // (F6/F8/F13), the slice-1b price legs (FXH/GT/GB/DISP — FXH since the 2026-08-10 closes-provider-pair
    // move), the slice-2 detectors (DB_*). VT is NO LONGER absent — its shared vix feed is live now
    // (slice 3 calm default), so it moved to the survivor census above.
    // CURATED census (feed topology — not a registry axis); the detector pair derives.
    const EXPECTED_ABSENT = [
      "F4",
      "F5",
      "SPCONC",
      "NVDA",
      "G1",
      "BRENT",
      "EBP",
      "R6",
      "CG",
      "F6",
      "F8",
      "F13",
      "KBE_RS",
      "INS_RS",
      "EXSH_GATE",
      "AT1",
      "MU_RS",
      "JPT",
      "FXH",
      "GT",
      "GB",
      "DISP",
      ...cmpIds("FXH"),
      ...cmpIds("GT"),
      ...cmpIds("GB"),
      ...cmpIds("DISP"),
      ...DOWNSIDE_DETECTOR_IDS,
      ...RS_LEG_IDS, // the EW rel-strength siblings ride the same down price feed
      // HCX/FDX (Stage 1 chart-only) ride the same down price feed, so neither they nor their
      // component vintage rows persist this run.
      "HCX",
      "FDX",
      ...cmpIds("HCX"),
      ...cmpIds("FDX"),
    ];
    // Superset guard: an id retired from the registry can't linger in this absence census.
    for (const id of EXPECTED_ABSENT)
      expect(KNOWN.has(id), `unknown census id: ${id}`).toBe(true);
    for (const id of EXPECTED_ABSENT) expect(ids).not.toContain(id);
    // `priceFed` is subtracted: those ids ride the DOWN feed here, not `FRED_COUNT`'s.
    expect(ids.size).toBe(FRED_COUNT - priceFed.length + EXPECTED_EXTRA.length);
    // ...and each degradation was logged, not silently swallowed (§5 pre-mortem).
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("price feed unavailable"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("oil feed unavailable"),
    );
    // BRENT rides its own thrown FRED series — the G1-pattern degrade, logged not swallowed.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[brent] oil feed unavailable"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("ebp feed unavailable"),
    );
    // R6 MOVE rides the same price feed (fetchDailyCloses("^MOVE")), so it degrades too —
    // the coincident channel falls back to VIX alone, logged not swallowed (N2).
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[move] feed unavailable"),
    );
    // CG copper/gold rides the same price feed (fetchDailyCloses("HG=F"/"GC=F")) — degrades,
    // logged not swallowed (the CONTEXT confirmer is simply omitted).
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[copper-gold] commodity feed unavailable"),
    );
  });

  test("R7 own composite AND the CG commodity feed throw (+ VXNCLS down): bull-steepener and copper/gold drop, the RATE base, the price feed and the FRED core still score, verdict computes (§5 pre-mortem)", async () => {
    // Three disjoint degrade seams in one healthy world (no throw reaches another's inputs):
    // - VXNCLS rejects: its nowcast prints read warns console-only — VXNT is display-only (`CHART_ONLY_INDICATORS`),
    //   so the only VXN-naming degrade is the chart-only feed's own.
    // - R7's degrade wrapper (the `R7` confirmer) isolates a hiccup on its OWN (redundant) T10Y3M/DGS2/DGS10
    //   re-fetch/compose from the RATE core: only R7's deep-arm DGS10 re-fetch (`since: deepArmSince`, the R2
    //   leg on an empty store) rejects — R2's own core-loop DGS10 fetch never asks that window, so R1–R4 keep the verdict alive.
    // - Only HG=F/GC=F reject (the CG two-symbol feed); CG's degrade wrapper must isolate the hiccup — the
    //   CONTEXT confirmer is omitted while the rest of the price feed survives.
    const r7DeepLeg = (series: string, opts?: { since?: string; now?: Date }): boolean =>
      series === "DGS10" && opts?.now !== undefined && opts.since === deepArmSince(opts.now);
    const feeds = fakeFeeds({
      fetchSeries: async (series, opts) =>
        series === VXNCLS.series
          ? Promise.reject(new Error("vxn feed unavailable"))
          : r7DeepLeg(series, opts)
            ? Promise.reject(new Error("rate feed unavailable"))
            : fredMock(series),
      fetchDailyCloses: async (symbol) => {
        if (symbol === "HG=F" || symbol === "GC=F") throw new Error("commodity feed unavailable");
        return priceCalm(symbol); // the shared calm fixture (incl. the F13 HYG/LQD leg)
      },
    });

    const alert = await runCycleWith(feeds, store);

    // Assert by id, not total count — priceUp()'s NVDA backfill count is wall-clock-flaky
    // (60 history rows can collide onto firedAt on a fast runner; see project notes).
    const ids = (await store.getReadingsForRun(alert.firedAt)).map(
      (r) => r.indicatorId,
    );
    expect(ids).not.toContain("R7"); // the R7 confirmer degraded away
    expect(ids).not.toContain("CG"); // the copper/gold confirmer degraded away
    expect(ids).toContain("R1"); // ...but the RATE base / FRED core kept scoring
    expect(ids).toContain("R2"); // ...incl. R2 off the same DGS10 series: only R7's own re-fetch rejected
    expect(ids).toContain("F4"); // ...and the rest of the price feed
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[bull-steepener] rate feed unavailable"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[copper-gold] commodity feed unavailable"),
    );
    expect(runWarns()).toContain("[nowcast] VXNCLS prints unavailable - VXNT estimate points omitted: vxn feed unavailable");
    expect(alert.degraded?.filter((d) => d.scope.includes("VXN")).map((d) => [d.scope, d.effect])).toEqual([
      ["[nowcast] VXNCLS prints unavailable - VXNT estimate points omitted", "trace"],
      ["[vxn-term] VXN term-structure input unavailable - VXNT omitted", "trace"],
      ["[VXNCLS] FRED VXN unavailable - chart-only leg non-live this run", "notify"],
    ]);
  });

  // Soft PRICE_SCORERS rows: a symbol only soft rows consume cannot take the core price batch down.
  test("a SOFT symbol (EXSA.DE) rejecting drops only EXSH_GATE; F4/F6/KBE_RS still score", async () => {
    const feeds = fakeFeeds({ fetchDailyCloses: closesRejecting("EXSA.DE", "xetra feed unavailable") });
    resetDegradeLog();
    const ids = (await scorePriceIndicators(RUN_AT, readEnv(), { store, runAt: RUN_AT, feeds })).readings.map(
      (r) => r.indicator.id,
    );
    expect(ids).toEqual(expect.arrayContaining(["F4", "F6", "KBE_RS"]));
    expect(ids).not.toContain("EXSH_GATE");
    expect(peekDegradeLog().filter((e) => e.scope.includes("soft symbol")).map((e) => [e.scope, e.effect])).toEqual([
      ["[prices] soft symbol EXSA.DE unavailable - its soft rows skipped", "notify"],
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("soft symbol EXSA.DE unavailable"),
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("[prices] feed unavailable"),
    );
  });

  // Without the fill EXSH_GATE's inner join (EXSH.DE ⋈ EXSA.DE) drops the D-1 date outright — the row the EOD never finalizes.
  test("an EXSH.DE live hole fills from its stored INPUT_SERIES row — EXSH_GATE keeps D-1", async () => {
    const leg = "EXSH.DE";
    const full = await priceCalm(leg);
    const hole = full.at(-2)!; // the Xetra D-1 bar the closes provider nulls
    const feeds = fakeFeeds({ fetchDailyCloses: async (s) => (s === leg ? full.filter((x) => x.date !== hole.date) : priceCalm(s)) });
    await store.recordReadings(priceLegReadingSeries(leg, [hole]), `${hole.date}T22:00:00.000Z`);
    const out = await scorePriceIndicators(RUN_AT, readEnv(), { store, runAt: RUN_AT, feeds });
    expect(out.series.find((s) => s.id === "EXSH_GATE")!.series.map((r) => r.date)).toContain(hole.date);
  });

  // RSP, not SMH: its only consumer (SPCONC) is guard-light, so ONLY the hard fetch can degrade the batch.
  test("a HARD symbol (RSP) rejecting still degrades the whole price batch", async () => {
    const feeds = fakeFeeds({ fetchDailyCloses: closesRejecting("RSP", "rsp feed unavailable") });
    const out = await scorePriceIndicators(RUN_AT, readEnv(), { store, runAt: RUN_AT, feeds });
    expect(out.readings).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[prices] feed unavailable - scoring FRED-only"),
    );
  });

  test("VXNT: a deep VXNCLS/VIXCLS/VXVCLS world persists VXNCLS ÷ (VXVCLS × k)", async () => {
    const feeds = fakeFeeds();
    // VIX ÷ VIX3M strictly past the red cut: VXNT RED. Push-body exclusion is vix-term-persistence.test.ts's + run.wiring.estimates's to pin.
    const { vxn, back } = deepVxntPorts(feeds, FIXTURE_ASOF, VT_DESCRIPTOR.red + 0.1);

    const alert = await runCycleWith(feeds, store);
    const row = (await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === VXNT.id);
    expect(row?.value).toBeCloseTo(vxn.at(-1)!.value / (back.at(-1)!.value * VXNT_DEEP_K), 9);
    expect(row?.state).toBe("RED");
  });
});
