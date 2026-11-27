/**
 * DB-first / warm-up / deep-arm orchestration — the B1 peel of `run-cycle.ts` (2026-09-05):
 * breadth/price DB-first resolution (§6.2), the shared VIX term legs, the core FRED-loop
 * scorer factory (`makeFredLoop` — the ex-inline closures with explicit deps), and the R4
 * deep-arm fetch (`fetchR4DeepInputs`). Consumed by `run-cycle-fred.ts` + `run-cycle-confirmers.ts`.
 */

import { INDICATORS } from "./registry-fred.js";
import {
  PRICE_SCORERS,
  DEEP_PRICE_INPUTS,
  BREADTH_LOOKBACK_DAYS,
  BREADTH_STORE_IDS,
  BREADTH_READ_ONLY,
  breadthCloseReadingSeries,
  DOWNSIDE_DETECTORS,
  RS_LEGS,
} from "./registry-price.js";
import { downsideBreakReadingSeries, relStrengthBreakReadingSeries } from "./scorers-price.js";
import { withNewest } from "./scorers-core.js";
import {
  type Indicator,
  type Observation,
  type Reading,
} from "./domain-types.js";
import type { CalibrationParam } from "./store.js";
import { fetchIndicatorObservations, graftTreasuryHeadFor } from "./indicator-feed.js";
import { fetchDailyCloses, finalRewriteHeld } from "./prices.js";
import { feedsOf, realFeeds, type FeedPorts } from "./feed-ports.js";
import { degrade, recordDegrade } from "./tracks.js";
import { fredLoopIndicator, scoreWithCuts, scoreWithCutsSeries, scoreWithCutsSeriesPerDay } from "./confirmers.js";
import { confirmClosesFor } from "./family-table.js";
import { gapFillFrom } from "./intraday.js";
import { SYNTH_PRIOR_IDS } from "./domain-cuts.js";
import { dbFirstOrDirect, needRowsForSeedDepth, needRowsForCalendarDays, readRowsForCalendarDays, tailSince14, TAIL_DAYS, type DbFirstCtx, type DbFirstFeedSpec } from "./series-db-first.js";
import { DFII10_ORIGIN } from "./backfill-depth.js";
import { synthHistoriesInclusive, SYNTH_HISTORY_LIMIT, type SynthHistoryLoad } from "./synth-cuts.js";
import { VIX_SYMBOL, VIX3M_SYMBOL } from "./vix_term.js";
import { withStoredLegs } from "./input-series.js";
import { estimateDatesOf } from "./estimated.js";
import type { Env } from "./config.js";

/**
 * Resolve one price symbol's closes for the price batch (§6.2). Shallow symbols: the plain 2y fetch,
 * untouched. Deep breadth symbols: DB-first — `BREADTH_STORE_IDS` maps QQQ/QQQE/RSP to their minted
 * BR_* id (persist-on-deep); SPY takes the READ-ONLY arm (read+merge, never write — its own cron writer owns the id).
 * The consumer wants the merged observation SERIES, so the seam's `points` is returned; readings are the
 * seam's own persist concern. `ctx===undefined` ⇒ direct arm (offline/test), fetch deep, persist nothing.
 * `fetchShallow` is the shallow arm's feed — the price batch hands it the stored-hole-filled feed (`withStoredLegs`).
 */
export async function resolveBreadthCloses(
  sym: string,
  runAt: string,
  env: Env,
  ctx: DbFirstCtx | undefined,
  fetchShallow: (sym: string) => Promise<Observation[]> = (s) => fetchDailyCloses(s, { now: () => Date.parse(runAt), env }),
): Promise<Observation[]> {
  const feeds = feedsOf(ctx);
  if (!DEEP_PRICE_INPUTS.has(sym)) return fetchShallow(sym);
  const ind = BREADTH_STORE_IDS[sym]!; // every DEEP_PRICE_INPUTS symbol has an entry
  const { points } = await dbFirstOrDirect(ctx, {
    ...breadthFeed(sym), // QQQ/QQQE/RSP → BR_* ; SPY → its own `SPY` id, READ-ONLY (§6.2)
    fetchDeep: () => feeds.fetchDailyCloses(sym, { deep: true, lookbackDays: BREADTH_LOOKBACK_DAYS, now: () => Date.parse(runAt), env }),
    fetchTail: () => feeds.fetchDailyCloses(sym, { deep: true, lookbackDays: TAIL_DAYS, now: () => Date.parse(runAt), env }),
    score: (pts) => breadthCloseReadingSeries(ind, pts),
    onPersistError: (err) =>
      recordDegrade(`[breadth-db-first] persist failed - ${sym} closes not written, breadth scored`, String(err), "notify"),
  });
  return points;
}

