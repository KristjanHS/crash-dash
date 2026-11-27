/**
 * VIX bottom-signal track — a
 * third, fully ISOLATED off-ladder track that reads the SAME instrument (VIX) in
 * the OPPOSITE direction from the fast ladder's R5 risk modifier: an extreme,
 * peaking-and-receding VIX is a capitulation / exhaustion marker — "fear may be
 * peaking, downside risk remains" (never "buy now").
 *
 * This module is pure (no IO, no time): every function takes an already-fetched,
 * date-aligned TermPoint[] and returns plain data. It imports ONLY domain-fold/domain-types
 * helpers (confirmedSeries, CONFIRM_CLOSES) and is NEVER imported by
 * the alert-band engine, so it structurally cannot move the fast alert band (§5
 * isolation contract) — imported ONLY by bottom_tier.ts, tracks.ts, store.ts. Its
 * vocabulary (CALM / CAPITULATION-WATCH / BOTTOM-FORMING) is disjoint from the fast
 * AlertLevel; tuning one track cannot move the other. Alert-ladder EARLINESS lives
 * elsewhere — the indicator band cuts (registry-*.ts/scorers-*.ts), the 2-close confirmation
 * buffer (deriveConfirmedState), and the per-mode thetas — NOT in these constants.
 *
 * The falling-knife guard (§2): a bottom needs TWO independent facets of the vol
 * surface to RECEDE, not a bare level cross — (1) spot rollover off a trailing high
 * and (2) term-structure backwardation easing back toward contango — both folded
 * through the standard CONFIRM_CLOSES buffer.
 *
 * Thresholds below are ASSERTED defaults ("argued, not validated") — there are only
 * a handful of true NDX troughs in history, a rare-event problem no parameter search
 * can overfit. Stage 0/7 harness trough-calibration is a committed follow-up.
 */

import { CONFIRM_CLOSES } from "./domain-types.js";
import { confirmedSeries } from "./domain-fold.js";
import type { TermPoint } from "./vix_term.js";

// --- Tunable constants (§3.3 — exported so the harness can sweep them) ----------
// VIX_CAP/ROLLOVER_K/BACKWARD_CUT set to the Stage-7 FP-min winner (T4 applied 2026-06-30):
// mean-FP 0.25 vs the prior 40/0.85/1.0 centre's 0.33, DSR/PBO gate PASSES (pbo=0.397,
// dsr=1.000). Still "argued, not statistically validated" — ~5 NDX troughs, 0.5pp margin over
// the runner-up. Provenance: scripts/backtest/calibration.json `bottom_sweep`.

/** Capitulation zone: front VIX at/above this absolute level. */
export const VIX_CAP = 35;
/** Backwardation cut: VIX/VIX3M ratio at/above this means fear is priced near-term. */
export const BACKWARD_CUT = 1.05;
/** Spot-rollover trigger: VIX ≤ ROLLOVER_K × trailing-HIGH_WIN-day high (spike crested). */
export const ROLLOVER_K = 0.9;
/** Trailing window (trading days) for the rollover high. */
const HIGH_WIN = 10;
/** "Capitulation reached recently" memory window (trading days). */
const LOOKBACK = 20;
/** Backwardation-easing confirm: ratio dropped ≥ EASE_DELTA over EASE_CLOSES closes. */
const EASE_DELTA = 0.05;
const EASE_CLOSES = 3;

// --- Swept-parameter bundle (§3.3, Stage 7) ------------------------------------

/**
 * The full tunable set the scorer reads, so the Stage-7 harness can replay the EXACT
 * rule under swept values without touching the module consts. `bottomRawStateSeries`/
 * `scoreBottom` take an optional `BottomParams` defaulting to
 * `BOTTOM_DEFAULTS` (the exported consts above) — so every prod caller is byte-for-byte
 * unchanged (zero behavior change); only the replay sweep passes a non-default set. The
 * Stage-7 grid varies only `vixCap`/`rolloverK`/`backwardCut`; the window params stay at
 * their defaults, so window alignment and the min-obs gate are constant across the sweep.
 */
export interface BottomParams {
  vixCap: number;
  backwardCut: number;
  rolloverK: number;
  highWin: number;
  lookback: number;
  easeDelta: number;
  easeCloses: number;
}

export const BOTTOM_DEFAULTS: BottomParams = {
  vixCap: VIX_CAP,
  backwardCut: BACKWARD_CUT,
  rolloverK: ROLLOVER_K,
  highWin: HIGH_WIN,
  lookback: LOOKBACK,
  easeDelta: EASE_DELTA,
  easeCloses: EASE_CLOSES,
};

