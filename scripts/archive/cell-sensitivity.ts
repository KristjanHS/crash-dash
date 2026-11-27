/**
 * W6 Stage 6.3 — the hybrid precision-shrunk per-cell sensitivity VINTAGE generator.
 *
 *
 *   npx tsx scripts/backtest/cell-sensitivity.ts            # regenerate cell_sensitivity.json
 *
 * OFFLINE + READ-ONLY, structurally: the only inputs are `runEventStudy` (which reads committed
 * `scripts/backtest/data/*.csv` + `loadPublishedVintage`, no network) and the pure Stage-6.1/6.2
 * cell resolvers in `src/danger-engine.ts`. It writes exactly ONE file, the tracked vintage
 * `scripts/backtest/cell_sensitivity.json`, pinned by `cell-sensitivity.test.ts` — the
 * `f1_cuts.json` / `calibration.json` precedent, NOT a migration. As of W6 Stage 6.4 the engine
 * CONSUMES this vintage: `cellSensitivity`/`computeCells`/`familyWsev` in `src/danger-engine.ts` read
 * each cell's `wHat` as the estimated cell's shrunk reach `ŵ` (via a static JSON import).
 *
 * B-2 (candidate future improvement, OUT OF SCOPE for W6): each shipped `wHat` is a POINT ESTIMATE.
 * Its `sigma` (the placebo arms' SD on the reach scale — see the `sigma` bullet) is ALREADY recorded
 * per cell in the emitted JSON.
 * Carrying `ŵ` as a RANGE instead — multiple-imputation style, with the `held` pick reading the
 * conservative (low) end — is the most likely next plan; this wave ships the point estimate only.
 *
 * WHAT IT COMPUTES. For each `estimated` `(family, leg)` cell of the `cr`/`vl`/`xa` families (the 7
 * zero-reach cells W2 left reach-unmeasured), on a common `[0,1]` reach scale (the same scale as a
 * measured cell's max `MEMBER_WEIGHT`):
 *   • `rawSens` = |excess(leg)| / |excess(referenceLeg)| × referenceReach — the W2 §3-rule-4 mapping
 *     (the UNSHRUNK point estimate; deliberately NOT clamped to `[0.4, referenceReach]` nor rounded
 *     to 0.2 as rule-4's SHIPPED weight is — this is an intermediate control quantity, and the
 *     shrinkage below is what regularizes it).
 *   • `sigma` = the placebo arms' STANDARD DEVIATION about their own mean (`placeboSdPp`), mapped onto
 *     that same reach scale (÷|excess(ref)|×referenceReach). ⚠ CHANGED IN STAGE A.2: this was
 *     `placeboMaxPp`, an ORDER STATISTIC over the rotation arms — upward-biased with the bias growing
 *     in arm count, measured at 2.4×–3.4× inflation here, which suppressed α across every cell. The
 *     max is retained in the artifact as a diagnostic only. See `placeboSdPp` for why SD-about-the-mean
 *     rather than RMS-about-zero. Episode count enters ONLY through σ — a THIN cell's placebo noise
 *     inflates σ; there is NO separate `n/(n+λ)` term (spec §Rejected, R5).
 *   • `tau2` = population variance of the family's MEASURED cell sensitivities over the same pool
 *     `familyClassTarget` averages (the risk-class legs, or the all-leg fallback when the class holds
 *     `< MIN_MEASURED_IN_CLASS` measured legs). target and τ² are the centre and spread of ONE
 *     measured-reach distribution; `target === familyClassTarget(...)` is asserted in the test.
 *   • `alpha` = τ²/(τ²+σ²); `wHatUnbounded` = SHRINK_SOFT_FORM(rawSens, target, α); and `wHat` =
 *     that blend after the Stage A.3 LIMITED-TRANSLATION BOUND (see `LIMITED_TRANSLATION_D`), i.e.
 *     clamped to `rawSens ± D·σ`. `bounded` records whether the clamp bound.
 *
 * SHRINK_SOFT_FORM (spec §7, the DEFAULT — not silently substituted): the LINEAR PRECISION BLEND
 * `ŵ = α·rawSens + (1−α)·target`. Because α ∈ [0,1] this is a convex combination, so `ŵ` is ALWAYS
 * within `[min(rawSens,target), max(rawSens,target)]` and on the `[0,1]`-derived scale by
 * construction — the spec's sanity bound holds identically. The Stage A.3 bound only ever pulls the
 * blend BACK TOWARDS `rawSens`, so the shipped `ŵ` stays inside that same interval. Note the two are
 * NOT symmetric: `rawSens` may exceed 1 by construction (it is the unclamped control quantity), while
 * `ŵ` may not — the `(0, 1]` guard in `familyCells` is what keeps an out-of-scale `rawSens` from ever
 * shipping as `ŵ`, and Stage A.3 ruling Q4 applies that guard to `wHatUnbounded` AS WELL AS to the
 * clamped `wHat`, so the new clamp can never rescue an out-of-scale blend into range.
 * R5 rider: a placebo-fail cell at
 * adequate n is shrunk SOFTLY, never zeroed — since target > 0 and α < 1 (σ² > 0 always), every
 * `ŵ` is strictly positive. ⚠ The rider's second half — THIN cells landing strictly BELOW their
 * target — was carried by the `cr` cells, which left the vintage on 2026-08-02; it is history, not a
 * property of the shipped artifact (`xa × Staples` ships ŵ ABOVE its target; Stage A.2's σ sharpening
 * and the 2026-08-05 `xa` column retune each WIDENED the gap — see `placeboSdPp` and the live JSON).
 *
 * CONTROL ARM. The A/B control arm is the UNSHRUNK `rawSens`
 * itself, recorded per cell as `control.unshrunk` beside `control.shrunk` (= `wHat`). Be precise
 * about what that is and is NOT: `rawSens` is the very local FED INTO `shrinkSoftForm` below — the
 * shrinkage's INPUT, NOT a second estimate on an independent code path — so it cannot detect an
 * error the two arms share, and no assertion equating `control.unshrunk` with `rawSens` (or
 * `control.shrunk` with `wHat`) could ever fail. What the arm DOES support is the `moved` check:
 * `cell-sensitivity.test.ts` throws if a cell's unshrunk and shrunk values agree — shrinkage that
 * moved nothing is a bug. The placebo input (`placeboExcessPp`, the per-arm excesses) is the harness's
 * existing rotation arm; it is NOT re-derived here — only summarised, by `placeboSdPp`.
 *
 * REDUCTION (pre-registered; the spec §Stage 6.3 IS the pre-registration — not tuned after seeing
 * numbers). One `excessPp`/`placeboMaxPp` per `(family, leg)` is read at the AMBER stress bucket and
 * the 20d horizon (`HORIZONS_TD[0]`, chosen a priori; 60d is the harness robustness check, never a
 * sweep), from each family's primary stress arm: `cr → EBP` (creditStressEbp), `vl → R5/VIX`
 * (volStress), `xa → DISP` (dispThreeLevel). See CR_USES_EBP for why `cr` reads the EBP co-signer
 * arm rather than F1/hyoas.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  creditStressEbp,
  dispThreeLevel,
  runEventStudy,
  volStress,
  HORIZONS_TD,
  type EventStudyRow,
  type EventStudySpec,
} from "./event-study.js";
import {
  cellSensitivity,
  MIN_MEASURED_IN_CLASS,
  riskClassOf,
} from "../../src/danger-engine.js";
import { LADDER } from "../../src/families.js";
import type { SignalKey } from "../../src/danger-ladder.js";
import { mean } from "../lib/stats.js";
import { isoDay } from "../../src/dates.js";

const OUT_URL = new URL("./cell_sensitivity.json", import.meta.url);

/** The stress bucket read per cell — AMBER, the broader stress state (more episodes than RED). */
export const STRESS_BUCKET = "AMBER";
/** The a-priori primary horizon (`HORIZONS_TD[0]` = 20d); 60d is the harness's robustness check. */
export const PRIMARY_HORIZON = HORIZONS_TD[0];

