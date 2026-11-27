import { describe, expect, it } from "vitest";
import {
  VELOCITY_WINDOW,
  type Indicator,
  type Observation,
} from "./domain-types.js";
import {
  evaluateLegs,
  foldFired,
  isVelocityLeg,
  legPhrase,
  winningLeg,
} from "./domain-legs.js";
import {
  rawStateSeries,
  scoredDaySeries,
  velocityDelta,
} from "./domain-fold.js";
import { resolveCuts, type CalibrationCuts } from "./domain-cuts.js";
import { ALL_INDICATORS } from "./registry.js";
import { F1_LOW_RISE_AMBER, F1_LOW_RISE_WINDOW } from "./registry-fred.js";
import {
  alignByDates,
  derivedRawStateSeries,
  resolvedDerivedBands,
  indicatorReadingSeries,
  scoreDerivedDecision,
  trailingReturn,
  trailingReturnAt,
} from "./scorers-core.js";

/**
 * The shared scoring primitives (`velocityDelta`, `trailingReturn`, the derived kinds, the OR-leg
 * fold) at their own layer. `velocityDelta`/`trailingReturn` are the REAL live formulas the
 * backtest constants emitter publishes fixtures from, so their shapes are pinned here directly.
 */

const obs = (values: number[]): Observation[] =>
  values.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, value }));

describe("velocityDelta", () => {
  it("computes v[i] - v[i-window], aligned to values[window..]", () => {
    expect(velocityDelta([1, 2, 4, 8, 16], 2)).toEqual([3, 6, 12]);
  });

  it("returns an empty series when there is no full window-back point", () => {
    expect(velocityDelta([1, 2, 3], 3)).toEqual([]);
    expect(velocityDelta([1, 2], 5)).toEqual([]);
  });
});

describe("trailingReturnAt", () => {
  it("computes v[i] / v[i-window] - 1", () => {
    expect(trailingReturnAt([100, 110, 121], 2, 2)).toBeCloseTo(0.21, 12);
    expect(trailingReturnAt([50, 100], 1, 1)).toBeCloseTo(1, 12);
  });

  it("returns null on a zero, negative, or non-finite base", () => {
    expect(trailingReturnAt([0, 100], 1, 1)).toBeNull();
    expect(trailingReturnAt([-5, 100], 1, 1)).toBeNull();
    expect(trailingReturnAt([Number.NaN, 100], 1, 1)).toBeNull();
    expect(trailingReturnAt([Number.POSITIVE_INFINITY, 100], 1, 1)).toBeNull();
  });
});

describe("trailingReturn", () => {
  it("is trailingReturnAt over the series, aligned to values[window..]", () => {
    const values = [100, 100, 120, 150, 0, 50];
    const got = trailingReturn(values, 2);
    expect(got).toHaveLength(values.length - 2);
    expect(got[0]).toBeCloseTo(0.2, 12);
    expect(got[1]).toBeCloseTo(0.5, 12);
    expect(got[2]).toBeCloseTo(-1, 12);
    expect(got[3]).toBeCloseTo(-2 / 3, 12);
    // A bad base emits null IN PLACE (length preserved, index k still ↔ values[k + window]), never a dropped row.
    expect(trailingReturn([-5, 100, 200], 1)).toEqual([null, 1]);
  });

  it("returns an empty series when there is no full window-back point", () => {
    expect(trailingReturn([1, 2], 5)).toEqual([]);
  });
});

describe("derivedRawStateSeries (unchanged by the trailingReturn extraction)", () => {
  const returnIndicator = (values: { amber: number; red: number; window: number }): Indicator => ({
    id: "TEST",
    label: "return fixture",
    longLabel: "return fixture",
    series: "TEST",
    channel: "GEO",
    thresholds: {},
    derived: { kind: "return", window: values.window, amber: values.amber, red: values.red, label: "ret", unit: "%" },
  });

  it("classifies the trailing return against its bands", () => {
    const ind = returnIndicator({ amber: 0.2, red: 0.4, window: 2 });
    // returns: +0.5 (red), -1.0, -0.667. The first day (120/100) is GREEN, not AMBER:
    // `120 / 100 - 1` is 0.19999999999999996 in IEEE-754, so it misses the 0.2 band.
    // Pinned deliberately — the extraction must not silently "fix" that edge.
    expect(derivedRawStateSeries(ind, obs([100, 100, 120, 150, 0, 50]))).toEqual([
      "GREEN",
      "RED",
      "GREEN",
      "GREEN",
    ]);
  });

  it("classifies an unambiguous amber return", () => {
    const ind = returnIndicator({ amber: 0.2, red: 0.4, window: 1 });
    expect(derivedRawStateSeries(ind, obs([100, 130]))).toEqual(["AMBER"]);
  });

  it("maps a null-base day to GREEN (the negative-WTI guard)", () => {
    const ind = returnIndicator({ amber: 0.2, red: 0.4, window: 1 });
    expect(derivedRawStateSeries(ind, obs([-5, 100, 200]))).toEqual(["GREEN", "RED"]);
  });
});

