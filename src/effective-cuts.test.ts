import { readFileSync } from "node:fs";
import { expect, test, describe } from "vitest";
import { effectiveCuts, winningLeg } from "./domain-legs.js";
import { winningLegSeries, scoredDaySeries } from "./domain-fold.js";
import { resolveCuts, type CalibrationCuts } from "./domain-cuts.js";
import { ALL_INDICATORS } from "./registry.js";
import { VELOCITY_WINDOW, type Indicator } from "./domain-types.js";

// Minimal indicators keyed by REAL ids so `effectiveCuts` resolves velocity-vs-level
// from CALIB_MAP the same way the live scorer does. Only id/thresholds/direction are
// load-bearing for the worst-of; the rest satisfy the `Indicator` shape.
const ind = (id: string, thresholds: Indicator["thresholds"], direction?: Indicator["direction"]): Indicator => ({
  id,
  label: id,
  longLabel: id,
  series: id,
  channel: "RATE",
  thresholds,
  ...(direction ? { direction } : {}),
});

describe("effectiveCuts - worst-of (earliest-firing) cut per severity", () => {
  test("(a) R5 HIGH level → min of {redLevel, evtRed, zref + zRed·std}", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 }); // HIGH (default)
    const cuts: CalibrationCuts = {
      evtRed: 33,
      evtAmber: 28,
      zRed: 2,
      zAmber: 1.5,
      zrefMean: 20,
      zrefStd: 5,
    };
    // red: min(35, 33, 20 + 2·5 = 30) = 30 ; amber: min(25, 28, 20 + 1.5·5 = 27.5) = 25
    const { effAmber, effRed } = effectiveCuts(r5, cuts);
    expect(effRed).toBeCloseTo(30);
    expect(effAmber).toBeCloseTo(25);
  });

  test("(b) R1 LOW level → max of {redLevel, evtRed, zref − zRed·std} (polarity flip)", () => {
    const r1 = ind("R1", { amberLevel: 0.5, redLevel: 0.0 }, "LOW");
    const cuts: CalibrationCuts = {
      evtRed: -0.5,
      zRed: 1,
      zAmber: 0.5,
      zrefMean: 0.8,
      zrefStd: 0.5,
    };
    // LOW ⇒ z-cut = mean − cut·std, worst-of = MAX (first crossed while falling)
    // red: max(0.0, -0.5, 0.8 − 1·0.5 = 0.3) = 0.3 (z-leg fires first)
    // amber: max(0.5, 0.8 − 0.5·0.5 = 0.55) = 0.55
    const { effAmber, effRed } = effectiveCuts(r1, cuts);
    expect(effRed).toBeCloseTo(0.3);
    expect(effAmber).toBeCloseTo(0.55);
  });

  test("(c) R2 velocity → min(redVelocity, velZref + velZRed·velStd), delta20 units, no EVT/op", () => {
    const r2 = ind("R2", { amberVelocity: 0.4, redVelocity: 0.7 });
    const cuts: CalibrationCuts = {
      velZRed: 2,
      velZAmber: 1,
      velZrefMean: 0.1,
      velZrefStd: 0.2,
    };
    // red: min(0.7, 0.1 + 2·0.2 = 0.5) = 0.5 ; amber: min(0.4, 0.1 + 1·0.2 = 0.3) = 0.3
    const { effAmber, effRed } = effectiveCuts(r2, cuts);
    expect(effRed).toBeCloseTo(0.5);
    expect(effAmber).toBeCloseTo(0.3);
  });

  test("(d) R3 velocity → velEvt included in the worst-of set", () => {
    const r3 = ind("R3", { amberVelocity: 0.35, redVelocity: 0.6 });
    const cuts: CalibrationCuts = {
      velEvtRed: 0.3, // the earliest-firing red leg
      velZRed: 3,
      velZrefMean: 0.1,
      velZrefStd: 0.1,
    };
    // red: min(0.6, velEvt 0.3, 0.1 + 3·0.1 = 0.4) = 0.3 → velEvt drives, proving it's in the set
    const { effRed } = effectiveCuts(r3, cuts);
    expect(effRed).toBeCloseTo(0.3);
  });

  test("(e) missing zref ⇒ z-leg dropped from the worst-of, not treated as 0", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 });
    const cuts: CalibrationCuts = { zRed: 2, zAmber: 1.5 }; // zref mean/std ABSENT
    // If the z-leg were mistakenly 0, red would collapse to min(35, 0) = 0.
    const { effAmber, effRed } = effectiveCuts(r5, cuts);
    expect(effRed).toBe(35);
    expect(effAmber).toBe(25);
  });

  test("(f) no applicable cut at all ⇒ {null, null}", () => {
    const bare = ind("R5", {}); // level id, empty thresholds
    const { effAmber, effRed } = effectiveCuts(bare, {});
    expect(effRed).toBeNull();
    expect(effAmber).toBeNull();
  });
});

