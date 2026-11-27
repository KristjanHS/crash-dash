import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import { ALL_INDICATORS, ID_SETS } from "./registry.js";
import { DOWNSIDE_DETECTOR_IDS, RS_LEG_IDS } from "./registry-price.js";
import { INDICATORS } from "./registry-fred.js";
import { CHART_ONLY_IDS } from "./registry-composite.js";
import { fromRunInputs } from "./run-inputs.js";
import { G1 } from "./registry-geo.js";
import type { Observation } from "./domain-types.js";
import type { FeedPorts } from "./feed-ports.js";
import { estimatorOf } from "./nowcast-score.js";
import { oilNowcastHead } from "./run-cycle-exposure.js";
import { degrade, drainDegradeLog, drainLateDegrades, recordDegrade, resetDegradeLog } from "./tracks.js";
import { noFreeSource } from "./no-free-source.js";
import { INPUT_SERIES } from "./input-series.js";
import { SB_BENCH_ID, SB_STRAT_ID } from "./scoreboard.js";
import {
  ALL_CMP_IDS,
  FRED_COUNT,
  cmpIds,
  fakeFeeds,
  fakeNotify,
  fredMock,
  ECISS_FIXTURE_LEVEL,
  ESTR_FIXTURE_LEVEL,
  EURGBP_FIXTURE_LEVEL,
  priceCalm,
  installRunTestHooks,
  f7Flat,
  dfii10Ramp,
  runCycleWith,
  seedHyoasCalib,
} from "./run.test-helpers.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// Audit rank 6 — degrade collector: `degrade()` appends a {scope, reason} at its choke
// point on any fallback; runScoringCycle resets it per run and drains it into the alert row.
describe("degrade() collector (audit rank 6)", () => {
  beforeEach(() => resetDegradeLog());

  test("a fallback records {scope, reason, effect}; a success records nothing", async () => {
    const ok = await degrade("[x] feed unavailable", "notify", 42, async () => 7);
    expect(ok).toBe(7); // success returns fn's value, no event
    const fb = await degrade(
      "[y] feed unavailable - leg non-live",
      "trace",
      42,
      async () => {
        throw new Error("boom 503");
      },
    );
    expect(fb).toBe(42); // failure returns the fallback
    expect(drainDegradeLog()).toEqual([
      { scope: "[y] feed unavailable - leg non-live", reason: "boom 503", effect: "trace" },
    ]);
  });

  test("a NoFreeSourceError fallback persists kind no-free-source; an ordinary Error carries no kind key", async () => {
    expect(await degrade("[nf] feed", "notify", 0, async () => noFreeSource("x"))).toBe(0);
    await degrade("[plain] feed", "notify", 0, async () => Promise.reject(new Error("boom")));
    const [tagged, plain] = drainDegradeLog();
    expect(tagged).toEqual({ scope: "[nf] feed", reason: "no free source for x — requires a paid data API", effect: "notify", kind: "no-free-source" });
    expect(plain).not.toHaveProperty("kind");
  });

  test("an event recorded after drainDegradeLog lands in drainLateDegrades as trace, `late` keeping its recorded effect; resetDegradeLog clears both logs", async () => {
    drainDegradeLog();
    recordDegrade("[late] seed after recordRun", "boom", "notify");
    await degrade("[late-wrap] feed", "notify", 0, async () => Promise.reject(new Error("x")));
    recordDegrade("[late] routine seed warn", "t", "trace");
    expect(drainLateDegrades()).toEqual([
      { scope: "[late] seed after recordRun", reason: "boom", effect: "trace", late: "notify" },
      { scope: "[late-wrap] feed", reason: "x", effect: "trace", late: "notify" },
      { scope: "[late] routine seed warn", reason: "t", effect: "trace", late: "trace" },
    ]);
    recordDegrade("[stale] late", "s", "trace");
    resetDegradeLog();
    expect(drainLateDegrades()).toEqual([]);
    recordDegrade("[next] run", "r", "notify");
    expect(drainDegradeLog()).toEqual([{ scope: "[next] run", reason: "r", effect: "notify" }]);
  });
});

