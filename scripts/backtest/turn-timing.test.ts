import { describe, expect, it } from "vitest";
import { shockOf } from "../ladder-shock.js";
import { SEMIS_RULES } from "../probe-semis-tranches.js";
import { episodesOf, gateStats, holdStats, RULES, stitch, timing, TURN, VOL, VOL_BOX, VOL_GATES, volEpisodes, volOf, type Ctx, type Episode } from "./turn-timing.js";

const flat = (n: number, v: number): number[] => Array.from({ length: n }, () => v);
/** Calm, a −40% V into a trough, recovery to a new high. */
const V = [...flat(300, 100), ...Array.from({ length: 40 }, (_, k) => 100 - k), ...Array.from({ length: 50 }, (_, k) => 60 + k)];

describe("episodesOf", () => {
  it("enters at −ENTER off the trailing high, troughs at the min, ends on the new high", () => {
    const [e] = episodesOf(V);
    expect(V[e!.start]! / 100 - 1).toBeLessThanOrEqual(-TURN.ENTER);
    expect(V[e!.trough]).toBe(Math.min(...V));
    expect(e!.open).toBe(false);
    expect(V[e!.end]).toBeGreaterThanOrEqual(100);
  });
  it("anchors on the trailing HIGH_N-close high, so a never-regained old high cannot swallow later episodes", () => {
    const px = [...flat(10, 100), ...flat(TURN.HIGH_N + 5, 50), ...flat(20, 30), ...flat(5, 51)];
    expect(episodesOf(px)).toHaveLength(2);
  });
  it("drops a drawdown shallower than −DEPTH", () => {
    const shallow = [...flat(300, 100), ...flat(10, 100 * (1 - TURN.ENTER) - 1), ...flat(5, 101)];
    expect(TURN.DEPTH).toBeGreaterThan(TURN.ENTER);
    expect(episodesOf(shallow)).toEqual([]);
  });
});

describe("timing", () => {
  const px = [10, 9, 8, 9, 10, 11];
  const ep: Episode = { start: 0, trough: 2, end: 5, open: false };
  it("after-stress skips a clear run that never registered stress", () => {
    const seq = [true, true, false, false, true, true];
    expect(timing(px, ep, (i) => seq[i]!, "after-stress")?.at).toBe(4);
    expect(timing(px, ep, (i) => seq[i]!, "first")?.at).toBe(0);
  });
  it("a pre-trough clear reports the further drop; n/a never clears", () => {
    const c = timing(px, ep, (i) => i === 1, "first");
    expect(c).toMatchObject({ at: 1, lag: -1 });
    expect(c!.further).toBeCloseTo(8 / 9 - 1);
    expect(timing(px, ep, () => null, "first")).toBeNull();
  });
});

it("stitch keeps the first series and appends only later dates of the second", () => {
  const a = [{ date: "2020-01-01", value: 1 }, { date: "2020-01-02", value: 2 }];
  expect(stitch(a, [{ date: "2020-01-02", value: 9 }, { date: "2020-01-03", value: 3 }]).map((p) => p.value)).toEqual([1, 2, 3]);
});

describe("retrace rules read the shipped shockOf", () => {
  // calm ±0.02 noise, a spike peaking 4.05 at close 102, then a hold at 3.6 (under the ⅓ line ≈ 3.70, over ½ ≈ 3.53)
  const v = [...Array.from({ length: 100 }, (_, k) => (k % 2 ? 3.02 : 3)), 4, 4, 4.05, 4, 4, ...flat(20, 3.6)];
  const dates = v.map((_, j) => new Date(Date.UTC(2000, 0, 1 + j)).toISOString().slice(0, 10));
  const pts = v.map((value, j) => ({ date: dates[j]!, value }));
  const k = { BASE_N: SEMIS_RULES.BASE_N, SIGMA_N: SEMIS_RULES.SIGMA_N, BROKE_SD: SEMIS_RULES.BROKE_SD };
  const ctx = (i: number): Ctx => ({ v, i, start: 100, dates, pts, shock: (j) => shockOf(pts.slice(0, j + 1), k) });
  const rule = (id: string) => RULES.find((r) => r.id === id)!.clear;
  it("n/a with no shock, clear under the ⅓ line, not under ½", () => {
    expect(rule("retr⅓")(ctx(50))).toBeNull();
    expect(rule("retr⅓")(ctx(106))).toBe(true);
    expect(rule("retr½")(ctx(106))).toBe(false);
  });
  it("+age10 holds until the peak is 10 closes old", () => {
    expect(rule("retr⅓+age10")(ctx(106))).toBe(false);
    expect(rule("retr⅓+age10")(ctx(112))).toBe(true);
  });
});

