import { describe, expect, test } from "vitest";
import { HICP_HEAD_MONTHS, hicpDelta6m, hicpYoY } from "./hicp.js";
import { HICP } from "./registry-fred.js";
import { resolveCuts } from "./domain-cuts.js";
import { scoreIndicator } from "./scorers-core.js";
import { type Observation, type State } from "./domain-types.js";
import { CONFIRM_CLOSES, VELOCITY_WINDOW } from "./domain-types.js";
import { CARD_ONLY_GROUPS } from "./families.js";
import { FAMILY_MEMBERS, MEMBER_WEIGHT, TIMING_CLASS } from "./danger-ladder.js";

const monthly = (values: readonly number[], start = 2020 * 12): Observation[] =>
  values.map((value, i) => {
    const abs = start + i;
    return { date: `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`, value };
  });

describe("hicpDelta6m — the ONE transform the HICP card, its backfill and the ESTR hike-side study share", () => {
  test("value = y/y at t minus y/y at t−6 (pp), dated the reference month (index-paired oracle)", () => {
    const idx = monthly(Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.002 * i + 0.0001 * i * i)));
    const v = idx.map((o) => o.value);
    const yoy = (t: number): number => (v[t]! / v[t - 12]! - 1) * 100;
    const out = hicpDelta6m(idx);
    expect(out).toHaveLength(idx.length - HICP_HEAD_MONTHS);
    out.forEach((o, k) => {
      const t = k + HICP_HEAD_MONTHS;
      expect(o.date).toBe(idx[t]!.date);
      expect(o.value).toBeCloseTo(yoy(t) - yoy(t - 6), 12);
    });
  });

  test("a missing month drops exactly the rows that need it — never pairs across the gap", () => {
    const idx = monthly(Array.from({ length: 30 }, (_, i) => 100 + i + (i % 3)));
    const full = hicpDelta6m(idx).map((o) => o.date);
    // Month 10 feeds y/y(22) only, which Δ6m reads at t = 22 (as t) and t = 28 (as t−6).
    const dropped = new Set([idx[22]!.date, idx[28]!.date]);
    expect(hicpDelta6m(idx.filter((_, i) => i !== 10)).map((o) => o.date)).toEqual(full.filter((d) => !dropped.has(d)));
  });
});

describe("HICP card — display state off the registry pair, card-only", () => {
  const { amberLevel, redLevel } = HICP.thresholds;
  const eps = (redLevel! - amberLevel!) / 4;
  const flat = (x: number): Observation[] => monthly(Array<number>(VELOCITY_WINDOW + CONFIRM_CLOSES + 2).fill(x));
  const cuts = resolveCuts(HICP.id, [], HICP.direction ?? "HIGH");
  // Generic convention classify is strict on both edges, so a tie at `amberLevel` reads GREEN.
  test.each<[number, State]>([
    [redLevel! + eps, "RED"],
    [redLevel!, "AMBER"],
    [amberLevel! + eps, "AMBER"],
    [amberLevel!, "GREEN"],
  ])("Δ6m %s → %s (AMBER strictly above the amber cut, RED strictly above red)", (x, state) => {
    expect(scoreIndicator(HICP, flat(x), cuts)?.state).toBe(state);
  });

  test("a CARD_ONLY_GROUPS row; never a dial member, weight or timing row", () => {
    expect(CARD_ONLY_GROUPS.some((g) => g.ids.includes(HICP.id))).toBe(true);
    expect(Object.values(FAMILY_MEMBERS).flat()).not.toContain(HICP.id);
    expect(Object.hasOwn(MEMBER_WEIGHT, HICP.id)).toBe(false);
    expect(Object.hasOwn(TIMING_CLASS, HICP.id)).toBe(false);
  });
});

describe("hicpYoY", () => {
  test("y/y % vs the same month a year back, dated the month's 1st; a gap month drops its row", () => {
    const idx = monthly(Array.from({ length: 15 }, (_, i) => 100 + i));
    const out = hicpYoY(idx.filter((_, i) => i !== 1));
    expect(out.map((o) => o.date)).toEqual([idx[12]!.date, idx[14]!.date]);
    expect(out[0]!.value).toBeCloseTo(12, 12);
    expect(out[1]!.value).toBeCloseTo((114 / 102 - 1) * 100, 12);
  });
});
