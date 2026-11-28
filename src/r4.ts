/**
 * R4 cash breaker — the extreme-only circuit-breaker layered OVER the 1–9 T1 dial.
 * Design LOCKED.
 *
 * Cash = R4, a separate ladder state reached only *past* rung 9. ENTER is
 * `bandDeep AND breadth AND (hyTail OR vtTail)` — the dial deep in the top band AND
 * family breadth AND at LEAST ONE of the two tail prints (the two tail rows are OR-ed,
 * not AND-ed) — evaluated on **ONE** close. EXIT is a single close on ANY one clear
 * condition. An idle-cash ratchet snaps straight back to the live target after a long,
 * calm stay; otherwise re-entry walks the ladder down from the most-defensive rung.
 *
 * ENTER-ON-CLOSE-1 (NF-1(A), 2026-07-26): the phase walk is `equity → cash → re-entry`,
 * and the old 3-close arming ladder (`arm1`/`arm2`) that once sat between the first two
 * is DELETED, not shortened — the breaker reacts on the first qualifying close, in
 * `equity` and mid-`reentry` alike. The surviving asymmetry vs the early cash overlay is
 * TOTAL + LATE + off-ladder, **not** slow: R4 is no longer the hardest-to-ENTER state.
 * ⚠ INTENDED CONSEQUENCE: `escalatorFloorBreakdown` floors the band to CRITICAL on
 * `phase === "cash"`, so entering 2 closes earlier makes that floor bind on more days and
 * more episodes — more frequent CRITICAL pushes. That is the ruling (maximum whipsaw
 * accepted explicitly), never a regression to be clawed back with a cut or a push gate.
 * ⚠ EXIT and the whole `case "cash"` body (hold / exit / ratchet / laddered re-entry),
 * including BOTH `pillarsLive` liveness guards, are UNTOUCHED by that ruling — read the
 * deletion as an entry-persistence change only, never as a general loosening.
 *
 * Pure leaf: same (dial, tail levels, prior state, clock) → same result. Persisted state
 * is 3 typed columns, no counter column (decision #1).
 *
 * ⚠ TWO cash mechanisms exist, deliberately (W5-a §1 Alternative A). This one is LATE + DEEP +
 * TOTAL — the terminal state reached *past* the ladder's deepest rung. `src/cash-overlay.ts` is
 * EARLY + SHALLOW + PARTIAL — the state reached *before* the ladder has moved. That is DEC-1's
 * geometry argument applied twice, in opposite directions; they share a word, not a mechanism.
 * They are merged at exactly one tested point, `resolveCash` in `cash-overlay.ts`, where this
 * module wins unconditionally.
 */
import type { T1DialResult } from "./t1dial.js";

// ── LOCKED calibration (design §LOCKED calibration; not re-opened here) ──────────
/** ENTER cond-1: `dial.targetRung ≥ 8`. */
export const R4_ENTER_RUNG = 8;
/** ENTER cond-1: `leadingFiring + coincidentFiring ≥ 3` (≥3 of 5 families firing). */
export const R4_ENTER_FAMILIES = 3;
/** ENTER cond-2: HY-OAS (F1 `BAMLH0A0HYM2`) level ≥ this, in %. Hand-set by the USER,
 *  an ABSOLUTE literal: a deliberate
 *  earlier-warning posture that sits BELOW the conventional 600bp stress mark, accepting a higher duty
 *  cycle in exchange for reachability. It is not derived from `R4_EXIT_HY` and nothing may re-derive it. */
export const R4_HY_TAIL = 4.0;
/** ENTER cond-2: VT ratio (VIX/VIX3M) ≥ 1.05. */
export const R4_VT_TAIL = 1.05;
/** EXIT (OR-leg a): `dial.targetRung ≤ 6`. */
const R4_EXIT_RUNG = 6;
/** EXIT (OR-leg b): HY-OAS < this AND… Hand-set by the USER
 *  as an ABSOLUTE literal. The former
 *  `0.75 × R4_HY_TAIL` ratio is RETIRED: HY-OAS is not scale-free, so one ratio produced two different
 *  behaviours at two different tails. The re-arm gap is `R4_HY_TAIL − R4_EXIT_HY`, never a third literal.
 *  The inverted hysteresis is now guarded ONLY by the `R4_EXIT_HY < R4_HY_TAIL` assertion in
 *  `r4.test.ts` — that assertion is load-bearing, not decorative. */
