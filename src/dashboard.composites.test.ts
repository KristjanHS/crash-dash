import { expect, test, describe } from "vitest";
import { readFileSync } from "node:fs";
import { scoreOil, mean } from "./scorers-core.js";
import {
  scoreRatioSpread,
  ratioSpreadValues,
  ratioSpreadPoints,
  ratioSpreadReadingSeries,
  ratioSpreadReadingSeriesFromValues,
  ratioSpreadMinLen,
  levelBandHead,
  readPathHeadRows,
  ratioSpreadState,
  scoreFxHaven,
  fxHavenState,
  scoreGlobalBreadth,
  globalBreadthState,
  scoreDispersion,
  dispersionReadingSeries,
  dispersionState,
  moveReadingSeries,
  moveLegBase,
  oatLegBase,
  percentileLevelState,
  levelBandValues,
  levelBandCuts,
  bonosSpreadReadingSeries,
  COMPOSITE_RESTATE_OF,
  ecyReadingSeries,
  ecyEstimateDates,
  ecyRows,
  ecyExpensiveCut,
  ecyExpensiveCutSeries,
  scoreEcy,
} from "./scorers-composite.js";
import {
  EPATH,
  HCX,
  FDX,
  GT,
  GB,
  DISP,
  BONOS,
} from "./registry-composite.js";
import {
  CG_AMBER_RET,
  EURC_AMBER,
  EURC_RED,
  FXH_AMBER,
  FXH_RED,
  DISP_CORR,
  DISP_BASKET_RED,
  DISP_CORR_P,
  DISP_CORR_P_WINDOW,
  DISP_CORR_P_MIN_OBS,
  GB_SYMBOLS,
  GB_AMBER,
  GT_AMBER,
  GT_RED,
  GB_RED,
  ECY_EXPENSIVE_P,
  ECY_MAX_STALE_DAYS,
} from "./family-descriptor-rows.js";
import {
  scoreGlobalTrend,
  scoreHcx,
  hcxBasketSeries,
  scoreRatioVsMa,
  breadthDistSeries,
  breadthCutSeries,
  spliceChainedIndex,
  CHAIN_BREAK_RATIO,
  CHAIN_QUIET_RATIO,
} from "./scorers-price.js";
import {
  type Reading,
  VELOCITY_WINDOW,
  CONFIRM_CLOSES,
  type Indicator,
  type Observation,
} from "./domain-types.js";
import { G1 } from "./registry-geo.js";
import { R6, ECY } from "./registry-fred.js";
import { quantile } from "./percentile.js";
import {
  CG_DESCRIPTOR,
  VT_DESCRIPTOR,
  EURC_DESCRIPTOR,
  EPATH_DESCRIPTOR,
  BONOS_DESCRIPTOR,
  R6_DESCRIPTOR,
  POINT_BAND_CUTS_OF,
  CHART_DESCRIPTOR_OF,
  COMPOSITE_LEVEL_BAND_OF,
  ECY_MIN_OBS,
  HCX_BAND,
  FDX_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { CG as CG_IND, FXH as FXH_IND, EURGBP, R7 } from "./registry-composite.js";
import { F5 } from "./registry-price.js";
import {
  BREADTH_MIN_CLOSES,
  returnOrMaConfig,
  scoreBreadth,
  scoreReturnOrMaSpread,
} from "./scorers-price.js";
import { BULL_MIN_OBS } from "./family-descriptor-rows.js";
import { scoreBullSteepener } from "./scorers-composite.js";
import { breadthClimb, priceSeries, PN, utcDay, monthDay } from "./dashboard.test-helpers.js";
import { computeAlertBand } from "./alert-band.js";
import { makeDial } from "./test-helpers.js";
import type { R4Phase } from "./r4.js";

describe("scoreOil (G1 oil shock - percent 20d return, GEO channel)", () => {
  // 20 baseline closes then a 4-day tail; scoreOil reads ret = close / close[-20].
  const oilObs = (tail: number[], baseline = 70): Observation[] =>
    [...Array.from({ length: 20 }, () => baseline), ...tail].map((value, i) => ({ date: monthDay("02")(i), value }));

  test("a non-positive base scores GREEN (2020 negative-WTI guard)", () => {
    // Baseline -5 (negative futures) then a positive tail: the % return is
    // meaningless, so the guard treats it as no shock rather than a sign-flip spike.
    expect(scoreOil(G1, oilObs([70, 70, 70, 70], -5)).state).toBe("GREEN");
  });
  test("a +43% 20d move on SHORT history caps at AMBER - split RED needs a resolvable trailing peak", () => {
    const r = scoreOil(G1, oilObs([70, 70, 100, 100])); // 100/70 - 1 = +42.9%
    expect(r.state).toBe("AMBER");
    expect(r.level).toBe(100);
    expect(r.delta20).toBeCloseTo(30); // honest absolute change of the headline level
  });
});

describe("ratioSpreadState/CG (T2.2 - 20d ratio return bands; a FALLING ratio is risk-off)", () => {
  test("non-default (amber, red) thresholds shift both band edges (backtest-sweep hook)", () => {
    // Tighter cuts amber −5% / red −12%: −8% now AMBER (GREEN under the shipped −10/−20), −15%
    // now RED (AMBER by default) — one shifted edge per band; the args move the edges, not the consts.
    expect(ratioSpreadState(-0.08, CG_DESCRIPTOR, -0.05, -0.12)).toBe("AMBER");
    expect(ratioSpreadState(-0.15, CG_DESCRIPTOR, -0.05, -0.12)).toBe("RED");
  });
});

describe("scoreRatioSpread/CG (T2.2 - HG÷GC ratio, CONTEXT confirmer, confirmed via CONFIRM_CLOSES)", () => {
  // CG lands in the registry in Stage 2; a stub carries the id/channel the scorer needs here.
  const CG: Indicator = {
    id: "CG",
    label: "Copper/gold ratio",
    longLabel: "Copper/gold ratio",
    series: "HG=F",
    channel: "CONTEXT",
    confirmer: true,
    thresholds: {},
    unit: "",
  };
  // A FLAT baseline then a short tail, gold held FLAT so the ratio return === the copper
  // return (ret = ratio / ratio[-20]). Same shape as scoreOil.
  //
  // The baseline is `CG_BASE` long, DERIVED from the scorer's own baseOffset — CG gained an
  // expanding-percentile LEVEL leg 2026-08-08 and DETRENDED it the same day, so its head is
  // `levelBandHead` (the trend window's NaN run + PCT_MIN_OBS), not 20 and no longer plain
  // PCT_MIN_OBS. The baseline being flat also pins the level leg GREEN on it (a flat series has
  // deviation 0 everywhere, so the expanding cut IS the value and the edges are strict), which is
  // what keeps every expectation below a statement about the VELOCITY leg alone — except where
  // the tail drops the ratio, where the level leg goes RED too and `combine: "split"` needs both.
  const CG_BASE = Math.max(levelBandHead(CG_DESCRIPTOR.levelBand), VELOCITY_WINDOW);
  const day = utcDay(2025);
  const cgObs = (copperTail: number[], copperBase = 4.0, gold = 2000) => {
    const copper = [...Array.from({ length: CG_BASE }, () => copperBase), ...copperTail];
    const hg: Observation[] = copper.map((value, i) => ({ date: day(i), value }));
    const gc: Observation[] = copper.map((_, i) => ({ date: day(i), value: gold }));
    return { hg, gc };
  };

  test("a FLAT ratio is GREEN - the amber cut sits below zero, so no move is not a move", () => {
    // The discriminating case for the 2026-08-08 retune: with amber AT zero a flat series was
    // AMBER (any non-positive return fired), which put ~half of all real days at ≥AMBER. Re-arming
    // amber to zero reds this test — that is the demo.
    expect(CG_AMBER_RET).toBeLessThan(0);
    const { hg, gc } = cgObs([4.0, 4.0, 4.0, 4.0]); // 0% ratio move
    const r = scoreRatioSpread(CG, CG_DESCRIPTOR, hg, gc);
    expect(r.rawState).toBe("GREEN");
    expect(r.state).toBe("GREEN");
    // ⚠ No shallow-decline (inside the amber band ⇒ still GREEN) twin is constructible on this
    // fixture: the baseline is CONSTANT, so ANY tail drop puts the value under its own expanding
    // percentile and the LEVEL leg fires regardless of how small the return move is. The velocity
    // band's interior is pinned in family-golden.test.ts instead.
  });
  test("a single elevated close confirms SAME-DAY (instant-up)", () => {
    const { hg, gc } = cgObs([4.0, 4.0, 4.0, 3.0]); // only the last day is RED (−25% ratio drop)
    const r = scoreRatioSpread(CG, CG_DESCRIPTOR, hg, gc);
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED"); // instant-up: escalation confirms same-day; CONFIRM_TIERS buffers only the stand-down
    expect(r.level).toBeCloseTo(3.0 / 2000); // headline `level` = the ratio
  });
});

describe("scoreRatioSpread/VT (T1.2 - VIX÷VIX3M ratio, COINCIDENT, confirmed via CONFIRM_CLOSES)", () => {
  // VT lives in the registry; a local stub carries the id/channel the scorer needs here
  // (mirrors the copper-gold test — the scorer test stays isolated from registry wiring).
  const VT: Indicator = {
    id: "VT",
    label: "VIX term structure",
    longLabel: "VIX term structure",
    series: "^VIX",
    channel: "COINCIDENT",
    thresholds: {},
    unit: "",
  };
  // 20 baseline VIX closes then a 4-day tail, VIX3M held FLAT so the ratio === VIX/VIX3M
  // (the state reads the LEVEL, not a return). Same fixture shape as scoreCopperGold.
  const vtObs = (vixTail: number[], vixBase = 18, vix3m = 20) => {
    const vixSeries = [...Array.from({ length: 20 }, () => vixBase), ...vixTail];
    const vix: Observation[] = vixSeries.map((value, i) => ({ date: monthDay("02")(i), value }));
    const v3m: Observation[] = vixSeries.map((_, i) => ({ date: monthDay("02")(i), value: vix3m }));
    return { vix, v3m };
  };

  test("flattening ratio 0.96 confirms AMBER (≥ 0.95, < 1.00)", () => {
    const { vix, v3m } = vtObs([18, 18, 19.2, 19.2]); // 19.2/20 = 0.96
    const r = scoreRatioSpread(VT, VT_DESCRIPTOR, vix, v3m);
    expect(r.rawState).toBe("AMBER");
    expect(r.state).toBe("AMBER"); // held 2 closes
  });
});

describe("scoreRatioSpread/EURC (slice 1b - ECB euro curve, GLOBAL channel, confirmed via CONFIRM_CLOSES)", () => {
  // EURC lives in the registry; a local stub carries the id/channel the scorer needs here
  // (mirrors the VT/copper-gold scorer tests — isolated from registry wiring).
  const EURC: Indicator = {
    id: "EURC",
    label: "Euro curve 10y−3m (ECB AAA)",
    longLabel: "Euro curve 10y−3m (ECB AAA)",
    series: "SR_10Y",
    channel: "GLOBAL",
    thresholds: {},
    unit: "",
  };
  // 20 baseline days then a 4-day tail. SR_3M held FLAT so the spread === SR_10Y − SR_3M
  // reads directly off the 10y tail (the state is the LEVEL of the spread, not a return).
  const ecObs = (tenTail: number[], tenBase = 3.0, three = 2.0) => {
    const tenSeries = [...Array.from({ length: 20 }, () => tenBase), ...tenTail];
    const sr10y: Observation[] = tenSeries.map((value, i) => ({ date: monthDay("03")(i), value }));
    const sr3m: Observation[] = tenSeries.map((_, i) => ({ date: monthDay("03")(i), value: three }));
    return { sr10y, sr3m };
  };

  test("the [OPEN] priors EURC_AMBER/EURC_RED are actually wired: a spread between them confirms AMBER", () => {
    // Spread sits strictly between EURC_RED (0.00) and EURC_AMBER (0.50): a scorer that
    // ignored the priors (e.g. hard-coded 0 cuts, or GREEN) would fail this.
    const mid = (EURC_AMBER + EURC_RED) / 2; // 0.25 with the shipped priors
    const { sr10y, sr3m } = ecObs([3.0, 3.0, 2.0 + mid, 2.0 + mid]); // spread = mid
    const r = scoreRatioSpread(EURC, EURC_DESCRIPTOR, sr10y, sr3m);
    expect(r.state).toBe("AMBER");
    expect(r.level).toBeCloseTo(mid); // headline `level` = the spread
  });
});

describe("EPATH (direction HIGH spread: a priced hike path is the risk)", () => {
  const { red } = EPATH_DESCRIPTOR;
  test("the registered EPATH scores its meaned SR_1Y − ESTR spread HIGH", () => {
    const n = ratioSpreadMinLen(EPATH_DESCRIPTOR);
    const m = EPATH_DESCRIPTOR.meanWindow;
    // A rising spread: the newest raw close sits above the trailing mean, so a dropped mean reads a different level.
    const spreads = Array.from({ length: n }, (_, i) => red + 0.1 + 0.01 * i);
    const estr = spreads.map((_, i) => ({ date: monthDay("05")(i), value: 2 }));
    const sr1y = estr.map((o, i) => ({ date: o.date, value: o.value + spreads[i]! }));
    const r = scoreRatioSpread(EPATH, EPATH_DESCRIPTOR, sr1y, estr);
    expect(r.level).toBeCloseTo(spreads.slice(-m).reduce((x, y) => x + y, 0) / m, 12);
    expect(r.state).toBe("RED");
  });
});

describe("ratio-spread meanWindow: scored + persisted value = trailing mean of the spread; absent ⇒ raw spread", () => {
  const M = 3;
  const meaned = { ...EURC_DESCRIPTOR, meanWindow: M } as const;
  const stub: Indicator = { id: "MW", label: "MW", longLabel: "MW", series: "A", channel: "GLOBAL", thresholds: {}, unit: "" };
  const hi = EURC_AMBER + 0.5;
  const lo = EURC_AMBER - 0.1; // one sub-amber close; the M-mean stays above amber
  const legs = (spreads: number[]) => ({
    a: spreads.map((s, i) => ({ date: monthDay("04")(i), value: 2 + s })),
    b: spreads.map((_, i) => ({ date: monthDay("04")(i), value: 2 })),
  });
  const spreads = [...Array.from({ length: VELOCITY_WINDOW + M }, () => hi), lo];
  const { a, b } = legs(spreads);
  const meanAt = (k: number) => spreads.slice(k, k + M).reduce((x, y) => x + y, 0) / M;

  test("values are the trailing M-means, dated from the first full window", () => {
    const { dates, values } = ratioSpreadValues(meaned, a, b);
    expect(dates).toEqual(a.slice(M - 1).map((o) => o.date));
    values.forEach((v, k) => expect(v).toBeCloseTo(meanAt(k), 12));
  });
  test("the mean is what scores: a lone sub-amber close stays GREEN; the raw-spread twin reads AMBER", () => {
    expect(lo).toBeGreaterThan(EURC_RED); // precondition: the raw close is AMBER, not RED
    const r = scoreRatioSpread(stub, meaned, a, b);
    expect(r.level).toBeCloseTo(meanAt(spreads.length - M), 12);
    expect(r.rawState).toBe("GREEN");
    const raw = scoreRatioSpread(stub, EURC_DESCRIPTOR, a, b);
    expect(raw.level).toBeCloseTo(lo, 12);
    expect(raw.rawState).toBe("AMBER");
  });
  test("no meanWindow (EURC): values are the raw spread on every aligned date", () => {
    const { dates, values } = ratioSpreadValues(EURC_DESCRIPTOR, a, b);
    expect(dates).toEqual(a.map((o) => o.date));
    values.forEach((v, k) => expect(v).toBeCloseTo(spreads[k]!, 12));
  });
  test("a value-domain re-score of the stored means never re-means them", () => {
    const run = ratioSpreadReadingSeries(stub, meaned, a, b).map((r) => [r.date, r.level, r.rawState]);
    const reread = ratioSpreadReadingSeriesFromValues(stub, meaned, ratioSpreadPoints(meaned, a, b));
    expect(reread.map((r) => [r.date, r.level, r.rawState])).toEqual(run);
  });
  test("the min-length guard counts the mean head", () => {
    const need = VELOCITY_WINDOW + CONFIRM_CLOSES + M - 1;
    const short = legs(spreads.slice(0, need - 1));
    expect(() => scoreRatioSpread(stub, meaned, short.a, short.b)).toThrow(`[MW] need ${need} aligned closes`);
  });
});

describe("fxHavenState (slice 1b Stage 4 - worst-of 20d haven-bid move; HIGH, inclusive ≥)", () => {
  // Prose cites the SYMBOLS, never their current values — the numeric literals below are fixture
  // points chosen to sit outside/between the shipped band pair, not a second copy of the cuts.
  test("default bands FXH_AMBER / FXH_RED; a bigger haven bid is more danger", () => {
    expect(fxHavenState(0.01)).toBe("GREEN"); // below amber
    expect(fxHavenState(FXH_AMBER)).toBe("AMBER"); // inclusive edge (≥ FXH_AMBER)
    expect(fxHavenState(FXH_RED)).toBe("RED"); // inclusive edge (≥ FXH_RED)
    expect(fxHavenState(-0.06)).toBe("GREEN"); // a risk-ON move is never danger
  });
});

describe("scoreFxHaven (slice 1b Stage 4 - FX-haven composite, GLOBAL channel, confirmed via CONFIRM_CLOSES)", () => {
  // FXH lives in the registry; a local stub carries the id/channel the scorer needs here
  // (mirrors the EURC/VT scorer tests — isolated from registry wiring).
  const FXH: Indicator = {
    id: "FXH",
    label: "FX havens (EUR/CHF/JPY bid)",
    longLabel: "FX havens (EUR/CHF/JPY bid)",
    series: "EURUSD=X",
    channel: "GLOBAL",
    thresholds: {},
    unit: "",
  };
  // 20 flat baseline days (value 1.0) then a 4-day tail at 1.0*(1+move). The 20d return at
  // each tail index reads baseline→tail, so the tail's `move` IS the series' 20d return. A
  // haven bid = the series FALLING, so a NEGATIVE `move` is a haven bid for every series.
  const fxSeries = (move: number): Observation[] => {
    const vals = [...Array.from({ length: 20 }, () => 1.0), ...Array.from({ length: 4 }, () => 1.0 * (1 + move))];
    return vals.map((value, i) => ({ date: monthDay("03")(i), value }));
  };
  const flat = fxSeries(0); // no move → 20d return 0 → not a haven bid

  // --- Per-series sign assertions (the load-bearing polarity; a flip fails loudly) ---
  // A flipped leg sign (+return) would read its FALLING series as risk-on → GREEN.
  test.each([
    { leg: "EURUSD=X", legs: [fxSeries(-0.06), flat, flat] },
    { leg: "CHF=X", legs: [flat, fxSeries(-0.06), flat] },
    { leg: "JPY=X", legs: [flat, flat, fxSeries(-0.06)] },
  ] as const)("$leg falling ALONE fires RED - that leg's haven sign", ({ legs }) => {
    const r = scoreFxHaven(FXH, ...legs);
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED");
  });

  // --- Composite "haven bid on" vs "risk-on" (the mirror pair) ---
  test("haven bid on (EUR weak / CHF+JPY strong - all three falling) confirms RED", () => {
    const r = scoreFxHaven(FXH, fxSeries(-0.06), fxSeries(-0.06), fxSeries(-0.06));
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED"); // held 2 closes
    expect(r.level).toBeCloseTo(1.0 * (1 - 0.06)); // headline `level` = the EURUSD=X close
  });
  test("the [OPEN] priors FXH_AMBER/FXH_RED are wired: a single-series move between them confirms AMBER", () => {
    // A CHF move sized at the MIDPOINT of the band pair → a haven-bid move strictly between
    // FXH_AMBER and FXH_RED (values cited by SYMBOL only — they retune); a scorer that ignored
    // the priors (hard-coded 0 cuts, or GREEN) would fail this.
    const mid = -(FXH_AMBER + FXH_RED) / 2;
    const r = scoreFxHaven(FXH, flat, fxSeries(mid), flat);
    expect(r.rawState).toBe("AMBER");
    expect(r.state).toBe("AMBER");
  });
});

const gtbDate = utcDay(2024);
// A monotonically RISING series → latest close above its own MA200 (participating).
const risingSeries = (): Observation[] =>
  Array.from({ length: 260 }, (_, i) => ({ date: gtbDate(i), value: 100 * Math.pow(1.001, i) }));
// A monotonically FALLING series → latest close below its own MA200 (not participating).
const fallingSeries = (): Observation[] =>
  Array.from({ length: 260 }, (_, i) => ({ date: gtbDate(i), value: 100 * Math.pow(0.999, i) }));

describe("scoreGlobalTrend (slice 1b Stage 5 - ACWI vs MA200, GLOBAL channel, REAL red band)", () => {
  // Uses the real registry GT so its `derived` descriptor (which carries GT_AMBER/GT_RED,
  // the scoring bands) is validated wired end-to-end. 255 flat baseline days at 100 then a
  // 5-day tail (≥ CONFIRM_CLOSES) at `last`.
  const gtSeries = (last: number): Observation[] =>
    Array.from({ length: 260 }, (_, i) => ({ date: gtbDate(i), value: i >= 255 ? last : 100 }));

  // The MA200 at the tail SPANS the tail (195 baseline + 5 tail days), so it is not 100 and
  // maSpread ≠ last/100 − 1. Invert the real relation — MA = 97.5 + 0.025·last, spread =
  // last/MA − 1 ⇒ last = 97.5(1+s) / (1 − 0.025(1+s)) — so each fixture is placed at a spread
  // chosen RELATIVE TO THE CUTS rather than at a hand-typed price. Hand-typed prices are what
  // made the old GREEN case (106) fixture-fragile: it sat ≈+0.058, which a retune can cross
  // without the test naming a number at all.
  const gtSeriesAtSpread = (s: number): Observation[] =>
    gtSeries((97.5 * (1 + s)) / (1 - 0.025 * (1 + s)));
  // Vacuity guard for the inversion: if it drifts, every band fixture below silently lands on
  // the wrong side of a cut while still asserting a state.
  test("gtSeriesAtSpread places the tail at the requested maSpread (fixture guard)", () => {
    for (const s of [-0.05, GT_RED - 0.02, (GT_AMBER + GT_RED) / 2, GT_AMBER + 0.02]) {
      expect(scoreGlobalTrend(GT, gtSeriesAtSpread(s)).decision!).toBeCloseTo(s, 10);
    }
  });

  test("ACWI's cushion above trend clears GT_AMBER → GREEN", () => {
    expect(scoreGlobalTrend(GT, gtSeriesAtSpread(GT_AMBER + 0.02)).state).toBe("GREEN");
  });
  test("cushion between GT_RED and GT_AMBER → AMBER", () => {
    const r = scoreGlobalTrend(GT, gtSeriesAtSpread((GT_AMBER + GT_RED) / 2));
    expect(r.rawState).toBe("AMBER");
    expect(r.state).toBe("AMBER");
  });
  test("the REAL red band GT_RED is wired: cushion at/below it → RED (not capped at AMBER like NVDA)", () => {
    const r = scoreGlobalTrend(GT, gtSeriesAtSpread(GT_RED - 0.02));
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED"); // unlike the NVDA gate (red:null), GT can go RED
  });
  // Post-2026-07-29-retune discriminator: both cuts are POSITIVE, so a close BELOW the MA200
  // is deep in RED. Under the retired pair this same fixture was the AMBER case — it is the
  // one fixture that separates the two band shapes, so it must stay.
  test("ACWI BELOW its own MA200 is RED, not the AMBER it scored under the retired cuts", () => {
    const r = scoreGlobalTrend(GT, gtSeriesAtSpread(-0.05));
    expect(r.state).toBe("RED");
  });
});

describe("scoreGlobalBreadth (slice 1b Stage 5 - participation of 7 ETFs vs their MA200, GLOBAL channel)", () => {
  // `nRising` of the 7 GB_SYMBOLS are rising (above MA200 = participating), the rest falling.
  // Monotonic series ⇒ participation is stable near the tail ⇒ the state confirms.
  const build = (nRising: number): Record<string, Observation[]> => {
    const out: Record<string, Observation[]> = {};
    GB_SYMBOLS.forEach((s, k) => (out[s] = k < nRising ? risingSeries() : fallingSeries()));
    return out;
  };

  // The three participation fixtures are DERIVED from the shipped cuts (a retune moves them
  // with it), then asserted to land in the intended band: `nAbove` is the smallest count whose
  // participation clears a cut, so `above(GB_AMBER)` is the first GREEN count and
  // `above(GB_RED)` the first AMBER one. Values stay pinned out-of-band in the golden.
  const nSymbols = GB_SYMBOLS.length;
  const above = (cut: number) => Math.ceil(cut * nSymbols);
  test("participation at/above the AMBER cut is GREEN", () => {
    const n = above(GB_AMBER);
    const r = scoreGlobalBreadth(GB, build(n));
    expect(r.level).toBeCloseTo(n / nSymbols);
    expect(r.state).toBe("GREEN");
  });
  test("GB_AMBER is wired: participation below it but at/above GB_RED is AMBER", () => {
    const n = above(GB_RED);
    const r = scoreGlobalBreadth(GB, build(n));
    expect(r.level).toBeCloseTo(n / nSymbols);
    expect(n / nSymbols).toBeLessThan(GB_AMBER); // vacuity guard: the fixture really is sub-amber
    expect(r.rawState).toBe("AMBER");
    expect(r.state).toBe("AMBER");
  });
  test("GB_RED is wired: participation below it is RED", () => {
    const n = above(GB_RED) - 1;
    const r = scoreGlobalBreadth(GB, build(n));
    expect(r.level).toBeCloseTo(n / nSymbols);
    expect(r.state).toBe("RED");
  });
  test("a symbol too short for its own MA200 is DROPPED from the denominator (over survivors, not zero-counted)", () => {
    const bySymbol: Record<string, Observation[]> = {};
    const survivors = nSymbols - 1;
    // The rising count is derived so the two denominators land in DIFFERENT bands — otherwise
    // the test passes whether or not the short symbol is excluded (the whole point of it).
    const nRising = Math.ceil(GB_AMBER * survivors);
    GB_SYMBOLS.slice(0, survivors).forEach((s, k) => (bySymbol[s] = k < nRising ? risingSeries() : fallingSeries()));
    // The last symbol is too short to have its own MA200 → EXCLUDED. Counted as below-MA=0 it
    // would drag participation onto `nSymbols` and into a WORSE band; over the survivors it holds.
    bySymbol[GB_SYMBOLS[survivors]!] = fallingSeries().slice(0, 50);
    expect(globalBreadthState(nRising / survivors, GB_AMBER, GB_RED)).not.toBe(
      globalBreadthState(nRising / nSymbols, GB_AMBER, GB_RED),
    ); // vacuity guard: the two denominators really do disagree
    const r = scoreGlobalBreadth(GB, bySymbol);
    expect(r.level).toBeCloseTo(nRising / survivors); // survivors-only denominator
    expect(r.state).toBe(globalBreadthState(nRising / survivors, GB_AMBER, GB_RED));
  });
  test("globalBreadthState edges: strict < on both bands", () => {
    expect(globalBreadthState(GB_AMBER, GB_AMBER, GB_RED)).toBe("GREEN"); // exactly at amber is not < amber
    expect(globalBreadthState(GB_AMBER - 0.01, GB_AMBER, GB_RED)).toBe("AMBER");
    expect(globalBreadthState(GB_RED, GB_AMBER, GB_RED)).toBe("AMBER"); // exactly at red is not < red
    expect(globalBreadthState(GB_RED - 0.01, GB_AMBER, GB_RED)).toBe("RED");
  });
});

describe("scoreDispersion (slice 1b Stage 6 - SPY·FEZ·EEM systemic/isolated; corr + negative-basket)", () => {
  const dispDate = utcDay(2024);
  // Build a price series (start 100) from a list of daily returns.
  const fromReturns = (rets: number[], start = 100): Observation[] => {
    const vals = [start];
    for (const r of rets) vals.push(vals[vals.length - 1]! * (1 + r));
    return vals.map((value, i) => ({ date: dispDate(i), value }));
  };
  // 40 days of OSCILLATING (real-variance) daily returns — even days one move, odd days the
  // other, so the daily returns VARY (non-zero variance ⇒ correlation is well-defined, NOT
  // the constant-return zero-variance trap the NaN guard covers).
  const wiggle = (a: number, b: number): number[] => Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b));
  const downRets = wiggle(-0.03, 0.01); // net ≈ −2%/2d drift
  const upRets = wiggle(0.03, -0.01); // element-wise −downRets ⇒ net-UP + anti-correlated

  test("all three falling TOGETHER (corr 1 + negative basket) → firing RED (broad/systemic)", () => {
    // Identical down-paths ⇒ pairwise corr = 1 ≥ DISP_CORR AND basket return < 0 ⇒ RED.
    const r = scoreDispersion(DISP, fromReturns(downRets), fromReturns(downRets), fromReturns(downRets));
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED"); // held ≥ CONFIRM_CLOSES
    expect(r.level).toBeCloseTo(1); // level = the mean pairwise corr (perfectly correlated)
  });

  test("one region down, two up → NOT firing (isolated) - mean corr collapses below the cut", () => {
    // SPY falls; FEZ & EEM rise together (upRets = −downRets). corr(SPY,FEZ)=corr(SPY,EEM)=−1
    // while corr(FEZ,EEM)=1 ⇒ mean ≈ −0.33 « DISP_CORR ⇒ GREEN (isolated, not systemic).
    const r = scoreDispersion(DISP, fromReturns(downRets), fromReturns(upRets), fromReturns(upRets));
    expect(r.state).toBe("GREEN");
  });

  test("calm all-UP basket (corr 1 but RISING) → GREEN - the negative-basket gate", () => {
    // All three rise together: corr = 1 ≥ DISP_CORR, but the basket return is POSITIVE, so the
    // down-gate keeps it GREEN — a broad RALLY is not danger.
    const r = scoreDispersion(DISP, fromReturns(upRets), fromReturns(upRets), fromReturns(upRets));
    expect(r.state).toBe("GREEN");
  });

  // Audit row 9 (CORE-B7, 2026-08-09) — the two-tiered zero-variance guard. `flatLeg` is a FLAT
  // price series: every daily return is EXACTLY 0 ⇒ zero return-variance ⇒ every pair it takes
  // part in is degenerate (Pearson 0/0). ⚠ A 100·1.001^i ramp does NOT reach this branch: its
  // returns are constant only in exact arithmetic, and float ULP noise leaves a non-zero variance.
  // The two branches below must NOT collapse into one another.
  const flatLeg = (n: number) => Array.from({ length: n }, (_, i) => ({ date: dispDate(i), value: 100 }));

  test("one degenerate leg among live ones → STILL a reading (a quiet leg cannot silence a live family)", () => {
    // EEM is the flat (zero-variance-return) leg: pairs (SPY,EEM) and (FEZ,EEM) are degenerate and
    // contribute 0, but (SPY,FEZ) is live — so the read keeps information and DISP still scores.
    // downRets is a 40-day fixture; the flat leg gets the same length so the 3-way inner join
    // keeps every day.
    const r = scoreDispersion(DISP, fromReturns(downRets), fromReturns(downRets), flatLeg(downRets.length + 1));
    expect(Number.isFinite(r.level)).toBe(true);
    // corr(SPY,FEZ)=1, the two degenerate pairs contribute 0, denominator stays 3 ⇒ level = 1/3.
    expect(r.level).toBeCloseTo(1 / 3);
    expect(r.state).toBe("GREEN"); // 1/3 ≤ DISP_CORR ⇒ confirm gate off, but the READING exists
  });

  test("EVERY pair degenerate (all legs flat) → NO READING, not a fabricated GREEN", () => {
    // All three legs flat ⇒ all three pairs degenerate on every window ⇒ the read carries no
    // information. Pre-2026-08-09 this persisted level 0 / GREEN; it must now degrade out.
    const flat = flatLeg(260);
    expect(dispersionReadingSeries(DISP, flat, flat, flat)).toEqual([]);
    expect(() => scoreDispersion(DISP, flat, flat, flat)).toThrow(
      /\[DISP\] every pair has a zero-variance leg on the latest of 260 aligned closes/,
    );
  });

  test("live history then a FROZEN tail on all three legs → the tail is dropped, no reading published", () => {
    // The mixed case the history-wide guard missed (review of audit row 9): a repeat-close /
    // frozen feed on all three legs for the last stretch. Every trailing window then has a
    // zero-variance leg on all three pairs, so the forced-0 level would score
    // dispersionState(0, basket≈0) = GREEN and be persisted + pushed as today's read — purely
    // because SOME ancient day was informative. The gate is per-read: the tail is dropped and
    // scoreDispersion throws.
    const frozen = (n: number): Observation[] => {
      const live = fromReturns(downRets); // 41 prices, dispDate(0..40); rets[0..39] vary
      const held = live[live.length - 1]!.value;
      return [
        ...live,
        ...Array.from({ length: n }, (_, k) => ({ date: dispDate(live.length + k), value: held })),
      ];
    };
    const legs = frozen(30); // 71 aligned closes; rets[40..69] are all exactly 0
    const series = dispersionReadingSeries(DISP, legs, legs, legs);
    // Day i is emitted off the window rets[i−20 .. i−1]; that window is wholly inside the
    // frozen run from i = 60 on, so the LAST informative emitted day is i = 59. Pre-fix the
    // series ran to i = 70 (the last aligned close) with a fabricated 0-level GREEN tail.
    expect(series.length).toBeGreaterThan(0); // the live head still publishes (not an all-flat feed)
    expect(series.at(-1)!.date).toBe(dispDate(59));
    expect(series.at(-1)!.date).not.toBe(legs[legs.length - 1]!.date); // the frozen tail is gone
    for (const r of series) expect(r.level).not.toBe(0); // no forced-0 (fabricated) day survives
    // The live path reads the LATEST aligned close, which carries no information ⇒ no reading.
    expect(() => scoreDispersion(DISP, legs, legs, legs)).toThrow(
      /\[DISP\] every pair has a zero-variance leg on the latest of 71 aligned closes/,
    );
  });

  test("full series has FINITE delta20 end-to-end (backfill persists the leading window)", () => {
    // The live path persists only the LATEST reading; backfill persists the WHOLE series. The
    // first VELOCITY_WINDOW emitted readings' delta20 reads meanCorr[i-VELOCITY_WINDOW] in the
    // pre-window region — NaN in the old fill(NaN), which NOT-NULL-violates `delta20` in Postgres.
    // downRets = 40 days ⇒ 41 aligned closes ⇒ ~21 emitted readings, so the leading window (the
    // NaN-delta20 regime) IS exercised: an old-code run would emit NaN here and fail this assert.
    const series = dispersionReadingSeries(DISP, fromReturns(downRets), fromReturns(downRets), fromReturns(downRets));
    expect(series.length).toBeGreaterThan(VELOCITY_WINDOW); // must reach the pre-window baseline region
    for (const r of series) expect(Number.isFinite(r.delta20)).toBe(true);
  });

  test("persists the 20d basket return as `decision` - level/rawState/state byte-identical", () => {
    // DISP has no `derived` descriptor, so decisionAt returns null; the composite override in
    // buildReadings carries the basket instead. Identical legs ⇒ the basket collapses to the
    // single-series 20d return, computable straight off the fixture prices.
    const prices = fromReturns(downRets);
    const series = dispersionReadingSeries(DISP, prices, prices, prices);
    expect(series.length).toBeGreaterThan(0);
    series.forEach((r, k) => {
      const i = k + VELOCITY_WINDOW; // buildReadings' baseOffset for DISP
      const expected = prices[i]!.value / prices[i - VELOCITY_WINDOW]!.value - 1;
      expect(r.decision).not.toBeNull();
      expect(r.decision!).toBeCloseTo(expected, 12);
    });
    // The pre-change contract: this fixture is the perfectly-correlated falling basket, so
    // level = 1 and the fold still ends RED — adding a column changed neither.
    const last = series[series.length - 1]!;
    expect(last.level).toBeCloseTo(1);
    expect(last.rawState).toBe("RED");
    expect(last.state).toBe("RED");
  });

  test("redesign 2026-07-22: corr is a single STRICT confirm gate, basket DEPTH splits RED/AMBER", () => {
    // Confirm gate ON (corr > 0.75) → basket depth decides the tier.
    expect(dispersionState(0.8, DISP_BASKET_RED - 1e-9)).toBe("RED"); // just past the depth cut → RED
    expect(dispersionState(0.8, DISP_BASKET_RED)).toBe("AMBER"); // AT −2.5% (not < ) → AMBER (boundary)
    expect(dispersionState(0.8, -0.01)).toBe("AMBER"); // shallow (−2.5%..0) + corr confirm → AMBER
    // Confirm gate OFF — corr ≤ 0.75 → GREEN at ANY basket depth (correlation only confirms).
    expect(dispersionState(DISP_CORR, -0.03)).toBe("GREEN"); // EXACTLY 0.75 → strict `>` fails → GREEN
    // Negative-basket gate: a non-negative basket is never danger however high corr runs.
    expect(dispersionState(0.99, -1e-9)).toBe("AMBER"); // just below 0 with corr on → AMBER
    expect(dispersionState(0.99, 0)).toBe("GREEN"); // flat basket (not < 0) → GREEN
    // Ordering invariant: the RED depth cut is a negative fraction below the AMBER floor of 0.
    expect(DISP_BASKET_RED).toBeLessThan(0);
  });

  test("B2 deepener 2026-09-08: corr AT/ABOVE its rolling p90 lifts AMBER to RED, and only AMBER", () => {
    const shallow = -0.01; // basket in [DISP_BASKET_RED, 0) ⇒ base tier AMBER
    expect(dispersionState(0.8, shallow, DISP_CORR, 0.8)).toBe("RED"); // AT the cut (inclusive `>=`)
    expect(dispersionState(0.8, shallow, DISP_CORR, 0.81)).toBe("AMBER"); // below the cut ⇒ base tier
    expect(dispersionState(0.9, shallow, DISP_CORR, 0.8)).toBe("RED"); // above the cut
    // The DISP_CORR gate OUTRANKS the deepener: at/below the gate the day is GREEN however high the
    // percentile rank runs — a p90 cut of 0 makes every finite corr "at or above" it.
    expect(dispersionState(DISP_CORR, shallow, DISP_CORR, 0)).toBe("GREEN"); // AT the gate ⇒ strict `>` fails
    expect(dispersionState(0.5, shallow, DISP_CORR, 0)).toBe("GREEN");
    // The negative-basket gate likewise outranks it.
    expect(dispersionState(0.99, 0, DISP_CORR, 0)).toBe("GREEN");
    // Already-RED (depth) days are untouched, and a WARM-UP (NaN cut) is a NO-OP, never a spurious RED.
    expect(dispersionState(0.99, DISP_BASKET_RED - 1e-9, DISP_CORR, NaN)).toBe("RED");
    expect(dispersionState(0.99, shallow, DISP_CORR, NaN)).toBe("AMBER");
    expect(dispersionState(0.99, shallow)).toBe("AMBER"); // caller holding no cut ⇒ today's behaviour
    expect([DISP_CORR_P, DISP_CORR_P_WINDOW, DISP_CORR_P_MIN_OBS].every(Number.isFinite)).toBe(true);
  });

  test("B2: the p90 distribution is INFORMATIVE-MASKED - a degenerate day's forced 0 is not an observation", () => {
    // Identical legs with VARYING returns ⇒ every informative day's corr is exactly 1, so the p90 is
    // 1 and EVERY day deepens the moment the cut goes finite: the first RED dates the warm-up exactly.
    const d = utcDay(2000, 0, 3);
    const leg: Observation[] = [];
    let v = 100;
    for (let i = 0; i < DISP_CORR_P_MIN_OBS + 60; i++) {
      leg.push({ date: d(i), value: v });
      v *= 1 + (i % 2 === 0 ? -0.0008 : -0.0002); // 20d basket stays in [DISP_BASKET_RED, 0) ⇒ base AMBER
    }
    const series = dispersionReadingSeries(DISP, leg, leg, leg);
    for (const r of series) {
      expect(r.level).toBe(1); // every EMITTED day is informative
      expect(r.decision as number).toBeLessThan(0);
      expect(r.decision as number).toBeGreaterThanOrEqual(DISP_BASKET_RED);
    }
    // meanCorr indices 0 and 1 are structurally non-informative (index 0 is never written; index 1's
    // corr window is the single return [0,0] ⇒ zero variance ⇒ degenerate), so they are forced to 0.
    const NON_INFORMATIVE_HEAD = 2;
    // MASKED, those two 0s are skipped and the cut goes finite at meanCorr index MIN_OBS + 2;
    // UNMASKED they would count as observations and fire it two days EARLY. Readings start at
    // VELOCITY_WINDOW, so this index is the discriminator between the two implementations.
    const firstRed = series.findIndex((r) => r.rawState === "RED");
    expect(firstRed).toBe(DISP_CORR_P_MIN_OBS + NON_INFORMATIVE_HEAD - VELOCITY_WINDOW);
    // Warm-up is a NO-OP deepener (AMBER, never RED) and every settled day deepens.
    expect(series.slice(0, firstRed).every((r) => r.rawState === "AMBER")).toBe(true);
    expect(series.slice(firstRed).every((r) => r.rawState === "RED")).toBe(true);
  });

  test("a NON-FINITE basket OR corr scores GREEN, never RED (BOTH gates stay fail-SAFE)", () => {
    // Regression pin. Both gates use the NaN-safe `!(x < y)` idiom: `!(basketReturn < 0)` and
    // `!(meanCorr > corrCut)`. Rewriting EITHER as the positive form (`basketReturn >= 0` /
    // `meanCorr <= corrCut`) makes the guard FALSE for NaN, control falls through, and a NaN
    // reaches RED — a false push on the live notify path. `alignByDates` filters only on
    // `undefined`, not `Number.isFinite`, so 0/0 can reach either input. Red the moment either
    // gate is "simplified" back.
    for (const corr of [DISP_CORR, 0.8, 0.99, Infinity]) {
      expect(dispersionState(corr, NaN), `corr=${corr}`).toBe("GREEN"); // NaN basket → GREEN
    }
    // A NaN CORR is likewise never danger, however deep the basket (`!(NaN > cut)` is true).
    expect(dispersionState(NaN, -0.03)).toBe("GREEN");
    expect(dispersionState(NaN, -0.01)).toBe("GREEN");
  });

  test("redesign 2026-07-22: RED re-tiered (corr 0.7→0.75 + basket −2.5% gate) over the committed SPY·FEZ·EEM fixtures", () => {
    // The redesign REVERSES the W3 "RED must not move" ruling: correlation became a single STRICT
    // > 0.75 confirm gate and basket DEPTH now splits the tiers, so RED deliberately SHRINKS (a
    // shallow, broad dip drops to AMBER, and corr in (0.7, 0.75] no longer fires). This drives the
    // committed fixtures — seeded synthetic series (`synth-fixtures.ts`); real market data is not
    // distributed with this repository — through the real scorer and pins the predicate mechanics.
    // 2019–22: clears the rolling p90's 756-row window (O(days × 756)); no exact counts.
    const [WINDOW_START, WINDOW_END] = ["2019-01-01", "2022-12-31"];
    const load = (n: string): Observation[] =>
      readFileSync(`scripts/backtest/data/${n}.csv`, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => {
          const [date, v] = l.split(",");
          return { date: date!, value: Number(v) };
        })
        .filter((o) => Number.isFinite(o.value) && o.date >= WINDOW_START && o.date <= WINDOW_END);
    const [spy, fez, eem] = [load("spy"), load("fez"), load("eem")];
    const now = dispersionReadingSeries(DISP, spy, fez, eem);

    expect(now.length).toBeGreaterThan(DISP_CORR_P_WINDOW + 150); // ≥ 150 rows in the full rolling-window regime
    // The two rows tightest against the RED depth cut, straddling it — the deepest AMBER and
    // shallowest RED — re-scored through the live predicate.
    const deepestAmber = now
      .filter((r) => r.rawState === "AMBER")
      .reduce((a, b) => ((a.decision as number) <= (b.decision as number) ? a : b));
    // The RED side splits since B2 (2026-09-08): the DEPTH tier (basket strictly below the cut) and
    // the DEEPENED subset (shallow basket lifted by corr ≥ its own rolling p90). Pin both.
    const depthReds = now.filter((r) => r.rawState === "RED" && (r.decision as number) < DISP_BASKET_RED);
    const deepened = now.filter((r) => r.rawState === "RED" && !((r.decision as number) < DISP_BASKET_RED));
    const shallowestRed = depthReds.reduce((a, b) => ((a.decision as number) >= (b.decision as number) ? a : b));
    expect(deepestAmber.decision as number).toBeGreaterThanOrEqual(DISP_BASKET_RED); // AMBER: shallow side
    expect(shallowestRed.decision as number).toBeLessThan(DISP_BASKET_RED); // RED: strictly below the cut
    for (const r of [deepestAmber, shallowestRed]) {
      expect(dispersionState(r.level, r.decision as number)).toBe(r.rawState); // re-score agrees
      expect(r.level).toBeGreaterThan(DISP_CORR); // STRICT confirm gate
    }
    // The deepener is genuinely live on the fixtures, and it is the ONLY thing lifting these rows:
    // each re-scores to AMBER when no p90 is passed (default NaN ⇒ no-op) and to RED at its own cut.
    expect(deepened.length).toBeGreaterThan(0);
    for (const r of deepened) {
      expect(r.level).toBeGreaterThan(DISP_CORR); // the gate still outranks the deepener
      expect(dispersionState(r.level, r.decision as number)).toBe("AMBER"); // no cut held ⇒ base tier
      expect(dispersionState(r.level, r.decision as number, DISP_CORR, r.level)).toBe("RED"); // at its cut ⇒ deepened
    }
    // RED fires (`shallowestRed` above throws on an empty RED set), and GREEN still dominates (the
    // predicate is not stuck on).
    expect(now.filter((r) => r.rawState === "GREEN").length).toBeGreaterThan(now.length / 2);
  });

});

