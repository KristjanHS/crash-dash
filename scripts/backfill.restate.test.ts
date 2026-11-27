/**
 * backfill suite — RESTATE / RESHADOW / DEEPEN (split 2026-09-05 from backfill.test.ts): the
 * downside-break cut-retune restate (the one drift insert-missing cannot heal), the pension
 * reshadow-all feed-provenance re-seed, `--deepen` (a frozen left edge a normal run skips), the
 * VT term-structure seed, and the no-waste shrink + re-shadow proofs. Shared fixtures + the
 * memoized virgin run: backfill.test-helpers.ts. Job runs → backfill.jobs.test.ts; policy →
 * backfill.policy.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ALL_INDICATORS } from "../src/registry.js";
import { HIGH_WINDOW_SHORT } from "../src/family-descriptor-rows.js";
import { type Observation } from "../src/domain-types.js";
import { LAG_THRESHOLDS } from "../src/ladder.js";
import { PRE_FIRST_PRUNE_MAX_SHARE, RESTATE_TAIL_GRACE_DAYS, restateTailMaxAgeDays } from "../src/run-seeds.js";
import { backfillHistory, wallClock } from "../src/run-seeds.js";
import { InMemoryStore } from "../src/store-memory.js";
import { INTRADAY_CUTOFF_UTC_MIN, isProvisional } from "../src/intraday.js";
import type { StoredReading } from "../src/store.js";
import {
  DEEP_PROBE,
  FRESH_MARGIN_DAYS,
  RAW_WARMUP_DAYS,
  REVISION_TAIL_DAYS,
  backfillAll,
  backfillDownsideBreaks,
  backfillPension,
  isoDaysBefore,
  type BackfillDeps,
  type PensionBackfillDeps,
} from "./backfill.js";
import { VIX3M_SYMBOL } from "../src/vix_term.js";
import { isTargetClosed } from "../src/market-closures.js";
import {
  N,
  STUB_NOW,
  monthlyObs,
  obsSeries,
  opts,
  readingSeries,
  seedRow,
  sharedVirginRun,
  stub,
} from "./backfill.test-helpers.js";

let recFred: string[];

beforeAll(async () => {
  ({ recFred } = await sharedVirginRun());
});

// --- restate: CUT-retune propagation (2026-07-23) -----------------------------
//
// The one drift insert-missing cannot heal. A stored DB_* `state` was scored under the cuts in
// force the day it was written; DB_XLK's retune (−8/−15 → −5/−8) invalidated its whole history,
// and both the `since` re-shadow tail and a `full` insert-missing pass preserve those rows
// verbatim. The persisted state is CONSUMED by the replay probe (probe-earlywarn.ts), so a stale
// vintage silently replays the RETIRED model.
describe("backfillDownsideBreaks restate (cut-retune propagation)", () => {
  // 120 daily closes: 80 up to a 139.5 peak, then a ~7% slide — deep enough to trip the −5 amber
  // both detectors carry today, shallow enough to stay clear of the −8 red. The stale vintage
  // below hardcodes GREEN for the same dates, which is what a pre-retune history looks like and
  // exactly what insert-missing cannot heal.
  const PEAK = 139.5;
  function slide(): Observation[] {
    const out: Observation[] = [];
    const d = new Date("2019-01-01T00:00:00Z");
    for (let i = 0; i < 120; i++) {
      out.push({ date: d.toISOString().slice(0, 10), value: i < 80 ? 100 + i * 0.5 : PEAK * (1 - (0.07 * (i - 79)) / 40) });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  const slideStub: PensionBackfillDeps = { fetchPrices: vi.fn(async () => slide()) };

  /** A STALE vintage: the real rows the scorer emits (hence the HIGH_WINDOW_SHORT warmup slice —
   *  earlier dates are unscoreable and prod never stored them), but every state hardcoded GREEN,
   *  which is exactly what a pre-retune history looks like: the retired −8 amber never fired on this
   *  slide. `decision` is non-null so backfillHistory's null-decision REPAIR path stays out of the
   *  way — the control arm must isolate insert-missing, not a second write path. */
  const staleRows = (id: string): StoredReading[] =>
    slide()
      .slice(HIGH_WINDOW_SHORT - 1)
      .map((o) => ({ date: o.date, indicatorId: id, value: o.value, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: -0.01 }));

  it("rebuilds the named detector's FULL history under a fresh vintage; an insert-missing pass leaves it stale", async () => {
    // CONTROL — the defect. A normal pass over an already-seeded span writes nothing, so the
    // stale GREEN vintage survives. Reverting the restate branch makes the restate arm below
    // match this one.
    const control = new InMemoryStore();
    await control.recordReadings(staleRows("DB_XLK"), "2019-05-01T00:00:00Z");
    const plain = await backfillDownsideBreaks(control, slideStub, opts);
    expect(plain.perLeg.DB_XLK).toBe(0);
    expect((await control.getSeries("DB_XLK", DEEP_PROBE)).every((p) => p.state === "GREEN")).toBe(true);

    // RESTATE — every stored date re-written under a fresh run_at (append-only; the runner's
    // pruneShadowedReadings then drops what this shadowed). Not the REVISION_TAIL_DAYS window:
    // a tail-only re-shadow would land far short of the full span.
    const store = new InMemoryStore();
    await store.recordReadings(staleRows("DB_XLK"), "2019-05-01T00:00:00Z");
    const re = await backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"] });
    const xlk = await store.getSeries("DB_XLK", DEEP_PROBE);
    expect(re.perLeg.DB_XLK).toBe(xlk.length);

    // The rebuilt rows carry the CURRENT cuts: the ~7% slide fires the −5 amber, where the stale
    // vintage said GREEN for every date. This is the assertion the control arm above inverts.
    expect(xlk.some((p) => p.state === "AMBER")).toBe(true);
    expect(xlk.every((p) => p.decision !== null && p.decision !== undefined)).toBe(true);
    // The unnamed detector is seeded by the same pass and scored under ITS OWN current cuts —
    // equal to DB_XLK's since DB_SMH's 2026-07-23 retune, so it fires here too (under the retired
    // −8 it stayed GREEN). A seam that scored one detector with the other's pair still lands here;
    // the per-id ROUTING witness lives at the scorer seam (dashboard.price-scorers.test.ts, injected table).
    const smh = await store.getSeries("DB_SMH", DEEP_PROBE);
    expect(smh.length).toBeGreaterThan(0);
    expect(smh.some((p) => p.state === "AMBER")).toBe(true);
  });

  it("is id-scoped — an unnamed detector takes the normal insert-missing path", async () => {
    const store = new InMemoryStore();
    await backfillDownsideBreaks(store, slideStub, opts); // seed both
    const re = await backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"] });
    expect(re.perLeg.DB_XLK).toBeGreaterThan(0);
    expect(re.perLeg.DB_SMH).toBe(0); // untouched: restating a detector whose cuts held is row churn
  });

  it("prunes calendar-hole dates the rebuilt feed never observes AND pre-first rows the restate's floor rolled past", async () => {
    // A feed flip's stray (the 2026-08-11 F9 incident shape): the OLD feed printed 2019-04-01,
    // the new one skips it (venue holiday) — interior to the rebuilt span, so no re-shadow can
    // ever land there and the old-unit vintage stays readings_latest without the prune.
    const holiday = "2019-04-01";
    const holeStub: PensionBackfillDeps = { fetchPrices: vi.fn(async () => slide().filter((o) => o.date !== holiday)) };
    // A pre-FLOOR row — older than BOTH the depth cutoff (years=100 ⇒ ~1924-06-01) and the first
    // scoreable rebuilt date (~2019-03-04 at highShort 63): an old-vintage prefix the rolling
    // restate floor left behind — the cron's expanding pool would keep reading it while the restate
    // never saw it (F3, 2026-09-02). Ruled: the restate's floor wins. A date INSIDE the depth
    // window would now survive as warm-up head (the spread-shaped test below).
    const preSpan: StoredReading = { date: "1923-06-15", indicatorId: "DB_XLK", value: 87.5, delta20: 0, rawState: "GREEN", state: "GREEN", decision: -0.01 };

    // CONTROL — a plain (non-restate) pass never deletes: the stray survives insert-missing.
    const control = new InMemoryStore();
    await control.recordReadings([...staleRows("DB_XLK"), preSpan], "2019-05-01T00:00:00Z");
    await backfillDownsideBreaks(control, holeStub, opts);
    const controlDates = new Set((await control.getSeries("DB_XLK", DEEP_PROBE)).map((p) => p.date));
    expect(controlDates.has(holiday)).toBe(true);
    expect(controlDates.has(preSpan.date)).toBe(true);

    const store = new InMemoryStore();
    await store.recordReadings([...staleRows("DB_XLK"), preSpan], "2019-05-01T00:00:00Z");
    await backfillDownsideBreaks(store, holeStub, { ...opts, restate: ["DB_XLK"] });
    const dates = new Set((await store.getSeries("DB_XLK", DEEP_PROBE)).map((p) => p.date));
    expect(dates.has(holiday)).toBe(false); // stranded old-feed vintage deleted, every vintage
    expect(dates.has(preSpan.date)).toBe(false); // pre-floor prefix deleted: store == rebuilt series
  });

  it("keeps warm-up rows INSIDE the depth window (spread-shaped: rebuild starts after the depth cutoff) — no throw, no prune", async () => {
    // The rebuilt series' first emitted date (~2019-03-04, the HIGH_WINDOW_SHORT warm-up) sits far
    // inside the years=100 depth window. The stored rows between the depth cutoff and that first
    // date are the analogue of a spread's stored-but-unscored σ head (a deeper depth override): pruning
    // at the bare first-emitted date would (a) trip the share guard — the head here is ~half the
    // store, so a restate of that id throws permanently — and (b) were the guard loosened, delete
    // exactly the rows the deeper override exists to keep. The prune floor is the DEEPER of the
    // depth cutoff and the first emitted date, so the head survives and counts for nothing.
    const stale = staleRows("DB_XLK");
    const head: StoredReading[] = slide()
      .slice(0, HIGH_WINDOW_SHORT - 1) // the unscoreable warm-up dates, all before the first emitted row
      .map((o) => ({ date: o.date, indicatorId: "DB_XLK", value: o.value, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: -0.01 }));
    // Premise (can-fail): the head alone is far over the share — pruning at the first emitted date
    // would THROW here, not silently pass; reverting the floor to `first` demonstrably reds this test.
    expect(head.length).toBeGreaterThan((stale.length + head.length) * PRE_FIRST_PRUNE_MAX_SHARE);
    const store = new InMemoryStore();
    await store.recordReadings([...stale, ...head], "2019-05-01T00:00:00Z");
    const re = await backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"] });
    expect(re.perLeg.DB_XLK).toBeGreaterThan(0); // the restate ran — no refusal throw
    const dates = new Set((await store.getSeries("DB_XLK", DEEP_PROBE)).map((p) => p.date));
    for (const r of head) expect(dates.has(r.date), `warm-up row ${r.date} must survive`).toBe(true);
  });

  it("refuses the pre-first prune when the rebuilt series looks truncated (share > PRE_FIRST_PRUNE_MAX_SHARE)", async () => {
    // A bot-challenged host serving a short window would otherwise let the prune wipe the history:
    // seed a pre-first prefix worth well over the share and expect a throw, not a deletion.
    const stale = staleRows("DB_XLK");
    const n = Math.ceil(stale.length * PRE_FIRST_PRUNE_MAX_SHARE) + 1;
    // Dated BEFORE the years=100 depth cutoff (~1924-06-01): the prune floor only reaches rows
    // older than BOTH bounds, so a prefix inside the depth window never trips this guard.
    const prefix: StoredReading[] = Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(1920, 0, 1 + i)).toISOString().slice(0, 10);
      return { date: d, indicatorId: "DB_XLK", value: 80, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: -0.01 };
    });
    const store = new InMemoryStore();
    await store.recordReadings([...stale, ...prefix], "2019-05-01T00:00:00Z");
    await expect(backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"] })).rejects.toThrow(/refusing restate prune/);
    // Nothing deleted on the refused path.
    expect((await store.getSeries("DB_XLK", DEEP_PROBE)).length).toBe(stale.length + prefix.length);
  });

  /** Stored-only rows dated `days` calendar days past the rebuilt series' newest bar. */
  const pastLast = (id: string, days: readonly number[]): StoredReading[] => {
    const last = Date.parse(`${slide().at(-1)!.date}T00:00:00Z`);
    return days.map((k) => ({
      date: new Date(last + k * 86_400_000).toISOString().slice(0, 10),
      indicatorId: id, value: 90, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: -0.01,
    }));
  };
  /** A restate `now` `days` calendar days past the rebuilt series' newest bar. */
  const nowPastLast = (days: number): Date => new Date(Date.parse(`${slide().at(-1)!.date}T00:00:00Z`) + days * 86_400_000);

  /** CG's shape: rebuild emits from 2010-01-01, depth cutoff 2011-01-01 (the read-path head trims deeper), a guard-sized 2008 prefix. */
  const cgWorld = async () => {
    const series = readingSeries(100);
    const row = (date: string): StoredReading => ({ date, indicatorId: "CG", value: 1, delta20: 0, rawState: "GREEN", state: "GREEN" });
    const prefix = Array.from({ length: series.length / 2 }, (_, i) => new Date(Date.UTC(2008, 0, 1 + i)).toISOString().slice(0, 10));
    expect(prefix.length).toBeGreaterThan((series.length + prefix.length) * PRE_FIRST_PRUNE_MAX_SHARE); // premise: guard-sized
    const store = new InMemoryStore();
    await store.recordReadings([...series.map((r) => row(r.date)), ...prefix.map(row)], "2019-05-01T00:00:00Z");
    const restate = (trimFloor: string) => backfillHistory(store, "CG", series, DEEP_PROBE, wallClock, undefined, true, "2011-01-01", "2010-04-15", trimFloor);
    return { series, prefix, store, restate };
  };

  it("prunes a pre-floor prefix over the share when the rebuild starts ON its trim floor (CG depth shrink)", async () => {
    const { series, prefix, store, restate } = await cgWorld();
    await restate(series[0]!.date);
    const dates = new Set((await store.getSeries("CG", DEEP_PROBE)).map((p) => p.date));
    for (const d of prefix) expect(dates.has(d), `pre-floor ${d} must be pruned`).toBe(false);
    expect(dates.has(series[0]!.date)).toBe(true);
  });

  it("refuses when the rebuild starts past its trim floor by more than a lag tier, even inside the depth cutoff (truncated head)", async () => {
    const { restate } = await cgWorld();
    expect(restateTailMaxAgeDays("CG")).toBeLessThan(200); // premise: 2009-06-01 → 2010-01-01 is out of tier
    await expect(restate("2009-06-01")).rejects.toThrow(/refusing restate prune/);
  });

  /** A lagged feed-swap (R8's shape): `n` stored rows on the rebuilt dates, plus stored-only rows `days` past its newest. */
  const r8World = async (days: readonly number[]) => {
    const series = readingSeries(100);
    const lastMs = Date.parse(`${series.at(-1)!.date}T00:00:00Z`);
    const iso = (k: number) => new Date(lastMs + k * 86_400_000).toISOString().slice(0, 10);
    const row = (date: string): StoredReading => ({ date, indicatorId: "R8", value: 9, delta20: 0, rawState: "GREEN", state: "GREEN" });
    const store = new InMemoryStore();
    await store.recordReadings([...series.map((r) => row(r.date)), ...days.map((k) => row(iso(k)))], "2019-05-01T00:00:00Z");
    return { store, series, iso };
  };

  it("prunes a lagged feed's tail past RESTATE_TAIL_GRACE_DAYS when the fetch is within restateTailMaxAgeDays", async () => {
    // The R8 2026-08-13 shape: the new feed ends before the stored grid, so the old feed's trailing
    // rows would stay `readings_latest`. A row inside the grace is a cron bar this fetch predates.
    const max = restateTailMaxAgeDays("R8");
    expect(max).toBeGreaterThan(RESTATE_TAIL_GRACE_DAYS); // premise: an R8 tail is prunable at all
    const { store, series, iso } = await r8World([RESTATE_TAIL_GRACE_DAYS, RESTATE_TAIL_GRACE_DAYS + 1, max]);
    await backfillHistory(store, "R8", series, DEEP_PROBE, wallClock, undefined, true, undefined, iso(max));
    const dates = new Set((await store.getSeries("R8", DEEP_PROBE)).map((p) => p.date));
    expect(dates.has(iso(RESTATE_TAIL_GRACE_DAYS)), "in-grace row must survive").toBe(true);
    for (const k of [RESTATE_TAIL_GRACE_DAYS + 1, max]) expect(dates.has(iso(k)), `post-grace +${k}d must be pruned`).toBe(false);
  });

  it("refuses the tail prune when the fetch's newest bar is older than restateTailMaxAgeDays (a stale fetch)", async () => {
    const max = restateTailMaxAgeDays("R8");
    const { store, series, iso } = await r8World([RESTATE_TAIL_GRACE_DAYS + 1, max + 1]);
    const before = (await store.getSeries("R8", DEEP_PROBE)).length;
    await expect(backfillHistory(store, "R8", series, DEEP_PROBE, wallClock, undefined, true, undefined, iso(max + 1))).rejects.toThrow(/looks stale/);
    expect((await store.getSeries("R8", DEEP_PROBE)).length).toBe(before);
  });

  it("a stale DAILY fetch refuses its tail prune and the other dbreak ids still write", async () => {
    // A daily tail needs age > grace, which only a stale fetch reaches: the cron row dated `now` must survive.
    const stale = staleRows("DB_XLK");
    const today = pastLast("DB_XLK", [RESTATE_TAIL_GRACE_DAYS + 1]);
    const store = new InMemoryStore();
    await store.recordReadings([...stale, ...today], "2019-05-01T00:00:00Z");
    const now = nowPastLast(RESTATE_TAIL_GRACE_DAYS + 1);
    await expect(backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"], now })).rejects.toThrow(/looks stale/);
    expect((await store.getSeries("DB_XLK", DEEP_PROBE)).length).toBe(stale.length + today.length);
    expect((await store.getSeries("RS_XLK", DEEP_PROBE)).length, "RS_XLK plans after DB_XLK").toBeGreaterThan(0);
  });

  it("restateTailMaxAgeDays calendarizes a slot tier and takes lagAfterDays as calendar days", () => {
    expect(restateTailMaxAgeDays("DB_XLK")).toBe(Math.ceil((LAG_THRESHOLDS.daily * 7) / 5));
    const r8 = ALL_INDICATORS.find((i) => i.id === "R8")!;
    expect(restateTailMaxAgeDays("R8")).toBe(r8.lagAfterDays);
  });

  it("refuses the tail prune when the rebuilt series' newest bar looks truncated (share > PRE_FIRST_PRUNE_MAX_SHARE)", async () => {
    const stale = staleRows("DB_XLK");
    const n = Math.ceil(stale.length * PRE_FIRST_PRUNE_MAX_SHARE) + 1;
    const tail = pastLast("DB_XLK", Array.from({ length: n }, (_, i) => RESTATE_TAIL_GRACE_DAYS + 1 + i));
    const store = new InMemoryStore();
    await store.recordReadings([...stale, ...tail], "2019-05-01T00:00:00Z");
    await expect(backfillDownsideBreaks(store, slideStub, { ...opts, restate: ["DB_XLK"] })).rejects.toThrow(/postdate the tail edge/);
    expect((await store.getSeries("DB_XLK", DEEP_PROBE)).length).toBe(stale.length + tail.length);
  });
});

