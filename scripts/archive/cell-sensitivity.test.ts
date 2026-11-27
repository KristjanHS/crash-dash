/**
 * W6 Stage 6.3 falsifiers.
 *
 * ⚠ RESTRUCTURED 2026-08-20. The SN defensive
 * seat made the last three estimated SN cells (`vl × Staples`, `xa × {Health, Staples}`) MEASURED, so
 * the estimated-cell population is now EMPTY board-wide and `cell_sensitivity.json` carries `cells: []`.
 * `buildVintage()` therefore reproduces an EMPTY vintage. Every per-cell pin that used to read a live
 * vintage record has NO survivor to re-point to — so the shrink CONTRACT is now pinned by driving the
 * pure generator functions (`shrinkSoftForm`, `limitedTranslation`, `placeboSdPp`/`placeboSigma`,
 * `measuredPool`) on SYNTHETIC inputs, exactly the shape claims 2/6/7 already used. The functions are
 * still live production code (`src/danger-engine.ts` imports the committed vintage) and each red demo is
 * fireable by mutating one line of `cell-sensitivity.ts` (named per test).
 *
 * Coverage genuinely lost with the drained population: the per-record FIELD/KEY-SET sweep and the A/B
 * `control.moved` artifact pin had no home once no cell is emitted; their pure-function cores (the blend
 * moved the estimate; the field shape) are re-expressed synthetically below. When a future re-seat
 * revives an estimated cell, `buildVintage` emits it and the "reproduces EMPTY" pin reds LOUD.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildVintage,
  limitedTranslation,
  shrinkSoftForm,
  measuredPool,
  placeboSdPp,
  placeboSigma,
  type CellSensitivityVintage,
} from "./cell-sensitivity.js";
import { familyClassTarget } from "../../src/danger-engine.js";
import { LADDER } from "../../src/families.js";
import { mean } from "../lib/stats.js";

const committed = JSON.parse(
  readFileSync(new URL("./cell_sensitivity.json", import.meta.url), "utf8"),
) as CellSensitivityVintage;

// One deterministic recompute shared across the suite (offline: committed fixtures only), built LAZILY.
let recomputedMemo: CellSensitivityVintage | undefined;
const recompute = (): CellSensitivityVintage => (recomputedMemo ??= buildVintage(committed.generated));

describe("cell_sensitivity.json (W6 Stage 6.3)", () => {
  // S4: the vintage is EMPTY and `buildVintage()` reproduces it empty. Fails forward — a re-seat that
  // revives an estimated cell makes `buildVintage` emit it and reds here (0 ≠ 1). Red demo: append a
  // synthetic cell to the committed JSON → `committed.cells` is non-empty → this reds.
  it("buildVintage reproduces the committed vintage — now EMPTY (SN seat drained all estimated cells)", () => {
    expect(recompute().cells).toEqual([]);
    expect(committed.cells).toEqual([]);
  });

  // OQ-5 Stage 4.1 — the vintage↔generator top-level pin. NOT cell-dependent: `buildVintage` still emits
  // `stage`/`shrinkForm`/`bucket`/`horizon`/`note` on an empty vintage. `generated` is exempt (the
  // recompute is seeded FROM it). *Red demo:* change `PRIMARY_HORIZON` → the horizon pin reds.
  it("pins every top-level descriptor against buildVintage()'s own output (generated exempt)", () => {
    const r = recompute();
    expect(Object.keys(committed).sort()).toEqual(["bucket", "cells", "generated", "horizon", "note", "shrinkForm", "stage"]);
    for (const k of ["stage", "shrinkForm", "bucket", "note"] as const) {
      expect(committed[k], `top-level ${k}`).toBe(r[k]);
    }
    expect(committed.horizon, "top-level horizon").toBe(r.horizon);
  });

  // The descriptor must describe the CODE, not merely match a constant. `shrinkForm` claims the LINEAR
  // PRECISION BLEND `ŵ = α·rawSens + (1−α)·target`; this binds that prose to `shrinkSoftForm`'s behaviour
  // over a DISCRIMINATING grid (a geometric blend, a hard threshold, a swapped-weight blend, and a
  // rescaled target all separate at the interior points). *Red demo:* change `shrinkSoftForm`'s blend →
  // the descriptor no longer describes it → red.
  it("shrinkForm's prose describes shrinkSoftForm's actual blend (descriptor cannot outlive the formula)", () => {
    expect(committed.shrinkForm).toContain("wHatUnbounded = alpha*rawSens + (1-alpha)*target");
    expect(committed.shrinkForm).toContain("alpha = tau2/(tau2+sigma^2)");
    expect(committed.shrinkForm).toContain("wHat = clamp(wHatUnbounded, rawSens - D*sigma, rawSens + D*sigma)");
    const probes: ReadonlyArray<[number, number, number]> = [
      [0.9, 0.2, 0.25],
      [0.2, 0.9, 0.25],
      [1.7, 0.55, 0.6],
      [0.0, 0.8, 0.5],
      [0.4, 0.4, 0.3],
      [0.9, 0.2, 0.0], // α = 0 → pure target
      [0.9, 0.2, 1.0], // α = 1 → pure rawSens
    ];
    for (const [rawSens, target, alpha] of probes) {
      expect(
        shrinkSoftForm(rawSens, target, alpha),
        `shrinkSoftForm(${rawSens}, ${target}, ${alpha}) must equal the blend shrinkForm describes`,
      ).toBeCloseTo(alpha * rawSens + (1 - alpha) * target, 12);
    }
  });

  // Stage-6.2 resolver ↔ generator: the generator's `target` is `mean(measuredPool)`, and it must equal
  // the danger engine's `familyClassTarget` for every (estimated-family × leg) — single-sourcing the
  // shrink target so the two implementations of the stratified mean cannot drift. Driven on the LIVE
  // measured pool (still fully populated: 63 sensitive cells). Red demo: change `measuredPool`'s
  // risk-class filter, or `familyClassTarget`'s pool, → the two diverge and this reds.
  it("target equals the Stage-6.2 familyClassTarget: mean(measuredPool) ≡ familyClassTarget (resolver cannot drift)", () => {
    let checked = 0;
    for (const family of ["cr", "vl", "xa"] as const) {
      for (const leg of LADDER) {
        const pool = measuredPool(family, leg);
        expect(pool.length, `${family}×${leg} measuredPool`).toBeGreaterThan(0); // vacuity: pool populated
        expect(familyClassTarget(family, leg), `${family}×${leg}`).toBeCloseTo(mean(pool), 10);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // vacuity: the loop actually ran
  });

  // REACH-SCALE INVARIANT: the shrink pipeline keeps a reach in the `(0, 1]` scale. On a drained vintage
  // there is no cell to pin, so this drives BOTH `shrinkSoftForm` and the `limitedTranslation` clamp on a
  // SYNTHETIC grid of in-scale `(rawSens, target ∈ (0,1], α ∈ [0,1], σ ≥ 0)`: a convex blend of two
  // in-scale values stays in scale, and the clamp only ever pulls it TOWARDS the (in-scale) rawSens.
  // ⚠ BOTH quantities (Stage A.3 ruling Q4): an out-of-scale unbounded blend could be rescued into range
  // by the clamp, so the unbounded blend is checked too. *Red demo:* make `shrinkSoftForm` return
  // `rawSens + target` → the sum exceeds 1 on the grid → red.
  it("the shrink pipeline keeps a synthetic reach in the (0, 1] scale — bounded AND unbounded", () => {
    const grid: ReadonlyArray<[number, number, number, number]> = [
      [0.9, 0.2, 0.25, 0.1],
      [0.2, 0.9, 0.6, 0.3],
      [1.0, 0.4, 0.5, 0.2],
      [0.5, 0.5, 0.0, 0.4],
      [0.8, 0.6, 1.0, 0.05],
    ];
    for (const [rawSens, target, alpha, sigma] of grid) {
      const u = shrinkSoftForm(rawSens, target, alpha);
      const b = limitedTranslation(u, rawSens, sigma);
      for (const [label, v] of [["ŵ (unbounded)", u], ["ŵ", b]] as const) {
        expect(v, `${label} @(${rawSens},${target},${alpha},${sigma}) must be > 0`).toBeGreaterThan(0);
        expect(v, `${label} @(${rawSens},${target},${alpha},${sigma}) must be ≤ 1`).toBeLessThanOrEqual(1);
      }
    }
  });

  // FALSIFIER 3 (the A/B control arm's core): shrinkage MOVES the estimate — the shrunk blend differs
  // from the unshrunk `rawSens` whenever `α < 1` and `rawSens ≠ target`. Driven on `shrinkSoftForm`
  // directly (the artifact's `control.moved` had no cell to record on the drained vintage). *Red demo:*
  // make `shrinkSoftForm` return `rawSens` (no shrinkage) → the arms agree → red.
  it("control arm: shrinkage moves the estimate (shrunk blend ≠ unshrunk rawSens)", () => {
    const grid: ReadonlyArray<[number, number, number]> = [
      [0.9, 0.2, 0.5],
      [0.3, 0.8, 0.25],
      [1.2, 0.6, 0.8],
    ];
    for (const [rawSens, target, alpha] of grid) {
      expect(alpha).toBeLessThan(1);
      expect(rawSens).not.toBe(target);
      expect(shrinkSoftForm(rawSens, target, alpha), `shrinkage must move (${rawSens},${target},${alpha})`).not.toBeCloseTo(
        rawSens,
        6,
      );
    }
  });

  // STAGE A.2 (R1) — σ IS THE placebo SD ABOUT THE MEAN, NOT THE placebo MAX. On a drained vintage this
  // is asserted on `placeboSdPp`/`placeboSigma` DIRECTLY over a SYNTHETIC arm set whose SD-about-the-mean
  // and max differ sharply, so a revert to the max is caught. *Red demo:* revert `placeboSigma`'s input
  // to `row.placeboMaxPp` (the max) → `placeboSdPp` would return 10 not 3.6 → the `toBeCloseTo(3.6)` reds.
  it("sigma is the placebo SD about the mean on the reach scale, not the placebo max (Stage A.2 R1)", () => {
    const arms = [1, 1, 1, 1, 10]; // mean 2.8 ⇒ popVariance 12.96 ⇒ SD 3.6; max 10 — SD ≠ max by 2.8×
    const row = { placeboExcessPp: arms } as Parameters<typeof placeboSdPp>[0];
    const sd = placeboSdPp(row, "synthetic × cell");
    expect(sd, "placeboSdPp must be the SD about the mean").toBeCloseTo(3.6, 12);
    expect(sd, "…and NOT the placebo max").not.toBeCloseTo(Math.max(...arms), 6);
    // σ = SD × referenceReach / |referenceExcess| (the pp → [0,1] reach-scale mapping).
    const refAbs = 4;
    const referenceReach = 0.6;
    expect(placeboSigma(row, { refAbs, referenceReach }, "synthetic × cell")).toBeCloseTo((sd / refAbs) * referenceReach, 12);
  });

  // STAGE A.3 (R2) — THE LIMITED-TRANSLATION BOUND ACTUALLY CLIPS. Anchored on `limitedTranslation`
  // DIRECTLY over fixture triples whose clip is provable by hand at `D = 1` (out-of-band, never derived
  // from `LIMITED_TRANSLATION_D` — enlarging `D` is this test's red demo).
  it("limitedTranslation clips the blend to within D·sigma of rawSens (Stage A.3 R2)", () => {
    // CLIPS, upper side: blend 0.9 sits 0.7 above rawSens 0.2 against a cap of 1·0.1 → 0.2 + 0.1.
    expect(limitedTranslation(0.9, 0.2, 0.1), "upper-side clip").toBeCloseTo(0.3, 12);
    // CLIPS, lower side: blend 0.1 sits 0.7 below rawSens 0.8 against a cap of 1·0.2 → 0.8 − 0.2.
    expect(limitedTranslation(0.1, 0.8, 0.2), "lower-side clip").toBeCloseTo(0.6, 12);
    // DOES NOT CLIP: blend 0.9 sits 0.05 from rawSens 0.85, well inside the 1·0.5 cap → untouched.
    expect(limitedTranslation(0.9, 0.85, 0.5), "no clip").toBeCloseTo(0.9, 12);
    // σ = 0 degenerates the bound to "return rawSens".
    expect(limitedTranslation(0.9, 0.2, 0), "sigma = 0 collapses the interval to a point").toBeCloseTo(0.2, 12);
  });
});
