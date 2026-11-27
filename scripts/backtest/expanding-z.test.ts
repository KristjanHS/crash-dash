import { describe, expect, it } from "vitest";
import { expandingZ } from "./expanding-z.js";

// The formula's non-circular anchor lives OUTSIDE this file — dropping the ex-fixture-parity
// test here (it read INPUT/GOLDEN from the fixture emitted FROM this same `expandingZ`, so it
// could not fail): `emit-scoring-constants.test.ts` pins the emitted output to a hand-kept
// golden (the Python-side anchors were deleted with the harness 2026-08-15).
// These TS tests cover the point-in-time invariants: warm-up NaN, no look-ahead, empty input.
describe("expandingZ (point-in-time)", () => {
  it("is NaN until two prior observations exist (no look-ahead, sample sd needs ≥2)", () => {
    const z = expandingZ([5, 5, 5]);
    expect(Number.isNaN(z[0]!)).toBe(true);
    expect(Number.isNaN(z[1]!)).toBe(true);
    // constant series ⇒ sd 0 ⇒ z stays NaN (guarded), never a divide-by-zero
    expect(Number.isNaN(z[2]!)).toBe(true);
  });

  it("uses only pre-t data (a future spike never changes an earlier z)", () => {
    const base = expandingZ([1, 2, 3, 4]);
    const withFutureSpike = expandingZ([1, 2, 3, 4, 999]);
    const idx = [...Array(4).keys()];
    const warmup = idx.filter((i) => Number.isNaN(base[i]!));
    const scored = idx.filter((i) => !Number.isNaN(base[i]!));
    expect(warmup.length).toBeGreaterThan(0);
    expect(scored.length).toBeGreaterThan(0);
    for (const i of warmup) expect(Number.isNaN(withFutureSpike[i]!)).toBe(true);
    for (const i of scored) expect(withFutureSpike[i]!).toBeCloseTo(base[i]!, 12);
  });

  it("returns an empty array for empty input", () => {
    expect(expandingZ([])).toEqual([]);
  });
});
