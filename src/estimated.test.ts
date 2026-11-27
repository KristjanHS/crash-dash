import { describe, expect, test } from "vitest";
import { ANCHOR_ROSTER, dropUnanchoredEstimates, estimateAnchored, estimateDatesOf, gateUnanchoredReadings, notifyObservationOn, isObservation, keptRows, mergeHeadEstimates, pickRecent, stampEstimated, stampEstimateSourced, sweepRosterEstimates, sweepSupersededEstimates, notifyHeadEstimates, unanchoredEstimateDates, withEstimateHeads, withoutEstimateSourced } from "./estimated.js";
import { prevSession } from "./source-holidays.js";
import { legCloseId, SB_STRAT_ID } from "./scoreboard.js";
import { INDICATORS } from "./registry-fred.js";
import { G1 } from "./registry-geo.js";
import type { Indicator, Reading } from "./domain-types.js";
import { InMemoryStore } from "./store-memory.js";
import type { SeriesPoint, StoredReading } from "./store.js";

const D = "2026-10-02";
const row = (runAt: string, estimated?: boolean) => ({ runAt, ...(estimated === undefined ? {} : { estimated }) });

describe("pickRecent — E7 order (estimated asc, run_at desc, id desc)", () => {
  test("a final row beats a NEWER estimate, from either side", () => {
    const final = row(`${D}T22:00:00Z`);
    const est = row(`${D}T23:00:00Z`, true);
    expect(pickRecent(final, est)).toBe(final);
    expect(pickRecent(est, final)).toBe(final);
  });

  test("same class: newest runAt wins; an equal runAt goes to the later insert (`next`)", () => {
    const a = row(`${D}T10:00:00Z`, true);
    const b = row(`${D}T11:00:00Z`, true);
    expect(pickRecent(b, a)).toBe(b);
    expect(pickRecent(a, b)).toBe(b);
    const tie = row(`${D}T10:00:00+00:00`, false);
    expect(pickRecent(a, row(`${D}T10:00:00Z`, true))).not.toBe(a);
    expect(pickRecent(row(`${D}T10:00:00Z`), tie)).toBe(tie); // `+00:00` vs `Z` compare as instants
    expect(pickRecent(undefined, a)).toBe(a);
  });
});

const reading = (over: Partial<StoredReading>): StoredReading => ({
  date: D,
  indicatorId: "F1",
  value: 1,
  delta20: 0,
  rawState: "GREEN",
  state: "GREEN",
  decision: null,
  ...over,
});

describe("sweepSupersededEstimates — E3: the estimate dies the run its print lands", () => {
  test("print lands → estimate row gone, and the latest read returns the print", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ value: 7, estimated: true })], `${D}T18:31:00.000Z`);
    expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(0); // no print yet: the estimate stays
    expect(await store.getSeries("F1", 5)).toMatchObject([{ date: D, value: 7, estimated: true }]);

    await store.recordReadings([reading({ value: 9 })], `${D}T22:00:00.000Z`);
    expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(1);
    expect(store.readings.filter((r) => r.date === D).map((r) => [r.value, r.estimated])).toEqual([[9, undefined]]);
    const [served] = await store.getSeries("F1", 5);
    expect(served).toMatchObject({ date: D, value: 9 });
    expect(served).not.toHaveProperty("estimated");
  });

  test("an estimate on a date a later print skipped (a source holiday) is swept; one past the newest print stays", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ date: "2026-08-31", value: 7, estimated: true }), reading({ date: "2026-09-02", value: 8, estimated: true })], "2026-09-02T22:00:00.000Z");
    await store.recordReadings([reading({ date: "2026-09-01", value: 9 })], "2026-09-03T22:00:00.000Z");
    expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(1);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => r.date)).toEqual(["2026-09-02"]);
  });

  test("a monthly row's estimate is no orphan: a FINAL next month (a graft-failure run) sweeps only its own date, never a hole", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ date: "2026-08-01", value: 7, estimated: true }), reading({ date: "2026-09-01", value: 8, estimated: true })], "2026-09-10T22:00:00.000Z");
    await store.recordReadings([reading({ date: "2026-09-01", value: 9 })], "2026-09-11T22:00:00.000Z");
    expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(1);
    expect((await store.getSeries("F1", 5)).map((p) => [p.date, p.value, p.estimated])).toEqual([["2026-08-01", 7, true], ["2026-09-01", 9, undefined]]);
  });

  test("a PROVISIONAL quote is served over the estimate but does not sweep it", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ value: 7, estimated: true })], `${D}T15:00:00.000Z`);
    await store.recordReadings([reading({ value: 8 })], `${D}T14:00:00.000Z`); // older, but a quote beats an estimate
    expect((await store.getSeries("F1", 5)).map((p) => p.value)).toEqual([8]);
    expect(await sweepSupersededEstimates(store, "F1", 14)).toBe(0);
    expect(store.readings.some((r) => r.estimated === true)).toBe(true);
  });
});