// --- reshadow-all: feed-provenance re-seed (2026-07-23, LEGP plan Stage 3) -----
//
// The raw-close analogue of restate. A stored raw close is append-only insert-missing, so a feed
// re-provenance (LEGP_* chain rebase, DEXUSEU→the closes provider) that changes a date's VALUE cannot heal via a
// re-run — the date is already present. `--reshadow-all` re-writes every projected row under a
// fresh vintage. The load-bearing pairing: the fn must ALSO force a `full` fetch, else only the
// since-tail is refetched and re-written.
describe("backfillPension reshadow-all (feed-provenance re-seed)", () => {
  const stub = (): PensionBackfillDeps => ({ fetchPrices: vi.fn(async () => obsSeries(N)) });

  it("re-writes a named leg's FULL history (a forced full fetch) where an insert-missing re-run writes 0", async () => {
    // CONTROL — a plain re-run over an already-seeded span writes nothing (insert-missing finds
    // every date present). Reverting the reshadow branch makes the arm below match this.
    const store = new InMemoryStore();
    await backfillPension(store, stub(), opts);
    const plain = await backfillPension(store, stub(), opts);
    expect(plain.perLeg.DEXUSEU).toBe(0);

    // RESHADOW-ALL — DEXUSEU re-written in full; count equals the whole stored series, NOT 0 and
    // NOT the since-tail. Red if the plan-forcing is dropped (a since window rewrites only the tail).
    const deps = stub();
    const re = await backfillPension(store, deps, { ...opts, reshadowAll: ["DEXUSEU"] });
    const stored = await store.getSeries("DEXUSEU", DEEP_PROBE);
    expect(re.perLeg.DEXUSEU).toBe(stored.length);
    expect(re.perLeg.SPY).toBe(0); // id-scoped: an unnamed leg stays a no-op insert-missing pass
    // The reshadow leg fetches the UNBOUNDED deep window; a regression to the since planner would
    // pass a `lookbackDays` here (as the untouched SPY leg does), collapsing the re-seed to the tail.
    expect(deps.fetchPrices).toHaveBeenCalledWith("EURUSD=X", { deep: true });
  });
});