/**
 * Per-family measurement source: the primary stress-episode spec, the drawdown-ratio reference leg
 * (spec §3 / W2 §3), and a human arm label for the vintage.
 *
 * ⚠ CR_USES_EBP — HISTORICAL as of 2026-08-02: the defensive seating made `cr × {Health, Staples}`
 * MEASURED, so `cr` now emits ZERO cells (`familyCells` `continue`s on every non-`estimated` cell) and
 * this entry is inert — no `FAMILY_SOURCE.cr` knob can move the artifact. Kept so a future `cr`
 * estimated cell inherits the pre-registered arm rather than re-picking one. The reasoning, as it
 * stood: `cr` reads the EBP co-signer arm, NOT F1/hyoas. `hyoas.csv` starts 2008-03, so on
 * its ~18y THIN sample (n=24 AMBER) the reference leg S&P IT is NOT the deepest-drawdown cyclical
 * (defensive Health shows MORE forward "damage" than the cyclical anchor — an artifact of the short
 * window), which yields `rawSens > referenceReach` and would push the shrunk `cr` cells AT OR ABOVE
 * their target. The pre-registered falsifier (a THIN `cr` cell's `ŵ` sits STRICTLY between 0 and its
 * R3 target) is only consistent with the deeper EBP arm (`ebp.csv` 1973→2026, capturing 2000–02 +
 * 2008 + 2020 + 2022), where S&P IT anchors properly at −4.08pp. EBP is exactly the EXACT co-signer
 * §3 names for the `cr` defensive cells, so this is the pre-registered arm, not a post-hoc pick.
 */