export const R4_EXIT_HY = 3.2;
/** EXIT (OR-leg b): …VT < 1.00 (both tails clear). */
export const R4_EXIT_VT = 1.0;
/** idle-cash ratchet: days-in-cash ≥ 20 → snap to target (gated on `targetRung ≤ R4_EXIT_RUNG`). @internal */
export const R4_RATCHET_DAYS = 20;
/** laddered re-entry begins at the most-defensive on-ladder rung (staples), walks toward target. @internal */
export const R4_REENTRY_START = 9;

const MS_PER_CALENDAR_DAY = 86_400_000;

export type R4Phase = "equity" | "cash" | "reentry";

/**
 * Narrow a PERSISTED `alert_log.r4_phase` text value to `R4Phase`.
 *
 * The column is plain `text` with no DB CHECK (the union is owned here), and rows written
 * before NF-1(A) can carry the retired `arm1`/`arm2`. Anything unrecognised hydrates to
 * `"equity"` — the resting state, and the safe direction: a junk/legacy value must not be
 * cast into a type the DB does not enforce and then steer the CRITICAL floor. Narrowed by
 * VALUE, not by cast, exactly like `fall_shape` in `store.ts`.
 */
export function hydrateR4Phase(raw: unknown): R4Phase {
  return raw === "cash" || raw === "reentry" ? raw : "equity";
}

/** Persisted R4 state — the 3 typed columns (decision #1: exactly 3, no 4th counter). */
export interface R4State {
  phase: R4Phase;
  /** ISO timestamp of the close that entered cash; null off-cash. Anchors the idle-cash ratchet. */
  entryFiredAt: string | null;
  /** the on-ladder rung a laddered re-entry currently holds; null unless `phase === "reentry"`. */
  reentryRung: number | null;
}

/** computeR4 result — the full next persisted state ({phase, entryFiredAt, reentryRung}) plus the
 *  derived `cash` flag and a legible `reason` for the /lab surface. assembleRun (Stage 3) overwrites
 *  all 3 persisted columns from this. */
export interface R4Result {
  /** `phase === "cash"` — the terminal off-ladder breaker zone. */
  cash: boolean;
  phase: R4Phase;
  entryFiredAt: string | null;
  reentryRung: number | null;
  reason: string;
}

/** ENTER gate — `bandDeep AND breadth AND (hyTail OR vtTail)`: the dial deep in the top band AND
 *  family breadth AND at least ONE of the two tail prints. The tail print is REQUIRED (the
 *  "extreme-only" guarantee) but either tail satisfies it. A null tail level is treated as un-met
 *  (fail-safe), so a single live tail can still carry the OR while the other feed is dark.
 *
 *  ⚠ **`enterR4` is NOT all-AND** — `enterCond` is `bandDeep && breadth && (hyTail || vtTail)`; the two
 *  TAIL rows are OR-ed, and ENTER is ONE close. */
function enterCond(dial: T1DialResult, hyOas: number | null, vt: number | null): boolean {
  const bandDeep = dial.targetRung >= R4_ENTER_RUNG;
  const breadth = dial.leadingFiring + dial.coincidentFiring >= R4_ENTER_FAMILIES;
  const tail = (hyOas != null && hyOas >= R4_HY_TAIL) || (vt != null && vt >= R4_VT_TAIL);
  return bandDeep && breadth && tail;
}

/**
 * EXIT gate — any ONE, single close. Tail-clear leg needs BOTH levels present and below floor.
 *
 * LIVENESS GUARD (2026-07-18, Stage 8.1 audit): the rung-clear leg additionally requires
 * `dial.pillarsLive`. A non-live pillar is dropped from the dial's fold and so counts as LOW
 * (`danger-engine.ts`), which means a run that merely ran out of fetch budget prints a LOW
 * `targetRung` indistinguishable from a genuinely calm one — and EXIT is single-close and
 * PERSISTED, so one starved close walked the breaker out of cash and cost 3 closes to re-arm.
 * The guard is liveness-only: no cut moved, and on a fully-live close `pillarsLive` is true, so
 * a genuinely calm live close still exits on the same rung it always did. The rank-7 family
 * carry already covers the *previously-firing* dropped family (it re-marks it live for
 * CARRY_MAX_TRADING_DAYS), so this guard bites only where carry does not: a pillar with nothing
 * to carry, i.e. exactly the starved-denominator case. The tail-clear leg is untouched — it
 * reads two RAW LEVELS, so it is already null-guarded and cannot be faked calm by an absent feed.
 */
