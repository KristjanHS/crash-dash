/**
 * `--dry-run` Store wrapper for the backfill runner (audit SCRIPT-1, Stage 3.1).
 *
 * A truthful dry run has to read the REAL rows — per-job counts are the difference
 * between what the feed has and what the DB already holds — while writing nothing. So
 * this seam is DENY-BY-DEFAULT: reads (`get*` / `checkSchema` / `maxRowsProbe`) pass
 * through, the three mutations a pass performs are tallied instead of executed, and every
 * other method throws before it can reach the DB. A Store method added later is blocked
 * until it is classified here.
 */
import type { Store, StoredReading } from "../../src/store.js";

export interface DryRunTally {
  /** Rows `recordReadings` would have written. */
  rows: number;
  /** The exact ids the runner would hand `pruneShadowedReadings` — the prune scope. */
  pruneIds: string[];
  /** Dates the three dated deletes (`DATED_DELETES`) would have hit, as `indicatorId` → date count. */
  deletes: Record<string, number>;
}

/** Read-only Store methods, by the interface's naming convention (`record*`/`prune*` are the writes). */
const READ_THROUGH = /^(get|checkSchema$|maxRowsProbe$)/;

/** The dated deletes — every-row, estimate-only (E3 sweep) and non-estimate (orphan heads); all tallied alike. */
const DATED_DELETES: ReadonlySet<PropertyKey> = new Set(["deleteReadingsOnDates", "deleteEstimatesOnDates", "deleteNonEstimatesOnDates"]);

/** Wrap a live store so a pass runs for real against reads and only tallies its writes. */
export function makeDryRunStore(store: Store): { store: Store; tally: DryRunTally } {
  const tally: DryRunTally = { rows: 0, pruneIds: [], deletes: {} };
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "recordReadings") {
        return async (readings: StoredReading[]) => {
          tally.rows += readings.length;
        };
      }
      if (prop === "pruneShadowedReadings") {
        // null = GC scope (the cron's shape); the backfill runner always passes explicit ids.
        return async (indicatorIds: string[] | null) => {
          tally.pruneIds = indicatorIds === null ? ["(all ids — GC scope)"] : [...indicatorIds];
          return 0;
        };
      }
      if (DATED_DELETES.has(prop)) {
        // The restate path's destructive half — tally, never execute.
        return async (indicatorId: string, dates: string[]) => {
          tally.deletes[indicatorId] = (tally.deletes[indicatorId] ?? 0) + dates.length;
          return 0;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && READ_THROUGH.test(prop)) return value.bind(target);
      throw new Error(
        `[backfill] dry-run: refusing to call unclassified Store method \`${String(prop)}\` — ` +
          `a dry run must write nothing. Classify it in dry-run-store.ts (read ⇒ pass through, write ⇒ tally).`,
      );
    },
  });
  return { store: proxy, tally };
}

/**
 * The ` would delete-on-date FXH:454;` clause for a DRY-RUN summary line — empty string when the
 * pass requested no dated deletes, so an ordinary dry run keeps its existing output.
 * Shared so `probe-restate.ts` and `backfill/run.ts` cannot drift into reporting the same tally
 * differently (or, as before, one of them not at all).
 */
export function datedDeleteClause(tally: DryRunTally): string {
  const entries = Object.entries(tally.deletes);
  if (entries.length === 0) return "";
  return ` would delete-on-date ${entries.map(([id, n]) => `${id}:${n}`).join(", ")};`;
}
