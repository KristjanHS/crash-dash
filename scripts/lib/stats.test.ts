import { describe, expect, it } from "vitest";

import { averageRanks, spearman } from "./stats.js";

// Scope: `averageRanks` + `spearman` only — the pair added for the since-retired `probe-growth.ts`'s ARM 4 (`--terms`; probe retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it)),
// whose printed M2 table was the growth-model rung-4 evidence. The older helpers
// in this module were lifted VERBATIM from the probes they replaced and are pinned by those probes'
// own numbers; re-testing them here would add points on branches nothing new touches.

describe("averageRanks", () => {
  it("gives a tie block the mean of the ranks it spans", () => {
    // The tie rule is the whole point: without it the two 20s would take ranks 2 and 3 in input
    // order, inventing an ordering the data does not carry.
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });
});

describe("spearman", () => {
  it("returns NaN when an arm is fully tied — either arm, not just the first", () => {
    // Both directions, because the NaN is `pearson`'s zero-variance return on whichever arm is
    // flat; a caller may not read a non-finite rho as a property of the x arm alone. ⚠ The y-arm
    // case survives a `db === 0` half-deletion (`num` is 0 too, so `0/0` is still NaN) — it pins the
    // OBSERVABLE contract, not that branch. Both cases red under `? 0 :` in place of `? NaN :`.
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNaN();
  });

  it("returns NaN for n < 2 — a single pair has no ordering", () => {
    expect(spearman([1], [2])).toBeNaN();
    expect(spearman([], [])).toBeNaN();
  });

  // PINNED DECISION (docblock): throw rather than return the plausible finite number
  // `averageRanks` would fabricate from distinct NaN ranks. Asserted on BOTH arms and on
  // Infinity, since the guard walks the truncated window of both.
  it("throws on a non-finite input rather than fabricating a finite rho", () => {
    expect(() => spearman([1, 2, NaN, 4], [4, 3, 2, 1])).toThrow(/non-finite input/);
    expect(() => spearman([1, 2, 3, 4], [4, 3, NaN, 1])).toThrow(/non-finite input/);
    expect(() => spearman([1, 2, Infinity, 4], [4, 3, 2, 1])).toThrow(/non-finite input/);
  });

  it("scores a perfect monotone (non-linear) relation at +1", () => {
    // Non-vacuity for the throw test above: the same shape WITHOUT a NaN returns a number, so the
    // throw is the input's doing and not "spearman throws on everything". Cubed y keeps it
    // rank-perfect while Pearson on the raw values would not be.
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1, 12);
  });
});
