import { expect, test, describe } from "vitest";
import {
  resolveMultiplier,
  earlierCut,
  earlierCutOpt,
  validateMultiplierConfig,
  RED_LEG_INERT_IDS,
  REACHABLE_IDS,
} from "./threshold-config.js";
import { ALL_INDICATORS } from "./registry.js";
import thresholdConfig from "../threshold-config.json" with { type: "json" };
import { resolveBands } from "./threshold-config.js";
import { derivedFiresHighward } from "./scorers-core.js";
import {
  F4_AMBER_RET,
  F4_RED_RET,
  BUND_AMBER,
  BUND_RED,
} from "./family-descriptor-rows.js";

const KNOWN = new Set(ALL_INDICATORS.map((i) => i.id));
const derivedOf = (id: string) => ALL_INDICATORS.find((i) => i.id === id)!.derived!;

describe("earlierCut - direction-normalized earliness transform", () => {
  test("m = 1 is the identity for every sign/direction (byte-parity guarantee)", () => {
    for (const v of [-10, -0.6491, 0, 0.95, 47.0061]) {
      expect(earlierCut(v, true, 1)).toBe(v);
      expect(earlierCut(v, false, 1)).toBe(v);
    }
  });

  test("directionality table: m<1 moves EVERY representation toward EARLIER", () => {
    // highward POSITIVE cut (HIGH level / velocity / z) — reduces to v·m, moves DOWN
    expect(earlierCut(10, true, 0.8)).toBeCloseTo(8, 10); // 10·0.8
    // highward NEGATIVE cut — the |v| trick keeps it monotone, moves DOWN (more negative)
    expect(earlierCut(-10, true, 0.8)).toBeCloseTo(-12, 10);
    // LOW (not highward) POSITIVE cut — moves UP toward the danger side
    expect(earlierCut(10, false, 0.8)).toBeCloseTo(12, 10);
    // LOW NEGATIVE cut (R1 amber −0.6491) — moves UP toward zero
    expect(earlierCut(-0.6491, false, 0.8)).toBeGreaterThan(-0.6491);
  });

  test("m>1 is symmetric to m<1 about the cut (later, not earlier)", () => {
    for (const [v, fh] of [
      [10, true],
      [-10, true],
      [10, false],
    ] as const) {
      const lo = earlierCut(v, fh, 0.7);
      const hi = earlierCut(v, fh, 1.3);
      expect((lo + hi) / 2).toBeCloseTo(v, 10); // symmetric about v
    }
  });

  test("zero-valued cuts are immovable under any m (|0| = 0)", () => {
    for (const m of [0.1, 0.5, 1, 2, 5]) {
      expect(earlierCut(0, true, m)).toBe(0);
      expect(earlierCut(0, false, m)).toBe(0);
    }
  });

  test("earlierCutOpt passes an absent (undefined) leg through untouched", () => {
    expect(earlierCutOpt(undefined, true, 0.5)).toBeUndefined();
    expect(earlierCutOpt(10, true, 0.5)).toBeCloseTo(5, 10);
  });
});

describe("resolveMultiplier - override → default → 1.0 precedence + guards", () => {
  test.each([
    ["positive per-id override wins", "R1", { default: 1.0, multipliers: { R1: { multiplier: 0.5 } } }, 0.5],
    ["negative override degrades to default", "R1", { default: 0.7, multipliers: { R1: { multiplier: -3 } } }, 0.7],
    ["zero override degrades to default", "R1", { default: 0.7, multipliers: { R1: { multiplier: 0 } } }, 0.7],
    ["absent override falls to default", "R1", { default: 0.6, multipliers: {} }, 0.6],
    ["bad default degrades to 1.0", "R1", { default: Number.NaN, multipliers: {} }, 1.0],
    ["unknown id → 1.0", "nope", { multipliers: {} }, 1.0],
  ] as const)("%s", (_name, id, cfg, want) => {
    expect(resolveMultiplier(id, cfg)).toBe(want);
  });
});

