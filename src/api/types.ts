/**
 * TS mirror of the OpenAPI read-API payload schemas (`openapi.yaml`).
 *
 * Hand-authored rather than code-generated: the project is zero-runtime-dep and
 * these are ~5 tiny schemas, so a generator (`openapi-typescript`) isn't worth a
 * devDep + network step. `openapi.yaml` stays the single source of truth — keep
 * these in sync with its `components.schemas` by hand (Phase 3 wires the
 * endpoints that return them).
 */

import type {
  Channel,
  Direction,
  Thresholds,
  DerivedView,
} from "../domain-types.js";
import type { Cadence } from "../domain-types.js";
import type { LastPrintTag } from "../last-print.js";
import type { AlertRecord, CoverageDegrade, CoverageMark, SeriesPoint, StoredReading } from "../store.js";
import type { ReplayPoint, ReplayCoverage } from "../replay.js";
import type {
  FamilyKey,
  FamilyPanel,
  GrowthRsLeg,
  LabResponse,
  LabBand,
  LabBandFloor,
  LabBandMember,
  LabFloorChip,
  OverlayView,
} from "../families.js";
import type { FallShapeConfidence } from "../v-bear.js";
import type { EstimateSlot } from "../estimate-slot.js";
// Re-exported so wire consumers take the builder's own shape, never a hand-kept clone.
export type { EstimateSlot };
import type { CellObserved, HeldMark, SignalCell } from "../danger-cell.js";
import type { FieldResult, LegRow, SubDangers } from "../danger-engine.js";
import type { ScoreboardView } from "../scoreboard.js";
import type { SignalKey, SuperGroup } from "../danger-ladder.js";
import type { ExposureResult, ExposureThresholds } from "../exposure.js";
import type { Episode, ExposureReplayPoint } from "../exposure-replay.js";

/**
 * GET /status verdict, GET /history element, GET /cron/run response.
 *
 * The wire DTO and the store domain type are structurally identical, so this is
 * a re-export rather than a hand-kept clone — divergence is impossible by
 * construction (P3). `openapi.yaml`'s `AlertRecord` schema is the remaining
 * separate copy; the contract test (contract.test.ts) guards that drift.
 */
// `runInputs` is replay-only (`withRunInputs` reads) — never on the wire.
export type AlertRecordDTO = Omit<AlertRecord, "runInputs">;

/**
 * A per-indicator reading as exposed by GET /status — a `StoredReading` plus the
 * static `label` (reconstructed from ALL_INDICATORS at the wire edge; readings
 * are stored without it, see store.ts) and the PER-FEED freshness (audit rank 6).
 *
 * ⚠ **`date` and `ageDays`/`lag` have DIFFERENT SOURCES and CAN diverge — never pair them as one
 * age statement.** `date` is the observation actually SERVED (the row this reading was scored from);
 * `ageDays`/`lag` are measured on the NEWEST STORED observation for the same feed, normally off
 * `freshnessFrom`'s series source —
 * the move that fixed a false-lag measured on 2 of 9 legs.
 * ⚠ NOT the series source unconditionally: on the three degrade paths `freshnessOf` (api/status.ts)
 * enumerates — a degraded freshness read, an id outside the roster, and a roster id the store holds
 * zero observations for — the run's own row supplies BOTH fields. The pair is ATOMIC either way (one
 * source feeds both), which is exactly why `date` is never their source. A run
 * that wrote an older row over a newer stored one yields a past `date` with `ageDays: 0`;
 * `api/status-freshness.test.ts` pins that exact case (`date: "2026-06-01"`, `ageDays: 0`).
 * `public/app.js` renders `reading.date` nowhere (only `cardLagMark`), so this is invisible on the
 * dashboard today — it bites any OTHER consumer that reads the pair as coherent.
 *
 * `ageDays` = calendar days between the newest stored observation and today; `lag` = older
 * than the indicator's RESOLVED lag cut — `ind.lagAfterDays ?? LAG_THRESHOLDS[ind.cadence
 * ?? "daily"]`, resolved through `lagCutFor` (ladder.ts): a per-indicator override where one is
 * registered (E7 — the set is enumerated by `RULED` in `registry.test.ts`), else the cadence tier,
 * so weekly feeds tolerate a full
 * release cycle of lag. Both computed at the wire edge, not stored, so
 * one frozen feed no longer hides behind the run-wide max-date heartbeat.
 */
// A reading row carries the SHORT name only. `longLabel` was emitted here from the
// official-short-names split until 2026-07-25 and never gained a consumer — the dashboard's
// card copy reads names off /api/meta, and the two live long-name seams sit on OTHER schemas
// (`SeriesResponse.longLabel` → detail-chart title, `LabBandMember.longLabel` → band-panel
// hover). Dropped as dead payload; re-add it here only alongside a reader.
export type ReadingDTO = Omit<StoredReading, "value" | "delta20"> & {
  // R7a: null on a PENSION / ETFs-card / `isLicensedId` row, for every request; a number otherwise.
  value: number | null;
  delta20: number | null;
  label: string;
  ageDays: number;
  /**
   * The UNIT of `ageDays`: `"slots"` — the feed's
   * own publication days — for a daily/weekly id since the read path moved to slot age, `"days"` —
   * calendar days — for monthly/quarterly and for every run-row fallback. Serve it beside `ageDays`
   * so a consumer never pairs the number with the wrong unit.
   */
  unit: "slots" | "days";
  lag: boolean;
  /**
   * WHICH freshness notion answered for this reading's `ageDays`/`lag`/`unit` (A1.1): `"roster"` —
   * the per-feed series roster (`freshnessFrom`), the normal source; `"run-row"` — the run's own
   * stored row, the fallback where the roster does not cover the id (a roster miss, a zero-row store,
   * an uncomputable publication calendar, or a degraded freshness read). A `"run-row"` age is a
   * last-fetch age, NOT a publication verdict — the field exists so a consumer can tell the two apart
   * rather than reading a fabricated-fresh fallback as measured.
   */
  source: "roster" | "run-row";
  /**
   * VALUE-ONLY card (all-indicators-cards, 2026-07-22): this reading carries a live `value` for
   * display but NO meaningful RAG `state` — the front-end renders the value and SUPPRESSES the
   * state dot (neutral, no colour) + the Δ20 line. Set ONLY on the synthetic F7/CAPE reading
   * `api/status.ts` bridges read-time (CAPE is non-scored/non-arming context, not a firing member).
   * Absent (falsy) on every scored reading, whose `state` is a real GREEN/AMBER/RED and drives a dot.
   */
  valueOnly?: boolean;
  /** B7 (R7/R9): value/state/date overlaid from a newer INTRADAY row — or the run's own intraday row on a served
   *  intraday verdict (`StatusResponse.provisional`). Absent otherwise. */
  provisional?: true;
  /** E3: that overlaid (or own intraday) row carries the stored `estimated` marker (a proxy nowcast or a carry) — the card reads EST. Absent otherwise. */
  estimated?: true;
  /** E22: the card reads `last print D-n` in place of the age pill — `lastPrintTag` (src/last-print.ts) rules when and `reason`. Absent otherwise. */
  lastPrint?: LastPrintTag;
  /** ETFs-group cards only: newest stored row ÷ the row 20 back − 1 (may be an intraday head). Absent under 21 rows, a bad base, or a degraded read;
   *  null on the served body (R7a — a single-input return is redacted under R6). */
  return20d?: number | null;
};

