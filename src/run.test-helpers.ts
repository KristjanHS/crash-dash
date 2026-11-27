import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import { realFeeds, type FeedPorts } from "./feed-ports.js";
import type { NotifyPorts } from "./notify-ports.js";
import { runScoringCycle } from "./run-cycle.js";
import type { RunCycleOptions } from "./run-cycle-ctx.js";
import { readEnv } from "./config.js";
import { MIN_VIX_OBS, PERSIST_N, SLOW_HIGH_WINDOW } from "./slow.js";
import { HICP_HEAD_MONTHS, HICP_SERIES } from "./hicp.js";
import { InMemoryStore } from "./store-memory.js";
import type { AlertRecord, CalibrationParam, Store, StoredReading } from "./store.js";
import * as vixTerm from "./vix_term.js";
import type { EcbSeriesKey } from "./ecb.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_COMPONENTS } from "./registry-composite.js";
import { INDICATORS } from "./registry-fred.js";
import { F5 } from "./registry-price.js";
import { scoreBreadth } from "./scorers-price.js";
import { HCX_SYMBOLS } from "./family-descriptor-rows.js";
import { BREADTH_MIN_CLOSES } from "./scorers-price.js";
import { GAP_FILL_DAYS } from "./intraday.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { PCT_MIN_OBS } from "./percentile.js";
import type { Observation } from "./domain-types.js";
import { wallClock, type Clock } from "./run-seeds.js";
import { HYGLQD_AMBER, HYGLQD_D20_AMBER, HYGLQD_MA, HYGLQD_RET_WINDOW } from "./family-descriptor-rows.js";
import { levelBandHead, moveLegBase, oatLegBase } from "./scorers-composite.js";
import { BONOS, ECISS, VXNCLS } from "./registry-composite.js";
import { R6 } from "./registry-fred.js";
import { CONFIRM_CLOSES, VELOCITY_WINDOW } from "./domain-types.js";
import { BULL_MIN_OBS, SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";
import { BONOS_DESCRIPTOR, BUND_DESCRIPTOR, CG_DESCRIPTOR, ESTR_DESCRIPTOR, VT_DESCRIPTOR, VXNT_K_WINDOW } from "./family-descriptor-rows.js";
import CALIBRATION from "../scripts/backtest/calibration.json" with { type: "json" };

// Composite-component vintage-row ids (rank 11), grouped by composite — derived from the registry, never hand-listed.
export const cmpIds = (composite: string): string[] => COMPOSITE_COMPONENTS[composite]!.map((c) => c.id);
export const ALL_CMP_IDS = Object.values(COMPOSITE_COMPONENTS).flat().map((c) => c.id);

// ECY: flat F7 (CAPE 40) × a linear monthly DFII10 ramp — falling ⇒ tail rank 1 (GREEN), rising ⇒ rank 0.
// Keep dates wall-clock-anchored: the all-GREEN run is unclocked and ECY's staleness gate reads the run clock.
const ECY_MONTHS = PCT_MIN_OBS + 12;
const ecyMonthDate = (i: number): string => {
  const now = new Date();
  const abs =
    now.getUTCFullYear() * 12 + now.getUTCMonth() - (ECY_MONTHS - 1 - i);
  return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`;
};
export const f7Flat = (): StoredReading[] =>
  Array.from({ length: ECY_MONTHS }, (_, i) =>
    makeStoredReading("F7", { date: ecyMonthDate(i), value: 40 }),
  );
export const dfii10Ramp = (from: number, to: number): Observation[] =>
  Array.from({ length: ECY_MONTHS }, (_, i) => ({
    date: ecyMonthDate(i),
    value: from + ((to - from) * i) / (ECY_MONTHS - 1),
  }));

// Strictly-increasing clock (+1ms/read); inject where a run's firedAt must never equal a prior run's stamp.
export const monotonicClock = (startIso = "2024-01-01T00:00:00.000Z"): Clock => {
  let ms = Date.parse(startIso);
  return () => new Date(ms++).toISOString();
};
// Derived from INDICATORS, never a literal — the persistence count follows the registry.
export const FRED_COUNT = INDICATORS.length;

// The ONE anchor for every daily fixture feed: a feed trailing its peers reads a huge slotAge ⇒ `floor:coverage`.
// run.*.test.ts date assertions pin this value — a clock drift is THIS one edit.
export const FIXTURE_ASOF = "2026-01-30";
/** Per-args memo for the pure fixture builders below; results are frozen, so mutating a shared fixture throws. */
function memo<A extends unknown[], T>(fn: (...args: A) => T[]): (...args: A) => T[] {
  const cache = new Map<string, T[]>();
  return (...args) => {
    const key = JSON.stringify(args);
    let hit = cache.get(key);
    if (!hit) {
      hit = Object.freeze(fn(...args).map((x) => (typeof x === "object" && x ? Object.freeze(x) : x))) as T[];
      cache.set(key, hit);
    }
    return hit;
  };
}
/** n consecutive daily ISO dates ending at `end` (default FIXTURE_ASOF); every daily feed derives its dates here. */
export const dailyDatesEndingAt = memo((n: number, end: string = FIXTURE_ASOF): string[] => {
  const t = Date.parse(end);
  return Array.from({ length: n }, (_, i) => new Date(t - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
});

// Length ≥ VELOCITY_WINDOW + CONFIRM_CLOSES; ends on FIXTURE_ASOF so asOf is a real FRED date shared with prices.
export const fredFlat = (value: number, end: string = FIXTURE_ASOF): Observation[] =>
  dailyDatesEndingAt(30, end).map((date) => ({ date, value }));
// WIGGLE gives priceUp() real return variance — without it DISP yields no reading on every all-calm run.
// Keep its period even (20d ratios cancel only on shared parity); a new MA/vol scorer over priceUp() must re-check its margins.
const WIGGLE = 0.0005;
// Length ≥ SLOW_HIGH_WINDOW + PERSIST_N − 1 + margin, so the slow track scores instead of silently degrading.
export const PRICE_UP_LEN = SLOW_HIGH_WINDOW + PERSIST_N + 7;
const priceUp = memo((end: string = FIXTURE_ASOF): Observation[] =>
  dailyDatesEndingAt(PRICE_UP_LEN, end).map((date, i) => ({
    date,
    value: 100 * Math.pow(1.001, i) * (i % 2 === 0 ? 1 : 1 + WIGGLE),
  })));
// Derived below R6's amber cut so a retune moves it; ^MOVE on priceUp() would score R6 RED and lift the T1 dial.
export const CALM_MOVE = R6.thresholds.amberLevel! - 10;
// ^MOVE must be LIVE (ends at `end`) as well as calm, else it arms the coverage floor (band floors at WATCH).
// Flat then a gentle decline ⇒ R6 level/velocity/absolute GREEN; MOVE_FIXTURE_LEN keeps R6 PRESENT.
export const moveFlat = (end: string = FIXTURE_ASOF): Observation[] => {
  const flatN = Math.floor(MOVE_FIXTURE_LEN * 0.6);
  return dailyDatesEndingAt(MOVE_FIXTURE_LEN, end).map((date, i) => ({
    date,
    value: i < flatN ? CALM_MOVE : CALM_MOVE - 5 * ((i - flatN) / (MOVE_FIXTURE_LEN - 1 - flatN)),
  }));
};
// ^OVX: flat at calmLevel("OVX") ⇒ level + spike GREEN; length clears scoreOil's minObs, ends at `end` (coverage floor).
const OVX_FIXTURE_LEN = VELOCITY_WINDOW + CONFIRM_CLOSES + 20;
const ovxFlat = (end: string = FIXTURE_ASOF): Observation[] =>
  dailyDatesEndingAt(OVX_FIXTURE_LEN, end).map((date) => ({ date, value: calmLevel("OVX") }));
// F13 calm: HYG rides priceUp() over a FLAT LQD so the ratio sits above its MA50 (same series on both legs ⇒ AMBER).
// The two guards below throw when a HYGLQD_* retune overtakes this margin.
const lqdFlat = (end: string = FIXTURE_ASOF): Observation[] => priceUp(end).map((o) => ({ ...o, value: 100 }));
const CALM_F13_SPREAD = (() => {
  const ratio = priceUp().map((o) => o.value / 100); // vs the flat LQD leg
  const last = ratio.length - 1;
  let sum = 0;
  for (let j = last - HYGLQD_MA + 1; j <= last; j++) sum += ratio[j]!;
  return ratio[last]! / (sum / HYGLQD_MA) - 1;
})();
if (CALM_F13_SPREAD <= HYGLQD_AMBER) {
  throw new Error(
    `calm price fixture no longer clears HYGLQD_AMBER (s=${CALM_F13_SPREAD} ≤ ${HYGLQD_AMBER}) - steepen priceUp() or widen the LQD gap`,
  );
}
const CALM_F13_D20 = (() => {
  const ratio = priceUp().map((o) => o.value / 100); // vs the flat LQD leg
  const last = ratio.length - 1;
  return ratio[last]! / ratio[last - HYGLQD_RET_WINDOW]! - 1;
})();
if (CALM_F13_D20 <= HYGLQD_D20_AMBER) {
  throw new Error(
    `calm price fixture no longer clears HYGLQD_D20_AMBER (d20=${CALM_F13_D20} ≤ ${HYGLQD_D20_AMBER}) - steepen priceUp() or widen the LQD gap`,
  );
}
// CG's legs: length derived from levelBandHead so CG stays PRESENT; unwiggled, same series both legs ⇒ GREEN.
const priceUpDeep = memo((end: string = FIXTURE_ASOF): Observation[] =>
  dailyDatesEndingAt(levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES + 20, end).map((date, i) => ({
    date,
    value: 100 * Math.pow(1.001, i),
  })));
// Breadth-calm (F5 QQQ/QQQE, SPCONC SPY/RSP): the ratio must sit BELOW its 12-mo high (a climbing ratio is AMBER/RED).
// Length ≥ BREADTH_MIN_CLOSES, else scoreBreadth throws and collapses the whole price batch.
const BREADTH_CALM_LEN = 560; // > the rankable floor; peak sits inside the latest day's 252-window
// Numerator (QQQ/SPY) = priceUp() left-extended: keep its tail == priceUp(), F6/GB/DISP/RS_*/slow track join on it.
const breadthBase = memo((end: string = FIXTURE_ASOF): Observation[] => {
  const up = priceUp(end);
  const pre = BREADTH_CALM_LEN - up.length;
  const t0 = Date.parse(up[0]!.date);
  const prefix = Array.from({ length: pre }, (_, j) => ({
    date: new Date(t0 - (pre - j) * 86_400_000).toISOString().slice(0, 10),
    value: 100 * Math.pow(1.001, j - pre), // continues priceUp backward: monotone-rising, all < 100
  }));
  return [...prefix, ...up];
});
// Calm ratio: 1.00→1.30 peak ~100 closes before the end, back to 1.15 (dist ≈ −12% ⇒ GREEN).
// Denominator (QQQE/RSP) = base/ratio; only the breadth scorer reads them.
const BREADTH_CALM_RATIO = (() => {
  const n = BREADTH_CALM_LEN;
  const peakAt = n - 100;
  return Array.from({ length: n }, (_, i) =>
    i <= peakAt ? 1 + 0.3 * (i / peakAt) : 1.3 - 0.15 * ((i - peakAt) / (n - 1 - peakAt)),
  );
})();
const breadthCalmNum = (end: string = FIXTURE_ASOF): Observation[] => breadthBase(end);
const breadthCalmDen = (end: string = FIXTURE_ASOF): Observation[] =>
  breadthBase(end).map((o, i) => ({ ...o, value: o.value / BREADTH_CALM_RATIO[i]! }));
// Fail-loud: the REAL scorer must score the calm breadth feed GREEN.
{
  const st = scoreBreadth(F5, breadthCalmNum(), breadthCalmDen()).state;
  if (st !== "GREEN")
    throw new Error(`calm breadth fixture no longer scores GREEN (got ${st}) - pull the ratio further below its 12-mo high`);
}
const priceCalmAt = (end: string) => async (symbol: string): Promise<Observation[]> =>
  symbol === "^MOVE"
    ? moveFlat(end)
    : symbol === "^OVX"
      ? ovxFlat(end)
      : symbol === "LQD"
      ? lqdFlat(end)
      : symbol === "QQQ" || symbol === "SPY"
        ? breadthCalmNum(end)
        : symbol === "QQQE" || symbol === "RSP"
          ? breadthCalmDen(end)
          : (CG_DESCRIPTOR.inputs as readonly string[]).includes(symbol)
            ? priceUpDeep(end)
            : priceUp(end);
export const priceCalm = priceCalmAt(FIXTURE_ASOF);

// ECB legs: SR_10Y 3.0 over SR_3M 2.0 (spread > EURC_AMBER) ⇒ EURC GREEN. Depth reads ESTR's descriptor
// window + CONFIRM_CLOSES, so a window retune can't drop ESTR from the wiring pins.
export const ecbGreen = (seriesKey: EcbSeriesKey, end: string = FIXTURE_ASOF): Observation[] =>
  dailyDatesEndingAt(Math.max(30, ESTR_DESCRIPTOR.scorer.constants.window + CONFIRM_CLOSES), end).map((date) => ({
    date,
    value:
      seriesKey === "SR_10Y" ? 3.0 : seriesKey === "ESTR" ? ESTR_FIXTURE_LEVEL : seriesKey === "ECISS"
          ? ECISS_FIXTURE_LEVEL
          : seriesKey === "EURGBP"
            ? EURGBP_FIXTURE_LEVEL
            : 2.0,
  }));
// ESTR: flat ESTR ⇒ quarter Δ = 0 ⇒ GREEN; distinct from SR_3M's 2.0 so a mis-keyed fetch reads back wrong.
export const ESTR_FIXTURE_LEVEL = 1.9;
// ECISS: flat, half its live amber level cut ⇒ GREEN on both legs; distinct from every other ECB key's value.
export const ECISS_FIXTURE_LEVEL = ECISS.thresholds.amberLevel! / 2;
// EURGBP: flat ⇒ zero move and zero MA spread ⇒ GREEN; distinct from every other ECB key's value.
export const EURGBP_FIXTURE_LEVEL = 0.85;

// Derived from BONOS's oatLegBase() so BONOS stays PRESENT through an arm retune.
const SOV_FIXTURE_LEN = oatLegBase(BONOS_DESCRIPTOR.scorer.constants) + CONFIRM_CLOSES + 20;
// Derived from moveLegBase() (R6's velocity warm-up) so R6 stays PRESENT.
const MOVE_FIXTURE_LEN = moveLegBase() + CONFIRM_CLOSES + 20;
// the sovereign-yield quote feed: DE10Y flat; ES (and any other 10y leg) flat above then declining ⇒ VELOCITY GREEN; DE2Y below DE10Y ⇒ BUND GREEN.
// ES10Y sits half BONOS's amber pair over DE10Y (derived — a retune never strands it RED).
const DE10Y_FIXTURE = 2.9;
// DERIVED off BUND's one level cut: twice `amber` (≥ 0.5 pp floor) keeps the slope GREEN through a retune.
const DE2Y_UNDER_DE10Y = Math.max(2 * BUND_DESCRIPTOR.amber, 0.5);
export const sovereignGreen = (symbol = "IT10Y-IT", end: string = FIXTURE_ASOF): Observation[] => {
  if (symbol === "DE10Y-DE") return dailyDatesEndingAt(SOV_FIXTURE_LEN, end).map((date) => ({ date, value: DE10Y_FIXTURE }));
  if (symbol === "DE2Y-DE") return dailyDatesEndingAt(SOV_FIXTURE_LEN, end).map((date) => ({ date, value: DE10Y_FIXTURE - DE2Y_UNDER_DE10Y }));
  const over = symbol === "ES10Y-ES" ? BONOS.thresholds.amberLevel! / 200 : 0.8;
  const level = DE10Y_FIXTURE + over;
  const flatN = Math.floor(SOV_FIXTURE_LEN * 0.6);
  return dailyDatesEndingAt(SOV_FIXTURE_LEN, end).map((date, i) => ({
    date,
    value: i < flatN ? level : level - 0.4 * ((i - flatN) / (SOV_FIXTURE_LEN - 1 - flatN)),
  }));
};

/** An official leg's calm fixture: its sovereign-quote twin's `sovereignGreen` rows dated ≥ `since` (the merge then equals the sovereign-quote leg). */
const officialGreen = (leg: "FR10Y" | "DE10Y" | "IT10Y", since: string = "2025-08-20", end: string = FIXTURE_ASOF): Observation[] =>
  sovereignGreen(`${leg}-${leg.slice(0, 2)}`, end).filter((o) => o.date >= since);

// K1 needs MONTHLY first-of-month CPIAUCSL/UNRATE (date-anchored YoY); flat 1.0 ⇒ AMBER, so K1 persists
// as the `FRED_COUNT` censuses expect.
const fredMonthly = (value: number): Observation[] =>
  Array.from({ length: 27 }, (_, i) => {
    const abs = 2024 * 12 + i;
    return { date: `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`, value };
  });
// A flat level below `id`'s registry Amber cut, DERIVED from it (`testing-project.md`: derive the SETUP).
// Keep the step `|amber|`-relative: a proportional step walks the wrong way for a NEGATIVE cut (EBP).
const calmLevel = (id: string): number => {
  const amber = ALL_INDICATORS.find((i) => i.id === id)?.thresholds.amberLevel;
  if (amber === undefined) throw new Error(`[fixture] ${id} has no amberLevel to derive a calm level from`);
  return amber - Math.abs(amber) * 0.4;
};
const calmBelowAmber = (id: string, end: string = FIXTURE_ASOF): Observation[] => fredFlat(calmLevel(id), end);

/** F1 to a CONFIRMED RED: a step off a calm base to `head`, which must breach BOTH Red legs (level AND velocity).
 *  Cuts and span are read from the registry — never restate them; a retune moves the fixture or throws here. */
export const f1RedBothLegs = (head: number): Observation[] => {
  const f1 = ALL_INDICATORS.find((i) => i.id === "F1")!;
  const span = f1.velocityWindow;
  const { redLevel, redVelocity } = f1.thresholds;
  if (span === undefined || redLevel === undefined || redVelocity === undefined)
    throw new Error("[fixture] F1 no longer carries the velocityWindow + Red level/velocity pair this fixture derives from");
  const base = calmLevel("F1");
  if (head <= redLevel || head - base <= redVelocity)
    throw new Error(`[fixture] head ${head} off base ${base} does not breach BOTH of F1's Red legs`);
  return Array.from({ length: span + 1 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    value: i === span ? head : base,
  }));
};

