/**
 * W5-a — the Tier-1 CASH OVERLAY (DEC-1 + DEC-10).
 * All 3 `[USER DECISION]`s RULED 2026-07-18.
 *
 * DEC-1: cash is an **overlay, never a rung**. The geometry argument: a rung is a *depth*, depth on
 * the two-key ladder is reached LATE (`armed && fired` is coincident confirmation = the crash is
 * already priced), and cash must fire EARLY. Early and deep are contradictory positions on one
 * ladder, so cash cannot be one of its rungs.
 *
 * ORTHOGONALITY INVARIANT (the plan's load-bearing invariant — §0):
 *   **This module READS the dial and never WRITES it.** No value produced here may enter
 *   `computeT1Dial`'s inputs, `rung`, `band`, `dangerScore`, `targetRung`, either regime axis,
 *   `computeField`'s `held`, or the composed `AlertLevel`. Anything that caps, floors or shifts
 *   `rung` IS a ladder operation and would make the overlay a rung by another name. It is an
 *   additional emitted fact, not a term in the ladder's arithmetic.
 *
 * Axis discipline (§2): the overlay reads `targetRung` only — never either regime axis. That keeps
 * it entirely clear of W3-c's live notify-cut choice and of both parity tripwires.
 *
 * Relationship to `src/r4.ts` (§1 Alternative A — deliberate, not a duplicate): R4 is the TERMINAL
 * cash state reached *past* the ladder's deepest rung (late + deep + total, 3-close entry). This
 * overlay is the state reached *before* the ladder has moved (early + shallow + partial, 1-close
 * entry). They share a word, not a mechanism. `resolveCash` below is the single tested merge point
 * that renders ONE claim — by PRECEDENCE, not by exclusivity (R7 ruling, 2026-07-26).
 * `computeCashOverlay(dial, prior, clock)` and `computeR4(dial, hy, vt, prior, clock)` cannot see
 * each other, so both CAN hold at once: the overlay arms on `targetRung` rising `CASH_ACCEL_RUNGS`
 * inside `CASH_ACCEL_WINDOW`, while R4 enters on `enterCond` (rung ≥ `R4_ENTER_RUNG`, AND
 * `leadingFiring + coincidentFiring ≥ R4_ENTER_FAMILIES`, AND an HY-OAS or VIX-term tail level —
 * `src/r4.ts`). A fall satisfying both is a live state, and `public/cash-precedence-parity.test.js`
 * enumerates the pair as a fixture. `resolveCash`'s first branch drops the overlay unconditionally
 * — safe because R4's 100% non-equity subsumes any `partial` (whose scalar is `100 − equityPct`,
 * so ≤ 85 by the deepest `EQUITY_PCT` when the posture is known, and `null` when it is degraded —
 * never total either way), not because the pair is unreachable.
 *
 * The overlay's own TRIGGER stays boolean and notify-only. W5-b Stage 4.1 sized the claim — but at
 * `resolveCash` (`CashState.nonEquityPct`, from the K5 posture's `equityPct`), NOT here: routing the
 * posture into `computeCashOverlay` would let it steer WHETHER cash fires, which §4.3.1's
 * orthogonality invariant forbids. `CashOverlayResult.nonEquityPct` is therefore vestigial `null`.
 */
import { POSITION_SPAN, type T1DialResult } from "./t1dial.js";
import { type R4Phase, type R4Result } from "./r4.js";

/** UD-1 = (c) DIAL ACCELERATION. The overlay fires on the DERIVATIVE of the dial, where every rung
 *  fires on the LEVEL — danger accelerating, regardless of depth. This is the most literal
 *  executable statement of DEC-1's geometry: "early" and "deep" are contradictory on a level scale
 *  but perfectly compatible on a rate scale.
 *
 *  Rise required, in rungs: one band width — the smallest move DEC-B3 declares meaningful. Cites
 *  the symbol, never a literal. */
export const CASH_ACCEL_RUNGS = POSITION_SPAN;