/** Symbols consumed ONLY by `soft` PRICE_SCORERS rows — any hard row, DOWNSIDE_DETECTOR or RS_LEG
 *  consumer keeps a symbol hard (its failure still degrades the whole batch). */
export const SOFT_PRICE_SYMBOLS: ReadonlySet<string> = (() => {
  const hard = new Set([
    ...PRICE_SCORERS.filter((s) => !s.soft).flatMap((s) => s.inputs),
    ...DOWNSIDE_DETECTORS.map((d) => d.symbol),
    ...RS_LEGS.flatMap((l) => l.symbols),
  ]);
  return new Set(PRICE_SCORERS.filter((s) => s.soft).flatMap((s) => s.inputs).filter((sym) => !hard.has(sym)));
})();

/** id → the price symbols `scorePriceIndicators` scores it off (PRICE_SCORERS + DB_* + RS_*) — the batch's `markFallbackSourced` claims. */
export const PRICE_BATCH_INPUTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...PRICE_SCORERS.map((s) => [s.indicator.id, s.inputs] as const),
  ...DOWNSIDE_DETECTORS.map((d) => [d.indicator.id, [d.symbol]] as const),
  ...RS_LEGS.map((l) => [l.indicator.id, l.symbols] as const),
]);

/** `scorePriceIndicators`' result. */
export type PriceBatch = {
  readings: Reading[];
  backfillSeries: { id: string; series: Reading[]; estimateDates: string[] }[];
  qqq: Observation[];
  downside: Reading[];
  rs: Reading[];
  /** PRICE_SCORERS + DB_* + RS_* per-id scored series (newest persisted via `readings`/`downside`/`rs`) — the gap-fill carry. */
  series: { id: string; series: Reading[] }[];
  /** Per-id feed-date grid for rows whose `calendar` is NOT QQQ's (EXSH_GATE → EXSH.DE Xetra dates). */
  calendars: Record<string, string[]>;
  /** Per-id dates an input leg carries an `estimated` obs (a closes provider `.DE` meta close) — the caller marks them estimate-sourced. */
  estimateDates: Record<string, string[]>;
};

/**
 * Score the keyed-price indicators (F4 semis, F5 breadth). The price feed is the
 * ONE optional dependency that may be unconfigured (no key) or rate-limited, and
 * a price-feed failure must NOT abort the FRED-based verdict (§5 pre-mortem) — so
 * this degrades to [] (FRED-only) on any error instead of throwing. Both F4 (semis)
 * and F5 (breadth) are CONTEXT (Phase-2 C5 demoted F4) — surfaced but excluded
 * from every roll-up score.
 */