export const FAMILY_SOURCE: Record<string, { spec: () => EventStudySpec; referenceLeg: string; arm: string }> = {
  cr: { spec: creditStressEbp, referenceLeg: "S&P IT", arm: "EBP (creditStressEbp)" },
  vl: { spec: volStress, referenceLeg: "S&P IT", arm: "R5/VIX (volStress)" },
  xa: { spec: dispThreeLevel, referenceLeg: "EM", arm: "DISP (dispThreeLevel)" },
};

export const SHRINK_FORM =
  "linear-precision-blend: wHatUnbounded = alpha*rawSens + (1-alpha)*target, " +
  "alpha = tau2/(tau2+sigma^2), sigma = standard deviation of the placebo arms about their mean, " +
  "on the reach scale; wHat = clamp(wHatUnbounded, rawSens - D*sigma, rawSens + D*sigma), " +
  "D = LIMITED_TRANSLATION_D (Efron-Morris limited translation)";

export interface CellSensitivityRecord {
  family: string;
  leg: string;
  kind: "estimated";
  arm: string;
  referenceLeg: string;
  nEpisodes: number;
  verdict: string;
  /** Forward excess of this leg at (AMBER, 20d), percentage points (from the event study). */
  excessPp: number;
  /**
   * Placebo-MAX excess of this leg at (AMBER, 20d), pp — the harness's rotation arm, not re-derived.
   * ⚠ This was σ's input before Stage A.2 and is NO LONGER. It is retained purely as a DIAGNOSTIC, so
   * a reader can size the max-vs-SD gap that motivated the change; nothing downstream reads it.
   */
  placeboMaxPp: number;
  /**
   * Placebo-arm standard deviation about the arms' mean at (AMBER, 20d), pp — σ's actual input since
   * Stage A.2 (R1), pre-reach-scaling. `sigma` below is this value on the `[0,1]` reach scale.
   */
  placeboSdPp: number;
  /** Forward excess of the reference leg at the same (bucket, horizon), pp. */
  referenceExcessPp: number;
  /** The reference leg's MEASURED reach on [0,1] (max relevant MEMBER_WEIGHT). */
  referenceReach: number;
  rawSens: number;
  sigma: number;
  tau2: number;
  alpha: number;
  target: number;
  /**
   * The precision blend BEFORE the Stage A.3 limited-translation bound — `shrinkSoftForm(rawSens,
   * target, alpha)`. Retained as a diagnostic so a reader can size how far the bound moved the cell.
   */
  wHatUnbounded: number;
  /**
   * Did the limited-translation clamp BIND on this cell? Computed on the ROUNDED emitted values
   * (Stage A.3 ruling Q5) — `round4(wHatUnbounded) !== round4(wHat)` — mirroring `control.moved`'s
   * convention, so the flag is verifiable from the artifact alone rather than from a raw comparison
   * the JSON does not carry.
   */
  bounded: boolean;
  /** The shrunk sensitivity ŵ ∈ [0,1] — the value the engine will read in Stage 6.4. */
  wHat: number;
  /** A/B control arm: unshrunk `rawSens` vs shrunk `wHat`. `moved` MUST be true (test throws else). */
  control: { unshrunk: number; shrunk: number; moved: boolean };
}