// --deepen (cause A): the planner reads only the NEWEST stored date, so a current id's frozen left
// edge never re-deepens after a window change. `--deepen` forces `full` for it. R1 ∈ SKIP_SAFE, so a
// normal current re-run SKIPS outright — only the deepen arm can move its edge (the mutation to delete).
describe("backfillAll --deepen re-fetches a frozen left edge a normal run skips", () => {
  const NOW = new Date("2024-06-01T00:00:00Z");
  const shallow = obsSeries(50, isoDaysBefore(NOW, 49)); //   newest == NOW, shallow left edge
  const deep = obsSeries(300, isoDaysBefore(NOW, 299)); //    newest == NOW, ~250 older rows below it
  const feedWith = (series: Observation[]): BackfillDeps => ({
    ...stub,
    fetchFred: async (s: string) =>
      s === "CPIAUCSL" || s === "UNRATE" ? monthlyObs(30) : s === "DFII10" ? monthlyObs(300, 1998) : series,
  });
  const run = (store: InMemoryStore, feed: BackfillDeps, extra: Record<string, unknown>) =>
    backfillAll(store, feed, { years: 100, now: NOW, only: ["R1"], ...extra });

  it("forces full for a current known-final id that a normal re-run skips", async () => {
    const store = new InMemoryStore();
    await run(store, feedWith(shallow), {});
    const afterSeed = (await store.getSeries("R1", DEEP_PROBE)).length;
    expect(afterSeed).toBeGreaterThan(0);

    // Normal re-run, DEEP feed: R1 is current + known-final ⇒ SKIP ⇒ the older rows are never fetched.
    const normal = await run(store, feedWith(deep), {});
    expect(normal.seeded.R1, "a current known-final id is skipped without --deepen").toBe(0);
    expect((await store.getSeries("R1", DEEP_PROBE)).length).toBe(afterSeed);

    // --deepen forces full ⇒ the deep feed's older rows are inserted. Red if the `|| deepen` arm is deleted.
    const deepened = await run(store, feedWith(deep), { deepen: ["R1"] });
    expect(deepened.seeded.R1, "--deepen re-fetches full history and inserts the older rows").toBeGreaterThan(0);
    expect((await store.getSeries("R1", DEEP_PROBE)).length).toBeGreaterThan(afterSeed);
  });

  it("a second --deepen run is idempotent (adds 0 — insert-missing, no destructive re-shadow)", async () => {
    const store = new InMemoryStore();
    await run(store, feedWith(deep), { deepen: ["R1"] });
    const again = await run(store, feedWith(deep), { deepen: ["R1"] });
    expect(again.seeded.R1).toBe(0);
  });
});

