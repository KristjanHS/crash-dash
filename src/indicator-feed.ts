/**
 * Per-id feed dispatch for the `INDICATORS` loop: `FEED_OF` (registry.ts) selects the prices feed,
 * everything else stays on keyless FRED. Nothing downstream of the fetch changes — the id keeps its
 * cuts, σ config, folds and persisted store id.
 *
 * ⛔ EVERY site that resolves `indicator.series` into a fetch must go through `indicatorFetchPlan` /
 * `fetchIndicatorObservations`: a site left on a bare `fetchSeries` scores that id off a different feed
 * than the rest of the system. Known parallel resolvers (their own inline feed dispatch, NOT this one):
 * `scoreFredBatch`'s INDICATORS loop (DOES call `fetchIndicatorObservations`), `scripts/backfill.ts`
 * `specs()`, and the σ probes (`scripts/probe-sigma-response.ts`, `scripts/probe-sigma-cusum-candidacy.ts`).
 *
 * Treasury same-day HEAD (A2) — the graft is the shared
 * `graftTreasuryHeadFor` helper below, wired at FOUR runtime doors so R2/R3/R4, R7's legs, and ECY's
 * deep DFII10 all score ONE Treasury vintage per run (never a T+0/T+1 split):
 *   - `fetchIndicatorObservations` (this file) — the core FRED loop (`run-dbfirst.ts` `makeFredLoop`) and
 *     the `INDICATORS` loop (`scoreFredBatch`).
 *   - `fetchR4DeepInputs` (`run-dbfirst.ts`) — ECY's deep DFII10, both deep and tail arms.
 *   - `r7LegSeries` (`confirmers.ts`) — R7's DGS2 (R3) / DGS10 (R2) legs, both arms. (R1/T10Y3M is
 *     absent from `TREASURY_HEAD_OF`, so the helper is identity there — T7.)
 *   - `seedInputSeriesOnCron` (`run-seeds.ts`) — the cron copy of DGS2/DGS10/DFII10 persisted under their
 *     RAW ids (S4/B3): grafted AND narrowly repaired (a same-day correction re-persisted as a new vintage
 *     over the `TAIL_DAYS` window), since this insert-missing seam is the one the DB-first repair never reaches.
 * KNOWN-UNGRAFTED, by decision (they resolve the same three series through a raw `fetchSeries` and are
 * deliberately left FRED-only for now — they seed/backfill HISTORY, not the live board): `scripts/backfill.ts`
 * (the R7-leg re-fetch ~1044 and ECY's DFII10 ~1205).
 */

import type { Indicator, Observation } from "./domain-types.js";
import { FEED_OF, TREASURY_HEAD_OF } from "./registry-fred.js";
import { velocitySigmaFetchOpts, velocitySigmaLookbackDays } from "./fred.js";
import { realFeeds, type FeedPorts } from "./feed-ports.js";
import { graftTreasuryHead, MIN_OVERLAP_ROWS } from "./treasury.js";
import type { Env } from "./config.js";

export type IndicatorFetchPlan =
  | { feed: "fred"; opts: { fullHistory?: boolean; since?: string } | undefined }
  | { feed: "prices"; opts: { deep?: boolean; lookbackDays?: number } }
  // NTFS is always full-history by construction (gsw.ts fetches the whole feds200628 file).
  | { feed: "ntfs"; opts: undefined };

/** Whether `indicatorFetchPlan` takes the deep (full-history) arm — clock-independent. `postInversionCooldown`
 *  carriers ALWAYS do: the rung's memory is unbounded, so a bounded window ages the qualifying episode out
 *  and the cron GREENs an armed rung (fred.ts ⚠ class). */
export const fetchesDeep = (ind: Indicator, opts: { fullHistory?: boolean } = {}): boolean =>
  opts.fullHistory === true || ind.postInversionCooldown !== undefined;

/** Whether `ind`'s plan rides the FRED feed (neither `prices` nor `ntfs` in `FEED_OF`). */
export const fetchesFromFred = (ind: Indicator): boolean => FEED_OF[ind.id] !== "ntfs" && FEED_OF[ind.id] !== "prices";

/**
 * The feed and the exact options one indicator's fetch takes — pure, so the wiring is assertable
 * without a network seam. `lookbackDays` rides the DEEP arm only (prices.ts): a shallow call would
 * silently clamp a σ id to the 2y default window.
 */
