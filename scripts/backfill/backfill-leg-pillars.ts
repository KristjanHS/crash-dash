/**
 * The `legpillars` backfill pass — replay the danger engine over the last `--closes` store
 * closes and persist every (date × leg × super-group) pillar reading into `leg_pillars`
 * (EW W4 Stage 4.2.4).
 *
 * Thin by construction: the walk itself lives in `leg-pillar-walk.ts` — the SAME function the
 * EW-liveness probe drives — so the probe stays a real control arm for this job instead of a
 * lookalike that can drift. This file only maps rows, gates them, and writes.
 *
 * The write is insert-missing (`putLegPillars` upserts with `ignoreDuplicates` on the 4-column
 * PK), so a re-run is a no-op rather than a restatement — nothing here deletes or rewrites.
 */
import { replayLegPillars, legPillarGenerator } from "./leg-pillar-walk.js";
import type { PillarSuperGroup } from "../../src/leg-percentile.js";
import type { LegPillarRow, Store } from "../../src/store.js";

/** Default replay window. 900 closes ≈ 3.5y of trading days — deep enough that Stage 4.3's
 *  rolling ECDF has a real distribution per (sleeve, super-group), not a handful of points. */
export const LEG_PILLAR_DEFAULT_CLOSES = 900;

/**
 * Acceptance floor: every EARLY-WARN (sleeve, super_group) pair must carry at least this many
 * replayed rows or the pass THROWS instead of seeding a short history. This is the whole reason
 * `--closes` is threaded through the runner: `--closes=400` must red loudly (Stage 4.2.4
 * falsifier 1), because a percentile column served off a 400-point window would silently be a
 * different statistic than the one Stage 4.3 specifies.
 */
export const LEG_PILLAR_MIN_ROWS_PER_PAIR = 500;

/** The super-group the acceptance floor is asserted on (the column Stage 4.3 serves). */
const ACCEPTANCE_SUPER_GROUP = "EARLY-WARN";

/** Injection seam: the live walk, swappable in tests. */
export interface LegPillarDeps {
  replay: typeof replayLegPillars;
}

export const liveLegPillarDeps: LegPillarDeps = { replay: replayLegPillars };

/** `${sleeve}|${superGroup}` → row count, in first-seen order. */
export function countPairs(rows: readonly LegPillarRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.sleeve}|${r.superGroup}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Throw unless EVERY EARLY-WARN pair clears the floor. The empty case throws too: a pass that
 * produced no EARLY-WARN pair at all would otherwise satisfy an "every pair ≥ 500" quantifier
 * vacuously and report success having replayed nothing.
 */
export function assertAcceptance(counts: Map<string, number>, min: number, closes: number): void {
  const ew = [...counts].filter(([key]) => key.endsWith(`|${ACCEPTANCE_SUPER_GROUP}`));
  if (ew.length === 0) {
    throw new Error(
      `acceptance FAILED: the replay produced no ${ACCEPTANCE_SUPER_GROUP} (sleeve, super_group) pair at all ` +
        `(--closes=${closes}) — nothing to seed.`,
    );
  }
  const short = ew.filter(([, n]) => n < min);
  if (short.length > 0) {
    throw new Error(
      `acceptance FAILED: ${short.length}/${ew.length} ${ACCEPTANCE_SUPER_GROUP} pair(s) below ${min} row(s) ` +
        `at --closes=${closes}: ${short.map(([key, n]) => `${key.split("|")[0]}:${n}`).join(", ")}. ` +
        `Re-run with a deeper --closes (default ${LEG_PILLAR_DEFAULT_CLOSES}).`,
    );
  }
}

/** Compact `sleeve:count` detail over the acceptance super-group only (18 pairs is a wall of text). */
function acceptanceDetail(counts: Map<string, number>): string {
  return [...counts]
    .filter(([key]) => key.endsWith(`|${ACCEPTANCE_SUPER_GROUP}`))
    .map(([key, n]) => `${key.split("|")[0]}:${n}`)
    .join(", ");
}