/**
 * Minimum aligned points for a param set: a full lookback window plus the confirm buffer.
 * CONFIRM_CLOSES is deliberately NOT part of BottomParams (the plan fixes it at the reused
 * 2; §3.3) — it is added here as the constant tail, not swept.
 */
export const minBottomObs = (params: BottomParams = BOTTOM_DEFAULTS): number =>
  params.lookback + CONFIRM_CLOSES;

/**
 * Load-time window-ordering invariants (§3.3): the rollover/easing windows must fit
 * inside the LOOKBACK memory, and ROLLOVER_K must be a genuine drawdown fraction.
 * A bad edit trips this at import, not silently at runtime.
 */
if (!(HIGH_WIN <= LOOKBACK)) throw new Error(`bottom: HIGH_WIN(${HIGH_WIN}) must be ≤ LOOKBACK(${LOOKBACK})`);
if (!(EASE_CLOSES <= LOOKBACK)) throw new Error(`bottom: EASE_CLOSES(${EASE_CLOSES}) must be ≤ LOOKBACK(${LOOKBACK})`);
if (!(ROLLOVER_K > 0 && ROLLOVER_K < 1)) throw new Error(`bottom: ROLLOVER_K(${ROLLOVER_K}) must be in (0,1)`);
if (!(BACKWARD_CUT > 0)) throw new Error(`bottom: BACKWARD_CUT(${BACKWARD_CUT}) must be > 0`);
if (!(VIX_CAP > 0)) throw new Error(`bottom: VIX_CAP(${VIX_CAP}) must be > 0`);

// --- Types ---------------------------------------------------------------------

/**
 * The bottom-track state, ranked for the notify-on-upward-change logic. Deliberately
 * disjoint from the fast AlertLevel and the slow SlowBand so the three tracks can
 * never be confused.
 */
export type BottomState = "CALM" | "CAPITULATION-WATCH" | "BOTTOM-FORMING";

/** Canonical CALM<CAPITULATION-WATCH<BOTTOM-FORMING ordering — harness/test-only
 *  (asserts state monotonicity). The LIVE notify-on-state-change ranks are
 *  `BOTTOM_TIER.bands[*].rank` in bottom_tier.ts; this const does not feed the run loop (`run-*.ts`). */
export const BOTTOM_STATE_RANK: Record<BottomState, number> = {
  CALM: 0,
  "CAPITULATION-WATCH": 1,
  "BOTTOM-FORMING": 2,
};

export interface BottomVerdict {
  state: BottomState; // confirmed (through CONFIRM_CLOSES)
  rawState: BottomState; // latest unconfirmed (observability / harness)
  vix: number; // latest front level
  vix3m: number; // latest 3-month level
  ratio: number; // latest vix / vix3m
  asOf: string; // latest aligned date
}

/** Minimum aligned points to score: a full LOOKBACK window plus the confirm buffer. */
export const MIN_BOTTOM_OBS = LOOKBACK + CONFIRM_CLOSES;

// The confirm fold is generic (`confirmedSeries<T>`, domain-fold.ts) — it is pure equality
// + run-length and never reads STATE_RANK — so BottomState[] folds directly, with no
// State bridge (the generalization replaced the former STATE_OF/BOTTOM_OF maps;
// /qimpag 2026-06-29).

// --- Raw state series ----------------------------------------------------------

/**
 * Per-day raw (unconfirmed) bottom state over the date-aligned series, aligned to
 * `points[LOOKBACK..]` (mirrors derivedRawStateSeries's window alignment) so the harness
 * can replay the EXACT rule. At each day i:
 *
 *   - CAPITULATION-WATCH: VIX ≥ VIX_CAP AND ratio ≥ BACKWARD_CUT (acute panic now).
 *   - BOTTOM-FORMING (higher rank, checked first): the capitulation zone was reached
 *     on some day in the trailing LOOKBACK window AND the spike is now receding —
 *       (a) spot rollover: VIX ≤ ROLLOVER_K × max(VIX over trailing HIGH_WIN days), AND
 *       (b) term-structure easing: ratio < BACKWARD_CUT, OR ratio dropped ≥ EASE_DELTA
 *           over the last EASE_CLOSES closes.
 *   - CALM: neither.
 *
 * BOTTOM-FORMING is tested before CAPITULATION-WATCH so a still-elevated-but-rolling
 * day resolves to the higher-rank receding read. Pure: no IO. `params` defaults to
 * `BOTTOM_DEFAULTS` (the exported consts) — a prod call is identical to the pre-Stage-7
 * behavior; only the harness sweep passes a non-default set.
 */