describe("ecyReadingSeries / scoreEcy (E3 - excess CAPE yield × GT trend gate, 2026-08-11)", () => {
  // Monthly `YYYY-MM-01` grid; DFII10 flat 0 so ECY = 1/CAPE — CAPE fixtures encode ECY directly.
  const ecyMonth = (i: number): string =>
    `${1990 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
  const addDays = (iso: string, n: number): string =>
    new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
  // Base alternates 0.04/0.06; the LAST month carries `tailEcy`. Default months = ECY_MIN_OBS + 1,
  // the minimum that gives the tail a full strict-prefix rank.
  const ECY_FIXTURE_MONTHS = ECY_MIN_OBS + 1;
  const ecyFixture = (tailEcy: number, months: number = ECY_FIXTURE_MONTHS) => {
    const vals = Array.from({ length: months }, (_, i) =>
      i === months - 1 ? tailEcy : i % 2 === 0 ? 0.04 : 0.06,
    );
    const f7: Observation[] = vals.map((v, i) => ({ date: ecyMonth(i), value: 1 / v }));
    const dfii10: Observation[] = vals.map((_, i) => ({ date: ecyMonth(i), value: 0 }));
    return { f7, dfii10, now: addDays(ecyMonth(months - 1), 4) };
  };
  const expensive = ecyFixture(0.005);
  const cheap = ecyFixture(0.1);

  test("fixture premise: the expensive tail ranks at/below ECY_EXPENSIVE_P, the cheap tail above", () => {
    // Guards every gate test below — if a retuned cut strands the fixtures on one side, red HERE.
    expect(ECY_EXPENSIVE_P).toBeGreaterThan(0); // a 0 cut makes the inclusive ≤ edge unreachable
    expect(ECY_EXPENSIVE_P).toBeLessThan(1);
    const expTail = ecyReadingSeries(ECY, expensive.f7, expensive.dfii10).at(-1)!;
    expect(expTail.decision as number).toBeLessThanOrEqual(ECY_EXPENSIVE_P);
    expect(expTail.level).toBeCloseTo(0.005 * 100); // level = the month's ECY in PERCENT, not the rank
    expect(expTail.state).toBe("AMBER"); // gate-less base — GT applies only at the live tail
    const cheapTail = ecyReadingSeries(ECY, cheap.f7, cheap.dfii10).at(-1)!;
    expect(cheapTail.decision as number).toBeGreaterThan(ECY_EXPENSIVE_P);
    expect(cheapTail.state).toBe("GREEN");
  });

  test("ecyEstimateDates: the open (newest) month always; a closed month only while its LAST DFII10 obs is `estimated`", () => {
    const months = ECY_FIXTURE_MONTHS + 1;
    const { f7, dfii10 } = ecyFixture(0.1, months);
    const [prev, last] = [ecyMonth(months - 2), ecyMonth(months - 1)];
    const withHead = [...dfii10, { date: addDays(last, 1), value: 0, estimated: true as const }];
    const series = ecyReadingSeries(ECY, f7, withHead);
    expect(series.at(-2)?.date).toBe(prev); // premise: `prev` is a scored closed month
    expect(ecyEstimateDates(series, withHead)).toEqual([last]);
    // An official obs after the head leaves the open month estimated anyway (a graft-failure run never lands it FINAL).
    expect(ecyEstimateDates(series, [...withHead, { date: addDays(last, 2), value: 0 }])).toEqual([last]);
    // A closed month whose last obs is still a head stays estimated until that obs prints.
    const prevHead = [...withHead, { date: addDays(prev, 20), value: 0, estimated: true as const }];
    expect(ecyEstimateDates(ecyReadingSeries(ECY, f7, prevHead), prevHead)).toEqual([prev, last]);
  });

  test("ecyRows month-start parity: a closed month the cron holds `estimated` (Treasury head) the FRED-only restate never writes FINAL", () => {
    const months = ECY_FIXTURE_MONTHS + 1;
    const { f7, dfii10 } = ecyFixture(0.1, months);
    const [prev, last] = [ecyMonth(months - 2), ecyMonth(months - 1)];
    // FRED stops short of `prev`'s last session; the cron grafts it + the open month's first session as heads (T+0).
    const fred = [...dfii10.filter((o) => o.date < last), { date: addDays(prev, 20), value: 0 }];
    const cronDfii = [...fred, { date: addDays(prev, 27), value: 0, estimated: true as const }, { date: addDays(last, 1), value: 0, estimated: true as const }];
    const cron = ecyRows(ECY, f7, cronDfii);
    const restate = ecyRows(ECY, f7, fred);
    expect(cron.estimateDates).toContain(prev); // premise: the cron holds the closed month estimated
    expect(restate.series.map((r) => r.date)).toContain(prev); // premise: the restate writes it
    // FRED prints in date order, so a month missing its last session is the restate's NEWEST row → estimated.
    const written = new Set(restate.series.map((r) => r.date));
    expect(cron.estimateDates.filter((d) => written.has(d) && !restate.estimateDates.includes(d))).toEqual([]);
  });

  test("expensive + GT GREEN → AMBER, never RED (trend intact caps the grade)", () => {
    expect(scoreEcy(ECY, expensive.f7, expensive.dfii10, "GREEN", expensive.now)?.state).toBe("AMBER");
  });

  test("expensive + GT AMBER → RED; expensive + GT RED → RED (trend broken)", () => {
    expect(scoreEcy(ECY, expensive.f7, expensive.dfii10, "AMBER", expensive.now)?.state).toBe("RED");
    expect(scoreEcy(ECY, expensive.f7, expensive.dfii10, "RED", expensive.now)?.state).toBe("RED");
  });

  test("cheap + GT RED → GREEN (ruled O3 - trend-alone is GT's own card)", () => {
    expect(scoreEcy(ECY, cheap.f7, cheap.dfii10, "RED", cheap.now)?.state).toBe("GREEN");
  });

  test("expensive + GT non-live (null) → null, never a fabricated RED", () => {
    expect(scoreEcy(ECY, expensive.f7, expensive.dfii10, null, expensive.now)).toBeNull();
  });

  test("under the ECY_MIN_OBS strict-prefix floor: series empty AND scoreEcy null (no false GREEN)", () => {
    const short = ecyFixture(0.1, ECY_MIN_OBS); // tail's prefix = ECY_MIN_OBS − 1 → no reading
    expect(ecyReadingSeries(ECY, short.f7, short.dfii10)).toEqual([]);
    expect(scoreEcy(ECY, short.f7, short.dfii10, "GREEN", short.now)).toBeNull();
  });

  test("stale F7 (newest point older than ECY_MAX_STALE_DAYS vs now) → null", () => {
    const staleNow = addDays(ecyMonth(ECY_FIXTURE_MONTHS - 1), ECY_MAX_STALE_DAYS + 1);
    expect(scoreEcy(ECY, expensive.f7, expensive.dfii10, "GREEN", staleNow)).toBeNull();
  });

  test("ecyExpensiveCutSeries: the drawn line IS the ribbon's boundary on every month (AMBER ⇔ level < cut)", () => {
    // A varied 200-month history WITH TIES (values on a coarse grid repeat), so the ≤-inclusive rank
    // and the strict-below boundary are exercised where they could split; DFII10 flat 0.
    const months = ECY_MIN_OBS + 80;
    const vals = Array.from({ length: months }, (_, i) => 0.005 + 0.001 * ((i * 37) % 53));
    const f7: Observation[] = vals.map((v, i) => ({ date: ecyMonth(i), value: 1 / v }));
    const dfii10: Observation[] = vals.map((_, i) => ({ date: ecyMonth(i), value: 0 }));
    const readings = ecyReadingSeries(ECY, f7, dfii10);
    const cuts = ecyExpensiveCutSeries(f7, dfii10);
    expect(cuts.map((c) => c.date)).toEqual(readings.map((r) => r.date)); // one cut per scored month
    expect(readings.length).toBe(80);
    let ambers = 0;
    readings.forEach((r, i) => {
      const cut = cuts[i]!.cut;
      expect(Number.isFinite(cut)).toBe(true);
      expect(r.state).toBe(r.level < cut ? "AMBER" : "GREEN");
      if (r.state === "AMBER") ambers++;
    });
    expect(ambers).toBeGreaterThan(0); // the fixture actually crosses the line, so the ⇔ is not vacuous
  });

  test("ecyExpensiveCut: a value EQUAL to the cut ranks GREEN, one just below ranks AMBER (the ≤ rank's edge)", () => {
    // Prefix = 0.01 … (ECY_MIN_OBS + 49) × 0.01; p = 2% of 150 = exactly 3 values may sit ≤ x.
    const prefix = Array.from({ length: 150 }, (_, i) => 0.01 * (i + 1));
    const cut = ecyExpensiveCut(prefix);
    expect(cut).toBeCloseTo(0.04, 12); // sorted[3]: 3 values (0.01/0.02/0.03) strictly below it
    // Not the interpolated type-7 quantile (which lands between order statistics, off the boundary).
    expect(cut).not.toBeCloseTo(quantile(prefix, ECY_EXPENSIVE_P), 12);
    const state = (x: number) => ecyReadingSeries(ECY, [...prefix, x].map((v, i) => ({ date: ecyMonth(i), value: 1 / v })), [...prefix, x].map((_, i) => ({ date: ecyMonth(i), value: 0 }))).at(-1)!.state;
    expect(state(cut)).toBe("GREEN"); // 4 values ≤ x → 4/150 > 2%
    expect(state(cut - 1e-9)).toBe("AMBER"); // 3 values ≤ x → 3/150 ≤ 2%
  });

  test("scoreEcy stamps bandCuts[ecyAmber] = the drawn cut tail (Slice 3.1; drawn `* 100` units)", () => {
    const amberKey = CHART_DESCRIPTOR_OF["ECY"]!.bandCuts!.find((c) => c.level === "amber")!.key;
    expect(amberKey).toBe("ecyAmber"); // resolved from the descriptor, never a literal in the scorer
    for (const fx of [expensive, cheap]) {
      const scored = scoreEcy(ECY, fx.f7, fx.dfii10, "GREEN", fx.now)!;
      const expected = ecyExpensiveCutSeries(fx.f7, fx.dfii10).at(-1)!.cut; // %-scale drawn line
      expect(Number.isFinite(expected)).toBe(true); // non-vacuous: a real finite cut
      expect(scored.bandCuts?.[amberKey]).toBe(expected);
    }
  });

  test("two DFII10 obs in the final month: the LAST of the month is joined, not the first", () => {
    // The early obs (−20 → ECY += 0.20, deep cheap) must LOSE to the later flat-0 close.
    const lastMonth = ecyMonth(ECY_FIXTURE_MONTHS - 1);
    const dfii10: Observation[] = [
      ...expensive.dfii10.slice(0, -1),
      { date: addDays(lastMonth, 1), value: -20 },
      { date: addDays(lastMonth, 15), value: 0 },
    ];
    const tail = ecyReadingSeries(ECY, expensive.f7, dfii10).at(-1)!;
    expect(tail.decision as number).toBeLessThanOrEqual(ECY_EXPENSIVE_P); // expensive — the −20 obs was ignored
  });
});


// --- HCX + FDX chart-only AVGO idiosyncratic legs (Stage 1) --------------------------------------
describe("scoreHcx (HCX hyperscaler capex basket ÷ SPY - CHART-ONLY, breadth-LOW band)", () => {
  // All four constituents share ONE noisy-but-climbing path (so alignByDates inner-joins every day
  // and the equal-weight return chain reduces to that path); SPY is flat, so basket÷SPY == basket.
  // The LOW ladder then fires on the basket's OWN distance-from-12mo-high, mirror of F5/SPCONC.
  const spyFlat = breadthClimb(0.002).qqqe; // flat 1s, BN long, same dates as the climb
  const basketOf = (tailReturn: number) => {
    const { qqq } = breadthClimb(tailReturn);
    return { GOOGL: qqq, META: qqq, MSFT: qqq, AMZN: qqq };
  };
  // Cuts on the LOW percentile pair (0.15 / 0.02) over the strict-prior dist — stable vs the tail.
  let lowCutsMemo: { aCut: number; rCut: number } | undefined;
  const lowCuts = () => {
    if (lowCutsMemo) return lowCutsMemo;
    const basket = hcxBasketSeries(basketOf(0.002));
    const dist = breadthDistSeries(basket.map((o) => o.value));
    lowCutsMemo = {
      // HCX's OWN window — the module defaults are F5's since the 2026-08-30 split.
      aCut: breadthCutSeries(dist, HCX_BAND.amberP, HCX_BAND.cutWindow, HCX_BAND.minObs).at(-1)!,
      rCut: breadthCutSeries(dist, HCX_BAND.redP, HCX_BAND.cutWindow, HCX_BAND.minObs).at(-1)!,
    };
    return lowCutsMemo;
  };

  test("fixture premise: the LOW band exists (0 < p02 < p15) so the three tails discriminate", () => {
    const { aCut, rCut } = lowCuts();
    expect(rCut).toBeGreaterThan(0); // the climb's dist is all positive daily returns
    expect(aCut).toBeGreaterThan(rCut); // p15 > p02
  });

  test("last-day dist far below the p02 cut → RED (deep below its own 12-mo high)", () => {
    // A negative last-day return sits below any positive low-tail cut.
    expect(scoreHcx(HCX, basketOf(-0.05), spyFlat).state).toBe("RED");
  });

  test("last-day dist between p02 and p15 → AMBER (rawState; the fold holds sawtooth history)", () => {
    const { aCut, rCut } = lowCuts();
    expect(scoreHcx(HCX, basketOf((aCut + rCut) / 2), spyFlat).rawState).toBe("AMBER");
  });

  test("last-day dist above the p15 cut → GREEN (a fresh new high is not the risk under LOW)", () => {
    const { aCut } = lowCuts();
    expect(scoreHcx(HCX, basketOf(aCut * 2), spyFlat).rawState).toBe("GREEN");
  });
});

describe("hcxBasketSeries (equal-weight daily-rebalanced return chain, inner-joined)", () => {
  const obs = (pairs: [string, number][]): Observation[] => pairs.map(([date, value]) => ({ date, value }));

  test("I_0 = 1 and each day compounds the equal-weight mean return", () => {
    // Two constituents; the other two mirror one of them so the mean is well-defined and checkable.
    const a = obs([["d0", 100], ["d1", 110], ["d2", 121]]); // +10%, +10%
    const b = obs([["d0", 50], ["d1", 55], ["d2", 60.5]]); // +10%, +10%
    const basket = hcxBasketSeries({ GOOGL: a, META: b, MSFT: a, AMZN: b });
    expect(basket.map((o) => o.value)).toEqual([1, 1.1, 1.1 * 1.1]);
  });

  test("MISSING-CLOSE rule: a day absent from ANY one symbol is dropped from the basket entirely", () => {
    // META holes d1 → the inner-join drops d1 for EVERY constituent; no forward-fill, no 3-name day.
    const full = obs([["d0", 100], ["d1", 101], ["d2", 102]]);
    const holed = obs([["d0", 100], ["d2", 102]]); // d1 missing
    const basket = hcxBasketSeries({ GOOGL: full, META: holed, MSFT: full, AMZN: full });
    expect(basket.map((o) => o.date)).toEqual(["d0", "d2"]); // d1 gone, not filled
    expect(basket).toHaveLength(2);
  });

  // --- Why HCX_FETCH_OPTS exists (2026-08-29, off a reported chart cliff) ------------------
  //
  // The chain is WINDOW-RELATIVE: `I_0 = 1` lands on the first aligned day of whatever closes the
  // caller fetched, so the SAME date carries a different level under a different fetch window. The
  // persisted `value` therefore has no meaning independent of its window — and `api/series.ts`
  // re-derives the plotted distance-from-high ACROSS stored rows, so two windows meeting inside one
  // 12-mo span print a cliff (prod 2026-08-21 → 2026-08-24: dist −0.116 → −0.960, the cron's shallow
  // `range=2y` rows meeting the backfill's deep ones).
  test("the SAME date carries a different level under a shorter fetch window", () => {
    const long = obs([["d0", 100], ["d1", 120], ["d2", 132], ["d3", 145.2]]);
    const short = obs([["d2", 132], ["d3", 145.2]]); // same closes, window starts two days later
    const four = (o: Observation[]) => ({ GOOGL: o, META: o, MSFT: o, AMZN: o });
    const deep = hcxBasketSeries(four(long));
    const shallow = hcxBasketSeries(four(short));
    const at = (b: Observation[], d: string) => b.find((o) => o.date === d)!.value;
    // d3's level differs by exactly the compounding the shorter window never saw (100 → 132).
    expect(at(deep, "d3")).toBeCloseTo(1.452, 10);
    expect(at(shallow, "d3")).toBeCloseTo(1.1, 10);
    expect(at(deep, "d3") / at(shallow, "d3")).toBeCloseTo(1.32, 10);
    // The rescale is a CONSTANT factor over the overlap — which is why a single-window series is
    // internally sound and a MIXED-window one is not. Deleting HCX_FETCH_OPTS' invariant means
    // making this untrue (persisting a scale-free level instead), not ignoring it.
    expect(at(deep, "d2") / at(shallow, "d2")).toBeCloseTo(1.32, 10);
  });

  test("both HCX call sites fetch through HCX_FETCH_OPTS, never the shallow default", () => {
    // The backfill half is pinned behaviourally in scripts/backfill.policy.test.ts ("HCX's feed depth is
    // plan-independent"); run-cycle-feeds.ts's GLOBAL_FEEDS row calls `fetchDailyCloses` directly, so its
    // depth is only observable in the source.
    const src = readFileSync(new URL("./run-cycle-feeds.ts", import.meta.url), "utf8");
    expect(src).toContain("symbols.map((sym) => fetchDailyCloses(sym, { ...HCX_FETCH_OPTS, now: priceClock, env: ctx.env }))");
    expect(src).toContain('fetchDailyCloses("SPY", { ...HCX_FETCH_OPTS, now: priceClock, env: ctx.env })');
    // Non-vacuity: the shallow default form still exists elsewhere in the file (the GT ACWI row;
    // the breadth shallow arm moved to run-dbfirst.ts), so the two assertions above are a real
    // distinction rather than a grep for a string nothing competes with.
    expect(src).toContain('const acwi = await fetchDailyCloses("ACWI", { now: priceClock, env: ctx.env });');
  });
});

describe("spliceChainedIndex (chained-index base-break repair for the read path)", () => {
  const N = 320;
  // A gently rising, wiggly chained index — long enough for breadthDistSeries' 252d prior window.
  const clean = Array.from({ length: N }, (_, i) => 1 + 0.002 * i + 0.05 * Math.sin(i / 11));

  test("a single-base (clean) series splices to itself with no breaks", () => {
    // maxRatio is the largest consecutive factor of the clean wiggle — under the quiet bound, so a
    // healthy payload never emits the field. Derived from the fixture, never a restated literal.
    const maxRatio = Math.max(...clean.slice(1).map((v, i) => Math.max(v / clean[i]!, clean[i]! / v)));
    expect(spliceChainedIndex(clean)).toEqual({ values: clean, breaks: [], maxRatio });
    expect(maxRatio).toBeLessThan(CHAIN_QUIET_RATIO);
  });

  // A sub-threshold base cliff: a step BELOW CHAIN_BREAK_RATIO is NOT a break (chainSplices stays
  // absent/0) yet still prints a real chart drop. `maxRatio` is the only surface that reveals it — the
  // whole point of I1. The step magnitude is expressed off CHAIN_BREAK_RATIO so retiring the gate can't
  // silently push the fixture across it and hollow the test.
  test("a sub-CHAIN_BREAK_RATIO base cliff yields NO break but a visible maxRatio", () => {
    const m = 200;
    const step = (CHAIN_BREAK_RATIO + CHAIN_QUIET_RATIO) / 2; // strictly inside (quiet, break): here 2.75×
    expect(step).toBeLessThan(CHAIN_BREAK_RATIO); // premise: below the splice threshold
    expect(step).toBeGreaterThan(CHAIN_QUIET_RATIO); // premise: above the quiet bound ⇒ must be visible
    const c = flatJoin(m); // a flat junction ⇒ the ONLY off-wiggle factor is the base step, exactly `step`
    const broken = c.map((v, i) => (i >= m ? v / step : v)); // a `step`× base DROP mid-window
    const { breaks, maxRatio } = spliceChainedIndex(broken);
    expect(breaks).toEqual([]); // correctly NOT spliced — the silent gap chainSplices cannot see
    expect(maxRatio).toBeCloseTo(step, 10); // the down-step folds to `step` ≥ 1 and is the largest factor
    expect(maxRatio).toBeGreaterThan(CHAIN_QUIET_RATIO); // ⇒ the read path emits maxChainRatio, so it is visible
  });

  test("breadthDistSeries is scale-invariant: a uniformly rescaled chain plots the SAME dist", () => {
    // ×8 is a power of two ⇒ each scaling is exact, so the correctly-rounded dist is bit-identical
    // (NaN heads compare equal under toEqual). This scale-invariance is WHY splicing onto any one
    // base is lossless: the constant per-segment factor cancels in every distance-from-high.
    const scaled = clean.map((v) => v * 8);
    expect(breadthDistSeries(scaled)).toEqual(breadthDistSeries(clean));
  });

  // A base break: the tail is re-anchored (`I_0 = 1` on a later fetch window) ⇒ a constant
  // multiplicative jump. ×1/16 both clears the break band AND, at the FLAT step forced at the join,
  // makes the splice restore the clean series EXACTLY (1/16 and 16 are powers of two, so no rounding).
  const flatJoin = (m: number) => {
    const c = clean.slice();
    c[m] = c[m - 1]!; // the one junction return is unrecoverable and assumed 0; a flat step makes that exact
    return c;
  };

  test("an injected base break collapses the UNSPLICED dist to the prod cliff; the splice restores it", () => {
    const m = 290;
    const c = flatJoin(m);
    const broken = c.map((v, i) => (i >= m ? v / 16 : v)); // a ~16× base drop mid-window
    const distUnspliced = breadthDistSeries(broken);
    // Prod signature (08-27→08-28): two bases inside one 12-mo window print a ~−0.94 cliff off the
    // trailing high (measured −0.9592 there; 1/16 lands −0.9375 against this fixture's flat high).
    expect(distUnspliced[m]!).toBeLessThan(-0.9);
    const { values: spliced, breaks } = spliceChainedIndex(broken);
    expect(breaks).toEqual([m]);
    expect(spliced).toEqual(c); // exact restoration (flat junction + power-of-two factor)
    // The plotted line, re-derived off the spliced series, has NO cliff — it matches the clean dist.
    expect(breadthDistSeries(spliced)).toEqual(breadthDistSeries(c));
    expect(breadthDistSeries(spliced)[m]!).toBeGreaterThan(-0.1);
  });

  test("multiple base breaks are each repaired and their indices reported", () => {
    const m1 = 120;
    const m2 = 250;
    const c = clean.slice();
    c[m1] = c[m1 - 1]!;
    c[m2] = c[m2 - 1]!;
    // base A; [m1..) ×1/16 (a down re-anchor); [m2..) ×8 on top (a second, upward re-anchor).
    const broken = c.map((v, i) => (i >= m2 ? (v / 16) * 8 : i >= m1 ? v / 16 : v));
    const { values: spliced, breaks } = spliceChainedIndex(broken);
    expect(breaks).toEqual([m1, m2]);
    expect(spliced).toEqual(c); // both tails re-anchored back onto base A, exactly
  });

  test("non-finite / non-positive values never trigger or poison a splice", () => {
    const vals = [1, 1.1, NaN, 1.2, 0, 1.3, -1, 1.25, 20, 21]; // the only real break is index 8 (20/1.25 = 16×)
    const { values: out, breaks } = spliceChainedIndex(vals);
    expect(breaks).toEqual([8]);
    // No Infinity anywhere; the poisoned inputs pass through untouched, the tail re-anchors finite.
    expect(out.every((v) => Number.isFinite(v) || Number.isNaN(v))).toBe(true);
    expect(out[2]).toBeNaN();
    expect(out[4]).toBe(0);
    expect(out[8]).toBeCloseTo(1.25, 10); // 20 re-anchored onto the last good value 1.25
    expect(out[9]).toBeCloseTo(1.3125, 10); // 21 × (1.25 / 20)
  });

  test("CHAIN_BREAK_RATIO sits in the empty gap: above any real daily move, below a base break", () => {
    // A real HCX daily step never reaches 4×; the observed base re-anchor was ~17.75×.
    expect(CHAIN_BREAK_RATIO).toBeGreaterThan(1.5);
    expect(CHAIN_BREAK_RATIO).toBeLessThan(17.75);
  });
});

describe("scoreRatioVsMa (FDX TSM/SMH foundry-dependency ratio - CHART-ONLY, two-leg LOW)", () => {
  const tsmFrom = (fn: (i: number) => number) => priceSeries(fn);
  const smhFlat = priceSeries(() => 100);

  test("a RISING ratio (TSM outrunning SMH) → GREEN (ms50 > amber, d20 > d20Amber)", () => {
    // Since the 2026-08-29 cut ruling the ms50 amber sits BELOW the MA50 crossing rather than on it,
    // so a flat ratio is no longer on the amber edge; a rising ratio is GREEN a fortiori.
    expect(scoreRatioVsMa(FDX, priceSeries((i) => 100 * Math.pow(1.001, i)), smhFlat).state).toBe("GREEN");
  });

  test("TSM falling fast AND far below its own MA50 → RED (both legs breach)", () => {
    // ~1%/day decay drives the ratio ~18% below its MA50 over the 20d window, which clears both
    // `red` and `d20Red` by a wide margin at any cut this leg has shipped — no value restated here.
    const r = scoreRatioVsMa(FDX, tsmFrom((i) => 100 * Math.pow(0.99, i)), smhFlat);
    expect(r.state).toBe("RED");
  });

  test("FDX Δ20d leg is live: velocity alone lifts to AMBER while ms50 stays above amber", () => {
    // A long steady RISE leaves the ratio well above its lagging MA50, so ms50 sits ABOVE amber and
    // the position leg cannot fire. The rise peaks retWindow sessions before the end, then ticks
    // down enough to breach d20Amber — so the ONLY leg that can lift the state off GREEN is the Δ20d
    // velocity leg. AMBER with ms50 > amber therefore isolates that OR-leg (RED is unreachable: it
    // needs ms50 <= red, which a positive ms50 cannot satisfy).
    const cfg = FDX_DESCRIPTOR.scorer.constants;
    const peak = PN - 1 - cfg.retWindow; // last rising index, exactly retWindow sessions before the end
    const vals = (i: number) =>
      i <= peak ? 100 + 2 * i : (100 + 2 * peak) * (1 - 0.0016 * (i - peak));
    const tsm = priceSeries(vals);
    // ms50 at the scored (last) index, computed against the shipped leg definition (ratio ÷ MA50 − 1).
    const ratio = tsm.map((o) => o.value / 100); // smhFlat = 100, so ratio ≡ tsm/100
    const L = PN - 1;
    const ms50 = ratio[L]! / mean(ratio, L - cfg.maWindow + 1, L) - 1;
    expect(ms50).toBeGreaterThan(cfg.amber); // position leg NOT firing
    const r = scoreRatioVsMa(FDX, tsm, smhFlat);
    expect(r.rawState).toBe("AMBER"); // AMBER with ms50 clear of amber ⇒ the Δ20d leg (d20Amber) fired alone
  });
});

// --- LOAD-BEARING band invariant: a RED HCX / RED FDX reading never moves the notify band --------
// The chart-only contract (VTP precedent): HCX/FDX ride CONTEXT identities that are off every
// roll-up AND every escalator, so a RED reading dropped into the `readings[]` array that feeds
// computeAlertBand must leave the pushed band unchanged. The load-bearing fact is the CHANNEL:
// escalatorFloor recombines GEO/RATE readings by channel — CONTEXT touches neither. Red-demo
// (working tree only): flipping HCX.channel to "GEO" (registry-composite.ts) makes the RED reading
// count toward the GEO floor and the "unmoved" assertion goes red — proving CONTEXT is load-bearing.
describe("chart-only invariant - a RED HCX and a RED FDX reading never move the notify band", () => {
  // Genuine RED readings from the real scorers (not hand-built), so the guard is not vacuous.
  const redHcx = (): Reading => {
    const { qqq } = breadthClimb(-0.05);
    const r = scoreHcx(HCX, { GOOGL: qqq, META: qqq, MSFT: qqq, AMZN: qqq }, breadthClimb(-0.05).qqqe);
    expect(r.state).toBe("RED");
    return r;
  };
  const redFdx = (): Reading => {
    const r = scoreRatioVsMa(FDX, priceSeries((i) => 100 * Math.pow(0.99, i)), priceSeries(() => 100));
    expect(r.state).toBe("RED");
    return r;
  };

  test("computeAlertBand is unmoved with vs without the RED HCX+FDX readings", () => {
    const base = {
      dial: makeDial(),
      geoFlags: 0,
      r4Phase: "equity" as R4Phase,
      recentDialBands: [] as ("OK" | "WATCH" | "WARNING" | "CRITICAL")[],
    };
    const bandWithout = computeAlertBand({ ...base, readings: [] });
    const bandWith = computeAlertBand({ ...base, readings: [redHcx(), redFdx()] });
    expect(bandWithout).toBe("OK"); // baseline: Calm dial, no floors
    expect(bandWith).toBe(bandWithout); // the RED chart-only readings left the band exactly where it was
  });
});

describe("readPathHeadRows — read/write share one head expression", () => {
  test("CG (bandCuts + ratio levelBand) burns levelBandHead; ECY (bandCuts, no ratio desc) burns 0", () => {
    expect(readPathHeadRows("CG")).toBe(levelBandHead(CG_DESCRIPTOR.levelBand)); // both descriptors ⇒ head
    expect(readPathHeadRows("ECY")).toBe(0); // bandCuts but no RATIO_DESCRIPTOR_OF row ⇒ nothing dropped on read
  });

  // The composite arm (plan 2026-08-31 §3): R6/BONOS are re-scored on read through
  // `COMPOSITE_RESTATE_OF`, so the backfill must store the head that re-score burns off.
  test("R6/BONOS (restate row, no band, no bandCuts) deepen by their own scorer base", () => {
    // Both deepen by their VELOCITY base (`moveLegBase()` / `oatLegBase(k)`): neither carries a
    // `levelBand`, so the generic band lookup would return 0 and the
    // unconditional branches in `readPathHeadRows` are what keep the read burning the σ warm-up.
    for (const [id, expected] of [
      ["R6", moveLegBase()],
      ["BONOS", oatLegBase(BONOS_DESCRIPTOR.scorer.constants)],
    ] as const) {
      expect(COMPOSITE_RESTATE_OF[id], `premise: ${id} IS re-scored on read`).toBeDefined();
      expect(readPathHeadRows(id), id).toBe(expected);
      expect(readPathHeadRows(id), id).toBeGreaterThan(0);
      // PREMISE GUARD: the stored head must cover the re-score's real burn `max(VELOCITY_WINDOW,
      // levelBandHead where a band exists, velSigma + vel)` — a velocity leg outgrowing the deepen would
      // store too few rows. Neither id has a band, so the velocity term is the whole burn.
      const { velWindow, velSigmaWindow } = (id === "R6" ? R6_DESCRIPTOR : BONOS_DESCRIPTOR).scorer.constants;
      expect(readPathHeadRows(id), `${id}: deepen must cover the velocity burn`).toBeGreaterThanOrEqual(
        Math.max(VELOCITY_WINDOW, velSigmaWindow + velWindow),
      );
    }
  });
});

