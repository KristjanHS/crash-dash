/**
 * Exposure dial (slice E1): two-key posture engine — ARM (credit stress on
 * F1 HY OAS) + FIRE (GT's own scored band on the ACWI trend) → Full / Core / Reduced / Defensive,
 * each carrying an equity weight (`EQUITY_PCT`).
 * Pure and IO-free (the assembleRun-style testable core): inputs are exactly
 * what getSeries returns, oldest→newest. Wire DTO for /api/exposure in E1
 * Stage 2. Constants are PROVISIONAL — retuned by eye via E2 replays; tests
 * pin only the mechanics, never the tuning.
 */

import { percentileRank } from "./slow.js";
import { ARM_ROC_WINDOW } from "./registry-fred.js";
import { GT } from "./registry-composite.js";
import { resolvedDerivedBands, scoreDerivedDecision } from "./scorers-core.js";
import type { SeriesPoint } from "./store.js";
import type { NtfyMessage } from "./ntfy.js";

/** Trailing trading days (~2y) for the ARM level rank window. */
export const ARM_RANGE_WINDOW = 504;
/** The live exposure path's series bounds. Single-sourced HERE (the pure engine both callers
 *  already import) so the cron read + post-merge re-slice in `run-core.ts`'s `seedSeriesWithRun` and
 *  the `api/exposure.ts` read can never drift apart — the drift IS the bug the re-slice fixes.
 *  `EXPOSURE_F1_LIMIT` is the bound `scanArmLatch`'s docblock names for the live path; the +40
 *  pad covers publication-lag/holiday slack. GT depth 10: only the newest point drives FIRE. */
export const EXPOSURE_F1_LIMIT = ARM_RANGE_WINDOW + 40;
export const EXPOSURE_GT_LIMIT = 10;
/**
 * Armed when the latest F1 value's PERCENTILE RANK within the trailing range
 * window is ≥ this. 0.85 matches the house convention `SYNTH_AMBER_PCTILE`
 * ("85th percentile = elevated") that B2/B8 ship — one convention across the
 * whole engine.
 *
 * ⚠ This constant was NOT carried across from the previous min/max
 * range-position measure. Range position and rank are not interchangeable: on
 * a right-skewed series like HY OAS, a value 75% of the way up the min–max span
 * sits well ABOVE the 75th percentile, so holding 0.75 would have LOWERED the
 * effective threshold — measured at +45% armed days (758 → 1096) over the
 * `probe:arm-rank` episode set (probe retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it); the counts are historical measurements). At 0.85 the rank measure arms 912 days (+20%).
 * Compared like-for-like (rank cut 0.925, reproducing range-0.75's 758 days),
 * the two measures pick nearly the same days — A-only 24, B-only 25 of 758 — so
 * the cut, not the measure, is what moves the count.
 *
 * ⚠ **PRE-LATCH — SUPERSEDED. Every count in the paragraph above (758, 1096,
 * 912, and the 0.925 / A-only 24 / B-only 25 like-for-like line) was measured
 * against the RAW rule `rank >= cut || roc >= bp`, which production stopped
 * running once W5-b Stage 1.1 added `scanArmLatch`.** Post-latch, the
 * same probe over the same episodes reports: range@0.75 **880** armed days,
 * rank@0.75 **1182**, and rank@0.85 — this constant's shipped value —
 * **1150**, not 912. The like-for-like line is now UNREACHABLE, not merely
 * restated: no cut in [0, 1] reproduces 880 armed days (best 0.921 → 1112, off
 * by 232), because the latch floors the count. So the "+45% / +20%" framing and
 * the A-only/B-only comparison are both dead — do NOT quote them, and do not
 * "refresh" them by swapping in the new numbers, because the like-for-like
 * comparison they came from no longer exists. The CHOICE of 0.85 is unaffected
 * (it is the `SYNTH_AMBER_PCTILE` house convention, first paragraph); only the
 * supporting measurement is void; a cut ruling is pending.
 *
 * ⚠ **STALE AS OF THE 2026-07-31 RELEASE TIGHTEN — the RANK-ARM counts only.** Every
 * rank-arm number in the paragraph above was measured with `ARM_RELEASE_PCT = 0.60`;
 * production now runs **0.80**, and a
 * tighter release cut shortens every latched run, so all three move DOWN. Specifically:
 *   - **rank@0.85 `1150` is SUPERSEDED by the measured `984`** — the tighten's own
 *     six-episode figure, which is why this file states 984 for the shipped configuration
 *     further down. Read 984, never 1150.
 *   - **post-latch rank@0.75 is `1096`, and the like-for-like best cut is `0.957 → 916, off by 36`** —
 *     re-measured 2026-08-09 post-tighten, superseding the pre-tighten `1182` / `0.921 → 1112`. (The
 *     `1096` at the top of this docblock is a DIFFERENT quantity: the pre-latch raw-rule count.)
 *   - **`880` (range@0.75) is the EXCEPTION and is still CORRECT — do NOT "refresh" it.**
 *     That is arm A, whose latch release cut is the FROZEN in-probe literal
 *     `ARM_A_RELEASE_PCT = 0.6` in `scripts/probe-arm-rank.ts` (retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it); a control arm must never
 *     import a constant the change under test moves). Production's tighten therefore cannot
 *     move arm A's count, by construction. A sweep that "updates 880 for consistency" would
 *     be re-basing the banked counterfactual — exactly the collapse the freeze prevents.
 * The paragraph above is kept, not rewritten — but its MAGNITUDE claim did NOT survive the tighten: the
 * miss narrowed from 232 days (26% of 880) to 36 (4%). UNREACHABLE still holds literally (the probe prints
 * "NO cut in [0, 1] reaches 880"), so the like-for-like read stays void — but on a narrow floor, not a wide
 * one. Do not quote "the latch floors the count" as a large effect.
 * @internal
 */
