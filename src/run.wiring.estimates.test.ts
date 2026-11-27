import { beforeEach, describe, expect, test, vi } from "vitest";
import { VIX_SYMBOL } from "./vix_term.js";
import { ESTIMATE_ROW_IDS, estimatorOf } from "./nowcast-score.js";
import { quoteRepairIds } from "./run-seeds.js";
import { InMemoryStore } from "./store-memory.js";
import { INDICATORS } from "./registry-fred.js";
import { type Observation, type Reading } from "./domain-types.js";
import { estimatesOf, pushEstimatorRows } from "./run-cycle-estimates.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { isProvisional } from "./intraday.js";
import { SMOOTHED_LEVEL_OF, VT_DESCRIPTOR, VXNT_K_WINDOW } from "./family-descriptor-rows.js";
import type { AlertRecord } from "./store.js";
import {
  FIXTURE_ASOF,
  deepVixcls,
  seedHyoasCalib,
  sovereignGreen,
  fredMock,
  fredMockAt,
  monotonicClock,
  priceCalm,
  dailyDatesEndingAt,
  installRunTestHooks,
  fakeFeeds,
  fakeNotify,
  runCycleWith,
  type FakeFeeds,
} from "./run.test-helpers.js";

// The EOD/intraday estimate wiring (Stages 3b.2, 5.2, 5.3), split out of
// run.wiring.intraday.test.ts to keep both files under the T1 file ceiling (scripts/test-budget-reporter.ts).
let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

/** Ids holding an `estimated` row that the EOD sweeps' roster (E3) would never delete. */
const unsweptEstimateIds = (): string[] => [
  ...new Set(
    store.readings
      .filter((r) => r.estimated === true && !([...ESTIMATE_ROW_IDS, ...quoteRepairIds()] as readonly string[]).includes(r.indicatorId))
      .map((r) => r.indicatorId),
  ),
];

/** R5's `^VIX` lead on its own level (offset off the print) through `end`, plus a `head` bar moved VIX_MOVE off its last close. */
const VIX_MOVE = 0.37;
const VIXCLS = INDICATORS.find((i) => i.id === "R5")!.series;
const R5_LEAD = estimatorOf("R5", "carry-level").leads[0];
const r5LeadOf = (end: string, head: string) => async (): Promise<Observation[]> => {
  const base = (await fredMockAt(end)(VIXCLS)).map((o) => ({ date: o.date, value: o.value + 15 }));
  return [...base, { date: head, value: base.at(-1)!.value + VIX_MOVE }];
};

describe("R5 VIX estimates", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — `^VIX`'s live bar
  test("intraday on D with the ^VIX lead ending D−1 (the index publisher at D−2): no R5 head; D−1 is an `estimated` row (I1) — never a FINAL non-estimate D−1 row (review I1)", async () => {
    const D = "2026-02-03"; // Tue: the lead's newest bar is Mon (NEXT), the index publisher's newest print Fri (FIXTURE_ASOF)
    const feeds = fakeFeeds({ fetchDailyCloses: async (symbol) => (symbol === R5_LEAD ? r5LeadOf(FIXTURE_ASOF, NEXT)() : priceCalm(symbol)) });
    const alert = await runCycleWith(feeds, store, monotonicClock(`${D}T15:00:00.000Z`), { intraday: true });
    expect((await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "R5")?.date).toBe(FIXTURE_ASOF);
    expect(store.readings.filter((r) => r.indicatorId === "R5" && r.date === NEXT).map((r) => r.estimated === true)).toEqual([true]);
  });
});

