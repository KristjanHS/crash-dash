// R3 (EW-11/12/13): the VT VIX backwardation PERSISTENCE leg — a CHART-ONLY
// consecutive-days-in-backwardation streak scored on the CONTEXT identity `VTP`
// (registry.ts, off ALL_INDICATORS and every dial family). It must NEVER reach notify. Pinned here:
// the streak→state cuts (5 → Amber, 10 → Red), the history builder, the stamped identity, the
// chart-only BAND invariant (a RED VTP reading in a `readings[]` array does not move
// computeAlertBand), and — since B.3 — the two surfaces the B.1 persistence wiring newly exposed:
// no dial family, and no line in the push BODY.
import { describe, expect, test } from "vitest";
import {
  backwardationStreak,
  vixTermPersistenceReadingSeries,
  scoreVixTermPersistence,
  scoreVxnTerm,
} from "./scorers-composite.js";
import {
  VTP,
  VT,
  VXNT,
} from "./registry-composite.js";
import {
  type Indicator,
  type Observation,
  type Reading,
} from "./domain-types.js";
import { CONFIRM_CLOSES, VELOCITY_WINDOW } from "./domain-types.js";
import { VT_DESCRIPTOR, VXNT_K_WINDOW } from "./family-descriptor-rows.js";
import { scoreVixTermPersistenceIndicator } from "./confirmers.js";
import { computeAlertBand, type VerdictHoldLeg } from "./alert-band.js";
import { computeField } from "./danger-engine.js";
import {
  computeFamilyPanel,
  familyOf,
  DASHBOARD_FAMILIES,
  GLOBAL_FAMILIES,
  US_FAMILIES,
} from "./families.js";
import { DIAL_FAMILIES, MEMBER_WEIGHT } from "./danger-ladder.js";
import { buildNotification } from "./notify_format.js";
import type { R4Phase } from "./r4.js";
import type { T1DialResult } from "./t1dial.js";
import { makeDial } from "./test-helpers.js";

// Synthetic ^VIX/^VIX3M legs from a per-day backwardation pattern (ascending). `true` ⇒ that
// day's VIX/VIX3M ratio > 1.00 (backwardation, VIX 110 vs VIX3M 100 = 1.10); `false` ⇒ ratio
// 0.90 (contango). Both legs share the same synthetic dates so alignByDate inner-joins all days.
function mkLegs(pattern: boolean[]): { vix: Observation[]; vix3m: Observation[] } {
  const vix: Observation[] = [];
  const vix3m: Observation[] = [];
  pattern.forEach((back, i) => {
    const date = `2026-${String(i).padStart(4, "0")}`;
    vix.push({ date, value: back ? 110 : 90 });
    vix3m.push({ date, value: 100 });
  });
  return { vix, vix3m };
}

/** Pattern with `runLen` backwardation days at the END, preceded by a non-backwardation day
 *  (so the streak terminates exactly at `runLen`) and `runLen` leading non-backwardation days. */
function trailingRun(runLen: number): boolean[] {
  const lead = new Array(Math.max(runLen, 1)).fill(false);
  const tail = new Array(runLen).fill(true);
  return [...lead, false, ...tail];
}

describe("backwardationStreak - consecutive most-recent days in backwardation", () => {
  test("counts only the trailing run, stopping at the first contango day", () => {
    const { vix, vix3m } = mkLegs([true, false, true, true, true]); // trailing run = 3
    expect(backwardationStreak(vix, vix3m)).toBe(3);
  });

  test("a flat curve (ratio exactly 1.00) is NOT backwardation (strict >)", () => {
    // both legs 100 ⇒ ratio 1.00, which must NOT count (VT_BACKWARDATION_RATIO strict >)
    const vix = [{ date: "d0", value: 100 }];
    const vix3m = [{ date: "d0", value: 100 }];
    expect(backwardationStreak(vix, vix3m)).toBe(0);
  });

  test("empty / disjoint legs degrade to 0", () => {
    expect(backwardationStreak([], [])).toBe(0);
    expect(backwardationStreak([{ date: "a", value: 110 }], [{ date: "b", value: 100 }])).toBe(0);
  });
});