/** "change" derived kind (eufin top5 N2): v[i] − v[i−w] in LEVEL units, polarity off the band sign
 *  exactly as "return" — ESTR's negative pair fires LOW, and a negative level (ESTR 2019–22) still scores. */
describe("change (trailing difference) — ESTR", () => {
  const estr = ALL_INDICATORS.find((i) => i.id === "ESTR")!;
  const w = estr.derived!.window!;
  const { amber, red } = resolvedDerivedBands(estr);
  // Flat at a NEGATIVE level for w+1 obs, then a drop of exactly amber, then exactly red (inclusive edges).
  const falling = (base: number) => [...Array(w + 1).fill(base), base + amber!, base + red!];

  it("fires LOW: a fall to the amber/red cut reads AMBER/RED, flat reads GREEN — at a negative level", () => {
    expect(estr.derived!.kind).toBe("change");
    expect(derivedRawStateSeries(estr, obs(falling(-0.375)))).toEqual(["GREEN", "AMBER", "RED"]);
  });

  it("a rise of the same magnitude stays GREEN", () => {
    const rising = [...Array(w + 1).fill(-0.375), -0.375 - amber!, -0.375 - red!];
    expect(derivedRawStateSeries(estr, obs(rising))).toEqual(["GREEN", "GREEN", "GREEN"]);
  });

  it("a POSITIVE band pair fires HIGH: a rise to the amber/red cut reads AMBER/RED", () => {
    const up: Indicator = { ...estr, derived: { ...estr.derived!, amber: 0.25, red: 0.5 } };
    const b = resolvedDerivedBands(up);
    const rising = [...Array(w + 1).fill(-0.375), -0.375 + b.amber!, -0.375 + b.red!];
    expect(derivedRawStateSeries(up, obs(rising))).toEqual(["GREEN", "AMBER", "RED"]);
  });
});

/**
 * "lowRise" derived kind (S3-b): change from the
 * trailing N-obs low in LEVEL units, v[i] − min(inclusive window ending at i). Shipped as F1's
 * DISPLAY-ONLY block — persisted `decision` + cite-able cut, never a scoring leg.
 */