export interface CellSensitivityVintage {
  generated: string;
  stage: string;
  shrinkForm: string;
  bucket: string;
  horizon: number;
  note: string;
  cells: CellSensitivityRecord[];
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const popVariance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
};

/**
 * The MEASURED-reach pool `familyClassTarget` averages — the risk-class legs, or the all-leg
 * fallback when that class holds `< MIN_MEASURED_IN_CLASS` measured legs. Reimplemented here (not
 * imported) so BOTH the target (its mean) and τ² (its variance) come from the SAME distribution;
 * `target === familyClassTarget(...)` is cross-checked in the test so the two cannot drift.
 */
export function measuredPool(family: SignalKey, sleeve: string): number[] {
  const measuredOver = (legs: readonly string[]): number[] =>
    legs
      .map((leg) => cellSensitivity(family, leg))
      .filter((c): c is { kind: "measured"; value: number } => c.kind === "measured")
      .map((c) => c.value);
  const cls = riskClassOf(sleeve);
  const inClass = measuredOver(LADDER.filter((leg) => riskClassOf(leg) === cls));
  return inClass.length >= MIN_MEASURED_IN_CLASS ? inClass : measuredOver([...LADDER]);
}

/**
 * SHRINK_SOFT_FORM — the linear precision blend (spec §7 default). Kept as a named function so the
 * falsifier's red demo ("replace SHRINK_SOFT_FORM with a hard threshold") mutates exactly one place.
 */
export function shrinkSoftForm(rawSens: number, target: number, alpha: number): number {
  return alpha * rawSens + (1 - alpha) * target;
}

/**
 * `D` — the limited-translation bound's width, in units of the cell's OWN σ (Stage A.3, R2).
 *
 * Efron & Morris's limited-translation rules cap the shrunk estimator's deviation from the unshrunk
 * one at a multiple of that component's standard error, buying BOUNDED worst-case per-component risk
 * for a small cost in average-case risk. One SE is the canonical presented form, and here `sigma` IS
 * the estimate's noise scale already expressed on the reach scale — so `D = 1` reads off the
 * estimator's own units with no free parameter. It is a LITERATURE DEFAULT, not a tuned value:
 * **any other `D` is tuning and needs its own ruling.**
 *
 * ⚠ SINGLE TOUCH POINT. Never restate this value as a *derivable* value in a comment, fixture or doc.
 * Exception: `cell-sensitivity.test.ts`'s bound-clips probe MUST pin it out-of-band (enlarging it is its red demo).
 */
export const LIMITED_TRANSLATION_D = 1;

/**
 * The limited-translation bound: clamp the blend to within `D·sigma` of the UNSHRUNK estimate.
 *
 * Pure and total, taking the three quantities directly rather than recomputing the blend, so the
 * test can drive it over a fixture triple whose clip is provable by hand — the live cell set drains
 * as seatings land, so a non-vacuity pin anchored on "some live cell has `bounded: true`" would rot
 * on the next seating. The clamp only ever moves the blend TOWARDS `rawSens`, so the result stays
 * inside `[min(rawSens, target), max(rawSens, target)]` and the convex-blend sanity bound survives.
 */
