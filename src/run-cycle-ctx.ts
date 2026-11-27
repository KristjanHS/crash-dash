/** Per-run identity, memos and accumulators every `run-cycle-*.ts` stage reads; built once by `createRunCtx`. */

import type { Observation, Reading } from "./domain-types.js";
import { resetKeyedFallbacks } from "./fred.js";
import { resolveFeeds, type FeedPorts } from "./feed-ports.js";
import { resolveNotify, type NotifyPorts } from "./notify-ports.js";
import { startTreasuryMemo } from "./treasury.js";
import { errMsg } from "./err-msg.js";
import { resetProviderFallbacks, startPriceFeed } from "./prices.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";
import { getStore, type StoredReading, type Store } from "./store.js";
import { recordDegrade, resetDegradeLog } from "./tracks.js";
import { isIntradayRun } from "./intraday.js";
import { RUN_FETCH_BUDGET_MS, startRunBudget } from "./fetch-budget.js";
import { toStoredReading, type SeriesById, type Clock } from "./run-seeds.js";
import type { DbFirstCtx } from "./series-db-first.js";
import type { Env } from "./config.js";
import type { GeoInputs } from "./geo.js";

/** id → registry entry, chart-only rows included (`estimatorLegs` resolves VXNCLS) — look ids up, never iterate it. */
export const INDICATOR_BY_ID = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i]));

export interface RunCycleOptions {
  /** The entry's `readEnv()` — every fetch/push/store the cycle runs reads its config from here. */
  env: Env;
  /** `forceEmail`: mail the CURRENT band to every subscriber, bypassing the delivered-push gate
   *  (only on-demand way to exercise prod Brevo). Via `/api/cron/run?email=force`; persists/pushes nothing. */
  forceEmail?: boolean;
  /** `intraday`: a daytime run carrying today's in-progress bars (`isIntradayRun`, intraday.ts). Pushes
   *  nothing and writes its readings WITHOUT an alert row, so push / notify baseline / scoring prev-state
   *  stay on the last EOD run; the 22:00 cron's rows supersede it per obs_date. */
  intraday?: boolean;
  /** Intraday only. Default (absent/true): the assembled verdict goes to the `intraday_verdict` slot, which
   *  every verdict read serves (`servedVerdict`) — the board re-derives. `false` = READINGS ONLY: the slot is
   *  emptied instead, so `/lab`, `/status` and `/api/exposure` stay on the last EOD verdict
   *  (`/api/cron/run?rederive=0`, `REDERIVE=0` on `make ship` or the prod scoring cron trigger). */
  rederive?: boolean;
  /** Intraday only: skip the inline seed tail (`runIntradaySeedTail`) — the caller runs `seedIntradayTail` itself
   *  (the cron, AFTER its edge purge, so a seed hitting maxDuration can't hide the persisted readings). */
  deferIntradaySeed?: boolean;
  /** EOD only: awaited once the alert row commits, before the seed tail (the cron's edge purge); must not throw and must be time-bounded. */
  onCommitted?: () => Promise<void>;
  /** TEST SEAM: invoked once with the full feed-date collector before it grids `lagCalendarsFrom`.
   *  `run.wiring.test.ts`'s all-GREEN cycle reds if a daily id fetched a reading but skipped `recordFeedDates`. */
  onFeedDatesCollected?: (dates: ReadonlyMap<string, readonly string[]>) => void;
  /** TEST SEAM: invoked once with the gap-fill carrier just before the sweep — `run.wiring.dial.test.ts`'s roster lint. */
  onGapFillSeries?: (carried: ReadonlyMap<string, readonly StoredReading[]>) => void;
  /** Feed ports overriding `realFeeds` (feed-ports.ts) for this run. */
  feeds?: Partial<FeedPorts>;
  /** Notify ports overriding `realNotify` (notify-ports.ts) for this run. */
  notify?: Partial<NotifyPorts>;
  /** The run's store; absent ⇒ `getStore("rw", env)`. */
  store?: Store;
  /** The run's manual GEO inputs; absent ⇒ `loadGeoInputs()` (config.json). */
  geo?: GeoInputs;
  /** TEST SEAM: ms left to the run hard deadline, read by `persistRun`'s prune gate and the EOD re-derive's apply gate (`rederiveOnWrite`); absent ⇒ `runMsUntilHardDeadline(performance.now())`. */
  msUntilHardDeadline?: () => number;
}

