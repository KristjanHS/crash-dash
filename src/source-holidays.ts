/**
 * Exchange-closure calendars per persisted id (moved from `scripts/probe-series-holes.ts`,
 * "recent market day"): the hole probe excuses these dates, and the
 * nowcast writes no estimate on them — the source never prints that date, so no print would ever supersede it.
 */
import { MARKET_CLOSURES, type Market } from "./market-closures.js";
import { legCloseQuotes, SB_BENCH_ID, SB_STRAT_ID } from "./scoreboard.js";
import { isoDay } from "./dates.js";

export {   type Market } from "./market-closures.js";

/** `LEGP_*` ids whose quoted ticker `onVenue` holds (a Xetra `.DE` line closes on XETRA, an LSE `.L` on England). */
const legIdsOn = (onVenue: (ticker: string) => boolean): string[] => legCloseQuotes().filter(([, q]) => onVenue(q.ticker)).map(([id]) => id);

/** The static tables (`market-closures.ts`, the registry-free leaf the slot-lag path reads) plus the venue-derived
 *  display lines: `LEGP_*` legs on their ticker's exchange and the SB NAV pair, which links only on an ACWI close
 *  (`chainLinkDate`). An id listed in two calendars closes on their union. @internal */
export const MARKET_CALENDARS: Record<Market, { holidays: readonly string[]; ids: readonly string[] }> = {
  ...MARKET_CLOSURES,
  US: { ...MARKET_CLOSURES.US, ids: [...MARKET_CLOSURES.US.ids, ...legIdsOn((t) => !/\.(DE|L)$/.test(t)), SB_STRAT_ID, SB_BENCH_ID] },
  UK: { ...MARKET_CLOSURES.UK, ids: [...MARKET_CLOSURES.UK.ids, ...legIdsOn((t) => t.endsWith(".L"))] },
  XETRA: { ...MARKET_CLOSURES.XETRA, ids: [...MARKET_CLOSURES.XETRA.ids, ...legIdsOn((t) => t.endsWith(".DE"))] },
};

/** Daily roster ids that print every weekday: closes-feed FX trades 24/5; the ECB CISS index has no weekday hole (2024–2026). */
export const NO_HOLIDAY_IDS: readonly string[] = ["F11", "F17", "FXH", "ECISS"];

/** True when `date` is a listed closure of `market` (same 2026–2027 coverage as `isSourceHoliday`). */
export function isMarketHoliday(market: Market, date: string): boolean {
  return MARKET_CALENDARS[market].holidays.includes(date);
}

/** True when `date` is a listed closure of `id`'s market. ⚠ Covers 2026–2027 only — outside it this reads false, and
 *  `sweepSupersededEstimates` deletes an orphaned estimate once a later print skips its date. */
export function isSourceHoliday(id: string, date: string): boolean {
  return Object.values(MARKET_CALENDARS).some((c) => c.ids.includes(id) && c.holidays.includes(date));
}

/** `id`'s "recent market day": the newest weekday ≤ `date` that is not
 *  one of its source holidays — a weekend holds Friday, a holiday its prior session. */
export function recentMarketDay(id: string, date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  for (;;) {
    const iso = isoDay(d);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isSourceHoliday(id, iso)) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
  }
}

/** `id`'s session before `date` — `recentMarketDay` of the day before (`estimateAnchored`'s anchor date). */
export function prevSession(id: string, date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return recentMarketDay(id, isoDay(d));
}