describe("vixTermPersistenceState - streak cuts (EW-11/12: 5 → Amber, 10 → Red)", () => {
  // (a) Amber edge: exactly 5 is Amber; 4 is not. (b) Red edge: exactly 10 is Red; 9 is Amber.
  test.each([
    [4, "GREEN"],
    [5, "AMBER"],
    [9, "AMBER"],
    [10, "RED"],
  ] as const)("a run of %i → %s", (run, state) => {
    const { vix, vix3m } = mkLegs(trailingRun(run));
    const r = scoreVixTermPersistence(VTP, vix, vix3m);
    expect(r.level).toBe(run); // level IS the streak count
    expect(r.state).toBe(state);
    expect(r.rawState).toBe(state); // no CONFIRM fold — raw === confirmed
  });
});

// (b1) The HISTORY builder — the per-close
// streak series `scripts/backfill.ts specs()` seeds VTP's deep history from, and the series whose
// TAIL `scoreVixTermPersistence` now returns. Two things can break independently: the per-day
// count (a running counter that never RESETS would read a broken run as one long streak, and the
// cuts above cannot see it — they only ever inspect the last day), and tail parity with the live
// scalar (a second implementation of the same rule is exactly the drift this de-dup removes).
describe("vixTermPersistenceReadingSeries - a Reading per aligned close", () => {
  test("counts each day's own run, RESETTING on a contango day", () => {
    // 3 backwardation days, a break, then 2 → per-day streaks 1,2,3,0,1,2 (not 1,2,3,3,4,5).
    const { vix, vix3m } = mkLegs([true, true, true, false, true, true]);
    const series = vixTermPersistenceReadingSeries(VTP, vix, vix3m);
    expect(series.map((r) => r.level)).toEqual([1, 2, 3, 0, 1, 2]);
    expect(series.map((r) => r.date)).toEqual(vix.map((o) => o.date)); // one point per aligned close
    expect(series.every((r) => r.indicator === VTP)).toBe(true);
  });

  test("the state ribbon crosses the Amber cut mid-series, at the run's 5th day", () => {
    // A 6-day run: GREEN until the streak reaches VT_STREAK_AMBER, AMBER from that day on.
    const { vix, vix3m } = mkLegs(new Array(6).fill(true));
    expect(vixTermPersistenceReadingSeries(VTP, vix, vix3m).map((r) => r.state)).toEqual([
      "GREEN", "GREEN", "GREEN", "GREEN", "AMBER", "AMBER",
    ]);
  });

  test("its tail IS the live scalar (one rule, one implementation)", () => {
    const { vix, vix3m } = mkLegs(trailingRun(7));
    expect(vixTermPersistenceReadingSeries(VTP, vix, vix3m).at(-1)).toEqual(
      scoreVixTermPersistence(VTP, vix, vix3m),
    );
    // Degenerate pair: no aligned closes ⇒ empty series, and the scalar keeps its pre-B.2 fallback.
    expect(vixTermPersistenceReadingSeries(VTP, [], [])).toEqual([]);
    expect(scoreVixTermPersistence(VTP, [], [])).toMatchObject({ date: "", level: 0, state: "GREEN" });
  });
});

// (b2) The IDENTITY the confirmer stamps (Stage 2b.4). Before 2b.4 the scorer hard-coded its own
// module-private `VT_PERSIST` identity, so "the persistence leg reads as VTP" was pinned
// transitively by every assertion above. 2b.4 turned it into the scorer's first PARAMETER, moving
// the choice into the single production wrapper — where nothing pinned it: passing VT (or any
// other Indicator) there type-checks and leaves the whole suite green. This pins the wiring.
describe("scoreVixTermPersistenceIndicator - stamps the VTP identity (2b.4 parameterization)", () => {
  test("the emitted Reading carries VTP, not VT or any other identity", () => {
    const { vix, vix3m } = mkLegs(trailingRun(10));
    const readings = scoreVixTermPersistenceIndicator(vix, vix3m);
    expect(readings).toHaveLength(1); // guard: the leg really emitted (else the pin is vacuous)
    expect(readings[0]!.indicator).toBe(VTP);
  });
});

// (c) Chart-only band invariant (EW-13). VTP rides a CONTEXT identity that is off every roll-up
// AND every escalator, so a RED VTP reading dropped into the `readings[]` array that feeds
// computeAlertBand must leave the pushed band unchanged. The load-bearing fact is the CHANNEL:
// escalatorFloor recombines GEO/RATE readings by channel — CONTEXT touches neither. Mutating
// VTP.channel to "GEO" (registry.ts) makes the RED reading count toward the GEO floor and
// this assertion goes red — proving CONTEXT (a non-escalator channel) is load-bearing, verified
// in-place 2026-07-21.
// The dial is a CONTROL here, not a subject: it must be the same on both sides of the comparison
// and must not itself move the band. `makeDial()`'s default is exactly that — rung 1, Calm on both
// axes, unprimed and unfired — and it comes from production, so the pre-2026-08-02
// `as unknown as T1DialResult` cast (which left every other field `undefined` inside band math)
// is gone with it.
const calmDial = (): T1DialResult => makeDial();

