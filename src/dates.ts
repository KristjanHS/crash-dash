/** Calendar-day helpers: the ONE spelling of a UTC ISO day, and the per-feed publication-calendar "today". */

/** UTC calendar day of `d` as `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The PUBLICATION CALENDAR's timezone — what "today" means when judging whether a feed is late.
 *
 * ⚠ NOT a display preference, and NOT the market timezone. Every freshness cut here is a whole-day
 * date difference, so the only thing that matters is which calendar date the SOURCE thinks it is.
 * Reading a US-published feed against the UTC date runs the lag clock ahead of the calendar
 * the feed actually publishes on, and a daily feed then reads one day older than any healthy
 * publication schedule allows — for the whole window where UTC has rolled over and the source has
 * not (19:00–24:00 US Central during CDT = 00:00–05:00 UTC, i.e. 03:00–08:00 EEST).
 * `STALE_AFTER_DAYS` is set with no margin for that (its docblock derives 4 from the publication
 * calendar exactly), so the phantom day is the difference between "at the limit" and "flagged as
 * lagging".
 *
 * Measured 2026-08-04 04:27 UTC, F1's newest observation 2026-07-30 — a healthy T+1 feed one
 * release behind: UTC ⇒ age 5 ⇒ lagging. America/Chicago ⇒ age 4 ⇒ fresh. That is the whole bug.
 *
 * DEFAULT IS CENTRAL, DELIBERATELY, AND `America/New_York` WOULD NOT HAVE FIXED IT — at that same
 * instant Eastern had ALREADY rolled to Aug 4 (00:27) while Central was still Aug 3 (23:27). The
 * dominant source is FRED (St. Louis Fed; the ICE BofA OAS family posts ~08:52 CT), so the Fed's
 * own zone is the honest calendar. Central is also the LENIENT choice for the US price feeds that
 * ride this default — it rolls an hour after Eastern, so a price feed is never called lagging before
 * its own calendar agrees. Per-source overrides go on the indicator (`feedTimeZone`), for feeds on
 * a genuinely different national calendar — the European-published ones (ECB, sovereign-quote Bund)
 * carry `Europe/Berlin`; the enumeration test in `registry.test.ts` pins that population.
 * @internal
 */
export const FEED_CALENDAR_TZ = "America/Chicago";

/**
 * Today's date (YYYY-MM-DD) on a feed's publication calendar. `en-CA` is the locale whose short
 * date format IS ISO, so this needs no manual padding or component assembly.
 *
 * Callers pass the indicator's `feedTimeZone` and get {@link FEED_CALENDAR_TZ} when it is unset.
 * The caller passes the instant (`now`); this is the ONE seam that resolves it to a feed's "today",
 * rather than each call site spelling out `toISOString()`. `assessFreshness`/`assessIndicatorFreshness` stay pure and take `today` as a string.
 */
export function todayOnFeedCalendar(feedTimeZone: string | undefined, now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: feedTimeZone ?? FEED_CALENDAR_TZ });
}

/** A per-feed "today" — {@link todayOnFeedCalendar} over ONE pinned instant, keyed by the feed's zone. */
export type FeedCalendarToday = (feedTimeZone?: string) => string;

/**
 * ONE clock read for a whole batch of feeds, memoised per DISTINCT zone (one `Intl` formatter per
 * zone, not one per reading), so no two ids in the batch land on opposite sides of a midnight that
 * ticks mid-batch. BOTH paths resolve "today" through this — the run path's stamp
 * (`stampFreshness`, run-cycle-dial.ts) and the read path (`/api/status`) — so the alert row and the
 * status page agree on a feed's age. Before 2026-09-13 the run path stamped every feed on the UTC
 * calendar: at the 22:00 UTC cron hour every `Europe/*` feed (EURC, BUND) had already rolled
 * to the next date on its own calendar, so the notify path read it one publication slot YOUNGER
 * than `/api/status` did minutes later — a prod-visible disagreement on the alert row.
 */
export function feedCalendarTodayResolver(now: Date): FeedCalendarToday {
  const byZone = new Map<string, string>();
  return (feedTimeZone?: string): string => {
    const key = feedTimeZone ?? "";
    const hit = byZone.get(key);
    if (hit !== undefined) return hit;
    const resolved = todayOnFeedCalendar(feedTimeZone, now);
    byZone.set(key, resolved);
    return resolved;
  };
}
