/**
 * Data layer: fetch + parse the keyless FRED CSV (no API key). The live scoring
 * path fetches only a bounded trailing window (cosd) — the scorers consume at
 * most a 252-trading-day window, so re-downloading the full multi-decade series
 * every run is wasted bytes. The backtest opts into full history (fullHistory).
 * Abstracted behind one function so a later swap to fredapi/keyed access is
 * a single edit (v4 §9).
 *
 * ⚠ **"FRED is down" is almost always FALSE as stated** — the KEYLESS fredgraph host times out
 * (curl 000 at 40s) while the KEYED API (`FRED_API_KEY`, in `.env.prod`) serves fine. Scope any
 * FRED-outage claim to the auth path it was observed on.
 */

import type { Observation, Indicator } from "./domain-types.js";
import { velocitySigmaDepth } from "./domain-fold.js";
import { VELOCITY_WINDOW, observationsByDate } from "./domain-types.js";
import { fredApiKey, type Env } from "./config.js";
import { dropWeekendMarks } from "./ice-weekend-marks.js";
import { sinceDaysAgo } from "./lookback.js";
import { type FetchLike, runBudgetExhausted } from "./fetch-budget.js";
import { fetchJson, fetchParsed, HttpStatusError, type RetryPolicy } from "./feed-http.js";
import { errMsg } from "./err-msg.js";
import { runMemo } from "./run-memo.js";
import { noFreeSource } from "./no-free-source.js";
import { REFUSED_SERIES } from "./fred-series-policy.js";

const FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
// Official keyed FRED API (JSON observations). PRIMARY when FRED_API_KEY is set; the
// keyless CSV endpoint above stays the fallback (config.ts fredApiKey / audit rank 3).
const FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations";

// Fault tolerance (audit rank 3): FRED is a run-aborting hard dependency, so a single
// transient 5xx / hang / empty parse must not erase a signal day. Each attempt carries
// its own AbortSignal.timeout (15s, well under the 60s function budget — a hang becomes
// a fast logged failure), and we retry ONCE after a short backoff before giving up. The
// caller (run-dbfirst.ts) then degrades that indicator to its last-persisted series.
//
// These three sit UNDER the run-wide fetch budget (fetch-budget.ts), which is what bounds
// the SUM: a run has ~20 sequential FRED terms, so no per-attempt value can keep the cycle
// inside maxDuration on a slow-feed day — only the shared deadline can. Note that setting
// FRED_API_KEY DOUBLES every term here (a keyed attempt that times out then chains into the
// full keyless CSV attempt below, both with their own retry), so the budget is what makes
// adding the key safe: the worst case is a degraded run, not a killed one.
const FRED_FETCH_TIMEOUT_MS = 15_000;
const FRED_MAX_ATTEMPTS = 2;
const FRED_RETRY_BACKOFF_MS = 500;

const FRED_UA = "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)";


// DEFAULT trailing window for the live scoring fetch. The generic FRED scorer
// (`scoreIndicator`) only needs the 20-day velocity window plus the 2-close confirmation
// buffer — ~22 trading days. (The 252-day high / 200-day MA windows belong to the
// F4/F5 price-feed scorers, which fetch via prices.ts, not here.) 800 calendar
// days ≈ 570 trading days is ~25× that, with headroom for weekends/holidays, while
// cutting the download of deep series (e.g. DGS10 back to 1962) by >95%.
//
// ⚠ It is NOT enough for every FRED-fed scorer, and the failure mode is SILENT. Since
// 2026-08-06 `scoreOil` (G1 + BRENT) carries a 756-TRADING-day trailing-peak level gate —
// deeper than the ~570 trading days this default yields — and short history degrades that
// gate to permanently ON. So those two call sites pass an explicit `since` derived from
// `OIL_LEVEL_LOOKBACK_DAYS` (src/confirmers.ts). Raising this constant globally instead
// would inflate all ~20 sequential FRED terms inside the 60s Vercel budget (fetch-budget.ts),
// which is why the fix is per-call-site. A future FRED indicator needing a multi-year
// window must do the same or pass fullHistory — bounded is the default, so silent
// truncation is the failure mode to watch for.
export const FRED_LOOKBACK_DAYS = 800;

