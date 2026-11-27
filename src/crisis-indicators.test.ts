// Stage 1 — Breakevens: T10YIE + T5YIFR
// real-history fixtures through the shipped scoreIndicator + CONFIRM fold.
//
// Fixture discipline (.claude/rules/testing-project.md): the INPUT series are approximate genuine
// FRED history (2022-03/04 T10YIE ran ~2.8–3.02; 2024 calm ~2.2–2.35; T5YIFR 2022 spiked
// ~2.4–2.67), but every EXPECTED classification is validated against the SHIPPED descriptor
// thresholds via the regime guards below (the run.test-helpers.ts CALM_F13_SPREAD pattern): if a
// default is retuned the guard reddens and the fixture must be re-derived — these fixtures
// ARE the amber-default validating tests the plan's threshold-defaults discipline demands.

import { describe, expect, test } from "vitest";

import { CONFIRM_CLOSES, VELOCITY_WINDOW, type Indicator, type Observation } from "./domain-types.js";
import { BRENT_AMBER_ROC, BRENT_DESCRIPTOR, BRENT_RED_ROC, OVX_DESCRIPTOR } from "./family-descriptor-rows.js";
import { checkOilLevelDepth } from "./confirmers.js";
import { BRENT } from "./registry-geo.js";
import { INDICATORS } from "./registry-fred.js";
import { combineLevelVelocity, levelGateOn, levelGateState, oilReadingSeries, scoreIndicator, scoreOil } from "./scorers-core.js";

const byId = (id: string): Indicator => {
  const ind = INDICATORS.find((i) => i.id === id);
  if (!ind) throw new Error(`${id} missing from INDICATORS`);
  return ind;
};

const T10YIE = byId("T10YIE");
const T5YIFR = byId("T5YIFR");

// Enough history for the velocity window + the confirmation buffer (scoreIndicator throws
// below VELOCITY_WINDOW + CONFIRM_CLOSES observations).
const MIN_OBS = VELOCITY_WINDOW + CONFIRM_CLOSES;