// EBP rides its own feed (`fetchEbp`): inject this per test, not through `fredMock`.
const ebpCalm = (end: string = FIXTURE_ASOF) => calmBelowAmber("EBP", end);

// HICP index with steadily slowing monthly growth ⇒ y/y falls every month ⇒ Δ6m below HICP's `amberLevel` ⇒ GREEN.
// Length = the transform head + scoreIndicator's minObs + slack; ends the month before `end`.
const hicpCalm = (end: string = FIXTURE_ASOF): Observation[] => {
  const n = HICP_HEAD_MONTHS + VELOCITY_WINDOW + CONFIRM_CLOSES + 6;
  const last = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 2;
  let level = 100;
  return Array.from({ length: n }, (_, i) => {
    level *= Math.exp(0.004 - 0.00003 * i);
    const abs = last - (n - 1) + i;
    return { date: `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`, value: level };
  });
};

// Series-aware FRED mock: monthly for K1's legs, daily flat 1.0 (GREEN) for the rest except the series re-pointed below.
export const fredMockAt = (end: string) => async (series: string): Promise<Observation[]> =>
  series === "CPIAUCSL" || series === "UNRATE"
    ? fredMonthly(1)
    : // NFCIRISK (F3) scores off its LEVEL and fredFlat(1)'s flat 1.0 trips AMBER. Not derived:
      // 0 is SEMANTIC (= average financial risk) — keep it literal.
      series === "NFCIRISK"
      ? fredFlat(0, end)
      : // IG OAS (F2): its level cuts sit BELOW fredFlat(1)'s flat 1.0 since the 2026-07-28
        // retune — track the registry cut.
        series === "BAMLC0A0CM"
        ? calmBelowAmber("F2", end)
        : // R7 ranks each day against its OWN history, so its three legs need one that clears the
          // rank warm-up (else R7 degrades out); T10Y3M also needs R1's smoothed redWindow + confirm fold.
          series === "T10Y3M" || series === "DGS2" || series === "DGS10"
          ? padHistory(fredFlat(1, end), Math.max(VELOCITY_WINDOW + BULL_MIN_OBS, SMOOTHED_LEVEL_OF.R1!.redWindow! + CONFIRM_CLOSES) + 10)
          : series === HICP_SERIES
            ? hicpCalm(end)
            : fredFlat(1, end);