// Orchestration test for the run loop (`run-cycle.ts`) wiring (fetch → score → persist → push).
// The pure pieces (scoreIndicator, escalatorFloor/computeAlertBand, decideNotify, buildNotification)
// are unit-tested in dashboard.notify.test.ts; this verifies how runScoringCycle wires
// them to its IO collaborators. We stub at the IO boundary ONLY — the four real
// seams (FRED feed, price feed, store, ntfy) — and drive a real InMemoryStore so
// the assertions are about what the cycle PERSISTED and PUSHED, not about mocks.

describe("runScoringCycle - wiring (fetch → score → persist → push)", () => {
  test("all-GREEN first run: merges FRED+price+EBP readings, persists, stays silent (OK)", async () => {
    // The ECY leg discriminates on the DEEP ask (its DB-first `since` fetch) so R4's ordinary
    // DFII10 core-loop fetch keeps the flat-GREEN fredMock; the `since` count is the Finding-1
    // hoist pin (one fetch per RUN, not 9). The input-series seed's raw-id catch-up asks
    // `fullHistory` (raw DFII10 store unseeded) and is counted apart so the pin stays sharp.
    const fetchSeries: FeedPorts["fetchSeries"] = async (series, opts) =>
      series === "DFII10" && (opts?.fullHistory || opts?.since !== undefined)
        ? dfii10Ramp(3, 1) // falling real yield ⇒ cheap ⇒ GREEN regardless of the GT gate
        : fredMock(series);
    // The G1 nowcast lead (CL=F) has NO bar on the print's date and one on the next session (the
    // calm head is a Friday ⇒ +3 days), so the push clause's head is reachable only by walking back to an
    // earlier stored print — which needs the run to hand `oilNowcastHead` its multi-print FRED series (S2a).
    const oilLead = estimatorOf("G1", "carry-log").leads[0];
    // EXSH_GATE is a Xetra ratio (EXSH.DE/EXSA.DE): a German holiday (a date only the US legs trade) must be
    // absent from EXSH_GATE's feed-date stamp yet present on F6's.
    const xetra = (await priceCalm("EXSH.DE")).map((o) => o.date);
    const holiday = xetra.at(-3)!; // an interior date both calendars would otherwise share
    expect((await priceCalm("QQQ")).map((o) => o.date)).toContain(holiday); // non-vacuous: the US grid trades it
    const oilCloses = async (symbol: string): Promise<Observation[]> => {
      const closes = await priceCalm(symbol);
      if (symbol === "EXSH.DE" || symbol === "EXSA.DE") return closes.filter((o) => o.date !== holiday);
      if (symbol !== oilLead) return closes;
      const head = closes.at(-1)!;
      return [...closes.slice(0, -1), { date: new Date(Date.parse(head.date) + 3 * 86_400_000).toISOString().slice(0, 10), value: head.value * 1.02 }];
    };
    // EBP: flat below its own Amber cut → GREEN; ECY's CAPE is the run's live CAPE fetch.
    const feeds = fakeFeeds({ fetchSeries, fetchDailyCloses: oilCloses, fetchCape: async () => f7Flat() });

    let collected: ReadonlyMap<string, readonly string[]> | undefined;
    const notify = fakeNotify();
    const alert = await runCycleWith(feeds, store, undefined, { notify, onFeedDatesCollected: (m) => (collected = m) });

    expect(alert.level).toBe("OK");
    // Assert the persisted set by explicit id, not a magic count: every FRED registry
    // indicator scores GREEN and persists (derived from INDICATORS, so a new registry
    // entry can't silently rot the guard the way `+24` would)...
    const ids = new Set(
      (await store.getReadingsForRun(alert.firedAt)).map((r) => r.indicatorId),
    );
    for (const { id } of INDICATORS) expect(ids).toContain(id);
    // ...plus the non-registry live readings an all-calm run adds: the two bespoke price
    // scorers (F4/F5), the NVDA gate (LATEST rides the commit path; history backfills in run.wiring.feeds.test.ts),
    // the confirmers (EBP/R6/R7/CG/G1/BRENT),
    // the price-derived registry legs (F6/F8/F13),
    // the GLOBAL legs (EURC/FXH/GT/GB/DISP — all GREEN off the mocked ECB/FRED/
    // price feeds), the slice-2 downside detectors (DB_*), and the 2 D9 scoreboard NAV rows
    // (first run ⇒ seeded at NAV_BASE). (K1 Kiley regime removed 2026-07-02.)
    // CURATED census (feed topology — not a registry axis): WHICH non-registry rows an
    // all-calm run persists is a property of the mocked feed set, so the remainder stays
    // hand-curated; only the downside-detector pair derives (registry axis).
    const EXPECTED_EXTRA = [
      "F4",
      "F5",
      "SPCONC",
      "NVDA",
      "EBP",
      "R6",
      "R7",
      "CG",
      "G1",
      "BRENT",
      // NG Henry Hub natgas confirmer — its DHHNGSP feed rides the calm fredMock and persists GREEN.
      "NG",
      // VT (volatility roll-up) + VTP (backwardation-streak, chart-only) score off the SHARED
      // ^VIX/^VIX3M legs, now that `fakeFeeds` defaults that seam to a calm live contango
      // pair (slice 3) instead of []. Both persist GREEN on a calm run; the single shared fetch is
      // pinned by the `fetchVixSeries` call count below.
      "VT",
      "VTP",
      // …and the bottom track now scores an honest CALM off that same live pair (it was silent
      // under the empty default), backfilling its two raw display-only legs VIX/VIX3M (ID_SETS.raw).
      "VIX",
      "VIX3M",
      // E7: ECY scores off the live CAPE × mocked-DFII10 join (cheap ⇒ GREEN, no GT gate needed).
      "ECY",
      "F6",
      "F8",
      "F13",
      "CQS",
      "KBE_RS",
      "INS_RS",
      "EXSH_GATE",
      "AT1",
      "MU_RS",
      "JPT",
      "EURC",
      "FXH",
      "GT",
      "GB",
      "DISP",
      "BUND",
      "ESTR",
      "EPATH",
      "HICP",
      "ECISS",
      "BONOS",
      "EURGBP",
      "CCC",
      ...DOWNSIDE_DETECTOR_IDS,
      // …and their same-day EW rel-strength siblings (RS_*, 2026-08-15) — the other registry axis.
      ...RS_LEG_IDS,
      "SB_STRAT",
      "SB_BENCH",
      // FDX (Stage 1 chart-only) scores at the test fixture depth (~279 closes ≥ its MA50 floor)
      // and persists a GLOBAL reading. HCX is ABSENT here: its breadth band needs
      // BREADTH_MIN_CLOSES aligned closes, above the fixture depth, so it is guard-light this
      // run (its CMP components still persist, via ALL_CMP_IDS below).
      "FDX",
      // VXNCLS (chart-only FRED VXN) rides the calm fredMock and persists GREEN. VXNT is ABSENT: its k window needs
      // VXNT_K_WINDOW aligned closes, above the fixture depth (`deepVxntPorts` is the deep world).
      "VXNCLS",
      // T10Y3M_RAW (chart-only unsmoothed FRED T10Y3M) rides the same calm fredMock.
      "T10Y3M_RAW",
      // VXSMH (chart-only, index-only through `fetchSeries`) rides the same calm fredMock.
      "VXSMH",
      // Rank 11 — composite-component vintage rows: every EURC/FXH/GT/GB/DISP/BUND/HCX/FDX component
      // scores no state but persists its raw close as a display-only GLOBAL row.
      ...ALL_CMP_IDS,
    ];
    // Superset guard: every curated census id must exist in the registry universe (∪ composite
    // components); the SB_* scoreboard rows are exempted by name — persisted rows, not registry ids.
    {
      // VTP is exempted by name: it is persisted+charted but ABSENT from ALL_INDICATORS (so out of
      // ID_SETS), exactly like the SB_* scoreboard rows — see registry-composite.ts.
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
    }
    for (const id of EXPECTED_EXTRA) expect(ids).toContain(id);
    // Rank 11 (folded from the ex-composite test): each CMP_* component persists a display-only
    // vintage row — no scored state, no decision var, a plausible raw close mirroring its composite's date.
    {
      const rows = await store.getReadingsForRun(alert.firedAt);
      const byId = new Map(rows.map((r) => [r.indicatorId, r]));
      for (const id of ALL_CMP_IDS) {
        const row = byId.get(id)!;
        expect(row.state).toBe("GREEN");
        expect(row.rawState).toBe("GREEN");
        expect(row.decision).toBeNull();
        expect(Number.isFinite(row.value)).toBe(true);
        expect(row.value).toBeGreaterThan(0);
        expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const composite of ["EURC", "FXH", "GT", "GB", "DISP", "BUND"]) {
        const compositeDate = byId.get(composite)!.date;
        for (const id of cmpIds(composite))
          expect(byId.get(id)!.date).toBe(compositeDate);
      }
    }
    // ECB ESTR/ECISS/EURGBP: GREEN at the fixture level, read back through its constant.
    {
      const byId = new Map((await store.getReadingsForRun(alert.firedAt)).map((r) => [r.indicatorId, r]));
      const levels = { ESTR: ESTR_FIXTURE_LEVEL, ECISS: ECISS_FIXTURE_LEVEL, EURGBP: EURGBP_FIXTURE_LEVEL };
      for (const [id, value] of Object.entries(levels)) {
        expect(byId.get(id)?.state, id).toBe("GREEN");
        expect(byId.get(id)?.value, id).toBe(value);
      }
    }
    // ONE ^VIX/^VIX3M fetch per run (2 calls) feeds BOTH VT and the bottom track (CALM off the same legs),
    // through the `fetchVixSeries` port — a "tidy fetchVixTermLegs into vix_term.ts" would bypass it and trip here.
    expect(feeds.fetchVixSeries).toHaveBeenCalledTimes(2);
    expect(alert.bottomState).toBe("CALM");
    // Exactly registry ∪ extras, nothing else (the "no surprise rows" half of the old count).
    expect(ids.size).toBe(FRED_COUNT + EXPECTED_EXTRA.length);
    // Feed-date collector: every daily id the run
    // persisted is recorded — the one grid source `lagCalendarsFrom` reads. CMP_*/VIX/VIX3M ride a parent's fetch.
    {
      const sharedFetch = new Set([...ALL_CMP_IDS, "VIX", "VIX3M"]);
      const cadenceOf = new Map(ALL_INDICATORS.map((i) => [i.id, i.cadence ?? "daily"]));
      const daily = [...ids].filter((id) => cadenceOf.get(id) === "daily" && !sharedFetch.has(id));
      expect(daily.length).toBeGreaterThan(0);
      expect(daily.filter((id) => !collected!.has(id))).toEqual([]);
      expect(collected!.get("EXSH_GATE")).toEqual(xetra.filter((d) => d !== holiday));
      expect(collected!.get("F6")).toContain(holiday);
    }
    // The cycle recorded exactly one alert, and it IS the returned verdict
    // (asserted through the Store interface — no peeking at the fake's internals).
    expect(await store.getLastAlert({ withPanel: true, withRunInputs: true })).toEqual(alert);
    expect(await store.getRecentAlerts(100)).toHaveLength(1);
    // The cycle persists `run_inputs` — readings' freshness stamps ride it, every GLOBAL id resolves back.
    const ri = alert.runInputs!;
    expect(ri.v).toBe(1);
    expect(Object.keys(ri.stamps).length).toBeGreaterThan(0);
    expect(ri.globalReadings!.length).toBeGreaterThan(0);
    expect(fromRunInputs(ri, []).globalReadings!.map((r) => r.indicator.id)).toEqual(ri.globalReadings!.map((g) => g.id));
    // Wiring: the push clause's G1 head is `oilNowcastHead` over THIS run's print, its FRED prints and the
    // lead's closes, and it reaches `run_inputs.oilEst`. The walk-back premise is what lets the output see the call
    // site: the EOD estimate-row head `mergeHeadEstimates` falls back to stamps `fromDate` = the print's own date.
    {
      const g1Row = (await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "G1" && r.estimated !== true)!;
      const want = oilNowcastHead("G1", { date: g1Row.date, level: g1Row.value }, await fredMock(G1.series), await oilCloses(oilLead), alert.firedAt.slice(0, 10));
      expect(want?.fromDate).toBeDefined(); // premise: the head exists...
      expect(want!.fromDate < g1Row.date).toBe(true); // ...and only via the walk-back
      expect(ri.oilEst?.G1).toMatchObject(want!);
    }
    // OK on a first run (no prior) is silent: no push intent recorded, ntfy untouched.
    expect(alert.pushedAt).toBeNull();
    expect(notify.pushNtfy).not.toHaveBeenCalled();
    // E7: the persisted ECY row carries a REAL scored state (not a silent degrade) and the rank level.
    const ecyRow = (await store.getReadingsForRun(alert.firedAt)).find(
      (r) => r.indicatorId === "ECY",
    );
    expect(ecyRow?.state).toBe("GREEN");
    expect(Number.isFinite(ecyRow?.value)).toBe(true);
    // Finding-1 hoist pin: the shared ecy ctx fires its DFII10 deep fetch ONCE per run —
    // built inside the confirmer map it fired once per confirmer (9×).
    const dfii10 = feeds.fetchSeries.mock.calls.filter(([s]) => s === "DFII10").map(([, o]) => o);
    expect(dfii10.filter((o) => o?.since !== undefined)).toHaveLength(1);
    // seedInputSeriesOnCron (P1.1): exactly one raw-id DFII10 catch-up, `fullHistory` on the
    // unseeded raw store — a de-hoisted ECY ctx asking `fullHistory` would inflate this too.
    expect(dfii10.filter((o) => o?.fullHistory && o.since === undefined)).toHaveLength(1);
  });
});

describe("injected feed ports + store", () => {
  test("an EOD run reads every port and writes only the injected store", async () => {
    const feeds = fakeFeeds();
    const own = new InMemoryStore();
    seedHyoasCalib(own);
    const alert = await runCycleWith(feeds, own);
    // fetchDramSpot serves only the input roster's snapshot rows — a roster without one leaves that port unread;
    // fetchHourlyBars has no EOD consumer; fetchOfficialLeg has no consumer at all since its spread cards retired.
    const unreached = ["fetchOfficialLeg", ...(INPUT_SERIES.some((s) => s.feed === "snapshot") ? [] : ["fetchDramSpot"]), "fetchHourlyBars"];
    expect(Object.entries(feeds).filter(([, f]) => f.mock.calls.length === 0).map(([k]) => k)).toEqual(unreached);
    expect(await own.getLastAlert({ withPanel: true, withRunInputs: true })).toEqual(alert);
    expect(await store.getLastAlert()).toBeNull();
    // No feed namespace reached past its port: each one ends on the wire, which is the hook's fetch backstop.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// formatMagnitude's canonical unit suite (incl. the tiny-ratio false-zero guard and the
// 0.005 boundary) lives in notify_format.test.ts — the pure-formatter layer, not here.
