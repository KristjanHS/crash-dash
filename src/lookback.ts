import { isoDay } from "./dates.js";
/**
 * Fetch-window constants shared by the fetchers and the read path. A dependency-free leaf, so a read
 * handler sizing a DB-first window never imports a fetcher (`scripts/arch-rules.test.ts`).
 */

// Deep-history lookback for the one-shot backfill (`{ deep: true }`). Generously
// over the deepest registry `backfill` depth (the backfill script trims each id to its own depth) so the
// fetch never under-supplies the deepest seedable window. Sizes a price source's
// deep start date (`{ deep: true }`, prices.ts).
export const DEEP_LOOKBACK_DAYS = 20 * 365;

/** `days` calendar days before `now` as `YYYY-MM-DD` — the shape `fetchSeries`'s `since` takes.
 *  Exported so a deep-window call site derives its bound the same way the default one does. */
export const sinceDaysAgo = (days: number, now: Date): string =>
  isoDay(new Date(now.getTime() - days * 86_400_000));
