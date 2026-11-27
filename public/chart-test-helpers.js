// Shared { svg, detail } contract assertion for the detail-chart render tests
// (detail-chart.test.js + generic-detail-chart.test.js). Plain `.js` HELPER (not a
// `*.test.js`), so vitest resolves the import but never collects it as a suite.
import { expect } from "vitest";

// Assert the shared { svg, detail } contract every chart category must satisfy: a
// non-empty SVG string carrying a legend, plus a well-formed `detail` pointer seam.
export const expectValid = (r, n) => {
  expect(typeof r.svg).toBe("string");
  expect(r.svg.length).toBeGreaterThan(0);
  expect(r.svg).toContain("<svg");
  expect(r.svg).toContain("chart-legend");
  expect(r.detail.n).toBe(n);
  expect(Array.isArray(r.detail.samples)).toBe(true);
  expect(r.detail.samples).toHaveLength(n);
  for (const s of r.detail.samples) {
    expect(typeof s.x).toBe("number");
    // dotY is null at a null-primary sample (S4 phantom-dot fix); finite otherwise.
    expect(s.dotY === null || Number.isFinite(s.dotY)).toBe(true);
    expect(typeof s.readout).toBe("string");
  }
};
