import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import { SupabaseStore, LEG_PILLAR_CHUNK, type LegPillarRow } from "./store.js";
import { admin, hasDb, supa, truncate } from "./store.test-helpers.js";

// --- leg_pillars seam (EW W4 Stage 4.2.3) --------------------------------------
//
// `putLegPillars` is the ONLY write path for the replayed per-leg pillar history and
// `getLegPillarSeries` the only read. Three properties carry the design and each is
// pinned below: the chunked upsert (not a one-shot insert), insert-missing idempotence
// (`ignoreDuplicates` on the 4-column PK), and vintage co-existence — two `generator`
// values sharing one (obs_date, sleeve, super_group) prefix, each readable alone.

/** A `LegPillarRow` with the fixture defaults every test below overrides field-wise. */
const pillarRow = (over: Partial<LegPillarRow> = {}): LegPillarRow => ({
  obsDate: "2026-07-01",
  sleeve: "L5",
  superGroup: "EARLY-WARN",
  value: 0.42,
  estimated: false,
  basis: "F1,F2",
  generator: "ew-v0",
  ...over,
});

// --- chunking: DB-free, with a fake PostgREST client ---------------------------
//
// Counts the upsert round trips for a batch straddling two chunk boundaries and asserts
// the EXACT split (1000/1000/500), not merely ">1": a ">1" assertion passes at any chunk
// size from 2 to 2499 and so pins nothing about the boundary the ~16k-row job depends on.

