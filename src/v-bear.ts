/**
 * W5-d — live V-shaped-vs-bear discriminator (DEC-3).
 *
 * Classifies a live equity fall as **V-shaped** or **bear** from two live inputs — drawdown
 * *velocity* (how fast the fall arrived) and *credit dwell* (how long credit has stayed RED) —
 * with no fitted constants. Every cut below is DERIVED FROM AN EXISTING SYMBOL, never chosen by
 * looking at DEC-3's episode table; a session that "improves" a cut by matching that table has
 * broken this rung's central discipline.
 *
 * Pure: no store, no fetch. Inputs are exactly what `fetchDailyCloses` / `getSeries` return.
 *
 * THE LOAD-BEARING PROPERTY: of the three states, exactly ONE (`v-shaped`) diverges from today's
 * behaviour. `bear` and `indeterminate` both mean "act as today", so a dead feed, a short DB, a
 * clipped peak, or disagreeing inputs all land on today's behaviour STRUCTURALLY — not via a
 * fallback branch that could itself be wrong.
 */
import { drawdownSeries, PENSION_DIP } from "./pension.js";
import { VELOCITY_WINDOW, type State } from "./domain-types.js";
// Type-only, both of them → no runtime edge into families.ts / r4.ts (families.ts is a low view-type
// module and r4.ts owns the phase union; the chip builder below is the only consumer here).
import type { LabFloorChip } from "./families.js";
import type { R4Phase } from "./r4.js";
import { ARM_ROC_WINDOW } from "./exposure.js";
import type { SeriesPoint } from "./store.js";
// Type-only (erased at runtime) → no runtime cycle, even though cash-overlay.ts pulls in t1dial.ts.
import { V_SHAPE_SUPPRESS_PREFIX, type CashOverlayResult } from "./cash-overlay.js";

/** Three-state class. Only `v-shaped` changes behaviour; the other two are today's behaviour. */
export type FallShape = "v-shaped" | "bear" | "indeterminate";

/**
 * Drawdown-per-trading-day at or past which a fall counts as FAST (≤, i.e. more negative).
 *
 * Derivation, by symbol: *the shallowest drawdown this repo calls meaningful (`PENSION_DIP`),
 * completed inside the one window every velocity measure in this repo uses (`VELOCITY_WINDOW`).*
 *
 * ⚠ NAME COLLISION, CHECKED — `domain-types.ts`'s `VELOCITY_WINDOW` is the *indicator* velocity lookback
 * (`delta20 = v[i] − v[i−20]`), a DIFFERENT quantity on a different series. W5-d borrows it purely
 * as a derivation denominator, never as a lookback. Do not unify the two concepts.
 */
export const V_VELOCITY_CUT = PENSION_DIP / VELOCITY_WINDOW;

/**
 * Minimum drawdown before we classify at all. Velocity is noise at `dd ≈ 0`, so shallower than
 * `PENSION_DIP` there is no fall to classify ⇒ `indeterminate` ⇒ today's behaviour. Same symbol as
 * `V_VELOCITY_CUT`'s numerator, so the engagement point and the cut are one decision, not two.
 */
export const V_MIN_DRAWDOWN = PENSION_DIP;

/**
 * Consecutive confirmed-RED credit closes at or past which credit is GRINDING (≥).
 *
 * Derivation, by symbol: `ARM_ROC_WINDOW` is the window over which the ARM key measures a *fast
 * turn* in credit. Credit RED that has OUTLASTED that window is no longer a turn — it is a level.
 * That is the executable form of DEC-3's "a V repairs credit in weeks; a bear grinds for months."
 */
export const BEAR_DWELL_CLOSES = ARM_ROC_WINDOW;

/**
 * The live V-vs-bear path's F1/F2 series bound. Single-sourced HERE (the pure engine both the
 * cron caller and any later reader import) so the `store.getSeries` read and the post-merge
 * re-slice in `run-core.ts`'s `seedSeriesWithRun` can never drift — the same pattern
 * `EXPOSURE_F1_LIMIT` (`exposure.ts`) establishes, and the drift IS the bug the re-slice fixes.
 *
 * `BEAR_DWELL_CLOSES` is the depth `creditDwellCloses` actually needs; the +10 pad covers
 * publication-lag / holiday slack so a live run is not pushed under the short-history null by a
 * calendar artifact.
 */
export const V_BEAR_F_LIMIT = BEAR_DWELL_CLOSES + 10;

