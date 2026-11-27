/**
 * gapFillSweep: the cron's ONE insert-missing pass over the last GAP_FILL_DAYS of every carried series — a
 * date never the newest on a run (late print, missed cron, a `=X` Friday bar) lands without a
 * manual backfill; stored dates are never re-shadowed; nothing outside the window is written.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./store-memory.js";
import { BACKFILL_PROBE_LIMIT, backfillHistory, eodKeepRunAt, gapFillSweep, toStoredReading, type Clock } from "./run-seeds.js";
import { GAP_FILL_DAYS, INTRADAY_CUTOFF_UTC_MIN, VALUE_EPS, gapFillFrom, isProvisional } from "./intraday.js";
import { INDICATORS } from "./registry-fred.js";
import { type Reading } from "./domain-types.js";
import { confirmClosesFor } from "./family-table.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { makeFredLoop } from "./run-dbfirst.js";
import { loadSynthHistoriesDated } from "./synth-cuts.js";
import { scoreWithCutsSeriesPerDay } from "./confirmers.js";
import { peekDegradeLog, resetDegradeLog } from "./tracks.js";
import { ECY } from "./registry-fred.js";
import { ecyEstimateDates, ecyReadingSeries } from "./scorers-composite.js";
import { ECY_MIN_OBS } from "./family-descriptor-rows.js";
import { sweepEodRows, withoutEstimateSourced, type EodRun } from "./estimated.js";
import type { Observation } from "./domain-types.js";

const F1 = INDICATORS.find((i) => i.id === "F1")!;
const ASOF = "2026-09-29";
const reading = (date: string, level: number, id = "F1"): Reading =>
  ({ indicator: { ...F1, id }, date, level, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null }) as Reading;
const clock: Clock = () => "2026-09-29T22:55:00.001Z";
const day = (offset: number): string => new Date(Date.parse(`${ASOF}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
/** `confirmClosesFor(id)` in-window bootstrap rows, then `body`, then the run's own newest (ASOF). */
const carriedOf = (id: string, body: Reading[]): Reading[] => [
  ...Array.from({ length: confirmClosesFor(id) }, (_, i) => reading(day(GAP_FILL_DAYS - i), 9, id)),
  ...body,
  reading(ASOF, 9, id),
];
/** Records every `getSeriesBulk` call; a `probeError` rejects it. */
class ProbeStore extends InMemoryStore {
  readonly bulkCalls: Parameters<InMemoryStore["getSeriesBulk"]>[] = [];
  constructor(private readonly probeError?: Error) {
    super();
  }
  override async getSeriesBulk(...a: Parameters<InMemoryStore["getSeriesBulk"]>): ReturnType<InMemoryStore["getSeriesBulk"]> {
    this.bulkCalls.push(a);
    if (this.probeError) throw this.probeError;
    return super.getSeriesBulk(...a);
  }
}

