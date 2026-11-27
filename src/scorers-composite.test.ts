// Mutation-driven edge pins for scorers-composite.ts (A3m-2): each test kills a decision mutant the
// subject suites left alive, incl. the config-multiplier direction pins (m ≠ 1 via the `config` param).
import { describe, expect, test } from "vitest";
import { indicator, utcDay } from "./dashboard.test-helpers.js";
import { CONFIRM_CLOSES, type Observation, VELOCITY_WINDOW } from "./domain-types.js";
import type { ThresholdConfig } from "./threshold-config.js";
import {
  BONOS_DESCRIPTOR,
  BUND_DESCRIPTOR,
  CG_DESCRIPTOR,
  CQS_DESCRIPTOR,
  EURC_DESCRIPTOR,
  VT_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { BUND, DISP, FXH, GB } from "./registry-composite.js";
import { ECY } from "./registry-fred.js";
import { PCT_MIN_OBS, rollingPercentile } from "./percentile.js";
import {
  backwardationStreak,
  btpLegSeries,
  bullSteepenerLegSeries,
  bullSteepenerReadingSeries,
  bullSteepenerState,
  bundLegSeries,
  creditBridgeCutSeries,
  creditBridgeReadingSeries,
  curveReadingSeries,
  dispersionReadingSeries,
  ecyExpensiveCut,
  ecyReadingSeries,
  fxHavenMoveSeries,
  fxHavenReadingSeries,
  globalBreadthReadingSeries,
  latestMove,
  levelBandCuts,
  levelBandHead,
  levelBandTailDepth,
  moveLegBase,
  moveLegSeries,
  moveScoreRows,
  oatLegBase,
  oatVelocityZ,
  ratioSpreadBaseOffset,
  ratioSpreadMeanWindow,
  ratioSpreadReadingSeries,
  scoreDispersion,
  scoreEcy,
  scoreGlobalBreadth,
  vixTermPersistenceReadingSeries,
  vxnTermDenominator,
} from "./scorers-composite.js";

const day = utcDay(2000);
const obs = (values: readonly number[], date: (i: number) => string = day): Observation[] =>
  values.map((value, i) => ({ date: date(i), value }));
// Deterministic, never-flat series: σ and pairwise correlations stay non-degenerate.
const wiggle = (n: number, base = 3, amp = 0.2): number[] =>
  Array.from({ length: n }, (_, i) => base + amp * Math.sin(i / 9) + (amp / 4) * Math.cos(i * 1.7));

describe("levelBand helpers", () => {
  const rolling = { kind: "rolling-percentile", window: 5, minObs: 3, amberP: 0.3, redP: 0.1 } as const;

  test("a rolling band's head is its minObs and its tail depth the full window", () => {
    expect(levelBandHead(rolling)).toBe(3);
    expect(levelBandTailDepth(rolling)).toBe(5);
  });

  test("a non-rolling band's tail depth is its head", () => {
    expect(levelBandTailDepth({ kind: "expanding-percentile", amberP: 0.3, redP: 0.1 })).toBe(PCT_MIN_OBS);
  });

  test("a rolling band's cuts are the trailing-window percentile", () => {
    const v = wiggle(12);
    const cuts = levelBandCuts(v, rolling, 0.5);
    expect(cuts).toEqual(rollingPercentile(v, 0.5, 5, 3));
    expect(Number.isFinite(cuts[11])).toBe(true);
  });
});

describe("ratio-spread unified scorer", () => {
  test("only a spread honours meanWindow", () => {
    expect(ratioSpreadMeanWindow({ ...VT_DESCRIPTOR, meanWindow: 3 })).toBe(1);
    expect(ratioSpreadMeanWindow({ ...EURC_DESCRIPTOR, meanWindow: 3 })).toBe(3);
  });

  test("baseOffset is never under VELOCITY_WINDOW and widens to a wider return window", () => {
    expect(ratioSpreadBaseOffset(VT_DESCRIPTOR)).toBe(VELOCITY_WINDOW);
    expect(ratioSpreadBaseOffset({ ...VT_DESCRIPTOR, window: 5 })).toBe(VELOCITY_WINDOW);
    expect(ratioSpreadBaseOffset({ ...VT_DESCRIPTOR, window: 60 })).toBe(60);
  });

  test("a zero or fractional meanWindow throws", () => {
    expect(() => ratioSpreadMeanWindow({ ...EURC_DESCRIPTOR, meanWindow: 0 })).toThrow(/positive integer/);
    expect(() => ratioSpreadMeanWindow({ ...EURC_DESCRIPTOR, meanWindow: 1.5 })).toThrow(/positive integer/);
  });

  const a = obs(wiggle(400));
  const b = obs(Array<number>(400).fill(1));

  test("CG rows carry both level-leg cuts under their wire keys", () => {
    const tail = ratioSpreadReadingSeries(indicator({ id: "CG" }), CG_DESCRIPTOR, a, b).at(-1)!;
    expect(Object.keys(tail.bandCuts ?? {}).sort()).toEqual(["levelAmber", "levelRed"]);
  });

  test("an id with only an amber wire key stamps only that key", () => {
    const tail = ratioSpreadReadingSeries(indicator({ id: "ECY" }), CG_DESCRIPTOR, a, b).at(-1)!;
    expect(Object.keys(tail.bandCuts ?? {})).toEqual(["ecyAmber"]);
  });
});

describe("vxnTermDenominator", () => {
  test("median of the trailing VXN/VIX ratios × VIX3M; a non-positive day skips; estimated stays flagged", () => {
    const vxn = obs([6, 2, 4, 10, 8, 12]);
    const vix = obs([1, 1, 1, 1, 1, 1]);
    const vix3m = obs([1, 1, 1, 1, 0, 1]).map((o, i) => (i === 5 ? { ...o, estimated: true } : o));
    // window 3 (odd): d3 ← [6,2,4] → 4; d4 → 0 × 4 skipped; d5 ← [4,10,8] → 8.
    expect(vxnTermDenominator(vxn, vix, vix3m, 3)).toEqual([
      { date: day(3), value: 4 },
      { date: day(5), value: 8, estimated: true },
    ]);
  });
});

describe("VT backwardation persistence", () => {
  test("the streak counts the oldest aligned close too", () => {
    expect(backwardationStreak(obs([1.2, 1.1, 1.3]), obs([1, 1, 1]))).toBe(3);
  });

  test("a ratio of exactly 1 is not backwardation and resets the streak", () => {
    const series = vixTermPersistenceReadingSeries(indicator({ id: "VTP" }), obs([1.2, 1, 1.2]), obs([1, 1, 1]));
    expect(series.map((r) => r.level)).toEqual([1, 0, 1]);
  });
});

describe("DISP dispersion", () => {
  test("exactly minLen closes with a degenerate last window throws the zero-variance error", () => {
    // rets[0] = 1 %, then flat: day 20's window is informative, day 21's is all-degenerate.
    const s = obs([100, 101, ...Array<number>(20).fill(101)]);
    expect(s).toHaveLength(22);
    expect(() => scoreDispersion(DISP, s, s, s)).toThrow(/zero-variance/);
  });

  test("VELOCITY_WINDOW + 1 informative closes emit one reading", () => {
    const s = obs(wiggle(21, 100, 5));
    expect(dispersionReadingSeries(DISP, s, s, s)).toHaveLength(1);
  });

  test("a flat leg contributes 0 to the pairwise mean instead of poisoning it", () => {
    const spy = obs(Array<number>(30).fill(100));
    const live = obs(wiggle(30, 100, 5));
    expect(dispersionReadingSeries(DISP, spy, live, live).at(-1)!.level).toBeCloseTo(1 / 3, 9);
  });

  test("states fold through the confirm buffer: a one-day recovery stays RED", () => {
    const fall = Array.from({ length: 21 }, (_, i) => 100 - 0.4 * i + 0.05 * ((i * 7) % 3));
    const s = obs([...fall, 110]);
    const last = dispersionReadingSeries(DISP, s, s, s).at(-1)!;
    expect(last.rawState).toBe("GREEN");
    expect(last.state).toBe("RED");
  });
});

describe("FXH haven moves", () => {
  test("each leg's move is −(20d return)", () => {
    const eur = obs([2, ...Array<number>(19).fill(2), 1.9]);
    const chf = obs(Array<number>(21).fill(1));
    const jpy = obs([100, ...Array<number>(19).fill(100), 90]);
    const r = fxHavenMoveSeries(eur, chf, jpy);
    expect(r.eurMove[0]).toBeCloseTo(0.05, 12);
    expect(r.jpyMove[0]).toBeCloseTo(0.1, 12);
  });
});

describe("GB global breadth", () => {
  test("a symbol with exactly MA_WINDOW closes survives; a flat close is not above its MA", () => {
    const spy = obs(Array<number>(200).fill(10), (i) => day(i + 1));
    const vgk = obs(Array<number>(201).fill(20));
    const series = globalBreadthReadingSeries(GB, { SPY: spy, VGK: vgk });
    expect(series).toHaveLength(1);
    expect(series[0]!.date).toBe(day(200));
    expect(series[0]!.level).toBe(0);
  });

  test("the MA is the trailing MA_WINDOW closes, not two more", () => {
    const spy = obs([1000, 1000, ...Array<number>(199).fill(1), 2]);
    expect(globalBreadthReadingSeries(GB, { SPY: spy }).at(-1)!.level).toBe(1);
  });

  test("scoreGlobalBreadth counts the MA_WINDOW − 1 warm-up as aligned closes", () => {
    const spy = obs(Array<number>(200).fill(10));
    expect(() => scoreGlobalBreadth(GB, { SPY: spy })).toThrow("need 202 aligned closes, got 200");
  });
});

describe("R7 bull steepener", () => {
  const cuts = (dropAmber: number, dropRed: number, steepAmber: number, steepRed: number) => ({
    dropAmber,
    dropRed,
    steepAmber,
    steepRed,
  });

  test("a zero steepening is not a bull steepener", () => {
    expect(bullSteepenerState(-0.5, -0.5, cuts(-0.1, -0.3, 5, 5))).toBe("GREEN");
  });

  test("a 2y drop exactly equal to the steepening still dominates", () => {
    expect(bullSteepenerState(-0.3, 0, cuts(-0.1, -0.2, 5, 5))).toBe("RED");
  });

  test("the drop cuts are inclusive", () => {
    expect(bullSteepenerState(-0.3, -0.2, cuts(-0.1, -0.3, 5, 5))).toBe("RED");
    expect(bullSteepenerState(-0.25, -0.15, cuts(-0.25, -1, 5, 5))).toBe("AMBER");
  });

  test("either amber tail alone fires AMBER", () => {
    expect(bullSteepenerState(-0.3, -0.2, cuts(-0.25, -1, 5, 5))).toBe("AMBER");
    expect(bullSteepenerState(-0.5, 0, cuts(-1, -2, 0.4, 5))).toBe("AMBER");
  });

  test("the steepening amber cut is inclusive", () => {
    expect(bullSteepenerState(-0.5, 0, cuts(-1, -2, 0.5, 5))).toBe("AMBER");
  });

  // Base 0 for 20 days, so day 20 + k carries Δ20 = the day's own value.
  const dgs2 = [...Array<number>(20).fill(0), -0.3, -0.5, 0, -0.3, -0.1, 0.3, -0.3];
  const dgs10 = [...Array<number>(20).fill(0), -0.2, -0.5, 0.2, 0, 0.3, 0.5, -0.5];

  test("the leg series' shape gate mirrors bullSteepenerState", () => {
    const legs = bullSteepenerLegSeries(obs(Array<number>(28).fill(1)), obs(dgs2), obs(dgs10));
    expect(legs.dates).toHaveLength(27); // day 27 has no rates: dropped from every leg
    expect(legs.d10[20]).toBeCloseTo(-0.2, 12);
    expect(legs.shortEndDriven.slice(20)).toEqual([true, false, false, true, false, false, false]);
  });

  test("a sub-1 multiplier moves the LOW drop cuts up and the HIGH steep cuts down", () => {
    const n = 160;
    const g2 = obs(wiggle(n, 2, 0.6));
    const g10 = obs(Array.from({ length: n }, (_, i) => 4 + 0.5 * Math.cos(i / 7) + 0.1 * Math.sin(i * 1.3)));
    const one = bullSteepenerLegSeries(obs(Array<number>(n).fill(1)), g2, g10).cuts;
    const half = bullSteepenerLegSeries(obs(Array<number>(n).fill(1)), g2, g10, 0.5).cuts;
    const i = n - 1;
    expect(half.dropAmber[i]).toBeGreaterThan(one.dropAmber[i]!);
    expect(half.dropRed[i]).toBeGreaterThan(one.dropRed[i]!);
    expect(half.steepAmber[i]).toBeLessThan(one.steepAmber[i]!);
    expect(half.steepRed[i]).toBeLessThan(one.steepRed[i]!);
  });

  test("the reading series starts after the Δ window plus the rank warm-up", () => {
    const n = 150;
    const series = bullSteepenerReadingSeries(
      indicator({ id: "R7" }),
      obs(Array<number>(n).fill(1)),
      obs(wiggle(n, 2, 0.6)),
      obs(wiggle(n, 4, 0.3)),
    );
    expect(series).toHaveLength(4);
    expect(series[0]!.date).toBe(day(146));
  });
});

describe("R6 MOVE", () => {
  test("moveScoreRows is the scored-day base plus CONFIRM_CLOSES", () => {
    expect(moveScoreRows()).toBe(moveLegBase() + CONFIRM_CLOSES);
  });

  test("latestMove needs base + CONFIRM_CLOSES closes", () => {
    expect(() => latestMove(indicator({ id: "R6" }), [], moveLegBase() + 1)).toThrow(
      `need ${moveLegBase() + CONFIRM_CLOSES} closes`,
    );
  });

  test("moveLegSeries emits one state slot per close", () => {
    const v = wiggle(moveLegBase() + 3, 100, 5);
    expect(moveLegSeries(indicator({ id: "R6" }), v).state).toHaveLength(v.length);
  });
});

describe("sovereign spread velocity legs", () => {
  const c = { velWindow: 1, velSigmaWindow: 3, measure: "log" as const };

  test("the log arm z-scores from index 0 when every close is positive", () => {
    const z = oatVelocityZ(wiggle(40), c);
    expect(z).toHaveLength(40);
    expect(Number.isFinite(z[20])).toBe(true);
  });

  test("the log arm restarts after the last non-positive close", () => {
    const v = wiggle(40);
    v[5] = 0;
    const z = oatVelocityZ(v, c);
    expect(z[25]).toBeUndefined();
    expect(Number.isFinite(z[26])).toBe(true);
  });

  test("the bp arm keeps negative spreads in its measured window", () => {
    const z = oatVelocityZ(wiggle(40, 0, 1), { ...c, measure: "bp" });
    expect(Number.isFinite(z[20])).toBe(true);
  });

  test("btpLegSeries emits one state and leg slot per close", () => {
    const v = wiggle(oatLegBase(BONOS_DESCRIPTOR.scorer.constants) + 3, 100, 5);
    const r = btpLegSeries(indicator({ id: "BONOS" }), v, BONOS_DESCRIPTOR);
    expect(r.state).toHaveLength(v.length);
    expect(r.leg).toHaveLength(v.length);
  });
});

describe("BUND curve legs", () => {
  test("no legs below VELOCITY_WINDOW, and a zero slope is not an inversion", () => {
    const slope = Array<number>(30).fill(0.5);
    slope[5] = 0;
    const y02 = Array.from({ length: 30 }, (_, i) => (i < 10 ? 3 : 2.6));
    const legs = bundLegSeries(slope, y02, 0.35);
    expect(legs[19]).toBeUndefined();
    expect(legs[25]!.c).toBe("GREEN"); // 2y Δ −0.4 qualifies, but no inversion was ever seen
  });
});

describe("CQS credit bridge", () => {
  const ebp = (...labels: string[]): Observation[] => labels.map((date) => ({ date, value: 1 }));
  const bridge = (spread: readonly number[], date: (i: number) => string) => ({
    baa: obs(spread, date),
    aaa: obs(Array<number>(spread.length).fill(0), date),
  });
  const { zAmber, zRed, sigmaWindow } = CQS_DESCRIPTOR.scorer.constants;
  const alternating = (n: number, amp: number) => Array.from({ length: n }, (_, j) => (j % 2) * amp);
  const cq = indicator({ id: "CQS" });

  test("σ is the population SD of the trailing ≤ sigmaWindow same-horizon Δs ending today", () => {
    const spread = Array.from({ length: 320 }, (_, j) => 0.5 * Math.sin(j * 1.3) + 0.3 * Math.cos(j * 0.37));
    const { baa, aaa } = bridge(spread, utcDay(2020));
    const { cuts } = creditBridgeCutSeries(baa, aaa, ebp("2020-09-01")); // anchor 2020-09-30 = index 273
    const sigmaAt = (t: number): number => {
      const L = t - 273;
      const d: number[] = [];
      for (let j = Math.max(L, t - sigmaWindow + 1); j <= t; j++) d.push(spread[j]! - spread[j - L]!);
      const m = d.reduce((x, y) => x + y, 0) / d.length;
      return Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / d.length);
    };
    for (const t of [280, 300, 319]) {
      expect(cuts.cqsAmber![t]).toBeCloseTo(zAmber * sigmaAt(t), 12);
      expect(cuts.cqsRed![t]).toBeCloseTo(zRed * sigmaAt(t), 12);
    }
  });

  test("the 20th same-horizon Δ arms σ; 19 do not", () => {
    // Anchor 2020-01-31: index 19 from Jan 12 (20 Δs), index 18 from Jan 13 (19 Δs).
    const armed = bridge(alternating(40, 0.1), utcDay(2020, 0, 12));
    expect(creditBridgeCutSeries(armed.baa, armed.aaa, ebp("2020-01-01")).cuts.cqsAmber![20]).toBeCloseTo(zAmber * 0.1, 12);
    const short = bridge(alternating(40, 0.1), utcDay(2020, 0, 13));
    expect(creditBridgeCutSeries(short.baa, short.aaa, ebp("2020-01-01")).cuts.cqsAmber!.every((x) => x === undefined)).toBe(true);
  });

  test("σ exactly at sigmaFloor stays unarmed", () => {
    const { baa, aaa } = bridge(alternating(40, 0.02), utcDay(2020, 0, 12)); // 20 Δs of ±0.02 ⇒ σ = 0.02 exactly
    expect(creditBridgeCutSeries(baa, aaa, ebp("2020-01-01")).cuts.cqsAmber![20]).toBeUndefined();
  });

  test("days before the first EBP anchor keep Δ = 0", () => {
    const { baa, aaa } = bridge(wiggle(90), utcDay(2020)); // anchors at index 30 and 59
    const series = creditBridgeReadingSeries(cq, baa, aaa, ebp("2020-01-01", "2020-02-01"));
    expect(series.slice(0, 10).map((r) => r.level)).toEqual(Array<number>(10).fill(0));
  });

  test("an anchor before the first close leaves Δ = 0", () => {
    const { baa, aaa } = bridge(wiggle(40), utcDay(2020));
    const series = creditBridgeReadingSeries(cq, baa, aaa, ebp("2019-12-01"));
    expect(series.map((r) => r.level)).toEqual(Array<number>(series.length).fill(0));
  });

  test("an anchor on the first close measures Δ from it", () => {
    const spread = wiggle(40);
    const { baa, aaa } = bridge(spread, utcDay(2020, 0, 31));
    const series = creditBridgeReadingSeries(cq, baa, aaa, ebp("2020-01-01"));
    expect(series[5]!.level).toBeCloseTo(spread[25]! - spread[0]!, 12);
  });
});

