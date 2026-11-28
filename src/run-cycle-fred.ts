/** Run-cycle scoring inputs + FRED batch: calibration/synth load, F1 vintage guard, CQS/R8 tails, the FRED loop. */

import { INDICATORS, T10Y3M_POST_INVERSION } from "./registry-fred.js";
import { type Observation, type Reading } from "./domain-types.js";
import { type CalibParamRow } from "./domain-cuts.js";
import { SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";
import { degrade, recordDegrade } from "./tracks.js";
import { isProvisional } from "./intraday.js";
import { estimateDatesOf } from "./estimated.js";
import { loadSynthHistoriesDated, synthesizedCalib, type SynthHistories } from "./synth-cuts.js";
import { FRED_FALLBACK_READ, makeFredLoop } from "./run-dbfirst.js";
import type { RunBase, RunCtx } from "./run-cycle-ctx.js";
import { errMsg } from "./err-msg.js";
import { isNoFreeSource } from "./no-free-source.js";
import { markPhase } from "./fetch-budget.js";

/**
 * Fail-loud guard: a ROWS-PRESENT check that the harness still EMITS the `credit/hyoas` prefix —
 * absent ⇒ throw so the cron ABORTS (never scores F1 on absent priors). Cron/scoring path only.
 * @internal
 */
export function assertF1VintagePresent(
  calib: ReadonlyArray<CalibParamRow>,
  synthHistories: SynthHistories,
): void {
  const f1 = INDICATORS.find((i) => i.id === "F1");
  if (!f1) return;
  // `synthesizedCalib` stays in the path (identity for F1) so the guard reads the SAME row set every `resolveCuts` site sees.
  const rows = synthesizedCalib(f1, calib, synthHistories);
  if (!rows.some((p) => p.channel === "credit" && p.metric.startsWith("hyoas_"))) {
    throw new Error("[F1] missing credit/hyoas calibration vintage - refusing to score on absent priors");
  }
}

export async function loadScoringInputs(base: RunBase) {
  const { fetchEbp, fetchSeries } = base.feeds;
  // The measured-threshold vintage, read ONCE and threaded per indicator via resolveCuts. EMPTY
  // vintage ⇒ every leg undefined ⇒ byte-identical absolute-only behavior. F1/F2 have NO z-leg
  // (own `op`/`vel-op` pairs); R2/R3/R4 get the velocity z-leg; G1 oil stays Tier C (no z-leg).
  const calib = await base.store.getCalibration();
  // `synthPriors` ids (`SYNTH_PRIOR_IDS`) have NO published vintage; cuts = the expanding percentile of
  // their OWN stored history, loaded in ONE bulk round-trip and threaded to every `resolveCuts` site
  // (the split-brain guard). Empty map ⇒ registry priors, never a NaN cut. Loaded BEFORE this run's row
  // persists; scorers append the run's own newest obs so cron/restate/read pools match. A store failure is a recorded degrade.
  const synthLoad = await loadSynthHistoriesDated(base.store, (msg, err) => {
    console.warn(`${msg}: ${errMsg(err)}`);
    recordDegrade(msg, errMsg(err), "notify");
  });
  const synthHistories = synthLoad.histories;
  // Placed OUTSIDE the per-indicator degrade wrapper below so the throw ABORTS the cron rather than
  // being caught, dropping F1 non-live and HIDING the outage. The api/series READ path keeps its own
  // degrade behavior (renders `convention`/absent band, never a throw).
  assertF1VintagePresent(calib, synthHistories);
  // BAA10Y tail — consumed only by the CQS quality spread (`cqsSeries`); degrades to [] (CQS drops its card,
  // never aborts the core). STARTED not awaited: floats to overlap the INDICATORS map; `degrade` can
  // never reject unhandled (it catches every throw → the [] fallback).
  const baa10yTail = degrade<Observation[]>(
    "[baa10y] Baa10y feed unavailable - CQS card non-live this run",
    "notify",
    [],
    () => fetchSeries("BAA10Y", { now: new Date(base.runAt), env: base.env }),
  ).finally(() => markPhase("cqs.BAA10Y")); // floats from here: the `cqs` phase mark only shows its residual wait
  // AAA10Y — the CQS card's SECOND leg; same float-don't-await + degrade contract. Empty tail ⇒ empty join ⇒ CQS leg drops.
  const aaa10yTail = degrade<Observation[]>(
    "[aaa10y] Aaa feed unavailable - CQS quality-spread card non-live this run",
    "notify",
    [],
    () => fetchSeries("AAA10Y", { now: new Date(base.runAt), env: base.env }),
  ).finally(() => markPhase("cqs.AAA10Y"));
  // EBP monthly series — the CQS EBP-bridge anchor (only the latest month-END read). Empty tail ⇒
  // silent GREEN, never a thrown card. Same float-don't-await shape as the two legs above.
  const ebpTail = degrade<Observation[]>(
    "[ebp] EBP feed unavailable - CQS bridge anchor lost this run (silent GREEN, R5)",
    "notify",
    [],
    () => fetchEbp(),
  ).finally(() => markPhase("cqs.EBP"));
  // Short (3m) leg for the R8 post-inversion steepener escalation — FULL history. Degrades to [] ⇒ gate off (floor applies, no RED escalation).
  const postInversionShortLeg = degrade<Observation[]>(
    "[postInversion] short-leg feed unavailable - steepener escalation off this run (floor still applies)",
    "notify",
    [],
    () => fetchSeries(T10Y3M_POST_INVERSION.shortLegSeries, { fullHistory: true, now: new Date(base.runAt), env: base.env }),
  );
  // The ex-inline FRED-loop closures (B1 peel, run-dbfirst.ts) — explicit deps, no hidden closure state.
  const { seriesScorerFor, scoreFred, fredLoopObservations } = makeFredLoop({ dbFirst: base.dbFirst, env: base.env, calib, synthLoad, postInversionShortLeg });
  return { calib, synthHistories, baa10yTail, aaa10yTail, ebpTail, seriesScorerFor, scoreFred, fredLoopObservations };
}

export async function scoreFredBatch(
  ctx: RunCtx,
  fredLoopObservations: ReturnType<typeof makeFredLoop>["fredLoopObservations"],
  scoreFred: ReturnType<typeof makeFredLoop>["scoreFred"],
) {
  const { opts } = ctx;
  const estimatePrints = new Map<string, Observation[]>(); // id → the print grid its EOD estimate rows extend
  // Per-indicator degrade: each indicator scores independently so one fetch rejection can't reject the
  // Promise.all / 500 the cron. On failure, fall back to the last-persisted series; no stored history ⇒
  // indicator non-live this run (dropped from `readings`), never a thrown run.
  const fredScored: Reading[] = (
    await Promise.all(
      INDICATORS.map(async (indicator): Promise<Reading | null> => {
        ctx.markFallbackSourced(indicator.id, indicator.series); // a `prices`-plan id's symbol (`fetchIndicatorObservations`); claimed before a throw
        try {
          // `fredLoopObservations` (DB-first only for `CORE_LOOP_DB_FIRST` ids) then `scoreFred`.
          // Record the FULL fetched grid, not just the
          // latest date.
          const prints = await fredLoopObservations(indicator);
          if (indicator.estimator !== undefined) estimatePrints.set(indicator.id, prints);
          const observations = ctx.graftOn ? await ctx.graft.liveHead(indicator.id, prints) : prints;
          ctx.recordFeedDates(indicator.id, observations.map((o) => o.date));
          ctx.markEstimateSourced(indicator.id, estimateDatesOf(observations)); // e.g. a Treasury head (`graftTreasuryHead`)
          const series = await scoreFred(indicator, observations);
          ctx.carry(indicator.id, series);
          return series.at(-1)!;
        } catch (liveErr) {
          // A refused id / unfed feed is unavailable by design, not an outage: its trace carries the kind.
          const kind = isNoFreeSource(liveErr) ? { kind: "no-free-source" as const } : undefined;
          // Fall back to the last-persisted series (store keys by id). NOT for a `SMOOTHED_LEVEL_OF`
          // id: its stored value IS the trailing mean ⇒ re-scoring = mean of means.
          const stored = SMOOTHED_LEVEL_OF[indicator.id]
            ? []
            : (await ctx.store.getSeries(indicator.id, FRED_FALLBACK_READ).catch(() => [])).filter(
                // EOD never scores a provisional row; no run scores an `estimated` row (E2) — it would re-persist as a print.
                (p) => p.estimated !== true && (opts.intraday === true || !isProvisional(p, indicator.id)),
              );
          if (stored.length > 0) {
            try {
              // The stored series IS this run's grid for the id
              //.
              ctx.recordFeedDates(indicator.id, stored.map((p) => p.date));
              const storedObs = stored.map((p) => ({ date: p.date, value: p.value }));
              const r = (await scoreFred(indicator, storedObs)).at(-1)!;
              const reason = errMsg(liveErr);
              console.warn(
                `[${indicator.id}] the live feed failed - scored off last-persisted series (${stored.length} pts): ${reason}`,
              );
              recordDegrade(`[${indicator.id}] scored off last-persisted series`, reason, "notify", kind);
              return r;
            } catch (storeErr) {
              const reason = errMsg(storeErr);
              console.warn(
                `[${indicator.id}] stored-series fallback also failed to score - indicator non-live this run: ${reason}`,
              );
              recordDegrade(`[${indicator.id}] non-live - stored fallback failed to score`, reason, "notify");
              return null;
            }
          }
          const reason = errMsg(liveErr);
          console.warn(
            `[${indicator.id}] the live feed fetch failed, no stored fallback - indicator non-live this run: ${reason}`,
          );
          recordDegrade(`[${indicator.id}] non-live - live feed fetch failed, no stored fallback`, reason, "notify", kind);
          return null;
        }
      }),
    )
  ).filter((r): r is Reading => r !== null);
  return { fredScored, estimatePrints };
}
