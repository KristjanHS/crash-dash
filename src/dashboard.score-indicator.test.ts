import { expect, test, describe } from "vitest";
import {
  scoreIndicator,
  scoreSmoothedLevel,
  smoothedLevelReadingSeries,
  meanLevelCutSeries,
  postInversionCutSeries,
} from "./scorers-core.js";
import {
  scoreBullSteepener,
  bullSteepenerState,
  bullSteepenerLegSeries,
  scoreMoveLevel,
} from "./scorers-composite.js";
import { BULL_MIN_OBS, BULL_CUT_WINDOW } from "./family-descriptor-rows.js";
import {
  R6,
  F11_SIGMA_WINDOW,
  F11_SIGMA_MIN_OBS,
  F11_SIGMA_EWMA_HALF_LIFE,
  F11_SIGMA_FLOOR,
  F11_FAST_VELOCITY_WINDOW,
  F9_CUSUM_K,
  F9_CUSUM_H,
  F9_CUSUM_H_RED,
  CCC,
} from "./registry-fred.js";
import { R7 } from "./registry-composite.js";
import { VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import {
  rawStateSeries,
  velocitySigmaZSeries,
  velocityCusumSeries,
  winningLegSeries,
} from "./domain-fold.js";
import { activeLegs } from "./domain-legs.js";
import { ALL_INDICATORS } from "./registry.js";
import { resolveCuts } from "./domain-cuts.js";
import { flat, flatN, ramp, indicator, byId } from "./dashboard.test-helpers.js";
import { SMOOTHED_LEVEL_OF, R8_MEAN_CUT_BANDS, POST_INVERSION_BAND } from "./family-descriptor-rows.js";

describe("R1 two-window mean level (direction LOW): RED on the quarter mean, AMBER on the month mean", () => {
  const r1 = byId("R1");
  const sw = SMOOTHED_LEVEL_OF.R1!;
  const w = sw.redWindow!;
  const last = (vals: number[]) => smoothedLevelReadingSeries(r1, vals.map((v, i) => ({ date: `d${String(i).padStart(4, "0")}`, value: v })), sw.window, undefined, sw.redWindow).at(-1)!;

  test("a full inverted quarter is RED", () => {
    expect(last(Array<number>(w).fill(-0.5)).state).toBe("RED");
  });
  test("an inverted MONTH inside a positive quarter is AMBER, not RED - the two windows discriminate", () => {
    const vals = [...Array<number>(w - sw.window).fill(1.0), ...Array<number>(sw.window).fill(-0.5)];
    expect(last(vals).rawState).toBe("AMBER");
  });
  // Strict `<`: a constant 0.0 is flat, not inverted — neither mean is < redLevel and the rung never
  // arms (arming counts means < 0), so it is GREEN; 0.5 likewise.
  test("a constant 0.00 spread is GREEN (flat is not inverted); 0.50 is GREEN", () => {
    expect(last(Array<number>(w).fill(0.0)).state).toBe("GREEN");
    expect(last(Array<number>(w).fill(0.5)).state).toBe("GREEN");
  });
  test("a feed shorter than the RED window fails loud through scoreSmoothedLevel", () => {
    expect(() => scoreSmoothedLevel(r1, flatN(-0.5, w - 1), sw.window, undefined, sw.redWindow)).toThrow();
  });

  test("each reading STAMPS the armed rung cut under R1's wire key (Stage 2.2)", () => {
    // A full inverted quarter arms the rung, so a finite AMBER-floor cut is stamped.
    const obs = Array<number>(w).fill(-0.5).map((v, i) => ({ date: `d${String(i).padStart(4, "0")}`, value: v }));
    const r = smoothedLevelReadingSeries(r1, obs, sw.window, undefined, sw.redWindow);
    // The SAME rung cut the scorer's AMBER leg reads, recomputed off the `window`-obs means.
    const means: number[] = [];
    const meanDates: string[] = [];
    for (let i = sw.window - 1; i < obs.length; i++) {
      let sum = 0;
      for (let k = i - sw.window + 1; k <= i; k++) sum += obs[k]!.value;
      means.push(sum / sw.window);
      meanDates.push(obs[i]!.date);
    }
    const rungCut = postInversionCutSeries(means, r1.postInversionCooldown!, meanDates);
    let stamped = 0;
    r.forEach((reading, k) => {
      const exp = rungCut[k] != null && Number.isFinite(rungCut[k]!) ? rungCut[k]! : undefined;
      expect(reading.bandCuts?.[POST_INVERSION_BAND.key], `${reading.date}`).toBe(exp);
      if (exp !== undefined) stamped++;
    });
    expect(stamped).toBeGreaterThan(0);
  });
});

describe("scoreIndicator - R4 real-yield velocity (velocity-only, RATE, can go negative)", () => {
  // Bands come from the LIVE registry entry, never a hand-typed copy: R4's convention cuts are
  // the binding leg of its effective cut (they sit below the measured EVT/regime-z legs), so a
  // retune moves production. A copied fixture would keep passing against the stale numbers.
  const r4 = ALL_INDICATORS.find((i) => i.id === "R4")!;
  const amberVel = r4.thresholds.amberVelocity!;
  const redVel = r4.thresholds.redVelocity!;
  // `ramp(step)` yields a 20d Δ of step × VELOCITY_WINDOW, so invert the target Δ through it.
  const rampToDelta = (delta: number) => ramp(delta / VELOCITY_WINDOW);

  test("a flat NEGATIVE level never fires without velocity (DFII10 went negative 2020-22)", () => {
    expect(scoreIndicator(r4, flat(-0.5)).state).toBe("GREEN");
    expect(scoreIndicator(r4, flat(99)).state).toBe("GREEN"); // flat HIGH is likewise no velocity
  });
  test("a 20d rise above redVelocity fires RED", () => {
    expect(scoreIndicator(r4, rampToDelta(redVel * 1.2)).state).toBe("RED");
  });
  test("a 20d rise between amberVelocity and redVelocity fires AMBER", () => {
    expect(scoreIndicator(r4, rampToDelta((amberVel + redVel) / 2)).state).toBe("AMBER");
  });
});

// --- LEVEL edges: F3 (fixture cuts) + registry F10 (HIGH) -----------------
// The F10 row carries ONLY the per-indicator LEVEL band boundaries, pinned against the LIVE
// registry NUMBERS so a threshold drift trips here. The shared strict-compare level leg is
// canonically pinned by the F3 row (HIGH) / R1 (LOW) above and the shared velocity leg by R4, so
// these do NOT re-test those code paths per-indicator — only the registry numbers (2 edges
// each). F10 is an inline INDICATORS entry (no named export) → looked up by id.
//
// ⚠ **F9 LEFT THIS BLOCK 2026-08-07 AND F11 2026-08-08** — not a coverage loss, a population change:
// both level axes were retired (Stage 1 of each scorer
// redesign), so `thresholds.amberLevel`/`redLevel` no
// longer exist for either and `levelEdges("F9"|"F11", …)` would derive `undefined` edges that score
// GREEN for any input — a row that cannot fail is worse than an absent one. Both registry pairs are
// now VELOCITY-only and each surviving axis is pinned in `src/registry.test.ts`
// §"F9 velocity-only (level axis retired 2026-08-07)" / §"F11 velocity-only (level axis retired
// 2026-08-08)". F10 is the surviving row below.

// F10 has no named cut export, so its edges DERIVE from the LIVE registry pair — a retune must
// not need a fixture edit.
// `step` is only the "just above the cut" nudge, sized to the indicator's units.
const levelEdges = (id: string, step: number) => {
  const ind = byId(id);
  const amber = ind.thresholds.amberLevel!;
  const red = ind.thresholds.redLevel!;
  return { ind, amber, amberUp: amber + step, red, redUp: red + step };
};

// HIGH-level convention: the amber/red cut VALUE stays on the safer side (exclusive `>`), so
// exact-amber is GREEN / above-amber is AMBER, and exact-red is AMBER / above-red is RED.
describe.each([
  // F3: the canonical strict `>` HIGH level leg on fixture cuts (mirror of R1's strict `<` LOW edges).
  {
    ind: indicator({ id: "F3", channel: "FIN", thresholds: { amberLevel: 0.5, redLevel: 1.0 } }),
    name: "F3 NFCI Risk",
    amber: 0.5,
    amberUp: 0.6,
    red: 1.0,
    redUp: 1.5,
  },
  { ...levelEdges("F10", 0.1), name: "F10 EM OAS" },
])("scoreIndicator - $name HIGH-level edges", ({ ind, amber, amberUp, red, redUp }) => {
  test("amber edge: exact is GREEN (exclusive), above is AMBER", () => {
    expect(scoreIndicator(ind, flat(amber)).state).toBe("GREEN");
    expect(scoreIndicator(ind, flat(amberUp)).state).toBe("AMBER");
  });
  test("red edge: exact is AMBER (exclusive), above is RED", () => {
    expect(scoreIndicator(ind, flat(red)).state).toBe("AMBER");
    expect(scoreIndicator(ind, flat(redUp)).state).toBe("RED");
  });
});

// CCC (FRED BAMLH0A3HYC): level OR Δ20 at Amber, through the run path's `resolveCuts`.
describe("scoreIndicator - CCC OAS registry level + Δ20 cuts (GLOBAL)", () => {
  // 40 closes at `last - d`, then `last`: the newest delta20 is exactly `d` (VELOCITY_WINDOW back sits on the flat run).
  const jump = (last: number, d: number): Observation[] => [...flatN(last - d, 40), { date: "d40", value: last }];
  const score = (last: number, d: number) => scoreIndicator(CCC, jump(last, d), resolveCuts(CCC.id, [], CCC.direction ?? "HIGH"));

  test("the row scores off the registry pairs", () => {
    expect(VELOCITY_WINDOW).toBeLessThan(40);
    expect(score(12.52, 1.0).delta20).toBeCloseTo(1.0, 9);
  });
  // Amber edges per leg; the Red AND fold is pinned in `scoring-primitives.test.ts` (`ARMED`).
  test("Amber via either leg", () => {
    const { amberLevel, amberVelocity } = CCC.thresholds;
    const rows = [
      { last: amberLevel! - 0.1, d: amberVelocity! - 0.1, want: "GREEN" },
      { last: amberLevel! + 0.1, d: amberVelocity! - 0.1, want: "AMBER" }, // level leg
      { last: amberLevel! - 0.1, d: amberVelocity! + 0.1, want: "AMBER" }, // Δ20 leg
    ];
    const label = (r: (typeof rows)[number], state: string) => `${r.last}/${r.d} ⇒ ${state}`;
    expect(rows.map((r) => label(r, score(r.last, r.d).state))).toEqual(rows.map((r) => label(r, r.want)));
  });
});

// F12's China-credit-impulse suites (creditImpulseState edges, creditImpulseReadingSeries
// 4Q-diff guard + arithmetic, scoreCreditImpulse minObs + confirmation) lived here until
// 2026-07-17. DELETED with the scorer itself (DEC-21, dead-feed retirement): they tested a
// function that no longer exists, so there is nothing left to bend or preserve.
//
// ONE COVERAGE LOSS IS REAL AND IS **NOT** SILENTLY ABSORBED: the suite's last test
// ("every emitted row carries a non-null delta20") was the ONLY fixture reaching
// `buildReadings`' `Math.max(0, i - VELOCITY_WINDOW)` clamp — F12's baseOffset of 4 was the
// only baseOffset < VELOCITY_WINDOW in the codebase. The clamp is still LIVE code (see its
// comment in scorers-core.ts: `derivedBaseOffset` returns 0 for an `identity` descriptor, so a
// future scorer can reach it) but it is now UNTESTED. Re-covering it needs a synthetic
// short-baseOffset scorer fixture, which is a new test, not a rescue of this one.

// The ex-US-developed (EAFE) leaders F14/F15 had a registry LOW-level edge suite here until
// 2026-07-17. DELETED with the indicators (DEC-19/DEC-20, dead FRED feeds) — the suite pinned
// registry NUMBERS that no longer exist, so it had no premise left. The shared strict-`<`
// LOW-polarity level leg it rode on is canonically pinned by R1 above; nothing is lost.

describe("velocitySigmaZSeries - the strictly-historical rolling σ (F9 Stage 1, ruling 1)", () => {
  // ⚠ The ruled contract is that σ is estimated over deltas ending at `t−1`: the scored day's OWN
  // Δw must never enter the scale that judges it. A fixture that merely checks "z looks right"
  // passes under BOTH the strict bound and an off-by-one — so the case below is built to
  // DISCRIMINATE them. Every historical delta is IDENTICAL (a constant-slope ramp) ⇒ σ = 0 ⇒ the
  // day degrades and z is undefined. Widen the bound by one and the scored day's own (very
  // different) delta joins the window, σ becomes positive, and z resolves — i.e. the assertion
  // reds on exactly the mutation the prose forbids.
  const CFG = { window: 100, minObs: 3 };
  const W = 1;
  // Alignment: the returned arrays start at observation VELOCITY_WINDOW, so index k is obs k + 20.
  const RAMP_N = 25;
  const JUMP = 50;
  const ramp = Array.from({ length: RAMP_N }, (_, j) => (j < RAMP_N - 1 ? j : j - 1 + JUMP));

  test("the scored day's OWN delta is excluded - a constant-slope history degrades it", () => {
    const { z, sigma } = velocitySigmaZSeries(ramp, W, CFG);
    // Alignment guard first: a wrong length would make the index below read a different day.
    expect(z).toHaveLength(RAMP_N - VELOCITY_WINDOW);
    const last = RAMP_N - 1 - VELOCITY_WINDOW;
    // Non-vacuity: the jump day's own delta is enormous and IS what an off-by-one would admit.
    expect(ramp[RAMP_N - 1]! - ramp[RAMP_N - 2]!).toBeGreaterThan(JUMP - 2);
    expect(sigma[last], "σ must see only the constant historical slope").toBeUndefined();
    expect(z[last], "…so the day degrades rather than scoring off its own shock").toBeUndefined();
  });

  test("a varied history DOES score - the degrade above is the bound, not a dead function", () => {
    // The contrast arm. Same length, same window, but the historical deltas differ, so σ > 0 and
    // the identical call returns a finite z: an all-undefined return cannot be blamed for the
    // assertion above.
    const varied = Array.from({ length: RAMP_N }, (_, j) => (j < RAMP_N - 1 ? (j % 3) * 2 : 40));
    const { z, sigma } = velocitySigmaZSeries(varied, W, CFG);
    const last = RAMP_N - 1 - VELOCITY_WINDOW;
    expect(sigma[last]!).toBeGreaterThan(0);
    // z is the SCORED delta over that σ — the same delta the card and the persisted row carry.
    expect(z[last]!).toBeCloseTo((varied[RAMP_N - 1]! - varied[RAMP_N - 2]!) / sigma[last]!, 10);
  });

  // The two UNITS GATES the review (I5 + the accepted `legBounds` suggestion, 2026-08-08) asked for.
  // Both guard an intersection that is EMPTY today, so neither can be pinned by an existing fixture —
  // they exist so the combination fails LOUD instead of silently putting two different units on the
  // same `vel-z` leg. Each case constructs the combination directly.
  describe("σ units cannot share the vel-z leg with a raw-unit source", () => {
    const sigmaInd = indicator({
      id: "SIGTEST",
      thresholds: { amberVelocity: 1.55, redVelocity: 2.65, velocitySigma: { window: 100, minObs: 3, cusumK: F9_CUSUM_K, cusumH: F9_CUSUM_H, cusumHRed: F9_CUSUM_H_RED } },
    });
    const obs = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value: 100 + (i % 3),
    }));

    test("a proxy velZ series beside velocitySigma throws instead of silently winning", () => {
      // `scoreDaySeries`' velZ selection is an if/else chain with the proxy FIRST, so without the
      // gate the published-zref z would ride a leg whose bound is a σ multiple.
      const velZ = obs.slice(VELOCITY_WINDOW).map(() => 1);
      expect(() => rawStateSeries(sigmaInd, obs, undefined, { velZ })).toThrow(/velocitySigma/);
      // Contrast arm: the SAME call without the proxy series is fine, so the throw is the
      // combination and not the σ id itself.
      expect(() => rawStateSeries(sigmaInd, obs, undefined, undefined)).not.toThrow();
    });

    test("a measured velZ CUT beside velocitySigma throws - but an evt/operative velocity cut does not", () => {
      // `_zscore_*` ⇒ velZAmber ⇒ the same `vel-z` leg the σ pair backs ⇒ units mismatch.
      expect(() => activeLegs(sigmaInd, { velZAmber: 4.2 })).toThrow(/σ units/);
      // `evt_vel_*` / `operative_vel_*` land on `vel-evt` / `vel-op`, both compared against the RAW
      // delta20 — correct units, deliberately NOT blocked (the hazard there is an extra OR-leg).
      expect(() => activeLegs(sigmaInd, { velEvtAmber: 4.2, velOpAmber: 4.2 })).not.toThrow();
    });
  });

  // ⚠ THE THREE CASES AROUND THIS ONE ARE BLIND TO THE WINDOW. They all run `window: 100` against a
  // 25-observation fixture, so the lower bound `a = max(0, i − window − w)` is 0 on every day and
  // BOTH of these mutations pass them (review C2, 2026-08-08):
  //   `a = Math.max(0, i - cfg.window)`  — the window comes out `w` deltas SHORT
  //   `a = 0`                            — σ becomes an EXPANDING all-history estimate, i.e. exactly
  //                                        the pre-ruling behaviour ruling 1 replaced
  // The fixture below makes the window BIND: it puts an old, wildly-different volatility regime
  // behind the window's left edge, so σ is only correct if that block is EXCLUDED. The expected σ is
  // recomputed here by a brute-force loop over the same values — an independent oracle, not a
  // transcribed number and not the implementation's prefix sums.
  describe("the σ WINDOW binds - an out-of-window regime must be excluded", () => {
    const WW = 1; // w = 1 ⇒ each delta is one step, so the window bound is readable off the indices
    const WIN = 20;
    const N = 60;
    const OLD_SWING = 50; // the old regime: alternating ±50 one-step moves
    const HINGE = 20; // the OLDEST delta INSIDE the correct window — what mutation 1 drops
    // values[0..38] alternate 0/OLD_SWING; delta at j=39 is the hinge; j=40..59 are small.
    const vals: number[] = [];
    for (let i = 0; i < N; i++) {
      if (i < 39) vals.push(i % 2 === 0 ? 0 : OLD_SWING);
      else if (i === 39) vals.push(vals[38]! + HINGE);
      else vals.push(vals[i - 1]! + ((i % 3) + 1));
    }
    const LAST_I = N - 1;
    // Brute-force sample sd of the deltas at observation indices j ∈ [lo, hi] (both inclusive).
    const sdOver = (lo: number, hi: number): number => {
      const d: number[] = [];
      for (let j = lo; j <= hi; j++) d.push(vals[j]! - vals[j - WW]!);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1));
    };

    test("σ uses exactly the last `window` historical deltas - older regimes are excluded", () => {
      const { sigma, z } = velocitySigmaZSeries(vals, WW, { window: WIN, minObs: 5 });
      const last = LAST_I - VELOCITY_WINDOW;
      // The ruled range: deltas at j ∈ [i − window, i − 1], strictly historical, exactly `window` of
      // them. Anything else is a different estimator.
      const expected = sdOver(LAST_I - WIN, LAST_I - 1);
      expect(sigma[last]!).toBeCloseTo(expected, 10);
      expect(z[last]!).toBeCloseTo((vals[LAST_I]! - vals[LAST_I - WW]!) / expected, 10);
      // DISCRIMINATION (this is what makes the pin above non-vacuous): each mutation's window gives a
      // materially different σ, so neither can satisfy the assertion.
      const shortByW = sdOver(LAST_I - WIN + WW, LAST_I - 1); // `a = max(0, i - cfg.window)`
      const expanding = sdOver(WW, LAST_I - 1); // `a = 0`
      expect(Math.abs(shortByW - expected) / expected, "dropping the hinge must move σ").toBeGreaterThan(0.3);
      expect(expanding / expected, "the old regime must dwarf the in-window scale").toBeGreaterThan(3);
    });
  });

  test("below minObs the day degrades rather than scoring off a thin σ", () => {
    // Only `RAMP_N - 1 - W` historical deltas exist at the last index; demand more than that.
    const { z } = velocitySigmaZSeries(ramp, W, { window: 100, minObs: RAMP_N });
    expect(z.every((v) => v === undefined)).toBe(true);
  });
});