describe("sweepRosterEstimates — E3 + `estimateAnchored` over one bulk read", () => {
  test("per id: a printed-over estimate dies; an estimate past the newest print stays", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ date: "2026-09-30", value: 7, estimated: true }), reading({ indicatorId: "F2", date: "2026-09-30" })], "2026-09-30T18:00:00.000Z");
    await store.recordReadings([reading({ date: "2026-09-30", value: 9 }), reading({ date: "2026-10-01", value: 8, estimated: true })], "2026-09-30T22:00:00.000Z");
    await sweepRosterEstimates(store, ["F1", "F2"], 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => `${r.indicatorId}@${r.date}`)).toEqual(["F1@2026-10-01"]);
  });

  test("an estimate chained onto another estimate dies; the one anchored on the print stays", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ date: "2026-09-30" }), reading({ date: "2026-10-01", estimated: true }), reading({ date: D, estimated: true })], `${D}T22:00:00.000Z`);
    await sweepRosterEstimates(store, ["F1"], 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => r.date)).toEqual(["2026-10-01"]);
  });

  test("`ANCHOR_ROSTER` sweeps the chained display lines: a LEGP_* and an SB_* estimate chained onto an estimate die", async () => {
    const store = new InMemoryStore();
    const ids = [legCloseId("Semis"), SB_STRAT_ID];
    await store.recordReadings(ids.flatMap((indicatorId) => [
      reading({ indicatorId, date: "2026-09-28" }), reading({ indicatorId, date: "2026-09-29", estimated: true }),
      reading({ indicatorId, date: "2026-10-01", estimated: true }), reading({ indicatorId, date: D, estimated: true }),
    ]), `${D}T22:00:00.000Z`);
    await sweepRosterEstimates(store, ANCHOR_ROSTER, 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => `${r.indicatorId}@${r.date}`)).toEqual(ids.map((id) => `${id}@2026-09-29`));
  });

  test("a settled EU-leg close stored `estimated` anchors only when itself anchored: past a gap every one dies in ONE sweep, as the US line's", async () => {
    const store = new InMemoryStore();
    const [eu, us] = [legCloseId("EU-Fin"), SB_STRAT_ID];
    await store.recordReadings([eu, us].flatMap((indicatorId) => [
      reading({ indicatorId, date: "2026-09-28" }), reading({ indicatorId, date: "2026-09-29", estimated: true }),
      reading({ indicatorId, date: "2026-10-01", estimated: true }), reading({ indicatorId, date: D, estimated: true }),
    ]), `${D}T22:00:00.000Z`);
    await sweepRosterEstimates(store, [eu, us], 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => `${r.indicatorId}@${r.date}`)).toEqual([`${eu}@2026-09-29`, `${us}@2026-09-29`]);
  });

  test("an intraday (provisional) head two sessions past the last FINAL stays and is never listed; the same head at EOD dies", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ indicatorId: "G1", date: "2026-09-30" })], "2026-09-30T22:00:00.000Z");
    await store.recordReadings([reading({ indicatorId: "G1", date: D, estimated: true })], `${D}T12:00:00.000Z`);
    expect(unanchoredEstimateDates("G1", await store.getSeries("G1", 5))).toEqual([]);
    await sweepRosterEstimates(store, ["G1"], 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => `${r.indicatorId}@${r.date}`)).toEqual([`G1@${D}`]);
    await store.recordReadings([reading({ indicatorId: "G1", date: D, estimated: true })], `${D}T22:00:00.000Z`);
    await sweepRosterEstimates(store, ["G1"], 14);
    expect(store.readings.filter((r) => r.estimated === true)).toEqual([]);
  });
});

