import { describe, expect, it } from "vitest";
import { acceptance, BINDING, bindingTable, byDate, classifyBinding, driftSummary, driftTable, episodes, fillDrift, fillDrops, HOLDOUT_WINDOW, holdoutVerdict, parity, PASS, REPLAY, replayMode, scoreEpisode, sigmaAt, verdictLine, type EpisodeResult, type Pt, type ReplayKnobs, type ReplayRun, whyFollow, whyTable } from "./ladder-replay.js";

/** A BEAR episode with one T1 fill, no trough: `ret` alone decides the pass. */
const bear = (ret: number): EpisodeResult => ({ shockStart: "2019-01-02", exit: "2019-02-01", end: "2019-08-01", open: false, drop: 0, rise: 0, shape: "BEAR", troughLag: 20, hold: ret, ret, fills: ["2019-02-05", null, null], drops: [{ trough: 0, end: ret }, null, null] });
const bears = (n: number, ret = 0.05): EpisodeResult[] => Array.from({ length: n }, () => bear(ret));

describe("byDate", () => {
  it("sorts an out-of-order input into a fresh copy; a sorted input is copied, never aliased", () => {
    const pts: Pt[] = ["2020-01-03", "2020-01-01", "2020-01-02"].map((date, i) => ({ date, value: i }));
    expect(byDate(pts).map((p) => p.date)).toEqual(["2020-01-01", "2020-01-02", "2020-01-03"]);
    expect(pts[0]!.date).toBe("2020-01-03");
    const sorted = byDate(pts);
    expect(byDate(sorted)).not.toBe(sorted);
  });
});

describe("acceptance", () => {
  it("THIN when a verdict id is short, though the verdict passes", () => {
    const vd = holdoutVerdict(bears(HOLDOUT_WINDOW.THIN_BEARS));
    expect([vd.pass, vd.thin]).toEqual([true, false]);
    expect([acceptance(vd, ["CCC"]), acceptance(vd, [])]).toEqual(["THIN", "PASS"]);
  });
  it("THIN under THIN_BEARS bear episodes, though the verdict passes; at THIN_BEARS it reads PASS or FAIL", () => {
    const thin = holdoutVerdict(bears(HOLDOUT_WINDOW.THIN_BEARS - 1));
    expect([thin.pass, thin.thin, acceptance(thin, [])]).toEqual([true, true, "THIN"]);
    expect(acceptance(holdoutVerdict([bear(PASS.WORST_BEAR - 0.01), ...bears(HOLDOUT_WINDOW.THIN_BEARS - 1)]), [])).toBe("FAIL");
    expect(acceptance(holdoutVerdict([bear(PASS.WORST_BEAR - 0.01)]), [])).toBe("THIN");
  });
});

describe("replayMode", () => {
  it("reads a bare window as the verdict and drift: / p0: / why: as their mode; any other prefix or window throws", () => {
    expect(["sweep", "drift:holdout", "p0:sweep", "why:holdout"].map(replayMode)).toEqual([
      { mode: "verdict", window: "sweep" }, { mode: "drift", window: "holdout" }, { mode: "p0", window: "sweep" }, { mode: "why", window: "holdout" },
    ]);
    for (const bad of ["swept", "boot:sweep", "drift:", "why:drift:sweep"]) expect(() => replayMode(bad), bad).toThrow(`--replay=${bad}: holdout | sweep`);
  });
});

describe("verdictLine", () => {
  it("THIN names its bear count and every short id; a full window prints its verdict with no THIN tail", () => {
    expect(verdictLine(bears(HOLDOUT_WINDOW.THIN_BEARS - 1), ["CCC"])).toMatch(new RegExp(`→ THIN · 0 real bear\\(s\\) · THIN: ${HOLDOUT_WINDOW.THIN_BEARS - 1} bear episodes, CCC short$`));
    expect(verdictLine(bears(HOLDOUT_WINDOW.THIN_BEARS), [])).toMatch(/→ PASS · 0 real bear\(s\)$/);
  });
});