export const fredMock = fredMockAt(FIXTURE_ASOF);

export const deepVixcls = (end: string = FIXTURE_ASOF, n: number = MIN_VIX_OBS + 20): Observation[] =>
  dailyDatesEndingAt(n, end).map((date, i) => ({ date, value: 15 + (i % 3) }));
/** VXNCLS ≡ VXNT_DEEP_K × VIXCLS in the deep VXNT world, so every k window's median IS this constant. */
export const VXNT_DEEP_K = 1.25;
/** VXNT's three legs past its k window, ending at `end`: VIX3M = VIX ÷ `ratio` (default calm, under VT's amber). */
export const deepVxntLegs = (end: string = FIXTURE_ASOF, ratio: number = VT_DESCRIPTOR.amber - 0.1) => {
  const front = deepVixcls(end, VXNT_K_WINDOW + 40);
  return {
    front,
    back: front.map((o) => ({ date: o.date, value: o.value / ratio })),
    vxn: front.map((o) => ({ date: o.date, value: o.value * VXNT_DEEP_K })),
  };
};
/** `FeedPorts` with every port a `vi.fn`, so a test reads `feeds.<port>.mock` without `vi.mocked`. */
export type FakeFeeds = { [K in keyof FeedPorts]: Mock<FeedPorts[K]> };

