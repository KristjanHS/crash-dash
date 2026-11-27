import { describe, expect, it } from "vitest";

import { at } from "./series-math.js";

// `at()` is the pure core's index accessor — in range returns the
// element, anything else throws a RangeError naming the index and the length (so `degrade()` drops the feed).
describe("at", () => {
  const xs = [10, 20, 30];

  it("returns the element at 0, a middle index and length − 1", () => {
    expect(at(xs, 0)).toBe(10);
    expect(at(xs, 1)).toBe(20);
    expect(at(xs, 2)).toBe(30);
  });

  it("types a readonly `as const` tuple through to its element type", () => {
    const tuple = ["a", "b"] as const;
    const v: "a" | "b" = at(tuple, 1);
    expect(v).toBe("b");
  });

  it("reads a typed array (Float64Array prefix sums)", () => {
    expect(at(new Float64Array([1.5, 2.5]), 1)).toBe(2.5);
  });

  it.each([
    ["-1", -1],
    ["length", 3],
    ["a non-integer", 1.5],
    ["NaN", Number.NaN],
  ])("throws a RangeError naming index and length for %s", (_label, i) => {
    expect(() => at(xs, i)).toThrow(RangeError);
    expect(() => at(xs, i)).toThrow(`index ${i} out of range [0, 3)`);
  });

  it("throws on any index into an empty series", () => {
    expect(() => at([], 0)).toThrow("index 0 out of range [0, 0)");
  });
});