export const ARM_LEVEL_PCT = 0.85;
/**
 * ARM RELEASE cut — the latch's lower edge. Once armed, ARM stays on while the F1
 * rank holds at or above this, and releases only below it: **the deadband is
 * `ARM_LEVEL_PCT` 0.85 → 0.80.** The latch can only ADD armed days, never remove
 * one the raw rule produced, so its direction is unconditionally more-conservative
 * — which is the whole steer ("more conservative, earlier warnings").
 *
 * Precedent: the M4/M8 asymmetric re-risk deadband (`RERISK_DEADBAND`,
 * `danger-engine.ts`) that the design already calls SOUND. Still asymmetric — `DERISK_DEADBAND` is
 * `0` — but note it was HALVED on 2026-08-07 (`DANGER_CUTS.amber` → `DANGER_CUTS.amber / 2`),
 * and the re-risk TIMING gates beside it were retired
 * outright. So the precedent survives only for the DEADBAND shape, not for the confirm/dwell
 * clocks — which is consistent with the armed-DWELL rejection below, not undercut by it.
 *
 * ⚠ A minimum armed-DWELL (stay armed N days regardless of rank) was considered and
 * **REJECTED** — N would have to be read off the measured 2022 replay gaps, i.e. a
 * fitted constant, and the steer forbids inventing them. The K4 source text predates
 * the amendment that rejects it; do NOT rebuild the dwell from it.
 * ⚠ **No 2022 gap length was measured to pick 0.80** — it is a USER-DECIDED round
 * number, exactly as the 0.60 it superseded was. The 2022 ARM continuity is recorded as
 * an OBSERVATION, not a target: if it disagrees, surface the disagreement rather than
 * retuning this constant.
 *
 * Ruled 2026-07-31: 0.60 → 0.80. The
 * complaint the tighten answers is armed DWELL, not onset — the six-episode set measures
 * −166 armed days (1150 → 984) with the six first-armed dates UNCHANGED, since tightening
 * the lower edge can neither delay onset (every armed run starts on a raw-rule day) nor
 * advance it. 0.80 is a round number in the measured direction, NOT a fitted optimum; the
 * house rule against fitting a constant to the six episodes is unchanged.
 * @internal
 */
export const ARM_RELEASE_PCT = 0.8;
/** Trading days (~6w) for the ARM widening rate-of-change — defined in `registry-fred.ts` (re-exported here), shared with F1's `velocityWindow`. */
export { ARM_ROC_WINDOW };
/** Armed when value[last] − value[last−30] ≥ this (F1 value is OAS in %, so 0.50 = +50bp). @internal */
export const ARM_ROC_BP = 0.5;
/** Approaching (pre-alert) when not armed but the 30d ROC is already ≥ this (+28bp). @internal */
export const ARM_ROC_APPROACH_BP = 0.28;
/**
 * Approaching (pre-alert) when not fired but the maSpread cushion is within this much of
 * GT's RESOLVED amber cut (`fireApproachCut`). It was an absolute "+4% above MA200" while
 * FIRE carried its own `maSpread <= 0`; since FIRE consumes GT's band (CORE-B4) the fire
 * edge is GT's amber, so the pre-alert rides 4pp above THAT — same 4pp of cushion, measured
 * from the cut that now fires. Left absolute it would be dead code: today's resolved amber
 * (0.059) sits ABOVE 0.04, so every maSpread ≤ 0.04 already fires.
 * @internal
 */
export const FIRE_MA_APPROACH_SPREAD = 0.04;
/**
 * Below this many F1 points the ARM key is degraded; past the floor the rank is
 * taken over whatever the available window holds.
 *
 * Stays at 252 deliberately. CORE-B5 proposed raising it to 504 to match
 * `ARM_RANGE_WINDOW`, but that was a workaround for the old RANGE measure,
 * where a short window meant min/max were computed over a different span than
 * the constant advertised. A rank over a trailing window shorter than 504 is
 * still a valid rank of the available window, so the rule-swap that finding
 * objected to dissolves rather than needing the floor raised.
 * @internal
 */
export const ARM_MIN_OBS = 252;

/**
 * The ARM/FIRE cut values as they ride the `/api/exposure` wire (R1 footnotes).
 *
 * ⚠ Seam ruling (USER, 2026-07-26): the numbers the `/exposure` chips print are SERVED,
 * never retyped in `public/`. The front-end formats what arrives here and holds no numeric
 * copy of any cut, so a retune of the constants above moves the on-screen footnote with it
 * — the drift class `armMetricsAt`'s docblock records (a rule swap left `openapi.yaml` and
 * `public/` describing the old measure) cannot recur through this path.
 */
export interface ExposureThresholds {
  /** `ARM_LEVEL_PCT` — rank cut that arms. */
  armLevelPct: number;
  /** `ARM_RANGE_WINDOW` — trading days the rank is taken over. */
  armRangeWindow: number;
  /** `ARM_ROC_BP` — widening cut that arms (OAS points; 0.50 = +50bp). */
  armRocBp: number;
  /** `ARM_ROC_WINDOW` — trading days the widening is measured over. */
  armRocWindow: number;
  /** `ARM_RELEASE_PCT` — the latch's lower edge. */
  armReleasePct: number;
  /** `ARM_ROC_APPROACH_BP` — the ARM pre-alert cut. */
  armRocApproachBp: number;
  /** `FIRE_MA_APPROACH_SPREAD` — pre-alert cushion ABOVE GT's resolved amber cut. */
  fireMaApproachSpread: number;
}

