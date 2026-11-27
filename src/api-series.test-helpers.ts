/**
 * Shared fixtures for the api/series.*.test.ts suites (split by subject 2026-09).
 *
 * NOT a *.test.ts file, so vitest never collects it — same idiom as
 * src/dashboard.test-helpers.ts and src/danger-engine.test-helpers.ts. It holds the
 * store-seed builders, the per-id fixture data, and the single `seedSharedStore` that
 * populates the InMemoryStore every /api/series suite reads. The mutable `store`/`activeStore`
 * bindings and the `serve`/`serveDetail`/`servePension` closures stay in each test file — they
 * close over the per-file `GET`/`store`/`activeStore`.
 */

import { InMemoryStore } from "./store-memory.js";
import { priceLegReadingSeries } from "./pension.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";
import { indicatorReadingSeries } from "./scorers-core.js";
import {
  fxHavenReadingSeries,
  bullSteepenerLegSeries,
  vixTermPersistenceReadingSeries,
} from "./scorers-composite.js";
import { cusumParams } from "./domain-legs.js";
import { DISP_BASKET_RED } from "./family-descriptor-rows.js";
import { type Observation, type Indicator } from "./domain-types.js";
import { velocitySigmaDepth } from "./domain-fold.js";
import type { CalibrationParam } from "./store.js";
import type { SeriesPointDTO } from "./api/types.js";
import { T10Y3M_DRAWDOWN } from "./registry-fred.js";

// P1.2: the branch inputs are STORE rows (src/input-series.ts) — tests seed them via
// `priceLegReadingSeries` instead of mocking the retired fred/indicator-feed fetches.
export const headersOf = (res: Response): Record<string, string> => Object.fromEntries(res.headers.entries());

export const RUN_AT = "2026-06-25T21:00:00.000Z";

// Strictly monotonic so the 20-obs delta is unambiguously non-zero. 22 points clears the
// ≥21 threshold priceLegReadingSeries needs to emit a real delta20 on the latest point.
// MONTHLY cadence (one point per month-start, 2024-04-01 .. 2026-01-01) so the `/api/series`
// from/to range tests can slice on the month grid the edge now enforces (P5, `parseRange`);
// delta20 is a 20-OBSERVATION delta, cadence-independent, so it stays exactly 20.
const monotonic = (start: number): Observation[] =>
  Array.from({ length: 22 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 3 + i, 1)).toISOString().slice(0, 10),
    value: start + i, // +1/obs: latest delta20 = value[21] - value[1] = 20 > 0
  }));

// --- Per-mode state ribbon ------------------------
// Seed R2 (velocity-only, in-scope) with a ramp whose 20d change crosses a SENSITIVE
// correction cut but stays under a LOOSE crash cut (operative 1.0/2.0, which DOMINATES — the
// fixture's 0.3 delta20 is above R2's registry velocity pair since the 2026-08-13 retune):
// value is flat for the first 40 obs (delta20 = 0) then rises +0.015/obs, so delta20
// ramps 0 → 0.3 over obs 40..60 and holds 0.3. Under correction (operative 0.1/0.2) the
// ribbon walks GREEN → AMBER → RED; under crash (operative 1.0/2.0, floored by static)
// it stays GREEN — a clean, transition-bearing divergence.
export const R2 = ALL_INDICATORS.find((i) => i.id === "R2")!;
const R2_N = 90; // 40 visible + R2's own lookback pad (w=20 ⇒ 35) + 20 VELOCITY_WINDOW consumed
const r2raw: Observation[] = Array.from({ length: R2_N }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  value: 10 + 0.015 * Math.max(0, i - 40),
}));

// Shared (null/null) velocity operative cuts for R2 (channel rate, prefix dgs10) — the ONLY
// rows resolveCuts reads on the notify path. The recompute-on-read (`?detail=1`) resolves the
// SAME cuts, so the served ribbon walks GREEN → AMBER → RED off this sensitive pair (0.1/0.2).
export const calibRow = (metric: string, value: number): CalibrationParam => ({
  market: null,
  mode: null,
  channel: "rate",
  metric,
  value,
  ciLow: null,
  ciHigh: null,
  method: "test",
  nEvents: null,
  windowStart: null,
  windowEnd: null,
  notes: null,
  computedAt: RUN_AT,
});

