import { describe, expect, it } from "vitest";
import { INTRADAY_CUTOFF_UTC_MIN } from "../src/intraday.js";
import type { SeriesPoint, SeriesRange } from "../src/store.js";
import { InMemoryStore } from "../src/store-memory.js";
import { makeStoredReading } from "../src/test-helpers.js";
import { formatReport, whyReport } from "./probe-why.js";

const D = "2026-10-02";
const at = (date: string, min: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + min * 60_000).toISOString();

describe("probe-why", () => {
  it("serves the final print over a NEWER estimate, flags the intraday row provisional, and agrees with the view", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("BUND", { date: D, value: 4.71, estimated: true })], at(D, 600));
    await store.recordReadings([makeStoredReading("BUND", { date: D, value: 4.69 })], at(D, INTRADAY_CUTOFF_UTC_MIN + 60));
    await store.recordReadings([makeStoredReading("BUND", { date: D, value: 4.75, estimated: true })], at(D, 1500));
    const r = await whyReport(store, "BUND", D);
    expect(r.rows.map((x) => [x.value, x.provisional, x.served])).toEqual([
      [4.71, true, false],
      [4.69, false, true],
      [4.75, false, false],
    ]);
    expect(r.reason).toBe("final beats estimate ×2");
    expect(r.viewAgrees).toBe(true);
  });

  it("an equal run_at tie goes to the later insert", async () => {
    const store = new InMemoryStore();
    const run = at(D, 1320);
    await store.recordReadings([makeStoredReading("ZZ", { date: D, value: 1.5 })], run);
    await store.recordReadings([makeStoredReading("ZZ", { date: D, value: 1.6 })], run);
    const r = await whyReport(store, "ZZ", D);
    expect({ served: r.rows.map((x) => x.served), reason: r.reason }).toEqual({ served: [false, true], reason: "later insert ×1" });
  });

  it("a date with no row reports the nearest earlier served dates", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("BONOS", { date: "2026-10-01", value: 3.2 })], at("2026-10-01", 1320));
    const r = await whyReport(store, "BONOS", D);
    expect({ rows: r.rows, reason: r.reason, earlier: r.earlier.map((p) => p.date), viewAgrees: r.viewAgrees }).toEqual({
      rows: [],
      reason: "no stored row",
      earlier: ["2026-10-01"],
      viewAgrees: true,
    });
  });

  it("flags a view that serves a different row than pickRecent", async () => {
    class NewestRunAtView extends InMemoryStore {
      override async getSeries(id: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> {
        const vs = await this.getReadingVersions(id, range?.from ?? "");
        return limit > 0 && vs.length > 0 ? [vs.at(-1)!] : [];
      }
    }
    const store = new NewestRunAtView();
    await store.recordReadings([makeStoredReading("ZZ", { date: D, value: 3.1 })], at(D, 1320));
    await store.recordReadings([makeStoredReading("ZZ", { date: D, value: 3.2, estimated: true })], at(D, 1400));
    expect((await whyReport(store, "ZZ", D)).viewAgrees).toBe(false);
  });

  it("a full-precision value wider than its column still parses as an est row (owed ccc-est/f1-est FAIL 2026-11-05)", async () => {
    const store = new InMemoryStore();
    await store.recordReadings([makeStoredReading("CCC", { date: D, value: 13.1645638710835, rawState: "AMBER", state: "AMBER", estimated: true })], at(D, 1500));
    const lines = formatReport("CCC", D, await whyReport(store, "CCC", D));
    expect(lines[2]).toMatch(/13\.1645638710835 AMBER→AMBER/);
  });
});
