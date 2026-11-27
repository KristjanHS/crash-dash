import { describe, expect, it } from "vitest";
import {
  computeCapeValuation,
  VAL_M_FLOOR,
  VAL_MAX_STALE_DAYS,
  VAL_Z_CAP,
  VAL_Z_WINDOW,
  type CapeObs,
} from "./valuation.js";

/** Monthly obs (ascending, `YYYY-MM-01`); `values` oldest→newest, newest maps to end{Year,Month}. */
function monthlySeries(values: number[], endYear: number, endMonth: number): CapeObs[] {
  const out: CapeObs[] = [];
  let y = endYear;
  let m = endMonth;
  for (let i = values.length - 1; i >= 0; i--) {
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-01`, value: values[i]! });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out.reverse();
}

/** A two-point window: `p` copies of `low` then `q` of `high`, newest = `high`. For newest=high the
 *  trailing z-score is exactly `sqrt(p/q)` (independent of low/high magnitude) — the pin we exploit. */
function twoPoint(p: number, q: number, low: number, high: number): number[] {
  return [...Array(p).fill(low), ...Array(q).fill(high)];
}

const NOW = "2026-07-16";

describe("computeCapeValuation - trailing z-score → one-sided severity multiplier (W1-k)", () => {
  it("z = 0 (today at its own trailing mean) ⇒ m = 1.0", () => {
    // 179×(29) + 179×(31) + 30 (history) + 30 (newest) ⇒ mean 30, sd>0, newest=mean ⇒ z=0.
    const values = [...Array(179).fill(29), ...Array(179).fill(31), 30, 30];
    const v = computeCapeValuation(monthlySeries(values, 2026, 7), NOW);
    expect(v.degraded).toBe(false);
    expect(v.z).toBeCloseTo(0, 6);
    expect(v.m).toBe(1.0);
    expect(v.value).toBe(30);
  });

  it("z = VAL_Z_CAP (2.0) ⇒ m clamps to VAL_M_FLOOR", () => {
    // p/q = 4 ⇒ z = sqrt(4) = 2.0 exactly (288 low + 72 high, newest = high).
    const v = computeCapeValuation(monthlySeries(twoPoint(288, 72, 20, 40), 2026, 7), NOW);
    expect(v.z).toBeCloseTo(VAL_Z_CAP, 6);
    expect(v.m).toBeCloseTo(VAL_M_FLOOR, 6);
  });

  it("mid overvaluation (z = 1.0) ⇒ m linear between 1.0 and VAL_M_FLOOR", () => {
    const v = computeCapeValuation(monthlySeries(twoPoint(180, 180, 20, 40), 2026, 7), NOW);
    expect(v.z).toBeCloseTo(1.0, 6);
    expect(v.m).toBeCloseTo(1 - (1 - VAL_M_FLOOR) * 0.5, 6); // 0.925
  });

  it("deep overvaluation (z ≫ cap) ⇒ m stays at the floor, never below", () => {
    const v = computeCapeValuation(monthlySeries(twoPoint(355, 5, 20, 40), 2026, 7), NOW);
    expect(v.z!).toBeGreaterThan(VAL_Z_CAP);
    expect(v.m).toBeCloseTo(VAL_M_FLOOR, 6);
  });

  it("cheap (z < 0) ⇒ m = 1.0 - NEVER m>1 (one-sided)", () => {
    // 359 history at 40, newest at 20 ⇒ well below the trailing mean.
    const v = computeCapeValuation(monthlySeries([...Array(359).fill(40), 20], 2026, 7), NOW);
    expect(v.degraded).toBe(false);
    expect(v.z!).toBeLessThan(0);
    expect(v.m).toBe(1.0);
  });

  it("absent series ⇒ degraded, m = 1.0 (identity - a dead feed is a no-op)", () => {
    const v = computeCapeValuation([], NOW);
    expect(v).toEqual({ m: 1.0, z: null, value: null, mean: null, degraded: true });
  });

  it("too-short series (< VAL_Z_WINDOW) ⇒ degraded, m = 1.0", () => {
    const short = monthlySeries(twoPoint(50, 50, 20, 40), 2026, 7); // 100 obs
    expect(short.length).toBeLessThan(VAL_Z_WINDOW);
    expect(computeCapeValuation(short, NOW).degraded).toBe(true);
    expect(computeCapeValuation(short, NOW).m).toBe(1.0);
  });

  it("stale series (newest older than VAL_MAX_STALE_DAYS) ⇒ degraded, m = 1.0", () => {
    // A FULL window, but ending 2026-03-01 — ~137d before NOW ⇒ dead feed.
    const stale = monthlySeries(twoPoint(288, 72, 20, 40), 2026, 3);
    expect(stale.length).toBe(VAL_Z_WINDOW);
    expect(computeCapeValuation(stale, NOW).degraded).toBe(true);
    expect(computeCapeValuation(stale, NOW).m).toBe(1.0);
    // sanity-bound the lag: a fresh (2026-07) copy of the SAME shape is NOT degraded.
    expect(computeCapeValuation(monthlySeries(twoPoint(288, 72, 20, 40), 2026, 7), NOW).degraded).toBe(false);
    expect(VAL_MAX_STALE_DAYS).toBeGreaterThan(31); // must clear one monthly cycle
  });

  it("degenerate (sd ≈ 0, all-equal window) ⇒ degraded, m = 1.0 (no divide-by-zero)", () => {
    const flat = monthlySeries(Array(VAL_Z_WINDOW).fill(25), 2026, 7);
    const v = computeCapeValuation(flat, NOW);
    expect(v.degraded).toBe(true);
    expect(v.m).toBe(1.0);
  });
});