describe("gapFillSweep", () => {
  it("one bulk probe for N ids; writes missing in-window dates and a stored final whose value is not the official one, never the newest or the bootstrap head", async () => {
    const store = new ProbeStore();
    await store.recordReadings([makeStoredReading("F1", { date: day(3), value: 40 })], "2026-09-29T22:55:00.000Z");
    const ids = ["F1", "G1", "F9"]; // non-`=X`: an `=X` row written before D+48h stays provisional and is re-swept
    const carried = new Map(ids.map((id) => [id, carriedOf(id, [reading(day(3), 3, id), reading(day(1), 4, id)]).map(toStoredReading)]));
    expect(await gapFillSweep(store, carried, ASOF, clock)).toBe(6);
    expect(store.bulkCalls.map((c) => [c[0], c[1].limit])).toEqual([[ids, GAP_FILL_DAYS + 1]]);
    for (const id of ids) expect((await store.getSeries(id, 100)).map((p) => [p.date, p.value]), id).toEqual([[day(3), 3], [day(1), 4]]);
    // Idempotent: a current window costs no write.
    expect(await gapFillSweep(store, carried, ASOF, clock)).toBe(0);
  });

  it("a stored final within VALUE_EPS of the official value is not rewritten (prod float noise ~1e-14)", async () => {
    const store = new ProbeStore();
    await store.recordReadings([makeStoredReading("F1", { date: day(3), value: 3 * (1 + VALUE_EPS / 10) }), makeStoredReading("F1", { date: day(1), value: 4 })], "2026-09-29T22:55:00.000Z");
    const carried = new Map([["F1", carriedOf("F1", [reading(day(3), 3, "F1"), reading(day(1), 4, "F1")]).map(toStoredReading)]]);
    expect(await gapFillSweep(store, carried, ASOF, clock)).toBe(0);
  });

  // An intraday run (other provider) and a read-edge-scored slow leg write missing dates only: no per-run value flip.
  it.each([
    ["F1", { valueRepair: false }, 1, 40],
    ["complacency-vix", {}, 1, 40],
    ["complacency-high", {}, 2, 3],
  ])("%s %o: writes %i (missing day(1) always), stored day(3) final → %i", async (id, opts, writes, value) => {
    const store = new ProbeStore();
    await store.recordReadings([makeStoredReading(id, { date: day(3), value: 40 })], "2026-09-29T22:55:00.000Z");
    const carried = new Map([[id, carriedOf(id, [reading(day(3), 3, id), reading(day(1), 4, id)]).map(toStoredReading)]]);
    expect(await gapFillSweep(store, carried, ASOF, clock, opts)).toBe(writes);
    expect((await store.getSeries(id, 10)).map((p) => [p.date, p.value])).toEqual([[day(3), value], [day(1), 4]]);
  });

  // An intraday sweep (`insertOnOrAfter` = its own date) writes a past date only over an absent/estimated head of an un-held id, and only
  // a row FINAL at its write; EOD writes every non-FINAL one. The floor row (ASOF) lands either way; day(-1) = newest, skipped.
  const INTRADAY = { insertOnOrAfter: ASOF };
  const EARLY: Clock = () => `${day(1)}T00:00:01.000Z`;
  it.each([
    ["intraday", "absent", INTRADAY, clock, 4],
    ["intraday", "estimated", INTRADAY, clock, 4],
    ["intraday", "final", INTRADAY, clock, 7],
    ["intraday", "provisional", INTRADAY, clock, 7],
    ["intraday held", "estimated", { ...INTRADAY, pastHeldIds: new Set(["F1"]) }, clock, 7],
    ["intraday before day(1) closes", "absent", INTRADAY, EARLY, undefined],
    ["EOD", "provisional", {}, clock, 4],
  ] as const)("%s, day(1) head %s → served day(1) %s", async (_, head, opts, at, day1) => {
    const store = new ProbeStore();
    const runAt = head === "provisional" ? `${day(1)}T00:00:01.000Z` : `${ASOF}T06:00:00.000Z`;
    if (head !== "absent") await store.recordReadings([makeStoredReading("F1", { date: day(1), value: 7, ...(head === "estimated" ? { estimated: true } : {}) })], runAt);
    const series = [...carriedOf("F1", [reading(day(1), 4)]).slice(0, -1), reading(ASOF, 5), reading(day(-1), 9)];
    const written: string[] = [];
    await gapFillSweep(store, new Map([["F1", series.map(toStoredReading)]]), ASOF, at, { ...opts, onWritten: (_id, d) => written.push(d) });
    expect(written).toEqual(day1 === 4 ? [day(1), ASOF] : [ASOF]);
    const served = new Map((await store.getSeries("F1", 10)).map((p) => [p.date, p]));
    expect([served.get(day(1))?.value, served.get(day(1))?.estimated]).toEqual([day1, head === "estimated" && day1 !== 4 ? true : undefined]);
  });

  // R1: a fallback-fed id keeps its stored FINAL value; every other id repairs.
  it.each([
    [{ insertOnlyIds: new Set(["F1"]), insertOnlyReason: "provider fallback" }, { F1: 40, G1: 3 }, "(1 id(s) insert-only: provider fallback)"],
    [{ valueRepair: false, insertOnlyReason: "unclaimed provider fallback QQQ" }, { F1: 40, G1: 40 }, "(insert-only run: unclaimed provider fallback QQQ)"],
  ])("%o: stored day(3) finals → %o, day(1) inserted for both, summary says %s", async (opts, day3, note) => {
    const store = new ProbeStore();
    await store.recordReadings(["F1", "G1"].map((id) => makeStoredReading(id, { date: day(3), value: 40 })), "2026-09-29T22:55:00.000Z");
    const carried = new Map(["F1", "G1"].map((id) => [id, carriedOf(id, [reading(day(3), 3, id), reading(day(1), 4, id)]).map(toStoredReading)]));
    const lines: string[] = [];
    await gapFillSweep(store, carried, ASOF, clock, { ...opts, log: (l) => lines.push(l) });
    for (const id of ["F1", "G1"] as const)
      expect((await store.getSeries(id, 10)).map((p) => [p.date, p.value]), id).toEqual([[day(3), day3[id]], [day(1), 4]]);
    expect(lines.at(-1)).toContain(note);
  });

  /** Mirrors `readings`' NOT NULL `value`/`delta20` (a non-finite serialises to null) + an optional poisoned id. */
  class StrictStore extends InMemoryStore {
    constructor(private readonly poisoned?: string) {
      super();
    }
    override async recordReadings(rows: Parameters<InMemoryStore["recordReadings"]>[0], runAt: string): Promise<void> {
      if (rows.some((r) => !Number.isFinite(r.value) || !Number.isFinite(r.delta20))) throw new Error("null value violates not-null constraint");
      if (rows.some((r) => r.indicatorId === this.poisoned)) throw new Error(`insert rejected for ${this.poisoned}`);
      return super.recordReadings(rows, runAt);
    }
  }
  const ids = ["F1", "G1", "FXH"];
  const sweep = (store: InMemoryStore, nanG1 = false) =>
    gapFillSweep(store, new Map(ids.map((id) => [id, carriedOf(id, [reading(day(3), nanG1 && id === "G1" ? NaN : 3, id), reading(day(1), 4, id)]).map(toStoredReading)])), ASOF, clock);
  const datesOf = async (store: InMemoryStore) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await store.getSeries(id, 100)).map((p) => p.date)])));

  it("a non-finite row is dropped per id — every other row of every id still lands", async () => {
    resetDegradeLog();
    const store = new StrictStore();
    expect(await sweep(store, true)).toBe(5);
    expect(await datesOf(store)).toEqual({ F1: [day(3), day(1)], G1: [day(1)], FXH: [day(3), day(1)] });
    expect(peekDegradeLog()).toEqual([]);
  });

  it("a batch insert that throws for one id falls back per id: the others land, the failure is a degrade event", async () => {
    resetDegradeLog();
    const store = new StrictStore("G1");
    expect(await sweep(store)).toBe(4);
    expect(await datesOf(store)).toEqual({ F1: [day(3), day(1)], G1: [], FXH: [day(3), day(1)] });
    expect(peekDegradeLog().map((e) => e.scope)).toEqual([expect.stringMatching(/^\[gap-fill\] G1 /)]);
  });

  it("a failed stored-window probe writes nothing and records a degrade event, never a throw", async () => {
    resetDegradeLog();
    const store = new ProbeStore(new Error("probe down"));
    expect(await sweep(store)).toBe(0);
    expect(peekDegradeLog()).toEqual([{ scope: expect.stringMatching(/^\[gap-fill\] /), reason: "probe down", effect: "notify" }]);
  });
});