export async function scorePriceIndicators(runAt: string, env: Env, ctx?: DbFirstCtx): Promise<PriceBatch> {
  return degrade<PriceBatch>(
    "[prices] feed unavailable - scoring FRED-only",
    "notify",
    { readings: [], backfillSeries: [], qqq: [], downside: [], rs: [], series: [], calendars: {}, estimateDates: {} },
    async () => {
      const feeds = feedsOf(ctx);
      // Fetch the deduped union of every spec's inputs once (first-seen order →
      // ["SMH","NVDA","QQQ","QQQE",…], the existing set). The PRICE_SCORERS table is
      // the single source of truth for the symbol→scorer pairing this loop used to
      // hardcode. `DOWNSIDE_DETECTORS`'s symbols are appended (dedup keeps SMH's
      // existing position): the detector loop below reads `bySymbol`, so a detector on
      // a symbol NO scorer fetches (XLK) would otherwise silently score nothing.
      const symbols = [
        // `RS_LEGS`' symbols are appended for the same structural reason as DOWNSIDE_DETECTORS':
        // every one is already fetched today, but the coupling must not be coincidental.
        ...new Set([
          ...PRICE_SCORERS.flatMap((s) => s.inputs),
          ...DOWNSIDE_DETECTORS.map((d) => d.symbol),
          ...RS_LEGS.flatMap((l) => l.symbols),
        ]),
      ];
      // Per-symbol depth: the four breadth legs (F5's QQQ/QQQE, SPCONC's SPY/RSP) need
      // BREADTH_MIN_CLOSES aligned closes before the dynamic band can form at all, which the
      // default ~275-close window cannot supply — see `DEEP_PRICE_INPUTS` (registry-price.ts) for
      // why this is per-symbol and not a global LOOKBACK_DAYS bump. Every other symbol is shallow.
      // Per-symbol depth AND source. Shallow symbols keep their plain 2y fetch, holes filled from the
      // stored `INPUT_SERIES` rows of the rostered ones (below). The four
      // DEEP breadth symbols go DB-first (§6.2): the stored raw closes + a `TAIL_DAYS` tail, a shallow
      // store re-fetching deep and (for the three MINTED BR_* ids) storing it back. SPY is READ-ONLY —
      // its closes live under the `SPY` id its dedicated cron writer keeps fresh (`INPUT_SERIES`, post-J4),
      // so this path reads+merges but NEVER writes (the one documented departure from §0.2, §6.2).
      // A SOFT symbol's failure empties only its soft rows (they score `[]`); every other symbol stays hard.
      // Defect 3: a rostered shallow symbol's live holes (the closes provider's Xetra
      // D-1 null bar under EXSH_GATE / AT1) fill from its stored closes, so the inner-joined ratio keeps D-1 and the
      // EOD gap-fill can finalize it. The stored window only has to span the hole — a stored row fills only a
      // date before the live newest — so `TAIL_DAYS` rows, not the MA depth. Offline (`ctx` unset): live only.
      const shallowCloses = ctx
        ? withStoredLegs(ctx.store, symbols.filter((sym) => !DEEP_PRICE_INPUTS.has(sym)), (sym) => feeds.fetchDailyCloses(sym, { now: () => Date.parse(runAt), env }), TAIL_DAYS, {
            now: new Date(ctx.runAt),
            onFail: (scope, reason) => recordDegrade(scope, reason, "notify"),
          })
        : undefined;
      const fetched = await Promise.all(
        symbols.map((sym) =>
          SOFT_PRICE_SYMBOLS.has(sym)
            ? resolveBreadthCloses(sym, runAt, env, ctx, shallowCloses).catch((err: unknown): Observation[] => {
                console.warn(`[prices] soft symbol ${sym} unavailable - its soft rows skipped: ${String(err)}`);
                recordDegrade(`[prices] soft symbol ${sym} unavailable - its soft rows skipped`, String(err), "notify");
                return [];
              })
            : resolveBreadthCloses(sym, runAt, env, ctx, shallowCloses),
        ),
      );
      const bySymbol: Record<string, Observation[]> = {};
      symbols.forEach((sym, i) => (bySymbol[sym] = fetched[i]!));

      // Each spec scores its per-day series; LAST element = the live commit
      // reading (joins `readings`, atomic with the alert). A `backfill` row (NVDA)
      // is also backfilled whole. A guard-light row
      // can also return EMPTY (F5/SPCONC below the rankable window — a NaN-cut warm-up
      // that would otherwise publish a false GREEN); those legs are dropped, not `.at(-1)!`d.
      const specs = PRICE_SCORERS.map((s) => ({ id: s.indicator.id, backfill: s.backfill === true, inputs: s.inputs, series: s.series(bySymbol) }));
      // Slice-2 downside-break detectors over {SMH, XLK} — REUSE the closes just
      // fetched into bySymbol (no new feed). Use the guard-light series form + `.at(-1)`
      // rather than scoreDownsideBreak so a short/absent leg yields nothing (its `[]`)
      // instead of throwing and aborting the WHOLE price batch (which would also drop
      // F4/F5). Persisted under the DB_* ids; api/lab.ts maps them back for /lab.
      const downsideSeries = DOWNSIDE_DETECTORS.map((d) => ({
        id: d.indicator.id,
        series: downsideBreakReadingSeries(d.indicator, bySymbol[d.symbol] ?? []),
      }));
      // EW rel-strength legs (RS_*) — same guard-light `.at(-1)` shape over the same bySymbol closes.
      const rsSeries = RS_LEGS.map((l) => ({
        id: l.indicator.id,
        series: relStrengthBreakReadingSeries(l.indicator, bySymbol[l.symbols[0]] ?? [], bySymbol[l.symbols[1]] ?? []),
      }));
      const newestOf = (xs: { series: Reading[] }[]): Reading[] =>
        xs.map((x) => x.series.at(-1)).filter((r): r is Reading => r !== undefined);
      return {
        readings: specs.map((s) => s.series.at(-1)).filter((r): r is Reading => r !== undefined),
        backfillSeries: specs
          .filter((s) => s.backfill)
          .map(({ id, series, inputs }) => ({ id, series, estimateDates: estimateDatesOf(...inputs.map((sym) => bySymbol[sym])) })),
        // The slow track reuses these QQQ closes (already fetched here) instead of
        // re-hitting the closes provider for the same symbol in the same run — the feed throttles
        // duplicate/concurrent calls, which was degrading the slow track most runs.
        qqq: bySymbol["QQQ"] ?? [],
        downside: newestOf(downsideSeries),
        rs: newestOf(rsSeries),
        series: [...specs.map(({ id, series }) => ({ id, series })), ...downsideSeries, ...rsSeries],
        calendars: Object.fromEntries(
          PRICE_SCORERS.filter((s) => s.calendar !== undefined).map((s) => [
            s.indicator.id,
            (bySymbol[s.calendar!] ?? []).map((o) => o.date),
          ]),
        ),
        estimateDates: Object.fromEntries([
          ...PRICE_SCORERS.map((s) => [s.indicator.id, estimateDatesOf(...s.inputs.map((sym) => bySymbol[sym]))] as const),
          ...DOWNSIDE_DETECTORS.map((d) => [d.indicator.id, estimateDatesOf(bySymbol[d.symbol])] as const),
          ...RS_LEGS.map((l) => [l.indicator.id, estimateDatesOf(...l.symbols.map((sym) => bySymbol[sym]))] as const),
        ]),
      };
    },
  );
}

