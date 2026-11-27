/** Run-cycle pre-assembly inputs: exposure dial, V-vs-bear fall shape, oil nowcast clause, D-B escalator, growth maps. */

import type { CalibParamRow } from "./domain-cuts.js";
import type { Observation, Reading } from "./domain-types.js";
import { computeExposure, type ExposureResult } from "./exposure.js";
import { classifyFallShape, V_BEAR_F_LIMIT, type FallShapeVerdict } from "./v-bear.js";
import type { SeriesPoint, Store } from "./store.js";
import { legCloseId } from "./scoreboard.js";
import { computeLegRs, computeVolAdjMom, Y1_MIN_OBS, type Sleeve } from "./y1.js";
import { degrade, recordDegrade, type ScoredTrack } from "./tracks.js";
import { nowcastOilSpots, type OilNowcast } from "./oil-nowcast.js";
import { estimatorOf, type NowcastScoredId } from "./nowcast-score.js";
import { estimateAnchored, getPrintSeries } from "./estimated.js";
import { finalDates } from "./intraday.js";
import { LADDER } from "./families.js";
import { toStoredReadings, seedSeriesWithRun, EXPOSURE_F1_LIMIT, EXPOSURE_GT_LIMIT } from "./run-core.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { errMsg } from "./err-msg.js";

/**
 * The push clause's oil estimate: `print` (this run's scored reading) carried by `futureCloses` to the FIRST
 * session past it that is on or before `firedDateIso` and anchored on a final print — never a chained later one.
 * `storedPrints` are capped strictly below the reading's date, so the newest print IS its level, and the
 * walk-back can reach an earlier print when the future has no close on the newest date (S2a). No print ⇒ null.
 */
export function oilNowcastHead(
  id: "BRENT" | "G1",
  print: Pick<Reading, "date" | "level"> | undefined,
  storedPrints: readonly Observation[] | undefined,
  futureCloses: Observation[],
  firedDateIso: string,
): OilNowcast | null {
  if (!print) return null;
  const prints = [...(storedPrints ?? []).filter((o) => o.date < print.date), { date: print.date, value: print.level }];
  const finals = finalDates(prints, id);
  return nowcastOilSpots(prints, futureCloses, estimatorOf(id, "carry-log").beta).find((e) => e.date <= firedDateIso && estimateAnchored(id, finals, e.date)) ?? null;
}