// A2: a D row stamped before D's cutoff is rewritten from the feed; one stamped at the cutoff is final — kept by backfillHistory,
// value-repaired by gapFillSweep.
describe.each([
  ["gapFillSweep", (store: InMemoryStore, s: Reading[]) => gapFillSweep(store, new Map([["F1", carriedOf("F1", s).map(toStoredReading)]]), ASOF, clock)],
  ["backfillHistory", (store: InMemoryStore, s: Reading[]) => backfillHistory(store, "F1", s, BACKFILL_PROBE_LIMIT, clock)],
])("%s — provisional stored row", (name, fill) => {
  const repairs = name === "gapFillSweep";
  const D = "2026-09-28";
  const at = (min: number) => new Date(Date.parse(`${D}T00:00:00Z`) + min * 60_000).toISOString();
  it.each([
    [INTRADAY_CUTOFF_UTC_MIN - 1, 1, 4],
    [INTRADAY_CUTOFF_UTC_MIN, repairs ? 1 : 0, repairs ? 4 : 40],
  ])("stored at minute %i → writes %i, newest D value %i, final", async (min, writes, value) => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F1", { date: D, value: 40 })], at(min));
    expect(await fill(store, [reading(D, 4)])).toBe(writes);
    const p = (await store.getSeries("F1", 10)).find((q) => q.date === D)!;
    expect({ value: p.value, provisional: isProvisional(p) }).toEqual({ value, provisional: false });
  });

  it("a final-timed `estimated` stored row is rewritten by the print, as a provisional one is (N1)", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F1", { date: D, value: 40, estimated: true })], at(INTRADAY_CUTOFF_UTC_MIN));
    expect(await fill(store, [reading(D, 4)])).toBe(1);
    expect((await store.getSeries("F1", 10)).filter((q) => q.date === D).map((q) => [q.value, q.estimated === true])).toEqual([[4, false]]);
  });
});

