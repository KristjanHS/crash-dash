/**
 * `dbFirstSeries` (§4 stage 4.1) on the `InMemoryStore` fake — the shallow→deep re-seed, the
 * tail-arm merge (feed wins / stored-only kept / new date appended), never-delete, the `needRows`
 * boundary, scorer-state persistence and the `runAt - 1 ms` stamp. No real fetch: every arm is a
 * local mock over a fixed date set.
 */
import { describe, expect, test, vi } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import { dbFirstOrDirect, dbFirstSeries, resolveDbFirstArm, seamRunAt } from "./series-db-first.js";
import { R5_SLOW_DB_FIRST_FEED } from "./tracks.js";
import { R6 } from "./registry-fred.js";
import { INTRADAY_CUTOFF_UTC_MIN, isProvisional } from "./intraday.js";
import type { Observation, Reading } from "./domain-types.js";

const ID = R6.id;
// After the newest seeded date's intraday cutoff, so every seed row is FINAL (a provisional one is always rewritten).
const SEED_RUN_AT = "2026-08-10T22:00:00.000Z";
const RUN_AT = "2026-08-11T21:05:00.000Z";

const seedRow = (date: string, value: number): StoredReading => ({
  date,
  indicatorId: ID,
  value,
  delta20: 1.5,
  rawState: "RED",
  state: "RED",
  decision: 7,
});

async function seeded(n: number, dates: string[]): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.recordReadings(dates.slice(0, n).map((d, i) => seedRow(d, 100 + i)), SEED_RUN_AT);
  return store;
}

const DATES = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10"];

/** A scorer that stamps EVERY point AMBER with delta20 = value/10 — never GREEN, so a default leaks. */
const amberScorer = (points: Observation[]): Reading[] =>
  points.map((p) => ({
    indicator: R6,
    date: p.date,
    level: p.value,
    delta20: p.value / 10,
    rawState: "AMBER",
    state: "AMBER",
    decision: null,
  }));

type Arms = { deep: Observation[]; tail: Observation[] };
function arms(a: Arms) {
  const calls = { deep: 0, tail: 0 };
  return {
    calls,
    fetchDeep: async () => (calls.deep++, a.deep),
    fetchTail: async () => (calls.tail++, a.tail),
    score: amberScorer,
    runAt: RUN_AT,
  };
}

describe("dbFirstSeries — stored provisional row vs an EOD feed that lacks its date (C1)", () => {
  const D = "2026-08-11";
  async function withProvisionalD(): Promise<InMemoryStore> {
    const store = await seeded(6, DATES);
    await store.recordReadings([seedRow(D, 4242)], "2026-08-11T15:00:00.000Z");
    expect(isProvisional((await store.getSeries(ID, 1))[0]!)).toBe(true);
    return store;
  }
  const tailWithoutD = [{ date: "2026-08-10", value: 105 }];

  test("EOD run: D is absent from the merged points and the scored readings", async () => {
    const store = await withProvisionalD();
    // needRows 7 = 6 final + D: the depth count still sees D, so the arm stays tail.
    const r = await dbFirstSeries(store, { id: ID, needRows: 7, ...arms({ deep: [], tail: tailWithoutD }) });
    expect(r.arm).toBe("tail");
    expect(r.points.map((p) => p.date)).not.toContain(D);
    expect(r.readings.map((x) => x.date)).not.toContain(D);
  });

  test("intraday run keeps D in the merge", async () => {
    const store = await withProvisionalD();
    const a = { ...arms({ deep: [], tail: tailWithoutD }), runAt: "2026-08-11T16:00:00.000Z", intraday: true };
    const r = await dbFirstSeries(store, { id: ID, needRows: 6, ...a });
    expect(r.points.find((p) => p.date === D)?.value).toBe(4242);
  });

  test("dbFirstOrDirect forwards the ctx's intraday flag", async () => {
    const opts = { id: ID, needRows: 6, ...arms({ deep: [], tail: tailWithoutD }) };
    const eod = await dbFirstOrDirect({ store: await withProvisionalD(), runAt: RUN_AT }, opts);
    const intra = await dbFirstOrDirect({ store: await withProvisionalD(), runAt: RUN_AT, intraday: true }, opts);
    expect(eod.points.map((p) => p.date)).not.toContain(D);
    expect(intra.points.map((p) => p.date)).toContain(D);
  });
});