/** Trading-day-ish dated series from literal values (oldest→newest). */
const series = (startIso: string, values: number[]): Observation[] => {
  const start = Date.parse(startIso);
  return values.map((value, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
};

/** Fixture-regime guard: the last `n` closes sit strictly ABOVE `cut` (exclusive `>`,
 *  the shipped HIGH-level compare) — else the expected state below no longer derives
 *  from the shipped thresholds and the fixture must be re-derived. */
const lastAbove = (values: number[], n: number, cut: number): boolean =>
  values.slice(-n).every((v) => v > cut);

/** The Δ over the scored velocity window on the LAST close — the day whose raw state IS the
 *  confirmed state on an escalation (instant-up under the directional fold), hence the day whose
 *  velocity leg classifies. */
const tailDelta = (values: number[]): number => values.at(-1)! - values.at(-1 - VELOCITY_WINDOW)!;

/** The LARGEST Δ over the scored velocity window anywhere in the series (every scored day, not
 *  just the tail) — the relation an all-days-GREEN fixture depends on. */
const maxWindowDelta = (values: number[]): number =>
  Math.max(...values.slice(VELOCITY_WINDOW).map((v, i) => v - values[i]!));

describe("T10YIE - 2022-03/04 de-anchoring window confirms RED; 2024 calm window GREEN", () => {
  // Approximate genuine T10YIE closes, Mar→Apr 2022: the climb from ~2.6% into the ~3.02
  // realized-peak zone. The last CONFIRM_CLOSES closes exceed the red cut.
  const RED_2022 = [
    2.62, 2.65, 2.69, 2.73, 2.78, 2.83, 2.86, 2.84, 2.88, 2.91,
    2.89, 2.92, 2.94, 2.90, 2.87, 2.85, 2.89, 2.93, 2.95, 2.98,
    2.96, 2.99, 3.01, 3.02,
  ];
  // Approximate genuine calm-2024 closes: ~2.2–2.35, all under the amber cut.
  const CALM_2024 = Array.from({ length: MIN_OBS + 2 }, (_, i) => 2.2 + 0.15 * Math.abs(Math.sin(i)));

  test("2022 window: last closes clear the shipped red cut ⇒ confirmed RED", () => {
    // Regime guards — expected state derives from the SHIPPED cuts, not a hand-typed claim.
    expect(T10YIE.thresholds.redLevel).toBeDefined();
    expect(lastAbove(RED_2022, CONFIRM_CLOSES, T10YIE.thresholds.redLevel!)).toBe(true);
    expect(RED_2022.length).toBeGreaterThanOrEqual(MIN_OBS);
    // VELOCITY-axis regime guard (2026-07-31, added with the velocity leg): the classifying
    // tail day's Δ20d of 0.29 sits UNDER the shipped `redVelocity` — so this fixture's RED is
    // the LEVEL leg's, as the test name claims, not the velocity leg's. Lower `redVelocity`
    // past that and this reddens, naming the velocity axis rather than silently re-attributing
    // the fixture. (Earlier climb days reach Δ 0.34, still under the shipped cut — and under
    // instant-up an earlier velocity RED would STICK, so keep the whole climb under it.)
    expect(T10YIE.thresholds.redVelocity).toBeDefined();
    expect(tailDelta(RED_2022)).toBeLessThanOrEqual(T10YIE.thresholds.redVelocity!);
    const r = scoreIndicator(T10YIE, series("2022-03-21", RED_2022));
    expect(r.state).toBe("RED");
  });

  test("2024 calm window: every close under the shipped amber cut ⇒ confirmed GREEN", () => {
    expect(T10YIE.thresholds.amberLevel).toBeDefined();
    expect(CALM_2024.every((v) => v <= T10YIE.thresholds.amberLevel!)).toBe(true);
    // VELOCITY-axis regime guard (2026-07-31): GREEN now needs the second axis too. The sine
    // wobble's largest 20d rise is 0.1369, under the shipped `amberVelocity`, so a tightening
    // retune reds HERE, naming the velocity axis, instead of flipping the fixture's expected
    // state with no explanation.
    expect(T10YIE.thresholds.amberVelocity).toBeDefined();
    expect(maxWindowDelta(CALM_2024)).toBeLessThanOrEqual(T10YIE.thresholds.amberVelocity!);
    const r = scoreIndicator(T10YIE, series("2024-05-01", CALM_2024));
    expect(r.state).toBe("GREEN");
    expect(r.rawState).toBe("GREEN");
  });
});

// Velocity leg (2026-07-31 `[USER]`). The DISCRIMINATING
// regime for a leg that did not exist before: a series climbing hard while its LEVEL never leaves the
// green band. Under the level pair alone this fixture is GREEN — the velocity pair is the only thing
// that can colour it, so deleting either registry velocity cut reds this test and nothing else.
// Setup derives from the shipped cuts (testing-project.md),
// which makes this test HOMOGENEOUS in `redVelocity` — it passes for any positive pair, including one
// 33× the measured quantile. It pins WIRING, never VALUE (no test pins a cut's value — testing-project.md).
describe("breakeven velocity leg - a climb under the level band still scores", () => {
  for (const ind of [T10YIE, T5YIFR]) {
    test(`${ind.id}: Δ over the velocity window clears the red cut while every close stays under amber`, () => {
      const t = ind.thresholds;
      expect(t.redVelocity).toBeDefined();
      expect(t.amberLevel).toBeDefined();
      // Climb by 1.5× the red velocity cut across the scored window, topping out AT the amber level.
      const rise = t.redVelocity! * 1.5;
      const step = rise / VELOCITY_WINDOW;
      const vals = Array.from({ length: MIN_OBS }, (_, i) => t.amberLevel! - step * (MIN_OBS - 1 - i));
      // Regime guards — this fixture must sit in the level-GREEN, velocity-RED corner, or it proves
      // nothing about the new leg.
      expect(Math.max(...vals)).toBeLessThanOrEqual(t.amberLevel!);
      expect(vals.at(-1)! - vals.at(-1 - VELOCITY_WINDOW)!).toBeGreaterThan(t.redVelocity!);
      const r = scoreIndicator(ind, series("2021-09-01", vals));
      expect(r.state).toBe("RED");
    });
  }
});

describe("T5YIFR - crossing the de-anchoring line escalates same-day (directional fold)", () => {
  // Approximate genuine T5YIFR closes, Mar/Apr 2022: the amber-band grind (~2.4–2.55)
  // before the spike toward the ~2.67 peak.
  const AMBER_BASE = [
    2.28, 2.31, 2.34, 2.37, 2.41, 2.44, 2.42, 2.45, 2.48, 2.46,
    2.49, 2.51, 2.47, 2.50, 2.52, 2.49, 2.53, 2.55, 2.52, 2.54,
    2.51, 2.53, 2.55,
  ];
  const SPIKE = 2.67; // ~the 2022-04-21 realized peak, above the red line

  test("2+ closes above the red line confirm RED", () => {
    const vals = [...AMBER_BASE, 2.63, SPIKE];
    expect(T5YIFR.thresholds.redLevel).toBeDefined();
    expect(lastAbove(vals, CONFIRM_CLOSES, T5YIFR.thresholds.redLevel!)).toBe(true);
    const r = scoreIndicator(T5YIFR, series("2022-03-14", vals));
    expect(r.state).toBe("RED");
  });

  test("a single-day spike above the red line confirms SAME-DAY (instant-up)", () => {
    const vals = [...AMBER_BASE, SPIKE];
    // Regime guards: only the LAST close clears red; the preceding closes sit in the amber
    // band (above amber, at-or-under red) — the SYMMETRIC 2-close fold would have held AMBER,
    // so the fixture DISCRIMINATES the directional fold from a symmetric re-buffering.
    const t = T5YIFR.thresholds;
    expect(vals.at(-1)!).toBeGreaterThan(t.redLevel!);
    expect(vals.at(-2)!).toBeLessThanOrEqual(t.redLevel!);
    expect(lastAbove(vals.slice(0, -1), CONFIRM_CLOSES, t.amberLevel!)).toBe(true);
    const r = scoreIndicator(T5YIFR, series("2022-03-14", vals));
    expect(r.rawState).toBe("RED"); // today's read sees the spike...
    expect(r.state).toBe("RED"); // ...and instant-up makes that the state, same day.
  });

  test("standing down needs 2 clean closes: one receded close after the spike still reads RED", () => {
    const t = T5YIFR.thresholds;
    const back = (t.amberLevel! + t.redLevel!) / 2; // a genuine amber-band close, under red
    const one = scoreIndicator(T5YIFR, series("2022-03-14", [...AMBER_BASE, SPIKE, back]));
    expect(one.rawState).toBe("AMBER"); // today's read has receded...
    expect(one.state).toBe("RED"); // ...but the DOWN buffer holds the confirmed RED
    const two = scoreIndicator(T5YIFR, series("2022-03-14", [...AMBER_BASE, SPIKE, back, back]));
    expect(two.state).toBe("AMBER"); // two clean closes stand it down
  });
});

// --- Stage 2 — OVX (crisis rung 2): the named validating test for the level pair ---------

const OVX = byId("OVX");

describe("OVX - 2026-06/07 Israel-Iran spike confirms non-GREEN; calm-2024 window GREEN", () => {
  // Approximate genuine OVX closes (`^OVX` since S6, ex-OVXCLS; 1 of 1254 overlap dates differs by
  // 0.09), Jun 2026: low-40s pre-strike, ending at the 2026-06-13
  // spike peak. The window ends AT the peak: under the user-set cuts the easing tail scores
  // GREEN again, so the peak day is the episode's validating close.
  const SPIKE_2026 = [
    37.8, 38.9, 39.4, 38.2, 39.0, 38.5, 40.1, 41.3, 40.8, 42.0,
    43.5, 44.2, 43.8, 44.9, 46.5, 48.0, 47.2, 49.5, 52.0, 58.4,
    66.0, 77.9,
  ];
  // Approximate genuine calm-2024 closes: ~30–35, all under the amber cut and drifting too
  // slowly for the spike leg (both legs GREEN — scoreOil is the prod entry for this id).
  const CALM_2024 = Array.from({ length: MIN_OBS + 2 }, (_, i) => 30 + 5 * Math.abs(Math.sin(i / 3)));

  test("2026 spike peak: the SPIKE leg clears red while the level leg is only AMBER ⇒ RED", () => {
    // Regime guards — the expected state derives from the SHIPPED cuts (registry + descriptor).
    const { redRet, velocityWindow } = OVX_DESCRIPTOR.scorer.constants;
    const last = SPIKE_2026.at(-1)!;
    expect(last).toBeGreaterThan(OVX.thresholds.amberLevel!); // level leg AMBER…
    expect(last).toBeLessThanOrEqual(OVX.thresholds.redLevel!); // …but NOT red on its own
    expect(last / SPIKE_2026.at(-1 - velocityWindow)! - 1).toBeGreaterThanOrEqual(redRet); // spike RED
    expect(SPIKE_2026.length).toBeGreaterThanOrEqual(MIN_OBS);
    const r = scoreOil(OVX, series("2026-06-01", SPIKE_2026));
    expect(r.state).toBe("RED");
    expect(r.state).not.toBe("GREEN");
  });

  test("calm-2024 window: every close under the amber cut, no 5-session spike ⇒ confirmed GREEN", () => {
    const { amberRet, velocityWindow } = OVX_DESCRIPTOR.scorer.constants;
    expect(OVX.thresholds.amberLevel).toBeDefined();
    expect(CALM_2024.every((v) => v <= OVX.thresholds.amberLevel!)).toBe(true);
    for (let i = velocityWindow; i < CALM_2024.length; i++)
      expect(CALM_2024[i]! / CALM_2024[i - velocityWindow]! - 1).toBeLessThan(amberRet);
    const r = scoreOil(OVX, series("2024-05-01", CALM_2024));
    expect(r.state).toBe("GREEN");
    expect(r.rawState).toBe("GREEN");
  });
});

// --- OVX slice 2 (2026-08-06): the level band OR'd with the 5-session spike ---------------
//
// Every fixture value is COMPUTED from OVX_DESCRIPTOR + the registry pair, and both expectations
// run through `combineLevelVelocity` under the SHIPPED combine mode — so a cut retune or an
// OR⇄AND flip moves the fixtures and the expectations together, with no test-body edit.
describe("OVX - either leg alone fires (combine: OR), worse-of", () => {
  const { amberRet, redRet, velocityWindow } = OVX_DESCRIPTOR.scorer.constants;
  const OVX_COMBINE = OVX_DESCRIPTOR.combine;
  const AMBER_LEVEL = OVX.thresholds.amberLevel!;
  const RED_LEVEL = OVX.thresholds.redLevel!;
  /** Clear of the band edge by more than any rounding, in the fixture's own units. */
  const MARGIN = 0.02;

  test("level GREEN + velocity RED ⇒ RED (the spike leg alone)", () => {
    // Peak sits ON the amber cut: the level leg is strict `>`, so this is GREEN by construction.
    const peak = AMBER_LEVEL;
    const base = peak / (1 + redRet + MARGIN);
    const vals = [...Array<number>(MIN_OBS - 1).fill(base), peak];
    // Regime guards — both legs' inputs, derived from the shipped constants.
    expect(peak).toBeLessThanOrEqual(AMBER_LEVEL); // level leg GREEN
    expect(vals.at(-1)! / vals.at(-1 - velocityWindow)! - 1).toBeGreaterThanOrEqual(redRet);
    expect(scoreOil(OVX, series("2026-06-01", vals)).state).toBe(
      combineLevelVelocity(OVX_COMBINE, "GREEN", "RED"),
    );
  });

  test("level RED + velocity GREEN ⇒ RED (the regime leg alone)", () => {
    // Flat at a level clear of the red cut: zero return ⇒ the spike leg cannot fire.
    const flat = RED_LEVEL * (1 + MARGIN);
    const vals = Array<number>(MIN_OBS).fill(flat);
    expect(flat).toBeGreaterThan(RED_LEVEL); // level leg RED
    expect(vals.at(-1)! / vals.at(-1 - velocityWindow)! - 1).toBeLessThan(amberRet); // velocity GREEN
    expect(scoreOil(OVX, series("2026-06-01", vals)).state).toBe(
      combineLevelVelocity(OVX_COMBINE, "RED", "GREEN"),
    );
  });
});

// --- Stage 3 — BRENT (crisis rung 3): the disjunction + amber-default validating tests ----
//
// Every fixture value is COMPUTED from the shipped BRENT_DESCRIPTOR constants (never
// hand-typed), with regime guards asserting the relation each leg depends on — retune a
// constant and the guard reddens, forcing a re-derive.

// The two shipped level-gate knobs, read from the descriptor so a retune or an OR⇄AND flip moves
// every expectation below with it (no test body changes) — `.claude/rules/indicator-loop.md`
// §"A retune is a ONE-place edit", `indicator-loop.md`.
const LEVEL_WINDOW = BRENT_DESCRIPTOR.scorer.constants.levelWindow;
const COMBINE = BRENT_DESCRIPTOR.combine;
/** What the merged scorer emits when the level gate is OFF while velocity reads RED. */
const GATE_OFF_ON_RED_VELOCITY = combineLevelVelocity(COMBINE, "GREEN", "RED");
/** …and when the gate is ON while velocity reads GREEN (the retired "level alone is RED" case). */
const GATE_ON_ON_GREEN_VELOCITY = combineLevelVelocity(COMBINE, "RED", "GREEN");

describe("combineLevelVelocity - both modes, so an OR⇄AND descriptor flip is a one-word data edit", () => {
  test("AND admits velocity through the gate; OR takes the WORSE of the two legs", () => {
    expect(combineLevelVelocity("and", "RED", "AMBER")).toBe("AMBER");
    expect(combineLevelVelocity("and", "GREEN", "RED")).toBe("GREEN");
    expect(combineLevelVelocity("or", "RED", "GREEN")).toBe("RED");
    expect(combineLevelVelocity("or", "GREEN", "AMBER")).toBe("AMBER");
    // The widening's whole point: a level leg with a real AMBER arm (OVX's band) keeps it under
    // OR instead of collapsing to the binary gate's RED. A boolean level leg cannot express this.
    expect(combineLevelVelocity("or", "AMBER", "GREEN")).toBe("AMBER");
    expect(combineLevelVelocity("or", "AMBER", "RED")).toBe("RED");
    // …and under AND any non-GREEN level is a PERMISSION, never the output severity.
    expect(combineLevelVelocity("and", "AMBER", "RED")).toBe("RED");
  });
});

describe("levelGateOn - the trailing-peak gate compares the PRIOR window, current point excluded", () => {
  test("insufficient history ⇒ ON (degrades to velocity-only, never silently mutes)", () => {
    // i < window on EVERY index of a short feed — the regime the ~22-obs fixtures below live in.
    expect(levelGateOn([1, 2, 3], 2, LEVEL_WINDOW)).toBe(true);
  });

  test("equal-to-peak gates ON, strictly-below gates OFF", () => {
    const w = 3;
    expect(levelGateOn([5, 9, 5, 9], 3, w)).toBe(true); // ties the prior peak
    expect(levelGateOn([5, 9, 5, 8], 3, w)).toBe(false); // under it
    // The current point is EXCLUDED from the peak, else this would compare 9 to itself and never fire.
    expect(levelGateOn([1, 1, 1, 9], 3, w)).toBe(true);
  });
});

describe("BRENT - the 20d ROC band joined to the trailing-peak level gate", () => {
  /** 20 baseline closes at `base`, then `tail` repeated CONFIRM_CLOSES times (the
   *  dashboard.composites.test.ts oilObs shape) — total VELOCITY_WINDOW + CONFIRM_CLOSES obs. */
  const brentObs = (base: number, tail: number): number[] => [
    ...Array.from({ length: VELOCITY_WINDOW }, () => base),
    ...Array.from({ length: CONFIRM_CLOSES }, () => tail),
  ];

  test("short history degrades the LEVEL leg to GREEN: a red-band 20d run-up caps at AMBER", () => {
    const BASE = 70;
    const TAIL = BASE * (1 + BRENT_RED_ROC + 0.06);
    // Guard the regime: the ROC leg fires, and the feed is far too short to resolve a trailing
    // peak — so this fixture (and every ~MIN_OBS one below) exercises the underrun branch
    // (`levelGateState` degrades GREEN: split RED needs a RESOLVABLE peak, never a short feed).
    expect(TAIL / BASE - 1).toBeGreaterThanOrEqual(BRENT_RED_ROC);
    expect(MIN_OBS).toBeLessThan(LEVEL_WINDOW);
    const r = scoreOil(BRENT, series("2026-06-01", brentObs(BASE, TAIL)));
    expect(r.state).toBe(GATE_OFF_ON_RED_VELOCITY);
  });

  test("a flat SHORT series scores GREEN: no velocity, no resolvable peak to grade against", () => {
    // 1000 is not a threshold copy — the fixed $100 RED level was RETIRED 2026-08-06, so an
    // arbitrarily high FLAT price still contributes no severity of its own on an underrun window.
    const FLAT = 1000;
    const vals = Array.from({ length: MIN_OBS }, () => FLAT);
    expect(0).toBeLessThan(BRENT_AMBER_ROC); // the ROC leg does NOT fire
    // Underrun degrades the level leg to GREEN (`levelGateState`); the tie-at-own-peak that
    // AMBERs on a DEEP feed (the accepted split side effect, pinned below) contributes nothing here.
    const rows = oilReadingSeries(BRENT, series("2026-06-01", vals));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.rawState).toBe("GREEN");
    expect(scoreOil(BRENT, series("2026-06-01", vals)).state).toBe("GREEN");
  });

  test("amber band: mid-band 20d run-up confirms AMBER - the named validating test for the 15% amber default", () => {
    const BASE = 70;
    const TAIL = BASE * (1 + (BRENT_AMBER_ROC + BRENT_RED_ROC) / 2);
    // Guards: inside [amber, red) on the ROC leg, below $100 on the level leg.
    expect(TAIL / BASE - 1).toBeGreaterThanOrEqual(BRENT_AMBER_ROC);
    expect(TAIL / BASE - 1).toBeLessThan(BRENT_RED_ROC);
    const r = scoreOil(BRENT, series("2026-06-01", brentObs(BASE, TAIL)));
    expect(r.state).toBe("AMBER");
  });

  test("Jun-2025-style round-trip: the spike prefix confirms AMBER, the full eased window is GREEN", () => {
    const BASE = 60;
    const SPIKE = BASE * (1 + (BRENT_AMBER_ROC + BRENT_RED_ROC) / 2); // mid amber band vs BASE
    const EASED = BASE * 1.03; // drifts back — below SPIKE and far under both legs
    // Guards: the spike ambers vs the baseline; the eased tail's 20d ROC vs the spike is
    // NEGATIVE (< amber) and everything stays under the level leg.
    expect(SPIKE / BASE - 1).toBeGreaterThanOrEqual(BRENT_AMBER_ROC);
    expect(SPIKE / BASE - 1).toBeLessThan(BRENT_RED_ROC);
    expect(EASED / SPIKE - 1).toBeLessThan(BRENT_AMBER_ROC);
    const vals = [
      ...Array.from({ length: VELOCITY_WINDOW }, () => BASE),
      ...Array.from({ length: CONFIRM_CLOSES }, () => SPIKE),
      ...Array.from({ length: VELOCITY_WINDOW }, () => EASED),
    ];
    const prefix = scoreOil(BRENT, series("2025-05-01", vals.slice(0, MIN_OBS)));
    expect(prefix.state).toBe("AMBER");
    const full = scoreOil(BRENT, series("2025-05-01", vals));
    expect(full.state).toBe("GREEN");
  });

  // --- The DISCRIMINATING pair: a feed long enough for the gate to actually resolve. Same
  // red-band velocity in both, opposite level reads — the only fixtures where the level leg can
  // change the answer, and the reason a `combine` flip needs no new test body.
  const BASE = 70;
  /** The prior 3y peak: red-band ABOVE base, so a tail can be red-band and still under it. */
  const PEAK = BASE * (1 + BRENT_RED_ROC + 0.1);
  /** Peak position — inside every scored index's prior window, never the current point. */
  const PEAK_IDX = Math.floor(LEVEL_WINDOW / 2);
  /** `LEVEL_WINDOW` closes (one of them the peak) then `CONFIRM_CLOSES` at `tail`. */
  const deepObs = (tail: number): number[] =>
    Array.from({ length: LEVEL_WINDOW + CONFIRM_CLOSES }, (_, i) =>
      i === PEAK_IDX ? PEAK : i < LEVEL_WINDOW ? BASE : tail,
    );

  test("red-band run-up that FAILS to breach the trailing peak: the level gate is OFF", () => {
    const TAIL = BASE * (1 + BRENT_RED_ROC + 0.06);
    const vals = deepObs(TAIL);
    const last = vals.length - 1;
    // Guards: velocity fires, the gate does not, and the feed is deep enough for `levelGateOn`
    // to be past its insufficient-history branch (else this fixture would silently re-test the
    // degrade path and could never discriminate).
    expect(TAIL / BASE - 1).toBeGreaterThanOrEqual(BRENT_RED_ROC);
    expect(last).toBeGreaterThanOrEqual(LEVEL_WINDOW);
    expect(levelGateOn(vals, last, LEVEL_WINDOW)).toBe(false);
    expect(scoreOil(BRENT, series("2023-01-02", vals)).state).toBe(GATE_OFF_ON_RED_VELOCITY);
  });

  test("the SAME run-up carried above the trailing peak: gate ON, confirmed RED", () => {
    const TAIL = PEAK * 1.01;
    const vals = deepObs(TAIL);
    const last = vals.length - 1;
    expect(TAIL / BASE - 1).toBeGreaterThanOrEqual(BRENT_RED_ROC);
    expect(levelGateOn(vals, last, LEVEL_WINDOW)).toBe(true);
    expect(scoreOil(BRENT, series("2023-01-02", vals)).state).toBe("RED");
  });

  test("at-peak with a QUIET 20d return ambers - the accepted split side effect (slow grind to fresh highs)", () => {
    const vals = Array.from({ length: LEVEL_WINDOW + CONFIRM_CLOSES }, () => BASE);
    const last = vals.length - 1;
    expect(levelGateOn(vals, last, LEVEL_WINDOW)).toBe(true); // flat DEEP series ties its own prior peak
    expect(scoreOil(BRENT, series("2023-01-02", vals)).state).toBe(GATE_ON_ON_GREEN_VELOCITY);
  });

  // The graded proximity rung END-TO-END through the descriptor's own `peakProximity` — flat at
  // `tail` with one PEAK spike mid-window, so the 20d ROC is exactly zero and only the level grades.
  const PROX = BRENT_DESCRIPTOR.scorer.constants.peakProximity!;
  const nearPeakObs = (tail: number): number[] =>
    Array.from({ length: LEVEL_WINDOW + CONFIRM_CLOSES }, (_, i) => (i === PEAK_IDX ? PEAK : tail));

  test("NEAR the peak (≥ peakProximity × peak, below it) with a quiet return ambers - the graded rung", () => {
    const TAIL = PEAK * (PROX + (1 - PROX) / 2); // inside [prox × peak, peak)
    const vals = nearPeakObs(TAIL);
    const last = vals.length - 1;
    expect(levelGateOn(vals, last, LEVEL_WINDOW)).toBe(false); // below the peak — RED unreachable
    expect(scoreOil(BRENT, series("2023-01-02", vals)).state).toBe("AMBER");
  });

  test("BELOW the proximity rung with a quiet return stays GREEN", () => {
    const TAIL = PEAK * PROX * 0.99;
    expect(scoreOil(BRENT, series("2023-01-02", nearPeakObs(TAIL))).state).toBe("GREEN");
  });
});

describe("levelGateState - the graded level leg (RED at peak, AMBER at ≥ proximity × peak)", () => {
  test("graded rungs off the PRIOR-window peak, current point excluded", () => {
    expect(levelGateState([100, 90, 80, 70, 96], 4, 4, 0.95)).toBe("AMBER"); // 96 ≥ 0.95 × 100, below 100
    expect(levelGateState([100, 90, 80, 70, 100], 4, 4, 0.95)).toBe("RED"); // ties the prior peak
    expect(levelGateState([100, 90, 80, 70, 94], 4, 4, 0.95)).toBe("GREEN"); // under the rung
  });
  test("default proximity 1 keeps the binary read - the AMBER rung is unreachable", () => {
    expect(levelGateState([100, 90, 80, 70, 96], 4, 4)).toBe("GREEN");
  });
  test("underrun degrades GREEN, deliberately DIVERGING from levelGateOn's degrade-to-ON", () => {
    expect(levelGateState([100, 90, 80], 2, 4, 0.95)).toBe("GREEN");
    expect(levelGateOn([100, 90, 80], 2, 4)).toBe(true);
  });
});

// --- I1 (2026-08-06 review): the LIVE-PATH depth falsifier for the level gate ------------------
//
// `levelGateOn` degrades to ON on short history BY DESIGN (pinned above), which makes a truncated
// feed indistinguishable from a healthy one at the scorer. `checkOilLevelDepth` (confirmers.ts) is
// the live-path statement about the FEED: it records a degrade event when the depth actually
// received cannot resolve the gate. It never throws, so the fixtures above stay green.
describe("checkOilLevelDepth - the live feed-depth falsifier (BRENT/G1 trailing-peak gate)", () => {
  /** Collector standing in for `recordDegrade` — the same `onDegrade` injection seam the danger
   *  engine uses, so the test never touches the module-level degrade log. */
  const collect = (): { events: { scope: string; reason: string }[]; on: (s: string, r: string) => void } => {
    const events: { scope: string; reason: string }[] = [];
    return { events, on: (scope, reason) => events.push({ scope, reason }) };
  };
  const obsOfLength = (n: number): Observation[] => series("2020-01-01", Array.from({ length: n }, () => 70));

  test("a feed SHORTER than the level window fires, and names the id + both numbers", () => {
    const c = collect();
    const short = obsOfLength(LEVEL_WINDOW - 1);
    // Regime guard: this is exactly the depth at which `levelGateOn` cannot resolve, so the gate
    // is ON and BRENT silently reverts to its pre-2026-08-06 velocity-only behaviour.
    expect(levelGateOn(short.map((o) => o.value), short.length - 1, LEVEL_WINDOW)).toBe(true);
    expect(checkOilLevelDepth(BRENT, short, c.on)).toBe(true);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.scope).toContain(BRENT.id);
    expect(c.events[0]!.reason).toContain(String(short.length));
    expect(c.events[0]!.reason).toContain(String(LEVEL_WINDOW));
  });

  test("EXACT boundary: length === levelWindow still fires (the latest index is length−1)", () => {
    // The discriminating case a `<` would get wrong: the newest scored index is `length - 1`, and
    // `levelGateOn` needs `i >= window`. At `length === LEVEL_WINDOW` that is `window - 1` ⇒ the
    // gate is STILL unresolvable, so the guard must fire here.
    const c = collect();
    expect(checkOilLevelDepth(BRENT, obsOfLength(LEVEL_WINDOW), c.on)).toBe(true);
    expect(c.events).toHaveLength(1);
  });

  test("one observation MORE than the window is silent - the guard is not fire-always", () => {
    const c = collect();
    const deep = obsOfLength(LEVEL_WINDOW + 1);
    // The gate CAN resolve here — the non-vacuity anchor: without this the two asserts above
    // would pass against a guard that fired unconditionally.
    expect(levelGateOn(deep.map((o) => o.value), deep.length - 1, LEVEL_WINDOW)).toBe(true);
    expect(checkOilLevelDepth(BRENT, deep, c.on)).toBe(false);
    expect(c.events).toEqual([]);
  });

  test("a `level: \"fixed\"` id (OVX) is out of scope - no trailing peak to be short of", () => {
    const c = collect();
    expect(checkOilLevelDepth(OVX, obsOfLength(MIN_OBS), c.on)).toBe(false);
    expect(c.events).toEqual([]);
  });
});