// A date scored off an `estimated` obs (a closes provider meta close) is never FINAL.
describe("backfillHistory — an estimate-sourced date never lands FINAL", () => {
  const D = ASOF;
  const est = new Set([D]);
  const fill = (store: InMemoryStore, s: Reading[], reshadowFloor?: string) =>
    backfillHistory(store, "F1", s, BACKFILL_PROBE_LIMIT, clock, reshadowFloor, false, undefined, undefined, undefined, est);
  const onD = async (store: InMemoryStore) => store.readings.filter((r) => r.indicatorId === "F1" && r.date === D).map((r) => [r.value, r.estimated === true]);

  it("no stored D row ⇒ D is written `estimated`, the print before it FINAL", async () => {
    const store = new InMemoryStore();
    expect(await fill(store, [reading(day(1), 3), reading(D, 4)])).toBe(2);
    expect(await onD(store)).toEqual([[4, true]]);
    expect((await store.getSeries("F1", 10)).find((p) => p.date === day(1))).not.toHaveProperty("estimated");
  });

  it("a stored D estimate (the run's own row) is left alone — no FINAL rewrite of the same estimate", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F1", { date: D, value: 40, estimated: true })], "2026-09-29T22:00:00.000Z");
    expect(await fill(store, [reading(D, 4)])).toBe(0);
    expect(await onD(store)).toEqual([[40, true]]);
  });

  it("a stored D print is never re-shadowed by the estimate", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F1", { date: D, value: 40 })], "2026-09-29T22:00:00.000Z");
    expect(await fill(store, [reading(D, 4)], day(5))).toBe(0);
    expect(await onD(store)).toEqual([[40, false]]);
  });
});