/** One deep breadth symbol's DB-first feed spec (§6.2): its minted BR_* id — SPY its own id,
 *  READ-ONLY (its dedicated cron writer owns the id). Spread by `resolveBreadthCloses`; the direct
 *  arm tests drive `resolveDbFirstArm` with the same object. */
export const breadthFeed = (sym: string): DbFirstFeedSpec => ({
  id: BREADTH_STORE_IDS[sym]!.id,
  needRows: needRowsForCalendarDays(BREADTH_LOOKBACK_DAYS),
  readOnly: BREADTH_READ_ONLY.has(sym),
  holdFinal: () => finalRewriteHeld(sym), // per symbol: a QQQ hop never holds BR_RSP
});

/**
 * R4's DB-first feed spec (ECY's deep DFII10 input persists under R4 — `fetchR4DeepInputs`), sized
 * to DFII10's whole history as of `runAt` — NOT the shared seed depth: a seed-depth read cap joined
 * ~3y of months against the `ECY_MIN_OBS` floor and ECY was omitted on EVERY run (2026-09-05 → 2026-09-29).
 * `minRows` must cover every stored weekday from the origin; `needRows` (the deep-arm trigger) must stay under DFII10's real row count.
 */
export const r4DbFirstFeed = (runAt: string): DbFirstFeedSpec => {
  const days = (Date.parse(runAt.slice(0, 10)) - Date.parse(DFII10_ORIGIN)) / 86_400_000;
  return { id: "R4", needRows: needRowsForCalendarDays(days), minRows: readRowsForCalendarDays(days) };
};

// Store-read depth for the core-loop per-indicator FRED fallback (audit rank 3): how many
// last-persisted points to pull when a live fetch fails. ~570 trading days ≈ the keyless
// FRED lookback window, comfortably above every FRED scorer's velocity + calibration windows.
export const FRED_FALLBACK_READ = 800;

// Core-loop ids whose DEEP (`fullHistory`) fetch is served DB-first (§6.1): the stored series + a
// `TAIL_DAYS` tail. Never a `SMOOTHED_LEVEL_OF` id (its stored value is the mean — `db-first-feeds.test.ts` pins ∅).
export const CORE_LOOP_DB_FIRST: ReadonlySet<string> = new Set([]);

