import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import { getStore, type StoredReading } from "../src/store.js";
import { makeCaptureStore } from "./probe-feed-diff.js";

const row = (date: string, value: number, extra: Partial<StoredReading> = {}): StoredReading => ({
  date, indicatorId: "X", value, delta20: 0, rawState: "GREEN", state: "GREEN", ...extra,
});

describe("makeCaptureStore tailFrom", () => {
  it("planning reads see the real store through the day before tailFrom; writes are captured, never executed", async () => {
    const real = new InMemoryStore();
    await real.recordReadings(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((d, i) => row(d, i)), "2026-10-02T22:00:00Z");
    const { store, arm } = makeCaptureStore(real, { tailFrom: "2026-10-01" });
    expect((await store.getSeries("X", 100)).map((p) => p.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
    expect((await store.getSeries("X", 100, { to: "2026-09-29" })).map((p) => p.date)).toEqual(["2026-09-28", "2026-09-29"]);
    expect((await store.getSeriesBulk(["X"], { limit: 1 })).get("X")!.map((p) => p.date)).toEqual(["2026-09-30"]);
    await store.recordReadings([row("2026-10-01", 9), row("2026-10-02", 8, { estimated: true })], "2026-10-06T22:00:00Z");
    expect(real.readings).toHaveLength(5);
    expect([...arm.get("X")!]).toEqual([["2026-10-01", { value: 9, state: "GREEN" }], ["2026-10-02", { value: 8, state: "GREEN", estimated: true }]]);
  });

  // The probes resolve a `getStore("ro")` handle — a frozen object whose read methods are its own properties.
  it("wraps a frozen read handle too: planning reads clamp, writes are captured", async () => {
    const real = new InMemoryStore();
    await real.recordReadings(["2026-09-30", "2026-10-01"].map((d, i) => row(d, i)), "2026-10-02T22:00:00Z");
    const ro = getStore("ro", { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_KEY: "k" }, () => real);
    const { store, arm } = makeCaptureStore(ro, { tailFrom: "2026-10-01" });
    expect((await store.getSeries("X", 100)).map((p) => p.date)).toEqual(["2026-09-30"]);
    await store.recordReadings([row("2026-10-01", 9)], "2026-10-06T22:00:00Z");
    expect([...arm.keys()]).toEqual(["X"]);
  });
});