describe("dbFirstSeries — shallow store (rows < needRows)", () => {
  test("runs the deep arm only and persists the fetched history, scored (§0.2)", async () => {
    const store = await seeded(2, DATES);
    const deep = DATES.map((d, i) => ({ date: d, value: 500 + i }));
    const a = arms({ deep, tail: [{ date: "2026-08-10", value: 999 }] });
    const r = await dbFirstSeries(store, { id: ID, needRows: 5, ...a });

    expect(r.arm).toBe("deep");
    expect(a.calls).toEqual({ deep: 1, tail: 0 });
    expect(r.readings).toEqual(amberScorer(deep));
    const after = await store.getSeries(ID, 100);
    expect(after.map((p) => p.value)).toEqual(deep.map((p) => p.value));
    // (e) every persisted date carries the SCORER's state/delta20 — a revised seed date and a new one alike.
    expect(after[0]).toMatchObject({ date: DATES[0], value: 500, state: "AMBER", rawState: "AMBER", delta20: 50 });
    expect(after[5]).toMatchObject({ date: DATES[5], value: 505, state: "AMBER", rawState: "AMBER", delta20: 50.5 });
    expect(after.every((p) => p.state === "AMBER")).toBe(true);
  });
});

describe("dbFirstSeries — deep-enough store (tail arm)", () => {
  const tail: Observation[] = [
    { date: "2026-08-07", value: 777 }, // overlaps a stored date with a REVISED value
    { date: "2026-08-10", value: 105 }, // overlaps with the SAME value — but the scorer's state differs
    { date: "2026-08-11", value: 888 }, // new tail date
    // 2026-08-06 deliberately absent from the feed: the store's copy must survive
  ];

  test("feed wins on an overlapping date, a stored date the feed lacks is kept, a new date is appended", async () => {
    const store = await seeded(6, DATES);
    const a = arms({ deep: [{ date: "1999-01-01", value: -1 }], tail });
    const r = await dbFirstSeries(store, { id: ID, needRows: 6, ...a });

    expect(r.arm).toBe("tail");
    expect(a.calls).toEqual({ deep: 0, tail: 1 });
    expect(r.readings.map((x) => [x.date, x.level])).toEqual([
      ["2026-08-03", 100],
      ["2026-08-04", 101],
      ["2026-08-05", 102],
      ["2026-08-06", 103],
      ["2026-08-07", 777],
      ["2026-08-10", 105],
      ["2026-08-11", 888],
    ]);
  });

  test("never-delete: the store still holds every prior date; only feed-fetched dates are written, at runAt - 1 ms", async () => {
    const store = await seeded(6, DATES);
    const a = arms({ deep: [], tail });
    await dbFirstSeries(store, { id: ID, needRows: 6, ...a });

    const after = await store.getSeries(ID, 100);
    expect(after.map((p) => p.date)).toEqual([...DATES, "2026-08-11"]);
    // Feed gap ⇒ stored copy kept, UNTOUCHED (its seed vintage, seed state) — never re-scored/re-written.
    expect(after.find((p) => p.date === "2026-08-06")).toMatchObject({ value: 103, state: "RED", delta20: 1.5 });
    expect(after.find((p) => p.date === "2026-08-07")).toMatchObject({ value: 777, state: "AMBER" });
    expect(after.find((p) => p.date === "2026-08-11")).toMatchObject({ value: 888, state: "AMBER" });
    // Same value, different scorer state ⇒ written (state is what the ribbon serves).
    expect(after.find((p) => p.date === "2026-08-10")).toMatchObject({ value: 105, state: "AMBER" });
    // (f) every row the seam wrote carries runAt - 1 ms; the seed vintage is the only other stamp.
    const written = store.readings.filter((x) => x.runAt !== SEED_RUN_AT);
    expect(written.map((x) => x.date).sort()).toEqual(["2026-08-07", "2026-08-10", "2026-08-11"]);
    expect(new Set(written.map((x) => x.runAt))).toEqual(new Set([seamRunAt(RUN_AT)]));
    expect(seamRunAt(RUN_AT)).toBe("2026-08-11T21:04:59.999Z");
  });

  test("equal in all four persisted columns ⇒ not re-written (reader-invisible vintage)", async () => {
    const store = await seeded(6, DATES);
    const a = arms({ deep: [], tail: [{ date: "2026-08-10", value: 105 }] });
    // Scorer agrees with the stored value/delta20/rawState/state → nothing to write.
    const score = (points: Observation[]) =>
      amberScorer(points).map((r) => ({ ...r, delta20: 1.5, rawState: "RED" as const, state: "RED" as const }));
    await dbFirstSeries(store, { id: ID, needRows: 6, ...a, score });
    expect(store.readings.filter((x) => x.date === "2026-08-10")).toHaveLength(1);
  });

  // R1: the unheld half = the never-delete test (08-07 rewrites to 777).
  test("holdFinal ⇒ a FINAL prior with a differing fresh value is kept; a new date still persists", async () => {
    const store = await seeded(6, DATES);
    const tail = [{ date: "2026-08-07", value: 777 }, { date: "2026-08-11", value: 888 }];
    await dbFirstSeries(store, { id: ID, needRows: 6, ...arms({ deep: [], tail }), holdFinal: () => true });
    const written = store.readings.filter((x) => x.runAt !== SEED_RUN_AT).map((x) => x.date);
    expect(written).toEqual(["2026-08-11"]);
  });

  test("same value AND state, different rawState ⇒ re-written (all four persisted columns compare)", async () => {
    const store = await seeded(6, DATES);
    const a = arms({ deep: [], tail: [{ date: "2026-08-10", value: 105 }] });
    // Stored seed is rawState RED / state RED; the scorer keeps state RED but rawState AMBER.
    const score = (points: Observation[]) => amberScorer(points).map((r) => ({ ...r, state: "RED" as const, delta20: 1.5 }));
    await dbFirstSeries(store, { id: ID, needRows: 6, ...a, score });
    const rows = store.readings.filter((x) => x.date === "2026-08-10");
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.runAt === seamRunAt(RUN_AT))).toMatchObject({ rawState: "AMBER", state: "RED" });
  });

  test("`minRows` above `needRows` widens the READ cap; the shallow check stays on needRows", async () => {
    const store = await seeded(6, DATES);
    const asked: number[] = [];
    const getSeries = store.getSeries.bind(store);
    store.getSeries = async (id, limit, range) => (asked.push(limit), getSeries(id, limit, range));
    const a = arms({ deep: [], tail: [] });
    const r = await dbFirstSeries(store, { id: ID, needRows: 6, minRows: 40, ...a });
    expect(asked).toEqual([40]);
    expect(r.arm).toBe("tail");
  });

  test("a rejecting `recordReadings` never throws past the scored readings; `onPersistError` fires once", async () => {
    const store = await seeded(6, DATES);
    store.recordReadings = async () => { throw new Error("db 503"); };
    const errs: unknown[] = [];
    const a = arms({ deep: [], tail });
    const r = await dbFirstSeries(store, { id: ID, needRows: 6, ...a, onPersistError: (e) => errs.push(e) });
    expect(r.readings.map((x) => x.date)).toEqual([...DATES, "2026-08-11"]);
    expect(errs).toHaveLength(1);
    expect(String(errs[0])).toContain("db 503");
  });

  test("`needRows` boundary: stored rows == needRows is NOT shallow", async () => {
    const store = await seeded(6, DATES);
    const a = arms({ deep: [], tail: [] });
    const r = await dbFirstSeries(store, { id: ID, needRows: 6, ...a });
    expect(r.arm).toBe("tail");
    expect(a.calls).toEqual({ deep: 0, tail: 1 });
    // …and one fewer stored row IS shallow.
    const shallow = await seeded(5, DATES);
    const b = arms({ deep: [], tail: [] });
    expect((await dbFirstSeries(shallow, { id: ID, needRows: 6, ...b })).arm).toBe("deep");
    expect(b.calls).toEqual({ deep: 1, tail: 0 });
  });
});