/** The one served copy of the cuts above — assembled HERE, beside the constants it names. */
export const EXPOSURE_THRESHOLDS: ExposureThresholds = {
  armLevelPct: ARM_LEVEL_PCT,
  armRangeWindow: ARM_RANGE_WINDOW,
  armRocBp: ARM_ROC_BP,
  armRocWindow: ARM_ROC_WINDOW,
  armReleasePct: ARM_RELEASE_PCT,
  armRocApproachBp: ARM_ROC_APPROACH_BP,
  fireMaApproachSpread: FIRE_MA_APPROACH_SPREAD,
};

export type Posture = "Full" | "Core" | "Reduced" | "Defensive";

/**
 * Equity weight per posture. All four values are `[USER DECIDED]` (W5-b K5) — none is
 * fitted to a replay, and none may be re-derived from one.
 *
 * `Full` is the addition that delivers "earlier": before K5 the lowest-risk state WAS
 * `Core`, and a key merely `approaching` emitted only a low-priority heads-up with equity
 * unchanged. Now `approaching` is a real 100% -> 70% de-risk step, bought with no new cut
 * and no new signal — it reuses the already-shipped `ArmKey.approaching` / `FireKey.approaching`.
 *
 * At `Defensive` the non-equity 85% is bond-rung-primary (D6 as amended by D-E2), NOT cash.
 * Anything rendering `100 - equityPct` as a CASH number is a false number on a
 * notify-visible surface.
 * @internal
 */
export const EQUITY_PCT: Record<Posture, number> = {
  Full: 100,
  Core: 70,
  Reduced: 40,
  Defensive: 15,
};

/**
 * The compound-risk metric (R8): the two axes of the system — the exposure POSTURE (how much
 * equity) and the rotation LADDER RUNG (how risky the held leg) — are independent and both
 * compound, so the state actually carried is their product.
 *
 * `effectiveEquityRisk = equityPct × (10 − riskRank) / 9`, where `riskRank` is the held sleeve's
 * 1..9 `risk` rank (`LEG_FIELD` in `danger-ladder.ts`, == `LADDER` index + 1): rung 1 (Semis)
 * keeps the full weight, rung 9 (Staples) keeps 1/9 of it.
 *
 * ⚠ The linear rank→risk map is a STATED MODELLING CHOICE, not a measurement. The ladder's rank
 * is ORDINAL; mapping it linearly onto a risk weight introduces no free parameter and needs no
 * compute, which is exactly why it was chosen — but it is not evidence about relative leg risk.
 * Say so wherever the number is rendered or documented, and do not "validate" it against returns
 * without a plan.
 * @internal
 */
export function effectiveEquityRisk(equityPct: number, riskRank: number): number {
  return (equityPct * (10 - riskRank)) / 9;
}

/**
 * The floor on `effectiveEquityRisk` — the minimum compounded risk a SERVED posture × held-rung
 * pair may carry. Below it the pair is over-de-risked (idle-cash drag against the ACWI benchmark),
 * so `resolveCompoundFloor` relaxes the posture until the product clears.
 *
 * ⚠ **[USER DECIDED], not fitted and not measured.** There is no historical posture × rung
 * occupancy series to fit against: `/api/replay` runs `replayExposure`, which is the POSTURE axis
 * only (F1 + FIRE, no dial rung), so a joint series would require the backtest the USER ruled out.
 * The value was chosen by judgement over the reachable state space (4 postures × 9 rungs = 36
 * cells; it blocks 8 of them, leaving `Defensive` reachable at rungs 1–4). It must never be
 * described as measured, and anyone proposing to move it owes that backtest first.
 *
 * ⚠ The comparison is **INCLUSIVE** (`score >= COMPOUND_RISK_FLOOR`). `Defensive` × rung 4 scores
 * exactly 10.0; an exclusive `>` would block it and silently cut `Defensive`'s reach from rungs
 * 1–4 to 1–3. The boundary cell is pinned separately in `exposure.test.ts`.
 *
 * ⚠ **There is NO free posture×rung occupancy series** — `/api/replay` runs `replayExposure`, the posture
 * axis only. `COMPOUND_RISK_FLOOR` is a judgement call; never re-describe it as measured.
 * @internal
 */
export const COMPOUND_RISK_FLOOR = 10;

/**
 * The relaxation order when the floor binds: posture is the YIELDING axis, stepping UP one tier at
 * a time. The rung axis keeps its danger-driven answer untouched — the dial's leg pick is the read
 * with direct market evidence behind it, and relaxing posture is the direction that fights idle
 * cash against the ACWI benchmark.
 * @internal
 */
export const POSTURE_RELAX_ORDER = ["Defensive", "Reduced", "Core", "Full"] as const;

/** What the floor resolved to, for one (posture, held rung) pair. */
export interface BoundedPosture {
  /** The posture actually served/held — the raw one, or a relaxed tier when the floor bound. */
  posture: Posture | null;
  /** `EQUITY_PCT[posture]`, null in exactly the case `posture` is null. */
  equityPct: number | null;
  /** `effectiveEquityRisk` of the RETURNED posture; null when the pair is rung-blind or degraded. */
  score: number | null;
  /** True iff the floor moved the posture off its raw value. */
  floorApplied: boolean;
}

