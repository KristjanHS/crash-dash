/**
 * Pure orchestration (`backfillAll`/`liveDeps`) for the `indicators` job; the CLI is `scripts/backfill/run.ts`.
 * Dev: `npm run backfill`. Prod: `npm run backfill:raw -- <job> --env=prod` — never plain `backfill` (boots a dev stack).
 */
import { fetchEbp } from "../src/ebp.js";
import { HICP_SERIES, hicpDelta6m } from "../src/hicp.js";
import { velocitySigmaLookbackDays } from "../src/fred.js";
import { fetchNtfsSeries } from "../src/gsw.js";
import {
  BOTTOM_INDICATORS,
  DOWNSIDE_DETECTORS,
  F4,
  F5,
  F6,
  KBE_RS,
  INS_RS,
  EXSH_GATE,
  AT1,
  MU_RS,
  JPT,
  F8,
  F13,
  NVDA,
  SPCONC,
  RS_LEGS,
  PENSION_INDICATORS,
} from "../src/registry-price.js";
import {
  BUND,
  CG,
  COMPOSITE_COMPONENTS,
  componentBackfillSeries,
  DISP,
  HCX,
  FDX,
  VXNCLS,
  T10Y3M_RAW,
  VXSMH,
  CQS,
  EURC,
  EPATH,
  BONOS,
  FXH,
  GB,
  HCX_FETCH_OPTS,
  GT,
  R7,
  VT,
  VTP,
  VXNT,
} from "../src/registry-composite.js";
import {
  EBP,
  HICP,
  CCC,
  ECY,
  FEED_OF,
  INDICATORS,
  R6,
} from "../src/registry-fred.js";
import {
  G1,
  BRENT,
  NG,
} from "../src/registry-geo.js";
import { GB_SYMBOLS, HCX_SYMBOLS } from "../src/family-descriptor-rows.js";
import {
  breadthReadingSeries,
  hcxBasketSeries,
  creditAppetiteReadingSeries,
  downsideBreakReadingSeries,
  relStrengthBreakReadingSeries,
  exshGateReadingSeries,
  ratioVsMaReadingSeries,
  globalTrendReadingSeries,
  memGateReadingSeries,
  nvdaGateReadingSeries,
  semisReadingSeries,
} from "../src/scorers-price.js";
import {
  bullSteepenerReadingSeries,
  dispersionReadingSeries,
  ecyRows,
  cgPoints,
  cgRows,
  cgLookbackDays,
  CG_LEVEL_ANCHOR,
  fxHavenReadingSeries,
  globalBreadthReadingSeries,
  creditBridgeReadingSeries,
  bonosSpreadReadingSeries,
  curveReadingSeries,
  moveReadingSeries,
  ratioSpreadReadingSeries,
  ratioSpreadMinLen,
  vixTermPersistenceReadingSeries,
  vxnTermReadingSeries,
} from "../src/scorers-composite.js";
import {
  indicatorReadingSeries,
  oilReadingSeries,
  smoothedLevelReadingSeries,
} from "../src/scorers-core.js";
import type { Indicator, Observation, Reading } from "../src/domain-types.js";
import {
  VT_DESCRIPTOR,
  VXNT_DESCRIPTOR,
  VXNT_K_WINDOW,
  BUND_DESCRIPTOR,
  EURC_DESCRIPTOR,
  EPATH_DESCRIPTOR,
  OIL_LEVEL_LOOKBACK_DAYS,
  GEO_HYBRID_DESCRIPTOR_OF,
  SMOOTHED_LEVEL_OF,
} from "../src/family-descriptor-rows.js";
import { VIX_SYMBOL, VIX3M_SYMBOL } from "../src/vix_term.js";
import { fetchEcbSeries } from "../src/ecb.js";
import type { EcbSeriesKey } from "../src/ecb.js";
import { realFeeds } from "../src/feed-ports.js";
import { BREADTH_LOOKBACK_DAYS } from "../src/registry-price.js";
import { ESTR, ECISS, EURGBP } from "../src/registry-composite.js";
import { derivedReadingSeries } from "../src/scorers-core.js";
import { returnOrMaSpreadReadingSeries } from "../src/scorers-price.js";
import { dropTargetHolidays } from "../src/market-closures.js";
import { fetchDailyCloses } from "../src/prices.js";
import { LOOKBACK_DAYS } from "../src/price-cache.js";
import { DEEP_LOOKBACK_DAYS } from "../src/lookback.js";
import { priceLegReadingSeries } from "../src/pension.js";
import { finalDates } from "../src/intraday.js";
import { INPUT_SERIES, inputDeepLookbackDays } from "../src/input-series.js";
import { LADDER } from "../src/families.js";
import {
  LEG_TICKER,
  legCloseId,
  legCloseQuotes,
  legCloseReadingRows,
  legProxy,
  offLadderLegCloseReadingRows,
  offLadderLegCloseId,
  OFF_LADDER_LEG_TICKER,
  OFF_LADDER_LEG_KEYS,
} from "../src/scoreboard.js";
import { PRE_FIRST_PRUNE_MAX_SHARE, backfillHistory, capeOpenFloor, wallClock, type Clock } from "../src/run-seeds.js";
import { estimateDatesOf, stampEstimated } from "../src/estimated.js";
import { resolveCuts } from "../src/domain-cuts.js";
import type { CalibrationCuts } from "../src/domain-cuts.js";
import { loadSynthHistories, synthesizedCalib } from "../src/synth-cuts.js";
import { SYNTH_PRIOR_IDS } from "../src/domain-cuts.js";
import { bandCutsUsed, r7LegLoopDeep, scoreWithCutsSeriesPerDay } from "../src/confirmers.js";
import type { R7_LEG_IDS } from "../src/confirmers.js";
import { BACKFILL_YEARS, deepArmSince } from "../src/series-db-first.js";
import { LEG_BACKFILL_YEARS, LEG_PROXY_SEED_YEARS } from "../src/backfill-depth.js";
import type { CalibrationParam } from "../src/store.js";
import type { Store, StoredReading } from "../src/store.js";

// Star-re-exported for importers; one-way — restate-policy.ts must never import this file.
export * from "./restate-policy.js";
import {
  DEEP_PROBE,
  SKIP_SAFE_IDS,
  backfillCutoffFor,
  backfillFloorsFor,
  backfillSinceDate,
  probeFor,
  curveFeedSince,
  sovereignFeedSince,
  backfillTrimYears,
  isoCutoff,
  isoDaysBefore,
  latestStoredDate,
  minIso,
  planFetch,
  reshadowAllSet,
  reshadowDays,
  specCutoff,
  writeSet,
} from "./restate-policy.js";
import type { FetchPlan } from "./restate-policy.js";
import { withFredArchive } from "./backfill/fred-archive.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";
import { isNoFreeSource } from "../src/no-free-source.js";

/** Default scored-spec warmup (≥252 trading days); a deeper-window spec overrides via `warmupDays`. */
export const SCORED_WARMUP_DAYS = 420;
/** VXNT warmup: the k window + the ratio scorer's floor, in calendar days (+30 margin) — derived, so a k-window retune moves it; SCORED_WARMUP_DAYS covers today's need by slack only, tied to neither. */
export const VXNT_WARMUP_DAYS = Math.ceil(((VXNT_K_WINDOW + ratioSpreadMinLen(VXNT_DESCRIPTOR)) * 365) / 252) + 30;
/** Raw-leg warmup (pension/bottom/legs). */
export const RAW_WARMUP_DAYS = 7;

/** Price feed opts for a non-skip plan: always deep; `since` bounds the window to `lookbackDays`. */
function priceOpts(plan: Exclude<FetchPlan, { mode: "skip" }>): { deep: true; lookbackDays?: number } {
  return plan.mode === "since" ? { deep: true, lookbackDays: plan.lookbackDays } : { deep: true };
}

/** FRED feed opts for a non-skip plan — the one expression scored specs and BOTTOM legs share. */
function fredOpts(plan: Exclude<FetchPlan, { mode: "skip" }>): { fullHistory?: boolean; since?: string } {
  return plan.mode === "since" ? { since: plan.sinceDate } : { fullHistory: true };
}

/** Injectable feed seam: `liveDeps` in prod, stubs in tests. */
export interface BackfillDeps {
  fetchFred(series: string, opts: { fullHistory?: boolean; since?: string }): Promise<Observation[]>;
  fetchEbp(): Promise<Observation[]>;
  fetchEcb(series: EcbSeriesKey, opts?: { startPeriod?: string }): Promise<Observation[]>;
  fetchPrices(symbol: string, opts: { deep: boolean; lookbackDays?: number }): Promise<Observation[]>;
  /** Keyless sovereign-quote daily bars — FR/IT/ES/DE 10y + DE/FR 2y legs; [from, to] ISO. */
  fetchSovereignDaily(symbol: string, from: string, to: string): Promise<Observation[]>;
  /** Monthly CAPE history — ECY's valuation leg; specs() never trims it. */
  fetchCape(): Promise<Observation[]>;
  /** Keyless GSW NTFS composite (src/gsw.ts) — always full history; R8 via `FEED_OF` in `indObs`. */
  fetchNtfs(): Promise<Observation[]>;
}