// Official-leg gaps (`keepHoles`): a date ≥ `reshadowFloor` the official feed lacks is never FINAL — its stored non-estimate row
// is deleted and rewritten `estimated` (the series row if the rebuild carries the date, else the stored row's own value).
describe("backfillHistory — official-leg gap dates (keepHoles)", () => {
  const STORED_AT = "2026-09-29T22:00:00.000Z"; // after every fixture date's cutoff ⇒ stored rows are settled (FINAL)
  const days = (from: number, to: number): string[] => Array.from({ length: from - to + 1 }, (_, i) => day(from - i));
  const storeFinals = async (store: InMemoryStore, dates: string[], value = 40) =>
    store.recordReadings(dates.map((date) => makeStoredReading("F1", { date, value })), STORED_AT);
  const fill = (store: InMemoryStore, s: Reading[], floor: string, keepHoles: Set<string>, est: Set<string> = new Set()) =>
    backfillHistory(store, "F1", s, BACKFILL_PROBE_LIMIT, clock, floor, false, undefined, undefined, undefined, est, keepHoles);
  const rowsOn = (store: InMemoryStore, d: string) =>
    store.readings.filter((r) => r.indicatorId === "F1" && r.date === d).map((r) => [r.value, r.estimated === true]);
  const served = async (store: InMemoryStore, d: string) =>
    (await store.getSeries("F1", BACKFILL_PROBE_LIMIT)).filter((p) => p.date === d).map((p) => [p.value, p.estimated === true]);

  it("a FINAL on a gap ≥ the floor is deleted and restamped `estimated` — own value if the series lacks the date, the series row if not; a pre-floor gap stays FINAL", async () => {
    const store = new InMemoryStore();
    const [floor, lacking, carried, preFloor] = [day(50), day(10), day(20), day(55)];
    await storeFinals(store, [preFloor, ...days(50, 1)]);
    const series = days(50, 1).filter((d) => d !== lacking).map((d) => reading(d, d === carried ? 7 : 3));
    await fill(store, series, floor, new Set([lacking, carried, preFloor]));
    expect([await rowsOn(store, lacking), await rowsOn(store, carried), await served(store, day(30)), await rowsOn(store, preFloor)]).toEqual([
      [[40, true]], // the series lacks it: the stored value, restamped estimated (the old FINAL deleted, not shadowed)
      [[7, true]], // the series carries it: the fresh value, estimated
      [[3, false]], // a non-gap date ≥ the floor: a plain FINAL re-shadow (served row)
      [[40, false]], // below the floor: not an official gap — untouched
    ]);
  });

  it("refuses (throws, writes nothing) when gap dates ≥ the floor exceed OFFICIAL_GAP_MAX_SHARE (5%) of the span; at the cap it runs", async () => {
    const store = new InMemoryStore();
    await storeFinals(store, days(20, 1));
    const series = days(20, 1).map((d) => reading(d, 3)); // span 20 ⇒ cap 1 gap date
    const before = structuredClone(store.readings);
    // Pre-floor keepHoles never count toward the share.
    await expect(fill(store, series, day(20), new Set([day(5), day(9)]))).rejects.toThrow(/F1: refusing official-gap rewrite — 2 gap date\(s\) over 20 row\(s\)/);
    expect(store.readings).toEqual(before);
    expect(await fill(store, series, day(20), new Set([day(5), day(30), day(40)]))).toBe(20);
    expect(await rowsOn(store, day(5))).toEqual([[3, true]]);
  });

  it("a gap date already holding a settled `estimated` row, estimate-sourced this run, is left alone — not deleted, not rewritten", async () => {
    const store = new InMemoryStore();
    const gap = day(10);
    await storeFinals(store, days(20, 1).filter((d) => d !== gap));
    await store.recordReadings([makeStoredReading("F1", { date: gap, value: 40, estimated: true })], STORED_AT);
    await fill(store, days(20, 1).map((d) => reading(d, d === gap ? 7 : 3)), day(20), new Set([gap]), new Set([gap]));
    expect(await rowsOn(store, gap)).toEqual([[40, true]]);
  });
});

// A synthPriors id's gap row must pool the STORED history (as the cron's own row does), not the
// shallow feed prefix — the cron fetches ~2y while the store holds the deep series (review finding 1).
describe("scoreFred — synthPriors per-day window (F3)", () => {
  const F3 = INDICATORS.find((i) => i.id === "F3")!;
  const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  // 400 stored days at a low level, then a 60-day feed window at a distinctly higher, wiggling level.
  const obs = Array.from({ length: 60 }, (_, i) => ({ date: day(400 + i), value: 0.2 + Math.sin(i / 3) * 0.05 }));
  const setup = async () => {
    const store = new InMemoryStore();
    await store.recordReadings(
      Array.from({ length: 400 }, (_, i) => makeStoredReading("F3", { date: day(i), value: -0.5 + (i % 7) * 0.01 })),
      "2025-12-31T00:00:00.000Z",
    );
    const loop = makeFredLoop({
      env: {},
      dbFirst: { store, runAt: `${obs.at(-1)!.date}T22:55:00.000Z` },
      calib: [],
      synthLoad: await loadSynthHistoriesDated(store),
      postInversionShortLeg: Promise.resolve([]),
    });
    return { store, loop };
  };

  it("carries confirmClosesFor rows before the window, the per-day rows equal the stored-pool scorer's, newest == the cron's scalar", async () => {
    const { store, loop } = await setup();
    const series = await loop.scoreFred(F3, obs);
    const at = obs.findIndex((o) => o.date >= gapFillFrom(obs.at(-1)!.date));
    const from = obs[at - confirmClosesFor("F3")]!.date;
    const stored = await store.getSeries("F3", 5000);
    const perDay = scoreWithCutsSeriesPerDay(F3, obs, [], undefined, { from, stored });
    expect(series[0]!.date).toBe(from);
    expect(series.slice(0, -1)).toEqual(perDay.slice(0, -1));
    const key = (r: Reading) => ({ d: r.date, s: r.state, c: r.bandCuts });
    expect(key(perDay.at(-1)!)).toEqual(key(series.at(-1)!));
  });

  it("`from` bounds the scored days only: bounded rows equal the unbounded call's rows on/after `from`", async () => {
    const { store } = await setup();
    const stored = await store.getSeries("F3", 5000);
    const from = obs[50]!.date;
    const bounded = scoreWithCutsSeriesPerDay(F3, obs, [], undefined, { from, stored });
    expect(bounded.length).toBe(10);
    expect(bounded).toEqual(scoreWithCutsSeriesPerDay(F3, obs, [], undefined, { stored }).filter((r) => r.date >= from));
  });
});

