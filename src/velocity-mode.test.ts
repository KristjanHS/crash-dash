import { describe, expect, it } from "vitest";
import {
  VELOCITY_WINDOW,
  type Indicator,
  type Observation,
} from "./domain-types.js";
import {
  rawStateSeries,
  scoredDaySeries,
  velocityDeltaAt,
} from "./domain-fold.js";
import { resolveCuts } from "./domain-cuts.js";
import { ALL_INDICATORS } from "./registry.js";
import { indicatorReadingSeries } from "./scorers-core.js";
import { formatVelocityDelta } from "./notify_format.js";

// `velocityMode: "relative"`: the speed leg, the persisted `delta20` and the pushed Δ are ONE number,
// `velocityDeltaAt`. Fixtures are HY-OAS-shaped (%-points) and derived from the constants below.

const obs = (values: number[]): Observation[] =>
  values.map((value, i) => ({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, value }));
// A `VELOCITY_WINDOW`-close path from `from` to `to`, linear, so the newest day's Δ is `to − from`.
const ramp = (from: number, to: number): number[] =>
  Array.from({ length: VELOCITY_WINDOW + 1 }, (_, k) => from + ((to - from) * k) / VELOCITY_WINDOW);
const F2 = ALL_INDICATORS.find((i) => i.id === "F2")!;
// A relative-mode twin of F2 (its fold policy: AMBER = either leg, RED = both) with spread-shaped cuts.
const REL_AMBER = 2.88;
const REL_RED = 3.28;
const REL_VEL_AMBER = 0.068;
const REL_VEL_RED = 0.104;
const REL: Indicator = {
  ...F2,
  velocityMode: "relative",
  thresholds: { amberLevel: REL_AMBER, redLevel: REL_RED, amberVelocity: REL_VEL_AMBER, redVelocity: REL_VEL_RED },
};
const cuts = resolveCuts(REL.id, [], "HIGH");

describe("velocityDeltaAt - relative vs absolute", () => {
  it("relative = Δ / base; absolute = Δ (a 2.60 → 2.90 widening)", () => {
    const v = ramp(2.6, 2.9);
    const i = v.length - 1;
    expect(velocityDeltaAt(v, i, REL)).toBeCloseTo((2.9 - 2.6) / 2.6, 12);
    expect(velocityDeltaAt(v, i, F2)).toBe(v[i]! - v[i - VELOCITY_WINDOW]!);
  });

  it("the head clamp divides by values[0], the same base the absolute clamp subtracts", () => {
    const v = ramp(2.6, 2.9);
    expect(velocityDeltaAt(v, 5, REL)).toBeCloseTo((v[5]! - 2.6) / 2.6, 12);
  });

  it("a non-positive base fails loud instead of persisting ±Infinity/NaN", () => {
    expect(() => velocityDeltaAt([0, 0.1], 1, REL)).toThrow(/positive base/);
  });

  it("relative + velocitySigma is refused at the fold (σ scores the absolute Δ)", () => {
    const bad: Indicator = { ...REL, thresholds: { ...REL.thresholds, velocitySigma: { window: 60, minObs: 20 } } };
    expect(() => rawStateSeries(bad, obs(ramp(2.6, 2.9)))).toThrow(/relative/);
  });
});

describe("relative mode - persisted delta20 is the scored relative delta", () => {
  it("indicatorReadingSeries emits the fraction; F2 on the same closes emits the absolute Δ", () => {
    const o = obs(ramp(2.6, 2.9));
    const rel = indicatorReadingSeries(REL, o, cuts).at(-1)!;
    const f2 = indicatorReadingSeries(F2, o).at(-1)!;
    expect(rel.delta20).toBeCloseTo(0.3 / 2.6, 12);
    expect(f2.delta20).toBeCloseTo(0.3, 12);
  });
});

describe("relative mode - RED needs level AND speed (FOLD_POLICY)", () => {
  // Speed one full band past the red cut; level just under the amber cut (GREEN on the level axis).
  const fastRel = REL_VEL_RED + (REL_VEL_RED - REL_VEL_AMBER);
  const calmLevel = REL_AMBER - 0.03;
  const wideLevel = REL_RED + (REL_RED - REL_AMBER);

  it("level GREEN with a RED-sized relative widening scores AMBER via the speed leg, not RED", () => {
    const day = obs(ramp(calmLevel / (1 + fastRel), calmLevel));
    const scored = scoredDaySeries(REL, day, cuts);
    expect(scored.rawStates.at(-1)).toBe("AMBER");
    expect(scored.legs.at(-1)).toBe("vel-op");
  });

  it("level RED AND speed RED scores RED on the composite leg", () => {
    const day = obs(ramp(wideLevel / (1 + fastRel), wideLevel));
    const scored = scoredDaySeries(REL, day, cuts);
    expect(scored.rawStates.at(-1)).toBe("RED");
    expect(scored.legs.at(-1)).toBe("op+vel-op");
  });
});

describe("formatVelocityDelta - the pushed Δ", () => {
  it("relative renders the fraction as a signed 1-dp percentage; absolute keeps formatDelta", () => {
    expect(formatVelocityDelta(0.0681, "", "relative")).toBe("+6.8%");
    expect(formatVelocityDelta(-0.0423, "", "relative")).toBe("-4.2%");
    expect(formatVelocityDelta(0.3, "%", undefined)).toBe("+0.30%");
  });
});