/**
 * The ONE resolver both surfaces call (`api/exposure.ts` and the run path in `run-core.ts`) —
 * deliberately NOT folded into `computeExposure`, which is pure and rung-blind and has no business
 * knowing the ladder. Both call sites or neither: if only the run path bounded, `/api/exposure`
 * would serve an unbounded posture while the push reported a bounded one, which is the same
 * two-surface disagreement this mechanism exists to end.
 *
 * `riskRank` null (no dial / no persisted held sleeve / an unknown sleeve name) is rung-BLIND, not
 * a rung-0 fabrication: the raw posture passes through untouched. `posture` null (degraded ARM/FIRE
 * input) propagates as null rather than fabricating a weight.
 *
 * Termination is a property OF `COMPOUND_RISK_FLOOR`'s value, not of this loop — at 10 every cell
 * clears at or before `Full` (worst chain `Defensive × r9` 1.7 → 4.4 → 7.8 → 11.1). A floor above
 * 11.1 would leave `Full × r9` unresolvable with nowhere to step; the termination pin in
 * `exposure.test.ts` reds instead of shipping that state, which is why the exhausted loop below
 * returns the most-permissive posture rather than inventing a tier.
 */
export function resolveCompoundFloor(posture: Posture | null, riskRank: number | null): BoundedPosture {
  if (posture === null) return { posture: null, equityPct: null, score: null, floorApplied: false };
  if (riskRank === null) return { posture, equityPct: EQUITY_PCT[posture], score: null, floorApplied: false };
  const start = POSTURE_RELAX_ORDER.indexOf(posture);
  for (let i = start; i < POSTURE_RELAX_ORDER.length; i++) {
    const step = POSTURE_RELAX_ORDER[i]!;
    const score = effectiveEquityRisk(EQUITY_PCT[step], riskRank);
    if (score >= COMPOUND_RISK_FLOOR) {
      return { posture: step, equityPct: EQUITY_PCT[step], score, floorApplied: i > start };
    }
  }
  const top = POSTURE_RELAX_ORDER[POSTURE_RELAX_ORDER.length - 1]!;
  return {
    posture: top,
    equityPct: EQUITY_PCT[top],
    score: effectiveEquityRisk(EQUITY_PCT[top], riskRank),
    floorApplied: top !== posture,
  };
}

/** What the overlay step-down resolved to, for one (floor-resolved posture, published cash) pair. */
export interface SteppedPosture {
  /** The posture actually served/held after the step-down. */
  posture: Posture | null;
  /** `EQUITY_PCT[posture]`, null in exactly the case `posture` is null. */
  equityPct: number | null;
  /** True iff the overlay moved the posture off the floor-resolved one. */
  steppedDown: boolean;
}

/**
 * R8 Stage 2 — the OVERLAY STEP-DOWN, the second of the two mechanisms that move a served posture.
 * Ruled 2026-07-31.
 *
 * The defect it repairs, and its WHOLE extent: `resolveCash` sizes a published `partial` as
 * `standing = 100 − equityPct`, which at `Full` is **zero** — the level says hold cash back, the
 * number holds nothing back. So when the published level is `partial` and the standing would be 0,
 * posture yields one tier and the claim gains real size.
 *
 * ⚠ **Deliberately inert below `Full`.** A `partial` at `Core`/`Reduced`/`Defensive` already has a
 * non-zero standing, so this returns the posture untouched there. That is the NARROW ruled reading —
 * the broad one ("a fired overlay always moves the position") was offered and DECLINED. It is not a
 * bug and must not be "fixed" into an unconditional step-down: unconditional would breach the
 * compound floor in five cells instead of one.
 *
 * ⚠ **`Defensive` needs no guard.** Its standing is 85, never 0, so it never steps down and never
 * needs a tier below the bottom of `POSTURE_RELAX_ORDER`. Do not add one.
 *
 * ⚠ **ORDER: the floor resolves FIRST** (`resolveCompoundFloor`), and this runs on its output.
 * ⚠ **The result is NOT re-clamped by the floor.** In exactly one bounded cell — `Full × r9` → `Core
 * × r9` = 7.8 — the step-down breaches `COMPOUND_RISK_FLOOR` by 2.2 and **the breach stands**. That
 * is the ruled resolution of the two mechanisms' conflict, pinned in `exposure.test.ts`; re-clamping
 * it would restore the zero-size `partial` this exists to remove (floor-last is unsatisfiable
 * against that pin).
 *
 * ⚠ **DEC-1 stays cut.** The path is trigger → posture → size, one direction only: the caller feeds
 * this the level `resolveCash` already published, and nothing here reaches `computeCashOverlay`'s
 * trigger. `CashOverlayResult.nonEquityPct` remains vestigially `null`.
 *
 * Keying on `100 − EQUITY_PCT[posture] === 0` rather than on the name `Full` is deliberate: it is
 * the same expression `resolveCash` sizes the claim with, so a retune of `EQUITY_PCT` moves the
 * trigger and the defect together instead of leaving a hardcoded posture name behind.
 *
 * Both surfaces or neither — `api/exposure.ts` (via `applyOverlayStepDown`) and the run path in
 * `run-core.ts` call this off the same published level, or they disagree on the same close.
 */
export function resolveOverlayStepDown(
  posture: Posture | null,
  publishedCashLevel: "off" | "partial" | "full",
): SteppedPosture {
  const equityPct = posture === null ? null : EQUITY_PCT[posture];
  if (posture === null || publishedCashLevel !== "partial") return { posture, equityPct, steppedDown: false };
  if (100 - EQUITY_PCT[posture] !== 0) return { posture, equityPct, steppedDown: false };
  // Only a 100%-equity posture reaches here, and `POSTURE_RELAX_ORDER` is ordered least→most
  // permissive, so its predecessor always exists — one tier DOWN is the mirror of the floor's one
  // tier UP, off the SAME order, so the two mechanisms can never disagree about what a tier is.
  const stepped = POSTURE_RELAX_ORDER[POSTURE_RELAX_ORDER.indexOf(posture) - 1]!;
  return { posture: stepped, equityPct: EQUITY_PCT[stepped], steppedDown: true };
}

