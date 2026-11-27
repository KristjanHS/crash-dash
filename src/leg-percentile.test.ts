/**
 * W4 Stage 4.3 — the rolling-ECDF primitive (`src/leg-percentile.ts`).
 *
 * Falsifiers 1 and 2 of the stage live here: the warm-up BOUNDARY (not "warm-up exists"), and that
 * the window is genuinely ROLLING rather than expanding — the test that makes the OQ-3 ruling a
 * fact about the code instead of a sentence in a docblock.
 */
import { describe, test, expect } from "vitest";
import {
  basisChangeDates,
  canonicalJson,
  ECDF_WINDOW,
  LEG_PILLAR_GENERATOR,
  legPillarGenerator,
  rollingEcdfRank,
} from "./leg-percentile.js";
import { MEMBER_WEIGHT } from "./danger-ladder.js";

/** `n` strictly-ascending observations, all < 1000 so a 1000 probe ranks at the top. */
const asc = (n: number): number[] => Array.from({ length: n }, (_, i) => i / n);

describe("rollingEcdfRank - warm-up boundary (falsifier 1)", () => {
  test(`exactly ECDF_WINDOW-1 observations ⇒ warmup; at ECDF_WINDOW ⇒ pct`, () => {
    // The pair is the whole point: a one-sided assert passes under `<`, `<=` AND a hard-coded
    // `return warmup`, so both sides of the boundary are asserted in one test.
    expect(rollingEcdfRank(asc(ECDF_WINDOW - 1), 0.5)).toEqual({ kind: "warmup" });
    const at = rollingEcdfRank(asc(ECDF_WINDOW), 0.5);
    expect(at.kind).toBe("pct");
    // 501 of the 500 values are ≤ 0.5? No — 251 are (i/500 ≤ 0.5 ⇔ i ≤ 250), inclusive of the tie
    // at exactly 0.5, so the rank is 251/500. Written as the exact fraction rather than "≈0.5" so
    // an off-by-one in the tie convention cannot hide inside a loose tolerance.
    expect(at.kind === "pct" && at.value).toBeCloseTo(251 / ECDF_WINDOW, 12);
  });

  test("the rank is a fraction of ECDF_WINDOW, never of the longer history handed in", () => {
    // 2× the window, values 0..1 ascending: only the NEWEST 500 (the upper half, ≥ 0.5) count, so a
    // probe at 0.5 ranks near ZERO — not near 0.5 as it would over the full history. This is the
    // denominator half of "rolling"; the tail-selection half is the next describe block.
    const long = asc(2 * ECDF_WINDOW);
    const r = rollingEcdfRank(long, 0.5);
    expect(r.kind).toBe("pct");
    expect(r.kind === "pct" && r.value).toBeCloseTo(1 / ECDF_WINDOW, 12);
  });

  test("ties count (`<= x`), so a value equal to every observation ranks 1", () => {
    // Pins the tie convention this file's docblock flags as the near-twin of slow.ts's
    // `percentileRank`. A `<` implementation would return 0 here.
    expect(rollingEcdfRank(new Array(ECDF_WINDOW).fill(0.3), 0.3)).toEqual({ kind: "pct", value: 1 });
  });
});

describe("rollingEcdfRank - rolling, NOT expanding (falsifier 2, pins OQ-3)", () => {
  test("the SAME new value ranks differently against two windows differing only in their oldest obs", () => {
    // Two 500-long windows, identical except for element 0. `x` sits between the two oldest values,
    // so it is ABOVE the old close in window A and BELOW it in window B ⇒ the counts differ by
    // exactly one observation. An expanding window (which would keep BOTH old closes forever) can
    // never show this difference; nor can any implementation that ignores the window's contents.
    const tail = Array.from({ length: ECDF_WINDOW - 1 }, (_, i) => 0.5 + i / 1000);
    const windowA = [0.0, ...tail];
    const windowB = [0.4, ...tail];
    const x = 0.2;
    const a = rollingEcdfRank(windowA, x);
    const b = rollingEcdfRank(windowB, x);
    expect(a).toEqual({ kind: "pct", value: 1 / ECDF_WINDOW });
    expect(b).toEqual({ kind: "pct", value: 0 });
    expect(a).not.toEqual(b);
  });

  test("roll-off: appending a NEW close moves the rank of an UNCHANGED value", () => {
    // The consequence the FE title must state. `history` is exactly ECDF_WINDOW long; appending one
    // close pushes the oldest out the back, so the same `x` is ranked against a different set.
    const history = [0.0, ...Array.from({ length: ECDF_WINDOW - 1 }, () => 0.9)];
    const before = rollingEcdfRank(history, 0.5);
    const after = rollingEcdfRank([...history, 0.9], 0.5);
    expect(before).toEqual({ kind: "pct", value: 1 / ECDF_WINDOW });
    expect(after).toEqual({ kind: "pct", value: 0 });
  });

});