/**
 * The one-line kill switch (requirement (b) of the 2026-07-20 ruling). Set `false` and
 * `applyFallShape` becomes the identity function: the class is still computed, persisted and
 * rendered, it simply steers nothing, and the dial returns to today's behaviour.
 *
 * **Flipped `true` at Stage 5.1** — the ONE behaviour-changing commit, which also wires the single
 * `applyFallShape` call in `run-core.ts`. Its falsifier-3 proves the flip is load-bearing: with this back at
 * `false`, `run.exposure.test.ts`'s "a v-shaped fall SUPPRESSES a firing cash overlay" goes red on the `level`
 * assertion (it stays 'partial'). A kill switch nobody proved can flip behaviour is decorative.
 */
export const V_BEAR_INFLUENCE_ENABLED = true;

interface FallVelocity {
  /** Trailing-peak drawdown at the last close, in [−1, 0]. */
  dd: number;
  /** `dd / closesSincePeak` — drawdown per trading day. Negative while falling. */
  velocity: number;
  /** Closes elapsed since the trailing peak. `0` when the last close IS the peak. */
  closesSincePeak: number;
  /**
   * The window OPENS on its own highest close, so the true peak may predate the window and both
   * `dd` and `velocity` are untrustworthy. See the clip invariant on `fallVelocity`.
   */
  peakClipped: boolean;
}

/**
 * Drawdown velocity of `closes` (oldest-first), measured from its trailing peak.
 *
 * ⚠ CLIP INVARIANT — the lookback (`LOOKBACK_DAYS = 400`, ≈275 closes) cannot hold a 2008-shaped
 * ~350-trading-day decline PLUS its peak, so on such a grind the trailing peak is clipped.
 *
 * The clip is NOT self-correcting, and the plan's original claim that it is was measured FALSE:
 * a clipped peak shallows `dd` (true) but drops `closesSincePeak` faster than it drops `dd`, so
 * the measured velocity comes out LARGER in magnitude — i.e. toward `v-shaped`, the one class that
 * changes behaviour. Measured inflation on a 2008 shape (−55 % over 350 closes, clipped to 275):
 * `dd` −0.550 → −0.489 but velocity −0.00157 → −0.00178, a 1.14× push toward the cut.
 *
 * The margin absorbs it today (bears sit 4–8× short of `V_VELOCITY_CUT`), but a margin is not the
 * structural guarantee the 2026-07-20 ruling (c) requires. So `peakClipped` makes it structural:
 * a window that opens on its own high cannot be trusted to hold the peak, and
 * `classifyFallShape` sends it to `indeterminate` ⇒ today's behaviour.
 *
 * @returns `null` when there are no closes (feed down) — never a number from no data.
 */
export function fallVelocity(closes: number[]): FallVelocity | null {
  if (closes.length === 0) return null;

  const dds = drawdownSeries(closes);
  const lastIdx = dds.length - 1;
  const dd = dds[lastIdx]!;

  // The trailing peak is the LAST new high: `drawdownSeries` resets to 0 exactly there.
  let peakIdx = 0;
  for (let i = 0; i <= lastIdx; i++) {
    if (dds[i] === 0) peakIdx = i;
  }

  const closesSincePeak = lastIdx - peakIdx;
  // At the peak there is no fall, so no velocity — 0, not a divide-by-zero.
  const velocity = closesSincePeak > 0 ? dd / closesSincePeak : 0;
  // The window opened on its own high ⇒ the real peak may lie before it (a decline longer than
  // the lookback). Only a monotone-ish whole-window grind produces this; a genuine V has ample
  // pre-peak history inside 400 days, so the guard costs it nothing.
  const peakClipped = peakIdx === 0 && closes.length > 1;
  return { dd, velocity, closesSincePeak, peakClipped };
}

/** Count consecutive confirmed-RED closes at the head (newest end) of one id's history. */
function tailRedRun(points: SeriesPoint[]): number {
  let run = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.state !== "RED") break;
    run++;
  }
  return run;
}