interface ArmKey {
  armed: boolean;
  /** Pre-alert tier: not armed, but ROC ≥ ARM_ROC_APPROACH_BP. Always false when armed or degraded. */
  approaching: boolean;
  degraded: boolean;
  level: number | null;
  percentile: number | null;
  roc: number | null;
  asOf: string | null;
}

interface FireKey {
  fired: boolean;
  /** Pre-alert tier: not fired, but maSpread ≤ `fireApproachCut()`. Always false when fired or degraded. */
  approaching: boolean;
  degraded: boolean;
  maSpread: number | null;
  asOf: string | null;
}

/**
 * The subset of a close's exposure the push comparator READS on the PRIOR side. `ExposureResult` is
 * structurally assignable to it, and so is the persisted `ExposurePushState` — which is the point:
 * the prior side is what the LAST RUN observed, read back off its alert row, never a live
 * re-derivation off today's series (see `decideExposureNotify`).
 */
export interface ExposurePrior {
  posture: Posture | null;
  arm: { armed: boolean; approaching: boolean };
  fire: { fired: boolean; approaching: boolean };
}

/**
 * The exposure push's persisted dedup axis — one per run, stamped onto the alert row BEFORE the
 * atomic write (`alert_log.tier_state.exposure_state`) and read back by the NEXT run as its `prev`.
 * Carried forward unchanged on a degraded run, so an outage cannot reset the baseline.
 *
 * BOTH postures are stored, plus the blindness flag, because the comparator's axis is chosen by the
 * PAIR: the bounded posture is the served variable (R8 Stage 2.2) but binding is only possible on a
 * run whose row carries a rung, and comparing a bounded side against an unbounded one manufactures a
 * transition out of nothing. Storing the raw posture beside the bounded one lets a later run drop
 * BOTH sides back to the raw axis when either run was rung-blind (`exposurePushPair`, run-cycle.ts).
 */
export interface ExposurePushState extends ExposurePrior {
  /** The BOUNDED posture (floor → overlay step-down) — the variable `/api/exposure` serves. */
  posture: Posture;
  /** The same close's UNBOUNDED posture, always — the fallback axis when either side is blind. */
  rawPosture: Posture;
  /** True when this run's row carried no rung, so `posture` is the raw one by identity. */
  rungBlind: boolean;
}

/**
 * Project a close's bound + raw results into the state the next run compares against. Null when
 * either posture is degraded — there is nothing to compare, and the caller carries the prior state
 * forward rather than writing a hole into the baseline.
 */
export function exposurePushState(
  bound: ExposureResult,
  raw: ExposureResult,
  rungBlind: boolean,
): ExposurePushState | null {
  if (bound.posture === null || raw.posture === null) return null;
  return {
    posture: bound.posture,
    rawPosture: raw.posture,
    rungBlind,
    // The two keys are axis-INDEPENDENT: binding moves the posture, never the latch/approach flags,
    // so one copy serves both axes.
    arm: { armed: raw.arm.armed, approaching: raw.arm.approaching },
    fire: { fired: raw.fire.fired, approaching: raw.fire.approaching },
  };
}

export interface ExposureResult {
  posture: Posture | null; // null = degraded input ("insufficient data") — never a fabricated Core
  /** `EQUITY_PCT[posture]`, and `null` in exactly the same case `posture` is null. */
  equityPct: number | null;
  arm: ArmKey;
  fire: FireKey;
  summary: string; // one-sentence behavioral contract, e.g. "credit calm (34th pct, +2bp/30d); trend clear of GT's cut -> Full (100% equity)" — the ROC window in it is interpolated from ARM_ROC_WINDOW (see `summarize`), not typed
}

/**
 * The ARM level rank + 30d ROC as they stood at index `i` of `f1` (oldest→newest),
 * over the trailing windows ending THERE. Extracted so the latch scan can evaluate
 * prior closes without re-entering `computeArm` (which would need a slice per step).
 */
function armMetricsAt(f1: SeriesPoint[], i: number): { percentile: number | null; roc: number | null } {
  // armRankPercentile: the fraction of the trailing window at or below the value at
  // `i`. `ArmKey.percentile` means what its name says — the old
  // (latest − min) / (max − min) was a position in an absolute span, not a
  // percentile, and let a single 2020 outlier pin `max` for two years and
  // suppress arming (CORE-B5).
  const at = f1[i];
  // Type guard only — `noUncheckedIndexedAccess` types this `| undefined`. Both callers
  // pass an in-range index (computeArm guards `last`; the scan stays within [floor, n]),
  // so this branch is not reachable in practice; it is not a behavioural fallback.
  if (!at) return { percentile: null, roc: null };
  const window = f1.slice(Math.max(0, i + 1 - ARM_RANGE_WINDOW), i + 1);
  const sorted = window.map((p) => p.value).sort((a, b) => a - b);
  // A rank IS defined on a zero-variance window (every value ≤ x ⇒ 1.0), so the
  // null here is NOT a math guard — it is deliberate. A perfectly flat F1
  // window is a lagging-feed tell, and arming at rank 1.0 on non-data would be
  // the fabricated-danger mirror of CORE-B7. Degrade quietly instead.
  // ⚠ CHANGING THIS MEASURE OBLIGES A PROSE SWEEP OF `openapi.yaml` AND `public/`.
  // `openapi-drift.test.ts` pins the ROUTE TABLE (paths ⇄ handlers ⇄ rewrites ⇄ preview mock) plus
  // chart-spec `fromPoint` fields — never payload shape, never descriptions (2026-08-01: "pins
  // SHAPE" here was itself an unchecked coverage claim; shape lives in `src/api/contract.test.ts`,
  // and even there the harness compares KEY sets). So the swap from
  // position-in-range to this rank left the published contract and the
  // live /lab chip both describing the old measure — the chip said "flat range"
  // against this file's "flat window", and `exposure-view.test.js` test-locked the
  // stale string. Nothing failed; the review caught it.
  const flat = sorted.length > 0 && sorted[0] === sorted[sorted.length - 1];
  const percentile = sorted.length > 0 && !flat ? percentileRank(sorted, at.value) : null;
  const rocBase = f1[i - ARM_ROC_WINDOW];
  const roc = rocBase ? at.value - rocBase.value : null;
  return { percentile, roc };
}