/** Closes the rise must occur within. The window holds this many `targetRung` samples INCLUDING
 *  the current close.
 *
 *  **Why the overlay owns this number.** It used to be R4's enter-persistence constant — not
 *  because the two quantities mean the same thing, but because R4 happened to own a 3 first. They
 *  are opposite concepts: R4's was a PERSISTENCE counter (how many consecutive qualifying closes
 *  before a state flips), while this is a MEASUREMENT window (how far back the `CASH_ACCEL_RUNGS`-
 *  sized rise in `targetRung` may be spread). Borrowing the persistence unit made any change to
 *  R4's entry policy silently re-tune an unrelated trigger in this file — and R4's counter has
 *  since been DELETED outright (NF-1(A): the breaker enters on one close), which would have
 *  collapsed this window to a single sample had the coupling still stood.
 *
 *  **Derivation of 3, on the overlay's own terms.** The window must be long enough that a genuine
 *  one-band acceleration spread over a couple of closes is still caught (a 2-sample window sees
 *  only today-vs-yesterday and misses the two-step rise DEC-1 calls "early"), and short enough that
 *  the rise still reads as a DERIVATIVE rather than a slow drift — at 3 samples the widest span the
 *  calendar bound (`CASH_PRIOR_MAX_AGE_DAYS`) admits is still inside a fortnight. 3 is also the
 *  value it evaluated to when it was derived, so extracting it moved no behaviour. */
export const CASH_ACCEL_WINDOW = 3;

/** Maximum age, in CALENDAR days, of a persisted prior `targetRung` that may still seed the
 *  acceleration window.
 *
 *  **Why a calendar bound exists at all:** `CASH_ACCEL_WINDOW` counts SAMPLES, not days, and
 *  `computeCashOverlay` never sees a date. The cron rehydrates the window from the persisted
 *  `dial_target_rung` history (`getRecentAlerts`), whose rows carry NO recency bound of their own —
 *  after a holiday cluster, a feed outage or any cron gap a row can be weeks or months old.
 *  Comparing today's rung against it fires the overlay and prints "within 3 closes" for a rise that
 *  actually took a quarter: a FALSE cash call, which §0 and the standing fail-safe convention
 *  forbid. `buildCashOverlayWindow` therefore applies this bound **pairwise across every window
 *  step**, not once against a single row, and truncates at the first violation.
 *
 *  **Derivation of 7.** The bound governs ONE window step — the calendar span between two adjacent
 *  trading closes. The widest such span the US calendar produces is a long weekend carrying a
 *  public holiday: a Friday close followed by a Monday holiday puts the next close on Tuesday
 *  (4 days); Good Friday / Christmas / New Year clusters top out at the same 4. Seven days clears
 *  that worst case with margin (it tolerates a whole missed trading week's worth of holiday) while
 *  still rejecting the multi-week lag this bound exists to catch.
 *
 *  **The asymmetry is deliberate and one-directional:** too SMALL only discards a usable prior, so
 *  the window seeds empty ⇒ `rise = 0` ⇒ `off` — a missed fire, which is safe. Too LARGE re-admits
 *  the false cash call. When in doubt, shrink it. @internal */
export const CASH_PRIOR_MAX_AGE_DAYS = 7;

/** ENTER persistence, in closes. **1 — derived from DEC-1's geometry, and it deliberately INVERTS
 *  D10/DEC-5's "hardest to ENTER".** That ruling was written for R4's terminal TOTAL cash, which
 *  then required 3 consecutive qualifying closes; on an early PARTIAL overlay a persistence counter
 *  is a latency tax paid against the exact property the overlay exists to buy.
 *  ⚠ The inversion this docblock names is HISTORY as of NF-1(A) (2026-07-26): R4 now enters on ONE
 *  close too, so the two no longer differ in persistence at all — what still differs is TOTAL-vs-
 *  PARTIAL and LATE-vs-EARLY. The 1 here is unchanged and is still the overlay's own number. */
export const CASH_ENTER_CLOSES = 1;

