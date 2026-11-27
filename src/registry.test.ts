import { describe, expect, it, test } from "vitest";

import {
  ALL_INDICATORS,
  ID_SETS,
  indicatorIds,
} from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_COMPONENTS } from "./registry-composite.js";
import {
  FEED_OF,
  T10Y3M_POST_INVERSION,
  TREASURY_HEAD_OF,
} from "./registry-fred.js";
import {
  indicatorReadingSeries,
  postInversionCutSeries,
  smoothedLevelReadingSeries,
} from "./scorers-core.js";
import { VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import { INPUT_SERIES } from "./input-series.js";
import { buildFamilyChart } from "./chart-rail.js";
import {
  CHART_PARAMS_OF,
  SMOOTHED_LEVEL_OF,
  DETAIL_WINDOW,
  RS_CUT_OVERRIDES,
  rsCuts,
  AT1_DESCRIPTOR,
  RS_SMH_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { velocitySigmaFetchOpts } from "./fred.js";
import { indicatorFetchPlan } from "./indicator-feed.js";
import { velocitySigmaDepth } from "./domain-fold.js";
import { activeLegs, operativePairUsable } from "./domain-legs.js";
import { levelCutIds, readFixture } from "../scripts/backtest/drift-guard.js";
import { assessIndicatorFreshness, lagCutFor, AMBITION_THRESHOLDS } from "./ladder.js";
import { feedCalendarTodayResolver, todayOnFeedCalendar, FEED_CALENDAR_TZ } from "./dates.js";
import { feedTimeZoneIndex } from "./feed-lag.js";
import type { Indicator } from "./domain-types.js";
import { REACHABLE_IDS } from "./threshold-config.js";
import { synthesizedCalib } from "./synth-cuts.js";
import { driftMemo, indById } from "./registry.test-helpers.js";
import { sleeveLabel } from "./families.js";

/** A fixed clock for the fetch-plan windows (`since` bounds). */
const PLAN_NOW = new Date("2026-10-25T22:00:00Z");

// Hoisted once: the R8/R1 describes replay the same fixture repeatedly; read the raw CSV a single
// time at module load and slice off it (tests never mutate the array). No behaviour change.
const T10Y3M_OBS: Observation[] = readFixture("scripts/backtest/data/t10y3m.csv");

// The DDR5 spot input is retired: neither a registry row nor an input-series roster id.
describe("retired DDR5 spot id", () => {
  // Spelled in two halves so a whole-word repo grep for the retired id stays at zero hits.
  const RETIRED = new RegExp(`^${["DRAM", "SPOT"].join("_")}$`);
  test("no registered or input-series id is the retired spot id", () => {
    const ids = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS, ...INPUT_SERIES].map((i) => i.id);
    expect(ids.length, "premise: the rosters are non-empty").toBeGreaterThan(0);
    expect(ids.filter((id) => RETIRED.test(id))).toEqual([]);
  });
});

describe("provisional flag is a typed registry field, carried by exactly the ids that earned it - EW-19", () => {
  // The whole point of EW-19 is that "measured but not optimized" is machine-readable.
  // Read the TYPED field off every registry entry (never a grep over comment text) and
  // pin the full carrier SET file-wide, so this fails both ways: if F1 loses the flag,
  // and if any other id silently acquires it without its own overfit-gate argument.
  // OVX (crisis rung 2) + BRENT (crisis rung 3, 2026-07-24): shipped on published priors with NO
  // overfit gate run — flagged provisional by the plan's binding threshold-defaults discipline.
  // T10YIE/T5YIFR LEFT the set 2026-08-31 `[USER]` — their pairs are FINAL, not awaiting a gate.
  // CCC: hand-set [USER] pairs, no overfit gate run.
  const EXPECTED_PROVISIONAL = ["F1", "OVX", "BRENT", "CCC"];

  test("exactly the expected ids carry the flag", () => {
    const carriers = ALL_INDICATORS.filter((i) => i.provisional === true).map((i) => i.id);
    expect(carriers).toEqual(EXPECTED_PROVISIONAL);
  });
});

describe("registry convention bands are strictly separated (usable) - N2", () => {
  // The display fallback (`effectiveCuts`, src/domain-legs.ts) is each indicator's static
  // convention band, ASSUMED always strictly separated in oriented space (its doc:
  // "the registry convention default — always strictly separated"). A degenerate
  // (amber==red) or inverted convention would propagate silently to any non-usable
  // cell that falls to it. Guard the registry against that regression through the
  // SAME predicate the handler resolves with — `operativePairUsable` (src/domain-legs.ts)
  // — rather than a local replica that could silently drift out of sync: level flips
  // on a LOW indicator, velocity never flips; an absent leg is vacuously fine
  // (bespoke scorers F4/G1/NVDA/F5 carry thresholds: {}).
  const separated = (amber: number | undefined, red: number | undefined, flip: boolean) =>
    amber === undefined || red === undefined || operativePairUsable(amber, red, flip);

  // ONE test over the whole registry: collect every violator id-labelled so a break still names
  // the offending indicator, and anchor non-vacuity on the count actually inspected.
  test("every entry: amber strictly more sensitive than red (oriented), level + velocity", () => {
    const violators: string[] = [];
    let inspected = 0;
    for (const i of ALL_INDICATORS) {
      inspected++;
      const t = i.thresholds;
      const low = i.direction === "LOW";
      if (!separated(t.amberLevel, t.redLevel, low)) violators.push(`${i.id} (level)`);
      if (!separated(t.amberVelocity, t.redVelocity, false)) violators.push(`${i.id} (velocity)`);
    }
    expect(inspected).toBe(ALL_INDICATORS.length);
    expect(inspected).toBeGreaterThan(0); // the loop ran, not zero
    expect(violators, `convention band violators: ${violators.join(", ")}`).toEqual([]);
  });
});

describe("deleted-coverage scorers-core branches stay unreachable from any live indicator - test-suite value audit ruling 3", () => {
  // Stage 2.4 ([USER]) deleted the two legacy
  // raw-close describes while KEEPING the code, so three scorers-core.ts exports now have ZERO suite
  // coverage: `drawdownLegSeries`, and the raw-close `postInversionFloorSeries`+`steepenerEscalationSeries`.
  // Tripwire: reds the instant a LIVE indicator wires onto that untested code. Two routes:
  //  - `drawdownLeg` present ⇒ `indicatorReadingSeries` calls `drawdownLegSeries` (registry-fred.ts R1
  //    docblock: re-wire = `drawdownLeg: T10Y3M_DRAWDOWN` + drop the `SMOOTHED_LEVEL_OF.R1` row);
  //  - `postInversionCooldown` present WITHOUT a `SMOOTHED_LEVEL_OF` row ⇒ the RAW-close branch that
  //    calls `postInversionFloorSeries`+`steepenerEscalationSeries` on raw closes. R1/R8 both carry a
  //    `SMOOTHED_LEVEL_OF` row (`confirmers.ts` resolveScoreBranch), so they take the tested mean path.
  // Tombstone: `src/dashboard.score-indicator.test.ts` (search "TOMBSTONE"). Do NOT restore the deleted
  // tests — the trade is ruled; this is the tripwire.
  test("no live indicator carries drawdownLeg, nor a raw-close postInversionCooldown", () => {
    const carriers: string[] = [];
    let inspected = 0;
    for (const i of ALL_INDICATORS) {
      inspected++;
      if (i.drawdownLeg !== undefined)
        carriers.push(`${i.id}: drawdownLeg is LIVE ⇒ drawdownLegSeries (scorers-core.ts) is untested`);
      if (i.postInversionCooldown !== undefined && SMOOTHED_LEVEL_OF[i.id] === undefined)
        carriers.push(`${i.id}: raw-close postInversionCooldown is LIVE ⇒ postInversionFloorSeries+steepenerEscalationSeries (scorers-core.ts) untested`);
    }
    expect(inspected).toBe(ALL_INDICATORS.length);
    expect(inspected).toBeGreaterThan(0); // the loop ran, not zero
    expect(
      carriers,
      `see the deleted-tests tombstone in src/dashboard.score-indicator.test.ts: ${carriers.join(", ")}`,
    ).toEqual([]);
  });
});

describe("per-source lag overrides - E7", () => {
  // ⚠ REPLACES the "FXH is tagged DAILY" block (§I9.3(4)) — that ruling is OVERTURNED. Its evidence
  // (`medianGap 1d / p90Gap 3d`, and the same statistic behind the F9/F11 "feed rot" reading) was
  // measured over OBSERVATION dates, which are structurally blind to RELEASE cadence: a feed that
  // stamps a daily observation grid but ships it in a weekly batch has p90Gap 3 and a real worst-case
  // age of 9. So a 9d-dark H.10 leg is a normal release week, not rot (§Stage 1.4).
  //
  // The ruled table, typed OUT OF BAND (a second source — not derived from the registry, so it can
  // actually disagree when a row drifts). `cadence` is the truthful registration; `lagAfterDays`
  // is the margin the tier cut does not carry (weekly's 9 is EXACTLY the H.10 structural max, so a
  // holiday-slipped Monday would still flag).
  const RULED: Record<string, { cadence: Indicator["cadence"]; lagAfterDays?: number }> = {
    // ⚠ F9 LEFT THIS TABLE 2026-08-10 — it left the weekly H.10 feed for `USDU` (`FEED_OF`, registry.ts)
    // and carries NO override: ETF grid, not `=X`, so its newest bar stays within `LAG_THRESHOLDS.daily` and no margin is owed.
    // ⚠ F11 MOVED TIERS 2026-08-10 (weekly H.10 → `CNY=X`, `FEED_OF`); its +1 override RETIRED slice-3,
    // prod measured max 1 slot so the daily tier already covers `=X` (`npm run probe:slot-lag-fx`).
    F11: { cadence: "daily" },
    // ⚠ FXH MOVED TIERS 2026-08-10 (weekly H.10 → daily closes-feed EURUSD=X/CHF=X/JPY=X); its +1 override and
    // its 3 legs' RETIRED slice-3, same max-1-slot measurement.
    FXH: { cadence: "daily" },
    CMP_FXH_DEXUSEU: { cadence: "daily" },
    CMP_FXH_DEXSZUS: { cadence: "daily" },
    CMP_FXH_DEXJPUS: { cadence: "daily" },
    G1: { cadence: "weekly", lagAfterDays: 11 },
    BRENT: { cadence: "weekly", lagAfterDays: 11 },
    EBP: { cadence: "monthly", lagAfterDays: 70 },
    HICP: { cadence: "monthly", lagAfterDays: 90 },
    // ⚠ F3 JOINED THIS TABLE 2026-08-03 — it was previously this block's "non-overridden weekly
    // control". NFCI stamps the week-ending FRIDAY and releases it the following WEDNESDAY (T+5),
    // and a row stays newest until its SUCCESSOR lands: age 5→11 in a normal week, 12 when that
    // successor slips to Thursday (22 of 157 Wednesdays, always the week after a Monday holiday —
    // `npm run probe:nfci-grid`). The weekly tier of 9 holds neither. It was the last
    // stale-by-construction feed on the board after the daily cut moved.
    F3: { cadence: "weekly", lagAfterDays: 12 },
  } as const;

  // R1's floor check: the cut a leg carries must be >= the worst age Stage 1.3 actually MEASURED for
  // it over the 90-day prod window. This is a floor only — the number's SOURCE is the publisher's
  // release calendar, never the measurement (a window-fitted cut would rate a feed that died inside
  // the window as normal).
  // `null` = EXEMPT, and the row must say why — a missing key still fails the floor test below.
  const MEASURED_MAX_AGE_90D: Record<string, number | null> = {
    // ⚠ F11 has NO measured floor: it moved to `CNY=X` on 2026-08-10, so prod holds zero days on this
    // feed and the `DEXCHUS` window measured a different publisher. Fill it once 90 days accrue.
    F11: null,
    // ⚠ FXH + its 3 CMPs likewise have NO measured floor: the feed moved 2026-08-10 (H.10 → the closes-feed
    // pairs), so prod holds zero days on it and the 9d window measured the old publisher. Fill at 90d.
    FXH: null, CMP_FXH_DEXUSEU: null, CMP_FXH_DEXSZUS: null, CMP_FXH_DEXJPUS: null,
    G1: 6, BRENT: 6, EBP: 55,
    HICP: null, // ⚠ no prod rows yet (estr-hike-side-leg S4) — fill once 90 days accrue.
    // ⚠ F3's floor is NOT from the 90-day prod window — that window is too short to be sure of
    // containing a holiday week, and the holiday week is exactly where the max lives. It is the
    // 157-Wednesday ALFRED vintage scan (`npm run probe:nfci-grid`): 11 normal, 12 when the
    // successor release slips to Thursday. Stated here rather than silently filed under the
    // sibling ids' 90d provenance.
    F3: 12,
  };

  const componentById = new Map(
    Object.values(COMPOSITE_COMPONENTS).flat().map((c) => [c.id, c.indicator] as const),
  );
  const byId = (id: string): Indicator => {
    const ind = ALL_INDICATORS.find((i) => i.id === id) ?? componentById.get(id);
    if (!ind) throw new Error(`no registry entry for ${id}`); // non-vacuity: a renamed id fails loudly
    return ind;
  };
  /** ISO date exactly `n` whole days before `TODAY` — the fixture age assessIndicatorFreshness sees. */
  const TODAY = "2026-07-26";
  const daysBefore = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  for (const [id, ruled] of Object.entries(RULED)) {
    test(`${id} carries the ruled cadence + lagAfterDays`, () => {
      const ind = byId(id);
      expect(ind.cadence).toBe(ruled.cadence);
      expect(ind.lagAfterDays).toBe(ruled.lagAfterDays);
    });
  }

  // A `null` (exempt) row has nothing to compare; a MISSING row is `undefined`, so it still
  // generates the test and reds on the `hasOwn` line.
  const FLOORED = Object.keys(RULED).filter((id) => MEASURED_MAX_AGE_90D[id] !== null);
  test("some ruled id carries a measured floor", () => {
    expect(FLOORED.length).toBeGreaterThan(0);
  });
  test.each(FLOORED)("%s: the ruled cut clears its Stage-1.3 measured maxAge (R1 floor)", (id) => {
    // non-vacuity: every ruled id owns a row here — a measured floor, or an explicit `null` exemption
    expect(Object.hasOwn(MEASURED_MAX_AGE_90D, id)).toBe(true);
    expect(lagCutFor(byId(id))).toBeGreaterThanOrEqual(MEASURED_MAX_AGE_90D[id]!);
  });

  // The behavioural pin: `lagCutFor` is the ONE resolution point every consumption site threads
  // (alert-band's verdictHoldLegs, /api/status, /lab's LAG_CUT_OF, scorers-core's stamp). An age AT the
  // cut is fresh (`lag: ageDays > maxAgeDays`), one day past it is stale. It depends only on the
  // resolved cut, so ONE override-carrying row stands for the table.
  test("F3: age at its resolved cut is fresh, one day past is stale", () => {
    const ind = byId("F3");
    const cut = lagCutFor(ind); // the ONE source — a surviving override, else the cadence tier
    const at = assessIndicatorFreshness(daysBefore(cut), TODAY, ind.cadence, ind.lagAfterDays);
    const past = assessIndicatorFreshness(daysBefore(cut + 1), TODAY, ind.cadence, ind.lagAfterDays);
    expect(at).toEqual({ lag: false, ageDays: cut, unit: "days" });
    expect(past).toEqual({ lag: true, ageDays: cut + 1, unit: "days" });
  });

  // Never compare against `LAG_THRESHOLDS`: AMBITION is CALENDAR days, LAG's daily/weekly are
  // publication SLOTS.
  test("AMBITION_THRESHOLDS tiers stay strictly ordered, in CALENDAR days", () => {
    // Within-unit, and the property the "beyond target" overview actually depends on: the tiers
    // stay strictly ordered, so each cadence has a population of its own.
    expect(AMBITION_THRESHOLDS.daily).toBeLessThan(AMBITION_THRESHOLDS.weekly);
    expect(AMBITION_THRESHOLDS.weekly).toBeLessThan(AMBITION_THRESHOLDS.monthly);
  });
});

describe("indicatorIds - union/exclude selector (Stage 3.1)", () => {
  test("unions named sets in first-seen order, deduped", () => {
    // fredLoop ∪ downside share no ids; fredLoop ∪ scored overlaps entirely — both shapes covered.
    expect([...indicatorIds(["fredLoop", "downside"])]).toEqual([...ID_SETS.fredLoop, ...ID_SETS.downside]);
    expect([...indicatorIds(["fredLoop", "scored"])]).toEqual([...ID_SETS.scored]);
  });

  test("exclude removes members while preserving order", () => {
    expect([...indicatorIds(["fredLoop"], { exclude: ["R5"] })]).toEqual([
      "F1", "F2", "F3", "R1", "R8", "R2", "R3", "R4", "F9", "F10", "F11", "T10YIE", "T5YIFR", "OVX", "F17",
    ]);
  });

  test("throws on an exclude id absent from the union - no silent no-op for retired ids", () => {
    expect(() => indicatorIds(["fredLoop"], { exclude: ["DB_SMH"] })).toThrow(/not in the union/);
    expect(() => indicatorIds(["downside"], { exclude: ["NOPE"] })).toThrow(/"NOPE"/);
  });
});

describe("official short names - the label/longLabel split", () => {
  // The uniqueness half is the load-bearing one: it forces a `VIX` / `VIX spot` decision at EDIT
  // time instead of at read time in a 03:00 push. Red-demo verified by temporarily setting the
  // BOTTOM VIX leg's label back to "VIX" (collides with R5) — this test's first assertion goes red.
  it("indicator short names are unique, push-safe, and keep their long name", () => {
    const names = ALL_INDICATORS.map((i) => i.label);
    expect(new Set(names).size).toBe(names.length); // no two legs read the same in a push
    for (const i of ALL_INDICATORS) {
      expect(i.label.length).toBeLessThanOrEqual(24); // fits a phone push line + a tile chip
      expect(i.longLabel.length).toBeGreaterThan(0); // the hover text is never empty
    }
  });
});

describe("REACHABLE_IDS ⊆ ID_SETS.all - leaf-literal superset guard (Stage 3.1)", () => {
  // threshold-config.ts is a JSON-only leaf that hand-maintains REACHABLE_IDS BY DESIGN
  // (no registry import — cycle avoidance with domain-cuts.ts). This test-side guard is the
  // only allowed coupling: every reachable id must exist in the registry universe, so a
  // retired/renamed indicator can't leave a ghost entry in the leaf literal.
  test("every REACHABLE_IDS entry is a registry id", () => {
    const all = new Set(ID_SETS.all);
    const ghosts = [...REACHABLE_IDS].filter((id) => !all.has(id));
    expect(ghosts).toEqual([]);
  });
});

/**
 * F9 velocity-only — the REPLACEMENT falsifier for its lost `drift-guard` seat
 * (ruled).
 *
 * F9's level axis was retired, and `levelCutIds()` derives the drift guard's population by
 * filtering on a registry `amberLevel`/`redLevel` — so F9 left that guard outright and no
 * velocity-only indicator is drift-monitored. These two assertions carry the property the guard
 * carried, directly, minus its level-bound population filter:
 *
 *  1. **The axis still MOVES.** `assessDrift` is axis-agnostic — it folds through the real
 *     `synthesizedCalib` → `resolveCuts` → `rawStateSeries` chain and asks only whether the
 *     resulting state takes more than one distinct value. With F9's level bounds gone, every
 *     state it can reach is reached on the VELOCITY axis alone, so `MOVES` here IS the
 *     velocity-axis-alone claim.
 *  2. **No level cut resolves.** `activeLegs` is the served leg inventory (`/api/series`,
 *     `/api/indicators`), reduced over the SAME `legBounds` that `classify` scores — so it sees
 *     BOTH halves of the kill switch: a measured level cut (`evt`/`op` off `CALIB_MAP.legs.level`)
 *     AND the registry CONVENTION fallback (`op ?? t.amberLevel`), which no `CALIB_MAP` edit can
 *     close.
 *
 * RED DEMOS — both EXECUTED 2026-08-07 against this file
 * (`npx vitest run src/registry.test.ts -t "F9 velocity-only"`); the strings below are the runner's
 * CAPTURED output, not a prediction:
 *   (i)  `SYNTH_AMBER_PCTILE`/`SYNTH_RED_PCTILE` (`src/synth-cuts.ts`) → `1.0` (the lever worked as
 *        written — `expandingPercentile` is well-behaved at p=1), pinning the resolved velocity cut
 *        at the max of the |Δ20| distribution, which the strict velocity legs can never exceed ⇒
 *        every day GREEN ⇒ `assessDrift` returns `PINNED`. Assertion 1 red:
 *          AssertionError: expected 'PINNED' to be 'MOVES' // Object.is equality
 *          ❯ src/registry.test.ts  expect(assessment.status).toBe("MOVES");
 *        (1 failed | 2 passed — the other two tests stayed green, so the demo is specific.)
 *   (ii) re-add `amberLevel: 106` to F9's `registry.ts` `thresholds` ⇒ `legBounds`' `op` leg picks
 *        up the convention fallback (`op ?? t.amberLevel`), which no `CALIB_MAP` edit can close.
 *        Assertion 2 red:
 *          AssertionError: expected [ 'op', 'vel-op', 'vel-evt' ] to deeply equal [ 'vel-op', 'vel-evt' ]
 *          ❯ src/registry.test.ts  expect(activeLegs(f9, assessment.cuts)).toEqual(["vel-op", "vel-evt"]);
 *        2 failed | 1 passed — the precondition test above reds too, by construction
 *        ("expected 106 to be undefined"), since it asserts the very field the demo re-adds.
 * Each was restored by RE-TYPING the original, never by `git checkout --`.
 */
describe("rolling-σ fetch depth (2026-08-08 Stage 1; blend depth 2026-08-10 ruling 5)", () => {
  // §Constants rules a σ window. That is only a DOCUMENTED number until the fetch can reach it:
  // the default `FRED_LOOKBACK_DAYS` (800 calendar days ≈ 550 business rows) yielded ~490 usable
  // Δ60s, so the shipped σ spanned ~2y, not 5y. `velocitySigmaFetchOpts` widens the σ ids' fetch.
  // ⚠ The bound is `velocitySigmaDepth`, NOT `window`: F11's EWMA arm is unbounded, so `window`
  // alone would size its fetch to 564 obs and print a σ 5.44% under the estimator's own value
  // (measured 2026-08-10). Both ids run the SAME assertions and DISCRIMINATE — F9 is rectangular
  // (depth = window), F11 blended (depth = 10 × half-life > window), so a revert to `window` reds
  // F11 while F9 stays green. Every expectation is DERIVED from the registry config.
  // ⚠ The depth is asserted on the plan the id's OWN feed takes (`indicatorFetchPlan`), not on
  // `velocitySigmaFetchOpts` — F11 left FRED for `CNY=X` 2026-08-10, so a FRED-only assertion would
  // be green forever on a call the code no longer makes.
  test.each(["F9", "F11"])("%s's fetch covers velocitySigmaDepth + velocityWindow trading days", (id) => {
    const ind = indById(id);
    const cfg = ind.thresholds.velocitySigma!;
    // Premise (this suite is the only place that would notice an id leaving the σ shape).
    expect(cfg, `${id} must still be a σ id`).toBeDefined();
    const need = velocitySigmaDepth(cfg) + ind.velocityWindow!;
    const plan = indicatorFetchPlan(ind, PLAN_NOW);
    // The CALENDAR days the id's fetcher is actually handed: a `since` bound on FRED, `lookbackDays`
    // on prices — where it is honoured on the DEEP arm alone, so `deep` is part of the claim.
    expect(plan.feed !== "prices" || plan.opts.deep, `${id}: lookbackDays is ignored unless deep`).toBe(true);
    let calendarDays: number;
    if (plan.feed === "prices") {
      calendarDays = plan.opts.lookbackDays!;
    } else {
      calendarDays = (PLAN_NOW.getTime() - Date.parse(`${plan.opts!.since}T00:00:00Z`)) / 86_400_000;
    }
    // 5 trading days per 7 calendar days is the floor the conversion must clear.
    expect(calendarDays).toBeGreaterThanOrEqual((need * 7) / 5);
    // …and not absurdly deep either — a runaway factor would re-inflate the fetch budget.
    expect(calendarDays).toBeLessThan((need * 7 * 1.5) / 5);
  });

  test("F9/F11/F17/OVX all fetch off the prices feed (F9 → USDU 2026-08-10; F17 minted there; OVX → ^OVX at S6)", () => {
    // Non-vacuity for the branch above: without this the `prices` arm could vanish unnoticed.
    // ⚠ All σ ids are `prices` now, so the depth test's FRED `else` arm goes unreachable.
    expect(indicatorFetchPlan(indById("F11"), PLAN_NOW).feed).toBe("prices");
    expect(indicatorFetchPlan(indById("F9"), PLAN_NOW).feed).toBe("prices");
    expect(indicatorFetchPlan(indById("F17"), PLAN_NOW).feed).toBe("prices");
    // OVX rides `^OVX` on the prices feed since S6 (2026-09-20 oil-nowcast, FEED_OF.OVX="prices").
    expect(indicatorFetchPlan(indById("OVX"), PLAN_NOW).feed).toBe("prices");
    expect(indById("OVX").series).toBe("^OVX");
    // …and R8 rides the NTFS composite feed (gsw.ts) since the 2026-08-13 Stage B swap.
    expect(indicatorFetchPlan(indById("R8"), PLAN_NOW).feed).toBe("ntfs");
  });

  test("the graft does NOT move the feed: R2/R3/R4 still route to `fred` (T2 — tag, not fetcher ref)", () => {
    // A TREASURY_HEAD_OF entry must not be read as a FEED override — the history is still FRED, and the
    // head rides `graftTreasuryHeadFor` after the FRED fetch. Non-vacuity: these are exactly the
    // grafted ids, so a regression that put them on another feed reds here.
    expect(Object.keys(TREASURY_HEAD_OF).length).toBeGreaterThan(0);
    for (const id of Object.keys(TREASURY_HEAD_OF)) {
      expect(FEED_OF[id], `${id} must have NO FEED_OF override`).toBeUndefined();
      expect(indicatorFetchPlan(indById(id), PLAN_NOW).feed, `${id} routes to fred`).toBe("fred");
    }
  });

  test("no other id moves", () => {
    // FILE-WIDE negative: every indicator OUTSIDE the σ set keeps the default bounded window, i.e.
    // the helper returns `undefined` and the call site is byte-identical to before. Non-vacuity:
    // the population must be large and must EXCLUDE the σ ids (else it proves nothing about the
    // split). ⚠ The set became TWO on 2026-08-09:
    // F11 gained a `velocitySigma` block, so the old "F9 is the only σ id" pin was falsified BY
    // DESIGN and is restated here as membership. It is deliberately a hardcoded list — joining or
    // leaving the σ seam is a ruled act that owes an edit here, not a derivation that follows the
    // registry wherever it goes.
    const sigmaIds = ["F9", "F11", "F17"];
    expect(ALL_INDICATORS.filter((i) => velocitySigmaFetchOpts(i, PLAN_NOW) !== undefined).map((i) => i.id).sort()).toEqual(
      [...sigmaIds].sort(),
    );
    const others = ALL_INDICATORS.filter((i) => !sigmaIds.includes(i.id));
    expect(others.length).toBeGreaterThan(20);
    expect(others.filter((i) => velocitySigmaFetchOpts(i, PLAN_NOW) !== undefined)).toEqual([]);
  });

  test("every postInversionCooldown carrier plans a FULL-HISTORY fetch", () => {
    // The rung's memory is unbounded (a ≥qualifyN episode + sporadic re-inversions stays armed
    // forever), so any bounded window eventually ages the episode out and the cron scores GREEN
    // while a full-history replay says AMBER — silent divergence. Derived from the knob, not an id
    // list, so a future carrier inherits the pin; membership (R1+R8 today) is the non-vacuity floor.
    const carriers = ALL_INDICATORS.filter((i) => i.postInversionCooldown !== undefined);
    expect(carriers.map((i) => i.id).sort()).toEqual(["R1", "R8"]);
    for (const ind of carriers) {
      const plan = indicatorFetchPlan(ind, PLAN_NOW);
      // prices: the deep arm with no lookback bound (one re-caps the unbounded rung); NTFS: full history by
      // construction (gsw.ts fetches the whole feds200628 file), so no window knobs; FRED: `fullHistory`.
      const want = { prices: { deep: true, lookbackDays: undefined }, ntfs: undefined, fred: { fullHistory: true } }[plan.feed];
      expect(plan.opts, `${ind.id} (${plan.feed}): a cooldown carrier must fetch full history`).toEqual(want);
    }
  });
});

/**
 * F9 + F11 velocity-only — the level axis retired on both (F9 2026-08-07; F11 2026-08-08),
 * and both then left `synthPriors` for a rolling-σ z
 * pair.
 *
 * Retiring the level pair evicted each id from the drift guard (`levelCutIds()` filters on a registry
 * `amberLevel`/`redLevel`; `DRIFT_FIXTURES.F9`/`.F11` deleted, their CSVs kept), so these tests carry
 * the guard's property directly, minus its level-bound population filter:
 *  1. The axis still MOVES — `assessDrift` is axis-agnostic, so with the level bounds gone `MOVES` IS
 *     the velocity-axis-alone claim. Its verdict is taken over `DRIFT_WINDOW_YEARS` (3y), a SUBSET of
 *     the fixture it reads in full only to build σ.
 *  2. No level cut resolves — `activeLegs` is the served leg inventory (`/api/series`), reduced over the
 *     SAME `legBounds` that `classify` scores, so it sees BOTH halves of the kill switch: a measured
 *     level cut AND the registry CONVENTION fallback (`op ?? t.amberLevel`). The precondition test is
 *     what keeps 2 from passing for the wrong reason (a level leg absent because `cuts` is empty).
 *  3. The synth seam is CLOSED — were either id to re-enter `synthPriors`, its raw-unit percentile rows
 *     would resolve and DOMINATE the σ pair (`domain-cuts.ts` hazard notes), silently comparing raw
 *     points to σ. Vacuity: the identical call on F3, the seam's last remaining member, must still
 *     emit — if F3 ever leaves too, the anchor has no successor and the test is retired, not repointed.
 *  4. The plotted span IS the scored span — `velocityWindow` is 60 TRADING days (both feeds are a
 *     business-day grid under `cadence: "daily"`), and the plotted `delta20` column, which
 *     `buildReadings` writes as `values[i] − values[i − (velocityWindow ?? VELOCITY_WINDOW)]`, resolves
 *     from that field: the quadratic ramp makes every window width disjoint, and the discriminating half
 *     needs one point to differ from the global span. The loop pins `buildReadings`' head clamp
 *     (`Math.max(0, i − w)`) on the EMITTED column only; the scored-state half lives in
 *     `src/velocity-window.test.ts` §"F1's scored velocity leg clamps the 30d lookback at the series start".
 *
 * Red demos executed 2026-08-07/08 (captured output in this file's history): re-adding a level prior
 * reds the precondition and 2; `SYNTH_*_PCTILE` → 1.0 reds 1 (`PINNED`); deleting `velocityWindow: 60`
 * reds 4.
 */
const VELOCITY_ONLY = [
  // `vel-cusum`: F9's CUSUM persistence leg (Stage 2), backed at both severities by registry constants.
  { id: "F9", retired: "2026-08-07", csv: "broad_usd.csv", legs: ["vel-z", "vel-cusum"], regimeAnchor: false },
  // `vel-z-fast`: the `fastWindow`-gated second horizon. No
  // `vel-cusum` (ruling 5: F11 declares no `cusumK`/`cusumH`). `regimeAnchor`: a vacuity anchor over the
  // wider `BACKFILL_YEARS` reduction — without it a σ leg resolving NO cut at all could satisfy 1.
  { id: "F11", retired: "2026-08-08", csv: "cny.csv", legs: ["vel-z", "vel-z-fast"], regimeAnchor: true },
];

// One lazy assessment per id, shared by the per-id describe and the regime-anchor test below.
const ASSESS = new Map(VELOCITY_ONLY.map(({ id, csv }) => [id, driftMemo(indById(id), `scripts/backtest/data/${csv}`)]));

describe.each(VELOCITY_ONLY)("$id velocity-only (level axis retired $retired)", ({ id, csv, legs }) => {
  const ind = indById(id);
  const fixture = `scripts/backtest/data/${csv}`;
  const assessment = ASSESS.get(id)!;

  test("the registry pair is VELOCITY-only - no level prior survives", () => {
    expect(ind.thresholds.amberLevel).toBeUndefined();
    expect(ind.thresholds.redLevel).toBeUndefined();
    expect(ind.thresholds.amberVelocity).toBeDefined();
    expect(ind.thresholds.redVelocity).toBeDefined();
  });

  test("state takes more than one value over the committed history - on the velocity axis alone", () => {
    // Not UNOBSERVABLE: the fixture must actually span the window, or `MOVES` could never be reported.
    expect(assessment().status).not.toBe("UNOBSERVABLE");
    expect(assessment().status).toBe("MOVES");
    expect(assessment().states.length).toBeGreaterThan(1);
  });

  test("no level cut resolves - neither measured nor the registry convention fallback", () => {
    // Level-axis legs are `op`, `evt` and `z`; NONE may appear. The σ pair routes to `vel-z`, not the
    // raw-units `vel-op` convention fallback.
    expect(activeLegs(ind, assessment().cuts)).toEqual(legs);
  });

  test("the synth seam is CLOSED - no row is synthesized on either axis", () => {
    const history = readFixture(fixture).map((o) => o.value);
    // Live-seam anchor: same call, a still-`synthPriors` id, the same fixture shape.
    expect(
      synthesizedCalib(indById("F3"), [], new Map([["F3", history]])).length,
      "the synth seam must still emit for a synthPriors id",
    ).toBeGreaterThan(0);
    expect(synthesizedCalib(ind, [], new Map([[id, history]]))).toEqual([]);
  });

  test("the plotted delta20 column resolves from velocityWindow - 60 trading days, not the global span", () => {
    expect(ind.velocityWindow).toBe(60); // the VALUE pin — everything below derives from the field
    const w = ind.velocityWindow!;
    const N = w + VELOCITY_WINDOW + 10;
    const values = Array.from({ length: N }, (_, i) => i * i);
    // Real consecutive calendar dates off a FIXED epoch (no wall clock): N > 31.
    const EPOCH_MS = Date.UTC(2020, 0, 1);
    const obs: Observation[] = values.map((v, i) => ({
      date: new Date(EPOCH_MS + i * 86_400_000).toISOString().slice(0, 10),
      value: v,
    }));
    const readings = indicatorReadingSeries(ind, obs);
    expect(readings.length).toBeGreaterThan(0); // vacuity anchor: the fixture must reach scored days
    for (const r of readings) {
      const i = values.indexOf(r.level);
      expect(r.delta20).toBe(values[i]! - values[Math.max(0, i - w)]!);
    }
    // DISCRIMINATING half: a silently-dropped `velocityWindow` cannot pass by coincidence.
    const differs = readings.some((r) => {
      const i = values.indexOf(r.level);
      return r.delta20 !== values[i]! - values[Math.max(0, i - VELOCITY_WINDOW)]!;
    });
    expect(differs).toBe(true);
  });
});

describe("velocity-only regime anchors", () => {
  const anchors = VELOCITY_ONLY.filter((r) => r.regimeAnchor);
  test("at least one velocity-only id carries the regime anchor", () => {
    expect(anchors.length).toBeGreaterThan(0);
  });
  test.each(anchors)("$id: state takes more than one value over the wider BACKFILL_YEARS reduction", ({ id }) => {
    expect(ASSESS.get(id)!().regimeStates.length).toBeGreaterThan(1);
  });
});

/**
 * Stage 2's REPLACEMENT FALSIFIER (ruled 2026-08-07 [USER]), per id — the chart routes differ. The
 * originally-named free falsifier, `chart-rail.ts`'s `dualAxis window … contradicts the scored velocity
 * window` throw, is UNREACHABLE for both: neither declares a `dualAxis`, so both take
 * `genericThresholdChart`'s single-axis `hasVelocity` branch. Re-arming the throw by adding one is ruled
 * OUT (it would redraw level bands with no cut behind them). The scored-span half is the
 * `velocityWindow` test above.
 */
describe("F9/F11 velocity-only chart route (the generic `hasVelocity` branch)", () => {
  test("F9: one primary axis plotting delta20 against per-day σ bands", () => {
    // The SECONDARY axis (added 2026-08-09) carries the CUSUM accumulator, a different quantity on its
    // own scale, pinned by its own suite. This owns the PRIMARY axis: still the sole home of the scored
    // Δ60 column, so the filters below stay exact.
    const spec = buildFamilyChart(indById("F9"), undefined);
    expect(spec.axes.filter((a) => a.id === "primary")).toHaveLength(1);
    expect(spec.series.filter((s) => s.axis === "primary").map((s) => s.fromPoint)).toEqual(["delta20"]);
    // The velocity pair rides the per-DAY moving transport since Stage 3
    // (the cuts are σ multiples, so the drawn line is
    // `multiple × σ(t)` in raw Δ60 units) — `metric: "velocity"` is the SCALAR shape, which is
    // exactly what a σ id must NOT emit. Still the `hasVelocity` branch: two primary bands over
    // the plotted `delta20`, not `dualAxis`.
    expect(
      Array.isArray(spec.bands)
        ? spec.bands.filter((b) => (b.axis ?? "primary") === "primary").map((b) => [b.source, b.axis, b.metric])
        : spec.bands,
    ).toEqual([
      ["perPoint", "primary", undefined],
      ["perPoint", "primary", undefined],
    ]);
  });

  test("F11: ONE axis, no window stamp, no cusum series, σ bands captioned off the registry pair", () => {
    const f11 = indById("F11");
    // The chart route: single primary axis plotting the persisted delta20 column against the
    // VELOCITY pair (the `hasVelocity` branch). ONE axis, and that is the load-bearing claim — F11's
    // window-only `CHART_PARAMS_OF` row must not divert it to the dual-axis route, and its
    // `velocitySigma` block must not open the S⁺ secondary axis (ruling 5: no `cusumK`/`cusumH`, and
    // `genericThresholdChart` gates that axis on the RESOLVED knob triple, not on `velocitySigma`).
    const spec = buildFamilyChart(f11, undefined);
    expect(spec.axes.map((a) => a.id)).toEqual(["primary"]);
    // F11's WINDOW-ONLY row was deleted 2026-08-30 — the shared span (`DETAIL_WINDOW_CONFIG`) is
    // deeper than the 500 it carried, so the spec stamps nothing and the client falls back to it.
    // The 2026-08-09 ruling this replaces is preserved as the property that mattered: the span F11
    // is actually drawn at must stay ABOVE 365, where its σ pair was measured off-frame.
    expect(CHART_PARAMS_OF.F11).toBeUndefined();
    expect(spec.window).toBeUndefined();
    expect(DETAIL_WINDOW).toBeGreaterThan(365); // the ruled visibility floor — 365d was measured too tight
    // ⛔ No `cusum` series reaches the wire for F11.
    expect(spec.series.some((s) => s.fromPoint === "cusum")).toBe(false);
    // The CAPTION half: the axis label must resolve the span from the field, in the TRADING-day units
    // `cadence: "daily"` names. Derived, never a literal.
    expect(spec.axes[0]!.label).toBe(`Δ${f11.velocityWindow}d`);
    expect(spec.series.map((s) => s.fromPoint)).toEqual(["delta20"]);
    // The σ pair rides the `perPoint` transport (a different raw cut every day), NOT the static
    // `threshold` pair — so these bands carry `fromPoint`/`label` and NO `metric` key. Labels
    // compose off the registry pair, so a retune moves the caption with the line.
    expect(spec.bands).toEqual([
      {
        level: "amber",
        axis: "primary",
        source: "perPoint",
        fromPoint: "velSigmaAmber",
        label: `amber ${+f11.thresholds.amberVelocity!.toFixed(2)}σ`,
      },
      {
        level: "red",
        axis: "primary",
        source: "perPoint",
        fromPoint: "velSigmaRed",
        label: `red ${+f11.thresholds.redVelocity!.toFixed(2)}σ`,
      },
    ]);
  });
});

// PER-SOURCE FRESHNESS CALENDAR — the sibling of the E7 per-source CUTS above. That block sets how
// many days late is too late; this one sets what a "day" is measured against. Both resolve at one
// seam (`lagCutFor` / `todayOnFeedCalendar`), and getting the calendar wrong silently spends the
// whole margin the cuts were derived with.
//
// `now` is PINNED to the instant that exposed the bug — a wall-clock fixture here would pass or
// fail on the hour of day, which is precisely the variable under test.
describe("per-source publication calendar (todayOnFeedCalendar)", () => {
  // 2026-08-04 04:27 UTC: UTC and Eastern have rolled to Aug 4, Central has not.
  const INCIDENT = new Date("2026-08-04T04:27:00Z");
  const UTC_TODAY = INCIDENT.toISOString().slice(0, 10);
  const F1 = indById("F1");
  // The inverse of `assessFreshness`'s own age arithmetic (date-only strings parse as UTC midnight),
  // so a fixture can be placed EXACTLY on a cut instead of hand-typing the date the cut implies.
  const daysBefore = (day: string, n: number): string =>
    new Date(Date.parse(day) - n * 86_400_000).toISOString().slice(0, 10);

  test("the default calendar is US Central, and Eastern would NOT have been enough", () => {
    expect(todayOnFeedCalendar(undefined, INCIDENT)).toBe("2026-08-03");
    // The discriminating half: without it, a helper hardwired to Eastern reproduces the bug (Eastern
    // has already rolled over at this instant) while still satisfying the line above's intent.
    expect(todayOnFeedCalendar("America/New_York", INCIDENT)).toBe("2026-08-04");
  });

  test("feedCalendarTodayResolver: one pinned instant, per-zone dates, memo returns the SAME date on re-ask", () => {
    // The cron hour (22:00 UTC) is where the run path's old UTC stamp diverged from /api/status:
    // Central is still on the UTC date, Berlin has rolled to the next one.
    const CRON = new Date("2026-09-12T22:30:00Z");
    const todayOn = feedCalendarTodayResolver(CRON);
    expect(todayOn(undefined)).toBe(todayOnFeedCalendar(undefined, CRON));
    expect(todayOn(undefined)).toBe("2026-09-12");
    expect(todayOn("Europe/Berlin")).toBe("2026-09-13");
    // The discriminating half: a resolver that dropped the zone (memo keyed on nothing) returns the
    // first-asked date for every feed — the exact shape of the pre-fix defect.
    expect(todayOn("Europe/Berlin")).not.toBe(todayOn(undefined));
    expect(todayOn("Europe/Berlin")).toBe("2026-09-13");
  });

  test("F1 exactly at ITS registered cut reads FRESH on its own calendar and STALE on the UTC one", () => {
    // SETUP derived from the cut, never hand-typed: place F1's newest observation exactly `cut` days
    // before the Central date, the regime where one phantom day is the whole difference. (At the
    // incident's cut of 4 this resolved to 2026-07-30 — a healthy T+1 feed one release behind.)
    const cut = lagCutFor(F1);
    const centralToday = todayOnFeedCalendar(F1.feedTimeZone, INCIDENT);
    const asOf = daysBefore(centralToday, cut);
    const onFeedCalendar = assessIndicatorFreshness(asOf, centralToday, F1.cadence, F1.lagAfterDays);
    expect(onFeedCalendar).toEqual({ lag: false, ageDays: cut, unit: "days" });
    // The regime the fix exists for: same instant, same observation, UTC clock ⇒ a phantom day.
    const onUtc = assessIndicatorFreshness(asOf, UTC_TODAY, F1.cadence, F1.lagAfterDays);
    expect(onUtc).toEqual({ lag: true, ageDays: cut + 1, unit: "days" });
  });

  // The population BOTH tests below walk is the one the live resolvers walk: `feedTimeZoneIndex()`
  // (feed-lag.ts) = the served registry PLUS `COMPOSITE_COMPONENTS`, which is what `/api/lab`
  // resolves "today" over (`FEED_TZ_OF`). Filtering `ALL_INDICATORS` alone would leave every
  // `CMP_*` id — a sixth of the resolved population — outside both pins.
  const ZONE_OF = feedTimeZoneIndex();
  const SERVED_IDS = new Set(ALL_INDICATORS.map((i) => i.id));

  test("the SERVED override population is exactly the EUROPEAN-published feeds", () => {
    // The euro-area ids are published in Frankfurt — e.g. EURC (ECB SDMX, ecb.ts)
    // and BUND (the German Bund close) — and BONOS in Madrid. Everything else rides the US-Central default,
    // including the price feeds: those arrive through a US aggregator (prices.ts) even
    // where the listing is European (XDEV.DE), and Central is the LENIENT choice there
    // (`FEED_CALENDAR_TZ`). A NEW entry here owes its own publisher rationale on the registry row.
    // Scope: the SERVED rows only — the composite components are the sibling test below, because
    // they carry no rationale of their own (they inherit their parent's).
    const overridden = [...ZONE_OF].filter(([id, tz]) => tz !== undefined && SERVED_IDS.has(id));
    expect(overridden.map(([id]) => id).sort()).toEqual(["BONOS", "BUND", "ECISS", "EPATH", "ESTR", "EURC", "EURGBP"]);
    expect([...new Set(overridden.map(([, tz]) => tz))].sort()).toEqual(["Europe/Berlin", "Europe/Madrid"]);
    // …and the override BITES: Berlin has rolled to the next date at an instant Central has not.
    expect(todayOnFeedCalendar("Europe/Berlin", INCIDENT)).toBe("2026-08-04");
    expect(todayOnFeedCalendar(undefined, INCIDENT)).toBe("2026-08-03");
  });

  test("a composite's components resolve on their PARENT's calendar, and no other component does", () => {
    // One publisher, one calendar, inside one surface: `componentBackfillSeries` maps the very closes the
    // parent was computed from, so a component judged on a different calendar than its parent makes
    // /lab self-inconsistent — on a frozen ECB feed in the CEST evening window the parent would read
    // a day older than its own component. Both sides derived (registry table × resolver index), so
    // dropping the inheritance in `componentIndicator` empties the left side and reds here.
    const overriddenComponents = [...ZONE_OF]
      .filter(([id, tz]) => tz !== undefined && !SERVED_IDS.has(id))
      .map(([id, tz]) => `${id}: ${tz}`)
      .sort();
    // Parent zone off the registry rows, chart-only included: an unserved parent's components are walked too.
    const PARENT_TZ = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i.feedTimeZone]));
    const expected = Object.entries(COMPOSITE_COMPONENTS)
      .filter(([composite]) => PARENT_TZ.get(composite) !== undefined)
      .flatMap(([composite, comps]) => comps.map((c) => `${c.id}: ${PARENT_TZ.get(composite)!}`))
      .sort();
    expect(overriddenComponents).toEqual(expected);
    // Vacuity anchor — both sides are derived, so an equality of two empty lists would pass with the
    // inheritance gone. Anchored on a named stable member (EURC's ECB 10y tenor), never a roster count.
    expect(overriddenComponents).toContain("CMP_EURC_SR10Y: Europe/Berlin");
  });

  test("every registered zone is one the runtime's Intl knows", () => {
    // `feedTimeZone` is a free-form `string` that flows into `toLocaleDateString`, which THROWS
    // RangeError on an unknown zone — and /api/status's GET has no try/catch (nor does /api/lab,
    // which resolves the WIDER population), so a typo'd zone 500s the whole endpoint in prod. This
    // is the only thing standing between a typo and that outage.
    // Non-vacuous by the two enumerations above: the override population is pinned non-empty on
    // both halves of this walk.
    const known = new Set(Intl.supportedValuesOf("timeZone"));
    const unknown = [...ZONE_OF]
      .filter(([, tz]) => tz !== undefined && !known.has(tz))
      .map(([id, tz]) => `${id}: ${tz}`);
    expect(unknown).toEqual([]);
    // The default every un-overridden id resolves through rides the same throwing call.
    expect(known.has(FEED_CALENDAR_TZ)).toBe(true);
  });
});