// TWO keyless-FRED data quirks to know before debugging depth/lag:
// 1. ICE BofA OAS series (BAMLH0A0HYM2 HY, BAMLC0A0CM IG) are keyless-clamped to ~3yr
//    (~795 rows) REGARDLESS of cosd — an ICE licensing restriction, not a fetch bug
//    (DGS10 pulls its full 1962→ history through this same endpoint). Native OAS is
//    unusable for deep-history backtest/lift; lift is measured off the baa10y proxy
//    (1986→, unit-free). Don't re-attempt native OAS expecting depth. Since 2026-04 the
//    clamp covers the FRED website + ALFRED vintages too (verified 2026-07-16) — the only
//    free full-history source is an Internet Archive capture; see the E2 replay-view spec
//    Stage 1 / data/README.md once the committed vintage lands.
// 2. FRED daily series post ~1 business day late, so over a weekend the newest FRED obs
//    is Thursday while the price feed already has Friday — self-heals next weekday cron.
//    Only worry if FRED stays behind into mid-week.

/**
 * DEEP-WINDOW override for ANY ROLLING-σ indicator — every id declaring `Thresholds.velocitySigma`
 * takes it, none other.
 *
 * Returns the `fetchSeries` options that make the id's ruled σ window REACHABLE, or `undefined`
 * for every other indicator — which is byte-identical to the previous call shape, so no other
 * id's fetch moves. This is the per-call-site widening `FRED_LOOKBACK_DAYS`' own docblock
 * prescribes (`scoreOil`'s `OIL_LEVEL_LOOKBACK_DAYS` is the precedent); raising the global
 * constant instead would deepen all ~20 sequential FRED terms inside the 60s Vercel budget.
 *
 * Depth: `velocitySigmaDepth` (domain-fold.ts) + `velocityWindow` TRADING days — it is the ONE
 * source, shared with `lookbackPadFor` (api/series.ts), and it covers a blended id's UNBOUNDED
 * EWMA arm, which `window` alone does not. FRED bounds are CALENDAR dates, hence the 7/5
 * conversion plus a 10% holiday/weekend buffer.
 * Without it the estimate silently spans whatever the default window happened to yield
 * (~490 deltas at `FRED_LOOKBACK_DAYS = 800`) — a materially different scale in a shifted
 * volatility regime, and `F9_SIGMA_MIN_OBS` would be scoring it rather than degrading it.
 */
export function velocitySigmaFetchOpts(ind: Indicator, now: Date): { since: string } | undefined {
  const days = velocitySigmaLookbackDays(ind);
  return days === undefined ? undefined : { since: sinceDaysAgo(days, now) };
}

/** The σ id's depth in CALENDAR days, or `undefined` for every other id — the ONE source both feeds
 *  size their window from (`fetchDailyCloses`'s `lookbackDays` on the prices branch). */
export function velocitySigmaLookbackDays(ind: Indicator): number | undefined {
  const cfg = ind.thresholds.velocitySigma;
  if (!cfg) return undefined;
  const tradingDays = velocitySigmaDepth(cfg) + (ind.velocityWindow ?? VELOCITY_WINDOW);
  return Math.ceil((tradingDays * 7 * 1.1) / 5);
}

// ⛔ NEVER an always-armed memo: off the cron path nothing bounds its lifetime and a warm lambda would
// serve one request's FRED vintage to the next. Arm per run; unarmed = no memo. Each hit is handed its own
// array, so an in-place sort cannot reach a sibling caller.
const fredMemo = runMemo<string, Observation[]>({ copy: (obs) => obs.slice() });

/** Arm a fresh per-run FRED memo. Called at `runScoringCycle` entry beside `resetKeyedFallbacks()`. */
export function startFredMemo(opts: { intraday?: boolean } = {}): void {
  fredMemo.start();
  fredOutcomes.clear();
  // the vol-index-only ids' whole-history download, once per symbol per run
  volMemo = new Map();
  volIntraday = opts.intraday === true;
}

/** Disarm the memo (test isolation, and any caller that must see every fetch go to the wire). */
export function stopFredMemo(): void {
  fredMemo.stop();
  volMemo = null;
  volIntraday = false;
}

/** Store id → index-publisher symbol for ids FRED never carries: `fetchSeries` serves them index-only, a failure throws (no fallback). */
const INDEX_ONLY_SYMBOL_OF: Readonly<Record<string, string>> = { VXSMH: "VXSMH" };

