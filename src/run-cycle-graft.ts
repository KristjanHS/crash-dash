/** Run-cycle intraday graft: the per-run sovereign-quote memo, sovereign/US legs, and the ONE daytime-head seam (`liveHead`). */

import type { Observation } from "./domain-types.js";
import { dropTargetHolidays } from "./market-closures.js";
import { graftQuoteHead, isSovereignYield } from "./quote-graft.js";
import { extendWithEstimate } from "./nowcast-score.js";
import { nowcastLevelCarry, usRateLead } from "./level-nowcast.js";
import { isMarketHoliday, isSourceHoliday, recentMarketDay } from "./source-holidays.js";
import { withStoredLegs } from "./input-series.js";
import { estimateAnchored } from "./estimated.js";
import { degrade, recordDegrade } from "./tracks.js";
import { isNoFreeSource } from "./no-free-source.js";
import { finalDates } from "./intraday.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { INDICATOR_BY_ID, once, type RunBase, type RunGraft } from "./run-cycle-ctx.js";

export function createGraft(base: RunBase): RunGraft {
  const { fetchSovereignBars, fetchDailyCloses, graftQuoteLevel, fetchSovereignQuote } = base.feeds;
  // The ONE sovereign-quote clock: each symbol's bars pulled ONCE per cycle (deep since 2010 for the σ head) + one live-quote
  // head, grafted BEFORE the TARGET drop (a quote failure degrades to the bars); EOD the head is stored `estimated`.
  const quotes = new Map<string, Promise<Observation | undefined>>();
  const quoteOf = (symbol: string): Promise<Observation | undefined> => {
    let p = quotes.get(symbol);
    if (p === undefined) {
      p = fetchSovereignQuote(symbol, new Date(base.runAt)).catch((err: unknown) => {
        console.warn(`[sovereign-quote] ${symbol} restQuote unavailable - EOD bars only: ${String(err)}`);
        recordDegrade(`[sovereign-quote] ${symbol} restQuote unavailable - EOD bars only`, String(err), "notify", isNoFreeSource(err) ? { kind: "no-free-source" } : undefined);
        return undefined;
      });
      quotes.set(symbol, p);
    }
    return p;
  };
  // The sovereign-quote bars' window end (today, UTC).
  const boeEnd = base.runAt.slice(0, 10);
  // `keep` defaults to the euro legs' TARGET drop; the US legs (Stage 5.2) drop no bar. `isClosed` is the calendar the
  // quote graft walks back across to find the session before the quote — TARGET for the euro legs, SIFMA (US_RATES) for the US legs.
  const buildSovereignLeg = (
    symbol: string,
    keep: (obs: Observation[]) => Observation[] = dropTargetHolidays,
    isClosed?: (isoDate: string) => boolean,
  ) =>
    once(async () => {
      const quote = quoteOf(symbol); // in flight alongside the bars
      const bars = await fetchSovereignBars(symbol, "2010-01-01", boeEnd);
      // Level graft: the quote's last price is on the bars' level; its previous close rolls at the close.
      return keep(graftQuoteLevel(bars, await quote, symbol, isClosed));
    });
  // The default (TARGET-dropped euro) leg is ONE thunk per symbol per run: the cards share one pull.
  const euroLegs = new Map<string, () => Promise<Observation[]>>();
  const sovereignLeg: RunGraft["sovereignLeg"] = (symbol, keep, isClosed) => {
    if (keep !== undefined || isClosed !== undefined) return buildSovereignLeg(symbol, keep, isClosed);
    return euroLegs.get(symbol) ?? euroLegs.set(symbol, buildSovereignLeg(symbol)).get(symbol)!;
  };
  // Stage 5.2 (E16/E17): R1/R2/R3 carry their FRED prints over the sovereign-yield quote feed's US Treasury legs (their registry `estimator.leads`). No TARGET
  // drop — the estimate's own date is gated on the US calendar (`recentMarketDay` in `pushEstimate`, `isSourceHoliday` in `liveHead`) —
  // and the quote graft walks back across US closures (review I2: on the session after a US-only holiday, the sovereign-yield quote feed has no
  // bar on the holiday, so the TARGET walk-back would refuse the graft and drop the head + EOD estimate).
  const usClosed = (d: string): boolean => isMarketHoliday("US_RATES", d);
  const memo = <T, K extends string = string>(build: (key: K) => () => Promise<T>) => {
    const made = new Map<K, () => Promise<T>>();
    return (key: K): Promise<T> => (made.get(key) ?? made.set(key, build(key)).get(key)!)();
  };
  const usLeg = memo((symbol) => sovereignLeg(symbol, (obs) => obs, usClosed));
  // One resolver for every registry estimator (the FRED loop's + VT's `leg-ratio`, `vixEstimatePoints`): a sovereign-quote yield reads the US leg above, anything else its daily closes
  // (holes filled from the stored `INPUT_SERIES` rows where the symbol is rostered).
  const estimatorLegs = memo((id) =>
    once(() => {
      const leads = INDICATOR_BY_ID.get(id)?.estimator?.leads ?? [];
      for (const s of leads) base.markFallbackSourced(id, s); // intraday `liveHead` scores the carried id off these closes
      const closes = withStoredLegs(base.store, leads, (symbol) => fetchDailyCloses(symbol, { now: () => Date.parse(base.runAt), env: base.env }), NOWCAST_MAX_CARRY_DAYS + 1, {
        now: new Date(base.runAt),
        onFail: (scope, reason) => recordDegrade(scope, reason, "notify"),
      });
      return Promise.all(leads.map((s) => (isSovereignYield(s) ? usLeg(s) : closes(s))));
    }),
  );
  // The ONE daytime head, a `proxyCarry` obs (`headObs`) stored `estimated`. `legs` overrides the registry resolver;
  // a `carry-level` id only, same `prints` reference when nothing grafts.
  // sovereign-yield leads: the lead's grafted head basis-shifted onto the print at their latest shared date (E17), only when
  // EVERY lead's quote is dated the head, a session — a live quote is intraday, never `estimateAnchored`-gated; a print there wins.
  // Any other lead (R5's `^VIX` bar): the level carry, only when dated the run's own day — an earlier lead bar (an
  // early-UTC run before the index publisher posts D−1) would persist as D−1's row. The index publisher's print at the lead's date wins (the carry returns null).
  const liveHead = async (id: string, prints: Observation[], legs?: readonly Observation[][]): Promise<Observation[]> => {
    const e = INDICATOR_BY_ID.get(id)?.estimator;
    if (e?.kind !== "carry-level") return prints;
    const resolved = legs ?? (await degrade<Observation[][] | undefined>(`[graft] ${id} estimator legs unavailable - no live head`, "notify", undefined, () => estimatorLegs(id)));
    if (resolved === undefined) return prints;
    const lead = usRateLead(resolved);
    const anchored = (date: string): boolean => !isSourceHoliday(id, date) && estimateAnchored(id, finalDates(prints, id), date);
    if (e.leads.every(isSovereignYield)) {
      const head = lead.at(-1);
      if (head === undefined || recentMarketDay(id, head.date) !== head.date) return prints;
      const live = (await Promise.all(e.leads.map((s) => quoteOf(s)))).every((q) => q?.date === head.date);
      return live ? graftQuoteHead(prints, head, lead) : prints;
    }
    const est = nowcastLevelCarry(prints, lead, e.beta);
    return est && est.date === base.firedDateIso && anchored(est.date) ? extendWithEstimate(prints, [est]) : prints;
  };
  return { quoteOf, sovereignLeg, estimatorLegs, liveHead, boeEnd };
}