// --- F1 on the per-mode branch: the RESPONSE half of the 2026-08-06 expansion ---------------
// The predicate pin above proves the exclusion is gone; these two prove what the WIRE now carries.
// F1 is the first per-mode id with `velocityWindow: 30` (every other one is the global 20), so the
// same fixture doubles as the left-edge pad falsifier for `LOOKBACK_PAD` (api/series.ts).
//
// SHAPE: 40 flat-LOW closes, a step UP at obs 40, flat-HIGH thereafter. Consequences, all derived
// from F1's registry pair (never re-typed):
//  - the level stays BELOW `amberLevel`, so the LEVEL leg never fires and every colour on screen
//    comes from the 30-day velocity leg — the leg the pad exists for;
//  - a visible point whose 30d lookback reaches back across the step sees a big delta (AMBER); one
//    whose lookback sits entirely in the flat-HIGH plateau sees 0 (GREEN). The transition lands
//    INSIDE the visible window's first days, which is exactly where an undersized pad lies: the
//    `domain-fold.ts` clamp would measure those days off the fetched head instead (delta 0 ⇒ GREEN).
export const F1 = ALL_INDICATORS.find((i) => i.id === "F1")!;
// Half the level cut, not a hand-typed margin: a bare `- 1.5` here collides with the unrelated
// `F1_LOW_RISE_AMBER` cut and trips `threshold-single-source.test.ts` now that this file is under src/.
const F1_LOW = F1.thresholds.amberLevel! / 2; // far below the level cut ⇒ level leg dark
const F1_HIGH = F1.thresholds.amberLevel! - 0.4; // still below it; the STEP is what fires velocity
const F1_STEP_AT = 40;
const F1_N = 105;
const f1raw: Observation[] = Array.from({ length: F1_N }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  value: i < F1_STEP_AT ? F1_LOW : F1_HIGH,
}));

// --- F11 at velocityWindow = 60: the regime that SETS the per-id lookback pad ----------------
// The two cases above top out at w = 30. F11's re-horizoning to the quarter (w = 60) is what makes
// `lookbackPadFor` resolve the widest velocity term on the branch, so it owes its own left-edge
// oracle — the pad refactor must not be the thing that discovers it is untested.
//
// F11's velocity pair is in σ UNITS (`thresholds.velocitySigma` ⇒ the `vel-z` leg), so its ONLY leg
// needs `minObs` strictly-historical Δ60 values before it emits anything: a fixture shallower than
// the σ estimator paints all-GREEN and the vacuity anchor below would pass under every pad. Depth
// and step size are therefore derived from the registry σ config, never restated.
//
// SHAPE: a 7-day sawtooth wiggle (what gives σ something to estimate — a flat history makes σ = 0
// and every day degrades, which would pass under any pad) plus one step UP at `F11_STEP_AT`. With
// limit 40 the visible window is the last 40 obs; the step sits so the full step is inside the
// HEAD's Δ60 lookback and out of the TAIL's, giving an elevated head and a GREEN tail. An
// UNDERSIZED pad starts the fetched window past the step, so `domain-fold.ts`'s `i − w < 0` clamp
// measures those head days off a HIGH `values[0]` (Δ 0 ⇒ GREEN) and the oracle comparison reds.
//
// Cuts: F11 resolves no calibration row on either axis, so both sides score off the registry σ pair.
export const F11 = ALL_INDICATORS.find((i) => i.id === "F11")!;
const F11_SIGMA = F11.thresholds.velocitySigma!;
const F11_W = F11.velocityWindow!;
const F11_BASE = 100;
// Depth off `velocitySigmaDepth`, not `window` and not `minObs`: the pad grants a FULL estimator
// history ahead of the first visible point, and F11's blended σ needs the EWMA's burn-in, which is
// deeper than its window. Reading `window` here left the fixture 844 rows against a 1425-row pad —
// caught by the premise guard at the foot of the case, which is the one thing that sees it.
export const F11_N = 40 + velocitySigmaDepth(F11_SIGMA) + 2 * F11_W + 180;
const F11_STEP_AT = F11_N - 95;
const F11_WIGGLE = 1;
// ⚠ The step is a fixed multiple of the WIGGLE, deliberately NOT derived from `amberVelocity`.
// Deriving it from the cut is self-defeating here: σ is estimated over the rolling Δ60 window that
// CONTAINS the step, so a cut-derived step shrinks σ by the same factor it shrinks the cut, and the
// tail's wiggle-only z (≈ F11_WIGGLE/σ) rises as the pair is loosened. At 1.23/1.49 the tail sat at
// z≈1.0 under a 1.49 red cut; the 2026-08-31 retune to 1.0/1.15 pushed it over and turned the
// "step is out of the tail's lookback" GREEN assertion RED — a fixture failure, not a scorer bug.
// A step this size puts the tail at z≈0.4 and the head well past amber, so BOTH assertions hold
// across the whole plausible cut range while the BAND each lands in stays emergent.
const F11_STEP = 8 * F11_WIGGLE;
const f11raw: Observation[] = Array.from({ length: F11_N }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  value: F11_BASE + (i % 7 === 0 ? F11_WIGGLE : 0) + (i >= F11_STEP_AT ? F11_STEP : 0),
}));

