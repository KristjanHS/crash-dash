/** GET /api/series?id=&limit=[&from=&to=][&market=&mode=][&mult=][&detail=1] — one indicator's
 *  history, oldest→newest (openapi.yaml `getSeries`). `id` required; `limit` default 365, clamp 1..4000. */
import { getStore, type CalibrationParam, type SeriesPoint, type ReadStore } from "../src/store.js";
import {
  indicatorReadingSeries,
  indicatorLegSeries,
  postInversionCutSeries,
  drawdownCutSeries,
  shortMoveSeries,
} from "../src/scorers-core.js";
import {
  activeLegs,
  activeLegBounds,
  effectiveCuts,
  cusumParams,
} from "../src/domain-legs.js";
import {
  resolveCuts,
  scaleCuts,
  hasSynthPriors,
  calibLegsFor,
  type CalibrationCuts,
} from "../src/domain-cuts.js";
import {
  fxHavenMoveSeries,
  bullSteepenerLegSeries,
  ecyExpensiveCutSeries,
  levelBandValues,
  levelBandCuts,
  creditBridgeCutSeries,
  oatVelocityZ,
  dispersionState,
} from "../src/scorers-composite.js";
import {
  FXH_AMBER,
  FXH_RED,
  DISP_CORR,
  DISP_CORR_P,
  DISP_CORR_P_WINDOW,
  DISP_CORR_P_MIN_OBS,
  HIGH_WINDOW_SHORT,
} from "../src/family-descriptor-rows.js";
import {
  downsideBreakReadingSeries,
  breadthCutSeries,
  breadthConfig,
  breadthDistSeries,
  spliceChainedIndex,
  CHAIN_QUIET_RATIO,
} from "../src/scorers-price.js";
import {
  asymConfirmedStateSeries,
  velocitySigmaZSeries,
  velocitySigmaDepth,
  velocityCusumSeries,
} from "../src/domain-fold.js";
import {
  CONFIRM_CLOSES,
  VELOCITY_WINDOW,
  type Direction,
  type Indicator,
  type Observation,
} from "../src/domain-types.js";
import { DOWNSIDE_DETECTOR_IDS } from "../src/registry-price.js";
import { CG, VTP } from "../src/registry-composite.js";
import { readInputSeries, warnMissingInput } from "../src/input-series.js";
import {
  GATES,
  belowMAFlags,
  maValues,
  inclusiveRollingMax,
  atOrAboveCutFlags,
  atOrAboveRollingMaxFlags,
  rollingMaxValues,
  type GateDef,
} from "../src/gates.js";
// `confirmClosesFor`: never restate the confirm buffer as a literal — read the scorer's own function.
import { confirmClosesFor } from "../src/family-table.js";
import {
  CHART_DESCRIPTOR_OF,
  COMPOSITE_LEVEL_BAND_OF,
  VELOCITY_Z_CONSTANTS_OF,
  DETAIL_WINDOW,
  GEO_HYBRID_DESCRIPTOR_OF,
  POINT_BAND_CUTS_OF,
  POINT_BAND_SIGMA_CUTS,
  SIGMA_REF_KEY,
  CHART_PARAMS_OF,
  POST_INVERSION_BAND,
  R1_DRAWDOWN_BAND,
  R8_MEAN_CUT_BANDS,
  F3_VELOCITY_BAND,
  RATIO_DESCRIPTOR_OF,
  SMOOTHED_LEVEL_OF,
} from "../src/family-descriptor-rows.js";
// From the defining file `src/percentile.js` (zero-import leaf); `src/slow.js` only re-exports them.
import { expandingPercentile, rollingPercentile } from "../src/percentile.js";
import { COMPOSITE_RESTATE_OF, cgRows, ratioSpreadReadingSeriesFromValues, readPathHeadRows } from "../src/scorers-composite.js";
import { decisionAt } from "../src/scorers-core.js";
// The run path's own warmup-union merge + the one `warmup: true` feed spec — never re-derived here.
import { resolveDbFirstArm, type DbFirstFeedSpec } from "../src/series-db-first.js";
import { CG_DB_FIRST_FEED } from "../src/db-first-specs.js";
import { readFxhLegs, fxhLegLimit, type FxhLegs } from "../src/fxh-legs.js";
import { resolveBands, resolveMultiplier, earlierCut } from "../src/threshold-config.js";
import { loadSynthHistories, synthesizedCalib } from "../src/synth-cuts.js";
import type { SeriesPointDTO, SeriesResponse } from "../src/api/types.js";
import {
  META,
  parseLimit,
  rejectUnknownParams,
  serveRedactable,
  VINTAGE_HEADERS,
} from "../src/api/http.js";
import { isLicensedEstimateId, isLicensedId } from "../src/licensed.js";
import { memoByVintage } from "../src/api/vintage-memo.js";
import { isProvisional } from "../src/intraday.js";
import { ANCHOR_ROSTER, unanchoredEstimateDates } from "../src/estimated.js";
import { estimateSlot } from "../src/estimate-slot.js";
import { legProxy } from "../src/scoreboard.js";
// The value-only id set is single-sourced from api/status.ts — do NOT re-list the ids here.
import { CUTLESS_CHART_IDS, PLACEHOLDER_STATE_IDS } from "./status.js";
import { readEnv } from "../src/config.js";
import { chainedSeries, CHAINED_SERIES_HEAD } from "../src/api-routes/series-chained.js";

/** A warn sink — `console.warn` in production, an injected recorder under test. */
type Warn = (...args: unknown[]) => void;

/** One request's read context. `warn` / `multiplierOf` default to `console.warn` / `resolveMultiplier`
 *  wherever a caller omits them. `now` is required: the entry (`GET`) reads the wall clock once. */
type SeriesRead = { store: ReadStore; now: Date; warn?: Warn; multiplierOf?: (id: string) => number };

/** `handle`'s injectable seams; each default is the production one `GET` runs with. */
export interface SeriesSeams {
  /** Clock for the input-series staleness gate — REQUIRED: `GET` (the entry) reads the request's wall clock once. */
  now: Date;
  warn?: Warn;
  /** The per-id threshold multiplier the cut gates and leg cuts read (default `resolveMultiplier`). */
  multiplierOf?: (id: string) => number;
}

/** R7 per-point whitelist: date + state (+ leg/provisional/estimated/gates), value/delta20 null. A new field stays OUT. */
function redactPoint(p: SeriesPointDTO): SeriesPointDTO {
  return {
    date: p.date,
    value: null,
    delta20: null,
    rawState: p.rawState,
    state: p.state,
    ...(p.leg !== undefined ? { leg: p.leg } : {}),
    ...(p.provisional ? { provisional: p.provisional } : {}),
    ...(p.estimated ? { estimated: p.estimated } : {}),
    ...(p.gates !== undefined ? { gates: p.gates } : {}),
  };
}

/** R7 whitelist: a licensed id's public response — every point through `redactPoint`; top level only
 *  names/unit/fold/valueOnly/proxy. A new field stays OUT until listed here. */
export function redactSeries(body: SeriesResponse): SeriesResponse {
  return {
    indicatorId: body.indicatorId,
    label: body.label,
    ...(body.longLabel !== undefined ? { longLabel: body.longLabel } : {}),
    ...(body.unit !== undefined ? { unit: body.unit } : {}),
    points: body.points.map(redactPoint),
    ...(body.confirmCloses !== undefined ? { confirmCloses: body.confirmCloses } : {}),
    ...(body.valueOnly !== undefined ? { valueOnly: body.valueOnly } : {}),
    // The proxy join date carries no licensed value.
    ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
    redacted: true,
  };
}

/** An unlicensed id whose estimate rows carry a licensed lead (`isLicensedEstimateId`): in the public response, each `estimated`
 *  point goes through `redactPoint` and the `oilEst` slot (that estimate's own value) is dropped; prints pass as-is. */
export function redactEstimates(body: SeriesResponse): SeriesResponse {
  const { oilEst: _estimate, ...rest } = body;
  return { ...rest, points: body.points.map((p) => (p.estimated ? redactPoint(p) : p)) };
}

/** R7 response rule: an `isLicensedId` id serves through `serveRedactable` with `redactSeries`; an id whose estimate rows
 *  carry an `isLicensedId` lead, with `redactEstimates`; anything else unchanged, `VINTAGE_HEADERS`. */
async function respondSeries(body: SeriesResponse): Promise<Response> {
  if (isLicensedId(body.indicatorId)) return serveRedactable(body, redactSeries);
  if (isLicensedEstimateId(body.indicatorId)) return serveRedactable(body, redactEstimates);
  return Response.json(body, { headers: VINTAGE_HEADERS });
}

/** Store→wire seam (Stage 2.2): `SeriesPoint` now carries the STORED scorer cut, but the wire
 *  `bandCuts` stays the drawn-cut map until a read path consumes the stored one — drop it here. */
function stripStoredCuts(points: SeriesPoint[]): Omit<SeriesPoint, "bandCuts">[] {
  return points.map(({ bandCuts: _stored, ...rest }) => rest);
}

/** Store→wire seam (A1/B1): `runAt` is store-only; its wire form is `provisional: true` (key omitted when final).
 *  `estimated: true` is the STORED marker (E3), on a provisional or an EOD row alike; same key as `api/lab.ts` L3. */
