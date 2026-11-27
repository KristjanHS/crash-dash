/**
 * Exposure engine (E1 Stage 1) — mechanics only, per the one-sided-verifiability
 * caveat: these pin percentile/ROC arithmetic, guards, OR semantics, posture
 * mapping, and notify decisions — never the tuning of the provisional constants.
 */

import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "./store.js";
import {
  ARM_LEVEL_PCT,
  ARM_MIN_OBS,
  ARM_RANGE_WINDOW,
  ARM_RELEASE_PCT,
  ARM_ROC_APPROACH_BP,
  ARM_ROC_BP,
  ARM_ROC_WINDOW,
  COMPOUND_RISK_FLOOR,
  EQUITY_PCT,
  FIRE_MA_APPROACH_SPREAD,
  POSTURE_RELAX_ORDER,
  effectiveEquityRisk,
  resolveCompoundFloor,
  resolveOverlayStepDown,
  computeExposure,
  decideExposureNotify,
  type ExposureResult,
  type Posture,
} from "./exposure.js";
import { resolveCash, resolvePersistedCashLevel } from "./cash-overlay.js";
import { R4_RESTING } from "./r4.js";
import { LADDER } from "./families.js";
// The push comparator's bound lives on the run path (it needs the persisted rung + cash columns
// `computeExposure` is blind to); its pins live HERE, beside the posture fixtures they need.
import { boundExposureForPush, exposurePushPair, type ExposureBoundRow } from "./run-cycle.js";
import { GT } from "./registry-composite.js";
import { resolvedDerivedBands } from "./scorers-core.js";

/** Synthetic oldest→newest series; values[i] → sequential fake dates. */
function series(values: number[], decision?: (v: number) => number | null): SeriesPoint[] {
  return values.map((value, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
    value,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
    ...(decision ? { decision: decision(value) } : {}),
  }));
}

/**
 * Step between the rank-ramp base's values. Small enough that a whole
 * ARM_ROC_WINDOW-long move along the ramp stays far under ARM_ROC_BP, so a
 * f1WithRankCount fixture exercises the LEVEL leg with the ROC leg provably quiet.
 */
const RANK_STEP = 0.001;

/** ARM_MIN_OBS DISTINCT ascending values — distinct so every rank is reachable. */
function rankRamp(): number[] {
  return Array.from({ length: ARM_MIN_OBS }, (_, i) => i * RANK_STEP);
}

/**
 * A close ranking far BELOW ARM_RELEASE_PCT, inserted between the ramp and the latest.
 *
 * ⚠ Load-bearing since K4: the ramp's own top close is the max of its window ⇒ rank 1.0
 * ⇒ RAW-armed. Without this break the latch would carry that arming forward and every
 * level-leg fixture below would report armed=true regardless of where the latest sits,
 * silently destroying their ability to pin the ARM_LEVEL_PCT edge. Breaking the latch
 * here is what keeps those tests observing the RAW rule. The latch itself is pinned
 * separately, in "ARM latch (K4 hysteresis)".
 */
const LATCH_BREAK = -1;

/** Window size the rank fixtures produce: the ramp, the latch break, and one latest point. */
const RANK_WINDOW = ARM_MIN_OBS + 2;

/**
 * F1 whose LATEST value has percentile rank exactly `k / RANK_WINDOW`: the ramp
 * base plus the latch break plus a latest placed so exactly `k` of the window's
 * values (itself included) are ≤ it. Lets a test target a rank relative to
 * ARM_LEVEL_PCT without hard-coding the cut's value.
 */
function f1WithRankCount(k: number): SeriesPoint[] {
  return series([...rankRamp(), LATCH_BREAK, (k - 2.5) * RANK_STEP]);
}

/** F1 whose level leg is maxed out: latest above the whole ramp → rank 1.0. */
function armedF1(): SeriesPoint[] {
  return f1WithRankCount(RANK_WINDOW);
}

/** Plateau the ROC fixtures measure from. */
const ROC_PLATEAU = 1.0;

/**
 * F1 whose 30d ROC is exactly `roc` while the LEVEL leg is provably quiet: a HIGH
 * distinct ramp base (so the low tail ranks near the window's bottom), then a flat
 * plateau spanning the ROC window, then the latest at plateau + roc.
 */
function f1WithRoc(roc: number): SeriesPoint[] {
  const base = Array.from({ length: ARM_MIN_OBS }, (_, i) => 100 + i);
  const plateau = Array<number>(ARM_ROC_WINDOW).fill(ROC_PLATEAU);
  return series([...base, ...plateau, ROC_PLATEAU + roc]);
}

/** Calm F1: latest near the bottom of the distribution, zero ROC → neither leg moves. */
function calmF1(): SeriesPoint[] {
  return f1WithRoc(0);
}

/** GT's RESOLVED amber cut — the band FIRE consumes (CORE-B4). Derived, never restated. */
const GT_CUT = resolvedDerivedBands(GT).amber!;
const gtAbove = series([100], () => 5); // cushion far clear of GT's cut → GREEN → intact
const gtBroken = series([100], () => -1); // below GT's red → fired
const gtApproaching = series([100], () => GT_CUT + FIRE_MA_APPROACH_SPREAD);
const RUNGS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

describe("ARM level percentile rank", () => {
  /** Smallest rank COUNT whose rank k/RANK_WINDOW reaches the cut — derived, never hard-coded. */
  const kAtCut = Math.ceil(ARM_LEVEL_PCT * RANK_WINDOW);

  it("arms when the latest value's rank reaches ARM_LEVEL_PCT, not one rank below", () => {
    const at = computeExposure(f1WithRankCount(kAtCut), gtAbove).arm;
    expect(at.percentile).toBeGreaterThanOrEqual(ARM_LEVEL_PCT);
    expect(at.roc!).toBeLessThan(ARM_ROC_BP); // the LEVEL leg alone armed it, not ROC
    expect(at.armed).toBe(true);

    const under = computeExposure(f1WithRankCount(kAtCut - 1), gtAbove).arm;
    expect(under.percentile).toBeLessThan(ARM_LEVEL_PCT);
    expect(under.armed).toBe(false);
  });

  it("ranks against the DISTRIBUTION, not the min/max span: a lone outlier max cannot suppress arming", () => {
    // CORE-B5 regression: one 2020-style spike sitting in the trailing window pinned
    // `max` and dragged the old (latest-min)/(max-min) position toward 0 for two years.
    const OUTLIER = 100;
    const ramp = rankRamp().slice(0, ARM_MIN_OBS - 1);
    const latest = ramp[ramp.length - 1]! + RANK_STEP; // just above the whole ramp
    const arm = computeExposure(series([OUTLIER, ...ramp, latest]), gtAbove).arm;

    const rangePosition = (arm.level! - 0) / (OUTLIER - 0); // what the OLD measure computed
    expect(rangePosition).toBeLessThan(ARM_LEVEL_PCT); // old measure: would NOT have armed
    expect(arm.percentile).toBeGreaterThanOrEqual(ARM_LEVEL_PCT);
    expect(arm.roc!).toBeLessThan(ARM_ROC_BP); // level leg only
    expect(arm.armed).toBe(true);
  });

  it("flat window → percentile null, level leg not armed (stale-feed tell, not a math guard)", () => {
    const flat = series(Array(ARM_MIN_OBS).fill(1.0) as number[]);
    const r = computeExposure(flat, gtAbove);
    expect(r.arm.percentile).toBeNull();
    expect(r.arm.degraded).toBe(false); // enough obs — it is the flatness, not the count
    expect(r.arm.armed).toBe(false);
    expect(r.summary).toContain("flat window");
  });
});

