/**
 * Pins the feed-lag probe's ladder and its A/A guards.
 *
 * The probe is MEASUREMENT-ONLY, so what this file guards is that the measurement means what the
 * docblock says: (1) that EVERY guard can actually
 * fire — a guard that cannot fire is the vacuity the probe exists to prevent — and (2) the ladder's
 * boundaries, including BOTH arms of the E7 §Stage 4 fork as re-based by §Stage 4.7-R2: an id the
 * registry has EXPLICITLY registered rots against `max(p90Gap, LAG_THRESHOLDS[registered])` — the
 * CADENCE TIER, not the id's resolved cut — and an id it says nothing about against `p90Gap` alone.
 *
 * TWO axes, so TWO discriminating cases, neither of which can stand in for the other:
 *   · the `explicit` GATE — one row read both ways (age 9, cut 11, tier 9, own p90 3 ⇒ DEEP-LAG
 *     unregistered, FRESH explicit); dropping the gate flips the second line.
 *   · TIER-vs-CUT — the EBP-shaped row (registered monthly, cut 70, p90Gap 31, age 100): DEEP-LAG under
 *     the tier floor (bar 80) and LATE under the retired cut floor (bar 140). Reverting the 4.7-R2
 *     re-base reds TWO tests here: "finding 3: the explicit floor is the CADENCE TIER, not the id's
 *     resolved cut" AND "an explicit registration RAISES the deep-lag bar to 2 × the tier, it never
 *     removes it" (cut 11 ⇒ bar 22 under the retired floor, so its `age 19 ⇒ DEEP-LAG` line fails).
 * `shouldCorrect` has the matching `explicit` pair, since the explicit arm withholds every
 * correction, fining included. Which ids fall on which side is NOT pinned here — that is
 * `EXPLICIT_OF` in `api/lab.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_GAPS,
  assertNonVacuous,
  classify,
  impliedCadenceFor,
  lagRowFor,
  lagTier,
  shouldCorrect,
  type Label,
  type Row,
} from "./probe-feed-lag.js";
import { LAG_THRESHOLDS, lagCutFor } from "../src/ladder.js";
import { ALL_INDICATORS } from "../src/registry.js";
import type { Cadence } from "../src/domain-types.js";

/** A classified row with the fields the guards read; the rest is filler the guards never touch. */
function row(over: Partial<Row> & { label: Label; registered?: Cadence }): Row {
  const registered = over.registered ?? "daily";
  return {
    id: "X",
    registered,
    cut: LAG_THRESHOLDS[registered],
    // Guard (a2) DOES read `explicit`/`p90Gap`/`registered` (via `deepLagRhythm`): the strict arm gives
    // every default row a finite bar of `2 × p90Gap = 6`, so a healthy fixture reaches DEEP-LAG at 7d and
    // FRESH at 0d. A row that must FAIL (a2) sets `p90Gap` to Infinity explicitly.
    explicit: false,
    age: 1,
    newest: "2026-07-25",
    gaps: MIN_GAPS,
    medianGap: 1,
    p90Gap: 3,
    impliedCadence: "daily",
    ...over,
  };
}

