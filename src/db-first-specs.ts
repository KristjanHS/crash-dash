import { CG } from "./registry-composite.js";
import { DEEP_LOOKBACK_DAYS } from "./lookback.js";
import { needRowsForCalendarDays, readRowsForCalendarDays, type DbFirstFeedSpec } from "./series-db-first.js";

/** CG's DB-first feed spec (`warmup: true` — the warm-up union counts toward the arm; see the CG
 *  entry's docblock). Read by BOTH the run path
 *  (`confirmers.ts`) and the read path (`api/series.ts`), hence its own leaf. */
export const CG_DB_FIRST_FEED: DbFirstFeedSpec = {
  id: CG.id,
  needRows: needRowsForCalendarDays(DEEP_LOOKBACK_DAYS),
  // Read cap reaches `CG_LEVEL_ANCHOR` until ~2046; a cap of `needRows` drops the head the cron's base starts at.
  minRows: readRowsForCalendarDays(2 * DEEP_LOOKBACK_DAYS),
  warmup: true,
};
