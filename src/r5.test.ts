import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "./store.js";
import {
  R5_GROSS_STEP,
  R5_MAX_SPAN_DAYS,
  R5_MIN_GROSS,
  R5_MIN_OBS,
  R5_TARGET_VOL,
  R5_WINDOWS,
  computeR5,
} from "./r5.js";

const TRADING_DAYS = 252;

const MS_PER_DAY = 86_400_000;
const BASE_DATE = Date.UTC(2026, 0, 1);

/** ISO `YYYY-MM-DD`, `n * stepDays` calendar days after 2026-01-01. Computed from a real epoch
 *  rather than string-padded (`2026-01-60` is not a date, and R5's contiguity gate parses it). */
function isoDay(n: number, stepDays: number): string {
  return new Date(BASE_DATE + n * stepDays * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Turn a daily log-return series into the `SeriesPoint[]` shape `store.getSeries` returns
 *  (oldest→newest). Only `date`/`value` matter to R5; the state fields are filler. `stepDays` spaces
 *  the closes — 1 (consecutive days) sits well inside `R5_MAX_SPAN_DAYS`; the span tests raise it. */
function seriesFromReturns(returns: number[], stepDays = 1): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let close = 100;
  for (let i = 0; i <= returns.length; i++) {
    if (i > 0) close *= Math.exp(returns[i - 1] as number);
    points.push({
      date: isoDay(i, stepDays),
      value: close,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
    });
  }
  return points;
}

/** `n` returns alternating ±`r`. Chosen because its sample stdev has a closed form — for a
 *  strictly-alternating series of magnitude `r`, `σ = r·√((n+1)/n)` — which lets a test place the
 *  realized vol on an exact target without re-implementing `computeR5`'s arithmetic. */
function alternating(n: number, r: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? r : -r));
}

/** The per-return magnitude that makes the SHORT window's annualized sample stdev land exactly on
 *  `annualVol`. The short window dominates the ensemble max for a constant-magnitude series (its
 *  `(n+1)/n` small-sample inflation is the larger), so this also fixes `realizedVol`. */
function magnitudeForVol(annualVol: number): number {
  const n = (R5_WINDOWS[0] as number) - 1; // a window of N closes yields N−1 returns
  return annualVol / Math.sqrt(TRADING_DAYS) / Math.sqrt((n + 1) / n);
}

/** A full-length (`R5_MIN_OBS` closes) series realizing `annualVol`. */
function seriesAtVol(annualVol: number): SeriesPoint[] {
  return seriesFromReturns(alternating(R5_MIN_OBS - 1, magnitudeForVol(annualVol)));
}

describe("computeR5 - the warm-up gate", () => {
  it("59 observations ⇒ degraded, 60 ⇒ a number", () => {
    const r = magnitudeForVol(0.3);
    const short = seriesFromReturns(alternating(R5_MIN_OBS - 2, r));
    const shortResult = computeR5(short);
    expect(shortResult.degraded).toBe(true);
    expect(shortResult.gross).toBeNull();
    expect(shortResult.realizedVol).toBeNull();

    const full = seriesAtVol(0.3);
    const fullResult = computeR5(full);
    expect(fullResult.degraded).toBe(false);
    expect(typeof fullResult.gross).toBe("number");
  });

  it("degrades rather than fabricating a trim when a close is non-positive", () => {
    const points = seriesAtVol(0.3);
    (points[R5_MIN_OBS - 2] as SeriesPoint).value = 0;
    const result = computeR5(points);
    expect(result.degraded).toBe(true);
    expect(result.gross).toBeNull();
  });
});