describe("classify — the ladder", () => {
  const daily = LAG_THRESHOLDS.daily;
  const weekly = LAG_THRESHOLDS.weekly;

  it("UNKNOWN below MIN_GAPS, whatever the age", () => {
    expect(
      classify({ gaps: MIN_GAPS - 1, age: 99, cut: daily, registered: "daily", p90Gap: 1, explicit: false }),
    ).toBe("UNKNOWN");
    expect(classify({ gaps: MIN_GAPS, age: 99, cut: daily, registered: "daily", p90Gap: 1, explicit: false })).not.toBe(
      "UNKNOWN",
    );
  });

  it("FRESH at exactly the tier cut, when the own-rhythm test is clear", () => {
    expect(classify({ gaps: MIN_GAPS, age: daily, cut: daily, registered: "daily", p90Gap: 3, explicit: false })).toBe(
      "FRESH",
    );
  });

  it("DEEP-LAG strictly ABOVE the rhythm × DEEP_LAG_MULTIPLE, not at it", () => {
    expect(
      classify({ gaps: MIN_GAPS, age: 6, cut: daily, registered: "daily", p90Gap: 3, explicit: false }),
    ).not.toBe("DEEP-LAG");
    expect(classify({ gaps: MIN_GAPS, age: 7, cut: daily, registered: "daily", p90Gap: 3, explicit: false })).toBe(
      "DEEP-LAG",
    );
  });

  // AXIS 1 — the `explicit` GATE (E7 §Stage 4 fork). One row, both ways: p90Gap 3 (OBSERVATION
  // spacing, blind to the release grid — §Stage 1.4) on an H.10-shaped weekly row (tier 9, ruled cut
  // 11), aged 9 days. Unregistered it is 3× its own p90 ⇒ DEEP-LAG, the false RED that stopped Stage 4;
  // once the registry has ASSERTED the rhythm the bar is max(3, tier 9) × 2 = 18 ⇒ inside the bar,
  // then FRESH at the cut. Dropping the `explicit` gate flips the second line; the tier-vs-cut axis
  // is NOT separated here (both floors leave this row FRESH) — that is the 4.7-R2 case below.
  it("finding 1: an EXPLICIT id rots against max(p90Gap, tier); an unregistered one against p90Gap", () => {
    expect(classify({ gaps: MIN_GAPS, age: 9, cut: 11, registered: "weekly", p90Gap: 3, explicit: false })).toBe("DEEP-LAG");
    expect(classify({ gaps: MIN_GAPS, age: 9, cut: 11, registered: "weekly", p90Gap: 3, explicit: true })).toBe(
      "FRESH",
    );
  });

  // AXIS 2 — TIER vs RESOLVED CUT (E7 §Stage 4.7-R2, the EBP specimen). `lagAfterDays: 70` encodes
  // publication LAG, not release SPACING, so flooring at it bought a 140d deep-lag bar — four and a half
  // months of darkness. The tier floor gives 2 × max(31, LAG_THRESHOLDS.monthly) < 100, and this row is 100d dark.
  // Under the retired `max(p90Gap, cut)` form the bar is 140 ⇒ age 100 is past cut 70 and past p90 31
  // but inside the bar ⇒ LATE. So reverting the re-base flips exactly this line, and only this line.
  it("finding 3: the explicit floor is the CADENCE TIER, not the id's resolved cut", () => {
    expect(2 * Math.max(31, LAG_THRESHOLDS.monthly)).toBeLessThan(100); // out-of-band: bar 2 × max(31, tier) < age 100 < 2 × 70 = 140
    expect(classify({ gaps: MIN_GAPS, age: 100, cut: 70, registered: "monthly", p90Gap: 31, explicit: true })).toBe(
      "DEEP-LAG",
    );
  });

  it("an explicit registration RAISES the deep-lag bar to 2 × the tier, it never removes it", () => {
    // The bar is `2 × max(p90Gap, tier)`, and with a p90 well under the tier it is 2 × the TIER.
    // DERIVED, never typed (threshold single-touch-point): the weekly tier moved 9 → 5 on 2026-09-09
    // when it became a PUBLICATION-SLOT count, and a hand-typed 18 here rotted silently into a
    // DEEP-LAG. `p90Gap` is pinned below the tier so `max` really does pick the tier.
    const P90 = 3;
    const BAR = 2 * Math.max(P90, LAG_THRESHOLDS.weekly);
    expect(P90).toBeLessThan(LAG_THRESHOLDS.weekly); // else the bar is the p90's and this tests nothing
    // The `cut` is deliberately NOT the floor: a cut-floored bar would be `2 × cut` and red the
    // second line, so the cut is set clear of the tier in the other direction.
    const CUT = LAG_THRESHOLDS.weekly + 6;
    expect(classify({ gaps: MIN_GAPS, age: BAR, cut: CUT, registered: "weekly", p90Gap: P90, explicit: true })).not.toBe(
      "DEEP-LAG",
    );
    expect(classify({ gaps: MIN_GAPS, age: BAR + 1, cut: CUT, registered: "weekly", p90Gap: P90, explicit: true })).toBe("DEEP-LAG");
  });

  it("the explicit arm can only RAISE the bar: a p90 already past the tier keeps the strict form", () => {
    // p90 7 > daily tier 3, so `max` must pick the p90 — rot at 15, not at 7. A tier-only explicit
    // arm (no `Math.max`) would call age 14 DEEP-LAG and red the second line.
    expect(classify({ gaps: MIN_GAPS, age: 15, cut: daily, registered: "daily", p90Gap: 7, explicit: true })).toBe(
      "DEEP-LAG",
    );
    expect(
      classify({ gaps: MIN_GAPS, age: 14, cut: daily, registered: "daily", p90Gap: 7, explicit: true }),
    ).not.toBe("DEEP-LAG");
  });

  it("MISCADENCED: past the registry cut but inside the feed's own rhythm", () => {
    // weekly-publishing feed registered daily: cut 3, own p90 7, age 6.
    expect(classify({ gaps: MIN_GAPS, age: 6, cut: daily, registered: "daily", p90Gap: 7, explicit: false })).toBe(
      "MISCADENCED",
    );
  });

  it("LATE: past both the cut and the own p90, but below the rot multiple", () => {
    expect(classify({ gaps: MIN_GAPS, age: 8, cut: daily, registered: "daily", p90Gap: 7, explicit: false })).toBe(
      "LAG",
    );
  });

  // The ladder is cut-agnostic: `classify` takes `cut` as an argument and always has, so this case
  // pins the BOUNDARY (a row that is FRESH at 11 and LATE at 9), NOT E7 Stage 3.6 — that stage changed
  // only which number `lagRowFor` feeds in, and its falsifier is the `registered`/`cut` disagreement
  // case in the `lagRowFor` block below. Fixture: a holiday-slipped H.10 week, age 10 against p90 9.
  it("the cut argument decides FRESH vs LATE at the H.10 boundary (11 vs the weekly tier 9)", () => {
    // Specimen is G1 (WTI oil — genuinely weekly-11: EIA weekly-Wednesday release over a daily grid).
    // F9 left the H.10 feed for daily `USDU` 2026-08-10, so it no longer sits at this boundary.
    const g1Cut = lagCutFor(ALL_INDICATORS.find((i) => i.id === "G1")!);
    expect(g1Cut).toBe(11); // out-of-band: the ruled value, not re-derived from the row under test
    // `registered` is held FIXED at weekly across the pair, so the only thing that moves is the
    // `cut` argument — the DEEP-LAG floor (max(p90 9, tier 9) × 2 = 18) is identical on both lines.
    expect(classify({ gaps: MIN_GAPS, age: 10, cut: g1Cut, registered: "weekly", p90Gap: 9, explicit: true })).toBe(
      "FRESH",
    );
    // The contrast that makes the pin non-vacuous: the tier cut labels the same row LATE.
    expect(classify({ gaps: MIN_GAPS, age: 10, cut: weekly, registered: "weekly", p90Gap: 9, explicit: true })).toBe(
      "LAG",
    );
  });
});

