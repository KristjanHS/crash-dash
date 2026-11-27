import { expect, test, describe } from "vitest";
import { resolveBands, earlierCut } from "./threshold-config.js";
import { scoreIndicator } from "./scorers-core.js";
import { VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import {
  RELSTR_AMBER,
  RELSTR_RED,
  MU_AMBER,
  MU_RED,
} from "./family-descriptor-rows.js";
import { rawStateSeries } from "./domain-fold.js";
import {
  resolveCuts,
  withSynthesizedPriors,
  usesOwnSeriesZ,
  calibratedZ,
  type CalibrationCuts,
} from "./domain-cuts.js";
import { ALL_INDICATORS } from "./registry.js";
import { withMultipliedThresholds } from "./registry-fred.js";
import { scoreWithCuts } from "./confirmers.js";
import { computeSynthCuts, priorThresholds } from "./synth-cuts.js";
import { flat, indicator, byId } from "./dashboard.test-helpers.js";

// --- Threshold-provenance Phase 1: resolver + dual-threshold classify ------
// A representative slice of a getCalibration() vintage (mirrors calibration.json
// params: <prefix>_<cut> metric names per channel). zref_* are absent here for
// most series (they ship in Phase 2) — added only to the credit/baa10y proxy to
// prove the resolver picks them up when present.
const CALIB: ReadonlyArray<{ channel: string; metric: string; value: number }> = [
  // `rate/t10y3m_*` rows are published on purpose: R1 left `CALIB_MAP` 2026-08-31 and must
  // resolve NOTHING off a vintage that still carries its prefix (the smoothed-arm guard throws).
  { channel: "rate", metric: "t10y3m_evt_level_amber", value: -0.6491 },
  { channel: "rate", metric: "t10y3m_evt_level_red", value: -1.4158 },
  { channel: "vol", metric: "vix_evt_level_amber", value: 33.2011 },
  { channel: "vol", metric: "vix_evt_level_red", value: 47.0061 },
  { channel: "vol", metric: "vix_zscore_amber", value: 1.5 },
  { channel: "vol", metric: "vix_zscore_red", value: 2.0 },
  { channel: "credit", metric: "ebp_evt_level_amber", value: 1.0248 },
  { channel: "credit", metric: "ebp_evt_level_red", value: 2.0367 },
  { channel: "credit", metric: "ebp_zscore_amber", value: 1.5 },
  { channel: "credit", metric: "ebp_zscore_red", value: 2.0 },
  { channel: "credit", metric: "baa10y_evt_level_amber", value: 3.3542 },
  { channel: "credit", metric: "baa10y_evt_level_red", value: 4.4758 },
  { channel: "credit", metric: "baa10y_zscore_amber", value: 1.5 },
  { channel: "credit", metric: "baa10y_zscore_red", value: 2.0 },
  { channel: "credit", metric: "baa10y_zref_mean", value: 2.0 }, // Phase-2 shape, here to test resolution
  { channel: "credit", metric: "baa10y_zref_std", value: 0.5 },
  // EW-R1 Stage 2.1: F1 reads `credit/hyoas` (F2 still reads `baa10y`). The tracked
  // calibration.json mirrors the baa10y z rows onto this prefix, so the fixture does too —
  // same values, so every F1 expectation below is the SAME number it was pre-split.
  { channel: "credit", metric: "hyoas_evt_level_amber", value: 3.3542 },
  { channel: "credit", metric: "hyoas_evt_level_red", value: 4.4758 },
  { channel: "credit", metric: "hyoas_zscore_amber", value: 1.5 },
  { channel: "credit", metric: "hyoas_zscore_red", value: 2.0 },
  { channel: "credit", metric: "hyoas_zref_mean", value: 2.0 },
  { channel: "credit", metric: "hyoas_zref_std", value: 0.5 },
  // Velocity-only ids (R2→dgs10): the harness references these on the 20-day change, so the
  // resolver routes them into the SEPARATE velocity bound set (qimpag P3-follow).
  { channel: "rate", metric: "dgs10_evt_level_amber", value: 0.4 },
  { channel: "rate", metric: "dgs10_evt_level_red", value: 0.7 },
  { channel: "rate", metric: "dgs10_zscore_amber", value: 1.5 },
  { channel: "rate", metric: "dgs10_zscore_red", value: 2.0 },
  { channel: "rate", metric: "dgs10_zref_mean", value: 0.0 },
  { channel: "rate", metric: "dgs10_zref_std", value: 0.2 },
];

describe("withMultipliedThresholds - engine-wide byte-parity at the shipped config", () => {
  test("is referential-identity over ALL_INDICATORS (all-1.0 config → m===1 fast-path)", () => {
    // The shipped threshold-config.json is all-1.0 (shared) / label-only, so the seam must
    // return each indicator UNCHANGED — the parity guarantee (design decision 4). Referential
    // identity (toBe) is the strongest form: not just equal thresholds, the same object.
    for (const ind of ALL_INDICATORS) {
      expect(withMultipliedThresholds(ind)).toBe(ind);
    }
  });
});

describe("resolveCuts (indicator → measured cut-points)", () => {
  test("R1 (smoothed carrier since 2026-08-31) has NO row - resolves {} off a vintage naming its prefix", () => {
    expect(CALIB.some((p) => p.metric.startsWith("t10y3m_"))).toBe(true); // premise: rows are there to ignore
    expect(resolveCuts("R1", CALIB, "LOW")).toEqual({});
  });

  test("R5 maps to vol/vix; EBP maps to credit/ebp (both own-series)", () => {
    // toEqual (not toMatchObject) so a future silent field add/drop is caught.
    expect(resolveCuts("R5", CALIB, "HIGH")).toEqual<CalibrationCuts>({
      evtAmber: 33.2011,
      evtRed: 47.0061,
      zAmber: 1.5,
      zRed: 2.0,
      zrefMean: undefined,
      zrefStd: undefined,
    });
    // EBP's `evtLevel` was RETIRED 2026-07-29 (`[USER]` retune, `CALIB_MAP` — the hand-set
    // registry pair is now the single source for its level axis), so BOTH gated legs resolve
    // `undefined` off the very same vintage that still publishes them. The z leg is not gated
    // and still resolves — that asymmetry IS the routing this pins.
    expect(resolveCuts("EBP", CALIB, "HIGH")).toEqual<CalibrationCuts>({
      evtAmber: undefined,
      evtRed: undefined,
      zAmber: 1.5,
      zRed: 2.0,
      zrefMean: undefined,
      zrefStd: undefined,
    });
  });

  test("F1/F2 open NO EVT level leg - and their borrowed proxy-z legs are RETIRED", () => {
    // Both ids carry `evtLevel: false` — F2 because its `credit/baa10y` EVT level is in Baa10y
    // units rather than IG-OAS units, F1 because the pair its `credit/hyoas` prefix publishes was
    // RETIRED 2026-07-23 (`[USER]`) as permanently dominated by its registry priors. This fixture
    // publishes an EVT level row under BOTH prefixes on purpose, so the fold-only cuts below are
    // attributable to the flag and not to a missing row.
    const f1 = resolveCuts("F1", CALIB, "HIGH");
    const f2 = resolveCuts("F2", CALIB, "HIGH");
    // HISTORY: this block used to pin the four borrowed bounds equal to the Baa−10y card's own
    // (2026-07-23 `[USER]`, "one source, three consumers"). The arm-trigger arc
    // (verdict `D-FAVOURED`) RETIRED `z`/`vel-z` on
    // both proxy ids — Red now folds every PRESENT leg with a strict AND, and the borrowed pair
    // would have made that a four-leg conjunction across two unit systems. Stage 5.2 (2026-08-06)
    // then deleted `CALIB_MAP.{F1,F2}` and the `proxy` axis, so `resolveCuts` returns EARLY on the
    // absent entry and both ids resolve the FOLD ALONE — asserted exhaustively (not
    // `toMatchObject`) so a re-seated row carrying any bound reds this test.
    for (const c of [f1, f2]) expect(c).toEqual<CalibrationCuts>({ fold: { amber: "or", red: "and" } });
    // (The old NON-VACUITY loop over the four BAA10Y_* bounds left with the BAA10Y indicator's
    // outright retirement 2026-08-11 — the borrowed-source constants no longer exist to pin.)
  });

  test("R2/R3/R4 are VELOCITY - metrics route to the velocity bound set (vs delta20)", () => {
    // dgs10 metrics surface in vel* fields, NEVER the level evt*/z* fields (those compare
    // `level`; a velocity id must threshold its delta20).
    expect(resolveCuts("R2", CALIB, "HIGH")).toEqual<CalibrationCuts>({
      velEvtAmber: 0.4,
      velEvtRed: 0.7,
      velZAmber: 1.5,
      velZRed: 2.0,
      velZrefMean: 0.0,
      velZrefStd: 0.2,
    });
    // R3/R4 map to dgs2/dfii10 (absent from CALIB) ⇒ velocity fields all undefined.
    expect(resolveCuts("R3", CALIB, "HIGH")).toEqual<CalibrationCuts>({
      velEvtAmber: undefined,
      velEvtRed: undefined,
      velZAmber: undefined,
      velZRed: undefined,
      velZrefMean: undefined,
      velZrefStd: undefined,
    });
  });

  test("unmapped indicator (F4) ⇒ empty cuts; empty vintage ⇒ all undefined", () => {
    expect(resolveCuts("F4", CALIB, "HIGH")).toEqual({});
    expect(resolveCuts("R5", [], "HIGH")).toEqual<CalibrationCuts>({
      evtAmber: undefined,
      evtRed: undefined,
      zAmber: undefined,
      zRed: undefined,
      zrefMean: undefined,
      zrefStd: undefined,
    });
  });

  // The all-1.0 shipped config makes m===1 the identity, so a transposed firesHighward inside
  // the decoration would pass every test above. Drive a NON-1.0 multiplier through the REAL
  // seam (injectable config) and pin the DIRECTIONAL contract: under the same m and the SAME
  // mapped row (R5 — no LOW id has a `CALIB_MAP` row since R1 left it 2026-08-31), the `direction`
  // argument alone decides whether the level cut moves UP (LOW) or DOWN (HIGH) toward danger.
  test("m≠1 executes through the real resolveCuts seam with the DIRECTIONAL split", () => {
    const m = 0.5;
    const cfg = { default: 1.0, multipliers: { R5: { multiplier: m } } };

    // R5's raw evtAmber = 33.2011 read as a LOW id: fires-lowward ⇒ m<1 lifts it UP (earlier).
    const low = resolveCuts("R5", CALIB, "LOW", cfg);
    expect(low.evtAmber!).toBeGreaterThan(33.2011); // moved UP
    expect(low.evtAmber!).toBeCloseTo(earlierCut(33.2011, false, m), 10);

    // The same row as the HIGH id it is: fires-highward ⇒ m<1 moves it DOWN (earlier).
    const high = resolveCuts("R5", CALIB, "HIGH", cfg);
    expect(high.evtAmber!).toBeLessThan(33.2011); // moved DOWN
    expect(high.evtAmber!).toBeCloseTo(earlierCut(33.2011, true, m), 10);

    // The two directions genuinely differ (a transposed levelHighward would move both the same way).
    expect(Math.sign(low.evtAmber! - 33.2011)).toBe(1);
    expect(Math.sign(high.evtAmber! - 33.2011)).toBe(-1);

    // z-cuts are highward in σ-space regardless of the id's polarity (both move DOWN under m<1).
    expect(low.zAmber!).toBeCloseTo(earlierCut(1.5, true, m), 10);
    expect(high.zAmber!).toBeCloseTo(earlierCut(1.5, true, m), 10);
  });
});

describe("withMultipliedThresholds - m≠1 through the real seam (injectable config)", () => {
  // The parity test above proves m===1 is identity; this proves the NON-identity branch actually
  // scales the convention thresholds AND flips earliness with `direction` (a transposed
  // firesHighward would move a LOW id the wrong way). Drive a real 0.5 through the injectable seam.
  const R1_LIVE = ALL_INDICATORS.find((i) => i.id === "R1")!; // LOW, redLevel 0.0, NO amberLevel
  // ⚠ Since R1 retired its fixed `amberLevel` (2026-08-30) NO shipped LOW id carries a movable level
  // cut — R1's remaining one is the immovable |0| red. So the LOW half of the direction-flip claim is
  // driven through a CONSTRUCTED carrier: a real R1 with a hypothetical amber level bolted on. The
  // seam under test is still the real `withMultipliedThresholds`; only the carrier is synthetic, and
  // `R1_LIVE` below pins that the live entry survives the same call unscathed.
  const LOW_AMBER = 0.5;
  const R1 = { ...R1_LIVE, thresholds: { ...R1_LIVE.thresholds, amberLevel: LOW_AMBER } };
  const R5 = ALL_INDICATORS.find((i) => i.id === "R5")!; // HIGH, amberLevel 20 / redLevel 30
  const m = 0.5;
  const cfg = { default: 1.0, multipliers: { R1: { multiplier: m }, R5: { multiplier: m } } };

  test("LOW id (R1) lifts its amber level UP; the zero red cut stays immovable", () => {
    const scaled = withMultipliedThresholds(R1, cfg);
    expect(scaled).not.toBe(R1); // non-identity branch taken
    expect(scaled.thresholds.amberLevel!).toBeGreaterThan(R1.thresholds.amberLevel!); // 0.5 → up
    expect(scaled.thresholds.amberLevel!).toBeCloseTo(earlierCut(LOW_AMBER, false, m), 10);
    expect(scaled.thresholds.redLevel).toBe(0); // |0| immovable
  });

  test("the LIVE R1 has no level-amber cut to scale - an absent knob is not invented", () => {
    const scaled = withMultipliedThresholds(R1_LIVE, cfg);
    expect(R1_LIVE.thresholds.amberLevel).toBeUndefined();
    expect(scaled.thresholds.amberLevel).toBeUndefined();
    expect(scaled.thresholds.redLevel).toBe(0);
  });

  test("HIGH id (R5) moves its amber level DOWN - the opposite direction to R1", () => {
    const scaled = withMultipliedThresholds(R5, cfg);
    expect(scaled.thresholds.amberLevel!).toBeLessThan(R5.thresholds.amberLevel!); // 20 → down
    expect(scaled.thresholds.amberLevel!).toBeCloseTo(earlierCut(20, true, m), 10);
    // Direction genuinely differs from R1 (a transposed firesHighward would move both the same way).
    const r1 = withMultipliedThresholds(R1, cfg);
    expect(Math.sign(r1.thresholds.amberLevel! - R1.thresholds.amberLevel!)).toBe(1);
    expect(Math.sign(scaled.thresholds.amberLevel! - R5.thresholds.amberLevel!)).toBe(-1);
  });
});

describe("scoreIndicator measured z-leg wiring (threshold-provenance Phase 3)", () => {
  // R5/vix is own-series: scoreIndicator must BUILD the per-day z from the indicator's
  // own values + the published vix zref, so a low-VIX day below the absolute level
  // still fires once its regime-relative z crosses the cut.
  const r5 = indicator({ id: "R5", channel: "COINCIDENT", direction: "HIGH", thresholds: { amberLevel: 100, redLevel: 200 } });
  const ownCalib = [
    { channel: "vol", metric: "vix_zscore_amber", value: 1.5 },
    { channel: "vol", metric: "vix_zscore_red", value: 2.0 },
    { channel: "vol", metric: "vix_zref_mean", value: 15 },
    { channel: "vol", metric: "vix_zref_std", value: 5 },
  ];

  test("own-series z fires EARLIER than the absolute level (calibration present)", () => {
    // z = (23 − 15) / 5 = 1.6 ≥ 1.5 amber, < 2.0 red ⇒ AMBER, though level 23 ≪ 100.
    expect(scoreIndicator(r5, flat(23), resolveCuts("R5", ownCalib, "HIGH")).state).toBe("AMBER");
  });

  test("R2/R3/R4 velocity z + EVT compare delta20 (own-series, inline) - fires earlier", () => {
    // R2 is velocity-only (no level cut). A 20-day RISE of 0.5 (ramp +0.025/obs over the
    // window) is below the absolute redVelocity 0.7 but: velEvt amber 0.4 (delta20 0.5 ≥
    // 0.4) AND velZ = (0.5 − 0)/0.2 = 2.5 ≥ 2.0 red ⇒ RED via the measured velocity legs.
    const r2 = indicator({ id: "R2", channel: "RATE", thresholds: { amberVelocity: 0.4, redVelocity: 0.7 } });
    const cuts = resolveCuts("R2", CALIB, "HIGH");
    // Build a strictly-rising ramp so every delta20 ≈ 0.5 across the folded window.
    const ramp: Observation[] = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, value: i * 0.025 }));
    expect(rawStateSeries(r2, ramp, cuts).at(-1)).toBe("RED");
    // Empty calib ⇒ the same ramp rides absolute velocity only: delta20 0.5 > amber 0.4,
    // < red 0.7 ⇒ AMBER (proves the measured legs ADD the earlier RED, Decision 2 floor).
    expect(rawStateSeries(r2, ramp).at(-1)).toBe("AMBER");
  });
});

