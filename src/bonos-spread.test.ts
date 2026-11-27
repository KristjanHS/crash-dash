/**
 * BONOS spread scorer (`btpLegSeries`, combine "or") and its shared velocity machinery (`oatVelocityZ`,
 * `oatLegSeries`, `oatLegBase`): the VEL z leg fires on a jump, the LEVEL leg on a slow grind through the absolute
 * pair with VEL green, a calm spread stays GREEN; the bp arm is level-invariant, the worst-of attribution names the
 * 5d shock on a tie and `vel-z-slow` on a lone grind, each arm aligns to its own day, and the head is derived from
 * the constants. Cuts are read off `BONOS.thresholds` / `BONOS_DESCRIPTOR`, never restated.
 */
import { describe, expect, test } from "vitest";
import { BONOS_DESCRIPTOR } from "./family-descriptor-rows.js";
import {
  bonosSpreadReadingSeries,
  btpLegSeries,
  highBandState,
  oatLegBase,
  oatLegSeries,
  oatVelocityZ,
  scoreBonosSpread,
} from "./scorers-composite.js";
import { BONOS } from "./registry-composite.js";
import type { Observation, State } from "./domain-types.js";

const S = ["GREEN", "AMBER", "RED"] as const satisfies readonly State[];
const C = BONOS_DESCRIPTOR.scorer.constants;
const BASE = oatLegBase(C);
const SLOW = { ...C, velWindow: C.velSlowWindow };
/** The raw-endpoint arm (`endpointMean: 1`) — the pre-N1 scorer. */
const RAW = { ...C, endpointMean: 1 };
const RAW_SLOW = { ...RAW, velWindow: C.velSlowWindow };
/** Smoothed endpoints lag a step by `endpointMean − 1` days before Δ carries its full size. */
const LAG = C.endpointMean - 1;
const BUND = 2.5;