// Same lifetime rule as the FRED memo: armed per run (from `startFredMemo`), never a live module-level
// map off the cron path — a warm lambda would otherwise serve one request's vintage to the next.
let volMemo: Map<string, Promise<Observation[]>> | null = null;
// Run-scoped with the memo: an intraday run keeps today's unsettled row.
let volIntraday = false;

/** Whole close history for one index-publisher symbol through the `fetchVolIndexCloses` seam, memoized per run. */
async function volIndexHistory(symbol: string, deps: FredFetchDeps): Promise<Observation[]> {
  const { fetchVolIndexCloses } = deps;
  if (fetchVolIndexCloses === undefined) throw new Error(`no volatility-index source bound for ${symbol}`);
  const req = { fetchImpl: deps.fetchImpl, now: deps.now, intraday: volIntraday };
  const memo = volMemo;
  if (!memo) return fetchVolIndexCloses(symbol, req);
  const hit = memo.get(symbol);
  if (hit) return (await hit).slice();
  // A REJECTION stays memoized too (unlike the FRED memo): an id is pulled under several windows per run, and a
  // hung index-publisher fetch must cost one attempt per symbol, not one per window, inside the shared fetch budget.
  const inflight = fetchVolIndexCloses(symbol, req);
  memo.set(symbol, inflight);
  return (await inflight).slice();
}

/** IO seams, each defaulting to the real global resolved per call; `env` is required, and so is `now` — the
 *  default window's anchor and the index publisher's settle/freshness clock. */
export interface FredFetchDeps {
  fetchImpl?: FetchLike;
  env: Env;
  sleep?: (ms: number) => Promise<void>;
  now: Date;
  /** The `INDEX_ONLY_SYMBOL_OF` ids' whole-history source (`realFeeds.fetchSeries` binds it). Absent ⇒ those ids throw. */
  fetchVolIndexCloses?: VolIndexFetch;
  /** Ids refused before any request; defaults to `fred-series-policy.ts`'s `REFUSED_SERIES`. */
  refusedSeries?: ReadonlySet<string>;
}

/** One volatility index's whole daily-close history, ascending; throws on failure. */
export type VolIndexFetch = (symbol: string, deps: { fetchImpl?: FetchLike; now: Date; intraday?: boolean }) => Promise<Observation[]>;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function fetchSeries(
  series: string,
  opts: { fullHistory?: boolean; since?: string } & FredFetchDeps,
): Promise<Observation[]> {
  // A refused id (`fred-series-policy.ts`) never reaches the wire, the volatility-index port or the memo.
  if ((opts.refusedSeries ?? REFUSED_SERIES).has(series)) noFreeSource(series);
  // Window precedence: `fullHistory` (deep stats / a first backfill seed) → no cosd, all
  // history; else an explicit `since` (YYYY-MM-DD) — the incremental-backfill bound that
  // fetches ONLY the dates a re-run still needs (observation_start), never the whole
  // series again; else the default bounded trailing window the daily scorers need.
  const cosd = opts.fullHistory
    ? undefined
    : (opts.since ?? sinceDaysAgo(FRED_LOOKBACK_DAYS, opts.now));
  return fredMemo.get(`${series}|${cosd ?? ""}`, () => fetchWindow(series, cosd, opts));
}

async function fetchWindow(series: string, cosd: string | undefined, deps: FredFetchDeps): Promise<Observation[]> {
  // `INDEX_ONLY_SYMBOL_OF` ids (no FRED copy) are served by the volatility-index source alone; a failure throws.
  const only = INDEX_ONLY_SYMBOL_OF[series];
  if (only !== undefined) return (await volIndexHistory(only, deps)).filter((o) => cosd === undefined || o.date >= cosd);
  return fetchFredWindow(series, cosd, deps);
}

async function fetchFredWindow(series: string, cosd: string | undefined, deps: FredFetchDeps): Promise<Observation[]> {
  return dropWeekendMarks(series, await fetchFredWindowRaw(series, cosd, deps));
}