export function limitedTranslation(wHatUnbounded: number, rawSens: number, sigma: number): number {
  const half = LIMITED_TRANSLATION_D * sigma;
  return Math.min(Math.max(wHatUnbounded, rawSens - half), rawSens + half);
}

/**
 * The per-family mapping from percentage points onto the `[0,1]` reach scale, carried as a value
 * object rather than a single pre-divided factor **deliberately**: `placeboSigma` below reproduces the
 * expression `(pp / refAbs) * referenceReach` character-for-character, and a pre-multiplied
 * `pp * (referenceReach / refAbs)` is not guaranteed bit-identical in IEEE-754. Stage A.1's done-test
 * is a byte-identical artifact, so the reassociation is not available here.
 */
export interface ReachScale {
  /** |excess| of the family's reference leg at (bucket, horizon), pp. Strictly positive (guarded). */
  refAbs: number;
  /** The reference leg's MEASURED reach on [0,1] (max relevant MEMBER_WEIGHT). */
  referenceReach: number;
}

/**
 * The placebo arms' dispersion in PERCENTAGE POINTS — the **standard deviation about the arms' own
 * mean** (Stage A R1), computed with the file's `popVariance` so σ and τ² share ONE dispersion
 * convention and the α ratio τ²/(τ²+σ²) stays dimensionally coherent.
 *
 * CONSIDERED AND NOT CHOSEN: **RMS about zero** — the null's theoretical centre, arguably the more
 * principled reference when the placebo distribution is assumed centred. It is materially different,
 * not a rounding detail: on `vl × Staples` all six arms are negative (mean −0.293), giving SD 0.1547
 * against RMS-about-0 0.3316, a 2.1× gap that roughly halves that cell's α. Ruled SD-about-the-mean.
 *
 * WHY NOT THE MAX (what shipped before Stage A.2): `placeboMaxPp` is an **order statistic** over the
 * rotation arms — upward-biased as an estimate of the null's spread, with the bias GROWING in the arm
 * count (see §Search-evidence in the Stage A plan). Measured here at 2.4×–3.4× inflation on the reach
 * scale, which suppressed α and let `target` dominate every shipped ŵ. The max is RETAINED in the
 * artifact as a diagnostic so a reader can size the change.
 *
 * Fails loud, never clamps — matching `familyCells`'s `(0, 1]` ŵ guard. A thin row emits
 * `placeboExcessPp: []` in `runEventStudy`, and an SD over fewer than two arms is not a dispersion
 * estimate at all; silently returning 0 there would hand the cell α = 1 and let a no-evidence cell
 * bind fully.
 */
export function placeboSdPp(row: EventStudyRow, cellLabel: string): number {
  const arms = row.placeboExcessPp.filter((x) => Number.isFinite(x));
  if (arms.length < 2) {
    throw new Error(
      `[cell-sensitivity] ${cellLabel}: placebo SD needs >= 2 finite arms, got ${arms.length} ` +
        `(of ${row.placeboExcessPp.length} emitted) — a thin row cannot support a dispersion estimate`,
    );
  }
  return Math.sqrt(popVariance(arms));
}

/**
 * σ — the cell's placebo-noise scale, mapped from pp onto the `[0,1]` reach scale.
 *
 * ⚠ WHY THIS IS A NAMED FUNCTION: **artifact attribution**, not reuse (Stage A §1). It has exactly one
 * caller and none is planned. `scripts/backtest/cell_sensitivity.json` is a COMMITTED artifact that
 * `src/danger-engine.ts` statically imports and the prod danger ordering reads, so a single commit that
 * both restructured the σ path and changed what σ *is* would make the JSON diff carry two causes at
 * once and neither would be independently falsifiable. Extracting first (Stage A.1, gated on a
 * byte-identical regen) bought a provable no-op checkpoint; A.2 then changed only this body. This is
 * the case the project's no-N=2-abstraction rule (`dev-workflow.md` §Architecture) yields to — do not
 * "clean it up" back inline.
 */
export function placeboSigma(row: EventStudyRow, scale: ReachScale, cellLabel: string): number {
  return (placeboSdPp(row, cellLabel) / scale.refAbs) * scale.referenceReach;
}

