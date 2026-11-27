import { describe, expect, it } from "vitest";
import { retraceLine } from "../src/ladder-jobs.js";
import { makeTagOf } from "../src/ladder-live.js";
import { INDICATORS } from "../src/registry-fred.js";
import { creditConfirms, creditRungs, hyRetrace, type CreditInputs, type CreditRules } from "./ladder-credit.js";
import type { Pt } from "./ladder-replay.js";
import { shockOf } from "./ladder-shock.js";

const R: CreditRules = { BASE_N: 20, SIGMA_N: 60, BROKE_SD: 3, T1_RETRACE: 1 / 3, T2_RETRACE: 1 / 2, T2_PEAK_AGE_N: 10, T3_RETRACE: 2 / 3, ESC_HY_MA_K: 1.1, ESC_SPREAD_MA_N: 200 };
const dateAt = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const TICK = 1e-4;
const RUNGS = creditRungs(makeTagOf({ F1: "HY OAS" })({ series: ["F1"], job: "recovery", agg: "allOf" }));
const read = (k: 0 | 1 | 2, F1: Pt[], exit?: string) => RUNGS[k].read(R, { s: { F1 }, ...(exit !== undefined && { exit }) } satisfies CreditInputs);
/** 3.00/3.02 zig-zag (σ ≈ 0.02): a shock anchored on its last 3.00 close has base = median of 10 × 3.00 + 10 × 3.02 = 3.01. */
const calm = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 2 ? 3.02 : 3));