/** Calm injected ports, every daily feed ending at `end`; drains/outage/memo are no-ops; `over` wins. */
export const fakeFeeds = (over: Partial<FeedPorts> = {}, end: string = FIXTURE_ASOF): FakeFeeds => {
  const vc = vixCalm(end);
  const calm: FeedPorts = {
    fetchSeries: fredMockAt(end),
    fetchDailyCloses: priceCalmAt(end),
    fetchEbp: async () => ebpCalm(end),
    fetchSovereignBars: async (symbol) => sovereignGreen(symbol, end),
    fetchVixSeries: async (s) => (s === vixTerm.VIX_SYMBOL ? vc.front : vc.back),
    graftQuoteLevel: realFeeds.graftQuoteLevel,
    startFredMemo: () => {},
    fredOutage: () => null,
    drainKeyedFallbacks: () => [],
    drainProviderFallbacks: () => [],
    fetchEcbSeries: async (k) => ecbGreen(k, end),
    fetchOfficialLeg: async (leg, since) => ({ source: "stub", obs: officialGreen(leg, since, end) }),
    fetchNtfsSeries: async () => fredFlat(1, end),
    fetchDramSpot: async () => fredFlat(50, end),
    fetchSovereignQuote: async () => undefined,
    fetchTreasuryColumn: async () => [],
    fetchCape: async () => [],
    fetchHourlyBars: async () => ({ bars: [], divDates: new Set() }),
  };
  const ports = { ...calm, ...over };
  return Object.fromEntries(Object.entries(ports).map(([k, f]) => [k, vi.fn(f)])) as unknown as FakeFeeds;
};