/** GET /status. */
export interface StatusResponse {
  // api/status.ts serves the stored row (`servedVerdict`: EOD row or intraday slot) verbatim, so ANY new
  // AlertRecord field is already on the /status wire nested under `verdict` — no top-level
  // StatusResponse field and no api/status.ts change. (Contrast IndicatorMeta,
  // a SEPARATE /config-side meta schema.) When exposing a new persisted AlertRecord field:
  // add it to openapi's AlertRecord schema (optional if absent on pre-migration rows) and
  // guard it in contract.test.ts.
  verdict: AlertRecordDTO;
  readings: ReadingDTO[];
  asOf: string;
  lag: boolean; // heartbeat (Phase 3): feed older than STALE_AFTER_DAYS
  feedAgeDays: number; // whole days between asOf and today
  /**
   * PER-FEED pill — the SECOND,
   * independent freshness surface beside the `lag`/`feedAgeDays` heartbeat above, which is
   * unchanged. `lag` is one generic cut over `verdict.date` = the MAX observation date across all
   * feeds, so ONE current feed paints it fresh while every other feed is behind; these three count
   * the ids that are past THEIR OWN cut on THEIR OWN publication calendar (`freshnessFrom`,
   * src/feed-lag.ts — the same verdict `/lab`'s board makes). The two pills CAN disagree; that is
   * the ruling, not a bug.
   *
   * `feedsTotal` is the DENOMINATOR (`freshnessFrom`'s full roster: served registry + composite
   * components), so the tooltip can read "3 of N behind" rather than a bare count.
   *
   * ⚠ ALL THREE ARE OPTIONAL, TOGETHER: the freshness read is its own store read and `/api/status`
   * degrades rather than 500s when it throws (the sibling envelope `api/lab.ts` uses), so a payload
   * that measured nothing omits them instead of serving `feedsLagging: 0` — which would read "all
   * feeds current". They are emitted as a set or not at all, and `feedsLagging === laggingFeedIds.length`
   * by construction (one expression produces both). The FE renders no pill when they are absent
   * (`feedsBehindPill`, public/feed-age-mark.js). `openapi.yaml` marks the same three optional.
   */
  feedsLagging?: number;
  laggingFeedIds?: string[];
  feedsTotal?: number;
  /** ids whose publication calendar could not be built, so lateness is UNCOMPUTABLE — EXCLUDED from
   *  `feedsLagging`/`laggingFeedIds`, served here instead. Optional-as-a-set with the pill fields. */
  unmeasuredFeedIds?: string[];
  /**
   * FEED-LAG OVERVIEW — one row per REGISTERED
   * feed off the SAME freshness walk that produces the pill above, self-contained so `/lab`'s panel
   * can render the "age now / healthy / deep-lag bar" ledger without a second fetch. Roster is the
   * registry walk (`freshnessFrom`'s `freshness`), never a projection of `CADENCE_OF`/`LAG_CUT_OF`
   * alone (a coverage check on one of the two is tautological — an earlier commit removed one). Lagging rows sort
   * first. OPTIONAL and emitted with the pill fields: a degraded freshness read omits it rather than
   * serving a roster with no measurements. `openapi.yaml` marks it optional too.
   */
  feedLag?: FeedLagRow[];
  /** The serving build's `VERCEL_DEPLOYMENT_ID`; null outside Vercel. Paired with `verdict.firedAt` it is the client's storage-paint key (P9.2). */
  deployId: string | null;
  /** Whether this deploy resolves the dashboard link host (`dashboardUrl`, src/config.ts) the push `Click` and the
   *  mail footer carry; false ⇒ alerts still send, linkless. Derived only — the url itself is never served. */
  alertLinks: boolean;
  /** Set iff `verdict` is the daytime `intraday_verdict` slot (`servedVerdict`, src/intraday.ts), not the EOD row. */
  provisional?: true;
}

/**
 * One feed's row in the `/api/status` {@link StatusResponse.feedLag} overview (§7.2). Distinct from
 * `FeedLagNote` (the `/api/lab` footnote payload, marked feeds only): this is the WHOLE roster, one
 * row per registered feed, carrying the three numbers the overview shows — age now, the healthy cut,
 * and the deep-lag bar — plus which of the two ways that bar was derived.
 */
export interface FeedLagRow {
  id: string;
  /** the cadence its freshness is scored against (`CADENCE_OF`). */
  cadence: Cadence;
  /**
   * age of the newest stored observation on the feed's OWN publication calendar, in {@link ageUnit}.
   * `null` where there is NO stamp measurement — zero stored rows (then `lag: true`) or a publication
   * calendar that could not be built (then `unmeasured: true`, no `lag`). A run-row fallback age
   * (`source: "run-row"`) is NOT null — the last-fetch date, self-identified, never a fabricated 0.
   */
  age: number | null;
  /** the UNIT of {@link age}: `"slots"` for a daily/weekly id, `"days"` for monthly/quarterly. `null`
   *  exactly when `age` is (either cause) — the two move as one, never a number beside the wrong unit. */
  ageUnit: "slots" | "days" | null;
  /** the resolved lag cut (`LAG_CUT_OF` = `lagCutFor`) the feed is FRESH within — its `age`'s healthy bar. */
  lagCut: number;
  /**
   * the DEEP-LAG bar the feed rots against, in {@link ageUnit}. `source: "p90"` ⇒ the MEASURED `2 × p90` gap (for the
   * explicit arm, `2 × max(p90, tier)`) served from the existing lag note — a stage-2 measurement
   * this feed already carried; `source: "tier"` ⇒ derived `2 × LAG_THRESHOLDS[cadence]`, no
   * measurement. Stage 2 is NOT widened for this block, so a fully fresh store (no suspects, no lag
   * notes) yields all-`"tier"` rows and issues no second query. `"run-row"` ⇒ `age` is the last-fetch
   * date off the run row (an `unmeasured` feed's publication calendar was uncomputable, so its age
   * comes from the fetch, not its own calendar) — the board reads it "last fetched", not "published".
   */
  deepLagBar: number;
  source: "p90" | "tier" | "run-row";
  /** the server's DEEP-LAG verdict (`lagTier(label) === "deep"`, day-based); present exactly where the
   *  feed carries a lag note — the panel reads it instead of comparing `age` to `deepLagBar`. */
  deep?: boolean;
  /** past its own cut on its own publication calendar — the `freshness` verdict, identical to the
   *  pill's. OMITTED on an `unmeasured` row: lateness was uncomputable, never a fabricated verdict. */
  lag?: boolean;
  /** set (with no `lag`) when the publication calendar could not be built — the feed is UNMEASURED,
   *  excluded from the pill's lagging count and served in `unmeasuredFeedIds` instead. */
  unmeasured?: boolean;
  /** set when the newest stored row is intraday (R10): `age` reads 0 and the panel marks it `INTRADAY`. */
  provisional?: true;
}

/** One point in GET /series — the stored `SeriesPoint` plus an optional read-only
 *  `leg`: the RAW per-day OR-leg that fired (`op`/`evt`/`z`/`vel-op`/`vel-evt`/`vel-z`/`vel-z-fast`/`vel-z-slow`/`vel-cusum`),
 *  so the detail-chart ribbon tooltip can attribute a RED whose plotted value sits inside
 *  the drawn effective line. Emitted ONLY where the raw leg agrees with the confirmed
 *  ribbon `state`; on the ≤2 confirmation-buffer boundary cells where they disagree it is
 *  suppressed, so the tooltip degrades to `date + state`. Wire-only — NOT persisted (kept
 *  off `SeriesPoint`); an old payload / shared-state path simply omits it. Present on the
 *  per-mode recompute + F1/F2 proxy read paths. */
