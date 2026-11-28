/**
 * Run-cycle IO shell: fetch+score every indicator, assembleRun (pure core), persist (readings +
 * alert, one txn), then push only on an upward level change (v4 §6.5). CLI entry: run.ts (`npm start`).
 */

import {
  type AlertLevel,
} from "./ladder.js";
import {
  applyCompoundFloor,
  applyOverlayStepDown,
  exposurePushState,
  type ExposurePrior,
  type ExposurePushState,
  type ExposureResult,
} from "./exposure.js";
import {
  getStore,
  type AlertRecord,
  type Store,
} from "./store.js";
import { loadGeoInputs } from "./geo.js";
import { peekDegradeLog, recordDegrade, TRACKS } from "./tracks.js";
import {
  rungOfSleeve,
} from "./families.js";
import type { R4Phase } from "./r4.js";
import { resolvePersistedCashLevel, CASH_REHYDRATE_DATES, type CashLevel } from "./cash-overlay.js";
import { STAGE_TO_FLAGS } from "./alert-band.js";
import type { Clock } from "./run-seeds.js";
import {
  assembleRun,
} from "./run-core.js";
import { createRunCtx, type RunCtx, type RunCycleOptions } from "./run-cycle-ctx.js";
import { resolveFeeds } from "./feed-ports.js";
import type { Env } from "./config.js";
import { toRunInputs, type AssembleRunOpts } from "./run-inputs.js";
import { createGraft } from "./run-cycle-graft.js";
import { buildStoredRows, persistRun, persistRunTrace } from "./run-cycle-persist.js";
import { markPhase, runTimings } from "./fetch-budget.js";
import { runIntradaySeedTail, runSeedTail } from "./run-cycle-seed-tail.js";
import { buildEstimateRows } from "./run-cycle-estimates.js";
import { mergeHeadEstimates, notifyHeadEstimates } from "./estimated.js";
import { pushBand, pushFredOutage, pushTail } from "./run-cycle-push.js";
import { computeExposureInputs } from "./run-cycle-exposure.js";
import { assembleReadingsAndDial } from "./run-cycle-dial.js";
import { loadScoringInputs, scoreFredBatch } from "./run-cycle-fred.js";
import { startConfirmersAndTracks, recordConfirmers } from "./run-cycle-confirmers.js";
import { scoreGlobalFeeds, scoreCqs, startEcbFetches } from "./run-cycle-feeds.js";

// Re-exported so the moved public name stays importable here (pinned at its source in db-first-feeds.test.ts) — NAMED, never `export *`.
;
;
export { assertF1VintagePresent } from "./run-cycle-fred.js";
export type { RunCycleOptions } from "./run-cycle-ctx.js";



/** The persisted-alert-row columns one side of the exposure comparator reads to bound a posture.
 *  Structural (not an `AlertRecord` import): `AlertRecord` is structurally assignable, no cast. @internal */
export interface ExposureBoundRow {
  /** The rung axis — the sleeve actually held that close (`rungOfSleeve` maps it to 1..9). */
  heldSleeve: string | null;
  /** R4's phase, for `resolveCash`'s precedence over the overlay. */
  r4Phase: R4Phase | null;
  /** The overlay's OWN level; `'full'` is `r4Phase`'s and the two merge in `resolveCash`. */
  cashOverlay: Exclude<CashLevel, "full">;
}

/**
 * Bound ONE side of the exposure push comparator: `applyCompoundFloor` first, then the overlay
 * step-down keyed off the PUBLISHED cash level. A missing/sleeve-less row is rung-BLIND (identity
 * this side), so never call this directly on the notify path — go through `exposurePushPair`, whose
 * SYMMETRY is what keeps a blind read push-suppressing rather than a phantom transition.
 * @internal
 */
export function boundExposureForPush(raw: ExposureResult, row: ExposureBoundRow | null): ExposureResult {
  const floored = applyCompoundFloor(raw, rungOfSleeve(row?.heldSleeve ?? null));
  const published = resolvePersistedCashLevel(row?.r4Phase ?? null, row?.cashOverlay ?? "off", floored.equityPct);
  return applyOverlayStepDown(floored, published);
}

