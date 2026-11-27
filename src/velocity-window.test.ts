import { describe, expect, test } from "vitest";

import { ALL_INDICATORS } from "./registry.js";
import { indicatorReadingSeries } from "./scorers-core.js";
import { VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import { type CalibrationCuts } from "./domain-cuts.js";

// Stage 1.3 DELETED F1's registry velocity prior (1.0/1.75), so these window-mechanics fixtures
// thread an explicit RESOLVED velocity cut instead of leaning on the (now-gone) convention. The
// value reproduces the old convention exactly, so the fired-observation expectations below (which
// pin F1's WINDOW, not the cut) are unchanged; a window delta of 3.0 fires the vel-evt leg at 1.75.
const F1_VEL_CUT: CalibrationCuts = { velEvtAmber: 1.0, velEvtRed: 1.75 };
// F1's override, read off the registry; every off-by-w trap below discriminates only while it ≠ VELOCITY_WINDOW.
const F1_WINDOW = ALL_INDICATORS.find((i) => i.id === "F1")!.velocityWindow!;

/**
 * EW-4 / D-A (Stage 1.2) — F1 carries its own velocity lookback; an id with no override stays at VELOCITY_WINDOW.
 * (The override MEMBERSHIP is pinned below; F1's window value is read, never pinned.)
 *
 * The trap this pins: `velocityDelta(values, w)` returns an array whose index `k` is
 * observation `k + w`, so `scoreDaySeries` must read `deltas[i - w]`. Reading it as
 * `deltas[i - VELOCITY_WINDOW]` is correct ONLY at w = VELOCITY_WINDOW — at F1's longer w it stays
 * in range and yields a plausible-but-wrong (`w − VELOCITY_WINDOW`-shifted) delta. A NON-LINEAR synthetic
 * series is therefore mandatory: on a straight ramp every window-w slice has the same
 * width and the off-by-w would be invisible. `v[i] = i*i` makes each index distinct.
 *
 * The emitted delta is CLAMPED at the series start (`buildReadings`/`scoreDaySeries` use
 * `values[Math.max(0, i - w)]`), so at F1's w the leading `w − VELOCITY_WINDOW` scored
 * rows read `values[i] − values[0]`; the expectation mirrors that clamp.
 */
describe("per-indicator velocity window (EW-4)", () => {
  const N = 60;
  // Quadratic ramp: v[i] - v[i-w] is strictly increasing in i, so a w-index misread
  // produces a DIFFERENT number at every scored day.
  const values = Array.from({ length: N }, (_, i) => i * i);
  const obs: Observation[] = values.map((v, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    value: v,
  }));

  const byId = (id: string) => ALL_INDICATORS.find((i) => i.id === id)!;

  const expectDeltasSpan = (id: string, w: number) => {
    const readings = indicatorReadingSeries(byId(id), obs);
    expect(readings.length).toBe(N - VELOCITY_WINDOW);
    for (const r of readings) {
      const i = values.indexOf(r.level);
      expect(i).toBeGreaterThanOrEqual(VELOCITY_WINDOW);
      // Mirror production's start-of-series clamp (Math.max(0, i - w)) so F1's leading
      // rows (i - w < 0) compare against values[0] rather than an undefined lookback.
      expect(r.delta20).toBe(values[i]! - values[Math.max(0, i - w)]!);
    }
  };

  test("premise: VELOCITY_WINDOW is below F1's override (else the off-by-w traps cannot discriminate)", () => {
    expect(VELOCITY_WINDOW).toBeLessThan(F1_WINDOW);
  });

  test("F1 emits a delta over its own window (v[i] - v[i-w], clamped at the head)", () => {
    expectDeltasSpan("F1", F1_WINDOW);
  });

  test("F2 (no override) still emits a VELOCITY_WINDOW delta", () => {
    expectDeltasSpan("F2", VELOCITY_WINDOW);
  });

  test("F1 (30d), F3 (4-week), F9 (60d), F11 (60d), F17 (60d) and R8 (10d mean-space) are the ONLY ids carrying a velocity-window override", () => {
    const carriers = ALL_INDICATORS.filter((i) => i.velocityWindow !== undefined).map((i) => i.id);
    expect(carriers.sort()).toEqual(["F1", "F11", "F17", "F3", "F9", "R8"]);
    expect(byId("F3").velocityWindow).toBe(4);
    // F9's and F11's 60 are pinned (with the chart-span half) in `registry.test.ts`
    // §"F9 velocity-only (level axis retired 2026-08-07)" and §"F11 velocity-only (level axis
    // retired 2026-08-08)" — here only their MEMBERSHIP of the override set, so neither pair of
    // pins can be deleted by one edit.
  });
});