describe("dual-threshold classify (via rawStateSeries) - recall-first, fail-safe", () => {
  // HIGH indicator whose absolute cuts are far away, so the measured legs decide.
  const high = indicator({ id: "HX", direction: "HIGH", thresholds: { amberLevel: 100, redLevel: 200 } });
  // Absolute amber close enough to fire on its own — used to prove the floor (d).
  const high2 = indicator({ id: "HX", direction: "HIGH", thresholds: { amberLevel: 10 } });

  test("(a) calibration present fires EARLIER than the absolute convention", () => {
    // flat(50): GREEN on absolutes (50 < 100); AMBER once an EVT amber of 40 applies.
    expect(new Set(rawStateSeries(high, flat(50)))).toEqual(new Set(["GREEN"]));
    expect(new Set(rawStateSeries(high, flat(50), { evtAmber: 40 }))).toEqual(new Set(["AMBER"]));
    expect(new Set(rawStateSeries(high, flat(50), { evtAmber: 40, evtRed: 45 }))).toEqual(new Set(["RED"]));
  });

  test("(b) empty / absent calibration ⇒ byte-identical to the pure-absolute path", () => {
    const r1 = indicator({ id: "R1", direction: "LOW", thresholds: { amberLevel: 0.5, redLevel: 0.0 } });
    // Last 10 values cross all three states (GREEN >0.5, AMBER 0–0.5, RED <0); the
    // first 20 are a flat baseline (R1 has no velocity leg, so they only seed i−20).
    const tail = [1.0, 0.3, -0.5, 0.7, 0.0, -1.0, 0.4, 0.6, -0.2, 0.5];
    const obs: Observation[] = Array.from({ length: 30 }, (_, i) => ({
      date: `d${i}`,
      value: i < 20 ? 1 : tail[i - 20]!,
    }));
    const base = rawStateSeries(r1, obs);
    expect(new Set(base).size).toBeGreaterThan(1); // guard: the fixture really is mixed
    expect(rawStateSeries(r1, obs, {})).toEqual(base);
    expect(rawStateSeries(r1, obs, undefined)).toEqual(base);
  });

  test("(c) z-leg parity vs a hand-computed fixture (HIGH and LOW polarity)", () => {
    const cuts: CalibrationCuts = { zAmber: 1.5, zRed: 2.0 };
    // HIGH, no absolute triggers: today 10, mean 4, std 2 ⇒ z = 3 ≥ 2.0 ⇒ RED.
    const bare = indicator({ id: "HX", direction: "HIGH", thresholds: {} });
    const zHigh = calibratedZ(10, 4, 2); // 3
    const zSeries = (obs: Observation[]) => obs.slice(VELOCITY_WINDOW).map(() => zHigh);
    expect(new Set(rawStateSeries(bare, flat(10), cuts, { z: zSeries(flat(10)) }))).toEqual(new Set(["RED"]));
    // z just below amber ⇒ GREEN (1.4σ does not fire the 1.5σ amber cut).
    const calmSeries = flat(10).slice(VELOCITY_WINDOW).map(() => 1.4);
    expect(new Set(rawStateSeries(bare, flat(10), cuts, { z: calmSeries }))).toEqual(new Set(["GREEN"]));
    // LOW polarity negates z: a value far BELOW its mean (z = −3) fires, since −z = 3 ≥ 2.0.
    const low = indicator({ id: "R1", direction: "LOW", thresholds: {} });
    const zLow = calibratedZ(-2, 4, 2); // (−2−4)/2 = −3
    const lowSeries = flat(-2).slice(VELOCITY_WINDOW).map(() => zLow);
    expect(new Set(rawStateSeries(low, flat(-2), cuts, { z: lowSeries }))).toEqual(new Set(["RED"]));
    // ...and a LOW value far ABOVE mean (healthy, z = +3 ⇒ −z = −3) never fires.
    const healthySeries = flat(10).slice(VELOCITY_WINDOW).map(() => calibratedZ(10, 4, 2));
    expect(new Set(rawStateSeries(low, flat(10), cuts, { z: healthySeries }))).toEqual(new Set(["GREEN"]));
  });

  test("(d) absolute convention is a FLOOR - measured legs never silence it (Decision 2)", () => {
    // Absolute amber at 10 fires on flat(20); an EVT amber of 50 (would fire later)
    // cannot un-fire it. The result stays AMBER, proving the legs only ever ADD.
    expect(new Set(rawStateSeries(high2, flat(20), { evtAmber: 50 }))).toEqual(new Set(["AMBER"]));
  });

  test("EVT-level leg polarity is inclusive and flips for LOW (mirrors the harness ≥/≤)", () => {
    const low = indicator({ id: "R1", direction: "LOW", thresholds: {} });
    // LOW: value exactly at the EVT amber fires (≤, inclusive); just above does not.
    expect(new Set(rawStateSeries(low, flat(-0.6), { evtAmber: -0.6 }))).toEqual(new Set(["AMBER"]));
    expect(new Set(rawStateSeries(low, flat(-0.5), { evtAmber: -0.6 }))).toEqual(new Set(["GREEN"]));
    // HIGH: symmetric inclusive boundary (≥) — value exactly at the EVT amber fires.
    const high = indicator({ id: "HX", direction: "HIGH", thresholds: {} });
    expect(new Set(rawStateSeries(high, flat(40), { evtAmber: 40 }))).toEqual(new Set(["AMBER"]));
    expect(new Set(rawStateSeries(high, flat(39.9), { evtAmber: 40 }))).toEqual(new Set(["GREEN"]));
  });
});

