/**
 * Stage 4 backfill unit tests — InMemoryStore ONLY, no live DB. Proves the core reconstructs each
 * NULL-`dialState` row's dial via `assembleDial` (the exact seam probe-dial-roundtrip recomputes
 * with) and writes it under the mandatory NULL-only guard: idempotent, and blind to already-populated
 * rows.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../../src/store-memory.js";
import type { StoredReading } from "../../src/store.js";
import { assembleDial } from "../../src/dial-assembly.js";
import { makeAlert, makeDial } from "../../src/test-helpers.js";
import { backfillDialStateCore, parseArgs } from "./dial-state.js";

const DATE = "2026-06-25";
const RUN_AT = "2026-06-25T21:00:00.000Z";

/** A couple of confirmed readings so getReadingsForRun is non-empty and assembleDial is deterministic. */
const READINGS: StoredReading[] = [
  { date: DATE, indicatorId: "F1", value: 1.2, delta20: 0.1, rawState: "GREEN", state: "GREEN", decision: null },
  { date: DATE, indicatorId: "F2", value: 0.8, delta20: -0.1, rawState: "GREEN", state: "GREEN", decision: null },
];

/** Seed one run (readings + a NULL-dialState alert) into a fresh store. */
async function seedNullRow(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.recordReadings(READINGS, RUN_AT);
  await store.recordAlert(makeAlert({ firedAt: RUN_AT, date: DATE, dialState: null }));
  return store;
}

/** The dial the probe's RECOMPUTE arm would produce for this run — the expected backfill result. */
async function expectedDial(store: InMemoryStore) {
  const readings = READINGS.map((r) => ({ id: r.indicatorId, state: r.state }));
  return (await assembleDial({ readings, asOf: DATE, store })).dial;
}

describe("backfillDialStateCore", () => {
  it("(a) populates a NULL dial_state with the assembleDial reconstruction for the same inputs", async () => {
    const store = await seedNullRow();
    const expected = await expectedDial(store);

    const summary = await backfillDialStateCore(store, { limit: 100 });

    expect(summary).toMatchObject({ scanned: 1, updated: 1, alreadyPopulated: 0, skippedNoReadings: 0 });
    const row = store.alerts.find((a) => a.firedAt === RUN_AT)!;
    expect(row.dialState).not.toBeNull();
    // The backfill WRITES assembleDial output, so the persisted blob deep-equals a fresh recompute here.
    // That is this writer's own guarantee — never a read-path invariant (`probe-dial-roundtrip` retired
    // the blob-equals-recompute oracle 2026-08-16; the live reader serves the blob verbatim).
    expect(row.dialState).toEqual(expected);
  });

  it("(c) leaves an already-populated dial_state untouched", async () => {
    const store = new InMemoryStore();
    await store.recordReadings(READINGS, RUN_AT);
    // A DISTINCT dial already persisted — the backfill must NOT overwrite it.
    const existing = makeDial({ rung: 9, positionP: 0.9 }); // rung 9 ⇒ dangerScore 1 / Crisis (derived)
    await store.recordAlert(makeAlert({ firedAt: RUN_AT, date: DATE, dialState: existing }));

    const summary = await backfillDialStateCore(store, { limit: 100 });
    expect(summary).toMatchObject({ updated: 0, alreadyPopulated: 1 });
    // Untouched: still the original object, not the reconstruction.
    expect(store.alerts[0]!.dialState).toEqual(existing);

    // Direct NULL-only-guard pin: writing over a non-null blob is refused (returns false, no mutation).
    const other = makeDial({ rung: 1 }); // the calm end — distinct from `existing` on every derived field
    expect(await store.backfillDialState(RUN_AT, other)).toBe(false);
    expect(store.alerts[0]!.dialState).toEqual(existing);
  });

  it("skips a NULL row with no reconstructable readings (never fails)", async () => {
    const store = new InMemoryStore();
    // Alert but NO readings recorded for its run → getReadingsForRun empty.
    await store.recordAlert(makeAlert({ firedAt: RUN_AT, date: DATE, dialState: null }));

    const summary = await backfillDialStateCore(store, { limit: 100 });
    expect(summary).toMatchObject({ scanned: 1, updated: 0, skippedNoReadings: 1 });
    expect(store.alerts[0]!.dialState).toBeNull();
  });
});

describe("parseArgs", () => {
  it("defaults to --env=local, --limit=5000", () => {
    expect(parseArgs([])).toEqual({ env: "local", limit: 5000 });
  });
  it("rejects a non-positive --limit", () => {
    expect(parseArgs(["--limit=0"]).error).toMatch(/positive integer/);
  });
});