/**
 * The SCORED half of D-A (Stage 1.2). The block above pins the EMITTED `delta20`
 * (`buildReadings`, scorers-core.ts); this one pins the delta `scoreDaySeries` classifies on
 * — a genuinely separate code path, which is why the `deltas[i - w]` re-index needs its
 * own falsifier. Under the off-by-w the fold reads `deltas[i - VELOCITY_WINDOW]` =
 * `v[i − VELOCITY_WINDOW + w] − v[i − VELOCITY_WINDOW]` at F1's w: a FORWARD-looking window shifted
 * `w − VELOCITY_WINDOW` observations early. In range, plausible, and wrong. A single up-bump makes the true and
 * mis-indexed RED windows DISJOINT.
 */
describe("F1's scored velocity leg reads its own-window delta, not a VELOCITY_WINDOW-indexed one", () => {
  const N = 80;
  // Zero everywhere except a 3-day up-bump to 3.0 at i = 45,46,47. No level cut is threaded,
  // so the LEVEL leg never fires and every non-GREEN day is attributable to the velocity leg
  // alone. F1's window delta = 3.0 (> the threaded velEvtRed 1.75) exactly on the bump days; once
  // the bump falls out of F1's window the change is ≤ 0.
  const values = Array.from({ length: N }, (_, i) => (i >= 45 && i <= 47 ? 3.0 : 0));
  const obs: Observation[] = values.map((v, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    value: v,
  }));
  const f1 = ALL_INDICATORS.find((i) => i.id === "F1")!;

  test("the bump scores RED on exactly F1's window-change days, and goes quiet after", () => {
    const readings = indicatorReadingSeries(f1, obs, F1_VEL_CUT);
    // Aligned to obs[VELOCITY_WINDOW..], so reading k is observation k + VELOCITY_WINDOW.
    const redObsIdx = readings
      .map((r, k) => (r.rawState === "RED" ? k + VELOCITY_WINDOW : -1))
      .filter((i) => i >= 0);
    // True window delta > redVelocity(1.75) on exactly i = 45,46,47. The off-by-w shifts the
    // window `F1_WINDOW − VELOCITY_WINDOW` obs early, reddening a disjoint earlier triple.
    expect(redObsIdx).toEqual([45, 46, 47]);
    // The bump has fully left F1's window well before the tail, so the series is quiet.
    expect(readings.at(-1)!.rawState).toBe("GREEN");
  });
});

/**
 * The start-of-series CLAMP that F1's longer window makes reachable (D-A / Stage 1.2). At
 * F1's w the first `w − VELOCITY_WINDOW` scored observations have `i − w < 0`; production
 * clamps the lookback to `values[0]` (mirroring `buildReadings`, scorers-core.ts) so the scored
 * delta equals the emitted one. WITHOUT the clamp those rows read `deltas[<0] = undefined`
 * and the velocity leg silently darkens on the series head — this fixture reddens exactly
 * that head, so it goes GREEN (fails) if the clamp is dropped.
 */
describe("F1's scored velocity leg clamps its lookback at the series start", () => {
  const N = 60;
  // A step at i=1: v[0]=0 then 3.0 forever. No level cut threaded ⇒ level leg off. The
  // clamped delta is v[i]-v[0]=3.0 for i=VELOCITY_WINDOW..F1_WINDOW (RED), then v[i]-v[i-w]=0 (GREEN).
  const values = Array.from({ length: N }, (_, i) => (i === 0 ? 0 : 3.0));
  const obs: Observation[] = values.map((v, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    value: v,
  }));
  const f1 = ALL_INDICATORS.find((i) => i.id === "F1")!;

  test("the leading rows (i-w < 0) score RED off values[0], not a dropped undefined delta", () => {
    const readings = indicatorReadingSeries(f1, obs, F1_VEL_CUT);
    const redObsIdx = readings
      .map((r, k) => (r.rawState === "RED" ? k + VELOCITY_WINDOW : -1))
      .filter((i) => i >= 0);
    // Clamped: obs VELOCITY_WINDOW..F1_WINDOW all read v[i]-v[0]=3.0 > 1.75. Without the clamp all
    // but obs F1_WINDOW (deltas[0]) read an undefined delta (leg dark).
    const head = Array.from({ length: F1_WINDOW - VELOCITY_WINDOW + 1 }, (_, k) => VELOCITY_WINDOW + k);
    expect(redObsIdx).toEqual(head);
  });
});