describe("holdoutVerdict", () => {
  const row = (shape: "BEAR" | "V", ret: number, fills: (string | null)[] = ["d", null, null], trough = 0): EpisodeResult => ({ shockStart: "", exit: "", end: "", open: false, drop: 0, rise: 0, shape, troughLag: 0, hold: 0, ret, fills, drops: fills.map((d) => (d === null ? null : { trough, end: 0 })) });
  const cut = PASS.WORST_BEAR;

  it("fails on any fill whose trough sinks under WORST_FILL_DROP, a V's included, however the episode ends", () => {
    const bar = PASS.WORST_FILL_DROP;
    expect(holdoutVerdict([row("BEAR", 0, undefined, bar), row("V", 0.5, undefined, bar)]).pass).toBe(true);
    expect(holdoutVerdict([row("BEAR", 0), row("V", 0.5, undefined, bar - 0.001)])).toMatchObject({ pass: false, worstFill: bar - 0.001 });
    // a −20% dip after the fill that recovers to +5% at the episode end
    const dip = [...Array<number>(10).fill(100), ...Array<number>(5).fill(80), 105].map((value, i) => ({ date: day(i), value }));
    expect(fillDrops(dip, [day(9), null, null], day(15))[0]).toEqual({ trough: expect.closeTo(-0.2, 10), end: expect.closeTo(0.05, 10) });
  });
  it("passes on the worst single bear, never the bear total or a V", () => {
    expect(holdoutVerdict([row("BEAR", cut), row("BEAR", cut), row("V", cut - 0.5)]).pass).toBe(true);
    expect(holdoutVerdict([row("BEAR", cut - 0.001), row("BEAR", 0.5)]).pass).toBe(false);
    expect([holdoutVerdict([]).pass, holdoutVerdict([row("BEAR", 0, [null, null, null]), row("V", 0.5)]).pass]).toEqual([false, false]);
  });
  it("parity reads only the dates both sides hold", () => {
    const up = [{ date: "a", value: 1 }, { date: "b", value: 2 }, { date: "c", value: 9 }];
    expect(parity(up, [{ date: "b", value: 2.5 }, { date: "c", value: null }, { date: "d", value: 0 }])).toEqual({ n: 1, max: 0.5 });
  });
});

/** Twenty final daily closes: fill drift reads index distance in `closes(px)`, so the values are irrelevant. */
const px: Pt[] = Array.from({ length: 20 }, (_, i) => ({ date: `2020-01-${String(i + 1).padStart(2, "0")}`, value: 100 }));
const day = (i: number): string => px[i]!.date;
const ep = (exit: string, fills: (string | null)[]): EpisodeResult => ({ shockStart: day(0), exit, end: day(19), open: false, drop: 0, rise: 0, shape: "BEAR", troughLag: 10, hold: 0, ret: 0, fills, drops: fills.map((d) => (d === null ? null : { trough: 0, end: 0 })) });
const shipped: ReplayRun = () => [ep(day(4), [day(6), day(9), day(14)])];
const run = (fills: (string | null)[]): ReplayRun => () => [ep(day(4), fills)];