describe("computeR5 - the sizing rule", () => {
  it("a series realizing exactly R5_TARGET_VOL yields gross 1.00", () => {
    const result = computeR5(seriesAtVol(R5_TARGET_VOL));
    expect(result.realizedVol).toBeCloseTo(R5_TARGET_VOL, 10);
    expect(result.gross).toBe(1);
  });

  it("caps at 1.0 - a calm series never levers above fully invested", () => {
    const result = computeR5(seriesAtVol(R5_TARGET_VOL / 4));
    expect(result.gross).toBe(1);
  });

  it("a dead-flat series is fully invested, not a division blow-up", () => {
    const result = computeR5(seriesFromReturns(alternating(R5_MIN_OBS - 1, 0)));
    expect(result.realizedVol).toBe(0);
    expect(result.gross).toBe(1);
  });

  it("a 60%-vol series clamps to R5_MIN_GROSS, not lower", () => {
    const result = computeR5(seriesAtVol(0.6));
    // Unclamped this would size to 0.15/0.60 = 0.25.
    expect(result.gross).toBe(R5_MIN_GROSS);
  });

  it("trims proportionally between the floor and the cap", () => {
    // 20%/yr realized ⇒ 0.15/0.20 = 0.75, already on the step grid.
    expect(computeR5(seriesAtVol(0.2)).gross).toBe(0.75);
  });

  it("gross is always a multiple of R5_GROSS_STEP", () => {
    const seen = new Set<number>();
    for (let volPct = 5; volPct <= 80; volPct++) {
      const gross = computeR5(seriesAtVol(volPct / 100)).gross;
      expect(gross).not.toBeNull();
      const steps = (gross as number) / R5_GROSS_STEP;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      seen.add(gross as number);
    }
    // Vacuity guard: a stub returning one constant would satisfy the grid assertion above for every
    // input. The sweep must actually move gross across the range for the property to mean anything.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe("computeR5 - the lag / contiguity gate", () => {
  /** Rewrite the OLDEST date so the window spans exactly `days` calendar days. The gate reads only
   *  the first and last dates of the newest `R5_MIN_OBS` points, which is what this moves. */
  function withSpan(points: SeriesPoint[], days: number): SeriesPoint[] {
    const last = Date.parse(`${(points[points.length - 1] as SeriesPoint).date}T00:00:00Z`);
    const first = new Date(last - days * MS_PER_DAY).toISOString().slice(0, 10);
    return points.map((p, i) => (i === 0 ? { ...p, date: first } : p));
  }

  it("a 60-close series spanning more than R5_MAX_SPAN_DAYS degrades; at the bound it sizes", () => {
    const base = seriesAtVol(0.3);

    const stale = computeR5(withSpan(base, R5_MAX_SPAN_DAYS + 1));
    expect(stale.degraded).toBe(true);
    expect(stale.gross).toBeNull();
    expect(stale.realizedVol).toBeNull();
    // The reason must name the span, so /lab says WHY rather than showing a bare warm-up.
    expect(stale.reason).toContain(String(R5_MAX_SPAN_DAYS + 1));
    expect(stale.reason).toContain(String(R5_MAX_SPAN_DAYS));

    const atBound = computeR5(withSpan(base, R5_MAX_SPAN_DAYS));
    expect(atBound.degraded).toBe(false);
    expect(typeof atBound.gross).toBe("number");
  });
});

describe("computeR5 - the window ensemble", () => {
  it("a series calm for 60d but violent in the last 20 uses the 20d (higher) vol", () => {
    const short = R5_WINDOWS[0] as number;
    const calm = alternating(R5_MIN_OBS - short, magnitudeForVol(0.05));
    const violent = alternating(short - 1, magnitudeForVol(0.6));
    const result = computeR5(seriesFromReturns([...calm, ...violent]));

    // The 60d window blends the calm head in, so it reads far below the violent tail.
    expect(result.realizedVol).toBeCloseTo(0.6, 2);
    expect(result.gross).toBe(R5_MIN_GROSS);
  });

  it("the ensemble takes the max - a violent head does not get averaged away either", () => {
    const short = R5_WINDOWS[0] as number;
    const violent = alternating(R5_MIN_OBS - short, magnitudeForVol(0.9));
    const calm = alternating(short - 1, magnitudeForVol(0.05));
    const result = computeR5(seriesFromReturns([...violent, ...calm]));

    // The 20d window is calm, but the 60d window still carries the violent head.
    expect(result.realizedVol as number).toBeGreaterThan(R5_TARGET_VOL);
    expect(result.gross as number).toBeLessThan(1);
  });
});
