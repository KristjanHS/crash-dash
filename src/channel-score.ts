/**
 * Σ state ranks over a channel's readings (Red=2, Amber=1, Green=0) (v4 §6.2).
 *
 * Extracted out of `ladder.ts` (O2 step 1, 2026-07-15) so the alert-band
 * escalator floors (RATE stress in `alert-band.ts`) don't depend on the
 * legacy verdict module (retired 2026-07-15; its frozen backtest copy
 * legacy-ladder.ts was deleted 2026-08-15); this sum stays load-bearing.
 */
import { STATE_RANK, type Reading } from "./domain-types.js";

export function channelScore(readings: Reading[]): number {
  return readings.reduce((s, r) => s + STATE_RANK[r.state], 0);
}
