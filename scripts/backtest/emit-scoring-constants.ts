/**
 * D0 Stage 2.2 — single-source scoring-constants emitter.
 *
 * Imports every hand-mirrored scoring constant (and the per-primitive fixtures)
 * from the REAL `src/` + `scripts/backtest/` exports — NO numeric literal for any
 * mirrored constant — and writes ONE committed JSON artifact
 * (`scripts/backtest/data/scoring_constants.json`) that the Python harness loads in
 * Stage 3, replacing its hardcoded centres/windows/MODES. Rides the exact `replay.ts`
 * artifact channel (`join(DATA_DIR, …)`, `JSON.stringify(obj, null, 2) + "\n"`).
 *
 * The emit logic lives in the pure exported `buildScoringConstants()` (zero IO), so
 * the self-check test can compare a fresh in-process build against the committed JSON.
 * `main()` (the only IO) is guarded behind the `invokedDirectly` check, exactly like
 * `replay.ts`, so importing this module has no side effects.
 *
 * The JSON is COMMITTED (correction 6): re-run `npm run emit:scoring-constants` after
 * editing any mirrored source, or the Stage-2 self-check test fails ("did you re-run
 * the emitter?" guard, the automated successor to expanding-z.test.ts's manual golden).
 *
 * ONE-WAY MIRROR — it cannot host a Python-authored constant. Because every emitted value
 * is imported from a real TS export, a calibration-*methodology* input with no TS counterpart
 * (`Z_ELEVATED`, `Z_CUTS`, `TAIL_QUANTILES` — in TS, `zAmber`/`zRed` are only ever read back
 * OUT of calibration) is **correctly** outside this bundle: routing it through here would mean
 * inventing a TS literal no TS code reads. Python is their home; co-locate, don't emit.
 * Falsifier: `grep -rn 'zAmber\|zRed' src/ api/ --include=*.ts | grep -v test` — every hit must
 * be a `cuts.*` read or a type/doc line, never a literal assignment.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// --- Mirrored constants: imported from the live src/ exports (no literals) ------
import { PENSION_DIP, PENSION_CORRECTION, PENSION_BEAR, drawdownSeries } from "../../src/pension.js";
import {
  SLOW_CALM_PCTILE,
  SLOW_CALM_RUN_MIN,
  ACCEL_AMBER_PCTILE,
  ACCEL_RED_PCTILE,
  VIX_LOW_PCTILE,
  NEAR_HIGH_FRAC,
  ACCEL_WINDOW,
  SLOW_HIGH_WINDOW,
} from "../../src/slow.js";
import { CG_AMBER_RET, CG_RED_RET, VT_AMBER_RATIO, VT_RED_RATIO, RET_WINDOW } from "../../src/family-descriptor-rows.js";
import { trailingReturn } from "../../src/scorers-core.js";
import { R6 } from "../../src/registry-fred.js";
import { ALERT_RANK } from "../../src/ladder.js";
import { VIX_CAP, ROLLOVER_K, BACKWARD_CUT } from "../../src/bottom.js";
import { VELOCITY_WINDOW, type Observation } from "../../src/domain-types.js";
import { velocityDelta } from "../../src/domain-fold.js";
import { MODES, T10Y2Y_IND, BWD_DIFF_IND, maxForwardDrawdown } from "./replay.js";
import { expandingZ } from "./expanding-z.js";
import { isoDay } from "../../src/dates.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

// --- Fixture inputs -------------------------------------------------------------
// These are FIXTURE INPUTS (not mirrored constants) — the literals below are the raw
// series fed through the real TS primitives; the "expected" halves are COMPUTED, never
// hand-typed, so a formula/window drift on either the TS or Python side fails a parity
// test in Stage 4.

/** Exact INPUT array from `expanding-z.test.ts` (kept identical so the emitted fixture
 *  is provably the same numbers the manual GOLDEN pins today — Stage 4.1 flip). */
const EXPANDING_Z_INPUT = [2.34, 2.3, 2.31, 2.28, 2.5, 2.2, 3.1, 2.4, 2.35, 2.9, 4.2, 2.1, 2.15, 2.05, 2.6];

/** Small shared price series for the velocity / trailing-return / drawdown fixtures.
 *  Length 30 so `velocityDelta` at VELOCITY_WINDOW=20 yields a non-empty result. */
const PRICE_SERIES = [
  100, 101, 99, 102, 105, 103, 98, 97, 100, 104, 108, 110, 107, 106, 109, 112, 115, 113, 111, 114, 118, 120, 117, 116,
  119, 122, 125, 123, 121, 124,
];

/** RET_WINDOW=126 would need a >126-element series to produce a non-empty result — unwieldy.
 *  Use a small explicit window and RECORD it in the fixture so Python reads it (never assumes 126). */
const TRAILING_RETURN_FIXTURE_WINDOW = 5;

/** Stage 4.1 — a deliberately SHORT window so the open-window boundary (`t >= n - window`,
 *  the still-open tail both ports must null out) is a non-empty slice of PRICE_SERIES, not a
 *  1-of-30 edge case. Recorded in the fixture so Python reads it, never assumes a mode window. */
const FORWARD_DRAWDOWN_FIXTURE_WINDOW = 5;

/** Per-t forward drawdown from the LIVE `maxForwardDrawdown` (replay.ts): for each close t,
 *  `min(close over [t, t+win]) / close[t] − 1`, null once the window runs past the fixture end.
 *  This is the emitted TS truth the Python `fwd_dd_mode` (mode_target, the retired harness.py) was pinned to
 *  in Stage 4.1. Dates are synthetic consecutive UTC days — both ports index positionally and
 *  the per-t call anchors on the exact entry date, so i0 == t. */