// --- F9: the ROLLING-σ depth term of the pad ------------------------------------------------
// F9 needs its OWN case because it is the id that carries the CUSUM persistence leg F11 declines,
// and because this is where the pad's SECOND, additive term is pinned as arithmetic: each z is
// standardized by a σ estimated over a rolling `window` of historical Δ60s, and each Δ60 costs `w`
// (60) leading observations, so the first visible point needs `window + w` MORE history than the
// velocity lookback alone.
// ⚠ `window`, NOT `minObs` (§3.5b, 2026-08-09). `minObs` is only the floor at which
// `velocitySigmaZSeries` starts EMITTING a z; a pad sized to it emits a z off a SHALLOWER σ than the
// scorer's, i.e. a different number on screen than the notify path scores. See the exact-equality
// contract below, which the old `minObs + w` pad cannot satisfy.
//
// SHAPE: a 7-day sawtooth wiggle (this is what gives σ something to estimate — a flat history makes
// σ = 0 and every day degrades, which would pass under any pad) plus one step UP at `F9_STEP_AT`.
// With limit 40 the visible window is the last 40 obs; the step sits far enough back that the full
// step is inside the HEAD's Δ60 lookback and out of the TAIL's, so the window carries an elevated
// head and a GREEN tail. The band the head lands in is EMERGENT (z = Δ60/σ, and σ is a property of
// the whole fixture), so the assertions pin "not GREEN" plus per-point equality with the
// unbounded-history oracle, never a transcribed band.
export const F9 = ALL_INDICATORS.find((i) => i.id === "F9")!;
export const F9_SIGMA = F9.thresholds.velocitySigma!;
// F9 declares the full CUSUM knob triple, so the leg resolves; the `!` is what pins that — it reds
// if F9 ever drops a knob and quietly becomes a speed-only σ id like F11 (2026-08-09 ruling 5).
export const F9_CUSUM = cusumParams(F9_SIGMA)!;
export const F9_W = F9.velocityWindow!;
// Deep enough that the CORRECT pad is still a strict SUBSET of the stored history — otherwise the
// handler fetches everything, the oracle reads the same array, and the pad stops being the subject.
// ⚠ Derived off `window`, NOT `minObs` (§3.5b): the pad grew from `minObs + w` to `window + w`, so a
// fixture sized to the old term no longer out-runs it and the premise guard at the foot of the case
// reds. Never restate either number — both come from the registry σ config.
export const F9_N = 40 + F9_SIGMA.window + 2 * F9_W + 180;
const F9_STEP_AT = F9_N - 95;
const F9_WIGGLE = 1;
const F9_STEP = 2;
export const f9raw: Observation[] = Array.from({ length: F9_N }, (_, i) => ({
  date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  value: 100 + (i % 7 === 0 ? F9_WIGGLE : 0) + (i >= F9_STEP_AT ? F9_STEP : 0),
}));

