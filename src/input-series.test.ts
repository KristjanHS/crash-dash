/**
 * P1.1 roster + read-helper contracts (src/input-series.ts): the roster stays collision-free
 * with the scored universe, and `readInputSeries` maps store rows to ascending Observations,
 * omitting unseeded ids (the §6 missing-row rule's read half).
 */
import { describe, expect, it, vi } from "vitest";

import { fillLiveHoles, INPUT_SERIES, inputSeriesIdOf, readInputSeries, settledClose, warnMissingInput, withStoredLegs } from "./input-series.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_IDS } from "./registry-composite.js";
import { PENSION_INDICATORS, PLACEHOLDER_STATE_IDS } from "./registry-price.js";
import { InMemoryStore } from "./store-memory.js";
import { priceLegReadingSeries } from "./pension.js";
import { OAS_NOWCAST_LEGS } from "./hyoas-nowcast.js";
import { NOWCAST_LEG_SYMBOLS } from "./nowcast-score.js";
import { isProvisional } from "./intraday.js";
import { LEG_TICKER, OFF_LADDER_LEG_TICKER } from "./scoreboard.js";

describe("INPUT_SERIES roster", () => {
  it("has no duplicate ids", () => {
    const ids = INPUT_SERIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("collides with no scored indicator id and no chart-only id (raw rows, no card/scorer)", () => {
    const scored = new Set([...ALL_INDICATORS.map((i) => i.id), ...CHART_ONLY_IDS]);
    // PENSION ids are the deliberate shared ids: INPUT_SERIES is their only cron writer since J4.
    const pension = new Set(PENSION_INDICATORS.map((i) => i.id));
    // So are the value-only CONTEXT cards (BBB): never scored (`thresholds: {}`), state masked by PLACEHOLDER_STATE_IDS.
    const valueOnly = new Set(ALL_INDICATORS.filter((i) => i.channel === "CONTEXT" && PLACEHOLDER_STATE_IDS.has(i.id) && Object.keys(i.thresholds).length === 0).map((i) => i.id));
    for (const { id } of INPUT_SERIES) {
      if (pension.has(id) || valueOnly.has(id)) continue;
      expect(scored.has(id), `${id} is already a scored/chart-only indicator id`).toBe(false);
    }
    expect(INPUT_SERIES.some((s) => pension.has(s.id) && scored.has(s.id)), "PENSION exemption is vacuous").toBe(true);
    expect(INPUT_SERIES.some((s) => valueOnly.has(s.id)), "value-only CONTEXT exemption is vacuous").toBe(true);
  });

  it("every LEGP_* leg ticker is rostered — the leg seed's stored-row fallback reads only rostered symbols", () => {
    const tickers = [...Object.values(LEG_TICKER), ...Object.values(OFF_LADDER_LEG_TICKER)].map((l) => l.ticker);
    expect(tickers).toContain("QDVE.DE"); // vacuity anchor: the tables are read, not empty
    expect(tickers.filter((t) => inputSeriesIdOf(t) === undefined)).toEqual([]);
  });

  it("every same-day nowcast leg has a cron writer here — the read path is store-only, so a missing row is silently dark", () => {
    const legs = [
      ...Object.values(OAS_NOWCAST_LEGS).flatMap((l) => [l.price, l.hedge]),
      ...NOWCAST_LEG_SYMBOLS,
    ];
    const roster = new Set(INPUT_SERIES.map((s) => s.id));
    for (const leg of legs) expect(roster.has(leg), `${leg} has no INPUT_SERIES writer`).toBe(true);
  });
});

describe("readInputSeries", () => {
  it("maps stored rows to ascending {date,value} and OMITS ids with no rows", async () => {
    const store = new InMemoryStore();
    const obs = [
      { date: "2026-01-02", value: 1.1 },
      { date: "2026-01-03", value: 1.2 },
      { date: "2026-01-06", value: 1.3 },
    ];
    await store.recordReadings(priceLegReadingSeries("VIXCLS", obs), "2026-01-06T22:00:00.000Z");

    const map = await readInputSeries(store, ["VIXCLS", "T10Y2Y"], 100, { now: new Date("2026-01-20T00:00:00Z") });
    expect(map.get("VIXCLS")).toEqual(obs);
    expect(map.has("T10Y2Y")).toBe(false); // unseeded id ⇒ absent, never an empty array
  });

  it("stale rows (newest older than INPUT_MAX_STALE_DAYS vs now) ⇒ OMITTED + one warn; fresh ⇒ present", async () => {
    const store = new InMemoryStore();
    const obs = [{ date: "2026-01-06", value: 1.3 }];
    await store.recordReadings(priceLegReadingSeries("STALE_A", obs), "2026-01-06T22:00:00.000Z");
    const warn = vi.fn();
    // 44 days after the newest row: fresh (boundary inside the cap).
    const fresh = await readInputSeries(store, ["STALE_A"], 100, { now: new Date("2026-02-19T00:00:00Z"), warn });
    expect(fresh.get("STALE_A")).toEqual(obs);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("STALE_A"))).toHaveLength(0);
    // 46 days after: stale ⇒ absent from the map, warned once with a "stale" reason.
    const stale = await readInputSeries(store, ["STALE_A"], 100, { now: new Date("2026-02-21T00:00:00Z"), warn });
    expect(stale.has("STALE_A")).toBe(false);
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes("STALE_A"));
    expect(mine).toHaveLength(1);
    expect(String(mine[0]![0])).toContain("stale");
  });

  it("an estimate-only head (E3) or a head `keep` drops never masks a stale series", async () => {
    const store = new InMemoryStore();
    await store.recordReadings(priceLegReadingSeries("STALE_E", [{ date: "2026-01-06", value: 1.3 }]), "2026-01-06T22:00:00.000Z");
    const est = priceLegReadingSeries("STALE_E", [{ date: "2026-02-20", value: 1.4 }]).map((r) => ({ ...r, estimated: true }));
    await store.recordReadings(est, "2026-02-20T22:00:00.000Z");
    const warn = vi.fn();
    const now = new Date("2026-02-21T00:00:00Z"); // print 46d old, estimate 1d old
    expect((await readInputSeries(store, ["STALE_E"], 100, { now, warn })).has("STALE_E")).toBe(false);
    const fresh = new Date("2026-02-19T00:00:00Z"); // print 44d old ⇒ fresh; the estimate rides along unless `keep` drops it
    expect((await readInputSeries(store, ["STALE_E"], 100, { now: fresh })).get("STALE_E")).toHaveLength(2);
    const keepFinal = { now: fresh, keep: (_: string, p: { estimated?: boolean }) => p.estimated !== true };
    expect((await readInputSeries(store, ["STALE_E"], 100, keepFinal)).get("STALE_E")).toEqual([{ date: "2026-01-06", value: 1.3 }]);
    // A provisional head `keep` drops: the kept print is 46d old ⇒ absent.
    await store.recordReadings(priceLegReadingSeries("STALE_K", [{ date: "2026-01-06", value: 1 }]), "2026-01-06T22:00:00.000Z");
    await store.recordReadings(priceLegReadingSeries("STALE_K", [{ date: "2026-02-20", value: 2 }]), "2026-02-20T10:00:00.000Z");
    expect((await readInputSeries(store, ["STALE_K"], 100, { now, warn, keep: (_, p) => !isProvisional(p) })).has("STALE_K")).toBe(false);
  });

  it("EBP rides its per-id override: a ~2-month-old monthly print stays fresh at 100d, degrades past it", async () => {
    const store = new InMemoryStore();
    const obs = [{ date: "2026-06-01", value: 0.2 }];
    await store.recordReadings(priceLegReadingSeries("EBP", obs), "2026-07-05T22:00:00.000Z");
    // 65 days old — the normal first-of-month + ~1-month-lag worst case; > 45 but < 100.
    const fresh = await readInputSeries(store, ["EBP"], 100, { now: new Date("2026-08-05T00:00:00Z") });
    expect(fresh.get("EBP")).toEqual(obs);
    // 101 days old — past the override too ⇒ absent.
    const warn = vi.fn();
    const stale = await readInputSeries(store, ["EBP"], 100, { now: new Date("2026-09-10T00:00:00Z"), warn });
    expect(stale.has("EBP")).toBe(false);
  });
});

