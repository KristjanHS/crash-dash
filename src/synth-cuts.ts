/**
 * Stage 6.3 — THE shared entry point for the runtime-computed cuts of the `synthPriors`
 * ids — **the live set is F3 `NFCIRISK` alone** (`SYNTH_PRIOR_IDS`). F9 left 2026-08-08 and F11
 * 2026-08-09, both for a fixed cut on a rolling-σ z; the F9/F11 mentions below are historical, not
 * membership. F10 `BAMLEMCBPIOAS` was one until
 * 2026-07-18: its keyless FRED feed is server-truncated to a rolling ~3-year window, so the
 * convention is scoped to deep-history ids and F10 reverted to its registry priors
 * (`domain-cuts.ts` `CALIB_MAP`, the F10-is-absent block).
 *
 * Route = **Option B, runtime expanding percentile** (USER-ruled 2026-07-17, final).
 * A member ships hand-typed
 * `PRIORS — uncalibrated` bands in `registry.ts` and has NO harness vintage: nothing in
 * `calibration.json` covers them, and adding them to the Python harness was the route
 * (A/C) explicitly NOT taken. So their cuts are computed here, per run, from their own
 * stored history and injected as synthesized calibration rows via `withSynthesizedPriors`.
 *
 * **Cuts (ruled, do not re-open):**
 *  - level: 85th / 95th expanding-window empirical CDF of the series LEVEL.
 *  - velocity: 85th / 95th of `|Δ|` over the id's RESOLVED window — `SYNTH_VEL_WINDOW` (20) by
 *    default, or the entry's own `velocityWindow` (`registry.ts`), resolved at both
 *    call sites below so the percentile and the SCORED window can never diverge. The ABSOLUTE
 *    change, so a symmetric
 *    move in either direction counts toward the same tail (`classify` compares the velocity
 *    legs against a signed `delta20`, but the cut is a magnitude tail by construction).
 *
 * **Why `expandingPercentile` and not a plain full-sample `quantile`:** the house rule in
 * `calibration.json`'s own `notes` is that a cut is applied POINT-IN-TIME, never as a fixed
 * full-sample quantile. The live cut is the LAST element of the expanding series — the value
 * a run on the newest observation would have seen, computed strictly from PRE-t history, so
 * it carries no look-ahead and the same function can be replayed day-by-day.
 *
 * **Degrade (fail-safe direction, ruled):** below `PCT_MIN_OBS` (252) prior observations
 * `expandingPercentile` yields NaN. A NaN/absent cut is NOT acceptable — it would silently
 * WIDEN the band (the measured `evt` leg vanishes and only the strict-`>` convention leg
 * remains). So each leg independently falls back to the registry PRIOR. Never the reverse
 * direction: a thin history can only leave the band where it already was.
 *
 * **The prior used for fallback is `rawThresholds ?? thresholds`** — the PRE-earliness-
 * multiplier value. `resolveCuts` applies `m` to every measured leg via `scaleCuts`, so
 * feeding it the already-`m`-scaled `indicator.thresholds` (what 6.2b did) double-scales.
 * Computed cuts have the same property for free: they are a raw-series statistic.
 *
 * ⚠ **SPLIT-BRAIN GUARD — load-bearing.** Four sites resolve cuts against their own
 * `getCalibration()`: `run-dbfirst.ts` (the INDICATORS loop via `confirmers.scoreWithCuts`, plus the
 * fast-confirmer path), `api/series.ts` (`recomputedSeries`) and `api/indicators.ts`
 * (`provenance`). ALL of them must call `synthesizedCalib` with a
 * history loaded by `loadSynthHistories`, or `/lab` draws one cut while the phone fires
 * another. `api/indicators.test.ts` pins the notify ↔ `/api/indicators` agreement.
 *
 * ⚠ **A FIFTH caller exists, and the count is a trap:** `scripts/emit-synth-cuts.ts` also calls
 * `loadSynthHistories`. It is NOT a resolve site (read-only golden emitter), so it cannot
 * split-brain the band — but it MUST be regenerated in the same commit as any cut change, or
 * the committed golden silently describes the old cuts. Falsifier:
 * `grep -rn loadSynthHistories src/ api/ scripts/` returns 5, not 4.
 *
 * ⚠ Same-INPUTS also means same-POOL. `run-cycle-fred.ts` loads history BEFORE persisting the run's own
 * reading, while the API handlers read after — so the notify path APPENDS the run's newest
 * observation (`synthHistoriesInclusive`): its pool is `[…stored, today]`, exactly the pool the
 * handlers read post-persist and the pool a restate's per-day arm (`scoreWithCutsSeriesPerDay`)
 * holds on day i. Ruled [USER] 2026-09-02 — before it the cron was exclusive-by-one, a ~1e-4
 * split the 1e-9 parity probe flags on every cron-written row. Falsifier:
 * `npm run probe:band-cuts-parity -- --env=prod` after a cron run.
 */
