import { expect, test, describe } from "vitest";
import {
  B1_OVERRIDES_PER_YEAR,
  chainedRatio,
  chainLinkDate,
  computeScoreboard,
  SB_BENCH_ID,
  SB_MAX_CLOSE_LAG_DAYS,
  SB_STRAT_ID,
  scoreboardNavRows,
  LEG_TICKER,
  legCloseId,
  legCloseReadingRows,
  M2_RETURN_LAG_PP,
  maxDrawdown,
  MIN_CALMAR_RUNS,
  MIN_UI_RUNS,
  NAV_BASE,
  nextNav,
  recoveryRuns,
  spliceProxyCloses,
  ulcerIndex,
  YARDSTICK_LABEL,
  withholdScoreboardStats,
  type NavPoint,
  type OverrideRow,
} from "./scoreboard.js";
import { LADDER } from "./families.js";
import type { Observation } from "./domain-types.js";

/** Build a NavPoint series from values, one point per calendar day from `start`. */
function navSeries(values: number[], start = "2026-01-01"): NavPoint[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return values.map((value, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
}

const NOW = new Date("2026-07-15T12:00:00Z");
const noAlerts: never[] = [];

describe("ulcerIndex", () => {
  test("known hand-computed vector", () => {
    // navs 100,90,80,120 → trailing peaks 100,100,100,120 → D = 0,−10,−20,0 (pct)
    // UI = sqrt((0 + 100 + 400 + 0) / 4) = sqrt(125)
    expect(ulcerIndex([100, 90, 80, 120])).toBeCloseTo(Math.sqrt(125), 10);
  });

  test("zero for a monotone-rising series", () => {
    expect(ulcerIndex([100, 101, 105, 110])).toBe(0);
  });
});

describe("maxDrawdown + recoveryRuns", () => {
  test("fall-recover-fall series: maxDD is the deep trough, recovery counted to first re-touch of pre-trough peak", () => {
    // peak 100 → trough 60 (idx 2, dd −40%) → recovers at idx 4 (110 ≥ 100) → shallower second fall
    const navs = [100, 80, 60, 90, 110, 100, 95];
    expect(maxDrawdown(navs)).toBeCloseTo(-40, 10);
    expect(recoveryRuns(navs)).toBe(2); // idx 4 − idx 2
  });

  test("recovery n/a (null) when unrecovered", () => {
    expect(recoveryRuns([100, 90, 80, 85])).toBeNull();
  });

  test("recovery n/a (null) when maxDD = 0", () => {
    expect(recoveryRuns([100, 110, 120])).toBeNull();
  });
});

describe("computeScoreboard n/a windows", () => {
  test(`calmar n/a below MIN_CALMAR_RUNS (${MIN_CALMAR_RUNS}), defined at the boundary`, () => {
    // Zig-zag so a real drawdown exists (calmar's own maxDD≠0 rule never bites here).
    const values = (n: number) => Array.from({ length: n }, (_, i) => 100 + i + (i % 2 ? -5 : 0));
    const short = computeScoreboard(navSeries(values(MIN_CALMAR_RUNS - 1)), [], [], noAlerts, NOW);
    expect(short.strategy.calmar.value).toBeNull();
    expect(short.strategy.calmar.naReason).toMatch(/n\/a yet/);
    const enough = computeScoreboard(navSeries(values(MIN_CALMAR_RUNS)), [], [], noAlerts, NOW);
    expect(enough.strategy.calmar.value).not.toBeNull();
    expect(enough.strategy.calmar.naReason).toBeNull();
  });

  test(`ulcer n/a below MIN_UI_RUNS (${MIN_UI_RUNS}), defined at the boundary`, () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => 100 - i); // falling → UI > 0
    const short = computeScoreboard(navSeries(values(MIN_UI_RUNS - 1)), [], [], noAlerts, NOW);
    expect(short.strategy.ulcer.value).toBeNull();
    expect(short.strategy.ulcer.naReason).toMatch(/n\/a yet/);
    const enough = computeScoreboard(navSeries(values(MIN_UI_RUNS)), [], [], noAlerts, NOW);
    expect(enough.strategy.ulcer.value).toBeGreaterThan(0);
    expect(enough.strategy.ulcer.naReason).toBeNull();
  });

  test("zero SB rows → warmingUp with every metric n/a", () => {
    const sb = computeScoreboard([], [], [], noAlerts, NOW);
    expect(sb.warmingUp).toBe(true);
    expect(sb.since).toBeNull();
    expect(sb.runs).toBe(0);
    for (const cell of Object.values(sb.strategy)) {
      expect(cell.value).toBeNull();
      expect(cell.naReason).toMatch(/n\/a yet/);
    }
    expect(sb.gates.ulcer.verdict).toBeNull();
    expect(sb.yardstickLabel).toBe(YARDSTICK_LABEL);
  });

  test("withholdScoreboardStats fails closed: a warming-up view (0 strategy rows) still nulls the computed benchmark column", () => {
    const bench = navSeries(Array.from({ length: 30 }, (_, i) => 100 + (i % 3 === 0 ? -5 : i / 10)));
    const sb = computeScoreboard([], bench, [], noAlerts, NOW);
    expect(sb.warmingUp).toBe(true);
    // Non-vacuity: `warmingUp` reads the strategy rows only, so the benchmark statistics ARE computed.
    expect([sb.benchmark.ulcer.value, sb.benchmark.maxDD.value, sb.benchmark.annRet.value].every((v) => typeof v === "number")).toBe(true);
    const redacted = withholdScoreboardStats(sb);
    const cells = [...Object.values(redacted.strategy), ...Object.values(redacted.benchmark)];
    expect(cells.map((c) => c.value)).toEqual(cells.map(() => null));
    expect(cells.every((c) => c.naReason !== null)).toBe(true); // the cell invariant
    expect(redacted.strategy).toEqual(sb.strategy); // the empty column keeps its honest warming-up cells
    expect(Object.values(redacted.benchmark).map((c) => c.naReason)).toEqual(Object.values(redacted.benchmark).map(() => "withheld - licensed closes"));
    expect([redacted.gates.ulcer.strategyUi, redacted.gates.ulcer.benchmarkUi, redacted.returnVsFundPp]).toEqual([null, null, null]);
  });

  test("window statement names the first SB date and run count", () => {
    const sb = computeScoreboard(navSeries([100, 101, 99]), [], [], noAlerts, NOW);
    expect(sb.warmingUp).toBe(false);
    expect(sb.windowStatement).toBe(
      "measuring since 2026-01-01 · 3 runs - short window: informational, not yet kill-grade (D7 needs ≥2 non-overlapping windows)",
    );
  });
});