/** A RED VXNT off a level fixture: VIXCLS ≡ VXNCLS (k ≡ 1) and VXVCLS ≡ 1, so the scored ratio IS the VXNCLS level. */
function redVxnt(): Reading {
  const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const head = Array.from({ length: VXNT_K_WINDOW + VELOCITY_WINDOW + 5 }, () => VT_DESCRIPTOR.amber / 2);
  const levels = [...head, ...Array.from({ length: CONFIRM_CLOSES }, () => VT_DESCRIPTOR.red * 2)];
  const leg = (vs: number[]): Observation[] => vs.map((value, i) => ({ date: day(i), value }));
  return scoreVxnTerm(VXNT, leg(levels), leg(levels), leg(levels.map(() => 1)));
}

/** The chart-only ids whose display-only contract (band, dial family + danger, push body) is pinned below. */
const CHART_ONLY_RED: readonly { ind: Indicator; red: () => Reading }[] = [
  { ind: VTP, red: () => scoreVixTermPersistence(VTP, mkLegs(trailingRun(10)).vix, mkLegs(trailingRun(10)).vix3m) },
  { ind: VXNT, red: redVxnt },
];

describe("chart-only invariant - a RED chart-only reading never moves the notify band", () => {
  test.each(CHART_ONLY_RED)("computeAlertBand is unmoved with vs without the RED $ind.id reading", ({ red }) => {
    const vtpRed = red();
    expect(vtpRed.state).toBe("RED"); // guard: the reading really is RED (else the test is vacuous)

    const base = {
      dial: calmDial(),
      geoFlags: 0,
      r4Phase: "equity" as R4Phase,
      recentDialBands: [] as ("OK" | "WATCH" | "WARNING" | "CRITICAL")[],
    };
    const bandWithout = computeAlertBand({ ...base, readings: [] });
    const bandWith = computeAlertBand({ ...base, readings: [vtpRed] });

    expect(bandWithout).toBe("OK"); // baseline: Calm dial, no floors
    expect(bandWith).toBe(bandWithout); // the RED VTP left the band exactly where it was
  });
});

