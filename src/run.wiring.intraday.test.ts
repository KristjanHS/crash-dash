import { beforeEach, describe, expect, test } from "vitest";
import { ESTIMATE_ROW_IDS, GATE_FAILED_ESTIMATORS, NOWCAST_LEG_SYMBOLS, estimatorOf } from "./nowcast-score.js";

const T10YIE_EST = estimatorOf("T10YIE", "carry-ratio");
import { InMemoryStore } from "./store-memory.js";
import type { AlertRecord, SeriesPoint } from "./store.js";
import { graftQuoteLevel } from "./quote-graft.js";
import { isTargetClosed } from "./market-closures.js";
import { drainDegradeLog, resetDegradeLog } from "./tracks.js";
import { INDICATORS } from "./registry-fred.js";

const R2 = INDICATORS.find((i) => i.id === "R2")!;
import type { Observation } from "./domain-types.js";
import type { FeedPorts } from "./feed-ports.js";
import { seedIntradayTail } from "./run-cycle.js";
import { createGraft } from "./run-cycle-graft.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { QUOTE_GRAFT_CARDS, quoteRepairIds } from "./run-seeds.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { legCloseId, SB_STRAT_ID } from "./scoreboard.js";
import {
  FIXTURE_ASOF,
  sovereignGreen,
  fakeFeeds,
  fakeNotify,
  type FakeFeeds,
  fredFlat,
  f1RedBothLegs,
  fredMock,
  priorAlert,
  monotonicClock,
  moveFlat,
  seedHyoasCalib,
  priceCalm,
  installRunTestHooks,
  runCycleWith,
} from "./run.test-helpers.js";
import { GAP_FILL_DAYS, isProvisional, servedVerdict } from "./intraday.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { isSourceHoliday } from "./source-holidays.js";
import { readEnv } from "./config.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

/** Fails the anchor gate's stored-row read (`gateUnanchoredReadings`: the BUND head's ids at `GAP_FILL_DAYS`, no range) — an input. */
class AnchorReadFailStore extends InMemoryStore {
  override async getSeriesBulk(...a: Parameters<InMemoryStore["getSeriesBulk"]>): Promise<Map<string, SeriesPoint[]>> {
    const [ids, opts] = a;
    if (ids.includes("BUND") && opts.limit === GAP_FILL_DAYS && opts.range === undefined) throw new Error("anchor read down");
    return super.getSeriesBulk(...a);
  }
}
/** A slot whose clear fails while `clearFails` — the EOD run's supersede input. */
class SlotClearFailStore extends InMemoryStore {
  clearFails = false;
  override async clearIntradayVerdict(): Promise<void> {
    if (this.clearFails) throw new Error("slot down");
    return super.clearIntradayVerdict();
  }
}
/** The post-commit daily-roster sweep's bulk read fails, recording which slot was committed by then. */
class RosterSweepFailStore extends InMemoryStore {
  slotAtSweep: string | undefined;
  override async getSeriesBulk(...a: Parameters<InMemoryStore["getSeriesBulk"]>): Promise<Map<string, SeriesPoint[]>> {
    if (a[1].limit === GAP_FILL_DAYS + NOWCAST_MAX_CARRY_DAYS && a[1].range === undefined) {
      this.slotAtSweep = this.intradayVerdict?.firedAt;
      throw new Error("roster read down");
    }
    return super.getSeriesBulk(...a);
  }
}

/** Ids holding an `estimated` row that the EOD sweeps' roster (E3) would never delete. */
const unsweptEstimateIds = (): string[] => [
  ...new Set(
    store.readings
      .filter((r) => r.estimated === true && !([...ESTIMATE_ROW_IDS, ...quoteRepairIds()] as readonly string[]).includes(r.indicatorId))
      .map((r) => r.indicatorId),
  ),
];

