/** The run cycle's feed IO as injectable ports (`RunCycleOptions.feeds`); the defaults delegate lazily to each
 *  module namespace, so a `vi.spyOn(<namespace>, fn)` still intercepts. Every daily-close, hourly-bar, sovereign
 *  bar/quote, official-leg, index-EOD, DRAM-spot, CAPE and volatility-index fetch reaches its source only through this
 *  file: consumers take the port off `feedsOf(ctx)`, or off `realFeeds` (resolved per call) where no ctx exists.
 *  A `noFreeSource()` binding is an extension slot: no free source serves that data, so it throws `NoFreeSourceError`
 *  and the caller degrades; binding a provider here reaches every consumer. */

import type { Env } from "./config.js";
import type { Observation } from "./domain-types.js";
import * as ebp from "./ebp.js";
import * as ecb from "./ecb.js";
import type { FetchLike } from "./fetch-budget.js";
import * as fred from "./fred.js";
import * as gsw from "./gsw.js";
import { noFreeSource } from "./no-free-source.js";
import type { Bar, PriceDeps } from "./price-cache.js";
import * as prices from "./prices.js";
import * as quoteGraft from "./quote-graft.js";
import * as treasury from "./treasury.js";
import * as vixTerm from "./vix_term.js";

// Source ports read inside the real `fetchSeries` binding below (and `fetchIndexEod`, the injectable index-EOD source
// of `fetchOfficialLeg`) — never by the run cycle directly, so they are not `FeedPorts` members (an injected run fakes
// the outer port instead).
/** Whole daily-close history of a volatility index (the vol-index-only ids of `fred.fetchSeries`). */
const fetchVolIndexCloses: fred.VolIndexFetch = async () => noFreeSource("vol-index closes");
/** End-of-day closes of an index instrument. */
export const fetchIndexEod = async (_q: { instrumentId: string; label: string; range?: "M1" | "Y1" | "Y5"; startDate: string }): Promise<Observation[]> =>
  noFreeSource("index EOD");

export interface FeedPorts {
  fetchDailyCloses: typeof prices.fetchDailyCloses;
  drainProviderFallbacks: typeof prices.drainProviderFallbacks;
  fetchSeries: typeof fred.fetchSeries;
  fredOutage: typeof fred.fredOutage;
  drainKeyedFallbacks: typeof fred.drainKeyedFallbacks;
  startFredMemo: typeof fred.startFredMemo;
  fetchEbp: typeof ebp.fetchEbp;
  /** Daily bars for a sovereign-yield symbol. */
  fetchSovereignBars: (
    symbol: string,
    from: string,
    to: string,
    interval?: "1D" | "30M",
    deps?: { fetchImpl?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<unknown> },
  ) => Promise<Observation[]>;
  graftQuoteLevel: typeof quoteGraft.graftQuoteLevel;
  fetchVixSeries: typeof vixTerm.fetchVixSeries;
  fetchEcbSeries: typeof ecb.fetchEcbSeries;
  /** Official 10y yield leg history. */
  fetchOfficialLeg: (
    leg: "FR10Y" | "DE10Y" | "IT10Y",
    since: string,
    opts: { now: Date; env: Env; fetchIndexEod?: typeof fetchIndexEod },
  ) => Promise<{ source: string; obs: Observation[] }>;
  fetchNtfsSeries: typeof gsw.fetchNtfsSeries;
  /** Latest DRAM spot session average for an item. */
  fetchDramSpot: (item: string) => Promise<Observation[]>;
  /** Live quote for a sovereign-yield symbol. */
  fetchSovereignQuote: (symbol: string, now: Date, deps?: { fetchImpl?: FetchLike }) => Promise<Observation | undefined>;
  fetchTreasuryColumn: typeof treasury.fetchTreasuryColumn;
  /** Monthly Shiller-CAPE history (F7, ECY's valuation leg). */
  fetchCape: () => Promise<Observation[]>;
  /** Hourly bars for a ticker. */
  fetchHourlyBars: (symbol: string, range?: string, deps?: Pick<PriceDeps, "fetchImpl">) => Promise<{ bars: Bar[]; divDates: Set<string> }>;
}

export const realFeeds: FeedPorts = {
  fetchDailyCloses: (...a) => prices.fetchDailyCloses(...a),
  drainProviderFallbacks: () => prices.drainProviderFallbacks(),
  fetchSeries: (series, opts) => fred.fetchSeries(series, { ...opts, fetchVolIndexCloses: opts.fetchVolIndexCloses ?? fetchVolIndexCloses }),
  fredOutage: () => fred.fredOutage(),
  drainKeyedFallbacks: () => fred.drainKeyedFallbacks(),
  startFredMemo: (...a) => fred.startFredMemo(...a),
  fetchEbp: () => ebp.fetchEbp(),
  fetchSovereignBars: async () => noFreeSource("sovereign bars"),
  graftQuoteLevel: (...a) => quoteGraft.graftQuoteLevel(...a),
  fetchVixSeries: (...a) => vixTerm.fetchVixSeries(...a),
  fetchEcbSeries: (...a) => ecb.fetchEcbSeries(...a),
  fetchOfficialLeg: async () => noFreeSource("official leg"),
  fetchNtfsSeries: (...a) => gsw.fetchNtfsSeries(...a),
  fetchDramSpot: async () => noFreeSource("DRAM spot"),
  fetchSovereignQuote: async () => noFreeSource("sovereign quote"),
  fetchTreasuryColumn: (...a) => treasury.fetchTreasuryColumn(...a),
  fetchCape: async () => noFreeSource("CAPE"),
  fetchHourlyBars: async () => noFreeSource("hourly bars"),
};

export const resolveFeeds = (over: Partial<FeedPorts> = {}): FeedPorts => ({ ...realFeeds, ...over });

/** An optional-`feeds` ctx's ports (`DbFirstCtx`, `ConfirmerCtx`); `realFeeds` when built without them. `RunBase` reads `ctx.feeds`. */
export const feedsOf = (ctx: { readonly feeds?: FeedPorts } | undefined): FeedPorts => ctx?.feeds ?? realFeeds;