describe("gate (a) - ulcer", () => {
  test("equality boundary PASSes (UI_strat === UI_bench × ratio)", () => {
    const values = Array.from({ length: MIN_UI_RUNS }, (_, i) => 100 - i); // identical series both sides
    const sb = computeScoreboard(navSeries(values), navSeries(values), [], noAlerts, NOW);
    expect(sb.gates.ulcer.strategyUi).toBe(sb.gates.ulcer.benchmarkUi);
    expect(sb.gates.ulcer.verdict).toBe("PASS");
  });

  test("FAILs when the strategy's ulcer exceeds the benchmark's", () => {
    const calm = Array.from({ length: MIN_UI_RUNS }, (_, i) => 100 + (i % 2 ? -1 : 0));
    const rough = Array.from({ length: MIN_UI_RUNS }, (_, i) => 100 + (i % 2 ? -20 : 0));
    const sb = computeScoreboard(navSeries(rough), navSeries(calm), [], noAlerts, NOW);
    expect(sb.gates.ulcer.verdict).toBe("FAIL");
  });
});

describe("watched guardrail - return-vs-fund flag", () => {
  // Strategy flat, benchmark rising → strategy lags far beyond −M2_RETURN_LAG_PP annualized.
  const flat = (n: number) => Array.from({ length: n }, () => 100);
  const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + 2 * i);

  test(`below MIN_UI_RUNS: returnVsFundPp shown but returnFlag stays null`, () => {
    const n = MIN_UI_RUNS - 1;
    const sb = computeScoreboard(navSeries(flat(n)), navSeries(rising(n)), [], noAlerts, NOW);
    expect(sb.returnVsFundPp).not.toBeNull();
    expect(sb.returnVsFundPp!).toBeLessThan(-M2_RETURN_LAG_PP);
    expect(sb.returnFlag).toBeNull();
  });

  test(`at MIN_UI_RUNS: the same lag fires the flag`, () => {
    const n = MIN_UI_RUNS;
    const sb = computeScoreboard(navSeries(flat(n)), navSeries(rising(n)), [], noAlerts, NOW);
    expect(sb.returnVsFundPp!).toBeLessThan(-M2_RETURN_LAG_PP);
    expect(sb.returnFlag).toBe("KILL-FLOOR");
  });
});