// (d) The OTHER two halves of option B's
// "chartable, never notify-reaching". (c) above pins the BAND; a reading that is now in `readings[]`
// (B.1) is also a candidate for the two surfaces that read that array directly: the dial FAMILY
// panel (whose band IS the notify band) and the push BODY. The readings[]-PRESENCE half is pinned
// separately by a real `runScoringCycle` in `run.wiring.test.ts` (the all-GREEN census); this block
// pins the two absences, each beside a vacuity guard proving the surface is live in the fixture.
describe("notify-exclusion (B.3) - no dial family, no push body", () => {
  const redOf = (red: () => Reading) => {
    const r = red();
    expect(r.state).toBe("RED"); // guard: the reading really is RED (else both pins are vacuous)
    return r;
  };

  test.each(CHART_ONLY_RED)("$ind.id is in no family table or weight row, and a RED one moves no panel cell or danger", ({ ind, red }) => {
    for (const [name, defs] of [
      ["US", US_FAMILIES],
      ["GLOBAL", GLOBAL_FAMILIES],
      ["DASHBOARD", DASHBOARD_FAMILIES],
      ["DIAL", DIAL_FAMILIES],
    ] as const) {
      expect(defs.flatMap((f) => f.ids), `${name}_FAMILIES member ids`).not.toContain(ind.id);
    }
    expect(familyOf(ind.id)).toBeUndefined(); // and so `confirmClosesFor(ind)` stays 0
    expect(Object.keys(MEMBER_WEIGHT)).not.toContain(ind.id);

    // Behavioral half — the membership tables are what the panel reads, so a RED row must leave the
    // reduced panel, and the danger field computed off it, byte-identical to one that never saw it.
    const panel = (rows: { id: string; state: "GREEN" | "AMBER" | "RED" }[]) =>
      computeFamilyPanel(rows, DIAL_FAMILIES);
    const field = (rows: { id: string; state: "GREEN" | "AMBER" | "RED" }[]) =>
      computeField({ globalFamilies: panel(rows).families }, { lo: 1, hi: 9, label: "all" });
    const state = redOf(red).state;
    expect(panel([{ id: ind.id, state }])).toEqual(panel([]));
    expect(field([{ id: ind.id, state }])).toEqual(field([]));
    // Vacuity guard: the SAME RED state under a real volatility-family id (VT) does move both — so
    // the equalities above are an exclusion, not a dead panel or field.
    expect(panel([{ id: VT.id, state }])).not.toEqual(panel([]));
    expect(field([{ id: VT.id, state }])).not.toEqual(field([]));
  });

  test.each(CHART_ONLY_RED)("the push body never renders $ind.id - not as a driver line, not in the omitted count", ({ ind, red }) => {
    const vtpRed = redOf(red);
    // The SAME reading under a notify-facing identity, so the two arms differ ONLY by identity.
    const control: Reading = { ...vtpRed, indicator: VT };
    const body = (readings: Reading[]) =>
      buildNotification(null, "WARNING", undefined, undefined, readings, "2026-06-26").message.body;

    // Vacuity guard: an identically-RED notify-facing reading DOES print a driver line here.
    expect(body([control])).toContain(VT.label);
    expect(body([vtpRed])).not.toContain(ind.label);
    // Byte-identical with and without: VTP contributes nothing at all — not a line, and not a
    // body-visible "N others GREEN" count (a filter applied only to the drivers would fail here).
    expect(body([control, vtpRed])).toBe(body([control]));
  });

  // The SECOND body entry point for an indicator LABEL, and the one the driver-line filter above
  // does not cover: `opts.verdictHoldLegs`. `run-core.ts` computes `verdictHoldLegs(readings, …)` over the
  // UNFILTERED array, so a stale VTP arrives here as a pre-built {id,label,ageDays} row and the
  // stale-legs line printed "VIX backwardation (16d)" verbatim (measured 2026-07-31) even while the
  // driver line was correctly suppressed. The exclusion now lives on BOTH inputs of the builder.
  test("a stale VTP prints no stale-legs entry, while a stale notify-facing leg does", () => {
    const bodyWith = (legs: VerdictHoldLeg[]) =>
      buildNotification(null, "WARNING", undefined, undefined, [], "2026-06-26", { verdictHoldLegs: legs })
        .message.body;
    const leg = (ind: typeof VT): VerdictHoldLeg => ({
      id: ind.id,
      label: ind.label,
      ageDays: 16,
      cadence: "daily",
    });

    // Vacuity guard: a notify-facing stale leg DOES print, so the absence below is an exclusion.
    expect(bodyWith([leg(VT)])).toContain(`${VT.label} (16d)`);
    expect(bodyWith([leg(VTP)])).not.toContain(VTP.label);
    // …and a VTP-only list prints no lagging-legs LINE at all (not an empty "[!] lagging legs: ").
    expect(bodyWith([leg(VTP)])).not.toContain("lagging legs:");
    // Byte-identical with and without, so VTP contributes nothing to the rendered line either.
    expect(bodyWith([leg(VT), leg(VTP)])).toBe(bodyWith([leg(VT)]));
  });
});

// (e) Degrade fail-safe of the production wrapper (review finding 2, 2026-07-31). Unlike
// `scoreVixTermIndicator`, the persistence scorer NEVER throws on a disjoint/too-short pair — the
// `?? { date: "", level: 0, state: "GREEN" }` fallback fires instead. Since B.1 persists whatever
// the wrapper returns, that fallback would store a FABRICATED 0-day calm dated "" (and
// `Date.parse("")` is NaN, so lag checks read it as fresh) — the exact shape `api/lab.ts`
// claims can never reach the overlay ("a feed-down close reads as SILENCE"). The wrapper takes the
// SERIES tail, so an empty series means no reading at all.
describe("scoreVixTermPersistenceIndicator - degrade fail-safe on a non-empty but disjoint pair", () => {
  test("a disjoint pair emits NO reading (never a fabricated GREEN 0-day dated \"\")", () => {
    const front = [{ date: "2026-06-01", value: 110 }];
    const back = [{ date: "2026-06-02", value: 100 }]; // non-empty, but zero aligned closes
    // Guard: the pair really is non-empty, so the length short-circuit is NOT what returns [].
    expect(front.length && back.length).toBeTruthy();
    expect(vixTermPersistenceReadingSeries(VTP, front, back)).toEqual([]); // the disjoint regime
    expect(scoreVixTermPersistenceIndicator(front, back)).toEqual([]);
  });
});