describe("VT VIX term-structure estimate (the `leg-ratio` estimator)", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — the live `^VIX`/`^VIX3M` bars
  // `fakeFeeds`' calm legs are 18/22 (ratio 0.818, GREEN); the live NEXT bars invert the curve toward AMBER (20/21 = 0.952 ≥ 0.93).
  const HEAD: Record<string, number> = { "^VIX": 20, "^VIX3M": 21 };
  const CALM: Record<string, number> = { "^VIX": 18, "^VIX3M": 22 };
  const [vixSym, vix3mSym] = estimatorOf("VT", "leg-ratio").leads;
  const leadOf = (end: string, head: string | null) => async (symbol: string): Promise<Observation[]> => {
    if (symbol !== vixSym && symbol !== vix3mSym) return priceCalm(symbol);
    const base = dailyDatesEndingAt(30, end).map((date) => ({ date, value: CALM[symbol]! }));
    return head === null ? base : [...base, { date: head, value: HEAD[symbol]! }];
  };
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds({ fetchDailyCloses: leadOf(FIXTURE_ASOF, NEXT) });
  });
  const rowOf = async (firedAt: string) => (await store.getReadingsForRun(firedAt)).find((r) => r.indicatorId === "VT");
  const vtEstimates = () => store.readings.filter((r) => r.indicatorId === "VT" && r.estimated === true);
  const RATIO = HEAD["^VIX"]! / HEAD["^VIX3M"]!;

  test("intraday on D with the live bars ending D−1 (the index publisher at D−2): no VT head; D−1 is an `estimated` row, never a FINAL non-estimate row", async () => {
    const D = "2026-02-03";
    const alert = await runCycleWith(feeds, store, monotonicClock(`${D}T15:00:00.000Z`), { intraday: true });
    expect((await rowOf(alert.firedAt))?.date).toBe(FIXTURE_ASOF);
    expect(store.readings.filter((r) => r.indicatorId === "VT" && r.date === NEXT).map((r) => [r.estimated === true, r.value])).toEqual([[true, RATIO]]);
  });

  test("intraday: VT scores the FRED legs extended by the live bars — a provisional `estimated` head at NEXT = ^VIX/^VIX3M (AMBER);" +
    " EOD with the index publisher lagging NEXT replaces it with ONE final `estimated` NEXT row; the run row stays the index publisher's", async () => {
    const day = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T15:00:00.000Z`), { intraday: true });
    const row = await rowOf(day.firedAt);
    expect([row?.date, isProvisional({ date: row!.date, runAt: day.firedAt }), row?.state]).toEqual([NEXT, true, "AMBER"]);
    expect(row?.value).toBeCloseTo(RATIO, 12);
    const served = (await store.getSeries("VT", 1)).at(-1)!;
    expect([served.date, served.estimated === true]).toEqual([NEXT, true]);
    // The scoring extension is the run's OWN day only: NEXT is the reading, not also a row (the oil-lane residual does not recur).
    expect(vtEstimates().map((r) => [r.date, isProvisional(r)])).toEqual([[NEXT, true]]);
    // VTP shares the legs but never the extension: its row stays on the FRED grid on the run whose both live bars extended VT.
    expect((await store.getReadingsForRun(day.firedAt)).find((r) => r.indicatorId === "VTP")?.date).toBe(FIXTURE_ASOF);
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect((await rowOf(alert.firedAt))?.date).toBe(FIXTURE_ASOF);
    const est = (await store.getSeries("VT", 1)).at(-1)!;
    expect([est.date, est.estimated, isProvisional(est), est.state]).toEqual([NEXT, true, false, "AMBER"]);
    expect(est.value).toBeCloseTo(RATIO, 12);
    expect((await store.getSeries("VT", 5)).filter((p) => p.date === NEXT && p.estimated !== true)).toEqual([]);
    expect(unsweptEstimateIds()).toEqual([]);
    // The notify dial folded the head (VT feeds the volatility family) — `run_inputs` keeps it as the re-derive's evidence.
    expect(alert.runInputs!.heads!.find((h) => h.indicatorId === "VT")).toMatchObject({ date: NEXT, value: est.value });
  });

  test("a live bar on one leg only writes nothing (the ratio needs both carries)", async () => {
    feeds.fetchDailyCloses.mockImplementation(async (symbol) =>
      symbol === vix3mSym ? leadOf(FIXTURE_ASOF, null)(symbol) : leadOf(FIXTURE_ASOF, NEXT)(symbol),
    );
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect((await rowOf(alert.firedAt))?.date).toBe(FIXTURE_ASOF);
    expect(vtEstimates()).toEqual([]);
  });

  test("the back FRED leg lagging the front by a session: ONE estimated row at the front's date = FRED VIX / (VXVCLS print + the ^VIX3M move) — the" +
    " front leg itself never extends, and NEXT (its previous session not final) is gated out", async () => {
    const PREV = dailyDatesEndingAt(2, FIXTURE_ASOF)[0]!;
    const calmLeg = (symbol: string, end: string) => dailyDatesEndingAt(30, FIXTURE_ASOF).filter((d) => d <= end).map((date) => ({ date, value: CALM[symbol]! }));
    feeds.fetchVixSeries.mockImplementation(async (s) => (s === VIX_SYMBOL ? calmLeg(vixSym, FIXTURE_ASOF) : calmLeg(vix3mSym, PREV)));
    // The live ^VIX3M bar on FIXTURE_ASOF moves +1 off its PREV close; ^VIX's live bar there is the print's own level (no move).
    feeds.fetchDailyCloses.mockImplementation(async (symbol) => {
      const base = await leadOf(FIXTURE_ASOF, NEXT)(symbol);
      return symbol === vix3mSym ? base.map((o) => (o.date === FIXTURE_ASOF ? { ...o, value: o.value + 1 } : o)) : base;
    });
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect((await rowOf(alert.firedAt))?.date).toBe(PREV);
    expect(vtEstimates().map((r) => [r.date, r.value])).toEqual([[FIXTURE_ASOF, CALM["^VIX"]! / (CALM["^VIX3M"]! + 1)]]);
  });
});

// One world holding every lifecycle family on disjoint seams: R1–R3 sovereign-quote quotes, R5's ^VIX lead.
// Each family's asserts read its own ids only.
describe("estimate lifecycles: R1–R3, R5 on one intraday → EOD world", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — every family's quote / live bar
  const [R1_LEGS, [R2_LEG], [R3_LEG]] = (["R1", "R2", "R3"] as const).map((id) => estimatorOf(id, "carry-level").leads) as [readonly [string, string], readonly [string], readonly [string]];
  // Distinct per-leg moves off the last bar, so R1's lead reads as the 10y − 3m spread (never the 10y alone) and R2/R3
  // each carry their own tenor. Every other symbol has no live print (bars only).
  const MOVE: Record<string, number> = { [R1_LEGS[0]]: 0.07, [R1_LEGS[1]]: 0.02, [R3_LEG]: 0.11 };
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds({
      fetchSeries: async (series) => fredMock(series),
      fetchDailyCloses: async (symbol) =>
        symbol === R5_LEAD ? r5LeadOf(FIXTURE_ASOF, NEXT)() : priceCalm(symbol),
      fetchSovereignQuote: async (symbol) =>
        MOVE[symbol] === undefined ? undefined : { date: NEXT, value: sovereignGreen(symbol).at(-1)!.value + MOVE[symbol]! },
    });
  });
  const rowOf = async (firedAt: string, id: string) => (await store.getReadingsForRun(firedAt)).find((r) => r.indicatorId === id);
  const printOf = async (id: string) => (await fredMock(INDICATORS.find((i) => i.id === id)!.series)).at(-1)!.value;
  const estRows = (...ids: string[]) => store.readings.filter((r) => ids.includes(r.indicatorId) && r.estimated === true);
  const newest = async (id: string) => (await store.getSeries(id, 1)).at(-1)!;
  const finalNext = async (id: string) => {
    const est = await newest(id);
    return [est.date, est.estimated, isProvisional(est)];
  };

  test("intraday: provisional `estimated` NEXT heads/rows per family (E1, I1); EOD with every print lagging:" +
    " ONE final `estimated` NEXT row per id at its estimate, the run rows stay on prints", async () => {
    const day = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T16:45:00.000Z`), { intraday: true });
    for (const [id, delta] of [["R2", MOVE[R2_LEG]!], ["R3", MOVE[R3_LEG]!], ["R5", VIX_MOVE]] as const) {
      const row = await rowOf(day.firedAt, id);
      expect([row?.date, isProvisional({ date: row!.date, runAt: day.firedAt })], id).toEqual([NEXT, true]);
      expect(row?.value, id).toBeCloseTo((await printOf(id)) + delta, 10);
      // E1: the provisional head serves NEXT — stored `estimated` (a `proxyCarry` obs, `liveHead`).
      expect([(await newest(id)).date, (await newest(id)).estimated === true], id).toEqual([NEXT, true]);
    }
    expect((await rowOf(day.firedAt, "R1"))?.date).toBe(NEXT); // both R1 legs quoted NEXT
    // I1: the estimate row + the `estimated` head, TWO rows per id at NEXT — RESIDUAL — the one-runner `estimator` stage collapses them to one.
    expect(estRows("R1", "R2", "R3", "R5").map((r) => [r.indicatorId, r.date, isProvisional(r)]).sort()).toEqual(
      ["R1", "R1", "R2", "R2", "R3", "R3", "R5", "R5"].map((id) => [id, NEXT, true]),
    );

    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    for (const [id, delta] of [["R2", MOVE[R2_LEG]!], ["R3", MOVE[R3_LEG]!], ["R5", VIX_MOVE]] as const) {
      expect((await rowOf(alert.firedAt, id))?.date, id).toBe(FIXTURE_ASOF);
      expect(await finalNext(id), id).toEqual([NEXT, true, false]);
      expect((await newest(id)).value, id).toBeCloseTo((await printOf(id)) + delta, 10);
      // The EOD cleaner (`sweepEodRows`) deleted the daytime head shadowing this run's estimate; only the estimate holds NEXT.
      expect((await store.getSeries(id, 5)).filter((p) => p.date === NEXT && p.estimated !== true), id).toEqual([]);
    }
    const r1 = await newest("R1");
    expect([r1.date, r1.estimated]).toEqual([NEXT, true]);
    // Flat T10Y3M prints ⇒ the stored mean moves by Δspread / window (a 10y-only lead would move it by MOVE.US10Y / window).
    const { window } = SMOOTHED_LEVEL_OF.R1!;
    expect(r1.value).toBeCloseTo((await printOf("R1")) + (MOVE[R1_LEGS[0]]! - MOVE[R1_LEGS[1]]!) / window, 10);
    // `run_inputs` keeps the head the dials folded — a re-derive's evidence once the cleaners delete the row.
    expect(alert.runInputs!.heads!.find((h) => h.indicatorId === "R5")).toMatchObject({ date: NEXT, value: (await newest("R5")).value });
    expect(unsweptEstimateIds()).toEqual([]);
  });

  test("EOD with the R2/R3 lead down keeps the intraday NEXT estimate as is — provisional at its own run_at, never at the EOD stamp", async () => {
    await runCycleWith(feeds, store, monotonicClock(`${NEXT}T16:45:00.000Z`), { intraday: true });
    // The kept R2 estimate reads RED (the prints stay GREEN): D's notify dial leaves it out, D+1's folds it.
    for (const r of estRows("R2")) Object.assign(r, { state: "RED", rawState: "RED" });
    feeds.fetchSovereignQuote.mockImplementation(async () => undefined);
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    const stampAt = new Date(Date.parse(alert.firedAt) + 1).toISOString();
    for (const id of ["R2", "R3"]) {
      expect(alert.runInputs!.heads!.filter((h) => h.indicatorId === id && h.date === NEXT), id).toEqual([]);
      const kept = estRows(id).filter((r) => r.date === NEXT);
      expect(kept.length, id).toBeGreaterThan(0);
      expect(kept.map((r) => [isProvisional(r), r.runAt === stampAt]), id).toEqual(kept.map(() => [true, false]));
    }
    // probe-provisional-rows' restamp leg rests on this: an estimator id's row past its newest print is `estimated`.
    const pastPrint = [...(await store.getSeriesBulk([...ESTIMATE_ROW_IDS], { limit: 10 }))].flatMap(([id, s]) => {
      const print = s.filter((p) => p.estimated !== true && !isProvisional(p)).at(-1)?.date ?? "";
      return s.filter((p) => p.date > print).map((p) => [id, p.date, p.estimated === true] as const);
    });
    expect(pastPrint).toContainEqual(["R2", NEXT, true]);
    expect(pastPrint.filter(([, , est]) => !est)).toEqual([]);
    const r2Tail = (a: AlertRecord) => a.panelState?.cissHistory.find((h) => h.id === "R2")?.history.at(-1)?.state;
    const dPlus1 = await runCycleWith(feeds, store, monotonicClock("2026-02-03T22:00:00.000Z"));
    expect([r2Tail(alert), r2Tail(dPlus1)]).toEqual(["GREEN", "RED"]);
  });
});