/**
 * The single VIXCLS/VXVCLS fetch on THIS path — the pair pulled once here and shared by BOTH
 * consumers: VT (the VT FAST_CONFIRMER, confirmers.ts) AND the off-ladder VIX-bottom track
 * (threaded via TrackCtx). That consolidation killed the duplicate pull that lost the cron's
 * rate-limit race and silently dropped VT on prod (feed consolidation 2026-07-05; the legs were
 * the closes feed's `^VIX`/`^VIX3M` chart until the 2026-07-26 FRED repoint).
 *
 * Lives in run-dbfirst.ts
 * (not vix_term.ts) so the fetchVixSeries call is CROSS-module — the seam the tests spy on;
 * an intra-module call would bypass vi.spyOn(vixTerm, "fetchVixSeries") (run.wiring.test.ts asserts
 * fetchVixSeries called exactly 2×/run). Each leg degrades to [] internally, so this never
 * throws; an empty leg is each consumer's degraded sentinel.
 */
export async function fetchVixTermLegs(
  runAt: string,
  env: Env,
  onFail?: (scope: string, err: unknown) => void,
  { fetchSeries, fetchVixSeries }: Pick<FeedPorts, "fetchSeries" | "fetchVixSeries"> = realFeeds,
): Promise<{ front: Observation[]; back: Observation[] }> {
  const fetchFn = (series: string): Promise<Observation[]> => fetchSeries(series, { now: new Date(runAt), env });
  const [front, back] = await Promise.all([fetchVixSeries(VIX_SYMBOL, fetchFn, onFail), fetchVixSeries(VIX3M_SYMBOL, fetchFn, onFail)]);
  return { front, back };
}

/** The run-cycle state the ex-inline FRED-loop closures read — explicit deps, no hidden closure state. */
export interface FredLoopDeps {
  dbFirst: Pick<DbFirstCtx, "store" | "runAt" | "intraday" | "feeds">;
  env: Env;
  calib: ReadonlyArray<CalibrationParam>;
  synthLoad: SynthHistoryLoad;
  postInversionShortLeg: Promise<Observation[]>;
}

/**
 * Build the core FRED loop's three scorers off explicit deps (B1 peel — these were inline
 * closures in `runScoringCycle`; parameters replace the closed-over state 1:1).
 */
export function makeFredLoop({ dbFirst, env, calib, synthLoad, postInversionShortLeg }: FredLoopDeps): {
  seriesScorerFor: NonNullable<DbFirstCtx["seriesScorerFor"]>;
  scoreFred: (indicator: (typeof INDICATORS)[number], observations: Observation[]) => Promise<Reading[]>;
  fredLoopObservations: (indicator: (typeof INDICATORS)[number]) => Promise<Observation[]>;
} {
  const feeds = feedsOf(dbFirst);
  // The SERIES-form twin for the DB-first sites that persist a FRED-loop id's history (R7 over
  // R1/R2/R3 — `r7LegSeries`, confirmers.ts): same calib/synth vintage and the same short leg as
  // `scoreFred` below, so a row the seam writes agrees with the one this loop writes for the day.
  const seriesScorerFor = async (indicator: Indicator): Promise<(points: Observation[]) => Reading[]> => {
    const shortLeg = indicator.postInversionCooldown ? await postInversionShortLeg : undefined;
    return (points) =>
      scoreWithCutsSeries(indicator, points, calib, undefined, synthHistoriesInclusive(synthLoad, indicator.id, points), shortLeg);
  };
  // `withNewest(<series>, <scalar>)`: run-cycle persists `.at(-1)` and carries the series to the gap-fill sweep.
  const scoreFred = async (
    indicator: (typeof INDICATORS)[number],
    observations: Observation[],
  ): Promise<Reading[]> => {
    // No id injects a cross-series leg any more (the F1/F2 Baa10y proxy was deleted 2026-08-06,
    // Stage 5.2); every z here is own-series, built inline in rawStateSeries.
    const shortLeg = indicator.postInversionCooldown ? await postInversionShortLeg : undefined;
    const newest = scoreWithCuts(
      indicator,
      observations,
      calib,
      undefined,
      synthHistoriesInclusive(synthLoad, indicator.id, observations),
      shortLeg,
    );
    return withNewest(await gapFillSeries(indicator, observations, shortLeg), newest);
  };
  // The gap-fill window's rows, scored as the cron would have scored each day had it been a run's newest. A
  // `synthPriors` id (F3/F11) per day off the STORED pool, from `confirmClosesFor(id)` obs before the window so
  // the sweep's bootstrap trim lands outside it. Never fatal: a failure only skips this run's gap-fill.
  const gapFillSeries = async (indicator: Indicator, observations: Observation[], shortLeg?: Observation[]): Promise<Reading[]> => {
    try {
      if (!SYNTH_PRIOR_IDS.includes(indicator.id)) return (await seriesScorerFor(indicator))(observations);
      const at = observations.findIndex((o) => o.date >= gapFillFrom(dbFirst.runAt.slice(0, 10)));
      if (at < 0) return [];
      const stored = await dbFirst.store.getSeries(indicator.id, SYNTH_HISTORY_LIMIT);
      return scoreWithCutsSeriesPerDay(indicator, observations, calib, shortLeg, {
        from: observations[Math.max(0, at - confirmClosesFor(indicator.id))]!.date,
        stored,
      });
    } catch (err) {
      console.warn(`[gap-fill] ${indicator.id}: skipped this run: ${err instanceof Error ? err.message : String(err)}`);
      recordDegrade(`[gap-fill] ${indicator.id}: skipped this run`, err instanceof Error ? err.message : String(err), "trace");
      return [];
    }
  };
  // The core loop's own fetch, DB-first for the `CORE_LOOP_DB_FIRST` deep ids (roster empty since
  // 2026-09-04 — R1 is smoothed; the seam stays for a raw-valued deep id). Scored by `scoreFred` in run-cycle-fred.ts's INDICATORS loop.
  const fredLoopObservations = async (indicator: (typeof INDICATORS)[number]): Promise<Observation[]> => {
    if (!CORE_LOOP_DB_FIRST.has(indicator.id)) return fetchIndicatorObservations(indicator, {}, dbFirst.runAt, env, feeds);
    const { points } = await dbFirstOrDirect(
      { ...dbFirst, seriesScorerFor },
      {
        id: indicator.id,
        needRows: needRowsForSeedDepth(),
        fetchDeep: () => fetchIndicatorObservations(indicator, {}, dbFirst.runAt, env, feeds),
        fetchTail: () => feeds.fetchSeries(indicator.series, { since: tailSince14(new Date(dbFirst.runAt)), now: new Date(dbFirst.runAt), env }),
        score: await seriesScorerFor(indicator),
        onPersistError: (err) =>
          recordDegrade(`[core-loop-db-first] persist failed - ${indicator.id} history not written, scored`, String(err), "notify"),
      },
    );
    return points;
  };
  return { seriesScorerFor, scoreFred, fredLoopObservations };
}