export function indicatorFetchPlan(ind: Indicator, now: Date, opts: { fullHistory?: boolean } = {}): IndicatorFetchPlan {
  if (FEED_OF[ind.id] === "ntfs") return { feed: "ntfs", opts: undefined };
  const deep = fetchesDeep(ind, opts);
  if (fetchesFromFred(ind)) {
    return { feed: "fred", opts: deep ? { fullHistory: true } : velocitySigmaFetchOpts(ind, now) };
  }
  if (deep) return { feed: "prices", opts: { deep: true } };
  const lookbackDays = velocitySigmaLookbackDays(ind);
  return { feed: "prices", opts: lookbackDays === undefined ? {} : { deep: true, lookbackDays } };
}

/**
 * The single touch point for the Treasury same-day HEAD:
 * an id absent from `TREASURY_HEAD_OF` is returned UNCHANGED (same reference, identity — R1/T7 exempt by
 * construction); an id present takes the same-day column grafted over its FRED history by the T6 equality
 * gate inside `graftTreasuryHead`. The year comes from the caller's `runAt`. **A3 January fallback:** the CSV is per-year, so in early January the current-year column
 * shares too few dates with FRED — its OVERLAP (current-year rows at or before FRED's last obs, the
 * quantity the gate counts) under `MIN_OVERLAP_ROWS` — for the gate to ESTABLISH. Then, and only then,
 * ALSO fetch `year - 1` and concatenate (prior year first) so the prior December's rows are available to
 * carry the overlap across the boundary; the graft still succeeds only if that prior-year column is
 * itself present and agrees with FRED. Never fetches two years unconditionally. Never throws:
 * `fetchTreasuryColumn` degrades to `[]` (T5) and
 * `graftTreasuryHead` returns `fred` untouched on empty/mismatched input.
 */
export async function graftTreasuryHeadFor(
  id: string,
  obs: Observation[],
  runAt: string,
  fetchColumn: FeedPorts["fetchTreasuryColumn"] = realFeeds.fetchTreasuryColumn,
): Promise<Observation[]> {
  const head = TREASURY_HEAD_OF[id];
  if (head === undefined) return obs;
  const year = new Date(runAt).getUTCFullYear();
  let rows = await fetchColumn(head.curve, head.column, year);
  // A3 fallback fires on the SAME quantity the graft's gate measures: distinct current-year rows that can
  // OVERLAP FRED (date ≤ FRED's last obs), NOT the raw row count. A graft only appends rows STRICTLY newer
  // than FRED's last date, so every head row is excluded from `matched` — counting raw rows over-states the
  // overlap by the head lead, and at exactly `MIN_OVERLAP_ROWS` current-year rows the gate fails
  // (`matched < MIN_OVERLAP_ROWS`) while `rows.length < MIN_OVERLAP_ROWS` stays false. Measuring the FRED
  // overlap directly closes that year-boundary hole. (An empty FRED history can't be grafted onto anyway —
  // `graftTreasuryHead` returns it untouched — so skip the extra fetch there.)
  const lastFred = obs.reduce((max, o) => (o.date > max ? o.date : max), "");
  const overlap = rows.reduce((n, r) => (r.date <= lastFred ? n + 1 : n), 0);
  if (obs.length > 0 && overlap < MIN_OVERLAP_ROWS) {
    const prior = await fetchColumn(head.curve, head.column, year - 1);
    rows = [...prior, ...rows]; // prior year first — `graftTreasuryHead` re-sorts the head anyway
  }
  return graftTreasuryHead(obs, rows);
}

/** Fetch one indicator's observations from ITS feed, per `indicatorFetchPlan`, then graft the Treasury
 *  same-day head for the rate ids FRED publishes T+1 (`graftTreasuryHeadFor` — a no-op for every other id). */
export async function fetchIndicatorObservations(
  ind: Indicator,
  opts: { fullHistory?: boolean },
  runAt: string,
  env: Env,
  feeds: Pick<FeedPorts, "fetchDailyCloses" | "fetchSeries" | "fetchNtfsSeries" | "fetchTreasuryColumn"> = realFeeds,
): Promise<Observation[]> {
  const plan = indicatorFetchPlan(ind, new Date(runAt), opts);
  const obs =
    plan.feed === "ntfs"
      ? await feeds.fetchNtfsSeries(new Date(runAt), env, feeds)
      : plan.feed === "prices"
        ? await feeds.fetchDailyCloses(ind.series, { ...plan.opts, now: () => Date.parse(runAt), env })
        : await feeds.fetchSeries(ind.series, { ...plan.opts, now: new Date(runAt), env });
  return graftTreasuryHeadFor(ind.id, obs, runAt, feeds.fetchTreasuryColumn);
}