describe("VXNCLS ^VIX estimate (the `carry-mult` estimator)", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — `^VIX`'s live bar
  const MOVE = 1.1;
  const [vixSym] = estimatorOf("VXNCLS", "carry-mult").leads;
  // Both series vary per date, so a print × ratio off any anchor but the newest print lands elsewhere.
  const vxnTo = (end: string) => dailyDatesEndingAt(30, end).map((date, i) => ({ date, value: 20 + i * 0.25 }));
  const vix = dailyDatesEndingAt(30, FIXTURE_ASOF).map((date, i) => ({ date, value: 15 + (i % 3) }));
  const lead = [...vix, { date: NEXT, value: vix.at(-1)!.value * MOVE }];
  let feeds: FakeFeeds;
  const stubVxn = (end: string) => feeds.fetchSeries.mockImplementation(async (s) => (s === "VXNCLS" ? vxnTo(end) : fredMock(s)));
  beforeEach(() => {
    feeds = fakeFeeds({ fetchDailyCloses: async (symbol) => (symbol === vixSym ? lead : priceCalm(symbol)) });
    stubVxn(FIXTURE_ASOF);
  });
  const vxnEstimates = () => store.readings.filter((r) => r.indicatorId === "VXNCLS" && r.estimated === true).map((r) => [r.date, r.value]);

  test("EOD with FRED lagging NEXT: ONE `estimated` NEXT row = newest print × ^VIX_NEXT/^VIX_print (β 1, multiplicative); the run row stays FRED", async () => {
    const print = vxnTo(FIXTURE_ASOF).at(-1)!.value;
    expect(print * MOVE).not.toBeCloseTo(print + (lead.at(-1)!.value - vix.at(-1)!.value), 3); // the fixture parts mult from additive carry
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect((await store.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "VXNCLS")?.date).toBe(FIXTURE_ASOF);
    expect(vxnEstimates().map(([d]) => d)).toEqual([NEXT]);
    expect(vxnEstimates()[0]![1]).toBeCloseTo(print * MOVE, 12);
    expect(unsweptEstimateIds()).toEqual([]);
  });

  test("VXNCLS lagging 2 sessions: a row for the anchored session only — none for the run's own day (`estimateAnchored`)", async () => {
    const PREV = dailyDatesEndingAt(2, FIXTURE_ASOF)[0]!;
    stubVxn(PREV);
    await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect(vxnEstimates().map(([d]) => d)).toEqual([FIXTURE_ASOF]);
  });

  test("a ^VIX leg failure costs the estimate row only, recorded `trace` — display-only (`CHART_ONLY_INDICATORS`), so it never arms the push caveat", async () => {
    feeds.fetchDailyCloses.mockImplementation(async (symbol) => {
      if (symbol === vixSym) throw new Error("^VIX down");
      return priceCalm(symbol);
    });
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect(vxnEstimates()).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("[nowcast] VXNCLS estimate row not written"))).toHaveLength(1);
    expect((alert.degraded ?? []).filter((e) => /VXN/.test(e.scope)).map((e) => [e.scope, e.effect])).toEqual([
      ["[vxn-term] VXN term-structure input unavailable - VXNT omitted", "trace"],
      ["[nowcast] VXNCLS estimate row not written this run", "trace"],
    ]);
  });

  test("estimatesOf carries the newest print over (L_t/L_t0)^β — β is the literal's, not 1", () => {
    const prints = vxnTo(FIXTURE_ASOF);
    const out = estimatesOf({ kind: "carry-mult", leads: [vixSym], beta: 2 }, prints, [lead]);
    expect(out).toMatchObject([{ date: NEXT }]);
    expect((out as Observation[])[0]!.value).toBeCloseTo(prints.at(-1)!.value * MOVE ** 2, 12);
  });
});