describe("ECY excess CAPE yield", () => {
  const N = 125;
  const monthDate = (m: number, dom = 15): string => new Date(Date.UTC(2000, m, dom)).toISOString().slice(0, 10);
  const cape = (m: number): number => 20 + 5 * Math.sin(m / 5) + m * 0.01;
  const real = (m: number): number => 1 + 0.5 * Math.cos(m / 3);
  const f7 = Array.from({ length: N }, (_, m) => ({ date: monthDate(m), value: cape(m) }));
  const dfii = Array.from({ length: N }, (_, m) => ({ date: monthDate(m), value: real(m) }));
  const last = N - 1;
  const ecyPct = (c: number, m: number): number => (1 / c - real(m) / 100) * 100;

  test("level is the month's ECY in percent", () => {
    expect(ecyReadingSeries(ECY, f7, dfii).at(-1)!.level).toBeCloseTo(ecyPct(cape(last), last), 12);
  });

  test("a non-positive CAPE month is dropped", () => {
    const bad = f7.map((o, m) => (m === last ? { ...o, value: -5 } : o));
    expect(ecyReadingSeries(ECY, bad, dfii).map((r) => r.date)).not.toContain(monthDate(last));
  });

  test("a non-finite DFII month is skipped", () => {
    const bad = dfii.map((o, m) => (m === last ? { ...o, value: NaN } : o));
    expect(ecyReadingSeries(ECY, f7, bad).map((r) => r.date)).not.toContain(monthDate(last));
  });

  test("the walk is date-sorted whatever the input order", () => {
    expect(ecyReadingSeries(ECY, [...f7].reverse(), dfii)).toEqual(ecyReadingSeries(ECY, f7, dfii));
  });

  test("within a month the latest date wins, whatever the input order", () => {
    const two = [...f7.slice(0, last), { date: monthDate(last, 20), value: 30 }, { date: monthDate(last, 5), value: 40 }];
    const tail = ecyReadingSeries(ECY, two, dfii).at(-1)!;
    expect(tail.date).toBe(monthDate(last, 20));
    expect(tail.level).toBeCloseTo(ecyPct(30, last), 12);
  });

  test("a same-date duplicate keeps the first observation", () => {
    const dup = [...f7.slice(0, last), { date: monthDate(last), value: 30 }, { date: monthDate(last), value: 40 }];
    expect(ecyReadingSeries(ECY, dup, dfii).at(-1)!.level).toBeCloseTo(ecyPct(30, last), 12);
  });

  const plusDays = (iso: string, d: number): string => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

  test("F7 exactly ECY_MAX_STALE_DAYS old still scores; one day more is stale", () => {
    expect(scoreEcy(ECY, f7, dfii, "GREEN", plusDays(monthDate(last), 60))).not.toBeNull();
    expect(scoreEcy(ECY, f7, dfii, "GREEN", plusDays(monthDate(last), 61))).toBeNull();
  });

  test("an empty F7 history scores null", () => {
    expect(scoreEcy(ECY, [], dfii, "GREEN", monthDate(last))).toBeNull();
  });

  test("staleness reads the newest F7 date, not the last-listed one", () => {
    expect(scoreEcy(ECY, [...f7].reverse(), dfii, "GREEN", plusDays(monthDate(last), 10))).not.toBeNull();
  });

  test("an empty history has no cut", () => {
    expect(ecyExpensiveCut([])).toBeNaN();
  });
});