export async function computeExposureInputs(
  ctx: RunBase,
  readings: Reading[],
  stampedReadings: Reading[],
  globalReadings: Reading[],
  oilPrints: Readonly<Record<NowcastScoredId, Observation[]>>,
  nowcastCloses: (symbol: string) => Promise<Observation[]>,
  calib: ReadonlyArray<CalibParamRow>,
  scored: ScoredTrack[],
): Promise<{
  exposure: ExposureResult | null;
  exposureSeries: { f1: SeriesPoint[]; gt: SeriesPoint[] } | null;
  fallShape: FallShapeVerdict | null;
  oilEst: Partial<Record<"BRENT" | "G1", OilNowcast | null>>;
  nearHighTol: number | null;
  slowDistToHigh: number | null;
  growthRsBySleeve: Map<Sleeve, number | null> | undefined;
  growthMomBySleeve: Map<Sleeve, number | null> | undefined;
}> {
  // Exposure dial (E1) — HOISTED above the notify/alert assembly so the band push carries THIS close's
  // equity weight. Store history is seeded with the run's own not-yet-persisted F1/GT rows via the SAME
  // `toStoredReadings` projection `recordRun` uses (byte-equal to the old post-recordRun getSeries path).
  // ⚠ MUST sit above `drainDegradeLog()` (`persistRun`): a degrade here (store/feed hiccup ⇒ posture null ⇒ "not
  // yet sized", band push still fires) would otherwise land in a log nothing persists.
  let exposureSeries: { f1: SeriesPoint[]; gt: SeriesPoint[] } | null = null;
  let exposure: ExposureResult | null = null;
  try {
    // `stampedReadings`: the seed must be byte-equal to what `recordRun` persists (named explicitly so a
    // future scoring-only override can't leak into the seed).
    const runRows = [...toStoredReadings(stampedReadings), ...toStoredReadings(globalReadings)];
    const [storedF1, storedGt] = await Promise.all([
      getPrintSeries(ctx.store, "F1", EXPOSURE_F1_LIMIT), // E25: a carry row is no observation
      getPrintSeries(ctx.store, "GT", EXPOSURE_GT_LIMIT),
    ]);
    exposureSeries = {
      f1: seedSeriesWithRun(storedF1, runRows, "F1", EXPOSURE_F1_LIMIT),
      gt: seedSeriesWithRun(storedGt, runRows, "GT", EXPOSURE_GT_LIMIT),
    };
    exposure = computeExposure(exposureSeries.f1, exposureSeries.gt);
  } catch (err) {
    const reason = errMsg(err);
    console.warn(`[exposure] non-live this run: ${reason}`);
    recordDegrade("[exposure] non-live - F1/GT history unavailable", reason, "notify");
  }

  // V-vs-bear fall shape — LIVE: `applyFallShape` wraps the cash overlay, so a `v-shaped` verdict
  // SUPPRESSES it (band/dial/held sleeve untouched); the verdict is persisted for the push-time render.
  // ACWI is the benchmark; `fetchDailyCloses` memoizes by `symbol|range`, so this call is a CACHE HIT
  // (no `lookbackDays` override — it would mint a second cache key + round-trip). F1/F2 seeded with this
  // run's rows via `seedSeriesWithRun` at `V_BEAR_F_LIMIT` (byte-equal to a post-persist getSeries).
  // ⚠ MUST sit above `drainDegradeLog()`: a degrade here (null ⇒ 'indeterminate') would else be swallowed.
  let fallShape: FallShapeVerdict | null = null;
  try {
    // `stampedReadings`: must match the UNFLIPPED rows `recordRun` writes (as the exposure seed above).
    const runRows = toStoredReadings(stampedReadings);
    const [acwi, storedF1, storedF2] = await Promise.all([
      ctx.feeds.fetchDailyCloses("ACWI", { now: () => Date.parse(ctx.runAt), env: ctx.env }),
      getPrintSeries(ctx.store, "F1", V_BEAR_F_LIMIT),
      getPrintSeries(ctx.store, "F2", V_BEAR_F_LIMIT),
    ]);
    fallShape = classifyFallShape(
      acwi.map((o) => o.value),
      seedSeriesWithRun(storedF1, runRows, "F1", V_BEAR_F_LIMIT),
      seedSeriesWithRun(storedF2, runRows, "F2", V_BEAR_F_LIMIT),
    );
  } catch (err) {
    const reason = errMsg(err);
    console.warn(`[v-bear] non-live this run: ${reason}`);
    recordDegrade("[v-bear] non-live - ACWI closes or F1/F2 history unavailable", reason, "notify");
  }

  // E8 retired the F1 push `est.` clause; only the oil clause below remains (F1's `inav` estimate reaches the notify
  // dial instead).
  const nowcastLeg = (symbol: string) =>
    degrade<Observation[]>(`[oil-nowcast] ${symbol} closes unavailable - push estimate clause omitted`, "notify", [], () => nowcastCloses(symbol));

  // S5 + `estimateAnchored`: live BZ=F / CL=F futures carry this run's BRENT/G1 prints ONE session past the print for the push body's
  // est. clause. Missing input or no anchored session ⇒ null (display-only, R3), never aborts the push.
  const [bzCloses, clCloses] = await Promise.all(
    (["BRENT", "G1"] as const).map((id) => nowcastLeg(estimatorOf(id, "carry-log").leads[0])),
  );
  const printOf = (id: "BRENT" | "G1") => readings.find((r) => r.indicator.id === id);
  const oilEst: Partial<Record<"BRENT" | "G1", OilNowcast | null>> = {
    BRENT: oilNowcastHead("BRENT", printOf("BRENT"), oilPrints.BRENT, bzCloses!, ctx.firedDateIso),
    G1: oilNowcastHead("G1", printOf("G1"), oilPrints.G1, clCloses!, ctx.firedDateIso),
  };

  // D-B divergence escalator inputs: near-high tolerance off `calib` (no re-fetch) + this run's QQQ
  // distance-to-252d-high off the slow track. Both null-safe ⇒ no bump on an absent row / degraded feed.
  const nearHighTol = calib.find((p) => p.channel === "equity" && p.metric === "qqq_nearhigh_tol")?.value ?? null;
  const slowDistToHigh = scored.find((s) => s.baselineField === "slowBand")?.spDistToHigh ?? null;

  // G2.1 — the growth pillar's rs/mom maps, so `computeField` lights `legRows[].growth` on the NOTIFY
  // path as /lab does. READ ONLY (no new fetch): the nine `LEGP_*` series are read from the store and
  // `computeLegRs`/`computeVolAdjMom` are the same derivations `seedGrowthRsOnCron` runs post-persist.
  // ⚠ ACCEPTED LAG (do not "fix"): `seedLegClosesOnCron` writes today's `LEGP_*` in the post-recordRun tail, so both
  // maps anchor to the PREVIOUS close — its served row, estimate included (`pushLegSeries`). STARVE-FIRST: sits BEFORE recordRun, so a store
  // hiccup leaves both maps undefined ⇒ `computeLegGrowth` returns `live: false` (byte-identical to pre-G2.1).
  let growthRsBySleeve: Map<Sleeve, number | null> | undefined;
  let growthMomBySleeve: Map<Sleeve, number | null> | undefined;
  try {
    const legSeries = await pushLegSeries(ctx.store);
    growthRsBySleeve = computeLegRs(legSeries).rs;
    growthMomBySleeve = computeVolAdjMom(legSeries).mom;
  } catch (err) {
    console.warn(`[growth] pillar non-live this run: ${errMsg(err)}`);
    recordDegrade("[growth] pillar non-live - leg series unavailable", errMsg(err), "notify");
  }

  return { exposure, exposureSeries, fallShape, oilEst, nearHighTol, slowDistToHigh, growthRsBySleeve, growthMomBySleeve };
}

/** The nine `LEGP_*` series the push's growth maps read: the SERVED row per date (FINAL, else the EOD
 *  estimate). Same window `seedGrowthRsOnCron` reads (`Y1_MIN_OBS` + its 40-row pad). */
export async function pushLegSeries(store: Pick<Store, "getSeriesBulk">): Promise<Map<Sleeve, SeriesPoint[]>> {
  const bulk = await store.getSeriesBulk(LADDER.map((sleeve) => legCloseId(sleeve)), { limit: Y1_MIN_OBS + 40 });
  return new Map(LADDER.map((sleeve) => [sleeve, bulk.get(legCloseId(sleeve)) ?? []]));
}
