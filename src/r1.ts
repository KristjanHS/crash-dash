/**
 * R1 walk-down path — the laddered, one-rung-per-close route from the held rung to the target rung.
 *
 * Rung axis (confirmed against `LADDER` in `src/danger-engine.ts`): rung 1 is the MOST AGGRESSIVE
 * leg, rung 9 the MOST DEFENSIVE (Staples). So de-risk means `targetRung > priorRung` and re-risk
 * means `targetRung < priorRung`. Every comparison below is written on that axis.
 *
 * R1's distinct residual over the live `DERISK_DEADBAND` hysteresis is the WALK: the deadband
 * decides *whether* to move, R1 decides *how* the move is spread — one rung per close, never a jump
 * to the floor — and hands `/lab` the remaining sequence to draw.
 *
 * Pure leaf: same (targetRung, priorRung, reriskConfirmCount) → same result. No I/O, no DB, no new
 * column — `priorRung` comes from the existing `prevTargetOf(verdict.heldSleeve)` and
 * `reriskConfirmCount` from the existing `AlertRecord` field.
 *
 * Constants are METHODOLOGICAL (a convention, a symmetry, a structural bound) — none is fitted to a
 * replayed world ("no backtest as arbiter"). All four are
 * pinned by `r1.test.ts`.
 */

/** Rungs advanced per close when de-risking. The method card's settled "laddered one-rung-per-step
 *  (§1.3)". Pinned by `r1.test.ts` "a rung-2 → rung-9 de-risk produces a 7-element path, one rung
 *  apart" — a step of 2 would emit `[4,6,8,9]` (4 elements, not 7; the overshoot guard truncates
 *  the last stride, so only the first three pairs are two apart), so that test goes red. */
const R1_STEP_DOWN = 1;

/** Rungs advanced per close when re-risking. SYMMETRIC with the de-risk step by construction: the
 *  asymmetry (#7 / D10) lives in `R1_UP_CONFIRM`, not in the step, so the walk stays legible.
 *  Pinned by `r1.test.ts` "re-risk advances exactly one rung per close once confirmed" — that test
 *  asserts the literal rung 8 from a rung-9 prior, so a step of 2 goes red. */
const R1_STEP_UP = 1;

/** Consecutive confirming closes required before a re-risk step may fire at all. Two closes matches
 *  the repo's existing `CONFIRM_CLOSES = 2` leg-level convention (`danger-engine.ts`), so R1 does
 *  not introduce a third confirmation speed. Pinned by `r1.test.ts` "re-risk holds at priorRung
 *  while reriskConfirmCount < R1_UP_CONFIRM and advances at exactly R1_UP_CONFIRM" — it asserts the
 *  literal counts 1 (hold) and 2 (advance), so a value of 3 goes red on the advance half. @internal */
export const R1_UP_CONFIRM = 2;

/** The most-defensive ON-ladder rung — `LADDER.length` = 9 (Staples). The retreat's destination is
 *  defensive *equity*, not cash; cash is off-ladder and reached only past rung 9 under R4's separate
 *  bar ("R1 floors at defensive equity, never cash"). Pinned
 *  by `r1.test.ts` "targetRung 12
 *  clamps nextRung and every path element to R1_FLOOR_RUNG" — it asserts the literal 9 as both the
 *  clamp and the last path element, so a floor of 10 goes red. */
export const R1_FLOOR_RUNG = 9;

/** The most-aggressive on-ladder rung. Structural lower bound, not a knob. */
const R1_TOP_RUNG = 1;

type R1Direction = "derisk" | "rerisk" | "hold";

interface R1Result {
  /** The rung to hold after this close — one step along the walk, or `priorRung` when holding. */
  nextRung: number;
  /** The remaining rung sequence from `priorRung` to `targetRung`, exclusive of `priorRung` and
   *  inclusive of `targetRung`, every element clamped to the ladder. `[]` on cold start and when
   *  already at target. This is what `/lab` draws as "the walk". */
  path: number[];
  /** true ⇒ `nextRung` sits on the defensive floor (`R1_FLOOR_RUNG`). */
  atFloor: boolean;
  /** Always `path.length`: on a moving close that is the closes needed to reach `targetRung`
   *  COUNTING the step taken this close (a 1-rung move reports 1, not 0); on an unconfirmed re-risk
   *  no step is taken this close, so arrival actually costs one more. 0 ⇒ nothing left to travel. */
  stepsRemaining: number;
  /** Which way the walk runs, on the rung-1-aggressive axis. `"hold"` covers cold start,
   *  already-at-target, and an unconfirmed re-risk. */
  direction: R1Direction;
  /** Legible one-liner for the /lab overlay strip. */
  reason: string;
}