// N3 (2026-09-29): the euro spreads' sovereign-quote legs; only a restate re-writes the stored bp `value` of dates already held
// (insert-missing keeps the old feed's value), and it must join DE10Y-DE.
describe("backfillAll --restate rewrites the euro spread's stored VALUE off the sovereign-quote legs (N3)", () => {
  const IDS = ["BONOS"];
  const LEG: Record<string, string> = { BONOS: "ES10Y-ES" };
  // sovereign-quote DE10Y-DE alone carries a ±0.1bp wiggle (σ > 0) and a 10bp DOWN step over its last 5 closes: the spread's
  // velocity arm fires off it, while off a constant leg the spread is constant (σ = 0 ⇒ GREEN).
  const deps: BackfillDeps = {
    ...stub,
    fetchSovereignDaily: async (symbol, from, to) => {
      const obs = await stub.fetchSovereignDaily(symbol, from, to);
      if (symbol !== "DE10Y-DE") return obs;
      return obs.map((o, i) => ({ ...o, value: o.value + (i % 2) * 0.001 - (i >= obs.length - 5 ? 0.1 : 0) }));
    },
  };
  const run = (store: InMemoryStore, extra: Record<string, unknown>) =>
    backfillAll(store, deps, { years: 100, now: STUB_NOW, only: IDS, ...extra });
  const valueOn = async (store: InMemoryStore, id: string, date: string) =>
    (await store.getSeries(id, DEEP_PROBE)).find((p) => p.date === date)?.value;
  const sovereignLast = async (symbol: string) => (await deps.fetchSovereignDaily(symbol, "1970-01-01", "2100-01-01")).at(-1)!;

  it("insert-missing keeps a stale stored value; --restate rewrites it to (leg − DE10Y-DE) × 100", async () => {
    const de = await sovereignLast("DE10Y-DE");
    const last = de.date;
    const store = new InMemoryStore();
    for (const id of IDS) await seedRow(store, id, last); // value 100 = an old-feed vintage
    await run(store, {});
    for (const id of IDS) expect(await valueOn(store, id, last), `${id}: insert-missing keeps the old value`).toBe(100);

    const res = await run(store, { restate: IDS });
    expect(res.failures).toEqual([]);
    for (const [id, leg] of Object.entries(LEG)) {
      const want = ((await sovereignLast(leg)).value - de.value) * 100;
      expect(await valueOn(store, id, last), `${id}: restated value off ${leg} − DE10Y-DE`).toBeCloseTo(want, 6);
    }
  });

  it("a TARGET-closed leg bar produces no BONOS reading", async () => {
    const legDates = (await deps.fetchSovereignDaily("ES10Y-ES", "1970-01-01", "2100-01-01")).map((o) => o.date);
    const closed = legDates.filter(isTargetClosed);
    expect(closed).toEqual(expect.arrayContaining(["2024-01-01", "2024-03-29", "2024-04-01"])); // non-vacuity
    const store = new InMemoryStore();
    const res = await run(store, {});
    expect(res.failures).toEqual([]);
    for (const id of IDS) {
      const dates = (await store.getSeries(id, DEEP_PROBE)).map((p) => p.date);
      expect(dates.length, `${id}: seeded`).toBeGreaterThan(0);
      expect(dates.filter((d) => closed.includes(d)), id).toEqual([]);
      expect(dates, `${id}: the next open day stores`).toContain("2024-04-02");
    }
  });
});