describe("effectiveCuts - degenerate/inverted operative pair falls WHOLE-pair to convention (operative-collapse guard)", () => {
  test("(m) R1 LOW level: opAmber == opRed ⇒ pair discarded, convention lines drawn", () => {
    // Prod repro: R1 bear carried 0.38/0.38 ⇒ both lines drew on one value.
    const r1 = ind("R1", { amberLevel: 0.5, redLevel: 0.0 }, "LOW");
    const { effAmber, effRed } = effectiveCuts(r1, { opAmber: 0.38, opRed: 0.38 });
    expect(effAmber).toBe(0.5);
    expect(effRed).toBe(0.0);
  });

  test("(n) R3 velocity: velOpAmber == velOpRed ⇒ pair discarded, convention lines drawn", () => {
    // Prod repro: R3 correction/bear carried 0.23/0.23.
    const r3 = ind("R3", { amberVelocity: 0.35, redVelocity: 0.6 });
    const { effAmber, effRed } = effectiveCuts(r3, { velOpAmber: 0.23, velOpRed: 0.23 });
    expect(effAmber).toBe(0.35);
    expect(effRed).toBe(0.6);
  });

  test("(o) pair inverted in oriented space ⇒ discarded (LOW polarity: amber must sit ABOVE red)", () => {
    const r1 = ind("R1", { amberLevel: 0.5, redLevel: 0.0 }, "LOW");
    const { effAmber, effRed } = effectiveCuts(r1, { opAmber: 0.1, opRed: 0.2 });
    expect(effAmber).toBe(0.5);
    expect(effRed).toBe(0.0);
  });

  test("(p) a lone operative leg is discarded on the drawn line, never blended with convention", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 });
    const { effAmber, effRed } = effectiveCuts(r5, { opRed: 30 });
    expect(effRed).toBe(35);
    expect(effAmber).toBe(25);
  });

  test("(q) a strictly separated pair still binds (guard doesn't over-discard)", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 });
    const { effAmber, effRed } = effectiveCuts(r5, { opAmber: 22, opRed: 30 });
    expect(effAmber).toBe(22);
    expect(effRed).toBe(30);
  });
});

/**
 * F1/F2 (credit) resolve NO calibration cut but their fold. Every measured leg was retired — level EVT
 * 2026-07-23, velocity EVT/operative 2026-07-28, the borrowed Baa−10y z / vel-z legs 2026-08-06
 * — and Stage 5.2 then deleted both `CALIB_MAP` rows, so
 * `resolveCuts` returns the fold alone (read before the `CALIB_MAP` guard). The rows stay published in
 * the frozen `scripts/backtest/calibration.json` vintage, so the pin runs against the REAL tracked
 * vintage: any defined key besides `fold` is a retired leg re-admitted (on F2, a `credit/baa10y_*` row
 * leaking onto a leg scored in IG-OAS units). Red demo: re-adding `CALIB_MAP.F1` as a `credit/hyoas`
 * level row resolves `evtAmber/evtRed/zAmber/zRed/zrefMean/zrefStd` beside `fold`.
 */
