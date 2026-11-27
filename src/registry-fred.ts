/**
 * Registry — FRED-generic family (registry split, 2026-08-15): the engine-wide threshold
 * multiplier, the INDICATORS FRED-loop array + its knob constants, and the generic
 * `scoreIndicator`-path ids registered outside the loop (F7/ECY/EBP/HICP/R6).
 * Import surface: this file — edit and import here.
 */

import {
  type DrawdownLeg,
  type Indicator,
  type PostInversionCooldown,
  type Thresholds,
} from "./domain-types.js";
import {
  // R5b: OVX's spike band is DRAWN from the same descriptor constants `scoreOil` scores it on.
  OVX_DESCRIPTOR,
  HICP_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { HICP_SERIES } from "./hicp.js";
import { resolveMultiplier, earlierCut, type ThresholdConfig } from "./threshold-config.js";
import { BACKFILL_YEARS, DFII10_ORIGIN, EXPANDING_PERCENTILE_PREFIX_YEARS, SEMIS_BACKFILL_YEARS } from "./backfill-depth.js";
import type { TreasuryCurve } from "./treasury.js";

/**
 * The engine-wide threshold-multiplier transform for convention `Thresholds` (Stage 2.3):
 * scale each present level/velocity band through the direction-normalized `earlierCut`
 * (m<1 fires EARLIER, m>1 later) so a config edit moves scoring, dial, ntfy AND the drawn
 * convention bands together (the band builders and `legBounds` both read `ind.thresholds`).
 * Level bands flip earliness with `direction` (LOW = R1 moves UP toward danger); velocity
 * bands are always highward. `derived` descriptors are NOT touched here — `scaleDerived`
 * scales them at the display edge, so scaling them here too would double-apply. The
 * `m === 1` fast-path returns `ind` UNCHANGED (referential identity), the byte-parity
 * guarantee for the shipped all-1.0 config.
 */
export function withMultipliedThresholds(ind: Indicator, config?: ThresholdConfig): Indicator {
  const m = resolveMultiplier(ind.id, config);
  if (m === 1) return ind;
  const t = ind.thresholds;
  const firesHighward = (ind.direction ?? "HIGH") !== "LOW";
  const scaled: Thresholds = {
    ...t,
    ...(t.amberLevel !== undefined ? { amberLevel: earlierCut(t.amberLevel, firesHighward, m) } : {}),
    ...(t.redLevel !== undefined ? { redLevel: earlierCut(t.redLevel, firesHighward, m) } : {}),
    ...(t.amberVelocity !== undefined ? { amberVelocity: earlierCut(t.amberVelocity, true, m) } : {}),
    ...(t.redVelocity !== undefined ? { redVelocity: earlierCut(t.redVelocity, true, m) } : {}),
  };
  // Stamp the PRE-multiplier thresholds: the Stage-6.3 synth seam's degraded fallback must
  // inject a cut that has never seen `m` (resolveCuts' scaleCuts applies it), else the
  // synthesized leg is double-scaled against its own convention leg.
  return { ...ind, thresholds: scaled, rawThresholds: t };
}

/**
 * F9's ROLLING-σ window (trading days), strictly historical, ending `t−1` — adapts to the
 * volatility regime without leaking the scored day into its own scale.
 *
 * ⚠ A CAP, not a promise — `velocitySigmaZSeries` estimates over every usable delta in
 * `[t−window, t−1]`. The cron fetch is sized FROM this constant (`velocitySigmaFetchOpts`,
 * fred.ts, widens F9's own feed window to `F9_SIGMA_WINDOW + velocityWindow` trading days);
 * the remaining caps are the series' own start date and the store-fallback read on a failed
 * live fetch. `F9_SIGMA_MIN_OBS` is the floor that makes any residual shortfall degrade
 * rather than score silently. ⚠ `F9_CUSUM_K`'s offset half is measured UNDER this window —
 * moving it re-runs the candidacy probe before the k split is restated.
 * Exported so a test derives its fixture length from the constant instead of restating it.
 */
export const F9_SIGMA_WINDOW = 504;

/**
 * Trading days (~6w) for exposure.ts's ARM widening rate-of-change — AND F1's `velocityWindow`
 * below (D-A: the 30d span is shared, the ARM latch is not). Defined here so both engines read the
 * ONE number: `exposure.ts` imports it from here directly and re-exports it beside
 * its other ARM constants; the registry importing it from `exposure.ts` would close a value cycle.
 */
export const ARM_ROC_WINDOW = 30;
/** F9's σ depth floor — mirrors `PCT_MIN_OBS` (252). Below it the day degrades, unscored. */
export const F9_SIGMA_MIN_OBS = 252;

/**
 * F11's ROLLING-σ window — the FLOOR arm's lookback under the blend below.
 * No longer borrowed from F9: it is F11's
 * own knob and the two ids move independently.
 *
 * ⚠ It does NOT size the read any more — a blended id's EWMA arm is unbounded, so both read sites
 * go through `velocitySigmaDepth` (domain-fold.ts). Shortening this constant alone would have cut
 * the EWMA's burn-in with it (measured: σ 5.44% low at a 564-obs read).
 */
export const F11_SIGMA_WINDOW = 504;
/** F11's σ depth floor — mirrors `F9_SIGMA_MIN_OBS`/`PCT_MIN_OBS` (252). Below it the day degrades. */
export const F11_SIGMA_MIN_OBS = 252;

/**
 * F11's BLENDED σ:
 * σ = `max(EWMA hl, floor × rect F11_SIGMA_WINDOW)`. F9 keeps the rectangular estimator.
 */
export const F11_SIGMA_EWMA_HALF_LIFE = 125;
/**
 * The rect arm's floor multiple under the blend — 0 would leave the EWMA unfloored. MEASURED (ruling 6):
 * fitted so the floor wins the max on 11.9% of diag-era days, matching the 11.3% the retired rect-1260
 * floor won on the same instrument (`npm run probe:sigma-response -- --id=F11 --floor=`).
 */
export const F11_SIGMA_FLOOR = 0.9;

/**
 * F11's FAST Δ horizon — the `vel-z-fast` OR-arm over `max(z@Δ30, z@Δ60)` at the held σ pair
 * (`[USER]` 2026-08-11 off the discharged re-measure gate).
 */
export const F11_FAST_VELOCITY_WINDOW = 30;

/**
 * F9's CUSUM PERSISTENCE knobs: `S⁺_t = max(0, S⁺_{t−1} + z_t − k)` over the σ-standardized z
 * above, scoring the TWO-TIER `vel-cusum` leg.
 * ⛔ **`k` is NOT the textbook `k = δ/2` alone** — it carries TWO roles,
 * `k = <in-control offset> + <sensitivity>`:
 *  - the **OFFSET** half cancels a ratchet: `z` is deliberately NOT mean-centred
 *    (`velocitySigmaZSeries`) and its stored-era in-control level is strictly positive, so a `k`
 *    below that level lets S⁺ reach the bounds with nothing happening. It is the stored-era
 *    MEDIAN of z — a robust symmetric estimator, never the episode-inflated full-sample mean; the
 *    number lives in `docs/indicator-cut-provenance.md` §F9, measured UNDER the live
 *    `F9_SIGMA_WINDOW`. ⛔ A `k` below the median is REJECTED (re-arms the ratchet). ⛔ A ROLLING
 *    de-mean is REJECTED (the baseline would chase a sustained shift, turning this persistence
 *    detector back into the retired LEVEL leg).
 *  - the **SENSITIVITY** half is the textbook `δ/2` — half the sustained shift, in σ, the leg is
 *    tuned to catch — and the only half that moves to widen or narrow the leg. Currently **0.25**
 *    (2026-08-11 `[USER]`, a sustained ~0.5σ target), so `k` = median + 0.25 rounded to 0.55.
 * The two `h` constants are the textbook SPC pair over the accumulator:
 *  - `F9_CUSUM_H` — the WARNING limit, AMBER at `S⁺ ≥ h`. Fire test ONLY: absent from the
 *    recurrence, it cannot change how high S⁺ climbs — `k` is the lever there.
 *  - `F9_CUSUM_H_RED` — the ACTION limit, RED at `S⁺ ≥ h_red`; the recurrence FIR-restarts to
 *    `h_red/2` on THAT crossing only (Lucas–Crosier head-start, 2026-08-11 `[USER]`). It DOES
 *    enter the recurrence (`cusumRedBound` → `velocityCusumSeries`), so moving it changes how S⁺
 *    evolves. ⛔ Restarting at the WARNING limit is REJECTED: it cut S⁺ down the moment it
 *    signalled, leaving the red line uncrossable except by one outsized step.
 * ALL THREE are HAND-SET off the chart, not calibrated (`docs/reference.md` §[arch] 4); the
 * constraints that bind a retune are `docs/indicator-cut-provenance.md` §F9. No `h` sweep is owed:
 * the textbook ARL target assumes i.i.d. input and z is ~98% autocorrelated — the leg over-fires
 * by design, `[USER]`-ruled (`Thresholds.velocitySigma` carries the per-field caveats).
 * ⛔ No fire-rate / episode / marginal-day figure anywhere in the tree describes the live leg —
 * every one was measured under a retired reset/k/window; quote none.
 * Exported for the same reason as the σ window: a test derives from the constant, never restates it.
 */
export const F9_CUSUM_K = 0.55;
export const F9_CUSUM_H = 2.0;
export const F9_CUSUM_H_RED = 2.7;

/** Per-id FEED override — absent ⇒ keyless FRED. Every site resolving `indicator.series` must
 *  dispatch through `fetchIndicatorObservations` (indicator-feed.ts); a tag, never a fetcher ref. */
export const FEED_OF: Record<string, "prices" | "ntfs"> = { F9: "prices", F11: "prices", F17: "prices", OVX: "prices", R8: "ntfs" };

/**
 * Per-id Treasury same-day HEAD tag — the rate ids FRED publishes T+1 whose identical numbers the US
 * Treasury posts ~2h before the 18:00-ET cron. A TAG, never
 * a fetcher ref (T2): the FEED stays FRED (`FEED_OF` has no entry for these), and `graftTreasuryHeadFor`
 * (indicator-feed.ts) appends only the rows NEWER than FRED's last obs, gated for equality on the overlap.
 * R1/`T10YIE` are ABSENT by construction (T7 — already same-day; a graft would swap a published series for
 * a reconstruction for zero gain). Column keys are UPPERCASED — the two curve files differ in case.
 */
export const TREASURY_HEAD_OF: Record<string, { curve: TreasuryCurve; column: string }> = {
  R4: { curve: "real", column: "10 YR" },
  R2: { curve: "nominal", column: "10 YR" },
  R3: { curve: "nominal", column: "2 YR" },
};

/**
 * Post-inversion floor rung values — R1's object, armed over its 21-obs means via the
 * SMOOTHED_LEVEL_OF branch (never restate them; mechanic on the type, domain-types.ts). `floorLevel`
 * is HAND-SET — `docs/indicator-cut-provenance.md` §R1 binds a retune.
 * Armed cut = expanding percentile, ruled 2026-08-12.
 */
export const T10Y3M_POST_INVERSION: PostInversionCooldown = {
  qualifyN: 30,
  floorLevel: 0.85,
  releaseN: 10,
  cutPctile: 0.37,
  cutWarmupObs: 1260,
  cutClamp: [0.5, 1.2],
  cutAnchorDate: "2006-01-01",
  shortLegSeries: "DGS3MO",
  shortLegWindow: 42,
  shortLegDropBp: 10,
};

/**
 * The regime-relative drawdown leg (ruled 2026-08-30) — UN-WIRED from R1 2026-08-31 (option A bare; the
 * mean-space sim showed it adds 0 days): no registry object carries it; kept as code + fixture-pinned tests.
 * NOT a `PostInversionCooldown` field: it must not inherit `T10Y3M_POST_INVERSION`'s arming (the rung's
 * re-arm needs 30 consecutive inverted closes). AMBER-only; the type's docblock (domain-types.ts) binds the rest.
 *
 * The measured cell (`npm run probe:r1-drawdown`, T10Y3M 2006-01-03→2026-08-28): 345d lead into
 * 2007, 471d into 2020, 15.2% calm-day firing (the shipped armed rung alone fires on 30.5%), +503
 * warning days. Widening the window to 252 or 504 obs loses the 2007 episode — do not revisit it.
 * ⚠ The four [USER]-pinned chart dates on `T10Y3M_POST_INVERSION` do NOT bind these knobs: the pin
 * test scores them with no short leg, so the gate is off and they cannot see this leg at all.
 * These four values live ONLY here.
 */
export const T10Y3M_DRAWDOWN: DrawdownLeg = {
  window: 126,
  dropPp: 0.40,
  gateWindow: 42,
  gateBp: 10,
};

/**
 * R8's mean-space rung — `levelCuts` flips the whole walk into 21-obs-mean space (arming, release,
 * pool; mechanic on the type, domain-types.ts). Both percentiles are HAND-SET off /lab —
 * `docs/indicator-cut-provenance.md` §R8 binds a retune; keep BOTH red clamp bounds ≤ amber's — the
 * clamp is monotone, so that ordering (not disjointness) is what keeps red ≤ amber structurally.
 * `shortLegSeries` must stay equal to `T10Y3M_POST_INVERSION`'s — run-cycle-fred.ts fetches ONE short leg
 * off the R1 object for both carriers (`registry.test.ts` pins the equality). The 2026-08-13 NTFS swap
 * left this leg on raw short-leg closes — the steepener gate is about the 2s/3m leg, not the mean.
 */
export const R8_MEAN_POST_INVERSION: PostInversionCooldown = {
  qualifyN: 5,
  floorLevel: 0.85,
  releaseN: 10,
  cutWarmupObs: 1260,
  cutAnchorDate: "2006-01-01",
  shortLegSeries: "DGS3MO",
  shortLegWindow: 42,
  shortLegDropBp: 10,
  levelCuts: {
    amber: { pctile: 0.40, clamp: [-0.83, 0.28] },
    red: { pctile: 0.35, clamp: [-0.84, 0.27] },
  },
};

/**
 * The indicator set (v4 §4). Family A credit spreads (FIN) and Family B rate
 * channel (RATE leading-rate + COINCIDENT vol) share the level+velocity shape,
 * so they all score through the same function. Scope per v4 §11 Path B:
 * F1, F2 (financing) + R1, R2, R3 (leading-rate) + R5 (coincident modifier).
 */
// F1 rise-from-trailing-low (Iran playbook Stage-3 credit leg, S3-b ruling 2026-08-15):
// DISPLAY-ONLY derived block — never scored; `decisionAt`
// persists its kind/window as the `decision` column.
export const F1_LOW_RISE_WINDOW = 90;
// HAND-SET off the plan's measured in-span base (`[USER]` 2026-08-15); in F1 LEVEL units (pct points).
export const F1_LOW_RISE_AMBER = 1.5;

export const INDICATORS: Indicator[] = ([
  {
    id: "F1",
    label: "HY OAS",
    longLabel: "HY OAS",
    series: "BAMLH0A0HYM2",
    // Semis top-10 seat. FRED clamps ICE to ~3y — a `full` backfill reaches 5y via the HY vintage (scripts/backfill/fred-archive.ts).
    backfill: { years: SEMIS_BACKFILL_YEARS },
    channel: "FIN",
    // The LEVEL pair below is HAND-SET (`[USER]`), and THIS ENTRY IS ITS SINGLE SOURCE.
    // F1 publishes no `credit/hyoas_operative_*` row, so `legBounds`' `op` leg falls back to
    // exactly this pair, and the detail chart's `threshold` bands resolve the SAME pair:
    // one number, one place, scorer and drawn line cannot drift.
    // The `op` leg is F1's ONLY level leg. The VELOCITY pair below is HAND-SET too, and THIS
    // ENTRY IS ITS SINGLE SOURCE; F1's velocity axis is the `vel-op` convention leg alone —
    // drawn line and scorer read THIS pair, semantics a DAILY SHOCK test (fires when
    // Δ30d ≥ cut, no latch).
    // NO measured or borrowed leg scores alongside the priors. Red folds every PRESENT leg with
    // a strict AND, so F1's scoring legs are exactly the two convention pairs below: `op`
    // (level) OR `vel-op` (velocity) at Amber, `op` AND `vel-op` at Red.
    // The `credit/hyoas` vintage stays REQUIRED even though NO cut resolves from it any more:
    // absent, `runScoringCycle` THROWS (`assertF1VintagePresent`, decision 4, fail-loud). Since
    // 2026-07-28 that guard is a ROWS-PRESENT check on the `credit/hyoas` prefix, not a resolved-
    // cut check — the frozen `calibration.json` vintage losing the prefix to a prune or a
    // hand-edit is still caught loudly (the `harness.py` regen it was written for retired
    // 2026-08-15), and the vintage stays the audit trail behind these hand-set numbers.
    thresholds: { amberLevel: 2.98, redLevel: 3.1, amberVelocity: 0.22, redVelocity: 0.36 },
    // EW-4 / D-A (`[USER]`, chosen a priori): F1's velocity leg reads a 30-day change, not the
    // global 20. Overrides `VELOCITY_WINDOW` for F1 ONLY — the constant stays 20 globally. The
    // span IS `ARM_ROC_WINDOW`, defined above and re-exported by exposure.ts (same window source,
    // own DAILY-SHOCK semantics — no ARM latch).
    // ⚠ F1's persisted `delta20` column therefore carries a 30-day move; the notify copy labels
    // the span off this field so the alert body never claims "20d".
    velocityWindow: ARM_ROC_WINDOW,
    // Both pairs are HAND-SET priors: no overfit gate (PBO/DSR) and no replay recall guard ran
    // on them. Typed field so a provenance sweep can find it.
    provisional: true,
    // ADDITIVE (S3-b): the Stage-3 playbook leg's decision variable, persisted via `decisionAt` and
    // never scored — `displayOnly` keeps F1 on its level/velocity serve path (see the flag's docblock).
    derived: {
      kind: "lowRise",
      window: F1_LOW_RISE_WINDOW,
      amber: F1_LOW_RISE_AMBER,
      red: null,
      label: `rise from ${F1_LOW_RISE_WINDOW}d low`,
      unit: "",
      displayOnly: true,
    },
  },
  {
    id: "F2",
    label: "IG OAS",
    longLabel: "IG OAS",
    series: "BAMLC0A0CM",
    // The VELOCITY pair was retuned 2026-07-28 (`[USER]`); the LEVEL pair then and again 2026-09-01.
    // provenance: docs/indicator-cut-provenance.md §F2
    // ⚠ HAND-SET, like the pair they replace — no overfit gate (PBO/DSR) and no replay recall
    // guard ran on them. The literals below are the SINGLE source for F2's two convention legs
    // (`op` level + `vel-op` velocity, `domain-cuts.ts`) — which, since the borrowed Baa10y z legs
    // were retired 2026-08-06,
    // are the ONLY legs F2 scores: `op` OR `vel-op` at Amber, `op` AND `vel-op` at Red (option D).
    // Deliberately NOT restated in prose here or in any fixture — a
    // retune is a one-line edit, and every copy is a second source that rots silently.
    thresholds: { amberLevel: 0.84, redLevel: 0.88, amberVelocity: 0.05, redVelocity: 0.09 },
  },
  {
    id: "F3",
    backfill: { years: EXPANDING_PERCENTILE_PREFIX_YEARS }, // sole deep FRED exception: the expanding-percentile cut anchors over this WEEKLY prefix
    label: "NFCI Risk",
    longLabel: "NFCI Risk",
    series: "NFCIRISK", // Chicago Fed NFCI — Risk subindex (keyless FRED, WEEKLY)
    channel: "FIN",
    // std-dev-scaled index, 0 ≈ average risk; direction defaults HIGH (positive = riskier).
    // DUAL-LEG (R2, 2026-07-21): a LEVEL leg plus an AMBER-ONLY, 4-WEEK velocity CONFIRMER /
    // COINCIDENT leg (EW-9). `velocityWindow: 4` makes the scored/persisted `delta20` a
    // 4-OBSERVATION change — on this WEEKLY series a 4-week rate-of-change, not the 20-trading-day
    // default. The velocity leg reaches AMBER only (no `redVelocity`), so a fast NFCIRISK move can
    // confirm toward WATCH but never escalates to Red on its own. This is a CONFIRMER, not a
    // leading indicator.
    // ⚠ **THESE ARE THE DEGRADE FALLBACK ONLY (since 2026-07-20, W1 slice 2).** F3 is on the
    // runtime expanding-percentile seam (`domain-cuts.ts` `CALIB_MAP`, `synthPriors: true`), so the
    // live cuts (both legs) are measured from stored history and these numbers reach the notify
    // path only when that history is missing/thin. They are NOT a conservative fallback:
    // `NFCIRISK`'s post-2010 maximum is 0.136, so amberLevel 0.5 / redLevel 1.0 is a level cut the
    // series cannot reach, and `amberVelocity: 0.5` is likewise a 4-week |Δ| the series never
    // makes — degrading to any of them puts F3 back to permanently GREEN. Do not "recalibrate"
    // them into fresh absolutes; that re-creates the drift class the seam exists to kill.
    thresholds: { amberLevel: 0.5, redLevel: 1.0, amberVelocity: 0.5 },
    velocityWindow: 4, // weekly ⇒ the velocity leg is a 4-WEEK rate-of-change (R2, EW-9)
    unit: "",
    // WEEKLY release (Chicago Fed NFCI, Wednesdays) ⇒ per-feed lag must not flag its
    // normal weekday lag as rot.
    cadence: "weekly",
    // ⚠ The weekly TIER cannot carry this feed. NFCI stamps an observation on the week-ending
    // FRIDAY and releases it the following WEDNESDAY (T+5), so the newest row available is already
    // 5d old the moment it lands. A row stays the newest until its SUCCESSOR is released, so its
    // max request-time age is (successor's release day − 1) − obs: **11** in a normal week.
    // 12 is the HOLIDAY-WEEK maximum, and it is the successor's slip that produces it, not this
    // row's own lag.
    // provenance: docs/indicator-cut-provenance.md §F3 — derived by `npm run probe:nfci-grid`.
    //
    // It is a PER-FEED knob and not a tier move on purpose: `deepLagRhythm` (feed-lag.ts) floors the
    // DEEP-LAG bar at the cadence TIER, never at the resolved cut (E7 §Stage 4.7-R2), so raising the
    // tier would widen every explicit weekly id's deep-lag bar 18 → 24 while this widens nobody's.
    // F3 still counts as past the 9d AMBITION (ladder.ts AMBITION_THRESHOLDS reads the cadence
    // tier and deliberately ignores this override), so the staged /lab "beyond target" overview
    // will keep it visible rather than let this cut hide it.
    lagAfterDays: 12,
  },
  {
    id: "R1",
    // sovereign-quote same-tenor Treasury yields at beta 1; two leads = the date-joined spread `a − b` (`levelSpread`).
    estimator: { kind: "carry-level", leads: ["US10Y", "US3M"], beta: 1 },
    label: "10y−3m",
    longLabel: "Term spread 10y-3m",
    series: "T10Y3M",
    channel: "RATE",
    // v4 §4 R1: LEADING, inverted polarity. Literature-faithful since 2026-08-31 (`[USER]`, option A,
    // `npm run probe:r1-lit`): a `SMOOTHED_LEVEL_OF` carrier — the stored/plotted value is the 21-obs
    // mean; RED = the 63-obs mean < `redLevel`; AMBER = the 21-obs mean < `redLevel` OR the rung below
    // armed over the 21-obs means (`smoothedLevelReadingSeries`, the `redWindow` branch). No steepener
    // escalation (the rung's `shortLeg*` knobs are R8's now) and NO `drawdownLeg` — `T10Y3M_DRAWDOWN`
    // stays as code; re-wiring it = `drawdownLeg: T10Y3M_DRAWDOWN` here + drop the `SMOOTHED_LEVEL_OF.R1`
    // row + restate. No `amberLevel` (retired 2026-08-30): the 0.5 fixed cut missed 60 of 118 falls.
    thresholds: { redLevel: 0.0 },
    direction: "LOW",
    postInversionCooldown: T10Y3M_POST_INVERSION,
  },
  {
    // R8 — the Engstrom–Sharpe near-term forward spread (NTFS, `FEED_OF.R8` → src/gsw.ts: exact
    // GSW construction, fail-loud) on a 21-obs trailing mean, which is the input every published
    // term-spread model is estimated on (daily closes are not). Scored by `scoreSmoothedLevel`
    // (scorers-core.ts) via the `SMOOTHED_LEVEL_OF` branch in `scoreWithCuts`; the mean window is
    // a descriptor knob, never a value in this file.
    //
    // Regime-aware (2026-08-13): NO registry level pair — the level legs are the armed
    // expanding-percentile pair on `R8_MEAN_POST_INVERSION.levelCuts` (mean-space rung,
    // `smoothedLevelReadingSeries`), OR'd with the Δ10 velocity pair below (tail-derived off the
    // committed history — provenance in `docs/indicator-cut-provenance.md` §R8, which binds a retune).
    // The NY Fed probit axis on the chart is DISPLAY-ONLY (2026-08-09 ruling) — it scores nothing.
    //
    // No `MEMBER_WEIGHT` row on purpose (zero danger-engine reach — the term spread already has
    // R1's row). ⚠ Rotted 2026-08-20 and corrected: this used to say "that is NOT inert — `FAMILY_OF.R8`
    // seats it in the `rates` panel worst-of and `rates` is an ARM family, so a firing R8 still raises
    // the dial floor." D1 made `firing` band-derived, so
    // the panel worst-of no longer arms anything. R8's dial reach is now EXACTLY its bridge: on a day
    // `R1` is dark, `bandIdsFor` substitutes R8 onto the rates band and a firing R8 does raise the floor;
    // on every other day it is rowless AND off-band, so D6's `legP` skips it too and it moves the dial
    // NOTHING. It still folds into the displayed `rates` worst-of and the `⌁` cannot-arm mark (paint).
    id: "R8",
    label: "NTFS avg",
    longLabel: "Near-term forward spread, 21-obs mean",
    series: "NTFS",
    channel: "RATE",
    thresholds: { amberVelocity: 0.18, redVelocity: 0.32 },
    direction: "LOW",
    // GSW feds200628.csv is "posted on Tuesday for the period up to the Friday of the previous
    // week" (Fed page) ⇒ structural age cycles ~4–11d; 12 = 11d max + 1 holiday-slipped Tuesday.
    cadence: "weekly",
    lagAfterDays: 12,
    // ⚠ RELEASE ≠ OBSERVATION (G1/BRENT precedent): the weekly post sits over NTFS's business-day
    // grid, so the Δ10 velocity below spans TRADING days — without this the caption says "10 weeks".
    obsCadence: "daily",
    velocityWindow: 10,
    postInversionCooldown: R8_MEAN_POST_INVERSION,
    confirmer: true,
  },
  {
    id: "R2",
    estimator: { kind: "carry-level", leads: ["US10Y"], beta: 1 },
    label: "10y Δ",
    longLabel: "10y velocity",
    series: "DGS10",
    channel: "RATE",
    // v4 §4 R2: rate shock. Velocity-only.
    thresholds: { amberVelocity: 0.2, redVelocity: 0.27 },
  },
  {
    id: "R3",
    estimator: { kind: "carry-level", leads: ["US2Y"], beta: 1 },
    label: "2y Δ",
    longLabel: "2y velocity",
    series: "DGS2",
    channel: "RATE",
    // v4 §4 R3: Fed-path shock. Velocity-only.
    thresholds: { amberVelocity: 0.35, redVelocity: 0.6 },
  },
  {
    id: "R4",
    label: "10y RY Δ",
    longLabel: "10y real-yield velocity",
    series: "DFII10", // FRED: 10y TIPS real yield, daily business-day
    backfill: { since: DFII10_ORIGIN }, // Semis top-10 seat; = r4DbFirstFeed's origin — shallower prunes ECY's DFII10 on restate
    channel: "RATE",
    // v4 §4 R4: rate shock. Velocity-only.
    // DFII10 can go negative (2020–22), but velocity-only means a +0.18 *rise*
    // over 20d is the shock regardless of sign, so the negative-level case never bites.
    // provenance: docs/indicator-cut-provenance.md §R4
    thresholds: { amberVelocity: 0.18, redVelocity: 0.25 },
  },
  {
    id: "R5",
    // the closes feed's `^VIX` — read off `fetchDailyCloses`' default ~2y window only (its pre-2018 `^VIX` runs at 2× the index publisher's).
    estimator: { kind: "carry-level", leads: ["^VIX"], beta: 1 },
    label: "VIX",
    longLabel: "VIX",
    series: "VIXCLS",
    channel: "COINCIDENT",
    // v4 §4 R5, C4 cutpoint pass (2026-07-15): coincident "fuse is lit" gauge,
    // adjusted from 25/35 — C4's standard four-regime VIX map
    // puts the high-vol boundary lower; 25/35 fired a full regime late.
    // Level-only. The C4 map's "3-day" hold was originally stood in for by the
    // per-indicator 2-close buffer (§6.1); the directional fold (2026-08-26) fires these
    // cuts on a SINGLE close upward — only the RELEASE keeps a 2-close stand-in for that hold.
    thresholds: { amberLevel: 20, redLevel: 30 },
    unit: "",
  },
  // --- EM-leading indicators (F9/F10/F11) — CONTEXT, EM leg-selection axis --------
  // Three research-backed LEADING reads on "is the EM leg too risky to hold?", added
  // via the shared scoreIndicator FRED loop (fetch → score → persist, zero extra wiring
  // — they ride INDICATORS in run-dbfirst.ts). channel CONTEXT: they feed the danger ledger +
  // T1 dial families off GLOBAL_FAMILIES (post-O2 the dial reads families with no channel
  // filter, so a CONTEXT member CAN move the dial). All bands are PRIORS — uncalibrated.
  {
    id: "F9",
    label: "Broad USD",
    longLabel: "Broad USD",
    series: "USDU", // WisdomTree USD Bullish ETF (daily closes — `FEED_OF.F9` routes it off FRED)
    channel: "CONTEXT",
    // Left the weekly H.10 release 2026-08-10: release
    // and observation grid no longer diverge, so no `obsCadence` — keep `cadence` EXPLICIT,
    // `deepLagRhythm` (feed-lag.ts) takes the strict p90 arm without it.
    cadence: "daily",
    // direction defaults HIGH: rising dollar = EM risk-off. Feeds the cross-asset (xa) danger family.
    // ⛔ **STALE AS OF 2026-08-08 — the whole co-fire paragraph below is a DEAD VINTAGE, kept only
    // as the record of a closed question.** A 2026-08-08 change
    // replaced F9's cut set outright (runtime percentile over |Δ60| → fixed σ cuts on a
    // strictly-historical rolling z), so the 139 RED days it counts were produced by a scorer that
    // no longer exists and NO number below describes today's board. Do not quote it as live, and do
    // not re-derive a decision from it — the QUALITATIVE finding it closed (the `xa` ↔ `rate` axes
    // are overwhelmingly disjoint, so no double-count remedy is owed) is what survives; the counts
    // do not. Re-running it is the RE-RUN recipe at the end of the paragraph, unchanged.
    // ⚠ **F9 scores the RAW dollar change, deliberately — the `xa` ↔ `rate` double-count was MEASURED
    // and is not there** (2026-08-08, closed). The worry
    // was that a dollar rally driven by a widening rate differential is not EM stress, and the `rate`
    // family already carries that differential through R2/R3/R4 — so the two families might report the
    // same thing twice. Measured over the full confirmed prod series (n=3727 days): F9 RED on 139 days,
    // R2|R3|R4 RED on 97, **BOTH on 7**. P(rate RED | F9 RED) = 0.050 against a 0.026 base rate — a
    // ~1.9× lift, but only 5% of F9's RED days co-fire, so the two axes are overwhelmingly disjoint.
    // ⚠ **VINTAGE, and why the count rotted.** Measured under F9's SYNTH-PRIOR cut pair — i.e.
    // BEFORE the σ-standardization landed and removed F9 from `SYNTH_PRIOR_IDS`. The 139 is a direct
    // function of those cuts, so it went stale the moment that shipped: it is the pre-σ vintage,
    // not a current figure. Two further caveats: F9's `state` column had just been restated
    // onto the 60-day span while R2/R3/R4 kept their own persisted vintage (`readings.state` is served
    // unscored), so the two columns are not same-vintage; and `n` is F9's OWN series length, with the
    // rate REDs counted only on F9's dates — which is the correct denominator for this conditional, but
    // means `n` is not an intersection. To RE-RUN it (the check the last sentence asks for), read
    // `getSeriesBulk(["F9","R2","R3","R4"], { limit: 4000 })`, index each by `date`, and count days
    // where F9 `state === "RED"` against days where any of R2/R3/R4 is `"RED"`.
    // Do NOT swap this for a risk-appetite residual (a regression on a US-minus-foreign short-rate
    // differential): that remedy was DROPPED 2026-08-08 `[USER]` as designed work, and its premise —
    // that the two families duplicate — is what this measurement refutes. Re-open only if the co-fire
    // rate moves materially.
    // ⚠ **The LEVEL axis is RETIRED (2026-08-07,
    // user ruling).** `DTWEXBGS` (the vintage measured; the argument carries to the current
    // `USDU` series) is a non-stationary trending index, so an absolute level cut is a
    // date threshold in disguise and an expanding-percentile one is worse — it recodes "the dollar is
    // higher than it used to be" as "extreme", and a POT tail fit over a trending series puts every
    // exceedance in a calendar window rather than an exchangeable tail.
    // provenance: docs/indicator-cut-provenance.md §F9
    // The axis is retired outright, NOT retuned: a better number on a
    // trending index is still a number on a trending index. The surviving VELOCITY pair below is the
    // one source for F9's cuts; do not restate it elsewhere. Retiring the pair here was only HALF the
    // kill switch — `CALIB_MAP.F9` (`domain-cuts.ts`) must stay `legs: { velocity: true }`, because
    // it is the row that keeps F9's velocity axis addressable at all. (The old second half of this
    // warning — that `withSynthesizedPriors` would otherwise emit measured LEVEL rows — is moot
    // since 2026-08-08: `CALIB_MAP.F9` no longer carries `synthPriors`, so nothing is synthesized
    // for F9 on any axis.)
    // ⚠ **THESE TWO NUMBERS ARE σ, NOT INDEX POINTS** (2026-08-08, `[USER]` ruling).
    // A 60-day change on a trending,
    // regime-varying index has no fixed raw cut — the previous pair was a labelled
    // degrade-fallback behind a runtime expanding-percentile fit. Both are gone: F9 now
    // standardizes first (`z = Δ60 / σ`, σ strictly historical) and cuts in σ units, which
    // is stable and readable ("the dollar moved 2σ in a quarter"). `velocitySigma` below is
    // the ONE discriminator that makes this pair σ-valued; `legBounds` (domain-legs.ts)
    // reads it and routes the pair to the `vel-z` leg instead of the raw-units `vel-op` leg.
    // These are the LIVE cuts, not priors — `CALIB_MAP.F9` no longer carries `synthPriors`
    // and no vintage publishes an `fx/dtwexbgs_*` row, so nothing overrides them.
    // Hand-set off the detail chart by the user, not calibrated.
    // ⚠ The live pair ships UNMEASURED by ruling — no day-share was computed at it, and none is owed,
    // so NO fire-rate / day-count / marginal-contribution figure anywhere describes the live cut
    // (`docs/indicator-cut-provenance.md` §F9). Retired-pair figures are in that file's git history.
    thresholds: {
      amberVelocity: 0.7,
      redVelocity: 0.9,
      velocitySigma: {
        window: F9_SIGMA_WINDOW,
        minObs: F9_SIGMA_MIN_OBS,
        cusumK: F9_CUSUM_K,
        cusumH: F9_CUSUM_H,
        cusumHRed: F9_CUSUM_H_RED,
      },
    },
    // ⚠ **60 TRADING DAYS, not 60 weeks** (Stage 2):
    // the speed axis is re-horizoned to the BIS/Obstfeld–Zhou QUARTER. `USDU` returns BUSINESS-DAY
    // closes under `cadence: "daily"`, so release and observation grid agree and this window steps
    // over trading days either way.
    // ONE field moves BOTH windows: the scored/persisted `delta20` (`buildReadings` in
    // scorers-core.ts and `scoreDaySeries` in domain-fold.ts both resolve
    // `velocityWindow ?? VELOCITY_WINDOW`) AND — since 2026-08-08 — the Δ quantity the rolling σ
    // standardizes, `velocitySigmaZSeries` taking `w` from `scoreDaySeries`' single resolution
    // rather than re-reading the field. (The `computeSynthCutsDetailed` percentile that used to be
    // the third consumer is gone with F9's `synthPriors`.) Do NOT add a second window path — they
    // would diverge silently. The σ WINDOW above is a separate, additional knob and likewise has
    // exactly one resolution site (`F9_SIGMA_WINDOW` → `thresholds.velocitySigma`).
    velocityWindow: 60,
    unit: "",
  },
  {
    id: "F10",
    label: "EM OAS",
    longLabel: "EM OAS",
    series: "BAMLEMCBPIOAS", // ICE BofA EM Corporate Plus OAS (keyless FRED, DAILY) — free EMBI proxy
    channel: "CONTEXT",
    // direction HIGH: wider spread = EM credit stress. FRED serves % not bps (3.5 = 350bps) — %-native
    // thresholds, NO bps scaling in the fetch. Feeds the credit (cr) danger family.
    // ⚠ **These hand-typed priors are the LIVE cuts again as of 2026-07-18 (option C).**
    // provenance: docs/indicator-cut-provenance.md §F10 (the FEED-TRUNCATION measurement).
    // F10 is ABSENT from `CALIB_MAP` (`domain-cuts.ts`).
    thresholds: { amberLevel: 1.62, redLevel: 1.8, amberVelocity: 0.4, redVelocity: 0.8 }, // %-native, hand-set 2026-08-30
    unit: "",
  },
  {
    id: "F11",
    label: "USD/CNY",
    longLabel: "CNY (China risk)",
    series: "CNY=X", // CNY per USD (price feed, not FRED — `FEED_OF.F11`; `=X` has no free source, prices.ts)
    channel: "CONTEXT",
    // Left the weekly H.10 release 2026-08-10: release
    // and observation grid no longer diverge, so no `obsCadence` — keep `cadence` EXPLICIT,
    // `deepLagRhythm` (feed-lag.ts) takes the strict p90 arm without it.
    cadence: "daily",
    // direction HIGH: yuan weakening (CNY/USD rising) = China/EM risk-off. The fast keyless China-
    // specific tell (a market-price/RORO read, NOT the slow credit impulse). Feeds the cross-asset (xa) family.
    // ⚠ **The LEVEL axis is RETIRED (2026-08-08,
    // user rulings).** The CNY is a MANAGED float, so an absolute level cut reads the PEG REGIME rather
    // than danger: the currency was administratively pinned at ≈8.28 until the 2005-07-21 peg exit, and
    // the level axis's own measured history says so — 34.0% of all closes at or above the amber prior
    // (2,903 of the 3,499 red-prior days sit BEFORE the peg exit), the red prior last reached
    // 2007-12-07, and in the last three years amber fires on 39.6% of days while red fires on none. Its
    // D3 per-episode leads were `+364 · +365 · miss · miss · miss · −333` — two at the lookback ceiling
    // (already elevated when the window opened) and one NEGATIVE. σ of the level across calendar 2000
    // was 0.001: a hard peg has no variance, and an expanding percentile over that history fits a peg,
    // not an exchangeable tail. The retired pair was `amberLevel: 7.2` / `redLevel: 7.4` — history, safe
    // to restate here only because they are no longer live cuts.
    // provenance: docs/indicator-cut-provenance.md §F11
    // The axis is retired outright, NOT retuned: a better number is still a number on a series that
    // spent eleven years pegged. Retiring the pair here is only HALF the kill switch — `CALIB_MAP.F11`
    // (`domain-cuts.ts`) must stay `evtLevel: false, evtVelocity: true, legs: { velocity: true }`, or
    // `withSynthesizedPriors` would go on emitting measured level rows.
    // ⚠ **ACCEPTED APPROXIMATION — the velocity axis is denominated in POINTS, not log/percent**
    // (RULED 2026-08-08). `delta20` here is an
    // ABSOLUTE CNY-per-USD difference on a series that has sat at 8.28, 6.19 and 7.35, so the same
    // 0.05 is a different move at each level and a fixed point cut is a different percentile in every
    // era (⚠ PRE-RE-HORIZON VINTAGE — measured on the Δ20 window Stage 2a replaced, NOT on the Δ60
    // quantity now scored: log Δ20 p85 was 0.67% full history, 1.21% post-2015, 0.59% last 3y. Kept as
    // the evidence that carried the ruling; deliberately NOT re-measured). The unit
    // objection is accepted as CORRECT and deliberately NOT acted on: `delta20` is persisted, charted,
    // restated by `scripts/backfill.ts --restate=` and read by `chart-rail.ts` in level units, so the
    // change is a persisted-column migration on both prod and dev buying a ~30% residue across the
    // post-2005 level range. Do not reopen it as a stage.
    // ⚠ **THESE TWO NUMBERS ARE σ MULTIPLES, NOT CNY-PER-USD POINTS** (2026-08-09).
    // They are no longer the uncalibrated degrade
    // fallback behind a runtime expanding percentile: that percentile is RETIRED (`CALIB_MAP.F11` no
    // longer carries `synthPriors`), so under ruling 1 no measured velocity cut is left to prefer and
    // this pair is what scores every day. `velocitySigma` below is the ONE discriminator that makes it
    // σ-valued — `legBounds` (domain-legs.ts) reads it, suppresses the raw-units `vel-op` convention
    // fallback (`velOp ?? (velSigma ? undefined : velConvention)`) and routes the pair to `vel-z`.
    // ⚠ HAND-SET by user ruling 2026-08-16 — and that ruling DELIBERATELY ABANDONS the fire-rate fit
    // this pair used to carry. The retired pair (1.23 / 1.49) was MEASURED 2026-08-10 to hold the
    // retired rect-1260 estimator's stored-era rate (3.1 / 9.7% amber-only/red against a banked
    // 3.0 / 9.7%); the pair below re-measures at 2.8 / 13.9% on the same probe, i.e. red fires ~43%
    // more often. That loosening IS the ruling — do NOT "restore" the old rate by re-fitting.
    // Sweep the response surface before any FURTHER move:
    // `npm run probe:sigma-response -- --id=F11 --csv=scripts/backtest/data/cny.csv --multiples=<a>,<r>`
    // (add `--floor=<f>` to sweep the estimator too). No HAND-SET fixture mirrors the pair, but the
    // GENERATED `src/goldens/golden-charts.json` renders both as axis labels — a retune owes
    // `npm run golden:regen` in the same commit, or `golden-pins.test.ts` reds on the stale label.
    thresholds: {
      amberVelocity: 1.0,
      redVelocity: 1.15,
      // ⛔ NO `cusumK`/`cusumH` — F11 declines the persistence leg (ruling 5): the CUSUM leg was
      // measured inert for this id (+2…+6 marginal days out of 3,750 at every `h` ∈ {2..8}). Both
      // fields are optional since Stage 2, and every consumer gates on the RESOLVED alarm bound
      // rather than on `velocitySigma` presence — so F11 gets the speed leg with no S⁺ axis, no
      // `vel-cusum` leg and no `cusum` wire key. Adding either field re-enables all three.
      velocitySigma: {
        window: F11_SIGMA_WINDOW,
        minObs: F11_SIGMA_MIN_OBS,
        ewmaHalfLife: F11_SIGMA_EWMA_HALF_LIFE,
        ewmaFloorFactor: F11_SIGMA_FLOOR,
        fastWindow: F11_FAST_VELOCITY_WINDOW,
      },
    },
    // ⚠ **60 TRADING DAYS, not 60 weeks** (Stage 2,
    // ruled): the speed axis is re-horizoned to the QUARTER, adopting F9's window for
    // symmetry across the two H.10 FX ids. `CNY=X` returns BUSINESS-DAY closes under `cadence: "daily"`,
    // so release and observation grid agree and this window steps over trading days either way.
    // ONE field moves BOTH windows: the scored/persisted `delta20` (`buildReadings` in
    // scorers-core.ts and `rawStateSeries` in domain-fold.ts both resolve
    // `velocityWindow ?? VELOCITY_WINDOW`) AND — since 2026-08-09 — the Δ quantity the rolling σ
    // standardizes, `velocitySigmaZSeries` taking `w` from `scoreDaySeries`' single resolution rather
    // than re-reading the field. (The `computeSynthCutsDetailed` percentile that used to be the third
    // consumer is gone with F11's `synthPriors`.) Do NOT add a second window path — they would
    // diverge silently. The σ WINDOW above is a separate, additional knob.
    // ⚠ Persisted `delta20` CHANGES MEANING for F11 at this edit: rows written before it are Δ20
    // and rows after are Δ60. `scripts/backfill.ts --restate=F11` on BOTH prod and dev is the
    // re-derive path (never a full backfill) and rides with the ship.
    // ⚠ **DEGRADE-TO-GREEN AT THE HEAD OF STORED HISTORY — accepted, not a scorer bug.** With the
    // percentile retired, a day whose σ cannot resolve (fewer than `F11_SIGMA_MIN_OBS` usable deltas)
    // has NO velocity leg at all and scores GREEN, rather than falling back to a points cut. Prod
    // stores from 2011-08, so roughly the first year of restated rows is green by construction. It is
    // visible on `/lab` replay; do not "fix" it by re-adding a raw-points fallback, which is the
    // silent-escalation trap `domain-cuts.ts`' §F11 note describes.
    // ⛔ The offshore CNH−CNY basis (option C) is DECLINED, not pending: the closes provider's `CNH=X` and
    // `USDCNH=X` each return exactly ONE bar at every window (measured 2026-08-08 against the same
    // chart endpoint `prices.ts` uses; onshore `CNY=X` returns 4,331 over the identical request), so
    // there is no offshore SERIES to build a basis from. Do not re-open it without a different feed.
    velocityWindow: 60,
    unit: "",
  },
  // --- Inflation breakevens (T10YIE/T5YIFR) — CONTEXT, crisis regime discriminators --------
  // Two plain FRED daily series (ids = series names, BAA10Y precedent), added via the shared
  // scoreIndicator FRED loop (fetch → score → persist, zero extra wiring — they ride INDICATORS
  // in run-dbfirst.ts). channel CONTEXT, NOT RATE: escalatorFloorBreakdown's rateBase averages
  // non-confirmer RATE readings, so a RATE channel would dilute the existing R1–R4 stress floor;
  // CONTEXT members still move the dial via the `rates` family (F13-in-credit precedent).
  // Both level-only, direction HIGH (rising breakeven = inflation de-anchoring risk).
  // ⛔ BOTH PAIRS FINAL `[USER]` 2026-08-31 — not provisional. T5YIFR reading LOWER than T10YIE is the
  // ruled design; do not propose a distribution-matched retune (`indicator-cut-provenance.md` §T5YIFR).
  {
    id: "T10YIE",
    // leads = [num, den]; `beta` = a 2015–2019 hold-out fit — re-measure and re-pin by hand.
    estimator: { kind: "carry-ratio", leads: ["TIP", "IEF"], beta: 11.295 },
    label: "10y breakeven",
    longLabel: "10y inflation breakeven",
    series: "T10YIE", // 10-Year Breakeven Inflation Rate (keyless FRED, DAILY)
    channel: "CONTEXT",
    // No CALIB_MAP entry (F10 precedent), so these registry values ARE the live cuts.
    // Both ids deliberately share ONE velocity pair.
    // provenance: docs/indicator-cut-provenance.md §T10YIE
    thresholds: { amberLevel: 2.5, redLevel: 2.85, amberVelocity: 0.2, redVelocity: 0.35 },
    unit: "%",
  },
  {
    id: "T5YIFR",
    label: "5y5y forward",
    longLabel: "5y5y forward inflation",
    series: "T5YIFR", // 5-Year, 5-Year Forward Inflation Expectation Rate (keyless FRED, DAILY)
    channel: "CONTEXT",
    // provenance: docs/indicator-cut-provenance.md §T5YIFR
    // VELOCITY leg added 2026-07-31 `[USER]` — same rationale and same storedDelta chart route
    // as T10YIE above, and the SAME pair by design (the two series' Δ20d quantiles came out
    // near-identical: equal p90, p97 within 0.02).
    thresholds: { amberLevel: 2.4, redLevel: 2.6, amberVelocity: 0.2, redVelocity: 0.35 },
    // Its own factor, NOT "oil": de-anchoring is a distinct read, so oil + T5YIFR lit = 2 factors.
    geoFactor: "infl-exp",
    unit: "%",
  },
  // --- OVX crude-oil implied vol — GEO channel, G1 sibling ---------------------------------
  // `^OVX` (the index publisher's Crude Oil Volatility Index) via `FEED_OF.OVX = "prices"` (S6/R5)
  // — a same-day close, not the T+1 FRED `OVXCLS`
  // it scored on until then. Rides the shared scoreIndicator INDICATORS loop (`FEED_OF` routes its
  // FETCH off FRED to `fetchDailyCloses("^OVX")`, exactly as F9/F11/F17 do); the stored-series
  // fallback beats a FAST_CONFIRMERS degrade-to-nothing for this daily series. channel GEO: `autoGeoBase` in
  // escalatorFloorBreakdown (alert-band.ts) counts DISTINCT `geoFactor`s among the confirmed
  // non-GREEN GEO readings, so OVX elevated alone floors WATCH but OVX + G1 + BRENT still buy
  // ONE flag between them (all three read the oil factor); the stack up to the geo cap
  // (WARNING) now comes from manual flags / a declared crisis stage. Direction HIGH, TWO legs
  // under OR since 2026-08-06 (`OVX_DESCRIPTOR`):
  // the R5-VIX-shaped level band
  // below (implied vol's LEVEL is the regime read) OR a 5-session spike, worse-of. It stays in
  // INDICATORS — `scoreWithCuts` branches it onto `scoreOil` inside the loop.
  // R5b gave it the `derived` block below, which moves it onto the derived-kind chart layout.
  // Its OR leg is a SECOND BAND, never a `GATES` entry — gates are AND-semantic and would dim
  // stretches that actually fire (`gates.ts`; `gates.test.ts` pins `GATES.OVX === undefined`).
  {
    id: "OVX",
    label: "OVX",
    longLabel: "Oil implied vol (OVX)",
    series: "^OVX", // the index publisher's Crude Oil Volatility Index (DAILY — `^` has no free source, prices.ts; FEED_OF.OVX="prices")
    channel: "GEO",
    geoFactor: "oil", // implied vol ON oil — same underlying factor as G1/BRENT (see `geoFactor`)
    // User-set 2026-08-11 off the detail chart (hand-set cuts): amber = sustained oil-shock
    // regime, red = blowout zone. No CALIB_MAP entry (F10 precedent) — this pair IS the live cut.
    thresholds: { amberLevel: 73, redLevel: 83 },
    unit: "",
    provisional: true,
    // The spike leg, drawn on the right axis against its own pair. Every value is READ from
    // `OVX_DESCRIPTOR.scorer.constants`, and this block is ALSO what `scoreOil` scores the spike
    // leg against (`fixedBandLegs`, which throws if the mirroring below is broken) — so a retune
    // moves band and scorer together (`indicator-loop.md` §A retune is a ONE-place edit). Unlike G1/BRENT this id
    // keeps a non-empty `thresholds`, so `derivedChart` draws BOTH pairs: the level band on
    // the price axis AND this one, which is the honest picture of an OR (R5b).
    derived: {
      kind: "return",
      window: OVX_DESCRIPTOR.scorer.constants.velocityWindow,
      amber: OVX_DESCRIPTOR.scorer.constants.amberRet,
      red: OVX_DESCRIPTOR.scorer.constants.redRet,
      label: `${OVX_DESCRIPTOR.scorer.constants.velocityWindow}-day return`,
      unit: "%",
    },
  },
  // --- ex-US-developed (EAFE) leading indicators — RETIRED 2026-07-17 (DEC-19/DEC-20) ------
  // F14 (OECD CLI Euro area, `EA19LOLITONOSTSAM`) and F15 (Euro biz confidence,
  // `BSCICP03EZM665S`) are DELETED: both FRED feeds are dead. F14's last obs is 2022-11-01
  // (EA19 retired when Croatia joined the euro in 2023; FRED never picked up an EA20 CLI and
  // OECD's `LI` measure has no euro-area aggregate at all) — it sat frozen RED forever,
  // pinning `macro-cycle` RED through the worst-of fold. F15's last obs is 2024-01-01 (the
  // OECD MEI database retirement killed the whole `…03…665S` naming) — frozen AMBER forever.
  // Do NOT re-add either series. The load-bearing case against re-wiring a CLI successor is
  // that no study measures CLI's lead to EQUITY DRAWDOWNS at all — the lead-time literature
  // targets output-gap turning points. A keyless OECD SDMX revival candidate for F15
  // (`EA20.M.BCICP`) is logged in `docs/backlog.md` §Open, deliberately NOT wired: it re-inherits the
  // uncalibrated ~100-centred priors and would need real calibration to mean anything
  //.
  {
    id: "F17",
    label: "USD/JPY",
    longLabel: "JPY (Japan risk)",
    series: "JPY=X", // JPY per USD (price feed, not FRED — `FEED_OF.F17`; `=X` has no free source, prices.ts)
    backfill: { years: SEMIS_BACKFILL_YEARS }, // Semis re-entry input (`yen_carry` sign)
    channel: "CONTEXT",
    cadence: "daily",
    // direction HIGH (registry default): yen WEAKENING (JPY/USD rising) = Japan risk / carry stress;
    // the yen-STRENGTH haven side stays FXH's.
    // Velocity-only, σ-valued — the F11 template (its level axis is declined at mint, not retired later).
    thresholds: {
      amberVelocity: 0.9,
      redVelocity: 1.1,
      // Hand-set 2026-08-11 off the detail chart (supersedes the 2026-08-10 probe fit).
      velocitySigma: {
        // Minted as a COPY of F11's blend (template ruling 2026-08-10) — F17's own knobs thereafter;
        // re-fit the multiples above after ANY move here.
        window: 504,
        minObs: 252,
        ewmaHalfLife: 125,
        ewmaFloorFactor: 0.9,
      },
    },
    velocityWindow: 60,
    unit: "",
    provisional: false,
  },
  // new-indicator:INDICATORS-END
  // ^ `scripts/new-indicator.ts` inserts a generated `Indicator` entry immediately ABOVE that
  // marker line; its `insertAtAnchor` throws when the marker appears 0 or ≥2 times, so a rewrite
  // of this array's tail that drops or duplicates it fails loudly at the next generator run.
] as Indicator[]).map((ind) => withMultipliedThresholds(ind));

/**
 * Reserved-but-unimplemented indicators (v4 §4) — no keyless data source as of
 * 2026-06-26, so they are NOT in INDICATORS and contribute nothing (a missing
 * COINCIDENT/CONTEXT reading is GREEN: maxState([]) = GREEN, channelScore([]) = 0):
 *   - F7 (CAPE, valuation, CONTEXT — a Stage 2 channel addition) — the Shiller CAPE
 *     history is Excel/HTML-only, monthly.
 * F4 (semis) + F5 (breadth) are now LIVE via the price feed (`prices.ts`,
 * prices.ts) — see PRICE_INDICATORS + scoreSemis/scoreBreadth (registry-price.ts).
 */

/**
 * Shiller CAPE — VALUE-ONLY context card (all-indicators-cards, 2026-07-22). Listed in
 * ALL_INDICATORS (registry.ts) so `/api/indicators` emits a card meta and `/api/series` serves its
 * history, but DELIBERATELY NOT in `INDICATORS` — the cron run loop iterates `INDICATORS`, so
 * F7 is NEVER scored, confirmed, or armed. `thresholds: {}` (no scorer) → `buildIndicatorChart`
 * returns the `"context-only"` sentinel (allowlisted in chart-bands.test.ts). Its live CAPE is read
 * ONLY by the display-context `computeCapeValuation` (`valuation.ts`, consumed by /api/status and
 * /api/indicators) — the dial applies NO CAPE multiplier (`mEff` retired, ruled O2 2026-08-11), so
 * F7 reaches no dial term and no firing family member. The card VALUE is
 * bridged read-time in `api/status.ts` via `computeCapeValuation` (F7's reading row rides a distinct
 * `run_at`, so /status's firedAt-scoped read never returns it). `channel: CONTEXT`, monthly cadence.
 */
export const F7: Indicator = {
  id: "F7",
  backfill: { years: BACKFILL_YEARS + 1 },
  label: "CAPE",
  longLabel: "Shiller CAPE (valuation)",
  series: "F7", // persisted CAPE series (backfillCapeOnCron → getSeries("F7")); NOT a FRED-loop fetch
  channel: "CONTEXT",
  thresholds: {}, // never scored — value-only card
  unit: "",
  cadence: "monthly",
};

/** BBB OAS — value-only CONTEXT card, never scored (outside `INDICATORS`); seeded by `INPUT_SERIES` (input-series.ts).
 *  Read by the semis drawdown-watch `bbb` confirmer (scripts/semis-watch.ts). */
export const BBB: Indicator = {
  id: "BBB",
  label: "BBB OAS",
  longLabel: "ICE BofA BBB US Corporate OAS (FRED BAMLC0A4CBBB)",
  series: "BAMLC0A4CBBB",
  channel: "CONTEXT",
  thresholds: {},
  unit: "%",
};

/**
 * ECY excess CAPE yield (2026-08-11) — valuation×trend gate over live CAPE + DFII10, scored
 * bespoke by `scoreEcy` (FAST_CONFIRMERS tail; cuts on ECY_DESCRIPTOR, family-descriptor-rows.ts).
 * Persisted `level` (the stored/plotted value) is the month's ECY in **percent**; `decision`
 * carries the strict-prefix expanding rank scored against ECY_EXPENSIVE_P under the monthly
 * ECY_MIN_OBS floor. CONTEXT ⇒ off every roll-up; the `vb` danger-family seat lands via
 * families.ts (E4), not here.
 */
export const ECY: Indicator = {
  id: "ECY",
  label: "ECY",
  longLabel: "Excess CAPE yield (valuation × trend)",
  series: "ECY", // persisted derived series (F7 CAPE + DFII10 join); not a direct feed symbol
  channel: "CONTEXT",
  direction: "LOW",
  thresholds: {}, // bespoke scoreEcy (ECY_DESCRIPTOR cuts + GT gate), not classify()
  unit: "%",
  cadence: "monthly",
};

// --- EBP credit confirmer (Phase-2 C3, 2026-06-28) -------------------------
//
// Excess Bond Premium: a validated credit-risk-appetite predictor with free full
// history (1973→, monthly) from federalreserve.gov — fetched via its OWN feed
// (ebp.ts), NOT the FRED loop, so it is NOT in INDICATORS. It is a FIN-channel
// COINCIDENT CONFIRMER (median lead ≈ −1d in the harness → it must not lead): the
// gate in the retired verdict engine only credits it once the non-EBP FIN base (F1/F2) is
// already elevated, and excludes it from the cross-channel red-count. Level-only
// (direction HIGH), scored via the existing scoreIndicator path so it inherits the
// standard confirm fold — directional since 2026-08-26: a WORSENING monthly EBP print
// counts the day it lands; only a stand-down waits 2 prints. Unit is blank — EBP is an
// excess premium in pp, not a quoted OAS spread.
//
// ⚠ HAND-SET (`[USER]`; loosened 2026-07-31), and the SINGLE source for EBP's level axis. The pair
// below replaces what the published `credit/ebp` vintage used to put on that axis (the
// `ebp_operative_*` cell-sweep rows, and the `ebp_evt_level_*` GPD pair behind them): both
// legs were retired in the SAME edit via `CALIB_MAP.EBP.evtLevel: false` (`domain-cuts.ts`),
// because the legs OR and the lower measured amber would otherwise keep binding — the
// retune would have been invisible. The rows stay published; only the routing closed.
// Deliberately NOT restated in prose or in any fixture: a retune is a one-line edit here.
// The regime-z leg (own `ebp_zref_*` distribution) is NOT gated on `evtLevel` and ORs on
// beside this pair, unchanged.
//
// ⚠ THE RESULTING FIRE RATE IS INTENDED — do NOT "fix" it by tightening.
// provenance: docs/indicator-cut-provenance.md §EBP (the retired 2026-07-29 pair's measurement).
// A future session finding EBP amber "too often" is observing the ruled behaviour, not a bug: EBP
// is a CONFIRMER, gated behind an elevated non-EBP FIN base, so a permissive level axis cannot
// move the ladder on its own. Re-tuning needs a fresh `[USER]` ruling, not a percentile argument.
export const EBP: Indicator = withMultipliedThresholds({
  id: "EBP",
  label: "EBP",
  longLabel: "Excess bond premium (EBP, monthly)",
  series: "ebp", // fetched via fetchEbp() (ebp.ts), not a FRED id
  channel: "FIN",
  thresholds: { amberLevel: -0.14, redLevel: 0.01 }, // level-only, HIGH
  confirmer: true,
  cadence: "monthly", // delta20 spans 20 months → labeled "20mo Δ", not "20d Δ"
  // Fed FEDS Notes `ebp_csv.csv` posts the 4th business day of a month for an observation dated the
  // 1st of the PRIOR month ⇒ structural max ~62–66d; `monthly`'s 40 would flag every normal month.
  // Stage-1 measured maxAge 55.
  lagAfterDays: 70,
  unit: "",
});

// --- HICP euro-area inflation Δ6m (estr-hike-side-leg R5, 2026-10-03) -----------------------------
// Display-only CONTEXT card, rowless (ECISS precedent): the R4 T1-gate's inflation half, never scored into danger.
export const HICP: Indicator = withMultipliedThresholds({
  id: "HICP",
  label: "HICP Δ6m",
  longLabel: "Euro-area HICP y/y, 6-month change (pp)",
  series: HICP_SERIES, // FRED monthly index, transformed by `hicpDelta6m` before scoring
  channel: "CONTEXT",
  thresholds: { ...HICP_DESCRIPTOR.thresholds }, // level-only, HIGH
  cadence: "monthly",
  // Obs dated the reference month's 1st; Eurostat final lands ~M+1 day 17, so the newest stays ~80d before its successor.
  lagAfterDays: 90,
  unit: "",
});

// --- R6 MOVE bond-market vol confirmer (T1.1, 2026-07-01) -------------------
//
// ICE BofAML MOVE Index — the "bond-market VIX". Risk-parity funds
// mechanically de-lever on MOVE spikes (VIX/MOVE corr ≈0.93 — ⚠ RETIRED 2026-07-26,
// do NOT re-derive R6 cuts or weights from R5's on it: `npm run probe:move-vix`
// measures Δ20 r 0.5163 / level r 0.5890 over 5,848 shared days, far below the 0.90
// same-factor line, so MOVE is a DISTINCT factor from VIX; see MEMBER_WEIGHT.R6's
// docblock in `src/danger-ladder.ts`),
// and the source rule is "don't re-enter equities until bond vol stabilizes" — so
// MOVE must CONFIRM, not lead. The id feeds the
// T1 dial's rates family via GLOBAL_FAMILIES (reassigned volatility→rates at the
// Stage-1.2 taxonomy merge), where the family worst-of keeps the confirm-don't-lead
// intent. `confirmer: true` documents that intent (COINCIDENT had no base/confirmer
// split). Fetched via its OWN feed (`fetchDailyCloses("^MOVE")`, keyless
// an index, prices.ts), NOT the FRED loop,
// so it is NOT in INDICATORS. Level-only HIGH; the MOVE-native regime map (~80 calm /
// ~120 stress / ~150+ crisis) is the DESCRIPTIVE prior the bands were first set from —
// the shipped cuts are now a deliberate ruling below it (see `thresholds`). ⚠ That published
// scale is also WHY R6 carries no percentile level leg: a trailing-window percentile measures
// "unusual for this window", which on a series that HAS an absolute scale is the weaker read —
// twice measured, twice deleted (2026-08-31, 2026-09-02). See `R6_DESCRIPTOR`'s docblock.
export const R6: Indicator = withMultipliedThresholds({
  id: "R6",
  label: "MOVE",
  longLabel: "MOVE (bond-market vol)",
  series: "^MOVE", // fetched via fetchDailyCloses() (prices.ts), not a FRED id
  backfill: { years: SEMIS_BACKFILL_YEARS }, // Semis top-10 seat
  channel: "COINCIDENT",
  // R6 is PER-LEG only (2026-08-19 rates band-driving split): it can no longer select or floor a band.
  // Level-only HIGH. `scoreMoveLevel` ORs this pair with `R6_DESCRIPTOR`'s VELOCITY leg — and with
  // NOTHING ELSE since 2026-09-02, when the last percentile level leg was deleted (L1 detrend → N1
  // raw-level 2026-08-31, N1 deleted the following ruling). So THIS PAIR IS NOW R6's ONLY LEVEL READ:
  // a MOVE between the two cuts is AMBER on level and nothing else can reach that rung from below.
  // The static z-leg is RETIRED (no `CALIB_MAP` row).
  // provenance: docs/indicator-cut-provenance.md §R6.
  thresholds: { amberLevel: 105, redLevel: 130 }, // MOVE-native regime map ([USER] 2026-08-30)
  confirmer: true,
  unit: "",
});

// CCC & lower US HY OAS — level + Δ20 (pp), AMBER = either leg, RED = level AND Δ20 (`FOLD_POLICY.CCC`); provenance §CCC.
// Seated cr on all nine legs, per-leg only (PER_LEG_ONLY_MEMBERS): never BAND_DRIVING, never the dial's `legP`.
export const CCC: Indicator = withMultipliedThresholds({
  id: "CCC",
  label: "CCC OAS",
  longLabel: "ICE BofA CCC & lower US HY OAS (FRED BAMLH0A3HYC)",
  series: "BAMLH0A3HYC",
  channel: "GLOBAL",
  thresholds: { amberLevel: 9.0, redLevel: 9.2, amberVelocity: 0.5, redVelocity: 0.7 },
  provisional: true,
  unit: "%",
});

// EU2 (SovCISS France, euro sovereign stress) REMOVED 2026-09-05 `[USER]`: the indicator, its
// `EU2_DESCRIPTOR` cuts, the ECB `CISS` series key, the backfill job, the drift fixture and the
// `probe:eu2-marginal` script are all gone. It had been band-inert since 2026-08-15 and its
// marginal-firing probe failed its bar (`docs/reference.md` §EU2).

/**
 * Genuinely SCORED ids that are band-inert: no panel-family seat and no `MEMBER_WEIGHT` row, so they
 * contribute nothing to any band and their blindness cannot pin one — `verdictHoldLegs`
 * (alert-band.ts) excludes them by the same W4-e vacuity argument as `PLACEHOLDER_STATE_IDS`, kept
 * separate because these are real `classify()` states, not placeholders. An id leaves this set in the
 * same commit that seats it (family roster + `MEMBER_WEIGHT` row).
 */
export const BAND_INERT_SCORED_IDS: ReadonlySet<string> = new Set<string>();