/**
 * R8's OWED REPLACEMENT for the drift guard (2026-08-09, a retired plan).
 *
 * `levelCutIds()` excludes smoothed-level ids because `assessDrift` scores the level pair against the
 * DAILY close while R8's live scorer scores a trailing MEAN — so an assessment there would grade a
 * path the phone never runs. The property the guard would have asserted (the state series is not
 * pinned flat over the committed history) is asserted here instead, through R8's OWN scorer, over the
 * same committed fixture `DRIFT_FIXTURES.R1` reads.
 */
describe("R8 - term spread on a 21-obs mean (excluded from the drift guard by construction)", () => {
  const r8 = indById("R8");
  const window = SMOOTHED_LEVEL_OF.R8!.window;

  test("it IS a smoothed-level id and IS out of the guard's population", () => {
    // Vacuity guard: without this the drift assertion below could pass while R8 was silently still
    // being graded on daily closes.
    expect(SMOOTHED_LEVEL_OF[r8.id]).toBeDefined();
    expect(levelCutIds()).not.toContain("R8");
    // …R1 joined the smoothed set 2026-08-31 (its own pins: the describe below); the exclusion stays
    // NARROW — a fixed-pair id on the same channel is still watched.
    expect(levelCutIds()).not.toContain("R1");
    expect(levelCutIds()).toContain("F2");
  });

  test("NO registry level pair - the level legs are the mean-space rung's armed pair alone", () => {
    // A reintroduced pair would score through `fixedLevelState` beside the rung — two level sources.
    expect(r8.thresholds.amberLevel).toBeUndefined();
    expect(r8.thresholds.redLevel).toBeUndefined();
    expect(r8.direction).toBe("LOW");
  });

  test("the rung's clamp bounds are ORDERED - red ≤ amber structurally, whatever the pool ranks", () => {
    // The clamp is monotone, so red's pctile ≤ amber's survives clamping iff BOTH of red's bounds
    // sit at or below amber's. (Supersedes the disjointness pin: the NTFS-vintage clamps overlap.)
    const lc = r8.postInversionCooldown!.levelCuts!;
    expect(lc.amber.clamp[0]).toBeGreaterThanOrEqual(lc.red.clamp[0]);
    expect(lc.amber.clamp[1]).toBeGreaterThanOrEqual(lc.red.clamp[1]);
    expect(lc.red.pctile).toBeLessThan(lc.amber.pctile);
  });

  test("R8's short leg EQUALS R1's - run-cycle fetches ONE short leg off the R1 object for BOTH carriers", () => {
    expect(r8.postInversionCooldown!.shortLegSeries).toBe(T10Y3M_POST_INVERSION.shortLegSeries);
  });

  test("state takes more than one value over the committed history - through R8's OWN scorer", () => {
    const obs = T10Y3M_OBS;
    const readings = smoothedLevelReadingSeries(r8, obs, window);
    expect(readings.length).toBeGreaterThan(obs.length - window - 1);
    expect(new Set(readings.map((r) => r.rawState)).size).toBeGreaterThan(1);
  });

  test("the emitted level IS the mean, not the close - the card, the cut line and the ribbon agree", () => {
    const obs = T10Y3M_OBS.slice(0, window + 3);
    const readings = smoothedLevelReadingSeries(r8, obs, window);
    const expectedFirst =
      obs.slice(0, window).reduce((s, o) => s + o.value, 0) / window;
    expect(readings[0]!.level).toBeCloseTo(expectedFirst, 10);
    expect(readings[0]!.date).toBe(obs[window - 1]!.date);
    // A mean is not a close: with real data the two differ, so this cannot pass by coincidence.
    expect(readings[0]!.level).not.toBe(obs[window - 1]!.value);
  });

  test("a non-positive window throws rather than emitting an empty series", () => {
    const obs = T10Y3M_OBS.slice(0, 40);
    expect(() => smoothedLevelReadingSeries(r8, obs, 0)).toThrow(/positive integer/);
    expect(() => smoothedLevelReadingSeries(r8, obs, 1.5)).toThrow(/positive integer/);
  });
});