describe("lowRise (change from the trailing low)", () => {
  const lowRiseIndicator = (values: { amber: number; red: number | null; window: number }): Indicator => ({
    id: "TEST",
    label: "lowRise fixture",
    longLabel: "lowRise fixture",
    series: "TEST",
    channel: "GEO",
    thresholds: {},
    derived: { kind: "lowRise", window: values.window, amber: values.amber, red: values.red, label: "rise", unit: "" },
  });

  it("classifies v[i] - min(inclusive trailing window) highward, aligned to obs[window-1..]", () => {
    const ind = lowRiseIndicator({ amber: 2, red: 3.5, window: 3 });
    // rises: 3-3=0, 6-3=3, 3.9-3=0.9, 7.5-3.9=3.6 — the window INCLUDES v[i] (min(4,3,6)=3, not 4).
    expect(derivedRawStateSeries(ind, obs([5, 4, 3, 6, 3.9, 7.5]))).toEqual([
      "GREEN",
      "AMBER",
      "GREEN",
      "RED",
    ]);
  });

  // F1's real path: the generic level/velocity loop persists the lowRise decision via `decisionAt`
  // while the STATES stay level/velocity-only — the S3-b "additive" contract.
  describe("F1 wiring (display-only block on the shipped level/velocity scorer)", () => {
    const F1 = ALL_INDICATORS.find((i) => i.id === "F1")!;
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const seq = (values: number[]): Observation[] => values.map((value, i) => ({ date: day(i), value }));

    // Shape: a low shelf, a ramp, then a plateau LONGER than F1's velocity window — so on the last
    // day the 90d low is still the shelf (decision breaches) while Δvel = 0 and level < amberLevel
    // (both scoring legs dark). Every number derives from the cuts; premises are pinned below.
    const low = 1.0;
    const high = low + F1_LOW_RISE_AMBER * 1.05;
    const ramp = Array.from({ length: 15 }, (_, i) => low + ((high - low) * (i + 1)) / 15);
    const values = [...Array.from({ length: 40 }, () => low), ...ramp, ...Array.from({ length: 45 }, () => high)];

    it("premises: the fixture sits in the discriminating regime", () => {
      expect(high).toBeLessThan(F1.thresholds.amberLevel!); // level leg stays dark
      expect(45).toBeGreaterThan(F1.velocityWindow!); // plateau outlasts the velocity window ⇒ Δ = 0
      expect(values.length).toBeGreaterThan(F1_LOW_RISE_WINDOW); // the low is inside the trailing window
      expect(high - low).toBeGreaterThan(F1_LOW_RISE_AMBER); // …and the rise breaches the cut
    });

    it("persists the lowRise decision while the scored state stays GREEN (additive, never a leg)", () => {
      const last = indicatorReadingSeries(F1, seq(values)).at(-1)!;
      expect(last.rawState).toBe("GREEN");
      expect(last.state).toBe("GREEN");
      expect(last.decision).toBeCloseTo(high - low, 12);
      expect(scoreDerivedDecision(F1, last.decision ?? null)).toBe("AMBER");
    });

    it("red is null - no rise, however large, escalates past AMBER", () => {
      expect(scoreDerivedDecision(F1, F1_LOW_RISE_AMBER * 100)).toBe("AMBER");
    });

    it("is warmup-gapped (decision null under a short lookback)", () => {
      const short = indicatorReadingSeries(F1, seq(values.slice(0, F1_LOW_RISE_WINDOW - 1)));
      expect(short.length).toBeGreaterThan(0);
      for (const r of short) expect(r.decision).toBeNull();
    });
  });
});

describe("alignByDates (N-series inner-join, oldest→newest)", () => {
  const at = (pairs: [string, number][]): Observation[] =>
    pairs.map(([date, value]) => ({ date, value }));

  it("keeps only dates present in EVERY series, aligned column-wise", () => {
    const a = at([["2026-01-01", 1], ["2026-01-02", 2], ["2026-01-03", 3]]);
    const b = at([["2026-01-02", 20], ["2026-01-03", 30], ["2026-01-04", 40]]);
    const c = at([["2026-01-02", 200], ["2026-01-03", 300]]);
    const { dates, values } = alignByDates([a, b, c]);
    // Common dates = {01-02, 01-03}; each column is that series' values on them.
    expect(dates).toEqual(["2026-01-02", "2026-01-03"]);
    expect(values).toEqual([
      [2, 3],
      [20, 30],
      [200, 300],
    ]);
  });

  it("handles the degenerate shapes (no common date, single series, no series)", () => {
    // no common date → one empty column per series
    expect(alignByDates([at([["2026-01-01", 1]]), at([["2026-01-02", 2]])])).toEqual({
      dates: [],
      values: [[], []],
    });
    // single series → identity (one column of its own values)
    expect(alignByDates([at([["2026-01-01", 1], ["2026-01-02", 2]])])).toEqual({
      dates: ["2026-01-01", "2026-01-02"],
      values: [[1, 2]],
    });
    // no series at all → empty
    expect(alignByDates([])).toEqual({ dates: [], values: [] });
  });
});

/**
 * The OR-leg FOLD seam. Two distinct
 * risks are guarded here:
 *  1. the seam is DEAD — `CalibrationCuts.fold` exists in the types and never reaches the
 *     scorer. Driven through the REAL exported path (`rawStateSeries` → the module-private
 *     `classify` → `foldFired`), never through `foldFired` alone, so a broken thread reds.
 *  2. the ATTRIBUTION of a multi-leg firing degrades to a single leg (E6/E7): under an AND fold
 *     `winningLeg` must SYNTHESIZE the composite key from the fired legs in `LEG_ORDER` order.
 * `FOLD_POLICY` is empty at this stage, so no live indicator takes either path.
 */