describe("F1/F2 credit cuts - the retired legs stay retired against the published vintage", () => {
  const CALIB = (
    JSON.parse(readFileSync(new URL("../scripts/backtest/calibration.json", import.meta.url), "utf8")) as {
      params: { channel: string; metric: string; value: number; market?: string | null; mode?: string | null }[];
    }
  ).params;
  const shared = (metric: string): number | undefined =>
    CALIB.find((p) => p.market == null && p.mode == null && p.channel === "credit" && p.metric === metric)?.value;

  const f1 = ALL_INDICATORS.find((i) => i.id === "F1")!;
  /** Which cut keys actually resolved — `resolveCuts` writes explicit `undefined`s for absent legs. */
  const definedKeys = (cuts: object): string[] =>
    Object.entries(cuts)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort();

  test("F1 and F2 resolve their fold and NOTHING else, though every retired row is still published", () => {
    // The rows are still in the vintage — proof the empty cut sets below are the GATE, not missing rows.
    expect(CALIB.some((p) => p.channel === "credit" && p.metric === "hyoas_evt_level_amber")).toBe(true);
    expect(CALIB.some((p) => p.channel === "credit" && p.metric === "hyoas_evt_vel_amber")).toBe(true);
    expect(CALIB.some((p) => p.channel === "credit" && p.metric === "hyoas_operative_vel_amber")).toBe(true);
    expect(shared("baa10y_zref_std")).toBeGreaterThan(0);
    expect(definedKeys(resolveCuts("F1", CALIB, "HIGH"))).toEqual(["fold"]);
    expect(definedKeys(resolveCuts("F2", CALIB, "HIGH"))).toEqual(["fold"]);
  });

  /**
   * D-A / Stage 1.2 — `CALIB_MAP.F1` opened `legs.velocity`. F1 is a LEVEL-bearing id, so
   * `isVelocity = velocity && !level` is FALSE and `effectiveCuts` must keep drawing only its
   * LEVEL line — the velocity legs stay OFF the plotted axis. Were they wrongly included,
   * effRed would collapse onto the 30d velocity cut (in delta20 units), far below the level
   * line — so this fixture goes red if the axis filter breaks.
   *
   * The velocity cut it is proven against is the REGISTRY pair since 2026-07-28 (`[USER]`):
   * the measured `velEvt*` rows stopped resolving with `evtVelocity: false`, so pinning
   * against them would now assert `undefined > undefined` and pass vacuously.
   */
  test("F1 still plots its LEVEL line only - the open velocity axis stays off-plot", () => {
    const cuts = resolveCuts("F1", CALIB, "HIGH");
    const velRed = f1.thresholds.redVelocity!;
    const { effAmber, effRed } = effectiveCuts(f1, cuts);
    // Identical to the registry LEVEL prior — the velocity legs contribute nothing.
    expect(effAmber).toBe(f1.thresholds.amberLevel);
    expect(effRed).toBe(f1.thresholds.redLevel);
    // The plotted line sits FAR above the velocity cut — proof the velocity leg is off-axis.
    expect(effRed!).toBeGreaterThan(velRed);
  });
});