async function fetchFredWindowRaw(series: string, cosd: string | undefined, deps: FredFetchDeps): Promise<Observation[]> {
  const { fetchImpl, env, sleep = realSleep } = deps;
  const apiKey = fredApiKey(env);
  // Keyed FRED API is PRIMARY when the (free) key is set; on any hard failure fall back
  // to the keyless CSV path so a keyed-endpoint outage never erases the series. Unset key
  // ⇒ the keyless CSV path exactly as before (with the new retry/timeout hardening).
  if (apiKey) {
    try {
      const obs = await fetchKeyedJson(series, apiKey, cosd, fetchImpl, sleep);
      recordFredOutcome(series);
      return obs;
    } catch (err) {
      console.warn(`[fred] keyed API failed for ${series} - falling back to keyless CSV: ${errMsg(err)}`);
      recordKeyedFallback(series, err);
    }
  }
  try {
    const obs = await fetchKeylessCsv(series, cosd, fetchImpl, sleep);
    recordFredOutcome(series);
    return obs;
  } catch (err) {
    recordFredOutcome(series, err);
    throw err;
  }
}

// WHICH PATH SERVED THIS RUN — the diagnostic that closes a real blind spot (2026-08-04).
//
// The fallback above is otherwise SILENT in the only place it matters: `console.warn` goes to
// Vercel's function log, which retains nothing past the live tail, so "did the keyed API serve
// prod last Tuesday, or did it fail over to keyless?" was permanently unanswerable after the fact.
// That is not a hypothetical — it blocked the 2026-08-04 F1-lateness debug, where the keyed key
// had been added ~4 days earlier and could not be ruled in or out from evidence.
//
// So each fallback is ALSO recorded here, and `run-cycle-persist.ts` drains this into ONE `recordDegrade`
// event per run, which persists on the alert row (`alert_log.degraded`, i.e. `/api/status` →
// `.verdict.degraded`) — durable storage the log retention cannot erase.
//
// ⚠ WHAT THIS CAN AND CANNOT ANSWER. A recorded event proves the keyed path FAILED. Its ABSENCE
// does NOT prove the keyed path served: a run with no `FRED_API_KEY` set records nothing either
// (see `fetchSeries` above — no key ⇒ keyless-only, which is not a "fallback"), and so does a run
// whose keyed attempts all died on the run-wide budget. There is deliberately no positive
// keyed-served marker; distinguishing "keyed served" from "no key configured" needs the env, not
// this trace.
//
// ⚠ THE COLLECTOR LIVES HERE, NOT IN `tracks.ts`. `tracks.ts` (which owns `recordDegrade`) imports
// THIS module, so calling it from here would close an import cycle in an explicitly acyclic graph.
// Emitting a plain record and letting the one importer that owns the run lifecycle drain it keeps
// the arrow one-way — and keeps the drain point under `run-cycle-persist.ts`'s control, ahead of
// `recordRun` (an event recorded in the post-`recordRun` tail is wiped before it can ever persist).
//
// ⚠ SILENT WHEN HEALTHY, AND DELIBERATELY NOT PUSH-VISIBLE. Nothing is recorded when the keyed
// path succeeds or when no key is set, so a healthy run's trace is byte-unchanged. The event is
// recorded with effect `"trace"`, so a keyed hiccup is queryable forever but never fires a notification — it is a
// diagnostic about HOW the data arrived, not a statement that the data is bad. Keyless is a
// fully-adequate feed; a fallback costs latency, never a signal day.

export interface KeyedFallback {
  series: string;
  /**
   * The failure WITHOUT the series id — `HTTP 401 Unauthorized`, `0 observations`, or a raw
   * network/timeout message. Series-free on purpose: it is the drain's dedup key, and an expired
   * key fails every FRED term of the run identically, so a per-series string would dedup nothing
   * and persist one near-identical line per FRED call onto the alert row.
   */
  summary: string;
}

// Off the cron path (api/series.ts, api/lab.ts, api/replay.ts, the probe scripts — each a direct
// `fetchSeries` importer) NOTHING drains this — a warm lambda would otherwise grow it for the
// container's lifetime. Hard cap it. One record is pushed per FAILED keyed `fetchSeries` call, and
// a cycle makes a few dozen FRED calls at most (the `INDICATORS` loop + explicit terms in
// run-cycle-*.ts / confirmers.ts / tracks.ts / run-seeds.ts), so the cap cannot truncate a real run's
// batch even when every one of them falls back.
const KEYED_FALLBACK_CAP = 100;

