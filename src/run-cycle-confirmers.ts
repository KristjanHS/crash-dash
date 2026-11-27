/** Run-cycle confirmers + tracks: oil nowcast points, price/VIX legs, the floating confirmer batch, off-ladder tracks. */

import { G1, BRENT } from "./registry-geo.js";
import { VT, VXNCLS } from "./registry-composite.js";
import { type Observation, type State } from "./domain-types.js";
import { OIL_LEVEL_LOOKBACK_DAYS, VT_DESCRIPTOR } from "./family-descriptor-rows.js";
import { sinceDaysAgo } from "./lookback.js";
import { degrade, recordDegrade, TRACKS } from "./tracks.js";
import { errMsg } from "./err-msg.js";
import { markPhase } from "./fetch-budget.js";
import { FAST_CONFIRMERS, type ConfirmerCtx } from "./confirmers.js";
import type { DbFirstCtx } from "./series-db-first.js";
import { estimatorOf, extendWithEstimate, intradayNowcastPoints, NOWCAST_LEG_SYMBOLS, type NowcastScoredId } from "./nowcast-score.js";
import { alignTermStructure } from "./vix_term.js";
import { nowcastLevelCarries } from "./level-nowcast.js";
import { recentMarketDay } from "./source-holidays.js";
import { estimateAnchored } from "./estimated.js";
import { finalDates } from "./intraday.js";
import { withStoredLegs } from "./input-series.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { scorePriceIndicators, fetchVixTermLegs, fetchR4DeepInputs, PRICE_BATCH_INPUTS } from "./run-dbfirst.js";
import type { RunBase, RunCtx } from "./run-cycle-ctx.js";
import { estimatesOf, gatedEstimates } from "./run-cycle-estimates.js";

/** VT's same-day points (`leg-ratio`; the VIX3M nowcast-error pass covers both closes-provider
 *  legs, so VT leaves the Stage 6 carry roster for an estimate): each FRED leg carried over its live `^VIX`/`^VIX3M` lead at beta 1 (R5's form —
 *  `nowcastLevelCarries`, print + the lead's move, never the lead's raw level) on the dates past the legs' newest ALIGNED print that
 *  BOTH carries reach, gated like the oil points — never past the run's date, a VT session, `estimateAnchored` on the aligned grid
 *  (one session past the print). Keyed by each leg's series id (`VIXCLS`/`VXVCLS`, the VT confirmer's `extendObs` keys) plus
 *  `VT` → the ratio on those dates (the row/carry dates), plus `VXNCLS` → VXNT's VXN leg (`legs.vxn`) by its own `carry-mult` off the same `^VIX`. */
async function vixEstimatePoints(
  ctx: RunCtx,
  legs: { front: Observation[]; back: Observation[]; vxn: Observation[] },
): Promise<Map<string, Observation[]>> {
  const out = new Map<string, Observation[]>();
  const aligned = alignTermStructure(legs.front, legs.back);
  const newest = aligned.at(-1)?.date;
  if (newest === undefined) return out;
  const [vix = [], vix3m = []] = await degrade<Observation[][]>("[nowcast] VT live legs unavailable - no VT estimate this run", "notify", [], () => ctx.graft.estimatorLegs(VT.id));
  const finals = finalDates(aligned);
  const [frontId, backId] = VT_DESCRIPTOR.inputs;
  // A leg's value on a date: its own FRED print where it has one (a leg lagging the other by a session), else its carry.
  const legAt = (prints: Observation[], live: Observation[]): Map<string, number> => {
    const m = new Map(prints.map((o) => [o.date, o.value]));
    for (const e of nowcastLevelCarries(prints, live, 1)) if (!m.has(e.date)) m.set(e.date, e.value);
    return m;
  };
  const [front, back] = [legAt(legs.front, vix), legAt(legs.back, vix3m)];
  const newestOf = (leg: Observation[]): string => leg.at(-1)?.date ?? "";
  for (const [date, f] of [...front].sort(([a], [b]) => a.localeCompare(b))) {
    const b = back.get(date);
    if (b === undefined || b <= 0 || f <= 0 || date <= newest || date > ctx.firedDateIso) continue;
    if (recentMarketDay(VT.id, date) !== date || !estimateAnchored(VT.id, finals, date)) continue;
    if (date > newestOf(legs.front)) out.set(frontId, [...(out.get(frontId) ?? []), { date, value: f }]);
    if (date > newestOf(legs.back)) out.set(backId, [...(out.get(backId) ?? []), { date, value: b }]);
    out.set(VT.id, [...(out.get(VT.id) ?? []), { date, value: f / b }]);
  }
  // VXN print × ^VIX now ÷ ^VIX at the print — the closes provider serves no live ^VXN bar; `vix` is VXNCLS's own `carry-mult` lead (pinned in run.wiring.estimates).
  const vxnEst = estimatesOf(estimatorOf(VXNCLS.id, "carry-mult"), legs.vxn, [vix]);
  const vxnPts = gatedEstimates(ctx.firedDateIso, VXNCLS.id, legs.vxn, vxnEst);
  if (vxnPts.length > 0) out.set(VXNCLS.id, vxnPts);
  return out;
}