/**
 * F1 = the rank ramp, then one RAW-ARMED close (above the whole ramp ⇒ rank 1.0),
 * then one close placed so exactly `k` of its trailing window rank ≤ it. With that rank
 * below ARM_LEVEL_PCT the head is not raw-armed, so ARM can only still be on via the
 * latch — that gap is what these fixtures exist to expose.
 */
function f1LatchedThen(k: number): SeriesPoint[] {
  const ramp = rankRamp();
  const rawArmedDay = ARM_MIN_OBS * RANK_STEP; // above the whole ramp → rank 1.0
  // Exactly `k` of the window's values are ≤ the hold value: (k-1) ramp values, plus
  // itself. The raw-armed close sits above it and is never counted.
  const holdValue = (k - 1.5) * RANK_STEP;
  return series([...ramp, rawArmedDay, holdValue]);
}

/** Window size `f1LatchedThen(k)` produces ⇒ its head's rank is exactly `k / LATCHED_WINDOW`. */
const LATCHED_WINDOW = ARM_MIN_OBS + 2;

/** Rank COUNT whose rank is closest to `targetRank` — lets a test aim inside the deadband. */
function latchedCountFor(targetRank: number): number {
  return Math.round(targetRank * LATCHED_WINDOW);
}

/**
 * The middle of the `[ARM_RELEASE_PCT, ARM_LEVEL_PCT)` deadband — the regime where the head
 * holds the latch but does NOT raw-arm, which is the only regime the latch fixtures can prove
 * anything in. DERIVED, never typed: the 2026-07-31 tighten (0.60 → 0.80) narrowed the band from
 * 0.25 wide to 0.05 and put the previously hand-typed 0.7 target OUTSIDE it, silently turning
 * "holds inside the deadband" into "releases". Each fixture using it still asserts both edges.
 */
const DEADBAND_MID = (ARM_RELEASE_PCT + ARM_LEVEL_PCT) / 2;

/**
 * Latched fixture whose head rank is EXACTLY `ARM_RELEASE_PCT` (+ `offsetRanks` steps).
 *
 * ⚠ Why a bespoke window size: ranks are `k / total` for integer k, so a `>=` vs `>`
 * mutation at the cut is observable ONLY when the cut is exactly representable. At
 * LATCHED_WINDOW = 254, `0.80 × 254 = 203.2` — no k lands on the cut, every fixture sits
 * strictly to one side, and flipping the comparison changes nothing. 255 divides by 5, so
 * k = 204 gives exactly 0.80 and the edge becomes testable. (Same argument held at the
 * pre-2026-07-31 cut: `0.60 × 254 = 152.4` missed, `0.60 × 255 = 153` landed.)
 */
function f1LatchedAtReleaseCut(offsetRanks = 0): SeriesPoint[] {
  const TOTAL = 255;
  const rampLen = TOTAL - 2; // + the raw-armed close + the hold close
  const ramp = Array.from({ length: rampLen }, (_, i) => i * RANK_STEP);
  // The docblock's "exactly representable" argument, promoted from prose to code: it holds at 0.80
  // (204/255) and held at the old 0.60 (153/255), but fails at e.g. 0.75 or 0.9 — and it fails
  // SILENTLY, leaving every fixture strictly to one side of the cut so a `>=`→`>` mutation stays green.
  const kAtCut = ARM_RELEASE_PCT * TOTAL;
  if (!Number.isInteger(kAtCut)) {
    throw new Error(
      `f1LatchedAtReleaseCut: ARM_RELEASE_PCT (${ARM_RELEASE_PCT}) × TOTAL (${TOTAL}) = ${kAtCut}, ` +
        `not an integer - no rank count lands EXACTLY on the release cut, so this fixture can no ` +
        `longer pin the cut's inclusivity. Re-pick the bespoke TOTAL so the cut is exactly ` +
        `representable (TOTAL must be a multiple of the cut's denominator).`,
    );
  }
  const k = kAtCut + offsetRanks;
  return series([...ramp, rampLen * RANK_STEP, (k - 1.5) * RANK_STEP]);
}