const seq = (n: number, end = "2026-01-30"): string[] => {
  const t = Date.parse(end);
  return Array.from({ length: n }, (_, i) => new Date(t - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
};
/** 10Y leg closes as (Bund + spread bp / 100) over a flat Bund ⇒ the spread is exactly `bp`. */
const legs = (bp: number[]): { es: Observation[]; de: Observation[] } => {
  const dates = seq(bp.length);
  return {
    es: bp.map((v, i) => ({ date: dates[i]!, value: BUND + v / 100 })),
    de: bp.map((_, i) => ({ date: dates[i]!, value: BUND })),
  };
};
/** Small noise so σ > 0 (a dead-flat spread degrades the velocity leg GREEN by construction). */
const noisy = (n: number, level: number): number[] => Array.from({ length: n }, (_, i) => level + Math.sin(i / 3) * 2);

// Seeded fixture PRNG (mulberry32).
const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Stationary iid noise ±6 bp around 0, quarter-bp rounded (exact in binary ⇒ Δbp is exact at any level). */
const noise = (n: number, seed: number): number[] => {
  const r = mulberry(seed);
  return Array.from({ length: n }, () => Math.round((r() - 0.5) * 12 * 4) / 4);
};
const firstDefined = (xs: ReadonlyArray<number | undefined>): number => xs.findIndex((x) => x !== undefined);

describe("BONOS two legs, worst-of", () => {
  const { amberLevel, redLevel } = BONOS.thresholds;

  test("calm below both cuts ⇒ GREEN, no leg token", () => {
    const { es, de } = legs(noisy(BASE + 40, amberLevel! / 2));
    const r = scoreBonosSpread(BONOS, es, de);
    expect(r.state).toBe("GREEN");
    expect(r.leg).toBeUndefined();
    for (const x of bonosSpreadReadingSeries(BONOS, es, de)) expect(S).toContain(x.rawState);
  });

  test("a jump inside the calm range fires the VEL leg (`vel-z`), LEVEL green", () => {
    const bp = noisy(BASE + 40, amberLevel! / 2);
    // Jump = a quarter of the amber cut in the last 3 closes: lands at ¾·amber, inside the pair, so only velocity can carry it.
    for (let i = bp.length - 3; i < bp.length; i++) bp[i]! += amberLevel! / 4;
    const { es, de } = legs(bp);
    const last = bonosSpreadReadingSeries(BONOS, es, de).at(-1)!;
    expect(last.rawState).toBe("RED");
    expect(last.leg).toMatch(/^vel-z/);
    expect(last.level).toBeLessThan(amberLevel!);
  });

  test("a slow grind above the red cut fires the LEVEL leg with VEL green", () => {
    const n = BASE + 40;
    // Linear grind at an exactly representable step (0.25 bp/day) ⇒ every Δbp bit-identical ⇒ σ = 0 ⇒ VEL degrades GREEN
    // (0.02 leaks float noise into σ and fires a spurious z).
    const bp = Array.from({ length: n }, (_, i) => redLevel! + 1 + i * 0.25);
    const { es, de } = legs(bp);
    expect(oatLegSeries(bp, C).state[n - 1]).toBe("GREEN");
    const { state, leg } = btpLegSeries(BONOS, bp, BONOS_DESCRIPTOR);
    expect(state[n - 1]).toBe("RED");
    expect(leg[n - 1]).toBe("level");
    expect(scoreBonosSpread(BONOS, es, de).state).toBe("RED");
  });

  test("between the cuts with VEL green ⇒ AMBER via the level leg", () => {
    const n = BASE + 40;
    const mid = (amberLevel! + redLevel!) / 2;
    // Flat at the midpoint: Δbp = 0 ⇒ σ = 0 ⇒ VEL green; a drift would leave a narrow pair before the head burns.
    const { state, leg } = btpLegSeries(BONOS, Array.from({ length: n }, () => mid), BONOS_DESCRIPTOR);
    expect(state[n - 1]).toBe("AMBER");
    expect(leg[n - 1]).toBe("level");
  });

  test("head guard: a series no longer than the σ head yields zero readings and the scorer throws", () => {
    const { es, de } = legs(noisy(BASE, 50));
    expect(bonosSpreadReadingSeries(BONOS, es, de)).toHaveLength(0);
    expect(() => scoreBonosSpread(BONOS, es, de)).toThrow();
  });
});

describe("the bp arm", () => {
  test("is level-invariant with smoothed endpoints: the same Δbp path at 55 bp and at 95 bp gives an identical z (log does not)", () => {
    const path = noise(BASE + 60, 3);
    path[path.length - 10]! += 40; // a spike, so the z tail is non-trivial
    const at = (lvl: number) => path.map((v) => v + lvl);
    const lo = oatVelocityZ(at(55), C);
    expect(C.measure).toBe("bp");
    expect(oatVelocityZ(at(95), C)).toEqual(lo);
    expect(oatVelocityZ(at(95), SLOW)).toEqual(oatVelocityZ(at(55), SLOW));
    // Non-vacuity: the tail is scored, and the log measure DOES see the level.
    expect(lo.filter((z) => z !== undefined).length).toBeGreaterThan(0);
    expect(lo).not.toEqual(oatVelocityZ(at(55), RAW));
    expect(oatVelocityZ(at(95), { ...C, measure: "log" })).not.toEqual(oatVelocityZ(at(55), { ...C, measure: "log" }));
  });
});

describe("worst-of attribution", () => {
  const H = BASE + 30;
  const arm = (z: number | undefined): State =>
    z === undefined ? "GREEN" : highBandState(z, C.zAmber, C.zRed);

  test("a tie (both horizons RED on a step day) is attributed to the 5d shock, `vel-z`", () => {
    const v = [...noise(H, 5).map((x) => 60 + x), ...Array.from({ length: 10 }, () => 100)];
    const STEP = H;
    // Premise: it IS a tie — both arms RED on the step day.
    expect(arm(oatVelocityZ(v, C)[STEP])).toBe("RED");
    expect(arm(oatVelocityZ(v, SLOW)[STEP])).toBe("RED");
    const o = oatLegSeries(v, C);
    expect(o.state[STEP]).toBe("RED");
    expect(o.leg[STEP]).toBe("vel-z");
  });

  test("a steady +1 bp/day grind fires `vel-z-slow` alone while the 5d arm stays GREEN", () => {
    const hist = noise(H, 9).map((x) => 60 + x);
    const G = hist.length - 1; // grind anchor
    const v = [...hist, ...Array.from({ length: 30 }, (_, g) => hist[G]! + g + 1)];
    const fastZ = oatVelocityZ(v, C);
    const slowZ = oatVelocityZ(v, SLOW);
    const o = oatLegSeries(v, C);
    // Once both smoothed endpoints sit on the grind, Δ5 = 5 bp exactly: the fast arm is GREEN throughout (premise).
    const days = Array.from({ length: v.length - (G + 5 + LAG) }, (_, k) => G + 5 + LAG + k);
    for (const i of days) expect(arm(fastZ[i]), `fast day ${i}`).toBe("GREEN");
    // Every firing day is the slow arm's, and names it.
    for (const i of days) {
      expect(o.state[i], `day ${i}`).toBe(arm(slowZ[i]));
      expect(o.leg[i], `day ${i}`).toBe(o.state[i] === "GREEN" ? undefined : "vel-z-slow");
    }
    // Non-vacuity: from grind day 20 on (Δ20 = 20 bp) the slow arm is RED.
    for (let i = G + 20 + LAG; i < v.length; i++) expect(o.state[i], `day ${i}`).toBe("RED");
  });

  test("token grammar on a lone spike: a non-GREEN day is `vel-z`, a GREEN day has no leg; a held level is absorbed GREEN", () => {
    const N = BASE + 60;
    const spread = Array.from({ length: N }, (_, i) => (i === N - 10 ? 150 : 90 + (i % 2 === 0 ? 0.3 : -0.3)));
    const { base, state, leg } = oatLegSeries(spread, C);
    expect(base).toBe(BASE);
    let firing = 0;
    for (let i = base; i < spread.length; i++) {
      expect(leg[i], `day ${i}`).toBe(state[i] === "GREEN" ? undefined : "vel-z");
      if (leg[i]) firing++;
    }
    // Non-vacuity: the fixture must actually fire.
    expect(firing).toBeGreaterThan(0);
    // A held step to 150 bp is GREEN on the velocity leg once the σ window has absorbed it.
    const heldHigh = Array.from({ length: N }, (_, i) => (i < N - 300 ? 60 : 150) + (i % 2 === 0 ? 0.3 : -0.3));
    const held = oatLegSeries(heldHigh, C);
    expect(held.state[N - 1]).toBe("GREEN");
    expect(held.leg[N - 1]).toBeUndefined();
  });
});

describe("arm alignment", () => {
  test("an isolated spike lands its raw slow z on its exact index, and that index alone", () => {
    const v = noise(BASE + 60, 13).map((x) => 60 + x);
    const SPIKE = v.length - 25;
    v[SPIKE]! += 40;
    const slowZ = oatVelocityZ(v, RAW_SLOW);
    expect(slowZ.flatMap((z, i) => (z !== undefined && z > C.zRed ? [i] : []))).toEqual([SPIKE]);
  });

  test("an isolated up-spike lands the smoothed fast z above zRed from its exact index, for the endpoint-mean span alone", () => {
    // Plateau with one isolated up-spike ⇒ a lone velocity RED; any offset shift moves that RED to a different index.
    const N = BASE + 60;
    const dipStart = BASE + 20;
    const SPIKE = dipStart + 25;
    const spread = Array.from({ length: N }, (_, i) => {
      const wig = i % 2 === 0 ? 0.3 : -0.3; // tiny wiggle ⇒ a small but nonzero Δ5 σ
      const d = i - dipStart;
      return i === SPIKE ? 96 : d >= 10 ? 90 + wig : d >= 0 ? 100 - d : 100 + wig;
    });
    const red = oatVelocityZ(spread, C).flatMap((z, i) => (z !== undefined && z > C.zRed ? [i] : []));
    expect(red).toEqual(Array.from({ length: C.endpointMean }, (_, k) => SPIKE + k));
  });

  test("a perturbed close first moves the smoothed z of BOTH arms on its own index, never a neighbour", () => {
    const v = noise(BASE + 60, 13).map((x) => 60 + x);
    const S = v.length - 25;
    const bumped = v.map((x, i) => (i === S ? x + 3 : x));
    for (const arm of [C, SLOW]) {
      const a = oatVelocityZ(v, arm);
      const b = oatVelocityZ(bumped, arm);
      expect(a.findIndex((z, i) => z !== b[i])).toBe(S);
    }
  });
});

describe("endpoint mean (N1)", () => {
  test("a one-day 10 bp spike-and-revert fires the raw 5d arm but not the smoothed one", () => {
    // iid ±6.6 bp history, then a quiet tail so Δ5 at the spike is exactly 10 bp raw vs 5 bp smoothed:
    // raw z ≈ 1.85 fires AMBER, smoothed z ≈ 1.39 stays GREEN.
    const S = BASE + 35;
    const v = noise(BASE + 60, 17).map((x, i) => (i < S - 10 ? 60 + 1.1 * x : 60));
    v[S]! += 10;
    const fired = (z: ReadonlyArray<number | undefined>) => z.some((x, i) => i >= S && x !== undefined && x >= C.zAmber);
    expect(fired(oatVelocityZ(v, RAW))).toBe(true);
    expect(fired(oatVelocityZ(v, C))).toBe(false);
  });
});

describe("head", () => {
  test("oatLegBase is exactly where the later arm's σ first lands", () => {
    const v = noise(BASE + 10, 21).map((x) => 60 + x);
    expect(BASE).toBe(Math.max(firstDefined(oatVelocityZ(v, C)), firstDefined(oatVelocityZ(v, SLOW))));
    const o = oatLegSeries(v, C);
    expect(o.base).toBe(BASE);
    expect(o.state[o.base - 1]).toBeUndefined();
    expect(o.state[o.base]).toBeDefined();
  });
});