describe("lagRowFor — the per-id row build shared by the probe and `/lab`'s stage-2 read", () => {
  it("NO-DATA on a served id the store has never heard of", () => {
    const r = lagRowFor({
      id: "F9",
      registered: "weekly",
      cut: LAG_THRESHOLDS.weekly,
      explicit: true,
      dates: [],
      today: "2026-07-26",
    });
    expect(r.label).toBe("NO-DATA");
    expect(r.age).toBe(Number.POSITIVE_INFINITY); // never a fabricated 0 — `/lab` serves it as null
    expect(r.gaps).toBe(0);
    expect(r.newest).toBe("-");
    // No observations ⇒ no implied correction: the row echoes the REGISTERED cadence rather than
    // inventing a tier from a p90 of 0 (which would read `daily` and propose a fining correction).
    expect(r.impliedCadence).toBe("weekly");
    expect(r.cut).toBe(LAG_THRESHOLDS.weekly);
  });

  it("gaps are between DISTINCT dates, taken in date order however the store returned them", () => {
    // Ten weekly observations, shuffled, with one re-published day. A re-publish is not a new
    // release, so it must NOT contribute a 0-gap, and the order must not contribute negatives.
    const weekly = [
      "2026-06-07", "2026-05-03", "2026-07-05", "2026-05-17", "2026-06-21",
      "2026-05-10", "2026-06-28", "2026-05-31", "2026-06-14", "2026-05-24",
      "2026-06-07", // duplicate
    ];
    const r = lagRowFor({
      id: "EBP",
      registered: "weekly",
      cut: LAG_THRESHOLDS.weekly,
      explicit: true,
      dates: weekly,
      today: "2026-07-19",
    });
    expect(r.gaps).toBe(9); // 10 distinct dates ⇒ 9 gaps; a surviving duplicate would make it 10
    expect(r.medianGap).toBe(7);
    expect(r.p90Gap).toBe(7);
    expect(r.newest).toBe("2026-07-05");
    expect(r.age).toBe(14);
    expect(r.impliedCadence).toBe("weekly");
    // age 14 > weekly cut 9 and > its own p90 7, but inside the explicit bar
    // (max(p90 7, weekly tier 9) × DEEP_LAG_MULTIPLE = 18) — behind, not dark.
    expect(r.label).toBe("LAG");
  });

  // E7 Stage 3.6 (ruled R4) — THE falsifier for the stage. `registered` and `cut` are made to
  // DISAGREE: a `weekly` row (tier 9) carrying the ruled H.10 override cut of 11. The pre-3.6 form
  // read `LAG_THRESHOLDS[registered]` internally and would score this row at 9 ⇒ age 10 > 9 and
  // > its own p90 9 ⇒ `LATE` on the /lab board, while the notify line stayed quiet at 11. Every
  // other `lagRowFor` case passes `cut: LAG_THRESHOLDS[registered]`, so only this one can tell the
  // argument from the tier. Red-demoed by restoring the internal lookup (both assertions go red).
  it("finding 2: the row is classified against the CUT ARGUMENT, not the registered tier", () => {
    // Nine gaps (≥ MIN_GAPS) of 7d with two 9d slips ⇒ p90Gap 9; today is 10d past the newest.
    // Specimen is G1 (genuinely weekly-11: EIA weekly-Wednesday over a daily grid) — F9 left the
    // H.10 feed for daily `USDU` 2026-08-10 and no longer carries the override.
    const r = lagRowFor({
      id: "G1",
      registered: "weekly", // tier cut 9
      cut: 11, // the ruled per-indicator `lagAfterDays` (lagCutFor(G1))
      explicit: true, // G1 carries both a `cadence` key and a `lagAfterDays` (E7 §Stage 4 fork)
      dates: [
        "2026-05-01", "2026-05-08", "2026-05-17", "2026-05-24", "2026-05-31",
        "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30", "2026-07-07",
      ],
      today: "2026-07-17",
    });
    expect(r.p90Gap).toBe(9);
    expect(r.age).toBe(10);
    // The BEHAVIOURAL witness first, so a red demo lands on the label rather than being masked by
    // the echo assertion below it (testing-project.md §Every new assertion owes a
    // mutate-and-confirm-red demonstration).
    expect(r.label).toBe("FRESH"); // under the tier this identical row reads LATE
    expect(r.cut).toBe(11); // the argument is echoed, never re-derived from `registered`
    // Out-of-band: the tier the row is NOT scored against. Asserted as a RELATION, not a literal —
    // the weekly tier's value moved on 2026-09-09 (9 calendar days → 5 publication slots) and what
    // this line has to establish is only that the argument and the tier DIFFER, so echoing the tier
    // instead of the argument would be visible.
    expect(LAG_THRESHOLDS.weekly).not.toBe(r.cut);
    expect(r.age).toBeGreaterThan(LAG_THRESHOLDS.weekly); // under the tier this row would read LATE
  });
});

