/**
 * BUND's bespoke curve scorer (`scoreBundCurve`):
 * each leg's edges, (b)'s AMBER cap, (c)'s inversion regime, and the worst-of combine. Fixtures derive from
 * `BUND_DESCRIPTOR` — never a restated value.
 */
import { describe, expect, test } from "vitest";
import { BUND_DESCRIPTOR } from "./family-descriptor-rows.js";
import {
  bundLegSeries,
  bundLevelState,
  bundResteepState,
  bundVelocityState,
  ratioSpreadReadingSeries,
  scoreCurve,
  scoreRatioSpread,
} from "./scorers-composite.js";
import { BUND } from "./registry-composite.js";
import { CONFIRM_CLOSES, STATE_RANK, VELOCITY_WINDOW, type Observation } from "./domain-types.js";

const K = BUND_DESCRIPTOR.scorer.constants;
const { amber: AMBER, red: RED } = BUND_DESCRIPTOR;
const W = VELOCITY_WINDOW;

const dates = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
const obs = (values: number[]): Observation[] => {
  const d = dates(values.length);
  return values.map((value, i) => ({ date: d[i]!, value }));
};

describe("leg (a) — two-sided Δ slope velocity", () => {
  const eps = (K.velRed - K.velAmber) / 4;
  test.each([1, -1])("sign %i: AMBER at velAmber, RED at velRed (inclusive), GREEN just below", (sign) => {
    expect(bundVelocityState(sign * (K.velAmber - eps))).toBe("GREEN");
    expect(bundVelocityState(sign * K.velAmber)).toBe("AMBER");
    expect(bundVelocityState(sign * (K.velRed - eps))).toBe("AMBER");
    expect(bundVelocityState(sign * K.velRed)).toBe("RED");
  });
});

describe("leg (b) — inversion LEVEL, ONE cut (never RED)", () => {
  const eps = AMBER / 4;
  test("AMBER below `amber` however deep (the context-only `red` included); at `amber` GREEN (strict <)", () => {
    expect(bundLevelState(AMBER - eps, AMBER)).toBe("AMBER");
    expect(bundLevelState(RED - eps, AMBER)).toBe("AMBER");
    expect(bundLevelState(-AMBER, AMBER)).toBe("AMBER");
    expect(bundLevelState(AMBER, AMBER)).toBe("GREEN");
  });
});

describe("leg (c) — re-steepening escalation", () => {
  const eps = K.escDrop2y / 4;
  test("RED at a 2y fall of escDrop2y (inclusive) up to escWindow obs after the last inversion", () => {
    expect(bundResteepState(-K.escDrop2y, 0)).toBe("RED");
    expect(bundResteepState(-K.escDrop2y, K.escWindow)).toBe("RED");
    expect(bundResteepState(-K.escDrop2y, K.escWindow + 1)).toBe("GREEN");
    expect(bundResteepState(-K.escDrop2y + eps, 0)).toBe("GREEN");
    expect(bundResteepState(K.escDrop2y, 0)).toBe("GREEN"); // a 2y RISE never escalates
  });

  // Slope steep (level GREEN) except ONE inverted obs at `inv`; the 2y steps down 2·escDrop2y at `t`, so
  // its Δ reads −2·escDrop2y on [t, t+W). The window straddles inv + escWindow.
  const inv = W + 5;
  const t = inv + K.escWindow - 5;
  const n = t + W + 5;
  const y02 = Array.from({ length: n }, (_, i) => (i < t ? 2 : 2 - 2 * K.escDrop2y));
  const slopeWith = (inverted: boolean) => Array.from({ length: n }, (_, i) => (inverted && i === inv ? -AMBER : AMBER));

  test("fires only through inv + escWindow, then stops", () => {
    const legs = bundLegSeries(slopeWith(true), y02, AMBER);
    expect(legs[inv + K.escWindow]!.c).toBe("RED");
    expect(legs[inv + K.escWindow + 1]!.c).toBe("GREEN");
    expect(legs[t - 1]!.c).toBe("GREEN"); // no 2y fall yet
  });

  test("never inverted ⇒ the same 2y fall stays GREEN", () => {
    const legs = bundLegSeries(slopeWith(false), y02, AMBER);
    expect(legs.filter((l) => l?.c === "RED")).toHaveLength(0);
  });
});