describe("vol forms", () => {
  const n = VOL.MED_N + 15;
  const d = (j: number) => new Date(Date.UTC(2000, 0, 1 + j)).toISOString().slice(0, 10);
  const ser = (f: (j: number) => number | null) => Array.from({ length: n }, (_, j) => ({ date: d(j), value: f(j)! })).filter((p) => p.value !== null);
  // VIX 18 → 22 over the last 12 closes; VIX3M 20 (missing at close 1); VXN 30 (missing at close 0)
  const v = volOf(ser((j) => (j >= n - 12 ? 22 : 18)), ser((j) => (j === 1 ? null : 20)), ser((j) => (j === 0 ? null : 30)));
  const box = (id: string) => VOL_BOX.find((r) => r.id === id)!.on;
  it("calendar = VIX ∩ VXN; VT n/a without VIX3M; VXNT waits for MED_N prior VIX3M closes", () => {
    expect(v.dates[0]).toBe(d(1));
    expect(v.vt[0]).toBeNull();
    expect(v.vxnt[VOL.MED_N]).toBeNull();
    expect(v.vxnt[VOL.MED_N + 1]).toBeCloseTo(30 / (20 * (30 / 18)));
  });
  it("VT≥1 ×10 needs ten straight closes ≥1, n/a across a VIX3M gap", () => {
    const first = v.dates.length - 12;
    expect(box("VT≥1 ×10")(v, 9, null)).toBeNull();
    expect(box("VT≥1 ×10")(v, first + 8, null)).toBe(false);
    expect(box("VT≥1 ×10")(v, first + 9, null)).toBe(true);
  });
  it("VIX≤0.8×epPeak reads the passed episode peak", () => {
    const g = VOL_GATES.find((r) => r.id === "VIX≤0.8×epPeak")!.on;
    expect([g(v, 5, null), g(v, 5, 25), g(v, 5, 22.4)]).toEqual([null, true, false]);
  });
});

describe("holdStats / gateStats", () => {
  const flat = (k: number, x: number) => Array.from({ length: k }, () => x);
  const ramp = (a: number, b: number) => Array.from({ length: Math.abs(b - a) }, (_, k) => a + Math.sign(b - a) * (k + 1));
  // calm, fall to 70, bounce to 80, fall to 50 (trough), recover to a new high
  const px = [...flat(300, 100), ...ramp(100, 70), ...ramp(70, 80), ...ramp(80, 50), ...ramp(50, 101)];
  const [e] = volEpisodes(px);
  it("a pre-trough hold counts precision on the further fall; post-trough and outside closes count apart", () => {
    const pre = holdStats(px, [e!], (i) => i < e!.trough);
    const all = holdStats(px, [e!], () => true);
    expect(pre.post).toEqual([0]);
    expect(pre.good).toBe(px.slice(e!.start, e!.trough).filter((x) => 50 / x - 1 <= -VOL.FURTHER).length);
    expect(all.post[0]).toBe(e!.end - e!.trough);
    expect(all.outside).toBe(px.length - 1 - e!.end);
  });
  it("bounce closes are bad candidates; a post-trough-only gate blocks every bad one and no good one", () => {
    const s = gateStats(px, [e!], 5, (i) => i > e!.trough);
    expect(s.bad).toBeGreaterThan(0);
    expect([s.badBlocked, s.goodBlocked, s.badAllowed]).toEqual([s.bad, 0, 0]);
  });
});
