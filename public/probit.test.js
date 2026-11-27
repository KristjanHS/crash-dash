import { describe, expect, it } from "vitest";
import { normalCdf, recessionProbabilityPct } from "./probit.js";
import { INDICATORS } from "../src/registry-fred.ts";

describe("normalCdf", () => {
  it("pins the three closed-form points of the standard normal", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
  });

  it("is symmetric about zero and bounded in [0,1]", () => {
    for (const z of [-4, -2.5, -0.3, 0.7, 3.1]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
      expect(normalCdf(z)).toBeGreaterThan(0);
      expect(normalCdf(z)).toBeLessThan(1);
    }
  });

  it("returns null for a non-finite input rather than NaN", () => {
    expect(normalCdf(null)).toBeNull();
    expect(normalCdf(NaN)).toBeNull();
  });
});

describe("recessionProbabilityPct", () => {
  it("is monotone DECREASING in the spread - a flatter curve is more dangerous", () => {
    const at = [-1.5, -1.0, -0.5, 0, 0.5, 1.5].map(recessionProbabilityPct);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeLessThan(at[i - 1]);
  });

  it("reproduces the probability the R8 doc reads its cuts off", () => {
    // These numbers are NOT a restatement of a registry cut — they are the model's output AT the cuts, so this pins the coefficients.
    expect(recessionProbabilityPct(0)).toBeCloseTo(29.7, 1);
    expect(recessionProbabilityPct(-0.5)).toBeCloseTo(42.0, 1);
  });

  it("R8 carries NO registry level pair for the probit to bind - the axis is display-only", () => {
    // The level legs live on the mean-space rung, so a probit
    // read of `thresholds.amberLevel/redLevel` must find nothing (a reintroduced pair reds here).
    const r8 = INDICATORS.find((i) => i.id === "R8");
    expect(r8.thresholds.amberLevel).toBeUndefined();
    expect(r8.thresholds.redLevel).toBeUndefined();
    expect(recessionProbabilityPct(r8.thresholds.amberLevel)).toBeNull();
  });

  it("returns null for a missing observation so a chart gap stays a gap", () => {
    expect(recessionProbabilityPct(null)).toBeNull();
    expect(recessionProbabilityPct(undefined)).toBeNull();
  });

});