// --- FXH bespoke three-leg move ribbon --------------------------------------------
// FXH's read path reads the three legs' STORED CMP_FXH_* closes (no live re-fetch), recomputes
// each day's three −20d haven-bid moves, and attaches `havenLegs` to the stored points. Seed the
// three legs so the CHF leg falls sharply over the tail (a strong haven bid → RED) while EUR/JPY
// stay flat, then assert the per-point envelope max(havenLegs) reproduces the stored rawState.
const FXH = ALL_INDICATORS.find((i) => i.id === "FXH")!;
const FX_N = 45;
const fxDates = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const flatFx = (v: number): Observation[] => Array.from({ length: FX_N }, (_, i) => ({ date: fxDates(i), value: v }));
// CHF per USD: flat 0.90 for the first 25 obs, then −0.004/obs. A 20d window sitting in the
// drop yields a −20d haven-bid move ≈ +0.089 (> FXH_RED 0.05); the earliest moved windows sit
// in the flat region (GREEN) — so the ribbon spans multiple bands (vacuity).
const chfFall: Observation[] = Array.from({ length: FX_N }, (_, i) => ({
  date: fxDates(i),
  value: i < 25 ? 0.9 : 0.9 - 0.004 * (i - 24),
}));
const dexUsEu = flatFx(1.1); // EUR leg flat ⇒ ~0 move
const dexJpUs = flatFx(150); // JPY leg flat ⇒ ~0 move

// --- R7 bull-steepener leg + ranked-cut overlay (Stage 2) -------------------------
// The R7 branch reads the three persisted leg rows full-depth from the store, runs the SHARED
// `bullSteepenerLegSeries` seam, and attaches per stored point the two 20d yield-change legs, the
// four per-day ranked cuts, and the `shortEndDriven` gate. Every expectation is DERIVED from that
// seam on the SAME synthetic obs the store is seeded with — no cut value is transcribed here.
const R7_N = 300; // deep enough that the newest points clear the cut warm-up floor (finite cuts)
const r7date = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
// Varied (non-degenerate) yield paths ⇒ the four ranked cuts are DISTINCT finite numbers.
const dgs2Obs: Observation[] = Array.from({ length: R7_N }, (_, i) => ({ date: r7date(i), value: 2 + 0.5 * Math.sin(i / 9) }));
const dgs10Obs: Observation[] = Array.from({ length: R7_N }, (_, i) => ({ date: r7date(i), value: 3 + 0.4 * Math.sin(i / 7 + 1) }));
const spreadObs: Observation[] = Array.from({ length: R7_N }, (_, i) => ({ date: r7date(i), value: 1 + 0.3 * Math.sin(i / 11) }));
const r7Legs = bullSteepenerLegSeries(spreadObs, dgs2Obs, dgs10Obs);
export const r7LegByDate = new Map(
  r7Legs.dates.map((d, i) => [
    d,
    {
      drop: r7Legs.drop[i]!,
      steep: r7Legs.dSteep[i]!,
      r7DropAmber: r7Legs.cuts.dropAmber[i]!,
      r7DropRed: r7Legs.cuts.dropRed[i]!,
      r7SteepAmber: r7Legs.cuts.steepAmber[i]!,
      r7SteepRed: r7Legs.cuts.steepRed[i]!,
      gate: r7Legs.shortEndDriven[i]!,
    },
  ]),
);
export const r7Inputs: Record<string, Observation[]> = { T10Y3M: spreadObs, DGS2: dgs2Obs, DGS10: dgs10Obs };
// Seed R7 rows for a tail slice that STRADDLES the cut warm-up floor: the earliest seeded dates
// carry a finite `drop` but NaN cuts (the GAP); the newest carry all four finite. States cycle so
// the verbatim-passthrough assertions discriminate.
// The cut warm-up floor, read off the seam (= VELOCITY_WINDOW + BULL_MIN_OBS) so the straddle
// tracks any window/minObs change without a transcribed index.
const R7_FIRST_FINITE_CUT = r7Legs.cuts.dropAmber.findIndex((c) => Number.isFinite(c));
const R7_SEED_FROM = R7_FIRST_FINITE_CUT - 12; // seed slice straddles the floor: head gaps, tail finite
const r7StateCycle = ["GREEN", "AMBER", "RED"] as const;
export const r7Rows = r7Legs.dates.slice(R7_SEED_FROM).map((d, i) => ({
  date: d,
  indicatorId: "R7",
  value: spreadObs[R7_SEED_FROM + i]!.value,
  delta20: 0,
  rawState: r7StateCycle[i % 3]!,
  state: r7StateCycle[i % 3]!,
}));
export const seedR7 = async (withLegs = true): Promise<InMemoryStore> => {
  const s = new InMemoryStore();
  await s.recordReadings(r7Rows, RUN_AT);
  if (withLegs)
    for (const [sid, o] of Object.entries(r7Inputs)) await s.recordReadings(priceLegReadingSeries(sid, o), RUN_AT);
  return s;
};