describe("QUOTE_HEAD_IDS — a sovereign-quote quote head survives EOD unanchored", () => {
  test("an EOD-stamped R2 and BONOS estimate two sessions past the last FINAL stay; F1's dies", async () => {
    const store = new InMemoryStore();
    const ids = ["R2", "BONOS", "F1"];
    await store.recordReadings(ids.map((indicatorId) => reading({ indicatorId, date: "2026-09-30" })), "2026-09-30T22:00:00.000Z");
    await store.recordReadings(ids.map((indicatorId) => reading({ indicatorId, date: D, estimated: true })), `${D}T22:00:00.000Z`);
    await sweepRosterEstimates(store, ids, 14);
    expect(store.readings.filter((r) => r.estimated === true).map((r) => r.indicatorId)).toEqual(["R2", "BONOS"]);
  });

  test("the notify read (`keptRows`) ends on the FINAL the dial's gate reads; the chart read keeps every quote head", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([reading({ indicatorId: "BUND", date: "2026-09-29" })], "2026-09-29T22:00:00.000Z");
    for (const date of ["2026-09-30", "2026-10-01"]) await store.recordReadings([reading({ indicatorId: "BUND", date, rawState: "RED", state: "RED", estimated: true })], `${date}T22:00:00.000Z`);
    const bund = { indicator: { id: "BUND" } as Indicator, date: "2026-10-01", level: 3, delta20: 0, rawState: "RED", state: "RED" } as Reading;
    const [gated] = await gateUnanchoredReadings([bund], { runAt: "2026-10-01T22:00:00.000Z", sourced: new Map([["BUND", new Set(["2026-10-01"])]]), carried: new Map() }, store);
    const series = await store.getSeries("BUND", 10);
    const lastOf = (rows: SeriesPoint[], keep: typeof isObservation, id = "BUND") => keptRows(id, rows, keep).at(-1)?.date;
    expect(ANCHOR_ROSTER.includes("CMP_BUND_DE2Y")).toBe(false); // an ungated quote leg: the gate never swaps it
    const notify = notifyObservationOn("2026-10-01");
    expect([gated?.date, lastOf(series, notify), lastOf(series, isObservation), lastOf(series.slice(0, 2), notify), lastOf(series, notify, "CMP_BUND_DE2Y")])
      .toEqual(["2026-09-29", "2026-09-29", "2026-10-01", "2026-09-30", "2026-10-01"]);
  });

  // A kept intraday estimate (its own daytime `runAt`) read on a later day is gap-judged as its EOD-stamped twin was.
  test("the notify read a day later ends a kept intraday quote head on the last FINAL when unanchored, on the head when anchored", () => {
    const at = (date: string, runAt: string, estimated?: true): SeriesPoint =>
      ({ date, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", runAt, ...(estimated ? { estimated } : {}) }) as SeriesPoint;
    const final = (date: string) => at(date, `${date}T22:00:00.001Z`);
    const intraday = (date: string) => at(date, `${date}T12:00:00.000Z`, true);
    const finals = ["2026-10-29", "2026-10-30", "2026-11-02"].map(final);
    const notify = notifyObservationOn("2026-11-05");
    const headOn = (rows: SeriesPoint[]) => keptRows("BUND", rows, notify).at(-1)?.date;
    expect([
      headOn([...finals, intraday("2026-11-04")]), // no 11-03 print: unanchored
      headOn([...finals, final("2026-11-03"), intraday("2026-11-04")]),
      headOn([...finals, final("2026-11-03"), intraday("2026-11-04"), intraday("2026-11-05")]), // the run day's own head stays exempt
    ]).toEqual(["2026-11-02", "2026-11-04", "2026-11-04"]);
  });

  test("the notify read folds a provisional `estimated` row from the day after its date — never on it, never a non-estimate", () => {
    const daytime = { date: D, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", runAt: `${D}T15:00:00.000Z` } as SeriesPoint;
    const est = { ...daytime, estimated: true as const };
    const kept = (today: string) =>
      [["R2", est], ["R2", daytime]].map(([id, p]) => notifyObservationOn(today)(id as string, p as SeriesPoint));
    expect([kept(D), kept("2026-10-05")]).toEqual([[false, false], [true, false]]);
  });

  test("the writers' gate keeps a card's unanchored EOD quote row and drops a US line's", () => {
    const us = SB_STRAT_ID;
    const stored = new Map(["BONOS", us].map((id): [string, SeriesPoint[]] => [id, [{ date: "2026-09-30", value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", runAt: "2026-09-30T22:00:00.000Z" }]]));
    const rows = ["BONOS", us].map((indicatorId) => reading({ indicatorId, date: D, estimated: true }));
    expect(dropUnanchoredEstimates(rows, stored, `${D}T22:00:00.000Z`).map((r) => r.indicatorId)).toEqual(["BONOS"]);
  });
});

describe("dropUnanchoredEstimates — the estimate writers' gate", () => {
  const [eu, us] = [legCloseId("EU-Fin"), SB_STRAT_ID];
  const storedAt = (date: string, estimated?: boolean) =>
    new Map([eu, us].map((id): [string, SeriesPoint[]] => [id, [{ date, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", runAt: `${date}T22:00:00.000Z`, ...(estimated ? { estimated } : {}) }]]));
  const rowsOn = (date: string) => [eu, us].map((indicatorId) => reading({ indicatorId, date, estimated: true }));

  test("at EOD an EU leg's settled close past a gap is judged like any estimate: both legs dropped", () => {
    expect(dropUnanchoredEstimates(rowsOn(D), storedAt("2026-09-30"), `${D}T22:00:00.000Z`)).toEqual([]);
  });

  test("a stored settled EU close on the previous session anchors the EU leg; the US line's estimate there is no FINAL", () => {
    expect(dropUnanchoredEstimates(rowsOn(D), storedAt("2026-10-01", true), `${D}T22:00:00.000Z`).map((r) => r.indicatorId)).toEqual([eu]);
  });

  test("settled EU closes chain in one call only off a FINAL: past a gap both drop, the second never anchored on the first", () => {
    const rows = ["2026-09-29", "2026-09-30"].map((date) => reading({ indicatorId: eu, date, estimated: true }));
    const runAt = "2026-09-30T22:00:00.000Z";
    const kept = (stored: string) => dropUnanchoredEstimates(rows, new Map([[eu, storedAt(stored).get(eu)!]]), runAt).map((r) => r.date);
    expect([kept("2026-09-25"), kept("2026-09-28")]).toEqual([[], ["2026-09-29", "2026-09-30"]]);
  });

  test("an intraday head on its own day stays unanchored; one dated a later session (forward-dated) is judged and dropped", () => {
    const stored = storedAt("2026-10-01");
    expect(dropUnanchoredEstimates(rowsOn("2026-10-01"), stored, "2026-10-01T12:00:00.000Z").map((r) => r.indicatorId)).toEqual([eu, us]);
    expect(dropUnanchoredEstimates(rowsOn("2026-10-05"), stored, `${D}T12:00:00.000Z`)).toEqual([]);
  });

  test("an EU leg's close written past its 17:05 UTC settle on its own day is judged, never an intraday head; the US line's head stays", () => {
    expect(dropUnanchoredEstimates(rowsOn(D), storedAt("2026-09-30"), `${D}T18:00:00.000Z`).map((r) => r.indicatorId)).toEqual([us]);
  });

  test("a catch-up of settled EU closes whose previous sessions precede the stored oldest row is unjudged by the bound: both kept, never the chained one alone", () => {
    const rows = ["2026-09-30", "2026-10-01"].map((date) => reading({ indicatorId: eu, date, estimated: true }));
    expect(dropUnanchoredEstimates(rows, new Map([[eu, storedAt("2026-10-05").get(eu)!]]), "2026-10-06T22:00:00.000Z").map((r) => r.date)).toEqual(["2026-09-30", "2026-10-01"]);
  });
});

describe("gateUnanchoredReadings — an unanchored estimate-sourced reading reads its last FINAL", () => {
  const F1 = INDICATORS.find((i) => i.id === "F1")!;
  const head = (date: string): Reading => ({ indicator: F1, date, level: 0.9, delta20: 0.4, rawState: "RED", state: "RED", lag: true, ageDays: 3 });
  const g1 = { indicator: G1, date: D, level: 1, delta20: 0, rawState: "GREEN", state: "GREEN" } as Reading;
  const run = { runAt: `${D}T22:00:00.000Z`, sourced: new Map([["F1", new Set([D])]]), carried: new Map() };
  const storeWith = async (dates: string[]) => {
    const store = new InMemoryStore();
    for (const date of dates) await store.recordReadings([reading({ indicatorId: "F1", date, value: 0.5, delta20: 0.1, rawState: "AMBER", state: "AMBER" })], `${date}T22:00:00.000Z`);
    return store;
  };

  test("no FINAL on the previous session: the reading is the last FINAL row (date/value/state), freshness dropped", async () => {
    const out = await gateUnanchoredReadings([head(D), g1], run, await storeWith(["2026-09-30"]));
    expect(out[0]).toEqual({ indicator: F1, date: "2026-09-30", level: 0.5, delta20: 0.1, rawState: "AMBER", state: "AMBER", decision: null, bandCuts: null });
    expect(out[1]).toBe(g1);
  });

  test("a stored-row read failure reaches `onReadFail` and anchors on the run's prints alone (none ⇒ dropped)", async () => {
    const broken = { getSeriesBulk: () => Promise.reject(new Error("bulk boom")) };
    const seen: string[] = [];
    const out = await gateUnanchoredReadings([head(D), g1], run, broken, (scope, reason) => seen.push(`${scope}: ${reason}`));
    expect([out, seen]).toEqual([[g1], ["[anchor] stored-row read failed - anchoring on this run's prints only: bulk boom"]]);
  });

  test("a FINAL on the previous session anchors it: the same readings back", async () => {
    const readings = [head(D), g1];
    expect(await gateUnanchoredReadings(readings, run, await storeWith(["2026-09-30", "2026-10-01"]))).toBe(readings);
  });

  test("an EU leg reads its newest ANCHORED settled close, never an older FINAL nor a settled close past a gap", async () => {
    const eu = legCloseId("EU-Fin");
    const leg = { indicator: { id: eu } as Indicator, date: D, level: 9, delta20: 0, rawState: "RED", state: "RED" } as Reading;
    const lastOf = async (final: string, settled: string) => {
      const store = new InMemoryStore();
      await store.recordReadings([reading({ indicatorId: eu, date: final, value: 1 })], `${final}T22:00:00.000Z`);
      await store.recordReadings([reading({ indicatorId: eu, date: settled, value: 2, estimated: true })], `${settled}T22:00:00.000Z`);
      const [out] = await gateUnanchoredReadings([leg], { ...run, sourced: new Map([[eu, new Set([D])]]) }, store);
      return [out?.date, out?.level];
    };
    expect([await lastOf("2026-09-29", "2026-09-30"), await lastOf("2026-09-25", "2026-09-29")]).toEqual([["2026-09-30", 2], ["2026-09-25", 1]]);
  });

  test("an EU leg's reading settled at 18:00 UTC on its own day is gated like an EOD one; the US line's intraday reading is not", async () => {
    const [eu, us] = [legCloseId("EU-Fin"), SB_STRAT_ID];
    const store = new InMemoryStore();
    await store.recordReadings([eu, us].map((indicatorId) => reading({ indicatorId, date: "2026-09-29", value: 1 })), "2026-09-29T22:00:00.000Z");
    const legs = [eu, us].map((id) => ({ indicator: { id } as Indicator, date: D, level: 9, delta20: 0, rawState: "RED", state: "RED" }) as Reading);
    const out = await gateUnanchoredReadings(legs, { runAt: `${D}T18:00:00.000Z`, sourced: new Map([[eu, new Set([D])], [us, new Set([D])]]), carried: new Map() }, store);
    expect(out.map((r) => [r.date, r.level])).toEqual([["2026-09-29", 1], [D, 9]]);
  });
});

describe("estimateAnchored — an estimate on t needs a FINAL row on t's previous session", () => {
  test("prevSession: a Monday's is Friday; a source holiday is skipped (F4: Mon 01-19 closed)", () => {
    expect([prevSession("F1", "2026-02-02"), prevSession("F4", "2026-01-20")]).toEqual(["2026-01-30", "2026-01-16"]);
  });

  test("a Monday estimate stands on a Friday FINAL; one over a missing previous session does not", () => {
    expect([estimateAnchored("F1", new Set(["2026-01-30"]), "2026-02-02"), estimateAnchored("F1", new Set(["2026-01-29"]), "2026-02-02")]).toEqual([true, false]);
  });

  test("a non-session date is never anchored, even past a FINAL previous session: a Saturday, and F4's MLK Day", () => {
    expect([estimateAnchored("F1", new Set(["2026-01-30"]), "2026-01-31"), estimateAnchored("F4", new Set(["2026-01-16"]), "2026-01-19")]).toEqual([false, false]);
  });

  test("unanchoredEstimateDates: a chained estimate is flagged; the read's oldest row is never judged", () => {
    const series = [{ date: "2026-01-27", estimated: true }, { date: "2026-01-28" }, { date: "2026-01-29", estimated: true }, { date: "2026-01-30", estimated: true }];
    expect(unanchoredEstimateDates("F1", series)).toEqual(["2026-01-30"]);
  });

  test("unanchoredEstimateDates: an EU leg's settled `estimated` close anchors the next estimate; a US line's does not", () => {
    const series = [{ date: "2026-01-28" }, { date: "2026-01-29", estimated: true, runAt: "2026-01-29T22:00:00.000Z" }, { date: "2026-01-30", estimated: true }];
    expect([unanchoredEstimateDates(legCloseId("EU-Fin"), series), unanchoredEstimateDates(SB_STRAT_ID, series)]).toEqual([[], ["2026-01-30"]]);
  });

  test("unanchoredEstimateDates: an EU close settled at 18:00 UTC on its own day is judged and anchors nothing; at 12:00 it is an exempt head that anchors nothing", () => {
    const series = (runAt: string) => [
      { date: "2026-09-29", runAt: "2026-09-29T22:00:00.000Z" }, { date: D, estimated: true, runAt }, { date: "2026-10-05", estimated: true, runAt: "2026-10-05T22:00:00.000Z" },
    ];
    const eu = legCloseId("EU-Fin");
    expect([unanchoredEstimateDates(eu, series(`${D}T18:00:00.000Z`)), unanchoredEstimateDates(eu, series(`${D}T12:00:00.000Z`))]).toEqual([[D, "2026-10-05"], ["2026-10-05"]]);
  });
});

describe("withEstimateHeads — E13 display readings (E1/E7: a print on the estimate's date wins)", () => {
  const R2 = INDICATORS.find((i) => i.id === "R2")!;
  const r = (indicator: Indicator, date: string): Reading => ({ indicator, date, level: 1, delta20: 0, rawState: "GREEN", state: "GREEN", lag: true, ageDays: 9 });
  const est = (indicatorId: string, date: string): StoredReading => ({ date, indicatorId, value: 2, delta20: 0.5, rawState: "RED", state: "RED", estimated: true });
  const restamp = (x: Reading): Reading => ({ ...x, lag: false });

  test("an estimate dated past the print heads its id's reading; a same-date one applies nowhere (null)", () => {
    const readings = [r(R2, "2026-02-02"), r(G1, "2026-02-02")];
    expect(withEstimateHeads(readings, [est("R2", "2026-02-02")], restamp)).toBeNull();
    const out = withEstimateHeads(readings, [est("R2", "2026-02-03")], restamp)!;
    expect(out[0]).toMatchObject({ date: "2026-02-03", level: 2, delta20: 0.5, rawState: "RED", state: "RED", lag: false });
    expect(out[0]!.ageDays).toBeUndefined(); // the print's stale freshness stamp never rides the head
    expect(out[1]).toBe(readings[1]);
  });

  test("notifyHeadEstimates: the notify fold's heads by id, off their print — a same-date estimate is none", () => {
    const readings = [r(R2, "2026-02-02"), r(G1, "2026-02-02")];
    const heads = notifyHeadEstimates(readings, [est("R2", "2026-02-03"), est("G1", "2026-02-02")]);
    expect(heads).toEqual({ R2: { date: "2026-02-03", value: 2, fromDate: "2026-02-02", state: "RED" } });
  });

  test("a chained estimate never heads: the anchored one does, and alone it applies nowhere", () => {
    const readings = [r(R2, "2026-02-02")];
    const chained = [est("R2", "2026-02-03"), est("R2", "2026-02-04")];
    expect([withEstimateHeads(readings, chained, restamp)?.[0]?.date, notifyHeadEstimates(readings, chained).R2?.date, withEstimateHeads(readings, [chained[1]!], restamp)]).toEqual(["2026-02-03", "2026-02-03", null]);
  });

  test("mergeHeadEstimates: oil's own value wins its id with the head's state; a null oil slot keeps the head", () => {
    const h = (value: number) => ({ date: "2026-02-03", value, fromDate: "2026-02-02", state: "RED" as const });
    const oil = { date: "2026-02-03", value: 9, fromDate: "2026-02-01" };
    expect(mergeHeadEstimates({ R2: h(2), G1: h(3), BRENT: h(4) }, { G1: oil, BRENT: null })).toEqual({ R2: h(2), G1: { ...oil, state: "RED" }, BRENT: h(4) });
    expect(mergeHeadEstimates({}, { G1: oil, BRENT: null })).toEqual({ G1: oil, BRENT: null });
  });
});

describe("estimate-sourced rows: flagged obs → `estimated` EOD rows", () => {
  const sr = (indicatorId: string, date: string): StoredReading => ({ date, indicatorId, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN" });

  test("estimateDatesOf: the union of every leg's flagged dates, sorted and deduped; an unflagged or absent leg adds none", () => {
    const a = [{ date: "2026-01-30", value: 1 }, { date: "2026-02-02", value: 2, estimated: true }];
    const b = [{ date: "2026-02-02", value: 3, estimated: true }, { date: "2026-02-03", value: 4, estimated: true }];
    expect(estimateDatesOf(b, a, undefined)).toEqual(["2026-02-02", "2026-02-03"]);
    expect(estimateDatesOf([{ date: "2026-02-02", value: 1 }], undefined)).toEqual([]);
  });

  test("stampEstimated flags only the named dates — a provisional (daytime) row included", () => {
    const rows = [sr("BONOS", "2026-01-30"), sr("BONOS", "2026-02-02")];
    const out = stampEstimated(rows, new Set(["2026-02-02"]));
    expect(out.map((r) => r.estimated === true)).toEqual([false, true]);
    expect(out[0]).toBe(rows[0]);
  });

  test("stampEstimateSourced reads each row's own id; another id's dates never stamp it", () => {
    const out = stampEstimateSourced([sr("BONOS", "2026-02-02"), sr("BUND", "2026-02-02")], new Map([["BONOS", new Set(["2026-02-02"])]]));
    expect(out.map((r) => [r.indicatorId, r.estimated === true])).toEqual([["BONOS", true], ["BUND", false]]);
  });

  test("withoutEstimateSourced drops an estimate-sourced row behind the newest, keeping the newest slot gap-fill skips", () => {
    const series = [sr("BONOS", "2026-01-29"), sr("BONOS", "2026-01-30"), sr("BONOS", "2026-02-02")];
    const out = withoutEstimateSourced(new Map([["BONOS", series], ["BUND", series]]), new Map([["BONOS", new Set(["2026-01-30", "2026-02-02"])]]));
    expect(out.get("BONOS")!.map((r) => r.date)).toEqual(["2026-01-29", "2026-02-02"]);
    expect(out.get("BUND")).toBe(series);
  });
});
