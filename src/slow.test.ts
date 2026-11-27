import { describe, expect, test } from "vitest";
import type { Observation } from "./domain-types.js";
import {
  ACCEL_WINDOW,
  PERSIST_M,
  PERSIST_N,
  SLOW_HIGH_WINDOW,
  type SlowComponent,
  SLOW_CALM_RUN_MIN,
  PCT_MIN_OBS,
  classifyBand,
  computeSlowVerdict,
  expandingPercentile,
  percentileRank,
  quantile,
  scoreComplacency,
  durationOfCalmRawStateSeries,
  scoreDurationOfCalm,
  scorePriceAccel,
  scoreSlow,
  slowStoredReadings,
  FETCH_EDGE_SCORED_IDS,
  slowBackfillRows,
} from "./slow.js";
import type { Store } from "./store.js";
import { TRACKS } from "./tracks.js";

// Dates are irrelevant to the slow scorers (they read only `value`), so use the
// index as a synthetic date — keeps fixtures terse and deterministic.
const obs = (i: number, value: number): Observation => ({ date: String(i), value });

/** `n` evenly-spaced values in [lo, hi] inclusive. */
const spread = (n: number, lo: number, hi: number): number[] =>
  Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1));

/**
 * Build a QQQ close series whose 63-day returns are EXACTLY `returns` (in order,
 * latest last): seed 63 flat closes, then `close[i] = close[i-63] * (1 + r)`
 * makes `close[i]/close[i-63] - 1 === r`. Lets us pin the return-percentile
 * distribution scorePriceAccel sees.
 */
const closesFromReturns = (returns: number[], seed = 100): Observation[] => {
  const closes = Array<number>(ACCEL_WINDOW).fill(seed);
  for (let k = 0; k < returns.length; k++) closes.push(closes[k]! * (1 + returns[k]!));
  return closes.map((v, i) => obs(i, v));
};

