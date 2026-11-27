import { describe, expect, it } from "vitest";
import { INTRADAY_CUTOFF_UTC_MIN } from "../src/intraday.js";
import { InMemoryStore } from "../src/store-memory.js";
import { sweepEodRows } from "../src/estimated.js";
import type { RunInputs } from "../src/run-inputs.js";
import type { StoredReading } from "../src/store.js";
import { makeAlert, makeStoredReading } from "../src/test-helpers.js";
import { partitionLagging, previousWeekday, readRestamped, scanProvisional, staticRoster, verdictOf } from "./probe-provisional-rows.js";

const TODAY = "2026-09-29";
const FROM = "2026-09-01";
const at = (date: string, min: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + min * 60_000).toISOString();
const inputsWith = (heads: StoredReading[]): RunInputs => ({
  v: 1, refs: { last: null, prevDay: null, lastPush: null }, geoFlags: 0, crisisStage: 0, scored: [], lastBands: [],
  exposurePosture: null, fallShape: null, spDistToHigh: null, nearHighTol: null, stamps: {}, heads,
});

describe("probe-provisional-rows", () => {
  it("counts a past provisional row per id and FAILs; a final or same-day provisional row passes", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("DB_SMH", { date: "2026-09-25" })], at("2026-09-25", INTRADAY_CUTOFF_UTC_MIN - 1));
    await store.recordReadings([makeStoredReading("DB_SMH", { date: "2026-09-26" })], at("2026-09-26", INTRADAY_CUTOFF_UTC_MIN));
    await store.recordReadings([makeStoredReading("F1", { date: TODAY })], at(TODAY, 600));
    const bad = await scanProvisional(store, ["DB_SMH", "F1"], TODAY, FROM, 31);
    expect({ provisional: [...bad.provisional], blind: bad.blind, scanned: bad.scanned, verdict: verdictOf(bad, TODAY, []) }).toEqual({
      provisional: [["DB_SMH", ["2026-09-25"]]],
      blind: [],
      scanned: 2,
      verdict: "FAIL",
    });
    // The EOD close rewrites D ⇒ the same store now passes.
    await store.recordReadings([makeStoredReading("DB_SMH", { date: "2026-09-25" })], at("2026-09-25", INTRADAY_CUTOFF_UTC_MIN + 55));
    expect(verdictOf(await scanProvisional(store, ["DB_SMH", "F1"], TODAY, FROM, 31), TODAY, [])).toBe("PASS");
  });

  it("U2: a provisional row dated the previous weekday is lagging (PASS, reported); older is stale (FAIL)", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("AT1", { date: "2026-09-28" })], at("2026-09-28", INTRADAY_CUTOFF_UTC_MIN - 30));
    // A kept intraday estimate takes the same band — `scanProvisional` has no `estimated` filter.
    await store.recordReadings([makeStoredReading("R2", { date: "2026-09-28", estimated: true })], at("2026-09-28", INTRADAY_CUTOFF_UTC_MIN - 30));
    const lag = await scanProvisional(store, ["AT1", "R2"], TODAY, FROM, 31);
    expect({ ...partitionLagging(lag, TODAY), verdict: verdictOf(lag, TODAY, []) }).toEqual({
      lagging: new Map([["AT1", ["2026-09-28"]], ["R2", ["2026-09-28"]]]),
      stale: new Map(),
      verdict: "PASS",
    });
    // Monday's previous weekday is Friday, so a Friday row is still lagging on Monday — and stale on Tuesday.
    expect(previousWeekday("2026-09-28")).toBe("2026-09-25");
    await store.recordReadings([makeStoredReading("AT1", { date: "2026-09-25" })], at("2026-09-25", INTRADAY_CUTOFF_UTC_MIN - 30));
    const two = await scanProvisional(store, ["AT1"], TODAY, FROM, 31);
    expect({ ...partitionLagging(two, TODAY), verdict: verdictOf(two, TODAY, []) }).toEqual({
      lagging: new Map([["AT1", ["2026-09-28"]]]),
      stale: new Map([["AT1", ["2026-09-25"]]]),
      verdict: "FAIL",
    });
  });

  it("an `=X` id's 48 h window lags one weekday further: on Monday its Thursday row lags, a default id's is stale", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("F17", { date: "2026-11-05" })], at("2026-11-06", 22 * 60));
    await store.recordReadings([makeStoredReading("AT1", { date: "2026-11-05" })], at("2026-11-05", INTRADAY_CUTOFF_UTC_MIN - 30));
    await store.recordReadings([makeStoredReading("F17", { date: "2026-11-04" })], at("2026-11-05", 22 * 60));
    const scan = await scanProvisional(store, ["F17", "AT1"], "2026-11-09", "2026-11-01", 9);
    expect(partitionLagging(scan, "2026-11-09")).toEqual({
      lagging: new Map([["F17", ["2026-11-05"]]]),
      stale: new Map([["F17", ["2026-11-04"]], ["AT1", ["2026-11-05"]]]),
    });
  });

  it("FAILs a blind read (no runAt) and an empty scan instead of passing them", async () => {
    const blindStore = {
      getSeriesBulk: async () => new Map([["F1", [{ date: "2026-09-25", value: 1, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: null, bandCuts: null }]]]),
    };
    const blind = await scanProvisional(blindStore, ["F1"], TODAY, FROM, 31);
    expect({ blind: blind.blind, verdict: verdictOf(blind, TODAY, []) }).toEqual({ blind: ["F1"], verdict: "FAIL" });
    expect(verdictOf(await scanProvisional(new InMemoryStore(), ["F1"], TODAY, FROM, 31), TODAY, [])).toBe("FAIL");
  });

  it("restamp leg: PASS after the real EOD sweep keeps an unfolded intraday estimate; FAIL on one at the stamp, or with no heads", async () => {
    const store = new InMemoryStore();
    const firedAt = at(TODAY, INTRADAY_CUTOFF_UTC_MIN + 55);
    const stampAt = new Date(Date.parse(firedAt) + 1).toISOString();
    const r3Head = makeStoredReading("R3", { date: TODAY, estimated: true });
    await store.recordReadings([makeStoredReading("R2", { date: TODAY, estimated: true })], at(TODAY, INTRADAY_CUTOFF_UTC_MIN - 60));
    await store.recordRun([makeStoredReading("R2", { date: "2026-09-28" })], firedAt, makeAlert({ date: TODAY, firedAt, runInputs: inputsWith([r3Head]) }));
    await store.recordReadings([r3Head], stampAt); // the run's own folded estimate rides the stamp
    await sweepEodRows(store, ["R2", "R3"], 40, { today: TODAY, firedAt, stampAt, estimated: new Map([["R3", new Set([TODAY])]]), keepRunAt: new Set() });
    const verdict = async () => verdictOf(await scanProvisional(store, ["R2", "R3"], TODAY, FROM, 31), TODAY, await readRestamped(store));
    expect([await readRestamped(store), await verdict()]).toEqual([[], "PASS"]);
    await store.recordReadings([makeStoredReading("R2", { date: TODAY, estimated: true })], stampAt);
    expect([await readRestamped(store), await verdict()]).toEqual([[`R2@${TODAY}`], "FAIL"]);

    const headless = new InMemoryStore();
    expect(await readRestamped(headless)).toBeNull();
    await headless.recordRun([], firedAt, makeAlert({ date: TODAY, firedAt }));
    expect(await readRestamped(headless)).toBeNull();
    const passing = await scanProvisional(store, ["R2", "R3"], TODAY, FROM, 31);
    expect([verdictOf(passing, TODAY, []), verdictOf(passing, TODAY, null)]).toEqual(["PASS", "FAIL"]);
  });

  it("the roster reaches the recordRun-only price ids, components, chart-only, inputs, breadth and leg seeds", () => {
    const ids = ["F4", "EXSH_GATE", "DB_SMH", "RS_XLK", "CMP_EURC_SR10Y", "HCX", "DGS2", "BR_QQQ", "LEGP_EUFIN", "LEGP_COMMOD", "SB_STRAT"];
    expect(ids.filter((id) => !staticRoster().includes(id))).toEqual([]);
  });
});