describe("R1 mean-space rung - the user-pinned dates, re-pinned on the 21-obs mean (2026-08-31)", () => {
  const r1 = indById("R1");
  const sw = SMOOTHED_LEVEL_OF.R1!;

  test("full-history replay holds the chart-pinned dates through R1's OWN scorer; still armed at the fixture end", () => {
    expect(sw.redWindow).toBeDefined(); // premise: R1 is the two-window carrier
    const obs = T10Y3M_OBS;
    const byDate = new Map(smoothedLevelReadingSeries(r1, obs, sw.window, undefined, sw.redWindow).map((r) => [r.date, r.state]));
    // 2026-03/04 AMBER come from the armed rung over the MEAN (m21 0.41/0.61 under the cut) — the
    // early-warning half of the `[USER]` goal; the 05–08 pins are the mean-space re-pin of the 08-12 set.
    expect(byDate.get("2026-03-16")).toBe("AMBER");
    expect(byDate.get("2026-04-15")).toBe("AMBER");
    expect(byDate.get("2026-05-15")).toBe("GREEN");
    expect(byDate.get("2026-07-31")).toBe("GREEN");
    expect(byDate.get("2026-08-05")).toBe("GREEN");
    expect(byDate.get("2026-06-29")).toBe("AMBER");
    // Level release only: armed since the 2022 inversion — the retired 252-obs clock would have
    // released years before the fixture end. The emitted value is the expanding percentile (its own
    // describe below), so pin armed-ness + the clamp bounds here, not a terminal value.
    const cfg = r1.postInversionCooldown!;
    const v = obs.map((o) => o.value);
    const means = v.slice(sw.window - 1).map((_, k) => v.slice(k, k + sw.window).reduce((a, b) => a + b, 0) / sw.window);
    const cuts = postInversionCutSeries(means, cfg, obs.slice(sw.window - 1).map((o) => o.date));
    const last = cuts.at(-1);
    expect(last).not.toBeNull();
    expect(last!).toBeGreaterThanOrEqual(cfg.cutClamp![0]);
    expect(last!).toBeLessThanOrEqual(cfg.cutClamp![1]);
  });
});

