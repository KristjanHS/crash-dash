/**
 * seedInputSeriesOnCron (load-tolerance P1.1): self-seeds full history on an empty store,
 * inserts only missing dates once seeded, and survives a single id's feed outage.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Env } from "./config.js";
import { FRED_LOOKBACK_DAYS } from "./fred.js";
import { LOOKBACK_DAYS } from "./price-cache.js";
import { resetProviderFallbacks, startPriceFeed } from "./prices.js";
import { providerFallbackHopped } from "./provider-fallback-latch.js";
import { latchProviderFallbackViaRealHop } from "./test-helpers.js";
import { MIN_OVERLAP_ROWS } from "./treasury.js";
import { priceLegReadingSeries } from "./pension.js";
import { InMemoryStore } from "./store-memory.js";
import { INPUT_CATCHUP_PROBE, seedInputSeriesOnCron, type Clock, type InputSeriesFeeds } from "./run-seeds.js";
import { INPUT_SERIES, inputSeriesIdOf } from "./input-series.js";
import { TAIL_DAYS } from "./series-db-first.js";
import { INTRADAY_CUTOFF_UTC_MIN, isProvisional } from "./intraday.js";
import { BREADTH_READ_ONLY, PENSION_INDICATORS } from "./registry-price.js";
import { LADDER } from "./families.js";
import { legCloseId, OFF_LADDER_LEG_KEYS, offLadderLegCloseId } from "./scoreboard.js";

import type { Observation } from "./domain-types.js";

const obs = (n: number): Observation[] =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: 100 + i,
  }));

const clock = (): Clock => {
  let t = 0;
  return () => new Date(Date.UTC(2030, 0, 1) + ++t).toISOString();
};
// `seedInputSeriesOnCron` reads its fetch clock ONCE, before the loop — the FIRST tick of a fresh `clock()`.
const FIRST_TICK_MS = Date.UTC(2030, 0, 1) + 1;
const seedNow = new Date(FIRST_TICK_MS);
// After every fixture date's cutoff (a final vintage, never `isProvisional`) and before `clock()`.
const PRESEED_AT = "2029-01-01T00:00:00.000Z";

// Fresh injected feeds per test; Treasury defaults to NO head (identity graft) — a unit test never touches the network.
let f: { [K in keyof InputSeriesFeeds]: Mock<InputSeriesFeeds[K]> };
beforeEach(() => {
  resetProviderFallbacks(); // module latch on a shared worker — a sibling file's hop must not hold the tail repair
  f = {
    fetchSeries: vi.fn<InputSeriesFeeds["fetchSeries"]>(async () => obs(30)),
    fetchDailyCloses: vi.fn<InputSeriesFeeds["fetchDailyCloses"]>(async () => obs(30)),
    fetchNtfsSeries: vi.fn<InputSeriesFeeds["fetchNtfsSeries"]>(async () => obs(30)),
    fetchDramSpot: vi.fn<InputSeriesFeeds["fetchDramSpot"]>(async () => obs(30)),
    fetchTreasuryColumn: vi.fn<InputSeriesFeeds["fetchTreasuryColumn"]>(async () => []),
  };
});
// A sentinel env: the feed asserts below pin that the seed hands ITS env to every fetch.
const SEED_ENV: Env = { NTFY_TOPIC: "input-series-test-env" };
const seed = (store: InMemoryStore, clk: Clock, warn?: (msg: string) => void) => seedInputSeriesOnCron(store, SEED_ENV, clk, warn, f);

describe("seedInputSeriesOnCron", () => {
  it("empty store: fetches FULL history per feed and writes every id's rows", async () => {
    const store = new InMemoryStore();
    const fredSpy = f.fetchSeries.mockImplementation(async () => obs(30));
    const priceSpy = f.fetchDailyCloses.mockImplementation(async () => obs(30));
    f.fetchNtfsSeries.mockImplementation(async () => obs(30));
    const tfSpy = f.fetchDramSpot.mockImplementation(async () => obs(30));

    await seed(store, clock());

    // The snapshot port serves exactly the roster's snapshot rows, each by its symbol — no other feed's row reaches it.
    expect(tfSpy.mock.calls).toEqual(INPUT_SERIES.filter((s) => s.feed === "snapshot").map((s) => [s.symbol ?? s.id]));
    for (const spec of INPUT_SERIES) {
      expect((await store.getSeries(spec.id, 100)).length, spec.id).toBe(30);
    }
    // EVERY roster id seeds here — the DB-first seam writes VIXCLS under R5, never the raw
    // id, so the raw-id copy is dark unless this seed fetches it (C1 review fix).
    expect(fredSpy).toHaveBeenCalledWith("VIXCLS", { fullHistory: true, now: seedNow, env: SEED_ENV });
    // Unseeded ids self-seed at full depth: FRED full history; prices deep, honouring the
    // per-spec replay lookback override.
    expect(fredSpy).toHaveBeenCalledWith("BAMLH0A0HYM2", { fullHistory: true, now: seedNow, env: SEED_ENV });
    expect(priceSpy).toHaveBeenCalledWith("ACWI", { deep: true, now: expect.any(Function), env: SEED_ENV });
    expect(priceSpy).toHaveBeenCalledWith("^GSPC", { deep: true, lookbackDays: 31 * 365, now: expect.any(Function), env: SEED_ENV });
    // Every price fetch's `now` thunk returns the run's single clock read — never a wall-clock read.
    expect(priceSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [sym, opts] of priceSpy.mock.calls) expect(opts.now(), sym).toBe(FIRST_TICK_MS);
    // A `symbol` row fetches its ticker and stores under its id (DEXUSEU ← the closes feed's EURUSD=X).
    expect(priceSpy).toHaveBeenCalledWith("EURUSD=X", { deep: true, now: expect.any(Function), env: SEED_ENV });
    expect(priceSpy).not.toHaveBeenCalledWith("DEXUSEU", expect.anything());
  });

  it("a signal aborted by the first fetch: no id is written, no further id is fetched", async () => {
    const store = new InMemoryStore();
    const ctl = new AbortController();
    const abortFirst = async (): Promise<Observation[]> => (ctl.abort(), obs(30));
    for (const k of ["fetchSeries", "fetchDailyCloses", "fetchNtfsSeries", "fetchDramSpot"] as const) f[k].mockImplementation(abortFirst);
    await seedInputSeriesOnCron(store, SEED_ENV, clock(), () => undefined, f, () => undefined, ctl.signal);
    expect(store.readings).toEqual([]);
    const fetched = f.fetchSeries.mock.calls.length + f.fetchDailyCloses.mock.calls.length + f.fetchNtfsSeries.mock.calls.length + f.fetchDramSpot.mock.calls.length;
    expect(fetched).toBeLessThan(INPUT_SERIES.length);
  });

  it("populated store: fetches the trailing window and inserts ONLY the missing dates", async () => {
    const store = new InMemoryStore();
    const fredSpy = f.fetchSeries.mockImplementation(async () => obs(30));
    f.fetchDailyCloses.mockImplementation(async () => obs(30));
    f.fetchNtfsSeries.mockImplementation(async () => obs(30));
    f.fetchDramSpot.mockImplementation(async () => obs(30));
    await seed(store, clock());
    const seeded = store.readings.length;

    // Same feeds again ⇒ every date already stored ⇒ zero writes.
    await seed(store, clock());
    expect(store.readings.length).toBe(seeded);
    // The catch-up fetch is the DEFAULT window, never fullHistory.
    expect(fredSpy).toHaveBeenCalledWith("BAMLH0A0HYM2", { now: seedNow, env: SEED_ENV });
    // The catch-up (non-deep) price fetch's `now` thunk is also the run's single clock read.
    const catchUp = f.fetchDailyCloses.mock.calls.filter(([, opts]) => opts.deep !== true);
    expect(catchUp.length).toBeGreaterThan(0);
    for (const [sym, opts] of catchUp) expect(opts.now(), sym).toBe(FIRST_TICK_MS);

    // One new close per feed ⇒ exactly one new row per id.
    f.fetchSeries.mockImplementation(async () => obs(31));
    f.fetchDailyCloses.mockImplementation(async () => obs(31));
    f.fetchNtfsSeries.mockImplementation(async () => obs(31));
    f.fetchDramSpot.mockImplementation(async () => obs(31));
    await seed(store, clock());
    expect(store.readings.length).toBe(seeded + INPUT_SERIES.length);
  });

  it("full-history feed deeper than the probe window: re-run inserts 0 rows, a new tail date still 1", async () => {
    // Prod 2026-09-05..10: NTFS (full history every run, 11.2k dates) diffed against a 600-date
    // probe re-inserted the 10,633 older dates as fresh vintages EVERY cron. The diff must be
    // bounded to the probed window. Fixture derived from the probe constant, never restated.
    const deep = INPUT_CATCHUP_PROBE + 100;
    const store = new InMemoryStore();
    f.fetchSeries.mockImplementation(async () => obs(30));
    f.fetchDailyCloses.mockImplementation(async () => obs(30));
    f.fetchNtfsSeries.mockImplementation(async () => obs(deep));
    f.fetchDramSpot.mockImplementation(async () => obs(30));
    await seed(store, clock());
    expect((await store.getSeries("NTFS", deep + 1)).length).toBe(deep);
    const seeded = store.readings.length;

    await seed(store, clock());
    expect(store.readings.length).toBe(seeded); // the 100 dates older than the window are NOT re-inserted

    f.fetchNtfsSeries.mockImplementation(async () => obs(deep + 1));
    await seed(store, clock());
    expect(store.readings.length).toBe(seeded + 1);
  });

  it("the probe window covers every non-full catch-up fetch (else the diff floor drops real rows)", () => {
    // The floor ignores fetched dates older than the probe; a FRED/price default window wider than
    // the probe (in trading rows, ~5/7 of calendar days) would then be silently clipped every cron.
    const widestCalendarDays = Math.max(FRED_LOOKBACK_DAYS, LOOKBACK_DAYS);
    expect(INPUT_CATCHUP_PROBE).toBeGreaterThan(Math.ceil((widestCalendarDays * 5) / 7));
  });

  it("every BREADTH_READ_ONLY id has a dedicated cron writer in INPUT_SERIES", () => {
    // The breadth path reads these ids DB-first but NEVER writes them (registry-price.ts). J4 deleted
    // SPY's pension writer; without a writer here the tail arm merges a 14-day tail onto a frozen base
    // and SPCONC/F6's trailing-high goes stale. Two imported sources, no restated constant.
    expect(BREADTH_READ_ONLY.size).toBeGreaterThan(0); // vacuity guard
    const writers = new Set(INPUT_SERIES.map((s) => s.id));
    for (const id of BREADTH_READ_ONLY) expect(writers.has(id), id).toBe(true);
  });

  it("every PENSION_INDICATORS id has a cron writer (INPUT_SERIES or seedLegClosesOnCron)", () => {
    // J4 deleted scorePensionTrack; 7 ETFs-card ids then froze at 2026-09-04 with no writer.
    const writers = new Set([
      ...INPUT_SERIES.map((s) => s.id),
      ...LADDER.map((s) => legCloseId(s)),
      ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId), // off-ladder LEGP_COMMOD rides the same cron seed
    ]);
    for (const { id } of PENSION_INDICATORS) expect(writers.has(id), id).toBe(true);
  });

  it("a throwing feed for one id does not abort the others", async () => {
    const store = new InMemoryStore();
    f.fetchSeries.mockImplementation(async (series: string) => {
      if (series === "BAA10Y") throw new Error("FRED down");
      return obs(30);
    });
    f.fetchDailyCloses.mockImplementation(async () => obs(30));
    f.fetchNtfsSeries.mockImplementation(async () => obs(30));
    f.fetchDramSpot.mockImplementation(async () => obs(30));
    const warn = vi.fn((_msg: string) => {});

    await seed(store, clock(), warn);

    expect(await store.getSeries("BAA10Y", 100)).toEqual([]);
    for (const spec of INPUT_SERIES.filter((s) => s.id !== "BAA10Y")) {
      expect((await store.getSeries(spec.id, 100)).length, spec.id).toBe(30);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("BAA10Y"))).toBe(true);
  });

  it("seeds ids concurrently through a bounded pool (more than one, fewer than every id in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (): Promise<Observation[]> => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return obs(30);
    };
    f.fetchSeries.mockImplementation(slow);
    f.fetchDailyCloses.mockImplementation(slow);
    f.fetchNtfsSeries.mockImplementation(slow);
    f.fetchDramSpot.mockImplementation(slow);

    await seed(new InMemoryStore(), clock());

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(INPUT_SERIES.length);
  });
});

describe("seedInputSeriesOnCron — Treasury same-day graft + repair (S4/B3)", () => {
  // DGS10 (indicator R2) fetched history 2026-07-01..2026-07-10; the graft appends a NEWER Treasury head.
  const dgs10Dates = Array.from({ length: 10 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`);
  const dgs10Obs: Observation[] = dgs10Dates.map((date, i) => ({ date, value: 4.0 + i * 0.01 }));
  const headDate = "2026-07-11";
  const headValue = 4.11;
  // Treasury 10y-nominal column: the last MIN_OVERLAP_ROWS dgs10 dates (MATCHING FRED, so the equality
  // gate ESTABLISHES) plus the same-day head. Overlap == MIN_OVERLAP_ROWS ⇒ no A3 prior-year fallback.
  const treasury10y: Observation[] = [
    ...dgs10Obs.slice(-MIN_OVERLAP_ROWS).map((o) => ({ ...o })),
    { date: headDate, value: headValue },
  ];

  const mountFeeds = () => {
    f.fetchSeries.mockImplementation(async (series: string) =>
      series === "DGS10" ? dgs10Obs.map((o) => ({ ...o })) : obs(5),
    );
    f.fetchDailyCloses.mockImplementation(async () => obs(5));
    f.fetchNtfsSeries.mockImplementation(async () => obs(5));
    f.fetchDramSpot.mockImplementation(async () => obs(5));
    f.fetchTreasuryColumn.mockImplementation(async (curve, column) =>
      curve === "nominal" && column === "10 YR" ? treasury10y.map((o) => ({ ...o })) : [],
    );
  };

  it("stores the head `estimated` (never FINAL), dedups it per run, and clears a daytime provisional head on D", async () => {
    const store = new InMemoryStore();
    const daytime = new Date(Date.parse(`${headDate}T00:00:00Z`) + (INTRADAY_CUTOFF_UTC_MIN - 60) * 60_000).toISOString();
    expect(isProvisional({ date: headDate, runAt: daytime })).toBe(true); // premise: the pre-seed is a daytime head
    await store.recordReadings(priceLegReadingSeries("DGS10", [{ date: headDate, value: 4.2 }]), daytime);
    mountFeeds();
    const tick = clock();
    await seed(store, tick);
    await seed(store, tick);
    const onD = store.readings.filter((r) => r.indicatorId === "DGS10" && r.date === headDate);
    expect(onD.map((r) => [r.value, r.estimated === true])).toEqual([[headValue, true]]);
    // FRED's own prints stay FINAL.
    expect(store.readings.some((r) => r.indicatorId === "DGS10" && r.date < headDate && r.estimated === true)).toBe(false);
  });

  it("D+1: FRED prints D ⇒ D lands FINAL and the D estimate is swept", async () => {
    const store = new InMemoryStore();
    mountFeeds();
    const tick = clock();
    await seed(store, tick);
    f.fetchSeries.mockImplementation(async (series: string) =>
      series === "DGS10" ? [...dgs10Obs, { date: headDate, value: headValue + 0.01 }].map((o) => ({ ...o })) : obs(5),
    );
    await seed(store, tick);
    const onD = store.readings.filter((r) => r.indicatorId === "DGS10" && r.date === headDate);
    expect(onD.map((r) => [r.value, r.estimated === true])).toEqual([[headValue + 0.01, false]]);
  });

  it("re-persists a stored Treasury-id date inside the tail whose fresh value differs", async () => {
    const store = new InMemoryStore();
    // A stale prior vintage on a date the fresh feed will contradict (999 ≠ 4.04).
    await store.recordReadings(
      priceLegReadingSeries("DGS10", [{ date: "2026-07-05", value: 999 }]),
      PRESEED_AT,
    );
    mountFeeds();
    await seed(store, clock());
    const p = (await store.getSeries("DGS10", 100)).find((r) => r.date === "2026-07-05");
    expect(p?.value).toBe(dgs10Obs[4]!.value); // the fresh vintage — repaired via a new readings_latest row
  });

  it("does NOT re-persist a stored Treasury-id date whose value is unchanged", async () => {
    const store = new InMemoryStore();
    // Pre-seed the SAME value/shape the fresh series produces ⇒ the 4-field diff finds nothing to repair.
    await store.recordReadings(
      priceLegReadingSeries("DGS10", [{ date: "2026-07-05", value: dgs10Obs[4]!.value }]),
      PRESEED_AT,
    );
    mountFeeds();
    await seed(store, clock());
    const rows = store.readings.filter((r) => r.indicatorId === "DGS10" && r.date === "2026-07-05");
    expect(rows.length).toBe(1); // only the pre-seed — no repair vintage appended
  });
});

describe("seedInputSeriesOnCron — price tail repair (tailRepair roster flag)", () => {
  // An ex-div rescales the provider's dividend-adjusted history: the fresh fetch contradicts the
  // stored tail vintage. Dates derived from TAIL_DAYS: index span-1 is inside the repair window
  // (floor = newest - TAIL_DAYS), index 0 is older than it.
  const span = TAIL_DAYS + 3;
  const day = (i: number) => new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const freshObs: Observation[] = Array.from({ length: span + 1 }, (_, i) => ({ date: day(i), value: 80 + i * 0.1 }));

  const mountFeeds = () => {
    f.fetchSeries.mockImplementation(async () => obs(5));
    f.fetchDailyCloses.mockImplementation(async () => freshObs.map((o) => ({ ...o })));
    f.fetchNtfsSeries.mockImplementation(async () => obs(5));
    f.fetchDramSpot.mockImplementation(async () => obs(5));
  };
  const preSeed = async (store: InMemoryStore, id: string, date: string, value: number) =>
    store.recordReadings(priceLegReadingSeries(id, [{ date, value }]), PRESEED_AT);

  it("re-persists a stored HYG / IEF / oil-future tail date whose fresh (re-adjusted / settled) value differs", async () => {
    expect(TAIL_DAYS).toBeGreaterThan(0); // premise guard: span derivation goes vacuous at 0
    const store = new InMemoryStore();
    const ids = ["HYG", "IEF", "CL=F", "BZ=F"];
    for (const id of ids) await preSeed(store, id, day(span - 1), 999);
    mountFeeds();
    await seed(store, clock());
    for (const id of ids) {
      const p = (await store.getSeries(id, 100)).find((r) => r.date === day(span - 1));
      expect(p?.value, id).toBe(freshObs[span - 1]!.value); // fresh vintage — repaired
    }
  });

  // R1: held PER SYMBOL — a hop (surviving the persist drain) holds only its own id.
  it("a HYG hop keeps HYG's FINAL tail row while IEF is repaired; missing dates still insert", async () => {
    const store = new InMemoryStore();
    await preSeed(store, "HYG", day(span - 1), 999);
    await preSeed(store, "IEF", day(span - 1), 999);
    mountFeeds();
    const lines: string[] = [];
    try {
      await latchProviderFallbackViaRealHop("HYG");
      expect(providerFallbackHopped("HYG")).toBe(true); // premise: the drain did not clear it
      await seedInputSeriesOnCron(store, SEED_ENV, clock(), undefined, f, (m) => lines.push(m));
      const hyg = await store.getSeries("HYG", 100);
      expect(hyg.find((r) => r.date === day(span - 1))?.value).toBe(999);
      expect(hyg.find((r) => r.date === day(span))?.value).toBe(freshObs[span]!.value); // missing date still written
      expect((await store.getSeries("IEF", 100)).find((r) => r.date === day(span - 1))?.value).toBe(freshObs[span - 1]!.value);
      expect(lines.find((m) => m.startsWith("[input-series] seeded"))).toMatch(/tail repair held: non-primary feed, 1 row/);
    } finally {
      resetProviderFallbacks();
    }
  });

  it("an intraday run holds HYG's FINAL tail row; a keyless-only id (EXSH.DE) is still repaired", async () => {
    const store = new InMemoryStore();
    await preSeed(store, "HYG", day(span - 1), 999);
    await preSeed(store, "EXSH.DE", day(span - 1), 999);
    mountFeeds();
    try {
      startPriceFeed({ intraday: true });
      await seed(store, clock());
    } finally {
      startPriceFeed(); // disarm: EOD chain for every later test
    }
    expect((await store.getSeries("HYG", 100)).find((r) => r.date === day(span - 1))?.value).toBe(999);
    expect((await store.getSeries("EXSH.DE", 100)).find((r) => r.date === day(span - 1))?.value).toBe(freshObs[span - 1]!.value);
  });

  it("never re-persists an un-flagged price id (SPY) whose stored tail value differs", async () => {
    expect(INPUT_SERIES.find((s) => s.id === "SPY")?.tailRepair).toBeUndefined(); // the pin: SPY stays insert-missing
    const store = new InMemoryStore();
    await preSeed(store, "SPY", day(span - 1), 999);
    mountFeeds();
    await seed(store, clock());
    const p = (await store.getSeries("SPY", 100)).find((r) => r.date === day(span - 1));
    expect(p?.value).toBe(999); // unchanged — no repair vintage appended
    expect(store.readings.filter((r) => r.indicatorId === "SPY" && r.date === day(span - 1)).length).toBe(1);
  });

  // A7: a provisional D is written ONCE as missing (never also as a tail repair); a final one stays.
  it.each([
    ["SPY", INTRADAY_CUTOFF_UTC_MIN - 1, "fresh", 2],
    ["HYG", INTRADAY_CUTOFF_UTC_MIN - 1, "fresh", 2],
    ["SPY", INTRADAY_CUTOFF_UTC_MIN, "stored", 1],
  ])("%s D stored at minute %i → newest D is the %s value, final; %i row(s) for D", async (id, min, which, rows) => {
    const D = day(span - 1);
    const store = new InMemoryStore();
    const at = new Date(Date.parse(`${D}T00:00:00Z`) + min * 60_000).toISOString();
    await store.recordReadings(priceLegReadingSeries(id, [{ date: D, value: 999 }]), at);
    mountFeeds();
    await seed(store, clock());
    const p = (await store.getSeries(id, 100)).find((r) => r.date === D)!;
    const value = which === "fresh" ? freshObs[span - 1]!.value : 999;
    expect({ value: p.value, provisional: isProvisional(p) }).toEqual({ value, provisional: false });
    expect(store.readings.filter((r) => r.indicatorId === id && r.date === D).length).toBe(rows);
  });

  // C3: an intraday seed writes D provisional; the same-day EOD seed rewrites it final (SPY: insert-missing only).
  it("intraday seed writes SPY D provisional → the EOD seed rewrites D with the settled close", async () => {
    const D = day(span);
    const at = (min: number): Clock => () => new Date(Date.parse(`${D}T00:00:00Z`) + min * 60_000).toISOString();
    const store = new InMemoryStore();
    mountFeeds();
    f.fetchDailyCloses.mockImplementation(async () => [...freshObs.slice(0, span), { date: D, value: 1 }]);
    await seed(store, at(INTRADAY_CUTOFF_UTC_MIN - 60));
    const mid = (await store.getSeries("SPY", 100)).find((r) => r.date === D)!;
    expect({ value: mid.value, provisional: isProvisional(mid) }).toEqual({ value: 1, provisional: true });
    f.fetchDailyCloses.mockImplementation(async () => freshObs.map((o) => ({ ...o })));
    await seed(store, at(INTRADAY_CUTOFF_UTC_MIN + 60));
    const eod = (await store.getSeries("SPY", 100)).find((r) => r.date === D)!;
    expect({ value: eod.value, provisional: isProvisional(eod) }).toEqual({ value: freshObs[span]!.value, provisional: false });
  });

  // Defect 3: the closes provider stops serving the Xetra D-1 bar, so without the fill
  // nothing ever rewrites the D-1 intraday row and it stays provisional forever.
  it("Defect 3: a provisional XDEV D-1 the live feed nulls is rewritten FINAL from its own stored value", async () => {
    const id = inputSeriesIdOf("XDEV.DE")!;
    const dM1 = day(span - 1);
    const store = new InMemoryStore();
    const provAt = new Date(Date.parse(`${dM1}T00:00:00Z`) + (INTRADAY_CUTOFF_UTC_MIN - 1) * 60_000).toISOString();
    await store.recordReadings(priceLegReadingSeries(id, [{ date: dM1, value: 999 }]), provAt);
    mountFeeds();
    f.fetchDailyCloses.mockImplementation(async () => freshObs.filter((o) => o.date !== dM1));
    await seed(store, clock());
    const p = (await store.getSeries(id, 100)).find((r) => r.date === dM1)!;
    expect({ value: p.value, provisional: isProvisional(p) }).toEqual({ value: 999, provisional: false });
  });

  it("a US pre-close provisional D-1 (HYG @ 18:31) is never frozen FINAL by the fill (settledClose)", async () => {
    const dM1 = day(span - 1);
    const store = new InMemoryStore();
    await store.recordReadings(priceLegReadingSeries("HYG", [{ date: dM1, value: 999 }]), `${dM1}T18:31:00.000Z`);
    mountFeeds();
    f.fetchDailyCloses.mockImplementation(async () => freshObs.filter((o) => o.date !== dM1));
    await seed(store, clock());
    const p = (await store.getSeries("HYG", 100)).find((r) => r.date === dM1)!;
    expect(isProvisional(p)).toBe(true);
  });

  // the closes provider meta source: the feed null-closes the Xetra D bar until the next
  // session; `closesMetaClose` closes it from the quote, flagged `estimated`. The settled bar (D+1's fetch) lands D FINAL.
  it("EXSH.DE: a meta-closed D lands `estimated`; D+1's settled bar lands D FINAL and sweeps the estimate", async () => {
    const D = day(span);
    const meta = { date: D, value: 77, estimated: true as const };
    const store = new InMemoryStore();
    mountFeeds();
    f.fetchDailyCloses.mockImplementation(async (s) =>
      [...freshObs.slice(0, span), ...(s === "EXSH.DE" ? [meta] : [freshObs[span]!])].map((o) => ({ ...o })));
    const tick = clock();
    await seed(store, tick);
    await seed(store, tick); // a repeat EOD replaces, never stacks
    const onD = () => store.readings.filter((r) => r.indicatorId === "EXSH.DE" && r.date === D).map((r) => [r.value, r.estimated === true]);
    expect(onD()).toEqual([[77, true]]);
    expect(store.readings.some((r) => r.indicatorId === "EXSA.DE" && r.estimated === true)).toBe(false); // settled legs stay FINAL
    f.fetchDailyCloses.mockImplementation(async () => freshObs.map((o) => ({ ...o })));
    await seed(store, tick);
    expect(onD()).toEqual([[freshObs[span]!.value, false]]);
  });

  it("a meta-closed (estimated) fresh row never tail-repairs a FINAL stored row on its date", async () => {
    const D = day(span);
    const store = new InMemoryStore();
    await preSeed(store, "EXSH.DE", D, 999);
    mountFeeds();
    f.fetchDailyCloses.mockImplementation(async () => [...freshObs.slice(0, span), { date: D, value: 77, estimated: true as const }]);
    await seed(store, clock());
    expect(store.readings.filter((r) => r.indicatorId === "EXSH.DE" && r.date === D).map((r) => [r.value, r.estimated === true])).toEqual([[999, false]]);
  });

  it("never re-persists a flagged id's differing date OLDER than the tail floor", async () => {
    const store = new InMemoryStore();
    await preSeed(store, "HYG", day(0), 555); // newest fetched is day(span); day(0) < floor
    mountFeeds();
    await seed(store, clock());
    const p = (await store.getSeries("HYG", 100)).find((r) => r.date === day(0));
    expect(p?.value).toBe(555);
    expect(store.readings.filter((r) => r.indicatorId === "HYG" && r.date === day(0)).length).toBe(1);
  });
});
