/**
 * Fast-path CONFIRMERS as DATA (architecture refactor D3 — the fast-path twin of
 * `TRACKS` in tracks.ts).
 *
 * G1 (auto-GEO oil), EBP (credit), R6 (MOVE bond-vol), R7 (bull-steepener), CG
 * (copper/gold), VT (VIX term-structure), BRENT (auto-GEO Brent confirm), VTP (VIX
 * backwardation streak), ECY (excess-CAPE-yield valuation gate), NG (Henry Hub natgas) and VXNT (VXN
 * term structure) are near-identical secondary confirmers: each fetches its own feed (or, for VT/VTP/VXNT,
 * reads the shared VIXCLS/VXVCLS legs; for ECY, the ctx-threaded F7/DFII10/GT inputs), scores through a bespoke
 * scorer, and degrades to nothing on a feed hiccup so
 * it can NEVER abort the FRED credit/rate core (§5 pre-mortem). Before this table each
 * one was hand-wired in multiple places in run.ts, and a confirmer added in one place
 * but forgotten in another silently diverged the derivations (the exact bug class the
 * TRACKS/S1 refactor killed for the off-ladder tracks).
 *
 * `FAST_CONFIRMERS` is the SINGLE source: `runScoringCycle` loops it to build
 * `readings`. Every scorer call, degrade message and the order in `readings` is
 * preserved byte-for-byte vs. the old hand-repeated wiring.
 */