import { expandingPercentile } from "./slow.js";
import { withSynthesizedPriors, hasSynthPriors, SYNTH_PRIOR_IDS, type CalibParamRow } from "./domain-cuts.js";
import type { Indicator, Observation, Thresholds } from "./domain-types.js";
// The empirical-CDF AMBER/RED percentile cuts are OWNED by `family-descriptor` (a value-leaf, and the
// locality-lint's home for tunables); re-exported here so every existing `synth-cuts` importer is unchanged.
import { SYNTH_AMBER_PCTILE, SYNTH_RED_PCTILE } from "./family-descriptor-rows.js";
import { isProvisional } from "./intraday.js";
export { SYNTH_AMBER_PCTILE, SYNTH_RED_PCTILE };
/** Velocity window — `|Δ20|`, matching `classify`'s `delta20` decision variable exactly. */
export const SYNTH_VEL_WINDOW = 20;
/**
 * How much stored history to pull per synth id. The deepest stored windows (the
 * `EXPANDING_PERCENTILE_PREFIX_YEARS` registry `backfill` depths, F3 weekly and CG daily ≈ 3,780 obs; the `BACKFILL_YEARS` default is far
 * shallower) are well under 5,000
 * observations, so 5,000 clears it with headroom so the percentile sees the whole
 * seeded window rather than a silently-truncated tail (a truncated window is not wrong,
 * but it would make the cut depend on this constant instead of on the data).
 *
 * At this limit `getSeriesBulk` fits ONE id per cap-sized RPC (`SERIES_BULK_MAX_ROWS`, `store.ts`), fired
 * concurrently. ⛔ Never shrink it to pack ids per call — F11's ~3,700 obs would TRUNCATE the live cut's window.
 */
export const SYNTH_HISTORY_LIMIT = 5000;

/** A store shaped just enough to load synth histories — keeps this module store-import-free. */
interface SynthHistorySource {
  getSeriesBulk(
    ids: string[],
    opts: { limit: number },
  ): Promise<Map<string, Array<{ date: string; value: number; runAt?: string }>>>;
}

/** Chronological level history per synth id (oldest→newest), as `computeSynthCuts` wants it. */
export type SynthHistories = ReadonlyMap<string, readonly number[]>;

/** The absolute 20-observation change series, index-aligned to `values` (first 20 omitted). */
function absDelta(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i < values.length; i++) out.push(Math.abs(values[i]! - values[i - window]!));
  return out;
}