describe("velocitySigmaZSeries - the OPT-IN blend max(EWMA, floor × rect) (F11 Stage 1, ruling 1)", () => {
  // ⚠ Two fixtures, one per BINDING ARM. A single fixture pins only whichever arm happens to win on it
  // and passes under `σ = ewma` and under `σ = floor × rect` alike, so the max would be untested.
  // `HL` is local: F11's shipped half-life is 125 observations and would be flat over a 60-obs fixture,
  // which is exactly the regime that cannot discriminate. `F11_SIGMA_FLOOR` IS the value under test and
  // is taken from the registry — never restated (`.claude/rules/indicator-loop.md`).
  const W = 1;
  const HL = 5;
  const WIN = 40;
  const MO = 5;
  const NOBS = 60;
  const LAST = NOBS - 1;
  const k = LAST - VELOCITY_WINDOW;
  const cfgRect = { window: WIN, minObs: MO };
  const cfgEwma = { window: WIN, minObs: MO, ewmaHalfLife: HL };
  const cfgBlend = { window: WIN, minObs: MO, ewmaHalfLife: HL, ewmaFloorFactor: F11_SIGMA_FLOOR };

  /** LOUD past, QUIET present ⇒ the rect arm towers over the EWMA and the FLOOR must bind. */
  const floorBinds = Array.from({ length: NOBS }, (_, i) => (i < WIN ? (i % 2) * 100 : 1000 + i));
  /** QUIET past, LOUD present ⇒ the EWMA towers over `floor × rect` and the EWMA must bind. */
  const ewmaBinds = Array.from({ length: NOBS }, (_, i) => (i < WIN ? i : (i % 2) * 1000));

  /**
   * INDEPENDENT ORACLE for the EWMA arm — the CLOSED FORM of the recurrence, not the recurrence:
   * `s² = λ Σ_{t≥1} (1−λ)^{m−1−t} D_t² + (1−λ)^{m−1} D_0²` over the strictly-historical deltas
   * `D_t = v[t+W] − v[t]` ending at `t = i − 1`. A copy of the fold would pin nothing.
   * Starts where the implementation's loop starts (`i = VELOCITY_WINDOW` folds delta `i − 1`), so the
   * agreement is STRUCTURAL — from `j = W` it only matched via this fixture's constant-slope head.
   */
  const ewmaOracle = (values: number[], i: number): number => {
    const lambda = 1 - Math.pow(0.5, 1 / HL);
    const D: number[] = [];
    for (let j = Math.max(W, VELOCITY_WINDOW - 1); j <= i - 1; j++) D.push(values[j]! - values[j - W]!);
    const m = D.length;
    let s2 = Math.pow(1 - lambda, m - 1) * D[0]! ** 2;
    for (let t = 1; t < m; t++) s2 += lambda * Math.pow(1 - lambda, m - 1 - t) * D[t]! ** 2;
    return Math.sqrt(s2);
  };

  test("the FLOOR binds - a quiet present cannot shrink σ below `F11_SIGMA_FLOOR × rect`", () => {
    const rectOnly = velocitySigmaZSeries(floorBinds, W, cfgRect);
    const ewmaOnly = velocitySigmaZSeries(floorBinds, W, cfgEwma);
    const blend = velocitySigmaZSeries(floorBinds, W, cfgBlend);
    // Regime guard: reds if the fixture ever stops being a floor-binds regime, so the pin below
    // can never be satisfied by an implementation that simply returns the EWMA.
    expect(ewmaOnly.sigma[k]!, "the EWMA must be the LOSING arm here").toBeLessThan(F11_SIGMA_FLOOR * rectOnly.sigma[k]!);
    expect(blend.sigma[k]!).toBeCloseTo(F11_SIGMA_FLOOR * rectOnly.sigma[k]!, 10);
    // z rides the SAME blended scale — a σ the leg never sees would be a half-wired blend.
    expect(blend.z[k]!).toBeCloseTo((floorBinds[LAST]! - floorBinds[LAST - W]!) / (F11_SIGMA_FLOOR * rectOnly.sigma[k]!), 10);
  });

  test("the EWMA binds - a loud present lifts σ above the floor, matching the closed-form oracle", () => {
    const rectOnly = velocitySigmaZSeries(ewmaBinds, W, cfgRect);
    const blend = velocitySigmaZSeries(ewmaBinds, W, cfgBlend);
    const oracle = ewmaOracle(ewmaBinds, LAST);
    expect(oracle, "the floor must be the LOSING arm here").toBeGreaterThan(F11_SIGMA_FLOOR * rectOnly.sigma[k]!);
    expect(blend.sigma[k]!).toBeCloseTo(oracle, 10);
    expect(blend.z[k]!).toBeCloseTo((ewmaBinds[LAST]! - ewmaBinds[LAST - W]!) / oracle, 10);
  });

  test("fields ABSENT ⇒ rectangular, matching a brute-force sample sd on every scored day", () => {
    // The "F9 is unchanged by construction" claim, measured: no `ewmaHalfLife` ⇒ the σ series is the
    // sample sd over `[i − window, i − 1]` on EVERY index, not just the last.
    const { sigma } = velocitySigmaZSeries(floorBinds, W, cfgRect);
    for (let i = VELOCITY_WINDOW; i < NOBS; i++) {
      const D: number[] = [];
      for (let j = Math.max(W, i - WIN); j <= i - 1; j++) D.push(floorBinds[j]! - floorBinds[j - W]!);
      const mu = D.reduce((a, b) => a + b, 0) / D.length;
      const v = D.reduce((a, b) => a + (b - mu) ** 2, 0) / (D.length - 1);
      expect(sigma[i - VELOCITY_WINDOW]!).toBeCloseTo(Math.sqrt(v), 10);
    }
    // Non-vacuity: the floor WINS on this fixture, so the blend is exactly `floor × rect` and the gap
    // is `1 − floor` — derived from the constant, never a literal (a literal read 0.2 and went red the
    // day the floor was measured up to 0.9). The premise guard reds if a future floor nears 1 and the
    // contrast stops discriminating.
    const blend = velocitySigmaZSeries(floorBinds, W, cfgBlend);
    expect(1 - F11_SIGMA_FLOOR, "a floor at ~1 makes this contrast vacuous").toBeGreaterThan(0.05);
    expect(Math.abs(blend.sigma[k]! - sigma[k]!) / sigma[k]!).toBeCloseTo(1 - F11_SIGMA_FLOOR, 10);
  });

  test("`minObs` gates the BLEND path - the EWMA arm is short while the rect arm is deep", () => {
    // The EWMA folds one delta per scored day (from VELOCITY_WINDOW), the rect arm counts every delta
    // in its window — so this `minObs` admits rect and starves the EWMA, and a blend that ignored the
    // gate would score off a 40-observation scale.
    const GATE = NOBS - 15; // > the EWMA's NOBS − VELOCITY_WINDOW deltas, ≤ the rect arm's LAST − W
    const deep = { window: 1000, minObs: GATE };
    expect(GATE, "the gate must exceed the EWMA's depth or this test is vacuous").toBeGreaterThan(NOBS - VELOCITY_WINDOW);
    expect(velocitySigmaZSeries(ewmaBinds, W, deep).sigma[k], "the rect arm is deep enough").toBeGreaterThan(0);
    const blend = velocitySigmaZSeries(ewmaBinds, W, { ...deep, ewmaHalfLife: HL, ewmaFloorFactor: F11_SIGMA_FLOOR });
    expect(blend.sigma[k], "…so the blend DEGRADES rather than scoring off a thin EWMA").toBeUndefined();
    expect(blend.z[k]).toBeUndefined();
  });

  test("F11's registry block is the blend, off the exported constants", () => {
    expect(byId("F11").thresholds?.velocitySigma).toEqual({
      window: F11_SIGMA_WINDOW,
      minObs: F11_SIGMA_MIN_OBS,
      ewmaHalfLife: F11_SIGMA_EWMA_HALF_LIFE,
      ewmaFloorFactor: F11_SIGMA_FLOOR,
      fastWindow: F11_FAST_VELOCITY_WINDOW,
    });
  });
});