describe("worst-of combine", () => {
  test("state = max rank of legs (a)/(b)/(c) on every day, each leg alone carrying it somewhere", () => {
    // Deterministic LCG walk: slope wanders across the cuts and zero, the 2y takes fast falls.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    const n = 1500;
    const slope: number[] = [];
    const y02: number[] = [];
    for (let i = 0, s = AMBER, y = 2; i < n; i++) {
      s += rnd() * K.velAmber * 0.5 - 0.02 * (s - RED); // mean-reverts near `red`, so it crosses 0
      y += rnd() * K.escDrop2y;
      slope.push(s);
      y02.push(y);
    }
    const legs = bundLegSeries(slope, y02, AMBER);
    const soleCarrier = { a: 0, b: 0, c: 0 };
    for (const l of legs) {
      if (!l) continue;
      const ranks = { a: STATE_RANK[l.a], b: STATE_RANK[l.b], c: STATE_RANK[l.c] };
      const worst = Math.max(ranks.a, ranks.b, ranks.c);
      expect(STATE_RANK[l.state]).toBe(worst);
      const carriers = (["a", "b", "c"] as const).filter((k) => ranks[k] === worst);
      if (worst > 0 && carriers.length === 1) soleCarrier[carriers[0]!]++;
    }
    expect(soleCarrier.a, "(a) alone carries a day").toBeGreaterThan(0);
    expect(soleCarrier.b, "(b) alone carries a day").toBeGreaterThan(0);
    expect(soleCarrier.c, "(c) alone carries a day").toBeGreaterThan(0);
  });
});

describe("scoreBundCurve — the run-path entry", () => {
  const curve = (slopes: number[], two = 0) => ({ y10: obs(slopes.map((s) => two + s)), y02: obs(slopes.map(() => two)) });

  test("a flat inverted curve confirms AMBER, not RED (the old level scorer's RED)", () => {
    const { y10, y02 } = curve(Array.from({ length: W + 10 }, () => RED - AMBER));
    expect(scoreCurve(BUND, BUND_DESCRIPTOR, y10, y02).state).toBe("AMBER");
  });

  test("a bear steepening of 2·velRed off a GREEN slope confirms RED (velocity is two-sided)", () => {
    const { y10, y02 } = curve(Array.from({ length: W + 10 }, (_, i) => (i < W + 5 ? AMBER : AMBER + 2 * K.velRed)));
    const r = scoreCurve(BUND, BUND_DESCRIPTOR, y10, y02);
    expect(r.state).toBe("RED");
    expect(r.delta20).toBeCloseTo(2 * K.velRed);
  });

  test("throws below VELOCITY_WINDOW + CONFIRM_CLOSES aligned closes", () => {
    const { y10, y02 } = curve(Array.from({ length: W + CONFIRM_CLOSES - 1 }, () => AMBER));
    expect(() => scoreCurve(BUND, BUND_DESCRIPTOR, y10, y02)).toThrow(new RegExp(`need ${W + CONFIRM_CLOSES} aligned closes`));
  });

  test("the latest reading is invariant to a deepened prefix (same tail covering VELOCITY_WINDOW + escWindow)", () => {
    const tail = W + K.escWindow + 2;
    // Parallel curve (slope GREEN, Δslope 0) except ONE inverted obs ~escWindow before the end, then both tenors
    // step down 2·escDrop2y near the end — leg (c) RED only if the tail still holds the inversion.
    const n = 400;
    const inv = n - 1 - (K.escWindow - 2);
    const drop = (i: number) => (i >= n - 5 ? 2 * K.escDrop2y : 0);
    const y02deep = obs(Array.from({ length: n }, (_, i) => 2.2 - drop(i)));
    const y10deep = obs(Array.from({ length: n }, (_, i) => (i === inv ? 2.2 - AMBER : 3.2) - drop(i)));
    const a = scoreCurve(BUND, BUND_DESCRIPTOR, y10deep.slice(-tail), y02deep.slice(-tail));
    const b = scoreCurve(BUND, BUND_DESCRIPTOR, y10deep, y02deep);
    expect(b.state, "premise: the deep read escalates on leg (c)").toBe("RED");
    expect([b.date, b.level, b.state]).toEqual([a.date, a.level, a.state]);
  });
});

describe("chart/scorer axis parity", () => {
  test("on a ramp, the stored `delta20` IS leg (a)'s velocity Δ (one window for chart axis and scorer)", () => {
    const n = W + 30;
    const two = Array.from({ length: n }, (_, i) => 2 - (i * K.velAmber) / n);
    const slope = Array.from({ length: n }, (_, i) => AMBER + (i * i * K.velAmber) / (n * W));
    const r = scoreCurve(BUND, BUND_DESCRIPTOR, obs(slope.map((s, i) => s + two[i]!)), obs(two));
    const leg = bundLegSeries(slope, two, AMBER).at(-1)!;
    expect(r.delta20).toBeCloseTo(leg.delta, 12);
  });
});

describe("the generic ratio-spread lattice refuses BUND", () => {
  test("ratioSpreadReadingSeries / scoreRatioSpread throw on a descriptor carrying a bespoke `scorer`", () => {
    const y02 = obs(Array.from({ length: W + 10 }, () => 2));
    const y10 = obs(Array.from({ length: W + 10 }, () => 2 + AMBER));
    const re = new RegExp(`bespoke scorer ${BUND_DESCRIPTOR.scorer.ref}`);
    expect(() => ratioSpreadReadingSeries(BUND, BUND_DESCRIPTOR, y10, y02)).toThrow(re);
    expect(() => scoreRatioSpread(BUND, BUND_DESCRIPTOR, y10, y02)).toThrow(re);
  });
});