describe("warnMissingInput", () => {
  it("warns once per id per instance", () => {
    const warn = vi.fn();
    warnMissingInput("WARN_ONCE_A", "test", warn);
    warnMissingInput("WARN_ONCE_A", "test", warn);
    warnMissingInput("WARN_ONCE_B", "test", warn);
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes("WARN_ONCE_"));
    expect(mine).toHaveLength(2);
  });
});

describe("fillLiveHoles / withStoredLegs", () => {
  const o = (date: string, value: number) => ({ date, value });
  it("fills dates before the live newest (past it only under `head`); live wins on shared dates; empty live stays empty", () => {
    const live = [o("2026-09-30", 1), o("2026-10-02", 3)];
    const stored = [o("2026-09-30", 1), o("2026-10-01", 2), o("2026-10-03", 4)];
    expect(fillLiveHoles(live, stored)).toEqual([o("2026-09-30", 1), o("2026-10-01", 2), o("2026-10-02", 3)]);
    expect(fillLiveHoles([], stored)).toEqual([]);
    // `head` (the leg seed's opt-in): a stored row past the live newest extends the series too.
    expect(fillLiveHoles(live, stored, { head: true }).at(-1)).toEqual(o("2026-10-03", 4));
    expect(fillLiveHoles([], stored, { head: true })).toEqual([]);
    // A head row rescales at the nearest EARLIER shared date (live 2 / stored 1 ⇒ ×2).
    expect(fillLiveHoles([o("2026-09-30", 2)], [o("2026-09-30", 1), o("2026-10-01", 3)], { head: true }).at(-1)).toEqual(o("2026-10-01", 6));
  });

  it("a live obs keeps its `estimated` flag (a closes provider meta close); a filled stored row carries none", () => {
    const live = [o("2026-09-30", 1), { date: "2026-10-02", value: 3, estimated: true as const }];
    const out = fillLiveHoles(live, [o("2026-09-30", 1), { ...o("2026-10-01", 2), estimated: true as const }]);
    expect(out).toEqual([o("2026-09-30", 1), o("2026-10-01", 2), { date: "2026-10-02", value: 3, estimated: true }]);
  });

  it("rescales a filled close to the live feed's adjustment (ex-div after the hole)", () => {
    const live = [o("2026-09-29", 98), o("2026-10-02", 100)];
    const stored = [o("2026-09-29", 100), o("2026-10-01", 50)];
    expect(fillLiveHoles(live, stored)).toContainEqual(o("2026-10-01", 49));
  });

  it("maps a rostered symbol to its store id, passes unrostered symbols through, degrades to live on a store failure", async () => {
    expect(inputSeriesIdOf("XDEV.DE")).toBe("XDEV");
    expect(inputSeriesIdOf("HYG")).toBe("HYG");
    expect(inputSeriesIdOf("NOPE")).toBeUndefined();
    const live = async () => [o("2026-10-02", 3)];
    const broken = { getSeriesBulk: async () => { throw new Error("down"); } } as unknown as InMemoryStore;
    const warn = vi.fn();
    const onFail = vi.fn();
    expect(await withStoredLegs(broken, ["HYG", "NOPE"], live, 5, { now: new Date("2026-10-03T00:00:00Z"), warn, onFail })("HYG")).toEqual([o("2026-10-02", 3)]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stored legs unreadable"));
    expect(onFail.mock.calls).toEqual([["[input-series] HYG stored legs unreadable — live feed only", "down"]]);
  });
});

describe("settledClose — which stored rows may fill a live hole ([USER] 2026-10-02)", () => {
  const D = "2026-10-01";
  const at = (hhmm: string) => ({ date: D, runAt: `${D}T${hhmm}:00.000Z` });
  it("final rows always; provisional only for an EU listing written after EU_SETTLED_UTC_MIN", () => {
    expect(settledClose("HYG", at("22:00"))).toBe(true); // final (past the intraday cutoff)
    expect(settledClose("EXSH.DE", at("18:31"))).toBe(true);
    expect(settledClose("EXSH.DE", at("17:05"))).toBe(true);
    expect(settledClose("EXSH.DE", at("17:04"))).toBe(false); // winter closing auction + the closes feed's delay
    expect(settledClose("EXSH.DE", at("14:21"))).toBe(false);
    expect(settledClose("HYG", at("18:31"))).toBe(false); // US pre-close
    expect(settledClose("EURUSD=X", at("18:31"))).toBe(false);
    expect(settledClose("CL=F", at("18:31"))).toBe(false);
  });

  it("a non-EU `estimated` row never fills a hole; an EU evening estimate (the quote-sourced label) does", async () => {
    expect(settledClose("HYG", { ...at("22:00"), estimated: true })).toBe(false);
    expect(settledClose("EXSH.DE", { ...at("18:31"), estimated: true })).toBe(true);
    expect(settledClose("EXSH.DE", { ...at("22:00"), estimated: true })).toBe(true); // EOD meta close, stored estimated since the quote-label change
    expect(settledClose("EXSH.DE", { ...at("17:04"), estimated: true })).toBe(false); // pre-settle quote
    const store = new InMemoryStore();
    for (const sym of ["HYG", "EXSH.DE"]) {
      await store.recordReadings(priceLegReadingSeries(sym, [{ date: D, value: 70 }]).map((r) => ({ ...r, estimated: true })), `${D}T22:00:00.000Z`);
    }
    const live = async () => [{ date: "2026-09-30", value: 1 }, { date: "2026-10-02", value: 3 }];
    const feed = withStoredLegs(store, ["HYG", "EXSH.DE"], live, 5, { now: new Date("2026-10-02T17:00:00Z"), onFail: () => undefined });
    expect((await feed("HYG")).map((o) => o.date)).toEqual(["2026-09-30", "2026-10-02"]);
    expect(await feed("EXSH.DE")).toContainEqual(expect.objectContaining({ date: D, value: 70 }));
  });

  it("withStoredLegs drops a US pre-close provisional row but fills from an EU evening one", async () => {
    const store = new InMemoryStore();
    await store.recordReadings(priceLegReadingSeries("HYG", [{ date: D, value: 70 }]), `${D}T18:31:00.000Z`);
    await store.recordReadings(priceLegReadingSeries("EXSH.DE", [{ date: D, value: 88 }]), `${D}T18:31:00.000Z`);
    const live = async () => [{ date: "2026-09-30", value: 1 }, { date: "2026-10-02", value: 3 }];
    const feed = withStoredLegs(store, ["HYG", "EXSH.DE"], live, 5, { now: new Date("2026-10-02T17:00:00Z"), onFail: () => undefined });
    expect((await feed("HYG")).map((o) => o.date)).toEqual(["2026-09-30", "2026-10-02"]);
    expect(await feed("EXSH.DE")).toContainEqual({ date: D, value: 88 });
  });
});