export type SeriesPointDTO = Omit<SeriesPoint, "value" | "delta20" | "runAt"> & {
  // WIRE-nullable: `value` null = a `pointBandCutSeries` warm-up gap or a `redacted` body (value/delta20 both, api/series.ts);
  // kept OFF the store's `SeriesPoint`, whose persisted rows are always numbers.
  value: number | null;
  delta20: number | null;
  leg?: string;
  // Written by an intraday run (`isProvisional`, src/intraday.ts); the EOD close replaces it. Absent ⇒ final.
  provisional?: true;
  // The stored `readings.estimated` marker (E3): the row is an estimate, not a print — provisional (intraday) or not (EOD).
  // The detail chart labels it ESTIMATED (+ `· INTRADAY` when also `provisional`); same key as /lab's member `estimated`. Absent otherwise.
  estimated?: true;
  // The three FX-haven leg moves (−20d haven-bid signed move, %) whose worst-of (max) is
  // the classified FXH envelope. Present ONLY on the FXH bespoke read path (mode-invariant);
  // the FE plots all three and derives the envelope = max. Absent on every other id.
  havenLegs?: { eur: number; chf: number; jpy: number }; // 20d haven-moves (%), FXH only
  // R7's two honest 20d yield-change legs (pp): `drop` = Δ20 DGS2, `steep` = Δ20 (10y−2y). Present
  // ONLY on the R7 bespoke read path (mode-invariant); the four moving ranked cut lines ride
  // `bandCuts.r7DropAmber/r7DropRed/r7SteepAmber/r7SteepRed`. Absent on every other id.
  bullLegs?: { drop: number; steep: number };
  // Case 4 — named per-point gate flags for compound-rule indicators whose decision
  // isn't a single-variable cross (F8 `belowMA200`; F4 `smhBelowMA200`/`nvdaBelowMA200`):
  // the non-drawable AND-conditions that must ALSO hold for the plotted decision
  // variable's band cross to fire. Wire-only — recomputed on read from stored history
  // (src/gates.ts GATES), never persisted. A key is present only where its MA window is
  // fully covered; a missing key/object = unknown → the client draws normally. The
  // generic renderer dims/dashes a `ChartSeries.gatedBy` series where NO listed gate is
  // on, so a non-firing crossing reads as designed rather than a bug.
  gates?: Record<string, boolean>;
  // PER-POINT band cut values, keyed by `ChartBand.fromPoint` (source:"perPoint") — a MOVING
  // threshold that cannot be baked as a build-time scalar. Today: CG's expanding-percentile
  // HG÷GC level cuts (`POINT_BAND_CUTS_OF`), ECY's expensive cut, the σ velocity cuts
  // (`POINT_BAND_SIGMA_CUTS`) and R1's post-inversion amber floor
  // (`POST_INVERSION_BAND`, all src/family-descriptor-rows.ts). Wire-only — recomputed
  // on read from the stored history, never persisted, and it touches NOTHING the point already
  // carries (`value`/`delta20`/`decision`/`rawState`/`state` pass through verbatim).
  // ⚠ A MISSING key means NO CUT on that date (the pre-`levelBandHead` head), never 0: the
  // renderer must break the band line into a gap there rather than drawing it at zero.
  bandCuts?: Record<string, number>;
  // PER-POINT CUSUM ACCUMULATOR `S⁺` for a rolling-σ velocity id — the second scorer leg's
  // own state variable, drawn on the detail chart's SECONDARY axis beside its flat `h` bound
  // (`ChartBand{axis:"secondary", source:"derived", label:"h"}`, src/chart-rail.ts). Wire-only —
  // recomputed on read from the stored history through `velocityCusumSeries`, NEVER persisted,
  // and it touches nothing the point already carries (`value`/`delta20`/`bandCuts`/`rawState`/
  // `state` pass through verbatim). Emitted only for a σ id whose CUSUM knobs also resolve — a
  // speed-only σ id (F11) emits NO `cusum` key at all.
  // ⚠ A MISSING key means NO S⁺ on that date (the σ warm-up head, where z is undefined), never
  // 0: the renderer must break the line into a gap there rather than drawing it at zero — a 0
  // is a real accumulator reading ("drift fully decayed"), so painting one would be a lie.
  cusum?: number;
  // PER-POINT velocity z for a composite velocity scorer leg (BONOS: the WINNING z of its two Δbp horizons,
  // its descriptor's `scorer.constants`; R6 = its single Δlog z), drawn on the detail
  // chart's SECONDARY axis beside its flat zAmber/zRed σ bounds. Wire-only — recomputed on read via
  // `oatVelocityZ` (the ONE owner of velFrom + the offset), never persisted, purely additive.
  // ⚠ A MISSING key means NO z on that date (the pre-head warm-up / σ=0 degrade), never 0.
  velZ?: number;
  // R1's short-leg gate DECISION VARIABLE, drawn on the detail chart's SECONDARY axis: the signed
  // change in the rung's short leg (DGS3MO) over the trailing `shortLegWindow` JOINED obs, in pp.
  // NEGATIVE = the short leg FELL (bull steepening). This is the quantity two otherwise INVISIBLE
  // AND-conditions test — the rung's bull-steepener escalation (`shortLegDropBp`, which turns a
  // firing rung day RED) and the always-on drawdown leg's direction-agnostic move gate (`gateBp`) —
  // so the chart draws them as a crossing instead of painting an un-cued RED. Wire-only —
  // recomputed on read through the SAME walk the scorer gates on (`shortMoveSeries`,
  // scorers-core.ts), never persisted, and it touches nothing the point already carries.
  // ⚠ A MISSING key means NO aligned short obs / an unfilled window on that date, never 0: the
  // renderer must draw a GAP there. A 0 is a real reading ("the short leg is exactly flat"), and on
  // a gap day the gate is structurally off, which is the opposite of what a drawn 0 would suggest.
  shortMove?: number;
  // The trailing PRIOR-window peak an `atOrAboveRollingMax` gate scores against (G1/BRENT) —
  // the gate's own line, drawn as a primary-axis trend overlay. Wire-only — recomputed on read
  // beside the gate flags (src/gates.ts rollingMaxValues), never persisted. A MISSING key means
  // the stored history is shorter than the window ⇒ the renderer draws a GAP, mirroring the
  // absent gate flag.
  rollingMax?: number;
  // The MA50 trend gate's own line, expressed on the DRAWDOWN axis the DB_* detail chart plots:
  // `ma50 ÷ 63d-high − 1`, × 100 like the drawdown itself. Wire-only — recomputed on read beside
  // the `belowMA50` gate flag (api/series.ts downsideSeries), never persisted. It is the SAME
  // condition the flag carries, drawn: `close < ma50 ⟺ dd < gateLine` (both sides ÷ the same
  // positive rolling high), so the line can never disagree with the dimming. A MISSING key means
  // the stored history is shorter than the MA window ⇒ the renderer draws a GAP, mirroring the
  // absent flag.
  gateLine?: number;
  // The `redWindow`-obs trailing mean of the feed — the quantity RED scores on for a two-window
  // smoothed carrier (R1, `SMOOTHED_LEVEL_OF[id].redWindow`), drawn as a SECOND primary line so the
  // ribbon's RED has a visible cause. Wire-only, recomputed on read (`withPostInversionCut`), never
  // persisted. Emitted ONLY for a `redWindow` carrier ⇒ byte-identical elsewhere; a MISSING key = the
  // pre-window head ⇒ the renderer draws a GAP, never 0.
  redMean?: number;
  // DISP's rolling correlation percentile cut (`rollingPercentile` at DISP_CORR_P over the trailing
  // DISP_CORR_P_WINDOW obs) — the B2 deepener line: a `meanCorr` at/above it turns a gated AMBER day
  // RED. Drawn as a primary-axis trend line beside the static DISP_CORR gate band. Wire-only —
  // recomputed on read from the SAME array `dispersionState` deepens against (api/series.ts
  // dispersionSeries), so the drawn line and the ribbon can never disagree; never persisted, and it
  // touches nothing the point already carries. Emitted ONLY on the DISP read path (absent elsewhere).
  // ⚠ A MISSING key means the warm-up head (< DISP_CORR_P_MIN_OBS finite obs ⇒ NaN percentile), never
  // 0: the renderer must break the line into a gap there rather than drawing a spurious low cut.
  corrP90?: number;
};

/** GET /series — one indicator's history, oldest→newest. */
export interface SeriesResponse {
  indicatorId: string;
  label: string;
  /** the indicator's DESCRIPTIVE long name — the detail chart's hover/aria title renders
   *  "short — long (id)". Optional: an old cached payload predates the split, and the client
   *  omits the long-name segment when it is absent. */
  longLabel?: string;
  /** value suffix ("%") / currency prefix ("€"/"$") / "" unitless — the registry `indicator.unit`, PENSION
   *  rows included. Formatted on the client by public/chart-primitives.js `formatValue`. */
  unit?: string;
  points: SeriesPointDTO[];
  // Worst-of (earliest-firing) effective cut per severity in PLOTTED units, computed
  // once at the `recomputedSeries` boundary off the resolved cuts (detail-band
  // effective-line design). The detail chart draws these as flat dashed lines in place
  // of today's static single-leg band. `null` = no applicable cut this severity;
  // ABSENT (both fields) = a non-recompute payload ⇒ client degrades to the static band.
  effAmber?: number | null;
  effRed?: number | null;
  // WHICH OR-legs the scorer tests for this indicator (`LEG_ORDER` ids: op / vel-op / evt / z /
  // vel-evt / vel-z / vel-z-fast / vel-z-slow / vel-cusum), derived from the SAME resolved cuts as `effAmber`/`effRed` (`activeLegs`,
  // domain-legs.ts) — the detail-chart legend names the live legs from this instead of restating them
  // in prose that rots when a leg is retired. Present on the recompute branches that resolve cuts
  // (per-mode + F1/F2 proxy); ABSENT ⇒ the client omits the leg list from the legend.
  scorerLegs?: string[];
  // Per-leg amber/red bound values for exactly the `scorerLegs` set, derived from the SAME
  // resolved cuts (`activeLegBounds`, domain-legs.ts) — the caption PRINTS these when no cut line is in
  // frame (caption-redesign #7), never a hardcoded client-side value. `null` = no bound at that
  // severity (or a σ-leg whose zref is degenerate). Every non-null value is in the leg's PLOTTED
  // axis's units: level legs in `effAmber`'s plotted-level units (the σ-axis z leg zref-inverted
  // the same way), `vel-*` legs in the velocity/Δ units the Δ-axis formatter renders —
  // vel-z/vel-z-fast are velZref-inverted server-side, and vel-cusum (an accumulator with no
  // Δ-axis image) is served null at BOTH severities, the leg staying present.
  // Present exactly where `scorerLegs` is present; ABSENT ⇒ non-recompute payload.
  legBounds?: Partial<Record<string, { amber: number | null; red: number | null }>>;
  // Stand-down (DOWN-only, 2026-08-26 directional fold) buffer in closes for this indicator's
  // family (`confirmClosesFor`) — the legend states it, so never a hardcoded "2" on the client. Absent on VTP (unfolded).
  confirmCloses?: number;
  // Never-scored VALUE-ONLY indicator (api/status.ts PLACEHOLDER_STATE_IDS): every point's
  // `state` is a placeholder GREEN, not a real RAG verdict. Present (true) only for those ids (+ the chained-only
  // LEGP_VALUE/SB_STRAT/SB_BENCH, src/api-routes/series-chained.ts — no band/score/fold, no `confirmCloses`) so
  // the detail-chart ribbon neutralizes to gray (F7/CAPE excluded client-side — it gets a z-severity
  // ribbon). Absent on every scored id, whose ribbon stays the confirmed-state colours.
  valueOnly?: boolean;
  // The display-only `?mult` what-if multiplier as APPLIED to this payload (post-clamp to
  // [0.5, 2.0]); `m < 1` shifted the cuts earlier, `m > 1` later. Present ONLY when the param
  // was supplied AND a recompute branch ran; ABSENT ⇒ this payload is the config-scored
  // ribbon and the client renders no what-if badge. Display-only: the notify path never sees it.
  mult?: number;
  // How many chained-index BASE BREAKS the read-path splice repaired (`spliceChainedIndex`, HCX only).
  // Present > 0 ⇒ the stored rows carried more than one base (a shallow/deep-fetch cron split) and were
  // re-anchored on read so the dist line has no false cliff; ABSENT ⇒ no splice was needed. Surfaces a
  // heal that would otherwise be silent, so a future base drift can't go unnoticed.
  chainSplices?: number;
  // The largest observed consecutive basket factor `max(r, 1/r) ≥ 1` (HCX only), present ONLY when it
  // clears the quiet-market bound (`CHAIN_QUIET_RATIO`). Reveals a base cliff BELOW the splice threshold —
  // one that prints a real chart drop yet is never spliced and leaves `chainSplices` absent. ABSENT on a
  // quiet payload (no field), so a healthy response stays byte-identical.
  maxChainRatio?: number;
  // The served estimate tail, any id (`estimateSlot`; wire name kept from the BRENT/G1 era): built by `estimateSlot` off THIS
  // response's own `points` — `date`/`value` = the newest point when it is `estimated`, `fromDate` = the newest
  // non-estimate point's date. Served, never recomputed on read. ABSENT when the newest served point is not `estimated`
  // or no non-estimate point precedes the estimated tail in the served window — never an error.
  oilEst?: EstimateSlot;
  // A held-fund leg's pre-join stand-in (`LegQuote.proxy`, LEGP_* only): points dated before `until` are the
  // `source` fund's € path scaled to meet the held fund's first close. ONE series-level object; ABSENT elsewhere.
  proxy?: { source: string; until: string };
  // R7: an `isLicensedId` id as served (`redactSeries`, api/series.ts) — state-only points, value/delta20 null,
  // every level-bearing top-level field dropped. The FE paints it ribbon-only. ABSENT on a full payload.
  redacted?: true;
}