// `COMPOSITE_RESTATE_OF` is the value-domain half of each composite scorer — the read-side re-score
// (api/series.ts) and the cron/backfill wrapper must be ONE computation over the same numbers, so a
// stored payload re-scored through the map reproduces the wrapper reading-for-reading.
describe("COMPOSITE_RESTATE_OF — the map row equals its wrapper on the same input", () => {
  // Each id's term is its VELOCITY base (`moveLegBase()` / `oatLegBase()`), the only warm-up either has
  // since the percentile legs were deleted; the fixture must clear the deeper of the two.
  const base = Math.max(VELOCITY_WINDOW, moveLegBase(), oatLegBase(BONOS_DESCRIPTOR.scorer.constants));
  const dates = (n: number) => Array.from({ length: n }, (_, i) => utcDay(2010)(i));
  // A wandering series with a late spike so the comparison covers GREEN and fired days alike.
  const wander = (n: number, lo: number, amp: number) =>
    Array.from({ length: n }, (_, i) => (i >= n - 6 ? lo + 4 * amp : lo + amp * Math.sin(i / 13)));

  test("R6: map(values, dates) ≡ moveReadingSeries(observations)", () => {
    const n = base + 80;
    const ds = dates(n);
    const values = wander(n, 70, 8);
    const viaMap = COMPOSITE_RESTATE_OF.R6!(R6, values, ds);
    const viaWrapper = moveReadingSeries(R6, ds.map((date, i) => ({ date, value: values[i]! })));
    expect(viaMap.length).toBeGreaterThan(0); // vacuity floor: the fixture clears the head
    expect(viaMap).toEqual(viaWrapper);
    expect(new Set(viaMap.map((r) => r.rawState)).size).toBeGreaterThan(1); // the spike actually fires
  });

  // The wrapper takes PCT-POINT yields and converts the spread to bp ONCE; the map takes the bp spread the store
  // holds. Feeding the wrapper `leg = de10y + spread/100` makes the two inputs one series, so equality proves the
  // map applies no conversion of its own. BONOS wanders around the AMBER cut by the pair's width — derived from
  // the registry pair so the fixture crosses all three level states (never a bp literal).
  test.each([
    {
      id: "BONOS", ind: BONOS, k: BONOS_DESCRIPTOR.scorer.constants, wrapper: bonosSpreadReadingSeries,
      lo: BONOS.thresholds.amberLevel!, amp: BONOS.thresholds.redLevel! - BONOS.thresholds.amberLevel!,
    },
  ] as const)("$id: map(bp values, dates) ≡ the spread wrapper(leg, de10y) — no second ×100", ({ id, ind, k, wrapper, lo, amp }) => {
    const n = Math.max(base, oatLegBase(k)) + 80;
    const ds = dates(n);
    const spreadBp = wander(n, lo, amp);
    const de10y = ds.map((date, i) => ({ date, value: 2 + 0.3 * Math.sin(i / 17) }));
    const leg = de10y.map((o, i) => ({ date: o.date, value: o.value + spreadBp[i]! / 100 }));
    const viaWrapper = wrapper(ind, leg, de10y);
    // The stored column is rebuilt by the wrapper's own expression, never by `spreadBp` (`(a+b/100−a)·100` ≠ `b` bit-for-bit).
    const storedBp = ds.map((_, i) => (leg[i]!.value - de10y[i]!.value) * 100);
    const head = n - viaWrapper.length;
    expect(viaWrapper.map((r) => r.level)).toEqual(storedBp.slice(head)); // `readings.value` IS bp
    expect(Math.abs(viaWrapper[0]!.level - spreadBp[head]!)).toBeLessThan(1e-9); // bp, never ÷100
    const viaMap = COMPOSITE_RESTATE_OF[id]!(ind, storedBp, ds);
    expect(viaMap.length).toBeGreaterThan(0);
    expect(viaMap).toEqual(viaWrapper);
    expect(new Set(viaMap.map((r) => r.rawState)).size).toBeGreaterThan(1);
  });
});