/** How many recent persisted fired-DATES the cron asks the store for when rehydrating the
 *  acceleration window (`getRecentAlerts(CASH_REHYDRATE_DATES)`).
 *
 *  **The off-by-one:** `CASH_ACCEL_WINDOW` counts samples INCLUDING the current close, which
 *  `computeCashOverlay` appends itself. So the rehydration only ever needs
 *  `CASH_ACCEL_WINDOW - 1` PRIORS, and `buildCashOverlayWindow` caps its output there — handing
 *  back a full `CASH_ACCEL_WINDOW` priors would let the fold's trailing `.slice()` silently drop
 *  the NEWEST sample.
 *
 *  **Why +2 and not more:** a returned date can be consumed without yielding a usable prior —
 *  today's own row on an intraday re-run (`getRecentAlerts` includes today), or a row whose
 *  `obs_date` duplicates another's under the intraday/21:05-UTC-cutoff regime. Two dates of slack
 *  covers both. Fetching more buys nothing: past the first gap or null rung the walk STOPS, so
 *  every older row is unreachable by construction. */
export const CASH_REHYDRATE_DATES = CASH_ACCEL_WINDOW + 2;

/** UD-2 = (ii) THREE-STATE ENUM. `full` is R4's terminal cash, `partial` is the early overlay,
 *  `off` is neither. A two-state boolean would force every consumer to hand-merge two independent
 *  cash booleans — which is precisely how two mechanisms produce two contradictory cash claims on
 *  one screen. */
export type CashLevel = "off" | "partial" | "full";

/** Persisted overlay state — the prior this stateful trigger needs (arch §9: "an exact prior target
 *  needs a persisted `targetRung` column"; the held-leg proxy is NOT the dial target and the two
 *  diverge exactly when the hold gate binds). Stage 2.1 gives these columns. */
export interface CashOverlayState {
  /** The `targetRung` window, MOST RECENT LAST, at most `CASH_ACCEL_WINDOW` entries. */
  recentTargetRungs: number[];
  /** ISO timestamp of the close the overlay went active; null while off. Survives across closes so
   *  a continuously-active overlay keeps its original entry stamp. */
  since: string | null;
}

/** The minimal shape `buildCashOverlayWindow` needs off a persisted alert row.
 *
 *  **Structural, deliberately NOT an import of `AlertRecord`:** `store.ts` already imports
 *  `CashLevel` from this module, so importing back would create a module cycle — what the repo's
 *  acyclic-split convention forbids. `StoredOverride` / `AlertSlice` in `store.ts` set the same
 *  precedent in the other direction ("store.ts stays lower-level"). `AlertRecord` is structurally
 *  assignable to this, so `AlertRecord[]` passes with no cast. */
export interface CashPriorRow {
  /** The observation date of the close the row scored (`obs_date`), not its fired timestamp. */
  date: string | null;
  /** The persisted dial `targetRung`; null on pre-migration rows and dial-less/degraded runs. */
  dialTargetRung: number | null;
}

const MS_PER_CALENDAR_DAY = 86_400_000;

/**
 * Rehydrate the acceleration window's PRIORS from persisted alert rows.
 *
 * Input is newest-first (as `getRecentAlerts` returns); **output is MOST RECENT LAST**, matching
 * `CashOverlayState.recentTargetRungs`, and is capped at `CASH_ACCEL_WINDOW - 1` because
 * `computeCashOverlay` appends the current close itself.
 *
 * **Truncate, never skip.** The walk stops at the first row that is either null-runged or outside
 * `CASH_PRIOR_MAX_AGE_DAYS` of its successor — everything older is discarded rather than spliced
 * out. Splicing would make two non-adjacent closes look adjacent, manufacturing a hole-in-the-series
 * false read and inflating `rise`. Truncating shortens the window ⇒ `rise` is smaller-or-equal ⇒ it
 * fails toward `off`, the standing safe direction. The age bound is applied PAIRWISE (each step
 * against the previous accepted close, starting at `asOf`), because a newest-only check would admit
 * a sample from three months back as long as yesterday's row exists.
 *
 * **Why order cannot be tested through the consumer:** `computeCashOverlay` derives
 * `trough = Math.min(...window)`, which is order-insensitive, and at these lengths the trailing
 * slice drops nothing — so a REVERSED window yields an identical `level`, `since`, `rise` and
 * `reason`. The array-equality unit test on this function is the only thing that can catch a
 * reversal; do not replace it with a level assertion.
 */
