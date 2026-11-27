/** Run-cycle estimate rows: the level-estimate helpers + the EOD estimate rows, one generic runner keyed off `estimator.kind`. */

import { type Estimator, type Observation, type Reading } from "./domain-types.js";
import { VT, VXNCLS, VXNT } from "./registry-composite.js";
import type { StoredReading } from "./store.js";
import { degrade, recordDegrade } from "./tracks.js";
import { errMsg } from "./err-msg.js";
import { FAST_CONFIRMERS, type ConfirmerCtx } from "./confirmers.js";
import { extendWithEstimate, type NowcastScoredId } from "./nowcast-score.js";
import { nowcastLevelCarries, nowcastRatioCarries, usRateLead } from "./level-nowcast.js";
import { nowcastOilSpots } from "./oil-nowcast.js";
import { recentMarketDay } from "./source-holidays.js";
import { estimateAnchored } from "./estimated.js";
import { finalDates } from "./intraday.js";
import { toStoredReading } from "./run-seeds.js";
import type { makeFredLoop } from "./run-dbfirst.js";
import { INDICATOR_BY_ID, type RunBase, type RunCtx } from "./run-cycle-ctx.js";

/** I2 + `estimateAnchored`: one row per missing session whose previous session is a print — the walk stops one session past the newest print. */
export function gatedEstimates(firedDateIso: string, id: string, prints: Observation[], ests: readonly Observation[]): Observation[] {
  const finals = finalDates(prints, id);
  return ests.filter((e) => e.date <= firedDateIso && recentMarketDay(id, e.date) === e.date && estimateAnchored(id, finals, e.date));
}
// E11: EOD estimate rows beyond the oil lane (T10YIE) — the print grid's head re-scored with one estimate appended.
async function pushEstimate(
  ctx: RunBase,
  id: string,
  prints: Observation[],
  ests: readonly Observation[],
  score: (obs: Observation[]) => Reading | undefined | Promise<Reading | undefined>,
): Promise<void> {
  const ext = extendWithEstimate(prints, gatedEstimates(ctx.firedDateIso, id, prints, ests));
  for (let n = prints.length + 1; n <= ext.length; n++) {
    const head = await score(ext.slice(0, n));
    if (head?.date === ext[n - 1]!.date) ctx.levelEstimateRows.push({ ...toStoredReading(head), estimated: true });
  }
}
/** The estimators this runner dispatches; a `carry-log` (G1/BRENT) or `leg-ratio` (VT) id's rows come off the `FAST_CONFIRMERS`
 *  re-score in `buildEstimateRows` (`confirmerEstimateRows`). */
export type RowEstimator = Exclude<Estimator, { kind: "carry-log" | "leg-ratio" }>;
/** Every missing-session estimate of `e`, oldest first. `legs` = its `leads` series in order. */
export function estimatesOf(e: RowEstimator, prints: Observation[], legs: Observation[][]): Observation[] {
  switch (e.kind) {
    case "carry-level":
      return nowcastLevelCarries(prints, usRateLead(legs), e.beta);
    case "carry-mult":
      return nowcastOilSpots(prints, legs[0] ?? [], e.beta);
    case "carry-ratio":
      return nowcastRatioCarries(prints, legs[0] ?? [], legs[1] ?? [], e.beta);
  }
}
/** `id`'s EOD estimate rows off its registry estimator `e` — the ONE call every non-oil estimate row goes through. */
export async function pushEstimatorRows(
  ctx: RunBase,
  id: string,
  e: RowEstimator,
  prints: Observation[],
  legs: Observation[][],
  score: (obs: Observation[]) => Reading | undefined | Promise<Reading | undefined>,
): Promise<void> {
  await pushEstimate(ctx, id, prints, estimatesOf(e, prints, legs), score);
}
export interface EstimateInputs {
  nowcastPts: ReadonlyMap<NowcastScoredId, Observation[]>;
  /** VT's live-leg points keyed by leg series id (`vixEstimatePoints`) + the `VT` ratio twin (+ `VXNCLS`, VXNT's VXN leg); empty ⇒ no row. */
  vixPts: ReadonlyMap<string, Observation[]>;
  confirmerCtx: ConfirmerCtx;
  scoreFred: ReturnType<typeof makeFredLoop>["scoreFred"];
  /** id → print grid, for every FRED-loop id carrying an `estimator` (`scoreFredBatch`). */
  estimatePrints: ReadonlyMap<string, Observation[]>;
}

/** One confirmer's `estimated` rows: its scorer re-run with `extend` (keyed by the obs grid it extends — the confirmer's own id for
 *  G1/BRENT, the FRED leg series ids for VT), kept on `dates`. */