/** Last element of the expanding percentile — the point-in-time cut for the newest obs. */
function liveCut(values: readonly number[], p: number): number | undefined {
  const v = expandingPercentile(values, p).at(-1);
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** Which legs fell back to the registry prior instead of resolving a real percentile. */
interface SynthDegradeFlags {
  amberLevel: boolean;
  redLevel: boolean;
  amberVelocity: boolean;
  redVelocity: boolean;
  /** True when ANY leg degraded — the honesty flag for a cut that is really the prior. */
  any: boolean;
}

/** `computeSynthCuts` plus the per-leg record of which legs are really the prior. */
interface SynthCutsResult {
  cuts: Thresholds;
  degraded: SynthDegradeFlags;
}

/** Which cut axes a registry prior actually defines — the LIVE axes for that id. */
interface SynthAxes {
  level: boolean;
  velocity: boolean;
}

/**
 * Derive the live axes from the registry prior itself (Stage 1 of the 6.4 plan).
 *
 * `resolveCuts` gates the velocity legs on `CALIB_MAP[id].legs.velocity`, so a synthesized
 * `evt_vel_*` row for a **level-only** id (`thresholds = { amberLevel, redLevel }`) is
 * emitted and never read — inert on its own, but `synthCutsDegraded` would still fold that
 * phantom axis' degrade flags into its `any`. On a thin history that reports `convention`
 * provenance for an id whose level cuts are genuinely measured and genuinely live: a real
 * (safe-direction) misreport, caused by 6.4 adding the first level-only synth id.
 *
 * Deriving from the prior rather than from `CALIB_MAP` keeps this module registry-shaped and
 * store-import-free; the two agree by construction (the prior IS what `resolveCuts` falls back
 * to). At the time of 6.4 both F9 and F11 defined both axes ⇒ every existing value was unchanged.
 * **Neither does now: F9's level axis was retired 2026-08-07 and F11's 2026-08-08**, so
 * `synthAxesFor` closes the level half — which is the intended mechanism, not a
 * regression: the registry prior IS the kill switch, and no `evt_level_*`/`operative_*` row is
 * emitted (pinned in `src/registry.test.ts` §"F9 velocity-only (level axis retired
 * 2026-08-07)" / §"F11 velocity-only (level axis retired 2026-08-08)"). ⚠ **F9 no longer reaches
 * this seam at all** — it left `synthPriors` 2026-08-08, so only F11 exercises the velocity-only
 * path here. F3 is the last synth id still carrying a level axis through this seam.
 */
export function synthAxesFor(prior: Thresholds): SynthAxes {
  return {
    level: prior.amberLevel !== undefined || prior.redLevel !== undefined,
    velocity: prior.amberVelocity !== undefined || prior.redVelocity !== undefined,
  };
}

/**
 * The pure math: expanding-percentile cuts over `history`, each leg independently falling
 * back to the matching `prior` field when the window is thinner than `PCT_MIN_OBS`.
 *
 * Returns the per-leg degrade flags alongside the cuts because **row presence cannot
 * recover them**: `withSynthesizedPriors` emits an `evt_*` row either way, so a consumer
 * looking only at the resolved cuts sees a "measured" EVT leg even when the number is the
 * hand-typed prior verbatim. The degrade is PER LEG and the two axes degrade at different
 * depths — the velocity array is `SYNTH_VEL_WINDOW` shorter than the level one, so a
 * 253–272-observation id computes real level cuts while both velocity cuts are priors.
 * Exported for the golden emitter, the provenance seam, and their tests — no IO, no store.
 *
 * **Leg-aware** (`synthAxesFor`): an axis the prior does not define is not computed and not
 * flagged — `undefined` cuts, `false` degrade flags — so `withSynthesizedPriors` emits no rows
 * for it and `degraded.any` never folds in a phantom axis.
 */
export function computeSynthCutsDetailed(
  history: readonly number[],
  prior: Thresholds,
  velWindow: number = SYNTH_VEL_WINDOW,
): SynthCutsResult {
  const axes = synthAxesFor(prior);
  // PER-LEG on velocity, not per-AXIS: an id may define `amberVelocity` WITHOUT `redVelocity`
  // (F3, R2's amber-only 4-week confirmer). Gating both velocity legs on the single
  // `axes.velocity` boolean would compute — and `withSynthesizedPriors` would then EMIT — an
  // `evt_vel_red` row from an unset prior, letting the velocity leg fire Red. Gate each leg on
  // its own prior field. Byte-identical for F11 (it defines both velocity legs).
  const wantAmberVel = prior.amberVelocity !== undefined;
  const wantRedVel = prior.redVelocity !== undefined;
  const vel = wantAmberVel || wantRedVel ? absDelta(history, velWindow) : [];
  const amberLevel = axes.level ? liveCut(history, SYNTH_AMBER_PCTILE) : undefined;
  const redLevel = axes.level ? liveCut(history, SYNTH_RED_PCTILE) : undefined;
  const amberVelocity = wantAmberVel ? liveCut(vel, SYNTH_AMBER_PCTILE) : undefined;
  const redVelocity = wantRedVel ? liveCut(vel, SYNTH_RED_PCTILE) : undefined;
  const degraded = {
    amberLevel: axes.level && amberLevel === undefined,
    redLevel: axes.level && redLevel === undefined,
    amberVelocity: wantAmberVel && amberVelocity === undefined,
    redVelocity: wantRedVel && redVelocity === undefined,
  };
  return {
    cuts: {
      ...prior,
      amberLevel: amberLevel ?? prior.amberLevel,
      redLevel: redLevel ?? prior.redLevel,
      amberVelocity: amberVelocity ?? prior.amberVelocity,
      redVelocity: redVelocity ?? prior.redVelocity,
    },
    degraded: { ...degraded, any: Object.values(degraded).some(Boolean) },
  };
}

/** The per-DATE expanding-percentile cut series for each defined leg. */
export interface SynthCutSeries {
  levelAmber?: number[];
  levelRed?: number[];
  amberVelocity?: number[];
  redVelocity?: number[];
}

/** Per-DATE expanding-percentile cut series per defined leg, index-aligned to `history` (velocity legs
 *  padded `velWindow` leading NaN); `series.at(-1)` == the `computeSynthCutsDetailed` live cut, an undefined leg draws no line. */
export function synthCutSeries(
  history: readonly number[],
  prior: Thresholds,
  velWindow: number = SYNTH_VEL_WINDOW,
): SynthCutSeries {
  const axes = synthAxesFor(prior);
  // PER-LEG velocity gate, mirroring `computeSynthCutsDetailed` exactly (F3 defines `amberVelocity`
  // WITHOUT `redVelocity`): an unset leg yields no series, so no phantom velocity-red line is drawn.
  const wantAmberVel = prior.amberVelocity !== undefined;
  const wantRedVel = prior.redVelocity !== undefined;
  const vel = wantAmberVel || wantRedVel ? absDelta(history, velWindow) : [];
  const pad = (s: number[]): number[] => [...new Array<number>(velWindow).fill(NaN), ...s];
  return {
    ...(axes.level ? { levelAmber: expandingPercentile(history, SYNTH_AMBER_PCTILE) } : {}),
    ...(axes.level ? { levelRed: expandingPercentile(history, SYNTH_RED_PCTILE) } : {}),
    ...(wantAmberVel ? { amberVelocity: pad(expandingPercentile(vel, SYNTH_AMBER_PCTILE)) } : {}),
    ...(wantRedVel ? { redVelocity: pad(expandingPercentile(vel, SYNTH_RED_PCTILE)) } : {}),
  };
}

/** Cuts-only view of `computeSynthCutsDetailed` — the shape every scoring site wants. @internal */
export function computeSynthCuts(
  history: readonly number[],
  prior: Thresholds,
  velWindow: number = SYNTH_VEL_WINDOW,
): Thresholds {
  return computeSynthCutsDetailed(history, prior, velWindow).cuts;
}

/** The PRE-earliness-multiplier registry bands — the fallback the degrade path injects. */
export function priorThresholds(indicator: Indicator): Thresholds {
  return indicator.rawThresholds ?? indicator.thresholds;
}

/**
 * THE call-site seam. Every `resolveCuts` site passes its vintage through this; for a
 * non-`synthPriors` id it is `withSynthesizedPriors`' identity (referential), so wiring it
 * everywhere costs nothing and a future synth id can never reach three sites and miss one.
 */
export function synthesizedCalib(
  indicator: Indicator,
  params: ReadonlyArray<CalibParamRow>,
  histories?: SynthHistories,
): ReadonlyArray<CalibParamRow> {
  if (!hasSynthPriors(indicator.id)) return params;
  const prior = priorThresholds(indicator);
  const history = histories?.get(indicator.id);
  return withSynthesizedPriors(
    indicator.id,
    history === undefined
      ? prior
      : computeSynthCuts(history, prior, indicator.velocityWindow ?? SYNTH_VEL_WINDOW),
    params,
  );
}

/**
 * Did this indicator's synthesized cuts fall back to the registry prior on ANY leg?
 *
 * ⚠ **No live caller since 2026-07-30.** Its sole consumer was `api/indicators.ts`'s
 * `provenance` field, retired with the whole wire field
 * ("IS-3
 * consequence 2" [USER]). Kept as the one seam that can still ANSWER the question, because
 * the answer is not recoverable from the cuts: `withSynthesizedPriors` emits its rows
 * unconditionally — the `evt_*` rows, and since W1 (2026-07-20) the
 * `operative_*`/`operative_vel_*` rows too — so a degraded id's cut set is shape-identical
 * to a computed one while the number is the hand-typed `PRIORS — uncalibrated` band.
 *
 * ANY leg, not all: a partial degrade (real level cuts, prior velocity cuts) is still a
 * band the id cannot honestly call measured, and under-claiming is the safe direction.
 * `false` for every non-synth id.
 */
export function synthCutsDegraded(indicator: Indicator, histories?: SynthHistories): boolean {
  if (!hasSynthPriors(indicator.id)) return false;
  const history = histories?.get(indicator.id);
  if (history === undefined) return true; // no history loaded ⇒ the cuts ARE the prior
  return computeSynthCutsDetailed(
    history,
    priorThresholds(indicator),
    indicator.velocityWindow ?? SYNTH_VEL_WINDOW,
  ).degraded.any;
}

/**
 * Load the stored level history for every synth id — one concurrent RPC per id at `SYNTH_HISTORY_LIMIT`
 * (see the constant's docblock). Call it only when a synth id is actually in scope.
 *
 * Degrades to an empty map on any store failure — `synthesizedCalib` then injects the priors,
 * i.e. exactly the Stage-6.2b behavior, never an absent cut. `onFail` names the ids first; one that throws rejects instead.
 */
export async function loadSynthHistories(store: SynthHistorySource, onFail?: SynthLoadFail): Promise<SynthHistories> {
  return (await loadSynthHistoriesDated(store, onFail)).histories;
}

/** Told a store failure before the loader resolves empty: `msg` names the synth ids that fall back to priors. */
export type SynthLoadFail = (msg: string, err: unknown) => void;

/** `loadSynthHistories` plus each id's NEWEST stored date — what `synthHistoriesInclusive` needs to
 *  tell "today's row is not stored yet" (append) from a same-day re-run (already stored: leave it). */
export interface SynthHistoryLoad {
  histories: SynthHistories;
  /** Newest FINAL stored date — a provisional (intraday) tail row is skipped here… */
  lastDate: ReadonlyMap<string, string>;
  /** …and its date listed here, so `synthHistoriesInclusive` drops it when the run re-prints that date (A4). */
  provisionalTail?: ReadonlyMap<string, string>;
}

export async function loadSynthHistoriesDated(store: SynthHistorySource, onFail: SynthLoadFail = console.warn): Promise<SynthHistoryLoad> {
  try {
    const bulk = await store.getSeriesBulk([...SYNTH_PRIOR_IDS], { limit: SYNTH_HISTORY_LIMIT });
    const histories = new Map<string, readonly number[]>();
    const lastDate = new Map<string, string>();
    const provisionalTail = new Map<string, string>();
    for (const [id, points] of bulk) {
      histories.set(id, points.map((p) => p.value));
      const last = points.at(-1);
      if (last !== undefined && isProvisional(last, id)) provisionalTail.set(id, last.date);
      const lastFinal = points.at(provisionalTail.has(id) ? -2 : -1);
      if (lastFinal !== undefined) lastDate.set(id, lastFinal.date);
    }
    return { histories, lastDate, provisionalTail };
  } catch (err) {
    onFail(`[synth] ${[...SYNTH_PRIOR_IDS].join("/")} history read failed - registry priors this run`, err);
    return { histories: new Map(), lastDate: new Map(), provisionalTail: new Map() };
  }
}

/**
 * The cron's history for `id`, INCLUSIVE of the run's own newest observation (chronological
 * `observations`, newest last). The stored history is loaded before this run's row persists, so
 * without the append the cron's expanding percentile runs over `[…stored]` while the restate's
 * per-day arm and the read path run over `[…stored, today]` — the exclusive-by-one split above.
 * A provisional (intraday) stored tail is dropped only when the run re-prints its date (tail ≥ the run's
 * newest date); an older provisional tail stays, as the read path keeps it.
 * Appends only when the newest observation post-dates the newest FINAL stored row (a same-day re-run
 * already holds it); leaves a non-synth id, an empty observation list, or an id with no stored
 * history (⇒ registry priors, unchanged degrade) untouched. Never mutates `load`.
 */
export function synthHistoriesInclusive(
  load: SynthHistoryLoad,
  id: string,
  observations: readonly Observation[],
): SynthHistories {
  if (!hasSynthPriors(id)) return load.histories;
  const latest = observations.at(-1);
  const base = load.histories.get(id);
  if (latest === undefined || base === undefined) return load.histories;
  const last = load.lastDate.get(id);
  const tail = load.provisionalTail?.get(id);
  const pool = tail !== undefined && tail >= latest.date ? base.slice(0, -1) : base;
  if (last !== undefined && latest.date <= last) {
    return pool === base ? load.histories : new Map(load.histories).set(id, pool);
  }
  const out = new Map(load.histories);
  out.set(id, [...pool, latest.value].slice(-SYNTH_HISTORY_LIMIT));
  return out;
}
