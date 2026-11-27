// Pins the /api/series from/to grid snappers (public/month-grid.js, P5) — plain `.js` so
// vitest collects it and tsc ignores it (frontend.md §Testable slices go in a pure seam module).
import { describe, expect, it } from "vitest";
import { floorMonthStart, ceilMonthStart } from "./month-grid.js";

describe("floorMonthStart", () => {
  it("floors a within-month day to its month-start", () => {
    expect(floorMonthStart("2008-11-20")).toBe("2008-11-01");
    expect(floorMonthStart("2006-10-31")).toBe("2006-10-01");
  });
  it("passes a month-start through unchanged", () => {
    expect(floorMonthStart("2015-06-01")).toBe("2015-06-01");
  });
});

describe("ceilMonthStart", () => {
  it("ceils a within-month day to the first of the NEXT month", () => {
    expect(ceilMonthStart("2003-03-31")).toBe("2003-04-01");
    expect(ceilMonthStart("2020-03-20")).toBe("2020-04-01");
  });
  it("rolls the year over at December", () => {
    expect(ceilMonthStart("2022-12-28")).toBe("2023-01-01");
  });
  it("passes a month-start through unchanged (no needless widening)", () => {
    expect(ceilMonthStart("2016-03-01")).toBe("2016-03-01");
  });
});