describe("gate (b) - overrides", () => {
  const ov = (obsDate: string): OverrideRow => ({ obsDate, note: null });

  test(`exactly ${B1_OVERRIDES_PER_YEAR} in the trailing year → PASS`, () => {
    const sb = computeScoreboard(
      navSeries([100]),
      navSeries([100]),
      [ov("2026-07-01"), ov("2026-06-01"), ov("2025-08-01")],
      noAlerts,
      NOW,
    );
    expect(sb.gates.overrides.count).toBe(3);
    expect(sb.gates.overrides.verdict).toBe("PASS");
    expect(sb.gates.overrides.limit).toBe(B1_OVERRIDES_PER_YEAR);
  });

  test("4 in the trailing year → FAIL", () => {
    const sb = computeScoreboard(
      navSeries([100]),
      navSeries([100]),
      [ov("2026-07-01"), ov("2026-06-01"), ov("2026-05-01"), ov("2025-08-01")],
      noAlerts,
      NOW,
    );
    expect(sb.gates.overrides.count).toBe(4);
    expect(sb.gates.overrides.verdict).toBe("FAIL");
  });

  test("entries older than 365 days are excluded from the count", () => {
    const sb = computeScoreboard(
      navSeries([100]),
      navSeries([100]),
      [ov("2026-07-01"), ov("2025-06-10"), ov("2024-01-01")], // 2 old rows (>365d before 2026-07-15)
      noAlerts,
      NOW,
    );
    expect(sb.gates.overrides.count).toBe(1);
    expect(sb.gates.overrides.verdict).toBe("PASS");
  });
});

describe("nextNav", () => {
  const fxFlat: Observation[] = [
    { date: "2026-07-01", value: 1.0 },
    { date: "2026-07-08", value: 1.0 },
  ];

  test('flat (R_t = 1) on prior r4Phase "cash"', () => {
    const closes: Observation[] = [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-08", value: 150 },
    ];
    const nav = nextNav(NAV_BASE, closes, fxFlat, "2026-07-01", "2026-07-08", {
      heldSleeve: "Semis",
      r4Phase: "cash",
    });
    expect(nav).toBe(NAV_BASE);
  });

  test("flat (R_t = 1) on null prior heldSleeve", () => {
    const closes: Observation[] = [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-08", value: 150 },
    ];
    const nav = nextNav(NAV_BASE, closes, fxFlat, "2026-07-01", "2026-07-08", {
      heldSleeve: null,
      r4Phase: "equity",
    });
    expect(nav).toBe(NAV_BASE);
  });

  test("a USD series converts per-date via the EURUSD divisor (the SB_BENCH / proxy arm)", () => {
    // USD price +10% but EUR strengthens 1.0 → 1.1: EUR return is flat.
    const closes: Observation[] = [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-02", value: 110 },
    ];
    const fx: Observation[] = [
      { date: "2026-07-01", value: 1.0 },
      { date: "2026-07-02", value: 1.1 },
    ];
    expect(chainedRatio(closes, fx, "2026-07-01", "2026-07-02", "USD")).toBeCloseTo(1, 10);
  });

  test("EUR-native leg passes through (FX ignored)", () => {
    // S&P 500 → SXR8.DE (EUR): +10% in EUR regardless of the FX series.
    const closes: Observation[] = [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-02", value: 110 },
    ];
    const fx: Observation[] = [
      { date: "2026-07-01", value: 1.0 },
      { date: "2026-07-02", value: 1.5 },
    ];
    const nav = nextNav(NAV_BASE, closes, fx, "2026-07-01", "2026-07-02", {
      heldSleeve: "S&P 500",
      r4Phase: "equity",
    });
    expect(nav).toBeCloseTo(NAV_BASE * 1.1, 10);
  });

  test("multi-day gap is absorbed as one multi-day ratio", () => {
    // Missed cron days: endpoints a week apart, intermediate closes ignored.
    const closes: Observation[] = [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-03", value: 90 },
      { date: "2026-07-08", value: 105 },
    ];
    const nav = nextNav(NAV_BASE, closes, fxFlat, "2026-07-01", "2026-07-08", {
      heldSleeve: "S&P 500",
      r4Phase: "equity",
    });
    expect(nav).toBeCloseTo(NAV_BASE * 1.05, 10);
  });

  test("missing close at either endpoint throws (upstream degrade)", () => {
    const closes: Observation[] = [{ date: "2026-07-01", value: 100 }];
    expect(() =>
      nextNav(NAV_BASE, closes, fxFlat, "2026-07-01", "2026-07-08", {
        heldSleeve: "S&P 500",
        r4Phase: "equity",
      }),
    ).toThrow(/no close/);
  });
});