/** One member chip inside a GET /lab family — an indicator id + its confirmed state. */
export type MemberDTO = FamilyPanel["members"][number];

/** One danger family in a GET /lab panel (openapi `Family`). Re-exported from
 *  src/families.ts so the wire DTO can't drift from the pure panel type. */
export type FamilyDTO = FamilyPanel;

/** GET /lab — the board snapshot (openapi `LabResponse`): family panel + T1 dial +
 *  R4 overlay; `?hist=N` sets the server-side i5 momentum window (never serialised).
 *  Re-exported from src/families.ts, matching the AlertRecordDTO pattern above — so
 *  `freshnessMissing` (A4: does a freshness stamp stand behind the `observed` census?) rides this
 *  DTO by construction rather than as a hand-kept copy. */
export type LabResponseDTO = LabResponse;

/** One coverage degrade riding `LabResponse.coverage` (openapi `CoverageDegrade`) — a family whose
 *  verdict the served run rested on data that is not live (R5), with the exact members holding it.
 *  Re-exported from src/store.ts (where the alert row's `degraded[].coverage` payload is defined)
 *  so the wire DTO can't drift from what the cron records. */
export type CoverageDegradeDTO = CoverageDegrade;

/** One non-live member inside a `CoverageDegradeDTO` (openapi `CoverageMark`) — same re-export rule.
 *  `reason` is `lag | absent | carried`: `series`/`state`/`ageDays` are populated for `lag`/`carried`
 *  and null for `absent` (no reading that run). */
export type CoverageMarkDTO = CoverageMark;

/** GET /lab `overlays.fallShape` (openapi `FallShapeOverlayView`, NF-1 Stage 5.2) — the shared
 *  `OverlayView` plus the REQUIRED four-valued `confidence` key. `overlays` is a
 *  `Record<string, OverlayView>`, so the extra key cannot be expressed on that map's value type;
 *  this DTO is what `src/lab-overlays.ts`'s `fallShapeView` returns and what a reader narrows to.
 *
 *  `confidence` is a FIRST-CLASS wire key, not copy ([USER] ruling Q1, 2026-07-26): it says WHICH of
 *  `classifyFallShape`'s five `indeterminate` branches fired — `conflicting` (the two axes disagree,
 *  a bear is NOT excluded) is emphatically not the same state as `no-fall`/`dark`. A consumer
 *  branches on this key and must never re-derive the split from `fallVelocity == null`.
 *  Re-exported off `src/v-bear.ts` so the union can't drift from the pure function that emits it. */
export type FallShapeConfidenceDTO = FallShapeConfidence;
export type FallShapeOverlayViewDTO = OverlayView & { confidence: FallShapeConfidence };

/** One per-leg growth-RS row on GET /lab (`LabResponse.growthRs`, G0 Stage 0.3) — the
 *  relative-strength value already ranked by the Y1 resolver, exposed display-only per LADDER
 *  sleeve. Re-exported from src/families.ts so the wire DTO can't drift; `rs` is `null` (never
 *  `0`) on a leg with no defensible RS — and on every row on the served body (3.5b: a statistic over licensed closes). */
export type GrowthRsLegDTO = GrowthRsLeg;

/** One replayed close in a GET /lab `?replay=` leg-path (openapi `ReplayPoint`) —
 *  re-exported from src/replay.ts so the wire DTO can't drift from the replay engine. */
export type ReplayPointDTO = ReplayPoint;

/** Per-member data coverage in a GET /lab `?replay=` run (openapi `ReplayCoverage`) —
 *  re-exported from src/replay.ts (same no-drift pattern). `firstDate` null = no history. */
export type ReplayCoverageDTO = ReplayCoverage;

/** The LIVE-ONLY BAND drill-down riding `LabResponse.band` (openapi `LabBand`) — the
 *  escalator-floor recompute + deduction chain. Re-exported from src/families.ts so the wire
 *  DTOs can't drift from the view types the handler builds (the AlertRecordDTO pattern). */
export type LabBandDTO = LabBand;
export type LabBandFloorDTO = LabBandFloor;
export type LabBandMemberDTO = LabBandMember;
/** One extra server-toned chip on a floor head (openapi `LabFloorChip`, NF-1 Stage 6.1) — the r4
 *  fall-shape + confidence pair today. Same re-export discipline as the three above. */
export type LabFloorChipDTO = LabFloorChip;

/** GET /lab historical-replay (`?replay=`) response (openapi `ReplayResponse`, mode 2b):
 *  the SAME pure pipeline advanced over stored history → a per-day leg-path (`points`) +
 *  per-member `coverage` + server-authored honesty `notes`. NOT a re-export: api/lab.ts
 *  wraps src/replay.ts's ReplayResult with the `mode`/`start`/`end` envelope, so this
 *  interface mirrors that wire shape field-for-field (points/coverage reuse the engine's
 *  element types above so those can't drift). Mode is the constant "replay" discriminant. */
export interface ReplayResponseDTO {
  mode: "replay";
  start: string;
  end: string;
  points: ReplayPointDTO[];
  coverage: ReplayCoverageDTO[];
  notes: string[];
}

/** The D9 scoreboard riding `LabResponse.scoreboard` (openapi `ScoreboardView`) —
 *  live path only, `warmingUp: true` pre-first-cron. Re-exported from
 *  src/scoreboard.ts (same no-drift pattern as AlertRecordDTO/FieldResultDTO). 3.5b: every NAV statistic (metric
 *  values, both ulcer indexes, `returnVsFundPp`) is null on the served body (`withholdScoreboardStats`). */
export type ScoreboardViewDTO = ScoreboardView;

/** `LabResponse.field`: `legRows[].subDangers` = the four share terms (earlyWarn/stressNow `PillarScore` —
 *  narrow via `pillarValue()` — plus trend, gp) whose max is `danger`; `regime`/`snRoc`/`ewRoc` read the same share pillars. */