/** The calm fixture degrades HCX (basket < BREADTH_MIN_CLOSES): the HCX basket + SPY deep enough to score, the rest `priceCalmAt(end)`. */
export const deepHcxCloses = (end: string = FIXTURE_ASOF): FeedPorts["fetchDailyCloses"] => async (sym) =>
  (HCX_SYMBOLS as readonly string[]).includes(sym) || sym === "SPY"
    ? dailyDatesEndingAt(BREADTH_MIN_CLOSES + GAP_FILL_DAYS + 10, end).map((date, i) => ({ date, value: 100 + i * (sym === "SPY" ? 0.1 : 0.2) }))
    : priceCalmAt(end)(sym);

/** The calm fixture degrades VXNT (legs < its k window): layers `deepVxntLegs` over `feeds`' current FRED impl and replaces its vix legs. */
export const deepVxntPorts = (feeds: FakeFeeds, end: string = FIXTURE_ASOF, ratio?: number): ReturnType<typeof deepVxntLegs> => {
  const legs = deepVxntLegs(end, ratio);
  const fredBase = feeds.fetchSeries.getMockImplementation()!;
  feeds.fetchSeries.mockImplementation(async (s, o) => (s === VXNCLS.series ? legs.vxn : fredBase(s, o)));
  feeds.fetchVixSeries.mockImplementation(async (s) => (s === vixTerm.VIX_SYMBOL ? legs.front : legs.back));
  return legs;
};