describe("VT term-structure seed rides the live scorer's feed", () => {
  it("fetches the VIX3M leg from FRED (VXVCLS)", () => {
    // VXVCLS is VT's back leg and has no other consumer in `specs()`, so this discriminates the
    // FRED route from the price route on its own. Pinned against `vix_term.ts` (the live bottom/VT
    // feed) rather than a literal — the same-feed-as-the-live-scorer invariant this table documents.
    // Reads the shared virgin run's recorded calls.
    expect(recFred).toContain(VIX3M_SYMBOL);
  });
});

describe("no-waste: shrink proof (backfillPension bounds a stale leg's window)", () => {
  it("fetches SPY with lookbackDays = gap + RAW_WARMUP_DAYS, not the full deep history", async () => {
    const store = new InMemoryStore();
    const STALE_DAYS = 30; // pinned out-of-band; the fetch window must be exactly gap + warmup.
    // SPY stored STALE_DAYS old (> FRESH_MARGIN_DAYS) → since-shrink.
    await seedRow(store, "SPY", isoDaysBefore(opts.now, STALE_DAYS));

    const pensionStub: PensionBackfillDeps = { fetchPrices: vi.fn(async () => obsSeries(N)) };
    await backfillPension(store, pensionStub, opts);

    // Bounded window (deep + a lookback of gap+warmup) — NOT the unbounded `{ deep: true }` a full
    // plan sends. Goes red if the since-shrink collapses back to always-full.
    expect(pensionStub.fetchPrices).toHaveBeenCalledWith("SPY", {
      deep: true,
      lookbackDays: STALE_DAYS + RAW_WARMUP_DAYS,
    });
  });
});