describe("scoreboardNavRows (links at the newest close every input shares)", () => {
  const obs = (pairs: [string, number][]): Observation[] => pairs.map(([date, value]) => ({ date, value }));
  const fx = obs([["2026-09-18", 1]]); // nearest-prior FX: one row covers every later date
  const acwi = obs([["2026-09-18", 100], ["2026-09-24", 110], ["2026-09-25", 120]]);
  const xdev = obs([["2026-09-18", 50], ["2026-09-24", 60]]); // Xetra leg, 09-25 not published yet
  const prev = { date: "2026-09-18", value: NAV_BASE };
  const value = { heldSleeve: "Value", r4Phase: "equity" as const };
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  // The 2026-09-18..26 prod freeze: ACWI had asOf's close, the held leg did not → exact-date lookup threw every run.
  test("a venue that hasn't published asOf moves BOTH chains to the newest shared close, not a degrade", () => {
    const rows = scoreboardNavRows({ asOf: "2026-09-25", prevStrat: prev, prevBench: prev, prior: value, fx, benchCloses: acwi, legCloses: xdev });
    expect(rows.map((r) => [r.indicatorId, r.date, r.value])).toEqual([
      [SB_STRAT_ID, "2026-09-24", NAV_BASE * 1.2],
      [SB_BENCH_ID, "2026-09-24", NAV_BASE * 1.1],
    ]);
  });

  test("nothing closed since the last row (an intraday re-run) writes no row and does not throw", () => {
    const at24 = { date: "2026-09-24", value: 110 };
    expect(scoreboardNavRows({ asOf: "2026-09-25", prevStrat: at24, prevBench: at24, prior: value, fx, benchCloses: acwi, legCloses: xdev })).toEqual([]);
  });

  test("a cash strategy links on the benchmark alone (the leg's missing close cannot hold it back)", () => {
    const rows = scoreboardNavRows({ asOf: "2026-09-25", prevStrat: prev, prevBench: prev, prior: { heldSleeve: "Value", r4Phase: "cash" }, fx, benchCloses: acwi, legCloses: [] });
    expect(rows.map((r) => [r.date, r.value])).toEqual([["2026-09-25", NAV_BASE], ["2026-09-25", NAV_BASE * 1.2]]);
  });

  test("a prev row on a date the new leg didn't trade (sleeve switch after an NYSE-only day) starts from its last close", () => {
    const acwiMon = obs([["2026-09-18", 100], ["2026-09-21", 105], ["2026-09-22", 110]]);
    const legNoMon = obs([["2026-09-18", 40], ["2026-09-22", 50]]); // no 09-21 row
    const rows = scoreboardNavRows({
      asOf: "2026-09-22",
      prevStrat: { date: "2026-09-21", value: 130 },
      prevBench: { date: "2026-09-21", value: 105 },
      prior: value,
      fx,
      benchCloses: acwiMon,
      legCloses: legNoMon,
    });
    expect(rows.map((r) => [r.indicatorId, r.date, r.value])).toEqual([
      [SB_STRAT_ID, "2026-09-22", 130 * (50 / 40)],
      [SB_BENCH_ID, "2026-09-22", 105 * (110 / 105)],
    ]);
  });

  test("a seed dated on a non-trading asOf (Saturday) links on the next run from the last close before it", () => {
    const seed = scoreboardNavRows({ asOf: "2026-09-26", prevStrat: undefined, prevBench: undefined, prior: value, fx: [], benchCloses: [], legCloses: [] });
    const at = (id: string) => seed.find((r) => r.indicatorId === id)!;
    expect(at(SB_STRAT_ID).date).toBe("2026-09-26");
    const rows = scoreboardNavRows({
      asOf: "2026-09-28",
      prevStrat: at(SB_STRAT_ID),
      prevBench: at(SB_BENCH_ID),
      prior: value,
      fx,
      benchCloses: obs([["2026-09-25", 100], ["2026-09-28", 110]]),
      legCloses: obs([["2026-09-25", 50], ["2026-09-28", 60]]),
    });
    expect(rows.map((r) => [r.indicatorId, r.date, r.value])).toEqual([
      [SB_STRAT_ID, "2026-09-28", NAV_BASE * (60 / 50)],
      [SB_BENCH_ID, "2026-09-28", NAV_BASE * (110 / 100)],
    ]);
  });

  test("a shared close older than SB_MAX_CLOSE_LAG_DAYS throws (stopped feed stays visible); exactly at the cap links", () => {
    const asOfAtCap = addDays("2026-09-24", SB_MAX_CLOSE_LAG_DAYS);
    expect(chainLinkDate([acwi, xdev], asOfAtCap)).toBe("2026-09-24");
    expect(() => chainLinkDate([acwi, xdev], addDays(asOfAtCap, 1))).toThrow(/behind/);
  });
});