/** The (bucket, horizon) row for a leg in a study's rows, or throw if absent. */
function rowAt(rows: readonly EventStudyRow[], leg: string): EventStudyRow {
  const r = rows.find((x) => x.bucket === STRESS_BUCKET && x.horizon === PRIMARY_HORIZON && x.leg === leg);
  if (!r) throw new Error(`[cell-sensitivity] no ${STRESS_BUCKET} ${PRIMARY_HORIZON}d row for leg ${leg}`);
  return r;
}

/** Compute one family's estimated-cell records from its primary stress arm. */
export function familyCells(family: SignalKey): CellSensitivityRecord[] {
  const src = FAMILY_SOURCE[family];
  if (!src) throw new Error(`[cell-sensitivity] no source configured for family ${family}`);
  // Hoisted above the early-out: a pure cellSensitivity() lookup, no event study — keep it firing for every family.
  const refCell = cellSensitivity(family, src.referenceLeg);
  if (refCell.kind !== "measured") {
    throw new Error(`[cell-sensitivity] ${family} reference leg ${src.referenceLeg} is not a measured cell`);
  }
  // Cheap precondition gates the expensive branch: no estimated cell ⇒ runEventStudy output is discarded.
  if (!LADDER.some((leg) => cellSensitivity(family, leg).kind === "estimated")) return [];
  const referenceReach = refCell.value;
  const rows = runEventStudy(src.spec());
  const refRow = rowAt(rows, src.referenceLeg);
  const referenceExcessPp = refRow.excessPp;
  const refAbs = Math.abs(referenceExcessPp);
  if (!(refAbs > 0)) {
    throw new Error(`[cell-sensitivity] ${family} reference leg ${src.referenceLeg} has non-positive |excess| ${refAbs}`);
  }

  const out: CellSensitivityRecord[] = [];
  for (const leg of LADDER) {
    if (cellSensitivity(family, leg).kind !== "estimated") continue;
    const row = rowAt(rows, leg);
    const cellLabel = `${family} × ${leg}`;
    const rawSens = (Math.abs(row.excessPp) / refAbs) * referenceReach;
    const sdPp = placeboSdPp(row, cellLabel);
    const sigma = placeboSigma(row, { refAbs, referenceReach }, cellLabel);
    const pool = measuredPool(family, leg);
    const target = mean(pool);
    const tau2 = popVariance(pool);
    // Fail loud, NEVER clamp (as the ŵ guard below). α = τ²/(τ²+σ²) is 0/0 when BOTH vanish — an
    // undefined blend weight, not a defensible default. σ = 0 ALONE is fine and deliberately allowed:
    // it drives α → 1, i.e. evidence binds fully, which is the correct reading of a placebo set with
    // no spread. τ² = 0 alone is likewise fine (α → 0, pure target).
    if (!(tau2 > 0) && !(sigma > 0)) {
      throw new Error(
        `[cell-sensitivity] ${cellLabel}: alpha is 0/0 — both tau2 (${tau2}) and sigma (${sigma}) are zero`,
      );
    }
    const alpha = tau2 / (tau2 + sigma * sigma);
    const wHatUnbounded = shrinkSoftForm(rawSens, target, alpha);
    const wHat = limitedTranslation(wHatUnbounded, rawSens, sigma);
    // Fail loud, NEVER clamp: rawSens is left unclamped by design (control arm) and can exceed 1, so
    // the convex blend can reach ŵ > 1 on future data even though it does not today. A silent clamp
    // would launder that; the vintage regenerates rarely, so a throw is the correct failure mode.
    //
    // ⚠ BOTH quantities are guarded (Stage A.3 ruling Q4). The limited-translation clamp above pulls
    // the blend back towards `rawSens`, so an out-of-scale `wHatUnbounded` could be rescued INTO
    // range by it — exactly the laundering this guard exists to refuse. Checking the unbounded blend
    // as well keeps the bound from silently absorbing that failure. The message names which failed.
    for (const [label, v] of [
      ["ŵ (unbounded)", wHatUnbounded],
      ["ŵ", wHat],
    ] as const) {
      if (!(v > 0 && v <= 1)) {
        throw new Error(
          `[cell-sensitivity] ${family} × ${leg} ${label}=${v} is outside the (0, 1] reach scale`,
        );
      }
    }
    out.push({
      family,
      leg,
      kind: "estimated",
      arm: src.arm,
      referenceLeg: src.referenceLeg,
      nEpisodes: row.nEpisodes,
      verdict: row.verdict,
      excessPp: round4(row.excessPp),
      placeboMaxPp: round4(row.placeboMaxPp),
      placeboSdPp: round4(sdPp),
      referenceExcessPp: round4(referenceExcessPp),
      referenceReach: round4(referenceReach),
      rawSens: round4(rawSens),
      sigma: round4(sigma),
      tau2: round4(tau2),
      alpha: round4(alpha),
      target: round4(target),
      wHatUnbounded: round4(wHatUnbounded),
      bounded: round4(wHatUnbounded) !== round4(wHat),
      wHat: round4(wHat),
      control: { unshrunk: round4(rawSens), shrunk: round4(wHat), moved: round4(rawSens) !== round4(wHat) },
    });
  }
  return out;
}