/** Geo inputs pinned to 0: config.json is live data; geo floors are tested via injected `geoFlags` / `opts.geo`. */
export const CALM_GEO = { flagCount: 0, crisisStage: 0 } as const;

/** `NotifyPorts` with every port a `vi.fn`, so a test reads `notify.<port>.mock` without `vi.mocked`. */
export type FakeNotify = { [K in keyof NotifyPorts]: Mock<NotifyPorts[K]> };

/** Silent injected notify ports: push resolves, send pinned ENABLED (no `.env.local` NTFY_TOPIC dependence), no mail; `over` wins. */
export const fakeNotify = (over: Partial<NotifyPorts> = {}): FakeNotify => ({
  pushNtfy: vi.fn(over.pushNtfy ?? (async () => undefined)),
  ntfyPushEnabled: vi.fn(over.ntfyPushEnabled ?? (() => true)),
  sendBandEmail: vi.fn(over.sendBandEmail ?? (async () => ({ sent: 0, failed: 0, skipped: "no-recipients" as const }))),
});

/** One `runScoringCycle` with `feeds` + `store` + `geo` + `notify` injected (no `getStore`/feed or notify namespace/config.json reached);
 *  a test asserting on pushes passes its own `opts.notify` (a `fakeNotify()`), else a fresh silent one. */