describe("dbFirstSeries — provisional (intraday) stored row", () => {
  const D = "2026-08-12";
  const at = (offMin: number) =>
    new Date(Date.parse(`${D}T00:00:00Z`) + (INTRADAY_CUTOFF_UTC_MIN + offMin) * 60_000).toISOString();
  const run = (store: InMemoryStore, runAt: string) =>
    dbFirstSeries(store, { id: ID, needRows: 1, ...arms({ deep: [{ date: D, value: 50 }], tail: [{ date: D, value: 50 }] }), runAt });
  const newestD = async (store: InMemoryStore) => (await store.getSeries(ID, 5)).find((p) => p.date === D)!;

  test("an EOD run fetching the SAME value as a provisional stored D rewrites it, so D ends final", async () => {
    const store = new InMemoryStore();
    await run(store, at(-1));
    expect(isProvisional(await newestD(store))).toBe(true); // premise: the intraday write is provisional
    await run(store, at(55));
    expect(isProvisional(await newestD(store))).toBe(false);
    expect(store.readings.filter((x) => x.date === D)).toHaveLength(2);
  });

  test("a FINAL stored D with the same value is not re-written", async () => {
    const store = new InMemoryStore();
    await run(store, at(55));
    await run(store, at(120));
    expect(store.readings.filter((x) => x.date === D)).toHaveLength(1);
  });
});