describe("sweepEodRows — the ONE EOD cleaner", () => {
  const RUN_AT = "2026-09-29T22:55:00.000Z";
  const STAMP_AT = "2026-09-29T22:55:00.001Z";
  const run = (estimated: Record<string, string[]> = {}, firedAt = RUN_AT): EodRun => ({
    today: ASOF,
    firedAt,
    stampAt: new Date(Date.parse(firedAt) + 1).toISOString(),
    estimated: new Map(Object.entries(estimated).map(([id, ds]) => [id, new Set(ds)])),
    keepRunAt: eodKeepRunAt(),
  });
  const provAt = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + (INTRADAY_CUTOFF_UTC_MIN - 1) * 60_000).toISOString();
  const eodAt = (d: string): string => `${d}T22:00:00.000Z`;
  const rawOn = (store: InMemoryStore, id: string, d: string) =>
    store.readings.filter((r) => r.indicatorId === id && r.date === d).map((r) => ({ value: r.value, estimated: r.estimated === true, runAt: r.runAt }));

  it("(a) a provisional head shadowing this run's estimate is deleted; the estimate serves and the FINAL row before it stays", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("G1", { date: "2026-09-28", value: 1 })], eodAt("2026-09-28"));
    await store.recordReadings([makeStoredReading("G1", { date: ASOF, value: 2 })], provAt(ASOF));
    await store.recordReadings([{ ...makeStoredReading("G1", { date: ASOF, value: 3 }), estimated: true }], STAMP_AT);
    expect((await store.getSeries("G1", 1))[0]?.value).toBe(2); // premise: the non-estimate head shadows the estimate (`pickRecent`)
    await sweepEodRows(store, ["G1"], GAP_FILL_DAYS, run({ G1: [ASOF] }));
    expect(rawOn(store, "G1", ASOF)).toEqual([{ value: 3, estimated: true, runAt: STAMP_AT }]);
    expect(rawOn(store, "G1", "2026-09-28")).toEqual([{ value: 1, estimated: false, runAt: eodAt("2026-09-28") }]);
  });

  it("(b) an estimate a FINAL print superseded dies — so does one on a date the next print skipped — and the FINAL stays", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([{ ...makeStoredReading("R2", { date: "2026-09-25", value: 5 }), estimated: true }], eodAt("2026-09-25"));
    await store.recordReadings([{ ...makeStoredReading("R2", { date: "2026-09-28", value: 6 }), estimated: true }], eodAt("2026-09-28"));
    await store.recordReadings([makeStoredReading("R2", { date: "2026-09-28", value: 7 })], RUN_AT);
    await store.recordReadings([makeStoredReading("R2", { date: ASOF, value: 8 })], RUN_AT);
    await sweepEodRows(store, ["R2"], GAP_FILL_DAYS, run());
    expect(store.readings.filter((r) => r.indicatorId === "R2").map((r) => [r.date, r.value, r.estimated === true])).toEqual([
      ["2026-09-28", 7, false],
      [ASOF, 8, false],
    ]);
  });

  it("(c) feed-down: a provisional non-estimate head with no FINAL row and no estimate from this run is re-stamped as this run's estimate; an `estimated` head keeps its own run_at", async () => {
    const store = new ProbeStore();
    const old = day(5);
    await store.recordReadings([makeStoredReading("F4", { date: old, value: 0 })], provAt(old)); // past the read window
    await store.recordReadings([makeStoredReading("F4", { date: "2026-09-25", value: 1 })], eodAt("2026-09-25"));
    await store.recordReadings([makeStoredReading("F4", { date: "2026-09-28", value: 2 })], provAt("2026-09-28"));
    await store.recordReadings([{ ...makeStoredReading("F4", { date: ASOF, value: 4 }), estimated: true }], provAt(ASOF)); // a daytime estimate head
    await sweepEodRows(store, ["F4"], 3, run());
    expect(store.bulkCalls[0]?.[1]?.limit).toBe(3); // ONE bulk read of the window, never a per-id loop
    expect(rawOn(store, "F4", "2026-09-28")).toEqual([{ value: 2, estimated: true, runAt: STAMP_AT }]);
    expect(rawOn(store, "F4", ASOF)).toEqual([{ value: 4, estimated: true, runAt: provAt(ASOF) }]);
    expect(rawOn(store, "F4", "2026-09-25")).toEqual([{ value: 1, estimated: false, runAt: eodAt("2026-09-25") }]);
    expect(rawOn(store, "F4", old)).toEqual([{ value: 0, estimated: false, runAt: provAt(old) }]); // outside `limit`: untouched
    expect((await store.getSeries("F4", 5)).filter((p) => isProvisional(p, "F4")).map((p) => p.date)).toEqual([old, ASOF]);
  });

  it("a provisional head the next FINAL print skipped is an orphan: deleted, never re-stamped (its carry/gap is the carry pass's)", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F4", { date: "2026-09-25", value: 1 })], provAt("2026-09-25"));
    await store.recordReadings([makeStoredReading("F4", { date: "2026-09-28", value: 2 })], eodAt("2026-09-28"));
    await sweepEodRows(store, ["F4"], GAP_FILL_DAYS, run());
    expect(store.readings.map((r) => r.date)).toEqual(["2026-09-28"]);
  });

  it("a forced EOD run before the cutoff: its own rows (provisional-looking at `run_at` = firedAt) are never heads — untouched, non-estimated", async () => {
    const store = new InMemoryStore();
    const firedAt = `${ASOF}T14:00:00.000Z`;
    await store.recordRun([makeStoredReading("F4", { date: ASOF, value: 1 }), makeStoredReading("BUND", { date: ASOF, value: 2 })], firedAt, makeAlert({ date: ASOF, firedAt }));
    await sweepEodRows(store, ["F4", "BUND"], GAP_FILL_DAYS, run({}, firedAt));
    expect((await store.getReadingsForRun(firedAt)).map((r) => [r.indicatorId, r.value, r.estimated === true])).toEqual([["F4", 1, false], ["BUND", 2, false]]);
    expect(store.readings.filter((r) => r.estimated === true)).toEqual([]);
  });

  it("a seed-tail id's daytime head (EXSH.DE) keeps its own `run_at` — never re-stamped; a quote card head in the same state is", async () => {
    const store = new InMemoryStore();
    const noon = `${ASOF}T12:00:00.000Z`;
    expect([eodKeepRunAt().has("EXSH.DE"), eodKeepRunAt().has("BUND")]).toEqual([true, false]); // premise: the roster derivation
    await store.recordReadings([makeStoredReading("EXSH.DE", { date: ASOF, value: 50 }), makeStoredReading("BUND", { date: ASOF, value: 80 })], noon);
    await sweepEodRows(store, ["EXSH.DE", "BUND"], GAP_FILL_DAYS, run());
    expect(rawOn(store, "EXSH.DE", ASOF)).toEqual([{ value: 50, estimated: false, runAt: noon }]);
    expect(rawOn(store, "BUND", ASOF)).toEqual([{ value: 80, estimated: true, runAt: STAMP_AT }]);
  });

  it("a >24 h-window id's D−1 row (F17, written D−1 22:00Z) is still provisional at EOD D yet never re-stamped; F4's is FINAL", async () => {
    const store = new InMemoryStore();
    const prev = "2026-09-28";
    await store.recordReadings([makeStoredReading("F17", { date: prev, value: 150 }), makeStoredReading("F4", { date: prev, value: 2 })], eodAt(prev));
    expect([isProvisional({ date: prev, runAt: eodAt(prev) }, "F17"), isProvisional({ date: prev, runAt: eodAt(prev) }, "F4")]).toEqual([true, false]); // premise
    await sweepEodRows(store, ["F17", "F4"], GAP_FILL_DAYS, run());
    expect([rawOn(store, "F17", prev), rawOn(store, "F4", prev)]).toEqual([[{ value: 150, estimated: false, runAt: eodAt(prev) }], [{ value: 2, estimated: false, runAt: eodAt(prev) }]]);
  });

  it("(d) a FINAL row is never deleted, even with a provisional sibling on its date and this run's estimate claiming the date", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("G1", { date: "2026-09-28", value: 1 })], provAt("2026-09-28"));
    await store.recordReadings([makeStoredReading("G1", { date: "2026-09-28", value: 9 })], eodAt("2026-09-28"));
    await sweepEodRows(store, ["G1"], GAP_FILL_DAYS, run({ G1: ["2026-09-28"] }));
    // The served row is the FINAL, so the date holds no head: both rows stay (a sibling a FINAL shadows is the prune GC's).
    expect(rawOn(store, "G1", "2026-09-28")).toEqual([
      { value: 1, estimated: false, runAt: provAt("2026-09-28") },
      { value: 9, estimated: false, runAt: eodAt("2026-09-28") },
    ]);
    expect((await store.getSeries("G1", 5)).map((p) => p.value)).toEqual([9]);
  });
});