describe("lagTier — the two-tier paint rule, all three outcomes", () => {
  // UNKNOWN must not be invented into a mark
  it.each([
    ["DEEP-LAG", "deep"], ["NO-DATA", "deep"],
    ["MISCADENCED", "soft"], ["LAG", "soft"],
    ["FRESH", null], ["UNKNOWN", null],
  ] as const)("%s → %s", (label, tier) => {
    expect(lagTier(label)).toBe(tier);
  });
});

describe("impliedCadenceFor — the FINEST covering tier", () => {
  it("returns the first tier whose threshold covers the gap", () => {
    expect(impliedCadenceFor(3)).toBe("daily");
    expect(impliedCadenceFor(4)).toBe("weekly");
    expect(impliedCadenceFor(9)).toBe("weekly");
    expect(impliedCadenceFor(10)).toBe("monthly");
    expect(impliedCadenceFor(999)).toBe("quarterly");
  });
});

describe("shouldCorrect — coarsening needs the MEDIAN too (§I8.3)", () => {
  it("withholds a coarsening a single holiday week in the p90 would have proposed", () => {
    // daily feed, p90 stretched to 4d over one long week, median still 1d.
    expect(
      shouldCorrect({ registered: "daily", impliedCadence: "weekly", medianGap: 1, label: "LAG", explicit: false }),
    ).toBe(false);
  });

  it("proposes a coarsening once the MEDIAN has left the finer tier", () => {
    expect(
      shouldCorrect({ registered: "daily", impliedCadence: "weekly", medianGap: 7, label: "LAG", explicit: false }),
    ).toBe(true);
  });

  it("proposes a FINING correction for an id the registry never asserted a rhythm for", () => {
    expect(
      shouldCorrect({ registered: "weekly", impliedCadence: "daily", medianGap: 1, label: "DEEP-LAG", explicit: false }),
    ).toBe(true);
  });

  // E7 §Stage 4 fork. The two rows are IDENTICAL but for `explicit` — the only shape that separates
  // "the registry asserted this rhythm" from the old blanket "fining is always safe". This is exactly
  // the `weekly → daily` line the prod probe printed for F9/F11/G1/BRENT/FXH, advising a revert of the
  // registration E7 had just ruled. Deleting the `if (r.explicit) return false;` guard reds the first
  // line and leaves the second green.
  it("withholds any correction for an EXPLICITLY registered id, fining included", () => {
    const row = { registered: "weekly", impliedCadence: "daily", medianGap: 1, label: "DEEP-LAG" } as const;
    expect(shouldCorrect({ ...row, explicit: true })).toBe(false);
    expect(shouldCorrect({ ...row, explicit: false })).toBe(true);
  });

  it("never proposes anything for an unclassified row", () => {
    for (const label of ["UNKNOWN", "NO-DATA"] as const)
      expect(
        shouldCorrect({ registered: "weekly", impliedCadence: "daily", medianGap: 1, label, explicit: false }),
      ).toBe(false);
  });
});

