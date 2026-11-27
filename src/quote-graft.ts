// Pure quote-graft helpers for the sovereign daily-bar legs: a same-day quote grafted onto the EOD bars. Fetch-free
// leaf — `estimated.ts` (on the live api/ read graph) binds `isSovereignYield` without reaching any feed module.

import { headObs, type Observation } from "./domain-types.js";
import { isTargetClosed } from "./market-closures.js";
import { isoDay } from "./dates.js";

/** True for a sovereign-yield symbol (`US10Y`, `US3M`, `GB10Y-GB`) — every other lead symbol is a price-feed ticker. */
export const isSovereignYield = (symbol: string): boolean => /^[A-Z]{2}\d{1,2}[YM](-[A-Z]{2})?$/.test(symbol);

/** `primary` plus ONE head row from `head` when it is strictly newer than `primary`'s last date, shifted by
 *  the basis `proxy[d] − primary[d]` at their latest shared `d` (0 without `proxy`). Same reference otherwise. */
export function graftQuoteHead(
  primary: Observation[],
  head: Observation | undefined,
  proxy?: readonly Observation[],
): Observation[] {
  const last = primary.at(-1);
  if (head === undefined || last === undefined || head.date <= last.date) return primary;
  let basis = 0;
  if (proxy !== undefined) {
    const mine = new Map(primary.map((o) => [o.date, o.value]));
    const shared = [...proxy].reverse().find((o) => mine.has(o.date));
    if (shared === undefined) return primary;
    basis = shared.value - mine.get(shared.date)!;
  }
  return [...primary, headObs(head.date, head.value - basis, "proxyCarry")];
}

/** The weekday before `date` (YYYY-MM-DD): Mon → Fri. */
function prevWeekday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 1 ? 3 : dow === 0 ? 2 : 1));
  return isoDay(d);
}

/** `primary` plus ONE head row at the quote's level, ONLY when `primary`'s last bar is the weekday before the
 *  quote's date (or the last open weekday before it, per `isClosed` — TARGET by default, the euro legs' calendar;
 *  the US legs pass the US market calendar). A lagging last bar (bars a session behind a current quote) would silently drop a session, so
 *  it warns and grafts nothing. Same reference whenever nothing is grafted. */
export function graftQuoteLevel(
  primary: Observation[],
  quote: Observation | undefined,
  symbol = "?",
  isClosed: (isoDate: string) => boolean = isTargetClosed,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Observation[] {
  const last = primary.at(-1);
  if (quote === undefined || last === undefined || quote.date <= last.date) return primary;
  const prev = prevWeekday(quote.date);
  // A closed prior weekday (TARGET 12-25 before Mon 12-28; US Labor Day before Tue) may carry a bar (the sovereign-yield quote feed prints EU legs on them) or not.
  let open = prev;
  while (isClosed(open)) open = prevWeekday(open);
  if (last.date !== prev && last.date !== open) {
    warn(
      `[sovereign-quote] ${symbol} last bar ${last.date} is not the session before quote ${quote.date} (want ${prev}) - no quote head`,
    );
    return primary;
  }
  return [...primary, headObs(quote.date, quote.value, "quote")];
}