describe("the `vel-z-fast` OR-arm (F11 lead-time stage 6) - a second Δ horizon on the same σ pair", () => {
  // The fixture puts the move on the FAST horizon only: yesterday dipped −8, today recovered +9,
  // so Δ1 spikes while Δ4 lands back near flat. The knob-less contrast arm is the vacuity guard —
  // if the slow horizon also fired, its GREEN assertion reds and the fixture pins nothing.
  const sigmaBase = { window: 100, minObs: 3 };
  const vals: number[] = [100];
  for (let i = 1; i <= 27; i++) vals.push(vals[i - 1]! + (i % 2 === 0 ? 2 : 0));
  vals.push(vals[27]! - 8, vals[27]! + 1);
  const obs = vals.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, value }));
  const fast = indicator({
    id: "FASTTEST",
    velocityWindow: 4,
    thresholds: { amberVelocity: 1.55, redVelocity: 99, velocitySigma: { ...sigmaBase, fastWindow: 1 } },
  });
  const slow = indicator({
    id: "FASTTEST",
    velocityWindow: 4,
    thresholds: { amberVelocity: 1.55, redVelocity: 99, velocitySigma: sigmaBase },
  });

  test("fast z breaches ⇒ the day fires and attributes `vel-z-fast`; without the knob it is GREEN", () => {
    expect(rawStateSeries(slow, obs).at(-1)).toBe("GREEN");
    expect(rawStateSeries(fast, obs).at(-1)).toBe("AMBER");
    expect(winningLegSeries(fast, obs, undefined, undefined, 0).at(-1)).toBe("vel-z-fast");
  });

  test("the leg is listed iff the σ block declares `fastWindow`", () => {
    expect(activeLegs(fast)).toContain("vel-z-fast");
    expect(activeLegs(slow)).not.toContain("vel-z-fast");
  });
});