import {
  G1,
  BRENT,
  NG,
} from "./registry-geo.js";
import {
  EBP,
  R6,
  ECY,
  INDICATORS,
} from "./registry-fred.js";
import {
  R7,
  CG,
  VT,
  VTP,
  VXNCLS,
  VXNT,
} from "./registry-composite.js";
import {
  VELOCITY_WINDOW,
  type Indicator,
  type Observation,
  type Reading,
  type State,
} from "./domain-types.js";
import {
  indicatorReadingSeries,
  oilReadingSeries,
  scoreIndicator,
  scoreOil,
  scoreSmoothedLevel,
  smoothedLevelReadingSeries,
  withNewest,
} from "./scorers-core.js";
import {
  scoreRatioSpread,
  latestRatioSpread,
  ratioSpreadReadingSeries,
  cgPoints,
  cgRows,
  cgLookbackDays,
  latestMove,
  moveReadingSeries,
  moveScoreRows,
  vixTermPersistenceReadingSeries,
  scoreVxnTerm,
  vxnTermDenominator,
  vxnTermReadingSeries,
  scoreBullSteepener,
  bullSteepenerReadingSeries,
  scoreEcy,
  ecyRows,
} from "./scorers-composite.js";
import { resolveCuts } from "./domain-cuts.js";
import { type ProxyLegSeries } from "./domain-fold.js";
import {
  CG_DESCRIPTOR,
  F3_VELOCITY_BAND,
  GEO_HYBRID_DESCRIPTOR_OF,
  OIL_LEVEL_LOOKBACK_DAYS,
  POINT_BAND_CUTS_OF,
  SMOOTHED_LEVEL_OF,
  VT_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { confirmClosesFor } from "./family-table.js";
import { sinceDaysAgo } from "./lookback.js";
import { fetchesDeep, fetchesFromFred, graftTreasuryHeadFor } from "./indicator-feed.js";
import { estimateDatesOf } from "./estimated.js";
import { feedsOf, type FeedPorts } from "./feed-ports.js";
import { CG_DB_FIRST_FEED } from "./db-first-specs.js";
import { degrade, recordDegrade } from "./tracks.js";
import { errMsg } from "./err-msg.js";
import { synthesizedCalib, SYNTH_HISTORY_LIMIT, type SynthHistories } from "./synth-cuts.js";
import type { CalibrationParam } from "./store.js";
import {
  dbFirstOrDirect,
  deepArmSince,
  needRowsForCalendarDays,
  needRowsForSeedDepth,
  TAIL_DAYS,
  tailSince14,
  type DbFirstCtx,
  type DbFirstFeedSpec,
} from "./series-db-first.js";
import type { Env } from "./config.js";

/**
 * Calendar days of ^MOVE history the R6 deep fetch asks for. Cut 1500 → 900 when the legacy detrended
 * leg (rolling-750) was DELETED 2026-08-31. HELD at 900 through the N1 deletion (2026-09-02) — that
 * removed the last rolling WINDOW, leaving `moveLegBase()` (255, the velocity leg) as the only warm-up,
 * so the ask is now even further clear of what binds. 900 is HAND-SET with headroom, not sized to the
 * measurement — it clears `moveScoreRows()` ~2.3× and still buys a year-plus of scored days past
 * warm-up (both pinned in `confirmers.test.ts`). Also sizes `needRowsForCalendarDays`' DB-first shallow
 * check. Do NOT re-cut it toward the new floor: the extra depth is what makes a future band possible
 * to MEASURE before it is shipped, which is the step both deleted level legs skipped.
 * The single touch point; never restate the literal.
 * @internal
 */
export const R6_MOVE_LOOKBACK_DAYS = 900;

/** R6's DB-first feed spec — the arm inputs its site spreads into `dbFirstOrDirect`; the direct
 *  arm tests (`db-first-feeds.test.ts`) drive `resolveDbFirstArm` with this same object. @internal */
export const R6_DB_FIRST_FEED: DbFirstFeedSpec = {
  id: R6.id,
  needRows: needRowsForCalendarDays(R6_MOVE_LOOKBACK_DAYS),
  minRows: moveScoreRows(),
};

/**
 * Score one cut-consuming indicator under its resolved calibration cuts (measured
 * vintage row layered over the absolute backstop — resolveCuts). `proxy` once carried F1/F2's
 * Baa10y level + Δ30d series, the cross-series legs they borrowed from the `credit/baa10y`
 * reference distribution.
 *
 * ⚠ NO PRODUCTION CALLER PASSES `proxy` ANY MORE. The borrowed `z`/`vel-z` legs were retired
 * 2026-08-06 and the whole proxy-z path — the producer, the `CALIB_MAP.{F1,F2}` rows behind it and
 * every fetch/branch feeding them — was deleted the same day (Stage 5.2).
 * What survives is the `ProxyLegSeries` parameter
 * itself, threaded through to `scoreDaySeries`; `makeFredLoop` and `src/goldens/dispatch.ts` both
 * pass `undefined`, and NO constructor of one remains anywhere since 2026-09-05 — the last, the frozen
 * control arm inside `scripts/probe-f1f2-legs.ts`, was retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it). The seam stays as the injection point.
 *
 * This is the notify path for the whole INDICATORS FRED loop (run-dbfirst.ts), F9/F10/F11 included,
 * so it MUST route the vintage through `synthesizedCalib` — the split-brain guard: a
 * site that skips it resolves `convention` while the sites that don't fire `measured`.
 * `synthHistories` carries the stored level history the Stage-6.3 expanding percentile is
 * computed from; omitted (or missing an id) ⇒ that id degrades to its registry priors.
 */
export function scoreWithCuts(
  indicator: Indicator,
  observations: Observation[],
  calib: ReadonlyArray<CalibrationParam>,
  proxy?: ProxyLegSeries,
  synthHistories?: SynthHistories,
  // Short (3m) leg for the post-inversion steepener escalation; omitted/[] ⇒ gate off (floor only).
  shortLeg?: Observation[],
): Reading {
  const { cuts, branch } = resolveScoreBranch(indicator, calib, synthHistories);
  // GEO-HYBRID ids inside the INDICATORS loop (OVX since 2026-08-06) score through the merged
  // two-leg `scoreOil`, not the generic classify path — but they stay IN the loop, so they keep
  // the stored-series fallback a FAST_CONFIRMERS move would have cost them (registry.ts, OVX).
  // This is the ONE branch point for both callers of this function: run-cycle's cron loop and
  // `src/goldens/dispatch.ts`.
  if (branch === "oil") return scoreOil(indicator, observations);
  // SMOOTHED-LEVEL ids (R8) stay in the INDICATORS loop but score their registry level pair against a
  // trailing MEAN, not the latest close.
  if (branch !== "generic") return scoreSmoothedLevel(indicator, observations, branch.window, shortLeg, branch.redWindow);
  return { ...scoreIndicator(indicator, observations, cuts, proxy, shortLeg), bandCuts: bandCutsUsed(cuts) };
}

/**
 * The SERIES-form twin of `scoreWithCuts` — same vintage routing (`synthesizedCalib`), same three
 * branches, same falsifiers — returning every day's reading instead of the latest. What a DB-first site
 * hands the seam as `score` when it persists ANOTHER registry id's series (R7 over R1/R2/R3), so the
 * rows it writes under that id agree with what the core loop would write for the same day.
 * Parity with `scoreWithCuts` is pinned in `confirmers.test.ts` (last element ≡ the scalar).
 */
export function scoreWithCutsSeries(
  indicator: Indicator,
  observations: Observation[],
  calib: ReadonlyArray<CalibrationParam>,
  proxy?: ProxyLegSeries,
  synthHistories?: SynthHistories,
  shortLeg?: Observation[],
): Reading[] {
  const { cuts, branch } = resolveScoreBranch(indicator, calib, synthHistories);
  if (branch === "oil") return oilReadingSeries(indicator, observations);
  if (branch !== "generic") return smoothedLevelReadingSeries(indicator, observations, branch.window, shortLeg, branch.redWindow);
  // ONE resolved `cuts` scores every day in the series (the generic scorer holds no per-date
  // cut), so the same `bandCutsUsed(cuts)` is the cut used for every row it returns.
  const bandCuts = bandCutsUsed(cuts);
  return indicatorReadingSeries(indicator, observations, cuts, proxy, shortLeg).map((r) => ({ ...r, bandCuts }));
}

/**
 * RESTATE twin of `scoreWithCutsSeries` for a `synthPriors` id: day i is scored the way the
 * cron scored it ON day i — its cuts resolved over the level history AS OF that date (the newest
 * `SYNTH_HISTORY_LIMIT` observations up to and including it, the same window `loadSynthHistories`
 * serves the cron), and its `bandCuts` stamp is THAT day's cut. `scoreWithCutsSeries` stamps ONE
 * (today's) cut on every row, which is right for the cron (it persists only the latest row) and
 * wrong for a restate (`readings.band_cuts` would then flatten the drawn expanding-percentile line
 * and the parity probe's per-date arm fails on every historical row — measured 2026-09-02).
 * Scoring is O(n·(tail + pool)) — each day re-scores the tail back to its fold's last sync run (the whole
 * prefix for a non-tailable id) plus the O(pool) cut; building each day's `history` is O(n²) cheap array work.
 * The cron gap-fill bounds days with `from` and passes `stored`.
 */
export function scoreWithCutsSeriesPerDay(
  indicator: Indicator,
  observations: Observation[],
  calib: ReadonlyArray<CalibrationParam>,
  shortLeg?: Observation[],
  { from, stored }: { from?: string; stored?: readonly Observation[] } = {},
): Reading[] {
  // The cron's history is the STORED readings, which begin only after the scorer's warm-up (F3:
  // 13 weekly rows on prod) — never the feed's first observation. Feeding the raw feed prefix shifts
  // every expanding percentile (measured 2026-09-02: -0.343 vs the cron's -0.35305 on 2026-08-21), so
  // the history floor is the first date the scorer EMITS, derived from one whole-series pass.
  const firstEmitted =
    stored === undefined ? scoreWithCutsSeries(indicator, observations, calib, undefined, undefined, shortLeg)[0]?.date : "";
  if (firstEmitted === undefined) return [];
  // A generic id without a σ/cooldown/drawdown leg scores each raw state from its `lookback`-deep
  // window alone; any other id re-scores the whole prefix.
  const t = indicator.thresholds;
  const tailable =
    resolveScoreBranch(indicator, calib).branch === "generic" &&
    !t.velocitySigma &&
    !indicator.postInversionCooldown &&
    !indicator.drawdownLeg;
  const lookback = Math.max(VELOCITY_WINDOW, indicator.velocityWindow ?? VELOCITY_WINDOW, indicator.derived?.window ?? 0);
  // `asymConfirmedStateSeries` forgets its past at a run of `run` equal raw states: the confirmed state IS that raw state.
  const run = Math.max(1, confirmClosesFor(indicator.id));
  const out: Reading[] = [];
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]!;
    if (from !== undefined && o.date < from) continue;
    const history =
      stored === undefined
        ? observations
            .slice(0, i + 1)
            .filter((p) => p.date >= firstEmitted)
            .slice(-SYNTH_HISTORY_LIMIT)
            .map((p) => p.value)
        : [...stored.filter((p) => p.date < o.date).map((p) => p.value), o.value].slice(-SYNTH_HISTORY_LIMIT);
    const synth = new Map([[indicator.id, history]]);
    let day: Reading | undefined;
    // Re-score a tail, doubling it until it holds a sync run past `lookback` (or is the whole prefix).
    for (let len = tailable ? lookback + run : i + 1; ; len *= 2) {
      const s = Math.max(0, i + 1 - len);
      const rows = scoreWithCutsSeries(indicator, observations.slice(s, i + 1), calib, undefined, synth, shortLeg);
      const exact = s === 0 ? [] : rows.filter((r) => r.date >= observations[s + lookback]!.date).map((r) => r.rawState);
      if (s === 0 || exact.some((x, j) => j >= run - 1 && exact.slice(j - run + 1, j).every((y) => y === x))) {
        day = rows.at(-1);
        break;
      }
    }
    if (day !== undefined && (stored === undefined || day.date === o.date)) out.push(day);
  }
  return out;
}