describe("ARM latch (K4 hysteresis)", () => {
  it("holds ARM on while the rank stays at/above ARM_RELEASE_PCT, where the RAW rule alone would release", () => {
    const arm = computeExposure(f1LatchedThen(latchedCountFor(DEADBAND_MID)), gtAbove).arm;
    // The regime that makes this test non-vacuous: the head sits INSIDE the deadband,
    // so pre-latch code returns armed=false on exactly this input.
    expect(arm.percentile!).toBeGreaterThanOrEqual(ARM_RELEASE_PCT);
    expect(arm.percentile!).toBeLessThan(ARM_LEVEL_PCT);
    expect(arm.roc!).toBeLessThan(ARM_ROC_BP);
    expect(arm.armed).toBe(true); // ← only the latch can produce this
  });

  it("holds AT the release cut and releases ONE RANK below it - the cut is inclusive", () => {
    // The cut EDGE, mirroring "arms when the rank reaches ARM_LEVEL_PCT, not one rank
    // below" for the level leg. Without this, flipping the hold test's `<` to `<=`
    // (i.e. redefining the documented "at or above this" as strictly-above) stays green:
    // the other latch fixtures sit far from the cut and cannot see a one-rank shift.
    const at = computeExposure(f1LatchedAtReleaseCut(), gtAbove).arm;
    expect(at.percentile).toBe(ARM_RELEASE_PCT); // EXACTLY on the cut — the only observable edge
    expect(at.armed).toBe(true);

    const below = computeExposure(f1LatchedAtReleaseCut(-1), gtAbove).arm;
    expect(below.percentile!).toBeLessThan(ARM_RELEASE_PCT);
    expect(below.armed).toBe(false);
  });

  it("keeps a raw-armed day armed and never fabricates one the raw rule did not produce", () => {
    expect(computeExposure(armedF1(), gtAbove).arm.armed).toBe(true); // raw-armed stays armed
    const calm = computeExposure(calmF1(), gtAbove).arm;
    expect(calm.percentile!).toBeLessThan(ARM_RELEASE_PCT); // never held ⇒ nothing to latch
    expect(calm.armed).toBe(false);
  });

  it("a flat window BREAKS the latch (stale-feed tell - the hold term is false, not true)", () => {
    // A full trailing window of one repeated value after a raw-armed close: percentile
    // is null by deliberate design, so the latch cannot carry across it and ARM falls
    // back to raw. Mirrors the head's refusal to arm at rank 1.0 on non-data.
    const flatRun = Array<number>(ARM_RANGE_WINDOW).fill(0.5) as number[];
    const arm = computeExposure(series([...rankRamp(), ARM_MIN_OBS * RANK_STEP, ...flatRun]), gtAbove).arm;
    expect(arm.percentile).toBeNull();
    expect(arm.degraded).toBe(false); // plenty of obs — it is the flatness that breaks it
    expect(arm.armed).toBe(false);
  });

  it("seeds FALSE across the degraded prefix - indices below ARM_MIN_OBS are not evaluable", () => {
    // Exactly ARM_MIN_OBS points: the head holds above the release cut, but there is no
    // evaluable prior close for the scan to step back to, so the latch cannot seed true.
    const holdValue = (Math.round(DEADBAND_MID * ARM_MIN_OBS) - 0.5) * RANK_STEP;
    const arm = computeExposure(series([...rankRamp().slice(0, ARM_MIN_OBS - 1), holdValue]), gtAbove).arm;
    expect(arm.degraded).toBe(false);
    expect(arm.percentile!).toBeGreaterThanOrEqual(ARM_RELEASE_PCT); // the hold term IS satisfied
    expect(arm.armed).toBe(false); // …but nothing evaluable behind it
  });

});

describe("ARM widening ROC", () => {
  it("arms at +ARM_ROC_BP over the ROC window, not just under", () => {
    const r = computeExposure(f1WithRoc(ARM_ROC_BP), gtAbove);
    expect(r.arm.roc).toBeCloseTo(ARM_ROC_BP);
    expect(r.arm.percentile).toBeLessThan(ARM_LEVEL_PCT); // the ROC leg alone armed it
    expect(r.arm.armed).toBe(true);

    expect(computeExposure(f1WithRoc(ARM_ROC_BP - 0.01), gtAbove).arm.armed).toBe(false);
  });
});

describe("ARM guards", () => {
  it("degrades below ARM_MIN_OBS points", () => {
    const short = series(Array(ARM_MIN_OBS - 1).fill(1.0) as number[]);
    const r = computeExposure(short, gtAbove);
    expect(r.arm.degraded).toBe(true);
    expect(r.arm.armed).toBe(false);
    expect(r.posture).toBeNull();
  });

  it("degrades on empty F1 with null fields", () => {
    const r = computeExposure([], gtAbove);
    expect(r.arm).toEqual({
      armed: false,
      approaching: false,
      degraded: true,
      level: null,
      percentile: null,
      roc: null,
      asOf: null,
    });
    expect(r.posture).toBeNull();
  });
});

describe("FIRE", () => {
  // CORE-B4: FIRE consumes GT's resolved band, so the discriminating fixture is a POSITIVE
  // cushion just under that cut — fired under the new contract, NOT fired under the old
  // `maSpread <= 0`. The two ≤0 cases stay: they fire under both, and pin the RED end.
  // CORE-B6 (row 18) then made the cut itself INCLUSIVE — the ON-the-cut and just-ABOVE-the-cut
  // pair below is what separates that convention from both its predecessor and an unbounded edge.
  it("fires on GT's resolved band, inclusive of the cut, with a POSITIVE cushion below it", () => {
    expect(computeExposure(calmF1(), series([100], () => GT_CUT - 0.001)).fire.fired).toBe(true);
    // Row 18 (CORE-B6) made the LOW branch's amber comparison
    // INCLUSIVE, so a decision variable sitting exactly ON the cut now fires — it used to read
    // GREEN here while the same value on the RED cut read RED. This line is the pin that
    // OVERTURNED, and it is the only fixture in this file that discriminates the two
    // conventions: every other case sits strictly on one side. Keep it exactly on the cut.
    expect(computeExposure(calmF1(), series([100], () => GT_CUT)).fire.fired).toBe(true);
    // Just ABOVE the cut is the new non-firing edge — without this the inclusive rule is
    // indistinguishable from "the low edge never bounds at all".
    expect(computeExposure(calmF1(), series([100], () => GT_CUT + 0.001)).fire.fired).toBe(false);
    expect(computeExposure(calmF1(), gtBroken).fire.fired).toBe(true);
    expect(computeExposure(calmF1(), series([100], () => 0)).fire.fired).toBe(true);
    expect(computeExposure(calmF1(), gtAbove).fire.fired).toBe(false);
  });

  it("degrades on null decision and on empty series - posture null, never a fabricated Core", () => {
    for (const gt of [series([100], () => null), series([100]), []]) {
      const r = computeExposure(calmF1(), gt);
      expect(r.fire.degraded).toBe(true);
      expect(r.fire.fired).toBe(false);
      expect(r.posture).toBeNull();
      expect(r.summary).toContain("insufficient data");
    }
  });
});

describe("approaching tiers (E3 Decision 1 - pre-alert, real cuts untouched)", () => {
  it("ARM approaching at/above +ARM_ROC_APPROACH_BP, not just under, never while armed", () => {
    const at = computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove).arm;
    expect(at.armed).toBe(false);
    expect(at.approaching).toBe(true);
    expect(computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP - 0.01), gtAbove).arm.approaching).toBe(false);
    const armed = computeExposure(f1WithRoc(ARM_ROC_BP), gtAbove).arm;
    expect(armed.armed).toBe(true);
    expect(armed.approaching).toBe(false);
  });

  it("FIRE approaching at/below GT's cut + FIRE_MA_APPROACH_SPREAD, not just above, never while fired", () => {
    const approachCut = GT_CUT + FIRE_MA_APPROACH_SPREAD;
    const at = computeExposure(calmF1(), series([100], () => approachCut)).fire;
    expect(at.fired).toBe(false);
    expect(at.approaching).toBe(true);
    expect(
      computeExposure(calmF1(), series([100], () => approachCut + 0.01)).fire.approaching,
    ).toBe(false);
    const fired = computeExposure(calmF1(), gtBroken).fire;
    expect(fired.fired).toBe(true);
    expect(fired.approaching).toBe(false);
  });

  it("degraded keys are never approaching", () => {
    const r = computeExposure([], series([100], () => null));
    expect(r.arm.approaching).toBe(false);
    expect(r.fire.approaching).toBe(false);
  });

  // W5-b K5 REPLACES the old "approaching leaves the posture untouched (pre-alert only)"
  // contract: approaching is now a real de-risk step, and this is the whole point of Full.
  it("approaching costs the Full -> Core step (K5: this is what delivers 'earlier')", () => {
    expect(computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove).posture).toBe("Core");
    expect(computeExposure(calmF1(), gtAbove).posture).toBe("Full");
  });
});