const keyedFallbacks: KeyedFallback[] = [];

function recordKeyedFallback(series: string, err: unknown): void {
  // A run-wide budget abort is NOT a keyed-endpoint rejection — the shared deadline killed the
  // request before the API answered (verified: the abort surfaces in `fetchSeries`'s catch with
  // `runBudgetExhausted()` already true), and the run records that cause once and explicitly via
  // BUDGET_ABORT_SCOPE in run-cycle-dial.ts. Recording it here too would headline "keyed API fell back
  // to keyless CSV (N series)" for series the keyed endpoint never rejected.
  //
  // ⚠ COUPLED TO THE BUDGET'S LIFETIME, NOT TO THIS RUN'S. `startRunBudget()` is called at
  // `runScoringCycle` entry and NOTHING calls `clearRunBudget()` at the end, so the deadline
  // outlives the cycle in a warm container and `runBudgetExhausted()` keeps returning true once
  // its timer has fired. Deliberately left that way rather than clearing: on Vercel each handler
  // is its OWN function instance, so the only readers that can ever see a cron run's stale
  // deadline are code in the cron container itself after `runScoringCycle` returns and a
  // long-lived CLI process — neither of which fetches FRED today, and a second cycle in the same
  // container opens a fresh budget at entry before any fetch. Add a post-cycle FRED caller and
  // this gate silently stops recording for it: `clearRunBudget()` (fetch-budget.ts) is the seam,
  // and it needs a `finally` around the whole cycle, not a line before `return`.
  if (runBudgetExhausted()) return;
  if (keyedFallbacks.length >= KEYED_FALLBACK_CAP) return;
  keyedFallbacks.push({ series, summary: err instanceof FredFetchError ? err.summary : errMsg(err) });
}

/**
 * Drop everything collected so far. Called at `runScoringCycle` entry (mirroring
 * `resetDegradeLog()`) — without it, a fallback from the post-`recordRun` tail of the PREVIOUS
 * run (`run-seeds.ts` fetches BELOW the drain) survives on a warm container and gets stamped on
 * the NEXT run's alert row, asserting a keyed failure that run never had.
 */
export function resetKeyedFallbacks(): void {
  keyedFallbacks.length = 0;
}

/** Take + clear the keyed→keyless fallbacks recorded since the last drain (run-cycle-persist.ts). */
export function drainKeyedFallbacks(): KeyedFallback[] {
  return keyedFallbacks.splice(0);
}

/** Outage = ≥ this many FRED series failed on EVERY path, and at least half the series this run fetched. */
export const FRED_OUTAGE_MIN_FAILED = 3;

// series → its failure summary once any FRED call for it failed on every path; null = served. Reset by `startFredMemo`.
const fredOutcomes = new Map<string, string | null>();

function recordFredOutcome(series: string, err?: unknown): void {
  if (err === undefined) {
    if (!fredOutcomes.has(series)) fredOutcomes.set(series, null);
    return;
  }
  // A budget abort still leaves the series unserved (a hanging FRED surfaces only this way), so it counts.
  // Keyless errors name the series — strip it so the summaries dedup.
  const summary = runBudgetExhausted() ? "run fetch budget exhausted" : err instanceof FredFetchError ? err.summary : errMsg(err).replaceAll(series, "<id>");
  fredOutcomes.set(series, summary);
}

export interface FredOutage {
  failed: string[];
  total: number;
  /** Distinct series-free failure summaries. */
  summaries: string[];
}

/** This run's FRED-wide outage (both auth paths failing for most series), or null — feeds `pushFredOutage`. */
export function fredOutage(): FredOutage | null {
  const failed = [...fredOutcomes].filter(([, s]) => s !== null);
  if (failed.length < FRED_OUTAGE_MIN_FAILED || failed.length * 2 < fredOutcomes.size) return null;
  return { failed: failed.map(([id]) => id), total: fredOutcomes.size, summaries: [...new Set(failed.map(([, s]) => s!))] };
}

/**
 * A FRED failure that also carries a SERIES-FREE summary for the fallback trace above. The
 * `message` keeps naming the series (it is what the log line and the thrown error show); the
 * summary is what dedups across the run's ~20 terms.
 */