describe("quantile (type-7 linear interpolation)", () => {
  test("endpoints and midpoint of 0..10", () => {
    const s = spread(11, 0, 10); // [0,1,...,10]
    expect(quantile(s, 0)).toBe(0);
    expect(quantile(s, 1)).toBe(10);
    expect(quantile(s, 0.5)).toBe(5);
  });
  test("single element and empty", () => {
    expect(quantile([42], 0.9)).toBe(42);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

// Non-circular anchor for the hand-computed cases below: for the IDENTITY series
// [0,1,…,n-1], the type-7 quantile at p is exactly (n-1)*p — the interpolation
// formula's index IS the value. So the expected numbers are arithmetic, not a
// golden re-read from `expandingPercentile`'s own output.
describe("expandingPercentile (point-in-time)", () => {
  test("NaN until PCT_MIN_OBS prior observations exist (degrade below the floor)", () => {
    // One short of the floor can never clear it ⇒ every slot stays NaN. Derived from
    // the constant so the fixture tracks a re-ruling of PCT_MIN_OBS.
    const short = PCT_MIN_OBS - 1;
    expect(expandingPercentile(spread(short, 0, short - 1), 0.95).every(Number.isNaN)).toBe(true);

    const out = expandingPercentile(spread(300, 0, 299), 0.95);
    expect(Number.isNaN(out[251]!)).toBe(true); // only 251 pre-t obs
    expect(Number.isFinite(out[252]!)).toBe(true); // 252nd pre-t obs clears it
  });

  test("hand-computed type-7 cuts at the floor (85th/95th - the ruled pair)", () => {
    // At i=252 the window is [0..251], n=252 ⇒ quantile(p) = 251*p exactly.
    const p85 = expandingPercentile(spread(300, 0, 299), 0.85);
    const p95 = expandingPercentile(spread(300, 0, 299), 0.95);
    expect(p85[252]!).toBeCloseTo(251 * 0.85, 12); // 213.35
    expect(p95[252]!).toBeCloseTo(251 * 0.95, 12); // 238.45
    // and it expands: one more obs ⇒ window [0..252], n=253 ⇒ 252*p
    expect(p95[253]!).toBeCloseTo(252 * 0.95, 12); // 239.4
  });

  test("day t never enters its own cut (the leak this function exists to prevent)", () => {
    // Fixture must reach the regime where the LEAKY version diverges. A lone spike
    // over flat data does NOT: at n=253 the 95th sits at index 239.4 and never
    // reaches a single outlier, so both versions return the same number and the
    // test would pin nothing. Over [0..251] the two answers separate:
    //   read-then-insert (correct): quantile([0..251], .95)      = 251*.95 = 238.45
    //   insert-then-read (leaked):  quantile([0..251,999], .95)  = idx 239.4 → 239.4
    const vals = [...spread(252, 0, 251), 999];
    const out = expandingPercentile(vals, 0.95);
    expect(out[252]!).toBeCloseTo(238.45, 12);
    expect(out[252]!).not.toBeCloseTo(239.4, 12);
  });

  test("uses only pre-t data (a future spike never changes an earlier cut)", () => {
    const base = expandingPercentile(spread(300, 0, 299), 0.95);
    const withFutureSpike = expandingPercentile([...spread(300, 0, 299), 999999], 0.95);
    const idx = [...Array(300).keys()];
    const warmup = idx.filter((i) => Number.isNaN(base[i]!));
    const scored = idx.filter((i) => !Number.isNaN(base[i]!));
    expect(warmup.length).toBeGreaterThan(0);
    expect(scored.length).toBeGreaterThan(0);
    for (const i of warmup) expect(Number.isNaN(withFutureSpike[i]!)).toBe(true);
    for (const i of scored) expect(withFutureSpike[i]!).toBeCloseTo(base[i]!, 12);
  });

  test("returns an empty array for empty input", () => {
    expect(expandingPercentile([], 0.95)).toEqual([]);
  });
});

describe("percentileRank (fraction ≤ x)", () => {
  test("rank within an ascending array", () => {
    const s = spread(10, 1, 10); // [1,2,...,10]
    expect(percentileRank(s, 10)).toBe(1); // all ≤ 10
    expect(percentileRank(s, 5)).toBe(0.5); // 5 of 10 ≤ 5
    expect(percentileRank(s, 0)).toBe(0); // none ≤ 0
  });
  test("empty → NaN", () => {
    expect(Number.isNaN(percentileRank([], 1))).toBe(true);
  });
});

describe("scorePriceAccel (0/1/2 by return percentile)", () => {
  // A wide-gap reference distribution: 80% in [0,0.10], next 15% in [0.20,0.40],
  // top 5% in [0.60,0.80]. The latest return (appended last) is compared against
  // this; gaps are wide enough that including the single latest can't flip a band.
  const background = [...spread(160, 0.0, 0.1), ...spread(30, 0.2, 0.4), ...spread(10, 0.6, 0.8)];
  const scoreFor = (latest: number) => scorePriceAccel(closesFromReturns([...background, latest])).score;

  test("below the 80th percentile → 0", () => {
    expect(scoreFor(0.05)).toBe(0);
  });
  test("between 80th and 95th → 1", () => {
    expect(scoreFor(0.3)).toBe(1);
  });
  test("at/above the 95th percentile → 2", () => {
    expect(scoreFor(0.7)).toBe(2);
  });
  test("latest exactly AT both percentile cuts → 2 (pins >= over >)", () => {
    // All returns identical ⇒ every quantile == that value == latest. `latest >=
    // red` must hold (score 2); a refactor to `>` would wrongly drop it to 0.
    expect(scorePriceAccel(closesFromReturns(spread(60, 0.1, 0.1))).score).toBe(2);
  });
  test("throws when history is too short for a stable percentile", () => {
    expect(() => scorePriceAccel(closesFromReturns(spread(5, 0, 0.1)))).toThrow(/need/);
  });
  test("exposes the latest return's percentile rank as `metric`", () => {
    // A top-5% latest return ranks near 1.0; a bottom return ranks low.
    const hot = scorePriceAccel(closesFromReturns([...background, 0.7]));
    expect(hot.metric).toBeGreaterThan(0.95);
    expect(hot.metric).toBeLessThanOrEqual(1);
    const cold = scorePriceAccel(closesFromReturns([...background, 0.0]));
    expect(cold.metric!).toBeLessThan(hot.metric!);
  });
});

describe("scoreComplacency (low VIX leg + near-252d-high leg)", () => {
  // 60 VIX closes: 59 flat at 20, last set per case. q(0.10) over [20×59, x] is 20
  // for any x, so latest ≤ 20 ⇒ "low", latest > 20 ⇒ "not low".
  const vix = (last: number): Observation[] =>
    [...Array.from({ length: 59 }, (_, i) => obs(i, 20)), obs(59, last)];
  const vixLow = vix(10);
  const vixHigh = vix(25);
  // Min QQQ history for the m-of-n leg (272): each of the last PERSIST_N days needs its
  // own trailing 252d window. Fixtures derive the length; never restate 272.
  const QQQ_LEN = SLOW_HIGH_WINDOW + PERSIST_N - 1;
  /** All 100s except the last `belowDays` closes at 90 (below the 0.98 cut). */
  const qqqDip = (belowDays: number): Observation[] =>
    Array.from({ length: QQQ_LEN }, (_, i) => obs(i, i >= QQQ_LEN - belowDays ? 90 : 100));
  const qqqAtHigh = qqqDip(0);
  // Sustained shortfall: > PERSIST_N − PERSIST_M days below ⇒ within < PERSIST_M ⇒ leg off.
  const qqqBelow = qqqDip(PERSIST_N);

  test("neither leg → 0", () => {
    expect(scoreComplacency(qqqBelow, vixHigh).component.score).toBe(0);
  });
  test("low VIX only → 1", () => {
    expect(scoreComplacency(qqqBelow, vixLow).component.score).toBe(1);
  });
  test("near-high only → 1", () => {
    expect(scoreComplacency(qqqAtHigh, vixHigh).component.score).toBe(1);
  });
  test("both legs → 2", () => {
    expect(scoreComplacency(qqqAtHigh, vixLow).component.score).toBe(2);
  });
  test("exact boundaries: VIX == decile cut (<=) and QQQ == 98% of high (>=) both fire", () => {
    // All VIX flat ⇒ q(0.10) == latest ⇒ `latest <= cut` must hold (pins <= over <).
    const vixFlat: Observation[] = Array.from({ length: 60 }, (_, i) => obs(i, 20));
    // QQQ peaks at 100, latest exactly 98 ⇒ `98 >= 0.98*100` must hold (pins >= over >).
    const qqqExact: Observation[] = Array.from({ length: QQQ_LEN }, (_, i) =>
      obs(i, i === QQQ_LEN - 1 ? 98 : 100),
    );
    expect(scoreComplacency(qqqExact, vixFlat).component.score).toBe(2);
  });
  test("persistence: a single-day dip below the cut does NOT flip the leg off", () => {
    expect(scoreComplacency(qqqDip(1), vixHigh).component.score).toBe(1);
  });
  test("persistence boundary: exactly PERSIST_M within fires; one fewer does not", () => {
    // qqqDip(k): within = PERSIST_N − k. k = N − M ⇒ within == M (pins >= over >).
    expect(scoreComplacency(qqqDip(PERSIST_N - PERSIST_M), vixHigh).component.score).toBe(1);
    expect(scoreComplacency(qqqDip(PERSIST_N - PERSIST_M + 1), vixHigh).component.score).toBe(0);
  });
  test("per-day ROLLING high, not today's high for all N (contrastive)", () => {
    // Monotone +0.5%/day: every day IS its own trailing high ⇒ within = PERSIST_N ⇒ fires.
    // Under the rejected today's-high-for-all-N rule, most of the last N days sit below
    // 0.98 × the final close (0.995^k < 0.98 for k ≥ 5), so the leg would read 0.
    const rising: Observation[] = Array.from({ length: QQQ_LEN }, (_, i) => obs(i, 100 * 1.005 ** i));
    expect(scoreComplacency(rising, vixHigh).component.score).toBe(1);
  });
  test("returns two observability legs with continuous metrics + binary scores", () => {
    const { legs } = scoreComplacency(qqqAtHigh, vixLow);
    expect(legs.map((l) => l.id)).toEqual(["complacency-vix", "complacency-high"]);
    // Low VIX leg fires (1); near-high leg fires (1). Each leg is binary, never 2.
    expect(legs.map((l) => l.score)).toEqual([1, 1]);
    // Distance-to-high metric is 1.0 when at the high; VIX percentile ∈ (0,1].
    expect(legs[1]!.metric).toBeCloseTo(1.0);
    expect(legs[0]!.metric).toBeGreaterThan(0);
    expect(legs[0]!.metric).toBeLessThanOrEqual(1);
  });
  test("throws on too-short VIX or QQQ history", () => {
    expect(() => scoreComplacency(qqqAtHigh, vix(10).slice(0, 30))).toThrow(/VIX/);
    expect(() => scoreComplacency(qqqAtHigh.slice(0, 100), vixLow)).toThrow(/QQQ/);
  });
});

describe("classifyBand (proportional bands + rollout guard)", () => {
  test("2 active (rollout): CALM 0-1, ELEVATED 2-3, DE-RISK 4", () => {
    expect(classifyBand(0, 2)).toBe("CALM");
    expect(classifyBand(1, 2)).toBe("CALM");
    expect(classifyBand(2, 2)).toBe("ELEVATED");
    expect(classifyBand(3, 2)).toBe("ELEVATED"); // ratio .75 but guard needs ALL maxed
    expect(classifyBand(4, 2)).toBe("DE-RISK"); // all maxed
  });
  test("3 active (still rollout): DE-RISK only when ALL maxed", () => {
    expect(classifyBand(5, 3)).toBe("ELEVATED"); // ratio .83 ≥ .75 yet not all maxed
    expect(classifyBand(6, 3)).toBe("DE-RISK"); // 6 === 2×3
  });
  test("4 active: guard lifts → plain ≥0.75 ratio", () => {
    expect(classifyBand(3, 4)).toBe("CALM"); // .375
    expect(classifyBand(4, 4)).toBe("ELEVATED"); // .50
    expect(classifyBand(6, 4)).toBe("DE-RISK"); // .75 — NOT all maxed, yet DE-RISK
    expect(classifyBand(8, 4)).toBe("DE-RISK");
  });
});

describe("computeSlowVerdict", () => {
  const comp = (id: string, score: 0 | 1 | 2): SlowComponent => ({ id, label: id, score });

  test("rolls components into score/ratio/band", () => {
    const v = computeSlowVerdict([comp("a", 2), comp("b", 1)]);
    expect(v).toMatchObject({ score: 3, activeCount: 2, maxScore: 4, ratio: 0.75, band: "ELEVATED" });
  });
  test("empty component set is CALM with ratio 0 (no divide-by-zero)", () => {
    const v = computeSlowVerdict([]);
    expect(v).toMatchObject({ score: 0, activeCount: 0, maxScore: 0, ratio: 0, band: "CALM" });
  });
});

// T3.2 duration-of-calm — a pure, UNWIRED observability leg (never scored into the band).
describe("scoreDurationOfCalm", () => {
  const vixObs = (values: number[]): Observation[] => values.map((v, i) => obs(i, v));
  // n copies of `v`.
  const rep = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

  test("run-length: run < 63 → GREEN / fragileCalm:false", () => {
    // 50 flat calm closes: median cut = 10, none exceed it ⇒ an unbroken 50-day run,
    // still short of the 63-day threshold ⇒ never AMBER.
    const { leg, fragileCalm } = scoreDurationOfCalm(vixObs(rep(50, 10)));
    expect(fragileCalm).toBe(false);
    expect(leg.score).toBe(0);
    expect(leg.id).toBe("complacency-duration");
    expect(leg.metric).toBeCloseTo(50 / SLOW_CALM_RUN_MIN, 10); // progress toward threshold
  });

  test("run-length: sustained run ≥ 63 (+CONFIRM_CLOSES to confirm) → AMBER / fragileCalm:true", () => {
    // 65 flat calm closes = 63 to reach the threshold + 2 more so the AMBER raw state
    // holds CONFIRM_CLOSES consecutive closes and the confirmation buffer adopts it.
    const { leg, fragileCalm } = scoreDurationOfCalm(vixObs(rep(65, 10)));
    expect(fragileCalm).toBe(true);
    expect(leg.score).toBe(1);
    expect(leg.metric).toBeGreaterThanOrEqual(1); // 65 / 63 > 1
  });

  test("run-length: a single VIX spike above the cut resets the run → GREEN", () => {
    // 40 calm + one spike above the median + 40 calm: 80 calm days total, but the spike
    // breaks the run so the latest run is only 40 (< 63) ⇒ GREEN despite the calm regime.
    const { leg, fragileCalm } = scoreDurationOfCalm(
      vixObs([...rep(40, 10), 100, ...rep(40, 10)]),
    );
    expect(fragileCalm).toBe(false);
    expect(leg.score).toBe(0);
    expect(leg.metric).toBeCloseTo(40 / SLOW_CALM_RUN_MIN, 10); // run reset by the spike
  });

  test("cut uses the median (0.5), NOT the 0.1 decile", () => {
    // Distribution engineered so median and decile differ: 15 lows (5), 50 highs (25),
    // then a clean 65-day run at 15. Sorted ⇒ decile = 5, median = 15. The run values (15)
    // sit AT the median cut (calm, since reset is strict `> cut`) but ABOVE the decile cut
    // (5). So the median cut yields a confirmed AMBER run; a 0.1-decile cut would treat 15
    // as NOT calm ⇒ no run ⇒ GREEN. A true result therefore proves the higher (median) cut.
    const values = [...rep(15, 5), ...rep(50, 25), ...rep(65, 15)];
    const sorted = [...values].sort((a, b) => a - b);
    const cutMedian = quantile(sorted, 0.5);
    const cutDecile = quantile(sorted, 0.1);
    expect(cutMedian).toBe(15);
    expect(cutDecile).toBe(5);
    expect(cutMedian).not.toBe(cutDecile); // the two cuts genuinely diverge

    const { fragileCalm } = scoreDurationOfCalm(vixObs(values));
    expect(fragileCalm).toBe(true); // only the median cut (15) sustains the run
  });

  test("the duration leg NEVER moves computeSlowVerdict's band/score/ratio (activeCount stays 2)", () => {
    // Valid-length fixtures so all slow scorers run; the duration leg is appended to
    // `observability` only, so the 2-active band math is byte-identical with/without it.
    const qqq = Array.from({ length: SLOW_HIGH_WINDOW + PERSIST_N - 1 }, (_, i) => obs(i, 100));
    const vix = Array.from({ length: 65 }, (_, i) => obs(i, 18));
    const scored = scoreSlow(qqq, vix);

    // Four observability legs (3 prior + the T3.2 leg) but only 2 SCORED components.
    expect(scored.observability).toHaveLength(4);
    expect(scored.components).toHaveLength(2);

    const withLeg = computeSlowVerdict(scored.components, scored.observability, scored.fragileCalm);
    const baseline = computeSlowVerdict(scored.components); // no observability, no fragileCalm

    expect(withLeg.activeCount).toBe(2);
    expect(withLeg.band).toBe(baseline.band);
    expect(withLeg.score).toBe(baseline.score);
    expect(withLeg.maxScore).toBe(baseline.maxScore);
    expect(withLeg.ratio).toBe(baseline.ratio);
    // fragileCalm rides alongside without touching the band math.
    expect(withLeg.fragileCalm).toBe(scored.fragileCalm);
  });
});

// T3.2 duration-of-calm — the extracted sweepable raw-state series (harness anti-drift hook).
describe("durationOfCalmRawStateSeries (extracted per-day raw-state series)", () => {
  const vixObs = (values: number[]): Observation[] => values.map((v, i) => obs(i, v));
  const rep = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

  test("default fold is faithful to scoreDurationOfCalm on stable runs", () => {
    // scoreDurationOfCalm now DELEGATES to this series, so the two can't drift. On a stable
    // ≥65-day calm run the latest raw state is AMBER and the scorer confirms fragileCalm; on a
    // sub-threshold run both stay calm-but-not-fragile.
    const amber = vixObs(rep(65, 10));
    expect(durationOfCalmRawStateSeries(amber).at(-1)).toBe("AMBER");
    expect(scoreDurationOfCalm(amber).fragileCalm).toBe(true);

    const green = vixObs(rep(50, 10));
    expect(durationOfCalmRawStateSeries(green).at(-1)).toBe("GREEN");
    expect(scoreDurationOfCalm(green).fragileCalm).toBe(false);
  });

  test("a non-default runMin shifts the AMBER threshold (sweep parameter is live)", () => {
    // Clean 100-day calm run (flat ⇒ the cut is the level for any pctile). Default runMin=63:
    // 100 ≥ 63 ⇒ AMBER. At (0.6, 126) the same run is sub-threshold ⇒ GREEN — the argument
    // genuinely moves the edge, and the shipped default is unchanged.
    const vix = vixObs(rep(100, 10));
    expect(durationOfCalmRawStateSeries(vix).at(-1)).toBe("AMBER");
    expect(durationOfCalmRawStateSeries(vix, 0.6, 126).at(-1)).toBe("GREEN");
  });
});

describe("slow-track isolation from the fast ladder", () => {
  test("a degraded slow track (QQQ empty) scores null: fragileCalm false (no floor), no bubble push", async () => {
    const slowTrack = TRACKS.find((t) => t.baselineField === "slowBand")!;
    const scored = await slowTrack.score({ store: {} as Store, qqq: [], vixFront: [], vix3mBack: [], runAt: "2026-07-17T22:00:00.000Z", env: {} });
    expect(scored.alertFields).toEqual({ slowScore: null, slowBand: null, slowMaxScore: null });
    expect(scored.fragileCalm).toBe(false);
    expect(scored.notification(null, "2026-07-10").push).toBe(false);
  });
});

// Notify-on-upward-band-change for the slow tier is now exercised against the
// generic NotifyTier over SLOW_TIER — see notify_tier.test.ts (push/transition
// matrix across every (last, next) pair + golden ntfy payloads).

describe("slowStoredReadings (persistence projection)", () => {
  // The OBSERVABILITY set: price-accel + the two complacency legs, each carrying a
  // continuous metric. value=metric (the schema's "level"), NOT the score.
  const observability: SlowComponent[] = [
    { id: "price-accel", label: "Price acceleration", score: 2, metric: 0.97 },
    { id: "complacency-vix", label: "Complacency - VIX percentile", score: 0, metric: 0.42 },
    { id: "complacency-high", label: "Complacency - distance to 252d high", score: 1, metric: 0.99 },
  ];
  test("emits 3 rows with value=metric, delta20=0, state via scoreToState - no `complacency` row", () => {
    const rows = slowStoredReadings(observability, "2026-06-28");
    expect(rows).toEqual([
      { date: "2026-06-28", indicatorId: "price-accel", value: 0.97, delta20: 0, rawState: "RED", state: "RED" },
      { date: "2026-06-28", indicatorId: "complacency-vix", value: 0.42, delta20: 0, rawState: "GREEN", state: "GREEN" },
      { date: "2026-06-28", indicatorId: "complacency-high", value: 0.99, delta20: 0, rawState: "AMBER", state: "AMBER" },
    ]);
    expect(rows.map((r) => r.indicatorId)).not.toContain("complacency");
  });
  test("falls back to score when a component has no metric", () => {
    const [row] = slowStoredReadings([{ id: "price-accel", label: "x", score: 2 }], "2026-06-28");
    expect(row!.value).toBe(2);
  });
  test("scoreSlow's observability ids line up with the SLOW_INDICATORS leg ids (so /api/series resolves)", () => {
    // Valid-length fixtures so the scorers run: 272 flat QQQ closes + 60 flat VIX.
    const qqq = Array.from({ length: SLOW_HIGH_WINDOW + PERSIST_N - 1 }, (_, i) => obs(i, 100));
    const vix = Array.from({ length: 60 }, (_, i) => obs(i, 18));
    const { observability: live } = scoreSlow(qqq, vix);
    const ids = slowStoredReadings(live, "2026-06-28").map((r) => r.indicatorId);
    expect(ids).toEqual([
      "price-accel",
      "complacency-vix",
      "complacency-high",
      "complacency-duration", // T3.2 observability leg appended (band math unchanged)
    ]);
    expect(ids).toEqual(live.map((c) => c.id));
  });
});

describe("FETCH_EDGE_SCORED_IDS (the gap-fill sweep's insert-only slow legs)", () => {
  // A seeded 2y-ish read (QQQ short of SLOW_QQQ_WINDOW_DAYS, like the live range=2y price lookback) whose left edge
  // moves one bar between two runs: exactly the listed legs re-score a past date, so a value repair would churn them.
  test("equals the set of legs whose past-date value moves when the read's start moves one bar", () => {
    let seed = 11;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const dates: string[] = [];
    for (let d = Date.parse("2023-01-02T00:00:00Z"); dates.length < 504; d += 86_400_000) {
      if (new Date(d).getUTCDay() % 6 !== 0) dates.push(new Date(d).toISOString().slice(0, 10));
    }
    let q = 300;
    let v = 18;
    const qqq = dates.map((date) => ({ date, value: (q *= 1 + (rnd() - 0.48) * 0.02) }));
    const vix = dates.map((date) => ({ date, value: (v = Math.max(9, v + (rnd() - 0.5) * 2)) }));
    const cutoff = dates.at(-16)!;
    const before = new Map(slowBackfillRows(qqq.slice(0, -1), vix.slice(0, -1), cutoff).map((r) => [`${r.indicatorId}|${r.date}`, r.value]));
    const after = slowBackfillRows(qqq.slice(1), vix.slice(1), cutoff);
    const moved = new Set(after.filter((r) => before.has(`${r.indicatorId}|${r.date}`) && before.get(`${r.indicatorId}|${r.date}`) !== r.value).map((r) => r.indicatorId));
    expect(after.filter((r) => before.has(`${r.indicatorId}|${r.date}`)).length).toBeGreaterThan(0); // premise: past dates overlap
    expect([...moved].sort()).toEqual([...FETCH_EDGE_SCORED_IDS].sort());
  });
});