describe("R1 armed cut - expanding percentile (ruled 2026-08-12)", () => {
  const r1 = indById("R1");
  const PI = r1.postInversionCooldown!;
  const DAY = 86_400_000;
  const dateAt = (startMs: number, i: number) => new Date(startMs + i * DAY).toISOString().slice(0, 10);
  const anchorMs = Date.parse(PI.cutAnchorDate);
  // Expectation oracle, derived from the cfg knobs alone — no knob value restated in this file.
  const pctileOf = (pool: number[]) => {
    const v = [...pool].sort((a, b) => a - b)[Math.floor(PI.cutPctile! * (pool.length - 1))]!;
    return Math.min(PI.cutClamp![1], Math.max(PI.cutClamp![0], v));
  };
  // Post-anchor fixture: a qualifying inversion, then a two-value distribution that never releases
  // (both under floorLevel) and grows the pool past the warm-up.
  const lowVal = PI.cutClamp![0] + 0.05;
  const highVal = PI.floorLevel - 0.1;
  const post = [
    ...Array<number>(PI.qualifyN).fill(-1),
    ...Array.from({ length: PI.cutWarmupObs }, (_, i) => (i % 2 === 0 ? lowVal : highVal)),
  ];
  const postDates = post.map((_, i) => dateAt(anchorMs, i));

  test("warm-up holds floorLevel; past warm-up the armed cut IS the clamped expanding percentile", () => {
    const cuts = postInversionCutSeries(post, PI, postDates);
    // Armed at the qualifying run's end with the pool still under warm-up ⇒ floorLevel.
    expect(cuts[PI.qualifyN - 1]).toBe(PI.floorLevel);
    // At the end the pool is the whole fixture; the fixture discriminates percentile from the hold.
    expect(cuts.at(-1)).toBe(pctileOf(post));
    expect(cuts.at(-1)).not.toBe(PI.floorLevel);
  });

  test("obs dated before cutAnchorDate never enter the pool", () => {
    const preN = 1000;
    const preVal = PI.cutClamp![0] - 0.4; // would drag the percentile onto the low clamp if pooled
    const pre = Array<number>(preN).fill(preVal);
    const preDates = pre.map((_, i) => dateAt(anchorMs - preN * DAY, i));
    // Vacuity: counting the pre-anchor obs WOULD move the cut.
    expect(pctileOf([...pre, ...post])).not.toBe(pctileOf(post));
    const cuts = postInversionCutSeries([...pre, ...post], PI, [...preDates, ...postDates]);
    expect(cuts.at(-1)).toBe(pctileOf(post));
  });

  test("an obs dated EXACTLY cutAnchorDate enters the pool (the >= boundary)", () => {
    // The anchor-day obs is the pool MAXIMUM (still under floorLevel), so dropping it shifts the
    // percentile index without a cancelling rank shift — a `>` gate reds the terminal assertion.
    const span = PI.floorLevel - PI.cutClamp![0];
    const anchorVal = PI.cutClamp![0] + span * 0.95;
    const rest = Array.from(
      { length: PI.cutWarmupObs },
      (_, i) => PI.cutClamp![0] + span * (0.05 + (0.85 * i) / (PI.cutWarmupObs - 1)),
    );
    const values = [anchorVal, ...Array<number>(PI.qualifyN).fill(-1), ...rest];
    const dts = values.map((_, i) => dateAt(anchorMs, i)); // i=0 IS cfg.cutAnchorDate
    expect(dts[0]).toBe(PI.cutAnchorDate);
    // Vacuity: excluding the anchor-day obs MOVES the clamped percentile.
    expect(pctileOf(values)).not.toBe(pctileOf(values.slice(1)));
    const cuts = postInversionCutSeries(values, PI, dts);
    expect(cuts.at(-1)).toBe(pctileOf(values));
  });
});