/**
 * RESET-TO-0 ON ALARM (2026-08-09 `[USER]`). The fixture is the regime the
 * reset exists for and the ONLY one that discriminates: an UNBROKEN one-sided drift. Under the
 * pre-2026-08-09 recurrence S⁺ ratchets monotonically and, once it crosses `h`, never comes back
 * — one endless alarm. With the reset the same drift re-fires periodically and the accumulator
 * stays bounded. A decaying or reversing fixture passes under BOTH and would pin nothing.
 *
 * The no-reset behaviour is recomputed in-test as an ORACLE rather than transcribed, so the
 * discrimination assertions cannot go stale, and `k`/`h` come from the registry constants —
 * never restated (`.claude/rules/indicator-loop.md` §A retune is a ONE-place edit).
 */
describe("velocityCusumSeries - FIR restart to h_red/2 at the ACTION limit", () => {
  const N = 20;
  // NET drift per close, DERIVED from the warning limit rather than a literal: the fixture must take
  // MORE than one close to reach `h`, or "S⁺ dwelled above the warning limit" is true of every close
  // under both recurrences and the discrimination below goes vacuous. A literal step did exactly that
  // when `h` was retuned down to it (2026-08-09 §3.12). At 0.6 of the warning limit the retired reset
  // fires on close 2 and the shipped one on close 3, which is the only spacing these tests need — and
  // every crossing clears its bound by a wide margin, so no assertion rides `z − k` rounding (at
  // exactly half, two steps land a hair BELOW `h` and the dwell run silently reads 1).
  const STEP = F9_CUSUM_H * 0.6;
  const z = Array.from({ length: N }, () => F9_CUSUM_K + STEP);
  const noResetOracle = z.map((_, i) => (i + 1) * STEP);
  const reset = (s: Array<number | undefined>) =>
    s.filter((v) => v !== undefined && v >= F9_CUSUM_H_RED);

  test("PREMISE: the ACTION limit is above one step, above the warning limit, and reachable", () => {
    // Guards the three ways this suite could go vacuous: a reset bound ≤ 1 resets on every close
    // (no ratchet to break), one past the fixture's reach never resets at all, and one at or below
    // the warning limit would collapse the two tiers back into the pre-§3.6a single-bound leg.
    expect(F9_CUSUM_H_RED).toBeGreaterThan(STEP);
    expect(F9_CUSUM_H_RED).toBeLessThan((N * STEP) / 2);
    expect(F9_CUSUM_H_RED).toBeGreaterThan(F9_CUSUM_H);
    // …and the fourth, introduced when the step became derived: the two bounds must be far enough
    // apart to fall on DIFFERENT closes. Two steps must clear the warning limit but not the action
    // limit, or both recurrences reset together and the dwell discrimination below ties at 1.
    expect(2 * STEP).toBeGreaterThan(F9_CUSUM_H);
    expect(2 * STEP).toBeLessThan(F9_CUSUM_H_RED);
    // FIR premise: the head-start must land BELOW the warning limit, or the restart day itself
    // would read amber and the "alarm is a single-day event" contract dies silently.
    expect(F9_CUSUM_H_RED / 2).toBeLessThan(F9_CUSUM_H);
    // …and below one fixture step of the action limit, or the post-fire close re-fires and the
    // head-start assertion below compares against a reset value instead.
    expect(STEP).toBeLessThan(F9_CUSUM_H_RED / 2);
  });

  test("an unbroken drift RE-FIRES instead of ratcheting, and S⁺ stays bounded", () => {
    const out = velocityCusumSeries(z, F9_CUSUM_K, F9_CUSUM_H_RED);
    const peak = Math.max(...out.map((v) => v ?? 0));
    // Bounded: the reset day is emitted, then FIR-restarted, so S⁺ can never exceed the action
    // limit plus one step.
    expect(peak, "S⁺ must be bounded by the action limit + one step").toBeLessThanOrEqual(
      F9_CUSUM_H_RED + STEP,
    );
    // Re-arms: every reset day is followed by a strictly SMALLER value (the FIR restart).
    const fireIdx = out.flatMap((v, i) => (v !== undefined && v >= F9_CUSUM_H_RED ? [i] : []));
    expect(fireIdx.length).toBeGreaterThan(1);
    for (const i of fireIdx.filter((i) => i + 1 < out.length)) {
      expect(out[i + 1]!, `@${i + 1} must re-arm from h_red/2`).toBeLessThan(out[i]!);
      // DISCRIMINATION vs the retired restart-to-0: the post-fire close carries the head-start,
      // so it reads h_red/2 + one net step, not one net step alone.
      expect(out[i + 1]!, `@${i + 1} must carry the FIR head-start`).toBeCloseTo(
        F9_CUSUM_H_RED / 2 + STEP,
        10,
      );
    }
    // DISCRIMINATION — the no-reset recurrence on this same input ratchets: it sits above the
    // action limit on every day from the crossing onward and its peak grows with N. Both
    // assertions above red under it.
    expect(reset(noResetOracle).length).toBeGreaterThan(reset(out).length);
    expect(Math.max(...noResetOracle)).toBeGreaterThan(F9_CUSUM_H_RED + STEP);
  });

  test("the WARNING limit does not reset - S⁺ DWELLS above it instead of one crossing day", () => {
    // §3.6a's whole mechanism: with the reset at the warning limit S⁺ was cut down the moment it
    // signalled amber, so it was above `h` for the crossing day ALONE (run length 1) and the
    // action limit was unreachable except by one outsized step. The shipped recurrence must hold
    // above the warning limit for CONSECUTIVE closes — which is what makes the red line crossable.
    // Longest run of closes with S⁺ ≥ the warning limit, under each reset point.
    const longestRun = (s: Array<number | undefined>) => {
      let best = 0;
      let run = 0;
      for (const v of s) {
        run = v !== undefined && v >= F9_CUSUM_H ? run + 1 : 0;
        if (run > best) best = run;
      }
      return best;
    };
    const shipped = velocityCusumSeries(z, F9_CUSUM_K, F9_CUSUM_H_RED);
    // DISCRIMINATION: the retired recurrence (reset-to-0 AT the warning limit) on this same input,
    // recomputed inline as an oracle — the shipped function FIR-restarts and can no longer emulate it.
    const retired: number[] = [];
    let sRet = 0;
    for (const zi of z) {
      sRet = Math.max(0, sRet + zi - F9_CUSUM_K);
      retired.push(sRet);
      if (sRet >= F9_CUSUM_H) sRet = 0;
    }
    expect(longestRun(retired), "PREMISE: the retired reset admitted no dwell").toBe(1);
    expect(longestRun(shipped)).toBeGreaterThan(longestRun(retired));
  });

  test("a degraded day still HOLDS the accumulator rather than resetting it", () => {
    // The pre-existing contract (an unknown step is not evidence of a reversal) must survive the
    // reset: only reaching the ACTION limit restarts S⁺.
    const withGap = [F9_CUSUM_K + STEP, undefined, F9_CUSUM_K + STEP];
    const out = velocityCusumSeries(withGap, F9_CUSUM_K, F9_CUSUM_H_RED);
    expect(out[1]).toBeUndefined();
    // Two net steps held across the gap — and below the action limit, so nothing reset here.
    expect(out[2]!).toBeCloseTo(2 * STEP, 10);
  });
});