class FredFetchError extends Error {
  constructor(
    message: string,
    readonly summary: string,
  ) {
    super(message);
  }
}

/** Retries ANY error — fetch, non-OK status, a bad body or an empty parse (`nonEmpty`); the caller degrades after. */
const fredRetry = (sleep: (ms: number) => Promise<void>): RetryPolicy => ({
  attempts: FRED_MAX_ATTEMPTS,
  backoffMs: FRED_RETRY_BACKOFF_MS,
  sleep,
});

function nonEmpty(series: string, obs: Observation[]): Observation[] {
  if (obs.length === 0) throw new FredFetchError(`FRED returned 0 observations for ${series}`, "0 observations");
  return obs;
}

/**
 * Keyless CSV endpoint (the historical default). `cosd` bounds the window; unset = full history —
 * **for most ids.**
 *
 * ⚠ **"unset = full history" is FALSE for the ICE BofA OAS family.** Keyless fredgraph serves those
 * over a rolling ~3-year window regardless of `cosd`: verified 2026-07-18, the euro HY OAS series
 * and `BAMLEMCBPIOAS` (F10) both return exactly **796 rows starting 2023-07-18** — identical count AND
 * start date, the signature of a server-side window, not of a short series. Non-ICE ids come back
 * whole over the same call (`DTWEXBGS` 5356, `DEXCHUS` 11877). This is a FEED property: `backfill --
 * indicators` cannot repair it (a dry run adds 1 row).
 *
 * ⚠ **The keyed JSON path is NO LONGER an escape for this family.** Measured 2026-08-01 (EU-1):
 * the euro HY OAS series starts **2023-08-01 on the KEYED API too** — FRED truncated the ICE BofA OAS
 * series themselves to a rolling ~3y in April 2026, so this is a second, SERIES-side truncation on top
 * of the keyless-window artifact above, not the same one. No credential path reaches pre-2023 ICE BofA history.
 * The only remaining escape is a COMMITTED vintage stitched to the live tail — the shape
 * `stitchHyOas(loadHyOasVintage(), <live BAMLH0A0HYM2>)` in `src/hyoas-history.ts` already ships for
 * F1/HY. Anything needing ICE BofA co-history before ~3y ago must go through a vintage file or be
 * scoped to what the window admits. Falsifier:
 *   `curl -s 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLEMCBPIOAS' | wc -l`
 * Binds on anything that computes a statistic from stored depth — see the `PCT_MIN_OBS` floor (`slow.ts`) gating
 * `synth-cuts.ts`: 796 rows clears `PCT_MIN_OBS` (252) yet spans no credit stress, so a "measured"
 * percentile cut off this feed is regime-inadequate and lands BELOW the hand-typed prior.
 */
