import { beforeEach, describe, expect, test, vi } from "vitest";
import { capeOrStoredF7 } from "./ecy-cape-fallback.js";
import { noFreeSource } from "./no-free-source.js";
import { CAPE_PROBE_LIMIT } from "./run-seeds.js";
import { peekDegradeLog, resetDegradeLog } from "./tracks.js";
import type { SeriesPoint } from "./store.js";

const refused = () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }));
const point = (date: string, value: number, estimated?: true): SeriesPoint => ({
  date, value, delta20: 0, rawState: "GREEN", state: "GREEN", ...(estimated ? { estimated } : {}),
});
const STORED = [point("2025-12-01", 39.5), point("2026-01-01", 40.1, true)];
const storeOf = (rows: SeriesPoint[]) => ({ getSeries: vi.fn(async () => rows) });
const events = () => peekDegradeLog().map((e) => [e.scope, e.reason, e.effect]);
const OMIT = "[ECY] CAPE fetch failed, stored F7 stale/empty - ECY omitted this run";

beforeEach(() => resetDegradeLog());

describe("capeOrStoredF7", () => {
  test("a live fetch serves its rows; no event, no store read", async () => {
    const store = storeOf(STORED);
    const live = [{ date: "2026-01-01", value: 41 }];
    expect(await capeOrStoredF7(async () => live, store, "2026-01-30", false, "CAPE")).toBe(live);
    expect(store.getSeries).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  test("a failed fetch, newest stored F7 exactly 60 d old: stored rows (estimated included) served, one trace", async () => {
    const store = storeOf(STORED);
    expect(await capeOrStoredF7(refused, store, "2026-03-02", false, "CAPE")).toEqual([
      { date: "2025-12-01", value: 39.5 },
      { date: "2026-01-01", value: 40.1 },
    ]);
    expect(store.getSeries).toHaveBeenCalledWith("F7", CAPE_PROBE_LIMIT);
    expect(events()).toEqual([
      ["[ECY] CAPE fetch failed - ECY scored off stored F7", "fetch failed [ECONNREFUSED] · newest stored F7 2026-01-01 (2 rows)", "trace"],
    ]);
  });

  test.each([
    { intraday: false, effect: "notify" },
    { intraday: true, effect: "trace" },
  ])("61 d old on an intraday=$intraday run: null, one omission at $effect", async ({ intraday, effect }) => {
    expect(await capeOrStoredF7(refused, storeOf(STORED), "2026-03-03", intraday, "CAPE")).toBeNull();
    expect(events()).toEqual([[OMIT, "fetch failed [ECONNREFUSED] · newest stored F7 2026-01-01 (2 rows)", effect]]);
  });

  test("empty stored F7 or a throwing store read: null, one omission naming why", async () => {
    expect(await capeOrStoredF7(refused, storeOf([]), "2026-01-30", false, "CAPE")).toBeNull();
    const throwing = { getSeries: async () => Promise.reject(new Error("store read failed")) };
    expect(await capeOrStoredF7(refused, throwing, "2026-01-30", false, "CAPE")).toBeNull();
    expect(events()).toEqual([
      [OMIT, "fetch failed [ECONNREFUSED] · no stored F7", "notify"],
      [OMIT, "fetch failed [ECONNREFUSED] · stored F7 read failed: store read failed", "notify"],
    ]);
  });

  test("a public no-free-source fetch tags both events no-free-source; an outage tags neither", async () => {
    const publicCape = async () => noFreeSource("CAPE");
    expect(await capeOrStoredF7(publicCape, storeOf([]), "2026-01-30", false, "CAPE")).toBeNull();
    await capeOrStoredF7(publicCape, storeOf(STORED), "2026-01-30", false, "CAPE");
    await capeOrStoredF7(refused, storeOf([]), "2026-01-30", false, "CAPE");
    expect(peekDegradeLog().map((e) => [e.effect, e.kind])).toEqual([
      ["notify", "no-free-source"],
      ["trace", "no-free-source"],
      ["notify", undefined],
    ]);
  });

  test("no fallback scope matches the c4 feed-degrade / fell back to / pattern", async () => {
    await capeOrStoredF7(refused, storeOf(STORED), "2026-01-30", false, "multpl CAPE");
    await capeOrStoredF7(refused, storeOf([]), "2026-01-30", false, "multpl CAPE");
    const scopes = peekDegradeLog().map((e) => e.scope);
    expect(scopes).toHaveLength(2);
    for (const s of scopes) expect(s).not.toMatch(/ fell back to /);
  });
});
