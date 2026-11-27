// MOVE-ONLY peel from danger-engine.ts (B4, 2026-08-15): momentum lookbacks, the held-pick
// deadband knobs, and `pickHeld`. `danger-engine.ts` re-exports the surface; the back-import is type-only (erased).
import { DANGER_CUTS } from "./danger-concentration.js";
import type { DangerBand, LegRow } from "./danger-engine.js";

/** momentum lookback (i5): danger ROC over N closes; spec default, eyeball-tuned. */
export const LOOKBACK = 20;
/** SN speed-arrow lookback (ledger idiom item 5, USER 2026-07-15): STRESS-NOW ROC over 5
 *  closes (~1 trading week) — a speed read, deliberately NOT the momentum seam's LOOKBACK=20. */
export const SN_ROC_LOOKBACK = 5;
/** EW speed-arrow lookback (D2.1, USER 2026-07-16): EARLY-WARN ROC over 20 closes (~1 month).
 *  ⚠ ITS ORIGINAL RATIONALE IS NOW DEAD (2026-07-17). 20 was chosen because EW's slow members
 *  (F12 quarterly, F14/F15 monthly) made a 5-close EW delta structurally ≈ 0, so the arrow could
 *  never fire at SN's cadence. All three are now retired (DEC-19/DEC-20/DEC-21) and `mc` is
 *  memberless, leaving EW = {cr, rt} (+ the `vb` stub) — every remaining EW member is DAILY, so
 *  nothing about the feeds still argues for 20 over SN's 5. The VALUE is left untouched here
 *  deliberately: it is a USER-decided knob and re-tuning it is a behavior change this dead-feed
 *  retirement is not chartered to make. OPEN: re-decide EW vs SN cadence now that the asymmetry's
 *  premise is gone. The two
 *  pillars share `SN_ROC_CUTS` (`public/sub-dangers.js`) — only the CADENCE differs, not the
 *  scale: both are raw pillar-share [0,1] units, which the leg's max over EW and SN
 *  presupposes. Coincides numerically with LOOKBACK=20 but is a SEPARATE seam (that one is
 *  danger-ROC with a divisor; this is a raw pillar delta) — don't collapse them. */
export const EW_ROC_LOOKBACK = 20;

// --- held-pick knobs, DERIVED from DANGER_CUTS (D5, 2026-07-17) ---------------------
// These four lived in `danger-ladder.ts` (defined, never used there) as hand-picked 0.3 literals
// calibrated against the pre-Stage-1b ROOT scale (`√(Σ w·s²/Σ w)`). A later, ~2.4× colder engine
// scale left the literals silently not firing on prod — a fail-toward-aggressive bug on the ntfy-pushed hold. D5 fixes the CLASS, not the instance: they are
// now EXPRESSIONS over `DANGER_CUTS`, so they can never again be stranded when the cuts are
// recalibrated, and no new fitted number enters the model. They live in the engine's B4 split files
// (`CONC_THRESHOLD`/`CONC_WEIGHT` now in `danger-concentration.ts`), not `danger-ladder.ts`,
// because engine-side → `danger-ladder` is the existing import edge: deriving them over
// `DANGER_CUTS` in `danger-ladder.ts` would invert that edge into a cycle, and as top-level `const`s
// that is a TDZ init-order failure.

/** Held-pick anti-whipsaw buffer (stateless hysteresis) ∈ [0,1] on the danger scale — DIRECTIONAL
 *  (M4/M8, slice-1). Rotation best practice is a buffer band around the switch signal (DFA's 2% MA
 *  buffer; ±bands around a moving average) so a marginal signal never flips the hold.
 *
 *  MECHANISM (the pre-2026-07-17 docstring described this BACKWARDS — that inversion is the likely
 *  root cause of the whole stranded-constant bug, so read the code, `computeField` in `danger-engine.ts`):
 *  among in-band legs, every leg within `deadband` of the MINIMUM danger is a candidate, and the
 *  MOST-AGGRESSIVE (lowest risk rank) candidate is held. So a WIDER deadband admits hotter legs and
 *  therefore pulls the hold TOWARD the aggressive end; a ZERO deadband collapses it to the strict
 *  calmest (most-defensive) in-band leg. The buffer resists rotating to a more-DEFENSIVE leg — it is
 *  not, as previously written, a brake on rotating to a more-aggressive one.
 *
 *  `computeField` picks the deadband by DIRECTION vs the prior target rung:
 *   - danger RISING (current target rung > prev) ⇒ DERISK_DEADBAND ⇒ de-risk fast: the hold collapses
 *     to the strict calmest in-band leg (cures P1's pull to the aggressive floor). Cold-start (no
 *     prior) assumes RISING (fail-safe).
 *   - danger FALLING/STABLE ⇒ RERISK_DEADBAND ⇒ inertia: an aggressive leg whose danger exceeds the
 *     calmest in-band leg's by LESS than the deadband keeps the hold. Only a gap of ≥ the deadband
 *     forces the rotation onto the calmer, more-defensive leg.
 *  Research-grounded in regime-persistence asymmetry (arXiv 2402.05272), NOT backtest-fit. */