/** W4 — the per-leg EARLY-WARN pillar percentile cell (`LegRowDTO.ewPct`), a rolling-window
 *  ECDF rank of the leg's EW pillar against its own stored history. FOUR arms, tagged exactly
 *  like `PillarScore` so reading `.value` without narrowing on `kind` is a COMPILE ERROR — the
 *  point of the shape. Three of the four print `—`:
 *   • `pct` — the rank ∈[0,1]; `basisSpans` names the roster-change dates the ranked window
 *     straddles (Stage 4.4);
 *   • `warmup` — fewer than `ECDF_WINDOW` stored closes for this sleeve × super-group. Never impute;
 *   • `na` — the pillar is `uncomparable`: a rank over an absent value is meaningless;
 *   • `stale-basis` — the stored generator vintage ≠ the live one (Stage 4.4). A stale number is
 *     never served.
 *  This type lives on the DTO and NOWHERE inside `src/danger-engine.ts` — deliberately. The
 *  percentile is DISPLAY-ONLY, and putting it on the wire type rather than on `LegRow` makes that
 *  enforced by `tsc` (the engine literally cannot name it) instead of by a docblock. Attached in
 *  `toServedField` (`src/lab-served-field.ts`), AFTER `computeField` has returned. */
export type PercentileCell =
  | {
      kind: "pct";
      value: number;
      /** Roster-change obs_dates INSIDE the ranked window (ascending, newer side of each boundary);
       *  omitted — never `[]` — when the whole window shares one roster. Computed by
       *  `basisChangeDates` (src/leg-percentile.ts) over the rows already read for the rank, so it
       *  costs no extra query. A spanned window earns the FE's `~`. */
      basisSpans?: string[];
    }
  | { kind: "warmup" }
  | { kind: "na" }
  /** Stage 4.4: the stored history was computed by a different engine-formula vintage, so no rank
   *  is served. Both tags ride the wire because the FE title names them — `stored` is the vintage
   *  found in `leg_pillars`, `live` is this deploy's `LEG_PILLAR_GENERATOR`. */
  | { kind: "stale-basis"; stored: string; live: string };

/** OQ-5 Stage 5.4 — the per-leg signal cell and its observation census, as they cross the wire
 *  (openapi `SignalCell` / `CellObserved`). Structural re-exports of the engine types, NOT a second
 *  copy: `LegRow.cells` has always ridden `LegRowDTO` through the `Omit<LegRow, "growth">` spread,
 *  so the census reached the wire the moment Stage 5.2 added it — what Stage 5.4 changes is that
 *  the contract now DOCUMENTS the shape (`cells.items` was a bare `type: object`) and that
 *  `src/api/contract.test.ts` pins both schemas against these types.
 *
 *  ⚠ `src/lab-served-field.ts`'s `toServedField` ends in `as unknown as FieldResult`, which defeats structural
 *  checking on the served object — so the wire presence of `observed` is ALSO pinned at runtime,
 *  through `GET`, in `api/lab.test.ts` ("the per-cell observation census rides every served cell").
 *  A type-only pin here would be green against a handler that stripped the field. */
export type SignalCellDTO = SignalCell;
export type CellObservedDTO = CellObserved;
/** B2 — the hold-window provenance riding `SignalCellDTO.held` (openapi `HeldMark`). Same structural
 *  re-export discipline as the two above: it reaches the wire through `LegRow.cells` unchanged, and
 *  the alias exists so `src/api/contract.test.ts` can pin the schema's key set against the engine
 *  type rather than against a hand-copied shape. */
export type HeldMarkDTO = HeldMark;

/** The `LegRow` keys that are ENGINE-ONLY and never cross the wire — DECLARED ONCE, here, and MADE
 *  TRUE at one seam: `src/lab-served-field.ts`'s `toServedField` deletes exactly these keys off every served row
 *  (it reads this alias through a `satisfies Record<LegRowEngineOnly, true>` map, so a key added here
 *  is a compile error there until the strip covers it). Removing a key from the alias without also
 *  documenting it in `openapi.yaml` therefore leaks bytes, and adding one without touching the seam
 *  cannot compile.
 *
 *  Today: `riskClass` only (2026-08-02, seating Stage 3) — the DECLARED R3 cyclical/defensive
 *  partition on `LEG_FIELD`, an internal shrink-target input, not a display field. Promoting it to
 *  the wire is a separate, deliberate `openapi.yaml` + contract-sample decision.
 *
 *  ⚠ THIS ALIAS IS NOT A PLACE TO SILENCE A RED CONTRACT LITERAL. `src/api/contract.test.ts`'s
 *  hand-typed `legRow: LegRowDTO` exists so that a field added to `LegRow`/`LegField` is a compile
 *  error until the YAML documents it. Widening this alias to make such a red go away disables that
 *  guard and ships an undocumented field; the only legitimate reason to add a key is that the seam
 *  genuinely strips it from the served bytes, pinned at runtime in `api/lab.test.ts`. */
export type LegRowEngineOnly = "riskClass";

export type LegRowDTO = Omit<LegRow, "growth" | LegRowEngineOnly> & {
  /** G1 growth pillar: the leg's growth value when the pillar is live, else null (the subDangers null
   *  idiom — never 0). Since G2.1 BOTH production paths supply the rs/mom maps — the cron/notify path
   *  (`run-core.ts`) and /lab — so this serializes a number on either. **DISPLAY-ONLY again since
   *  Rung 4 Stage 2 (2026-08-03):** G2.3 had made `pickHeld` read growth as a within-band tiebreak on
   *  the held-leg pick, and the `[USER]` option-E ruling retired that (the eps arm is deleted). Growth is
   *  still computed and served; it no longer reaches the pick, and it never entered the danger
   *  scalar in any era. */
  growth: number | null;
  /** G1 raw per-leg vol-adjusted momentum z-score (computeVolAdjMom), display-only for
   *  inspectability (§0b); null when undefined (starved leg / degenerate cross-section). */
  volAdjMom: number | null;
  /** W4 Stage 4.1 — the EARLY-WARN pillar's rolling-ECDF percentile cell, DISPLAY-ONLY. Wire-only
   *  by construction: it is absent from `LegRow`, so nothing in `src/danger-engine.ts`
   *  (`danger`/`subDangers`/`regime`/`inBand`/`held`) or on the notify path can
   *  read it. At Stage 4.1 there is no stored history and no math yet: `toServedField` emits
   *  `{kind:"na"}` for an uncomparable EW pillar and `{kind:"warmup"}` otherwise, so every leg
   *  prints `—`. The `pct` arm arrives with the real rank in Stage 4.3. */
  ewPct: PercentileCell;
};
export type FieldResultDTO = Omit<FieldResult, "legRows" | "held"> & { legRows: LegRowDTO[]; held: LegRowDTO | null };
export type SubDangersDTO = SubDangers;

/** GET /api/exposure (slice E1) — the two-key exposure dial (openapi `ExposureResponse`).
 *  The pure `ExposureResult` (posture + ARM/FIRE keys + one-line summary) from
 *  src/exposure.ts, plus the wire-only `asOf` = newest date across the F1 (credit) and
 *  GT (trend) series (null when both empty). Re-exported from src/exposure.ts so the
 *  posture/key shape can't drift from the engine (the AlertRecordDTO pattern); `asOf`
 *  is one of two hand-added envelope fields. Empty pre-first-cron DB ⇒ posture null.
 *  `thresholds` is the other: the served ARM/FIRE cuts (`EXPOSURE_THRESHOLDS`) the chip
 *  footnotes print, so `public/` holds no numeric copy of a cut (R1 seam ruling). 3.5b: `arm.roc` and `fire.maSpread`
 *  are null and `summary`'s ROC slot "—" on the served body (`withholdExposureStats`). */
export type ExposureResponse = ExposureResult & {
  asOf: string | null;
  thresholds: ExposureThresholds;
  /** Set iff the posture is bounded off the daytime `intraday_verdict` slot (`servedVerdict`), not the EOD row. */
  provisional?: true;
};

/** One replayed trading day inside a GET /api/replay episode (openapi `ExposureReplayPoint`)
 *  — derived from src/exposure-replay.js so the wire point can't drift from the replay
 *  engine (the ExposureResponse no-drift pattern). `posture` null = degraded input;
 *  `price` null = withheld on a `redacted` body (raw vendor close, src/licensed.ts). */
export type ExposureReplayPointDTO = Omit<ExposureReplayPoint, "price"> & { price: number | null };

/** One episode in GET /api/replay (openapi `ExposureReplayEpisode`): the pure `Episode`
 *  descriptor + its replayed `points`, an optional `defensive` (IEF bond-rung proxy) line
 *  present only when IEF history covers the window's open, and server-authored honesty
 *  `notes`. Extends `Episode` so the id/label/window/candidate/rationale fields can't drift. */
export interface ExposureReplayEpisodeDTO extends Episode {
  points: ExposureReplayPointDTO[];
  /** `price` null = withheld on a `redacted` body. */
  defensive?: { date: string; price: number | null }[];
  notes: string[];
}

/** GET /api/replay (slice E2, Stage 6) — every crisis episode replayed in one payload
 *  (openapi `ExposureReplayResponse`) so the /lab episode-replay section switches with zero
 *  refetch. `asOf` = the newest underlying observation across the fetched feeds. */