/**
 * Consecutive confirmed-RED credit closes, taking the MAX over F1/F2 — matching
 * `escalatorFloorDetail`'s existing `creditBlowout` predicate ("EITHER F1 or F2 confirmed RED")
 * exactly, so the system's two credit predicates cannot drift.
 *
 * Inputs are `getSeries` output: OLDEST-FIRST, so the newest close is the last element.
 *
 * ⚠ SHORT-HISTORY NULL — this is why the DB path is admissible at all. A history shorter than
 * `BEAR_DWELL_CLOSES` would report a small dwell, which reads as `v-shaped` — the one class that
 * CHANGES behaviour. Wrong direction. So **EITHER id being short nulls the whole verdict**
 * ⇒ `indeterminate` ⇒ today's behaviour. Never a number derived from a short window.
 *
 * ⚠ The dangerous case is a short id being EXCLUDED, not one dragging the max down. An earlier
 * per-id filter kept the qualifying id's dwell and dropped the short one: with F1 60 closes all
 * GREEN and F2 29 closes ALL RED, it reported "credit RED only 0 closes" and classified
 * `v-shaped` — the behaviour-changing state, on evidence that says the opposite. F1/F2 backfill
 * depth can legitimately diverge, so that was reachable, not theoretical.
 */
export function creditDwellCloses(f1: SeriesPoint[], f2: SeriesPoint[]): number | null {
  if (f1.length < BEAR_DWELL_CLOSES || f2.length < BEAR_DWELL_CLOSES) return null;
  return Math.max(tailRedRun(f1), tailRedRun(f2));
}

export interface FallShapeVerdict {
  shape: FallShape;
  /** Measured drawdown velocity, or `null` when no fall was measurable. */
  velocity: number | null;
  /** Measured credit dwell, or `null` on a short history. */
  dwell: number | null;
  /** Human-readable why, surfaced on `/lab` and (via the overlay) on the push. */
  reason: string;
}

/**
 * Classify the current fall. TOTAL over the input product — every combination of "no closes",
 * "too shallow", "short credit history", and the two inputs agreeing or disagreeing has a row.
 *
 * @param closes ACWI daily closes, oldest-first (the account's benchmark — the rotation runs in an
 *   LHV PIK benchmarked to Tuleva ACWI, so "has the fall already happened to me" is an ACWI
 *   question, not an SPX one).
 * @param f1 F1 credit-spread history, oldest-first.
 * @param f2 F2 credit-spread history, oldest-first.
 */
export function classifyFallShape(
  closes: number[],
  f1: SeriesPoint[],
  f2: SeriesPoint[],
): FallShapeVerdict {
  const fall = fallVelocity(closes);
  if (fall === null) {
    return { shape: "indeterminate", velocity: null, dwell: null, reason: "no closes" };
  }

  if (fall.dd > V_MIN_DRAWDOWN) {
    return {
      shape: "indeterminate",
      velocity: fall.velocity,
      dwell: null,
      reason: `drawdown ${pct(fall.dd)} shallower than ${pct(V_MIN_DRAWDOWN)} - no fall to classify`,
    };
  }

  if (fall.peakClipped) {
    return {
      shape: "indeterminate",
      velocity: fall.velocity,
      dwell: null,
      reason: `window opens on its own high - trailing peak may be clipped, ${pct(fall.dd)} untrustworthy`,
    };
  }

  const dwell = creditDwellCloses(f1, f2);
  if (dwell === null) {
    return {
      shape: "indeterminate",
      velocity: fall.velocity,
      dwell: null,
      reason: `credit history shorter than ${BEAR_DWELL_CLOSES} closes - dwell unmeasurable`,
    };
  }

  const fast = fall.velocity <= V_VELOCITY_CUT;
  const grinding = dwell >= BEAR_DWELL_CLOSES;

  if (fast && !grinding) {
    return {
      shape: "v-shaped",
      velocity: fall.velocity,
      dwell,
      reason: `fall ${pctPerDay(fall.velocity)} past ${pctPerDay(V_VELOCITY_CUT)} with credit RED only ${dwell} closes`,
    };
  }
  if (!fast && grinding) {
    return {
      shape: "bear",
      velocity: fall.velocity,
      dwell,
      reason: `fall ${pctPerDay(fall.velocity)} short of ${pctPerDay(V_VELOCITY_CUT)} with credit RED ${dwell} closes`,
    };
  }
  return {
    shape: "indeterminate",
    velocity: fall.velocity,
    dwell,
    reason: `velocity ${pctPerDay(fall.velocity)} and credit dwell ${dwell} closes disagree`,
  };
}