describe("resolveDbFirstArm — an `estimated` stored row never merges (review C1, E2)", () => {
  // Two R5 prints + the EOD `estimated` head on a later date (VIXCLS not yet posted), written AFTER
  // that date's cutoff so it is NOT provisional — only the `estimated` flag can keep it out.
  const PRINTS = ["2026-08-06", "2026-08-07"];
  const EST_D = "2026-08-10";
  async function r5WithEstimate(): Promise<InMemoryStore> {
    const store = new InMemoryStore();
    await store.recordReadings(PRINTS.map((d, i) => ({ ...seedRow(d, 20 + i), indicatorId: "R5" })), SEED_RUN_AT);
    await store.recordReadings([{ ...seedRow(EST_D, 80), indicatorId: "R5", estimated: true }], SEED_RUN_AT);
    const newest = (await store.getSeries("R5", 5)).at(-1)!;
    expect([newest.date, newest.estimated, isProvisional(newest)]).toEqual([EST_D, true, false]); // premise
    return store;
  }

  test.each([false, true])("merged ends on the last PRINT date (keepProvisional=%s)", async (keepProvisional) => {
    const { merged } = await resolveDbFirstArm(await r5WithEstimate(), R5_SLOW_DB_FIRST_FEED, keepProvisional);
    expect([...merged.keys()].sort().at(-1)).toBe(PRINTS.at(-1));
  });

  test("the feed's print for the estimate's date is written FINAL even at the estimate's value", async () => {
    const store = new InMemoryStore();
    const est = { date: EST_D, indicatorId: ID, value: 50, delta20: 5, rawState: "AMBER" as const, state: "AMBER" as const, decision: null, estimated: true };
    await store.recordReadings([est], SEED_RUN_AT);
    await dbFirstSeries(store, { id: ID, needRows: 1, ...arms({ deep: [], tail: [{ date: EST_D, value: 50 }] }) });
    expect((await store.getSeries(ID, 5)).find((p) => p.date === EST_D)?.estimated).toBeUndefined();
  });
});

// §4.2 "Arm log" (ruling 2): `dbFirstOrDirect` emits exactly ONE line per site —
// `[db-first] <id> arm=<deep|tail> have=<stored rows> need=<needRows>` — so a `vercel logs` grep can
// spot an `arm=deep` on run ≥ 2 (⇒ the prior run's persist rejected). The direct arm (no store) logs
// `have=-`. `dbFirstResult.have` surfaces the stored-row count the log reports.
describe("dbFirstOrDirect — arm log (§4.2 ruling 2)", () => {
  const ctxFor = (store: InMemoryStore) => ({ store, runAt: RUN_AT });
  const optsFor = (needRows: number) => ({
    id: ID,
    needRows,
    fetchDeep: async () => DATES.map((d, i) => ({ date: d, value: 500 + i })),
    fetchTail: async () => [{ date: "2026-08-11", value: 888 }],
    score: amberScorer,
  });

  test("deep arm logs `arm=deep` with the real stored-row count, and surfaces it as `have`", async () => {
    const store = await seeded(2, DATES);
    const spy = vi.fn();
    const r = await dbFirstOrDirect(ctxFor(store), optsFor(5), spy);
    expect(r.arm).toBe("deep");
    expect(r.have).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(`[db-first] ${ID} arm=deep have=2 need=5`);
  });

  test("tail arm logs `arm=tail` with the stored-row count", async () => {
    const store = await seeded(6, DATES);
    const spy = vi.fn();
    const r = await dbFirstOrDirect(ctxFor(store), optsFor(6), spy);
    expect(r.arm).toBe("tail");
    expect(r.have).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(`[db-first] ${ID} arm=tail have=6 need=6`);
  });

  test("the direct arm (no ctx) logs `have=-` and runs the deep fetch, persisting nothing", async () => {
    const spy = vi.fn();
    const r = await dbFirstOrDirect(undefined, optsFor(5), spy);
    expect(r.arm).toBe("direct");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(`[db-first] ${ID} arm=direct have=- need=5`);
  });
});
