import { describe, expect, test, vi, type Mock } from "vitest";
import { isSlotExcused } from "./market-closures.js";
import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import { ALL_INDICATORS } from "./registry.js";
import { DIAL_FAMILIES } from "./dial-assembly.js";
import type { RunInputs } from "./run-inputs.js";
import type { Observation } from "./domain-types.js";
import * as families from "./families.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import { VXNCLS } from "./registry-composite.js";
import { GAP_FILL_DAYS, gapFillFrom } from "./intraday.js";
import { provisionalRoster } from "./run-seeds.js";
import { INPUT_SERIES } from "./input-series.js";
import { BREADTH_STORE_IDS } from "./registry-price.js";
import { LADDER } from "./families.js";
import { OFF_LADDER_LEG_KEYS, SB_BENCH_ID, SB_STRAT_ID, legCloseId, offLadderLegCloseId } from "./scoreboard.js";
import { PCT_MIN_OBS } from "./percentile.js";
import { confirmClosesFor } from "./family-table.js";
import {
  ALL_CMP_IDS,
  FIXTURE_ASOF,
  fredMock,
  fredMockAt,
  ecbGreen,
  ECISS_FIXTURE_LEVEL,
  padHistory,
  monotonicClock,
  deepVixcls,
  deepVxntLegs,
  carriedDailyIds,
  atUtcMin,
  installRunTestHooks,
  fakeFeeds,
  deepHcxCloses,
  deepVxntPorts,
  runCycleWith,
  priorAlert,
  type FakeFeeds,
} from "./run.test-helpers.js";
import { INTRADAY_CUTOFF_UTC_MIN, isProvisional } from "./intraday.js";
import { makeStoredReading } from "./test-helpers.js";
import { FETCH_EDGE_SCORED_IDS } from "./slow.js";
import { rederiveFailedScope } from "./rederive.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// ECY scores only off a live CAPE + a deep DFII10 leg (the calm fixture degrades it to EMPTY, so the roster lint
// could never see it carried): flat CAPE × falling real yield ⇒ cheap ⇒ GREEN, months ending at FIXTURE_ASOF.
const ECY_MONTHS = PCT_MIN_OBS + 12;
const ecyMonth = (i: number): string => {
  const [y, m] = FIXTURE_ASOF.split("-").map(Number);
  const abs = y! * 12 + (m! - 1) - (ECY_MONTHS - 1 - i);
  return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`;
};
const scoreEcyThisRun = async (feeds: FakeFeeds): Promise<void> => {
  feeds.fetchCape.mockImplementation(async () => Array.from({ length: ECY_MONTHS }, (_, i) => ({ date: ecyMonth(i), value: 40 })));
  const base = feeds.fetchSeries.getMockImplementation()!;
  feeds.fetchSeries.mockImplementation(async (series, opts) =>
    series === "DFII10" && (opts?.fullHistory || opts?.since !== undefined)
      ? Array.from({ length: ECY_MONTHS }, (_, i) => ({ date: ecyMonth(i), value: 3 - (2 * i) / (ECY_MONTHS - 1) }))
      : base(series, opts),
  );
};

// The calm feeds sit at each scorer's minimum depth (FRED 30d, ESTR at scoreDerived's floor), so a carried series
// would start INSIDE the gap-fill window; left-pad every DAILY seam by FIXTURE_PAD days (monthly feeds untouched).
const FIXTURE_PAD = 2 * GAP_FILL_DAYS;
const DAY_MS = 86_400_000;
const padDaily = (obs: Observation[]): Observation[] => {
  const t = obs.map((o) => Date.parse(o.date));
  if (t.length < 2 || t.some((x, k) => k > 0 && x - t[k - 1]! > 4 * DAY_MS)) return obs;
  const pad = Array.from({ length: FIXTURE_PAD }, (_, i) => ({ ...obs[0]!, date: new Date(t[0]! - (FIXTURE_PAD - i) * DAY_MS).toISOString().slice(0, 10) }));
  return [...pad, ...obs];
};
const deepenDailySeams = (feeds: FakeFeeds): void => {
  const seams = [feeds.fetchSeries, feeds.fetchSovereignBars, feeds.fetchVixSeries, feeds.fetchEcbSeries, feeds.fetchNtfsSeries] as unknown as Array<Mock<(...a: unknown[]) => Promise<Observation[]>>>;
  for (const fn of seams) {
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (...a) => padDaily(await base(...a)));
  }
};

/** Ids written by their own history seeder, keyed by that writer — permanent opt-outs from the roster lint. */
const OWN_BACKFILL: Record<string, readonly string[]> = {
  seedInputSeriesOnCron: INPUT_SERIES.map((s) => s.id),
  seedLegClosesOnCron: [...LADDER.map(legCloseId), ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId)],
  resolveBreadthCloses: Object.values(BREADTH_STORE_IDS).map((i) => i.id),
  sbStoredReadings: [SB_STRAT_ID, SB_BENCH_ID],
  backfillCapeOnCron: ["F7"],
};
const optedOut = new Set(Object.values(OWN_BACKFILL).flat());

/** The `n`-th weekday before `date` (ISO). */
const weekdaysBack = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  for (let k = 0; k < n; ) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() % 6 !== 0) k++;
  }
  return d.toISOString().slice(0, 10);
};

describe("runScoringCycle - wiring (fetch → score → persist → push)", () => {
  // Root cause of the 2026-09-28 "7 feeds behind": the run persisted ONE newest row per id, so a date
  // never the newest on a run stayed a hole until a manual backfill. The table is every carried DAILY id.
  describe("gap-fill wiring table: every carried daily id (onGapFillSeries keys)", () => {
    const D = FIXTURE_ASOF; // a Friday
    const dM1 = weekdaysBack(D, 1);
    // `ecbGreen` sits at ESTR's scoreDerived MINIMUM ⇒ a 2-row carried series the sweep's trims empty; deepen ESTR here.
    // HCX + the slow/bottom tracks degrade on the calm fixture ⇒ deepen them too (the roster lint's overrides).
    // The roster lint's padded world (+ ECY scored, daily seams left-padded); a test re-mocking FRED after it drops both.
    const tableFeeds = async (end: string): Promise<FakeFeeds> => {
      const feeds = fakeFeeds(
        { fetchDailyCloses: deepHcxCloses(end), fetchSeries: async (s) => (s === "VIXCLS" ? deepVixcls(end) : fredMockAt(end)(s)) },
        end,
      );
      deepVxntPorts(feeds, end);
      feeds.fetchEcbSeries.mockImplementation(async (k) =>
        k === "ESTR" ? padHistory(ecbGreen(k, end), ecbGreen(k, end).length + GAP_FILL_DAYS) : ecbGreen(k, end),
      );
      await scoreEcyThisRun(feeds);
      deepenDailySeams(feeds);
      return feeds;
    };
    const runCarrying = async (feeds: FakeFeeds, clockIso: string, opts: { intraday?: boolean } = {}) => {
      let carried: ReadonlyMap<string, readonly StoredReading[]> | undefined;
      const alert = await runCycleWith(feeds, store, monotonicClock(clockIso), { ...opts, onGapFillSeries: (c) => (carried = c) });
      return { alert, carried: carried!, ids: carriedDailyIds(carried!) };
    };
    // `${id}@${date}` for each id whose stored `date` row is absent, provisional or the seeded sentinel.
    const nonFinal = async (ids: readonly string[], dates: readonly string[]): Promise<string[]> => {
      const out: string[] = [];
      for (const id of ids) {
        const byDate = new Map((await store.getSeries(id, 500)).map((p) => [p.date, p]));
        for (const d of dates) {
          const p = byDate.get(d);
          if (p === undefined || isProvisional(p) || p.value === -999) out.push(`${id}@${d}`);
        }
      }
      return out;
    };

    // Prices print a running D bar, FRED still ends D−1 ⇒ the nowcast ids' D estimate shadows their D−1 print
    // (the 2026-10-01 nowcast hole): D−1 lands FINAL on the intraday run for an id no EOD price symbol feeds; EOD fills the rest.
    test("intraday before the cutoff ⇒ D−1 past-date writes skip EOD-price ids; the same day's EOD ⇒ D−1 stored FINAL", async () => {
      const feeds = await tableFeeds(D);
      const fredDm1 = fredMockAt(dM1);
      feeds.fetchSeries.mockImplementation(async (s) => (s === VXNCLS.series ? deepVxntLegs(dM1).vxn : fredDm1(s)));
      const clock = atUtcMin(D, INTRADAY_CUTOFF_UTC_MIN - 5);
      const { ids } = await runCarrying(feeds, clock, { intraday: true });
      expect((await store.getSeries("G1", 1)).at(-1)?.date).toBe(D); // premise: the estimate heads G1
      const priceFed = ["DB_SMH", "F13"];
      expect(await nonFinal(["G1", ...priceFed], [dM1])).toEqual(priceFed.map((id) => `${id}@${dM1}`));
      await runCarrying(feeds, `${D}T22:55:00.000Z`);
      expect(await nonFinal(ids, [dM1])).toEqual([]);
    });

    // A D−1 head stored `estimated` (or absent) is replaced by the feed's FINAL bar on the next intraday run, bar an EOD-price id
    // (the closes provider by day — EOD's); a FINAL head stays. F2 is FRED-loop (claimed by its FRED series name, never price-fed): it repairs.
    test("intraday on D: estimated/absent D−1 heads → FINAL (sovereign-quote leg, `=X` leg, FRED loop); EOD-price + FINAL heads kept; EOD repairs the rest", async () => {
      const feeds = await tableFeeds(D);
      const [sovereign, fx, fred, eodPrice, final] = ["CMP_BUND_DE10Y", "CMP_FXH_DEXUSEU", "F2", "DB_SMH", "VIX"];
      await store.recordReadings([sovereign, eodPrice].map((id) => makeStoredReading(id, { date: dM1, value: -999, estimated: true })), `${dM1}T22:55:00.000Z`);
      await store.recordReadings([makeStoredReading(final, { date: dM1, value: -999 })], `${dM1}T22:55:00.000Z`);
      const heads = async (): Promise<[string, string][]> =>
        Promise.all([sovereign, fx, fred, eodPrice, final].map(async (id) => {
          const p = (await store.getSeries(id, 500)).find((q) => q.date === dM1);
          return [id, p === undefined ? "absent" : `${p.value === -999 ? "seeded" : "feed"}${p.estimated === true ? " est" : ""}`] as [string, string];
        }));
      const { ids } = await runCarrying(feeds, atUtcMin(D, INTRADAY_CUTOFF_UTC_MIN - 5), { intraday: true });
      expect(ids).toEqual(expect.arrayContaining([sovereign, fx, fred, eodPrice, final])); // premise: every pinned id is carried
      expect(await heads()).toEqual([[sovereign, "feed"], [fx, "feed"], [fred, "feed"], [eodPrice, "seeded est"], [final, "seeded"]]);
      await runCarrying(feeds, `${D}T22:55:00.000Z`);
      expect(await heads()).toEqual([[sovereign, "feed"], [fx, "feed"], [fred, "feed"], [eodPrice, "feed"], [final, "feed"]]);
    });

    // The ECB's weekly CISS release re-issues ~3.5 weeks of past obs: EOD overwrites a revised stored FINAL past the default window.
    test("EOD: a stored FINAL ECISS row the ECB revised 15 weekdays back is overwritten; 30 weekdays back and an unchanged row are not", async () => {
      const feeds = await tableFeeds(D);
      const ecb = feeds.fetchEcbSeries.getMockImplementation()!;
      const ecissObs = Array.from({ length: 80 }, (_, i) => ({ date: weekdaysBack(D, 79 - i), value: ECISS_FIXTURE_LEVEL }));
      feeds.fetchEcbSeries.mockImplementation(async (k, o) => (k === "ECISS" ? ecissObs : ecb(k, o)));
      const [revised, unchanged, outside] = [weekdaysBack(D, 15), weekdaysBack(D, 20), weekdaysBack(D, 30)];
      const seededAt = `${weekdaysBack(D, 1)}T22:55:00.000Z`;
      const seeded = Array.from({ length: 30 }, (_, i) => weekdaysBack(D, i + 1)).map((date) =>
        makeStoredReading("ECISS", { date, value: date === revised || date === outside ? -999 : ECISS_FIXTURE_LEVEL }));
      await store.recordReadings(seeded, seededAt);
      expect(gapFillFrom(D) > revised).toBe(true); // premise: the revised date lies past the default window
      const { ids } = await runCarrying(feeds, `${D}T22:55:00.000Z`);
      expect(ids).toContain("ECISS"); // premise: ECISS reaches the sweep
      const versions = async (date: string) => (await store.getReadingVersions("ECISS", date)).map((v) => [v.value, v.runAt]);
      expect((await versions(revised)).at(-1)).toEqual([ECISS_FIXTURE_LEVEL, expect.not.stringMatching(seededAt)]);
      expect(await versions(outside)).toEqual([[-999, seededAt]]);
      expect(await versions(unchanged)).toEqual([[ECISS_FIXTURE_LEVEL, seededAt]]);
    });

    // `rederiveOnWrite`: the EOD trigger reads store state, never the gap-fill's writes.
    // EOD D−1 at ORIG folded an F1@D−1 estimate head; the intraday run on D then writes F1@D−1's FINAL row.
    const ORIG = `${dM1}T22:55:00.000Z`;
    const headWorld = async () => {
      const roster = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].filter((id) => ALL_INDICATORS.some((i) => i.id === id));
      const head = { indicatorId: "F1", date: dM1, value: 1.37, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null, bandCuts: null } as const;
      const runInputs: RunInputs = { v: 1, refs: { last: null, prevDay: null, lastPush: null }, geoFlags: 0, crisisStage: 0, scored: [], lastBands: [],
        exposurePosture: null, fallShape: null, spDistToHigh: null, nearHighTol: null, stamps: {}, heads: [head] }; // run_inputs outlives the estimate sweep
      await store.recordRun(roster.map((id) => makeStoredReading(id, { date: id === "F1" ? weekdaysBack(D, 2) : dM1 })), ORIG, priorAlert({ date: dM1, firedAt: ORIG, runInputs }));
      const feeds = fakeFeeds({ fetchSeries: fredMockAt(dM1) }); // FRED ends D−1 every run: F1@D−1 is never a gap-fill date
      const logs = vi.mocked(console.log).mock.calls;
      const rederived = async (clockIso: string) => {
        const at = logs.length;
        const alert = await runCycleWith(feeds, store, monotonicClock(clockIso));
        const lines = logs.slice(at).map(([m]) => String(m));
        expect(lines.filter((m) => m.startsWith("[gap-fill] F1: wrote") && m.includes(dM1))).toEqual([]); // premise: no gap-fill write to key on
        return { lines: lines.filter((m) => m.startsWith(`[rederive] ${dM1}:`)), alert };
      };
      await runCycleWith(feeds, store, monotonicClock(atUtcMin(D, INTRADAY_CUTOFF_UTC_MIN - 5)), { intraday: true });
      return rederived;
    };

    test("EOD D−1 folded an F1@D−1 estimate head, an intraday persist finalizes it ⇒ EOD D logs `[rederive] D−1`; EOD D+1 never again", async () => {
      const eod = await headWorld();
      const rederived = async (clockIso: string) => (await eod(clockIso)).lines;
      const f1 = (await store.getReadingVersions("F1", dM1)).filter((v) => v.estimated !== true && !isProvisional(v, "F1"));
      expect(f1.map((v) => v.runAt! > ORIG)).toEqual([true]); // premise: the intraday run wrote F1@D−1's one FINAL row
      expect(await rederived(`${D}T22:55:00.000Z`)).toEqual([expect.any(String)]);
      expect((await store.getReadingVersions("F1", dM1)).filter((v) => v.runAt === `${D}T22:55:00.000Z`)).toHaveLength(1); // premise: EOD D re-wrote it
      expect(await rederived("2026-02-02T22:55:00.000Z")).toEqual([]);
    });

    test("EOD D's re-derive of D−1 fails once ⇒ D's row names D−1's fired_at in its degrade; EOD D+1 re-derives D−1", async () => {
      const eod = await headWorld();
      const getAlertAt = store.getAlertAt.bind(store);
      let armed = true;
      store.getAlertAt = (firedAt, opts) => {
        if (!armed || firedAt !== ORIG || opts?.withRunInputs !== true) return getAlertAt(firedAt, opts);
        armed = false;
        return Promise.reject(new Error("transient 503"));
      };
      const d = await eod(`${D}T22:55:00.000Z`);
      expect([armed, d.lines]).toEqual([false, []]); // premise: the step hit the one failure and re-derived nothing
      expect(d.alert.degraded?.map((e) => e.scope)).toContain(rederiveFailedScope(ORIG));
      expect((await eod("2026-02-02T22:55:00.000Z")).lines).toEqual([expect.any(String)]);
    });

    // Intraday and EOD price reads differ: a daytime value repair flips every EOD-price id's window twice a day.
    test("an intraday run never value-repairs a stale FINAL D−1; the next EOD run does (bar the read-edge slow legs), never under its own firedAt", async () => {
      const MON = "2026-02-02";
      const feeds = await tableFeeds(D);
      const { ids, carried } = await runCarrying(feeds, `${D}T22:55:00.000Z`);
      // Roster lint (R4): every persisted id is
      // carried with ≥2 dates reaching `gapFillFrom` past the sweep's trims, or opted out by its own seeder.
      const multiDate = new Set([...carried].filter(([, s]) => new Set(s.map((r) => r.date)).size >= 2).map(([id]) => id));
      const roster = provisionalRoster();
      expect([...new Set(roster)].filter((id) => !multiDate.has(id) && !optedOut.has(id))).toEqual([]);
      expect([...optedOut].filter((id) => !roster.includes(id))).toEqual([]);
      const from = gapFillFrom(FIXTURE_ASOF);
      expect(ids.filter((id) => (carried.get(id)!.slice(confirmClosesFor(id), -1)[0]?.date ?? "9999") > from)).toEqual([]);
      await store.recordReadings(ids.map((id) => makeStoredReading(id, { date: dM1, value: -999 })), `${D}T23:00:00.000Z`);
      const gapFillOnly = ["F13", "VIX", "DB_SMH", "complacency-high"];
      const edge = [...FETCH_EDGE_SCORED_IDS];
      expect(ids).toEqual(expect.arrayContaining([...gapFillOnly, ...edge])); // premise: every pinned id is carried
      await runCarrying(feeds, atUtcMin(MON, INTRADAY_CUTOFF_UTC_MIN - 5), { intraday: true });
      expect(await nonFinal(gapFillOnly, [dM1])).toEqual(gapFillOnly.map((id) => `${id}@${dM1}`));
      const { alert } = await runCarrying(feeds, `${MON}T22:55:00.000Z`);
      expect(await nonFinal([...gapFillOnly, ...edge], [dM1])).toEqual(edge.map((id) => `${id}@${dM1}`));
      const own = await store.getReadingsForRun(alert.firedAt);
      expect(ids.filter((id) => own.filter((r) => r.indicatorId === id).length > 1)).toEqual([]);
    });
  });

  test("rank 11: composite-component ids are excluded from scoring/dial BY CONSTRUCTION (pure constant, no cycle)", () => {
    // No component id is a registry/roll-up indicator, and none is whitelisted into any danger
    // family (US or GLOBAL) — so the family reduce and the T1 dial never see them (like DB_*/SB_*).
    const registryIds = new Set(ALL_INDICATORS.map((i) => i.id));
    const familyIds = new Set(
      [
        ...families.US_FAMILIES,
        ...families.GLOBAL_FAMILIES,
        ...families.DASHBOARD_FAMILIES,
      ].flatMap((f) => f.ids),
    );
    for (const id of ALL_CMP_IDS) {
      expect(registryIds.has(id)).toBe(false);
      expect(familyIds.has(id)).toBe(false);
    }
  });

  // IS-6 rung B, the 2026-07-17 outage shape driven end-to-end: the feed ANSWERS — no throw, so no
  // degrade fires — but with a close 60 days old, while the other FRED dailies are current. Post
  // rates-split (2026-08-19) the stale leg is a BAND-DRIVING rates member (R4, DFII10): R6/R7/EURC/
  // BUND are per-leg only and no longer in rates' coverage roster, so staling one of them would NOT
  // degrade rates coverage. R4 keeps its last-known state and the run goes loud through the COVERAGE
  // FLOOR instead. The run owes BOTH halves — (a) stored history stays honest at the frozen
  // `obs_date`, (b) the live board still refuses to read calm, now at WATCH.
  test("IS-6 rung B: stored R4 stays honest at the frozen obs_date, the live band reads WATCH via floor:coverage, [coverage] names R4", async () => {
    const FROZEN_RATE_DAYS = 60;
    // The run-time age is in publication SLOTS (weekends are never a slot, publication-calendar.ts `isWeekend`),
    // net of R4's excused closures (market-closures.ts: FRED posts nothing on 01-01 / MLK 01-19) — derived through
    // the same predicate the stamp subtracts, never restated as a number. Every closure here sits weeks before the run
    // date (postDaysAfter ≫ 1), hence `Infinity`: only R4's SOURCE closures count, as they do in `slotAge`.
    const FROZEN_RATE_SLOTS = Array.from({ length: FROZEN_RATE_DAYS }, (_, i) => new Date(Date.UTC(2026, 0, 30 - i)))
      .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !isSlotExcused("R4", d.toISOString().slice(0, 10), Infinity)).length;
    const frozen = (obs: Observation[]): Observation[] =>
      obs.map((o) => ({
        ...o,
        date: new Date(Date.parse(o.date) - FROZEN_RATE_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10),
      }));
    const feeds = fakeFeeds({
      fetchSeries: async (series) => (series === "DFII10" ? frozen(await fredMock(series)) : fredMock(series)),
    });
    // Clocked at the FRED fixture's own asOf, so the ordinary daily feeds really are flowing (a bare
    // wall clock leaves the WHOLE fixture behind, and the guard deliberately stands down then).
    const alert = await runCycleWith(feeds, store, monotonicClock("2026-01-30T21:00:00.000Z"));

    // (a) store honesty (§0.3): a synthetic RED at a back-dated obs_date would be served FOREVER by
    // getSeries — present at the real close and its real state, never dropped or reddened.
    const r4 = (await store.getReadingsForRun(alert.firedAt)).find(
      (r) => r.indicatorId === "R4",
    );
    expect(r4?.date).toBe(
      new Date(Date.UTC(2026, 0, 30) - FROZEN_RATE_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    expect(r4?.value).toBe(1);
    expect(r4?.state).toBe("GREEN");
    expect(r4?.rawState).toBe("GREEN");

    // (b) the floor:coverage owner: R4 stays GREEN, the coverage floor lifts the band to WATCH (capped there).
    expect(alert.level).toBe("WATCH");
    expect(alert.bandReason).toBe("floor:coverage");

    // (c) the structured [coverage] trace for the held family (Stage 4.1) — /api/lab parses no scope prose.
    const events = (alert.degraded ?? []).filter((d) => d.coverage);
    const held = events.find((d) =>
      d.coverage!.members.some((m) => m.id === "R4"),
    );
    expect(held, "a coverage event naming R4").toBeDefined();
    expect(held!.scope).toBe("[coverage] rates verdict held by non-live data");
    expect(held!.reason).toContain(`R4 (lag ${FROZEN_RATE_SLOTS}d)`);
    // LAST-KNOWN, not RED, at the RUN-TIME age derived from the freeze offset.
    expect(held!.coverage!.members.find((m) => m.id === "R4")).toEqual({
      id: "R4",
      reason: "lag",
      series: "DFII10",
      state: "GREEN",
      ageDays: FROZEN_RATE_SLOTS,
    });
    // Not a carried family — it has present members; `carried` is the rank-7 zero-member case.
    expect(held!.coverage!.carried).toBe(false);
    expect(held!.coverage!.verdict).toBe("GREEN");
    // An ABSENT member carries no reading: its three detail fields are null, never a fabricated zero.
    for (const m of events
      .flatMap((d) => d.coverage!.members)
      .filter((m) => m.reason === "absent")) {
      expect([m.series, m.state, m.ageDays]).toEqual([null, null, null]);
    }
  });

  // Absent-member carry: two BAND-DRIVING
  // rates members are absent this run — R4 (DFII10) has a fresh in-cut RED close so it re-enters
  // CARRIED; R3 (DGS2) has none so it stays ABSENT and arms the family's coverage. (Post rates-split
  // the coverage roster is R1/R2/R3/R4, so the absent leg must be one of those — R8 is the R1 bridge,
  // seated only while R1 is dark, and R6/R7/EURC/BUND are per-leg only.) The `[coverage]` payload must
  // name the carried member with `reason: "carried"` + populated detail, distinct from the absent one.
  test("a carried member surfaces with reason `carried` (detail populated) on the CoverageDegrade payload", async () => {
    const feeds = fakeFeeds({
      fetchSeries: async (series) => (series === "DFII10" || series === "DGS2" ? [] : fredMock(series)), // R4 + R3 feeds dark this run
    });
    // R4's last close: RED, one day before the fixture asOf (2026-01-30) ⇒ age 1, inside its daily cut.
    await store.recordReadings(
      [
        {
          date: "2026-01-29",
          indicatorId: "R4",
          value: 1,
          delta20: 0,
          rawState: "RED",
          state: "RED",
          decision: null,
        },
      ],
      "2026-01-29T22:00:00.000Z",
    );

    const alert = await runCycleWith(feeds, store, monotonicClock("2026-01-30T21:00:00.000Z"));
    const rates = (alert.degraded ?? []).find(
      (d) => d.coverage?.family === "rates",
    )?.coverage;
    expect(rates, "a coverage event for the rates family").toBeDefined();
    // The carried member: absent from the fetch, folded on its own in-cut RED close — full detail.
    expect(rates!.members).toContainEqual({
      id: "R4",
      reason: "carried",
      series: "DFII10",
      state: "RED",
      ageDays: 1,
    });
    // …and it is NOT mislabelled absent, while the genuinely-dark R3 IS absent (the discriminating pair).
    expect(rates!.members.find((m) => m.id === "R4")!.reason).not.toBe(
      "absent",
    );
    expect(rates!.members.find((m) => m.id === "R3")).toEqual({
      id: "R3",
      reason: "absent",
      series: null,
      state: null,
      ageDays: null,
    });
  });

  // The SLOW bubble-watch legs score on the slow TRACK, never in `dialReadings`, but GLOBAL_FAMILIES.volatility
  // lists them: the persisted display panel served all four as absent (+ coverage degraded) on every cron run.
  // Both assembleDial calls must hand them in (the dial-panel strip is `assembleDial`'s fact, dial-assembly.test.ts).
  test("slow-track legs land PRESENT on both persisted display volatility panels", async () => {
    // The calm fixture degrades the slow track (VIXCLS < MIN_VIX_OBS) — deepen it so the legs score.
    const feeds = fakeFeeds({ fetchSeries: async (s) => (s === "VIXCLS" ? deepVixcls() : fredMock(s)) });
    const alert = await runCycleWith(feeds, store, monotonicClock("2026-01-30T21:00:00.000Z"));
    const slow = [...SLOW_INDICATOR_IDS];
    const vol = (panel: readonly families.FamilyPanel[] | undefined) => panel?.find((f) => f.key === "volatility");
    for (const [name, state] of [["panelState", alert.panelState], ["displayPanelState", alert.displayPanelState]] as const) {
      expect(vol(state?.displayPanel)?.members.map((m) => m.id), `${name}.displayPanel`).toEqual(expect.arrayContaining(slow));
    }
  });
});