describe("sovereign-quote live-quote head graft", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri) — the quote's "today"
  const QUOTE_UP = 0.05;
  // Distinct per-leg moves off the last bar, so the BONOS spread moves by a known amount; a graft that pins the head
  // to the last bar (the post-close change-graft defect) lands neither.
  const MOVE: Record<string, number> = { "ES10Y-ES": 0.07, "DE10Y-DE": 0.02 };
  const quoteOf = async (symbol: string): Promise<Observation> => ({
    date: NEXT,
    value: sovereignGreen(symbol).at(-1)!.value + (MOVE[symbol] ?? QUOTE_UP),
  });
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });
  const rowOf = async (firedAt: string, id: string, s: InMemoryStore = store) =>
    (await s.getReadingsForRun(firedAt)).find((r) => r.indicatorId === id);

  test("intraday then EOD with bars ending D-1: the daytime BONOS quote head (an older provisional head deleted) gives way to each card's EOD quote head, stored `estimated` at D", async () => {
    const quote = feeds.fetchSovereignQuote.mockImplementation(quoteOf);
    await store.recordReadings([makeStoredReading("BONOS", { date: NEXT, value: -999 })], `${NEXT}T10:00:00.000Z`); // a daytime bar head
    expect((await store.getSeries("BONOS", 1))[0]?.value).toBe(-999); // premise: provisional, and it would outrank an estimate
    const day = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T12:00:00.000Z`), { intraday: true });
    const atNext = (id: string) => store.readings.filter((r) => r.indicatorId === id && r.date === NEXT);
    expect(atNext("BONOS").map((r) => [r.estimated === true, r.runAt])).toEqual([[true, day.firedAt]]); // the -999 head deleted
    const barSpread = (sovereignGreen("ES10Y-ES").at(-1)!.value - sovereignGreen("DE10Y-DE").at(-1)!.value) * 100;
    const headSpread = barSpread + (MOVE["ES10Y-ES"]! - MOVE["DE10Y-DE"]!) * 100;
    const dayBonos = await rowOf(day.firedAt, "BONOS");
    expect(isProvisional({ date: dayBonos!.date, runAt: day.firedAt })).toBe(true);
    expect(dayBonos?.value).toBeCloseTo(headSpread, 8);
    const served = (await store.getSeries("BONOS", 1))[0];
    expect([served?.date, served?.estimated, served?.value]).toEqual([NEXT, true, dayBonos?.value]);
    expect(QUOTE_GRAFT_CARDS.filter((id) => !store.readings.some((r) => r.indicatorId === id && r.date === NEXT && r.estimated === true))).toEqual([]);
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    expect(quote).toHaveBeenCalledWith("ES10Y-ES", new Date(alert.firedAt)); // parsed against the run clock, not the wall
    const bonos = await rowOf(alert.firedAt, "BONOS");
    expect([bonos?.date, bonos?.estimated, bonos?.value]).toEqual([NEXT, true, expect.closeTo(headSpread, 8)]);
    // No card (nor CMP_ leg) holds a non-estimate D row — the daytime head deleted, nothing gap-filled FINAL; each card's D row is its run row.
    expect([...quoteRepairIds()].filter((id) => atNext(id).some((r) => r.estimated !== true))).toEqual([]);
    const runRows = await store.getReadingsForRun(alert.firedAt);
    expect(QUOTE_GRAFT_CARDS.filter((id) => !runRows.some((r) => r.indicatorId === id && r.date === NEXT && r.estimated === true))).toEqual([]);
    expect(unsweptEstimateIds()).toEqual([]);
  });

  test("EOD: a quote jump flips the card's scored D state off the D-1 bar's", async () => {
    // ES10Y's quote jumps 1pp: BONOS's scored D state differs from the D-1 bar's.
    feeds.fetchSovereignQuote.mockImplementation(async (s) => ({ ...(await quoteOf(s)), ...(s === "ES10Y-ES" ? { value: sovereignGreen(s).at(-1)!.value + 1 } : {}) }));
    const alert = await runCycleWith(feeds, store, monotonicClock(`${NEXT}T22:00:00.000Z`));
    const bonos = await rowOf(alert.firedAt, "BONOS");
    const bonosPrev = (await store.getSeries("BONOS", 10)).find((p) => p.date === FIXTURE_ASOF);
    expect([bonos?.date, bonos?.estimated, bonosPrev?.state]).toEqual([NEXT, true, "GREEN"]);
    expect(bonos?.state).not.toBe(bonosPrev?.state); // the scored state is the quote head's, not the D-1 bar's
  });

  test("EOD two sessions past the bars: BUND's unanchored quote head reaches neither the dial nor the run's rows — both read its last FINAL", async () => {
    const TUE = "2026-02-03";
    feeds.fetchSovereignQuote.mockImplementation(async (s) => ({ date: TUE, value: sovereignGreen(s).at(-1)!.value + (s === "DE10Y-DE" ? 1 : 0) }));
    // 02-02 reads as a closed session, so the TUE quote grafts straight onto the FIXTURE_ASOF bar — two sessions past it.
    feeds.graftQuoteLevel.mockImplementation((bars, q, s) => graftQuoteLevel(bars, q, s, (d) => d === "2026-02-02" || isTargetClosed(d)));
    const bundOn = (p: AlertRecord["panelState"]) => p?.globalPanel.flatMap((f) => f.members).find((m) => m.id === "BUND")?.state;
    // Control world (same inputs, intraday): a live head is never anchor-gated, so BUND's run row and dial member ARE the head.
    const ctl = new InMemoryStore();
    seedHyoasCalib(ctl);
    const day = await runCycleWith(feeds, ctl, monotonicClock(`${TUE}T12:00:00.000Z`), { intraday: true });
    const head = await rowOf(day.firedAt, "BUND", ctl);
    expect([head?.date, bundOn(day.panelState)]).toEqual([TUE, head?.state]); // premise: the head scores, and the dial member reads it
    // The EOD world's store fails the gate's stored-row read (an input): the gate anchors on the run's own prints.
    const own = new AnchorReadFailStore();
    seedHyoasCalib(own);
    feeds.graftQuoteLevel.mockClear();
    const alert = await runCycleWith(feeds, own, monotonicClock(`${TUE}T22:00:00.000Z`));
    expect(feeds.graftQuoteLevel.mock.results.some((r) => r.type === "return" && r.value.at(-1)?.date === TUE)).toBe(true); // premise: the head grafted
    const final = (await own.getSeries("BUND", 10)).find((p) => p.date === FIXTURE_ASOF)!;
    expect(head?.state).not.toBe(final.state); // premise: the dial assertion below can tell head from FINAL
    const bund = await rowOf(alert.firedAt, "BUND", own);
    expect([bund?.date, bund?.estimated, bund?.state]).toEqual([FIXTURE_ASOF, undefined, final.state]);
    expect(own.readings.filter((r) => r.indicatorId === "BUND" && r.date === TUE)).toEqual([]);
    expect([bundOn(alert.panelState), bundOn(alert.displayPanelState)]).toEqual([final.state, final.state]);
    // The cron hands the gate a degrade sink: the stored-row read failure lands on the persisted trace, not the console alone.
    expect((await own.getLastAlert())?.degraded).toContainEqual({ scope: "[anchor] stored-row read failed - anchoring on this run's prints only", reason: "anchor read down", effect: "notify" });
  });
});

describe("liveHead with an explicit leg (R2's intraday FRED head)", () => {
  const prints = [{ date: "2026-01-29", value: 4.5 }, { date: "2026-01-30", value: 4.4 }];
  const us10y = [{ date: "2026-01-30", value: 4.6 }, { date: "2026-02-02", value: 4.65 }];
  const quote = { date: "2026-02-02", value: 4.65 };
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });
  const graftOn = (day: string) => createGraft({ runAt: `${day}T12:00:00.000Z`, firedDateIso: day, feeds: feeds as FeedPorts } as unknown as RunBase);
  const head = (q: Observation | undefined) => {
    feeds.fetchSovereignQuote.mockResolvedValue(q);
    return graftOn("2026-02-02").liveHead("R2", prints, [us10y]);
  };

  test("a quote-dated US10Y head newer than the FRED print grafts a `proxyCarry` head, basis-shifted at the last shared date", async () => {
    expect((await head(quote)).at(-1)).toEqual({ date: "2026-02-02", value: expect.closeTo(4.45, 10), source: "proxyCarry", estimated: true });
  });

  test("a US10Y bar with no matching quote ⇒ no lag fill; a head dated a US source holiday never grafts (same `prints` reference)", async () => {
    expect(await head(undefined)).toBe(prints);
    expect(await head({ ...quote, date: "2026-02-03" })).toBe(prints);
    const PRESIDENTS_DAY = "2026-02-16";
    expect(isSourceHoliday("R2", PRESIDENTS_DAY)).toBe(true);
    const usOnHoliday = [us10y[0]!, { date: PRESIDENTS_DAY, value: 4.65 }];
    feeds.fetchSovereignQuote.mockResolvedValue({ date: PRESIDENTS_DAY, value: 4.65 });
    expect(await graftOn(PRESIDENTS_DAY).liveHead("R2", prints, [usOnHoliday])).toBe(prints);
  });

  test("a live quote head two sessions past the last FRED print still grafts — a live quote is intraday, never anchor-gated", async () => {
    const thu = prints.slice(0, 1);
    feeds.fetchSovereignQuote.mockResolvedValue(quote);
    const out = await graftOn("2026-02-02").liveHead("R2", thu, [[{ date: "2026-01-29", value: 4.6 }, us10y[1]!]]);
    expect(out.at(-1)).toEqual({ date: "2026-02-02", value: expect.closeTo(4.55, 10), source: "proxyCarry", estimated: true });
  });
});

describe("createGraft: the sovereign-quote legs + the registry-resolved daytime head", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri)
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });
  const graftAt = (day: string, s: InMemoryStore = store) =>
    createGraft({ runAt: `${day}T12:00:00.000Z`, firedDateIso: day, store: s, feeds: feeds as FeedPorts, markFallbackSourced: () => {} } as unknown as RunBase);

  test("a quote dated a TARGET holiday is grafted BEFORE the TARGET drop, so it never lands", async () => {
    const [THU, GOOD_FRIDAY] = ["2026-04-02", "2026-04-03"];
    const [bars, quote] = [sovereignGreen("ES10Y-ES", THU), { date: GOOD_FRIDAY, value: 3.5 }];
    feeds.fetchSovereignBars.mockResolvedValue(bars);
    feeds.fetchSovereignQuote.mockResolvedValue(quote);
    expect(graftQuoteLevel(bars, quote).at(-1)?.date).toBe(GOOD_FRIDAY); // premise: the quote grafts
    expect((await graftAt(GOOD_FRIDAY).sovereignLeg("ES10Y-ES")()).at(-1)?.date).toBe(THU);
  });

  test("quote feed down: the quote degrades to none, records a notify event, and the leg stays on its bars", async () => {
    feeds.fetchSovereignQuote.mockRejectedValue(new Error("boom"));
    const g = graftAt(NEXT);
    resetDegradeLog();
    expect([await g.quoteOf("ES10Y-ES"), (await g.sovereignLeg("ES10Y-ES")()).at(-1)?.date]).toEqual([undefined, FIXTURE_ASOF]);
    expect(drainDegradeLog()).toEqual([{ scope: "[sovereign-quote] ES10Y-ES restQuote unavailable - EOD bars only", reason: "Error: boom", effect: "notify" }]);
    const prints = [{ date: FIXTURE_ASOF, value: 4 }];
    expect((await g.liveHead("R2", prints, [sovereignGreen("US10Y", NEXT)])).at(-1)?.date).toBe(FIXTURE_ASOF);
  });

  test("R1 takes a head only when EVERY spread leg's quote is dated it — a quote-less leg's NEXT bar never lag-fills", async () => {
    const leads = estimatorOf("R1", "carry-level").leads;
    const legs = leads.map((s) => [...sovereignGreen(s), { date: NEXT, value: sovereignGreen(s).at(-1)!.value }]);
    const prints = [{ date: FIXTURE_ASOF, value: 1 }];
    const head = (quoted: readonly string[]) => {
      feeds.fetchSovereignQuote.mockImplementation(async (s) => (quoted.includes(s) ? { date: NEXT, value: 1 } : undefined));
      return graftAt(NEXT).liveHead("R1", prints, legs);
    };
    expect((await head(leads)).at(-1)?.date).toBe(NEXT);
    expect(await head(leads.slice(0, 1))).toBe(prints);
  });

  test("a US leg's quote graft walks back across a US-only holiday (review I2): R2's head lands on the session after it", async () => {
    const [fri, tue] = ["2026-02-13", "2026-02-17"]; // Mon 02-16 Presidents Day: NYSE closed, TARGET open, no sovereign-quote bar
    feeds.fetchSovereignBars.mockImplementation(async (s) => sovereignGreen(s, fri));
    feeds.fetchSovereignQuote.mockImplementation(async (s) => ({ date: tue, value: sovereignGreen(s, fri).at(-1)!.value + 0.11 }));
    expect((await graftAt(tue).liveHead("R2", [{ date: fri, value: 4 }])).at(-1)).toMatchObject({ date: tue, value: expect.closeTo(4.11, 10) });
  });

  test("liveHead: a rejecting estimator-legs resolve is a recorded degrade and the prints stay head-less", async () => {
    feeds.fetchSovereignBars.mockRejectedValue(new Error("bars down"));
    const prints = [{ date: FIXTURE_ASOF, value: 4 }];
    resetDegradeLog();
    expect(await graftAt(NEXT).liveHead("R2", prints)).toBe(prints);
    expect(drainDegradeLog().map((d) => d.scope)).toContain("[graft] R2 estimator legs unavailable - no live head");
  });
});

describe("intraday run: silent, no alert row; the prior fired-day's dial band still feeds the lag hold", () => {
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });

  test("intraday run: persists readings, pushes nothing, writes no alert row", async () => {
    // F1 (BAMLH0A0HYM2, HY OAS) STEPPING to 7.0 — clearing BOTH registry Red legs, see `f1RedBothLegs` —
    // ⇒ confirmed RED ⇒ hard CRITICAL. The intraday run MUST stay silent and leave the notify baseline
    // untouched: had it written its CRITICAL alert row, the EOD run would read "same band" and never push.
    feeds.fetchSeries.mockImplementation(async (series) =>
      series === "BAMLH0A0HYM2" ? f1RedBothLegs(7) : fredMock(series),
    );

    const notify = fakeNotify();
    const intraday = await runCycleWith(feeds, store, monotonicClock("2026-01-30T10:00:00.000Z"), { intraday: true, notify });
    expect(intraday.level).toBe("CRITICAL");
    expect(intraday.pushedAt).toBeNull();
    expect(notify.pushNtfy).not.toHaveBeenCalled();
    expect(store.alerts).toHaveLength(0);
    expect((await store.getSeries("F1", 1)).length).toBe(1);
    // C3: the intraday seed tail — input series + pre-today leg closes — runs.
    expect((await store.getSeries("HYG", 1)).length).toBe(1);
    expect((await store.getSeries(legCloseId("Semis"), 1)).map((p) => p.date)).toEqual(["2026-01-29"]); // never today's bar
    // No SB NAV row: the chain never rewrites a stored date, so an intraday NAV would be permanent.
    expect(await store.getSeries(SB_STRAT_ID, 1)).toEqual([]);
  });

  // One calm intraday cycle carries both: the prior CRITICAL row only feeds the lag window, the defer flag only gates the seed tail.
  test("the real cycle feeds the prior fired-day's dial band into the N=2 de-escalation hold; N3: `deferIntradaySeed` skips the inline seed tail, `seedIntradayTail` runs it standalone", async () => {
    await store.recordAlert(priorAlert({ date: "2026-01-29", firedAt: "2026-01-29T21:00:00.000Z", level: "CRITICAL", dialBand: "CRITICAL" }));
    const a = await runCycleWith(feeds, store, monotonicClock("2026-01-30T10:00:00.000Z"), { intraday: true, deferIntradaySeed: true });
    expect([a.dialBand, a.level, a.bandReason]).toEqual(["OK", "CRITICAL", "lag-hold"]);
    expect((await store.getSeries("F1", 1)).length).toBe(1);
    expect(await store.getSeries("HYG", 1)).toEqual([]);
    expect(await store.getSeries(legCloseId("Semis"), 1)).toEqual([]);
    await seedIntradayTail(readEnv(), monotonicClock("2026-01-30T10:01:00.000Z"), { store, feeds });
    expect((await store.getSeries("HYG", 1)).length).toBe(1);
    // [USER] 2026-10-05: the leg closes a past EOD missed land intraday — dated before today, so FINAL; today's stays the EOD's.
    const legs = await store.getSeries(legCloseId("Semis"), 1);
    expect(legs.map((p) => ({ date: p.date, provisional: isProvisional(p) }))).toEqual([{ date: "2026-01-29", provisional: false }]);
  });
});

describe("intraday verdict slot + nowcast scoring", () => {
  const NEXT = "2026-02-02"; // the business day after FIXTURE_ASOF (Fri)
  const NOWCAST_SYMBOLS = new Set(NOWCAST_LEG_SYMBOLS);
  // The oil futures print a NEXT-day bar (+2%), TIP +3% over IEF +1% (E11); every other symbol is the calm fixture.
  const NEXT_MOVE: Record<string, number> = { [T10YIE_EST.leads[0]]: 1.03, [T10YIE_EST.leads[1]]: 1.01 };
  const proxiesWithNextBar = async (symbol: string): Promise<Observation[]> => {
    const base = await priceCalm(symbol);
    if (!NOWCAST_SYMBOLS.has(symbol) && NEXT_MOVE[symbol] === undefined) return base;
    const last = base.at(-1)!;
    return [...base, { date: NEXT, value: last.value * (NEXT_MOVE[symbol] ?? 1.02) }];
  };
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds({ fetchDailyCloses: proxiesWithNextBar });
  });
  const run = (hhmm: string, opts: { intraday?: true; rederive?: false } = {}, s: InMemoryStore = store) =>
    runCycleWith(feeds, s, monotonicClock(`${NEXT}T${hhmm}:00.000Z`), opts);
  const rowOf = async (firedAt: string, id: string) =>
    (await store.getReadingsForRun(firedAt)).find((r) => r.indicatorId === id);

  test("intraday: the verdict lands in the slot, G1/BRENT rows are the provisional NEXT `estimated` row; EOD: the run's rows stay prints, G1/BRENT persist a final `estimated` NEXT row, the slot is cleared", async () => {
    const memo = feeds.startFredMemo; // the arm call IS the behaviour — no store state records it
    const day = await run("12:00", { intraday: true });
    expect(memo).toHaveBeenLastCalledWith({ intraday: true }); // C2: the run arms the index publisher's keep-today rule
    expect(store.alerts).toHaveLength(0);
    expect(store.intradayVerdict?.firedAt).toBe(day.firedAt);
    for (const id of ["G1", "BRENT"]) {
      const row = await rowOf(day.firedAt, id);
      expect([row?.date, row?.estimated], id).toEqual([NEXT, true]);
      expect(isProvisional({ date: row!.date, runAt: day.firedAt }), id).toBe(true);
    }
    // F2 has no nowcast leg; F1 left the roster (E8) ⇒ their rows stay the FRED print.
    for (const id of ["F1", "F2"]) expect((await rowOf(day.firedAt, id))?.date, id).toBe(FIXTURE_ASOF);
    const eod = await run("22:00");
    expect(memo).toHaveBeenLastCalledWith({ intraday: false });
    expect(store.intradayVerdict).toBeNull();
    expect(store.alerts).toHaveLength(1);
    for (const id of ["F1", "G1", "BRENT"]) expect((await rowOf(eod.firedAt, id))?.date, id).toBe(FIXTURE_ASOF);
    for (const id of ["G1", "BRENT"]) {
      const newest = (await store.getSeries(id, 1)).at(-1)!;
      expect([newest.date, newest.estimated, isProvisional(newest)], id).toEqual([NEXT, true, false]); // E3: survives EOD
    }
    // No print or estimate for NEXT ⇒ a gap.
    for (const id of ["F1"]) expect((await store.getSeries(id, 1)).map((p) => p.date), id).toEqual([FIXTURE_ASOF]);
    // E11: T10YIE's run row stays the FRED print; its estimate row carries the print over ln(TIP/IEF).
    const t10yie = (await store.getSeries("T10YIE", 2)).slice(-2);
    expect(t10yie.map((p) => [p.date, p.estimated === true])).toEqual([[FIXTURE_ASOF, false], [NEXT, true]]);
    expect(t10yie[1]!.value).toBeCloseTo(t10yie[0]!.value + T10YIE_EST.beta * Math.log(1.03 / 1.01), 10);
    expect(unsweptEstimateIds()).toEqual([]);
    expect(day.firedAt < eod.firedAt).toBe(true);
  });

  test("I6 with the oil lane alone: two intraday runs still leave ONE `estimated` G1/BRENT head per (id, date)", async () => {
    feeds.fetchDailyCloses.mockImplementation(async (symbol) => (NOWCAST_SYMBOLS.has(symbol) ? proxiesWithNextBar(symbol) : priceCalm(symbol)));
    for (const hh of ["14", "15"]) await run(`${hh}:00`, { intraday: true });
    const est = store.readings.filter((r) => r.estimated === true);
    expect([...new Set(est.map((r) => r.indicatorId))].sort()).toEqual(["BRENT", "G1"]); // premise: no other lane estimated
    expect(est.map((r) => `${r.indicatorId}@${r.date}`).sort()).toEqual([`BRENT@${NEXT}`, `G1@${NEXT}`]);
  });

  test("estimateAnchored: a multi-session oil gap lands ONE `estimated` G1/BRENT row, the first session past the print (never a chained one); a weekend lead bar lands nothing", async () => {
    const SUNDAY = "2026-02-01";
    const TUE = "2026-02-03";
    feeds.fetchDailyCloses.mockImplementation(async (symbol) => {
      const base = await proxiesWithNextBar(symbol);
      const next = base.at(-1)!;
      if (next.date !== NEXT) return base;
      return [...base.slice(0, -1), { date: SUNDAY, value: next.value * 0.99 }, next, { date: TUE, value: next.value * 1.01 }];
    });
    await runCycleWith(feeds, store, monotonicClock(`${TUE}T12:00:00.000Z`), { intraday: true });
    const oil = store.readings.filter((r) => ["G1", "BRENT"].includes(r.indicatorId) && r.date > FIXTURE_ASOF);
    expect(oil.map((r) => `${r.indicatorId}@${r.date}:${r.estimated === true}`).sort()).toEqual(
      [`BRENT@${NEXT}:true`, `G1@${NEXT}:true`],
    );
    expect([store.readings.some((r) => r.indicatorId === "T10YIE" && r.date === NEXT), store.readings.some((r) => r.indicatorId === "T10YIE" && r.date === TUE), store.readings.filter((r) => r.date === SUNDAY && r.estimated === true).map((r) => r.indicatorId)]).toEqual([true, false, []]);
  });

  test("EOD supersedes the daytime run: its alert row is the served verdict even when the slot clear fails", async () => {
    const own = new SlotClearFailStore();
    seedHyoasCalib(own);
    const day = await run("12:00", { intraday: true }, own);
    own.clearFails = true;
    const eod = await run("22:00", {}, own);
    expect(own.intradayVerdict?.firedAt).toBe(day.firedAt); // premise: the clear really failed
    expect(servedVerdict(await own.getLastAlert(), await own.getIntradayVerdict())?.firedAt).toBe(eod.firedAt);
  });

  test("the slot commits WITH the readings, before the post-commit sweeps; a sweep's degrade still reaches the slot's trace", async () => {
    const own = new RosterSweepFailStore();
    seedHyoasCalib(own);
    const day = await run("12:00", { intraday: true }, own);
    expect(own.slotAtSweep).toBe(day.firedAt);
    expect(own.intradayVerdict?.degraded?.map((d) => d.scope)).toContain("[estimate-sweep] daily-roster read failed - superseded/unanchored rows linger");
  });

  test("rederive:false = readings only: an earlier daytime verdict is EMPTIED, never left beside the newer readings", async () => {
    await store.putIntradayVerdict(makeAlert({ date: NEXT, firedAt: `${NEXT}T10:00:00.000Z` }));
    expect(store.intradayVerdict).not.toBeNull();
    const alert = await run("12:00", { intraday: true, rederive: false });
    expect(store.intradayVerdict).toBeNull();
    expect(store.alerts).toHaveLength(0);
    expect((await rowOf(alert.firedAt, "F2"))?.date).toBe(FIXTURE_ASOF);
  });

});

describe("an EOD estimate head folds into the notify AND display dials; a failed-gate estimator's into display_* only", () => {
  const NEXT = "2026-02-02";
  let feeds: FakeFeeds;
  beforeEach(() => {
    feeds = fakeFeeds();
  });
  // US10Y's NEXT quote is R2's estimate lead: quoted ⇒ the run writes an R2 estimate row; unquoted ⇒ none (the base world).
  // The jump clears R2's Red velocity cut (derived, so a retune never strands it under). US3M stays unquoted, so R1 never heads.
  const R2_ID = R2.id;
  const quoteR2 = (quoted: boolean) =>
    feeds.fetchSovereignQuote.mockImplementation(async (s) =>
      quoted && s === "US10Y" ? { date: NEXT, value: sovereignGreen(s).at(-1)!.value + 2 * R2.thresholds.redVelocity! } : undefined,
    );
  // One fresh store per world: `estimate` writes this run's R2 estimate row; the base world writes none.
  const runWorld = async (estimate: boolean) => {
    const s = new InMemoryStore();
    seedHyoasCalib(s);
    // A daytime (provisional) G1 head from an earlier run today — the notify assembly must not read it.
    await s.recordReadings([{ date: NEXT, indicatorId: "G1", value: 1, delta20: 0, rawState: "RED", state: "RED", decision: null, estimated: true }], `${NEXT}T12:00:00.000Z`);
    quoteR2(estimate);
    const notify = fakeNotify();
    const alert = await runCycleWith(feeds, s, monotonicClock(`${NEXT}T22:00:00.000Z`), { notify });
    const r2Estimate = s.readings.some((r) => r.indicatorId === R2_ID && r.date === NEXT && r.estimated === true);
    return { alert, r2Estimate, pushes: [notify.pushNtfy.mock.calls, notify.sendBandEmail.mock.calls] };
  };
  const r2 = (p: AlertRecord["panelState"]) => p?.globalPanel.flatMap((f) => f.members).find((m) => m.id === R2_ID)?.state;
  // The whole persisted row minus the two display columns — the only fields a failed-gate estimate may move.
  // `run_inputs.heads` records every head the run wrote (the display dial folds them all) — an input, not the verdict.
  // The stamps are asOf-relative freshness records of the inputs, not the verdict.
  const notifyView = ({ displayDialState: _d, displayPanelState: _p, timings: _t, runInputs, ...rest }: AlertRecord) => ({
    ...rest,
    runInputs: runInputs && {
      ...runInputs,
      heads: undefined,
      stamps: undefined,
      globalReadings: runInputs.globalReadings?.map(({ stamp: _s, ...g }) => g),
    },
  });
  type World = Awaited<ReturnType<typeof runWorld>>;
  const expectNotifyUnmoved = (base: World, est: World) => {
    expect(base.pushes[0]).toHaveLength(1); // premise: a push fired, so push-equality is not vacuous
    expect(est.pushes).toEqual(base.pushes);
    expect(notifyView(est.alert)).toEqual(notifyView(base.alert));
  };

  const failedGate = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    const set = GATE_FAILED_ESTIMATORS as Set<string>;
    set.add(id);
    try {
      return await run();
    } finally {
      set.delete(id);
    }
  };
  const g1Red = (p: AlertRecord["panelState"]) => p?.cissHistory.find((h) => h.id === "G1")?.history.some((x) => x.state === "RED");

  // Control = the SAME prints with no NEXT oil bar, so no G1 head reaches either dial (no estimate row ⇒ display ≡ notify).
  const runShock = async (shock: boolean) => {
    const OIL = new Set(NOWCAST_LEG_SYMBOLS);
    feeds.fetchDailyCloses.mockImplementation(async (sym) => {
      const b = await priceCalm(sym);
      return shock && OIL.has(sym) ? [...b, { date: NEXT, value: b.at(-1)!.value * (sym === "CL=F" ? 1.8 : 1.02) }] : b;
    });
    const s = new InMemoryStore();
    seedHyoasCalib(s);
    const alert = await runCycleWith(feeds, s, monotonicClock(`${NEXT}T22:00:00.000Z`));
    return { alert, g1Heads: s.readings.filter((r) => r.indicatorId === "G1" && r.date === NEXT && r.estimated === true).length };
  };

  test("a G1 shock estimate flips geopolitics on panel_state and display_panel_state; the head-less control flips neither", async () => {
    const { alert: ctl, g1Heads: ctlHeads } = await runShock(false);
    const { alert: est, g1Heads: estHeads } = await runShock(true);
    expect([ctlHeads, estHeads]).toEqual([0, 1]); // premise: the worlds differ by the G1 head alone
    const g1 = (p: AlertRecord["panelState"]) => p?.globalPanel.flatMap((f) => f.members).find((m) => m.id === "G1")?.state;
    expect([g1(est.panelState), g1(est.displayPanelState)]).toEqual(["AMBER", "AMBER"]);
    expect([g1(ctl.panelState), g1(ctl.displayPanelState)]).toEqual(["GREEN", "GREEN"]);
    expect([ctl.displayPanelState, ctl.displayDialState]).toEqual([ctl.panelState, ctl.dialState]);
  });

  // F1 AMBER arms the dial and MOVE (R6) RED pre-loads rates' legP, so R2's estimate alone carries the regime across a `DIAL_REGIME_CUTS` cut.
  test("an R2 estimate crossing the regime cut moves the notify regime, dial_state AND display_dial_state (the daytime G1 row on display only); a failed-gate one leaves dialBand, push and every notify column at base", async () => {
    feeds.fetchSeries.mockImplementation(async (series) => (series === "BAMLH0A0HYM2" ? fredFlat(3.05) : fredMock(series)));
    feeds.fetchDailyCloses.mockImplementation(async (sym) =>
      sym === "^MOVE" ? moveFlat().map((x) => ({ ...x, value: x.value + 150 })) : priceCalm(sym),
    );
    const baseWorld = await runWorld(false);
    const estWorld = await runWorld(true);
    expect([baseWorld.r2Estimate, estWorld.r2Estimate]).toEqual([false, true]); // premise: the worlds differ by the R2 estimate
    const [base, est] = [baseWorld.alert, estWorld.alert];
    expect([base.dialState!.regime, est.dialState!.regime, est.displayDialState!.regime]).toEqual(["Caution", "Crisis", "Crisis"]);
    expect([r2(base.panelState), r2(est.panelState), r2(est.displayPanelState)]).toEqual(["GREEN", "RED", "RED"]);
    // The head the notify dial scored RED names itself on the push body's R2 line; the head-less base's body has no R2 line.
    const r2Line = (w: World) => w.pushes[0]![0]![0].body.split("\n").find((l) => l.startsWith(`${R2.label}: `));
    expect([baseWorld.pushes[0], estWorld.pushes[0]].map((p) => p!.length)).toEqual([1, 1]); // premise: both bodies exist
    expect(r2Line(estWorld)).toMatch(/ \(GREEN\) · .* · est\. [\d.]+% \(RED\)$/);
    expect(r2Line(baseWorld)).toBeUndefined();
    expect(est.dialState!.rung).toBeGreaterThan(base.dialState!.rung);
    expect(est.displayDialState!.rung).toBeGreaterThan(base.displayDialState!.rung);
    expect([g1Red(est.panelState), g1Red(est.displayPanelState)]).toEqual([false, true]);
    expect([g1Red(base.panelState), g1Red(base.displayPanelState)]).toEqual([false, true]);
    const gated = await failedGate(R2_ID, () => runWorld(true));
    expect([gated.alert.dialState!.regime, gated.alert.displayDialState!.regime]).toEqual(["Caution", "Crisis"]);
    expect(gated.alert.dialBand).toBe(base.dialBand);
    expectNotifyUnmoved(baseWorld, gated);
  });
});