/**
 * Assemble BOTH sides of the exposure push comparator plus the state this run persists — the ONLY
 * entry point the notify path may use. Prior side = the PREVIOUS RUN's persisted `ExposurePushState`
 * (so the push fires once per CHANGE), and `state` is what this run stamps before the atomic write.
 *
 * ⚠ If EITHER run was rung-blind, both sides fall back to the RAW axis (hence `rawPosture` beside
 * `posture`): the comparator reads the DIFFERENCE, so bounding one side while the other stays raw
 * would invent a transition. Deliberate cost: a genuine bounded-only move goes unpushed on a
 * rung-blind run — suppressing a real transition is the safe direction, a contradicted push is not.
 * @internal
 */
export function exposurePushPair(
  currRaw: ExposureResult,
  currRow: ExposureBoundRow | null,
  prevState: ExposurePushState | null,
): { curr: ExposureResult; prev: ExposurePrior | null; state: ExposurePushState | null } {
  const currBlind = rungOfSleeve(currRow?.heldSleeve ?? null) === null;
  const currBound = boundExposureForPush(currRaw, currBlind ? null : currRow);
  const state = exposurePushState(currBound, currRaw, currBlind);
  if (prevState === null) {
    // No baseline to compare against — a SILENT run that only establishes one.
    return { curr: currBound, prev: null, state };
  }
  const blind = currBlind || prevState.rungBlind;
  return {
    curr: blind ? currRaw : currBound,
    prev: blind ? { ...prevState, posture: prevState.rawPosture } : prevState,
    state,
  };
}

/** The prior-run reads for one cycle: scoring prev-state (`getLastAlertBefore`/`getLastBandBefore`) and the
 *  notify baselines (`getLastAlert`/`getLastPush`/`getLastBand`), issued as one concurrent batch by `runScoringCycle`. @internal */
export async function readPriorContext(store: Store, firedDateIso: string) {
  const [last, prevDay, lastPush, recentAlerts, lastBands, lastDialBandRaw] = await Promise.all([
    store.getLastAlert({ notifyBaseline: true }),
    store.getLastAlertBefore(firedDateIso),
    store.getLastPush(),
    store.getCashPriors(CASH_REHYDRATE_DATES),
    Promise.all(TRACKS.map((t) => store.getLastBand(t.baselineField))),
    store.getLastBandBefore("dialBand", firedDateIso),
  ]);
  const lastDialBand = lastDialBandRaw as AlertLevel | null;
  return { last, prevDay, lastPush, recentAlerts, lastBands, recentDialBands: lastDialBand != null ? [lastDialBand] : [] };
}

/** The intraday seed tail (`runIntradaySeedTail`), standalone — the `deferIntradaySeed` caller's half; `ports` = the run's injected seams. */
export const seedIntradayTail = (env: Env, clock: Clock, ports: Pick<RunCycleOptions, "store" | "feeds"> = {}): Promise<void> =>
  runIntradaySeedTail(ports.store ?? getStore("rw", env), env, clock, resolveFeeds(ports.feeds));