describe("VXNT VXN term-structure estimate (VT's `leg-ratio` lane)", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — the live `^VIX`/`^VIX3M` bars
  const [vixSym, vix3mSym] = estimatorOf("VXNT", "leg-ratio").leads;
  const RATIO = VT_DESCRIPTOR.amber - 0.1; // VIXCLS ÷ VXVCLS on every print: VT calm
  const MOVE = 1.1; // ^VIX's NEXT bar over its FIXTURE_ASOF close; ^VIX3M's NEXT bar is flat
  const front = deepVixcls(FIXTURE_ASOF, VXNT_K_WINDOW + 40);
  const back = front.map((o) => ({ date: o.date, value: o.value / RATIO }));
  // VXNCLS/VIXCLS strictly ascending, so a k window shifted by one session moves its median; `last` scales the newest print only.
  const vxnOf = (last: number) => front.map((o, i) => ({ date: o.date, value: o.value * (1.2 + i * 1e-3) * (i === front.length - 1 ? last : 1) }));
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
  };
  /** The VXNT world's ports (`last` scales the newest VXN print) + its closed-form expected head. */
  const worldOf = (last: number) => {
    const vxn = vxnOf(last);
    const feeds = fakeFeeds({
      fetchSeries: async (s) => (s === "VXNCLS" ? vxn : fredMock(s)),
      fetchVixSeries: async (s) => (s === VIX_SYMBOL ? front : back),
      fetchDailyCloses: async (symbol) =>
        symbol === vixSym ? [...front, { date: NEXT, value: front.at(-1)!.value * MOVE }]
          : symbol === vix3mSym ? [...back, { date: NEXT, value: back.at(-1)!.value }] : priceCalm(symbol),
    });
    // k at NEXT: the VXNT_K_WINDOW aligned closes strictly before NEXT (all prints) — an estimated NEXT ratio never feeds its own k.
    const k = median(vxn.slice(-VXNT_K_WINDOW).map((o, i) => o.value / front.at(i - VXNT_K_WINDOW)!.value));
    return { feeds, expected: (vxn.at(-1)!.value * MOVE) / (back.at(-1)!.value * k) }; // (VXN_print × ^VIX_N/^VIX_0) / (^VIX3M_N × k)
  };
  const rowOf = async (firedAt: string) => (await store.getReadingsForRun(firedAt)).find((r) => r.indicatorId === "VXNT");
  const vxntEstimates = () => store.readings.filter((r) => r.indicatorId === "VXNT" && r.estimated === true);

  test("intraday: a provisional `estimated` VXNT head at NEXT = carried VXN ÷ (live ^VIX3M × k), RED on VT's cuts while VT stays GREEN", async () => {
    // The VXN leg rides VT's resolved `^VIX` — the same symbol as VXNCLS's own `carry-mult` lead.
    expect(estimatorOf("VXNCLS", "carry-mult").leads[0]).toBe(vixSym);
    const { feeds, expected } = worldOf(1);
    expect(expected).toBeGreaterThan(VT_DESCRIPTOR.red); // premise: the head crosses red ...
    expect(RATIO * MOVE).toBeLessThan(VT_DESCRIPTOR.amber); // ... while VT's own head (^VIX_N / ^VIX3M_N) stays GREEN
    const day = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T15:00:00.000Z`), { intraday: true });
    const row = await rowOf(day.firedAt);
    expect([row?.date, isProvisional({ date: row!.date, runAt: day.firedAt }), row?.state]).toEqual([NEXT, true, "RED"]);
    expect(row?.value).toBeCloseTo(expected, 12);
    expect((await store.getReadingsForRun(day.firedAt)).find((r) => r.indicatorId === "VT")?.state).toBe("GREEN");
    const served = (await store.getSeries("VXNT", 1)).at(-1)!;
    expect([served.date, served.estimated === true]).toEqual([NEXT, true]);
    expect(vxntEstimates().map((r) => [r.date, isProvisional(r)])).toEqual([[NEXT, true]]);
    expect(unsweptEstimateIds()).toEqual([]);
  });

  test("EOD alone with every leg lagging NEXT: ONE final `estimated` NEXT row, the run row on prints; display-only — the RED head the notify" +
    " dial folds leaves the band, the push and every notify column of a GREEN-head world", async () => {
    const runWorld = async (last: number) => {
      const { feeds, expected } = worldOf(last);
      const s = new InMemoryStore();
      seedHyoasCalib(s);
      const notify = fakeNotify();
      const alert = await runCycleWith(feeds, s, monotonicClock(`${NEXT}T22:00:00.000Z`), { notify });
      return { expected, alert, pushes: notify.pushNtfy.mock.calls, rows: s.readings.filter((r) => r.indicatorId === "VXNT"),
        runRow: (await s.getReadingsForRun(alert.firedAt)).find((r) => r.indicatorId === "VXNT") };
    };
    const red = await runWorld(1);
    const green = await runWorld(0.85);
    // No intraday run first (the EOD cleaner would re-stamp its head): this run's own estimate lane wrote the NEXT row.
    expect(red.rows.filter((r) => r.date === NEXT).map((r) => [r.estimated, isProvisional(r), r.state])).toEqual([[true, false, "RED"]]);
    expect(red.rows.find((r) => r.date === NEXT)?.value).toBeCloseTo(red.expected, 12);
    expect(red.runRow?.date).toBe(FIXTURE_ASOF);
    expect([red.expected > VT_DESCRIPTOR.red, green.expected < VT_DESCRIPTOR.amber]).toEqual([true, true]);
    // Premise: both runs folded their VXNT estimate head into the notify dial (`run_inputs.heads`), RED vs GREEN.
    const head = (w: typeof red) => w.alert.runInputs!.heads!.find((h) => h.indicatorId === "VXNT");
    expect([head(red)?.date, head(red)?.value, head(green)?.date]).toEqual([NEXT, expect.closeTo(red.expected, 12), NEXT]);
    expect(green.pushes.length).toBeGreaterThan(0); // a push fired, so push-equality is not vacuous
    expect(red.pushes).toEqual(green.pushes);
    // Every column but the run's INPUTS for the two ids the worlds differ on (the VXN print and the VXNT head the dial folded).
    const vxn = new Set(["VXNCLS", "VXNT"]);
    const notifyView = ({ timings: _t, runInputs, ...rest }: AlertRecord) => ({
      ...rest,
      runInputs: runInputs && {
        ...runInputs,
        heads: undefined,
        globalReadings: runInputs.globalReadings?.filter((r) => !vxn.has(r.id)),
        oilEst: Object.fromEntries(Object.entries(runInputs.oilEst ?? {}).filter(([id]) => !vxn.has(id))),
      },
    });
    expect(notifyView(red.alert)).toEqual(notifyView(green.alert));
  });
});

describe("pushEstimatorRows (the EOD estimate-row runner)", () => {
  test("estimateAnchored: one row, the first session past the print (across a source holiday) — Wed never chains onto Tue's estimate", async () => {
    const [fri, holiday, tue, wed] = ["2026-02-13", "2026-02-16", "2026-02-17", "2026-02-18"];
    const R5 = INDICATORS.find((i) => i.id === "R5")!;
    const prints = await fredMockAt(fri)(R5.series);
    const p = prints.at(-1)!.value;
    const lead = [...prints, ...[[holiday, 0.1], [tue, 0.2], [wed, 0.37]].map(([date, m]) => ({ date: date as string, value: p + (m as number) }))];
    const score = (obs: Observation[]): Reading => ({ indicator: R5, date: obs.at(-1)!.date, level: obs.at(-1)!.value, delta20: 0, rawState: "GREEN", state: "GREEN" });
    const rowsAt = async (firedDateIso: string, id: string, e: Parameters<typeof pushEstimatorRows>[2], pr: Observation[], legs: Observation[][]) => {
      const ctx = { firedDateIso, levelEstimateRows: [] } as unknown as RunBase;
      await pushEstimatorRows(ctx, id, e, pr, legs, score);
      return ctx.levelEstimateRows.map((r) => [r.date, +(r.value - p).toFixed(10)]);
    };
    expect(await rowsAt(wed, "R5", estimatorOf("R5", "carry-level"), prints, [lead])).toEqual([[tue, 0.2]]);
    expect(await rowsAt(tue, "R5", estimatorOf("R5", "carry-level"), prints, [lead])).toEqual([[tue, 0.2]]);
  });
});