describe("fillDrift", () => {
  it("identity → every Δ 0, no mismatch, PASS", () => {
    const rows = fillDrift(px, shipped, shipped);
    expect(rows.map((r) => [r.tranche, r.delta, r.mismatch])).toEqual([[1, 0, false], [2, 0, false], [3, 0, false]]);
    expect(driftSummary(rows)).toEqual({ maxAbs: [0, 0, 0], mismatches: 0, filled: 3, episodes: 1, pass: true });
  });
  it("a tranche moved past DRIFT.K closes FAILs on |Δ| — signed Δ in the row, the magnitude in maxAbs", () => {
    const rows = fillDrift(px, shipped, run([day(8), day(5), day(14)]));
    expect(rows.map((r) => r.delta)).toEqual([2, -4, 0]);
    expect(driftSummary(rows)).toEqual({ maxAbs: [2, 4, 0], mismatches: 0, filled: 3, episodes: 1, pass: false });
    expect(driftTable(rows).split("\n")).toEqual([`${day(4)}  T1  ${day(6)} → ${day(8)}  Δ +2`, `${day(4)}  T2  ${day(9)} → ${day(5)}  Δ -4`, "max |Δ| T1/T2/T3 2/4/0 · mismatches 0 · filled 3/1 → DRIFT FAIL (k=3)"]);
  });
  it("null vs filled is a mismatch, never a Δ — FAILs though every Δ is within DRIFT.K; both null is Δ 0", () => {
    const rows = fillDrift(px, shipped, run([day(6), day(9), null]));
    expect(rows[2]).toEqual({ exit: day(4), tranche: 3, shipped: day(14), candidate: null, delta: null, mismatch: true });
    expect(driftSummary(rows)).toEqual({ maxAbs: [0, 0, 0], mismatches: 1, filled: 3, episodes: 1, pass: false });
    expect(driftTable(rows).split("\n")).toEqual([`${day(4)}  T3  ${day(14)} → —  MISMATCH`, "max |Δ| T1/T2/T3 0/0/0 · mismatches 1 · filled 3/1 → DRIFT FAIL (k=3)"]);
    expect(fillDrift(px, run([day(6), null, null]), run([day(6), null, null])).map((r) => [r.delta, r.mismatch])).toEqual([[0, false], [0, false], [0, false]]);
  });
  it("no shipped fill at all is THIN, never PASS — `filled` counts the shipped form's fills over `episodes` distinct exits", () => {
    const none = run([null, null, null]);
    const rows = fillDrift(px, none, none);
    expect(driftSummary(rows)).toEqual({ maxAbs: [0, 0, 0], mismatches: 0, filled: 0, episodes: 1, pass: false });
    expect(driftTable(rows)).toBe("max |Δ| T1/T2/T3 0/0/0 · mismatches 0 · filled 0/1 → DRIFT THIN (k=3)");
    const two: ReplayRun = () => [ep(day(4), [day(6), null, null]), ep(day(12), [null, null, null])];
    expect(driftSummary(fillDrift(px, two, two))).toMatchObject({ filled: 1, episodes: 2, pass: true });
  });
  it("a fill dated off the leg price's calendar reads at its last close ≤ the date (EU-Fin fills on a spread leg's days); a fill before every close throws", () => {
    const gap = px.filter((p) => p.date !== day(7));
    const rows = fillDrift(gap, shipped, run([day(7), day(10), day(14)]));
    expect(rows.map((r) => r.delta), "T1 day 7 → day 6's index (Δ 0); T2 day 10 vs day 9, both past the gap, one apart").toEqual([0, 1, 0]);
    expect(() => fillDrift(px.slice(3), run([day(0), null, null]), run([day(0), null, null]))).toThrow(/precedes every close/);
  });
  it("throws unless the two runs' exit lists are equal in order", () => {
    expect(() => fillDrift(px, shipped, () => [ep(day(5), [day(6), day(9), day(14)])])).toThrow(/exit lists differ/);
    expect(() => fillDrift(px, shipped, () => [...shipped(REPLAY), ...shipped(REPLAY)])).toThrow(/exit lists differ/);
  });
});

