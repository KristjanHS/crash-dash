/**
 * `Reading[] → StoredReading[]` — the ONE persisted-row projection (W5-b Stage 5.1), and a TRUE LEAF:
 * type imports only, so `series-db-first.ts` (imported by `tracks.ts`) can project rows without a
 * value edge into `store-rows.ts` (the cycle DB-first
 * stage 4.2 broke 2026-08-31).
 *
 * Extracted because the exposure hoist needs today's F1/GT rows BEFORE `assembleRun` returns its
 * `storedReadings`; three call sites (notify readings, GLOBAL rows, downside rows) previously spelled
 * this same map inline, so sharing it is what makes "the seed is byte-equal to what `recordRun`
 * persists" a property of the code rather than of vigilance. `store-rows.ts` and `run-core.ts`
 * re-export it for their existing importers.
 */
import type { Reading } from "./domain-types.js";
import type { StoredReading } from "./store.js";

export function toStoredReadings(readings: Reading[]): StoredReading[] {
  return readings.map((r) => ({
    date: r.date,
    indicatorId: r.indicator.id,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: r.state,
    decision: r.decision,
    bandCuts: r.bandCuts ?? null,
  }));
}
