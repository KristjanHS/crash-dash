import { describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import type { AlertRecord } from "./store.js";
import type { Reading } from "./domain-types.js";
import { LADDER, rungOfSleeve, sleeveLabel } from "./families.js";
import { assembleRun, latestReadingDate } from "./run-core.js";
import { readPriorContext } from "./run-cycle.js";
import { DE_ESCALATION_DAYS } from "./alert-band.js";
import { mkGeoReading } from "./alert-band.test-helpers.js";
import type { T1DialResult } from "./t1dial.js";
import { RERISK_BASIS_EPOCH } from "./danger-engine.js";
import { RERISK_CONFIRM, RERISK_DWELL_DAYS } from "./danger-ladder.js";
import { makeDial } from "./test-helpers.js";
import { gf } from "./danger-engine.test-helpers.js";
import { fromRunInputs, toRunInputs, type AssembleRunOpts } from "./run-inputs.js";
import { PROVISIONAL_IDS } from "./provisional.js";
import { installRunTestHooks, priorAlert } from "./run.test-helpers.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// Append-only writes + read-layer collapse (every run persists its own alert_log row; reads
// collapse to the max fired_at per UTC fired-date — delete gone since migration 20260717010000).
// The persistence half is pinned in store.run-history.test.ts; these pin the run-cycle.ts SPLIT it forces:
// scoring prev-state = the latest PRIOR fired-day row (getLastAlertBefore/getLastBandBefore),
// notify baseline = the ABSOLUTE latest row (getLastAlert). Pure seams; the intraday cycles live in run.wiring.intraday.
describe("same-day re-run (scoring prev-day vs notify absolute-latest)", () => {
  test("readPriorContext: a same-day re-run scores off the PRIOR fired-day (idempotent) and notifies off the absolute latest", async () => {
    // The prior FIRED-DAY row, placed in the regime where a double-tick is OBSERVABLE:
    //  - date 2026-01-29 < asOf (2026-01-30) ⇒ newClose ⇒ the dwell counter ticks;
    //  - holding the most-defensive leg while the calm dial wants an aggressive one ⇒ run 1 ROTATES
    //    off Staples on this single close (2026-08-07 symmetry ruling: no streak, no dwell);
    //  - a CRITICAL raw dial band ⇒ the N=2 de-escalation lag holds today's calm OK dial up.
    // A same-day re-run that read today's about-to-be-replaced row instead would read its own raw
    // OK band as the lag window and drop `level` to OK — the level/bandReason pair is what discriminates.
    const calm = { ...makeDial({ targetRung: 2 }), band: { lo: 1, hi: 3, label: "aggressive" } };
    const globalFamilies = gf([{ id: "VT", state: "AMBER" }]).globalFamilies;
    const assembleAt = async (s: InMemoryStore, now: string, dial: T1DialResult) => {
      const prior = await readPriorContext(s, now.slice(0, 10));
      const { alert, notification } = assembleRun({ readings: [], now, dial, globalFamilies, ...prior });
      return { prior, alert, notification };
    };
    await store.recordAlert(
      priorAlert({
        date: "2026-01-29",
        firedAt: "2026-01-29T21:00:00.000Z",
        pushedAt: "2026-01-29T21:00:00.000Z", // a recent push ⇒ the weekly reassert isn't due
        level: "CRITICAL",
        dialBand: "CRITICAL",
        heldSleeve: "Staples",
        heldDays: 1,
        reriskConfirmCount: 0,
      }),
    );

    const { alert: first } = await assembleAt(store, "2026-01-30T09:00:00.000Z", calm);
    await store.recordAlert(first);
    const { prior, alert: second } = await assembleAt(store, "2026-01-30T21:00:00.000Z", calm);

    // The split itself: scoring reads the prior fired-day, notify reads run 1's row.
    expect(prior.prevDay?.firedAt).toBe("2026-01-29T21:00:00.000Z");
    expect(prior.recentDialBands).toEqual(["CRITICAL"]);
    expect(prior.last?.firedAt).toBe(first.firedAt);
    // Vacuity: the lag really is holding the band above the raw dial, and the re-risk committed on close 1.
    expect([first.heldSleeve, first.heldDays, first.dialBand, first.level, first.bandReason]).toEqual(["EM", 0, "OK", "CRITICAL", "lag-hold"]);
    // The invariant: run 2 derives from the PRIOR DAY, not from run 1 — no double tick anywhere.
    const pick = (a: AlertRecord) => [a.heldDays, a.reriskConfirmCount, a.r4Phase, a.heldSleeve, a.dialBand, a.level, a.bandReason];
    expect(pick(second)).toEqual(pick(first));
    expect(second.dialState).not.toBeNull();

    // Notify baseline after a silent intraday run (which writes no alert row): the EOD run pushes off an
    // empty `last`; a same-day re-run reads that EOD row (prevDay stays null) ⇒ same band ⇒ silent.
    const day = new InMemoryStore();
    const crisis = makeDial({ targetRung: 9 }, { creditFiring: true });
    const eod = await assembleAt(day, "2026-01-30T22:00:00.000Z", crisis);
    expect([eod.alert.level, eod.notification.push]).toEqual(["CRITICAL", true]);
    await day.recordAlert({ ...eod.alert, pushedAt: eod.alert.firedAt });
    const rerun = await assembleAt(day, "2026-01-30T23:00:00.000Z", crisis);
    expect([rerun.prior.prevDay, rerun.prior.last?.firedAt]).toEqual([null, eod.alert.firedAt]);
    expect([rerun.alert.level, rerun.notification.push]).toEqual(["CRITICAL", false]);
  });

  test("steady dial ⇒ the hold stays put: the deadband's direction reads the prior DIAL target, not the held rung", () => {
    // Prod 2026-09-02..05 ping-ponged Semis → S&P IT → Semis → Value with the dial parked at rung 2:
    // `rising` compared today's dial target (a dial output) against yesterday's HELD rung (a pick
    // output). A re-risk pick landing above the target (rung 1) made the next close read 2 > 1 as
    // "rising" ⇒ zero deadband ⇒ strict argmin onto a calmer rung ⇒ the close after read "falling"
    // ⇒ re-risk back. The fix reads `prevDay.dialTargetRung`.
    //
    // Field: VT AMBER in band 1–3 — EM the strict argmin, Semis a sub-deadband gap above it (width
    // pinned by "FALLING - Health→Staples gap ≥ reriskDeadbandOf…", danger-engine.deadband-momentum.test.ts).
    // Dial: target rung 2 inside that band (`makeDial` derives its band from the split inputs, so it is spread over explicitly).
    const dial = { ...makeDial({ targetRung: 2 }), band: { lo: 1, hi: 3, label: "aggressive" } };
    const base = {
      readings: [] as Reading[],
      last: null,
      lastPush: null,
      dial,
      globalFamilies: gf([{ id: "VT", state: "AMBER" }]).globalFamilies,
    };
    const day = (d: string): AlertRecord =>
      ({ date: d, heldSleeve: "Semis", dialTargetRung: dial.targetRung, reriskConfirmCount: 0, heldDays: 3 }) as unknown as AlertRecord;

    // Cold ⇒ RISING ⇒ strict argmin. Establishes that the two branches really diverge on this field.
    const { alert: cold } = assembleRun({ ...base, now: "2026-01-29T22:00:00.000Z", prevDay: null });
    expect(cold.heldSleeve).toBe("EM");
    expect(rungOfSleeve("Semis")!).toBeLessThan(dial.targetRung); // the shape the old rule misread as rising

    // Prior day: holding Semis with the dial ALREADY at rung 2 ⇒ the dial did not move ⇒ FALLING/STABLE
    // ⇒ the re-risk window keeps Semis. The old rule read held-rung 1 < target 2 as RISING and flipped
    // to EM — the prod ping-pong's second beat.
    const { alert: steady } = assembleRun({ ...base, now: "2026-01-30T22:00:00.000Z", prevDay: day("2026-01-29") });
    expect(steady.dialTargetRung).toBe(dial.targetRung);
    expect(steady.heldSleeve).toBe("Semis");
  });

  test("no duplicate push: a hold change pushes off `last`, never `prevDay` - a same-day re-run at the same hold stays silent", () => {
    // The steady-dial field above: a cold pick (`prevDay: null`) lands on EM. Only `last.heldSleeve` moves between the arms.
    const dial = { ...makeDial({ targetRung: 2 }), band: { lo: 1, hi: 3, label: "aggressive" } };
    const base = { readings: [] as Reading[], prevDay: null, dial, globalFamilies: gf([{ id: "VT", state: "AMBER" }]).globalFamilies, now: "2026-01-30T22:00:00.000Z" };
    const { alert: cold } = assembleRun({ ...base, last: null, lastPush: null });
    const notify = (heldSleeve: string) => {
      const last = priorAlert({ date: "2026-01-30", firedAt: "2026-01-30T09:00:00.000Z", pushedAt: "2026-01-30T09:00:00.000Z", level: cold.level, heldSleeve });
      return assembleRun({ ...base, last, lastPush: last }).notification;
    };
    expect([notify("Semis").push, notify("Semis").message.title]).toEqual([true, `crash-dash - hold changed ${sleeveLabel("Semis")} -> ${sleeveLabel("EM")}`]);
    expect(notify(cold.heldSleeve!).push).toBe(false);
  });
});

// ─── W6 Addendum E-2: the re-risk streak BASIS EPOCH ────────────────────────────────────────────
// `RERISK_DEADBAND` derives from `DANGER_CUTS.amber`: remapped 0.129 → 0.2412 (Stage 6.8) and then
// HALVED to `DANGER_CUTS.amber / 2` on 2026-08-07 — the move
// that motivated the epoch bump the test below pins. Either way a
// `rerisk_confirm_count` persisted before an epoch was earned against a DIFFERENT bar. run-core
// reads such a streak as 0 (`prevConfirmLagging`), forcing the in-flight re-risk to reconfirm.
//
// THE PAIR IS THE POINT: one prior row carrying the SAME non-zero streak, dated one day BEFORE the
// epoch vs dated exactly ON it, must decide DIFFERENTLY. A single-arm fixture would pass against a
// build that never zeroes anything (or one that zeroes everything).
//
// Seam choice: `assembleRun` takes an explicit `now` and an explicit `prevDay`, and with
// `readings: []` its `asOf` is `now.slice(0, 10)` — so both dates are free. (The `runScoringCycle`
// fixtures above are pinned at asOf 2026-01-30; a post-epoch prior would sit in their FUTURE and
// silently flip `newClose`.) `globalFamilies: []` = an all-calm danger field, so the wide low band
// {lo:1,hi:3} makes the candidate the in-band leg of MINIMUM risk rank (LADDER[0]) — a re-risk off
// a defensive prior, which is exactly the move the streak gates. The 3-leg band (not a point band)
// is deliberate: it keeps that min-risk SELECTION in the fixture rather than handing the gate a
// single admissible leg.
describe("assembleRun - re-risk streak basis epoch (W6 Addendum E-2)", () => {
  // Fixture dates are DERIVED from the constant so a bump can't rot them.
  const dayOffset = (isoDate: string, days: number): string =>
    new Date(Date.parse(isoDate) + days * 86_400_000).toISOString().slice(0, 10);

  const AGGRESSIVE = LADDER[0]!;              // rung 1 — the calm band's candidate
  const DEFENSIVE = LADDER[LADDER.length - 1]!; // rung 9 — the prior hold, so the move is a RE-risk

  // The fixed-width band, DERIVED (`makeDial`, test-helpers.ts): rung 3 with a fully-split leader
  // axis ⇒ `targetRung 3` and width `POSITION_SPAN + round(1) = 3` rungs. The pre-2026-08-02 fixture
  // typed `rung 1 / dangerScore 0 / regime Calm` beside `targetRung 3` — a book `computeT1Dial` can
  // never emit (dangerScore 0 ⇒ targetRung 1). The honest book for this band is CAUTION, not Calm:
  // the width is family DISAGREEMENT, so a wide band at rung 3 costs a nonzero danger score. Nothing
  // on this path reads the regime axes — the re-risk gate turns on `targetRung` vs the prior held
  // rung — so the pins below are unaffected by the relabel.
  const calmDial = (): T1DialResult => makeDial({ rung: 3 }, { leaderSplit: 1 });

  // The carried streak the epoch rule is supposed to discard. Any positive value works — the counter
  // is bookkeeping, not a threshold, since RERISK_CONFIRM went to 1 (2026-08-07). It must be > 0 or
  // "read as 0" is indistinguishable from "read as-is", which is the whole point of the test.
  const CARRIED_STREAK = 1;

  // Only date / heldSleeve / reriskConfirmCount / heldDays (+ dialTargetRung, absent ⇒ cold RISING,
  // which this test's pins do not turn on) are read off `prevDay` on this path.
  const priorHold = (date: string): AlertRecord =>
    ({
      date,
      heldSleeve: DEFENSIVE,
      reriskConfirmCount: CARRIED_STREAK,
      heldDays: 10,
    }) as unknown as AlertRecord;

  // ⚠ WHY THIS TEST NEEDS A TREND VETO (2026-08-07). The epoch rule zeroes a pre-epoch carried streak.
  // Before the symmetry ruling that was observable on `heldSleeve`: the stale arm's zeroed streak fell
  // short of `RERISK_CONFIRM = 2` and held, while the fresh arm committed. At `RERISK_CONFIRM = 1`
  // NEITHER arm is blocked by the streak — both commit, both reset the counter to 0, and the pair
  // stops diverging, so the old shape was premise-dead, not merely off by a number. The counter only
  // stays UNCASHED behind the one surviving gate, `trendOk`. With a confirmed-RED uT member both arms
  // hold DEFENSIVE and the epoch is visible where it actually lives — on the accumulate/reset
  // predicate: stale re-accumulates from 0 (⇒ 1), fresh carries (⇒ 2).
  const trendRed = [{
    key: "trend" as const, label: "", state: "RED" as const, live: true, firing: true,
    contribution: null, absent: 0, members: [{ id: "GT", label: "GT", state: "RED" as const }],
    note: undefined, desc: undefined,
  }];

  test("a PRE-epoch prior's streak re-accumulates from 0; the same streak ON the epoch carries", () => {
    // PREMISE guard for the trend-veto framing above (not a fixture): if §5's fallback ever re-arms
    // either timing gate, the streak becomes cashable again and this test's shape must be re-derived
    // rather than re-numbered — exactly the rot that made its previous version premise-dead.
    expect(RERISK_CONFIRM).toBeLessThanOrEqual(1);
    expect(RERISK_DWELL_DAYS).toBeLessThanOrEqual(0); // premise: no dwell clock — a whole-pipeline run reads the shipped constant

    // asOf sits 5 days past the epoch, so BOTH arms see a new close (newClose) and differ in
    // nothing but the prior's date.
    const now = `${dayOffset(RERISK_BASIS_EPOCH, 5)}T22:00:00.000Z`;
    const base = {
      readings: [] as Reading[],
      last: null,
      lastPush: null,
      now,
      dial: calmDial(),
      globalFamilies: trendRed,
    };

    // STALE arm — one day before the epoch (the tightest discriminating offset under the strict `<`).
    const { alert: stale } = assembleRun({ ...base, prevDay: priorHold(dayOffset(RERISK_BASIS_EPOCH, -1)) });
    expect(stale.heldSleeve).toBe(DEFENSIVE);              // trend-vetoed, so the streak stays uncashed
    expect(stale.reriskConfirmCount).toBe(1);              // re-accumulated from 0: 0 + 1, NOT CARRIED_STREAK + 1

    // FRESH arm — exactly ON the epoch (the boundary is inclusive: `<` is strict).
    const { alert: fresh } = assembleRun({ ...base, prevDay: priorHold(RERISK_BASIS_EPOCH) });
    expect(fresh.heldSleeve).toBe(DEFENSIVE);              // same veto, same hold — only the counter differs
    expect(fresh.reriskConfirmCount).toBe(CARRIED_STREAK + 1);

    // Non-vacuity: the two arms really did diverge (guards against a future refactor collapsing
    // both onto one branch and leaving the pins above trivially agreeing).
    expect(stale.reriskConfirmCount).not.toBe(fresh.reriskConfirmCount);
    // ...and the veto really is what keeps the streak alive: drop it and both arms commit + reset.
    const { alert: unvetoed } = assembleRun({ ...base, globalFamilies: [], prevDay: priorHold(RERISK_BASIS_EPOCH) });
    expect(unvetoed.heldSleeve).toBe(AGGRESSIVE);
    expect(unvetoed.reriskConfirmCount).toBe(0);
  });
});

// Auto GEO crisis-stage machine — the calm streak is computed AT THE RUN SEAM (prevDay + the four
// trigger states, behind the new-trading-close gate), persisted, and threaded into the band floor.
describe("assembleRun - GEO calm streak (auto stage 0↔1↔4 machine)", () => {
  // mkGeoReading stamps every reading 2026-06-26, so asOf = that date; prevDay dates pivot newClose.
  const NOW = "2026-06-26T22:00:00.000Z";
  const PREV = "2026-06-25";
  const allGreen = () => ["G1", "OVX", "BRENT", "T5YIFR"].map((id) => mkGeoReading(id, "GREEN"));
  const prior = (date: string, geoCalmStreak: number | null): AlertRecord =>
    ({ date, geoCalmStreak }) as unknown as AlertRecord;
  const run = (readings: Reading[], prevDay: AlertRecord | null) =>
    assembleRun({ readings, last: null, prevDay, lastPush: null, now: NOW }).alert;

  test("bootstrap: null prevDay seeds the streak AT the dwell - no manufactured WATCH", () => {
    const alert = run([], null);
    expect(alert.geoCalmStreak).toBe(DE_ESCALATION_DAYS);
    expect(alert.level).toBe("OK");
    expect(alert.bandReason).toBe("no-dial");
  });

  test("pre-migration row (persisted streak null) seeds at the dwell, then advances on a new close", () => {
    expect(run(allGreen(), prior(PREV, null)).geoCalmStreak).toBe(DE_ESCALATION_DAYS + 1);
  });

  test("all four triggers GREEN on a NEW close advances the streak; the short streak floors WATCH", () => {
    const alert = run(allGreen(), prior(PREV, 0));
    expect(alert.geoCalmStreak).toBe(1);
    expect(DE_ESCALATION_DAYS).toBeGreaterThan(1); // premise: 1 is still short of the dwell below
    expect(alert.level).toBe("WATCH"); // held stage-1: nothing lit, streak short of the dwell
    expect(alert.bandReason).toBe("floor:geo");
  });

  test("a same-close cron re-run does NOT double-count the streak", () => {
    expect(run(allGreen(), prior(NOW.slice(0, 10), 0)).geoCalmStreak).toBe(0);
  });

  test("any lit trigger resets the streak to 0 (T5YIFR counts - the CONTEXT-channel trigger)", () => {
    const readings = [...allGreen().slice(0, 3), mkGeoReading("T5YIFR", "AMBER")];
    const alert = run(readings, prior(PREV, 5));
    expect(alert.geoCalmStreak).toBe(0);
    expect(alert.level).toBe("WATCH"); // the lit factor absorbs the hold — base 1, not 2
  });

  test("absent trigger readings HOLD the prior streak (blindness neither advances nor resets)", () => {
    expect(run([], prior(PREV, 0)).geoCalmStreak).toBe(0);
    expect(run([], prior(PREV, DE_ESCALATION_DAYS)).geoCalmStreak).toBe(DE_ESCALATION_DAYS);
  });
});

// R4/R5 Stage 3.2 — the coverage floor's
// ARMING is resolved at the run seam, not inside alert-band: `assembleRun` reads the CARRIED DIAL
// panel (`globalFamilies`) plus this run's own reading stamps and hands `computeAlertBandDetail` one
// boolean. Without this end-to-end pin the run-core call site could be deleted with every
// alert-band.floors.test.ts coverage test still green — the unit tests resolve the claim themselves.
describe("assembleRun - the coverage floor arms off globalFamilies + the reading stamps (R4/R5)", () => {
  const NOW = "2026-07-18T22:00:00.000Z";
  const ASOF = NOW.slice(0, 10);

  /** A stamped notify reading — `stale` is the run-cycle stamp (`stampFreshness`), the same field
   *  the floor's daily-peer guard reads. `cadence` rides the indicator, as in production. */
  const stamped = (id: string, cadence: "daily" | "weekly", lag: boolean): Reading => ({
    indicator: { id, label: id, longLabel: id, series: id, channel: "FIN", thresholds: {}, cadence },
    date: ASOF,
    level: 1.23,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
    lag,
  });

  const degradedPanel = [
    {
      key: "rates" as const,
      label: "rates",
      state: "GREEN" as const,
      live: true,
      firing: false,
      contribution: 0,
      members: [{ id: "R1", label: "R1", state: "GREEN" as const }],
      absent: 1,
      absentIds: ["R6"],
      coverageDegraded: true,
    },
  ];

  test("a coverage-degraded panel + a fresh daily reading floors the persisted band at WATCH", () => {
    const base = {
      last: null,
      lastPush: null,
      now: NOW,
      dial: makeDial(),        // Calm ⇒ raw dial band OK, so the floor is the only lift available
      readings: [stamped("F1", "daily", false), stamped("F3", "weekly", false)],
    };

    const { alert: armed } = assembleRun({ ...base, globalFamilies: degradedPanel });
    expect(armed.level).toBe("WATCH");
    expect(armed.bandReason).toBe("floor:coverage");

    // THE PAIR: identical readings, a panel with nothing degraded ⇒ no floor at all. Without this
    // arm the test above would pass against a build that floors every run.
    const clean = degradedPanel.map((f) => ({ ...f, absent: 0, absentIds: [], coverageDegraded: false }));
    const { alert: quiet } = assembleRun({ ...base, globalFamilies: clean });
    expect(quiet.level).toBe("OK");
    expect(quiet.bandReason).toBe("regime");

    // And the divergence half at the run seam: the degraded panel with EVERY DAILY feed stale is a
    // blind RUN, not a blind family — no arm (the weekly peer stays fresh and must not substitute).
    const { alert: blind } = assembleRun({
      ...base,
      readings: [stamped("F1", "daily", true), stamped("F3", "weekly", false)],
      globalFamilies: degradedPanel,
    });
    expect(blind.level).toBe("OK");
  });
});

describe("latestReadingDate - the asOf backstop", () => {
  const at = (id: string, date: string): Reading => ({
    indicator: { id, label: id, longLabel: id, series: id, channel: "FIN", thresholds: {} },
    date,
    level: 1,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
  });

  test("returns the chronological max, and undefined for an empty array", () => {
    expect(latestReadingDate([at("F1", "2026-08-05"), at("F3", "2026-07-31")])).toBe("2026-08-05");
    expect(latestReadingDate([])).toBeUndefined();
  });

  // The 2026-08-06 incident, at the seam that PUBLISHED it: EBP arrived as "7/1/2026", which the
  // lexicographic max ranked above every live ISO date, so the run dated itself — and folded its
  // whole dial — at a day with no data while the feeds were fine. Aborting is the correct outcome:
  // no alert beats an alert whose posture is fabricated from an empty fold.
  test("throws on a non-ISO date instead of letting it win the max", () => {
    expect(() => latestReadingDate([at("F1", "2026-08-05"), at("EBP", "7/1/2026")])).toThrow(
      /non-ISO reading date from EBP: 7\/1\/2026/,
    );
  });
});

// `run_inputs` must replay `assembleRun` exactly over the
// stored readings — which carry no freshness stamp, so the replay readings below are stamp-free like `reconstructReadings`'.
describe("assembleRun - run_inputs replay (toRunInputs/fromRunInputs)", () => {
  const NOW = "2026-06-26T22:00:00.000Z";
  const provId = [...PROVISIONAL_IDS][0]!;
  const lagged: Reading = { ...mkGeoReading("G1", "GREEN"), ageDays: 9, lag: true, unit: "slots" };
  const readings = [lagged, mkGeoReading("OVX", "GREEN"), mkGeoReading("BRENT", "GREEN"), mkGeoReading("T5YIFR", "GREEN")];
  const prevDay = priorAlert({ date: "2026-06-25", firedAt: "2026-06-25T21:00:00.000Z", level: "WARNING", dialBand: "WARNING", heldSleeve: "Semis", dialTargetRung: 2 });
  const opts: AssembleRunOpts = {
    readings,
    last: prevDay,
    prevDay,
    lastPush: null,
    now: NOW,
    dial: { ...makeDial({ targetRung: 2 }), band: { lo: 1, hi: 3 } },
    globalFamilies: gf([{ id: "VT", state: "AMBER" }]).globalFamilies,
    geoFlags: 1,
    crisisStage: 0,
    scored: [{
      baselineField: "slowBand",
      alertFields: { slowScore: 3, slowBand: "ELEVATED", slowMaxScore: 8 },
      rows: [],
      storedSeries: () => new Map(),
      notification: () => ({ push: false, message: null }),
      consoleLine: "",
    }],
    lastBands: ["CALM"],
    rsBySleeve: new Map([["Semis", 0.4], ["EM", null]]),
    momBySleeve: new Map([["Semis", -0.1]]),
    recentDialBands: ["WATCH"],
    recentAlerts: [{ date: "2026-06-25", dialTargetRung: 2 }],
    exposurePosture: "Reduced",
    fallShape: { shape: "v-shaped", velocity: 0.2, dwell: 1, reason: "fixture" },
    degradeEvents: [{ scope: "fixture", reason: "a degraded feed", effect: "notify" }],
    spDistToHigh: 0.99,
    nearHighTol: 0.02,
    globalReadings: [{ ...mkGeoReading(provId, "AMBER"), rawState: "RED", ageDays: 0, lag: false, unit: "slots" }],
    oilEst: { BRENT: { date: "2026-06-26", value: 80, fromDate: "2026-06-25" } },
  };
  const stampFree = readings.map(({ ageDays: _a, lag: _l, unit: _u, ...r }) => r);

  test("toRunInputs → JSON → fromRunInputs replays the same alert row, push and provisional", () => {
    const orig = assembleRun(opts);
    const ri = JSON.parse(JSON.stringify(toRunInputs(opts)));
    // Only the non-stored keys come from opts — a key fromRunInputs drops must not be masked by the original.
    const { last, prevDay: pd, lastPush, now, dial, globalFamilies } = opts;
    const restored = fromRunInputs(ri, stampFree);
    const replay = assembleRun({ last, prevDay: pd, lastPush, now, dial, globalFamilies, ...restored });
    expect(restored.exposurePosture).toBe(opts.exposurePosture);
    // Vacuity: the fixture's stored inputs move the output — the lag stamp holds the band, the provisional fires.
    const unstamped = assembleRun({ ...opts, readings: stampFree }).alert;
    expect(orig.alert.bandReason).not.toBe(unstamped.bandReason);
    expect(orig.provisional.push).toBe(true);
    expect(replay.alert).toEqual(orig.alert);
    expect(replay.notification).toEqual(orig.notification);
    expect(replay.provisional.message).toEqual(orig.provisional.message);
    expect(ri.refs).toEqual({ last: prevDay.firedAt, prevDay: prevDay.firedAt, lastPush: null });
  });
});