export interface ExposureReplayResponse {
  asOf: string;
  episodes: ExposureReplayEpisodeDTO[];
  /** Set on the served body: every raw close nulled (`redactReplay`, api/replay.ts). Absent on a full body. */
  redacted?: true;
}

/** GET /api/replay?companion=<id> (Rung E3, openapi `ReplayCompanionSeries`) — one external
 *  companion-overlay series (VIXCLS / T10Y2Y / DCOILWTICO / ^IXIC) served off its cron-persisted
 *  raw rows (src/input-series.ts), sliced server-side to the `from`/`to` episode window. Shaped like
 *  the slim core of `SeriesResponse` so the replay chart consumes either interchangeably. */
export interface ReplayCompanionResponse {
  indicatorId: string;
  label: string;
  unit: string;
  points: { date: string; value: number }[];
  /** A redacted companion (the R7 source roster), for every request: `points` empty. */
  redacted?: true;
}

/** GET /families element — one display GROUP's metadata (openapi `FamilyMeta`). The ordered
 *  list the Dashboard + Lab group their cards under (Stage 3); membership itself rides the
 *  `family` key on each IndicatorMeta / the /lab panel, not here. `key`/`label`/`desc` come
 *  straight off DASHBOARD_FAMILIES (families.ts) — plus, since the 2026-07-30 E6(a) ruling,
 *  one synthetic entry per non-family `CARD_ONLY_GROUPS` zone, so "family" is now a slight
 *  misnomer for the list as a whole (see `ids`).
 *
 *  ⚠ **`FamilyMeta.ids` means "dashboard RENDER RANK", not family members** (E6(a) accepted cost).
 *  Never re-introduce a roster copy in the browser. */
export interface FamilyMeta {
  key: string;
  label: string;
  desc?: string; // one-line "what this family is" for the group heading tooltip
  /** sanctioned-stub reason (FamilyDef.awaiting) — WHY a feedless family has no members,
   *  rendered in place of the generic "no live feed" empty state. Present ONLY on a
   *  deliberately-feedless family; absent on every live one. */
  awaiting?: string;
  /** **Dashboard RENDER RANK — NOT the family's members.** (E6(a) 2026-07-26; meaning
   *  widened 2026-07-30 by the USER-ruled option A, and the rename of the field was
   *  deliberately declined.) The family's ranked members in IMPACT ORDER first
   *  (`DASHBOARD_FAMILIES[].ids`), then that family's `CARD_ONLY_GROUPS` display-overlay ids —
   *  which are NOT panel/dial members and exist only as Dashboard cards. Read membership off
   *  `/lab`'s panel or `DASHBOARD_FAMILIES`, never off this array.
   *  Served so both card grids and the `<select>` pickers sort by rank: `/api/indicators` is
   *  registry-ordered and cannot supply it. Ids the surface has no card for are simply absent
   *  from its filtered set — the sort tolerates that. The list also carries a SYNTHETIC entry
   *  per overlay group that is not a family at all (today `pension-drawdown`). */
  ids: string[];
}

/** GET /danger-model payload (openapi `DangerModel`) — the STATIC danger-model reference block
 *  single-sourced from src/danger-ladder.ts + src/families.ts (Stage 4). Identical every run;
 *  `lab.js` fetches it once and `decorateCell` rebuilds each signal cell's M/N tooltip from it. */
export interface DangerModel {
  /** FamilyKey → 2-letter SignalKey bijection (SIGNAL_OF). */
  signalOf: Record<FamilyKey, SignalKey>;
  /** its inverse, SignalKey → FamilyKey (FAMILY_OF_SIGNAL). */
  familyOfSignal: Record<SignalKey, FamilyKey>;
  /** lead-time super-groups in render order (SUPER_GROUPS, Stage 5.1). */
  superGroups: SuperGroup[];
  /** SignalKey → its lead-time super-group (SUPER_GROUP_OF) — drives the board's tile group labels. */
  superGroupOf: Record<SignalKey, SuperGroup>;
  /** member id → relevant leg sleeves (MEMBER_RELEVANCE, the non-zero support of MEMBER_WEIGHT). */
  memberRelevance: Record<string, string[]>;
  /** member id → leg sleeve → MAGNITUDE weight (MEMBER_WEIGHT), served raw (R3, 2026-07-18) so the
   *  M/N drill-down tooltip can print the `×<weight>` suffix the family-taxonomy restructure dropped.
   *  Strictly a SUPERSET of `memberRelevance` (which is its non-zero support) — both are served
   *  because the mask is what `decorateCell` filters on and is the cheaper read; deriving one from
   *  the other FE-side would put the support rule in two places. Sleeves absent from a member's row
   *  are weight 0, i.e. not relevant, and never reach the tooltip. */
  memberWeight: Record<string, Record<string, number>>;
  /** member id → short display label (MEMBER_LABEL). */
  memberLabel: Record<string, string>;
  /** correlated-leg clusters keyed by sleeve (CLUSTERS). */
  clusters: string[][];
  /** concentration-cap knobs (CONC_THRESHOLD / CONC_WEIGHT). */
  concThreshold: number;
  concWeight: number;
  /** held-pick anti-whipsaw deadband + re-risk confirmation knobs.
   *  ⚠ Since 2026-08-07 the two TIMING knobs are ZERO —
   *  `reriskConfirm` is 1 and `reriskDwellDays` is 0, so neither gates anything on the live path.
   *  They stay on the wire as the re-arm levers (and because the FE renders them); a consumer must
   *  read the served numbers, never assume the retired M5/M7 asymmetry. `reriskDeadband` is the
   *  only surviving re-risk brake, and it HALVED in the same commit. */
  deriskDeadband: number;
  reriskDeadband: number;
  reriskConfirm: number;
  /** re-risk held-leg min-dwell in trading closes (RERISK_DWELL_DAYS). `0` since 2026-08-07 —
   *  a ledger the FE renders, no longer a gate. */
  reriskDwellDays: number;
  /** leg-RAG amber/red cuts (DANGER_CUTS) — the FE ledger idioms colour from these so a USER
   *  retune propagates without an FE edit; mirrors the server severity mapping. */
  legRagCuts: { amber: number; red: number };
  /** PILLAR_MEMBER_IDS — the ids a danger cell folds; a `memberWeight` key outside it carries the Dashboard ⌁ note. */
  pillarIds: string[];
}

/**
 * Declarative detail-chart spec (Case 1). Backend-emitted per indicator so the
 * generic renderer draws every id from ONE model instead of an id-shape dispatch.
 * Additive + optional — added Stage 2; the FE does not consume it until Stage 5.
 */