export function bottomRawStateSeries(points: TermPoint[], params: BottomParams = BOTTOM_DEFAULTS): BottomState[] {
  const { vixCap, backwardCut, rolloverK, highWin, lookback, easeDelta, easeCloses } = params;
  // Window-ordering guard for a NON-default bundle (the module consts are validated at
  // import; a swept/constructed BottomParams is validated here). highWin/easeCloses must
  // fit inside the lookback window or the trailing-window indexing below underflows — at
  // highWin == lookback+1 it would silently read the WRONG element (corrupt sweep result,
  // no crash); beyond that, a negative subscript crashes. A clean throw beats either. The
  // Stage-7 grid keeps the windows at their defaults, so prod/replay never trip this; the
  // guard exists to fail a future bad caller loudly rather than emit wrong calibration.
  if (highWin > lookback) throw new Error(`bottom: highWin(${highWin}) must be ≤ lookback(${lookback})`);
  if (easeCloses > lookback) throw new Error(`bottom: easeCloses(${easeCloses}) must be ≤ lookback(${lookback})`);
  const states: BottomState[] = [];
  const inCapZone = (i: number) => points[i]!.vix >= vixCap && points[i]!.ratio >= backwardCut;

  for (let i = lookback; i < points.length; i++) {
    // (1) capitulation reached anywhere in the trailing lookback window (incl. today).
    let capRecently = false;
    for (let j = i - lookback + 1; j <= i; j++) {
      if (inCapZone(j)) {
        capRecently = true;
        break;
      }
    }

    // (2a) spot rollover off the trailing highWin-day VIX high.
    let high = points[i - highWin + 1]!.vix;
    for (let j = i - highWin + 2; j <= i; j++) {
      if (points[j]!.vix > high) high = points[j]!.vix;
    }
    const rollover = points[i]!.vix <= rolloverK * high;

    // (2b) term-structure backwardation easing back toward contango.
    const ratioNow = points[i]!.ratio;
    const easedDelta = points[i - easeCloses]!.ratio - ratioNow >= easeDelta;
    const easing = ratioNow < backwardCut || easedDelta;

    if (capRecently && rollover && easing) {
      states.push("BOTTOM-FORMING");
    } else if (inCapZone(i)) {
      states.push("CAPITULATION-WATCH");
    } else {
      states.push("CALM");
    }
  }
  return states;
}

// --- Confirmed scoring ---------------------------------------------------------

/**
 * Confirmed bottom state from the date-aligned series: the raw per-day states folded
 * through the standard CONFIRM_CLOSES buffer (the generic `confirmedSeries<BottomState>`
 * fold) so a one-day head-fake doesn't fire. Throws if there
 * aren't enough aligned points for a full window + confirm. Pure.
 *
 * For harness / test use. The live path gates short/empty history to a null verdict in
 * `scoreBottomTrack` (tracks.ts) before `computeBottomVerdict` runs.
 */
export function scoreBottom(points: TermPoint[], params: BottomParams = BOTTOM_DEFAULTS): BottomState {
  const minObs = minBottomObs(params);
  if (points.length < minObs) {
    throw new Error(`[bottom] need ${minObs} aligned points, got ${points.length}`);
  }
  return confirmedSeries(bottomRawStateSeries(points, params), CONFIRM_CLOSES).at(-1)!;
}

/**
 * The full off-ladder verdict: confirmed state + the latest headline numbers (VIX,
 * VIX3M, ratio, as-of date) that drive it. Pure: no IO, no time. Fewer than
 * MIN_BOTTOM_OBS aligned points yields a CALM fallback — harness/test-only; the live
 * path gates short/empty history to null in `scoreBottomTrack` (tracks.ts) first.
 */
export function computeBottomVerdict(points: TermPoint[]): BottomVerdict {
  const latest = points[points.length - 1];
  if (!latest || points.length < minBottomObs(BOTTOM_DEFAULTS)) {
    return {
      state: "CALM",
      rawState: "CALM",
      vix: latest?.vix ?? NaN,
      vix3m: latest?.vix3m ?? NaN,
      ratio: latest?.ratio ?? NaN,
      asOf: latest?.date ?? "",
    };
  }
  const raw = bottomRawStateSeries(points, BOTTOM_DEFAULTS);
  return {
    state: confirmedSeries(raw, CONFIRM_CLOSES).at(-1)!,
    rawState: raw[raw.length - 1]!,
    vix: latest.vix,
    vix3m: latest.vix3m,
    ratio: latest.ratio,
    asOf: latest.date,
  };
}