export const runCycleWith = (
  feeds: Partial<FeedPorts>,
  store: Store,
  clock: Clock = wallClock,
  opts: Omit<RunCycleOptions, "env" | "feeds" | "store"> = {},
): Promise<AlertRecord> => runScoringCycle(clock, { env: readEnv(), feeds, store, geo: CALM_GEO, notify: fakeNotify(), ...opts });

// The gap-fill table: carrier ids whose registry `obsCadence ?? cadence` (default daily) is daily; a
// registry-less id (the CMP_* legs) is daily when its carried dates never step more than 4 days.
const REGISTRY_BY_ID = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i]));
export const carriedDailyIds = (carried: ReadonlyMap<string, readonly StoredReading[]>): string[] =>
  [...carried]
    .filter(([id, s]) => {
      const i = REGISTRY_BY_ID.get(id);
      if (i !== undefined) return (i.obsCadence ?? i.cadence ?? "daily") === "daily";
      const t = s.map((r) => Date.parse(r.date));
      return t.length >= 2 && t.every((x, k) => k === 0 || x - t[k - 1]! <= 4 * 86_400_000);
    })
    .map(([id]) => id);

/** Left-extend `obs` to `n` points by repeating its first value on earlier consecutive days. */
export const padHistory = (obs: Observation[], n: number): Observation[] => {
  const head = obs[0]!;
  const t0 = Date.parse(head.date);
  const pad = Array.from({ length: Math.max(0, n - obs.length) }, (_, i) => ({
    date: new Date(t0 - (n - obs.length - i) * 86_400_000).toISOString().slice(0, 10),
    value: head.value,
  }));
  return [...pad, ...obs];
};

