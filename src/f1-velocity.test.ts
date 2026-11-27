import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { ALL_INDICATORS } from "./registry.js";
import { evaluateLegs } from "./domain-legs.js";
import { resolveCuts, type CalibrationCuts } from "./domain-cuts.js";
import { assertF1VintagePresent } from "./run-cycle.js";

/**
 * F1's 30d velocity axis — MEASURED under Stage 1.2 (D-A), HAND-SET since 2026-07-28 (`[USER]`).
 *
 * The retune moved the Δ30d pair to 0.22 / 0.36 in `registry.ts`, which a `method: percentile_*`
 * calibration row cannot carry, so `CALIB_MAP.F1.evtVelocity` went false: the published
 * `credit/hyoas_evt_vel_{amber,red}` rows still EXIST but no longer resolve, and the axis scores
 * through the `vel-op` CONVENTION leg over the registry thresholds. This suite pins the convention
 * leg firing (the measured legs' darkness is pinned in `effective-cuts.test.ts`), because the failure
 * mode is silent: had the measured rows kept resolving, the lower measured amber (0.07) would
 * simply have kept binding and the retune would have been invisible on screen and in the notify.
 * Cuts are read from production (registry thresholds / the tracked calibration file), never
 * restated as literals.
 */
const CALIB = (
  JSON.parse(readFileSync(new URL("../scripts/backtest/calibration.json", import.meta.url), "utf8")) as {
    params: { channel: string; metric: string; value: number; market?: string | null; mode?: string | null }[];
  }
).params;

const credit = (metric: string): number | undefined =>
  CALIB.find((p) => p.market == null && p.mode == null && p.channel === "credit" && p.metric === metric)?.value;

const f1 = ALL_INDICATORS.find((i) => i.id === "F1")!;

describe("F1's retired measured 30d velocity rows (2026-07-28)", () => {
  test("the retired measured amber is BELOW the hand-set amber - i.e. the gate is load-bearing", () => {
    // The discriminating relation: while the measured leg resolved, it fired FIRST and the
    // registry pair could never be the amber the user sees. Derived from both sources, so it
    // tracks either one moving.
    expect(credit("hyoas_evt_vel_amber")!).toBeLessThan(f1.thresholds.amberVelocity!);
  });
});

describe("F1's velocity axis fires through the vel-op CONVENTION leg over the registry pair", () => {
  const cuts = resolveCuts("F1", CALIB, "HIGH");
  // The hand-set red velocity cut, read from production — the 30d Δ that must fire RED.
  const velRed = f1.thresholds.redVelocity!;
  // Level 0 is below every level cut, so no LEVEL leg fires and the only reachable RED legs are
  // the velocity ones — the fire is attributable to the velocity axis alone.
  const LEVEL_BELOW_ALL = 0;
  const redLegs = (delta20: number, c: CalibrationCuts) =>
    evaluateLegs("Red", LEVEL_BELOW_ALL, delta20, f1.thresholds, "HIGH", c);
  const velOpRedEntry = (delta20: number, c: CalibrationCuts = cuts) =>
    redLegs(delta20, c).find((l) => l.leg === "vel-op")!;

  test("a Δ30d past the registry red cut fires the vel-op leg → RED", () => {
    const e = velOpRedEntry(velRed + 1e-6);
    expect(e.bound).toBe(velRed); // the drawn line and the scored bound are this one number
    expect(e.fired).toBe(true);
    expect(redLegs(velRed + 1e-6, cuts).some((l) => l.fired)).toBe(true);
  });

  test("the convention leg is STRICT - a Δ30d exactly AT the cut does not fire", () => {
    // A live semantic difference the retune carries, not a test detail: the retired measured
    // `vel-evt` leg fired at `delta20 >= cut`, the convention `vel-op` leg fires at `> cut`
    // (`domain-legs.ts`). Immaterial on real data, but it is the boundary this axis now has.
    expect(velOpRedEntry(velRed).fired).toBe(false);
    expect(velOpRedEntry(velRed - 1e-6).fired).toBe(false);
  });
});

describe("fail-loud - F1 refuses to score on an absent credit/hyoas vintage (decision 4)", () => {
  const emptySynth = new Map<string, readonly number[]>();
  // Since 2026-07-28 the guard is a ROWS-PRESENT check on the whole `credit/hyoas` prefix: BOTH of
  // F1's measured legs are retired, so no resolved-cut form of it could distinguish a dropped
  // vintage section from normal operation — it would throw on every run. "Absent vintage" now
  // means the prefix itself is gone from the frozen `calibration.json` — a prune or a hand-edit,
  // since the `harness.py` regen this was written against retired 2026-08-15.
  const withoutHyoas = CALIB.filter((p) => !/^hyoas_/.test(p.metric));

  test("absent vintage (whole hyoas prefix dropped) ⇒ THROWS, naming the missing vintage", () => {
    // Prove the filter really emptied the prefix, else the throw is asserted on a path that
    // never runs.
    expect(withoutHyoas.some((p) => p.channel === "credit" && p.metric.startsWith("hyoas_"))).toBe(false);
    expect(() => assertF1VintagePresent(withoutHyoas, emptySynth)).toThrow(
      /missing credit\/hyoas calibration vintage/,
    );
  });

  test("dropping ONLY the velocity rows no longer throws - the guard's reach shrank by design", () => {
    // Stated as a test rather than a comment because it is a real LOSS of coverage: a partial
    // vintage is now undetectable here. It is acceptable only because nothing resolves off these
    // rows any more, so a half-published section cannot de-tighten a live cut.
    const withoutVelRows = CALIB.filter((p) => !/^hyoas_evt_vel_/.test(p.metric));
    expect(() => assertF1VintagePresent(withoutVelRows, emptySynth)).not.toThrow();
  });
});