/** Production feeds: keyless FRED + the EBP confirmer + the ECB euro curve + the F4/F5 price feed. */
export const liveDeps: BackfillDeps = {
  fetchFred: (series, opts) => realFeeds.fetchSeries(series, { ...opts, now: new Date(), env: readEnv() }),
  fetchEbp,
  fetchEcb: (series, opts) => fetchEcbSeries(series, opts),
  fetchPrices: (symbol, opts) => fetchDailyCloses(symbol, { ...opts, now: Date.now, env: readEnv() }),
  fetchSovereignDaily: (symbol, from, to) => realFeeds.fetchSovereignBars(symbol, from, to),
  fetchCape: () => realFeeds.fetchCape(),
  fetchNtfs: () => fetchNtfsSeries(new Date(), readEnv()),
};

export interface BackfillResult {
  /** Rows seeded per indicator id (0 = already complete). */
  seeded: Record<string, number>;
  /** Indicators whose feed/scoring threw — the run continues past each. */
  failures: { id: string; error: string }[];
  /** Total rows seeded across all indicators this run. */
  total: number;
}

/** Keep rows on/after `cutoff`. `backfillAll` trims readings centrally; specs use it on feeds only. */
const trim = <T extends { date: string }>(obs: T[], cutoff: string): T[] => obs.filter((o) => o.date >= cutoff);

// --- Pension legs (SPY/VEA/DEXUSEU/SP500IT): raw stored series, insert-missing — not backfillHistory ---

/** Injectable feed seam for the pension legs (the idempotency test injects stubs). */
export interface PensionBackfillDeps {
  fetchPrices(symbol: string, opts: { deep: boolean; lookbackDays?: number }): Promise<Observation[]>;
}

/** Deep price-feed closes for every pension leg; the FX leg is `EURUSD=X` stored as `DEXUSEU`.
 *  Never FRED DEXUSEU — its weekly lag trips the pension freshness gate. */
export const livePensionDeps: PensionBackfillDeps = {
  fetchPrices: (symbol, opts) => fetchDailyCloses(symbol, { ...opts, now: Date.now, env: readEnv() }),
};

/** Feed opts threaded from the leg's `planFetch` result (deep window, optionally shrunk). */
type LegFetchOpts = { deep: true; lookbackDays?: number };

/** PENSION legs, derived from `INPUT_SERIES`; `LEGP_EUFIN` is seeded by `seedLegClosesOnCron`, not here.
 *  Price feeds only: this job's one seam is `fetchPrices`, so a FRED-fed PENSION row would hand the price
 *  feed a FRED series id and abort the job — those rows are seeded by the `input-series` job instead. */
const PENSION_IDS = new Set(PENSION_INDICATORS.map((i) => i.id));
const PENSION_LEGS: { id: string; fetch: (deps: PensionBackfillDeps, opts: LegFetchOpts) => Promise<Observation[]> }[] =
  INPUT_SERIES.filter((s) => s.feed === "price" && PENSION_IDS.has(s.id)).map((s) => ({
    id: s.id,
    fetch: (d, o) => d.fetchPrices(s.symbol ?? s.id, o),
  }));

export interface PensionBackfillResult {
  /** Total rows inserted across the leg(s) this run (0 = already complete). */
  inserted: number;
  /** Rows inserted per leg id. */
  perLeg: Record<string, number>;
}

/** Seed the PENSION legs as raw series: trim to `BACKFILL_YEARS`, insert only dates a `DEEP_PROBE` read lacks. */
export async function backfillPension(
  store: Store,
  deps: PensionBackfillDeps,
  opts: { years?: number; probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const cutoff = isoCutoff(now, opts.years ?? BACKFILL_YEARS);
  const runAt = now.toISOString();
  const reshadowAll = reshadowAllSet(opts.reshadowAll, PENSION_LEGS.map((l) => l.id), "pension leg");
  const perLeg: Record<string, number> = {};
  let inserted = 0;
  for (const leg of PENSION_LEGS) {
    // A reshadow-all id forces the FULL fetch — a skip/since plan strands the old rows.
    const full = reshadowAll.has(leg.id);
    const plan: FetchPlan = full
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [leg.id]), RAW_WARMUP_DAYS, now, !SKIP_SAFE_IDS.has(leg.id));
    if (plan.mode === "skip") {
      perLeg[leg.id] = 0;
      continue;
    }
    const rows = priceLegReadingSeries(leg.id, trim(await leg.fetch(deps, priceOpts(plan)), cutoff));
    const existing = finalDates(await store.getSeries(leg.id, probe), leg.id);
    const missing = writeSet(rows, existing, now, reshadowDays(plan), full);
    if (missing.length > 0) await store.recordReadings(missing, runAt);
    perLeg[leg.id] = missing.length;
    inserted += missing.length;
  }
  return { inserted, perLeg };
}

// --- FXH haven-leg components (CMP_FXH_*) ------------------------------------

/** Injectable feed seam for the FXH component legs (the idempotency test injects stubs). */
export interface FxhCmpBackfillDeps {
  fetchPrices(symbol: string, opts: { deep: boolean; lookbackDays?: number }): Promise<Observation[]>;
}

/** Production feed: the same `fetchDailyCloses` the live FXH scorer fetches its `=X` legs through. */
export const liveFxhCmpDeps: FxhCmpBackfillDeps = {
  fetchPrices: (symbol, opts) => fetchDailyCloses(symbol, { ...opts, now: Date.now, env: readEnv() }),
};

/** HARD fetch cap, full plans included (free-tier price feed) — never route this job through `priceOpts`. */
export const FXH_CMP_LOOKBACK_DAYS = 1100;

/** Derived from `COMPOSITE_COMPONENTS` — never hand-type an id or ticker here. */
const FXH_CMP_LEGS: { id: string; symbol: string }[] = (COMPOSITE_COMPONENTS["FXH"] ?? []).map((c) => ({
  id: c.id,
  symbol: c.symbol,
}));

/** Seed CMP_FXH_* as raw series (insert-missing); every fetch capped at `FXH_CMP_LOOKBACK_DAYS`. */
export async function backfillFxhCmp(
  store: Store,
  deps: FxhCmpBackfillDeps,
  opts: { probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const runAt = now.toISOString();
  const reshadowAll = reshadowAllSet(opts.reshadowAll, FXH_CMP_LEGS.map((l) => l.id), "FXH component");
  const perLeg: Record<string, number> = {};
  let inserted = 0;
  for (const leg of FXH_CMP_LEGS) {
    const full = reshadowAll.has(leg.id);
    const plan: FetchPlan = full
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [leg.id]), RAW_WARMUP_DAYS, now, true);
    if (plan.mode === "skip") {
      perLeg[leg.id] = 0;
      continue;
    }
    const lookbackDays = Math.min(
      plan.mode === "since" ? plan.lookbackDays : FXH_CMP_LOOKBACK_DAYS,
      FXH_CMP_LOOKBACK_DAYS,
    );
    const rows = priceLegReadingSeries(leg.id, await deps.fetchPrices(leg.symbol, { deep: true, lookbackDays }));
    const existing = finalDates(await store.getSeries(leg.id, probe), leg.id);
    const missing = writeSet(rows, existing, now, reshadowDays(plan), full);
    if (missing.length > 0) await store.recordReadings(missing, runAt);
    perLeg[leg.id] = missing.length;
    inserted += missing.length;
  }
  return { inserted, perLeg };
}

/** DEEP seed of CMP_FXH_* via backfillHistory; by-name only (BY_NAME_ONLY_JOBS — free-tier price feed).
 *  Trim to `BACKFILL_YEARS` before seeding — untrimmed it overflows `DEEP_PROBE`. */
export async function backfillFxhCmpDeep(
  store: Store,
  deps: FxhCmpBackfillDeps,
  opts: { probe?: number; now?: Date } = {},
): Promise<PensionBackfillResult> {
  const probe = opts.probe ?? DEEP_PROBE;
  const cutoff = isoCutoff(opts.now ?? new Date(), BACKFILL_YEARS);
  const bySymbol: Record<string, Observation[]> = {};
  for (const leg of FXH_CMP_LEGS) {
    bySymbol[leg.symbol] = trim(await deps.fetchPrices(leg.symbol, { deep: true, lookbackDays: DEEP_LOOKBACK_DAYS }), cutoff);
  }
  const perLeg: Record<string, number> = {};
  let inserted = 0;
  for (const b of componentBackfillSeries("FXH", bySymbol)) {
    const n = await backfillHistory(store, b.id, b.series, probe, wallClock, undefined, false, undefined, undefined, undefined, new Set(estimateDatesOf(bySymbol[b.symbol])));
    perLeg[b.id] = n;
    inserted += n;
  }
  return { inserted, perLeg };
}

// --- VIX-bottom legs (VIXCLS/VXVCLS): raw insert-missing; series id from BOTTOM_INDICATORS, never a literal ---

/** Injectable FRED seam for the BOTTOM legs (the idempotency test injects a stub). */
export interface BottomBackfillDeps {
  fetchFred(series: string, opts: { fullHistory?: boolean; since?: string }): Promise<Observation[]>;
}

/** Production feed: the same source `vix_term.ts` reads for the live bottom track. */
export const liveBottomDeps: BottomBackfillDeps = {
  fetchFred: (series, opts) => realFeeds.fetchSeries(series, { ...opts, now: new Date(), env: readEnv() }),
};