/** Today's un-latched rule, unchanged: the slow grind-up OR the fast turn. */
function isRawArmed(percentile: number | null, roc: number | null): boolean {
  return (percentile !== null && percentile >= ARM_LEVEL_PCT) || (roc !== null && roc >= ARM_ROC_BP);
}

/**
 * K4 hysteresis, in the UNROLLED form. The recurrence is
 * `armed_i = raw_i || (armed_{i-1} && pct_i >= ARM_RELEASE_PCT)`, which unrolls to:
 * ARM is on at the newest close **iff** some j ≤ n has `raw_j` true and every close
 * in (j, n] holds ≥ `ARM_RELEASE_PCT`. So scan BACKWARD while the hold survives and
 * report whether `raw` was ever true in that run.
 *
 * ⚠ Do NOT "simplify" this back to the forward pass the recurrence literally states.
 * `replayExposure` calls `computeExposure` once per trading day and `/api/replay`
 * replays all six EPISODES (~2,000 days) in one request; a forward pass would re-rank
 * ~293 windows per day ≈ 10^9 operations in a single Vercel request.
 *
 * ⚠ COST IS AVERAGE-CASE, NOT WORST-CASE — the original cost argument
 * understated this and
 * the docblock that shipped with it asserted the average as if it were a bound. Typical
 * closes exit at step 1 (either raw-armed, or below the release cut), so the everyday cost
 * is ~2 rank computations — but "~80% of closes sit below 0.80" holds only under
 * exchangeability, which fails precisely during a sustained credit-stress plateau, i.e. the
 * regime the latch exists to serve. A run sitting inside the [0.80, 0.85) deadband never
 * raw-arms and never releases, so the scan walks its full depth and re-sorts a 504-point
 * window at every step. Depth is bounded by the supplied slice (534 − ARM_MIN_OBS ≈ 282
 * steps under `replayExposure`'s bound) — that structural bound still holds, but it is not
 * reached in practice: measured 2026-07-20, the WHOLE six-episode `/api/replay` request
 * (~2,000 days) runs ~1650–1700 ms cold, well under the ~3 s trip point, and the per-index
 * rank memo was deliberately DECLINED at that measurement. That measurement was taken at the
 * PRE-2026-07-31 release cut 0.60, and it stays a valid upper bound: raising the cut can only
 * terminate a scan earlier (a close in [0.60, 0.80) used to hold the latch and now breaks it),
 * and the deadband it must walk narrowed from 0.25 wide to 0.05. Re-measure before any change
 * that lengthens the deadband regime. If it does start to bite, memoize the per-index rank (the
 * windows of consecutive indices overlap by 503 of 504 points) — do NOT bound the depth,
 * which would silently change the latch's semantics.
 *
 * ⚠ Boundary: a latch older than the supplied slice degrades to `raw` — it UNDER-arms,
 * never over-arms. All three call sites bound the slice deliberately: `EXPOSURE_F1_LIMIT`
 * on the live path (`run-cycle-exposure.ts`, `api/exposure.ts` — both import it from this module, so the
 * two can never disagree) and `ARM_RANGE_WINDOW + ARM_ROC_WINDOW` in `replayExposure`.
 */
function scanArmLatch(f1: SeriesPoint[], head: { percentile: number | null; roc: number | null }): boolean {
  const floor = ARM_MIN_OBS - 1; // indices below this are not evaluable — the latch seeds false
  let metrics = head;
  let i = f1.length - 1;
  while (i >= floor) {
    if (isRawArmed(metrics.percentile, metrics.roc)) return true;
    // The latch carries back past close i only if i itself holds the release cut.
    // A flat window yields `percentile === null` ⇒ no hold ⇒ the latch breaks. That is
    // deliberate and matches the head's refusal to arm at rank 1.0 on a flat window:
    // a perfectly flat F1 window is a lagging-feed tell, not data.
    if (metrics.percentile === null || metrics.percentile < ARM_RELEASE_PCT) return false;
    i -= 1;
    if (i < floor) return false;
    metrics = armMetricsAt(f1, i);
  }
  return false;
}

function computeArm(f1: SeriesPoint[]): ArmKey {
  const last = f1[f1.length - 1];
  if (!last || f1.length < ARM_MIN_OBS) {
    return {
      armed: false,
      approaching: false,
      degraded: true,
      level: last?.value ?? null,
      percentile: null,
      roc: null,
      asOf: last?.date ?? null,
    };
  }
  const { percentile, roc } = armMetricsAt(f1, f1.length - 1);
  // K4: `armed` is the LATCHED value, not the raw rule — see scanArmLatch. The head
  // metrics are passed in so the common case (raw already true, or today below the
  // release cut) costs the one rank computation it always did.
  const armed = scanArmLatch(f1, { percentile, roc });
  return {
    armed,
    approaching: !armed && roc !== null && roc >= ARM_ROC_APPROACH_BP,
    degraded: false,
    level: last.value,
    percentile,
    roc,
    asOf: last.date,
  };
}