/**
 * Replay → map → gate → write. A dry run stops at the gate: `putLegPillars` is a genuine write
 * that the runner's dry-run Store wrapper does not (and must not) tally, so the pass returns
 * BEFORE it, and `select count(*) from leg_pillars` stays 0 (falsifier 2).
 */
export async function backfillLegPillars(
  store: Store,
  deps: LegPillarDeps,
  opts: { closes?: number; dryRun?: boolean } = {},
): Promise<{ summary: string; ids: string[] }> {
  const closes = opts.closes ?? LEG_PILLAR_DEFAULT_CLOSES;
  const walked = await deps.replay({ store }, { closes });
  // `legPillarGenerator` recomputes an ~6 ms digest per call, so memoize the two tags here rather than
  // pay it on all ~16k rows. Per-row stamp, NOT one const: SN rows carry `sn-`, EW rows `ew-`, so an
  // SN-only `MEMBER_WEIGHT` edit mints a new SN vintage without touching the EW series (§11.1).
  const genOf = new Map<PillarSuperGroup, string>();
  const generatorFor = (sg: PillarSuperGroup): string => {
    const g = genOf.get(sg) ?? legPillarGenerator(sg);
    genOf.set(sg, g);
    return g;
  };
  const rows: LegPillarRow[] = walked.map((r) => ({
    obsDate: r.date,
    sleeve: r.sleeve,
    superGroup: r.superGroup,
    value: r.value,
    estimated: r.estimated,
    basis: r.basis,
    generator: generatorFor(r.superGroup),
  }));

  const counts = countPairs(rows);
  assertAcceptance(counts, LEG_PILLAR_MIN_ROWS_PER_PAIR, closes);
  // LEAD WITH THE PROVENANCE, not the row count. The old line opened `900 close(s) → 16200 row(s)`,
  // which reads as a 16k-row pull from a data provider and prompted "why does this refetch so much
  // history every run?" (2026-07-31). It fetches NOTHING: `replayLegPillars` is read-only against the
  // store — its only outward call is `store.getSeries(...)` over already-persisted `readings` — and
  // the rows are re-derived in-process. Say so before the numbers, or the numbers get misread.
  // ⚠ REPORT THE REPLAYED DEPTH, NOT `closes`. `closes` is the REQUESTED window; the walk replays
  // `calendar.slice(-replayN)`, which is shorter when the store holds less depth — and the acceptance
  // floor (500) tolerates that. Saying "N *stored* close(s)" asserts the store actually holds them, so
  // the requested number would be a claim the code cannot back. Print both: what was replayed, and the
  // window that was asked for.
  const replayed = new Set(rows.map((r) => r.obsDate)).size;
  // Two generators now, one per super-group (§11.1) — print the distinct set, not the single EW const.
  const generators = [...new Set(rows.map((r) => r.generator))].sort().join(", ");
  const shape =
    `no provider fetch — local replay of ${replayed} stored close(s) (window ${closes}) ` +
    `→ ${rows.length} row(s) across ${counts.size} (sleeve, super_group) pair(s) ` +
    `@ generators ${generators}; ${ACCEPTANCE_SUPER_GROUP} ${acceptanceDetail(counts)}`;

  // `ids` stays EMPTY on both paths: `leg_pillars` carries no `indicator_id` and no vintage
  // column, so the runner's self-prune (which deletes shadowed `readings`) has no scope here.
  if (opts.dryRun) return { summary: `${shape} — NOT written (dry run)`, ids: [] };

  // `putLegPillars` returns the rows HANDED IN that the retention policy keeps, not the rows the DB actually inserted (the upsert
  // is `ignoreDuplicates`, so a re-run inserts 0 while still returning ~16k). Word the line for what
  // the number IS — "upserted" read as a write count and made the idempotent second run look like a
  // full restatement.
  const submitted = await store.putLegPillars(rows);
  return { summary: `${shape}; ${submitted} row(s) submitted (insert-missing)`, ids: [] };
}