// Run 2 lands ONE DAY later with the newest close REVISED: a distinct (later) run_at is the ONLY way
// readings_latest can supersede, and a series ENDING at `now` puts its tail on/after the reshadow floor.
describe("no-waste: re-shadow proof (a later run SUPERSEDES the revision tail under a fresh run_at)", () => {
  const data = obsSeries(N, "2025-08-01");
  const newest = data.at(-1)!;
  const revisedValue = newest.value + 5;
  const revised = data.map((o) => (o.date === newest.date ? { ...o, value: revisedValue } : o));
  const dayAfter = (days: number) => new Date(Date.parse(`${newest.date}T00:00:00Z`) + days * 86_400_000);
  type Run = (store: InMemoryStore, feed: Observation[], now: Date) => Promise<number | undefined>;
  const pension: Run = async (store, feed, now) =>
    (await backfillPension(store, { fetchPrices: async () => feed }, { years: 100, now, probe: DEEP_PROBE })).perLeg.SPY;
  // Window-honoring (`since`-sliced) like prod; F1 is revision-prone, so run 2 plans `since` + the re-shadow tail.
  const scored: Run = async (store, feed, now) => {
    const fetchFred: BackfillDeps["fetchFred"] = async (series, o) =>
      series === "CPIAUCSL" || series === "UNRATE" ? monthlyObs(30) : o.since ? feed.filter((x) => x.date >= o.since!) : feed;
    // run_at = `now` (as backfillPension stamps it): run 2's day-later run_at supersedes whatever the wall clock does.
    return (await backfillAll(store, { ...stub, fetchFred }, { years: 100, now, probe: DEEP_PROBE, only: ["F1"], clock: () => now.toISOString() })).seeded.F1;
  };

  it.each([
    ["backfillPension", "SPY", pension],
    ["backfillAll", "F1", scored],
  ] as const)("%s re-shadows %s's tail so getSeries serves the REVISED value", async (_fn, id, run) => {
    const store = new InMemoryStore();
    expect(await run(store, data, dayAfter(0))).toBeGreaterThan(0);
    const afterFirst = (await store.getSeries(id, DEEP_PROBE)).length;
    // Red if writeSet / backfillHistory's `reshadows` stops unioning the tail: newest−6 … newest.
    expect(await run(store, revised, dayAfter(1))).toBe(REVISION_TAIL_DAYS);
    const series = await store.getSeries(id, DEEP_PROBE);
    expect(series.length).toBe(afterFirst); // append-only vintage: a shadow row, no new obs date
    expect(series.find((p) => p.date === newest.date)!.value).toBeCloseTo(revisedValue);
  });
});