describe("operative-cut swap (modes-and-markets ② - gate-passing measured cut REPLACES the absolute)", () => {
  // Harness-side gating (C6 + recall guard) decides WHETHER operative metrics exist;
  // this suite locks the classify semantics GIVEN they were published.
  const OP_CALIB = [
    // R5 is the level-id carrier: R1 left `CALIB_MAP` 2026-08-31, so a `t10y3m_operative_*` row
    // would early-return `{}` and never reach the routing under test.
    { channel: "vol", metric: "vix_operative_amber", value: 30 },
    { channel: "vol", metric: "vix_operative_red", value: 45 },
    { channel: "rate", metric: "dgs10_operative_amber", value: 0.6 },
    // An operative row for an id whose `CALIB_MAP` entry sets `evtLevel: false` (EBP since its
    // 2026-07-29 retirement): the row IS published and the entry IS present, so the resolver
    // reaches the gate — and the gate must refuse to let it swap EBP's own-units absolute.
    // ⚠ This row was `baa10y_operative_amber` + an F1 assertion until 2026-08-06. Stage 5.2
    // deleted `CALIB_MAP.F1`, which made that assertion VACUOUS: `resolveCuts` early-returns
    // `{fold}` on an absent entry, so `opAmber` was undefined without the units gate ever running.
    // EBP is the discriminating replacement — present in the map, gated to false.
    { channel: "credit", metric: "ebp_operative_amber", value: 3.0 },
  ];

  test("resolveCuts is TARGET-BLIND: per-cell (market, mode) rows never reach the live path", () => {
    // The notify path calls resolveCuts, which reads ONLY null/null rows — a published
    // per-cell vintage in prod's `calibration` table must not leak its cut there, regardless
    // of row order (invariant 1: the null/null filter survives the mode-machinery removal).
    const cellRow = { channel: "vol", metric: "vix_operative_red", value: 40, market: "ndx", mode: "crash" };
    expect(resolveCuts("R5", [cellRow], "HIGH").opRed).toBeUndefined();
    // Mixed vintage: the legacy shared row wins regardless of array order.
    const legacyRow = { channel: "vol", metric: "vix_operative_red", value: 45, market: null, mode: null };
    expect(resolveCuts("R5", [cellRow, legacyRow], "HIGH").opRed).toBe(45);
  });

  test("synthesized priors: every synth id resolves through the seam on BOTH legs of BOTH axes (W1)", () => {
    // Values UNCHANGED when the seam is handed the prior is the 6.2b contract. W1 adds the
    // leg coverage: the synth cut occupies the `op` legs too, so the registry prior's
    // CONVENTION fallback (`legBounds`: `op ?? t.amberLevel`) is DISPLACED rather than left
    // live as a parallel OR-leg the measured cut could only ever tighten.
    // ⚠ `SYNTH_PRIOR_IDS` is a SINGLETON — F3 alone. That the seam is CLOSED for F9/F11 is pinned
    // positively in `registry.test.ts`, never by an id's silent absence from this loop.
    const ind = byId("F3");
    const cuts = resolveCuts(
      ind.id,
      withSynthesizedPriors(ind.id, ind.thresholds, []), // EMPTY vintage — rows are synthesized
      ind.direction ?? "HIGH",
    );
    expect(cuts.evtAmber).toBe(ind.thresholds.amberLevel);
    expect(cuts.evtRed).toBe(ind.thresholds.redLevel);
    expect(cuts.opAmber).toBe(ind.thresholds.amberLevel);
    expect(cuts.opRed).toBe(ind.thresholds.redLevel);
    // The velocity axis gets its own `operative_vel_*` row — NOT the level-named
    // `operative_amber`, which would put the LEVEL cut on a `delta20` comparison and make
    // the measured velocity leg inert by domination (Stage 6.2b's finding, op axis).
    expect(cuts.velOpAmber).toBe(ind.thresholds.amberVelocity);
    // An id without `synthPriors` is passed through untouched (referential identity).
    const vintage = [{ channel: "rate", metric: "t10y3m_evt_level_amber", value: 0.5 }];
    expect(withSynthesizedPriors("R1", { amberLevel: 0.5 }, vintage)).toBe(vintage);
  });

  test("W1 regression: a DRIFTED registry prior can no longer pin a synth id RED on the notify path", () => {
    // The shipped defect (originally F9 `DTWEXBGS`, RED on every close since 2018): the series
    // drifted permanently past a prior authored for a ~100-centred index — and the run still
    // fired RED, because `classify` ORs the measured `evt` leg with the `op` leg's CONVENTION
    // fallback at the stale registry pair.
    // ⚠ **The carrier moved F9 → F11 on 2026-08-07, then F11 → F3 on 2026-08-08** (Stage 1 of
    // each scorer redesign). Both
    // ids' level axes were RETIRED, so neither has a `redLevel` for the drift window to be derived
    // from and neither has a level `op` leg left to displace — the W1 mechanism would be untestable
    // on them, not merely unexercised. F3 is the only `synthPriors` id with a level axis left, and
    // it reproduces the defect's regime exactly: its 0.5/1.0 prior is itself a DRIFTED (dead) level
    // cut, which is the very condition this test constructs a history for.
    const carrier = byId("F3");
    // A monotone-trending history standing in for the real one, DERIVED from the registry pair so
    // a retune carries it along: p85/p95 land ABOVE the prior, which is the regime the defect
    // lives in. `flat()` histories below hold delta20 = 0, so no velocity leg contaminates this.
    const lo = carrier.thresholds.redLevel! * 0.9;
    const hi = carrier.thresholds.redLevel! * 1.5;
    const history = Array.from({ length: 1000 }, (_, i) => lo + ((hi - lo) * i) / 999);
    const measured = computeSynthCuts(history, priorThresholds(carrier));
    // Precondition, asserted not assumed — without the drift this test proves nothing.
    expect(measured.amberLevel!).toBeGreaterThan(carrier.thresholds.redLevel!);
    // A level PAST the stale prior's red but BELOW the measured amber: the exact window the
    // convention leg used to own. Values are derived from the cut, never re-typed.
    const level = (carrier.thresholds.redLevel! + measured.amberLevel!) / 2;
    const histories = new Map([[carrier.id, history]]);
    // The real notify path (`run-dbfirst.ts` → `confirmers.scoreWithCuts`), empty vintage so the only
    // rows in play are the synthesized ones.
    expect(scoreWithCuts(carrier, flat(level), [], undefined, histories).state).toBe("GREEN");
    // …and the seam still ESCALATES where the measurement says so: at the measured red cut
    // the notify path fires RED (the leg displacement must not disarm the indicator).
    expect(scoreWithCuts(carrier, flat(measured.redLevel!), [], undefined, histories).state).toBe("RED");
  });

  test("synthesized priors do NOT turn on an own-series z for the synth ids (usesOwnSeriesZ FALSE)", () => {
    // Option B uses no z leg at all for these ids: `ownZ` is omitted, so `scorers.ownSeriesZ`
    // never builds a spurious own-LEVEL z — the second, UNaccepted delta the axis restructure
    // (6.2a) exists to prevent. Only R5/EBP carry an own-series z (R1's row left 2026-08-31).
    for (const id of ["F3", "F9", "F11", "R1"]) expect(usesOwnSeriesZ(id), id).toBe(false);
    for (const id of ["R5", "EBP"]) expect(usesOwnSeriesZ(id), id).toBe(true);
    // ...and no z cut/zref resolves either, so the z-leg cannot fire at all.
    const cuts = resolveCuts("F9", withSynthesizedPriors("F9", byId("F9").thresholds, []), "HIGH");
    expect(cuts.zAmber).toBeUndefined();
    expect(cuts.zrefMean).toBeUndefined();
  });

  test("resolveCuts routes operative metrics: op* (level ids), velOp* (velocity ids), never proxy", () => {
    expect(resolveCuts("R5", OP_CALIB, "HIGH")).toMatchObject({ opAmber: 30, opRed: 45 });
    expect(resolveCuts("R2", OP_CALIB, "HIGH")).toMatchObject({ velOpAmber: 0.6, velOpRed: undefined });
    // The `evtLevel` gate on the OPERATIVE legs: EBP has a live CALIB_MAP entry (so the resolver
    // runs its full body and the row's channel/prefix match) but `evtLevel: false`, so the
    // published operative cut must NOT reach `opAmber`. Red-demoed by dropping the `map.evtLevel ?`
    // guard on `opAmber` in domain-cuts.ts — it then resolves 3.0.
    expect(resolveCuts("EBP", OP_CALIB, "HIGH").opAmber).toBeUndefined(); // units/gate guard
    expect(resolveCuts("R5", [], "HIGH").opAmber).toBeUndefined();
  });

  test("swap binds - a TIGHTER operative fires later than the convention it replaces (contrast (d))", () => {
    // Convention absolute amber 10 would fire on flat(20); the operative amber 50
    // REPLACES it, so 20 is GREEN — the exact case the (d) OR-floor forbids for
    // non-gated EVT legs — and 50 fires (inclusive ≥, it's a measured cut).
    const high2 = indicator({ id: "HX", direction: "HIGH", thresholds: { amberLevel: 10 } });
    expect(new Set(rawStateSeries(high2, flat(20), { opAmber: 50 }))).toEqual(new Set(["GREEN"]));
    expect(new Set(rawStateSeries(high2, flat(50), { opAmber: 50 }))).toEqual(new Set(["AMBER"]));
  });

  test("LOW polarity swaps with EVT semantics (≤, inclusive) and per band independently", () => {
    // R1-style: convention red at 0.0 (level < 0 fires). Operative red −1.4 replaces
    // it: −0.5 no longer RED; exactly −1.4 fires (≤). Amber band has NO operative and
    // no absolute here, so it stays un-fired — bands swap independently.
    const low = indicator({ id: "R1", direction: "LOW", thresholds: { redLevel: 0.0 } });
    expect(new Set(rawStateSeries(low, flat(-0.5), { opRed: -1.4 }))).toEqual(new Set(["GREEN"]));
    expect(new Set(rawStateSeries(low, flat(-1.4), { opRed: -1.4 }))).toEqual(new Set(["RED"]));
    // Absent operative ⇒ exact fallback to the convention absolute.
    expect(new Set(rawStateSeries(low, flat(-0.5)))).toEqual(new Set(["RED"]));
  });

  test("velocity ids: velOp* replaces the convention VELOCITY leg (delta20, inclusive)", () => {
    // Ramp with delta20 ≈ 0.5: convention amberVelocity 0.4 would fire; velOpAmber
    // 0.6 replaces it ⇒ GREEN; velOpAmber 0.5 fires (≥, inclusive).
    const r2 = indicator({ id: "R2", channel: "RATE", thresholds: { amberVelocity: 0.4 } });
    const ramp: Observation[] = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, value: i * 0.025 }));
    expect(rawStateSeries(r2, ramp, { velOpAmber: 0.6 }).at(-1)).toBe("GREEN");
    expect(rawStateSeries(r2, ramp, { velOpAmber: 0.5 }).at(-1)).toBe("AMBER");
    expect(rawStateSeries(r2, ramp).at(-1)).toBe("AMBER"); // absent ⇒ convention velocity
  });

  test("EVT-OR and z legs are UNCHANGED under a swap (they still only ADD)", () => {
    // Operative amber 50 suppresses the absolute-10 fire on flat(20), but a more
    // lenient EVT-OR amber of 15 still adds its firing — the swap touches ONLY the
    // convention absolute leg.
    const high2 = indicator({ id: "HX", direction: "HIGH", thresholds: { amberLevel: 10 } });
    expect(new Set(rawStateSeries(high2, flat(20), { opAmber: 50, evtAmber: 15 }))).toEqual(new Set(["AMBER"]));
  });
});