describe("scoreMoveLevel - R6 MOVE three-leg worst-of (rolling · velocity · absolute)", () => {
  // R6 scores via scoreMoveLevel since 2026-08-30 (Stage 1b), NOT scoreIndicator. Three OR'd legs:
  // R6_DESCRIPTOR's rolling-detrended level + velocity, and the ABSOLUTE pair off R6.thresholds
  // (the ONE source — derived here, never restated). base ≈ 449, so fixtures run 520 closes.
  const amber = R6.thresholds.amberLevel!;
  const red = R6.thresholds.redLevel!;
  const NR6 = 520;
  const obsOf = (vals: number[]) => vals.map((value, i) => ({ date: `d${i}`, value }));
  // Rise to a peak then decline to a high plateau: the tail sits WELL BELOW its own trailing mean
  // (level GREEN) and is still falling (velocity GREEN), so only the absolute pair can fire.
  const riseFall = (peak: number, tail: number) => {
    const peakAt = 300;
    return obsOf(
      Array.from({ length: NR6 }, (_, i) =>
        i <= peakAt ? 40 + ((peak - 40) * i) / peakAt : peak - ((peak - tail) * (i - peakAt)) / (NR6 - 1 - peakAt),
      ),
    );
  };
  // A low, gently-wobbling base (nonzero σ) that ramps up hard over the last 8 closes — a velocity
  // shock whose tail is still BELOW `amber`, so the absolute leg cannot fire.
  const lateSpike = (tailBelowAmber: number) =>
    obsOf(
      Array.from({ length: NR6 }, (_, i) => {
        const base = 60 + (i % 2);
        return i < NR6 - 8 ? base : base + ((tailBelowAmber - base) * (i - (NR6 - 8))) / 7;
      }),
    );

  test("absolute leg fires on its own: level+velocity GREEN, value > red ⇒ RED", () => {
    const obs = riseFall(red + 70, red + 5);
    // Control with unreachable thresholds isolates the non-absolute legs — they are GREEN here.
    const noAbs = indicator({ id: "R6X", thresholds: { amberLevel: 1e9, redLevel: 1e9 } });
    expect(scoreMoveLevel(noAbs, obs).state).toBe("GREEN");
    expect(scoreMoveLevel(R6, obs).state).toBe("RED"); // absolute pair alone reddens it
  });

  test("rolling/velocity legs raise the state above a GREEN absolute leg", () => {
    const obs = lateSpike(amber - 10); // tail < amber ⇒ absolute leg GREEN by construction
    expect(obs.at(-1)!.value).toBeLessThan(amber);
    expect(scoreMoveLevel(R6, obs).state).toBe("RED");
  });
});