/** RS chart-band ↔ scorer-cut parity (2026-09-24): every id `rsCuts` routes (the RS_SMH default + each
 *  `RS_CUT_OVERRIDES` row) draws its `derived.amber/red` bands off the SAME row the scorer reads —
 *  KBE_RS (and a since-retired EU-Fin RS row) drew the generic 0/−3% pair while scoring at hand-set cuts before this lint. */
describe("registry - RS derived chart bands equal the scorer's rsCuts row (one touch point)", () => {
  const routed = ["RS_SMH", ...Object.keys(RS_CUT_OVERRIDES)];

  it("routes the hand-set EU-Fin ids (else the parity sweep below is over the wrong set)", () => {
    expect(routed).toEqual(expect.arrayContaining(["KBE_RS", "AT1", "F6"]));
  });

  it("AT1 (btp-bund S4): rsCuts returns AT1's OWN row — not the RS default, not a KBE_RS alias", () => {
    const at1 = rsCuts("AT1");
    expect(at1).toEqual(AT1_DESCRIPTOR.scorer.constants); // routed off the descriptor (rsCuts hands back a copy)
    expect(at1).not.toEqual(RS_SMH_DESCRIPTOR.scorer.constants); // hand-set ≠ the generic RS default
    expect(at1.maWindow).toBe(rsCuts("KBE_RS").maWindow); // KBE_RS shape (MA50)
  });

  it.each(routed)("%s: derived.amber/red === rsCuts(id).amber/red", (id) => {
    const ind = indById(id);
    expect(ind.derived, `${id}: an rsCuts-routed id must carry a derived block`).toBeDefined();
    const cuts = rsCuts(id);
    expect(ind.derived!.amber).toBe(cuts.amber);
    expect(ind.derived!.red).toBe(cuts.red);
  });
});

describe("LEGP_EUFIN picker label", () => {
  it("is the EU-Fin sleeve's display label, so the picker and the board name the held fund alike", () => {
    expect(indById("LEGP_EUFIN").label).toBe(sleeveLabel("EU-Fin"));
  });
});

describe("HY OAS estimators", () => {
  it("F1 and CCC carry no estimator — their rows stay on FRED prints", () => {
    expect(["F1", "CCC"].map((id) => indById(id).estimator)).toEqual([undefined, undefined]);
  });
});