async function confirmerEstimateRows(
  c: (typeof FAST_CONFIRMERS)[number],
  confirmerCtx: ConfirmerCtx,
  extend: ReadonlyMap<string, Observation[]>,
  dates: ReadonlySet<string>,
): Promise<StoredReading[]> {
  const { series } = await c.score({ ...confirmerCtx, extendObs: (id, obs) => extendWithEstimate(obs, extend.get(id) ?? []) });
  return series.filter((r) => dates.has(r.date)).map((r) => ({ ...toStoredReading(r), estimated: true }));
}

export async function buildEstimateRows(
  ctx: RunCtx,
  { nowcastPts, vixPts, confirmerCtx, scoreFred, estimatePrints }: EstimateInputs,
): Promise<StoredReading[]> {
  // EOD (E2/E3): G1/BRENT re-score off the extended grid for the estimate ROW — `readings` stay on prints; the notify dial folds the row's head.
  const oilEstimateRows: StoredReading[] =
    nowcastPts.size === 0
      ? []
      : await degrade<StoredReading[]>("[nowcast] EOD estimate rows not written this run", "notify", [], async () => {
          const rows = await Promise.all(
            FAST_CONFIRMERS.filter((c) => nowcastPts.has(c.id)).map((c) => {
              const pts = nowcastPts.get(c.id)!;
              // Intraday, the newest point is the run's own G1/BRENT reading (flagged `estimated` at persist, E3).
              const dates = new Set((ctx.opts.intraday === true ? pts.slice(0, -1) : pts).map((p) => p.date));
              return confirmerEstimateRows(c, confirmerCtx, new Map([[c.id, pts]]), dates);
            }),
          );
          return rows.flat();
        });
  // VT (`leg-ratio`): the ratio scorer over the FRED legs carried over their live leads. While the graft is on, the run's own day is
  // the reading itself (the `VIXCLS`/`VXVCLS` scoring extension in `startConfirmersAndTracks`); every other point is a row.
  const vtRatioPts = vixPts.get(VT.id) ?? [];
  const vtDates = new Set(vtRatioPts.filter((p) => !(ctx.graftOn && p.date === ctx.firedDateIso)).map((p) => p.date));
  const vtEstimateRows: StoredReading[] =
    vtDates.size === 0
      ? []
      : await degrade<StoredReading[]>("[nowcast] VT EOD estimate row not written this run", "notify", [], () =>
          confirmerEstimateRows(FAST_CONFIRMERS.find((c) => c.id === VT.id)!, confirmerCtx, vixPts, vtDates),
        );
  // VXNT (`leg-ratio`, VT's lane): its VXN leg's carry dates + VT's; the confirmer emits a row only where all three legs have a value.
  // A failure records `trace`, never `notify`: VXNT is display-only (`CHART_ONLY_INDICATORS`), so the push caveat stays off.
  const vxntDates = new Set(
    [...(vixPts.get(VXNCLS.id) ?? []).map((p) => p.date), ...vtRatioPts.map((p) => p.date)].filter((d) => !(ctx.graftOn && d === ctx.firedDateIso)),
  );
  const vxntEstimateRows: StoredReading[] =
    vxntDates.size === 0
      ? []
      : await confirmerEstimateRows(FAST_CONFIRMERS.find((c) => c.id === VXNT.id)!, confirmerCtx, vixPts, vxntDates).catch((err: unknown) => {
          console.warn(`[nowcast] VXNT EOD estimate row not written this run: ${errMsg(err)}`);
          recordDegrade("[nowcast] VXNT EOD estimate row not written this run", errMsg(err), "trace");
          return [];
        });
  // Every FRED-loop estimator: the print grid carried over its lead to each missing session — EOD estimate
  // rows only, the reading stays on its print feed. No row once the grid holds the lead's date.
  await Promise.all(
    [...estimatePrints].map(([id, prints]) =>
      degrade<void>(`[nowcast] ${id} estimate row not written this run`, "notify", undefined, async () => {
        const ind = INDICATOR_BY_ID.get(id)!;
        const e = ind.estimator;
        if (e === undefined || e.kind === "carry-log" || e.kind === "leg-ratio" || prints.length === 0) return;
        // A provisional non-estimate head would shadow the estimate row: the EOD cleaner (`sweepEodRows`) deletes it.
        const score = async (ext: Observation[]) => (await scoreFred(ind, ext)).at(-1);
        await pushEstimatorRows(ctx, id, e, prints, await ctx.graft.estimatorLegs(id), score);
      }),
    ),
  );
  return [...oilEstimateRows, ...vtEstimateRows, ...vxntEstimateRows, ...ctx.levelEstimateRows];
}