// --- F6/F8 decision passthrough (Case 2, Stage 2) ---------------------------------
// The on-read re-score (`bespokeStateSeries`) is deleted: F6/F8 now ride the store
// passthrough exactly like every other id. So /api/series must echo the STORED cron-time
// `state`/`rawState` AND the persisted `decision` verbatim — no re-derivation, no
// re-division of F6's ratio. This is the passthrough form of the multiplier-independence
// invariant (the threshold multiplier scales bands at cron, never the served decision):
// because the read path performs zero derivation, no config edit can move the emitted
// decision — only the next cron/backfill refreshes the stored column. Seed each id with a
// distinct per-point `decision`+`state` and assert an exact echo.
const DEC_DATES = (n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 2, 1) + i * 86_400_000).toISOString().slice(0, 10));
// Rotate through all three states so the stored ribbon is non-constant — an on-read
// re-score would have to reproduce this exact sequence to pass, which it cannot without
// re-deriving. `decision` is a per-point scalar unrelated to any band the server knows.
const STATES = ["GREEN", "AMBER", "RED"] as const;

// --- Case 4 gate flags (F4/F8 compound-rule ids) -----------------------------------
// The gate branch serves the stored points verbatim PLUS wire-only per-point `gates`
// recomputed from stored history: F4's own-series SMH<MA200 (amber gate) and the
// cross-series NVDA<MA200 (red gate, joined by date). Seed 260 F4 points (flat 100
// then a hard drop to 50 over the last 30) so the own gate resolves false in the flat
// region and true after the drop; NVDA stays flat 100 (value == MA ⇒ strict < is
// false) so the cross gate resolves false wherever covered. F8 rides the SAME
// table-driven branch (src/gates.ts GATES), so F4 exercising both source kinds covers it.
export const GATE_N = 260;
export const MA_WIN = 200;
const gateDates = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