// R6's percentile LEVEL legs are both GONE — detrended L1 (deleted 2026-08-31) and raw-level N1
// (deleted 2026-09-02, `[USER]` ruling off a live prod complaint: on the deep ^MOVE feed the
// trailing-252 p75/p90 pair measured 77.1/82.5 against a MOVE of 77.9, so prod sat AMBER in a regime
// the MOVE-native map calls calm, with the would-be RED 47 points under R6's own absolute red).
// These tests pin the POST-DELETION behaviour: R6 is velocity ∨ absolute, and neither percentile leg
// can come back unnoticed.
describe("R6 level legs — both percentile bands are deleted (velocity ∨ absolute only)", () => {
  const N = moveLegBase() + 80;
  const ds = Array.from({ length: N }, (_, i) => utcDay(2010)(i));
  const obs = (vals: number[]) => ds.map((date, i) => ({ date, value: vals[i]! }));

  test("R6 carries NO levelBand — neither percentile leg can return silently", () => {
    // The deletion's permanent guard, and the one assertion that fails the moment a band is re-added
    // in ANY kind (detrended or raw). A `[USER]` ruling can of course change it — but not silently.
    expect("levelBand" in R6_DESCRIPTOR).toBe(false);
    // …and the wiring that only existed to carry it is gone too, or a re-add would half-ship.
    expect(POINT_BAND_CUTS_OF.R6).toBeUndefined();
    expect(COMPOSITE_LEVEL_BAND_OF.R6).toBeUndefined();
  });

  test("a MOVE at the TOP of its own calm 252-window stays GREEN — the N1 false-positive, removed", () => {
    // THE regression this deletion answers, in miniature. A MOVE oscillating in the high 60s/low 70s
    // that drifts gently up to 78 over its last week: 78 is the max of its own trailing 252 closes,
    // but it is CALM (52 points under the absolute red, 27 under the absolute amber) and it got there
    // slowly. Both live legs say GREEN — the level is under 105, the drift is nowhere near the z bounds.
    const vals = Array.from({ length: N }, (_, i) => (i >= N - 6 ? 76 + 0.4 * (i - (N - 6)) : 68 + 8 * Math.sin(i / 7)));
    const last = moveReadingSeries(R6, obs(vals)).at(-1)!;
    expect(last.level).toBe(Math.max(...vals.slice(-252))); // premise: it really IS the window top
    expect(last.level).toBeLessThan(R6.thresholds.amberLevel!); // …and really IS calm
    expect(last.rawState).toBe("GREEN");

    // DISCRIMINATING: the deleted N1 leg scored this exact day RED. Its band is inlined because it is
    // a RETIRED shape with no live touch point left (the same licence `scripts/probe-r6-restate-delta.ts`
    // takes) — and without this half the assertion above would pass just as well on a fixture N1 never
    // fired on, i.e. it would pin nothing about the deletion.
    const retiredN1 = { kind: "rolling-percentile", window: 252, minObs: 252, amberP: 0.75, redP: 0.9 } as const;
    const lv = levelBandValues(vals, retiredN1);
    const amber = levelBandCuts(lv, retiredN1, retiredN1.amberP);
    const red = levelBandCuts(lv, retiredN1, retiredN1.redP);
    const i = vals.length - 1;
    expect(red[i]!).toBeLessThan(last.level); // the p90 cut sits BELOW a calm MOVE — the whole defect
    expect(percentileLevelState("R6", lv[i]!, amber[i]!, red[i]!, "HIGH")).toBe("RED");
  });

  test("a calm below-trend MOVE stays GREEN — the L1 false-positive the deletion removes", () => {
    // With both level bands gone no leg can fire on a calm decline (90→50): it stays under 105
    // (absolute GREEN) and declines gently (velocity GREEN).
    // This is the family of the 2026-08-30 below-trend MOVE the old shallow-fetch bug reddened.
    const vals = Array.from({ length: N }, (_, i) => 90 - 40 * (i / (N - 1)));
    const last = moveReadingSeries(R6, obs(vals)).at(-1)!;
    expect(last.rawState).toBe("GREEN");
  });
});