export const atUtcMin = (date: string, min: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + min * 60_000).toISOString();

// Calm ^VIX/^VIX3M contango (18 < 22 ⇒ VT GREEN, VTP streak 0) — `fakeFeeds`' default; keep it on the shared
// window (a trailing one re-arms `floor:coverage`). Backwardation/degrade tests override the seam.
function vixCalm(end: string = FIXTURE_ASOF): { front: Observation[]; back: Observation[] } {
  const dates = dailyDatesEndingAt(30, end);
  return {
    front: dates.map((date) => ({ date, value: 18 })),
    back: dates.map((date) => ({ date, value: 22 })),
  };
}

/** A published `credit/*` cut, read from the TRACKED vintage — so a retune never edits a test. */
const publishedCreditCut = (metric: string): number => {
  const rows = CALIBRATION.params as ReadonlyArray<{ channel: string; metric: string; value: number }>;
  const hit = rows.find((p) => p.channel === "credit" && p.metric === metric);
  if (!hit) throw new Error(`calibration.json: credit/${metric} not published`);
  return hit.value;
};

// `runScoringCycle` THROWS without the `credit/hyoas` vintage — seed it into every InMemoryStore that drives a cycle.
export const seedHyoasCalib = (s: InMemoryStore): void => {
  const row = (metric: string, value: number): CalibrationParam => ({
    market: null,
    mode: null,
    channel: "credit",
    metric,
    value,
    ciLow: null,
    ciHigh: null,
    method: "measured",
    nEvents: null,
    windowStart: null,
    windowEnd: null,
    notes: null,
    computedAt: "2026-07-22T00:00:00.000Z",
  });
  // The VELOCITY EVT rows `assertF1VintagePresent` reads; values come from calibration.json — never type them here.
  void s.recordCalibration([
    row("hyoas_evt_vel_amber", publishedCreditCut("hyoas_evt_vel_amber")),
    row("hyoas_evt_vel_red", publishedCreditCut("hyoas_evt_vel_red")),
  ]);
};


// A PRIOR persisted alert row — the prev-state a run reads back; shared so every consumer seeds one shape.
export const priorAlert = (over: Partial<AlertRecord> = {}): AlertRecord =>
  makeAlert({
    date: "2026-01-27",
    firedAt: "2026-01-27T21:00:00.000Z",
    r4Phase: "equity",
    heldSleeve: "S&P 500", // EUR leg (SXR8.DE) — no FX in the strategy ratio
    ...over,
  });

/** The `console.warn` lines this test has emitted so far — read off `installRunTestHooks`' silencing spy. */
export const runWarns = (): string[] => vi.mocked(console.warn).mock.calls.map(([m]) => String(m));

/** Installs the shared per-test IO-seam stubs; call once at module scope in each `run.*.test.ts` file.
 *  `bindStore` publishes each fresh store into that file's own `let store` (an exported binding can't be reassigned). */
const liveFetches: string[] = [];
export function installRunTestHooks(bindStore: (s: InMemoryStore) => void): void {
  beforeEach(() => {
    const store = new InMemoryStore();
    bindStore(store);
    seedHyoasCalib(store);
    // Store tripwire: a run that forgets `store` throws in `getStore` instead of reaching `.env.local`'s DB.
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "");
    // Hermeticity backstop: an unstubbed seam throws AND afterEach reds on it (a degrade path can swallow the throw).
    liveFetches.length = 0;
    vi.stubGlobal("fetch", vi.fn((url: unknown) => {
      liveFetches.push(String(url));
      throw new Error(`[run hooks] unstubbed live fetch: ${String(url)}`);
    }));
    // The ONE console spy a run test needs: the cycle's log lines are silenced here, restored by the afterEach
    // below (Q-E), and a test asserting a diagnostic line reads THIS spy (`runWarns()` / `vi.mocked(console.*)`) — never a spy of its own.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(liveFetches, "unstubbed IO seam reached fetch — inject its port (`fakeFeeds`) or stub it in the describe").toEqual([]);
  });
}