describe("resolveBands (per-leg multiplier seam) - mechanism on synthetic inputs", () => {
  // Arbitrary scaffold values (not real band constants) so the math is proven without
  // coupling to any indicator's priors.
  test("unconfigured passes bare inputs through; a shared multiplier scales both legs; nulls stay null", () => {
    expect(resolveBands("id", 10, 20, true, { multipliers: {} })).toEqual({ amber: 10, red: 20 });
    expect(resolveBands("id", 10, 20, true, { multipliers: { id: { multiplier: 2 } } })).toEqual({ amber: 20, red: 40 });
    expect(resolveBands("id", null, null, true, { multipliers: {} })).toEqual({ amber: null, red: null });
  });
  test("per-leg amberMult/redMult scale each leg INDEPENDENTLY, negatives allowed (sign flip)", () => {
    // The prod fix in miniature: independent legs flip sign yet keep amber above red.
    expect(resolveBands("id", -1, -2, true, { multipliers: { id: { amberMult: -2, redMult: -0.5 } } })).toEqual({
      amber: 2,
      red: 1,
    });
  });
  test("a per-leg value falls back to the shared multiplier when absent", () => {
    expect(resolveBands("id", 10, 20, true, { multipliers: { id: { amberMult: -1, multiplier: 3 } } })).toEqual({
      amber: -10,
      red: 60,
    });
  });
});