async function fetchKeylessCsv(
  series: string,
  cosd: string | undefined,
  fetchImpl: FetchLike | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<Observation[]> {
  const params = new URLSearchParams({ id: series });
  if (cosd) params.set("cosd", cosd);
  // FRED stalls UA-less requests from datacenter IPs (fine locally, hangs on
  // Vercel) — send an explicit UA. The timeout converts a hang into a fast,
  // logged failure instead of consuming the function's whole maxDuration.
  return fetchParsed(`${FRED_CSV_BASE}?${params}`, (csv) => nonEmpty(series, parseFredCsv(csv, series)), {
    fetchImpl,
    init: { headers: { "User-Agent": FRED_UA } },
    timeoutMs: FRED_FETCH_TIMEOUT_MS,
    label: `FRED fetch failed for ${series}`,
    retry: fredRetry(sleep),
  });
}

/** Official keyed FRED API — JSON observations. `cosd` maps to `observation_start`. */
async function fetchKeyedJson(
  series: string,
  apiKey: string,
  cosd: string | undefined,
  fetchImpl: FetchLike | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<Observation[]> {
  const params = new URLSearchParams({ series_id: series, api_key: apiKey, file_type: "json" });
  if (cosd) params.set("observation_start", cosd);
  return fetchJson(`${FRED_API_BASE}?${params}`, (u) => nonEmpty(series, parseFredJson(u)), {
    fetchImpl,
    init: { headers: { "User-Agent": FRED_UA } },
    timeoutMs: FRED_FETCH_TIMEOUT_MS,
    label: `FRED API fetch failed for ${series}`,
    retry: {
      ...fredRetry(sleep),
      giveUp: (err) =>
        err instanceof HttpStatusError ? new FredFetchError(err.message, `HTTP ${err.status} ${err.statusText}`) : err,
    },
  });
}

/**
 * FRED CSV is `<date-header>,<series-id>` then `YYYY-MM-DD,<value>` rows. Missing
 * observations are marked "." in most series but as an EMPTY field (`YYYY-MM-DD,`)
 * in others (e.g. DCOILWTICO). We drop the header and any non-numeric rows.
 *
 * Hardened (audit rank 12 / DQ-A3 — parseFredCsv was alone among the feed parsers with
 * no header/sort/dedup guard): (1) assert the two-column `<date-header>,<series>` shape and
 * throw loudly naming the series on drift (an HTML error page or format change served as a
 * 200 would otherwise parse to garbage silently); (2) dedup by date, LAST value wins
 * (mirrors store.ts's byDate revision semantics); (3) sort ascending — FRED serves ascending
 * today, but any ordering hiccup would silently corrupt every downstream velocity window.
 * `series` is "?" only in legacy/test call sites; the live path (fetchKeylessCsv) names it.
 */
export function parseFredCsv(csv: string, series = "?"): Observation[] {
  const lines = csv.trim().split("\n");
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  // FRED's date column is `DATE` (legacy) or `observation_date` (current); the value column
  // is the series id. Exactly two columns with a recognised date header = a valid FRED CSV.
  const headerOk = header.length === 2 && /^(DATE|observation_date)$/i.test(header[0] ?? "");
  if (!headerOk) {
    throw new Error(
      `FRED CSV for ${series}: unexpected header "${lines[0] ?? ""}" (expected "<date>,<series>")`,
    );
  }

  // Dedup by date, last value wins (FRED vintage revisions; matches store.ts byDate).
  const byDate = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [date, raw] = line.split(",");
    if (!date || raw === undefined) continue;
    const trimmed = raw.trim();
    const value = Number(trimmed);
    // Drop a missing observation: "." OR an empty field. The empty case is the
    // trap — Number("") === 0 is finite, so without this it injects a spurious 0
    // (corrupting 20d velocity/return windows downstream), not a dropped row.
    if (trimmed === "" || trimmed === "." || !Number.isFinite(value)) continue;
    byDate.set(date, value);
  }

  return observationsByDate(byDate);
}

/**
 * Parse the keyed FRED API's JSON `observations` into the SAME Observation shape the CSV
 * path yields. FRED marks a missing value as "." (as in the CSV) — skip those rows, matching
 * parseFredCsv's drop behavior so keyed and keyless paths are byte-equivalent downstream.
 * Also mirrors the CSV path's dedup-by-date (last wins) + ascending sort so a keyed run is
 * byte-equivalent to a keyless one even under out-of-order / revised observations.
 */
export function parseFredJson(json: unknown): Observation[] {
  const byDate = new Map<string, number>();
  for (const o of fredObservations(json)) {
    if (!o.date || o.value === undefined) continue;
    const trimmed = o.value.trim();
    const value = Number(trimmed);
    if (trimmed === "" || trimmed === "." || !Number.isFinite(value)) continue;
    byDate.set(o.date, value);
  }
  return observationsByDate(byDate);
}

/** A keyed-API body whose `observations` (or a row's `date`/`value`) is not the shape `parseFredJson` reads. */
class FredShapeError extends Error {
  override name = "FredShapeError";
}

/** `observations` (absent ⇒ none, as before), each row `{date?: string; value?: string}`; anything else throws. */
function fredObservations(u: unknown): { date?: string; value?: string }[] {
  const rows = typeof u === "object" && u !== null && "observations" in u ? u.observations : undefined;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new FredShapeError("FRED API body: observations is not an array");
  return rows.map((o: unknown, i) => {
    if (typeof o !== "object" || o === null) throw new FredShapeError(`FRED API body: observations[${i}] is not an object`);
    const date = "date" in o ? o.date : undefined;
    const value = "value" in o ? o.value : undefined;
    if ((date !== undefined && typeof date !== "string") || (value !== undefined && typeof value !== "string")) {
      throw new FredShapeError(`FRED API body: observations[${i}] date/value is not a string`);
    }
    return { date, value };
  });
}