// ECY's month row is dated M-01, so the gap-fill writes a closed
// month FINAL off its now-official DFII10 (`GAP_FILL_DAYS_OF`); the open month stays the run's `estimated` head.
describe("ECY month roll-over — the closed month lands FINAL", () => {
  const month = (back: number): string => new Date(Date.UTC(2026, 9 - back, 1)).toISOString().slice(0, 10); // back 0 = Oct
  const N = ECY_MIN_OBS + 6; // past `confirmClosesFor(ECY)`'s bootstrap head
  const f7Through = (newest: number): Observation[] => Array.from({ length: N - newest }, (_, i) => ({ date: month(N - 1 - i), value: 25 + (i % 2) }));
  const officialThrough = (newest: number): Observation[] => f7Through(newest).map((o) => ({ date: o.date.replace(/01$/, "15"), value: 1 }));

  it("the roll-over run re-scores M off the official DFII10, writes it FINAL and sweeps M's estimate; M+1 stays estimated", async () => {
    const store = new InMemoryStore();
    // Run in M: September's newest DFII10 obs is a Treasury head, so Sep-01 is stored `estimated` (the run's head).
    const dfiiM = [...officialThrough(1), { date: "2026-09-29", value: 2, estimated: true as const }];
    const inM = ecyReadingSeries(ECY, f7Through(1), dfiiM).at(-1)!;
    await store.recordReadings([{ ...toStoredReading(inM), estimated: true }], "2026-09-29T22:00:00.000Z");
    // Roll-over run: Sep-30 printed official, October heads.
    const dfii = [...officialThrough(1), { date: "2026-09-30", value: 1.5 }, { date: "2026-10-02", value: 2, estimated: true as const }];
    const series = ecyReadingSeries(ECY, f7Through(0), dfii);
    const sourced = new Map([["ECY", new Set(ecyEstimateDates(series, dfii))]]);
    expect([series.at(-1)!.date, [...sourced.get("ECY")!]]).toEqual(["2026-10-01", ["2026-10-01"]]); // premise: Oct is the head
    await gapFillSweep(store, withoutEstimateSourced(new Map([["ECY", series.map(toStoredReading)]]), sourced), "2026-10-02", clock);
    await sweepEodRows(store, ["ECY"], GAP_FILL_DAYS, { today: "2026-10-02", firedAt: "2026-10-02T22:55:00.000Z", stampAt: "2026-10-02T22:55:00.001Z", estimated: new Map(), keepRunAt: new Set() });
    const sep = series.find((r) => r.date === "2026-09-01")!;
    expect(sep.level).not.toBeCloseTo(inM.level, 6); // premise: the official re-score differs from the head-scored row
    const served = (await store.getSeries("ECY", 5)).find((p) => p.date === "2026-09-01");
    expect([served?.value, served?.estimated]).toEqual([sep.level, undefined]);
    expect(store.readings.filter((r) => r.date === "2026-09-01" && r.estimated === true)).toEqual([]);
    expect(store.readings.some((r) => r.date === "2026-10-01")).toBe(false); // the open month is the run's own head, never gap-filled
  });
});