describe("episodes: peak and trough", () => {
  const t0 = Date.parse("2010-01-04");
  const dayN = (i: number): string => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
  const pxOf = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dayN(i), value }));
  const K = { ...REPLAY, FROM: dayN(0) };
  const eps = (vals: number[], k: ReplayKnobs = K) => episodes(pxOf(vals), k);
  /** VOL_N + 1 closes, log returns ±A (mean 0), ending on the high 100 at index H. */
  const A = 0.01;
  const H = K.VOL_N;
  const pre = Array.from({ length: H + 1 }, (_, i) => ((H - i) % 2 === 0 ? 100 : 100 * Math.exp(-A)));
  const SIG = A * Math.sqrt(K.VOL_N / (K.VOL_N - 1)) * Math.sqrt(252);
  const DROP = K.DROP_K * SIG * Math.sqrt(21 / 252);
  const RISE = K.RISE_K * SIG;

  it("sigmaAt = the annualised sample sd of the VOL_N returns ending at the close; null short of VOL_N", () => {
    expect(sigmaAt(pxOf(pre), H, K.VOL_N)).toBeCloseTo(SIG, 12);
    expect(sigmaAt(pxOf(pre), H - 1, K.VOL_N)).toBeNull();
  });
  it("opens on the first close ≤ (1 − DROP) × the running high, one tick above does not; a zero-σ history never opens", () => {
    expect(eps([...pre, 100 * (1 - DROP) * (1 + 1e-9)])).toEqual([]);
    const [e] = eps([...pre, 100 * (1 - DROP) * (1 - 1e-9)]);
    expect([e!.exit, e!.shockStart, e!.open]).toEqual([dayN(H + 1), dayN(H), true]);
    expect([e!.drop, e!.rise]).toEqual([expect.closeTo(DROP, 12), expect.closeTo(RISE, 12)]);
    expect(eps([...Array.from({ length: H + 1 }, () => 100), 50])).toEqual([]);
  });
  it("ends on the first close ≥ (1 + RISE) × the low since the exit, one tick under does not", () => {
    const vals = [...pre, 95, 90, 90 * (1 + RISE) * (1 - 1e-9)];
    expect(eps(vals).map((e) => [e.end, e.open])).toEqual([[dayN(H + 3), true]]);
    expect(eps([...vals, 90 * (1 + RISE) * (1 + 1e-9)]).map((e) => [e.end, e.open])).toEqual([[dayN(H + 4), false]]);
  });
  it("ends on the close back at the running high, one tick under does not (rise out of reach)", () => {
    const k = { ...K, RISE_K: 100 };
    expect(eps([...pre, 95, 100 * (1 - 1e-9)], k).map((e) => [e.end, e.open])).toEqual([[dayN(H + 2), true]]);
    expect(eps([...pre, 95, 100 * (1 - 1e-9), 100], k).map((e) => [e.end, e.open])).toEqual([[dayN(H + 3), false]]);
  });
  it("shockStart = the high's last close; the low's lag past SHAPE_N splits BEAR from V", () => {
    /** The exit close, then `lag` closes sliding to the low, then back above the high. */
    const dip = (lag: number): number[] => [...pre, 100 * (1 - DROP) * (1 - 1e-9), ...Array.from({ length: lag }, (_, i) => 96 - (6 * i) / (lag - 1)), 101];
    const [v] = eps(dip(K.SHAPE_N));
    const [bear] = eps(dip(K.SHAPE_N + 1));
    expect([v!.exit, v!.shockStart, v!.shape, v!.troughLag]).toEqual([dayN(H + 1), dayN(H), "V", K.SHAPE_N]);
    expect([bear!.shape, bear!.troughLag]).toEqual(["BEAR", K.SHAPE_N + 1]);
  });
  it("shockStart = the latest close within TIE of the high; one just outside TIE does not move it", () => {
    expect(eps([...pre, 100 * (1 - 0.5 * K.TIE), 99.8, 100 * (1 - 0.5 * K.TIE), 99.8, 95])[0]!.shockStart).toBe(dayN(H + 3));
    expect(eps([...pre, 100 * (1 - 0.5 * K.TIE), 99.8, 100 * (1 - 1.5 * K.TIE), 99.8, 95])[0]!.shockStart).toBe(dayN(H + 1));
  });
  it("after an end the running high restarts at the end close: a close at that level opens nothing; only exits on/after FROM return", () => {
    const end = 90 * (1 + RISE) * (1 + 1e-9);
    const vals = [...pre, 95, 90, end, end, end * 0.5];
    const all = eps(vals);
    expect(all.map((e) => [e.exit, e.end, e.open, e.shockStart])).toEqual([
      [dayN(H + 1), dayN(H + 3), false, dayN(H)],
      [dayN(H + 5), dayN(H + 5), true, dayN(H + 4)],
    ]);
    expect(eps(vals, { ...K, FROM: dayN(H + 2) }).map((e) => e.exit)).toEqual([dayN(H + 5)]);
  });
});