/** Build the full vintage over the `cr`/`vl`/`xa` families, in `LADDER` order. */
export function buildVintage(generated: string = isoDay(new Date())): CellSensitivityVintage {
  const cells = (["cr", "vl", "xa"] as const).flatMap((f) => familyCells(f));
  return {
    generated,
    stage: "6.3",
    shrinkForm: SHRINK_FORM,
    bucket: STRESS_BUCKET,
    horizon: PRIMARY_HORIZON,
    note:
      // Deliberately does NOT restate the cell COUNT nor WHICH families survive: `cells` below is
      // both, and both are table-derived (7 → 6 on 2026-08-01 when `xa × EU-Fin` flipped estimated →
      // measured; 6 → 3 on 2026-08-02 when the defensive seating flipped `cr × {Health, Staples}` and
      // `vl × Health`, emptying `cr`). Name families here and the note rots on the next seating.
      "Precision-shrunk per-cell sensitivity for whichever cr/vl/xa cells are still estimated " +
      "(spec §Stage 6.3). rawSens is UNSHRUNK (no rule-4 clamp/round); tau2 and " +
      "target are the variance and mean of the same familyClassTarget pool; each family reads its " +
      "own pre-registered stress arm (see FAMILY_SOURCE, and its `arm` on every cell below). " +
      "Regenerate: npx tsx scripts/backtest/cell-sensitivity.ts.",
    cells,
  };
}

function main(): void {
  const vintage = buildVintage();
  writeFileSync(OUT_URL, `${JSON.stringify(vintage, null, 2)}\n`);
  console.log(`\ncell_sensitivity vintage — ${vintage.cells.length} estimated cells (bucket=${vintage.bucket}, ${vintage.horizon}d)`);
  console.log(
    `${"family".padEnd(4)}${"leg".padEnd(10)}${"n".padStart(5)}  ${"verdict".padEnd(13)}` +
      `${"raw".padStart(8)}${"sigma".padStart(8)}${"tau2".padStart(8)}${"alpha".padStart(8)}${"target".padStart(8)}${"wHat".padStart(8)}`,
  );
  for (const c of vintage.cells) {
    console.log(
      `${c.family.padEnd(4)}${c.leg.padEnd(10)}${String(c.nEpisodes).padStart(5)}  ${c.verdict.padEnd(13)}` +
        `${c.rawSens.toFixed(4).padStart(8)}${c.sigma.toFixed(4).padStart(8)}${c.tau2.toFixed(4).padStart(8)}` +
        `${c.alpha.toFixed(4).padStart(8)}${c.target.toFixed(4).padStart(8)}${c.wHat.toFixed(4).padStart(8)}`,
    );
  }
  console.log(`\nwrote ${OUT_URL.pathname}`);
}

// Run only when invoked as a script — the test imports the pure helpers above and must not write.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