export function buildCashOverlayWindow(priors: CashPriorRow[], asOf: string): number[] {
  // Two date axes: the store orders/collapses on fired-date, while the age math uses obs_date.
  // Drop rows that are not a PRIOR close, de-dupe obs_date keeping the newest-fired (input is
  // newest-first), then sort defensively so an out-of-order backfill cannot scramble the walk.
  const seen = new Set<string>();
  const candidates: { date: string; dialTargetRung: number | null }[] = [];
  for (const row of priors) {
    const date = row.date;
    if (date == null || date >= asOf) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    candidates.push({ date, dialTargetRung: row.dialTargetRung });
  }
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const out: number[] = [];
  let cursor = asOf;
  for (const row of candidates) {
    if (out.length >= CASH_ACCEL_WINDOW - 1) break;
    if (row.dialTargetRung == null) break;
    // NaN (missing/unparseable date) fails BOTH comparisons ⇒ stop. A non-positive age (a
    // future-dated or same-close row) is rejected too: unexplained state fails safe.
    const ageDays = (Date.parse(cursor) - Date.parse(row.date)) / MS_PER_CALENDAR_DAY;
    if (!(ageDays > 0 && ageDays <= CASH_PRIOR_MAX_AGE_DAYS)) break;
    out.push(row.dialTargetRung);
    cursor = row.date;
  }
  return out.reverse();
}

/** `computeCashOverlay` result — the next persisted state plus the derived level and a legible
 *  reason for the `/lab` surface. The overlay itself can never be `"full"`: that magnitude belongs
 *  to R4 and is only reachable through `resolveCash`. */
export interface CashOverlayResult {
  level: Exclude<CashLevel, "full">;
  since: string | null;
  reason: string;
  /** Vestigial seam, always `null`. W5-b Stage 4.1 sized the claim at `resolveCash` instead — the
   *  posture never enters the TRIGGER, only the sizing of an already-decided claim (§4.3.1
   *  orthogonality). Kept typed `null` so nothing can start writing it here by accident. */
  nonEquityPct: null;
  /** The `targetRung` acceleration window this result was computed against. NOT persisted — the
   *  store writes only `cash_overlay`/`_since`/`_reason`, and `run-core.ts` rebuilds the window from the
   *  persisted `dial_target_rung` rows via `buildCashOverlayWindow` on every run. */
  recentTargetRungs: number[];
}

/** The single merged cash claim the rest of the system reads (§3). */
export interface CashState {
  level: CashLevel;
  /** Non-equity % of the sleeve (DEC-15/(B)): cash AND bond rungs, not cash alone. `null` only when
   *  the posture is degraded — never a fabricated number, mirroring `posture: null`. */
  nonEquityPct: number | null;
  reason: string;
  /** B-22 — WHY an early overlay is being HELD BACK, when it is (both are `level: "off"` states, so
   *  the level alone can't say). `"r4-reentry"` = R4 walking back onto the ladder (D8 whipsaw);
   *  `"v-shape"` = W5-d's v-shaped-fall suppression (`applyFallShape`). `null` on every non-suppressed
   *  claim (partial, plain off, and R4 `full` — which is R4 firing, not a hold). Lets both surfaces
   *  SURFACE the hold instead of silently dropping it. `resolveCashClaim` mirrors this exactly. */
  suppressedBy: "v-shape" | "r4-reentry" | null;
}