// A7: a provisional D older than the re-shadow tail is insert-missing's to rewrite; a final one stays.
describe("A7 — backfillPension rewrites a provisional stored date outside the re-shadow tail", () => {
  const D = isoDaysBefore(STUB_NOW, REVISION_TAIL_DAYS + 1);
  const at = (min: number) => new Date(Date.parse(`${D}T00:00:00Z`) + min * 60_000).toISOString();
  it.each([
    [INTRADAY_CUTOFF_UTC_MIN - 1, 50],
    [INTRADAY_CUTOFF_UTC_MIN, 999],
  ])("SPY stored at minute %i → newest D value %i, final", async (min, value) => {
    expect(REVISION_TAIL_DAYS + 1).toBeGreaterThan(FRESH_MARGIN_DAYS); // premise: a `since` plan, D below its tail
    const store = new InMemoryStore();
    const row: StoredReading = { date: D, indicatorId: "SPY", value: 999, delta20: 0, rawState: "GREEN", state: "GREEN" };
    await store.recordReadings([row], at(min));
    await backfillPension(store, { fetchPrices: async () => [{ date: D, value: 50 }] }, opts);
    const p = (await store.getSeries("SPY", 10)).find((q) => q.date === D)!;
    expect({ value: p.value, provisional: isProvisional(p) }).toEqual({ value, provisional: false });
  });
});