/**
 * The one branch point shared by `scoreWithCuts` and `scoreWithCutsSeries`: resolves the id's cuts
 * through `synthesizedCalib` and picks its scorer family.
 *
 * FALSIFIER, not an assumption: `scoreOil`/`oilReadingSeries` and `scoreSmoothedLevel`/
 * `smoothedLevelReadingSeries` read the registry `thresholds` pair directly, so a resolved calibration
 * cut would be SILENTLY DROPPED. Neither OVX nor R8 has a `CALIB_MAP` entry today (`resolveCuts`
 * returns `{}`), and the day one is published this throws instead of scoring the stale prior. `fold`
 * is a policy, not a cut, so it is excluded from the count.
 */
function resolveScoreBranch(
  indicator: Indicator,
  calib: ReadonlyArray<CalibrationParam>,
  synthHistories?: SynthHistories,
): { cuts: ReturnType<typeof resolveCuts>; branch: "generic" | "oil" | { window: number; redWindow?: number } } {
  const cuts = resolveCuts(
    indicator.id,
    synthesizedCalib(indicator, calib, synthHistories),
    indicator.direction ?? "HIGH",
  );
  const assertNoIgnoredCuts = (scorer: string, target: string): void => {
    const cutLegs = Object.keys(cuts).filter((k) => k !== "fold");
    if (cutLegs.length > 0) {
      throw new Error(
        `[${indicator.id}] ${scorer} scorer ignores resolved calibration cuts (${cutLegs.join(", ")}) - ` +
          `wire them into ${target} before publishing a CALIB_MAP row for this id`,
      );
    }
  };
  if (GEO_HYBRID_DESCRIPTOR_OF[indicator.id]) {
    assertNoIgnoredCuts("geo-hybrid", "oilReadingSeries");
    return { cuts, branch: "oil" };
  }
  const smoothed = SMOOTHED_LEVEL_OF[indicator.id];
  if (smoothed) {
    assertNoIgnoredCuts("smoothed-level", "smoothedLevelReadingSeries");
    return { cuts, branch: { window: smoothed.window, redWindow: smoothed.redWindow } };
  }
  return { cuts, branch: "generic" };
}

/**
 * The resolved numeric cut legs the generic scorer classified against — persisted per reading
 * to `readings.band_cuts` (Stage 2.1). Drops non-numeric `fold` (a policy, not a cut) and any
 * NaN, returning `null` when no numeric leg remains (a bespoke-branch id resolves `{}`). This is
 * the cut the scorer USED, not a re-derivation: for F3 (`NFCIRISK`, the sole synth id) the
 * `evt_*`/`operative_*` legs here ARE `computeSynthCuts(history).at(-1)`, injected by
 * `synthesizedCalib` into the same `cuts` object `classify` scored the reading against.
 * Stamped under the WIRE keys (`STAMP_KEY_OF`, Stage 2.2) so the stored cut meets the drawn one.
 */
// Resolved-cut key → wire key ([USER DECISION 2] ruling A): stamp under the keys the draw path
// emits. Legs with no wire counterpart (`velEvtRed`, `z*`/`op*`) keep their resolved-cut name.
const STAMP_KEY_OF: Readonly<Record<string, string>> = {
  evtAmber: POINT_BAND_CUTS_OF.F3!.find((b) => b.level === "amber")!.key,
  evtRed: POINT_BAND_CUTS_OF.F3!.find((b) => b.level === "red")!.key,
  velEvtAmber: F3_VELOCITY_BAND.key,
};