// --- Case 4 gate flags, `atOrAboveCut` rule (DISP) ---------------------------------
// The F4 block above exercises the `belowMA` rule on both source kinds; NOTHING covered
// the cut-gate branch end-to-end. src/gates.test.ts cannot: it REIMPLEMENTS the flag
// computation, so it stays green under every way api/series.ts could get that branch
// wrong. This block drives the real handler and asserts the wire booleans, and is proven
// red under all four (mutate api/series.ts' cut-gate branch):
//   1. `firesHighward` true → false      — cut moves to 0.75/0.9 ≈ 0.833, the 0.7/0.675/0.75 rows flip
//   2. `earlierCut(...)` dropped (raw cut) — cut stays 0.75, the 0.675 and 0.7 rows flip
//   3. reads `p.decision` instead of `p.value` — decisions are all ≪ the cut ⇒ all-false
//   4. branch moved BELOW the `source === "own"` branch — cut defs fall into belowMAFlags
//      with an undefined window ⇒ all-null ⇒ no `gates` key on any point at all
export const DISP_MULT = 0.9; // the non-1.0 DISP multiplier api/series.legs.test.ts injects via `multiplierOf`
// Redesign 2026-07-22: ONE corr confirm gate (`corrAtOrAboveCut`, appliesTo "both"). Resolved
// cut at that multiplier, as a LITERAL (not recomputed via earlierCut — that would re-derive the
// expectation from the seam under test): DISP_CORR 0.75 → 0.675. Rows sit below the resolved cut,
// on it exactly (the inclusive `>=` display edge), between resolved and raw (kills mutation 2),
// on the raw constant, and clear above. NB the display flag is `>=` while the SCORING predicate
// is strict `>`; this Case-4 block pins the wire FLAG only (the ribbon colour is tested via the
// stored state elsewhere), so the `>=` edge row is correct here.
// Baskets DERIVED from the production RED depth (never a hand-typed copy): a shallow
// basket in [DISP_BASKET_RED, 0) is the AMBER tier, one below DISP_BASKET_RED is RED,
// both only WITH the corr-confirm gate on (see the re-score test below). Also far from
// every corr cut, so mutation 3 (gate reads `decision`) still resolves all-false.
export const AMBER_BASKET = DISP_BASKET_RED / 2; // -0.0125 ∈ [DISP_BASKET_RED, 0) ⇒ AMBER
const DEEP_BASKET = DISP_BASKET_RED * 2; // -0.05 < DISP_BASKET_RED ⇒ RED
export const DISP_ROWS: ReadonlyArray<{ corr: number; basket: number; on: boolean; why: string }> = [
  { corr: 0.2, basket: DEEP_BASKET, on: false, why: "far below the cut (gate off ⇒ GREEN)" },
  { corr: 0.6, basket: DEEP_BASKET, on: false, why: "below the resolved cut 0.675 (gate off ⇒ GREEN)" },
  { corr: 0.675, basket: DEEP_BASKET, on: true, why: "the >= flag edge; strict > scoring fails ⇒ GREEN" },
  { corr: 0.7, basket: AMBER_BASKET, on: true, why: "above resolved 0.675 (kills mut 2); shallow ⇒ AMBER" },
  { corr: 0.75, basket: AMBER_BASKET, on: true, why: "gate on; shallow basket ⇒ AMBER (2nd consecutive)" },
  { corr: 0.95, basket: DEEP_BASKET, on: true, why: "far above the cut; deep basket ⇒ RED (raw)" },
];

// --- PENSION rows: a fresh store per test (withStore) so the seeded closes are known ------------
// `ramp` seeds enough obs for a REAL delta20 (priceLegReadingSeries needs ≥21).
export const ramp = (start: number, step: number, n: number): Observation[] =>
  Array.from({ length: n }, (_, i) => ({
    // MONTHLY cadence (month-start dates from 2026-03-01) so the pension range tests
    // slice on the `/api/series` month grid the edge enforces (P5, `parseRange`).
    date: new Date(Date.UTC(2026, 2 + i, 1)).toISOString().slice(0, 10),
    value: start + i * step,
  }));
export const seedPension = async (id: string, obs: Observation[]): Promise<InMemoryStore> => {
  const s = new InMemoryStore();
  await s.recordReadings(priceLegReadingSeries(id, obs), RUN_AT);
  return s;
};

// --- VTP chart-only history (stage B.2) -----------
// VTP is persisted (FAST_CONFIRMERS tail, B.1) but deliberately OUTSIDE ALL_INDICATORS, so
// until it joined `CHART_ONLY_INDICATORS` the handler's META gate 400'd it and the seeded
// history was unreachable on the wire. This is the served half of that stage's falsifier
// ("the stored series returns > 1 row with a plausible date span"), run against a stored
// fixture instead of the local stack: it goes red if the id falls out of META (400) or if the
// passthrough stops serving the stored streak points.
export const VTP_IND = CHART_ONLY_INDICATORS.find((i) => i.id === "VTP")!;
// 30 daily closes: contango until 2026-03-11, then a 12-day backwardation run — so the ribbon
// crosses BOTH streak cuts inside the window and the payload is not a flat GREEN wall.
export const vtpDates = Array.from({ length: 30 }, (_, i) =>
  new Date(Date.UTC(2026, 1, 10) + i * 86_400_000).toISOString().slice(0, 10),
);
const vtpVix: Observation[] = vtpDates.map((date, i) => ({ date, value: i < 18 ? 90 : 110 }));
const vtpVix3m: Observation[] = vtpDates.map((date) => ({ date, value: 100 }));