describe("assertNonVacuous — every guard must be ABLE to fire", () => {
  /** The healthy census: mixed FRESH/non-FRESH, with a classified non-daily row. */
  const healthy: Row[] = [
    row({ label: "FRESH" }),
    row({ label: "DEEP-LAG", id: "R" }),
    row({ label: "LAG", id: "EBP", registered: "monthly" }),
  ];

  it("passes on a mixed census", () => {
    expect(() => assertNonVacuous(healthy)).not.toThrow();
  });

  it("guard (b) fires when nothing is classifiable", () => {
    expect(() => assertNonVacuous([row({ label: "UNKNOWN" }), row({ label: "NO-DATA" })])).toThrow(/guard \(b\)/);
  });

  it("guard (a1) fires on an all-stale census (the dev DB)", () => {
    expect(() => assertNonVacuous([row({ label: "DEEP-LAG" }), row({ label: "LAG", registered: "monthly" })])).toThrow(
      /guard \(a1\)/,
    );
  });

  // E7 §Stage 4.7-R1 REVERSED this test: it used to assert that an all-FRESH census THROWS. That
  // outcome guard inverted the moment E7 removed the three false ROTs — every classified prod feed
  // read FRESH and the guard fired on the exact steady state the wave was built to produce, i.e. its
  // green had been load-bearing on the defect beside it. An all-FRESH census is now the GOAL, and
  // discrimination is asserted by guard (a2)'s perturbation instead.
  it("an all-FRESH census is healthy, NOT vacuous — the 4.7-R1 inversion", () => {
    expect(() =>
      assertNonVacuous([row({ label: "FRESH" }), row({ label: "FRESH", registered: "monthly" })]),
    ).not.toThrow();
  });

  // Guard (a2) — the CAPABILITY half. `p90Gap: Infinity` on the strict arm makes the deep-lag bar
  // Infinity, so no perturbed age can ever exceed it and the classifier can no longer reach DEEP-LAG:
  // exactly the "a bar computed as Infinity" failure the outcome form could not see on a healthy
  // census. The first row keeps guard (a1) satisfied so the throw is attributable to (a2).
  it("guard (a2) fires when the classifier cannot reach DEEP-LAG, even on an all-FRESH census", () => {
    const rows: Row[] = [
      row({ label: "FRESH" }),
      row({ label: "FRESH", id: "EBP", registered: "monthly", p90Gap: Number.POSITIVE_INFINITY }),
    ];
    expect(() => assertNonVacuous(rows)).toThrow(/guard \(a2\)/);
    // Non-vacuity: the SAME census with a finite rhythm passes, so the throw is the Infinity bar and
    // not the fixture's shape.
    expect(() =>
      assertNonVacuous([row({ label: "FRESH" }), row({ label: "FRESH", id: "EBP", registered: "monthly" })]),
    ).not.toThrow();
  });

  it("guard (c) fires when the only non-daily rows are UNKNOWN/NO-DATA — the near-vacuous form passed here", () => {
    const rows: Row[] = [
      row({ label: "FRESH" }),
      row({ label: "DEEP-LAG", id: "R" }),
      row({ label: "UNKNOWN", id: "EBP", registered: "monthly" }),
      row({ label: "NO-DATA", id: "Q", registered: "quarterly" }),
    ];
    // The registry-based form (`rows.some(r => r.registered !== "daily")`) would NOT throw here.
    expect(rows.some((r) => r.registered !== "daily")).toBe(true);
    expect(() => assertNonVacuous(rows)).toThrow(/guard \(c\)/);
  });
});