/**
 * All four confidence keys the persisted triple can express, most- to least-informative.
 * The VALUE is the list and the TYPE is derived from it (the `LEG_ATTRIBUTION_DECLINED_REASONS`
 * pattern in `families.ts`), so a fifth key cannot be added without `FALL_SHAPE_CONFIDENCE_COPY`
 * (a total `Record`) and the wire enum's contract pin noticing.
 */
export const FALL_SHAPE_CONFIDENCE_VALUES = ["measured", "conflicting", "no-fall", "dark"] as const;

/**
 * WHY `indeterminate` was reached — a FIRST-CLASS wire key, not copy ([USER] ruling Q1,
 * 2026-07-26). `indeterminate` is reachable from five branches of `classifyFallShape`, and exactly
 * one of them (velocity-vs-dwell disagreement) means "the two axes CONFLICT" rather than "nothing
 * was measured". Rendering all five as the bare word `indeterminate` hid that difference.
 *
 * A consumer branches on THIS key and never re-derives the split from `velocity == null`.
 */
export type FallShapeConfidence = (typeof FALL_SHAPE_CONFIDENCE_VALUES)[number];

/**
 * The one-line copy per key. Total by type, so a new key is a compile error here.
 *
 * ⚠ NONE of these four may read as reassurance ([USER] ruling, 2026-07-26): a bare `no-fall` or
 * `dark` renders as "all clear", which is the exact failure mode the ruling forbids — an absent
 * measurement is silence, never a calm read. `conflicting` must say the two axes DISAGREE and that
 * a bear is NOT excluded, because it is the one key that carries live evidence on both axes.
 */
export const FALL_SHAPE_CONFIDENCE_COPY: Record<FallShapeConfidence, string> = {
  measured: "both axes measured and agreeing",
  conflicting: "velocity and credit dwell DISAGREE - a bear is NOT excluded",
  "no-fall": "no classifiable fall (too shallow / clipped peak / short credit history) - not an all-clear",
  dark: "no closes - the price feed is dark, so nothing was measured; not a calm read",
};

/**
 * Stage 5.1 — how much the persisted `fall_shape` is actually WORTH, derived from the persisted
 * triple ALONE (`fall_shape` / `fall_velocity` / `credit_dwell_closes`).
 *
 * ⚠ **Never a read-time recompute.** The persisted `reason` string is not stored, so this is the
 * only way back to WHICH `indeterminate` branch fired — and re-running `classifyFallShape` at read
 * time would fetch a different vintage than the class that was live at push time (the standing
 * `fallShapeView` rule, `src/lab-overlays.ts`). Hence: TOTAL over the triple, pure, no IO.
 *
 * TOTALITY, by row (the ruled Stage 5.1 table — verified against `classifyFallShape`'s five
 * `indeterminate` branches before it was written; `dwell != null` is reachable ONLY from the
 * disagreement branch, which is what makes `conflicting` discriminable at all):
 *
 * | persisted triple                                        | key            |
 * |---------------------------------------------------------|----------------|
 * | `shape !== "indeterminate"`                             | `measured`     |
 * | `indeterminate` && `dwell != null`                      | `conflicting`  |
 * | `indeterminate` && `velocity != null` && `dwell == null`| `no-fall`      |
 * | `indeterminate` && `velocity == null`                   | `dark`         |
 *
 * The row ORDER is the spec: `dwell != null` outranks the `velocity == null` row, so a triple with
 * a dwell but no velocity (which `classifyFallShape` cannot emit) still reads `conflicting` rather
 * than falling through to `dark`.
 */
export function fallShapeConfidence(
  shape: FallShape,
  velocity: number | null,
  dwell: number | null,
): FallShapeConfidence {
  if (shape !== "indeterminate") return "measured";
  if (dwell != null) return "conflicting";
  if (velocity != null) return "no-fall";
  return "dark";
}

/**
 * NF-1 Stage 6.1 — the fall-shape CHIP pair for the `r4` floor head, server-toned.
 *
 * Two chips, never one merged ([USER] ruling Q2, 2026-07-26): a SHAPE chip then a CONFIDENCE chip,
 * each carrying its OWN tone, because `conflicting` is emphatic no matter which shape sits beside it
 * (`indeterminate` + `conflicting` = "the axes disagree", which is the opposite of an all-clear) —
 * one merged chip would have to pick a single tone and would lose exactly that.
 *
 * Tone discipline: `bear` is the only AMBER shape and `conflicting` the only AMBER confidence;
 * everything else is QUIET (no RAG state), never GREEN — an absent measurement must not borrow
 * green's reassurance. Lives HERE, beside `FALL_SHAPE_CONFIDENCE_COPY`, so the FE mirrors nothing.
 */