// --- RAW arm: the always-on regime-relative drawdown cut (2026-08-30) ------------------------
// `withPostInversionCut`'s raw arm ALSO attaches `bandCuts[R1_DRAWDOWN_BAND.key]` off the SAME
// `drawdownCutSeries` the leg scores through — a SECOND amber line, null ONLY in warm-up (never
// gated on the rung's arming). R1 left the raw arm 2026-08-31 (a `SMOOTHED_LEVEL_OF` row, no
// `drawdownLeg`), so the arm is pinned on a FIXTURE carrier — R1's rung + `T10Y3M_DRAWDOWN` under an
// id with no smoothed row — driven through the exported helper (the GET route reaches registry ids
// only). Every expectation derives from the exports; no knob value is restated.
export const RAW_CARRIER: Indicator = {
  ...ALL_INDICATORS.find((i) => i.id === "R1")!,
  id: "R1_RAW_FIXTURE",
  drawdownLeg: T10Y3M_DRAWDOWN,
};
// The stored projection the handler would have served: `value` = the raw close, as a raw carrier
// persists it. State is irrelevant to the overlay (it only ever ADDS keys), so it is held GREEN.
export const rawPoints = (obs: Observation[]): SeriesPointDTO[] =>
  obs.map((o) => ({ date: o.date, value: o.value, delta20: null, rawState: "GREEN" as const, state: "GREEN" as const }));
// P1.2: seed the carrier's own upstream series (+ any extra input ids) as raw store rows.
export const seedRaw = async (obs: Observation[], extra: Record<string, Observation[]> = {}): Promise<InMemoryStore> => {
  const s = new InMemoryStore();
  await s.recordReadings(priceLegReadingSeries(RAW_CARRIER.series, obs), RUN_AT);
  for (const [sid, o] of Object.entries(extra)) await s.recordReadings(priceLegReadingSeries(sid, o), RUN_AT);
  return s;
};

// --- redMean rides a redWindow carrier that has NO rung (2026-09-01) ---------------------
// `smoothedLevelReadingSeries` scores RED on the `redWindow` mean with NO rung armed, and
// `chart-rail.ts` appends the scored-mean series on `smoothed?.redWindow !== undefined` alone — so a
// redWindow carrier WITHOUT a `postInversionCooldown` would draw a RED-scored line the wire never
// values (an empty line under a RED ribbon). Pins that `withPostInversionCut` emits `redMean`
// cfg-INDEPENDENTLY. Live R1 carries a rung, so this arm needs a fixture: a `SMOOTHED_LEVEL_OF` row
// (window ≠ redWindow) under an id with `postInversionCooldown: undefined`.
export const REDMEAN_FIXTURE_ID = "R1_REDMEAN_FIXTURE";
export const REDMEAN_WIN = 21;
export const REDMEAN_REDWIN = 63;
export const REDMEAN_CARRIER: Indicator = {
  ...ALL_INDICATORS.find((i) => i.id === "R1")!,
  id: REDMEAN_FIXTURE_ID,
  postInversionCooldown: undefined,
};