describe("config multiplier seam: m = 0.8 moves each cut toward firing", () => {
  const at = (id: string, multiplier: number): ThresholdConfig => ({ multipliers: { [id]: { multiplier } } });

  test("BUND (LOW level leg): amber 0.45 lifts to 0.54, so a flat 0.5 slope fires", () => {
    const y10 = obs(Array<number>(21).fill(2.5));
    const y02 = obs(Array<number>(21).fill(2));
    const d = { ...BUND_DESCRIPTOR, amber: 0.45 };
    const raw = (config?: ThresholdConfig) => curveReadingSeries(BUND, d, y10, y02, config).at(-1)!.rawState;
    expect(raw(at(BUND.id, 1))).toBe("GREEN");
    expect(raw(at(BUND.id, 0.8))).toBe("AMBER");
  });

  test("FXH (HIGH): amber 0.05 drops to 0.04, so a 0.045 haven move fires", () => {
    const eur = obs([2, ...Array<number>(19).fill(2), 2 * (1 - 0.045)]);
    const chf = obs(Array<number>(21).fill(1));
    const jpy = obs(Array<number>(21).fill(100));
    const raw = (config?: ThresholdConfig) => fxHavenReadingSeries(FXH, eur, chf, jpy, 0.05, 0.2, config).at(-1)!.rawState;
    expect(raw(at(FXH.id, 1))).toBe("GREEN");
    expect(raw(at(FXH.id, 0.8))).toBe("AMBER");
  });

  test("GB (LOW participation): amber 0.5 lifts to 0.6, so 1-of-2 above MA fires", () => {
    const spy = obs([...Array<number>(200).fill(10), 11]);
    const vgk = obs(Array<number>(201).fill(20));
    const raw = (config?: ThresholdConfig) =>
      globalBreadthReadingSeries(GB, { SPY: spy, VGK: vgk }, 0.5, 0.1, config).at(-1)!.rawState;
    expect(raw(at(GB.id, 1))).toBe("GREEN");
    expect(raw(at(GB.id, 0.8))).toBe("AMBER");
  });

  test("DISP (HIGH corr gate): cut 0.4 drops to 0.32, so a 1/3 mean corr on a falling basket fires", () => {
    const fall = obs(Array.from({ length: 21 }, (_, i) => 100 - 0.4 * i + 0.05 * ((i * 7) % 3)));
    const flat = obs(Array<number>(21).fill(100));
    const raw = (config?: ThresholdConfig) => dispersionReadingSeries(DISP, flat, fall, fall, 0.4, config).at(-1)!.rawState;
    expect(raw(at(DISP.id, 1))).toBe("GREEN");
    expect(raw(at(DISP.id, 0.8))).not.toBe("GREEN");
  });
});