function flagProvisional<P extends { date: string }>(points: readonly P[], id: string): P[] {
  return points.map((p) => {
    const { runAt, estimated, ...rest } = p as P & { runAt?: string; estimated?: boolean };
    const est = estimated === true ? { estimated: true } : {};
    return (isProvisional({ date: p.date, runAt }, id) ? { ...rest, provisional: true, ...est } : { ...rest, ...est }) as P;
  });
}

/** Rebuilt-point branches drop store-only `runAt` and the E3 marker; re-key both by date so `flagProvisional` sees them (I1). */
function withRunAt<P extends { date: string }>(points: P[], stored: readonly SeriesPoint[]): P[] {
  const runAt = new Map(stored.flatMap((s) => (s.runAt ? [[s.date, s.runAt] as const] : [])));
  const est = new Map(stored.flatMap((s) => (s.estimated === true ? [[s.date, { estimated: true }] as const] : [])));
  return points.map((p) => ({ ...p, ...(runAt.has(p.date) ? { runAt: runAt.get(p.date) } : {}), ...est.get(p.date) }));
}

/** Date → persisted scorer cuts (wire-keyed), for the stored-cut-only read paths. */
function storedCutsByDate(points: readonly SeriesPoint[]): Map<string, Readonly<Record<string, number>>> {
  const map = new Map<string, Readonly<Record<string, number>>>();
  for (const p of points) if (p.bandCuts) map.set(p.date, p.bandCuts);
  return map;
}

/** The one wire-cut emission rule: a finite cut ⇒ `out[key] = v`; null/undefined/NaN/±Infinity ⇒ the key
 *  stays ABSENT (a chart gap, never 0/null). The stored-verbatim post-inversion arms in
 *  `withPostInversionCut` gate on presence only and do NOT route through here. */
export function putFiniteCut(out: Record<string, number>, key: string, v: number | null | undefined): void {
  if (v != null && Number.isFinite(v)) out[key] = v;
}

const DEFAULT_LIMIT = DETAIL_WINDOW;
// 4000 covers the deepest ~15y daily series (~3,780 pts) the one-shot backfill seeds (design §4.6).
export const MAX_LIMIT = 4000;
// Read depth for full-history input branches: deepest input (DGS10 ≈16k rows) tops backfill's 12k probe.
const INPUT_SERIES_LIMIT = 20_000;

// Safety margin on top of the derived pad minimum, so a pad is never correct with a zero margin.
const LOOKBACK_MARGIN = 15;

/** Extra leading history (beyond `limit`) so every visible point has full velocity lookback + a settled
 *  confirm buffer + (for a rolling-σ id) σ-depth at the left edge. Derived per-id, never hardcoded — a new
 *  `velocityWindow`/confirm buffer moves that id's pad alone. Left-edge fidelity pinned by
 *  `api/series.recompute.test.ts` (R2 w=20, F1 w=30, F11 w=60, F9 σ-depth). */
export function lookbackPadFor(ind: Indicator): number {
  const w = ind.velocityWindow ?? VELOCITY_WINDOW;
  const sigma = ind.thresholds.velocitySigma;
  return (
    Math.max(w, VELOCITY_WINDOW + confirmClosesFor(ind.id)) +
    (sigma ? velocitySigmaDepth(sigma) + w : 0) +
    LOOKBACK_MARGIN
  );
}

/** Whether the on-read recompute faithfully reproduces this id's confirmed states — TRUE only for
 *  standard FRED level/velocity ids scored end-to-end from the stored series. Excludes `derived`
 *  bespoke scorers, bands-less ids, geo-hybrids, composite level/restate ids, and cooldown carriers.
 *  `supportsRecompute is true for F1/F2` in `api/series.recompute.test.ts` pins the F1/F2 case. */
export function supportsRecompute(ind: Indicator): boolean {
  const t = ind.thresholds;
  const hasBands =
    t.amberLevel !== undefined ||
    t.redLevel !== undefined ||
    t.amberVelocity !== undefined ||
    t.redVelocity !== undefined ||
    // A `thresholds: {}` id with a `CALIB_MAP` leg would else serve an all-Green stored ribbon;
    // recompute off the resolved σ-cuts instead. Standing guard, no live example today.
    calibLegsFor(ind.id).level ||
    calibLegsFor(ind.id).velocity;
  return (
    hasBands &&
    // Only a SCORED derived leg disqualifies; a `displayOnly` block (F1's lowRise) stays exact.
    (ind.derived === undefined || ind.derived.displayOnly === true) &&
    !GEO_HYBRID_DESCRIPTOR_OF[ind.id] &&
    // Composite level/restate ids re-score through their own multi-leg scorer — a different model,
    // and this branch wins the dispatch, so excluding them is what routes them to their own branch.
    !COMPOSITE_LEVEL_BAND_OF[ind.id] &&
    !COMPOSITE_RESTATE_OF[ind.id] &&
    ind.postInversionCooldown === undefined
  );
}

const RANGE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse optional `from`/`to`: `null` field ⇒ open bound; a `Response` ⇒ 400 for a malformed date or a
 *  non-month-start (`YYYY-MM-01` grid, `no-store`). An empty window is NOT an error (honest empty payload). */