// Seed the shared InMemoryStore every /api/series suite reads. Runs the same
// side-effecting seed statements the pre-split suite ran at module top level, in the
// same order, so each split file rebuilds an identical store.
export async function seedSharedStore(store: InMemoryStore): Promise<void> {
const seedDecision = async (id: string) => {
  const dates = DEC_DATES(9);
  await store.recordReadings(
    dates.map((date, i) => ({
      date,
      indicatorId: id,
      value: 1.2 + i * 0.01, // stored raw ratio / level (untouched by the read path)
      delta20: 0,
      rawState: STATES[i % 3]!,
      state: STATES[i % 3]!,
      decision: -0.5 + i * 0.1, // the persisted cron-time decision variable
    })),
    RUN_AT,
  );
  return dates;
};
const seedGateId = async (id: string, valueAt: (i: number) => number) => {
  await store.recordReadings(
    Array.from({ length: GATE_N }, (_, i) => ({
      date: gateDates(i),
      indicatorId: id,
      value: valueAt(i),
      delta20: 0,
      rawState: "GREEN" as const,
      state: "GREEN" as const,
      decision: -0.1,
    })),
    RUN_AT,
  );
};
// Seed all three legs as raw stored series (the same projection the backfill uses).
await store.recordReadings(priceLegReadingSeries("SPY", monotonic(100)), RUN_AT);
await store.recordReadings(priceLegReadingSeries("LEGP_EXUS", monotonic(50)), RUN_AT);
await store.recordReadings(priceLegReadingSeries("DEXUSEU", monotonic(1)), RUN_AT);
// Store the shared-cut (paramless) series exactly as the run loop (`store-project.ts` `toStoredReadings`) projects a Reading[].
await store.recordReadings(
  indicatorReadingSeries(R2, r2raw).map((r) => ({
    date: r.date,
    indicatorId: r.indicator.id,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: r.state,
  })),
  RUN_AT,
);
await store.recordCalibration([
  calibRow("dgs10_operative_amber", 0.1),
  calibRow("dgs10_operative_red", 0.2),
]);
// Stored with a DELIBERATELY WRONG all-GREEN ribbon (the shape an older/other scorer would have
// left behind). Nothing in production writes this; it is the discriminator — a payload that still
// fell back to the stored shared-state series would serve these GREENs verbatim.
await store.recordReadings(
  f1raw.map((o) => ({
    date: o.date,
    indicatorId: "F1",
    value: o.value,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
  })),
  RUN_AT,
);
await store.recordReadings(
  f11raw.map((o) => ({
    date: o.date,
    indicatorId: "F11",
    value: o.value,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
  })),
  RUN_AT,
);
await store.recordReadings(
  f9raw.map((o) => ({
    date: o.date,
    indicatorId: "F9",
    value: o.value,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
  })),
  RUN_AT,
);
// Seed the CMP_FXH_* legs as raw stored series — the same projection the backfill job and the
// cron writer produce, so the read path's getSeriesBulk sees the exact closes the scorer saw.
await store.recordReadings(priceLegReadingSeries("CMP_FXH_DEXUSEU", dexUsEu), RUN_AT);
await store.recordReadings(priceLegReadingSeries("CMP_FXH_DEXSZUS", chfFall), RUN_AT);
await store.recordReadings(priceLegReadingSeries("CMP_FXH_DEXJPUS", dexJpUs), RUN_AT);
// Store FXH exactly as the run loop (`store-project.ts` `toStoredReadings`) projects a Reading[] (same alignment/VELOCITY_WINDOW drop the
// move series uses, so dates line up with the recomputed havenLegs).
await store.recordReadings(
  fxHavenReadingSeries(FXH, dexUsEu, chfFall, dexJpUs).map((r) => ({
    date: r.date,
    indicatorId: r.indicator.id,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: r.state,
  })),
  RUN_AT,
);
await seedDecision("F6");
await seedDecision("F8");
await seedGateId("F4", (i) => (i < GATE_N - 30 ? 100 : 50));
await seedGateId("NVDA", () => 100);
// NVDA pre-history DEEPER than F4 (review finding 6 — the old tests seeded both ids
// from the same start date): a full extra MA window of aux-ONLY dates, at a value
// (1e6 ≫ 100) that would poison the trailing MA — and resolve cross-only flags on
// F4's own-uncovered head — if the cross gate ever ran over NVDA's OWN calendar
// instead of the F4∩NVDA date intersection (the scorer's alignByDate semantics).
await store.recordReadings(
  Array.from({ length: MA_WIN + 20 }, (_, i) => ({
    date: gateDates(i - (MA_WIN + 20)),
    indicatorId: "NVDA",
    value: 1_000_000,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
    decision: -0.1,
  })),
  RUN_AT,
);
await store.recordReadings(
  DISP_ROWS.map((r, i) => ({
    date: gateDates(i),
    indicatorId: "DISP",
    value: r.corr,
    delta20: 0,
    // Stored under the OLD binary logic that never emitted AMBER — the re-score test
    // asserts these GREENs get overwritten to today's GREEN/AMBER/RED tiers on read.
    rawState: "GREEN" as const,
    state: "GREEN" as const,
    decision: r.basket, // the DRAWN leg (20d basket return)
  })),
  RUN_AT,
);
await store.recordReadings(
  vixTermPersistenceReadingSeries(VTP_IND, vtpVix, vtpVix3m).map((r) => ({
    date: r.date,
    indicatorId: r.indicator.id,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: r.state,
  })),
  RUN_AT,
);
}