const FALL_SHAPE_CHIP: Record<FallShape, { label: string; state?: State; title: string }> = {
  "v-shaped": {
    label: "V-shaped",
    state: "GREEN",
    title: "fall shape: V-shaped - a fast drawdown that snapped back; measured, and NOT the bear grind",
  },
  bear: {
    label: "bear",
    state: "AMBER",
    title: "fall shape: bear - a grinding drawdown with credit dwelling non-GREEN; the shape that has historically kept falling",
  },
  indeterminate: {
    label: "unclear",
    title: "fall shape: indeterminate - no shape could be classified from the persisted run; read the confidence chip beside it for WHY, and never as an all-clear",
  },
};

/** Confidence → its chip. Total by type. The label is SHORT (it rides a floor head); the full
 *  sentence is the hover, single-sourced from `FALL_SHAPE_CONFIDENCE_COPY` so the two cannot drift.
 *  `conflicting`'s label states the CONFLICT in words — the whole point of Stage 5/6 is that this
 *  case can never render as the bare word `indeterminate`. */
const FALL_CONFIDENCE_CHIP: Record<FallShapeConfidence, { label: string; state?: State }> = {
  measured: { label: "measured" },
  conflicting: { label: "AXES DISAGREE", state: "AMBER" },
  "no-fall": { label: "no fall measured" },
  dark: { label: "feed dark" },
};

/**
 * The chips for `LabBandFloor.chips` on the `r4` floor, or `[]` while the breaker is ON the ladder.
 *
 * ⚠ **The predicate is `phase !== "equity"` — population `{cash, reentry}`, never `cash` alone.**
 * A `cash`-only promotion goes dark for the WHOLE re-entry walk, which is the stretch where the fall
 * shape matters most (it is the evidence for whether re-risking into the fall is sane). NF-1 finding
 * (c); pinned through the render by `public/band-panel.test.js` (both phases), with a red demo.
 */
export function fallShapeChips(
  phase: R4Phase,
  shape: FallShape,
  confidence: FallShapeConfidence,
): LabFloorChip[] {
  if (phase === "equity") return [];
  const s = FALL_SHAPE_CHIP[shape];
  const c = FALL_CONFIDENCE_CHIP[confidence];
  return [
    { label: s.label, ...(s.state ? { state: s.state } : {}), title: s.title },
    {
      label: c.label,
      ...(c.state ? { state: c.state } : {}),
      title: `confidence: ${confidence} - ${FALL_SHAPE_CONFIDENCE_COPY[confidence]}`,
    },
  ];
}

/**
 * W5-e — the drawdown-gate **PROBE**. Measurement only; it steers NOTHING.
 *
 * ⚠ **PROBE, NOT A GATE.** `run-core.ts`'s rung seam (`src/run-core.ts`, the `rungOf`/`prevHeld`/`decideRotationHold`
 * block) and `decideRotationHold` (`src/rotation-commit.ts`) are untouched by W5-e, and no caller of this
 * function may change behaviour. The 2026-07-20 ruling that made W5-e measure-first also fixed where
 * a clamp would live IF one is ever promoted: **inside `decideRotationHold`, via a new input flag** — not a
 * post-clamp in `run-core.ts`, not a separate module (deferred **D-1**). Promotion is a USER decision
 * gated on the probe's measured frequency; nothing here may pre-empt it.
 *
 * **The derivation.** `classifyFallShape` above applies the −15% drawdown gate as its own first
 * substantive branch: `fall.dd > V_MIN_DRAWDOWN` returns `indeterminate` ("shallower than … — no
 * fall to classify"), and `fall.peakClipped` returns `indeterminate` immediately after. Therefore a
 * non-`indeterminate` shape **implies** `dd <= V_MIN_DRAWDOWN && !peakClipped`, and the whole gate
 * collapses to `shape !== "indeterminate"`. No new column, no re-computation at read time — the
 * already-persisted `fall_shape` carries it. The implication is a property that can DEEP-LAG (a future
 * branch returning `"bear"` without passing the dd test would break it silently), so the test pins
 * it through the REAL `classifyFallShape`, never through this one-liner.
 *
 * ⚠ **The clip hazard, at THIS call site (E-3).** `dd` is measured inside the 400-day price lookback
 * (`LOOKBACK_DAYS`, `prices.ts`; see the clip invariant on `fallVelocity` above), which makes a
 * long grind's `dd` **SHALLOWER** than nominal — so the probe engages **LATER** than a true −15%.
 * **For a probe this UNDERSTATES firing frequency.** Note the direction flip: E-3 was written
 * against a *suppression gate*, where the same clip would have been permissive; here it is
 * conservative. Any promotion decision must read the measured number as a **lower bound**.
 *
 * **Fail OFF (E-4/E-5).** `indeterminate` reads `false` — from ANY of its five branches, including
 * `fallVelocity` returning `null` on a dead feed, a short credit history, and velocity-vs-dwell
 * disagreement. Never a `true` derived from absent data.
 */