export function bandCutsUsed(cuts: ReturnType<typeof resolveCuts>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cuts)) {
    if (typeof v === "number" && Number.isFinite(v)) out[STAMP_KEY_OF[k] ?? k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * LIVE-PATH FALSIFIER for the trailing-peak level gate (2026-08-06 review I1).
 *
 * On a short feed the SCORED level leg (`levelGateState`, scorers-core.ts) degrades GREEN, so split
 * RED is unreachable — every reading caps at AMBER. A DEGRADED FEED IS therefore SILENT: if
 * `DCOILWTICO`/`DCOILBRENTEU` ever returned less than `levelWindow`+1 rows (a feed gap, or the
 * keyless clamp that already bit the ICE OAS series — `fred.ts` quirk 1), the shallow feed would
 * silently MUTE RED with every test green.
 * `OIL_LEVEL_LOOKBACK_DAYS` buys only ~14% headroom over the 756 trading days needed, so this is a
 * live risk, not a hypothetical.
 *
 * So the live path checks the depth it actually received and records a degrade event — the
 * codebase's existing convention (`recordDegrade`, tracks.ts), persisted onto the alert row's
 * `degraded` column and queryable via `/api/status` long after the Vercel log is gone. It does NOT
 * throw: the reading is still worth emitting (velocity-only is a real, if weaker, read), and a throw
 * inside `degrade()` would drop the GEO member entirely — strictly worse.
 *
 * ⚠ WHY THE THRESHOLD IS `<=`, NOT `<`: the scored index of the LATEST row is `values.length - 1`,
 * and `levelGateOn` resolves only when that index is `>= levelWindow`. So `length === levelWindow`
 * is already an unresolvable gate.
 *
 * ⚠ DELIBERATELY NOT INSIDE `scoreOil`: the ~22-observation crisis fixtures and the goldens score
 * that function directly and MUST stay green — the underrun-degrades-GREEN path is pinned behaviour
 * (`crisis-indicators.test.ts` §"short history degrades the LEVEL leg to GREEN: a red-band 20d
 * run-up caps at AMBER"). This guard is a statement about the live FEED, not about the scorer.
 *
 * `onDegrade` is the injection seam the tests drive (the `danger-engine.ts` `onDegrade` precedent);
 * live callers take the default. Returns whether it fired, so a caller/test can assert on it.
 * @internal
 */
export function checkOilLevelDepth(
  indicator: Indicator,
  observations: Observation[],
  onDegrade: (scope: string, reason: string) => void = (scope, reason) => recordDegrade(scope, reason, "notify"),
): boolean {
  const desc = GEO_HYBRID_DESCRIPTOR_OF[indicator.id];
  if (!desc || desc.level !== "trailing-peak") return false;
  const levelWindow = desc.scorer.constants.levelWindow;
  if (levelWindow == null) return false;
  if (observations.length > levelWindow) return false;
  onDegrade(
    `[oil] ${indicator.id} trailing-peak level gate unresolvable - scoring velocity-only`,
    `${indicator.series} returned ${observations.length} observations, at or below the ${levelWindow}-day ` +
      `level window: the gate is permanently ON this run, so ${indicator.id} scores as it did before the ` +
      `level leg existed. Check the feed depth (OIL_LEVEL_LOOKBACK_DAYS, family-descriptor-rows.ts).`,
  );
  return true;
}

/**
 * The pure, degrade-safe result of scoring one fast-path confirmer: its scored series, whose
 * `.at(-1)` is its contribution to the main `readings` array.
 */
interface ScoredConfirmer {
  /** `withNewest(<twin>, <scalar>)` — run-cycle persists `.at(-1)` and carries the whole series to the
   *  gap-fill sweep. Empty = degraded (absent from `readings`). */
  series: Reading[];
  /** The confirmer's OWN feed publication grid (its full fetched observation dates) — recorded into
   *  run-cycle's feed-date collector (RULED `[USER]`
   *  2026-09-09) so `lagCalendarsFrom`
   *  grids this daily confirmer against its real publication days, not the single latest `r.date`.
   *  Set on the daily confirmers whose feed is their own (R6/R7/CG; VXNT its denominator grid); VT/VTP read the SHARED vix
   *  legs and are recorded from those at the fetch site, and the weekly/monthly confirmers
   *  (G1/BRENT/EBP/ECY) are gridded by cadence, not slots. Absent ⇒ nothing recorded. */
  feedDates?: readonly string[];
  /** Dates scored off an `estimated` input obs (a Treasury head, a closes provider meta close; `estimateDatesOf`) — run-cycle marks them
   *  estimate-sourced so persist stores those rows `estimated`. Absent ⇒ none. */
  estimateDates?: readonly string[];
}

/** Shared inputs each confirmer's scorer may need (calib for the cut-scored ones; the
 * SHARED VIXCLS/VXVCLS legs for VT — threaded, never re-fetched). */
export interface ConfirmerCtx {
  calib: ReadonlyArray<CalibrationParam>;
  /** The run's snapshot clock (ISO) — every fetch window and freshness gate measures against it. */
  runAt: string;
  /** The run's env — every confirmer fetch reads its feed config from here. */
  env: Env;
  /** DB-first cron seam (stage 4.2): the run's store + `runAt`. Absent (an offline caller) ⇒ every
   *  deep/full-history site fetches its feed directly and persists nothing, as before 4.2. */
  dbFirst?: DbFirstCtx;
  vixFront: Observation[];
  vixBack: Observation[];
  /** ECY inputs, threaded as PROMISES so the confirmers can be STARTED before GT has scored
   * (run-cycle floats the confirmer batch and resolves `gtState` once `feedById` exists —
   * null = GT non-live this run, so `scoreEcy` omits rather than fabricating a gate verdict). */
  ecy: {
    /** The run's live CAPE fetch — the SAME feed the restate's ECY spec reads (`backfill.ts`), stored F7 on a failed fetch.
     *  null = the fetch failed with stored F7 stale/empty, already recorded at its run-mode effect (`ecy-cape-fallback.ts`). */
    f7: Promise<Observation[] | null>;
    dfii10: Promise<Observation[]>;
    gtState: Promise<State | null>;
    /** Injected wall-clock ISO date the F7 staleness gate measures against. */
    now: string;
  };
  /** INTRADAY only (a retired plan L2): extends a confirmer's fetched print
   *  grid by its same-day estimate before scoring (G1/BRENT). Absent ⇒ prints score as fetched. */
  extendObs?: (id: string, obs: Observation[]) => Observation[];
  /** The run's feed ports (`RunBase.feeds`); absent ⇒ `realFeeds`. */
  feeds?: FeedPorts;
}

/** One fast-path confirmer as data: its id and a degrade-safe scorer over the shared
 * ConfirmerCtx. */
interface FastConfirmer {
  id: string;
  /** Fetch + score under the §5 degrade contract; a feed hiccup yields the empty
   * contribution (no reading in `readings`), never a throw. */
  score(ctx: ConfirmerCtx): Promise<ScoredConfirmer>;
}

/** The degraded contribution: absent from `readings`. */
const EMPTY: ScoredConfirmer = { series: [] };

/**
 * Score the VT VIX term-structure ratio (T1.2) — a COINCIDENT indicator (Phase-2-validated,
 * promoted off CONTEXT 2026-07-04; feeds the dial's volatility family beside R5/R6). PURE:
 * takes the pre-fetched VIXCLS/VXVCLS legs (via fetchVixTermLegs, SHARED
 * with the off-ladder VIX-bottom track — feed consolidation 2026-07-05, killing the duplicate
 * the closes provider fetch that lost the cron's rate-limit race and silently dropped VT on prod). Scored
 * bespoke by scoreRatioSpread (VT_DESCRIPTOR) off the VIX÷VIX3M ratio LEVEL. Like EBP/R6/R7/CG a
 * feed hiccup must NOT abort the verdict (§5 pre-mortem), so BOTH degraded sentinels map to []: an
 * empty leg (feed down) AND a too-short/disjoint aligned series (the scorer throws via `latest`). NOTE:
 * post-promotion a silent drop is NOT free — it removes a coincident member that feeds the
 * dial's volatility family, so a degrade fails safe toward under-alerting (never a false
 * escalation).
 */
export function scoreVixTermIndicator(
  front: Observation[],
  back: Observation[],
  // The VT confirmer (cron) passes warn + `recordDegrade`; other callers warn only.
  onFail: (scope: string, err: unknown) => void = (scope, err) => console.warn(`${scope}: ${errMsg(err)}`),
): Reading[] {
  if (front.length === 0 || back.length === 0) return []; // a VIX leg is down — VT omitted (fail-safe)
  try {
    return [scoreRatioSpread(VT, VT_DESCRIPTOR, front, back)];
  } catch (err) {
    // A non-empty but too-short/disjoint aligned pair makes scoreRatioSpread throw; keep the
    // prior degrade() net's fail-safe [] (VT omitted, never a false escalation).
    onFail("[vix-term] volatility term-structure feed unavailable - coincident indicator omitted", err);
    return [];
  }
}

/**
 * Score the VT VIX backwardation PERSISTENCE leg (R3, EW-11/12/13) — a leg over
 * the SHARED VIXCLS/VXVCLS legs, scored off the consecutive-days-in-backwardation STREAK. Rides a
 * CONTEXT identity (VTP, registry.ts) that is off every roll-up and every dial family, so it can
 * NEVER move the notify band (EW-13).
 *
 * ⚠ EW-13 SPLIT (user ruling 2026-07-31):
 * the persistence-exclusion half is OVERTURNED — this wrapper is now the LAST entry of
 * `FAST_CONFIRMERS`, so the reading IS persisted and charted. The half that STANDS: VTP never
 * reaches notify and is in no dial family. Three independent structural reasons keep it off the
 * notify BAND, none of which this wiring touches: `channel: "CONTEXT"` is off every roll-up
 * (domain-types.ts §channel); VTP is absent from `families.ts`, so no dial family (and the dial band IS
 * the notify band) can see it; and the provisional path is behaviorally inert under the
 * directional fold (instant-up leaves no unconfirmed raw RED — VTP passing its
 * `confirmClosesFor >= 2` filter since 2026-08-26 is harmless; see provisional.ts).
 *
 * ⚠ Those three say nothing about the notify BODY, which reads `readings[]` DIRECTLY: B.1 left a
 * RED VTP printing a driver line in the push (measured 2026-07-31). The body exclusion is its own
 * mechanism — `buildNotification` filters `CHART_ONLY_IDS` (notify_format.ts, B.3). All three
 * surfaces (band, dial family, body) are pinned in `vix-term-persistence.test.ts`.
 *
 * Degrade-safe like scoreVixTermIndicator: an empty leg (feed down) and a too-short/disjoint pair
 * BOTH map to [] (leg omitted, fail-safe) — the first by the length guard, the second by the
 * empty-SERIES guard in the body (scoreVixTermPersistence's `date: ""` fallback would otherwise be
 * persisted as a fabricated 0-day calm). Pinned in `vix-term-persistence.test.ts`.
 * @internal
 */
export function scoreVixTermPersistenceIndicator(front: Observation[], back: Observation[]): Reading[] {
  if (front.length === 0 || back.length === 0) return []; // a VIX leg is down — persistence leg omitted
  try {
    // Unlike scoreRatioSpread, `scoreVixTermPersistence` NEVER throws on a disjoint/too-short pair:
    // `vixTermPersistenceReadingSeries` returns [] and its `?? { date: "", level: 0, state: "GREEN" }`
    // fallback fabricates a 0-day GREEN reading dated "" — which B.1 would PERSIST (and `Date.parse("")`
    // is NaN, so every lag check reads it as fresh). Take the tail of the SERIES instead, so an
    // empty series maps to [] and the fail-safe below is true for both degrade shapes.
    const series = vixTermPersistenceReadingSeries(VTP, front, back);
    const latest = series.at(-1);
    return latest ? [latest] : [];
  } catch (err) {
    console.warn(`[vix-term-persist] backwardation-streak feed unavailable - confirmer leg omitted: ${errMsg(err)}`);
    recordDegrade("[vix-term-persist] backwardation-streak feed unavailable - confirmer leg omitted", errMsg(err), "trace"); // chart-only VTP
    return [];
  }
}

/**
 * The fast-path confirmers, in `readings` order
 * (G1 → EBP → R6 → R7 → CG → VT → BRENT → VTP → ECY → NG → VXNT).
 * Order is load-bearing: `runScoringCycle` flat-maps this list into `readings` right
 * after the FRED core + price readings, so it MUST match the legacy concat order
 * (append-only keeps the legacy prefix byte-identical — VTP was appended at the TAIL for
 * exactly that reason, 2026-07-31).
 */
/**
 * R7's three legs IN `scoreBullSteepener` ORDER (spread, 2y, 10y) as the FRED-loop ids that already
 * persist those series — the stored `readings.value` of each IS the series (R1 → T10Y3M, R3 → DGS2,
 * R2 → DGS10; `db-first-feeds.test.ts` pins the mapping against the registry). Single touch point.
 */
export const R7_LEG_IDS = ["R1", "R3", "R2"] as const;

/** One R7 leg's DB-first feed spec: the leg's own registry id at seed depth. @internal */
export const r7LegFeed = (id: (typeof R7_LEG_IDS)[number]): DbFirstFeedSpec => ({
  id,
  needRows: needRowsForSeedDepth(),
});

/** Whether the core loop's own fetch of this leg is already `fullHistory` (then R7 rides its memo, not the DB). */
export const r7LegLoopDeep = (id: (typeof R7_LEG_IDS)[number]): boolean => {
  const ind = fredLoopIndicator(id);
  return fetchesFromFred(ind) && fetchesDeep(ind);
};

/** The FRED-loop registry `Indicator` for `id`, throwing on a non-registry id (reused by run-cycle's
 *  R4 DB-first site — a shared single touch point over `INDICATORS.find`, not a duplicate). */
export const fredLoopIndicator = (id: string): Indicator => {
  const ind = INDICATORS.find((i) => i.id === id);
  if (ind === undefined) throw new Error(`[registry] ${id} is not a FRED-loop registry id`);
  return ind;
};

/**
 * One R7 leg, DB-first: the merged (stored ∪ tail) raw series of the registry id persisting it. Takes
 * the direct arm (deep fetch, persist nothing) when the run carries no store or no series scorer — the
 * pre-4.2 behaviour. A persist failure never degrades R7: the leg still scores this run.
 */
async function r7LegSeries(ctx: ConfirmerCtx, id: (typeof R7_LEG_IDS)[number]): Promise<Observation[]> {
  const ind = fredLoopIndicator(id);
  const { fetchSeries, fetchTreasuryColumn } = feedsOf(ctx);
  // R1 takes the direct arm: the core loop asks T10Y3M `fullHistory` every run (R1 left DB-first
  // 2026-09-04, smoothed id), so this leg rides the run's FRED memo at zero extra wire cost.
  const loopDeep = r7LegLoopDeep(id);
  const scorer = loopDeep ? undefined : await ctx.dbFirst?.seriesScorerFor?.(ind);
  // The RUN's clock, not the lambda's: the deep bound is reproducible per run (and the
  // fixture-clocked tests are deterministic across UTC midnight).
  const now = new Date(ctx.runAt);
  const { points } = await dbFirstOrDirect(scorer === undefined ? undefined : ctx.dbFirst, {
    ...r7LegFeed(id),
    // A loop-deep leg (R1) rides the run's fullHistory FRED memo; a DB leg's deep arm is BOUNDED
    // at the seed depth + warm-up (`deepArmSince`), never inception.
    // A2: graft the Treasury same-day head as this LEG's id (R3=DGS2, R2=DGS10 get it; R1 is exempt —
    // absent from `TREASURY_HEAD_OF`, so `graftTreasuryHeadFor` is identity, T7). Both arms, so R7 scores
    // the same vintage R2/R3 do and the DB seam re-persists a corrected grafted date on its 14d tail (A1).
    // `now` is the run's own clock (fixture-deterministic across UTC midnight).
    fetchDeep: async () =>
      graftTreasuryHeadFor(id, await fetchSeries(ind.series, loopDeep ? { fullHistory: true, now, env: ctx.env } : { since: deepArmSince(now), now, env: ctx.env }), ctx.runAt, fetchTreasuryColumn),
    fetchTail: async () =>
      graftTreasuryHeadFor(id, await fetchSeries(ind.series, { since: tailSince14(now), now, env: ctx.env }), ctx.runAt, fetchTreasuryColumn),
    score: scorer ?? (() => []),
    onPersistError: (err) =>
      recordDegrade(`[bull-steepener-db-first] persist failed - ${id} history not written, R7 scored`, String(err), "notify"),
  });
  return points;
}

export const FAST_CONFIRMERS: FastConfirmer[] = [
  // G1 auto-GEO oil. DCOILWTICO is keyless FRED; a single oil-series hiccup must NOT
  // abort the FRED core (§5) — degrades to nothing (geo then rests on manual flags).
  // Cuts-independent (classifyDerived has no z-leg).
  //
  // ⚠ The explicit `since` is LOAD-BEARING, not tidying: `scoreOil`'s trailing-peak level gate
  // needs `levelWindow` (756) TRADING days, and fred.ts's DEFAULT window yields only ~570 — the
  // gate would then be permanently ON with every test green. Derived from the descriptor, so a
  // `levelWindow` retune moves the fetch depth with it (ONE touch point).
  {
    id: "G1",
    score: (ctx) =>
      degrade<ScoredConfirmer>("[geo] oil feed unavailable - geo on manual flags only", "notify", EMPTY, async () => {
        const obs = await feedsOf(ctx).fetchSeries(G1.series, { since: sinceDaysAgo(OIL_LEVEL_LOOKBACK_DAYS, new Date(ctx.runAt)), now: new Date(ctx.runAt), env: ctx.env });
        checkOilLevelDepth(G1, obs); // the `since` above is not self-verifying — see the docblock
        const scored = ctx.extendObs?.(G1.id, obs) ?? obs;
        const r = scoreOil(G1, scored); // scalar first: its min-obs guard throws before the twin runs
        return { series: withNewest(oilReadingSeries(G1, scored), r), estimateDates: estimateDatesOf(scored) }; // the nowcast head (`headObs`)
      }),
  },
  // EBP credit confirmer (Phase-2 C3) — its own keyless monthly feed scored through the
  // standard cut-scored path (its own calibration vintage). A feed hiccup degrades to
  // nothing (FIN base then scores on F1/F2 alone).
  {
    id: "EBP",
    score: (ctx) =>
      degrade<ScoredConfirmer>(
        "[ebp] feed unavailable - FIN scores without the EBP confirmer",
        "notify",
        EMPTY,
        async () => {
          const obs = await feedsOf(ctx).fetchEbp();
          const r = scoreWithCuts(EBP, obs, ctx.calib);
          return { series: withNewest(scoreWithCutsSeries(EBP, obs, ctx.calib), r) };
        },
      ),
  },
  // R6 MOVE bond-vol confirmer (T1.1) — ^MOVE via the price feed, scoreMoveLevel (rolling+velocity+
  // absolute worst-of). A feed hiccup degrades to nothing (coincident modifier rides R5 VIX alone).
  // ⚠ `deep: true` IS LOAD-BEARING, not decoration: `lookbackDays` is deep-only (prices.ts —
  // `closesChartUrl` serves `range=2y` to every shallow caller and drops the bound), so the
  // 2026-08-30 remap shipped its 1500d ask INERT and R6 ranked its level band over a 497-obs / 2-year
  // base. Measured 2026-08-30 (against the then-live detrended band, deleted 2026-08-31): that shallow
  // base put the p75 amber cut at dev −0.0262 instead of −0.0024 and painted 2026-08-28 (MOVE 70.97,
  // BELOW its own 200d trend) AMBER. The lesson binds the CURRENT band too — a rolling percentile is
  // only as honest as its fetch depth, whatever it ranks.
  {
    id: "R6",
    score: (ctx) =>
      degrade<ScoredConfirmer>(
        "[move] feed unavailable - coincident channel scores on VIX alone",
        "notify",
        EMPTY,
        async () => {
          // DB-first (stage 4.2): stored `R6` closes + a `TAIL_DAYS` tail; a store shallower than the
          // 1500d ask re-fetches deep and persists it. The seam's `readings` ARE the scored series —
          // `latestMove` only applies `scoreMoveLevel`'s min-obs guard, it never re-scores.
          const { fetchDailyCloses } = feedsOf(ctx);
          const { readings, points } = await dbFirstOrDirect(ctx.dbFirst, {
            ...R6_DB_FIRST_FEED,
            fetchDeep: () => fetchDailyCloses("^MOVE", { deep: true, lookbackDays: R6_MOVE_LOOKBACK_DAYS, now: () => Date.parse(ctx.runAt), env: ctx.env }),
            fetchTail: () => fetchDailyCloses("^MOVE", { deep: true, lookbackDays: TAIL_DAYS, now: () => Date.parse(ctx.runAt), env: ctx.env }),
            score: (pts) => moveReadingSeries(R6, pts),
            // A DB 5xx on the persist must not read as "feed unavailable" — R6 still scores this run.
            onPersistError: (err) =>
              recordDegrade("[move-db-first] persist failed - R6 scored, history not written", String(err), "notify"),
          });
          const series = withNewest(readings, latestMove(R6, readings, points.length));
          return { series, feedDates: points.map((p) => p.date), estimateDates: estimateDatesOf(points) };
        },
      ),
  },
  // R7 bull-steepener composite (T2.1) — a pure composite over three keyless FRED series
  // (T10Y3M + DGS2 + DGS10). Degrades to nothing on any feed hiccup (§5 — the RATE base R1–R4
  // still scores). Cuts-independent of the calibration vintage, but NOT cut-less: the cuts are
  // per-day ranks of its OWN history, so all three legs need FULL history — the default 800-day
  // window would rank each day against ~1½ years and make the cron vintage disagree with a backfill's.
  // DB-first (stage 4.2): each leg is the stored series of the registry id ALREADY persisting it
  // (`R7_LEG_IDS` — §0.3: never a second id for the same series) + a `TAIL_DAYS` tail; a store
  // shallower than the series' own `fullHistory` span re-fetches deep and persists it under that id,
  // scored by the run's own `seriesScorerFor` so the rows carry the core loop's vintage.
  {
    id: "R7",
    score: (ctx) =>
      degrade<ScoredConfirmer>(
        "[bull-steepener] rate feed unavailable - RATE scores without the R7 composite",
        "notify",
        EMPTY,
        async () => {
          const [spread, dgs2, dgs10] = await Promise.all([
            r7LegSeries(ctx, R7_LEG_IDS[0]),
            r7LegSeries(ctx, R7_LEG_IDS[1]),
            r7LegSeries(ctx, R7_LEG_IDS[2]),
          ]);
          const r = scoreBullSteepener(R7, spread, dgs2, dgs10);
          return {
            series: withNewest(bullSteepenerReadingSeries(R7, spread, dgs2, dgs10), r),
            feedDates: spread.map((o) => o.date),
            estimateDates: estimateDatesOf(spread, dgs2, dgs10),
          };
        },
      ),
  },
  // CG copper/gold ratio (T2.2) — a CONTEXT confirmer (never moves a roll-up), its own
  // two-symbol price feed scored bespoke. A feed hiccup degrades to nothing.
  //
  // ⛔ `{ deep: true }` IS LOAD-BEARING, not a nicety. `CG_DESCRIPTOR.levelBand` is an
  // EXPANDING percentile, so the cut it scores against is a function of how much history
  // this call passes: the default shallow fetch is `range=2y` (~500 aligned closes), which
  // turns the level leg into a ROLLING ~2-year percentile — the exact shape the plan ruled
  // out, because a rolling window renormalises a genuine multi-year collapse away. Deep reaches
  // `CG_LEVEL_ANCHOR` (`cgLookbackDays`); both writers score through `cgPoints`/`cgRows`.
  {
    id: "CG",
    score: (ctx) =>
      degrade<ScoredConfirmer>(
        "[copper-gold] commodity feed unavailable - CONTEXT confirmer omitted",
        "notify",
        EMPTY,
        async () => {
          // DB-first (stage 4.2): the stored `CG` RATIO series + a `TAIL_DAYS` tail; a store shallower
          // than the 20y (`DEEP_LOOKBACK_DAYS`) ask re-fetches both legs deep and persists the aligned
          // ratio (§0.2). §0.3: re-scored via the identity-denominator seam over the stored ratio
          // (`cgRows`) — CG never stores its legs (`COPPER` holds HG=F closes for the value probe only). The deep
          // arm stays `{ deep: true }` for the expanding-percentile reason the docblock above gives.
          // `warmup: true`: the scorer burns a `ratioSpreadMinLen` head (331 rows) it never emits, so the
          // stored series alone can never reach `needRows` — the head is persisted to `readings_warmup`
          // and counted in the arm decision.
          const { readings, points } = await dbFirstOrDirect(ctx.dbFirst, {
            ...CG_DB_FIRST_FEED,
            fetchDeep: async () => {
              const [hg, gc] = await Promise.all([
                feedsOf(ctx).fetchDailyCloses("HG=F", { deep: true, lookbackDays: cgLookbackDays(new Date(ctx.runAt)), now: () => Date.parse(ctx.runAt), env: ctx.env }),
                feedsOf(ctx).fetchDailyCloses("GC=F", { deep: true, lookbackDays: cgLookbackDays(new Date(ctx.runAt)), now: () => Date.parse(ctx.runAt), env: ctx.env }),
              ]);
              return cgPoints(hg, gc);
            },
            fetchTail: async () => {
              const [hg, gc] = await Promise.all([
                feedsOf(ctx).fetchDailyCloses("HG=F", { deep: true, lookbackDays: TAIL_DAYS, now: () => Date.parse(ctx.runAt), env: ctx.env }),
                feedsOf(ctx).fetchDailyCloses("GC=F", { deep: true, lookbackDays: TAIL_DAYS, now: () => Date.parse(ctx.runAt), env: ctx.env }),
              ]);
              return cgPoints(hg, gc);
            },
            score: (pts) => cgRows(CG, pts),
            onPersistError: (err) =>
              recordDegrade("[copper-gold-db-first] persist failed - CG scored, history not written", String(err), "notify"),
          });
          const r = latestRatioSpread(CG, CG_DESCRIPTOR, readings, points.length);
          return { series: withNewest(readings, r), feedDates: points.map((p) => p.date), estimateDates: estimateDatesOf(points) };
        },
      ),
  },
  // VT VIX term-structure (T1.2) — the ODD one: it reads the SHARED VIXCLS/VXVCLS legs
  // (fetched once per run and threaded via ctx, also feeding the off-ladder bottom
  // track), NOT its own feed. scoreVixTermIndicator carries its OWN fail-safe try/catch
  // (both empty-leg and too-short-series map to []); its `onFail` here warns AND records the degrade.
  {
    id: "VT",
    score: async (ctx) => {
      // Same-day estimate (`leg-ratio`): each FRED leg extended by its live `^VIX`/`^VIX3M` close, keyed by the leg's series id
      // (`vixEstimatePoints`, run-cycle-confirmers.ts); absent ⇒ the legs score as fetched. VTP/the bottom track stay on prints.
      const [frontId, backId] = VT_DESCRIPTOR.inputs;
      const front = ctx.extendObs?.(frontId, ctx.vixFront) ?? ctx.vixFront;
      const back = ctx.extendObs?.(backId, ctx.vixBack) ?? ctx.vixBack;
      const [r] = scoreVixTermIndicator(front, back, (scope, err) => {
        console.warn(`${scope}: ${errMsg(err)}`);
        recordDegrade(scope, errMsg(err), "notify");
      });
      // Scalar first: a degrade ([]) never reaches the twin, so it cannot throw outside the fail-safe.
      return r ? { series: withNewest(ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, front, back), r), estimateDates: estimateDatesOf(front, back) } : EMPTY;
    },
  },
  // BRENT auto-GEO Brent confirm (crisis rung 3). DCOILBRENTEU is keyless FRED; appended
  // AFTER VT (append-only — the legacy readings prefix stays byte-identical). Degrades to
  // nothing on a feed hiccup (geo then rests on manual flags + WTI). Cuts-independent
  // (scoreOil reads BRENT_DESCRIPTOR, no calibration cuts). Same load-bearing `since` as G1 above.
  {
    id: "BRENT",
    score: (ctx) =>
      degrade<ScoredConfirmer>("[brent] oil feed unavailable - geo rests on manual flags + WTI", "notify", EMPTY, async () => {
        const obs = await feedsOf(ctx).fetchSeries(BRENT.series, { since: sinceDaysAgo(OIL_LEVEL_LOOKBACK_DAYS, new Date(ctx.runAt)), now: new Date(ctx.runAt), env: ctx.env });
        checkOilLevelDepth(BRENT, obs); // same live-path falsifier as G1 above
        const scored = ctx.extendObs?.(BRENT.id, obs) ?? obs;
        const r = scoreOil(BRENT, scored);
        return { series: withNewest(oilReadingSeries(BRENT, scored), r), estimateDates: estimateDatesOf(scored) };
      }),
  },
  // VTP VIX backwardation-streak persistence leg (R3) — like VT it reads the SHARED
  // VIXCLS/VXVCLS legs off ctx, not its own feed, and carries its OWN fail-safe try/catch, so it
  // needs no degrade wrapper. Appended at the TAIL (option B, 2026-07-31): persisted + charted,
  // still CONTEXT / no dial family / no notify — see scoreVixTermPersistenceIndicator's docblock.
  {
    id: "VTP",
    score: async (ctx) => {
      const [r] = scoreVixTermPersistenceIndicator(ctx.vixFront, ctx.vixBack);
      return r ? { series: withNewest(vixTermPersistenceReadingSeries(VTP, ctx.vixFront, ctx.vixBack), r) } : EMPTY;
    },
  },
  // ECY excess-CAPE-yield valuation×trend gate (2026-08-11) — appended at the TAIL (append-only
  // ordering rule above). Reads the ctx-threaded promises: live CAPE (stored F7 on a failed fetch) + its own DFII10
  // fetch + GT's scored state (resolved mid-run by run-cycle). `scoreEcy` returns null on a stale/
  // short window or an expensive read with GT non-live — recorded as a degrade, never a fabricated
  // GREEN or RED.
  {
    id: "ECY",
    score: (ctx) =>
      degrade<ScoredConfirmer>(
        "[ecy] valuation-gate input unavailable - ECY omitted this run",
        "notify",
        EMPTY,
        async () => {
          const [f7, dfii10, gtState] = await Promise.all([ctx.ecy.f7, ctx.ecy.dfii10, ctx.ecy.gtState]);
          if (f7 === null) return EMPTY; // the CAPE fetch degrade (`ctx.ecy.f7`) is the record
          const r = scoreEcy(ECY, f7, dfii10, gtState, ctx.ecy.now);
          if (r === null) {
            recordDegrade(
              "[ecy] ECY omitted this run",
              "stale/short F7×DFII10 window, or expensive while GT is non-live - no gate verdict fabricated",
              "notify",
            );
            return EMPTY;
          }
          // Twin rows are the gate-less valuation base — the same `ecyRows` `backfill.ts` writes for ECY.
          const { series, estimateDates } = ecyRows(ECY, f7, dfii10);
          return { series: withNewest(series, r), estimateDates };
        },
      ),
  },
  // NG Henry Hub natgas — TAIL append (legacy prefix byte-identical); keyless FRED DHHNGSP, same
  // scoreOil path + load-bearing `since` as G1/BRENT. CONTEXT, off the alert band.
  {
    id: "NG",
    score: (ctx) =>
      degrade<ScoredConfirmer>("[natgas] feed unavailable - NG omitted this run", "notify", EMPTY, async () => {
        const obs = await feedsOf(ctx).fetchSeries(NG.series, { since: sinceDaysAgo(OIL_LEVEL_LOOKBACK_DAYS, new Date(ctx.runAt)), now: new Date(ctx.runAt), env: ctx.env });
        checkOilLevelDepth(NG, obs); // same live-path falsifier as G1/BRENT
        const r = scoreOil(NG, obs);
        return { series: withNewest(oilReadingSeries(NG, obs), r) };
      }),
  },
  // VXNT VXN term structure — TAIL append (legacy prefix byte-identical). CONTEXT + CHART_ONLY_IDS: display-only.
  // VXNCLS's default window is the VXNCLS global feed's own call. Fail-safe like VT.
  {
    id: "VXNT",
    score: async (ctx) => {
      try {
        const [frontId, backId] = VT_DESCRIPTOR.inputs;
        const raw = await feedsOf(ctx).fetchSeries(VXNCLS.series, { now: new Date(ctx.runAt), env: ctx.env });
        const vxn = ctx.extendObs?.(VXNCLS.id, raw) ?? raw;
        const front = ctx.extendObs?.(frontId, ctx.vixFront) ?? ctx.vixFront;
        const back = ctx.extendObs?.(backId, ctx.vixBack) ?? ctx.vixBack;
        if (vxn.length === 0 || front.length === 0 || back.length === 0) return EMPTY;
        const r = scoreVxnTerm(VXNT, vxn, front, back); // throws on a too-short/disjoint window
        return {
          series: withNewest(vxnTermReadingSeries(VXNT, vxn, front, back), r),
          feedDates: vxnTermDenominator(vxn, front, back).map((o) => o.date),
          estimateDates: estimateDatesOf(vxn, front, back),
        };
      } catch (err) {
        console.warn(`[vxn-term] VXN term-structure input unavailable - VXNT omitted: ${errMsg(err)}`);
        recordDegrade("[vxn-term] VXN term-structure input unavailable - VXNT omitted", errMsg(err), "trace"); // display-only: no push caveat
        return EMPTY;
      }
    },
  },
];