describe("scoreBullSteepener (R7 - 2y-led curve re-steepening, RATE confirmer)", () => {
  // bullSteepenerState(d2y, d10y, cuts): the state decomposes on the 2y vs 10y curve, NOT the
  // 3m-anchored term spread (review 2026-07-02, I1). dSteepen = d10y − d2y. Cuts are the day's
  // RANKED pair (per-day, from a rolling BULL_CUT_WINDOW tail) — these fixtures pass them explicitly.
  const CUTS = { dropAmber: -0.35, dropRed: -0.6, steepAmber: 0.3, steepRed: 0.5 };
  test("bullSteepenerState: RED on EITHER tail; a non-red day caps at AMBER (or combine)", () => {
    expect(bullSteepenerState(-0.7, -0.15, CUTS)).toBe("RED"); // drop ≤ −0.6 (steepen +0.55 also red)
    expect(bullSteepenerState(-0.7, -0.35, CUTS)).toBe("RED"); // drop tail ALONE now reaches RED (was AMBER under split)
    expect(bullSteepenerState(-0.55, -0.05, CUTS)).toBe("RED"); // steepen +0.50 ≥ steepRed ALONE, drop −0.55 not in red tail
    expect(bullSteepenerState(-0.4, -0.1, CUTS)).toBe("AMBER"); // drop ≤ −0.35 amber only, neither red tail
  });
  test("bullSteepenerState: a healthy bear-steepener (long end up, 2y up/flat) is GREEN", () => {
    expect(bullSteepenerState(0.1, 0.3, CUTS)).toBe("GREEN"); // 2y rising, not falling
    expect(bullSteepenerState(-0.3, 0.2, CUTS)).toBe("GREEN"); // 2y drop < steepening ⇒ long-end-driven
  });
  test("bullSteepenerState: a flattening curve (dSteepen ≤ 0) never fires", () => {
    expect(bullSteepenerState(-0.5, -0.7, CUTS)).toBe("GREEN"); // 10y fell more than 2y ⇒ flattening
  });
  // I1 regression: the discriminating case the old (3m-anchored) rule got WRONG. The 2y
  // collapses 0.70 and the 10y only 0.20 (flight-to-safety), so it IS a bull steepener —
  // even though the 3m bill hasn't moved yet, so T10Y3M stays flat/inverted. Must fire.
  test("bullSteepenerState: 2y collapse fires even when the 3m-anchored spread is flat", () => {
    expect(bullSteepenerState(-0.7, -0.15, CUTS)).toBe("RED"); // decoupled from the 3m leg
  });
  // The leg+cut seam `api/series.ts`' R7 branch draws from. `dSteep` and `shortEndDriven` are
  // the two fields no pre-seam test touched; both are pinned against the FIXTURE arithmetic and
  // against `bullSteepenerState` respectively, never against the seam's own output.
  const N = VELOCITY_WINDOW + BULL_MIN_OBS + 80;
  const day = (i: number) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10);
  const g2 = Array.from({ length: N }, (_, i) => 2 + Math.sin(i / 7) * 0.9 + Math.cos(i / 23) * 0.5);
  const g10 = Array.from({ length: N }, (_, i) => 3 + Math.sin(i / 11) * 0.6);
  const obs = (v: number[]) => v.map((value, i) => ({ date: day(i), value }));
  const legs = bullSteepenerLegSeries(
    obs(g10.map((v, i) => v - g2[i]!)),
    obs(g2),
    obs(g10),
  );
  const R7_BASE = VELOCITY_WINDOW + BULL_MIN_OBS;

  test("bullSteepenerLegSeries: dSteep is Δ20(10y) − Δ20(2y), off the raw legs", () => {
    for (const i of [R7_BASE, R7_BASE + 17, N - 1]) {
      const want = g10[i]! - g10[i - VELOCITY_WINDOW]! - (g2[i]! - g2[i - VELOCITY_WINDOW]!);
      expect(legs.dSteep[i]!).toBeCloseTo(want, 12);
      expect(legs.drop[i]!).toBeCloseTo(g2[i]! - g2[i - VELOCITY_WINDOW]!, 12);
    }
  });

  // The hoisted gate must be the SAME gate `bullSteepenerState` applies inline: with all four
  // cuts at 0, a gate-on day is RED (drop ≤ 0 fires the 2y-drop tail alone under `or`) and a
  // gate-off day is GREEN, so the biconditional reads the flag through the other function, not the seam.
  test("bullSteepenerLegSeries: shortEndDriven is bullSteepenerState's own gate", () => {
    const ZERO = { dropAmber: 0, dropRed: 0, steepAmber: 0, steepRed: 0 };
    for (let i = VELOCITY_WINDOW; i < N; i++) {
      expect(legs.shortEndDriven[i]).toBe(bullSteepenerState(legs.drop[i]!, legs.d10[i]!, ZERO) === "RED");
    }
    expect(legs.shortEndDriven.filter(Boolean).length).toBeGreaterThan(0); // fixture reaches the regime
    expect(legs.shortEndDriven.slice(VELOCITY_WINDOW).some((f) => !f)).toBe(true);
  });

  // mult < 1 fires EARLIER on both legs: never a calmer day, and each leg's scaled cuts alone flip ≥1 day.
  test("bullSteepenerLegSeries: mult < 1 moves drop (LOW) and steep (HIGH) cuts earlier", () => {
    const early = bullSteepenerLegSeries(obs(g10.map((v, i) => v - g2[i]!)), obs(g2), obs(g10), 0.5);
    const rank = { GREEN: 0, AMBER: 1, RED: 2 } as Record<string, number>;
    const at = (c: typeof legs.cuts, i: number) => ({
      dropAmber: c.dropAmber[i]!, dropRed: c.dropRed[i]!, steepAmber: c.steepAmber[i]!, steepRed: c.steepRed[i]!,
    });
    let dropFlips = 0;
    let steepFlips = 0;
    for (let i = R7_BASE; i < N; i++) {
      const base = at(legs.cuts, i);
      const s0 = rank[bullSteepenerState(legs.drop[i]!, legs.d10[i]!, base)]!;
      const scaled = at(early.cuts, i);
      expect(rank[bullSteepenerState(legs.drop[i]!, legs.d10[i]!, scaled)]!).toBeGreaterThanOrEqual(s0);
      const dropOnly = { ...base, dropAmber: scaled.dropAmber, dropRed: scaled.dropRed };
      const steepOnly = { ...base, steepAmber: scaled.steepAmber, steepRed: scaled.steepRed };
      if (rank[bullSteepenerState(legs.drop[i]!, legs.d10[i]!, dropOnly)]! > s0) dropFlips++;
      if (rank[bullSteepenerState(legs.drop[i]!, legs.d10[i]!, steepOnly)]! > s0) steepFlips++;
    }
    expect(dropFlips).toBeGreaterThan(0);
    expect(steepFlips).toBeGreaterThan(0);
  });

  // A3 (token-efficiency r2): the ranking base is the 3-way inner join, truncated to the
  // LATEST-starting series (T10Y3M in prod) — never the rates' longer history.
  test("bullSteepenerLegSeries: ranking base = 3-way join truncated to the latest series start", () => {
    const K = 15; // spread (the T10Y3M stand-in) starts K days after the rate legs
    const lateSpread = obs(g10.map((v, i) => v - g2[i]!)).slice(K);
    const truncated = bullSteepenerLegSeries(lateSpread, obs(g2), obs(g10));
    expect(truncated.dates.length).toBe(N - K); // joined-day count = the intersection, exactly
    expect(truncated.dates[0]).toBe(day(K)); // base starts at the latest starter's first date
    // Rolling cuts are history-independent past the window: the SAME calendar day day(K + R7_BASE)
    // gets the SAME cut whether or not the extra K days of prefix exist, because only the trailing
    // BULL_CUT_WINDOW finite drops rank — an expanding strict-prefix scorer could NOT produce this.
    expect(truncated.cuts.dropAmber[R7_BASE]!).toBeCloseTo(legs.cuts.dropAmber[K + R7_BASE]!, 12);
  });

  // The docblock invariant the whole warm-up rests on: no scored day is ever emitted with a NaN
  // cut (which would read as a false GREEN), because the first finite cut lands exactly at
  // `baseOffset` — the same index `bullSteepenerReadingSeries` starts classifying at.
  test("bullSteepenerLegSeries: the first finite cut lands exactly at baseOffset", () => {
    for (const c of Object.values(legs.cuts)) {
      expect(Number.isNaN(c[R7_BASE - 1]!)).toBe(true);
      expect(Number.isFinite(c[R7_BASE]!)).toBe(true);
    }
  });

  // Rolling-window regression (the direct falsifier for "the cut line is straight"): an extreme
  // 2y-drop cluster that sits INSIDE the trailing BULL_CUT_WINDOW at day A but has rolled OUT of it
  // by day B (a window+40 later) must move the low-tail cut by ≥1pp. A long calm prefix makes the
  // cluster a negligible fraction of an EXPANDING base — so on `expandingPercentile` the cut barely
  // moves (measured travel ~0.0015pp) and this reds; only `rollingPercentile` lets it travel.
  test("bullSteepenerLegSeries: the rolling cut moves as an extreme leaves the window", () => {
    const R7_BASE2 = VELOCITY_WINDOW + BULL_MIN_OBS;
    const M = R7_BASE2 + 900;
    const dayM = (i: number) => new Date(Date.UTC(2005, 0, 1 + i)).toISOString().slice(0, 10);
    const C0 = R7_BASE2 + 500; // sharp 25-day 2y decline then a low plateau (no rebound spike)
    const g2r = Array.from({ length: M }, (_, i) => {
      let v = 2 + Math.sin(i / 9) * 0.15;
      if (i >= C0 && i < C0 + 25) v -= (i - C0) * 0.3;
      else if (i >= C0 + 25) v -= 25 * 0.3;
      return v;
    });
    const g10r = Array.from({ length: M }, (_, i) => 3 + Math.sin(i / 13) * 0.1);
    const obsM = (v: number[]) => v.map((value, i) => ({ date: dayM(i), value }));
    const roll = bullSteepenerLegSeries(obsM(g10r.map((v, i) => v - g2r[i]!)), obsM(g2r), obsM(g10r));
    const A = C0 + 40; // cluster's negative drops inside the trailing window
    const B = A + BULL_CUT_WINDOW + 40; // a full window later: the cluster has rolled out
    expect(roll.cuts.dropAmber[A]!, "fixture must reach the extreme regime at A").toBeLessThan(-1);
    expect(roll.cuts.dropAmber[B]! - roll.cuts.dropAmber[A]!).toBeGreaterThan(1); // the cut rose ≥1pp
  });

  test("bullSteepenerState: cut boundaries are inclusive on both legs", () => {
    expect(bullSteepenerState(-0.6, -0.1, CUTS)).toBe("RED"); // drop == −0.60, steepen == +0.50
    expect(bullSteepenerState(-0.35, -0.05, CUTS)).toBe("AMBER"); // drop == −0.35 (inclusive)
    expect(bullSteepenerState(-0.34, -0.1, CUTS)).toBe("GREEN"); // one tick shy on BOTH legs (steepen +0.24)
  });
  // A NaN cut (a warm-up day that somehow reached the state fn) must not read as a fire.
  test("bullSteepenerState: NaN cuts never fire", () => {
    expect(bullSteepenerState(-2, -0.1, { dropAmber: NaN, dropRed: NaN, steepAmber: NaN, steepRed: NaN })).toBe(
      "GREEN",
    );
  });

  // The dynamic cuts need history: BASE = the warm-up the series drops (VELOCITY_WINDOW +
  // BULL_MIN_OBS), then a 4-day tail. The baseline WIGGLES (deterministic sinusoid) so the
  // ranked cuts are non-degenerate — a flat baseline would put every cut at 0 and make any
  // drop fire, passing whatever the percentile constants were.
  const BASE = 20 + BULL_MIN_OBS;
  const steepObs = (spreadTail: number[], dgs2Tail: number[], dgs10Tail: number[]) => {
    const len = BASE + spreadTail.length;
    const dates = Array.from({ length: len }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const mk = (base: number, wiggle: number, tail: number[]) =>
      [...Array.from({ length: BASE }, (_, i) => base + wiggle * Math.sin(i / 3)), ...tail].map((value, i) => ({
        date: dates[i]!,
        value,
      }));
    return {
      spread: mk(-0.5, 0, spreadTail), // headline only — flat so `delta20` is exactly the tail move
      dgs2: mk(5.0, 0.05, dgs2Tail),
      dgs10: mk(4.5, 0.03, dgs10Tail),
    };
  };

  test("a 2y collapse (10y falling less) confirms RED; headline reads the term spread", () => {
    const { spread, dgs2, dgs10 } = steepObs([-0.2, -0.2, -0.2, -0.2], [4.3, 4.3, 4.3, 4.3], [4.3, 4.3, 4.3, 4.3]);
    const r = scoreBullSteepener(R7, spread, dgs2, dgs10); // d2y −0.70, d10y −0.20
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED"); // GREEN→RED held 2 closes
    expect(r.level).toBeCloseTo(-0.2); // headline = the term spread, not the 2y
    expect(r.delta20).toBeCloseTo(0.3);
  });
  test("a RED 2y collapse fires even when the term spread stays inverted (3m-independent)", () => {
    // Spread flat at −0.5 (3m hasn't moved) but the 2y collapses 0.70 vs a 0.20 10y drop.
    const { spread, dgs2, dgs10 } = steepObs([-0.5, -0.5, -0.5, -0.5], [4.3, 4.3, 4.3, 4.3], [4.3, 4.3, 4.3, 4.3]);
    expect(scoreBullSteepener(R7, spread, dgs2, dgs10).state).toBe("RED");
  });
  test("a bear-steepener (2y rising with the long end) stays GREEN", () => {
    const { spread, dgs2, dgs10 } = steepObs([-0.2, -0.2, -0.2, -0.2], [5.2, 5.2, 5.2, 5.2], [4.8, 4.8, 4.8, 4.8]);
    expect(scoreBullSteepener(R7, spread, dgs2, dgs10).state).toBe("GREEN");
  });
});