describe("posture mapping", () => {
  it("0 keys quiet → Full; 0 keys approaching → Core; 1 → Reduced; 2 → Defensive", () => {
    expect(computeExposure(calmF1(), gtAbove).posture).toBe("Full");
    expect(computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove).posture).toBe("Core");
    expect(computeExposure(armedF1(), gtAbove).posture).toBe("Reduced");
    expect(computeExposure(calmF1(), gtBroken).posture).toBe("Reduced");
    expect(computeExposure(armedF1(), gtBroken).posture).toBe("Defensive");
  });

  it("the Full → Core step fires on EITHER key approaching, alone", () => {
    // Each half must fire on its own — an `&&` bug here would still pass a both-keys fixture.
    expect(computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove).arm.approaching).toBe(true);
    expect(computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove).posture).toBe("Core");

    const fireOnly = computeExposure(calmF1(), gtApproaching);
    expect(fireOnly.arm.approaching).toBe(false);
    expect(fireOnly.fire.approaching).toBe(true);
    expect(fireOnly.posture).toBe("Core");
  });

  it("equityPct is EQUITY_PCT[posture], and null exactly when posture is null", () => {
    for (const r of [
      computeExposure(calmF1(), gtAbove),
      computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove),
      computeExposure(armedF1(), gtAbove),
      computeExposure(armedF1(), gtBroken),
    ]) {
      expect(r.posture).not.toBeNull();
      expect(r.equityPct).toBe(EQUITY_PCT[r.posture!]);
    }

    const degraded = computeExposure([], gtAbove);
    expect(degraded.posture).toBeNull();
    expect(degraded.equityPct).toBeNull();
  });

  it("summary names the posture AND its weight", () => {
    expect(computeExposure(calmF1(), gtAbove).summary).toMatch(
      /credit calm .*; trend clear of GT's cut -> Full \(100% equity\)/,
    );
    expect(computeExposure([], gtAbove).summary).toMatch(/-> insufficient data$/);
  });
});

describe("decideExposureNotify", () => {
  const full = computeExposure(calmF1(), gtAbove);
  const reduced = computeExposure(calmF1(), gtBroken);
  const degraded = computeExposure([], gtAbove);

  it("pushes on non-null → non-null change, ASCII title + summary body", () => {
    const n = decideExposureNotify(reduced, full);
    expect(n.push).toBe(true);
    expect(n.message?.title).toBe("Exposure: Full -> Reduced");
    expect(n.message?.body).toBe(reduced.summary);
  });

  it("silent on same posture and on degraded either side", () => {
    expect(decideExposureNotify(full, full).push).toBe(false);
    expect(decideExposureNotify(degraded, full).push).toBe(false);
    expect(decideExposureNotify(full, degraded).push).toBe(false);
    expect(decideExposureNotify(degraded, degraded).push).toBe(false);
  });

  describe("approaching heads-up (low-prio)", () => {
    const fireApproaching = computeExposure(calmF1(), gtApproaching);
    const armApproaching = computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove);

    // ⚠ K5 SHRANK this branch's population, and that is intended, not a regression. From a quiet
    // book an approaching key is now Full -> Core — a posture CHANGE, so the default-priority
    // posture push takes precedence and the priority-2 heads-up never fires. The heads-up
    // survives only where the posture is UNCHANGED, i.e. one key already tripped (keys === 1).
    it("a key approaching from a QUIET book is now a posture push, not a heads-up", () => {
      const fire = decideExposureNotify(fireApproaching, full);
      expect(fire.push).toBe(true);
      expect(fire.message?.title).toBe("Exposure: Full -> Core");
      expect(fire.message?.priority).toBeUndefined();

      const arm = decideExposureNotify(armApproaching, full);
      expect(arm.push).toBe(true);
      expect(arm.message?.title).toBe("Exposure: Full -> Core");
      expect(arm.message?.priority).toBeUndefined();
    });

    it("still pushes priority 2 when a key enters approaching with the OTHER already tripped", () => {
      // The branch's surviving population: FIRE fired (Reduced), ARM enters approaching from
      // quiet. Posture is unchanged, so the heads-up is the only thing that can carry the news.
      const prevFiredQuietArm = computeExposure(calmF1(), gtBroken);
      const currArmApproaching = computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtBroken);
      expect(prevFiredQuietArm.posture).toBe("Reduced");
      expect(currArmApproaching.posture).toBe("Reduced");

      const n = decideExposureNotify(currArmApproaching, prevFiredQuietArm);
      expect(n.push).toBe(true);
      expect(n.message?.title).toBe("Exposure: credit (ARM) approaching");
      expect(n.message?.priority).toBe(2);
    });

    it("silent while approaching PERSISTS (dedup on the enter edge)", () => {
      expect(decideExposureNotify(fireApproaching, fireApproaching).push).toBe(false);
      expect(decideExposureNotify(armApproaching, armApproaching).push).toBe(false);
    });

    it("silent when the key was already TRIPPED (armed -> approaching is a de-escalation, not an enter)", () => {
      // prev: ARM armed + trend intact (Reduced); curr: ARM back to approaching + FIRE fired (still
      // Reduced). Same posture, and neither key ENTERS approaching from quiet — no push. Without the
      // !prev.armed guard this would wrongly push "credit approaching" on the way DOWN from armed.
      const prevArmedIntact = computeExposure(armedF1(), gtAbove);
      const currMixed = computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtBroken);
      expect(prevArmedIntact.posture).toBe("Reduced");
      expect(currMixed.posture).toBe("Reduced");
      expect(decideExposureNotify(currMixed, prevArmedIntact).push).toBe(false);
    });

    it("posture change takes precedence over an approaching enter (default priority)", () => {
      // curr: fired (Reduced) — prev: Full quiet. Even if a key also entered approaching,
      // the posture push wins and carries no low-prio marker.
      const n = decideExposureNotify(reduced, full);
      expect(n.message?.title).toBe("Exposure: Full -> Reduced");
      expect(n.message?.priority).toBeUndefined();
    });
  });
});

