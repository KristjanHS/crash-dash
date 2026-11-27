// Characterization tests for the display-format island extracted from app.js.
// Plain `.js` so vitest's default glob collects it while `tsc` ignores it — no jsdom
// needed (these are pure string/data builders). Mirrors app-state.test.js /
// haven-envelope.test.js. Pins the CURRENT output byte-for-byte so the extraction is
// provably behavior-preserving.
import { describe, it, expect } from "vitest";
import { formatDelta, pensionPct, slowMetricVal, latestValue, whatIfBadge, windowReturnPct } from "./format.js";

describe("formatDelta", () => {
  it("null/undefined → empty string", () => {
    expect(formatDelta(null, "%")).toBe("");
    expect(formatDelta(undefined, "%")).toBe("");
  });

  it("percent unit → 2 decimal places, always signed", () => {
    expect(formatDelta(1.234, "%")).toBe("+1.23");
    expect(formatDelta(-1.236, "%")).toBe("-1.24");
    expect(formatDelta(0, "%")).toBe("+0.00"); // 0 >= 0 → "+"
  });

  it("non-percent unit → ~2 significant figures via toLocaleString", () => {
    expect(formatDelta(1234, "bp")).toBe("+1,200"); // 2 sig figs, grouped
    expect(formatDelta(-0.01567, "x")).toBe("-0.016");
    expect(formatDelta(9.99, undefined)).toBe("+10"); // rounds to 2 sig figs
  });

  it("relative mode → the fraction as a signed 1-dp percentage, whatever the level unit", () => {
    expect(formatDelta(0.0681, "", "relative")).toBe("+6.8%");
    expect(formatDelta(-0.0423, "", "relative")).toBe("-4.2%");
  });
});

describe("pensionPct", () => {
  it("null/undefined → em dash (U+2014)", () => {
    expect(pensionPct(null)).toBe("-");
    expect(pensionPct(undefined)).toBe("-");
  });

  it("negative fraction → Unicode-minus percent, 1 dp", () => {
    // -0.123 → "−12.3%" with a Unicode minus (U+2212), not ASCII "-"
    expect(pensionPct(-0.123)).toBe("−12.3%");
    expect(pensionPct(-0.1)).toBe("−10.0%");
  });

  it("tolerant of a non-negative input - still prefixes the Unicode minus", () => {
    // Display-only helper: Math.abs means a positive dd still renders "−…%".
    expect(pensionPct(0)).toBe("−0.0%");
    expect(pensionPct(0.05)).toBe("−5.0%");
  });
});

describe("windowReturnPct", () => {
  it("signs both directions, 1 dp; absent → dash", () => {
    expect(windowReturnPct(-0.042)).toBe("−4.2%");
    expect(windowReturnPct(0.011)).toBe("+1.1%");
    expect(windowReturnPct(-0.0004)).toBe("+0.0%");
    expect(windowReturnPct(undefined)).toBe("-");
  });
});

describe("slowMetricVal", () => {
  it("null/undefined → em dash", () => {
    expect(slowMetricVal(null)).toBe("-");
    expect(slowMetricVal(undefined)).toBe("-");
  });

  it("finite metric → fixed 2 dp", () => {
    expect(slowMetricVal(0.123)).toBe("0.12");
    expect(slowMetricVal(0)).toBe("0.00"); // 0 is not null → formatted, not em dash
  });
});

describe("latestValue", () => {
  it("null/undefined series, absent or empty points → null", () => {
    expect(latestValue(null)).toBe(null);
    expect(latestValue(undefined)).toBe(null);
    expect(latestValue({})).toBe(null);
    expect(latestValue({ points: [] })).toBe(null);
  });

  it("returns the last point's value, passing a null through without coercion", () => {
    expect(latestValue({ points: [{ value: 1 }, { value: 2 }, { value: 3 }] })).toBe(3);
    expect(latestValue({ points: [{ value: 42 }] })).toBe(42);
    expect(latestValue({ points: [{ value: 1 }, { value: null }] })).toBe(null);
  });
});

describe("whatIfBadge", () => {
  it("OFF: non-positive / NaN / missing multiplier → empty string", () => {
    expect(whatIfBadge(0)).toBe("");
    expect(whatIfBadge(-1)).toBe("");
    expect(whatIfBadge(NaN)).toBe(""); // NaN > 0 is false
    expect(whatIfBadge(null)).toBe("");
    expect(whatIfBadge(undefined)).toBe("");
  });

  it("ON: multiplier of 1 still badges (guard is > 0, not > 1)", () => {
    const html = whatIfBadge(1);
    expect(html).not.toBe("");
    expect(html).toContain("what-if ×1");
  });

  it("ON: badge carries the applied ×<mult> value", () => {
    expect(whatIfBadge(1.5)).toContain("what-if ×1.5");
  });
});