// TOMBSTONE (2026-09-01, test-suite value audit §5 ruling 3): removed the two legacy raw-close
// describes — "post-inversion floor rung … (T10Y3M_POST_INVERSION, legacy fixture)" (11 tests) and
// "always-on drawdown leg … (T10Y3M_DRAWDOWN … legacy fixture)" (7 tests). Both drove config shapes
// synthesized as `{ ...byId("R1"), drawdownLeg }` that NO production path builds (R1's live path is
// `smoothedLevelReadingSeries`; T10Y3M_DRAWDOWN was un-wired from R1's registry entry 2026-08-31).
// The generic `drawdownLeg` / post-inversion machinery stays live in src/ — this is a TEST-ONLY drop;
// accepted trade: the generic branches now go untested. See dashboard.score-indicator legacy region.

describe("R8 mean-space rung - arming, warm-up cuts and escalation run in MEAN space (R8_MEAN_POST_INVERSION)", () => {
  const R8 = byId("R8");
  const cfg = R8.postInversionCooldown!;
  const lc = cfg.levelCuts!;
  const win = SMOOTHED_LEVEL_OF["R8"]!.window;
  const { qualifyN, floorLevel, releaseN } = cfg;
  const vw = R8.velocityWindow!;
  const calm = floorLevel + 0.1;
  // Between red's clamp CEILING and the warm-up amber hold: armed, this mean is AMBER by level and
  // could never be a red-cut hit whatever the pool ranks.
  const mid = (lc.red.clamp[1] + floorLevel) / 2;
  // Below zero (arms) AND below red's clamp FLOOR — a red cut, were one present, WOULD fire on it.
  const inverted = Math.min(-0.2, lc.red.clamp[0] - 0.5);
  const obsOf = (vals: number[]) => vals.map((v, i) => ({ date: `d${String(i).padStart(4, "0")}`, value: v }));
  const seg = (v: number, n: number) => Array<number>(n).fill(v);
  const warm = seg(calm, win + vw);
  // Constant tails ≥ win pin the mean to the constant, and a flat tail ≥ vw parks Δ(vw) at 0 — the
  // level assertions below can never be a falling-mean velocity fire in disguise.
  const armedFlat = [...warm, ...seg(inverted, win + qualifyN + vw)];
  const released = [...armedFlat, ...seg(calm, win + releaseN), ...seg(mid, win + vw)];

  test("armed sub-cut mean during warm-up: AMBER off the floorLevel hold - and NOT red, the red cut is ABSENT", () => {
    // Premise: the pool is under warm-up, so amber holds floorLevel and red is null.
    expect(armedFlat.length).toBeLessThan(cfg.cutWarmupObs);
    const r = smoothedLevelReadingSeries(R8, obsOf(armedFlat), win);
    expect(r.at(-1)!.state).toBe("AMBER");
    expect(r.at(-1)!.level).toBeCloseTo(inverted, 10); // the emitted level IS the flat mean
  });

  test("a raw-close burst that never drags the MEAN negative does not arm - arming counts means, not closes", () => {
    // qualifyN raw closes < 0 (the retired raw-space rung would arm) inside an otherwise-calm run.
    const burst = [...warm, ...seg(inverted, qualifyN), ...seg(mid, win + vw)];
    const r = smoothedLevelReadingSeries(R8, obsOf(burst), win);
    // Unarmed ⇒ no cut ⇒ the sub-floorLevel final mean is GREEN; an armed rung would amber it.
    expect(r.at(-1)!.state).toBe("GREEN");
  });

  test("releaseN means ≥ floorLevel disarm; a later sub-floorLevel mean scores GREEN", () => {
    const r = smoothedLevelReadingSeries(R8, obsOf(released), win);
    expect(r.at(-1)!.level).toBeCloseTo(mid, 10);
    expect(r.at(-1)!.state).toBe("GREEN");
  });

  // Shorts flat at `drop` with a final-day fall to 0: the last day's trailing-window delta is
  // EXACTLY `drop` — derived from the knob (never restated).
  const shortsOf = (n: number, drop: number) =>
    obsOf(Array.from({ length: n }, (_, i) => (i === n - 1 ? 0 : drop)));
  const bullStep = cfg.shortLegDropBp / 100;

  test("steepener escalation: an armed level-firing day on a bull short leg paints RED", () => {
    const r = smoothedLevelReadingSeries(R8, obsOf(armedFlat), win, shortsOf(armedFlat.length, bullStep));
    expect(r.at(-1)!.state).toBe("RED");
  });

  test("escalation is gated on the LEVEL leg firing - a released bull day stays GREEN", () => {
    const r = smoothedLevelReadingSeries(R8, obsOf(released), win, shortsOf(released.length, bullStep));
    expect(r.at(-1)!.state).toBe("GREEN");
  });

  test("each reading STAMPS its armed mean-space pair under R8's wire keys (Stage 2.2)", () => {
    const obs = obsOf(released);
    const r = smoothedLevelReadingSeries(R8, obs, win);
    // Recompute the SAME per-day pair the scorer classified against, off the trailing means —
    // via the real `meanLevelCutSeries`, so an index/key mismatch on the stamp reds.
    const means: number[] = [];
    const meanDates: string[] = [];
    for (let i = win - 1; i < obs.length; i++) {
      let sum = 0;
      for (let k = i - win + 1; k <= i; k++) sum += obs[k]!.value;
      means.push(sum / win);
      meanDates.push(obs[i]!.date);
    }
    const { amber, red } = meanLevelCutSeries(means, meanDates, cfg);
    const [amberBand, redBand] = R8_MEAN_CUT_BANDS;
    let stampedAmber = 0;
    r.forEach((reading, k) => {
      const expA = amber[k] != null && Number.isFinite(amber[k]!) ? amber[k]! : undefined;
      const expR = red[k] != null && Number.isFinite(red[k]!) ? red[k]! : undefined;
      expect(reading.bandCuts?.[amberBand.key], `${reading.date} amber`).toBe(expA);
      expect(reading.bandCuts?.[redBand.key], `${reading.date} red`).toBe(expR);
      if (expA !== undefined) stampedAmber++;
    });
    // Vacuity: the fixture arms the rung, so a finite amber cut is actually stamped somewhere.
    expect(stampedAmber).toBeGreaterThan(0);
  });
});
