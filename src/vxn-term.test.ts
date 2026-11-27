import { describe, expect, it } from "vitest";

import { CONFIRM_CLOSES, VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import { VXNT_K_WINDOW } from "./family-descriptor-rows.js";
import { VXNT } from "./registry-composite.js";
import { VT_AMBER_RATIO, VT_RED_RATIO } from "./family-descriptor-rows.js";
import { scoreVxnTerm, vxnTermDenominator } from "./scorers-composite.js";

const DAY_MS = 86_400_000;
const dateAt = (i: number): string => new Date(Date.UTC(2020, 0, 1) + i * DAY_MS).toISOString().slice(0, 10);
const obs = (values: readonly number[]): Observation[] => values.map((value, i) => ({ date: dateAt(i), value }));

/** `prior` aligned closes then D; VIXCLS ≡ 1 so VXNCLS IS the ratio, prior ratios strictly ascending. */
function priorThenD(prior: number, dRatio: number) {
  const vxn = [...Array.from({ length: prior }, (_, i) => 1 + i / 1000), dRatio];
  return { vxn: obs(vxn), vix: obs(vxn.map(() => 1)), vix3m: obs(vxn.map(() => 1)), d: dateAt(prior) };
}

/** VIXCLS ≡ VXNCLS (k ≡ 1 exactly) and VXVCLS ≡ 1, so the VXNT level IS `vxn` byte-for-byte. */
function levelFixture(levels: readonly number[]) {
  return { vxn: obs(levels), vix: obs(levels), vix3m: obs(levels.map(() => 1)) };
}

/** A GREEN head long enough for the warm-up + scorer base, then `tail` closes at `level`. */
function scoreAt(level: number, tail = CONFIRM_CLOSES) {
  const head = Array.from({ length: VXNT_K_WINDOW + VELOCITY_WINDOW + 5 }, () => VT_AMBER_RATIO / 2);
  const f = levelFixture([...head, ...Array.from({ length: tail }, () => level)]);
  return scoreVxnTerm(VXNT, f.vxn, f.vix, f.vix3m);
}

describe("vxnTermDenominator", () => {
  it("k_D reads only closes strictly before D: a D-only ratio change leaves D's denominator unchanged", () => {
    const low = priorThenD(VXNT_K_WINDOW, 0.5);
    const high = priorThenD(VXNT_K_WINDOW, 20);
    const lowRow = vxnTermDenominator(low.vxn, low.vix, low.vix3m).find((o) => o.date === low.d);
    const highRow = vxnTermDenominator(high.vxn, high.vix, high.vix3m).find((o) => o.date === high.d);
    expect(lowRow).toBeDefined();
    expect(highRow?.value).toBe(lowRow?.value);
  });

  it("warm-up floor: VXNT_K_WINDOW prior aligned closes emit D, one fewer emits nothing", () => {
    expect(VXNT_K_WINDOW).toBeGreaterThan(0);
    const full = priorThenD(VXNT_K_WINDOW, 1);
    const short = priorThenD(VXNT_K_WINDOW - 1, 1);
    expect(vxnTermDenominator(full.vxn, full.vix, full.vix3m).map((o) => o.date)).toEqual([full.d]);
    expect(vxnTermDenominator(short.vxn, short.vix, short.vix3m)).toEqual([]);
  });

  it("an even window's k is the mean of its two middle ratios, never the upper middle alone", () => {
    const vxn = obs([10, 1, 20, 2, 1]); // window 4 before D: sorted 1, 2, 10, 20 → k = (2 + 10) / 2
    expect(vxnTermDenominator(vxn, obs([1, 1, 1, 1, 1]), obs([1, 1, 1, 1, 1]), 4)).toEqual([{ date: dateAt(4), value: 6 }]);
  });

  it("a VIX3M date past VIXCLS's last close still emits: the before-D count stops at the tail (series-math `at()` guard)", () => {
    const ones = (n: number) => obs(Array.from({ length: n }, () => 1));
    const rows = vxnTermDenominator(ones(6), ones(5), ones(6), 4); // VIXCLS lags a day: d3 runs one date past r
    expect(rows).toEqual([{ date: dateAt(4), value: 1 }, { date: dateAt(5), value: 1 }]);
  });
});

describe("scoreVxnTerm — VT's cuts by reference", () => {
  it("AMBER at VT_AMBER_RATIO (inclusive)", () => {
    expect(scoreAt(VT_AMBER_RATIO).state).toBe("AMBER");
  });

  it("AMBER at VT_RED_RATIO (RED edge strict), RED just above it", () => {
    expect(scoreAt(VT_RED_RATIO).state).toBe("AMBER");
    expect(scoreAt(VT_RED_RATIO + 1e-9).state).toBe("RED");
  });

  it("sanity: VXNCLS/VIXCLS ≡ 1.30, D-rows VXNCLS = 1.015 × 1.30 × VXVCLS ⇒ level ≈ 1.015, RED", () => {
    const n = VXNT_K_WINDOW + VELOCITY_WINDOW + 5 + CONFIRM_CLOSES;
    const vix3m = Array.from({ length: n }, (_, i) => 20 + (i % 7));
    const level = (i: number) => (i >= n - CONFIRM_CLOSES ? 1.015 : VT_AMBER_RATIO / 2);
    const vxn = vix3m.map((v, i) => level(i) * 1.3 * v);
    const r = scoreVxnTerm(VXNT, obs(vxn), obs(vxn.map((v) => v / 1.3)), obs(vix3m));
    expect(r.level).toBeCloseTo(1.015, 9);
    expect(r.state).toBe("RED");
  });
});