/** B-22 — the stable prefix `applyFallShape` (v-bear.ts) stamps on a v-shape-suppressed overlay's
 *  `reason`. Owned HERE (the lowest cash module) so `applyFallShape` imports it without a cycle, and so
 *  the ONE place the marker is authored is the ONE `resolveCash` reads back. `/lab` reads the overlay
 *  straight from persisted columns (no in-process discriminant survives the round-trip), so this prefix
 *  is the only signal it has — `public/cash-overlay-view.js` duplicates the literal across the hand-mirror
 *  and the mirror test drift-guards it by generating a real suppressed overlay through `applyFallShape`. */
export const V_SHAPE_SUPPRESS_PREFIX = "v-shaped fall - early overlay suppressed";

/**
 * Advance the overlay one close.
 *
 * `dial` is nullable so the caller need not branch: a null/absent dial drops toward UNDER-reaction,
 * never a false cash call (the standing `t1dial.ts` convention). Note it CLEARS the window rather
 * than preserving it — a preserved stale low rung would make the next real close look like a large
 * rise, i.e. it would fail toward a FALSE positive, which is the wrong direction here.
 *
 * Pure: `dial` and `prior` are never mutated (the DEC-1 orthogonality guard, pinned by a test).
 */
export function computeCashOverlay(
  dial: T1DialResult | null,
  prior: CashOverlayState,
  clock: () => string,
): CashOverlayResult {
  if (!dial) {
    return { level: "off", since: null, reason: "no dial", nonEquityPct: null, recentTargetRungs: [] };
  }

  // Append this close, keep only the trailing window.
  const window = [...prior.recentTargetRungs, dial.targetRung].slice(-CASH_ACCEL_WINDOW);
  const trough = Math.min(...window);
  const rise = dial.targetRung - trough;
  const active = rise >= CASH_ACCEL_RUNGS;

  if (!active) {
    // Exit persistence is 1 close (D10/DEC-5): a single non-qualifying close ends it, and `since` clears with it;
    // entry and exit both 1 close ⇒ a chattering trigger costs pushes, not money.
    return {
      level: "off",
      since: null,
      reason: `no acceleration (+${rise} over ${window.length} closes)`,
      nonEquityPct: null,
      recentTargetRungs: window,
    };
  }

  // CASH_ENTER_CLOSES = 1: fires on the first qualifying close. `since` is preserved across a
  // continuously-active run so the stamp records the ENTRY, not the latest close.
  return {
    level: "partial",
    since: prior.since ?? clock(),
    reason: `target rung ${trough}→${dial.targetRung} (+${rise}) within ${window.length} closes`,
    nonEquityPct: null,
    recentTargetRungs: window,
  };
}

/**
 * §3 — precedence between the two live cash mechanisms. Total over the R4 × overlay product: no
 * input pair yields two simultaneous cash magnitudes.
 */