export async function startConfirmersAndTracks(
  ctx: RunCtx,
  calib: ConfirmerCtx["calib"],
  seriesScorerFor: NonNullable<DbFirstCtx["seriesScorerFor"]>,
) {
  const { fetchDailyCloses, fetchSeries } = ctx.feeds;
  // Oil nowcast (a retired plan L2; E2/E8): G1/BRENT
  // carry their prints to the futures' newest close on EVERY run. INTRADAY scores off the extended grid; EOD keeps readings + the FIN score
  // on prints and persists the point as an `estimated` row (`buildEstimateRows`, run-cycle-estimates.ts) whose head the notify dial folds.
  const nowcastPts = new Map<NowcastScoredId, Observation[]>();
  // Defect 1: the nowcast legs' live closes with their holes filled
  // from the stored `INPUT_SERIES` rows, so a feed missing the newest print's date (the closes provider's EU D-1 null bar)
  // still finds R10's exact-date base. ONE feed for the nowcast points AND the push clause (`computeExposureInputs`).
  const nowcastCloses = withStoredLegs(ctx.store, NOWCAST_LEG_SYMBOLS, (symbol) => fetchDailyCloses(symbol, { now: () => Date.parse(ctx.runAt), env: ctx.env }), NOWCAST_MAX_CARRY_DAYS + 1, {
    now: new Date(ctx.runAt),
    onFail: (scope, reason) => recordDegrade(scope, reason, "notify"),
  });
  // Same windows as the G1/BRENT scoring sites (per-run FRED memo ⇒ free); also the push clause's multi-print grid
  // (S2a/R11a) — G1/BRENT score as confirmers, outside the FRED loop's per-id grid.
  const printsOf = (series: string): Promise<Observation[]> =>
    degrade<Observation[]>(`[oil-nowcast] ${series} prints unavailable - estimate points omitted`, "notify", [], () =>
      fetchSeries(series, { since: sinceDaysAgo(OIL_LEVEL_LOOKBACK_DAYS, new Date(ctx.runAt)), now: new Date(ctx.runAt), env: ctx.env }),
    );
  const [g1Prints, brentPrints] = await Promise.all([printsOf(G1.series), printsOf(BRENT.series)]);
  const oilPrints: Readonly<Record<NowcastScoredId, Observation[]>> = { G1: g1Prints, BRENT: brentPrints };
  // "Recent market day": never past the run's UTC date, never a weekend or the source's own holiday; `estimateAnchored` on a print.
  const warnAndDegrade = (msg: string, err: unknown): void => {
    console.warn(`${msg}: ${errMsg(err)}`);
    recordDegrade(msg, errMsg(err), "notify");
  };
  for (const [id, pts] of await intradayNowcastPoints(oilPrints, nowcastCloses, warnAndDegrade)) {
    const finals = finalDates(oilPrints[id] ?? [], id);
    const kept = pts.filter((pt) => pt.date <= ctx.firedDateIso && recentMarketDay(id, pt.date) === pt.date && estimateAnchored(id, finals, pt.date));
    if (kept.length > 0) nowcastPts.set(id, kept);
  }
  if (nowcastPts.size > 0) console.log(`[nowcast] estimated: ${[...nowcastPts].map(([id, p]) => `${id}@${p.map((o) => o.date).join("+")}`).join(", ")}`);
  // Keyed-price feed (F4/F5/NVDA) + the SHARED VIXCLS/VXVCLS legs (threaded into
  // the VT confirmer AND the off-ladder bottom track). Neither aborts the core — both degrade to [].
  // VXNCLS: the VXNT confirmer's own default-window read, its VXN leg's estimate prints.
  const [price, vixLegs, vxnPrints] = await Promise.all([
    scorePriceIndicators(ctx.runAt, ctx.env, ctx.dbFirst),
    fetchVixTermLegs(ctx.runAt, ctx.env, warnAndDegrade, ctx.feeds), // a leg failure is a recorded degrade: VT can fire alerts
    // `trace`, never `notify`: VXNT is display-only (`CHART_ONLY_INDICATORS`), so the push caveat stays off.
    fetchSeries(VXNCLS.series, { now: new Date(ctx.runAt), env: ctx.env }).catch((err: unknown): Observation[] => {
      console.warn(`[nowcast] ${VXNCLS.series} prints unavailable - VXNT estimate points omitted: ${errMsg(err)}`);
      recordDegrade(`[nowcast] ${VXNCLS.series} prints unavailable - VXNT estimate points omitted`, errMsg(err), "trace");
      return [];
    }),
  ]);
  // VT's live-leg points (`vixEstimatePoints`): the EOD row lane reads them all; the scoring grid takes the run's OWN day only, and
  // only while the graft is on (R5's `liveHead` rule, `graftOn` — an earlier live bar, e.g. D−1 on an early-UTC run before the index publisher
  // posts, is a row, never the reading; so is the own day on a post-close intraday run).
  const vixPts = await vixEstimatePoints(ctx, { ...vixLegs, vxn: vxnPrints });
  for (const id of [VT.id, VXNCLS.id].filter((k) => vixPts.has(k)))
    console.log(`[nowcast] estimated: ${id}@${vixPts.get(id)!.map((o) => o.date).join("+")}`);
  const ownDay = (pts: Observation[]): Observation[] => (ctx.graftOn ? pts.filter((p) => p.date === ctx.firedDateIso) : []);
  // The scoring grid's extension — INTRADAY only; the EOD readings and FIN score stay on prints (the notify dial folds the estimate heads).
  const scoringPts: ReadonlyMap<string, Observation[]> = ctx.intraday
    ? new Map([...nowcastPts, ...[...vixPts].map(([id, pts]): [string, Observation[]] => [id, ownDay(pts)])])
    : new Map();
  const extendObs = (id: string, obs: Observation[]): Observation[] => extendWithEstimate(obs, scoringPts.get(id) ?? []);
  for (const t of price.series) ctx.carry(t.id, t.series);
  for (const [id, syms] of PRICE_BATCH_INPUTS) for (const sym of syms) ctx.markFallbackSourced(id, sym); // claimed even when the batch degraded
  for (const [id, ds] of Object.entries(price.estimateDates)) ctx.markEstimateSourced(id, ds); // a `.DE` meta-close D
  // Price cohort publication grid: the US price rows
  // (F4/F5/F6/F8/F13 + DB_*/RS_* legs) share
  // QQQ's calendar, so `price.qqq`'s dates are their grid. A row with its own `calendar` (EXSH_GATE → Xetra
  // EXSH.DE closes) is stamped from `price.calendars` instead. Empty ⇒ no price readings anyway.
  const priceGrid = price.qqq.map((o) => o.date);
  for (const r of [...price.readings, ...price.downside, ...price.rs])
    ctx.recordFeedDates(r.indicator.id, price.calendars[r.indicator.id] ?? priceGrid);
  // VT / VTP read the SHARED VIXCLS/VXVCLS legs (no feed of their own); the front leg's dates are their grid.
  const vixGrid = vixLegs.front.map((o) => o.date);
  ctx.recordFeedDates("VT", vixGrid);
  ctx.recordFeedDates("VTP", vixGrid);
  // The fast-path confirmers (G1, EBP, R6, R7, CG, VT, BRENT, VTP, ECY, NG, VXNT) scored from the ONE
  // FAST_CONFIRMERS table — the SINGLE source `readings` derives from; each degrades to the empty
  // contribution (core still scores). STARTED not awaited: ECY's gate is GT's scored state (only after
  // GLOBAL_FEEDS, run-cycle-feeds.ts), so it floats, awaited after `feed("GT")`; `readings` order byte-identical.
  let resolveGtState!: (s: State | null) => void;
  const gtStateForEcy = new Promise<State | null>((res) => {
    resolveGtState = res;
  });
  // Hoisted ONCE above the map (else both eager reads fire per confirmer). Pinned by run.wiring.test.ts's DFII10 call count.
  const ecyCtx = {
    // The run's ONE CAPE fetch (memoized in `createRunCtx`; a full run's F7 seed reuses it) — the restate's ECY input. null = failed:
    // an intraday blip is a trace (the next run re-fetches), a full/EOD run's a notify — ECY records no second, `notify` omission.
    f7: degrade<Observation[] | null>("[ECY] CAPE fetch failed - ECY omitted this run", ctx.intraday ? "trace" : "notify", null, () => ctx.feeds.fetchCape()),
    // R4 deep-arm fetch → `fetchR4DeepInputs`, run-dbfirst.ts.
    dfii10: fetchR4DeepInputs(ctx.dbFirst, seriesScorerFor, ctx.runAt, ctx.env),
    gtState: gtStateForEcy,
    now: ctx.clock().slice(0, 10),
  };
  const confirmerCtx = {
    calib,
    runAt: ctx.runAt,
    env: ctx.env,
    dbFirst: { ...ctx.dbFirst, seriesScorerFor },
    vixFront: vixLegs.front,
    vixBack: vixLegs.back,
    ecy: ecyCtx,
    extendObs,
    feeds: ctx.feeds,
  };
  // `conf.<id>` stamps each confirmer's settle time (fetch + score) — it floats across tracks + globals, so the
  // phase marks alone can't name a slow one (mirrors `ecb.<id>`, run-cycle-feeds.ts).
  const scoredConfirmersP = Promise.all(
    FAST_CONFIRMERS.map((c) => c.score(confirmerCtx).finally(() => markPhase(`conf.${c.id}`))),
  );

  // ⚠ Track scoring runs in the FETCH phase (not `assembleRun`, which receives already-scored tracks):
  // anything a track needs from the store must be written by a PRIOR cycle. Do NOT move a tail seed
  // earlier — merge a live tail in the track (`fetchDailyCloses` memoizes per-symbol per-run, free).
  // Off-ladder tracks (slow/bottom/pension) from the ONE generic TRACKS list; all concurrent, each
  // degrades to a null verdict without aborting the core.
  const scored = await Promise.all(
    TRACKS.map((t) =>
      t.score({
        store: ctx.store,
        env: ctx.env,
        qqq: price.qqq,
        vixFront: vixLegs.front,
        vix3mBack: vixLegs.back,
        runAt: ctx.runAt,
        dbFirst: { ...ctx.dbFirst, seriesScorerFor },
      }),
    ),
  );
  return { nowcastPts, vixPts, nowcastCloses, oilPrints, scoringPts, price, confirmerCtx, scoredConfirmersP, resolveGtState, scored };
}