/** `fetch()`, or null (logged) when it has no free source (a refused FRED id, an unfed port): a raw-series pass skips
 *  that id and continues, never aborting on it. Any other error propagates. */
async function skipNoFreeSource(id: string, fetch: () => Promise<Observation[]>): Promise<Observation[] | null> {
  try {
    return await fetch();
  } catch (err) {
    if (!isNoFreeSource(err)) throw err;
    console.log(`[backfill] ${id}: skipped (no free source) - ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Feed opts threaded from the leg's `planFetch` result (full history, or a `since` lower bound). */
type FredFetchOpts = { fullHistory?: boolean; since?: string };

/** The two BOTTOM legs, derived from the registry — never hand-type a series id. */
const BOTTOM_LEGS: { id: string; fetch: (deps: BottomBackfillDeps, opts: FredFetchOpts) => Promise<Observation[]> }[] =
  BOTTOM_INDICATORS.map((ind) => ({ id: ind.id, fetch: (d, o) => d.fetchFred(ind.series, o) }));

/** Seed the two VIX-bottom legs as raw series — backfillPension's body over the FRED seam. */
export async function backfillBottom(
  store: Store,
  deps: BottomBackfillDeps,
  opts: { years?: number; probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const cutoff = isoCutoff(now, opts.years ?? BACKFILL_YEARS);
  const runAt = now.toISOString();
  const reshadowAll = reshadowAllSet(opts.reshadowAll, BOTTOM_LEGS.map((l) => l.id), "bottom leg");
  const perLeg: Record<string, number> = {};
  let inserted = 0;
  for (const leg of BOTTOM_LEGS) {
    const full = reshadowAll.has(leg.id);
    const plan: FetchPlan = full
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [leg.id]), RAW_WARMUP_DAYS, now, !SKIP_SAFE_IDS.has(leg.id));
    if (plan.mode === "skip") {
      perLeg[leg.id] = 0;
      continue;
    }
    const fetched = await skipNoFreeSource(leg.id, () => leg.fetch(deps, fredOpts(plan)));
    if (fetched === null) {
      perLeg[leg.id] = 0;
      continue;
    }
    const rows = priceLegReadingSeries(leg.id, trim(fetched, cutoff));
    const existing = finalDates(await store.getSeries(leg.id, probe), leg.id);
    const missing = writeSet(rows, existing, now, reshadowDays(plan), full);
    if (missing.length > 0) await store.recordReadings(missing, runAt);
    perLeg[leg.id] = missing.length;
    inserted += missing.length;
  }
  return { inserted, perLeg };
}

// --- P1 input series (read-handler upstream inputs) --------------------------

/** Injectable feed seam for the input-series legs (the idempotency test injects stubs). */
export interface InputSeriesBackfillDeps {
  fetchFred(series: string, opts: { fullHistory?: boolean; since?: string }): Promise<Observation[]>;
  fetchPrices(symbol: string, opts: { deep: boolean; lookbackDays?: number }): Promise<Observation[]>;
  /** R8's own series (FEED_OF.R8 = "ntfs"): always full history by construction (gsw.ts). */
  fetchNtfs(): Promise<Observation[]>;
}

/** Production feeds: the same keyless FRED + price + GSW stack the cron seed fetches through. */
export const liveInputSeriesDeps: InputSeriesBackfillDeps = {
  fetchFred: (series, opts) => realFeeds.fetchSeries(series, { ...opts, now: new Date(), env: readEnv() }),
  fetchPrices: (symbol, opts) => fetchDailyCloses(symbol, { ...opts, now: Date.now, env: readEnv() }),
  fetchNtfs: () => fetchNtfsSeries(new Date(), readEnv()),
};

/** Input-series date-diff probe: MUST exceed the deepest full history (DGS10 ≈ 16k rows) — too small
 *  re-inserts the oldest dates every run. Keep equal to api/series.ts `INPUT_SERIES_LIMIT`. */
export const INPUT_SERIES_DEEP_PROBE = 20_000;

/** Seed `INPUT_SERIES` as raw series (insert-missing). Never add a `BACKFILL_YEARS` trim — the replay
 *  stitch reads this full depth; a full plan honours each spec's `deepLookbackDays`. */
export async function backfillInputSeries(
  store: Store,
  deps: InputSeriesBackfillDeps,
  opts: { probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? INPUT_SERIES_DEEP_PROBE;
  const runAt = now.toISOString();
  const reshadowAll = reshadowAllSet(opts.reshadowAll, INPUT_SERIES.map((s) => s.id), "input series");
  const perLeg: Record<string, number> = {};
  let inserted = 0;
  for (const spec of INPUT_SERIES) {
    // A snapshot-only feed serves no history: the cron seed writes it forward, so there is nothing to backfill.
    if (spec.feed === "snapshot") {
      perLeg[spec.id] = 0;
      continue;
    }
    const full = reshadowAll.has(spec.id);
    const plan: FetchPlan = full
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [spec.id]), RAW_WARMUP_DAYS, now, true);
    if (plan.mode === "skip") {
      perLeg[spec.id] = 0;
      continue;
    }
    const deepDays = inputDeepLookbackDays(spec, now);
    const obs = await skipNoFreeSource(spec.id, () =>
      spec.feed === "fred"
        ? deps.fetchFred(spec.symbol ?? spec.id, fredOpts(plan))
        : spec.feed === "ntfs"
        ? deps.fetchNtfs()
        : deps.fetchPrices(
            spec.symbol ?? spec.id,
            plan.mode === "full" && deepDays !== undefined
              ? { deep: true, lookbackDays: deepDays }
              : priceOpts(plan),
          ),
    );
    if (obs === null) {
      perLeg[spec.id] = 0;
      continue;
    }
    const rows = priceLegReadingSeries(spec.id, obs);
    const existing = finalDates(await store.getSeries(spec.id, probe), spec.id);
    const missing = writeSet(rows, existing, now, reshadowDays(plan), full);
    if (missing.length > 0) await store.recordReadings(missing, runAt);
    perLeg[spec.id] = missing.length;
    inserted += missing.length;
  }
  return { inserted, perLeg };
}

// --- CAPE valuation leg (F7): raw insert-missing via priceLegReadingSeries; only `value` is read ---

/** Injectable feed seam for the CAPE leg (the idempotency test injects a stub). */
export interface CapeBackfillDeps {
  fetchCape(): Promise<Observation[]>;
}

/** Production feed: the `fetchCape` port — the monthly Shiller-CAPE history has no free source, so it throws `NoFreeSourceError`. */
export const liveCapeDeps: CapeBackfillDeps = {
  fetchCape: () => realFeeds.fetchCape(),
};

/** Seed the CAPE leg (`F7`) as a raw series, trimmed to F7's registry `backfill` depth (stored depth is
 *  display-only; the z-score scores off the live full feed). */
export async function backfillCape(
  store: Store,
  deps: CapeBackfillDeps,
  opts: { probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const runAt = now.toISOString();
  const full = reshadowAllSet(opts.reshadowAll, ["F7"], "cape leg").has("F7");
  // The CAPE source has no window API: planFetch decides only skip vs fetch; F7 is revision-prone, so it never skips.
  const plan: FetchPlan = full
    ? { mode: "full" }
    : planFetch(await latestStoredDate(store, ["F7"]), 0, now, !SKIP_SAFE_IDS.has("F7"));
  if (plan.mode === "skip") return { inserted: 0, perLeg: { F7: 0 } };
  const raw = priceLegReadingSeries("F7", trim(await deps.fetchCape(), backfillSinceDate("F7", now)));
  // The open month is `estimated`, as `backfillCapeOnCron` stores it — never FINAL until the month closes.
  const rows = stampEstimated(raw, new Set(raw.filter((r) => r.date >= capeOpenFloor(runAt)).map((r) => r.date)));
  const existing = finalDates(await store.getSeries("F7", probe), "F7");
  const missing = writeSet(rows, existing, now, reshadowDays(plan), full);
  if (missing.length > 0) await store.recordReadings(missing, runAt);
  return { inserted: missing.length, perLeg: { F7: missing.length } };
}

// --- Downside-break detectors (DOWNSIDE_DETECTORS + RS_LEGS): SCORED via backfillHistory, never the raw-leg
// path — EARLY-WARN consumes the stored state, so it must match the cron scorer's ---

/** Seed every DOWNSIDE_DETECTORS/RS_LEGS leg via backfillHistory; `restate` (id-scoped) is the only heal for a cut retune.
 *  Owed on prod: `--restate=DB_SMH`. */
export async function backfillDownsideBreaks(
  store: Store,
  deps: PensionBackfillDeps,
  opts: { years?: number; probe?: number; now?: Date; restate?: readonly string[]; only?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const cutoff = isoCutoff(now, opts.years ?? BACKFILL_YEARS);
  const known = new Set([...DOWNSIDE_DETECTORS.map((d) => d.indicator.id), ...RS_LEGS.map((l) => l.indicator.id)]);
  // Fail LOUD on a typo'd id — a no-op restate reporting success is the expensive failure.
  const unknown = (opts.restate ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`restate: unknown detector id(s) ${unknown.join(", ")} — known: ${[...known].join(", ")}`);
  }
  const restate = new Set(opts.restate ?? []);
  // Narrow the PASS only after validation; fail loud on a set matching no leg.
  const onlySet = opts.only === undefined ? null : new Set(opts.only);
  const inPass = (id: string): boolean => onlySet === null || onlySet.has(id);
  if (onlySet !== null && ![...known].some((id) => onlySet.has(id))) {
    throw new Error(`only: no detector leg matched ${[...onlySet].join(", ")} — known: ${[...known].join(", ")}`);
  }
  const perLeg: Record<string, number> = {};
  let total = 0;

  // TWO PHASES: every fetch completes before the first write, so a feed throw leaves the DB untouched.
  const planned: { id: string; readings: Reading[]; reshadowFloor: string | undefined; est: string[] }[] = [];
  for (const d of DOWNSIDE_DETECTORS) {
    const id = d.indicator.id;
    if (!inPass(id)) continue;
    // SCORED leg ⇒ SCORED_WARMUP_DAYS; a restated id fetches FULL (a skip/since plan strands old rows).
    const plan: FetchPlan = restate.has(id)
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [id]), SCORED_WARMUP_DAYS, now, !SKIP_SAFE_IDS.has(id));
    if (plan.mode === "skip") {
      perLeg[id] = 0;
      continue;
    }
    const closes = trim(await deps.fetchPrices(d.symbol, priceOpts(plan)), cutoff);
    const readings = downsideBreakReadingSeries(d.indicator, closes);
    const rtd = reshadowDays(plan);
    // Restate floors the re-shadow at the trim cutoff, so the whole history re-writes.
    const reshadowFloor = restate.has(id) ? cutoff : rtd === undefined ? undefined : isoDaysBefore(now, rtd);
    planned.push({ id, readings, reshadowFloor, est: estimateDatesOf(closes) });
  }
  // EW rel-strength legs (RS_SMH/RS_XLK): same planner + restate semantics as the DB loop.
  for (const l of RS_LEGS) {
    const id = l.indicator.id;
    if (!inPass(id)) continue;
    const plan: FetchPlan = restate.has(id)
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, [id]), SCORED_WARMUP_DAYS, now, !SKIP_SAFE_IDS.has(id));
    if (plan.mode === "skip") {
      perLeg[id] = 0;
      continue;
    }
    const [num, spy] = await Promise.all(l.symbols.map((sym) => deps.fetchPrices(sym, priceOpts(plan))));
    const readings = relStrengthBreakReadingSeries(l.indicator, trim(num!, cutoff), trim(spy!, cutoff));
    const rtd = reshadowDays(plan);
    const reshadowFloor = restate.has(id) ? cutoff : rtd === undefined ? undefined : isoDaysBefore(now, rtd);
    planned.push({ id, readings, reshadowFloor, est: estimateDatesOf(num, spy) });
  }
  // A per-id restate refusal must not strand the ids after it half-restated: write every id, rethrow at the end.
  const refused: string[] = [];
  for (const p of planned) {
    try {
      const inserted = await backfillHistory(store, p.id, p.readings, probe, wallClock, p.reshadowFloor, restate.has(p.id), cutoff, isoDay(now), undefined, new Set(p.est));
      perLeg[p.id] = inserted;
      total += inserted;
    } catch (err) {
      refused.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (refused.length > 0) throw new Error(refused.join("\n"));
  return { inserted: total, perLeg };
}

// --- Per-leg EUR closes (LEGP_*): fold through the SHARED `legCloseReadingRows` — never a second EUR conversion here ---

/** Grace past the legs cutoff before a leg counts as shallow (first stored date = first trading day ≥ cutoff);
 *  also the reshadow delete's reached-depth slack. */
export const LEG_DEPTH_SLACK_DAYS = 30;

/** Injectable feed seam for the LEGP_* legs: deep prices — the `EURUSD=X` FX leg rides it too. */
export interface LegsBackfillDeps {
  fetchPrices(symbol: string, opts: { deep: boolean; lookbackDays?: number }): Promise<Observation[]>;
}

/** Production feed: the same `fetchDailyCloses` `seedLegClosesOnCron` uses, `EURUSD=X` included. */
export const liveLegsDeps: LegsBackfillDeps = {
  fetchPrices: (symbol, opts) => fetchDailyCloses(symbol, { ...opts, now: Date.now, env: readEnv() }),
};

/** Seed `LEGP_*` EUR-level history (insert-missing). An FX-outage date is dropped for ALL legs, never per-leg.
 *  Deepening a seeded leg (new `LEG_BACKFILL_YEARS` row) owes `--reshadow-all=<id>`, which also deletes stored dates the new chain lacks
 *  — refused (throws, that leg unwritten) when the fetch looks truncated, as `backfillHistory`'s restate prune. */
export async function backfillLegs(
  store: Store,
  deps: LegsBackfillDeps,
  opts: { years?: number; probe?: number; now?: Date; reshadowAll?: readonly string[] } = {},
): Promise<PensionBackfillResult> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? DEEP_PROBE;
  const runAt = now.toISOString();
  // Per-leg depth: the shared default, deepened by a `LEG_BACKFILL_YEARS` row (LEGP_EUFIN) or by a proxy's join.
  const legYears = (id: string): number => Math.max(opts.years ?? BACKFILL_YEARS, LEG_BACKFILL_YEARS[id] ?? 0);
  const legCutoff = (id: string): string => {
    const proxy = legProxy(id);
    const byYears = isoCutoff(now, legYears(id));
    return proxy === undefined ? byYears : minIso(byYears, isoCutoff(new Date(`${proxy.until}T00:00:00Z`), LEG_PROXY_SEED_YEARS));
  };
  const plusSlack = (iso: string): string => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + LEG_DEPTH_SLACK_DAYS * 86_400_000));

  // ONE plan across all LEGP_* ids (off-ladder included): any unseeded or shallow leg forces the full fetch.
  const legIds = [...LADDER.map((sleeve) => legCloseId(sleeve)), ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId)];
  const reshadowAll = reshadowAllSet(opts.reshadowAll, legIds, "leg");
  // Any reshadow-all id forces FULL for the whole pass — the chain builder needs the entire history.
  const anyReshadow = legIds.some((id) => reshadowAll.has(id));
  const revises = legIds.some((id) => !SKIP_SAFE_IDS.has(id));
  // DEPTH, not just recency: a leg with no row at/before `cutoff + LEG_DEPTH_SLACK_DAYS` is shallow ⇒ full.
  // One probe per distinct cutoff — a shallower floor says nothing about a deeper leg.
  const byCutoff = new Map<string, string[]>();
  for (const id of legIds) byCutoff.set(legCutoff(id), [...(byCutoff.get(legCutoff(id)) ?? []), id]);
  const probes = await Promise.all(
    [...byCutoff].map(async ([cutoff, ids]) => {
      const deep = await store.getSeriesBulk(ids, { limit: 1, range: { to: plusSlack(cutoff) } });
      return ids.filter((id) => (deep.get(id) ?? []).length === 0);
    }),
  );
  const shallow = legIds.filter((id) => probes.some((s) => s.includes(id)));
  const plan: FetchPlan =
    anyReshadow || shallow.length > 0
      ? { mode: "full" }
      : planFetch(await latestStoredDate(store, legIds), RAW_WARMUP_DAYS, now, revises);
  if (plan.mode === "skip") return { inserted: 0, perLeg: Object.fromEntries(legIds.map((id) => [id, 0])) };
  const reshadowTailDays = reshadowDays(plan);

  // Announce the tier (incremental vs FULL) — the row-count summary alone can't tell them apart.
  console.log(
    plan.mode === "since"
      ? `[backfill] legs: incremental fetch — tail since ${plan.sinceDate}, not a full history pull`
      : // NOT "nothing stored yet": ANY unseeded or shallow id lands here, so eight fully-stored
        // legs plus one newly-added sleeve does too.
        `[backfill] legs: FULL history fetch (${anyReshadow ? "--reshadow-all" : `shallow: ${shallow.join(",")}`}) — deep pull, expected once`,
  );

  const ladderTickers = [...new Set(Object.values(LEG_TICKER).map((l) => l.ticker))];
  // Each ticker trims at the DEEPEST cutoff of the legs it prices (EXSH.DE → LEGP_EUFIN's deeper row).
  const tickerLegs: [string, string][] = [
    ...LADDER.map((sleeve): [string, string] => [LEG_TICKER[sleeve].ticker, legCloseId(sleeve)]),
    ...OFF_LADDER_LEG_KEYS.map((leg): [string, string] => [OFF_LADDER_LEG_TICKER[leg].ticker, offLadderLegCloseId(leg)]),
  ];
  const tickerCutoff = (t: string): string =>
    tickerLegs.filter(([tk]) => tk === t).map(([, id]) => legCutoff(id)).reduce(minIso);
  // Off-ladder tickers fetch in an ISOLATED arm — a rejected feed must not abort the ladder legs' seed.
  const offLadderTickers = [...new Set(Object.values(OFF_LADDER_LEG_TICKER).map((l) => l.ticker))].filter(
    (t) => !ladderTickers.includes(t),
  );
  // A leg's pre-join proxy (`LegQuote.proxy`) fetches only when its window reaches before `until`; trimmed to [cutoff, until].
  const proxies = legCloseQuotes().flatMap(([id, q]) =>
    q.proxy !== undefined && legCutoff(id) < q.proxy.until && (plan.mode === "full" || plan.sinceDate < q.proxy.until)
      ? [{ ticker: q.proxy.ticker, cutoff: legCutoff(id), until: q.proxy.until }]
      : [],
  );
  const [fx, ...ladderCloses] = await Promise.all([
    // FX leg sized by the SAME plan-driven window as the leg tickers.
    deps.fetchPrices("EURUSD=X", priceOpts(plan)),
    ...ladderTickers.map((t) => deps.fetchPrices(t, priceOpts(plan)).then((o) => trim(o, tickerCutoff(t)))),
    ...proxies.map((p) => deps.fetchPrices(p.ticker, priceOpts(plan)).then((o) => trim(o, p.cutoff).filter((x) => x.date <= p.until))),
  ]);
  // A rejected off-ladder fetch yields [] for that ticker (one warn line) — no LEGP_COMMOD row this run.
  const offLadderCloses = await Promise.all(
    offLadderTickers.map(async (t) => {
      try {
        return trim(await deps.fetchPrices(t, priceOpts(plan)), tickerCutoff(t));
      } catch (err) {
        console.warn(`[backfill] legs: off-ladder ${t} feed non-live this run: ${err instanceof Error ? err.message : String(err)}`);
        return [] as Observation[];
      }
    }),
  );
  const byTicker: Record<string, Observation[]> = Object.fromEntries([
    ...ladderTickers.map((t, i) => [t, ladderCloses[i] ?? []]),
    ...proxies.map((p, i) => [p.ticker, ladderCloses[ladderTickers.length + i] ?? []]),
    ...offLadderTickers.map((t, i) => [t, offLadderCloses[i] ?? []]),
  ]);

  // Every date any leg traded, oldest→newest — the replay axis.
  const dates = [...new Set(Object.values(byTicker).flatMap((obs) => obs.map((o) => o.date)))].sort();
  // ALL-OR-NOTHING FX skip: a date with no usable EURUSD rate is dropped for every leg, never per-leg.
  const fxUsableAt = (d: string): boolean => (fx ?? []).some((o) => o.date <= d && o.value > 0);
  const usableDates = dates.filter(fxUsableAt);
  const skipped = dates.length - usableDates.length;
  if (skipped > 0) console.log(`[backfill] legs: skipped ${skipped} date(s) with no usable EURUSD rate`);
  // Fold through the SHARED chain builder from a seed base (empty `prior`) — ONE EUR-conversion path.
  const allRows = [
    ...legCloseReadingRows(byTicker, fx ?? [], usableDates, new Map()),
    ...offLadderLegCloseReadingRows(byTicker, fx ?? [], usableDates, new Map()),
  ];
  const rowsById = new Map<string, StoredReading[]>();
  for (const r of allRows) {
    const bucket = rowsById.get(r.indicatorId);
    if (bucket) bucket.push(r);
    else rowsById.set(r.indicatorId, [r]);
  }

  const perLeg: Record<string, number> = {};
  let inserted = 0;
  const refused: string[] = [];
  for (const id of legIds) {
    // A leg never stores deeper than its OWN cutoff, even where the shared date axis reaches further.
    const rows = (rowsById.get(id) ?? []).filter((r) => r.date >= legCutoff(id));
    const stored = await store.getSeries(id, probe);
    const last = rows.at(-1)?.date;
    if (reshadowAll.has(id) && last !== undefined) {
      // A reshadow owns the full history: drop stored dates the new chain does not produce (old calendar, old prefix).
      const keep = new Set(rows.map((r) => r.date));
      const stale = stored.map((p) => p.date).filter((d) => d <= last && !keep.has(d));
      // Truncation guard (`backfillHistory`'s): a chain starting past its cutoff may not delete a large share.
      const first = rows[0]!.date;
      if (first > plusSlack(legCutoff(id)) && stale.length > stored.length * PRE_FIRST_PRUNE_MAX_SHARE) {
        refused.push(
          `[backfill] legs: ${id}: refusing reshadow delete — ${stale.length} of ${stored.length} stored rows absent from a chain starting ${first} (cutoff ${legCutoff(id)}, > ${PRE_FIRST_PRUNE_MAX_SHARE * 100}%); the fetch looks truncated`,
        );
        perLeg[id] = 0;
        continue;
      }
      if (stale.length > 0) console.log(`[backfill] legs: ${id}: deleted ${await store.deleteReadingsOnDates(id, stale)} stale row(s) on ${stale.length} date(s)`);
    }
    const existing = finalDates(stored, id);
    const missing = writeSet(rows, existing, now, reshadowTailDays, reshadowAll.has(id));
    if (missing.length > 0) await store.recordReadings(missing, runAt);
    perLeg[id] = missing.length;
    inserted += missing.length;
  }
  if (refused.length > 0) throw new Error(refused.join("\n"));
  return { inserted, perLeg };
}

/** specs() builds UNTRIMMED readings — only `backfillAll` trims readings; a `trim(` here shapes a FEED.
 *  Coverage is THIS table, not ALL_INDICATORS: a scored indicator missing here gets cron-only history. */
/** A non-skip fetch plan threaded into a spec's `build` — bounds each shrinkable feed's window. */
type Win = Exclude<FetchPlan, { mode: "skip" }>;

/** Resolve cuts EXACTLY as the notify path (`scoreWithCuts`): `synthesizedCalib`, then `resolveCuts`. */
type CutsFor = (ind: Indicator) => CalibrationCuts;

type Spec = {
  id: string;
  // `estimateDates`: never FINAL (ECY).
  build: (win: Win) => Promise<Reading[] | { series: Reading[]; estimateDates: string[] }>;
  warmupDays?: number;
  // The cron's scoring-base start when deeper than the policy floors (CG: `CG_LEVEL_ANCHOR`): trim, re-shadow and prune floor.
  baseFloor?: string;
};

function specs(
  deps: BackfillDeps,
  cutoff: string,
  now: Date,
  cutsFor: CutsFor,
  // The stored vintage — the per-day synth scorer re-resolves cuts per date.
  vintage: ReadonlyArray<CalibrationParam> = [],
): Spec[] {
  // Feed trim at `cutoff − warmupDays`, NEVER the bare cutoff — a bare trim burns the scorer's warmup
  // inside the served span (reference.md §[arch] 9).
  const feedCutoff = (id: string, warmupDays: number): string =>
    isoDaysBefore(new Date(`${backfillCutoffFor(id, cutoff, now)}T00:00:00Z`), warmupDays);
  // Only a `full` plan lays archived closes (fred-archive.ts) beneath a clamped feed.
  const fredObs = (id: string, series: string, win: Win, warmupDays = SCORED_WARMUP_DAYS): Promise<Observation[]> =>
    deps
      .fetchFred(series, fredOpts(win))
      .then((o) => trim(win.mode === "full" ? withFredArchive(series, o) : o, feedCutoff(id, warmupDays)));
  // ⛔ Dispatch on `FEED_OF`, never `fetchFred` alone; cooldown carriers fetch deep and UNTRIMMED; velocitySigma
  // ids warm up at `velocitySigmaLookbackDays`. Falsifier: scripts/backfill.depth-parity.test.ts.
  const sigmaWarmupDays = (ind: Indicator): number | undefined => {
    const d = velocitySigmaLookbackDays(ind);
    return d === undefined ? undefined : Math.max(d, SCORED_WARMUP_DAYS);
  };
  const indObs = (ind: Indicator, win: Win): Promise<Observation[]> =>
    FEED_OF[ind.id] === "ntfs"
      ? deps.fetchNtfs() // full history by construction (gsw.ts) — a restated R8 pulls NTFS, never the FRED arm
      : FEED_OF[ind.id] === "prices"
        ? price(ind.series, win)
        : ind.postInversionCooldown !== undefined
          ? deps.fetchFred(ind.series, { fullHistory: true })
          : fredObs(ind.id, ind.series, win, sigmaWarmupDays(ind));
  // Short (3m) leg for the rung carriers — FULL history regardless of `win`; one fetch shared by all carriers.
  const shortLegCache = new Map<string, Promise<Observation[]>>();
  const shortLegFor = (ind: Indicator): Promise<Observation[]> | undefined => {
    const cfg = ind.postInversionCooldown;
    if (cfg === undefined) return undefined;
    let p = shortLegCache.get(cfg.shortLegSeries);
    if (p === undefined) {
      p = deps.fetchFred(cfg.shortLegSeries, { fullHistory: true });
      shortLegCache.set(cfg.shortLegSeries, p);
    }
    return p;
  };
  // Stamp `Reading.bandCuts` as the cron's `scoreWithCutsSeries` does; a synth id stamps its per-day cut.
  const fred = (ind: Indicator) => async (win: Win): Promise<Reading[]> => {
    // ⛔ A synth id (F3) reads the FULL-plan feed on every plan: its expanding pool floors at the first
    // EMITTED date, so a `since` feed shifts every cut. Falsifier: scripts/backfill.depth-parity.test.ts.
    const synth = SYNTH_PRIOR_IDS.includes(ind.id);
    const [obs, shortLeg] = await Promise.all([indObs(ind, synth ? { mode: "full" } : win), shortLegFor(ind)]);
    if (synth) return scoreWithCutsSeriesPerDay(ind, obs, vintage, shortLeg);
    const cuts = cutsFor(ind);
    const bandCuts = bandCutsUsed(cuts);
    return indicatorReadingSeries(ind, obs, cuts, undefined, shortLeg).map((r) => ({ ...r, bandCuts }));
  };
  // UNTRIMMED feed — `backfillAll`'s central reading-trim caps the output.
  const price = (symbol: string, win: Win): Promise<Observation[]> =>
    deps.fetchPrices(symbol, priceOpts(win));
  // HCX ONLY: plan-independent closes (`HCX_FETCH_OPTS`) — its basket index anchors at the feed's left edge on every plan.
  const hcxPrice = (symbol: string): Promise<Observation[]> => deps.fetchPrices(symbol, HCX_FETCH_OPTS);
  // Explicit-start feeds resolve through `backfillSinceDate` — never a locally re-derived window.
  const euCurveSince = backfillSinceDate(EURC.id, now);
  const epathSince = backfillSinceDate(EPATH.id, now);
  const bundFeedFloor = curveFeedSince("BUND", now); // led in by `bundLegHead`, so leg (c) scores the first stored row
  const bonosSince = backfillSinceDate(BONOS.id, now);
  const bonosFeedSince = specCutoff(BONOS.id, bonosSince, now);
  const isoToday = isoDay(now);
  const estrSince = backfillSinceDate(ESTR.id, now);
  const ecissSince = backfillSinceDate(ECISS.id, now);
  const eurgbpSince = backfillSinceDate(EURGBP.id, now);
  // ONE sovereign-quote pull per symbol at the deepest consumer bound (`sovereignFeedSince`), re-sliced per consumer; TARGET holidays dropped.
  const sovereignSince = sovereignFeedSince(now);
  const sovereignP = new Map<string, Promise<Observation[]>>();
  const sovereign = async (symbol: string, since: string): Promise<Observation[]> => {
    if (!sovereignP.has(symbol)) sovereignP.set(symbol, deps.fetchSovereignDaily(symbol, sovereignSince, isoToday).then(dropTargetHolidays));
    return trim(await sovereignP.get(symbol)!, since);
  };
  return [
    // FRED core (F1,F2,R1–R5) — geo-hybrid and smoothed-level ids excluded, re-added below with their own builders.
    ...INDICATORS.filter((ind) => !GEO_HYBRID_DESCRIPTOR_OF[ind.id] && !SMOOTHED_LEVEL_OF[ind.id]).map((ind) => ({
      id: ind.id,
      build: fred(ind),
      ...(sigmaWarmupDays(ind) !== undefined && { warmupDays: sigmaWarmupDays(ind) }),
    })),
    // Smoothed-level ids (R8): `smoothedLevelReadingSeries`, never the generic `fred(ind)` builder.
    ...INDICATORS.filter((ind) => SMOOTHED_LEVEL_OF[ind.id]).map((ind) => ({
      id: ind.id,
      build: async (win: Win): Promise<Reading[]> =>
        smoothedLevelReadingSeries(ind, await indObs(ind, win), SMOOTHED_LEVEL_OF[ind.id]!.window, await shortLegFor(ind), SMOOTHED_LEVEL_OF[ind.id]!.redWindow),
    })),
    // Geo-hybrid ids (OVX): `oilReadingSeries` via `indObs` (FEED_OF dispatch), never bare `fredObs`.
    ...INDICATORS.filter((ind) => GEO_HYBRID_DESCRIPTOR_OF[ind.id]).map((ind) => ({
      id: ind.id,
      build: async (win: Win): Promise<Reading[]> => oilReadingSeries(ind, await indObs(ind, win)),
    })),
    // EBP confirmer (monthly, naturally deep; its own keyless feed).
    {
      id: EBP.id,
      build: async (): Promise<Reading[]> =>
        indicatorReadingSeries(EBP, await deps.fetchEbp(), cutsFor(EBP)),
    },
    // HICP Δ6m (monthly) — the cron's full-history `hicpDelta6m` + generic fold; default depth via the central trim.
    {
      id: HICP.id,
      build: async (): Promise<Reading[]> =>
        indicatorReadingSeries(HICP, hicpDelta6m(await deps.fetchFred(HICP_SERIES, { fullHistory: true })), cutsFor(HICP)),
    },
    // G1 oil shock — `oilReadingSeries`; `warmupDays` covers the trailing-peak gate (a shorter warmup degrades it).
    {
      id: G1.id,
      warmupDays: OIL_LEVEL_LOOKBACK_DAYS,
      build: async (win): Promise<Reading[]> => oilReadingSeries(G1, await fredObs(G1.id, G1.series, win, OIL_LEVEL_LOOKBACK_DAYS)),
    },
    // BRENT — the SAME merged `oilReadingSeries` the live scoreOil folds.
    {
      id: BRENT.id,
      warmupDays: OIL_LEVEL_LOOKBACK_DAYS,
      build: async (win): Promise<Reading[]> => oilReadingSeries(BRENT, await fredObs(BRENT.id, BRENT.series, win, OIL_LEVEL_LOOKBACK_DAYS)),
    },
    // NG Henry Hub (DHHNGSP) — `oilReadingSeries` + `warmupDays`, like G1/BRENT.
    {
      id: NG.id,
      warmupDays: OIL_LEVEL_LOOKBACK_DAYS,
      build: async (win): Promise<Reading[]> => oilReadingSeries(NG, await fredObs(NG.id, NG.series, win, OIL_LEVEL_LOOKBACK_DAYS)),
    },
    // R7 — WINDOW-IGNORING, seed↔cron parity: each leg takes the cron's own bound (`r7LegLoopDeep`/`deepArmSince`), never `win`.
    {
      id: R7.id,
      build: async (): Promise<Reading[]> => {
        const leg = (id: (typeof R7_LEG_IDS)[number], series: string) =>
          deps.fetchFred(series, r7LegLoopDeep(id) ? { fullHistory: true } : { since: deepArmSince(now) });
        return bullSteepenerReadingSeries(R7, await leg("R1", "T10Y3M"), await leg("R3", "DGS2"), await leg("R2", "DGS10"));
      },
    },
    // Price indicators — SMH+NVDA (semis), QQQ+QQQE (breadth), NVDA gate (CONTEXT).
    { id: F4.id, build: async (win): Promise<Reading[]> => semisReadingSeries(F4, await price("SMH", win), await price("NVDA", win)) },
    // `warmupDays` = the live deep depth: the shared 420 sits below `BREADTH_MIN_CLOSES`, so an incremental plan emits no ranked day.
    { id: F5.id, warmupDays: BREADTH_LOOKBACK_DAYS, build: async (win): Promise<Reading[]> => breadthReadingSeries(F5, await price("QQQ", win), await price("QQQE", win)) },
    // SPCONC SPY/RSP — same builder + symbols as the live scorer.
    { id: SPCONC.id, warmupDays: BREADTH_LOOKBACK_DAYS, build: async (win): Promise<Reading[]> => breadthReadingSeries(SPCONC, await price("SPY", win), await price("RSP", win)) },
    { id: NVDA.id, build: async (win): Promise<Reading[]> => nvdaGateReadingSeries(NVDA, await price("NVDA", win)) },
    // F6 semis rel-strength + F8 memory-cycle — same builders + symbols as the daily scorers.
    { id: F6.id, build: async (win): Promise<Reading[]> => relStrengthBreakReadingSeries(F6, await price("SMH", win), await price("SPY", win)) },
    // KBE_RS bank-equity rel-strength — same builder + symbols as its PRICE_SCORERS row.
    { id: KBE_RS.id, build: async (win): Promise<Reading[]> => relStrengthBreakReadingSeries(KBE_RS, await price("KBE", win), await price("SPY", win)) },
    // INS_RS European-insurer rel-strength — same builder + deep symbols as its PRICE_SCORERS row (EXH5.DE ÷ EXSA.DE).
    { id: INS_RS.id, build: async (win): Promise<Reading[]> => relStrengthBreakReadingSeries(INS_RS, await price("EXH5.DE", win), await price("EXSA.DE", win)) },
    // EXSH_GATE EU-Fin 3-check re-entry gate — same builder + deep symbols as its PRICE_SCORERS row (EXSH.DE ÷ EXSA.DE).
    { id: EXSH_GATE.id, build: async (win): Promise<Reading[]> => exshGateReadingSeries(EXSH_GATE, await price("EXSH.DE", win), await price("EXSA.DE", win)) },
    // AT1 bank sub-credit proxy — same builder + deep symbols as its PRICE_SCORERS row (XAT1.DE ÷ EXHA.DE).
    { id: AT1.id, build: async (win): Promise<Reading[]> => relStrengthBreakReadingSeries(AT1, await price("XAT1.DE", win), await price("EXHA.DE", win)) },
    // MU_RS Micron rel-strength — same builder + deep symbols as its PRICE_SCORERS row (MU ÷ SMH).
    { id: MU_RS.id, build: async (win): Promise<Reading[]> => relStrengthBreakReadingSeries(MU_RS, await price("MU", win), await price("SMH", win)) },
    // JPT Japan trend — same builder + symbol as its PRICE_SCORERS row (1306.T).
    { id: JPT.id, build: async (win): Promise<Reading[]> => globalTrendReadingSeries(JPT, await price("1306.T", win)) },
    { id: F8.id, build: async (win): Promise<Reading[]> => memGateReadingSeries(F8, await price("MU", win)) },
    // F13 HYG/LQD credit appetite — same builder + symbols as the live scoreCreditAppetite.
    { id: F13.id, build: async (win): Promise<Reading[]> => creditAppetiteReadingSeries(F13, await price("HYG", win), await price("LQD", win)) },
    // R6 MOVE — `moveReadingSeries`, never `indicatorReadingSeries`. Feeds `{ deep: true }` UNCONDITIONALLY:
    // a `since` plan falls short of `moveLegBase()` and scores nothing.
    {
      id: R6.id,
      build: async (): Promise<Reading[]> => moveReadingSeries(R6, await deps.fetchPrices("^MOVE", { deep: true })),
    },
    // CG copper/gold — the cron's `cgPoints`/`cgRows` over a deep fetch to `CG_LEVEL_ANCHOR`, which `baseFloor` keeps stored.
    {
      id: CG.id,
      baseFloor: CG_LEVEL_ANCHOR,
      build: async (): Promise<Reading[]> =>
        cgRows(
          CG,
          cgPoints(
            await deps.fetchPrices("HG=F", { deep: true, lookbackDays: cgLookbackDays(now) }),
            await deps.fetchPrices("GC=F", { deep: true, lookbackDays: cgLookbackDays(now) }),
          ),
        ),
    },
    // VT VIX÷VIX3M — ids from `vix_term.ts`'s `VIX_SYMBOL`/`VIX3M_SYMBOL`, never literals; raw legs seed in `backfillBottom`.
    {
      id: VT.id,
      build: async (win): Promise<Reading[]> =>
        ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, await fredObs(VT.id, VIX_SYMBOL, win), await fredObs(VT.id, VIX3M_SYMBOL, win)),
    },
    // VTP backwardation streak — `vixTermPersistenceReadingSeries`; warmup must exceed VT_STREAK_RED or a
    // `since` plan truncates the running count.
    {
      id: VTP.id,
      build: async (win): Promise<Reading[]> =>
        vixTermPersistenceReadingSeries(VTP, await fredObs(VTP.id, VIX_SYMBOL, win), await fredObs(VTP.id, VIX3M_SYMBOL, win)),
    },
    // VXNT VXNCLS ÷ (VXVCLS × k) — same leg ids as VT plus VXNCLS; deeper warmup for the k window.
    {
      id: VXNT.id,
      build: async (win): Promise<Reading[]> =>
        vxnTermReadingSeries(
          VXNT,
          await fredObs(VXNT.id, VXNCLS.series, win, VXNT_WARMUP_DAYS),
          await fredObs(VXNT.id, VIX_SYMBOL, win, VXNT_WARMUP_DAYS),
          await fredObs(VXNT.id, VIX3M_SYMBOL, win, VXNT_WARMUP_DAYS),
        ),
    },
    // ESTR (ECB overnight rate) — the SAME `derivedReadingSeries` the cron's `scoreDerived` folds; ⛔ never
    // `indicatorReadingSeries` (`thresholds: {}` ⇒ GREEN forever). Untrimmed: the central trim caps it.
    {
      id: ESTR.id,
      build: async (): Promise<Reading[]> =>
        derivedReadingSeries(ESTR, await deps.fetchEcb("ESTR", { startPeriod: estrSince })),
    },
    // ECISS — same ecb.ts feed + indicatorReadingSeries as the cron.
    {
      id: ECISS.id,
      build: async (): Promise<Reading[]> =>
        indicatorReadingSeries(
          ECISS,
          trim(await deps.fetchEcb("ECISS", { startPeriod: ecissSince }), backfillCutoffFor(ECISS.id, cutoff, now)),
          cutsFor(ECISS),
        ),
    },
    // EURGBP — same ecb.ts feed + returnOrMaSpreadReadingSeries as the cron.
    {
      id: EURGBP.id,
      build: async (): Promise<Reading[]> =>
        returnOrMaSpreadReadingSeries(
          EURGBP,
          trim(await deps.fetchEcb("EURGBP", { startPeriod: eurgbpSince }), backfillCutoffFor(EURGBP.id, cutoff, now)),
        ),
    },
    // CQS Baa−Aaa bridge — `creditBridgeReadingSeries` over BAA10Y + AAA10Y + EBP (unwindowed).
    {
      id: CQS.id,
      build: async (win: Win): Promise<Reading[]> =>
        creditBridgeReadingSeries(
          CQS,
          await fredObs(CQS.id, CQS.series, win),
          await fredObs(CQS.id, "AAA10Y", win),
          await deps.fetchEbp(),
        ),
    },
    // ECY — FULL plan-independent feeds (history-anchored rank); the DFII10 second fetch is pinned at 2
    // by backfill.jobs.test.ts.
    {
      id: ECY.id,
      build: async () => ecyRows(ECY, await deps.fetchCape(), await deps.fetchFred("DFII10", { fullHistory: true })),
    },
    { id: CCC.id, build: fred(CCC) },
    { id: VXNCLS.id, build: fred(VXNCLS) },
    { id: T10Y3M_RAW.id, build: fred(T10Y3M_RAW) },
    { id: VXSMH.id, build: fred(VXSMH) },
    {
      id: EURC.id,
      build: async (): Promise<Reading[]> =>
        ratioSpreadReadingSeries(
          EURC,
          EURC_DESCRIPTOR,
          await deps.fetchEcb("SR_10Y", { startPeriod: euCurveSince }),
          await deps.fetchEcb("SR_3M", { startPeriod: euCurveSince }),
        ),
    },
    // EPATH (SR_1Y − ESTR, meaned) — the SAME ratioSpreadReadingSeries the cron folds (EURC template).
    {
      id: EPATH.id,
      build: async (): Promise<Reading[]> =>
        ratioSpreadReadingSeries(
          EPATH,
          EPATH_DESCRIPTOR,
          await deps.fetchEcb("SR_1Y", { startPeriod: epathSince }),
          await deps.fetchEcb("ESTR", { startPeriod: epathSince }),
        ),
    },
    // BUND (Bund 10y−2y) — the live `curveReadingSeries` off the shared sovereign-quote pulls.
    {
      id: BUND.id,
      build: async (): Promise<Reading[]> =>
        curveReadingSeries(
          BUND,
          BUND_DESCRIPTOR,
          // Slice at the FEED floor, never the shared `cutoff`; readings trim centrally.
          await sovereign("DE10Y-DE", bundFeedFloor),
          await sovereign("DE2Y-DE", bundFeedFloor),
        ),
    },
    // BONOS (ES−DE 10y, bp) — off the shared sovereign-quote pulls.
    {
      id: BONOS.id,
      build: async (): Promise<Reading[]> =>
        bonosSpreadReadingSeries(BONOS, await sovereign("ES10Y-ES", bonosFeedSince), await sovereign("DE10Y-DE", bonosFeedSince)),
    },
    // FXH — worst-of-3 FX haven via `fxHavenReadingSeries`, same pairs as the live scoreFxHaven.
    {
      id: FXH.id,
      build: async (win): Promise<Reading[]> =>
        fxHavenReadingSeries(
          FXH,
          await price("EURUSD=X", win),
          await price("CHF=X", win),
          await price("JPY=X", win),
        ),
    },
    // GT global trend (ACWI MA200 spread) — price-fed like F4/F5 via the memoized price() helper.
    { id: GT.id, build: async (win): Promise<Reading[]> => globalTrendReadingSeries(GT, await price("ACWI", win)) },
    // GB global breadth over GB_SYMBOLS; short-history legs self-drop.
    {
      id: GB.id,
      build: async (win): Promise<Reading[]> => {
        const bySymbol: Record<string, Observation[]> = {};
        for (const s of GB_SYMBOLS) bySymbol[s] = await price(s, win);
        return globalBreadthReadingSeries(GB, bySymbol);
      },
    },
    // DISP — SPY/FEZ/EEM via `dispersionReadingSeries`, same symbols as the live scoreDispersion.
    {
      id: DISP.id,
      build: async (win): Promise<Reading[]> =>
        dispersionReadingSeries(DISP, await price("SPY", win), await price("FEZ", win), await price("EEM", win)),
    },
    // HCX — equal-weight basket of HCX_SYMBOLS ÷ SPY via `hcxPrice` (ignores `win`).
    {
      id: HCX.id,
      build: async (): Promise<Reading[]> => {
        const bySymbol: Record<string, Observation[]> = {};
        for (const sym of HCX_SYMBOLS) bySymbol[sym] = await hcxPrice(sym);
        return breadthReadingSeries(HCX, hcxBasketSeries(bySymbol), await hcxPrice("SPY"));
      },
    },
    // FDX TSM/SMH — the live `ratioVsMaReadingSeries`.
    {
      id: FDX.id,
      build: async (win): Promise<Reading[]> =>
        ratioVsMaReadingSeries(FDX, await price("TSM", win), await price("SMH", win)),
    },
  ];
}

/** `--restate` roster: `specs()` ids ∪ detector legs — derived by import, never a hand list (the pin test
 *  asserts the union). Consumed by scripts/probe-vintage-drift.ts. */
export function restatableIds(): string[] {
  const specIds = specRoster().map((s) => s.id);
  const detectorIds = [...DOWNSIDE_DETECTORS.map((d) => d.indicator.id), ...RS_LEGS.map((l) => l.indicator.id)];
  return [...new Set([...specIds, ...detectorIds])];
}

/** The `specs()` roster (id + `warmupDays`), enumerated IO-free under thrower deps — detector legs excluded. */
export function specRoster(): { id: string; warmupDays?: number }[] {
  const boom = (name: string) => (): never => {
    throw new Error(`specRoster: specs() invoked ${name} at construction time — the id roster is no longer IO-free`);
  };
  const deps: BackfillDeps = {
    fetchFred: boom("fetchFred"),
    fetchEbp: boom("fetchEbp"),
    fetchEcb: boom("fetchEcb"),
    fetchPrices: boom("fetchPrices"),
    fetchSovereignDaily: boom("fetchSovereignDaily"),
    fetchCape: boom("fetchCape"),
    fetchNtfs: boom("fetchNtfs"),
  };
  return specs(deps, "1970-01-01", new Date(0), boom("cutsFor"), []).map(({ id, warmupDays }) =>
    warmupDays === undefined ? { id } : { id, warmupDays },
  );
}

/** Seed every spec; per-indicator try/catch — the CLI must exit non-zero when `failures` is non-empty. */
export async function backfillAll(
  store: Store,
  deps: BackfillDeps,
  opts: {
    years?: number;
    probe?: number;
    now?: Date;
    restate?: readonly string[];
    only?: readonly string[];
    // `--deepen`: force `full` for these ids (or "all") — insert-missing only; the sole re-deepen path.
    deepen?: readonly string[] | "all";
    // `backfillHistory`'s run_at seam (default: wall clock). Within one estimated/FINAL class a re-shadow beats the stored row
    // only at run_at ≥ its own (`pickRecent`), so a test
    // re-running over one store injects a strictly-increasing clock — a wall clock stepping back under load reds it.
    clock?: Clock;
  } = {},
): Promise<BackfillResult> {
  const years = opts.years ?? backfillTrimYears();
  const now = opts.now ?? new Date();
  const cutoff = isoCutoff(now, years);

  // Fetch each price symbol once per run, keeping the DEEPEST window — a shallower request reuses it.
  const priceCache = new Map<string, { lookback: number; p: Promise<Observation[]> }>();
  const memo: BackfillDeps = {
    ...deps,
    fetchPrices: (symbol, o) => {
      const want = o.deep ? (o.lookbackDays ?? DEEP_LOOKBACK_DAYS) : LOOKBACK_DAYS;
      const hit = priceCache.get(symbol);
      if (hit && hit.lookback >= want) return hit.p;
      const p = deps.fetchPrices(symbol, o);
      priceCache.set(symbol, { lookback: want, p });
      return p;
    },
  };
  // Every leg a spec's build fetched, reset per spec — its `estimateDatesOf` is the cron's `markEstimateSourced`.
  let fetched: Observation[][] = [];
  const tap = <A extends unknown[]>(f: (...a: A) => Promise<Observation[]>) => (...a: A) => f(...a).then((o) => (fetched.push(o), o));
  const seen: BackfillDeps = {
    fetchFred: tap(memo.fetchFred), fetchEbp: tap(memo.fetchEbp), fetchEcb: tap(memo.fetchEcb), fetchPrices: tap(memo.fetchPrices),
    fetchSovereignDaily: tap(memo.fetchSovereignDaily), fetchCape: tap(memo.fetchCape), fetchNtfs: tap(memo.fetchNtfs),
  };

  // LIVE-PARITY CUTS: `resolveCuts` over `synthesizedCalib`, exactly as `scoreWithCuts`; a store
  // failure degrades to an empty vintage rather than aborting.
  const vintage = await store.getCalibration().catch(() => []);
  const synthHistories = await loadSynthHistories(store);
  const cutsFor: CutsFor = (ind) =>
    resolveCuts(ind.id, synthesizedCalib(ind, vintage, synthHistories), ind.direction ?? "HIGH");

  const allSpecs = specs(seen, cutoff, now, cutsFor, vintage);
  // Fail LOUD on a typo'd `--restate` id — a no-op reporting success is the expensive failure.
  const knownIds = new Set(allSpecs.map((s) => s.id));
  const unknown = (opts.restate ?? []).filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`restate: unknown indicator id(s) ${unknown.join(", ")} — known: ${[...knownIds].join(", ")}`);
  }
  // Same fail-loud rule for `--deepen`.
  const deepenAll = opts.deepen === "all";
  const deepenSet = deepenAll || opts.deepen === undefined ? null : new Set(opts.deepen);
  const unknownDeepen = deepenSet ? [...deepenSet].filter((id) => !knownIds.has(id)) : [];
  if (unknownDeepen.length > 0) {
    throw new Error(`deepen: unknown indicator id(s) ${unknownDeepen.join(", ")} — known: ${[...knownIds].join(", ")}`);
  }
  // `only` narrows the PASS, never the validation above; empty ⇒ fail loud.
  const onlySet = opts.only === undefined ? null : new Set(opts.only);
  const specList = onlySet === null ? allSpecs : allSpecs.filter((s) => onlySet.has(s.id));
  if (specList.length === 0) {
    throw new Error(`only: no indicator spec matched ${[...(onlySet ?? [])].join(", ")} — known: ${[...knownIds].join(", ")}`);
  }
  const restate = new Set(opts.restate ?? []);
  // ONE bulk round-trip for every spec's newest stored date (each spec plans from its own edge).
  const newest = await store.getSeriesBulk(
    specList.map((s) => s.id),
    { limit: 1 },
  );

  const seeded: Record<string, number> = {};
  const failures: { id: string; error: string }[] = [];
  for (const spec of specList) {
    try {
      const maxDate = newest.get(spec.id)?.at(-1)?.date ?? null;
      // A restated or deepened id fetches `full` — the planner reads only the newest date, never the left edge.
      const deepen = deepenAll || (deepenSet?.has(spec.id) ?? false);
      const plan: FetchPlan = restate.has(spec.id) || deepen
        ? { mode: "full" }
        : // A spec whose deepest window outruns SCORED_WARMUP_DAYS declares its own (G1/BRENT's
          // trailing-peak level gate); everything else plans on the shared 420.
          planFetch(maxDate, spec.warmupDays ?? SCORED_WARMUP_DAYS, now, !SKIP_SAFE_IDS.has(spec.id));
      if (plan.mode === "skip") {
        seeded[spec.id] = 0;
        console.log(`[backfill] ${spec.id}: skipped (current)`);
        continue;
      }
      const rtd = reshadowDays(plan);
      // Per-id cutoff: an override depth (F3/CG/F7/…) trims at its own resolved bound; `trimFloor` is THE one reading-trim.
      const policy = backfillFloorsFor(spec.id, cutoff, now);
      const deeper = (f: string): string => (spec.baseFloor !== undefined && spec.baseFloor < f ? spec.baseFloor : f);
      const [idCutoff, trimFloor] = [deeper(policy.idCutoff), deeper(policy.trimFloor)];
      const idProbe = opts.probe ?? probeFor(trimFloor, now);
      // Restate floors the re-shadow at the trim cutoff.
      const reshadowFloor = restate.has(spec.id) ? idCutoff : rtd === undefined ? undefined : isoDaysBefore(now, rtd);
      fetched = [];
      const built = await spec.build(plan);
      const { series: builtSeries, estimateDates: ownEstimates } = Array.isArray(built) ? { series: built, estimateDates: [] } : built;
      const readings = trim(builtSeries, trimFloor);
      const asOf = isoDay(now);
      // Restate: a non-alert-run FINAL row on a spec's own estimate date is dropped, then rewritten `estimated`; estimates and alert-run
      // rows (`getReadingsForRun`'s snapshots) are kept, and a kept FINAL one HOLDS its date (`estHeld`; `backfillHistory` logs it).
      if (restate.has(spec.id) && ownEstimates.length > 0) await store.deleteNonEstimatesOnDates(spec.id, ownEstimates, true);
      const n = await backfillHistory(store, spec.id, readings, idProbe, opts.clock ?? wallClock, reshadowFloor, restate.has(spec.id), idCutoff, asOf, trimFloor, new Set([...estimateDatesOf(...fetched), ...ownEstimates]));
      seeded[spec.id] = n;
      console.log(`[backfill] ${spec.id}: ${n > 0 ? `seeded ${n} row(s)` : "already complete (0)"}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // No free source (a refused FRED id, an unfed port): skipped and logged, never a failure that aborts the run.
      if (isNoFreeSource(err)) {
        seeded[spec.id] = 0;
        console.log(`[backfill] ${spec.id}: skipped (no free source) - ${error}`);
        continue;
      }
      failures.push({ id: spec.id, error });
      console.error(`[backfill] ${spec.id}: FAILED — ${error}`);
    }
  }
  const total = Object.values(seeded).reduce((a, b) => a + b, 0);
  return { seeded, failures, total };
}