describe("OR-leg fold policy (cuts.fold)", () => {
  // Both op legs PRESENT at both severities via their CONVENTION fallbacks (no measured cut) —
  // the fold only ever combines legs that have a bound.
  const folded: Indicator = {
    id: "TEST_FOLD",
    label: "fold fixture",
    longLabel: "fold fixture",
    series: "TEST",
    channel: "GEO",
    thresholds: { amberLevel: 101, redLevel: 105, amberVelocity: 2, redVelocity: 50 },
  };
  const flat = Array.from({ length: VELOCITY_WINDOW }, () => 100);
  // delta20 = value − 100 on the single scored day.
  const dayAt = (value: number) => obs([...flat, value]);

  it("reaches the scorer: an AND at Red demotes a day only one Red leg breached", () => {
    // level 110 > redLevel 105 (op fires) but delta20 10 ≤ redVelocity 50 (vel-op does not).
    const oneLeg = dayAt(110);
    expect(rawStateSeries(folded, oneLeg)).toEqual(["RED"]); // OR (fold absent) — shipped
    const cuts: CalibrationCuts = { fold: { red: "and" } };
    // Amber is untouched by the policy and still ORs, so the day lands AMBER, not GREEN.
    expect(rawStateSeries(folded, oneLeg, cuts)).toEqual(["AMBER"]);
  });

  it("leaves a day where BOTH Red legs breach at RED under the same AND policy", () => {
    // Non-vacuity for the case above: the demotion is the fold, not a blanket silencing.
    const bothLegs = dayAt(160); // level 160 > 105 AND delta20 60 > 50
    expect(rawStateSeries(folded, bothLegs, { fold: { red: "and" } })).toEqual(["RED"]);
  });

  it("synthesizes the composite attribution key from the legs that jointly fired", () => {
    const both = winningLeg(160, 60, folded.thresholds, "HIGH", { fold: { red: "and" } });
    expect(both).toBe("op+vel-op");
    // Default (OR) attribution is unchanged: the FIRST firing leg in LEG_ORDER, alone.
    expect(winningLeg(160, 60, folded.thresholds, "HIGH")).toBe("op");
    // An AND that does not fire at Red falls through to the Amber tier's OR.
    expect(winningLeg(110, 10, folded.thresholds, "HIGH", { fold: { red: "and" } })).toBe("op");
  });

  it("folds a bare leg list through the shared combinator", () => {
    const legs = evaluateLegs("Red", 160, 60, folded.thresholds, "HIGH");
    expect(foldFired(legs, "Red").map((l) => l.leg)).toEqual(["op"]); // OR ⇒ first hit only
    expect(foldFired(legs, "Red", { red: "and" }).map((l) => l.leg)).toEqual(["op", "vel-op"]);
    // One present leg short ⇒ the AND yields nothing at all.
    const partial = evaluateLegs("Red", 110, 10, folded.thresholds, "HIGH");
    expect(foldFired(partial, "Red", { red: "and" })).toEqual([]);
  });
});

/**
 * The 2026-08-06 arm-trigger restructure (verdict `D-FAVOURED`) — F1 and F2 flip
 * from the shipped implicit OR-of-legs to option D:
 *
 *     Amber := level leg fires OR velocity leg fires        (unchanged)
 *     Red   := level leg fires AND velocity leg fires       (the arm trigger)
 *
 * Two production facts carry it: `FOLD_POLICY` (the fold, pinned below), and the 2026-08-06
 * retirement of the borrowed Baa10y `z`/`vel-z` legs (under an AND every PRESENT leg must fire, so
 * leaving them in would have made Red a four-leg conjunction across two unit systems rather than
 * the ruled two-leg trigger) — pinned by `dashboard.cuts.test.ts`'s exhaustive fold-only cut set,
 * and below by the BOTH-legs case still scoring RED.
 *
 * SYNTHETIC ONLY, by ruling E2: no probe, no replay, no DB, and knowingly no measurement of how
 * many real closes changed state. Every fixture number is DERIVED from the id's own registry
 * thresholds, so a retune moves the fixtures with production and no cut value is restated here.
 */