describe("legCloseReadingRows (chain-consistent LEGP_* levels)", () => {
  const DATE = "2026-07-15";
  /** EURUSD 1.25 ⇒ a USD close of 125 is 100 EUR. Flat over the window unless noted. */
  const FX: Observation[] = [{ date: "2026-07-14", value: 1.25 }];
  const NO_PRIOR = (): Map<string, { level: number; date: string }> => new Map();

  /** Closes for every leg at `date`: USD legs at 125, EUR legs at 100 — so a correct */
  /** conversion makes ALL nine SEED rows read 100 and a missed one stands out. */
  function allLegCloses(date = DATE): Record<string, Observation[]> {
    return Object.fromEntries(
      Object.values(LEG_TICKER).map((l) => [l.ticker, [{ date, value: l.currency === "USD" ? 125 : 100 }]]),
    );
  }

  test("seeds each leg (no prior) from its first computable EUR close", () => {
    const rows = legCloseReadingRows(allLegCloses(), FX, [DATE], NO_PRIOR());
    expect(rows.map((r) => r.indicatorId).sort()).toEqual(LADDER.map(legCloseId).sort());
    expect(rows.find((r) => r.indicatorId === legCloseId("Semis"))?.value).toBeCloseTo(100, 10);
    expect(rows.find((r) => r.indicatorId === legCloseId("S&P 500"))?.value).toBeCloseTo(100, 10);
  });

  test("advances a stored level by the within-fetch EUR ratio, not the raw EUR close (seam fix)", () => {
    // The stored anchor sits in a DIFFERENT vintage (level 200 at prevDate); the fresh fetch has
    // the leg rising 100→110 EUR (S&P 500, EUR-quoted so no FX). The chain must emit 200 × 1.10 =
    // 220 — NOT the raw EUR close 110. Mutating the writer to `eurCloseAt(...)` reddens on 110≠220.
    const prevDate = "2026-07-14";
    const closes: Record<string, Observation[]> = {
      [LEG_TICKER["S&P 500"].ticker]: [
        { date: prevDate, value: 100 },
        { date: DATE, value: 110 },
      ],
    };
    const prior = new Map([[legCloseId("S&P 500"), { level: 200, date: prevDate }]]);
    const rows = legCloseReadingRows(closes, FX, [DATE], prior);
    expect(rows.find((r) => r.indicatorId === legCloseId("S&P 500"))?.value).toBeCloseTo(220, 10);
  });

  test("chain from the seed base telescopes to the direct EUR close within one fetch vintage", () => {
    // Backfill semantics: empty prior, a multi-date fold. Because every date shares one vintage the
    // chained level at the LAST date equals the direct EUR close there — so a full re-seed leaves the
    // stored shape unchanged. S&P 500 is EUR-quoted (no FX): closes 100 → 130 over three dates.
    const t = LEG_TICKER["S&P 500"].ticker;
    const closes: Record<string, Observation[]> = {
      [t]: [
        { date: "2026-07-13", value: 100 },
        { date: "2026-07-14", value: 121 },
        { date: DATE, value: 130 },
      ],
    };
    const rows = legCloseReadingRows(closes, FX, ["2026-07-13", "2026-07-14", DATE], NO_PRIOR()).filter(
      (r) => r.indicatorId === legCloseId("S&P 500"),
    );
    expect(rows.map((r) => r.value)).toEqual([
      expect.closeTo(100, 10), // seed base = first EUR close
      expect.closeTo(121, 10), // 100 × (121/100)
      expect.closeTo(130, 10), // 121 × (130/121) — telescopes to the direct close
    ]);
  });

  test("skips only the legs missing a close, keeping the rest", () => {
    const closes = allLegCloses();
    const shut: readonly string[] = ["S&P 500", "EM"];
    for (const s of shut) closes[LEG_TICKER[s as (typeof LADDER)[number]].ticker] = [];
    const rows = legCloseReadingRows(closes, FX, [DATE], NO_PRIOR());
    expect(rows.map((r) => r.indicatorId).sort()).toEqual(LADDER.filter((s) => !shut.includes(s)).map(legCloseId).sort());
  });

  test("no FX at all: every EUR leg still seeds", () => {
    const rows = legCloseReadingRows(allLegCloses(), [], [DATE], NO_PRIOR());
    expect(rows.map((r) => r.indicatorId).sort()).toEqual(LADDER.map(legCloseId).sort());
  });

  test("emits display-only rows no scorer reads", () => {
    const [row] = legCloseReadingRows(allLegCloses(), FX, [DATE], NO_PRIOR());
    expect(row).toMatchObject({ date: DATE, delta20: 0, state: "GREEN", rawState: "GREEN", decision: null });
  });
});