/** Records every `.upsert(rows, opts)` the store issues; answers `{ error: null }`. */
function fakeUpsertClient() {
  const calls: Array<{ table: string; rows: unknown[]; opts: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        upsert(rows: unknown[], opts: unknown) {
          calls.push({ table, rows, opts });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, calls };
}

/** A SupabaseStore whose private client is the fake — no network, no DB. */
function storeWithFakeClient(client: unknown): SupabaseStore {
  const store = new SupabaseStore("http://127.0.0.1:1", "unused-key");
  (store as unknown as { client: unknown }).client = client;
  return store;
}

describe("putLegPillars - chunked upsert", () => {
  test("2500 rows split at the exact chunk boundary: 1000 / 1000 / 500, in order", async () => {
    const { client, calls } = fakeUpsertClient();
    const store = storeWithFakeClient(client);
    // Batch SIZE derives from the constant (2.5 chunks, straddling two boundaries); the
    // expected SPLIT is the literal 1000/1000/500 — deriving that too would track any retune
    // and could never disagree with the code.
    const rows = Array.from({ length: LEG_PILLAR_CHUNK * 2.5 }, (_, i) =>
      pillarRow({ obsDate: `2026-07-01`, sleeve: `L${i}`, value: i }),
    );

    // `rows.length`, not a literal 2500: this line pins "every row is accounted for", and a
    // literal here would fail FIRST under a chunk-size mutation and mask the split assertion.
    expect(await store.putLegPillars(rows)).toBe(rows.length);
    expect(calls.map((c) => c.rows.length)).toEqual([1000, 1000, 500]);
    expect(calls.every((c) => c.table === "leg_pillars")).toBe(true);
    // Insert-missing semantics travel with EVERY chunk, not just the first.
    expect(calls.map((c) => c.opts)).toEqual(
      Array(3).fill({ onConflict: "obs_date,sleeve,super_group,generator", ignoreDuplicates: true }),
    );
    // The chunks partition the batch in order — no row dropped, none sent twice.
    const sent = calls.flatMap((c) => c.rows as Array<Record<string, unknown>>);
    expect(sent).toHaveLength(2500);
    expect(sent[0]!.sleeve).toBe("L0");
    expect(sent[2499]!.sleeve).toBe("L2499");
  });

  test("empty batch is a no-op - zero round trips", async () => {
    const { client, calls } = fakeUpsertClient();
    expect(await storeWithFakeClient(client).putLegPillars([])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// --- InMemoryStore twin: the fake must not diverge from Postgres ---------------

describe("InMemoryStore - leg pillars", () => {
  test("round trip: ordering, null value, estimated flag, tail limit", async () => {
    const store = new InMemoryStore();
    await store.putLegPillars([
      pillarRow({ obsDate: "2026-07-03", value: 0.9 }),
      pillarRow({ obsDate: "2026-07-01", value: null }),
      pillarRow({ obsDate: "2026-07-02", value: 0.5, estimated: true }),
    ]);

    expect(await store.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10)).toEqual([
      { date: "2026-07-01", value: null, estimated: false, basis: "F1,F2" },
      { date: "2026-07-02", value: 0.5, estimated: true, basis: "F1,F2" },
      { date: "2026-07-03", value: 0.9, estimated: false, basis: "F1,F2" },
    ]);
    // `limit` caps the TAIL (newest), not the head.
    expect((await store.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 2)).map((p) => p.date)).toEqual([
      "2026-07-02",
      "2026-07-03",
    ]);
    // A sleeve/super-group nobody wrote is empty, never a cross-leg leak.
    expect(await store.getLegPillarSeries("L1", "EARLY-WARN", "ew-v0", 10)).toEqual([]);
  });

  test("co-existing generators: same (date, sleeve, super_group), each series reads only its own", async () => {
    const store = new InMemoryStore();
    await store.putLegPillars([
      pillarRow({ value: 0.42, generator: "ew-v0" }),
      pillarRow({ value: 0.77, generator: "ew-v1" }),
    ]);
    expect(await store.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10)).toEqual([
      { date: "2026-07-01", value: 0.42, estimated: false, basis: "F1,F2" },
    ]);
    expect(await store.getLegPillarSeries("L5", "EARLY-WARN", "ew-v1", 10)).toEqual([
      { date: "2026-07-01", value: 0.77, estimated: false, basis: "F1,F2" },
    ]);
  });

  test("idempotent: re-running a batch adds nothing and never restates a stored row", async () => {
    const store = new InMemoryStore();
    const batch = [pillarRow({ value: 0.42 }), pillarRow({ obsDate: "2026-07-02", value: 0.5 })];
    await store.putLegPillars(batch);
    // Second run carries a DIFFERENT value under the same PK: ignoreDuplicates means the
    // stored 0.42 stands — a re-run must not restate history.
    await store.putLegPillars([pillarRow({ value: 9.99 }), ...batch]);
    const series = await store.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10);
    expect(series).toHaveLength(2);
    expect(series[0]!.value).toBe(0.42);
  });
});

// --- Integration twin (crash-dash-ci stack only) -------------------------------

describe.runIf(hasDb)("SupabaseStore - leg pillars (integration)", () => {
  beforeEach(truncate);

  test("round trip: ordering, a NULL value, an estimated row, tail limit", async () => {
    expect(await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10)).toEqual([]);

    expect(
      await supa!.putLegPillars([
        pillarRow({ obsDate: "2026-07-03", value: 0.9 }),
        pillarRow({ obsDate: "2026-07-01", value: null }),
        pillarRow({ obsDate: "2026-07-02", value: 0.5, estimated: true, basis: "F1,F2,F9" }),
      ]),
    ).toBe(3);

    const series = await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10);
    expect(series.map((p) => p.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    // The null survives the round trip as null — NOT coerced to 0 (that would be an
    // uncomparable pillar silently entering the ECDF as the calmest observation).
    expect(series[0]!.value).toBeNull();
    expect(series.map((p) => p.estimated)).toEqual([false, true, false]);
    expect(series.map((p) => p.basis)).toEqual(["F1,F2", "F1,F2,F9", "F1,F2"]);
    expect(series[1]!.value).toBeCloseTo(0.5, 12);
    // Tail, not head.
    expect((await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 2)).map((p) => p.date)).toEqual([
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  test("co-existing generators under one (obs_date, sleeve, super_group) prefix", async () => {
    await supa!.putLegPillars([
      pillarRow({ value: 0.42, generator: "ew-v0" }),
      pillarRow({ value: 0.77, generator: "ew-v1" }),
    ]);

    // Both rows are really in the table (the PK admitted the 2nd) …
    const { data, error } = await admin!.from("leg_pillars").select("generator");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => (r as { generator: string }).generator).sort()).toEqual(["ew-v0", "ew-v1"]);
    // … and each series read returns ONLY its own vintage.
    const v0 = await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10);
    const v1 = await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v1", 10);
    expect(v0).toHaveLength(1);
    expect(v1).toHaveLength(1);
    expect(v0[0]!.value).toBeCloseTo(0.42, 12);
    expect(v1[0]!.value).toBeCloseTo(0.77, 12);
  });

  test("idempotent: the same batch twice - no throw, row count unchanged, no restatement", async () => {
    const batch = [pillarRow({ value: 0.42 }), pillarRow({ obsDate: "2026-07-02", value: 0.5 })];
    await supa!.putLegPillars(batch);
    // A plain `.insert` reds here on the PK; the upsert's ignoreDuplicates skips both rows.
    // The repeated row carries a DIFFERENT value, so a restating upsert (ignoreDuplicates
    // dropped) would show as 9.99 below.
    await expect(supa!.putLegPillars([pillarRow({ value: 9.99 }), ...batch])).resolves.toBe(3);

    const series = await supa!.getLegPillarSeries("L5", "EARLY-WARN", "ew-v0", 10);
    expect(series).toHaveLength(2);
    expect(series[0]!.value).toBeCloseTo(0.42, 12);
  });
});