/** Clamp a rung onto the on-ladder range [1, R1_FLOOR_RUNG]. TOTAL by construction: a non-finite
 *  rung (NaN or ±Infinity) falls back to the defensive floor — including `-Infinity`, which the bare
 *  min/max would otherwise have clamped to the MOST AGGRESSIVE rung 1. That
 *  matters because `buildPath`'s `while (cursor !== to)` never terminates on a NaN endpoint — a hung
 *  `/api/lab`, not a wrong number — so the guard lives here, at the single choke point both
 *  endpoints pass through, rather than being duplicated per caller. Fail-safe direction is the floor,
 *  matching how a missing `priorRung` is handled (seat defensively, never invent a walk). */
function clampRung(rung: number): number {
  if (!Number.isFinite(rung)) return R1_FLOOR_RUNG;
  return Math.min(R1_FLOOR_RUNG, Math.max(R1_TOP_RUNG, Math.round(rung)));
}

/**
 * Build the remaining walk from `from` (exclusive) to `to` (inclusive) at `step` rungs per close.
 * `to` is already clamped, so every emitted element is on-ladder; the final element is exactly `to`
 * even when `step` does not divide the gap evenly.
 */
function buildPath(from: number, to: number, step: number): number[] {
  const path: number[] = [];
  const dir = to > from ? 1 : -1;
  let cursor = from;
  while (cursor !== to) {
    cursor += dir * step;
    // Never overshoot: the last stride is truncated to land on `to`.
    if ((dir === 1 && cursor > to) || (dir === -1 && cursor < to)) cursor = to;
    path.push(cursor);
  }
  return path;
}

/**
 * Advance R1 one close.
 *
 * `targetRung` is the dial's current target; `priorRung` is the rung actually held (null on cold
 * start / no held sleeve); `reriskConfirmCount` is the count of consecutive closes the re-risk has
 * been confirming.
 */
export function computeR1(
  targetRung: number,
  priorRung: number | null,
  reriskConfirmCount: number,
): R1Result {
  const target = clampRung(targetRung);

  // Cold start: seat at target. Fail-safe — never invent a walk from a rung we never held.
  if (priorRung == null || !Number.isFinite(priorRung)) {
    return {
      nextRung: target,
      path: [],
      atFloor: target === R1_FLOOR_RUNG,
      stepsRemaining: 0,
      direction: "hold",
      reason: "cold start - seat at target",
    };
  }

  const prior = clampRung(priorRung);

  if (target === prior) {
    return {
      nextRung: prior,
      path: [],
      atFloor: prior === R1_FLOOR_RUNG,
      stepsRemaining: 0,
      direction: "hold",
      reason: `already at target rung ${prior} - no walk`,
    };
  }

  const derisk = target > prior;
  const step = derisk ? R1_STEP_DOWN : R1_STEP_UP;
  const path = buildPath(prior, target, step);

  // Re-risk is gated: down fires easier than up (#7 / D10). Below the confirm bar we hold the rung
  // we have, but still publish the walk so /lab can show what is pending.
  if (!derisk && reriskConfirmCount < R1_UP_CONFIRM) {
    return {
      nextRung: prior,
      path,
      atFloor: prior === R1_FLOOR_RUNG,
      stepsRemaining: path.length,
      direction: "hold",
      reason: `re-risk to rung ${target} unconfirmed (${reriskConfirmCount}/${R1_UP_CONFIRM} closes) - holding rung ${prior}`,
    };
  }

  const nextRung = path[0] as number;
  return {
    nextRung,
    path,
    atFloor: nextRung === R1_FLOOR_RUNG,
    stepsRemaining: path.length,
    direction: derisk ? "derisk" : "rerisk",
    reason: derisk
      ? `de-risk rung ${prior} → ${target} - stepping to ${nextRung}, ${path.length} close(s) to go`
      : `re-risk rung ${prior} → ${target} confirmed - stepping to ${nextRung}, ${path.length} close(s) to go`,
  };
}