/**
 * Deep DFII10 (its own second fetch, from `DFII10_ORIGIN`), DB-first (R7 template, confirmers.ts): R4 has no
 * `postInversionCooldown`, so the core loop fetches it SHALLOW — this deep fetch is a genuine
 * second one, and DB-first removes it once R4's stored history is deep enough (tail thereafter).
 * Kept inside the `degrade(…, [], …)` wrapper: a feed failure still yields [] ⇒ ECY omitted,
 * never a thrown run. A persist reject degrades separately (ECY still scores off the merged points).
 */
export function fetchR4DeepInputs(
  dbFirst: Pick<DbFirstCtx, "store" | "runAt" | "intraday" | "feeds">,
  seriesScorerFor: NonNullable<DbFirstCtx["seriesScorerFor"]>,
  runAt: string,
  env: Env,
): Promise<Observation[]> {
  const { fetchSeries, fetchTreasuryColumn } = feedsOf(dbFirst);
  return degrade<Observation[]>(
    "[ecy] DFII10 real-yield feed unavailable - ECY omitted this run",
    "notify",
    [],
    async () =>
      (
        await dbFirstOrDirect(
          { ...dbFirst, seriesScorerFor },
          {
            ...r4DbFirstFeed(runAt),
            // A2: this direct-fetch bypass takes the Treasury same-day head too, so ECY scores the same
            // R4 vintage as the core loop — both arms, and the seam re-persists a grafted date whose
            // FRED value later differs over its 14d tail (A1's repair). `runAt` is the run's own clock.
            fetchDeep: async () =>
              graftTreasuryHeadFor("R4", await fetchSeries("DFII10", { since: DFII10_ORIGIN, now: new Date(runAt), env }), runAt, fetchTreasuryColumn),
            fetchTail: async () =>
              graftTreasuryHeadFor("R4", await fetchSeries("DFII10", { since: tailSince14(new Date(runAt)), now: new Date(runAt), env }), runAt, fetchTreasuryColumn),
            score: await seriesScorerFor(fredLoopIndicator("R4")),
            onPersistError: (err) =>
              recordDegrade("[ecy-db-first] persist failed - R4 history not written, ECY scored", String(err), "notify"),
          },
        )
      ).points,
  );
}
