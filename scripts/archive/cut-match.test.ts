import { describe, it, expect } from "vitest";
import { bandSplit, fracBelow, massAt, matchCut, splitConverged } from "./cut-match.js";

describe("fracBelow — strict <, matching ledgerBand's >= banding", () => {
  it("excludes samples sitting exactly at the cut", () => {
    const arr = [0.2, 0.3, 0.3, 0.4];
    expect(fracBelow(arr, 0.3)).toBe(0.25);
    expect(bandSplit(arr, { amber: 0.3, red: 0.9 }).GREEN).toBe(fracBelow(arr, 0.3));
  });
});

describe("matchCut", () => {
  // half the mass piled at the input amber 0.3 (the capped gp term)
  const piled = [0.1, 0.1, 0.2, 0.3, 0.3, 0.3, 0.3, 0.3, 0.5, 0.6];

  it("steps past a pile when the next distinct value is closer to the target", () => {
    expect(massAt(piled, 0.3)).toBe(5);
    expect(matchCut(piled, 0.6)).toEqual({ cut: 0.5, fracBelow: 0.8 });
  });

  it("keeps the pile value when it is the closer split", () => {
    expect(matchCut(piled, 0.4)).toEqual({ cut: 0.3, fracBelow: 0.3 });
  });

  it("breaks an equidistant tie to the lower cut", () => {
    expect(matchCut([0.1, 0.2, 0.3, 0.4], 0.375)).toEqual({ cut: 0.2, fracBelow: 0.25 });
  });

  it("only offers candidates above the floor, up to the scale ceiling 1", () => {
    expect(matchCut(piled, 0.3, 0.3)).toEqual({ cut: 0.5, fracBelow: 0.8 });
    expect(matchCut([0.1, 0.2], 1, 0.2)).toEqual({ cut: 1, fracBelow: 1 });
  });
});

describe("splitConverged", () => {
  const ref = { GREEN: 0.8, AMBER: 0.15, RED: 0.05 };
  it("holds within 1 pp per band and fails past it", () => {
    expect(splitConverged({ GREEN: 0.805, AMBER: 0.145, RED: 0.05 }, ref)).toBe(true);
    expect(splitConverged({ GREEN: 0.79, AMBER: 0.17, RED: 0.04 }, ref)).toBe(false);
  });
});