describe("spliceProxyCloses (pre-join proxy € path, chain-joined to the held fund)", () => {
  const semis = LEG_TICKER.Semis;
  const J = semis.proxy!.until;
  const held: Observation[] = [
    { date: J, value: 50 },
    { date: "2021-08-09", value: 51 },
  ];
  const proxy: Observation[] = [
    { date: "2021-08-03", value: 230 }, // before every FX row → dropped, never fabricated
    { date: "2021-08-04", value: 240 },
    { date: "2021-08-05", value: 250 },
    { date: J, value: 252 },
    { date: "2021-08-09", value: 255 }, // post-join proxy close → ignored
  ];
  const fx: Observation[] = [
    { date: "2021-08-04", value: 1.2 },
    { date: J, value: 1.25 },
  ];
  const k = 50 / (252 / 1.25); // held(J) / proxy€(J)
  const expected = [
    ["2021-08-04", expect.closeTo((240 / 1.2) * k, 10)],
    ["2021-08-05", expect.closeTo((250 / 1.2) * k, 10)],
    [J, expect.closeTo(50, 10)],
    ["2021-08-09", expect.closeTo(51, 10)],
  ];

  test("before the join = proxy € × held(J)/proxy€(J); from the join on = the held € close", () => {
    expect(spliceProxyCloses(held, proxy, fx, semis).map((o) => [o.date, o.value])).toEqual(expected);
  });

  test("a full re-seed from before the join equals the held € close from the join on; a cron past it needs no proxy", () => {
    const closes = { [semis.ticker]: held, [semis.proxy!.ticker]: proxy };
    const dates = ["2021-08-03", "2021-08-04", "2021-08-05", J, "2021-08-09"];
    const rows = legCloseReadingRows(closes, fx, dates, new Map()).filter((r) => r.indicatorId === legCloseId("Semis"));
    expect(rows.map((r) => [r.date, r.value])).toEqual(expected);
    const prior = new Map([[legCloseId("Semis"), { level: 50, date: J }]]);
    const cron = legCloseReadingRows({ [semis.ticker]: held }, [], ["2021-08-09"], prior);
    expect(cron.find((r) => r.indicatorId === legCloseId("Semis"))?.value).toBeCloseTo(51, 10);
  });
});