describe("F1/F2 arm trigger - AND at Red, OR at Amber (FOLD_POLICY)", () => {
  // F2 is F1's engine on another series — its fold is pinned exhaustively in `dashboard.cuts.test.ts`.
  const ARMED = ["F1", "CCC"] as const;
  // F1/F2 carry NO calibration params any more (both measured pairs retired, both borrowed legs
  // retired), so an EMPTY vintage is the honest input — and `resolveCuts` must still hand back the
  // fold, which is exactly why the policy lives outside `CALIB_MAP`.
  const cutsFor = (id: string) => resolveCuts(id, [], "HIGH");

  // ONE scored day at `delta20 === delta`: `VELOCITY_WINDOW` flat closes at the base, then `level` (F1's
  // 30-day window clamps to `values[0]`). A relative-mode id's base is `level / (1 + delta)`.
  const dayAt = (ind: Indicator, level: number, delta: number): Observation[] => {
    const base = ind.velocityMode === "relative" ? level / (1 + delta) : level - delta;
    return obs([...Array.from({ length: VELOCITY_WINDOW }, () => base), level]);
  };

  it("E8-B: the fold TABLE is wired - every armed id resolves the ruled policy", () => {
    // The Stage-1 falsifier proved `cuts.fold` reaches the scorer with a hand-built cut set; this
    // is its other half — that `resolveCuts` sources the policy from the table for these ids.
    for (const id of ARMED) expect(cutsFor(id).fold, id).toEqual({ amber: "or", red: "and" });
  });

  for (const id of ARMED) {
    const ind = ALL_INDICATORS.find((i) => i.id === id)!;
    const t = ind.thresholds;
    // Derived, never typed: one full band ABOVE the Red cut on the axis meant to breach, and half
    // the AMBER cut on the axis meant to stay calm (dark at BOTH tiers, so the fold is the only
    // thing deciding).
    const levelBreach = t.redLevel! + (t.redLevel! - t.amberLevel!);
    const levelCalm = t.amberLevel! / 2;
    const velBreach = t.redVelocity! + (t.redVelocity! - t.amberVelocity!);
    const velCalm = t.amberVelocity! / 2;

    it(`${id}: a Red LEVEL breach with a calm velocity leg now scores AMBER, not RED`, () => {
      const day = dayAt(ind, levelBreach, velCalm);
      // The shipped OR fold (no cuts ⇒ no policy) scores this RED — the behaviour the arc overturns.
      expect(rawStateSeries(ind, day)).toEqual(["RED"]);
      expect(rawStateSeries(ind, day, cutsFor(id))).toEqual(["AMBER"]);
    });

    it(`${id}: the velocity hatch alone still raises AMBER - the OR at Amber is untouched`, () => {
      const day = dayAt(ind, levelCalm, velBreach);
      expect(rawStateSeries(ind, day, cutsFor(id))).toEqual(["AMBER"]);
    });

    it(`${id}: BOTH Red legs breaching still scores RED, attributed to the composite leg`, () => {
      // Non-vacuity twin for the demotion above: the AND is a fold, not a blanket silencing.
      const day = dayAt(ind, levelBreach, velBreach);
      const cuts = cutsFor(id);
      expect(rawStateSeries(ind, day, cuts)).toEqual(["RED"]);
      expect(scoredDaySeries(ind, day, cuts).legs).toEqual(["op+vel-op"]);
    });

  }
});

describe("composite leg vocabulary", () => {
  it("classifies a composite carrying a velocity part as velocity-class", () => {
    expect(isVelocityLeg("op+vel-op")).toBe(true);
    expect(isVelocityLeg("op")).toBe(false);
    expect(isVelocityLeg(undefined)).toBe(false);
  });

  it("renders an UNLISTED composite by falling through to its parts", () => {
    // No `evt+vel-evt` entry exists in LEG_PHRASE — the point of the fallthrough is that a
    // future FOLD_POLICY entry costs no table edit on either side.
    expect(legPhrase("evt+vel-evt")).toBe("EVT tail and velocity EVT");
    expect(legPhrase("op+vel-op")).toBe("wide and widening"); // a table hit still wins
    expect(legPhrase("some-future-leg")).toBe("some-future-leg");
  });
});