function exitCond(dial: T1DialResult, hyOas: number | null, vt: number | null): boolean {
  const rungClear = dial.pillarsLive && dial.targetRung <= R4_EXIT_RUNG;
  const tailsClear = hyOas != null && vt != null && hyOas < R4_EXIT_HY && vt < R4_EXIT_VT;
  return rungClear || tailsClear;
}

const equity = (reason: string): R4Result => ({
  cash: false,
  phase: "equity",
  entryFiredAt: null,
  reentryRung: null,
  reason,
});

/**
 * The RESTING R4 state — the dial-less / no-caller-supplied default ("no dial" ⇒ R4 never fired).
 * Expressed through the same `equity()` factory every live equity-phase result uses, so there is
 * no hand-typed field copy to drift.
 *
 * SINGLE SOURCE for both former copies: `notify_format.ts`'s default when a caller supplies no
 * `r4` at all (pure-logic tests / the dial-less path, where `resolveCash` still needs a whole
 * `R4Result`), AND `run-core.ts`'s pre-`computeR4` initialiser for its hoisted `r4` binding. Frozen:
 * `run-core.ts` REASSIGNS its binding rather than mutating the object (verified: no code path mutates
 * an `R4Result` in place), and the freeze pins that.
 *
 * It encodes no precedence — precedence lives only in `resolveCash`.
 */
export const R4_RESTING: Readonly<R4Result> = Object.freeze(equity("no dial"));

/**
 * Advance R4 one close. `dial` is always present here (the no-dial fail-safe lives in
 * assembleRun, which leaves the columns at literal null); only the tail levels may be null,
 * in which case the tail-dependent conditions are treated un-met.
 */
export function computeR4(
  dial: T1DialResult,
  hyOas: number | null,
  vt: number | null,
  prior: R4State,
  clock: () => string,
): R4Result {
  const entering = enterCond(dial, hyOas, vt);

  switch (prior.phase) {
    case "equity":
      // The FIRST qualifying close enters cash (NF-1(A)) and anchors the idle-cash ratchet
      // clock. No counter is printed because none is kept.
      return entering
        ? { cash: true, phase: "cash", entryFiredAt: clock(), reentryRung: null, reason: "entered cash" }
        : equity("calm");

    case "cash": {
      if (!exitCond(dial, hyOas, vt)) {
        return { cash: true, phase: "cash", entryFiredAt: prior.entryFiredAt, reentryRung: null, reason: "hold - danger persists" };
      }
      // Exit fired. Idle-cash ratchet: only when the stay was long AND the dial has genuinely
      // receded (never accelerates while targetRung ≥ 7) → snap straight to the live target.
      const daysInCash =
        prior.entryFiredAt == null
          ? 0
          : Math.floor((Date.parse(clock()) - Date.parse(prior.entryFiredAt)) / MS_PER_CALENDAR_DAY);
      // Same liveness guard as the rung-clear EXIT leg: the ratchet is the MOST aggressive
      // re-entry available (a straight snap to target, skipping the laddered walk), so it must
      // never read a starved rung as "the dial has genuinely receded". Without `pillarsLive` a
      // budget-starved close after a long stay snapped cash → full target in one step.
      if (daysInCash >= R4_RATCHET_DAYS && dial.pillarsLive && dial.targetRung <= R4_EXIT_RUNG) {
        return equity(`ratchet snap → target rung ${dial.targetRung}`);
      }
      // Otherwise begin a laddered re-entry from the most-defensive on-ladder rung.
      return { cash: false, phase: "reentry", entryFiredAt: null, reentryRung: R4_REENTRY_START, reason: `re-entry - rung ${R4_REENTRY_START}` };
    }

    case "reentry": {
      if (entering) {
        // Danger re-surged mid-re-entry → straight back to cash on this one close, the same
        // rule the `equity` arm applies. A re-surge while walking back onto the ladder is
        // exactly the "react on the first qualifying close" case NF-1(A) rules on.
        return { cash: true, phase: "cash", entryFiredAt: clock(), reentryRung: null, reason: "danger re-surged - entered cash" };
      }
      const target = dial.targetRung;
      const current = prior.reentryRung ?? R4_REENTRY_START;
      const next = current > target ? current - 1 : current < target ? current + 1 : current;
      if (next === target) {
        // Walked back onto the live target rung → fully re-invested.
        return equity(`re-entry complete → rung ${target}`);
      }
      return { cash: false, phase: "reentry", entryFiredAt: null, reentryRung: next, reason: `re-entry - rung ${current} → ${next}` };
    }
  }
}