export async function runScoringCycle(clock: Clock, opts: RunCycleOptions): Promise<AlertRecord> {
  const base = createRunCtx(clock, opts);
  const ecb = startEcbFetches(base.feeds);
  const { calib, baa10yTail, aaa10yTail, ebpTail, seriesScorerFor, scoreFred, fredLoopObservations } =
    await loadScoringInputs(base);
  markPhase("load");
  const ctx: RunCtx = Object.assign(base, { graft: createGraft(base) });
  const { fredScored, estimatePrints } = await scoreFredBatch(ctx, fredLoopObservations, scoreFred);
  markPhase("fred");
  const { nowcastPts, vixPts, nowcastCloses, oilPrints, scoringPts, price, confirmerCtx, scoredConfirmersP, resolveGtState, scored } =
    await startConfirmersAndTracks(ctx, calib, seriesScorerFor);
  markPhase("confirmers");
  const { feed } = await scoreGlobalFeeds(ctx, calib, ecb);
  markPhase("globals");
  // Resolve ECY's deferred gate input: GT's scored state (first reading of the GT feed), or null
  // when GT degraded this run — `scoreEcy` then omits rather than fabricating a gate verdict.
  resolveGtState(feed("GT")[0]?.state ?? null);
  // Marks split globals→assemble (24 s on prod 2026-11-18, unattributable). `confirmersWait` and `cqs` are only
  // the RESIDUAL wait on fetches that started earlier and overlap tracks + globals — a slow source names itself
  // in its own `conf.<id>` / `cqs.<id>` settle stamp, not here. `estimates` is buildEstimateRows' own work.
  const scoredConfirmers = await scoredConfirmersP;
  markPhase("confirmersWait");
  const estimateRows = await buildEstimateRows(ctx, { nowcastPts, vixPts, confirmerCtx, scoreFred, estimatePrints });
  markPhase("estimates");
  recordConfirmers(ctx, scoredConfirmers, scoringPts);
  const cqsSeries = await scoreCqs(ctx, baa10yTail, aaa10yTail, ebpTail);
  markPhase("cqs");
  const { readings, stampedReadings, globalReadings, downside, rs, dial, display, globalPanel, cissHistory, notifyPanelState } =
    await assembleReadingsAndDial(ctx, { fredScored, price, feed, cqsSeries, scoredConfirmers, scored, estimateRows });
  markPhase("assemble");

  // Read prior-run context BEFORE writing this one, SPLIT notify-vs-scoring (record_run keeps one alert
  // row per UTC fired-date, last run wins):
  //  * `last` (latest ORIGINAL row, incl. today's about-to-be-replaced one; `rederivedFrom` rows skipped) = NOTIFY baseline.
  //  * `prevDay` (latest PRIOR fired-day) = SCORING prev-state (dwell/streak/R4/hold — same-day re-run idempotent).
  //  * `lastPush` = last run that actually pushed (weekly re-assert baseline).
  //  * `getCashPriors` rehydrates the cash-accel window (one row per fired-date). ⛔ Do NOT MERGE the read
  //    methods into one (store.ts `getLastAlertBefore`: "don't merge") — but issuing them together in
  //    this batch is fine: every read takes only `firedDateIso`/a constant, never another read's RESULT.
  //  * per-track baseline = last NON-NULL band (getLastBand); a null band would re-fire the transition every run.
  //  * dial baseline (getLastBandBefore, a `fired_at <` lookback) reads the prior fired-day so an intraday row
  //    can't consume the N−1=1 prior-band slot (N=2 down-hold).
  const { last, prevDay, lastPush, recentAlerts, lastBands, recentDialBands } = await readPriorContext(ctx.store, ctx.firedDateIso);

  // Manual GEO inputs from config.json (default 0 / Green); logged so an active flag / declared stage shows in the transcript.
  const { flagCount: geoFlags, crisisStage } = opts.geo ?? loadGeoInputs();
  if (geoFlags > 0) console.log(`[geo] ${geoFlags} active manual flag(s) - GEO channel elevated`);
  if (crisisStage > 0) console.log(`[geo] crisis stage ${crisisStage} declared - geo floor +${STAGE_TO_FLAGS[crisisStage]} flag(s)`);

  const { exposure, exposureSeries, fallShape, oilEst, nearHighTol, slowDistToHigh, growthRsBySleeve, growthMomBySleeve } =
    await computeExposureInputs(ctx, readings, stampedReadings, globalReadings, oilPrints, nowcastCloses, calib, scored);

  const runOpts: AssembleRunOpts = { readings, readingsForStore: stampedReadings, last, prevDay, lastPush, now: ctx.runAt, geoFlags, crisisStage, scored, lastBands, dial, globalFamilies: globalPanel, cissHistory, panelState: notifyPanelState, displayDialState: display.dial, displayPanelState: display.panel, rsBySleeve: growthRsBySleeve, momBySleeve: growthMomBySleeve, recentDialBands, recentAlerts, exposurePosture: exposure?.posture ?? null, fallShape, degradeEvents: peekDegradeLog(), spDistToHigh: slowDistToHigh, nearHighTol, globalReadings,
    // The notify dial's folded heads ride the oil slot to the push body's `est.` clause; oil's own nowcast wins its ids' value.
    oilEst: mergeHeadEstimates(notifyHeadEstimates([...readings, ...globalReadings], estimateRows), oilEst) };
  const { alert, storedReadings, trackStoredReadings, notification, provisional, slowNotification, bottomNotification, freshness, consoleLines } =
    assembleRun(runOpts);
  // The late-notify-seen markers ride THIS row (`degraded`, so above persistRun's drain) whether surfaced or
  // suppressed — the next run's dedupe key (`priorLateNotifyEvents`). Here, not in `assembleRun`: a re-derive twin never records them.
  for (const m of notification.lateSeen) recordDegrade(m.scope, m.reason, "trace");
  // `run_inputs`: the SAME opts object + the heads the dials folded, so a re-derive replays exactly what this run assembled.
  alert.runInputs = toRunInputs(runOpts, estimateRows);

  // Exposure push comparator — ASSEMBLED HERE (needs `alert` + a spot ABOVE recordRun so its state rides
  // that write), PUSHED IN THE TAIL. Dedup baseline is `last` (prev RUN, incl. same-day), NOT `prevDay`.
  // A degraded feed CARRIES the prior state forward (a null would read back as "no baseline" and re-arm repeats).
  const exposurePush = exposure ? exposurePushPair(exposure, alert, last?.exposureState ?? null) : null;
  alert.exposureState = exposurePush?.state ?? last?.exposureState ?? null;

  for (const line of consoleLines) console.log(line);
  // Per-track transcript lines, in TRACKS order (slow, bottom, pension — unchanged).
  for (const s of scored) console.log(s.consoleLine);
  if (freshness.lag) {
    console.warn(`[heartbeat] feed lag: latest data ${freshness.ageDays}d old (as of ${alert.date})`);
  }

  // ⚠ NOTIFY BEFORE PERSIST (do NOT "restore" persist-first — ruled correct): the band push runs BEFORE
  // `recordRun` so the alert row records the OUTCOME — `pushed_at` on a confirmed send, `push_error` on
  // failure (next run's `decideReassert` re-fires off it). The write is atomic: fast + slow-tier readings +
  // the commit-point alert in one transaction. GLOBAL readings ride the same record_run (dial reduces them
  // by id) but were assembled OUTSIDE notify-facing `readings`, so they never touch verdict/summary/drivers.
  const storedRows = await buildStoredRows(ctx, alert, prevDay, globalReadings, { downside, rs });
  await pushBand(ctx, alert, last, notification, provisional);
  // ABOVE persistRun: its drainDegradeLog is the only point an event persists.
  const outage = await pushFredOutage(ctx);
  if (outage) recordDegrade(outage.scope, outage.reason, "trace");
  markPhase("push");
  // The commit-point row carries the marks so far; `persistRunTrace` rewrites them whole after the tail.
  alert.timings = runTimings();

  const outcome = await persistRun(ctx, alert, notification, storedReadings, trackStoredReadings, storedRows, estimateRows);
  if (outcome === "intraday-done") return alert;
  markPhase("persist");
  if (ctx.opts.onCommitted) {
    await ctx.opts.onCommitted();
    markPhase("purge");
  }

  try {
    await runSeedTail(ctx, price.backfillSeries, alert.date);
  } catch (err) {
    // `runSeedTail` already recorded each rejected task's ids (`SEED_TAIL_SCOPE`); this rethrows the first.
    markPhase("tail");
    await persistRunTrace(ctx, alert);
    throw err;
  }
  markPhase("tail");

  await pushTail(ctx, scored, slowNotification, bottomNotification, exposureSeries, exposurePush);
  markPhase("pushTail");
  await persistRunTrace(ctx, alert);

  return alert;
}