export function resolveCash(
  r4: R4Result,
  overlay: CashOverlayResult,
  equityPct: number | null,
): CashState {
  // W5-b §4.3.2 — the STANDING non-equity scalar, live in every state (§8.3: the equity-% distrust
  // does not switch off when the overlay is quiet). `null` propagates the degraded posture rather
  // than fabricating a number. Bounded 0..85 by `EQUITY_PCT` (deepest posture Defensive = 15%
  // equity), which is what keeps 100 reserved for R4 below.
  const standing = equityPct === null ? null : 100 - equityPct;

  // R4 is 100% cash; any early partial is a subset of it, so R4 dominates unconditionally. The 100
  // is authored here rather than derived from `standing`: R4's terminal cash is total BY DEFINITION
  // and does not consult the posture, so it survives a degraded `equityPct`. This is also what makes
  // the total invariant a biconditional — `nonEquityPct === 100` ⟺ `level === "full"` ⟺ `r4.cash`.
  if (r4.cash) return { level: "full", nonEquityPct: 100, reason: r4.reason, suppressedBy: null };

  // Explicit branch, NOT a fallthrough: R4 is already walking back onto the ladder, and an early
  // overlay re-firing here is the whipsaw D8 forbids. This is the only pair where a naive merge
  // (check the overlay first) is wrong. The LEVEL is suppressed; the standing scalar is not —
  // `level === "off"` no longer implies a null scalar, which is §4.3.2's deliberate semantic break.
  if (r4.phase === "reentry") {
    return {
      level: "off",
      nonEquityPct: standing,
      reason: `r4 re-entry - overlay suppressed (${r4.reason})`,
      suppressedBy: "r4-reentry",
    };
  }

  if (overlay.level === "partial") {
    // Sized HERE, not read off the overlay: `CashOverlayResult.nonEquityPct` stays vestigially
    // `null` so the posture never reaches `computeCashOverlay`'s trigger (§4.3.1 orthogonality).
    return { level: "partial", nonEquityPct: standing, reason: overlay.reason, suppressedBy: null };
  }

  // `reason` carries the overlay's own off-reason ("no acceleration (+0 over 2 closes)") even when
  // R4 idleness is what produced the `off` — the overlay is the only mechanism with something to
  // say here, and a legible reason beats null. `resolveCashClaim` (public/cash-overlay-view.js)
  // mirrors this exactly; the parity test pins the pair.
  //
  // B-22 — a plain quiet `off` ("no dial" / "no acceleration") and a v-shape-suppressed `off` are
  // BOTH here; the persisted `reason` prefix is the only thing that tells them apart (a
  // reason-presence gate cannot — a quiet off carries a non-null reason too). r4-reentry never reaches
  // this branch (its own case, above), so the marker match can't conflate the two suppression states.
  return {
    level: "off",
    nonEquityPct: standing,
    reason: overlay.reason,
    suppressedBy: overlay.reason.startsWith(V_SHAPE_SUPPRESS_PREFIX) ? "v-shape" : null,
  };
}

/**
 * R8 Stage 2 — the PUBLISHED cash LEVEL for a run, reconstructed from its persisted alert-row
 * columns (`r4_phase`, `cash_overlay`), for the surfaces that hold no live
 * `R4Result`/`CashOverlayResult`: the read path (`api/exposure.ts`) and the push bind
 * (`run-cycle.ts`'s `boundExposureForPush`).
 *
 * It exists so the overlay step-down's trigger is decided by `resolveCash`'s precedence on BOTH R8
 * surfaces rather than by a re-derived `overlay.level === "partial"` test on the read side: the
 * precedence is what makes an R4 `full`, and an overlay suppressed by an R4 re-entry, NOT move the
 * posture.
 *
 * ⚠ It returns the LEVEL ALONE, deliberately — never the `CashState`. Both shapes below are
 * FABRICATED from two persisted enums, which is strictly WIDER than the `notify_format.ts`
 * precedent (that one fabricates a `CashOverlayResult` only and passes the LIVE `R4Result`,
 * `opts.r4 ?? R4_RESTING`); a whole `R4Result` synthesized from a phase string carries an invented
 * `reason`. And the overlay `reason` is NOT inert: `resolveCash` reads it on the `off` path to
 * derive `suppressedBy` from `V_SHAPE_SUPPRESS_PREFIX`, so a v-shape-suppressed row would
 * reconstruct here as a plain quiet `off` with `suppressedBy: null`. Returning the one field the
 * fabrication CAN honour keeps the two it cannot (`reason`, `suppressedBy`) out of every caller's
 * reach, rather than handing back a full-fidelity-LOOKING claim with two fields silently wrong.
 * (`/lab` renders the row's own `cash_overlay_reason`; nothing reconstructs it from here.)
 */
export function resolvePersistedCashLevel(
  r4Phase: R4Phase | null,
  overlayLevel: Exclude<CashLevel, "full">,
  equityPct: number | null,
): CashLevel {
  const phase: R4Phase = r4Phase ?? "equity";
  return resolveCash(
    { cash: phase === "cash", phase, entryFiredAt: null, reentryRung: null, reason: "persisted r4 phase" },
    { level: overlayLevel, since: null, reason: "persisted overlay", nonEquityPct: null, recentTargetRungs: [] },
    equityPct,
  ).level;
}