export function recordConfirmers(
  ctx: RunBase,
  scoredConfirmers: Awaited<Awaited<ReturnType<typeof startConfirmersAndTracks>>["scoredConfirmersP"]>,
  scoringPts: ReadonlyMap<string, Observation[]>,
): void {
  // Record each daily confirmer's OWN feed grid. R6/R7/CG
  // carry `feedDates`; VT/VTP were
  // recorded from the shared vix legs at the fetch site; weekly/monthly confirmers grid by cadence.
  scoredConfirmers.forEach((s, i) => {
    if (s.feedDates !== undefined) ctx.recordFeedDates(FAST_CONFIRMERS[i]!.id, s.feedDates);
    ctx.markEstimateSourced(FAST_CONFIRMERS[i]!.id, s.estimateDates ?? []);
  });
  // recordRun persists each confirmer's `.at(-1)`; the sweep fills the rest of its window (a late/batched print).
  // C1: an intraday grid's nowcast dates are `estimated` rows (`buildEstimateRows`), never a sweep's final print; the head is sliced anyway.
  scoredConfirmers.forEach((s, i) => {
    const id = FAST_CONFIRMERS[i]!.id;
    const est = new Set((scoringPts.get(id) ?? []).map((p) => p.date));
    ctx.carry(id, s.series.filter((r, j) => j === s.series.length - 1 || !est.has(r.date)));
  });
}