/**
 * R8 Stage 1 — the COMPOUND-RISK FLOOR over the full reachable state space (4 postures × 9 rungs).
 *
 * Every expectation below is COMPUTED from `effectiveEquityRisk` and pinned, never hand-copied from
 * the plan's grid: that grid was hand-computed and shipped a wrong cell (`Defensive × r7` read 5.6, is
 * 5.0). What is pinned out-of-band is the SET of blocked cells and the boundary cell's exact value
 * — both of which move the moment `COMPOUND_RISK_FLOOR` does.
 */
describe("compound-risk floor (R8)", () => {
  /** Every (posture, rung) cell with its computed score — the posture × rung table, derived. */
  const cells = POSTURE_RELAX_ORDER.flatMap((posture) =>
    RUNGS.map((rung) => ({ posture, rung, score: effectiveEquityRisk(EQUITY_PCT[posture], rung) })),
  );

  it("blocks exactly the 8 cells the floor was chosen to block", () => {
    expect(cells.length).toBeGreaterThan(0); // vacuity guard
    const blocked = cells.filter((c) => c.score < COMPOUND_RISK_FLOOR).map((c) => `${c.posture}xr${c.rung}`);
    // The pinned membership is the VALUE half — a literal set measured off the ruling, so moving
    // COMPOUND_RISK_FLOOR (or the metric) reds this line rather than tracking silently.
    expect(blocked).toEqual([
      "Defensivexr5", "Defensivexr6", "Defensivexr7", "Defensivexr8", "Defensivexr9",
      "Reducedxr8", "Reducedxr9",
      "Corexr9",
    ]);
  });

  it("passes the boundary cell Defensive x r4 - the comparison is INCLUSIVE", () => {
    const boundary = effectiveEquityRisk(EQUITY_PCT.Defensive, 4);
    // Exact, and exactly ON the floor: 15 × 6 / 9 divides to 10 in IEEE-754, so this fixture really
    // does sit on the cut rather than a hair either side (`docs/claim-verification.md` §4).
    expect(boundary).toBe(10);
    expect(boundary).toBe(COMPOUND_RISK_FLOOR);
    // The whole floor value turns on this: under an exclusive `>` the resolver would step Defensive
    // up to Reduced here and "Defensive stays reachable at rungs 1-4" would silently become 1-3.
    expect(resolveCompoundFloor("Defensive", 4).posture).toBe("Defensive");
    expect(resolveCompoundFloor("Defensive", 4).floorApplied).toBe(false);
  });

  it("resolves every blocked cell UP and leaves every clearing cell alone", () => {
    const resolved = cells.map((c) => ({ ...c, bounded: resolveCompoundFloor(c.posture, c.rung) }));
    const clearing = resolved.filter((c) => c.score >= COMPOUND_RISK_FLOOR);
    const blocked = resolved.filter((c) => c.score < COMPOUND_RISK_FLOOR);
    expect(clearing.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    for (const { posture, rung, bounded } of clearing) {
      expect(bounded.posture, `${posture} x r${rung} must stand`).toBe(posture);
      expect(bounded.floorApplied).toBe(false);
    }
    for (const { posture, rung, bounded } of blocked) {
      expect(bounded.floorApplied, `${posture} x r${rung} must be raised`).toBe(true);
      // Posture is the yielding axis and it only ever moves UP the relax order.
      expect(POSTURE_RELAX_ORDER.indexOf(bounded.posture!)).toBeGreaterThan(
        POSTURE_RELAX_ORDER.indexOf(posture),
      );
    }
    for (const { bounded } of resolved) expect(bounded.equityPct).toBe(EQUITY_PCT[bounded.posture!]);
  });

  // TERMINATION PIN. This is a property OF the value 10, not of the mechanism: a floor above 11.1
  // would leave `Full x r9` (the most permissive cell there is) unresolvable with nowhere to step,
  // and that must red a test rather than ship an unresolvable state.
  it("every cell reaches a CLEARING posture at or before Full", () => {
    for (const { posture, rung } of cells) {
      const bounded = resolveCompoundFloor(posture, rung);
      expect(bounded.score, `${posture} x r${rung} did not terminate below Full`).toBeGreaterThanOrEqual(
        COMPOUND_RISK_FLOOR,
      );
    }
  });

  it("propagates a degraded posture and a rung-blind hold instead of fabricating a weight", () => {
    expect(resolveCompoundFloor(null, 9)).toEqual({ posture: null, equityPct: null, score: null, floorApplied: false });
    const blind = resolveCompoundFloor("Defensive", null);
    expect(blind.posture).toBe("Defensive"); // no rung ⇒ the floor cannot be evaluated ⇒ raw passes through
    expect(blind.equityPct).toBe(EQUITY_PCT.Defensive);
  });
});

/**
 * R8 Stage 2 — the OVERLAY STEP-DOWN over the WHOLE reachable state space: every (posture × rung) cell
 * × {overlay fired, not fired}. The space is finite and fully enumerable, so this table
 * IS the verification — no backtest is owed (round-3 ruling).
 *
 * Every expectation is COMPUTED — from `EQUITY_PCT`, `COMPOUND_RISK_FLOOR` and the ruled composition
 * — never hand-copied from the plan's grid, whose hand-computed version already shipped a wrong cell. The VALUE
 * half is pinned out-of-band by the literal stepped-cell membership and the literal breach below.
 *
 * `oracleFinalPosture` re-states the composition WITHOUT calling the resolvers (relax up while the
 * floor binds; then, if a `partial` is published at a zero-standing posture, one tier down and NO
 * re-clamp), so deleting either mechanism, or flipping the floor's `>=` to `>`, disagrees with it.
 * ⚠ It is not an INDEPENDENT derivation: it re-implements the loop off the same `EQUITY_PCT` /
 * `effectiveEquityRisk` / `POSTURE_RELAX_ORDER`, so a shared MISREADING of the ruled composition
 * passes both. It catches mechanism deletion and edge flips, not a wrong reading of the ruling.
 */
describe("R8 Stage 2 - the overlay step-down (72 states)", () => {
  const ORDER = POSTURE_RELAX_ORDER;

  function oracleFinalPosture(raw: Posture, rung: number, fired: boolean): Posture {
    let i = ORDER.indexOf(raw);
    while (i < ORDER.length - 1 && effectiveEquityRisk(EQUITY_PCT[ORDER[i]!], rung) < COMPOUND_RISK_FLOOR) i++;
    const floored = ORDER[i]!;
    // The step-down: only on a published `partial`, only where the standing would be zero.
    return fired && 100 - EQUITY_PCT[floored] === 0 ? ORDER[i - 1]! : floored;
  }

  /** The SIZING half of the published claim. `resolvePersistedCashLevel` returns the LEVEL alone by
   *  design (its fabricated `reason`/`suppressedBy` are not reconstructible from the persisted
   *  columns), so the standing scalar is read off `resolveCash` directly — the same sizing the run
   *  path performs, with the RESTING R4 these states all assume. */
  const claimAt = (fired: boolean, equityPct: number | null) =>
    resolveCash(
      R4_RESTING,
      {
        level: fired ? "partial" : "off",
        since: null,
        reason: "no acceleration (+0 over 2 closes)",
        nonEquityPct: null,
        recentTargetRungs: [],
      },
      equityPct,
    );

  /** The 72 states, each carried through the SHIPPED composition exactly as both surfaces run it. */
  const states = ORDER.flatMap((raw) =>
    RUNGS.flatMap((rung) =>
      [true, false].map((fired) => {
        const floored = resolveCompoundFloor(raw, rung);
        // Step 1: the level `resolveCash` publishes for the FLOOR-resolved posture. R4 resting, so
        // a fired overlay publishes `partial` and a quiet one `off`.
        const published = resolvePersistedCashLevel("equity", fired ? "partial" : "off", floored.equityPct);
        // Step 2: the step-down keys off that level. Step 3: the claim is re-sized against the
        // posture actually served, which is what the push renders and what `/api/exposure` implies.
        const stepped = resolveOverlayStepDown(floored.posture, published);
        return {
          id: `${raw}xr${rung}${fired ? "+fired" : ""}`,
          raw,
          rung,
          fired,
          floored,
          stepped,
          level: resolvePersistedCashLevel("equity", fired ? "partial" : "off", stepped.equityPct),
          standing: claimAt(fired, stepped.equityPct).nonEquityPct,
          score: effectiveEquityRisk(stepped.equityPct!, rung),
        };
      }),
    ),
  );

  it("resolves every state's final posture, published level and standing", () => {
    for (const s of states) {
      expect(s.stepped.posture, s.id).toBe(oracleFinalPosture(s.raw, s.rung, s.fired));
      expect(s.stepped.equityPct, s.id).toBe(EQUITY_PCT[s.stepped.posture!]);
      // The published level is the OVERLAY's, untouched by the step-down: posture sizes the claim,
      // it never decides whether cash is claimed (DEC-1, the one direction that stays cut).
      expect(s.level, s.id).toBe(s.fired ? "partial" : "off");
      expect(s.standing, s.id).toBe(100 - EQUITY_PCT[s.stepped.posture!]);
    }
  });

  /** THE ROUND-2 FALSIFIER, as a pin: the zero-size `partial` is the defect R8 was opened on. */
  it("no state publishes a `partial` of zero size", () => {
    const partials = states.filter((s) => s.level === "partial");
    expect(partials).toHaveLength(36); // vacuity guard: half the space really does publish partial
    for (const s of partials) {
      expect(s.standing, `${s.id} publishes a partial holding nothing back`).not.toBe(0);
      expect(s.standing, s.id).toBeGreaterThan(0);
    }
  });

  /**
   * The VALUE pin on WHICH states move — a literal membership set measured off the ruling, so
   * widening the step-down (the DECLINED broad reading: "a fired overlay always moves the position")
   * or narrowing it reds this line instead of tracking silently. 12 states: every `Full` row, plus
   * the three rung-9 rows the floor relaxes all the way to `Full`.
   */
  it("steps down in exactly the 12 states where the standing would be zero", () => {
    expect(states.filter((s) => s.stepped.steppedDown).map((s) => s.id)).toEqual([
      "Defensivexr9+fired",
      "Reducedxr9+fired",
      "Corexr9+fired",
      "Fullxr1+fired", "Fullxr2+fired", "Fullxr3+fired", "Fullxr4+fired", "Fullxr5+fired",
      "Fullxr6+fired", "Fullxr7+fired", "Fullxr8+fired", "Fullxr9+fired",
    ]);
    // The overlay is DELIBERATELY INERT below Full — the narrow ruled reading. Nothing that the
    // floor left at Core/Reduced/Defensive may move, however loudly the overlay fires.
    for (const s of states.filter((s) => s.stepped.steppedDown)) {
      expect(s.floored.posture, s.id).toBe("Full");
      expect(s.stepped.posture, s.id).toBe("Core"); // one tier, never two
    }
  });

  /**
   * THE ONE ACCEPTED BREACH, pinned so a future "fix" that re-clamps it reds. `Full × r9` with the
   * overlay fired steps to `Core × r9` = 7.8, a 2.2-point breach of `COMPOUND_RISK_FLOOR` — ruled to
   * STAND, because re-clamping restores the zero-size `partial` the test above forbids (floor-last
   * is unsatisfiable against it).
   *
   * ⚠ One bounded CELL, four raw states reach it: `Full × r9` is also where the floor sends
   * `Core/Reduced/Defensive × r9`. The plan's "conflict set = exactly one cell" counts bounded
   * cells, not raw ones.
   */
  it("accepts the single floor breach at the bounded cell Full x r9", () => {
    const breaches = states.filter((s) => s.score < COMPOUND_RISK_FLOOR);
    expect(breaches.map((s) => s.id)).toEqual([
      "Defensivexr9+fired", "Reducedxr9+fired", "Corexr9+fired", "Fullxr9+fired",
    ]);
    for (const s of breaches) {
      expect(s.floored.posture, s.id).toBe("Full"); // all four are the SAME bounded cell
      expect(s.stepped.posture, s.id).toBe("Core");
      expect(s.rung, s.id).toBe(9);
      // The literal, measured off the ruling: 70 × 1 / 9 = 7.78, 2.2 short of the floor.
      expect(s.score, s.id).toBeCloseTo(7.78, 2);
    }
  });

  /**
   * PRECEDENCE. The step-down keys off the level `resolveCash` PUBLISHES, never off
   * `overlay.level` — so the two states where a fired overlay is outranked or suppressed must move
   * nothing. Both fixtures sit at `Full`, the only posture that CAN step down, so a step-down here
   * would be visible (the suppressor-no-op trap, `.claude/rules/testing-project.md`).
   */
  it("leaves posture alone when R4 outranks or suppresses the fired overlay", () => {
    const at = (phase: "equity" | "cash" | "reentry") =>
      resolvePersistedCashLevel(phase, "partial", EQUITY_PCT.Full);
    // Non-vacuity: the SAME overlay at the SAME posture DOES step down under a resting R4.
    expect(at("equity")).toBe("partial");
    expect(resolveOverlayStepDown("Full", at("equity")).posture).toBe("Core");

    expect(at("cash")).toBe("full"); // R4's terminal cash subsumes the partial
    expect(resolveOverlayStepDown("Full", at("cash")).posture).toBe("Full");
    expect(at("reentry")).toBe("off"); // D8 whipsaw guard suppresses it
    expect(resolveOverlayStepDown("Full", at("reentry")).posture).toBe("Full");
  });

  it("propagates a degraded posture rather than fabricating one", () => {
    expect(resolveOverlayStepDown(null, "partial")).toEqual({
      posture: null,
      equityPct: null,
      steppedDown: false,
    });
  });
});

/**
 * R8 Stage 2 slice 2.2 — the EXPOSURE PUSH comparator, the third R8 surface.
 *
 * `decideExposureNotify` compared RAW postures while `/api/exposure` and the band push served
 * BOUNDED ones. `boundExposureForPush` (run-cycle.ts) puts both sides on the served variable; these
 * pin the three same-close defects R1 enumerated, each with the OLD raw comparison asserted beside
 * it so the fixture provably separates the two behaviours — the discriminating column, not the
 * total (`.claude/rules/testing-project.md` §"A guard's vacuity anchor must not certify the thing
 * it exists to catch").
 *
 * Every expected posture/equity is COMPUTED from `resolveCompoundFloor` / `resolveOverlayStepDown`,
 * never typed — the floor's grid is hand-computed in the plan and shipped a wrong cell.
 */
describe("exposure push comparator (R8 Stage 2.2)", () => {
  /** Raw postures, straight off the engine (each pinned in "posture mapping" above). */
  const rawCore = computeExposure(f1WithRoc(ARM_ROC_APPROACH_BP), gtAbove);
  const rawReduced = computeExposure(calmF1(), gtBroken);
  const rawDefensive = computeExposure(armedF1(), gtBroken);

  /** A persisted-row stand-in: the held sleeve at `rung`, resting R4, overlay off unless named. */
  const rowAt = (rung: number, cashOverlay: "off" | "partial" = "off") => ({
    heldSleeve: LADDER[rung - 1]!,
    r4Phase: "equity" as const,
    cashOverlay,
  });
  const blindRow = { heldSleeve: null, r4Phase: null, cashOverlay: "off" as const };

  // (i) The phone contradicted both bounded surfaces: it rendered the RAW posture and its equity %.
  it("pushes the BOUNDED posture and its equity %, not the raw pair", () => {
    const rung = 5;
    const curr = boundExposureForPush(rawDefensive, rowAt(rung));
    const prev = boundExposureForPush(rawCore, rowAt(rung));
    const expected = resolveCompoundFloor("Defensive", rung);
    const expectedPrev = resolveCompoundFloor("Core", rung);
    // Non-vacuity: the floor MOVED this close's posture, so raw and bounded really do disagree.
    expect(expected.floorApplied).toBe(true);
    expect(expected.posture).not.toBe(rawDefensive.posture);

    const n = decideExposureNotify(curr, prev);
    expect(n.push).toBe(true);
    expect(n.message?.title).toBe(`Exposure: ${expectedPrev.posture} -> ${expected.posture}`);
    expect(n.message?.body).toBe(curr.summary);
    // The body's own sentence carries the SERVED weight — the "(15% equity)" the phone used to read
    // beside a served 100% is exactly the contradiction this closes.
    expect(curr.summary).toContain(`-> ${expected.posture} (${expected.equityPct}% equity)`);
    expect(curr.equityPct).toBe(expected.equityPct);
  });

  // (ii) The phantom push: a raw transition both surfaces bound to the SAME posture.
  it("fires NOTHING for a raw transition that both closes bind to one posture", () => {
    const rung = 9;
    const curr = boundExposureForPush(rawReduced, rowAt(rung));
    const prev = boundExposureForPush(rawDefensive, rowAt(rung));
    // The OLD comparator's behaviour on this very fixture — the push nothing showed. Asserted
    // FIRST so a regression to raw reds on the push claim itself, not on a neighbouring pin.
    expect(decideExposureNotify(rawReduced, rawDefensive).push).toBe(true);
    expect(decideExposureNotify(curr, prev).push).toBe(false);
    const bound = resolveCompoundFloor("Reduced", rung).posture;
    expect(curr.posture).toBe(bound);
    expect(prev.posture).toBe(bound);
  });

  // (iii) The invisible move: a pure RUNG move that flips the bounded posture with raw unchanged.
  it("fires on a pure RUNG move that flips the bounded posture", () => {
    const currRung = 9;
    const prevRung = 8;
    const curr = boundExposureForPush(rawReduced, rowAt(currRung));
    const prev = boundExposureForPush(rawReduced, rowAt(prevRung));
    const expected = resolveCompoundFloor("Reduced", currRung);
    const expectedPrev = resolveCompoundFloor("Reduced", prevRung);
    // Non-vacuity: raw is IDENTICAL on both sides, so only the rung can separate them.
    expect(decideExposureNotify(rawReduced, rawReduced).push).toBe(false);
    expect(expected.posture).not.toBe(expectedPrev.posture);

    const n = decideExposureNotify(curr, prev);
    expect(n.push).toBe(true);
    expect(n.message?.title).toBe(`Exposure: ${expectedPrev.posture} -> ${expected.posture}`);
  });

  // The step-down half of the bound: same order the two shipped surfaces use — floor, then overlay.
  it("applies the overlay step-down AFTER the floor, off the PUBLISHED cash level", () => {
    const rung = 9;
    const floored = resolveCompoundFloor("Reduced", rung);
    const published = resolvePersistedCashLevel("equity", "partial", floored.equityPct);
    const expected = resolveOverlayStepDown(floored.posture, published);
    // Non-vacuity: the floor lifted this cell to the ONE posture the step-down can move.
    expect(published).toBe("partial");
    expect(expected.steppedDown).toBe(true);

    const stepped = boundExposureForPush(rawReduced, rowAt(rung, "partial"));
    expect(stepped.posture).toBe(expected.posture);
    expect(stepped.equityPct).toBe(expected.equityPct);
    expect(stepped.summary).toContain(`-> ${expected.posture} (${expected.equityPct}% equity)`);
    // …and the same close with the overlay OFF stays at the floor's answer.
    expect(boundExposureForPush(rawReduced, rowAt(rung)).posture).toBe(floored.posture);
  });

  it("is the IDENTITY on an absent/sleeveless prior row - rung-blind, never a phantom transition", () => {
    for (const row of [null, blindRow]) {
      const bounded = boundExposureForPush(rawDefensive, row);
      expect(bounded.posture).toBe(rawDefensive.posture);
      expect(bounded.equityPct).toBe(rawDefensive.equityPct);
      expect(bounded.summary).toBe(rawDefensive.summary);
    }
    // A sleeve RENAMED out of LADDER is rung-blind too, never rung 0 (which would bind hardest).
    expect(boundExposureForPush(rawDefensive, { heldSleeve: "Gone", r4Phase: null, cashOverlay: "off" }).posture)
      .toBe(rawDefensive.posture);
  });

  /** What a PREVIOUS run persisted: the state the shipped path stamps on its own alert row. */
  const stateFrom = (raw: ExposureResult, row: ExposureBoundRow | null) => exposurePushPair(raw, row, null).state;

  /**
   * The ASYMMETRIC axis — the mirror image of (ii), and the reason the notify path goes through the
   * PAIR assembler. The per-side identity above is real but insufficient: the comparator reads the
   * DIFFERENCE of two sides, so one rung-blind run is enough to invent a transition. A blind run is
   * NORMAL, not exotic — a dial-less/degraded run persists `heldSleeve: null`.
   */
  it("fires NOTHING when only ONE side was rung-blind - identical state, no phantom", () => {
    // Non-vacuity: the raw axis is SILENT on this fixture (the same market state on both runs), so
    // every push below is manufactured by the bind alone.
    expect(decideExposureNotify(rawDefensive, rawDefensive).push).toBe(false);
    for (const prevRow of [null, blindRow]) {
      // The one-sided bind's behaviour on this very fixture, asserted FIRST so the fixture provably
      // separates the two paths (a regression to a per-side bind reds on the push claim itself).
      const oneSided = decideExposureNotify(
        boundExposureForPush(rawDefensive, rowAt(9)),
        boundExposureForPush(rawDefensive, prevRow),
      );
      expect(oneSided.push).toBe(true);
      expect(oneSided.message?.title).toBe("Exposure: Defensive -> Full");

      const { curr, prev } = exposurePushPair(rawDefensive, rowAt(9), stateFrom(rawDefensive, prevRow));
      expect(decideExposureNotify(curr, prev).push).toBe(false);
      // …because BOTH sides fell back to the raw axis, not just the blind one.
      expect(curr.posture).toBe(rawDefensive.posture);
      expect(prev?.posture).toBe(rawDefensive.posture);
    }
    // This run blind and the STORED side rung-bearing is the same defect reversed.
    const reversed = exposurePushPair(rawDefensive, null, stateFrom(rawDefensive, rowAt(9)));
    expect(decideExposureNotify(reversed.curr, reversed.prev).push).toBe(false);
    expect(reversed.prev?.posture).toBe(rawDefensive.posture);
  });

  // …and the symmetry gate is not a kill switch: with a rung on BOTH runs the pair binds, so the
  // bounded-only move (iii) still fires through the shipped entry point.
  it("binds both sides when both runs carried a rung", () => {
    const { curr, prev } = exposurePushPair(rawReduced, rowAt(9), stateFrom(rawReduced, rowAt(8)));
    const expected = resolveCompoundFloor("Reduced", 9);
    const expectedPrev = resolveCompoundFloor("Reduced", 8);
    expect(curr.posture).toBe(expected.posture);
    expect(prev?.posture).toBe(expectedPrev.posture);
    expect(decideExposureNotify(curr, prev).message?.title).toBe(
      `Exposure: ${expectedPrev.posture} -> ${expected.posture}`,
    );
  });

  /**
   * THE REPEAT-PUSH FIX (2026-08-09). The prior side is the previous RUN's persisted state, so a run
   * that sees what the run before it saw is silent — however many times it runs, and however long
   * the two feeds sit on the same closes. Prod pushed the identical `Exposure: Core -> Full` on
   * every cron for two days: F1 last printed 2026-08-06 and GT 2026-08-07, and the retired
   * `derivePreviousExposure` prior re-derived "yesterday" by dropping each series' newest point on
   * EVERY run, so the transition sitting on the newest close never aged out of the comparison.
   */
  it("pushes a transition ONCE, then stays silent while the state holds", () => {
    const row = rowAt(5);
    // Non-vacuity: at THIS rung the floor keeps the two closes on different bounded postures, so
    // run 1 is a real move on the served variable (at rung 9 both bind to `Full` and nothing fires).
    expect(resolveCompoundFloor("Core", 5).posture).not.toBe(resolveCompoundFloor("Defensive", 5).posture);
    // Run 1 — the close that moved: Core yesterday, Defensive today. The push the phone should get.
    const moved = exposurePushPair(rawDefensive, row, stateFrom(rawCore, row));
    expect(decideExposureNotify(moved.curr, moved.prev).push).toBe(true);

    // Runs 2..N — same series, same state, re-derived from run 1's persisted state. Silent, and the
    // state it re-persists is byte-identical, so the silence does not decay with run count.
    let carried = moved.state;
    for (let i = 0; i < 3; i++) {
      const again = exposurePushPair(rawDefensive, row, carried);
      expect(decideExposureNotify(again.curr, again.prev).push).toBe(false);
      expect(again.state).toEqual(carried);
      carried = again.state;
    }
    // …and the NEXT genuine move still fires — the dedup is not a mute button.
    const next = exposurePushPair(rawCore, row, carried);
    expect(decideExposureNotify(next.curr, next.prev).push).toBe(true);
  });

  it("is a SILENT establish-only run when no prior state exists", () => {
    const first = exposurePushPair(rawReduced, rowAt(9), null);
    expect(first.prev).toBeNull();
    expect(decideExposureNotify(first.curr, first.prev).push).toBe(false);
    // Non-vacuity: it did not swallow the state — the next run has a baseline to compare against.
    expect(first.state?.posture).toBe(resolveCompoundFloor("Reduced", 9).posture);
    expect(first.state?.rawPosture).toBe("Reduced");
  });

  it("carries the approach EDGE across runs, so a standing approach re-pushes nothing", () => {
    const row = rowAt(9);
    const quiet = computeExposure(calmF1(), gtAbove);
    const approaching = computeExposure(calmF1(), gtApproaching);
    // Non-vacuity: these two fixtures differ ONLY in the fire key's approach flag.
    expect(quiet.fire.approaching).toBe(false);
    expect(approaching.fire.approaching).toBe(true);

    const enters = exposurePushPair(approaching, row, stateFrom(quiet, row));
    expect(decideExposureNotify(enters.curr, enters.prev).push).toBe(true);
    const holds = exposurePushPair(approaching, row, enters.state);
    expect(decideExposureNotify(holds.curr, holds.prev).push).toBe(false);
  });
});