describe("LEG_PILLAR_GENERATOR - computed, not a literal (W4 Stage 4.4)", () => {
  test("the EW arm is an `ew-` sha256 tag", () => {
    expect(legPillarGenerator("EARLY-WARN")).toMatch(/^ew-[0-9a-f]{12}$/);
  });

  /**
   * §11.1 write-guard falsifier: an SN-only `MEMBER_WEIGHT` edit MUST move the `sn-` tag and leave the
   * `ew-` tag byte-identical — otherwise pre-/post-edit SN rows interleave under one hash. `R5` is a `vl`
   * (STRESS-NOW) member; `R5.Health` is an SN-only reach cell. `legPillarGenerator` recomputes each call
   * (not memoized), so the perturbation is visible; restore in `finally`.
   */
  test("an SN-only MEMBER_WEIGHT edit moves the `sn-` tag, never the `ew-` tag", () => {
    const ewBefore = legPillarGenerator("EARLY-WARN");
    const snBefore = legPillarGenerator("STRESS-NOW");
    expect(snBefore).toMatch(/^sn-[0-9a-f]{12}$/); // SN carries its own `sn-` tag
    expect(ewBefore).toBe(LEG_PILLAR_GENERATOR); // the EW arm IS the exported const
    // `Readonly` is a compile-time shape only — the runtime object is a plain mutable literal.
    const r5 = MEMBER_WEIGHT.R5! as { Health?: number };
    const original = r5.Health;
    try {
      r5.Health = original === 0.4 ? 0.41 : 0.4;
      expect(legPillarGenerator("STRESS-NOW")).not.toBe(snBefore);
      expect(legPillarGenerator("EARLY-WARN")).toBe(ewBefore);
    } finally {
      r5.Health = original;
    }
  });

  test("canonicalJson is INSENSITIVE to key insertion order at every depth", () => {
    // The other half of "deterministic": plain `JSON.stringify` serializes in insertion order, so a
    // reordering that is a pure no-op for the arithmetic would mint a new vintage and orphan 500
    // closes of history. Nested, because a shallow sort would pass a top-level-only fixture.
    // Red demo: drop the `.sort()` in `canonicalJson` ⇒ this reds on the first expect.
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [3, 4] })).toBe(canonicalJson({ a: [3, 4], b: { c: 2, d: 1 } }));
    // Non-vacuity, and the property that keeps it a HASH input rather than a constant: different
    // VALUES must still serialize differently, and ARRAY order is meaning, not noise.
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: [3, 4] })).not.toBe(canonicalJson({ a: [4, 3] }));
  });

});

describe("basisChangeDates - the mixed-basis detector (W4 Stage 4.4, the `basis` half)", () => {
  const pt = (date: string, basis: string) => ({ date, basis });

  test("a single-roster window yields NO dates", () => {
    // The common case once the window has rolled past May 2026 — and the control that keeps the
    // assertions below from passing on a detector that fires unconditionally.
    expect(basisChangeDates([pt("2026-01-01", "A"), pt("2026-01-02", "A"), pt("2026-01-03", "A")])).toEqual([]);
    expect(basisChangeDates([])).toEqual([]);
    expect(basisChangeDates([pt("2026-01-01", "A")])).toEqual([]);
  });

  test("names the NEWER side of each boundary, ascending, one date per change", () => {
    // Two changes in one window (the real shape: EURC 2026-05-15, then BUND 2026-05-25). The date
    // reported is the first close computed under the NEW roster — that is the one an operator can
    // act on ("closes BEFORE this read colder"), and the older side is implied by it.
    const dates = basisChangeDates([
      pt("2026-05-13", "A"),
      pt("2026-05-14", "A"),
      pt("2026-05-15", "B"),
      pt("2026-05-20", "B"),
      pt("2026-05-25", "C"),
    ]);
    expect(dates).toEqual(["2026-05-15", "2026-05-25"]);
  });

  test("a roster that REVERTS is two changes, not zero (adjacency, not distinct-count)", () => {
    // A `new Set(basis).size > 1` implementation would agree on the fixtures above and disagree
    // here only in the DATES — but a `size`-based one cannot produce dates at all, and one that
    // reported only the FIRST boundary would drop the second. Both are the drift this pins.
    expect(basisChangeDates([pt("d1", "A"), pt("d2", "B"), pt("d3", "A")])).toEqual(["d2", "d3"]);
  });
});
