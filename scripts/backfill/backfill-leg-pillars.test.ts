import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../../src/store-memory.js";
import { backfillLegPillars, LEG_PILLAR_MIN_ROWS_PER_PAIR } from "./backfill-leg-pillars.js";
import { legPillarGenerator, type LegPillarWalkRow } from "./leg-pillar-walk.js";

/**
 * A replay stand-in: `dates` closes × 2 sleeves × 2 super-groups, with a per-super-group `basis`
 * (as the real walk emits — `legPillarBasis` differs per super-group). `short` shrinks ONE
 * sleeve's EARLY-WARN history so the acceptance floor has something to catch.
 */
function fakeWalk(dates: number, short?: { sleeve: string; keep: number }): LegPillarWalkRow[] {
  const rows: LegPillarWalkRow[] = [];
  for (let i = 0; i < dates; i++) {
    // Distinct dates: the store keys on (obs_date, sleeve, super_group, generator), so a
    // repeating calendar would silently collapse rows and understate every count.
    const date = new Date(Date.UTC(2018, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    for (const sleeve of ["us_large", "cash"]) {
      for (const superGroup of ["EARLY-WARN", "STRESS-NOW"] as const) {
        if (short && sleeve === short.sleeve && superGroup === "EARLY-WARN" && i >= short.keep) continue;
        rows.push({
          date,
          sleeve,
          superGroup,
          value: i % 7 === 0 ? null : i / 100,
          estimated: false,
          basis: `roster-${superGroup}`,
        });
      }
    }
  }
  return rows;
}

/**
 * The `legpillars` pass itself (Stage 4.2.4). Offline: the walk is injected, so what is under
 * test is the acceptance floor, the dry-run stop and the row mapping — not the replay.
 */
describe("backfillLegPillars", () => {
  const min = LEG_PILLAR_MIN_ROWS_PER_PAIR;

  it("THROWS naming the short EARLY-WARN pairs rather than seeding a shallow history", async () => {
    const store = new InMemoryStore();
    const deps = { replay: async () => fakeWalk(min, { sleeve: "cash", keep: min - 1 }) };
    await expect(backfillLegPillars(store, deps, { closes: 400 })).rejects.toThrow(
      new RegExp(`acceptance FAILED.*EARLY-WARN pair\\(s\\) below ${min}.*cash:${min - 1}`),
    );
    expect(store.legPillars).toHaveLength(0); // and it threw BEFORE writing
  });

  it("throws on an empty walk — an 'every pair ≥ N' gate is vacuously true over no pairs", async () => {
    await expect(backfillLegPillars(new InMemoryStore(), { replay: async () => [] }, {})).rejects.toThrow(
      /no EARLY-WARN \(sleeve, super_group\) pair at all/,
    );
  });

  it("--dry-run reports the counts and writes NOTHING", async () => {
    const store = new InMemoryStore();
    const { summary } = await backfillLegPillars(store, { replay: async () => fakeWalk(min) }, { dryRun: true });
    expect(store.legPillars).toHaveLength(0);
    expect(summary).toMatch(/NOT written \(dry run\)/);
    expect(summary).toMatch(new RegExp(`EARLY-WARN us_large:${min}, cash:${min}`));
    // Pin the provenance lead on THIS path too. Both returns interpolate the same `shape`, but that
    // is the thing a regression would break — a hand-rebuilt string in the dry-run branch alone would
    // pass every other assertion here.
    expect(summary).toMatch(/^no provider fetch — local replay of \d+ stored close\(s\) \(window \d+\) →/);
  });

  it("a real pass writes every walked row, stamped with the generator and the walk's own basis", async () => {
    const store = new InMemoryStore();
    const { summary, ids } = await backfillLegPillars(store, { replay: async () => fakeWalk(min) }, { closes: 900 });
    expect(ids).toEqual([]); // prunes NOTHING — leg_pillars carries no indicator_id to prune by
    expect(store.legPillars).toHaveLength(min * 4);
    // "submitted", not "upserted": the count is rows HANDED to the store, and the insert-missing
    // upsert writes 0 of them on a re-run.
    expect(summary).toMatch(new RegExp(`${min * 4} row\\(s\\) submitted \\(insert-missing\\)`));
    // The provenance clause is USER-VISIBLE TEXT and the whole point of it is that it LEADS. Without
    // this pin the line could silently revert to opening `900 close(s) → 16200 row(s)`, which reads as
    // a 16k-row provider pull (it is a store-local replay — `replayLegPillars` fetches nothing) and
    // is exactly the misreading it was reworded to stop on 2026-07-31.
    expect(summary).toMatch(/^no provider fetch — local replay of \d+ stored close\(s\) \(window \d+\) →/);
    // The replayed depth is the WALK's distinct dates, not the requested `--closes`. fakeWalk(min)
    // emits `min` dates against a 900 window, so these two must NOT be equal — a fixture where they
    // coincide could not tell the two quantities apart.
    expect(summary).toMatch(new RegExp(`local replay of ${min} stored close\\(s\\) \\(window 900\\)`));
    // Hoist the two tags — `legPillarGenerator` recomputes an ~11 ms digest per call, so calling it
    // inside a per-row predicate over `min*4` rows times out the suite.
    const ewTag = legPillarGenerator("EARLY-WARN");
    const snTag = legPillarGenerator("STRESS-NOW");
    // The written rows span EXACTLY the two per-super-group tags — a per-row stamp (§11.1), not one
    // const per run. `LEG_PILLAR_GENERATOR` is the EW arm; SN carries `sn-`.
    expect(new Set(store.legPillars.map((r) => r.generator))).toEqual(new Set([ewTag, snTag]));
    // The real regression pin: no STRESS-NOW row wears the EARLY-WARN tag. A single-const stamp would
    // put `ew-` on every SN row and red HERE, silently interleaving two SN vintages under one hash.
    const snRows = store.legPillars.filter((r) => r.superGroup === "STRESS-NOW");
    expect(snRows.length).toBeGreaterThan(0);
    expect(snRows.every((r) => r.generator === snTag)).toBe(true);
    expect(snRows.some((r) => r.generator === ewTag)).toBe(false);
    // The `basis` must survive the mapping VARYING (Stage 4.4's mixed-basis detection reads it);
    // a hard-coded literal in the job would collapse this to one value.
    expect(new Set(store.legPillars.map((r) => r.basis)).size).toBe(2);
    const first = store.legPillars[0]!;
    expect(first).toMatchObject({ obsDate: "2018-01-01", sleeve: "us_large", superGroup: "EARLY-WARN", value: null });
  });
});