/**
 * The pre-alert edge: `FIRE_MA_APPROACH_SPREAD` of cushion ABOVE GT's resolved amber cut.
 * Derived, never a literal, so a GT retune moves the fire edge and its pre-alert together.
 * The `?? 0` is type-only: `GT_AMBER` is a numeric constant and `resolveBands` nulls only a null constant.
 *
 * ⚠ **FIRE no longer tests `maSpread <= 0`** — it scores through GT's resolved band
 * (`scoreDerivedDecision(GT, maSpread) !== "GREEN"`), so de-risking begins on the cushion ABOVE MA200
 * and the 4pp pre-alert is RELATIVE to GT's amber (`fireApproachCut()`). Never "restore" the ≤0 form;
 * dark GT ⇒ degraded, never a silent GREEN.
 */
function fireApproachCut(): number {
  return (resolvedDerivedBands(GT).amber ?? 0) + FIRE_MA_APPROACH_SPREAD;
}

function computeFire(gt: SeriesPoint[]): FireKey {
  const last = gt[gt.length - 1];
  const maSpread = last?.decision ?? null; // GT's persisted decision IS the maSpread
  // DARK-GT CHOICE: an absent series or a null decision is DEGRADED, never a silent GREEN
  // "trend intact" — the same treatment computeArm gives a short F1 window, and it propagates
  // to `posture: null` ("insufficient data"), which decideExposureNotify keeps silent rather
  // than pushing a fabricated all-clear. Guarded HERE because scoreDerivedDecision maps a null
  // decision to GREEN.
  if (!last || maSpread === null) {
    return { fired: false, approaching: false, degraded: true, maSpread: null, asOf: last?.date ?? null };
  }
  // CORE-B4: FIRE consumes GT's RESOLVED band — the verdict the GT card itself renders —
  // instead of its own `maSpread <= 0`. Both GT cuts are positive since the 2026-07-29 retune,
  // so an AMBER card can no longer coexist with "Full 100% equity": de-risking begins on the
  // cushion above MA200, not at the break. Any non-GREEN band fires.
  const fired = scoreDerivedDecision(GT, maSpread) !== "GREEN";
  return {
    fired,
    approaching: !fired && maSpread <= fireApproachCut(),
    degraded: false,
    maSpread,
    asOf: last.date,
  };
}

/** 1 → "1st", 92 → "92nd", 11–13 → "th" — pushes/pages print percentiles as ordinals. */
function ordinal(n: number): string {
  const t = n % 10, h = n % 100;
  return `${n}${t === 1 && h !== 11 ? "st" : t === 2 && h !== 12 ? "nd" : t === 3 && h !== 13 ? "rd" : "th"}`;
}

/** `rocText` overrides the ROC slot verbatim (`withholdExposureStats`'s "—"); absent ⇒ rendered off `arm.roc`. */
function summarize(arm: ArmKey, fire: FireKey, posture: Posture | null, rocText?: string): string {
  let credit: string;
  if (arm.degraded) {
    credit = "credit data insufficient";
  } else {
    const pct = arm.percentile === null ? "flat window" : `${ordinal(Math.round(arm.percentile * 100))} pct`;
    const roc =
      // The window is INTERPOLATED from `ARM_ROC_WINDOW`, never typed — this string reaches the
      // page and the push, so a retune of the constant must move it too (review finding 2026-07-31;
      // it read `bp/30d` while the same constant was already on the wire as `armRocWindow`).
      rocText !== undefined
        ? rocText
        : arm.roc === null
          ? "ROC n/a"
          : `${arm.roc >= 0 ? "+" : ""}${Math.round(arm.roc * 100)}bp/${ARM_ROC_WINDOW}d`;
    credit = `${arm.armed ? "credit stressed" : "credit calm"} (${pct}, ${roc})`;
  }
  // Wording tracks the RULE: FIRE is GT's band now, and GT's amber sits above MA200, so
  // "above MA200" would read true on a fired day. Name the cut, don't restate a condition.
  const trend = fire.degraded
    ? "trend data missing"
    : fire.fired
      ? "trend below GT's cut"
      : "trend clear of GT's cut";
  const target = posture === null ? "insufficient data" : `${posture} (${EQUITY_PCT[posture]}% equity)`;
  return `${credit}; ${trend} -> ${target}`;
}

export function computeExposure(f1: SeriesPoint[], gt: SeriesPoint[]): ExposureResult {
  const arm = computeArm(f1);
  const fire = computeFire(gt);
  const keys = (arm.armed ? 1 : 0) + (fire.fired ? 1 : 0);
  // Keys→posture (W5-b K5). The Full/Core split is the ONLY use of `approaching` here:
  // with neither key tripped, a key merely approaching costs the 100→70 step.
  const posture: Posture | null =
    arm.degraded || fire.degraded
      ? null
      : keys === 2
        ? "Defensive"
        : keys === 1
          ? "Reduced"
          : arm.approaching || fire.approaching
            ? "Core"
            : "Full";
  return {
    posture,
    equityPct: posture === null ? null : EQUITY_PCT[posture],
    arm,
    fire,
    summary: summarize(arm, fire, posture),
  };
}

