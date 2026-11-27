import { describe, expect, it } from "vitest";
import { diffColumn, diffColumnWithFallback, verdictFor } from "./probe-rate-feed-parity.js";
import { MIN_OVERLAP_ROWS } from "../src/treasury.js";

// A fat clean overlap: MIN_OVERLAP_ROWS + 2 shared dates, all byte-identical.
const cleanDates = Array.from({ length: MIN_OVERLAP_ROWS + 2 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
const cleanFred = cleanDates.map((date, i) => ({ date, value: 4.0 + i * 0.01 }));

describe("diffColumn / verdictFor", () => {
  it("reports PARITY when every shared date agrees on a fat overlap", () => {
    const d = diffColumn(cleanFred, cleanFred.map((o) => ({ ...o })));
    expect(d).toEqual({ shared: MIN_OVERLAP_ROWS + 2, mismatches: [] });
    expect(verdictFor(d)).toBe("PARITY");
  });

  it("reports a MISMATCH and would exit non-zero when one shared date differs by 0.01", () => {
    const treasury = cleanFred.map((o) => ({ ...o }));
    treasury[3] = { date: treasury[3]!.date, value: treasury[3]!.value + 0.01 }; // perturb ONE date
    const d = diffColumn(cleanFred, treasury);
    expect(d.shared).toBe(MIN_OVERLAP_ROWS + 2);
    expect(d.mismatches).toEqual([{ date: cleanFred[3]!.date, fred: cleanFred[3]!.value, treasury: cleanFred[3]!.value + 0.01 }]);
    expect(verdictFor(d)).toBe("MISMATCH"); // non-PARITY ⇒ the probe sets process.exitCode = 1
  });

  it("reports INDETERMINATE (not silently green) when the shared overlap is thinner than MIN_OVERLAP_ROWS", () => {
    const thin = cleanFred.slice(0, MIN_OVERLAP_ROWS - 1);
    const d = diffColumn(thin, thin.map((o) => ({ ...o })));
    expect(d).toEqual({ shared: MIN_OVERLAP_ROWS - 1, mismatches: [] });
    expect(verdictFor(d)).toBe("INDETERMINATE");
  });

  it("counts a date shared only via a duplicate row once", () => {
    const treasury = [...cleanFred.map((o) => ({ ...o })), { date: cleanFred[0]!.date, value: cleanFred[0]!.value }];
    expect(diffColumn(cleanFred, treasury).shared).toBe(MIN_OVERLAP_ROWS + 2);
  });

  it("ignores a Treasury date FRED never printed (no false mismatch, no shared count)", () => {
    const treasury = [...cleanFred.map((o) => ({ ...o })), { date: "2026-12-31", value: 9.99 }];
    const d = diffColumn(cleanFred, treasury);
    expect(d.shared).toBe(MIN_OVERLAP_ROWS + 2);
    expect(d.mismatches).toEqual([]);
  });
});

describe("diffColumnWithFallback (A3 January fallback)", () => {
  // Early January: the current-year column is THIN (< MIN_OVERLAP_ROWS rows) while the prior-year
  // December column is FAT. FRED's ~60-day window spans BOTH years. Sizes derived from the constant.
  const priorDates = Array.from({ length: MIN_OVERLAP_ROWS }, (_, i) => `2025-12-${String(i + 10).padStart(2, "0")}`);
  const currentDates = Array.from({ length: MIN_OVERLAP_ROWS - 2 }, (_, i) => `2026-01-${String(i + 2).padStart(2, "0")}`);
  const priorRows = priorDates.map((date, i) => ({ date, value: 4.0 + i * 0.01 }));
  const currentRows = currentDates.map((date, i) => ({ date, value: 5.0 + i * 0.01 }));
  const fred = [...priorRows, ...currentRows]; // FRED prints both years' dates
  const fetchColumn = async (year: number) =>
    (year === 2026 ? currentRows : priorRows).map((o) => ({ ...o }));

  it("a thin current-year column plus a fat prior-year one yields PARITY", async () => {
    const d = await diffColumnWithFallback(fred, fetchColumn, 2026);
    expect(d.shared).toBeGreaterThanOrEqual(MIN_OVERLAP_ROWS);
    expect(d.mismatches).toEqual([]);
    expect(verdictFor(d)).toBe("PARITY");
  });

  it("does NOT fetch the prior year when the current-year overlap already clears the floor", async () => {
    const fatCurrent = Array.from({ length: MIN_OVERLAP_ROWS + 1 }, (_, i) => ({
      date: `2026-02-${String(i + 1).padStart(2, "0")}`,
      value: 4.2 + i * 0.01,
    }));
    const years: number[] = [];
    const spy = async (year: number) => {
      years.push(year);
      return year === 2026 ? fatCurrent.map((o) => ({ ...o })) : [];
    };
    const d = await diffColumnWithFallback(fatCurrent, spy, 2026);
    expect(years).toEqual([2026]); // one fetch only — the fallback never fired
    expect(verdictFor(d)).toBe("PARITY");
  });
});