describe("winningLeg - which OR-leg drove a day's state (classify order, RED before AMBER)", () => {
  const HIGH = "HIGH" as const;

  test("(g) only the regime-z leg fires ⇒ 'z'", () => {
    // level below the static level cut, no EVT/op — but the standardized z crosses zRed.
    const leg = winningLeg(25, 0, { redLevel: 35 }, HIGH, { zRed: 2 }, 2.5, undefined);
    expect(leg).toBe("z");
  });

  test("(h) the operative level cut fires ⇒ 'op'", () => {
    // opRed (inclusive ≥, evt-form) fires even though the static redLevel (35) is not crossed.
    const leg = winningLeg(32, 0, { redLevel: 35 }, HIGH, { opRed: 30 });
    expect(leg).toBe("op");
  });

  test("(i) a velocity id firing on velEvt ⇒ 'vel-evt'", () => {
    // delta20 ≥ velEvtRed, and no earlier OR-leg is present to pre-empt it.
    const leg = winningLeg(0, 0.4, {}, HIGH, { velEvtRed: 0.3 });
    expect(leg).toBe("vel-evt");
  });

  test("(j) GREEN day ⇒ undefined", () => {
    const leg = winningLeg(10, 0, { redLevel: 35, amberLevel: 25 }, HIGH, {});
    expect(leg).toBeUndefined();
  });

  test("(k) OR-leg order - the level cut pre-empts a simultaneously-firing z", () => {
    // both the level leg (40 > 35) and the z-leg (5 ≥ 2) fire; classify tests op/level first.
    const leg = winningLeg(40, 0, { redLevel: 35 }, HIGH, { zRed: 2 }, 5);
    expect(leg).toBe("op");
  });
});

describe("winningLegSeries - leg emitted only where raw agrees with the confirmed ribbon state", () => {
  const day = (i: number, value: number) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, value });

  test("(l) a STAND-DOWN day (raw improved, confirmed held) ⇒ leg SUPPRESSED; the instant-up RED day ⇒ 'op'", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 }); // HIGH level id
    // 22 GREEN closes (10), a RED close (40, instant-up), then two AMBER closes (30) —
    // the stand-down direction is where suppression is live under the asym fold.
    const obs = [
      ...Array.from({ length: 22 }, (_, i) => day(i, 10)),
      day(22, 40), // raw RED — confirmed RED same-day (instant escalation)
      day(23, 30), // raw AMBER #1 — confirmed still holds RED (1 of 2 clean closes)
      day(24, 30), // raw AMBER #2 — confirmed stands down to AMBER
    ];
    const legs = winningLegSeries(r5, obs); // k=0..4 ↔ i=20..24
    expect(legs.length).toBe(obs.length - VELOCITY_WINDOW); // 5
    expect(legs[2]).toBe("op"); // raw RED confirms same-day ⇒ attributed (no unconfirmed-raw-RED day exists)
    expect(legs[3]).toBeUndefined(); // raw AMBER but confirmed held RED ⇒ suppressed (the agreement gate)
    expect(legs[4]).toBe("op"); // raw agrees with the stood-down AMBER ⇒ attributed
    expect(legs.slice(0, 2).every((l) => l === undefined)).toBe(true); // agreeing-GREEN ⇒ no leg
  });

  // `rawLegs` is the UNGATED twin of `legs` (2026-07-23 fast-credit plan, lever 2). Under the
  // asym fold the disagreement days are STAND-DOWN cells — raw improved, confirmed held worse —
  // so the ungated series names the raw (receded) leg exactly where `legs` blanks.
  test("(m) scoredDaySeries.rawLegs attributes the STAND-DOWN day that `legs` suppresses", () => {
    const r5 = ind("R5", { amberLevel: 25, redLevel: 35 });
    const obs = [
      ...Array.from({ length: 22 }, (_, i) => day(i, 10)),
      day(22, 40), // raw RED — confirmed RED same-day
      day(23, 30), // raw AMBER #1 — confirmed still holds RED
      day(24, 30), // raw AMBER #2 — confirmed stands down to AMBER
    ];
    const { legs, rawLegs } = scoredDaySeries(r5, obs);
    expect(rawLegs.length).toBe(legs.length);
    expect(legs[3]).toBeUndefined(); // the gated series suppresses the stand-down day…
    expect(rawLegs[3]).toBe("op"); // …the ungated one names the raw AMBER's leg there
    expect(rawLegs[4]).toBe("op"); // and still agrees on the stood-down day
    // Non-vacuity: the two series genuinely DIFFER on this fixture (a rawLegs that just
    // aliased `legs` would pass every assertion above except this one).
    expect(rawLegs).not.toEqual(legs);
  });
});