export interface ChartAxis {
  id: "primary" | "secondary";
  side: "left" | "right";
  unit: string; // "%", "", "€", "$", "pp" (a level Δ of a %-quoted id), "bp" — tick/label formatting unit
  format: "value" | "derived"; // formatValue vs formatDerived; a "pp" value axis prints via formatLevelDelta
  // Axis title — e.g. "6-mo return", "EURUSD=X price", F9's velocity-only "Δ60d". Was secondary-only
  // until 2026-08-07, when the velocity-only generic route began captioning its PRIMARY axis
  // (the FE previously fell back to a hardcoded "Δ20 (20-day change)"). Absent ⇒ the renderer
  // picks its own default for that axis.
  label?: string;
  // Fixed [lo, hi] for the axis (an integer 0..RED rank); absent ⇒ the renderer fits the data extent.
  domain?: [number, number];
}
export interface ChartSeries {
  axis: "primary" | "secondary";
  fromPoint?: string; // point field: "value" | "delta20" | "decision" | "havenLegs.eur"|".chf"|".jpy"
  // named compute hook (worst-of max / 30-obs rate-of-change / 200-obs trailing mean / recession
  // probit of `value` / rise-from-trailing-low / trailing return) — overrides fromPoint. `probit` is
  // DISPLAY-ONLY and R8-only: it reads `value`, which for R8 is the 21-obs mean the model is estimated
  // on. `lowRise` (F1's displayOnly credit leg) and `trailingReturn` (F13's d20 scorer leg) read their
  // lookback from `window` below — never a name-baked literal.
  // ⚠ `trailingReturn` is `v[i]/v[i−window] − 1` — the SCORED quantity where the plotted `value` IS the
  // scorer's own series (F13: `value` is the HYG÷LQD ratio, so the hook reproduces its d20 leg exactly).
  // It is NOT `delta20`, which is the stored level DIFFERENCE and would paint a different number.
  // `ma50`/`ma200` = the trailing mean of `value` over PRICE_WINDOWS.maShort / MA_WINDOW obs (one
  // parametrised FE helper; the window rides the hook name, mirrored + parity-pinned client-side).
  // `high60` = the max of `value` over the inclusive `highWindow` closes ending at each point (XDEV_GATE_DESCRIPTOR).
  // `rv10` = annualised realized vol of the `rvWindow` log returns ending at each point (`RV10_OVERLAY`).
  // `delta` = `v[i] − v[i−window]`, the level difference (the display-only Δ5 line, `DELTA5_OVERLAY`).
  // `offHigh` = `v[i] / max(v over the inclusive `window` closes ending at i) − 1` (F17 — spit yen-gate overlay, `OFF_HIGH_OVERLAY_OF`).
  // `median` = the median of `value` over the inclusive `window` closes ending at i (`MOVE_MEDIAN` / `VOL_MEDIAN` toggle lines, R6/VXNCLS).
  // `vetoBreach` = `value` on a day whose log return ln(c_t/c_t−1) is under −vetoSd × σ of the sigmaWindow log returns ending
  // vetoWindow back, else null (Value XDEV's veto dots, `TOGGLE_OVERLAYS`).
  compute?: "havenEnvelope" | "roc30" | "ma50" | "ma200" | "high60" | "rv10" | "rv20" | "vetoBreach" | "probit" | "lowRise" | "trailingReturn" | "delta" | "offHigh" | "median";
  // Lookback in observations for a windowed compute hook that can't bake it into the name (`lowRise`
  // → F1_LOW_RISE_WINDOW, `trailingReturn` → F13's `retWindow`, threaded off the descriptor so the
  // window has ONE source). Absent ⇒ the hook that reads it gaps; roc30/ma200 carry their window in
  // the name and ignore this.
  window?: number;
  // Multiplies every computed/read value of THIS series before it is drawn (absent ⇒ 1).
  // Today: F8's MA200 overlay is drawn at MA200·MU_MA_MULT so the orange line IS the gate
  // line it is scored against, rather than a bare MA the reader must mentally scale.
  scale?: number;
  // Legend/readout name override for this series (absent ⇒ the renderer's per-hook default,
  // e.g. "200-day MA"). Server-supplied so the gate's headroom text is single-sourced.
  label?: string;
  // `scored-mean` = a SOLID primary overlay that IS a scored metric (R1's redWindow mean) — solid
  // vs the dashed `trend`/`derived` overlays is the load-bearing distinction (scored vs derived).
  // `step` = the primary stroke drawn as a horizontal-then-vertical staircase (an integer rank; a `toggle`
  // overlay's stepped line). `dots` = a mark per non-null point, no line (a `toggle` overlay only — XDEV's veto days).
  style: "primary" | "derived" | "leg" | "envelope" | "trend" | "scored-mean" | "step" | "dots"; // maps 1:1 to stroke specs
  // Case 4 — keys into `SeriesPointDTO.gates`: the renderer dims/dashes this series'
  // segments where NO listed gate is on (a band cross there cannot fire). Absent (or
  // no flags on the wire) ⇒ the series draws normally.
  gatedBy?: string[];
  // Leg↔cut pairing (R7 "drop"/"steep"): series + bands sharing a `pair` render in ONE hue
  // (FE maps it to a CSS var); absent ⇒ today's strokes, byte-identical.
  pair?: string;
  // Stroke tone. On a `trend` overlay: absent ⇒ `--trend-line` (blue, every existing trend user);
  // "alt" ⇒ `--trend-line-2` (orange); "white" ⇒ `--trend-line-white`; "cyan" ⇒ `--trend-line-cyan` (EU-Fin EXSH's
  // RV20 beside its blue RV10); "trend" ⇒ `--trend-line` explicitly.
  // EXSH_GATE gives each line its own hue (MA50 white, MA200 orange). On the `derived` decision line:
  // absent ⇒ `--ink-dim` (every existing user); a tone recolours it (EXSH_GATE: "trend", blue). The legend
  // names the colour whenever more than one trend line is drawn, and on a toned decision line.
  tone?: "alt" | "white" | "cyan" | "trend";
  // A VIRTUAL axis: drawn on its own scale fitted to the plot height — no ticks, label or margin, never
  // in the primary domain — its number in the hover readout only. Single layout only (`DELTA5_OVERLAY`, all five
  // ids; the `RV10_OVERLAY` ids; R4). Realized-vol lines (`rv10`/`rv20`) on one chart SHARE one fitted scale, and
  // level-difference lines (`delta` — R4's Δ63 + Δ120) another, so they compare. Hidden by default: rides the shared `.fit-lines` toggle.
  fit?: true;
  // A `fit` line's display-only reference: a faint hairline in the line's tone at `value` on its fitted scale
  // (kept inside the scale's extent), `label` named in the legend. R4's Δ120 → spit's escalation cut.
  ref?: { value: number; label: string };
  // Display-only overlay on its OWN axis' scale that rides the shared `.fit-lines` group — hidden until a legend
  // `.fit-toggle` flips it with the Δ5 lines. Never joins the axis domain (the hidden-by-default frame stays
  // unchanged); points outside the frame gap. Single + derived layouts (`TOGGLE_OVERLAYS`; derived has no `fit` axis).
  toggle?: true;
  // Hover: this `fit`/`toggle` line's value prints in the EXPANDED readout (the docked strip) only — never the
  // compact chip. A `fit` line otherwise rides both; a `toggle` line otherwise rides neither (EU-Fin EXSH's
  // RV20/MA50/MA200, user ask 2026-10-11).
  readout?: true;
  // A `toggle` overlay drawn in a CUT's stroke — severity hue + dash, `approach` = the faint dotted pre-alert
  // style, as on a `ChartBand` (XDEV's € zone lines + red veto dots). Absent ⇒ the trend `tone`.
  cut?: { level: "amber" | "red"; style?: "approach" };
}
/** Case 4 — one declared gate condition of a compound-rule indicator (legend copy). */
export interface ChartGate {
  key: string; // wire key into SeriesPointDTO.gates
  label: string; // human phrase, e.g. "MU below its 200-day MA"
  appliesTo: "amber" | "red" | "both"; // which band(s) the gate arms
}
export interface ChartBand {
  level: "amber" | "red";
  axis: "primary" | "secondary";
  source: "derived" | "displayBand" | "threshold" | "effective" | "perPoint";
  metric?: "level" | "velocity"; // source:"threshold" only (which thresholds pair)
  value?: number; // source:"derived"|"displayBand" — resolved at BUILD time
  // source:"perPoint" only — the key into `SeriesPointDTO.bandCuts` carrying THIS band's value
  // for each date. The band is a per-DATE series, not a scalar, so no `value` rides the spec.
  // A point missing the key has no cut on that date ⇒ the renderer draws a GAP, never 0.
  fromPoint?: string;
  label?: string; // source:"displayBand" — strict/inclusive edge text ("red >1.00")
  // Compact ON-PLOT chip text for a MOVING (source:"perPoint") cut — 2 glyphs, e.g. "2A"/"sR".
  // The renderer draws it in the right MARGIN (outside the plot frame) instead of the full `label`,
  // which stacked four ~120px strings over the newest observations and buried the lines
  // (`[USER]` 2026-08-29). The full `label` still names the cut in the legend, keyed by this chip.
  shortLabel?: string;
  // "approach" — fainter pre-alert rendering; on a perPoint band, a display-only REFERENCE line that is
  // not a cut (a `dualAxis.refSigma` 1σ line), drawn faint + dotted; "evt" — a MEASURED leg's cut drawn beside the
  // operative one (F1: the `hyoas_evt_level_*` pair), dotted so the two pairs never read as one.
  // Absent = full strength.
  style?: "approach" | "evt";
  // A σ-REFERENCE perPoint band only (`dualAxis.refSigma`): the σ multiple the line sits at, so the
  // hover recovers σ(t) = cut ÷ multiple and z = Δ ÷ σ off the wire it already has. Absent on every cut.
  sigmaMultiple?: number;
  // Same `pair` contract as ChartSeries — the hue carries LEG identity; severity stays on
  // stroke weight/dash + the amber/red label text.
  pair?: string;
}
/**
 * Case 3 — band-completeness contract, expressed INSIDE the chart-spec type (user
 * decision: not a standalone lint). A chart declares EITHER one-or-more real amber/
 * red `ChartBand`s OR the explicit `"context-only"` sentinel (a context/notify-neutral
 * channel that is genuinely unbanded — no threshold lines by design). There is no
 * third "silent empty array" state: an id that emits neither is caught by the
 * `ALL_INDICATORS` chart-band coverage test (src/chart-bands.test.ts). So a missing
 * threshold line is always a declared choice, never a forgotten wiring.
 */