export function drawdownGateWouldFire(shape: FallShape): boolean {
  return shape !== "indeterminate";
}

/**
 * The `OverlayView.fields[].label` under which `fallShapeView` (src/lab-overlays.ts) ships
 * `drawdownGateWouldFire`'s verdict across the wire.
 *
 * SINGLE SOURCE, and it lives beside the gate rather than at the wire edge because the FE reads the
 * field BY LABEL: `public/overlay-strip.js` looks the row up with `overlayFieldValue(view, …)` to
 * paint the always-visible dd-gate line (small-wins §3). A browser ESM module cannot import from
 * `src/`, so that module carries its own literal — `public/overlay-strip.test.js` imports THIS
 * constant and pins the pair, which is the only link between the two spellings. Rename here and the
 * FE goes red rather than silently losing the row.
 */
export const DD_GATE_FIELD_LABEL = "dd gate (probe)";

/**
 * Stage 2.1 — the influence seam, WIRED and LIVE since Stage 5.1. Exactly one call site:
 * `src/run-core.ts`, wrapping `computeCashOverlay`'s result on the cron path. The kill switch
 * `V_BEAR_INFLUENCE_ENABLED` is `true`; setting it `false` makes this the identity function
 * everywhere and returns the dial to pre-W5-d behaviour in one line.
 *
 * The identity unless the flag is on AND the fall is `v-shaped` — i.e. the ONE class that diverges
 * from today's behaviour (`bear` and `indeterminate` fall through structurally, not via a fallback
 * branch). §2.7's ruled magnitude is **(A) suppress the early cash overlay**; options (B)/(C) are
 * declined.
 *
 * Pure: never mutates `overlay` (mirrors `computeCashOverlay`'s pinned no-mutation property).
 *
 * ⚠ `recentTargetRungs` is DELIBERATELY carried through untouched — NOT because it is persisted
 * (it is not: `store.ts` writes only `cash_overlay`/`_since`/`_reason`, and the window is rebuilt
 * from the persisted `dial_target_rung` by `buildCashOverlayWindow` on every run), but because this
 * function's contract is a faithful pass-through of an opaque `CashOverlayResult`: it rewrites the
 * three fields the suppression is about and touches nothing else. Anything that starts reading this
 * field then gets the same value it would have got without the suppression.
 *
 * ⚠ `since` is cleared, a deviation from the plan's literal `{...overlay, level, reason}`: the repo's
 * standing invariant is `level === "off"` ⇒ `since === null` (see `computeCashOverlay`'s own off
 * branches), and a suppressed overlay that kept an entry stamp would render as "partial since X" on
 * `/lab` while claiming to be off. Cleared, a later un-suppression re-stamps entry at the close it
 * actually re-enters on — which is the honest date, since the overlay genuinely was off in between.
 *
 * @param enabled injected as a parameter default rather than read from module scope, so BOTH the
 *   flag-off identity and the flag-on suppression are testable without module surgery.
 */
export function applyFallShape(
  overlay: CashOverlayResult,
  shape: FallShape,
  enabled: boolean = V_BEAR_INFLUENCE_ENABLED,
): CashOverlayResult {
  if (!enabled || shape !== "v-shaped") return overlay;
  return {
    ...overlay,
    level: "off",
    since: null,
    // B-22 — the prefix is the single marker `resolveCash` reads back to set `suppressedBy: "v-shape"`
    // and the only signal that survives to `/lab` via the persisted `reason` column. Keep it a prefix.
    reason: `${V_SHAPE_SUPPRESS_PREFIX} (was: ${overlay.reason})`,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pctPerDay(x: number): string {
  return `${(x * 100).toFixed(2)}%/day`;
}