describe("shipped threshold-config.json resolves F6/F8 to a non-inverting band", () => {
  // Guards the exact prod footgun: a config value that silently produces an inverted or
  // no-op band. Inputs derive from the scorer's prior SYMBOLS (not literals), so retuning
  // the priors never breaks this. The classifier is `x <= red ? RED : x <= amber ? AMBER`,
  // so a coherent LOW-is-bad band needs red STRICTLY BELOW amber — the −2.0 shared
  // multiplier attempt violated this (red above amber ⇒ permanent RED). resolveBands reads
  // the REAL committed config (default arg); fails `npm run check` before such a config
  // can reach prod again.
  // F6 is RED-only since 2026-09-02 (E4): flat 1.0 multiplier, so both legs PASS THROUGH —
  // the null amber must survive the multiplier seam un-coerced (never become 0 or NaN).
  test("F6 resolved bands: amber null pass-through, red unscaled (flat 1.0 multiplier)", () => {
    const { amber, red } = resolveBands("F6", RELSTR_AMBER, RELSTR_RED, false);
    expect(amber).toBeNull();
    expect(red).toBe(RELSTR_RED);
  });

  test("F8 resolved bands are finite and red < amber (no inversion)", () => {
    const { amber, red } = resolveBands("F8", MU_AMBER, MU_RED, false);
    expect(Number.isFinite(amber)).toBe(true);
    expect(Number.isFinite(red)).toBe(true);
    expect(red).toBeLessThan(amber);
  });
});