export const DERISK_DEADBAND = 0;
/** **D6: a DISTANCE in danger space** — the gap between two legs' dangers that must be cleared before
 *  a FALLING/STABLE market gives up the aggressive hold.
 *
 *  **HALVED 2026-08-07 — [USER] ruling**: the timing gates
 *  (`RERISK_CONFIRM`, `RERISK_DWELL_DAYS`) went to zero, and this deadband is the deliberate
 *  counterweight — **shrunk, NOT zeroed**. It was one full leg-RAG band width (the green→amber cut, the
 *  distance the board itself treats as "a visible step"); it is now HALF that, so a sub-half-band gap is
 *  the noise the buffer still ignores while genuinely elevated aggressive legs are excluded from the
 *  candidate window.
 *
 *  **Stays DERIVED, never a literal** (single-touch-point discipline): a later `DANGER_CUTS` retune must
 *  carry it, and moving it owes a `RERISK_BASIS_EPOCH` bump in the same commit (see below).
 *
 *  ⚠ It USED to be numerically equal to `CONC_THRESHOLD`; since the halving it is not. That constant is
 *  a LEVEL (an absolute point on the scale) while this is a DISTANCE (a difference of two points) —
 *  same units, different quantity. They were kept as two symbols precisely so this move was possible. */
export const RERISK_DEADBAND = reriskDeadbandOf(DANGER_CUTS);

/** Re-risk deadband at `cuts` (= amber / 2) — `shareArm` passes its own; `RERISK_DEADBAND` = this at `DANGER_CUTS`. */
export function reriskDeadbandOf(cuts: Readonly<{ amber: number }>): number {
  return cuts.amber / 2;
}

/** **Re-risk streak BASIS EPOCH** (W6 Addendum E-2, 2026-07-25). The first obs-date whose persisted
 *  `rerisk_confirm_count` is guaranteed to have been earned against the CURRENT `RERISK_DEADBAND`.
 *  A prior row dated STRICTLY BEFORE this reads its streak as 0, so a re-risk in flight across a cut
 *  move must reconfirm under the new bar instead of cashing in confirmations earned under the old one.
 *
 *  Why a READ-side epoch and not a DB fix: `alert_log`'s decided columns are IMMUTABLE (Addendum E-1) —
 *  the stored history stays a truthful record of what fired, and the correction lives where the value is
 *  consumed. Sits beside `RERISK_DEADBAND` deliberately: **moving `DANGER_CUTS` moves the deadband, and
 *  moving the deadband owes an epoch bump in the same commit.**
 *
 *  **Fails safe by construction** — zeroing a streak can only DELAY a re-risk, never hasten one. That is
 *  the whole reason this ships without a measurement.
 *
 *  ⚠ **This bump is HYGIENE, not behaviour.** The epoch went INERT the moment `RERISK_CONFIRM` reached 1:
 *  with the streak gating nothing, zeroing a streak cannot delay anything either. The MECHANISM is kept
 *  rather than deleted for two reasons — it is the correct machinery if a streak is ever re-armed (§5's
 *  fallback ladder), and a silently-stale epoch is precisely the failure mode it exists to prevent, so
 *  leaving a dead-but-correct epoch is safer than leaving a live-but-absent one. Keep bumping it on every
 *  deadband move even while it is inert. */
export const RERISK_BASIS_EPOCH = "2026-10-25";

/** The `held` pick, extracted from `computeField` (W6 Stage 6.6) so the CANDIDATE gate has a
 *  directly-drivable seam — `computeField` calls THIS, there is no second copy of the rule.
 *  `effDangerOf` supplies the post-concentration effective danger (`computeField` passes its
 *  `effDanger` map; a caller with no concentration pass can pass `l => l.danger`).
 *
 *  Candidate set: `risk ∈ [band.lo, band.hi]` — the dial band.
 *  Empty candidate set ⇒ `null` ⇒ `run-core.ts`'s dial-sleeve fallback (also never taken; see there).
 *  Then: minimum effective danger, and among legs within `deadband` of it the MOST-AGGRESSIVE
 *  (lowest `risk`) — the anti-whipsaw buffer documented at the call site.
 *
 *  The comparison is STRICT (`<`), so a `risk` tie resolves first-wins.
 *  Growth NEVER reaches the pick: the G2.2 growth tiebreak was retired (Rung 4 Stage 2, `[USER]` ruling
 *  2026-08-03 option E) and its window arm deleted.
 *  Growth is still computed, served and displayed; `effDangerOf` alone fixes the candidate
 *  set and `risk` alone picks from it. */
export function pickHeld(
  legRows: readonly LegRow[],
  band: DangerBand,
  effDangerOf: (l: LegRow) => number,
  deadband: number,
): LegRow | null {
  const inBand = legRows.filter((l) => l.risk >= band.lo && l.risk <= band.hi);
  if (inBand.length === 0) return null;
  const dMin = Math.min(...inBand.map(effDangerOf));
  const candidates = inBand.filter((l) => effDangerOf(l) <= dMin + deadband);
  return candidates.reduce((m, l) => (l.risk < m.risk ? l : m));
}