export type ChartBands = ChartBand[] | "context-only";
export interface ChartSpec {
  axes: ChartAxis[];
  series: ChartSeries[];
  bands: ChartBands;
  // Case 4 — the compound-rule gate declarations (src/gates.ts GATES) backing the
  // legend's "also requires …" copy; present only on gated ids (F4/F8).
  gates?: ChartGate[];
  window?: number; // visible trading days to render (default DETAIL_LIMIT); F1 → ARM_RANGE_WINDOW (504)
  lead?: number; // extra leading points fetched to feed a windowed compute but never drawn; F1 → ARM_ROC_WINDOW (30)
  // DATE-anchored visible window (aligned-start ids: F1/F3/F13/SPY/VT/DISP). A calendar-days
  // lookback: every chart carrying it begins at the SAME start date, so series sampled
  // differently (F3 weekly, the rest daily) or with mid/end gaps no longer drift apart the way
  // a trading-day COUNT window (`window`) makes them. SUPERSEDES `window` when present. The
  // server emits `fromDays`; the client computes `fromDate = today − fromDays` and injects it,
  // and the renderer slices the visible window at the first point whose date ≥ `fromDate`.
  fromDays?: number; // calendar-days lookback (buildChart DETAIL_WINDOW_DAYS)
  fromDate?: string; // ISO anchor injected CLIENT-SIDE at render (today − fromDays); never emitted server-side
  // PER-LEG band lists (F1, 2026-07-23): this spec draws each drawable OR-leg as its OWN cut pair,
  // so the renderer must NOT override the level band with the `effAmber/effRed` worst-of composite.
  // ⚠ HISTORICAL motive, kept because it is the failure mode this flag exists to bar, NOT a live
  // description: back then the composite's min for F1 was the regime-z cut inverted through the
  // Baa10y PROXY's zref (~2.17/2.29 pp) — proxy units painted on the HY-OAS axis, hiding the very
  // operative pair the leg lines exist to show. Since 2026-07-23 the borrowed leg carries no
  // `zref*` at all (`resolveCuts` suppresses it for proxy ids), so `effectiveCuts` drops it and
  // the composite equals the registry level pair — measured, and pinned for BOTH proxy ids in
  // `src/effective-cuts.test.ts`. The flag stays as the structural guard: declared on the SPEC,
  // not inferred from the presence of an `evt`-styled band, so a future vintage that re-emits a
  // proxy zref cannot silently re-enable the very override this bars.
  legBands?: boolean;
  // FE layout dispatch key (CHART_DESCRIPTOR_OF override, else derived from the spec SHAPE by the
  // FE's own sniff expression — `rendererForSpec`, chart-rail.ts). Absent (old payload) ⇒ FE sniffs.
  renderer?: "single" | "fx" | "derived";
}

/**
 * One as-of window of the EW-R1 bps sensitivity report (EW-7). The shipped cuts are
 * PERCENTILES of an unconditional distribution, so the bps they imply moves with the
 * regime the window covers — this makes that regime-dependence legible on the wire
 * instead of leaving the reader to assume the published bps is a fixed constant.
 */
export interface BpsSensitivityPoint {
  window: string; // human label, e.g. "trailing-5y @ 2019-12-31"
  start: string; // window open (ISO date)
  asOf: string; // window close (ISO date) — the "today / 2015 / 2019" axis
  n: number; // observations in the window (a thin window's quantile is not comparable)
  amberBps: number; // what the AMBER percentile implies in bps over THIS window
  redBps: number; // what the RED percentile implies in bps over THIS window
}

/**
 * The bps a shipped percentile cut implies today, in 2015 and in 2019 (EW-7). Sourced
 * verbatim from the committed measurement output `scripts/backtest/f1_cuts.json` — NOT
 * recomputed at request time, so the wire cannot disagree with the published vintage.
 * Present only for the id whose series the measurement covers (today: F1 / BAMLH0A0HYM2);
 * every other indicator omits it, which is why it is optional.
 */
export interface BpsSensitivity {
  source: string; // repo path of the committed measurement output
  series: string; // the measured series id — must match the indicator's `series`
  leg: string; // which leg the percentiles cut (today: the level leg)
  percentiles: { amber: number; red: number }; // the shipped percentile pair, e.g. 0.66 / 0.90
  points: BpsSensitivityPoint[]; // one per as-of window, newest first
}

/** GET /indicators element. */
export interface IndicatorMeta {
  id: string;
  label: string;
  series: string;
  channel: Channel;
  family?: string; // the 8-family Dashboard grouping (Stage 5); absent for PENSION/BOTTOM (no card)
  unit?: string;
  thresholds: Thresholds; // amber/red cut-points; {} for bespoke price scorers (F4/F5)
  direction?: Direction; // level polarity; absent = HIGH (higher is worse)
  // The feed's RELEASE schedule (absent = daily) — how often it PUBLISHES, NOT the grid its
  // observations sit on. It does NOT decide a velocity label: the per-observation WORD resolves
  // `obsCadence ?? cadence` (see that field below) and the SPAN comes from `velocityWindow`,
  // never from a literal 20. Used here for freshness/lag copy and as the `obsCadence` fallback.
  cadence?: "daily" | "weekly" | "monthly" | "quarterly";
  // The velocity span the `delta20` column on this id actually carries, in OBSERVATIONS —
  // the registry's `velocityWindow`, absent ⇒ the global `VELOCITY_WINDOW` (20), exactly as
  // `cadence` above means "absent = daily". Emitted so a card/tooltip can caption Δ without
  // a `ChartSpec` in hand — a shared hardcoded "Δ20" copy is wrong for every carrier of this
  // field (which ids carry one: `registry.ts`).
  // ⚠ The companion unit WORD is NOT `cadence` — that is the RELEASE schedule, and
  // F9/F11 release weekly over a business-day observation grid, so "Δ60 weeks" would be 5×
  // wrong. Server-side the rail resolves the grid from the registry's `obsCadence ?? cadence`
  // (`domain-types.ts`) and ships the finished caption as the velocity axis' `label`; a client
  // composing its own text must resolve `obsCadence ?? cadence` (the field below, on the wire
  // since 2026-08-07) and never `cadence` alone — a weekly arm is correct only for an id that
  // genuinely OBSERVES weekly (F3), never for F9/F11.
  velocityWindow?: number;
  // `"relative"` ⇒ `delta20` is a FRACTION of the base level (registry `velocityMode`); absent ⇒ absolute Δ.
  velocityMode?: "relative";
  // The OBSERVATION grid `velocityWindow` steps over, where `cadence` above is the RELEASE
  // schedule. Absent ⇒ fall back to `cadence` (itself absent ⇒ daily), so a client's one rule
  // is `obsCadence ?? cadence` — the SAME expression the server rail uses (`chart-rail.ts`
  // `velocitySpanWord`). Declared on any id whose RELEASE schedule outruns its observation grid —
  // the FRED H.10 and EIA families both do; which ids exactly: `registry.ts`, and the resolved
  // word per id is pinned in `public/velocity-span.test.js`. Emitted because `public/app.js`'s card chip and
  // Δ tooltip have no `ChartSpec` in hand: reading `cadence` alone captions F9's 60-trading-day
  // change "60 weeks", a 5× error.
  obsCadence?: "daily" | "weekly" | "monthly" | "quarterly";
  derived?: DerivedView; // bespoke scorers (F4/G1/NVDA/F5): decision-variable descriptor for the detail chart; absent = level/velocity bands
  // Declarative detail-chart spec (Case 1, Stage 2): axes/series/bands built from the
  // SAME config the scorer + generic renderer read (derived bands via scaleDerived, VT via
  // the scorer's ratio constants). Optional for old-payload tolerance; the FE ignores it
  // until the Case-1 collapse (Stage 5). Additive — no existing meta field changes.
  chart?: ChartSpec;
  // EW-R1 Stage 4.1 (EW-7): what the shipped PERCENTILE cut implies in bps today, in 2015
  // and in 2019. Report-only — nothing scores off it. Present only for the indicator whose
  // `series` the committed measurement covers; absent everywhere else.
  bpsSensitivity?: BpsSensitivity;
  // P4 companion-eligibility anchor — newest stored obs at/before STORED_COMPANION_HORIZON (2015-01-01);
  // present ⟺ history reaches the horizon (lab.js's ≥2015 sweep reads it, `!= null`). NOT the literal earliest.
  companionAnchorDate?: string;
  /** CHART-ONLY (`CHART_ONLY_INDICATORS`, registry.ts — VTP today): the id is persisted and
   *  served as history, but is in NO scored set, NO panel/dial family, NO roll-up and off the
   *  notify body. `true` only for those ids — absent (never `false`) for every scored indicator,
   *  so an old payload reads the same as a scored one. The Dashboard card renders a
   *  "chart only — not scored" marker off it (public/app.js renderCard). */
  chartOnly?: true;
  /** D2 engine role, derived server-side (api/indicators.ts roleOf): `member` = holds a
   *  `MEMBER_WEIGHT` row in the danger model; `chart-only` = `CHART_ONLY_IDS`; `early-warning`
   *  = an `EARLY_WARN_MEMBERS` downside detector or its `RS_LEG_OF` rel-strength gate leg
   *  (WATCH-capped alert-band floor, no family weight); `context` = served/charted with no weight of
   *  its own (raw composite legs, pension track, observability ids). Always present. */
  role: "member" | "chart-only" | "early-warning" | "context";
}