export const once = <T>(f: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

export interface RunBase {
  readonly clock: Clock;
  readonly env: Env;
  readonly opts: RunCycleOptions;
  readonly intraday: boolean;
  readonly store: Store;
  readonly feeds: FeedPorts;
  readonly notify: NotifyPorts;
  readonly runAt: string;
  readonly firedDateIso: string;
  readonly dbFirst: Pick<DbFirstCtx, "store" | "runAt" | "intraday" | "feeds">;
  readonly graftOn: boolean;
  readonly gapCarry: SeriesById;
  readonly carry: (id: string, series: readonly Reading[]) => void;
  readonly feedDates: Map<string, readonly string[]>;
  readonly recordFeedDates: (id: string, dates: readonly string[]) => void;
  readonly levelEstimateRows: StoredReading[];
  /** id → dates its reading was scored off an `estimated` obs (`estimateDatesOf`); persist stores those rows `estimated`. */
  readonly estimateSourced: Map<string, Set<string>>;
  readonly markEstimateSourced: (id: string, dates: readonly string[]) => void;
  /** price symbol → the carried ids it feeds; resolved against the hop trace at the sweep (`fallbackGate`), never at the mark. */
  readonly fallbackClaims: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every site that turns a price `symbol` into a carried `id` calls this — an unmarked hopped symbol makes the run insert-only. */
  readonly markFallbackSourced: (id: string, symbol: string) => void;
  /** Every symbol this run asked `feeds.fetchDailyCloses` for — tells a price claim from a FRED/sovereign-quote label in `fallbackClaims`. */
  readonly priceFed: ReadonlySet<string>;
}

/** The sweep's provider-fallback gate: ids fed by a hopped symbol go insert-only; `unclaimed` non-empty ⇒ the whole run does. */
export function fallbackGate(
  claims: ReadonlyMap<string, ReadonlySet<string>>,
  hopped: readonly string[],
): { insertOnlyIds: ReadonlySet<string>; unclaimed: readonly string[] } {
  const insertOnlyIds = new Set<string>();
  const unclaimed: string[] = [];
  for (const sym of hopped) {
    const ids = claims.get(sym);
    if (ids === undefined) unclaimed.push(sym);
    else for (const id of ids) insertOnlyIds.add(id);
  }
  return { insertOnlyIds, unclaimed };
}

export interface RunGraft {
  readonly quoteOf: (symbol: string) => Promise<Observation | undefined>;
  readonly sovereignLeg: (
    symbol: string,
    keep?: (obs: Observation[]) => Observation[],
    isClosed?: (isoDate: string) => boolean,
  ) => () => Promise<Observation[]>;
  /** `id`'s registry `estimator.leads` resolved to their series, in order (sovereign-quote legs or price closes), memoized per run. */
  readonly estimatorLegs: (id: string) => Promise<Observation[][]>;
  /** `prints` under `id`'s daytime head (`liveHead`); `legs` overrides the registry resolver; `prints` itself where the id has none. */
  readonly liveHead: (id: string, prints: Observation[], legs?: readonly Observation[][]) => Promise<Observation[]>;
  readonly boeEnd: string;
}

export type RunCtx = RunBase & { readonly graft: RunGraft };

export function createRunCtx(clock: Clock, opts: RunCycleOptions): RunBase {
  // getStore throws loud when SUPABASE_URL + SUPABASE_SERVICE_KEY are unset.
  const store = opts.store ?? getStore("rw", opts.env);
  const resolved = resolveFeeds(opts.feeds);
  let cape: ReturnType<FeedPorts["fetchCape"]> | undefined;
  // ONE CAPE fetch per run: ECY (confirmer phase) and, on a full run, the F7 seed (tail) read the same CAPE vintage.
  const priceFed = new Set<string>();
  const feeds: FeedPorts = {
    ...resolved,
    fetchCape: () => (cape ??= resolved.fetchCape()),
    fetchDailyCloses: (symbol, o) => {
      priceFed.add(symbol);
      return resolved.fetchDailyCloses(symbol, o);
    },
  };
  const notify = resolveNotify(opts.notify);
  // One runAt stamps readings + alert (firedAt = the run's commit point; /status reads readings BY it).
  // Fetch-phase seams stamp re-seeded/tail rows at `seamRunAt(runAt)` (runAt−1ms) so the run's own rows
  // stay newest under `run_at desc`; its UTC date is the same-day-replace key.
  const runAt = clock();
  const firedDateIso = runAt.slice(0, 10);
  const dbFirst = { store, runAt, intraday: opts.intraday === true, feeds };
  // Reset the run-scoped collectors at entry so each reflects ONLY this run (serial in prod): degrade log,
  // keyed-FRED fallbacks (else a warm-container tail fallback lands on the NEXT run's alert row), price-
  // provider hops, the per-run FRED memo (a fresh map IS the reset), and the wall-clock fetch budget — the
  // ONE deadline that guarantees the cycle always reaches recordRun inside `RUN_HARD_DEADLINE_MS`.
  resetDegradeLog();
  resetKeyedFallbacks();
  feeds.startFredMemo({ intraday: opts.intraday === true });
  startPriceFeed({ intraday: opts.intraday === true }); // arms the run's intraday/EOD feed mode + clears the memo (prices.ts)
  // R2 and R3 share the nominal Treasury CSV — one per-run memo collapses their two head-fetches (and
  // ECY's/R7's re-fetch of the same ids) to one wire hit; a fresh map IS the reset.
  startTreasuryMemo({
    onFail: (curve, year, err) => recordDegrade(`[treasury] ${curve} ${year} curve fetch failed - FRED served without the same-day head`, errMsg(err), "notify"),
  });
  resetProviderFallbacks();
  startRunBudget(RUN_FETCH_BUDGET_MS, performance.now());
  // Gap-fill carrier: each producer hands its scored series here; ONE `gapFillSweep` after scoring
  // insert-misses every id's window (a date never the newest on a run — late print, missed cron, a `=X` Friday bar).
  const gapCarry: SeriesById = new Map();
  const carry = (id: string, series: readonly Reading[]): void => {
    gapCarry.set(id, series.map(toStoredReading));
  };
  // FEED-DATE COLLECTOR: the ONE grid `lagCalendarsFrom`
  // derives publication calendars
  // from — the full observation-date history each feed returned this run, not the single latest
  // `r.date`. Populated by ONE `recordFeedDates` call per fetch site. Pure — no clock, no store, no module state.
  const feedDates = new Map<string, readonly string[]>();
  const recordFeedDates = (id: string, dates: readonly string[]): void => {
    const prev = feedDates.get(id);
    feedDates.set(id, prev === undefined ? [...dates] : [...prev, ...dates]);
  };
  // `graftOn` (intraday, runAt-gated) gates the US rates' head (EOD never grafts: its own estimate row replaces the
  // intraday one via `writeEstimateRows`; `sweepEodRows` keeps the intraday one only when EOD writes no estimate for that date);
  // the sovereign-quote cards graft their quote head on every run.
  const graftOn = opts.intraday === true && isIntradayRun(new Date(runAt));
  const estimateSourced = new Map<string, Set<string>>();
  const markEstimateSourced = (id: string, dates: readonly string[]): void => {
    if (dates.length === 0) return;
    const set = estimateSourced.get(id) ?? new Set<string>();
    for (const d of dates) set.add(d);
    estimateSourced.set(id, set);
  };
  const fallbackClaims = new Map<string, Set<string>>();
  const markFallbackSourced = (id: string, symbol: string): void => {
    fallbackClaims.set(symbol, (fallbackClaims.get(symbol) ?? new Set<string>()).add(id));
  };
  return {
    clock, env: opts.env, opts, intraday: opts.intraday === true, store, feeds, notify, runAt, firedDateIso, dbFirst, graftOn,
    gapCarry, carry, feedDates, recordFeedDates, levelEstimateRows: [], estimateSourced, markEstimateSourced,
    fallbackClaims, markFallbackSourced, priceFed,
  };
}
