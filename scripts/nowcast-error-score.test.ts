import { describe, expect, it } from "vitest";
import { nowcastOilSpot } from "../src/oil-nowcast.js";
import { NOWCAST_BAR_MAE_RATIO, NOWCAST_BAR_MIN_N, fitBeta, p95Abs, scoreArms, walkForward } from "./nowcast-error-score.js";

/** n paired errors: carry |err| = 1 everywhere, estimate = `estScale` × that (signs alternate). */
const arms = (n: number, estScale: number): [number[], number[]] => {
  const carry = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1));
  return [carry.map((c) => c * estScale), carry];
};

describe("scoreArms — the E6 bar", () => {
  it("passes at n = MIN_N with MAE just under the ratio and p95 below carry's", () => {
    const s = scoreArms(...arms(NOWCAST_BAR_MIN_N, NOWCAST_BAR_MAE_RATIO - 0.01));
    expect(s).toMatchObject({ n: NOWCAST_BAR_MIN_N, pass: true, fails: [] });
    expect(s.ratio).toBeCloseTo(NOWCAST_BAR_MAE_RATIO - 0.01, 12);
  });

  it("fails n < MIN_N even when the estimator is perfect", () => {
    const s = scoreArms(...arms(NOWCAST_BAR_MIN_N - 1, 0));
    expect(s.pass).toBe(false);
    expect(s.fails).toEqual([`n<${NOWCAST_BAR_MIN_N}`]);
  });

  it("fails on MAE just above the ratio", () => {
    const s = scoreArms(...arms(NOWCAST_BAR_MIN_N, NOWCAST_BAR_MAE_RATIO + 0.01));
    expect(s.fails).toEqual([`MAE>${NOWCAST_BAR_MAE_RATIO}×carry`]);
  });

  it("fails the p95 clause alone: a low-MAE estimator with a fat tail", () => {
    const n = NOWCAST_BAR_MIN_N * 2;
    const carry = Array.from({ length: n }, () => 1);
    // 10% of days miss by 3 (above carry's p95 of 1), the rest are exact → MAE 0.3 ≤ 0.7.
    const est = carry.map((_, i) => (i % 10 === 0 ? 3 : 0));
    const s = scoreArms(est, carry);
    expect(s.estMae).toBeLessThanOrEqual(NOWCAST_BAR_MAE_RATIO * s.carryMae);
    expect(s.fails).toEqual(["p95>carry"]);
  });

  it("p95 is nearest-rank over |x|", () => {
    expect(p95Abs(Array.from({ length: 20 }, (_, i) => -(i + 1)))).toBe(19);
  });

  it("refuses unpaired arms", () => {
    expect(() => scoreArms([1], [1, 2])).toThrow(/unpaired/);
  });
});

describe("walkForward — pairing through a live estimator", () => {
  it("pairs every print after the first with an estimate dated that day, never seeing that day's print", () => {
    // Future == spot: a β=1 carry is exact, while carry-forward misses by each day's move.
    const obs = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"].map((date, i) => ({ date, value: 100 + 2 * i }));
    const wf = walkForward(obs, [obs], (p, [fut]) => nowcastOilSpot(p, fut!, 1), "pct");
    expect(wf.dates).toEqual(obs.slice(1).map((o) => o.date));
    expect(wf.estErr.every((e) => Math.abs(e) < 1e-9)).toBe(true);
    expect(wf.carryErr.every((e) => e < 0)).toBe(true);
  });

  it("drops a non-positive pct print from the pairs", () => {
    const spot = [{ date: "2026-01-05", value: 20 }, { date: "2026-01-06", value: 22 }, { date: "2026-01-07", value: -5 }];
    const fut = spot.map((o) => ({ date: o.date, value: 20 }));
    const wf = walkForward(spot, [fut], (p, [f]) => nowcastOilSpot(p, f!, 1), "pct");
    expect(wf.dates).toEqual(["2026-01-06"]);
    expect(wf.skipped).toBe(1);
  });
});

describe("fitBeta — the hold-out slope an arm is pinned from", () => {
  const dates = ["2019-01-02", "2019-01-03", "2019-01-04", "2019-01-07", "2020-01-02", "2020-01-03"];
  const proxy = new Map(dates.map((d, i) => [d, i * i]));
  // In-window prints move 0.5x the proxy; the 2020 pair moves 10x and must stay outside the fit.
  const prints = dates.map((date, i) => ({ date, value: date < "2020" ? 0.5 * i * i : 100 * i }));

  it("recovers the in-window slope and ignores pairs past `to`", () => {
    const { beta, n } = fitBeta(prints, (d) => proxy.get(d), { to: "2019-12-31" });
    expect(beta).toBeCloseTo(0.5, 12);
    expect(n).toBe(3);
  });

  it("skips a pair whose date has no proxy value", () => {
    const { n } = fitBeta(prints, (d) => (d === "2019-01-03" ? undefined : proxy.get(d)), { to: "2019-12-31" });
    expect(n).toBe(1);
  });
});