function parseRange(params: URLSearchParams): { from: string | null; to: string | null } | Response {
  const out: { from: string | null; to: string | null } = { from: null, to: null };
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (!RANGE_DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
      return Response.json({ error: `${key} must be a valid YYYY-MM-DD date` }, { status: 400 });
    }
    if (!raw.endsWith("-01")) {
      return Response.json(
        { error: `${key} must be a month-start date (YYYY-MM-01)` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    out[key] = raw;
  }
  return out;
}

/** `?mult=<m>` display-only what-if, applied ON TOP of the config multiplier (`m<1` fires earlier,
 *  `m>1` later, `m=1` identity). Absent/empty/non-numeric/≤0 ⇒ `null` (OFF); off the `[0.5,2.0]`
 *  step-`0.25` grid ⇒ 400 `no-store` (never clamped — a clamp mints a fresh edge-cache key). */
const MULT_MIN = 0.5;
const MULT_MAX = 2.0;
const MULT_STEP = 0.25;
function parseMult(raw: string | null): number | null | Response {
  if (raw === null || raw === "") return null;
  const m = Number(raw);
  if (!Number.isFinite(m) || m <= 0) return null;
  // Every grid value (m × 4 ∈ 2..8) is exact in binary, so the integer test never false-negatives.
  if (m < MULT_MIN || m > MULT_MAX || !Number.isInteger(m * (1 / MULT_STEP))) {
    return Response.json(
      { error: `mult must be on the ${MULT_MIN}..${MULT_MAX} grid in steps of ${MULT_STEP}` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return m;
}

/** Compose `?mult` onto a resolved cut set via the shared `scaleCuts` (src/domain-cuts.ts) that
 *  `resolveCuts`'s config multiplier also rides — one direction table, no drift. */
function applyMult(cuts: CalibrationCuts, direction: Direction, m: number): CalibrationCuts {
  return scaleCuts(cuts, direction !== "LOW", m);
}

/** Recompute the last `limit` points' confirmed states under the shared/null-row resolved cuts (the SAME
 *  the notify path scores). Fetches `limit + lookbackPadFor` leading points, re-scores, trims; only
 *  `rawState`/`state` change vs the stored series. */
async function recomputedSeries(
  { store, warn = console.warn }: SeriesRead,
  indicator: Indicator,
  limit: number,
  mult: number | null,
): Promise<{
  points: SeriesPointDTO[];
  effAmber: number | null;
  effRed: number | null;
  scorerLegs: string[];
  legBounds: ReturnType<typeof activeLegBounds>;
}> {
  // Tolerant like /api/indicators: a calibration-read blip degrades to convention cuts, never a 500.
  const calib = await store.getCalibration().catch((err: unknown): CalibrationParam[] => {
    warn(`[series] ${indicator.id} calibration read failed - re-scoring on convention cuts:`, err);
    return [];
  });
  const direction = indicator.direction ?? "HIGH";
  // `synthesizedCalib` injects runtime rows for synthPrior ids (F3/F9/F11) so this ribbon scores the
  // SAME cuts the notify path fired; identity for every other id. Keep the `hasSynthPriors` guard —
  // it is load-bearing for COST (`loadSynthHistories` = four ~9,400-row reads), never for uniformity.
  // Memoized per vintage off a one-row `getLastAlert`; a null verdict bypasses the memo.
  const histories = hasSynthPriors(indicator.id)
    ? await memoByVintage(
        "synth",
        (await store.getLastAlert().catch(() => null))?.firedAt,
        () => loadSynthHistories(store),
        // Empty map = the loader swallowed a store failure — do not pin it for the vintage.
        { cacheIf: (m) => m.size > 0 },
      )
    : undefined;
  const synthCalib = synthesizedCalib(indicator, calib, histories);
  const cuts =
    mult === null
      ? resolveCuts(indicator.id, synthCalib, direction)
      : applyMult(resolveCuts(indicator.id, synthCalib, direction), direction, mult);
  // Worst-of effective cuts — scalars riding the envelope, not `points[]`.
  const { effAmber, effRed } = effectiveCuts(indicator, cuts);
  const stored = await store.getSeries(indicator.id, limit + lookbackPadFor(indicator));
  const observations: Observation[] = stored.map((p) => ({ date: p.date, value: p.value }));
  // Reading + per-day leg series are index-aligned before the slice; same `-limit` keeps them paired.
  const readings = indicatorReadingSeries(indicator, observations, cuts).slice(-limit);
  const legs = indicatorLegSeries(indicator, observations, cuts).slice(-limit);
  const states = readings.map((r) => r.state);
  const points = readings.map((r, i) => ({
    date: r.date,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: states[i]!,
    ...(legs[i] ? { leg: legs[i] } : {}),
  }));
  // Synth-prior F3: attach each date's persisted scorer cut as wire-only `bandCuts` (null/absent ⇒ no
  // key, a chart gap, never an on-read recompute).
  const bandRows = POINT_BAND_CUTS_OF[indicator.id];
  const pointsOut = bandRows ? attachSynthBandCuts(points, bandRows, storedCutsByDate(stored)) : points;
  return {
    points: withRunAt(pointsOut, stored),
    effAmber,
    effRed,
    scorerLegs: activeLegs(indicator, cuts),
    // Rides the envelope beside `scorerLegs`, same resolved cuts — the caption prints these when
    // no cut line is in frame (caption-redesign #7), never a client-side literal.
    legBounds: activeLegBounds(indicator, cuts),
  };
}

/** Attach F3's per-date persisted scorer cuts as wire-only `bandCuts`; a null/absent cut emits no key
 *  (a chart gap), never an on-read recompute. */
function attachSynthBandCuts(
  points: SeriesPointDTO[],
  bandRows: ReadonlyArray<{ level: "amber" | "red"; key: string }>,
  storedCuts?: ReadonlyMap<string, Readonly<Record<string, number>>>,
): SeriesPointDTO[] {
  return points.map((p) => {
    const storedRow = storedCuts?.get(p.date);
    const bandCuts: Record<string, number> = {};
    for (const row of bandRows) putFiniteCut(bandCuts, row.key, storedRow?.[row.key]);
    putFiniteCut(bandCuts, F3_VELOCITY_BAND.key, storedRow?.[F3_VELOCITY_BAND.key]);
    return Object.keys(bandCuts).length > 0
      ? { ...p, bandCuts: { ...(p.bandCuts ?? {}), ...bandCuts } }
      : p;
  });
}

/** FXH bespoke branch (gated on `CHART_DESCRIPTOR_OF[id].branch === "fxHaven"`, mode-INVARIANT). Reads
 *  the three `CMP_FXH_*` stored closes via `readFxhLegs` (the cron scorer's own seam — anti-drift),
 *  recomputes the −20d haven-bid moves via `fxHavenMoveSeries`, attaches them as `havenLegs`; states
 *  pass through (leg ink, not a re-score). `effAmber/effRed` = FXH_AMBER/FXH_RED. `null` on read fail
 *  ⇒ degrade to the stored series; never throws. */
async function fxHavenSeries(
  { store, warn = console.warn }: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[]; effAmber: number; effRed: number } | null> {
  let legs: FxhLegs | null;
  try {
    legs = await readFxhLegs(store, fxhLegLimit(limit));
  } catch (err) {
    warn(`[series] ${indicator.id} haven-leg read failed - serving the stored series, no havenLegs:`, err);
    return null;
  }
  if (!legs) return null;
  const { usEur, chfUsd, jpyUsd } = legs;

  const { dates, eurMove, chfMove, jpyMove } = fxHavenMoveSeries(usEur, chfUsd, jpyUsd);
  const legsByDate = new Map(
    dates.map((d, i) => [d, { eur: eurMove[i]!, chf: chfMove[i]!, jpy: jpyMove[i]! }]),
  );

  const stored = stripStoredCuts(await store.getSeries(indicator.id, limit));
  const points: SeriesPointDTO[] = stored.map((p) => {
    const legs = legsByDate.get(p.date);
    return legs ? { ...p, havenLegs: legs } : { ...p };
  });
  // Bands via `resolveBands("FXH", …, true)` — the SAME seam `fxHavenReadingSeries` scores through
  // (anti-drift). Not `effectiveCuts`: FXH has no calibration override; if it gets one, route it there.
  const { amber: effAmber, red: effRed } = resolveBands("FXH", FXH_AMBER, FXH_RED, true);
  return { points, effAmber, effRed };
}

/** R7 bespoke branch (mode-INVARIANT). Reads the three cron leg rows full-depth, runs
 *  `bullSteepenerLegSeries` (anti-drift), attaches the two 20d yield-change legs + four per-day ranked
 *  `bandCuts.r7*` + the `shortEndDriven` gate; states pass through. Missing leg ⇒ `null` (degrade,
 *  warn once); a non-finite cut omits its key (a gap, never 0). */
async function bullSteepenerSeries(
  { store, now, warn, multiplierOf = resolveMultiplier }: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[] } | null> {
  const legIds = CHART_DESCRIPTOR_OF[indicator.id]!.seriesIds!;
  const inputs = await readInputSeries(store, legIds, INPUT_SERIES_LIMIT, { now });
  const absent = legIds.filter((id) => !inputs.has(id));
  if (absent.length > 0) {
    for (const id of absent) warnMissingInput(id, "series:bullSteepener", warn);
    return null; // missing input rows ⇒ degrade to the stored ribbon (no bullLegs), never a dark card
  }
  const [spread, dgs2, dgs10] = legIds.map((id) => inputs.get(id)!) as [
    Observation[],
    Observation[],
    Observation[],
  ];
  const legs = bullSteepenerLegSeries(spread, dgs2, dgs10, multiplierOf(indicator.id));
  const byDate = new Map(
    legs.dates.map((d, i) => [
      d,
      {
        drop: legs.drop[i]!,
        steep: legs.dSteep[i]!,
        r7DropAmber: legs.cuts.dropAmber[i]!,
        r7DropRed: legs.cuts.dropRed[i]!,
        r7SteepAmber: legs.cuts.steepAmber[i]!,
        r7SteepRed: legs.cuts.steepRed[i]!,
        shortEndDriven: legs.shortEndDriven[i]!,
      },
    ]),
  );
  const stored = stripStoredCuts(await store.getSeries(indicator.id, limit));
  const points: SeriesPointDTO[] = stored.map((p) => {
    const d = byDate.get(p.date);
    if (!d) return { ...p };
    // Omit each non-finite (warm-up head) cut key ⇒ GAP, not 0.
    const bandCuts: Record<string, number> = {};
    for (const key of ["r7DropAmber", "r7DropRed", "r7SteepAmber", "r7SteepRed"] as const) {
      putFiniteCut(bandCuts, key, d[key]);
    }
    return {
      ...p,
      bullLegs: { drop: d.drop, steep: d.steep },
      ...(Object.keys(bandCuts).length > 0 ? { bandCuts } : {}),
      gates: { shortEndDriven: d.shortEndDriven },
    };
  });
  return { points };
}

/** ECY join branch — stored rows VERBATIM plus the drawn amber cut as `bandCuts[ecyAmber]`: the cron-
 *  persisted cut verbatim, else re-derived per month from the F7 × DFII10 join via `ecyExpensiveCutSeries`
 *  (the scorer's own boundary; mirrors `pointBandCutSeries`'s persisted-else-derived seam). NOT
 *  `pointBandCutSeries`'s expanding percentile (it disagreed with the ribbon over the short ECY tail).
 *  Missing/failed input ⇒ passthrough with no cut key (a gap), never a throw. */
async function ecyJoinSeries(
  { store, now, warn = console.warn }: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[] }> {
  const desc = CHART_DESCRIPTOR_OF[indicator.id]!;
  const [capeId, dfiiSeries] = desc.seriesIds as [string, string];
  const rawStored = await store.getSeries(indicator.id, limit);
  const stored = stripStoredCuts(rawStored);
  let cutByDate: Map<string, number> | null = null;
  try {
    // DFII10-bounded (2003→), so a MAX_LIMIT read of the monthly CAPE store covers every joinable month.
    const [f7, dfiiMap] = await Promise.all([
      store.getSeries(capeId, MAX_LIMIT),
      readInputSeries(store, [dfiiSeries], INPUT_SERIES_LIMIT, { now }),
    ]);
    const dfii10 = dfiiMap.get(dfiiSeries);
    if (dfii10 === undefined) warnMissingInput(dfiiSeries, "series:ecyJoin", warn);
    cutByDate =
      dfii10 === undefined
        ? null
        : new Map(
            ecyExpensiveCutSeries(
              f7.map((p) => ({ date: p.date, value: p.value })),
              dfii10,
            ).map((c) => [c.date, c.cut]),
          );
  } catch (err) {
    warn(`[series] ${indicator.id} ${capeId}/${dfiiSeries} join read failed - no derived cut:`, err);
    cutByDate = null;
  }
  const keys = (desc.bandCuts ?? []).filter((b) => b.level === "amber").map((b) => b.key);
  const points: SeriesPointDTO[] = stored.map((p, i) => {
    const derived = cutByDate?.get(p.date);
    const bandCuts: Record<string, number> = {};
    for (const k of keys) {
      // Persisted cut verbatim; re-derived join cut only on legacy/pre-column rows.
      const sc = rawStored[i]?.bandCuts?.[k];
      const cut = sc != null && Number.isFinite(sc) ? sc : derived;
      putFiniteCut(bandCuts, k, cut);
    }
    return Object.keys(bandCuts).length > 0 ? { ...p, bandCuts } : { ...p };
  });
  return { points };
}

/** Gate branch (Case 4) — GATES ids (F4/F8/G1/BRENT) get stored points VERBATIM plus wire-only per-point
 *  `gates` flags: the non-drawable AND-conditions recomputed via `belowMAFlags`. Mode-INVARIANT. Fetches
 *  `limit + window` for a full left-edge MA lookback; a cross-series gate joins over the date-INTERSECTION
 *  (mirror of the scorer's alignByDate). A failed/short aux read or unresolved gate omits the key — the
 *  client draws that segment normally (fail-safe, no grey). */
async function gatedSeries(
  { store, multiplierOf = resolveMultiplier, warn = console.warn }: SeriesRead,
  indicator: Indicator,
  limit: number,
  // Rows kept BEYOND `limit` for a caller re-scoring over its own lookback (DISP's rolling p90). 0 else.
  extraPad = 0,
): Promise<{ points: SeriesPointDTO[] }> {
  const defs = GATES[indicator.id]!;
  const visible = limit + extraPad;
  // Only LOOKBACK rules need lead-in (`atOrAboveCut` contributes 0; the seed keeps `pad` a number for
  // an all-cut id). ⚠ `atOrAboveRollingMax` MUST be in this max (~3y window) or G1/BRENT flags come
  // back `null` everywhere — a silent no-op that looks like a working gate.
  const pad = Math.max(0, ...defs.map((d) => (d.rule === "atOrAboveCut" ? 0 : d.window)));
  const stored = stripStoredCuts(await store.getSeries(indicator.id, visible + pad));
  const points: SeriesPointDTO[] = stored.slice(-visible).map((p) => ({ ...p }));
  const offset = stored.length - points.length;
  // One multiplier read per request, shared by every cut gate — the scorer's own seam, no drift.
  const mult = multiplierOf(indicator.id);
  const flagFor = await Promise.all(
    defs.map(async (def: GateDef): Promise<(i: number, date: string) => boolean | null> => {
      if (def.rule === "atOrAboveCut") {
        // Cut gates are always "own" (GateDef union): the rule reads the gated id's own stored value.
        const flags = atOrAboveCutFlags(stored.map((p) => p.value), earlierCut(def.cut, true, mult));
        return (i) => flags[offset + i] ?? null;
      }
      if (def.rule === "atOrAboveRollingMax") {
        // Trailing-peak gates are always "own"; no multiplier — the "cut" is the id's own trailing peak.
        const flags = atOrAboveRollingMaxFlags(stored.map((p) => p.value), def.window);
        return (i) => flags[offset + i] ?? null;
      }
      if (def.source === "own") {
        const flags = belowMAFlags(stored.map((p) => p.value), def.window, def.maMult);
        return (i) => flags[offset + i] ?? null;
      }
      // Cross-series gate: the other id's stored history restricted to the DATE-INTERSECTION with the
      // gated id's calendar before the MA runs — mirror of the scorer's alignByDate. Own dates missing
      // from aux get no key (unknown).
      const aux = await store.getSeries(def.source, visible + pad).catch((err: unknown) => {
        warn(`[series] ${indicator.id} gate source ${def.source} read failed - gate key omitted:`, err);
        return [];
      });
      const ownDates = new Set(stored.map((p) => p.date));
      const joint = aux.filter((p) => ownDates.has(p.date));
      const auxFlags = belowMAFlags(joint.map((p) => p.value), def.window, def.maMult);
      const byDate = new Map(joint.map((p, i) => [p.date, auxFlags[i]] as const));
      return (_i, date) => byDate.get(date) ?? null;
    }),
  );
  points.forEach((p, i) => {
    defs.forEach((def, d) => {
      const flag = flagFor[d]!(i, p.date);
      if (flag !== null) (p.gates ??= {})[def.key] = flag;
    });
  });
  // Trailing-peak gate's own line: ship the prior-window peak per point (no client lead fetch).
  const peakDef = defs.find((d) => d.rule === "atOrAboveRollingMax");
  if (peakDef) {
    const peaks = rollingMaxValues(stored.map((p) => p.value), peakDef.window);
    points.forEach((p, i) => {
      const v = peaks[offset + i];
      if (v != null) p.rollingMax = v;
    });
  }
  return { points };
}

// Leading rows beyond `limit` so the rolling p90 AND confirm buffer are settled at the left edge.
const DISP_PAD = DISP_CORR_P_WINDOW + CONFIRM_CLOSES;

/** DISP read path: re-score stored corr(value)+basket(decision) through the CURRENT `dispersionState`
 *  + confirm buffer so the ribbon carries today's tiers across all history. Wraps gatedSeries for the
 *  gate flags. ⚠ Confirm depth AND fold primitive must match the scorer (`asymConfirmedStateSeries` at
 *  `confirmClosesFor`) — never restate a literal here. */
async function dispersionSeries(
  rd: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[] }> {
  const { points: padded } = await gatedSeries(rd, indicator, limit, DISP_PAD);
  const cut = earlierCut(DISP_CORR, true, (rd.multiplierOf ?? resolveMultiplier)(indicator.id)); // DISP mult 1.0 ⇒ cut 0.75
  // The scorer masks a degenerate day's corr to NaN before ranking; mask the stored forced 0 back out
  // or the read-path p90 sits below the cron's.
  const corrP90 = rollingPercentile(
    padded.map((p) => (p.value === 0 ? NaN : (p.value ?? NaN))),
    DISP_CORR_P,
    DISP_CORR_P_WINDOW,
    DISP_CORR_P_MIN_OBS,
  );
  const rawStates = padded.map((p, i) => dispersionState(p.value ?? NaN, p.decision ?? NaN, cut, corrP90[i]));
  const confirmed = asymConfirmedStateSeries(rawStates, confirmClosesFor(indicator.id));
  padded.forEach((p, i) => {
    p.rawState = rawStates[i]!;
    p.state = confirmed[i]!;
    // The deepener cut as its own line — the SAME `corrP90` the state deepens against, written before
    // the slice so it stays date-aligned. A warm-up NaN is left off the wire (a gap), never a low cut.
    if (Number.isFinite(corrP90[i])) p.corrP90 = corrP90[i];
  });
  return { points: padded.slice(-limit) };
}

/** The downside-break detector ids (registry DOWNSIDE_DETECTORS). */
const DOWNSIDE_IDS = new Set(DOWNSIDE_DETECTOR_IDS);
// F5/SPCONC/HCX take per-point cuts on a DERIVED series (`breadthDistSeries`), so `pointBandCutSeries`
// branches here BEFORE the RATIO_DESCRIPTOR_OF path and plots `dist` so line and band share one array (R3).
const BREADTH_DIST_BANDCUT_IDS = new Set(["F5", "SPCONC", "HCX"]);
// Only these breadth ids COMPOUND a chained index (arbitrary base per fetch depth) — `spliceChainedIndex`
// re-anchors before `breadthDistSeries`. F5/SPCONC are base-invariant ratios, excluded, pass through raw.
const CHAINED_INDEX_IDS = new Set(["HCX"]);
// Leading closes beyond `limit` so the drawdown's 63d rolling high + CONFIRM_CLOSES settle at the left edge.
const DOWNSIDE_PAD = HIGH_WINDOW_SHORT + CONFIRM_CLOSES;

/** Downside-break read path (DB_SMH/DB_XLK) — DISPLAY-ONLY. Re-scores stored closes through the production
 *  `downsideBreakReadingSeries` (cuts resolved off the id) and plots the drawdown `close ÷ 63d-high − 1`
 *  × 100 as the primary line; ribbon = the confirmed state the /lab chip shows. No price re-fetch. */
async function downsideSeries(
  { store }: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[] }> {
  const stored = await store.getSeries(indicator.id, limit + DOWNSIDE_PAD);
  const observations: Observation[] = stored.map((p) => ({ date: p.date, value: p.value }));
  const readings = downsideBreakReadingSeries(indicator, observations).slice(-limit);
  // The MA50 trend gate (the AND-rule half the drawdown can't show), from the SAME `belowMAFlags`/
  // `maValues` over the SAME closes, keyed by DATE (an index join would slide it by HIGH_WINDOW_SHORT−1).
  // A key is omitted where its window is uncovered. `api/series.post-inversion.test.ts` asserts both keys.
  const gateDef = GATES[indicator.id]?.[0];
  const closes = stored.map((p) => p.value);
  const belowFlags = gateDef ? belowMAFlags(closes, gateDef.rule === "belowMA" ? gateDef.window : 0) : [];
  const mas = gateDef ? maValues(closes, gateDef.rule === "belowMA" ? gateDef.window : 0) : [];
  // The gate in DRAWDOWN space: `ma50 ÷ 63d-high − 1`, off the SAME inclusive rolling high the scorer
  // uses (NOT the exclusive `rollingMaxValues`) — so the drawn line and the flag are one condition.
  const highs = inclusiveRollingMax(closes, HIGH_WINDOW_SHORT);
  const byDate = new Map(
    stored.map((p, i) => {
      const hi = highs[i];
      return [
        p.date,
        {
          below: belowFlags[i] ?? null,
          gateLine: mas[i] != null && hi != null && hi > 0 ? (mas[i] / hi - 1) * 100 : null,
        },
      ] as const;
    }),
  );
  const points: SeriesPointDTO[] = readings.map((r) => {
    const aux = byDate.get(r.date);
    return {
      date: r.date,
      // Plot the DRAWDOWN (the scored decision variable, a negative fraction) as a percent so
      // the "%" primary axis + the displayBand lines (api/indicators.ts bakes them from the
      // SAME per-id `downsideCuts` pair, also × 100) line up.
      value: (r.decision ?? 0) * 100,
      delta20: r.delta20,
      rawState: r.rawState,
      state: r.state,
      ...(gateDef && aux?.below != null ? { gates: { [gateDef.key]: aux.below } } : {}),
      ...(aux?.gateLine != null ? { gateLine: aux.gateLine } : {}),
    };
  });
  return { points: withRunAt(points, stored) };
}

/** PER-POINT band-cut branch (R1, CG): attach each date's MOVING `bandCuts[key]` AND re-score state through
 *  `ratioSpreadReadingSeries` so ribbon and cuts are one model (`ChartBand.fromPoint` keys the same map).
 *  Read `MAX_LIMIT + readPathHeadRows(id)` (a `warmup: true` db-first id reads the run path's `readings`
 *  ∪ warm-up union instead) — the expanding percentile is history-anchored; the unscoreable
 *  `levelBandHead` head is dropped and carries no cut key (a gap, never 0). */
/** `readings` ∪ the persisted `readings_warmup` head via the run path's own merge (`resolveDbFirstArm`);
 *  head rows carry the raw value only — no stored cut/state, the re-score burns them. */
async function warmupMergedSeries(store: ReadStore, feed: DbFirstFeedSpec): Promise<SeriesPoint[]> {
  const { merged, stored } = await resolveDbFirstArm(store, feed);
  const first = stored[0]?.date;
  const head: SeriesPoint[] = [...merged]
    .filter(([date]) => first === undefined || date < first)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value, delta20: 0, rawState: "GREEN", state: "GREEN" }));
  return [...head, ...stored];
}

async function pointBandCutSeries(
  { store, warn = console.warn }: SeriesRead,
  indicator: Indicator,
  limit: number,
): Promise<{ points: SeriesPointDTO[]; chainSplices?: number; maxChainRatio?: number }> {
  // `?? []`: a COMPOSITE_RESTATE_OF id (R6) may reach here with no `bandCuts` row — it comes for the
  // RE-SCORE, not the cuts; an empty list emits no `bandCuts` key.
  const cuts = CHART_DESCRIPTOR_OF[indicator.id]?.bandCuts ?? [];
  // Persisted cuts were stamped over `readings` ∪ warm-up (`warmup: true` db-first); re-score over the
  // same union, or a day near the cut paints a ribbon tier contradicting the drawn line beside it.
  const rawStored =
    CG_DB_FIRST_FEED.warmup === true && indicator.id === CG_DB_FIRST_FEED.id
      ? await warmupMergedSeries(store, CG_DB_FIRST_FEED)
      : await store.getSeries(indicator.id, MAX_LIMIT + readPathHeadRows(indicator.id));
  const stored = stripStoredCuts(rawStored);
  const values = stored.map((p) => p.value);
  // BREADTH branch (F5/SPCONC/HCX): cuts from `breadthCutSeries` (scorer's own rolling expression) and
  // the plotted value is that same `dist`, so line and band can't disagree (R3); stored `state` verbatim.
  if (BREADTH_DIST_BANDCUT_IDS.has(indicator.id)) {
    // A CHAINED-index id (HCX) may carry >1 base; splice onto the first BEFORE the dist so line and cuts
    // (both from `spliced`) agree. Base-invariant ratios pass through.
    const { values: spliced, breaks, maxRatio } = CHAINED_INDEX_IDS.has(indicator.id)
      ? spliceChainedIndex(values)
      : { values, breaks: [] as number[], maxRatio: 1 };
    // Never a SILENT heal — the count rides the response (`chainSplices`); this warns id + cliff factor.
    if (breaks.length > 0) {
      const detail = breaks.map((b) => `${stored[b]?.date}(×${(values[b]! / values[b - 1]!).toFixed(2)})`).join(", ");
      warn(`[series] ${indicator.id}: spliced ${breaks.length} chained-index base break(s): ${detail}`);
    }
    // Per-id config, never defaults: F5/SPCONC no longer share a window (a default would draw the wrong one).
    const bcfg = breadthConfig(indicator.id);
    const dist = breadthDistSeries(spliced, bcfg.highWindow);
    const cutSeries = cuts.map((c) => ({
      key: c.key,
      series: breadthCutSeries(dist, c.p, bcfg.cutWindow, bcfg.minObs),
    }));
    const off = Math.max(0, stored.length - limit);
    const points: SeriesPointDTO[] = [];
    stored.slice(-limit).forEach((p, i) => {
      const bandCuts: Record<string, number> = {};
      for (const { key, series } of cutSeries) putFiniteCut(bandCuts, key, series[off + i]);
      const d = dist[off + i];
      points.push({
        ...p,
        value: d != null && Number.isFinite(d) ? d : null,
        ...(Object.keys(bandCuts).length > 0 ? { bandCuts } : {}),
      });
    });
    // `chainSplices` only sees a break ≥ CHAIN_BREAK_RATIO; surface `maxChainRatio` above CHAIN_QUIET_RATIO
    // so a smaller unspliced cliff stays visible; gated so a healthy payload stays byte-identical.
    const maxChainRatio = maxRatio > CHAIN_QUIET_RATIO ? Number(maxRatio.toFixed(2)) : undefined;
    return {
      points,
      ...(breaks.length > 0 ? { chainSplices: breaks.length } : {}),
      ...(maxChainRatio !== undefined ? { maxChainRatio } : {}),
    };
  }
  const desc = RATIO_DESCRIPTOR_OF[indicator.id];
  // ⚠ UNITS: a DETRENDED `levelBand` cuts the value's DEVIATION, but the plotted line is the RATIO — so
  // the percentile is back-transformed per date (`sma · (1 + cutDev)`) through the one `levelBandValues`
  // detrend expression. The levelBand is resolved across both families (BONOS gets the same back-transform);
  // R6's N1 `rolling-percentile` is not detrended (`dev` null, raw MOVE units).
  const lb = desc?.levelBand ?? COMPOSITE_LEVEL_BAND_OF[indicator.id];
  const dev =
    lb?.kind === "detrended-expanding-percentile"
      ? levelBandValues(values, lb)
      : null;
  const cutSeries = cuts.map((c) => {
    // Non-`expanding-percentile` levelBand kinds route through `levelBandCuts` (the scorer's series);
    // the plain arm/no-band takes `expandingPercentile(values, c.p, c.minObs)` to honor the display
    // `minObs` floor. Detrended arms (`dev` non-null) back-transform below; N1 draws `cutRaw` as is.
    const cutRaw =
      lb && lb.kind !== "expanding-percentile"
        ? levelBandCuts(dev ?? values, lb, c.p)
        : expandingPercentile(values, c.p, c.minObs);
    return { key: c.key, raw: cutRaw };
  });
  // Re-score over the SAME deep array via the value-domain seam (CG: the writers' anchored `cgRows`, else
  // `ratioSpreadReadingSeriesFromValues`) — verdict and ribbon must match.
  // The COMPOSITE arm (R6/BONOS, `COMPOSITE_RESTATE_OF`) runs the value-domain scorer over `values`+dates;
  // its head is the SAME `readPathHeadRows` addend the read deepened by.
  const restate = COMPOSITE_RESTATE_OF[indicator.id];
  const pts = stored.map((p) => ({ date: p.date, value: p.value }));
  const scored = desc
    ? new Map(
        (indicator.id === CG.id ? cgRows(indicator, pts) : ratioSpreadReadingSeriesFromValues(indicator, desc, pts)).map((r) => [r.date, r]),
      )
    : restate
      ? new Map(
          restate(
            indicator,
            values,
            stored.map((p) => p.date),
          ).map((r) => [r.date, r]),
        )
      : null;
  // Composite velocity-leg ids (BONOS/R6) draw that leg's z via `oatVelocityZ` (the scorer's series).
  // Gated on `VELOCITY_Z_CONSTANTS_OF` membership, NOT an identity compare on the level band (that
  // named one descriptor object and silently dropped R6's `velZ`); each id resolves its OWN constants.
  // A second horizon (`velSlowWindow`, BONOS) serves the WINNING z per day — the arm the worst-of state reads.
  const velCfg = VELOCITY_Z_CONSTANTS_OF[indicator.id];
  const fastZ = velCfg ? oatVelocityZ(values, velCfg) : null;
  const slowZ =
    velCfg?.velSlowWindow !== undefined ? oatVelocityZ(values, { ...velCfg, velWindow: velCfg.velSlowWindow }) : null;
  const velZ =
    fastZ && slowZ
      ? fastZ.map((f, i) => (f === undefined ? slowZ[i] : slowZ[i] === undefined ? f : Math.max(f, slowZ[i])))
      : fastZ;
  // Offset from the deep array into the sliced window, so each visible point reads its OWN date's cut.
  const off = Math.max(0, stored.length - limit);
  const points: SeriesPointDTO[] = [];
  stored.slice(-limit).forEach((p, i) => {
    const fresh = scored?.get(p.date);
    // No reading ⇒ the dropped head; a mapped id with no ratio descriptor keeps the passthrough shape.
    if (scored && !fresh) return;
    const bandCuts: Record<string, number> = {};
    for (const { key, raw } of cutSeries) {
      // Re-scored `desc` ids read the persisted cut VERBATIM (null/absent ⇒ no key); BONOS/ECY/restate use
      // `raw`. Back-transform deviation → ratio when `dev` non-null (the UNITS caveat).
      const rc = desc ? rawStored[off + i]?.bandCuts?.[key] : raw[off + i];
      const v = rc != null && dev ? (values[off + i]! / (1 + dev[off + i]!)) * (1 + rc) : rc;
      // Omit the key over the band's head (`levelBandHead` NaN), never serve a drawable number.
      putFiniteCut(bandCuts, key, v);
    }
    // A MISSING `velZ` key is a GAP (warm-up / σ=0), never 0 — same rule as bandCuts.
    const z = velZ?.[off + i];
    points.push({
      ...p,
      ...(fresh ? { rawState: fresh.rawState, state: fresh.state } : {}),
      ...(Object.keys(bandCuts).length > 0 ? { bandCuts } : {}),
      ...(z !== undefined && Number.isFinite(z) ? { velZ: z } : {}),
    });
  });
  return { points };
}

/** PER-DAY σ OVERLAYS for a rolling-σ id (`thresholds.velocitySigma`): the MOVING band cuts `amber · σ(t)`
 *  AND, where CUSUM knobs resolve, the accumulator `S⁺`, both off ONE deep read. σ multiples are read off
 *  the registry velocity pair, never restated; keyed off the `POINT_BAND_SIGMA_CUTS` map `chart-rail.ts`
 *  reads. An OVERLAY, not a branch (runs on TOP of the produced points). DEEP-THEN-INDEX: fetch
 *  `points.length + lookbackPadFor` rows anchored on the LAST point's date (NOT `fetchLimit + pad` — that
 *  read 4k wrong rows for a 1-row probe); join BY DATE. A missing σ/cusum OMITS the key (a gap, never 0 —
 *  0 is a real S⁺). Alignment: `sigma[i - VELOCITY_WINDOW]` (the GLOBAL 20, not the id's own window). */
async function withSigmaOverlays(
  { store }: SeriesRead,
  indicator: Indicator,
  points: SeriesPointDTO[],
): Promise<SeriesPointDTO[]> {
  const cfg = indicator.thresholds.velocitySigma;
  if (!cfg) return points;
  const last = points.at(-1);
  if (last === undefined) return points;
  const stored = await store.getSeries(
    indicator.id,
    points.length + lookbackPadFor(indicator),
    { from: null, to: last.date },
  );
  const { sigma, z } = velocitySigmaZSeries(
    stored.map((p) => p.value),
    indicator.velocityWindow ?? VELOCITY_WINDOW,
    cfg,
  );
  // The SAME z the `vel-z` leg scores, folded by the production accumulator; knobs via `cusumParams`
  // (the one gate deciding the leg exists), so the drawn line resets where the scorer's does. A σ id
  // declining the persistence leg (F11) folds nothing and emits no `cusum` key; `bandCuts` still runs.
  const cusumCfg = cusumParams(cfg);
  const cusum = cusumCfg ? velocityCusumSeries(z, cusumCfg.k, cusumCfg.red) : undefined;
  // The display-only reference line (`dualAxis.refSigma`) rides the same σ(t), so it moves with the pair.
  const refSigma = CHART_PARAMS_OF[indicator.id]?.dualAxis?.refSigma;
  const byDate = new Map<string, Record<string, number>>();
  const cusumByDate = new Map<string, number>();
  stored.forEach((p, i) => {
    // Both overlays align to `values[VELOCITY_WINDOW..]` — the GLOBAL 20, not the id's own window.
    const k = i - VELOCITY_WINDOW;
    const c = cusum?.[k];
    if (c !== undefined && Number.isFinite(c)) cusumByDate.set(p.date, c);
    const s = sigma[k];
    if (s === undefined || !Number.isFinite(s)) return;
    const cuts: Record<string, number> = {};
    for (const c2 of POINT_BAND_SIGMA_CUTS) {
      const mult = indicator.thresholds[c2.from];
      if (mult != null) cuts[c2.key] = s * mult;
    }
    if (refSigma != null) cuts[SIGMA_REF_KEY] = s * refSigma;
    if (Object.keys(cuts).length > 0) byDate.set(p.date, cuts);
  });
  return points.map((p) => {
    const cuts = byDate.get(p.date);
    const s = cusumByDate.get(p.date);
    if (cuts === undefined && s === undefined) return p;
    return {
      ...p,
      ...(cuts ? { bandCuts: { ...(p.bandCuts ?? {}), ...cuts } } : {}),
      ...(s === undefined ? {} : { cusum: s }),
    };
  });
}

/** Trailing `win`-obs means of a feed, each dated at its window's LAST obs — the same expression
 *  `smoothedLevelReadingSeries` scores (and persists as `value`), so a mean-space cut joins BY DATE. */
function trailingMeans(obs: Observation[], win: number): { means: number[]; meanDates: string[] } {
  const means: number[] = [];
  const meanDates: string[] = [];
  for (let i = win - 1; i < obs.length; i++) {
    let sum = 0;
    for (let k = i - win + 1; k <= i; k++) sum += obs[k]!.value;
    means.push(sum / win);
    meanDates.push(obs[i]!.date);
  }
  return { means, meanDates };
}

/** Post-inversion cut lines as wire-only `bandCuts`, per carrier: a smoothed carrier (R1) and `levelCuts`
 *  carrier (R8) read `POST_INVERSION_BAND.key` / `R8_MEAN_CUT_BANDS` VERBATIM from the persisted scorer cut;
 *  a RAW carrier computes off `postInversionCutSeries` + `drawdownCutSeries` (R1_DRAWDOWN_BAND) and also
 *  attaches the short-leg gate's `shortMove`. Keys ABSENT (never 0/null) per each gap rule. Exported so
 *  `api/series.post-inversion.test.ts` can pin the raw arm on a fixture (GET reaches registry ids only). */
export async function withPostInversionCut(
  indicator: Indicator,
  points: SeriesPointDTO[],
  storedCuts: ReadonlyMap<string, Readonly<Record<string, number>>> | undefined,
  { store, now, warn }: SeriesRead,
): Promise<SeriesPointDTO[]> {
  const cfg = indicator.postInversionCooldown;
  // The drawdown leg is rung-INDEPENDENT in the scorer, so the drawn line must be too (`chart-rail.ts`'s
  // `dd` gate matches) — else a `drawdownLeg`/no-`cooldown` carrier scores AMBER with no cut.
  const ddCfg = indicator.drawdownLeg;
  const smoothed = SMOOTHED_LEVEL_OF[indicator.id];
  // Below: `redWindow` passes cfg-INDEPENDENTLY (the scorer reds on that mean with no rung armed).
  if (!cfg && !ddCfg && smoothed?.redWindow === undefined) return points;
  if (smoothed && !cfg?.levelCuts && smoothed.redWindow === undefined) return points;
  if (points.length === 0) return points;
  // Line input = the indicator's UPSTREAM series (`indicator.series`) read full-depth; the RAW-arm short
  // leg rides the SAME bulk read.
  const shortId = !smoothed ? cfg?.shortLegSeries : undefined;
  const inputs = await readInputSeries(
    store,
    shortId === undefined ? [indicator.series] : [indicator.series, shortId],
    INPUT_SERIES_LIMIT,
    { now },
  );
  const obs = inputs.get(indicator.series);
  if (obs === undefined) {
    warnMissingInput(indicator.series, "series:postInversion", warn);
    return points; // degrade: input rows missing ⇒ points unchanged, no post-inversion key this response
  }
  // The redWindow mean (what RED scores on) attached before the rung branches so every return path
  // carries it. Short-of-window dates get no key (a gap).
  if (smoothed?.redWindow !== undefined && obs.length >= smoothed.redWindow) {
    const { means: rMeans, meanDates: rDates } = trailingMeans(obs, smoothed.redWindow);
    const redByDate = new Map<string, number>();
    rDates.forEach((d, k) => redByDate.set(d, rMeans[k]!));
    points = points.map((p) => {
      const rm = redByDate.get(p.date);
      return rm === undefined ? p : { ...p, redMean: rm };
    });
  }
  if (smoothed && cfg && !cfg.levelCuts) {
    // TWO-WINDOW smoothed carrier (R1): the rung's armed cut VERBATIM from the persisted scorer cut
    // (null/absent ⇒ no key, a gap).
    if (obs.length < smoothed.window) return points;
    return points.map((p) => {
      const c = storedCuts?.get(p.date)?.[POST_INVERSION_BAND.key];
      return c === undefined ? p : { ...p, bandCuts: { ...(p.bandCuts ?? {}), [POST_INVERSION_BAND.key]: c } };
    });
  }
  if (cfg?.levelCuts) {
    // `levelCuts` carrier (R8): the mean-space pair VERBATIM from the persisted scorer cuts (null/absent
    // ⇒ no key, a gap).
    const win = smoothed?.window;
    if (win === undefined || obs.length < win) return points;
    return points.map((p) => {
      const stored = storedCuts?.get(p.date);
      const cuts: Record<string, number> = {};
      for (const band of R8_MEAN_CUT_BANDS) {
        const v = stored?.[band.key];
        if (v !== undefined) cuts[band.key] = v;
      }
      return Object.keys(cuts).length === 0 ? p : { ...p, bandCuts: { ...(p.bandCuts ?? {}), ...cuts } };
    });
  }
  const cuts = cfg
    ? postInversionCutSeries(
        obs.map((o) => o.value),
        cfg,
        obs.map((o) => o.date),
      )
    : null;
  // A `drawdownLeg` carrier: a SECOND amber line off `drawdownCutSeries` (the scorer's expression),
  // null ONLY during warm-up, never gated on the rung's arming.
  const ddCuts = ddCfg ? drawdownCutSeries(obs.map((o) => o.value), ddCfg) : null;
  // ONE window for the plotted `shortMove` line — the rung's, else the drawdown leg's; degrades to no
  // `shortMove` key on missing short-leg rows (gate off, floor still applies), never a drawn zero.
  const moveWindow = cfg?.shortLegWindow ?? ddCfg?.gateWindow;
  const short = shortId === undefined ? undefined : inputs.get(shortId);
  if (shortId !== undefined && short === undefined) warnMissingInput(shortId, "series:postInversion", warn);
  const moves = moveWindow !== undefined && short !== undefined ? shortMoveSeries(obs, short, moveWindow) : null;
  const byDate = new Map<string, Record<string, number>>();
  const moveByDate = new Map<string, number>();
  obs.forEach((o, i) => {
    const row: Record<string, number> = {};
    const c = cuts?.[i];
    if (c !== null && c !== undefined) row[POST_INVERSION_BAND.key] = c;
    const d = ddCuts?.[i];
    if (d !== null && d !== undefined) row[R1_DRAWDOWN_BAND.key] = d;
    if (Object.keys(row).length > 0) byDate.set(o.date, row);
    const m = moves?.[i];
    if (m !== null && m !== undefined) moveByDate.set(o.date, m);
  });
  return points.map((p) => {
    const row = byDate.get(p.date);
    const move = moveByDate.get(p.date);
    if (row === undefined && move === undefined) return p;
    return {
      ...p,
      ...(row ? { bandCuts: { ...(p.bandCuts ?? {}), ...row } } : {}),
      ...(move === undefined ? {} : { shortMove: move }),
    };
  });
}

/** CQS EBP-bridge moving cut lines as wire-only `bandCuts`, gated on `CHART_DESCRIPTOR_OF[id].cutOverlay`.
 *  Reads the bridge's own three inputs because the drawn cut is `z* × σ(t)` over the SPREAD; multiplying
 *  the z cuts back by the SAME σ the scorer divided by keeps line and ribbon one model
 *  (`creditBridgeCutSeries` is the one owner). Missing input ⇒ points unchanged (degrade, never 500);
 *  keys ABSENT (never 0/null) on anchor-less/warm-up/sub-floor-σ days. */
async function withCreditBridgeCuts(
  { store, now, warn }: SeriesRead,
  _indicator: Indicator,
  points: SeriesPointDTO[],
): Promise<SeriesPointDTO[]> {
  if (points.length === 0) return points;
  // "EBP" = the scored indicator's own persisted rows (monthly), NOT an INPUT_SERIES roster id.
  const bridgeIds = ["BAA10Y", "AAA10Y", "EBP"];
  const inputs = await readInputSeries(store, bridgeIds, INPUT_SERIES_LIMIT, { now });
  const absent = bridgeIds.filter((id) => !inputs.has(id));
  if (absent.length > 0) {
    for (const id of absent) warnMissingInput(id, "series:creditBridge", warn);
    return points; // degrade: an input series is missing ⇒ points unchanged, no cut keys this response
  }
  const [baa, aaa, ebp] = bridgeIds.map((id) => inputs.get(id)!) as [Observation[], Observation[], Observation[]];
  const { dates, cuts } = creditBridgeCutSeries(baa, aaa, ebp);
  const byDate = new Map<string, Record<string, number>>();
  dates.forEach((d, i) => {
    const row: Record<string, number> = {};
    for (const key of Object.keys(cuts)) putFiniteCut(row, key, cuts[key]![i]);
    if (Object.keys(row).length > 0) byDate.set(d, row);
  });
  return points.map((p) => {
    const row = byDate.get(p.date);
    return row === undefined ? p : { ...p, bandCuts: { ...(p.bandCuts ?? {}), ...row } };
  });
}

/** `handle`'s branch dispatch: run every gated builder (in this order — each is a store read), then serve
 *  the FIRST non-null one's points (recompute wins, per-point band cuts last), else the store passthrough.
 *  `range` is the parsed window, `undefined` when the request carries none. */
async function resolveBranchPoints(
  rd: SeriesRead,
  indicator: Indicator,
  chartDesc: (typeof CHART_DESCRIPTOR_OF)[string] | undefined,
  { detail, mult, limit, fetchLimit, range }: {
    detail: boolean;
    mult: number | null;
    limit: number;
    fetchLimit: number;
    range: { from: string | null; to: string | null } | undefined;
  },
) {
  const recomputed =
    detail && supportsRecompute(indicator) ? await recomputedSeries(rd, indicator, fetchLimit, mult) : null;
  // FXH bespoke branch (mode-INVARIANT): `null` on a feed failure ⇒ degrade to the stored series.
  const fxhBranch = chartDesc?.branch === "fxHaven" ? await fxHavenSeries(rd, indicator, fetchLimit) : null;
  // R7 bespoke branch (mode-INVARIANT): `null` on a feed failure ⇒ degrade to the stored series.
  const bullBranch = chartDesc?.branch === "bullSteepener" ? await bullSteepenerSeries(rd, indicator, fetchLimit) : null;
  // ECY join branch: stored rows verbatim + the join-derived amber cut (see `ecyJoinSeries`).
  const ecyBranch = chartDesc?.branch === "ecyJoin" ? await ecyJoinSeries(rd, indicator, fetchLimit) : null;
  // Case 4 gate branch (GATES: F4/F8/G1/BRENT) — stored points verbatim + wire-only `gates` flags.
  // ⚠ DISP and DB_* are EXCLUDED: both carry a GATES entry but own a bespoke branch, and this is checked
  // FIRST — without the exclusion a DB id would serve raw closes under a drawdown axis.
  const gatedBranch =
    GATES[indicator.id] && chartDesc?.branch !== "dispersion" && !DOWNSIDE_IDS.has(indicator.id)
      ? await gatedSeries(rd, indicator, fetchLimit)
      : null;
  // DISP bespoke branch: wraps gatedSeries (for the corr-confirm gate flags) but re-scores state on read
  // through the CURRENT dispersionState + confirm buffer. Excluded from gatedBranch so it isn't double-served.
  const dispBranch = chartDesc?.branch === "dispersion" ? await dispersionSeries(rd, indicator, fetchLimit) : null;
  // Downside-break DB_* bespoke branch: re-score stored closes to emit the DRAWDOWN line + ribbon.
  // Must NOT fall through to the price passthrough (price can't carry a drawdown axis).
  const downsideBranch = DOWNSIDE_IDS.has(indicator.id) ? await downsideSeries(rd, indicator, fetchLimit) : null;
  // Per-point moving-band branch (CG): stored row + wire-only `bandCuts`, state RE-SCORED (see docblock).
  // Sits last so any other recompute branch wins. ⚠ Gated on `bandCuts` OR the COMPOSITE_RESTATE map —
  // this is the ONLY site that runs `COMPOSITE_RESTATE_OF`, so gating on `bandCuts` alone would drop R6
  // back to the stored vintage when its `bandCuts` row went. A restate id with no row emits no key.
  const pointBandBranch =
    !chartDesc?.branch && (chartDesc?.bandCuts || COMPOSITE_RESTATE_OF[indicator.id])
      ? await pointBandCutSeries(rd, indicator, fetchLimit)
      : null;
  // Store passthrough (F6, every other stored id): cron-time `state`/`rawState`/`decision` ride through,
  // no on-read re-score (Case 2 invariant; gates are additive). The query is anchored to [from,to] with
  // the client `limit` (NOT the deep fetchLimit) — the store's gte/lte before its cap returns exactly the
  // latest-`limit` in-window rows, provably the same as a MAX_LIMIT fetch + filter + slice, without a
  // 4000-row read for a 1-row probe. Hoisted un-stripped so `withPostInversionCut` can read the persisted
  // scorer cut (R1/R8 always land here).
  const winner =
    recomputed ?? fxhBranch ?? bullBranch ?? ecyBranch ?? gatedBranch ?? dispBranch ?? downsideBranch ?? pointBandBranch;
  const passthroughRaw = winner ? null : await rd.store.getSeries(indicator.id, limit, range);
  const fetched = winner ? winner.points : stripStoredCuts(passthroughRaw!);
  return { recomputed, fxhBranch, pointBandBranch, passthroughRaw, fetched };
}

export async function GET(req: Request): Promise<Response> {
  const env = readEnv(); // the entry's ONE env read
  return handle(() => getStore("ro", env), req, { now: new Date() }); // the entry's ONE wall-clock read
}

/** `seriesBody` wrapped in the R7 response rule (`respondSeries`); a 400 passes through untouched. */
export async function handle(
  storeOf: () => ReadStore,
  req: Request,
  opts: SeriesSeams,
): Promise<Response> {
  const body = await seriesBody(storeOf, req, opts);
  return body instanceof Response ? body : respondSeries(body);
}

/** The FULL (unredacted) `/series` body for `req`, or its 400 — `handle` serves it through `respondSeries`.
 *  Exported so a suite asserting on the redactable fields reads them before the response rule. */
export async function seriesBody(
  storeOf: () => ReadStore,
  req: Request,
  opts: SeriesSeams,
): Promise<SeriesResponse | Response> {
  const params = new URL(req.url).searchParams;
  const unknown = rejectUnknownParams(params, ["id", "from", "to", "limit", "detail", "mult"]);
  if (unknown) return unknown;

  const id = params.get("id");
  // META is BUILD-time, so a just-added id 400s here until its commit deploys — verify a backfill by
  // its OWN exit-0 row count, not this live API.
  const indicator = id === null ? undefined : META.get(id);
  if (!indicator && (id === null || !CHAINED_SERIES_HEAD.has(id))) {
    return Response.json({ error: `id must be one of: ${[...META.keys(), ...CHAINED_SERIES_HEAD.keys()].join(", ")}` }, { status: 400 });
  }

  const range = parseRange(params);
  if (range instanceof Response) return range;
  const hasRange = range.from !== null || range.to !== null;

  // Range queries default `limit` to the cap (the range is the window); an explicit `limit` still applies
  // AFTER the range slice below.
  const limit = parseLimit(params.get("limit"), { def: hasRange ? MAX_LIMIT : DEFAULT_LIMIT, max: MAX_LIMIT });
  if (limit instanceof Response) return limit;
  // Recompute branches can't push the range into the store, so they fetch deep on a `to=<past>` window;
  // a `to`-less range's newest `limit` in-window rows are the newest overall, so bound at `limit`. The
  // store passthrough below pushes both range AND `limit` in, never over-fetching.
  const fetchLimit = hasRange && range.to !== null ? MAX_LIMIT : limit;

  // A chained-only display line (no registry row, `src/api-routes/series-chained.ts`): stored rows, no branch/overlay.
  if (!indicator) {
    const chained = await chainedSeries(storeOf(), id!, limit, hasRange ? range : undefined);
    const chainedPoints = flagProvisional(chained.points, id!);
    const chainedEst = estimateSlot(chainedPoints);
    return { ...chained, points: chainedPoints, ...(chainedEst ? { oilEst: chainedEst } : {}) };
  }

  // `?detail=1` opts into a full on-read recompute; a detail-less fetch serves the STORED state
  // byte-identical (openapi contract). The recompute reads only the shared/null-row cuts.
  const detail = params.get("detail") === "1";

  // Display-only `?mult` what-if (`null` = OFF ⇒ byte-identical). Inert without `detail`: the recompute
  // branch is gated on `detail`, which only the detail chart passes.
  const parsedMult = parseMult(params.get("mult"));
  if (parsedMult instanceof Response) return parsedMult; // off-grid ⇒ 400 no-store (P12.b)
  const mult = parsedMult;
  const rd: SeriesRead = {
    store: storeOf(),
    now: opts.now,
    warn: opts.warn ?? console.warn,
    multiplierOf: opts.multiplierOf ?? resolveMultiplier,
  };

  // Per-id chart/read-path declaration — the branch gates below key off it, never id literals. The
  // effective-cut scalars ride ONLY the recompute branch.
  const chartDesc = CHART_DESCRIPTOR_OF[indicator.id];
  const { recomputed, fxhBranch, pointBandBranch, passthroughRaw, fetched } = await resolveBranchPoints(
    rd, indicator, chartDesc, { detail, mult, limit, fetchLimit, range: hasRange ? range : undefined },
  );

  // ROLLING-σ velocity overlay on TOP of the branch's points; identity without `thresholds.velocitySigma`
  // (guard inside). Sizes its own read off `fetched`, not `fetchLimit`, so a 1-row probe costs `1 + pad`.
  // A PENSION row's `derived` line (KBE's worstDrop) is stamped on read — its stored rows carry no `decision`.
  const dv = indicator.channel === "PENSION" ? indicator.derived : undefined;
  const values = dv ? fetched.map((p) => p.value ?? NaN) : [];
  const decided = dv ? fetched.map((p, k) => ({ ...p, decision: decisionAt(dv, values, k) })) : fetched;

  const withCuts = indicator.thresholds.velocitySigma
    ? await withSigmaOverlays(rd, indicator, decided)
    : decided;

  // Post-inversion overlay (R1/R8) — same additive shape; identity without the rung (guard inside).
  const withPI = indicator.postInversionCooldown
    ? await withPostInversionCut(indicator, withCuts, passthroughRaw ? storedCutsByDate(passthroughRaw) : undefined, rd)
    : withCuts;

  // Bridge-cut overlay (CQS) — same additive shape; identity without a `cutOverlay` row.
  const withBridge =
    chartDesc?.cutOverlay === "creditBridge" ? await withCreditBridgeCuts(rd, indicator, withPI) : withPI;


  // `estimateAnchored`: an estimate whose previous session holds no FINAL row is a gap — never served (the persist sweep's rule).
  const unanchored = new Set(ANCHOR_ROSTER.includes(indicator.id) ? unanchoredEstimateDates(indicator.id, withBridge) : []);
  const anchored = unanchored.size === 0 ? withBridge : withBridge.filter((p) => !unanchored.has(p.date));
  // Range slice at the wire edge (ISO dates compare lexicographically); `limit` trims to latest-N in-window.
  const points = hasRange
    ? anchored
        .filter(
          (p) => (range.from === null || p.date >= range.from) && (range.to === null || p.date <= range.to),
        )
        .slice(-limit)
    : anchored;

  const servedPoints = flagProvisional(points, id!);
  // the served estimate slot is the STORED `estimated` tail of these very points (any id) — no read-path recompute.
  const oilEst = estimateSlot(servedPoints);
  const legPx = legProxy(indicator.id);

  // Materialize the "%" default at the wire edge (an explicit "" stays unitless), matching /api/indicators.
  const body: SeriesResponse = {
    indicatorId: indicator.id,
    label: indicator.label,
    longLabel: indicator.longLabel,
    unit: indicator.unit ?? "%",
    points: servedPoints,
    ...(recomputed
      ? {
          effAmber: recomputed.effAmber,
          effRed: recomputed.effRed,
          scorerLegs: recomputed.scorerLegs,
          legBounds: recomputed.legBounds,
        }
      : fxhBranch
        ? { effAmber: fxhBranch.effAmber, effRed: fxhBranch.effRed }
        : {}),
    // Read off `confirmClosesFor`, never restated as a literal in the legend copy. ABSENT on VTP: its
    // streak-banded state is served unfolded (HCX/FDX fold via `ratioReadingSeries`, so they keep it).
    ...(indicator.id === VTP.id ? {} : { confirmCloses: confirmClosesFor(indicator.id) }),
    // Echo the APPLIED (post-clamp) multiplier; gated on a recompute branch having RUN (not merely
    // `mult !== null`), so a `mult`-less or detail-less request stays byte-identical.
    ...(mult !== null && recomputed ? { mult } : {}),
    // VALUE-ONLY flag (never-scored ids + the cut-less chart-only vol cards): the ribbon's `state` is a placeholder GREEN, must neutralize.
    ...(PLACEHOLDER_STATE_IDS.has(indicator.id) || CUTLESS_CHART_IDS.has(indicator.id) ? { valueOnly: true } : {}),
    // Chained-index BASE BREAKS the read-path splice repaired (HCX); absent ⇒ none needed.
    ...(pointBandBranch?.chainSplices ? { chainSplices: pointBandBranch.chainSplices } : {}),
    // Largest consecutive basket factor above CHAIN_QUIET_RATIO (a sub-CHAIN_BREAK_RATIO cliff
    // `chainSplices` can't see); absent on a quiet payload.
    ...(pointBandBranch?.maxChainRatio ? { maxChainRatio: pointBandBranch.maxChainRatio } : {}),
    // The served estimate tail (any id; wire name kept): ABSENT unless the newest served point is `estimated`.
    ...(oilEst ? { oilEst } : {}),
    // A held-fund leg's pre-join stand-in (`LegQuote.proxy`): points dated before `until` are the proxy's € path.
    ...(legPx ? { proxy: { source: legPx.ticker, until: legPx.until } } : {}),
  };
  return body;
}
