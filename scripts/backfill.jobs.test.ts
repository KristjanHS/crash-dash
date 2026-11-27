/**
 * backfill suite — the hermetic JOB runs (split 2026-09-05 from backfill.test.ts):
 * `backfillAll` over InMemoryStore + STUB feeds (no
 * network) — first run seeds N>0, an idempotent re-run seeds 0 (the extracted-seam decision);
 * feed-failure handling (one flaky feed recorded in `failures`, the rest still seed); the `only`
 * narrowing arms; live-cut/trim seeding edges; and the bespoke jobs (pension/bottom/downside-
 * break/fxh/legs/cape). Shared fixtures + the memoized virgin run: backfill.test-helpers.ts.
 * Policy suites → backfill.policy.test.ts; restate/reshadow → backfill.restate.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ALL_INDICATORS } from "../src/registry.js";
import { BREADTH_LOOKBACK_DAYS } from "../src/registry-price.js";
import {
  COMPOSITE_COMPONENTS,
  ECISS,
  ESTR,
  EURGBP,
} from "../src/registry-composite.js";
import { G1 } from "../src/registry-geo.js";
import { indicatorReadingSeries, resolvedDerivedBands } from "../src/scorers-core.js";
import { type Observation } from "../src/domain-types.js";
import { CONFIRM_CLOSES } from "../src/domain-types.js";
import { resolveCuts } from "../src/domain-cuts.js";
import { SYNTH_VEL_WINDOW, loadSynthHistories, synthesizedCalib } from "../src/synth-cuts.js";
import { PCT_MIN_OBS } from "../src/slow.js";
import { makeStoredReading } from "../src/test-helpers.js";
import { CG_LEVEL_ANCHOR, levelBandHead } from "../src/scorers-composite.js";
import { CG_DESCRIPTOR, EURGBP_DESCRIPTOR, GEO_HYBRID_DESCRIPTOR_OF, OIL_LEVEL_LOOKBACK_DAYS, MA_WINDOW } from "../src/family-descriptor-rows.js";
import { BOTTOM_INDICATORS, DOWNSIDE_DETECTORS, RS_LEGS } from "../src/registry-price.js";
import { CHART_ONLY_IDS } from "../src/registry-composite.js";
import { indicatorIds } from "../src/registry.js";
import { scoreWithCutsSeriesPerDay } from "../src/confirmers.js";
import { InMemoryStore } from "../src/store-memory.js";
import {
  BACKFILL_YEARS,
  DEEP_PROBE,
  backfillSinceDate,
  FXH_CMP_LOOKBACK_DAYS,
  backfillAll,
  backfillBottom,
  backfillCape,
  backfillDownsideBreaks,
  backfillFxhCmp,
  backfillLegs,
  backfillPension,
  isoCutoff,
  isoDaysBefore,
  specCutoff,
  type BackfillDeps,
  type BottomBackfillDeps,
  type CapeBackfillDeps,
  type FxhCmpBackfillDeps,
  type InputSeriesBackfillDeps,
  type LegsBackfillDeps,
  type PensionBackfillDeps,
  backfillInputSeries,
} from "./backfill.js";
import { LEG_BACKFILL_YEARS } from "../src/backfill-depth.js";
import { INPUT_SERIES } from "../src/input-series.js";
import { VIX_SYMBOL, VIX3M_SYMBOL } from "../src/vix_term.js";
import { legCloseId, offLadderLegCloseId } from "../src/scoreboard.js";
import { LADDER } from "../src/families.js";
import { N, monthlyObs, obsSeries, opts, seedRow, sharedVirginRun, stub } from "./backfill.test-helpers.js";

let sharedStore: InMemoryStore;
let sharedFirst: Awaited<ReturnType<typeof backfillAll>>;
let recFred: string[];
let recNtfs: number;

beforeAll(async () => {
  ({ sharedStore, sharedFirst, recFred, recNtfs } = await sharedVirginRun());
});

describe("backfillAll (hermetic, stub feeds)", () => {
  it("seeds N>0 on the first run and 0 on an idempotent re-run", async () => {
    const first = sharedFirst;
    expect(first.failures).toEqual([]);
    expect(first.total).toBeGreaterThan(0);
    // all 25 indicators seeded (8 FRED core incl. F3 NFCI-Risk + EBP + G1 + R7 + F4 + F5 + F6 + F8 + NVDA + R6 + CG + VT +
    // EURC + FXH + GT + GB + DISP) — the length guards against one silently falling out of the spec
    // table (the exact bug that left R6/R7 with cron-only single-day history: present in ALL_INDICATORS +
    // scored daily, but never enumerated by specs(), so backfill exited 0 while seeding no history for them;
    // CG/VT were the same class of gap, fixed 2026-07-04; EURC the GLOBAL slice-1b gap, fixed 2026-07-12;
    // FXH/GT/GB the same GLOBAL-composite gap, fixed 2026-07-13; F6/F8 the semis-member gap, fixed
    // 2026-07-14; DISP the same GLOBAL-composite gap, fixed 2026-07-15; F9/F10/F11 ride INDICATORS
    // so they seed automatically, +3 → 28 (2026-07-15 EM-leading adds). F12 (bespoke 4Q-diff, own
    // fetch in run-cycle-feeds.ts) was an R6/R7-class gap — added to specs() 2026-07-15, +1 → 29.
    // F14/F15 (ex-US-developed EAFE leaders) rode INDICATORS and seeded automatically, +2 → 31,
    // until they were RETIRED 2026-07-17 (DEC-19/DEC-20, dead FRED feeds), −2 → 29. F12 was then RETIRED
    // TOO (2026-07-17, DEC-21) and its specs() entry deleted with it, −1 → 28. (K1 Kiley regime removed 2026-07-02.)
    // BUND (Bund curve 10y−2y, rung 3, own keyless feed) shipped 2026-07-18 as an
    // EURC-class GLOBAL slice gap — added to specs(), +1 → 30. NOTE the quantifier trap this
    // guard originally walked into: the id list here was HAND-TYPED, so the population changed
    // under an assertion ABOUT the population while both the length pin and the loop stayed
    // green — it had drifted by exactly R2/R3/R4 (29 typed vs 32 counted). Since stage3 slice
    // 3.2 the list is DERIVED from the registry (`indicatorIds(["scored"], { exclude })`), so
    // the population can no longer change under the assertion: a new scored id fails the
    // key-set equality below until it gains a specs() entry or a commented exclusion.
    // F13 (HYG/LQD credit appetite) shipped 2026-07-18: a PRICE_INDICATORS member scored daily but
    // never added to specs(), so it held only cron-only single-day history — found by W3-b's §2.1
    // leader-coverage probe, +1 → 31.
    // BAA10Y (Baa−10y spread) shipped 2026-07-23 (+1 → 32) and RETIRED 2026-08-11 — the indicator
    // left ALL_INDICATORS and specs(); the FRED series lives on only as CQS's input, −1.
    // EU2 (SovCISS France, own keyless ECB `CISS` feed, scored daily but not in INDICATORS) shipped
    // 2026-07-30 — the same EURC-class GLOBAL gap, +1 → 33 — and was REMOVED outright 2026-09-05
    // (left ALL_INDICATORS and specs() together), −1.
    // SPCONC (SPY/RSP concentration, F5's broad-market twin) was excluded here from its 2026-07-23 ship
    // with the comment "scored in-cron off the shared SPY closes, never backfilled" — which described
    // the gap rather than a design. It is the same R6/R7 class: 6 prod rows, so the F5/SPCONC overlap
    // was UNMEASURED and the member ABSENT at depth. specs() entry added 2026-08-05, +1 → 34.
    // ⚠ `indicatorIds` derives from ALL_INDICATORS, which by design EXCLUDES the chart-only ids
    // (VTP — notify-excluded). They have specs()
    // entries all the same (stage B.2: persisted by the FAST_CONFIRMERS tail ⇒ the same cron-only-
    // single-day-history gap as R6/R7), so the population is the union — DERIVED from
    // `CHART_ONLY_IDS`, never hand-typed, so a new chart-only id fails here until it seeds.
    const EXPECTED_SEEDED = [
      ...indicatorIds(["scored"], {
        exclude: [
          "DB_SMH", // downside detectors are cron-only (scored off live closes) — no backfill spec
          "DB_XLK", // ditto
          "RS_SMH", // EW rel-strength legs seed via the dbreak job, not specs() — like DB_*
          "RS_XLK", // ditto
        ],
      }),
      ...CHART_ONLY_IDS,
    ];
    expect(Object.keys(first.seeded).sort()).toEqual([...EXPECTED_SEEDED].sort());
    for (const id of EXPECTED_SEEDED) {
      expect(first.seeded[id], id).toBeGreaterThan(0);
    }

    // Idempotent re-run over the SAME (shared) store — plain stub so the recorder arrays the
    // sibling tests read stay pristine.
    const second = await backfillAll(sharedStore, stub, opts);
    expect(second.failures).toEqual([]);
    expect(second.total).toBe(0);
  });

  // The seeded half of the backfill
  // falsifier ("the stored series returns > 1 row with a plausible date span"), run hermetically
  // here because the live `npm run backfill -- VTP` arm needs the local stack. The key-set test
  // above already proves a VTP spec EXISTS; this proves what it stores is a real per-day streak
  // series and not one cron-shaped row. Red if the spec drops out, if the builder degenerates to
  // a single tail reading, or if the streak stops counting.
  it("seeds VTP deep streak history: > 1 row, spanning the window, streak counting (B.2)", async () => {
    const store = new InMemoryStore();
    // VIX3M at 0.9× VIX ⇒ ratio 1.11 > 1.00 on EVERY aligned close, so the streak runs the whole
    // window and the last day's level is the row count itself — a counter that stopped advancing
    // (or a fold that reset it) cannot satisfy that equality.
    const backwardated: BackfillDeps = {
      ...stub,
      fetchFred: async (series: string, opts?: unknown) =>
        series === VIX3M_SYMBOL
          ? (await stub.fetchFred(VIX_SYMBOL, opts as never)).map((o) => ({ ...o, value: o.value * 0.9 }))
          : stub.fetchFred(series, opts as never),
    };

    const res = await backfillAll(store, backwardated, { ...opts, only: ["VTP"] });
    expect(res.failures).toEqual([]);

    const stored = await store.getSeries("VTP", DEEP_PROBE);
    expect(stored.length).toBeGreaterThan(1);
    expect(stored.at(-1)!.date > stored[0]!.date).toBe(true); // ascending, non-degenerate span
    expect(stored.at(-1)!.value).toBe(stored.length); // the streak counted every stored close
    expect(stored.at(-1)!.state).toBe("RED"); // a run this long is well past VT_STREAK_RED
  });

  // Red if the spec is dropped, folds through `indicatorReadingSeries` (`thresholds: {}` ⇒ GREEN), or asks
  // the ECB for any window but its own resolved depth.
  it.each([
    // ESTR's derived `change` rule: slope off the resolved red cut (sign-carrying) — every window-long change is 2× red.
    ["ESTR", (_v: number, i: number) => 4 + (i * 2 * resolvedDerivedBands(ESTR).red!) / ESTR.derived!.window!],
    // ECISS's generic level classify: a red level.
    ["ECISS", () => 2 * ECISS.thresholds.redLevel!],
    // EURGBP's return-or-MA scorer: a sterling-sell-off ramp.
    ["EURGBP", (_v: number, k: number) => (1 + 2 * EURGBP_DESCRIPTOR.scorer.constants.retRed) ** (k / EURGBP.derived!.window!)],
  ] as const)("seeds %s through its own scorer from its own depth: a cut fires", async (id, value) => {
    const store = new InMemoryStore();
    const asked: (string | undefined)[] = [];
    const stressed: BackfillDeps = {
      ...stub,
      fetchEcb: async (series, o) => {
        if (series !== id) return stub.fetchEcb(series, o);
        asked.push(o?.startPeriod);
        return obsSeries(N).map((p, i) => ({ ...p, value: value(p.value, i) }));
      },
    };
    const res = await backfillAll(store, stressed, { ...opts, only: [id] });
    expect(res.failures).toEqual([]);
    expect(asked).toEqual([backfillSinceDate(id, opts.now)]);
    const stored = await store.getSeries(id, DEEP_PROBE);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.at(-1)!.state).toBe("RED");
  });

  it("R8 seeds off deps.fetchNtfs, never the FRED arm; DFII10 has exactly TWO consumers", async () => {
    // Discriminates by CALL, not by values (the stub feeds are shape-identical): a reverted branch
    // would resolve R8's series "NTFS" through fetchFred and never touch fetchNtfs. Reads the shared
    // virgin run's recorded calls.
    expect(sharedFirst.failures).toEqual([]);
    expect(recNtfs).toBeGreaterThan(0);
    expect(recFred).not.toContain("NTFS");
    expect((await sharedStore.getSeries("R8", DEEP_PROBE)).length).toBeGreaterThan(0);
    // Skip-proof premise, piggybacked on this UNSEEDED run: call count = consumer count; DFII10 is
    // exactly 2 since ECY 2026-08-11 (R4's plan-gated fetch + ECY's plan-independent full pull) — the
    // arithmetic behind the skip proof's count==1. VIXCLS >2 (R5 + VT + VTP): the counter measures
    // consumers, not "fetched at all". A consumer added through ANY route (a literal, `ind.series`,
    // or a descriptor input array invisible to grep) reds the DFII10 line — re-audit the skip proof.
    expect(recFred.filter((s) => s === "DFII10")).toHaveLength(2);
    expect(recFred.filter((s) => s === VIX_SYMBOL).length).toBeGreaterThan(2);
  });
});

// `only` exists so `npm run restate -- --id X` cannot be aborted (or widened) by an id it never named:
// on 2026-08-16 a price-feed cap failed 11 price specs, the caller threw before its prune, and the spread rows
// it HAD written stayed shadowed by the vintage they replaced.
describe("backfillAll `only` narrows the pass without narrowing validation", () => {
  // F4 reads SMH, then NVDA; NVDA's own spec does its own NVDA fetch, so it seeds past F4's failure.
  // The `only: ["F1"]` row is the stranded-spread failure: every price symbol rate-limited, and F1 (FRED-fed)
  // issues NO price fetch — an hourly-cap abort is structurally unreachable, not merely unlikely.
  it.each([
    { name: "continues past a failing feed and records it in failures", fails: (s: string) => s === "SMH", only: ["F4", "NVDA", "F1"], failed: ["F4"], seeded: ["F1", "NVDA"] },
    { name: "builds ONLY the named spec — an unrelated feed's failure cannot reach the run", fails: () => true, only: ["F1"], failed: [], seeded: ["F1"] },
  ])("$name", async ({ fails, only, failed, seeded }) => {
    const flaky: BackfillDeps = {
      ...stub,
      fetchPrices: async (symbol, o) => {
        if (fails(symbol)) throw new Error(`rate-limited: ${symbol}`);
        return stub.fetchPrices(symbol, o);
      },
    };

    const r = await backfillAll(new InMemoryStore(), flaky, { ...opts, restate: only, only });

    expect(r.failures.map((f) => f.id).sort()).toEqual(failed);
    expect(r.failures.every((f) => /rate-limited/.test(f.error))).toBe(true);
    expect(Object.keys(r.seeded).sort()).toEqual(seeded);
    for (const id of seeded) expect(r.seeded[id], id).toBeGreaterThan(0);
  });

  it("validates --restate against the FULL roster (validation is not narrowed)", async () => {
    // The typo'd-id reject is a row of the fail-loud table below.
    // DISCRIMINATING case: F1 is a real id that `only` excludes. Under FULL validation this is
    // accepted; validation narrowed to the filtered list would call F1 unknown and throw. A test
    // that restates and `only`s the same absent id passes under BOTH and pins nothing.
    // It also documents the divergent-set footgun: F1 is validated-as-known and then never built.
    const r = await backfillAll(new InMemoryStore(), stub, { ...opts, restate: ["F1"], only: ["F2"] });
    expect(Object.keys(r.seeded)).toEqual(["F2"]);
    expect(r.seeded.F1).toBeUndefined();
  });
});

describe("backfillDownsideBreaks `only` narrows the pass", () => {
  it("writes the named detector alone and leaves its siblings untouched", async () => {
    const store = new InMemoryStore();
    const target = DOWNSIDE_DETECTORS[0]!.indicator.id;
    const deps: PensionBackfillDeps = { fetchPrices: vi.fn(async () => obsSeries(N)) };

    const r = await backfillDownsideBreaks(store, deps, { ...opts, restate: [target], only: [target] });

    expect(Object.keys(r.perLeg)).toEqual([target]);
    expect(r.perLeg[target]).toBeGreaterThan(0);
  });
});

// Every job's id validation, one row per throw site: an unknown --restate / --deepen / --reshadow-all id,
// or an `only` that matches nothing, must throw rather than report a successful no-op. Each check runs
// before any fetch, so one price stub serves every non-FRED job. The three reshadow rows share
// `reshadowAllSet` but each pins its own job's call to it.
describe("an unknown or unmatched id fails loud, never a no-op success", () => {
  const prices = (): PensionBackfillDeps => ({ fetchPrices: vi.fn(async () => obsSeries(N)) });
  it.each([
    { name: "backfillAll --restate", run: () => backfillAll(new InMemoryStore(), stub, { ...opts, restate: ["NOPE"] }), err: /restate: unknown indicator id\(s\) NOPE/ },
    { name: "backfillAll --deepen", run: () => backfillAll(new InMemoryStore(), stub, { ...opts, deepen: ["NOPE"] }), err: /deepen: unknown indicator id\(s\) NOPE/ },
    { name: "backfillAll only", run: () => backfillAll(new InMemoryStore(), stub, { ...opts, only: ["F1_typo"] }), err: /only: no indicator spec matched F1_typo/ },
    { name: "backfillDownsideBreaks --restate", run: () => backfillDownsideBreaks(new InMemoryStore(), prices(), { ...opts, restate: ["DB_TYPO"] }), err: /restate: unknown detector id\(s\) DB_TYPO/ },
    { name: "backfillDownsideBreaks only", run: () => backfillDownsideBreaks(new InMemoryStore(), prices(), { ...opts, only: ["DB_typo"] }), err: /only: no detector leg matched DB_typo/ },
    { name: "backfillPension --reshadow-all", run: () => backfillPension(new InMemoryStore(), prices(), { ...opts, reshadowAll: ["DEXUSEU_TYPO"] }), err: /reshadow-all: unknown pension leg id/ },
    { name: "backfillFxhCmp --reshadow-all", run: () => backfillFxhCmp(new InMemoryStore(), prices(), { ...opts, reshadowAll: ["CMP_FXH_TYPO"] }), err: /reshadow-all: unknown FXH component id/ },
    { name: "backfillLegs --reshadow-all", run: () => backfillLegs(new InMemoryStore(), prices(), { reshadowAll: ["LEGP_typo"] }), err: /reshadow-all: unknown leg id/ },
  ])("$name", async ({ run, err }) => {
    await expect(run()).rejects.toThrow(err);
  });
});

describe("a manual backfill writes an estimate-sourced date `estimated`, never FINAL", () => {
  // SMH's newest close is a quote head (`estimated: true`, e.g. a closes provider meta close); every other symbol is official.
  const smhHead = <O extends { deep: boolean }>(f: (s: string, o: O) => Promise<Observation[]>) => async (s: string, o: O) => {
    const obs = await f(s, o);
    return s === "SMH" ? obs.map((x, i) => (i === obs.length - 1 ? { ...x, estimated: true as const } : x)) : obs;
  };
  const estDates = async (store: InMemoryStore, id: string): Promise<{ n: number; est: string[] }> => {
    const rows = await store.getSeries(id, DEEP_PROBE);
    return { n: rows.length, est: rows.filter((r) => r.estimated === true).map((r) => r.date) };
  };

  it("backfillAll: the SMH-scored id stamps the head date; a later spec off other legs stays FINAL", async () => {
    const store = new InMemoryStore();
    const head = (await stub.fetchPrices("SMH", { deep: true })).at(-1)!.date;
    await backfillAll(store, { ...stub, fetchPrices: smhHead(stub.fetchPrices) }, { ...opts, only: ["F6", "KBE_RS"] });
    expect(await estDates(store, "F6")).toEqual({ n: expect.any(Number), est: [head] });
    const kbe = await estDates(store, "KBE_RS");
    expect(kbe.n).toBeGreaterThan(0);
    expect(kbe.est).toEqual([]); // the per-spec reset: SMH's head never leaks into KBE÷SPY
  });

  it("backfillDownsideBreaks: DB_SMH + RS_SMH stamp the head date; the XLK legs stay FINAL", async () => {
    const store = new InMemoryStore();
    const head = obsSeries(N).at(-1)!.date;
    await backfillDownsideBreaks(store, { fetchPrices: smhHead(async () => obsSeries(N)) }, opts);
    for (const id of ["DB_SMH", "RS_SMH"]) expect((await estDates(store, id)).est, id).toEqual([head]);
    for (const id of ["DB_XLK", "RS_XLK"]) {
      const r = await estDates(store, id);
      expect(r.n, id).toBeGreaterThan(0);
      expect(r.est, id).toEqual([]);
    }
  });
});

describe("backfillAll scores a synthPriors id through its LIVE cuts (E8 item 1)", () => {
  // The defect (measured 2026-08-01 on prod): backfill handed `indicatorReadingSeries` NO calib, so a
  // `synthPriors` id was scored against its registry DEGRADE FALLBACK while
  // every live consumer (`scoreWithCuts`, api/series, api/indicators, api/lab) resolves the runtime
  // expanding-percentile cuts off the id's own stored history. The stored `state` column is what
  // `/lab`'s replay folds, so the rows painted states the live pipeline never produces.
  // The carrier is F3, the sole `SYNTH_PRIOR_IDS` member — an id off the seam resolves the vintage
  // untouched and the live-vs-fallback arms would be IDENTICAL by construction.
  it("re-scores F3 under synthesizedCalib, not the registry priors", async () => {
    const store = new InMemoryStore();
    const f3 = ALL_INDICATORS.find((i) => i.id === "F3")!;
    // Seed F3's own level history FIRST — with an empty store `loadSynthHistories` returns nothing
    // and `synthesizedCalib` degrades to the priors, i.e. exactly the pre-fix arm (the fixture would
    // be vacuous).
    //
    // DEPTH IS DERIVED, NEVER TYPED. The velocity percentile runs over `absDelta(history,
    // velocityWindow)`, which is `velocityWindow` SHORTER than the seeded window, so the floor is
    // `PCT_MIN_OBS + velocityWindow`; `expandingPercentile`'s last element needs `PCT_MIN_OBS`
    // observations STRICTLY BEFORE it, hence the +1. Below that floor both velocity legs degrade
    // back to the registry prior and the `not.toEqual` non-vacuity guard collapses.
    const velWindow = f3.velocityWindow ?? SYNTH_VEL_WINDOW;
    const SEED_N = PCT_MIN_OBS + velWindow + 1;
    const history = obsSeries(SEED_N + 100); // the trailing ~100 dates are what the backfill writes
    const seeded = history.slice(0, SEED_N);
    await store.recordReadings(
      seeded.map((o) => makeStoredReading("F3", { date: o.date, value: o.value })),
      "2024-05-31T00:00:00Z",
    );

    // Read the histories the run itself will resolve against — BEFORE the run, since its own writes
    // extend F3's history and would move the expanding-percentile cuts out from under the expectation.
    const histories = await loadSynthHistories(store);

    const feed: BackfillDeps = {
      ...stub,
      fetchFred: async (series: string, o?: unknown) =>
        series === f3.series ? history : stub.fetchFred(series, o as never),
    };
    const res = await backfillAll(store, feed, { ...opts, only: ["F3"] });
    expect(res.failures).toEqual([]);

    const liveCuts = resolveCuts("F3", synthesizedCalib(f3, [], histories), "HIGH");
    // The live arm is the PER-DAY restate scorer (a retired plan,
    // rung 1): day i scored against day i's expanding cut, stamped into `bandCuts`.
    const liveArm = scoreWithCutsSeriesPerDay(f3, history, []);
    const fallbackArm = indicatorReadingSeries(f3, history); // the pre-fix call shape
    // Non-vacuity, stated at the CUT layer first so a re-collapse names its own cause: if the
    // seeded window ever falls back under the derived floor, the legs degrade to the registry prior
    // and every downstream comparison is between identical inputs.
    // (`withSynthesizedPriors` publishes the synthesized velocity percentiles under the measured
    // `velEvt*`/`velOp*` legs — the degrade writes the prior verbatim into all of them.)
    // ⚠ F3 declares no `redVelocity`, so the velocity-RED legs read undefined on BOTH sides and
    // cannot carry a guard; the LEVEL axis F3 also rides is what pins the red half here.
    const prior = f3.rawThresholds ?? f3.thresholds;
    expect(prior.redVelocity, "premise: a redVelocity would owe its own guard").toBeUndefined();
    expect(liveCuts.velEvtAmber).not.toBe(prior.amberVelocity);
    expect(liveCuts.velOpAmber).not.toBe(prior.amberVelocity);
    expect(liveCuts.evtAmber).not.toBe(prior.amberLevel);
    expect(liveCuts.evtRed).not.toBe(prior.redLevel);
    // …and at the STATE layer: the two arms must actually disagree, else the assertion below
    // passes under BOTH.
    expect(liveArm.map((r) => r.state)).not.toEqual(fallbackArm.map((r) => r.state));

    const stored = await store.getSeries("F3", DEEP_PROBE);
    const byDate = new Map(stored.map((p) => [p.date, p.state]));
    // Only the dates the backfill itself wrote — the pre-seeded rows are GREEN by construction.
    const seededDates = new Set(seeded.map((o) => o.date));
    const written = liveArm.filter((r) => !seededDates.has(r.date) && byDate.has(r.date));
    expect(written.length).toBeGreaterThan(0);
    expect(written.map((r) => byDate.get(r.date))).toEqual(written.map((r) => r.state));
    // …and the row carries the cut it was scored against — the un-stamped series wrote NULL here
    // (prod, 2026-09-02: F3 storedNull=60/60 on `probe:band-cuts-parity`).
    const cutsByDate = new Map(stored.map((p) => [p.date, p.bandCuts ?? null]));
    for (const r of written) expect(cutsByDate.get(r.date), r.date).toEqual(r.bandCuts ?? null);
    expect(written.some((r) => r.bandCuts != null)).toBe(true);
  });
});

// CG's level leg draws an EXPANDING percentile, so its cut is a function of how much history the
// caller hands it. Trimming CG's FEEDS to `cutoff` made the window boundary decide the band (measured
// 2026-08-10 on prod: base start 2011-08-09 scored 2014-12-03/2015-07-31/2018-03-27/2019-05-30 RED,
// base start 2011-08-02 scored all four AMBER). CG's build therefore returns the UNTRIMMED deep base;
// `backfillAll` stores it down to the spec's `baseFloor` (`CG_LEVEL_ANCHOR`, the cron's base start), below
// `specCutoff("CG",…)`. ⚠ `backfillHistory`'s `reshadowFloor` does NOT bound the insert (it re-writes
// already-stored dates only).
describe("backfillAll scores CG off the UNTRIMMED base, stores it to the cron's base floor", () => {
  const NOW = new Date("2030-06-01T00:00:00Z"); // the master pair must start ≥ CG_LEVEL_ANCHOR, below which `cgRows` trims
  // 20y: DEEPER than CG's own 15y override, so the shared cutoff stays the binding bound here.
  const YEARS = 20;
  const CUTOFF = isoCutoff(NOW, YEARS);
  // CG's central trim is DEEPER than the plain cutoff by the read-path head api/series.ts re-scores,
  // so the store's left edge is `specCutoff("CG",…)`, not CUTOFF — DERIVED, so the constant moves it.
  const CG_CUTOFF = specCutoff("CG", CUTOFF, NOW);
  // The post-cutoff span alone must clear the level band's own floor, else the SHALLOW arm emits no
  // reading and the arm-vs-arm comparison is empty-vs-full (vacuous). DERIVED from the descriptor.
  const POST = levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES + 120;
  const DEEP_LEAD = 900; // extra pre-cutoff calendar days only the DEEP arm's feed reaches back over

  // A CG pair whose RATIO varies: `obsSeries` for both legs gives HG/GC ≡ 1, a flat level series with
  // no percentile for the extra base to move. Both legs share one date grid so alignByDate drops none.
  function cgPair(n: number, startISO: string): { hg: Observation[]; gc: Observation[] } {
    const hg: Observation[] = [];
    const gc: Observation[] = [];
    const d = new Date(`${startISO}T00:00:00Z`);
    for (let i = 0; i < n; i++) {
      const date = d.toISOString().slice(0, 10);
      hg.push({ date, value: 100 + Math.sin(i / 9) * 6 + i * 0.03 });
      gc.push({ date, value: 100 + Math.sin(i / 47) * 18 });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return { hg, gc };
  }

  const [HG, GC] = CG_DESCRIPTOR.inputs as readonly string[] as [string, string];

  // ONE master pair, sliced for the shallow arm — regenerating it from a later start would move the
  // sine phase and the post-cutoff VALUES would differ too, so a state delta could not be attributed
  // to the deeper base.
  const master = cgPair(DEEP_LEAD + POST, isoDaysBefore(new Date(`${CUTOFF}T00:00:00Z`), DEEP_LEAD));

  const runArm = async (deep: boolean): Promise<Map<string, string>> => {
    const store = new InMemoryStore();
    const cut = (o: Observation[]) => (deep ? o : o.filter((x) => x.date >= CUTOFF));
    const feed: BackfillDeps = {
      fetchFred: async (series: string) =>
        series === "CPIAUCSL" || series === "UNRATE" ? monthlyObs(40) : obsSeries(N, CUTOFF),
      fetchEbp: async () => obsSeries(N, CUTOFF),
      fetchEcb: async () => obsSeries(N, CUTOFF),
      fetchSovereignDaily: async () => obsSeries(N, CUTOFF),
      fetchPrices: async (symbol: string) =>
        symbol === HG ? cut(master.hg) : symbol === GC ? cut(master.gc) : obsSeries(N, CUTOFF),
      fetchCape: async () => monthlyObs(300, 1998),
      fetchNtfs: async () => obsSeries(N, CUTOFF),
    };
    const res = await backfillAll(store, feed, { years: YEARS, now: NOW, only: ["CG"] });
    expect(JSON.stringify(res.failures), `CG must not fail on the ${deep ? "deep" : "shallow"} arm`).not.toContain(
      '"CG"',
    );
    const stored = await store.getSeries("CG", DEEP_PROBE);
    return new Map(stored.map((p) => [p.date, p.state]));
  };

  it("stores CG's base below specCutoff (its `baseFloor`), deep base moving states", async () => {
    // Premise: the deep arm's FEED reaches behind CG_CUTOFF — otherwise the central trim drops nothing
    // and both arms are the same input, so every assertion below passes on a no-op.
    expect(master.hg.some((o) => o.date < CG_CUTOFF), "premise: the deep feed straddles specCutoff").toBe(true);
    expect(master.hg[0]!.date >= CG_LEVEL_ANCHOR, "premise: no master date is trimmed by the anchor").toBe(true);

    const deep = await runArm(true);
    const shallow = await runArm(false);

    // Half 1 — `baseFloor` governs the STORE: rows land below specCutoff, the span the cron's anchored base scores.
    expect(deep.size).toBeGreaterThan(0);
    expect([...deep.keys()].some((d) => d < CG_CUTOFF), "the cron's base below specCutoff must be stored").toBe(true);
    // …and the deep base RECOVERS the post-cutoff dates a trimmed feed burns on the level band's
    // warmup — it enters the cutoff already warm, so it scores strictly more of the stored span.
    const shared = [...shallow.keys()];
    expect(shared.every((d) => deep.has(d)), "deep must score every date shallow scored").toBe(true);
    expect(deep.size).toBeGreaterThan(shallow.size);

    // Half 2 — the DISCRIMINATOR, over the dates BOTH arms scored: identical closes, different base.
    // Routing CG's feeds back through the trimming `price` helper collapses this to an equality.
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.map((d) => deep.get(d))).not.toEqual(shared.map((d) => shallow.get(d)));
  });
});

// The central reading-trim, pinned on GT (globalTrendReadingSeries, head = MA_WINDOW − 1). GT's feed
// runs deep (via `price()`); the scorer's MA_WINDOW warmup must burn BELOW the cutoff, so the FIRST
// stored reading lands ON the cutoff — not cutoff + (MA_WINDOW − 1). Re-adding `price()`'s feed trim
// re-cuts the feed at the cutoff, burning the warmup INSIDE the window and pushing the edge forward.
describe("backfillAll central reading-trim: GT's warmup burns below the cutoff", () => {
  const NOW = new Date("2024-06-01T00:00:00Z");
  const YEARS = 5;
  const CUTOFF = isoCutoff(NOW, YEARS);
  const LEAD = MA_WINDOW + 60; // pre-cutoff calendar days: > MA_WINDOW so the warmup completes below it

  it("stores GT's first reading AT the cutoff, not cutoff + (MA_WINDOW − 1)", async () => {
    const deepAcwi = obsSeries(LEAD + 200, isoDaysBefore(new Date(`${CUTOFF}T00:00:00Z`), LEAD));
    // Premise: the feed carries MORE than a full MA_WINDOW of pre-cutoff observations, so the warmup
    // provably finishes below the cutoff — otherwise "first reading AT cutoff" is vacuous.
    expect(deepAcwi.filter((o) => o.date < CUTOFF).length, "premise: warmup fits below cutoff").toBeGreaterThan(MA_WINDOW);
    const feed: BackfillDeps = { ...stub, fetchPrices: async (symbol, o) => (symbol === "ACWI" ? deepAcwi : stub.fetchPrices(symbol, o)) };

    const store = new InMemoryStore();
    const res = await backfillAll(store, feed, { years: YEARS, now: NOW, only: ["GT"] });
    expect(JSON.stringify(res.failures), "GT must not fail").not.toContain('"GT"');

    const stored = await store.getSeries("GT", DEEP_PROBE);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => r.date >= CUTOFF), "no reading below the cutoff").toBe(true);
    expect(stored[0]!.date, "first stored reading lands ON the cutoff — warmup burned below it").toBe(CUTOFF);
  });
});

// Finding 1 (2026-09-05 review): the `fredObs` feed trim at the BARE cutoff discarded the very
// warm-up lead-in `planFetch` fetched via the spec's `warmupDays`, so G1/BRENT's 756-trading-day
// trailing-peak window could never resolve inside a 3y FRED feed (~753 trading rows) and the level
// leg persisted structurally GREEN forever — full seed, `--restate=G1` and the cron-plan tail alike.
describe("backfillAll G1 seed: the level leg resolves AT the cutoff (feed keeps its warm-up lead-in)", () => {
  const NOW = new Date("2024-06-01T00:00:00Z");
  const YEARS = 3; // the prod default depth — the shape under which the defect bites
  const CUTOFF = isoCutoff(NOW, YEARS);
  const LEVEL_WINDOW = GEO_HYBRID_DESCRIPTOR_OF.G1!.scorer.constants.levelWindow!;

  // WEEKDAY-only monotone ramp (prod FRED cadence ≈ 253 rows/yr — calendar-daily obsSeries would
  // hand a 3y feed ~1095 rows and mask the underrun): every close is a fresh trailing-peak breach,
  // so every LEVEL-resolvable day is RED, while the ~1% 20d velocity stays far below the amber ret.
  function weekdayRamp(startISO: string, endISO: string): Observation[] {
    const out: Observation[] = [];
    const d = new Date(`${startISO}T00:00:00Z`);
    let i = 0;
    while (d.toISOString().slice(0, 10) <= endISO) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) out.push({ date: d.toISOString().slice(0, 10), value: 50 + i++ * 0.05 });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  it("stores a non-GREEN G1 raw state at the cutoff — the trailing peak resolved off pre-cutoff lead-in", async () => {
    const feedStart = isoDaysBefore(new Date(`${CUTOFF}T00:00:00Z`), OIL_LEVEL_LOOKBACK_DAYS);
    const wti = weekdayRamp(feedStart, NOW.toISOString().slice(0, 10));
    // Premise (can-fail): the feed carries a full LEVEL_WINDOW of PRE-cutoff observations, so the
    // gate provably resolves on the cutoff's own row rather than deep into the served span.
    expect(wti.filter((o) => o.date < CUTOFF).length).toBeGreaterThan(LEVEL_WINDOW);
    const feed: BackfillDeps = { ...stub, fetchFred: async (series, o) => (series === G1.series ? wti : stub.fetchFred(series, o as never)) };

    const store = new InMemoryStore();
    const res = await backfillAll(store, feed, { years: YEARS, now: NOW, only: ["G1"] });
    expect(JSON.stringify(res.failures), "G1 must not fail").not.toContain('"G1"');

    const stored = await store.getSeries("G1", DEEP_PROBE);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => r.date >= CUTOFF), "readings still trim at the cutoff").toBe(true);
    // Level RED + velocity GREEN under combine "split" ⇒ AMBER. A bare-cutoff feed trim leaves the
    // window unresolvable at the cutoff (underrun degrades to GREEN by design) — the red demo.
    expect(stored[0]!.rawState, "first stored reading's level leg resolved (non-GREEN)").not.toBe("GREEN");
  });
});

// F5/SPCONC emit ONLY ranked days (2026-10-03), and the shared SCORED_WARMUP_DAYS lead-in sits below
// `BREADTH_MIN_CLOSES` — so an incremental plan on the shared warmup builds `[]` and the re-shadow tail
// goes inert. The specs' own `warmupDays` must carry the live deep depth into the `since` plan.
describe("backfillAll F5/SPCONC incremental plan: legs fetched at the live breadth depth", () => {
  it("asks QQQ/QQQE/SPY/RSP for lookbackDays >= BREADTH_LOOKBACK_DAYS on a current-row `since` plan", async () => {
    const store = new InMemoryStore();
    // Seeded AT `now` — the tightest (re-shadow) `since` window the planner can produce.
    const today = opts.now.toISOString().slice(0, 10);
    await seedRow(store, "F5", today);
    await seedRow(store, "SPCONC", today);
    const asked = new Map<string, { deep: boolean; lookbackDays?: number }[]>();
    const recStub: BackfillDeps = {
      ...stub,
      fetchPrices: async (symbol, o) => {
        asked.set(symbol, [...(asked.get(symbol) ?? []), o]);
        return stub.fetchPrices(symbol, o);
      },
    };

    await backfillAll(store, recStub, { ...opts, only: ["F5", "SPCONC"] });

    for (const symbol of ["QQQ", "QQQE", "SPY", "RSP"]) {
      const asks = asked.get(symbol) ?? [];
      expect(asks.length, `${symbol}: breadth must fetch its leg`).toBeGreaterThan(0);
      for (const o of asks) {
        // Bounded (a `since` plan, not a full re-pull) AND at least the live breadth depth.
        expect(o.lookbackDays, `${symbol}: incremental plan must bound the fetch`).toBeDefined();
        expect(o.lookbackDays!, `${symbol}: lookback must reach BREADTH_LOOKBACK_DAYS`).toBeGreaterThanOrEqual(BREADTH_LOOKBACK_DAYS);
      }
    }
  });
});

describe("backfillPension (hermetic, stub feeds)", () => {
  // All six PENSION legs fetch via fetchPrices (the sleeve/comparator adj-close tickers + the FX leg
  // as the closes feed's EURUSD=X, stored under id DEXUSEU). Each stub returns the SAME ≥300-pt synthetic series
  // obsSeries seeds for backfillAll — the 2019 dates survive the years=100 trim cutoff, so
  // every leg projects ≥1 stored row.
  const pensionStub: PensionBackfillDeps = {
    fetchPrices: vi.fn(async () => obsSeries(N)),
  };
  // Every chartable PENSION sleeve id — the guard that a leg never silently drops out of PENSION_LEGS
  // (J4 dropped SMH/VWO/VGK/XDEV, stranding four still-charted comparators with no writer).
  const pensionLegIds = ["DEXUSEU", "SPY", "SP500IT", "VWO", "VGK", "XDEV"];

  it("seeds all six legs on the first run and 0 on an idempotent re-run", async () => {
    const store = new InMemoryStore();

    const first = await backfillPension(store, pensionStub, opts);
    expect(first.inserted).toBeGreaterThan(0);
    // Every leg seeded — guards against a leg silently dropping out of PENSION_LEGS.
    for (const id of pensionLegIds) {
      expect(first.perLeg[id]).toBeGreaterThan(0);
    }
    // Source-pins each leg's fetch ticker (the stub returns the same data for any symbol, so a
    // wrong ticker would pass silently): the FX leg MUST fetch the closes feed's EURUSD=X (not FRED DEXUSEU);
    // the store-id≠ticker legs MUST fetch XLK (SP500IT) and XDEV.DE (XDEV), not their own store ids.
    for (const sym of ["SPY", "EURUSD=X", "XLK", "VWO", "VGK", "XDEV.DE"]) {
      expect(pensionStub.fetchPrices).toHaveBeenCalledWith(sym, { deep: true });
    }

    // Re-run against the SAME store: the DEEP_PROBE getSeries date-diff finds every
    // date already present, so insert-missing is a no-op (the §step-2 idempotency
    // contract — re-run = 0 new rows, mirroring the backfillHistory probe-depth test).
    const second = await backfillPension(store, pensionStub, opts);
    expect(second.inserted).toBe(0);
    for (const id of pensionLegIds) {
      expect(second.perLeg[id]).toBe(0);
    }
  });
});

describe("backfillInputSeries (hermetic, stub feeds)", () => {
  // Every roster id fetches through its own feed seam; the stub returns the same >=300-pt
  // synthetic series pension/bottom use. No BACKFILL_YEARS trim on this job, so every id
  // projects the full stub span.
  const inputStub: InputSeriesBackfillDeps = {
    fetchFred: vi.fn(async () => obsSeries(N)),
    fetchPrices: vi.fn(async () => obsSeries(N)),
    fetchNtfs: vi.fn(async () => obsSeries(N)),
  };

  it("seeds every roster id at full depth on the first run and 0 on an idempotent re-run", async () => {
    const store = new InMemoryStore();

    const first = await backfillInputSeries(store, inputStub, opts);
    expect(first.inserted).toBe(N * INPUT_SERIES.length);
    for (const { id } of INPUT_SERIES) expect(first.perLeg[id]).toBe(N);
    // Feed-pins the full plan: FRED ids pull full history; the replay price companions honour
    // their 31y deepLookbackDays override, plain price ids the 20y deep default.
    expect(inputStub.fetchFred).toHaveBeenCalledWith("VIXCLS", { fullHistory: true });
    const gspcDeep = INPUT_SERIES.find((s) => s.id === "^GSPC")?.deepLookbackDays;
    expect(gspcDeep, "premise: ^GSPC carries a deepLookbackDays override").toBeDefined();
    expect(inputStub.fetchPrices).toHaveBeenCalledWith("^GSPC", { deep: true, lookbackDays: gspcDeep });
    expect(inputStub.fetchPrices).toHaveBeenCalledWith("ACWI", { deep: true });
    expect(inputStub.fetchPrices).toHaveBeenCalledWith("XDEV.DE", { deep: true }); // `symbol`, not the store id
    expect(inputStub.fetchPrices).not.toHaveBeenCalledWith("XDEV", expect.anything());
    // R8's own series rides the GSW seam, never fetchFred("NTFS") (no such FRED series).
    expect(inputStub.fetchNtfs).toHaveBeenCalledTimes(1);
    expect(inputStub.fetchFred).not.toHaveBeenCalledWith("NTFS", expect.anything());

    // Re-run against the SAME store: the date-diff finds every date present => 0 new rows.
    const second = await backfillInputSeries(store, inputStub, opts);
    expect(second.inserted).toBe(0);
  });
});

describe("backfillBottom (hermetic, stub feeds)", () => {
  // Both BOTTOM legs fetch via fetchFred (FRED VIXCLS / VXVCLS levels — NOT the
  // retired the closes feed's `^VIX`/`^VIX3M` price path). The stub returns the same ≥300-pt synthetic
  // series backfillAll/pension use — the 2019 dates survive the years=100 trim cutoff, so
  // each leg projects ≥1 stored row.
  const bottomStub: BottomBackfillDeps = {
    fetchFred: vi.fn(async () => obsSeries(N)),
  };

  it("seeds both legs on the first run and 0 on an idempotent re-run", async () => {
    const store = new InMemoryStore();

    const first = await backfillBottom(store, bottomStub, opts);
    expect(first.inserted).toBeGreaterThan(0);
    // Every leg seeded — guards against a leg silently dropping out of BOTTOM_LEGS.
    for (const id of ["VIX", "VIX3M"]) {
      expect(first.perLeg[id]).toBeGreaterThan(0);
    }
    // Source-pins the feed SET: the stored VIX/VIX3M legs MUST fetch the keyless FRED series
    // the live bottom track scores (`vix_term.ts` VIX_SYMBOL/VIX3M_SYMBOL), not the retired
    // the closes feed's `^VIX`/`^VIX3M` index symbols that froze at 2026-07-17.
    expect(bottomStub.fetchFred).toHaveBeenCalledWith(VIX_SYMBOL, { fullHistory: true });
    expect(bottomStub.fetchFred).toHaveBeenCalledWith(VIX3M_SYMBOL, { fullHistory: true });
    // …and the PAIRING, which the two call assertions above cannot see: the stub returns the
    // same data for every series, so swapping `series` between the two BOTTOM_INDICATORS rows
    // keeps both `toHaveBeenCalledWith`s green while the VIX leg is seeded with 3-month data.
    // Pinned id→series against vix_term's constants (single-source, no literals restated here).
    expect(BOTTOM_INDICATORS.map((ind) => [ind.id, ind.series])).toEqual([
      ["VIX", VIX_SYMBOL],
      ["VIX3M", VIX3M_SYMBOL],
    ]);

    // Re-run against the SAME store: the DEEP_PROBE getSeries date-diff finds every
    // date already present, so insert-missing is a no-op (re-run = 0 new rows).
    const second = await backfillBottom(store, bottomStub, opts);
    expect(second.inserted).toBe(0);
    for (const id of ["VIX", "VIX3M"]) {
      expect(second.perLeg[id]).toBe(0);
    }
  });
});

describe("backfillDownsideBreaks (hermetic, stub feed — COMPUTED downside-break series)", () => {
  // Each DOWNSIDE_DETECTORS row fetches its symbol's closes via fetchPrices (the pension deps seam), then SCORES them via
  // downsideBreakReadingSeries and persists the computed Reading[] (level=close, state/decision)
  // through the backfillHistory scored seam. The stub returns the same ≥300-pt daily series (clears
  // HIGH_WINDOW_SHORT=63) so the scorer emits ≥1 reading; the 2019 dates survive the years=100 trim.
  const dbSmhStub: PensionBackfillDeps = {
    fetchPrices: vi.fn(async () => obsSeries(N)),
  };

  it("seeds the COMPUTED DB_* series for EVERY detector on the first run and 0 on an idempotent re-run", async () => {
    const store = new InMemoryStore();

    const first = await backfillDownsideBreaks(store, dbSmhStub, opts);
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.perLeg.DB_SMH).toBeGreaterThan(0);
    // EVERY DOWNSIDE_DETECTORS row seeds — a job that covered only the first detector would leave
    // the rest's perLeg undefined (a new detector silently getting no backfill is the failure mode).
    for (const d of DOWNSIDE_DETECTORS) {
      expect(first.perLeg[d.indicator.id], d.indicator.id).toBeGreaterThan(0);
    }
    // …and EVERY RS_LEGS row seeds off the same job (the 2026-08-15 extension) — same failure mode.
    for (const l of RS_LEGS) {
      expect(first.perLeg[l.indicator.id], l.indicator.id).toBeGreaterThan(0);
    }
    // Source-pins each fetched symbol: DB_SMH MUST fetch SMH, DB_XLK MUST fetch XLK, and each RS
    // leg BOTH its numerator and SPY. The stub returns the same data for any symbol, so without
    // this a regression to the wrong symbol would pass silently.
    for (const d of DOWNSIDE_DETECTORS) {
      expect(dbSmhStub.fetchPrices, d.indicator.id).toHaveBeenCalledWith(d.symbol, { deep: true });
    }
    for (const l of RS_LEGS) {
      for (const sym of l.symbols) {
        expect(dbSmhStub.fetchPrices, `${l.indicator.id}:${sym}`).toHaveBeenCalledWith(sym, { deep: true });
      }
    }

    // The persisted rows are the COMPUTED downside-break series, NOT the raw SMH price: the stored
    // `decision` column carries the drawdown (close ÷ 63d-high − 1, a non-positive fraction) and a
    // scored `state` — the vintage the notify EARLY-WARN sub-signal reads (`alert-band.ts`
    // `find("DB_SMH")`). A raw-price seed would carry no decision and a hardcoded GREEN state, so
    // this presence check pins that the SCORED path landed under the DB_SMH id. (The detail graph
    // re-derives from the stored close either way, so it is not what distinguishes the two paths.)
    const series = await store.getSeries("DB_SMH", DEEP_PROBE);
    expect(series.length).toBe(first.perLeg.DB_SMH); // per-leg, not the multi-detector total
    expect(series.every((p) => p.decision !== null && p.decision !== undefined && p.decision <= 0)).toBe(true);

    // Re-run against the SAME store: the DEEP_PROBE getSeries date-diff finds every date already
    // present, so insert-missing is a no-op (re-run = 0 new rows).
    const second = await backfillDownsideBreaks(store, dbSmhStub, opts);
    expect(second.inserted).toBe(0);
    for (const d of DOWNSIDE_DETECTORS) expect(second.perLeg[d.indicator.id], d.indicator.id).toBe(0);
    for (const l of RS_LEGS) expect(second.perLeg[l.indicator.id], l.indicator.id).toBe(0);
  });
});

describe("backfillFxhCmp (hermetic, stub feeds)", () => {
  const stub = (): FxhCmpBackfillDeps => ({ fetchPrices: vi.fn(async () => obsSeries(N)) });
  const FXH_ROSTER = COMPOSITE_COMPONENTS["FXH"] ?? [];
  const FXH_IDS = FXH_ROSTER.map((c) => c.id);

  it("seeds every CMP_FXH_* leg CAPPED on the first run and 0 on an idempotent re-run", async () => {
    // Roster premise: every loop below iterates this derived roster, so an emptied one leaves them vacuously green.
    expect(FXH_IDS).not.toHaveLength(0);
    const store = new InMemoryStore();
    const deps = stub();
    const first = await backfillFxhCmp(store, deps, opts);
    expect(first.inserted).toBeGreaterThan(0);
    for (const id of FXH_IDS) expect(first.perLeg[id], id).toBeGreaterThan(0);
    // The FULL plan (unseeded store) still fetches the CAPPED window — never `priceOpts`,
    // whose full arm drops the bound (free-tier price-feed guard, [USER] 2026-08-11).
    for (const c of FXH_ROSTER) {
      expect(deps.fetchPrices, c.id).toHaveBeenCalledWith(c.symbol, { deep: true, lookbackDays: FXH_CMP_LOOKBACK_DAYS });
    }
    // Re-run against the SAME store: the DEEP_PROBE getSeries date-diff finds every
    // date already present, so insert-missing is a no-op (re-run = 0 new rows).
    const second = await backfillFxhCmp(store, deps, opts);
    expect(second.inserted).toBe(0);
    for (const id of FXH_IDS) expect(second.perLeg[id], id).toBe(0);
  });

  it("--reshadow-all re-writes the named leg in FULL, still capped; unnamed legs stay insert-missing", async () => {
    const store = new InMemoryStore();
    await backfillFxhCmp(store, stub(), opts); // seed
    const deps = stub();
    const re = await backfillFxhCmp(store, deps, { ...opts, reshadowAll: ["CMP_FXH_DEXUSEU"] });
    // ALL fetched rows re-written under a fresh vintage (count = whole stored series, NOT 0
    // and NOT the since-tail); the two unnamed legs take the no-op insert-missing path.
    const stored = await store.getSeries("CMP_FXH_DEXUSEU", DEEP_PROBE);
    expect(stored.length).toBeGreaterThan(0);
    expect(re.perLeg.CMP_FXH_DEXUSEU).toBe(stored.length);
    expect(re.perLeg.CMP_FXH_DEXSZUS).toBe(0);
    expect(re.perLeg.CMP_FXH_DEXJPUS).toBe(0);
    // Unlike the pension reshadow (UNBOUNDED deep window), this job's reshadow fetch keeps the
    // hard cap — the cap surviving `--reshadow-all` is the stage's whole point.
    const sym = FXH_ROSTER.find((c) => c.id === "CMP_FXH_DEXUSEU")!.symbol;
    expect(deps.fetchPrices).toHaveBeenCalledWith(sym, { deep: true, lookbackDays: FXH_CMP_LOOKBACK_DAYS });
  });
});

describe("backfillLegs — an FX-outage skip is all-or-nothing (nine legs move together)", () => {
  // A date with no usable EURUSD rate at/before it must freeze ALL nine legs, not just the three
  // USD-quoted ones. The six EUR-quoted legs don't need FX, so the per-leg skip inside
  // legCloseReadingRows would still write them on that date — splitting the EUR NAV snapshot. FX
  // starts on D2, so D1 has no usable rate and must appear in NO leg's stored series (the EUR-leg
  // assertion goes RED on the pre-fix per-leg skip, which wrote D1 for the six EUR legs).
  const [D1, D2, D3] = ["2024-06-03", "2024-06-04", "2024-06-05"];
  const closes = (): Observation[] => [
    { date: D1, value: 100 },
    { date: D2, value: 101 },
    { date: D3, value: 102 },
  ];
  // FX (EURUSD=X) rides the same fetchPrices seam post-flip; it starts on D2 so D1 has no rate.
  const fxObs = (): Observation[] => [
    { date: D2, value: 1.08 },
    { date: D3, value: 1.09 },
  ];
  const legsStub: LegsBackfillDeps = {
    fetchPrices: async (symbol) => (symbol === "EURUSD=X" ? fxObs() : closes()),
  };

  it("drops the FX-gap date from every leg", async () => {
    const store = new InMemoryStore();
    await backfillLegs(store, legsStub);

    for (const id of [legCloseId("Semis"), legCloseId("S&P IT")]) {
      const dates = (await store.getSeries(id, DEEP_PROBE)).map((r) => r.date);
      expect(dates, id).toEqual([D2, D3]); // seeds from the first FX-covered date, D1 frozen for ALL legs
    }
  });

  it("reshadow-all forces the shared plan to FULL and re-writes every leg where a plain re-run writes 0", async () => {
    const store = new InMemoryStore();
    await backfillLegs(store, legsStub); // seed [D2, D3] for all nine legs
    const plain = await backfillLegs(store, legsStub);
    const semis = legCloseId("Semis");
    expect(plain.perLeg[semis]).toBe(0); // insert-missing no-op

    // Any reshadow-all id forces ONE shared FULL plan for all nine legs. Fresh vi.fn deps so the
    // fetch-args pin isolates the reshadow run (not the unseeded first seed, which is full anyway).
    const allIds = LADDER.map((s) => legCloseId(s));
    const legsDeps: LegsBackfillDeps = {
      fetchPrices: vi.fn(async (symbol: string) => (symbol === "EURUSD=X" ? fxObs() : closes())),
    };
    const re = await backfillLegs(store, legsDeps, { reshadowAll: allIds });
    // Plan-forcing pin (the legs shared-plan path — distinct from pension's per-leg forcing): FX and
    // price tickers all fetch the UNBOUNDED deep window; a regression dropping `anyReshadow` collapses
    // this to the since planner (`{ deep, lookbackDays }`) and the re-seed shrinks to the tail. The
    // EURUSD=X pin also source-pins the FX leg post FRED→closes-feed flip (a "DEXUSEU" regression reds it).
    expect(legsDeps.fetchPrices).toHaveBeenCalledWith("EURUSD=X", { deep: true });
    expect(legsDeps.fetchPrices).toHaveBeenCalledWith("SEC0.DE", { deep: true });
    // A proxy fetches only when the leg's window reaches before its join: VEA (2025-03-03); SMH → the pinned-now test below.
    expect(legsDeps.fetchPrices).toHaveBeenCalledWith("VEA", { deep: true });
    for (const id of allIds) {
      const stored = await store.getSeries(id, DEEP_PROBE);
      expect(re.perLeg[id], id).toBe(stored.length); // full re-write, not the since-tail
    }
  });

  // A reshadow onto a new listing deletes stored dates the new chain lacks
  // (old-calendar holidays, the old pre-cutoff prefix); LEGP_SEMIS's depth reaches SMH's pre-join stretch.
  it("reshadow-all deletes stale stored dates; LEGP_SEMIS's depth fetches the SMH proxy stretch", async () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const [old, deep, hole, join, mid, gap, tail] = ["2019-01-02", "2019-08-06", "2020-06-01", "2021-08-06", "2024-06-03", "2024-06-04", "2024-06-05"];
    const obs = (ds: string[], v: number): Observation[] => ds.map((date, i) => ({ date, value: v + i }));
    const fetchPrices = vi.fn(async (symbol: string) =>
      symbol === "EURUSD=X" ? obs([deep, join, mid, tail], 1.1) : symbol === "SMH" ? obs([deep, join], 200) : obs([join, mid, tail], 50),
    );
    const semis = legCloseId("Semis");
    const store = new InMemoryStore();
    await store.recordReadings([old, hole, gap].map((date) => makeStoredReading(semis, { date })), "2025-01-01T00:00:00Z");
    const dates = async (): Promise<string[]> => (await store.getSeries(semis, DEEP_PROBE)).map((r) => r.date);

    await backfillLegs(store, { fetchPrices }, { now }); // plain pass: insert-missing, the stale rows survive
    expect(await dates()).toEqual(expect.arrayContaining([old, hole, gap]));

    fetchPrices.mockClear();
    await backfillLegs(store, { fetchPrices }, { now, reshadowAll: [semis] });
    expect(fetchPrices).toHaveBeenCalledWith("SMH", { deep: true });
    expect(await dates()).toEqual([deep, join, mid, tail]);
  });

  // A proxied leg's cutoff derives from its join (`LEG_PROXY_SEED_YEARS` before `until`), so it never ages past it.
  it("a far-future reshadow still seeds 2y of proxy stretch before each join (SMH ≤ 2019-08-06, VEA ≤ 2023-03-03)", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const semis = legCloseId("Semis");
    const exus = legCloseId("ex-US");
    const proxyDates: Record<string, string[]> = { SMH: ["2019-08-06", "2021-08-06"], VEA: ["2023-03-03", "2025-03-03"] };
    const held = ["2021-08-06", "2025-03-03", "2029-12-28"];
    const fetchPrices = vi.fn(async (symbol: string): Promise<Observation[]> => {
      const ds = symbol === "EURUSD=X" ? ["2019-08-06", "2023-03-03", ...held] : (proxyDates[symbol] ?? held);
      return ds.map((date, i) => ({ date, value: 10 + i }));
    });
    const store = new InMemoryStore();
    await backfillLegs(store, { fetchPrices }, { now, reshadowAll: [semis, exus] });
    expect(fetchPrices).toHaveBeenCalledWith("SMH", { deep: true });
    expect(fetchPrices).toHaveBeenCalledWith("VEA", { deep: true });
    expect((await store.getSeries(semis, DEEP_PROBE))[0]?.date).toBe("2019-08-06");
    expect((await store.getSeries(exus, DEEP_PROBE))[0]?.date).toBe("2023-03-03");
  });

  // A truncated held-fund feed (a short closes provider window) must not delete the stored rows it never reached.
  it("refuses a reshadow delete when the fetch looks truncated: older stored rows stay", async () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const semis = legCloseId("Semis");
    const storedDates = Array.from({ length: 24 }, (_, i) => `${2021 + Math.floor(i / 6)}-${String(1 + (i % 6) * 2).padStart(2, "0")}-15`);
    const recent = ["2026-08-03", "2026-09-01", "2026-10-01"];
    const fetchPrices = vi.fn(async (symbol: string): Promise<Observation[]> =>
      symbol === "SMH" ? [] : recent.map((date, i) => ({ date, value: (symbol === "EURUSD=X" ? 1.1 : 50) + i })),
    );
    const store = new InMemoryStore();
    await store.recordReadings(storedDates.map((date) => makeStoredReading(semis, { date })), "2025-01-01T00:00:00Z");
    await expect(backfillLegs(store, { fetchPrices }, { now, reshadowAll: [semis] })).rejects.toThrow(
      /LEGP_SEMIS: refusing reshadow delete — 24 of 24 stored rows .*the fetch looks truncated/,
    );
    expect((await store.getSeries(semis, DEEP_PROBE)).map((r) => r.date)).toEqual(storedDates);
  });

  // Off-ladder isolation (code-review 2026-09-22): LYTR.DE (→ LEGP_COMMOD) once rode the SAME
  // `Promise.all` as the nine ladder tickers, so a LYTR.DE rejection aborted `backfillLegs` outright
  // (it has no outer try/catch) — none of the nine ladder legs seeded. It now fetches in an isolated
  // arm: a rejection yields [] for LEGP_COMMOD and the nine ladder legs seed as before.
  it("isolates a rejected off-ladder fetch: nine ladder legs seed, no LEGP_COMMOD row", async () => {
    const store = new InMemoryStore();
    const rejectStub: LegsBackfillDeps = {
      fetchPrices: async (symbol) => {
        if (symbol === "LYTR.DE") throw new Error("off-ladder feed down");
        return symbol === "EURUSD=X" ? fxObs() : closes();
      },
    };
    await backfillLegs(store, rejectStub);

    for (const sleeve of LADDER) {
      const dates = (await store.getSeries(legCloseId(sleeve), DEEP_PROBE)).map((r) => r.date);
      expect(dates, legCloseId(sleeve)).toEqual([D2, D3]); // nine legs seed despite the off-ladder reject
    }
    expect((await store.getSeries(offLadderLegCloseId("Commodities"), DEEP_PROBE)).length).toBe(0); // rejected off-ladder → no COMMOD row
  });

  // The legs job trims each leg to the shared `BACKFILL_YEARS` unless a `LEG_BACKFILL_YEARS` row
  // deepens it (LEGP_EUFIN): a close older than a leg's own cutoff must be DROPPED.
  it("trims legs to the shared BACKFILL_YEARS window, dropping an older close — EU-Fin keeps it", async () => {
    const now = new Date("2026-07-31T00:00:00Z");
    const cutoff = isoCutoff(now, BACKFILL_YEARS);
    const older = isoCutoff(now, LEG_BACKFILL_YEARS.LEGP_EUFIN!);
    expect(older < cutoff, `${older} < ${cutoff}`).toBe(true);

    const recent = "2026-07-30";
    const deepStub: LegsBackfillDeps = {
      fetchPrices: async (symbol) =>
        symbol === "EURUSD=X"
          ? [
              { date: older, value: 1.3 },
              { date: recent, value: 1.16 },
            ]
          : [
              { date: older, value: 50 },
              { date: recent, value: 60 },
            ],
    };
    const store = new InMemoryStore();
    await backfillLegs(store, deepStub, { now });
    const dates = (await store.getSeries(legCloseId("S&P 500"), DEEP_PROBE)).map((r) => r.date);
    expect(dates).toEqual([recent]);
    // LEGP_EUFIN declares its own deeper `LEG_BACKFILL_YEARS` row, so the same close seeds there.
    const eufin = (await store.getSeries(legCloseId("EU-Fin"), DEEP_PROBE)).map((r) => r.date);
    expect(eufin).toEqual([older, recent]);
  });

  // Prod 2026-09-22: the cron seed wrote a few recent LEGP_COMMOD rows before the first backfill, so
  // `latestStoredDate` called it seeded and the job ran a 14-day `since` tail — 9 rows, no history.
  // Nine deep legs + one recent-only COMMOD row must still force the FULL pull and fill COMMOD deep.
  it("a recent-only (shallow) leg forces the full fetch and seeds its history", async () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const deepDate = isoCutoff(now, BACKFILL_YEARS - 1); // inside the window, past the slack
    const recent = "2026-09-18";
    // Honours the plan's window like the real feed: a `since` tail (lookbackDays) never reaches deepDate.
    const inWindow = (obs: Observation[], lookbackDays?: number): Observation[] =>
      lookbackDays === undefined ? obs : obs.filter((o) => o.date >= new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10));
    const stub: LegsBackfillDeps = {
      fetchPrices: async (symbol, o) =>
        inWindow(symbol === "EURUSD=X"
          ? [
              { date: deepDate, value: 1.1 },
              { date: recent, value: 1.17 },
            ]
          : [
              { date: deepDate, value: 30 },
              { date: recent, value: 39 },
            ], o.lookbackDays),
    };
    // Seed the prod shape: nine legs deep, COMMOD holding only the recent row (as the cron left it).
    const recentOnlyCommod: LegsBackfillDeps = {
      fetchPrices: async (symbol, o) =>
        symbol === "LYTR.DE" ? [{ date: recent, value: 39 }] : stub.fetchPrices(symbol, o),
    };
    const store = new InMemoryStore();
    await backfillLegs(store, recentOnlyCommod, { now });
    const commod = offLadderLegCloseId("Commodities");
    expect((await store.getSeries(commod, DEEP_PROBE)).map((r) => r.date)).toEqual([recent]); // premise
    expect((await store.getSeries(legCloseId("Semis"), DEEP_PROBE)).map((r) => r.date)).toEqual([deepDate, recent]);

    const res = await backfillLegs(store, stub, { now });
    expect(res.perLeg[commod]).toBeGreaterThan(0);
    expect((await store.getSeries(commod, DEEP_PROBE)).map((r) => r.date)).toEqual([deepDate, recent]);
  });
});

describe("backfillCape (hermetic, stub feed — trimmed to F7\u2019s override depth)", () => {
  // CAPE is a raw stored series (id F7) fed by the monthly Shiller-CAPE history.
  // Since the 2026-09-05 contract the feed IS trimmed — to F7's own registry `backfill` depth
  // (stored depth is display-only; the z-score scores off the live full feed).
  // The stub straddles that cutoff so the trim is observable on
  // both sides.
  const capeStub: CapeBackfillDeps = {
    fetchCape: vi.fn(async () => [
      { date: "1990-01-01", value: 17.05 },
      { date: "1990-02-01", value: 16.5 },
      { date: "2009-03-01", value: 13.32 },
      { date: "2026-07-01", value: 41.94 },
    ]),
  };

  it("trims to F7's override cutoff and 0 on an idempotent re-run", async () => {
    const store = new InMemoryStore();
    // FIXED `now` well after the stub's newest row (2026-07-01): F7 is revision-prone, so a
    // real-clock `now` landing within REVISION_TAIL_DAYS of 2026-07-01 would re-shadow that row
    // and make the re-run's `inserted` non-zero. Pinning `now` a year out keeps the tail clear.
    const capeOpts = { now: new Date("2027-06-01T00:00:00Z") };
    const cutoff = backfillSinceDate("F7", capeOpts.now);
    const kept = (await capeStub.fetchCape()).filter((r) => r.date >= cutoff);
    // Vacuity guard: the stub must straddle the cutoff, or the trim assertion pins nothing.
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan((await capeStub.fetchCape()).length);

    const first = await backfillCape(store, capeStub, capeOpts);
    expect(first.inserted).toBe(kept.length);
    expect(first.perLeg.F7).toBe(kept.length);

    // Trim proof: exactly the on/after-cutoff dates persisted — the 1990/2009 rows dropped.
    const series = await store.getSeries("F7", DEEP_PROBE);
    const dates = series.map((r) => r.date);
    expect(dates).toEqual(kept.map((r) => r.date));
    expect(dates).not.toContain("1990-01-01");

    // Re-run against the SAME store: the DEEP_PROBE getSeries date-diff finds every date
    // present, and 2026-07-01 sits well before the (now − REVISION_TAIL_DAYS) re-shadow
    // floor, so insert-missing is a no-op (re-run = 0 new rows).
    const second = await backfillCape(store, capeStub, capeOpts);
    expect(second.inserted).toBe(0);
    expect(second.perLeg.F7).toBe(0);
  });

  it("stores the open month (on/after the clock's UTC month start) `estimated`, as the cron seed does; a closed month FINAL", async () => {
    const store = new InMemoryStore();
    const deps: CapeBackfillDeps = { fetchCape: async () => [{ date: "2026-06-01", value: 40.1 }, { date: "2026-07-01", value: 41.94 }] };
    await backfillCape(store, deps, { now: new Date("2026-07-15T12:00:00Z") });
    const flags = (await store.getSeries("F7", DEEP_PROBE)).map((p) => [p.date, p.estimated === true]);
    expect(flags).toEqual([["2026-06-01", false], ["2026-07-01", true]]);
  });
});