describe("hyRetrace", () => {
  it("T1: HY ⅓ back from its own shock peak to its base — a tick under the line passes, a tick over holds; never broke or no exit n/a", () => {
    const hy = (v: number) => series([...calm(80), 3.2, 3.4, 3.6, 3.8, 4, v]);
    const sh = shockOf(hy(4), R)!;
    const line = retraceLine(sh, R.T1_RETRACE);
    expect([sh.base, sh.peak, line]).toEqual([expect.closeTo(3.01, 9), 4, expect.closeTo(4 - R.T1_RETRACE * (4 - 3.01), 9)]);
    const x = dateAt(80);
    expect([read(0, hy(line - TICK), x), read(0, hy(line + TICK), x), read(0, series([...calm(80), 3.03]), x), read(0, hy(line - TICK))].map((g) => g.verdict)).toEqual(["met", "unmet", "na", "na"]);
  });
  it("quiet: an HY shock closed before the exit reads met; one opened after the exit and since closed still grades off its peak", () => {
    const before = series([...calm(80), 3.5, 4, 3.5, 3, ...calm(400)]);
    expect([shockOf(before, R)!.closedAt! < dateAt(380), read(0, before, dateAt(380))]).toEqual([true, { value: `quiet: HY shock closed ${dateAt(83)}`, verdict: "met" }]);
    expect(read(0, series([...calm(480), 3.5, 4, 3.5, 3, 3.02]), dateAt(380))).toEqual({ value: expect.stringMatching(/ \(peak 4\.00 /), verdict: "met" });
  });
  it("stale HY (no close on/after the exit) reads n/a — a gate that holds — where the same tape read on its last close passes, quiet or open", () => {
    const quiet = series([...calm(80), 3.5, 4, 3.5, 3, ...calm(400)]);
    const open = series([...calm(80), 3.2, 3.4, 3.6, 3.8, 4, retraceLine(shockOf(series([...calm(80), 3.2, 3.4, 3.6, 3.8, 4]), R)!, R.T1_RETRACE) - TICK]);
    const at = (c: Pt[], ahead: number) => read(0, c, dateAt(c.length - 1 + ahead)).verdict;
    expect([at(quiet, 0), at(quiet, 1), at(open, 0), at(open, 1)]).toEqual(["met", "na", "met", "na"]);
  });
  it("T2 ½ with the peak T2_PEAK_AGE_N closes old, T3 ⅔ — a tick under passes; a tick over, or one close younger, holds", () => {
    const hy = (v: number, n: number) => series([...calm(80), 3.2, 3.4, 3.6, 3.8, 4, ...flat(v, n)]);
    const x = dateAt(80);
    const line = (f: number) => retraceLine(shockOf(hy(4, 0), R)!, f);
    const [N, l2, l3] = [R.T2_PEAK_AGE_N, line(R.T2_RETRACE), line(R.T3_RETRACE)];
    expect(N).toBeGreaterThan(1);
    expect([read(1, hy(l2 - TICK, N), x), read(1, hy(l2 + TICK, N), x), read(1, hy(l2 - TICK, N - 1), x)].map((g) => g.verdict)).toEqual(["met", "unmet", "unmet"]);
    expect([read(2, hy(l3 - TICK, 1), x), read(2, hy(l3 + TICK, 1), x), read(2, hy(l3 - TICK, 1))].map((g) => g.verdict)).toEqual(["met", "unmet", "na"]);
  });
});

describe("hyEasing OR (`CREDIT_VEL_HIGH_N`)", () => {
  const RV: CreditRules = { ...R, CREDIT_VEL_HIGH_N: 10 };
  const { velocityWindow: VN, thresholds: { amberVelocity: CUT } } = INDICATORS.find((i) => i.id === "F1")!;
  const tag = makeTagOf({ F1: "HY OAS" })({ series: ["F1"], job: "recovery", agg: "allOf" });
  const readV = (k: 0 | 1 | 2, c: Pt[], r = RV) => RUNGS[k].read(r, { s: { F1: c }, exit: dateAt(80) }).verdict;
  const shock = [...calm(80), 3.2, 3.4, 3.6, 3.8, 4];
  /** The close VN back at `from`, the last at `to`, a close above `to` in between keeps the last under its 10-close high. */
  const rising = (from: number, to: number) => series([...shock, ...Array.from({ length: 20 }, (_, i) => 4 - ((4 - from) * (i + 1)) / 20), ...Array.from({ length: VN! - 1 }, (_, i) => from + ((to + 0.03 - from) * (i + 1)) / (VN! - 1)), to]);
  /** 2-decimal pairs a cut apart: 3.94 − 3.72 rounds under it (F1 quiet), 3.93 − 3.71 over it (F1 fires). */
  const [quiet, fires] = [rising(3.72, 3.94), rising(3.71, 3.93)];
  it("an unmet T1–T3 retrace reads met once F1's amber velocity leg is quiet (its own `>`) and its last close < its 10-close high; knob absent holds", () => {
    expect([3.94 - 3.72 > CUT!, 3.93 - 3.71 > CUT!, shockOf(quiet, R)!.peak, shockOf(fires, R)!.peak], "premise: F1's `>` on each pair; peak 4").toEqual([false, true, 4, 4]);
    expect([0, 1, 2].map((k) => readV(k as 0 | 1 | 2, quiet))).toEqual(["met", "met", "met"]);
    expect([readV(0, fires), readV(0, quiet, R)]).toEqual(["unmet", "unmet"]);
    expect(RUNGS[0].read(RV, { s: { F1: quiet }, exit: dateAt(80) }).value).toMatch(/ · easing: HY Δ\d+ \+\d\.\d\d ≤ [\d.]+ · [\d.]+ < 10-close high [\d.]+$/);
  });
  it("a last close AT its 10-close high holds; a tick under eases — and T2's peak age is bypassed; a rung without `vel` (BBB) never eases", () => {
    const flatTail = (v: number) => series([...shock, ...flat(3.9, 40), v]);
    expect([readV(0, flatTail(3.9)), readV(0, flatTail(3.9 - TICK))]).toEqual(["unmet", "met"]);
    const stepDown = (n: number) => series([...shock, ...flat(3.9, 40), ...flat(3.85, n)]);
    expect([readV(0, stepDown(RV.CREDIT_VEL_HIGH_N! - 1)), readV(0, stepDown(RV.CREDIT_VEL_HIGH_N!))], "the 3.90 high N closes back (the last counted) eases; N + 1 back holds").toEqual(["met", "unmet"]);
    const young = series([...shock, ...flat(3.2, 3)]);
    expect([readV(1, young, R), readV(1, young)]).toEqual(["unmet", "met"]);
    const bbb = hyRetrace(tag, (r) => r.T1_RETRACE, () => 0, { label: "BBB" });
    expect(bbb.read(RV, { s: { F1: flatTail(3.9 - TICK) }, exit: dateAt(80) }).verdict).toBe("unmet");
  });
  it("`credit_confirms`: an MA hit un-votes when HY eases, holds when not; knob absent votes", () => {
    const N = R.ESC_SPREAD_MA_N;
    const c = (tail: number[]) => series([...flat(3, N - 1), ...tail]);
    const easing = c([...flat(4, VN! + 5), 3.9]);
    const rising = c([...flat(3.5, VN!), 4]);
    expect([creditConfirms(easing, R).cell, creditConfirms(easing, RV).cell, creditConfirms(rising, RV).cell]).toEqual(["hit", false, "hit"]);
    expect(creditConfirms(easing, RV).value).toMatch(/ · easing: /);
  });
});

describe("creditConfirms", () => {
  it("hits at HY ≥ ESC_HY_MA_K × MA(ESC_SPREAD_MA_N) — a tick over the cut hits, a tick under clears; no history none, short of the MA na", () => {
    const N = R.ESC_SPREAD_MA_N;
    // x = K·MA ⇔ x = K·3·(N−1)/(N−K) over N−1 closes at 3.
    const cut = (R.ESC_HY_MA_K * 3 * (N - 1)) / (N - R.ESC_HY_MA_K);
    const hy = (x: number) => series([...flat(3, N - 1), x]);
    expect([creditConfirms(hy(cut + TICK), R).cell, creditConfirms(hy(cut - TICK), R).cell]).toEqual(["hit", false]);
    expect([creditConfirms([], R), creditConfirms(series(flat(3, N - 1)), R), creditConfirms(hy(3), R)]).toEqual([
      { cell: "none", rule: `HY ≥ ${R.ESC_HY_MA_K}× its MA${N}`, value: "HY no history" },
      { cell: "na", rule: `HY ≥ ${R.ESC_HY_MA_K}× its MA${N}`, value: `HY short of ${N} closes` },
      { cell: false, rule: `HY ≥ ${R.ESC_HY_MA_K}× its MA${N}`, value: `HY 3.00/${(3 * R.ESC_HY_MA_K).toFixed(2)} (MA${N} 3.00)` },
    ]);
    const [over, under] = [hy(cut + TICK), hy(cut - TICK)].map((c) => creditConfirms(c, R).value.match(/^HY (\S+)\/(\S+) \(MA\d+ \S+\)$/)!.slice(1));
    expect([over![0] !== over![1], under![0] !== under![1]], "a tick off the cut prints close and cut apart").toEqual([true, true]);
  });
});