// One collecting table for the shared `latest()` min-history guard: each scorer names its id and floor.
describe("min-history guard: a short feed throws `[ID] need N`", () => {
  const short = (n: number): Observation[] =>
    Array.from({ length: n }, (_, i) => ({ date: utcDay(2024)(i), value: 100 + Math.sin(i / 3) }));
  const cgNeed = Math.max(levelBandHead(CG_DESCRIPTOR.levelBand), VELOCITY_WINDOW) + CONFIRM_CLOSES;
  const r7Need = VELOCITY_WINDOW + BULL_MIN_OBS + CONFIRM_CLOSES;
  const eurgbpNeed =
    Math.max(EURGBP.derived?.window ?? 0, returnOrMaConfig(EURGBP.id).maWindow - 1) + 1 + CONFIRM_CLOSES;
  const breadthShort = breadthClimb(0.002, BREADTH_MIN_CLOSES - 1);
  test.each([
    { id: "G1", run: () => scoreOil(G1, short(10)), want: /\[G1\] need 22 observations/ },
    { id: "CG", run: () => scoreRatioSpread(CG_IND, CG_DESCRIPTOR, short(cgNeed - 1), short(cgNeed - 1)), want: new RegExp(`\\[CG\\] need ${cgNeed} aligned closes`) },
    { id: "FXH", run: () => scoreFxHaven(FXH_IND, short(21), short(21), short(21)), want: /\[FXH\] need 22 aligned closes/ },
    { id: "GT", run: () => scoreGlobalTrend(GT, short(201)), want: /\[GT\] need 202 observations/ },
    { id: "GB", run: () => scoreGlobalBreadth(GB, Object.fromEntries(GB_SYMBOLS.map((s) => [s, short(50)]))), want: /\[GB\] need 202 aligned closes/ },
    { id: "DISP", run: () => scoreDispersion(DISP, short(20), short(20), short(20)), want: /\[DISP\] need 22 aligned closes/ },
    { id: "R7", run: () => scoreBullSteepener(R7, short(r7Need - 1), short(r7Need - 1), short(r7Need - 1)), want: new RegExp(`\\[R7\\] need ${r7Need} aligned closes`) },
    { id: "EURGBP", run: () => scoreReturnOrMaSpread(EURGBP, short(eurgbpNeed - 1)), want: new RegExp(`\\[EURGBP\\] need ${eurgbpNeed} observations`) },
    { id: "F5", run: () => scoreBreadth(F5, breadthShort.qqq, breadthShort.qqqe), want: new RegExp(`\\[F5\\] need ${BREADTH_MIN_CLOSES} `) },
  ])("$id", ({ run, want }) => {
    expect(run).toThrow(want);
  });
});