describe("classifyBinding", () => {
  const px: Pt[] = [100, 90, 86, 85, 80].map((value, i) => ({ date: `2024-01-0${i + 1}`, value }));
  const frac = BINDING.ESC_FRAC;

  it("a later close at ESC_FRAC × the day's close is esc; just above it is fizzle; a drop after the end is fizzle", () => {
    expect(frac).toBeGreaterThan(0);
    const at = (x: number): Pt[] => [{ date: "2024-01-01", value: 100 }, { date: "2024-01-02", value: x }, { date: "2024-01-03", value: 50 }];
    expect(classifyBinding(at(frac * 100), { end: "2024-01-02" }, ["2024-01-01"])).toEqual({ esc: 1, fizzle: 0 });
    expect(classifyBinding(at((frac + 0.01) * 100), { end: "2024-01-02" }, ["2024-01-01"])).toEqual({ esc: 0, fizzle: 1 });
    expect(classifyBinding(at(99), { end: "2024-01-03" }, ["2024-01-01"])).toEqual({ esc: 1, fizzle: 0 });
  });

  it("counts each binding day against its own close", () => {
    expect(classifyBinding(px, { end: "2024-01-05" }, ["2024-01-01", "2024-01-03"])).toEqual({ esc: 1, fizzle: 1 });
  });

  it("bindingTable prints one row per arm", () => {
    expect(bindingTable([{ arm: "ruled", esc: 2, fizzle: 1, pass: true, acceptance: "PASS" }]).split("\n")[1]).toMatch(/^ruled\s+2\s+1\s+pass\s+PASS$/);
  });
});

it("whyTable splits a fill's criteria from its gates and marks each verdict", () => {
  const line = whyTable([{ exit: "2025-01-27", tranche: "T3", date: "2025-01-28", trough: -0.273, rows: [{ key: "price", gate: false, verdict: "unmet" }, { key: "credit", gate: false, verdict: "met" }, { key: "memory", gate: false, verdict: "na" }, { key: "hy-low", gate: true, verdict: "met" }], via: "count 1/1" }]).split("\n")[1]!;
  expect(line).toContain("price✗ credit✓ memory· | hy-low✓ | count 1/1");
  expect(line).toContain("-27.3%");
});

describe("scoreEpisode", () => {
  it("hold = exit→end; ret = a third per fill (÷ fills.length, an unfilled third is cash); drops = fillDrops", () => {
    const prices: Pt[] = px.map((p, i) => ({ ...p, value: i < 5 ? 100 : i < 10 ? 80 : i === 12 ? 72 : 90 }));
    const e = { shockStart: day(0), exit: day(4), end: day(19), open: false, drop: 0, rise: 0, shape: "BEAR" as const, troughLag: 8 };
    expect(scoreEpisode(prices, e, [day(6), null, null])).toEqual({ ...e, hold: expect.closeTo(-0.1, 10), ret: expect.closeTo(0.125 / 3, 10), fills: [day(6), null, null], drops: [{ trough: expect.closeTo(-0.1, 10), end: expect.closeTo(0.125, 10) }, null, null] });
  });
});

describe("whyFollow", () => {
  const VIA = ["time stop", "after T1", "after T2"];
  const legs = [{ tranche: "T1", key: "t1-hy", gate: true, verdict: "met" }, { tranche: "T2", key: "t2-vix", gate: false, verdict: "unmet" }];
  const read = (clear: boolean): Parameters<typeof whyFollow>[2] => (_e, _d, t) => ({ legs, res: t === "T1" ? { ready: true, clear, metCount: 2, need: 3 } : { ready: false, clear, metCount: 0, need: 3 } });
  const why = (fills: (string | null)[], after: number[], clear = true) => whyFollow([ep(day(4), fills)], () => px, read(clear), VIA, after);

  it("a ready fill routes `count met/need`; an unready one its via once clear and exactly after[i] fund closes passed the prior fill; rows = its tranche's, key prefix dropped", () => {
    expect(why([day(6), day(9), null], [99, 3, 99])).toEqual([
      { exit: day(4), tranche: "T1", date: day(6), trough: 0, rows: [{ key: "hy", gate: true, verdict: "met" }], via: "count 2/3" },
      { exit: day(4), tranche: "T2", date: day(9), trough: 0, rows: [{ key: "vix", gate: false, verdict: "unmet" }], via: "after T1" },
    ]);
  });
  it("throws on one close short of after[i], on an uncleared gate, and on an unfilled prior tranche (no since)", () => {
    const msg = `whyFills: T2 ${day(9)} filled with neither its count nor its after T1 route`;
    expect(() => why([day(6), day(9), null], [99, 4, 99])).toThrow(msg);
    expect(() => why([day(6), day(9), null], [99, 3, 99], false)).toThrow(msg);
    expect(() => why([null, day(9), null], [99, 0, 99])).toThrow(msg);
  });
});