/**
 * The redacted `/exposure` view of a served result (3.5b, ruled 2026-11-25): the F1 30d change is a statistic
 * over ONE licensed input, so `arm.roc` nulls and `summary` re-renders against the SAME posture with its ROC
 * slot "—" (the rest of the sentence — percentile rank, trend, posture — is unchanged). `fire.maSpread` nulls
 * too: it is GT's persisted decision — ACWI's distance from its MA200, a statistic over a licensed level that
 * `/api/series` already withholds for GT — while `fire.fired` / `approaching` (the verdicts) stay. Pure; a copy.
 */
export function withholdExposureStats<T extends ExposureResult>(served: T): T {
  return {
    ...served,
    arm: { ...served.arm, roc: null },
    fire: { ...served.fire, maSpread: null },
    summary: summarize(served.arm, served.fire, served.posture, "—"),
  };
}

/**
 * The `ExposureResult`-level adapter over `resolveCompoundFloor`, for the surface that serves a
 * whole result (`api/exposure.ts`). Re-renders `summary` against the BOUNDED posture through the
 * same `summarize` the raw result used, so the served sentence can never disagree with the served
 * `posture`/`equityPct` — a payload whose prose says "-> Defensive (15% equity)" beside
 * `posture: "Core"` is the two-surface defect reproduced inside one response.
 *
 * The run path calls `resolveCompoundFloor` directly (it consumes `equityPct` alone), so both
 * surfaces share one implementation of the bound.
 */
export function applyCompoundFloor(raw: ExposureResult, riskRank: number | null): ExposureResult {
  const bounded = resolveCompoundFloor(raw.posture, riskRank);
  if (!bounded.floorApplied) return raw;
  return {
    ...raw,
    posture: bounded.posture,
    equityPct: bounded.equityPct,
    summary: summarize(raw.arm, raw.fire, bounded.posture),
  };
}

/**
 * The `ExposureResult`-level adapter over `resolveOverlayStepDown`, for the surface that serves a
 * whole result (`api/exposure.ts`). Same shape and same reason as `applyCompoundFloor`: `summary` is
 * re-rendered through `summarize` against the STEPPED posture, so the served sentence can never
 * disagree with the served `posture`/`equityPct`.
 *
 * ⚠ Call it on the output of `applyCompoundFloor`, never before it — the floor resolves first.
 * The run path calls `resolveOverlayStepDown` directly (it consumes `equityPct` alone), so both
 * surfaces share one implementation of the step-down.
 */
export function applyOverlayStepDown(
  bounded: ExposureResult,
  publishedCashLevel: "off" | "partial" | "full",
): ExposureResult {
  const stepped = resolveOverlayStepDown(bounded.posture, publishedCashLevel);
  if (!stepped.steppedDown) return bounded;
  return {
    ...bounded,
    posture: stepped.posture,
    equityPct: stepped.equityPct,
    summary: summarize(bounded.arm, bounded.fire, stepped.posture),
  };
}

/**
 * Push on any posture CHANGE where both postures are non-null (degraded runs
 * are silent). Symmetric up/down for now — the M4/M8 asymmetric re-risk
 * deadband is deferred to a later slice.
 *
 * Approaching tier (E3 Decision 1): when the posture is unchanged but a key
 * ENTERS approaching (prev neither approaching nor tripped), push a LOW-priority
 * heads-up. While a key STAYS approaching there is no enter edge, so no repeat
 * push. A posture change takes precedence.
 *
 * ⚠ **`prev` is the PREVIOUS RUN's persisted state** (`ExposurePushState`, off its alert row), NOT a
 * re-derivation from today's series. That IS the dedup, and it is what makes the push fire once per
 * change instead of once per run: any run that sees the same state as the run before it — a manual
 * cron invocation, a second daily run, or every run across a weekend/holiday/publication lag where
 * F1 and GT print no new close — compares equal and stays silent.
 *
 * Until 2026-08-09 the prior was `computeExposure(f1.slice(0,-1), gt.slice(0,-1))`, a stateless
 * re-derivation of "yesterday" off the SAME two series. It carries no memory of what was pushed, so
 * a transition sitting on the newest close re-pushed on EVERY run until a new close arrived — prod
 * sent the identical `Exposure: Core -> Full` on every cron for two days (F1 last printed 2026-08-06,
 * GT 2026-08-07). Do not reintroduce a series-derived prior here.
 *
 * A null prior — the first run after this shipped, a row written before the field existed, or a
 * baseline never established because the feed has been degraded since — is a SILENT baseline: this
 * run persists its state and says nothing. Same rule as `heldSleeve`'s prior, and the same direction
 * of failure the rest of this path takes (suppress a real transition rather than invent one).
 */
export function decideExposureNotify(
  curr: ExposureResult,
  prev: ExposurePrior | null,
): { push: boolean; message: NtfyMessage | null } {
  if (curr.posture === null || prev == null || prev.posture === null) {
    return { push: false, message: null };
  }
  if (curr.posture !== prev.posture) {
    return {
      push: true,
      message: {
        title: `Exposure: ${prev.posture} -> ${curr.posture}`, // ASCII only — ntfy header constraint
        body: curr.summary,
      },
    };
  }
  const armEnters = curr.arm.approaching && !prev.arm.approaching && !prev.arm.armed;
  const fireEnters = curr.fire.approaching && !prev.fire.approaching && !prev.fire.fired;
  if (armEnters || fireEnters) {
    const what = [armEnters ? "credit (ARM)" : null, fireEnters ? "trend (FIRE)" : null]
      .filter(Boolean)
      .join(" + ");
    return {
      push: true,
      message: {
        title: `Exposure: ${what} approaching`, // ASCII only — ntfy header constraint
        body: curr.summary,
        priority: 2, // low — heads-up tier, below the default-priority posture pushes
      },
    };
  }
  return { push: false, message: null };
}