describe("resolveBands directionality per Stage-3.1 wired scorer", () => {
  test("G1 (positive-band return, firesHighward) - m<1 moves the amber cut DOWN", () => {
    const g1 = derivedOf("G1");
    expect(derivedFiresHighward(g1)).toBe(true);
    const { amber } = resolveBands("G1", g1.amber, g1.red, derivedFiresHighward(g1), {
      multipliers: { G1: { multiplier: 0.8 } },
    });
    expect(amber!).toBeLessThan(g1.amber!); // positive highward cut → down toward danger
  });

  test("F4 (LOW-is-bad decline, not highward) - m<1 lifts the amber cut UP toward zero", () => {
    const { amber } = resolveBands("F4", F4_AMBER_RET, F4_RED_RET, false, {
      multipliers: { F4: { multiplier: 0.8 } },
    });
    expect(amber).toBeGreaterThan(F4_AMBER_RET); // negative cut moves up toward 0 (fires earlier)
    expect(amber).toBeLessThan(0);
    // Representative SYNTHETIC negative band (ex-CG row): keeps the widen-transform assertion
    // non-degenerate however the shipped cut retunes (an amber at/near zero measures nothing).
    const neg = resolveBands("CG", -0.1, -0.1, false, { multipliers: { CG: { multiplier: 0.8 } } }).amber!;
    expect(neg).toBeGreaterThan(-0.1);
    expect(neg).toBeLessThan(0);
  });

  // A ZERO cut is immovable under the |v|-relative earliness form. `earlierCut` pins that
  // directly above; this pins it through the resolveBands SEAM, which is what the scoring
  // path actually calls. The zero is SYNTHETIC — it used to be GT's real amber, but the
  // 2026-07-29 retune moved both GT cuts positive, and no reachable id ships a zero cut now
  // (NVDA's amber 0 is deliberately outside REACHABLE_IDS). Passing it as an argument keeps
  // the seam-level invariant guarded without depending on some id happening to hold a 0.
  test("resolveBands - a zero cut passes through unmoved under any m (synthetic)", () => {
    for (const m of [0.5, 0.8, 1.25]) {
      const { amber } = resolveBands("GT", 0, null, false, { multipliers: { GT: { multiplier: m } } });
      expect(amber).toBe(0);
    }
  });

  test("GT (maSpread, not highward) - m<1 lifts BOTH cuts UP toward danger", () => {
    const gt = derivedOf("GT");
    const fh = derivedFiresHighward(gt);
    expect(fh).toBe(false); // maSpread fires LOW regardless of the cuts' sign
    const { amber, red } = resolveBands("GT", gt.amber, gt.red, fh, {
      multipliers: { GT: { multiplier: 0.8 } },
    });
    // Post-retune both cuts are POSITIVE, so "earlier" is UP on both — the direction the
    // retired negative red moved too, but now it must hold for amber as well.
    expect(gt.amber!).toBeGreaterThan(0);
    expect(gt.red!).toBeGreaterThan(0);
    expect(amber!).toBeGreaterThan(gt.amber!);
    expect(red!).toBeGreaterThan(gt.red!);
  });

  test("NVDA derived gate fires LOW (not highward)", () => {
    expect(derivedFiresHighward(derivedOf("NVDA"))).toBe(false);
  });
});

describe("validateMultiplierConfig - fail-loud on unreachable/unknown overrides", () => {
  test("the shipped config passes (default arg = real threshold-config.json)", () => {
    expect(() => validateMultiplierConfig(KNOWN)).not.toThrow();
  });

  test("a non-1.0 override on an unreachable id throws, naming the id and both remedies", () => {
    // price-accel is a known id but a percentile scorer with no |v|-relative earliness cut —
    // intentionally left OUT of REACHABLE_IDS (Stage 3.2 SKIP verdict), so an override no-ops.
    expect(REACHABLE_IDS.has("price-accel")).toBe(false);
    let msg = "";
    try {
      validateMultiplierConfig(KNOWN, { multipliers: { "price-accel": { multiplier: 0.5 } } });
    } catch (e) {
      msg = (e as Error).message;
    }
    // Pin the ACTIONABLE content, not the prose: the offending id, the set to check, and both
    // ways out. The old message asserted a single cause ("wire the scorer first") — a false
    // diagnosis when the scorer IS wired and REACHABLE_IDS is merely stale (DOC-B4).
    expect(msg).toContain("price-accel");
    expect(msg).toContain("REACHABLE_IDS");
    expect(msg).toMatch(/docs\/reference\.md/);
  });

  test("BUND is REACHABLE: a non-1.0 shared override moves its one level cut, so it must not throw", () => {
    // Prove the movement first, THEN pin the non-throw — membership alone would pass on a stale set.
    const half = { multipliers: { BUND: { multiplier: 0.5 } } };
    expect(resolveBands("BUND", BUND_AMBER, BUND_RED, false, half).amber).not.toBe(BUND_AMBER);
    expect(REACHABLE_IDS.has("BUND")).toBe(true);
    expect(() => validateMultiplierConfig(KNOWN, half)).not.toThrow();
  });

  test("a BUND redMult throws: leg (b) is single-cut, so its red leg is read by no scorer", () => {
    expect(RED_LEG_INERT_IDS.has("BUND")).toBe(true);
    expect(() => validateMultiplierConfig(KNOWN, { multipliers: { BUND: { redMult: 0.5 } } })).toThrow(/RED_LEG_INERT_IDS/);
    expect(() => validateMultiplierConfig(KNOWN, { multipliers: { BUND: { amberMult: 0.5 } } })).not.toThrow();
  });

  test("an unknown id override throws", () => {
    expect(() => validateMultiplierConfig(KNOWN, { multipliers: { ZZZ: { multiplier: 0.5 } } })).toThrow(
      /not a known ALL_INDICATORS id/,
    );
  });

  test("1.0 placeholders and label-only rows stay legal on an unreachable id", () => {
    expect(() => validateMultiplierConfig(KNOWN, { multipliers: { "price-accel": { multiplier: 1.0 } } })).not.toThrow();
    expect(() => validateMultiplierConfig(KNOWN, { multipliers: { "price-accel": { label: "x" } } })).not.toThrow();
  });
});

describe("threshold-config.json - entry-per-reachable-id coverage (DOC-B5)", () => {
  test("every REACHABLE_ID has a multipliers entry (a 1.0 placeholder at minimum)", () => {
    const keys = new Set(Object.keys(thresholdConfig.multipliers));
    const missing = [...REACHABLE_IDS].filter((id) => !keys.has(id));
    // A reachable id absent from threshold-config.json is a silent gap: a reader scanning
    // the JSON for that id's knob finds nothing, and the doc's per-id claim rots. Backfill a
    // 1.0 placeholder so the claim is true-by-construction. (DOC-B5 — 6 were missing:
    // F3/F9/F10/F11/F13 and one since-retired id. F12 is retired (DEC-21) ⇒ out of REACHABLE_IDS, correctly absent.)
    expect(missing).toEqual([]);
  });
});