function forwardDrawdownFixture(prices: number[], win: number): (number | null)[] {
  const obs: Observation[] = prices.map((value, i) => ({
    date: isoDay(new Date(Date.UTC(2020, 0, 1 + i))),
    value,
  }));
  return obs.map((o) => maxForwardDrawdown(obs, o.date, win));
}

export interface ScoringConstants {
  pension: { dip: number; correction: number; bear: number };
  slow: {
    calmPctile: number;
    calmRunMin: number;
    accelAmber: number;
    accelRed: number;
    vixLow: number;
    nearHigh: number;
    accelWindow: number;
    slowHighWindow: number;
  };
  cg: { amber: number; red: number };
  vt: { amber: number; red: number };
  move: { amberLevel: number; redLevel: number };
  t10y2y: { amberLevel: number; redLevel: number };
  bwdDiff: { amberLevel: number; redLevel: number };
  velocityWindow: number;
  retWindow: number;
  modes: Record<string, { theta: number; window: number }>;
  alertRank: Record<string, number>;
  bottomDefaults: { vixCap: number; rolloverK: number; backwardCut: number };
  fixtures: {
    expandingZ: { input: number[]; expected: (number | null)[] };
    velocityDelta: { input: number[]; window: number; expected: number[] };
    trailingReturn: { input: number[]; window: number; expected: (number | null)[] };
    drawdownSeries: { input: number[]; expected: number[] };
    forwardDrawdown: { input: number[]; window: number; expected: (number | null)[] };
  };
}

/**
 * Build the full scoring-constants object from the live src/ exports + real primitives.
 * PURE (no IO) so the self-check test can call it and deep-equal the committed JSON.
 *
 * NaN handling: `expandingZ` emits NaN over its warm-up prefix; JSON serializes NaN as
 * `null`, so we normalize NaN→null here too — otherwise the in-process object (NaN) and
 * the parsed committed JSON (null) would not deep-equal in the self-check.
 */
export function buildScoringConstants(): ScoringConstants {
  const moveT = R6.thresholds;
  const t10y2yT = T10Y2Y_IND.thresholds;
  const bwdDiffT = BWD_DIFF_IND.thresholds;

  const modes: Record<string, { theta: number; window: number }> = {};
  for (const [name, m] of Object.entries(MODES)) {
    modes[name] = { theta: m.theta, window: m.windowTd };
  }

  const expandingZExpected = expandingZ(EXPANDING_Z_INPUT).map((z) => (Number.isNaN(z) ? null : z));

  return {
    pension: { dip: PENSION_DIP, correction: PENSION_CORRECTION, bear: PENSION_BEAR },
    slow: {
      calmPctile: SLOW_CALM_PCTILE,
      calmRunMin: SLOW_CALM_RUN_MIN,
      accelAmber: ACCEL_AMBER_PCTILE,
      accelRed: ACCEL_RED_PCTILE,
      vixLow: VIX_LOW_PCTILE,
      nearHigh: NEAR_HIGH_FRAC,
      accelWindow: ACCEL_WINDOW,
      slowHighWindow: SLOW_HIGH_WINDOW,
    },
    cg: { amber: CG_AMBER_RET, red: CG_RED_RET },
    vt: { amber: VT_AMBER_RATIO, red: VT_RED_RATIO },
    move: { amberLevel: moveT.amberLevel!, redLevel: moveT.redLevel! },
    t10y2y: { amberLevel: t10y2yT.amberLevel!, redLevel: t10y2yT.redLevel! },
    bwdDiff: { amberLevel: bwdDiffT.amberLevel!, redLevel: bwdDiffT.redLevel! },
    velocityWindow: VELOCITY_WINDOW,
    retWindow: RET_WINDOW,
    modes,
    alertRank: { ...ALERT_RANK },
    // Emitted but consumed by nothing in Stage 2/3 (correction 10) — publishes the shipped
    // bottom.ts defaults so the centre-vs-shipped divergence stops being invisible.
    bottomDefaults: { vixCap: VIX_CAP, rolloverK: ROLLOVER_K, backwardCut: BACKWARD_CUT },
    fixtures: {
      expandingZ: { input: EXPANDING_Z_INPUT, expected: expandingZExpected },
      velocityDelta: {
        input: PRICE_SERIES,
        window: VELOCITY_WINDOW,
        expected: velocityDelta(PRICE_SERIES, VELOCITY_WINDOW),
      },
      trailingReturn: {
        input: PRICE_SERIES,
        window: TRAILING_RETURN_FIXTURE_WINDOW,
        expected: trailingReturn(PRICE_SERIES, TRAILING_RETURN_FIXTURE_WINDOW),
      },
      drawdownSeries: { input: PRICE_SERIES, expected: drawdownSeries(PRICE_SERIES) },
      forwardDrawdown: {
        input: PRICE_SERIES,
        window: FORWARD_DRAWDOWN_FIXTURE_WINDOW,
        expected: forwardDrawdownFixture(PRICE_SERIES, FORWARD_DRAWDOWN_FIXTURE_WINDOW),
      },
    },
  };
}

function main(): void {
  const constants = buildScoringConstants();
  writeFileSync(join(DATA_DIR, "scoring_constants.json"), JSON.stringify(constants, null, 2) + "\n");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
