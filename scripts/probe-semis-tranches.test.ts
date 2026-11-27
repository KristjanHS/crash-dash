import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findLicensedLevelsInLeg } from "../src/licensed-levels.js";
import { boardFamilies, boardReading, splitGates, toVerdict, type LadderEvent, type LadderFamily, type LadderLive, type LadderSign } from "../src/ladder-live.js";
import { driftSummary, episodes, fillDrift, REPLAY, type ReplayRun } from "./ladder-replay.js";
import { calm as calmPre, spreadWave } from "./ladder-replay.test-helpers.js";
import { HALF, shockOf } from "./ladder-shock.js";
import { retraceLine } from "../src/ladder-jobs.js";
import { contextRow } from "../src/ladder-block.js";
import { INDICATORS } from "../src/registry-fred.js";
import { absorbed, asProbeResult, BOX_IDS, BOX_ROWS, BOX_SIGNS, BOX_TAG, catchUp, escalation, evaluateShipped, FAMS, famNeed, followOf, LEGS, readIds, replaySemis, SEMIS_RULES as R, REPLAY_FORM, SHIPPED_FORM, SIGNS, tally, VOTE_FAMILIES, liveLimit, requireBbb, unservedReadsEmpty, VERDICT_IDS, VETO_ROWS, type Inputs, type Pt, type Rules } from "./probe-semis-tranches.js";
import { INDICATOR, SERIES, type SeriesSet } from "./semis-series.js";
import { openEpisode } from "./semis-watch.js";

const F1_CFG = INDICATORS.find((i) => i.id === "F1")!;
const isoAt = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
/** Precomputed once — the longest fixture (`followSet(PRE + 1000)` + a head) stays under 1500 closes; past it falls back to `isoAt`. */
const DATES = Array.from({ length: 1500 }, (_, i) => isoAt(i));
const dateAt = (i: number): string => DATES[i] ?? isoAt(i);
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const lin = (n: number, from: number, step: number): number[] => Array.from({ length: n }, (_, i) => from + step * i);
const EMPTY = Object.fromEntries(SERIES.map((id) => [id, []])) as unknown as SeriesSet;
const signRow = (sign: string, block = false, checked: string | null = "2026-10-01"): LadderSign => ({ sign, label: sign, lean: block ? "bear" : "open", finding: "", why: "", measurable: "", block, checked, due: null, primary: [], search: [], seed: [], sources: [] });
const rung = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => FAMS[f].rungs[k]!.read(R, { s: { ...EMPTY, ...s }, signs: [], ...x }).verdict;
const gate = (key: string, s: Partial<SeriesSet>, x: Partial<Inputs> = {}, signs: LadderSign[] = []) => LEGS.find((d) => d.key === key)!.read(R, { s: { ...EMPTY, ...s }, signs, ...x }).verdict;
const box = (s: Partial<SeriesSet>, signs: LadderSign[] = [], r: Rules = R) => escalation({ s: { ...EMPTY, ...s }, signs }, r);
const TICK = 1e-4;
/** A spread at `base` for ESC_SPREAD_MA_N − 1 closes then `x`. */
const spread = (base: number, x: number) => series([...flat(base, R.ESC_SPREAD_MA_N - 1), x]);
/** Every `CLUSTERS` member read and clear: quorum met, no vote, no hold. */
const BOX_CALM = { VT: series(flat(0.5, R.ESC_VOL_FLIP_N)), R4: series(flat(2, R.ESC_REAL_DELTA_N + 1)), R6: series(flat(100, R.ESC_VOL_MED_N)), F1: spread(3, 3), HCX: series([0.02]) };

describe("roster", () => {
  it("every tranche counts every family but credit, credit a gate at each (user 2026-10-20); gates per plan §3.2(a)", () => {
    const keys = (t: string, g: boolean) => LEGS.filter((d) => d.tranche === t && (d.gate ?? false) === g).map((d) => d.key.slice(3));
    expect([keys("T1", false), keys("T2", false), keys("T3", false)]).toEqual(Array(3).fill(["price", "memory", "capex", "rates"]));
    expect(["R5", "CCC"].filter((id) => (SERIES as readonly string[]).includes(id)), "VIX and CCC left Semis' inputs (user 2026-10-20)").toEqual([]);
    expect([keys("T1", true), keys("T2", true), keys("T3", true)]).toEqual([["credit", "price-hold", "esc"],["credit", "credit-bbb", "capex-rollover", "esc"], ["credit", "credit-bbb", "capex-rollover", "esc"]]);
  });
  it("only a forward-only id (T10Y3M_RAW pre-ship) reads empty when the deployed build does not serve it — never BBB, whose empty read passes its gate", () => {
    expect([unservedReadsEmpty("T10Y3M_RAW", 400, "id must be one of …"), unservedReadsEmpty("VXSMH", 400, "id must be one of …"), unservedReadsEmpty("F1", 400, "id must be one of …"), unservedReadsEmpty("BBB", 400, "id must be one of …"), unservedReadsEmpty("T10Y3M_RAW", 500, "id must be one of …")]).toEqual([true, false, false, false, false]);
  });
  it("the live read takes F1 and BBB deep with SEC0 (liveLimit), so their `shockOf` anchors where replay's stored read does", () => {
    expect((["LEGP_SEMIS", "F1", "BBB"] as const).map((id) => liveLimit(id) > liveLimit("VT"))).toEqual([true, true, true]);
  });
});

describe("BBB gate (T2·T3, user 2026-11-04)", () => {
  /** 1.00/1.01 zig-zag then a ramp to `peak` and the tail `v`; the exit sits on the last calm close. */
  const bbb = (peak: number, ...v: number[]) => series([...Array.from({ length: 80 }, (_, i) => (i % 2 ? 1.01 : 1)), 1.05, 1.1, peak, ...v]);
  const x = { exit: dateAt(79) };
  const base = shockOf(bbb(1.4), R)!.base;
  it("armed only at peak − base ≥ BBB_MIN_WIDEN: a tick over the floor holds an un-retraced T3, a tick under reads quiet, met", () => {
    expect(R.BBB_MIN_WIDEN).toBeGreaterThan(0.1);
    const at = (w: number) => gate("t3-credit-bbb", { BBB: bbb(base + w) }, x);
    expect([at(R.BBB_MIN_WIDEN + 0.005), at(R.BBB_MIN_WIDEN - 0.005)]).toEqual(["unmet", "met"]);
  });
  it("armed: T3 ⅔ back passes a tick under the line, holds a tick over; T2 also needs the peak T2_PEAK_AGE_N closes old", () => {
    const line = (f: number) => retraceLine(shockOf(bbb(1.4), R)!, f);
    const [l2, l3, N] = [line(R.T2_RETRACE), line(R.T3_RETRACE), R.T2_PEAK_AGE_N];
    expect([gate("t3-credit-bbb", { BBB: bbb(1.4, l3 - TICK) }, x), gate("t3-credit-bbb", { BBB: bbb(1.4, l3 + TICK) }, x)]).toEqual(["met", "unmet"]);
    expect([gate("t2-credit-bbb", { BBB: bbb(1.4, ...flat(l2 - TICK, N)) }, x), gate("t2-credit-bbb", { BBB: bbb(1.4, ...flat(l2 - TICK, N - 1)) }, x)]).toEqual(["met", "unmet"]);
  });
  it("a second wave re-anchored on a raised base stays armed off the exit close: under the floor from its own base, far over it from the exit", () => {
    const wave = series([...Array.from({ length: 80 }, (_, i) => (i % 2 ? 1.01 : 1)), ...flat(1.6, 75), 1.66, 1.72]);
    const sh = shockOf(wave, R)!;
    expect([sh.peak - sh.base < R.BBB_MIN_WIDEN, sh.peak - 1.01 > R.BBB_MIN_WIDEN], "premise: the latest shock re-anchored above the exit").toEqual([true, true]);
    expect(gate("t3-credit-bbb", { BBB: wave }, x)).toBe("unmet");
  });
  it("no BBB close on/before the exit (pre-2023-10 episodes, empty fixtures) passes; history but none on/after the exit (stale) holds, n/a; the live read throws on an empty BBB", () => {
    const stale = bbb(1.4).filter((p) => p.date < dateAt(81));
    expect([gate("t2-credit-bbb", { BBB: [] }, x), gate("t2-credit-bbb", { BBB: stale }, { exit: dateAt(81) })]).toEqual(["met", "na"]);
    expect(() => requireBbb(EMPTY)).toThrow(/BBB came back empty/);
    expect(requireBbb({ ...EMPTY, BBB: stale }).BBB).toBe(stale);
  });
});

describe("tally: needs and gates", () => {
  const raw = (t: "T1" | "T2" | "T3", met: number, n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, tranche: t, gate: false, value: "", verdict: i < met ? ("met" as const) : ("unmet" as const) }));
  const esc0 = box(BOX_CALM);
  it("need 1 / 2 / 3 of the four voting families; an unread family never lowers it, an absorbed rates rung leaves the count", () => {
    expect((["T1", "T2", "T3"] as const).map((t) => famNeed(t, VOTE_FAMILIES.length))).toEqual([1, 2, 3]);
    expect((["T1", "T2", "T3"] as const).map((t) => tally(t, raw(t, 0, 5), R, esc0).need)).toEqual([1, 2, 3]);
    expect([tally("T2", raw("T2", 2, 5), R, esc0).ready, tally("T2", raw("T2", 1, 5), R, esc0).ready]).toEqual([true, false]);
    const na = (t: "T2" | "T3", met: number, absorbed: boolean) => [...raw(t, met, met), { key: "rates", tranche: t, gate: false, value: "", verdict: "na" as const, ...(absorbed && { absorbed: true as const }) }];
    expect([tally("T2", na("T2", 1, false), R, esc0).ready, tally("T3", na("T3", 2, false), R, esc0).ready, tally("T3", na("T3", 2, true), R, esc0).ready, tally("T2", na("T2", 1, true), R, esc0).ready]).toEqual([false, false, true, false]);
  });
});

describe("family rungs at the cut ± 1", () => {
  const L = 300;
  /** Monotone rising SEC0 — every MA slope passes. */
  const up = series(lin(L, 100, 0.1));
  const back = (n: number) => dateAt(L - 1 - n);
  it("price: T1/T2 close > MA_FAST_K × MA50 at the cut ± a tick; T3's MA50 > MA200 ×10 — the cut fires, one fewer does not; a falling SEC0 fails its MAs; no exit → n/a", () => {
    expect(R.MA_FAST_K, "premise: a K of 1 makes the cut the plain MA").not.toBe(1);
    // The last close equal to K × MA50, the MA including that close.
    const base = lin(L - 1, 100, 0.1);
    const cut = (R.MA_FAST_K * base.slice(-(R.MA_FAST_N - 1)).reduce((a, b) => a + b, 0)) / (R.MA_FAST_N - R.MA_FAST_K);
    const at = (x: number) => series([...base, x]);
    // Exit on the first close, so T2's post-exit low is that close, far past LOW_HOLD_N.
    expect(([0, 1] as const).map((k) => [rung("PRICE", k, { LEGP_SEMIS: at(cut + TICK) }, { exit: back(L - 1) }), rung("PRICE", k, { LEGP_SEMIS: at(cut - TICK) }, { exit: back(L - 1) })])).toEqual([["met", "unmet"], ["met", "unmet"]]);
    const cross = (n: number) => series([...flat(100, L - n), ...lin(n, 101, 1)]);
    expect([rung("PRICE", 2, { LEGP_SEMIS: cross(R.T3_CROSS_N) }, { exit: back(L - 1) }), rung("PRICE", 2, { LEGP_SEMIS: cross(R.T3_CROSS_N - 1) }, { exit: back(L - 1) })]).toEqual(["met", "unmet"]);
    const down = series(lin(L, 200, -0.1));
    expect(([0, 1, 2] as const).map((k) => rung("PRICE", k, { LEGP_SEMIS: down }, { exit: back(130) }))).toEqual(["unmet", "unmet", "unmet"]);
    expect(rung("PRICE", 0, { LEGP_SEMIS: up })).toBe("na");
    expect(FAMS.PRICE.rungs[1].read(R, { s: { ...EMPTY, LEGP_SEMIS: down }, signs: [], exit: back(130) }).value, "each MA-rising condition shows its Δ").toMatch(new RegExp(` · MA50 Δ10 -\\d+\\.\\d{3}>0✗ · .* · MA200 Δ10 -\\d+\\.\\d{3}>0✗ · no low [\\d.]+/[\\d.]+ \\(\\d\\d-\\d\\d\\)✗$`));
    const t1 = FAMS.PRICE.rungs[0].read(R, { s: { ...EMPTY, LEGP_SEMIS: at(cut + TICK) }, signs: [], exit: back(60) });
    expect([new RegExp(`^[\\d.]+>${R.MA_FAST_K}×MA50 [\\d.]+✓ · `).test(t1.value), t1.count], "the cell prints the scaled MA; T1 carries no count").toEqual([true, undefined]);
  });
  it("price T2/T3: the close and both MAs print at one width — the widest pair's (MA200 3 dp apart drags MA50 to 3 dp too)", () => {
    // Close 60.604, MA50 58.00, MA200 60.601: only the close/MA200 pair needs 3 dp.
    const c = series([...flat(61.468, 160), ...flat((2900 - 60.604) / 49, 49), 60.604]);
    const [t2, t3] = ([1, 2] as const).map((k) => FAMS.PRICE.rungs[k].read(R, { s: { ...EMPTY, LEGP_SEMIS: c }, signs: [], exit: dateAt(0) }).value);
    expect([t2, t3]).toEqual([expect.stringMatching(/^60\.604>0\.96×MA50 55\.680✓ · .* · >MA200 60\.601✓ · /), expect.stringMatching(/^60\.604>MA200 60\.601✓ · .* · MA50 58\.000>MA200 60\.601✗/)]);
  });
  it("price T2: a post-exit low LOW_HOLD_N closes old passes, one close younger holds (count got/need); a later close equal to it is no new low, one a tick under is", () => {
    const N = R.LOW_HOLD_N;
    expect(N, "premise: N − 2 is a younger close").toBeGreaterThan(1);
    /** A new post-exit low (100, under the exit close) `age` closes back, plus `[age, value]` closes; every MA bit stays met. */
    const dipAt = (age: number, ...more: (readonly [number, number])[]) => ({ LEGP_SEMIS: series(up.map((p, i) => (i === L - 1 - age ? 100 : (more.find(([a]) => i === L - 1 - a)?.[1] ?? p.value!)))) });
    const read = (age: number, ...more: (readonly [number, number])[]) => FAMS.PRICE.rungs[1].read(R, { s: { ...EMPTY, ...dipAt(age, ...more) }, signs: [], exit: back(60) });
    expect([read(N), read(N - 1)].map((g) => [g.verdict, g.count])).toEqual([["met", { got: N, need: N }], ["unmet", { got: N - 1, need: N }]]);
    expect([read(N, [N - 2, 100]), read(N, [N - 2, 100 - TICK])].map((g) => [g.verdict, g.count])).toEqual([["met", { got: N, need: N }], ["unmet", { got: N - 2, need: N }]]);
  });
  it("T1 price-hold gate: a post-exit low T1_LOW_HOLD_N closes old passes under the exit close, one younger holds unless the close is over the exit close (a tie holds); no exit → n/a", () => {
    const N = R.T1_LOW_HOLD_N;
    expect(N, "premise: N − 1 closes after the low is at least one").toBeGreaterThan(1);
    /** Exit close 100 at index 2, the post-exit low 95 next, then `after` closes ending on `tail`. */
    const hold = (after: number, tail: number, x: Partial<Inputs> = { exit: dateAt(2) }) => gate("t1-price-hold", { LEGP_SEMIS: series([110, 105, 100, 95, ...flat(96, after - 1), tail]) }, x);
    expect([hold(N, 97), hold(N - 1, 97), hold(N - 1, 100 + TICK), hold(N - 1, 100), hold(N, 97, {})]).toEqual(["met", "unmet", "met", "unmet", "na"]);
  });
  it("memory T1: MU_RS Δ(T1_MU_DELTA_N) > 0 against the close exactly N back — a tick over passes, a tie or a tick under holds; N closes or fewer n/a", () => {
    const N = R.T1_MU_DELTA_N;
    expect(N, "premise: a window of at least one close").toBeGreaterThan(0);
    const mu = (from: number, mid: number, to: number) => rung("MEMORY", 0, { MU_RS: series([from, ...flat(mid, N - 1), to]) });
    expect([mu(1, 2, 1 + TICK), mu(1, 0.5, 1), mu(1, 0.5, 1 - TICK), rung("MEMORY", 0, { MU_RS: series(flat(1, N)) })], "mid closes oppose the verdict, so a read off N − 1 back flips each").toEqual(["met", "unmet", "unmet", "na"]);
  });
  it("memory T2/T3 hysteresis: MU_RS_CONFIRM_N closes over MA·(1+band) set it, one fewer or a tick over the MA does not; held through CONFIRM_N in-band closes under the MA and one past the band, cleared by CONFIRM_N past it; short history n/a", () => {
    const [up, dn, inBand] = [1 + 1.1 * R.MU_RS_BAND, 1 - 2 * R.MU_RS_BAND, 1 - R.MU_RS_BAND / 2];
    const mem = (k: 1 | 2, n: number, tail: number[]) => rung("MEMORY", k, { MU_RS: series([...flat(1, n), ...tail]) });
    const set = flat(up, R.MU_RS_CONFIRM_N);
    expect([mem(1, 70, set), mem(1, 70, set.slice(1)), mem(1, 70, flat(1 + TICK, R.MU_RS_CONFIRM_N)), mem(2, 210, set), mem(2, 210, set.slice(1)), mem(2, 150, set)]).toEqual(["met", "unmet", "unmet", "met", "unmet", "na"]);
    expect([mem(2, 210, [...set, ...flat(inBand, R.MU_RS_CONFIRM_N)]), mem(2, 210, [...set, ...flat(dn, R.MU_RS_CONFIRM_N - 1)]), mem(2, 210, [...set, ...flat(dn, R.MU_RS_CONFIRM_N)])]).toEqual(["met", "met", "unmet"]);
  });
  it("capex: T1 HCX Δ10 > 0 · T2 HCX ≥ −5% ∧ Δ20 > 0 · T3 ≥ −5% ×20 (a breach 20 closes back holds, 21 back passes)", () => {
    expect([rung("CAPEX", 0, { HCX: series([...flat(-0.05, 15), -0.05 + TICK]) }), rung("CAPEX", 0, { HCX: series(flat(-0.05, 16)) }), rung("CAPEX", 0, { HCX: series(flat(-0.05, 10)) })]).toEqual(["met", "unmet", "na"]);
    const t2 = (from: number, to: number) => series([from, ...flat(-0.2, R.HCX_T2_DELTA_N - 1), to]);
    expect([t2(R.HCX_T2_MIN - TICK, R.HCX_T2_MIN), t2(-0.2, R.HCX_T2_MIN - TICK), t2(R.HCX_T2_MIN, R.HCX_T2_MIN), t2(-0.01, R.HCX_T2_MIN + TICK)].map((h) => rung("CAPEX", 1, { HCX: h }))).toEqual(["met", "unmet", "unmet", "unmet"]);
    expect(rung("CAPEX", 1, { HCX: series(flat(0, R.HCX_T2_DELTA_N)) })).toBe("na");
    const hcx3 = (ago: number) => series(Array.from({ length: 30 }, (_, i) => (i === 30 - ago ? R.HCX_T2_MIN - TICK : R.HCX_T2_MIN)));
    expect([rung("CAPEX", 2, { HCX: hcx3(R.HCX_T3_N) }), rung("CAPEX", 2, { HCX: hcx3(R.HCX_T3_N + 1) })]).toEqual(["unmet", "met"]);
  });
  it("rates T1: d20 ≤ 0.10 ∧ z < 1 — d20 at the cut passes on a noisy history, a tick over holds, a calm history's z holds", () => {
    const noisy = lin(300, 0, 1).map((i) => 2 + 0.5 * Math.sin(i / 4));
    const end = (h: number[], d: number) => series([...h.slice(0, -1), h.at(-21)! + d]);
    const calm = lin(300, 0, 1).map((i) => 2 + 0.01 * (i % 3));
    expect([rung("RATES", 0, { R4: end(noisy, R.R4_D_MAX) }), rung("RATES", 0, { R4: end(noisy, R.R4_D_MAX + 0.001) }), rung("RATES", 0, { R4: end(calm, R.R4_D_MAX) })]).toEqual(["met", "unmet", "unmet"]);
  });
  it("rates T2/T3: no 60-close high ×5 / ×10 (a high 5 / 10 back passes, 4 / 9 holds); T3 also needs d20 ≤ 0", () => {
    const spike = (ago: number) => series([...flat(2, 80 - 1 - ago), 2.5, ...flat(2, ago)]);
    expect([rung("RATES", 1, { R4: spike(R.T2_R4_N) }), rung("RATES", 1, { R4: spike(R.T2_R4_N - 1) }), rung("RATES", 2, { R4: spike(R.T3_R4_N) }), rung("RATES", 2, { R4: spike(R.T3_R4_N - 1) })]).toEqual(["met", "unmet", "met", "unmet"]);
    const tail = (v: number) => series([...flat(2, 30), 2.5, ...flat(2, 39), v]);
    expect([rung("RATES", 2, { R4: tail(2) }), rung("RATES", 2, { R4: tail(2.01) }), rung("RATES", 1, { R4: tail(2.01) })]).toEqual(["met", "unmet", "met"]);
  });
  it("rates absorbed: a new 60-close DFII10 high inside the last ABSORB_N SEC0 closes with SEC0 up turns a rung its own rule fails n/a, never met; SEC0 down holds", () => {
    const spike = series([...flat(2, 80 - R.T2_R4_N), 2.5, ...flat(2, R.T2_R4_N - 1)]);
    const sec0 = (n: number, step: number) => series(lin(n, 100, step));
    expect([rung("RATES", 1, { R4: spike }), rung("RATES", 1, { R4: spike, LEGP_SEMIS: sec0(80, 0.1) }), rung("RATES", 1, { R4: spike, LEGP_SEMIS: sec0(80, -0.1) })]).toEqual(["unmet", "na", "unmet"]);
  });
  it("absorbed bounds: a high on the SEC0 close ABSORB_N back does not count, one close later does; SEC0 Δ20 > 0 with Δ1 < 0 still absorbs; every rates rung takes it", () => {
    const up = lin(L, 100, 0.1);
    const r4 = (at: number) => series(Array.from({ length: L }, (_, i) => (i === at ? 2.5 : 2)));
    const abs = (sec0: number[], at: number) => absorbed(R, { s: { ...EMPTY, LEGP_SEMIS: series(sec0), R4: r4(at) }, signs: [] });
    const from = L - 1 - R.ABSORB_N;
    expect([abs(up, from), abs(up, from + 1), abs([...up.slice(0, -1), up.at(-2)! - TICK], from + 1)]).toEqual([false, true, true]);
    expect([abs(up, L - 1 - 2 * R.T2_R4_N), rung("RATES", 1, { R4: r4(L - 1 - 2 * R.T2_R4_N), LEGP_SEMIS: series(up) })]).toEqual([true, "met"]);
    const noisy = lin(L - 1, 0, 1).map((i) => 2 + 0.5 * Math.sin(i / 4));
    const high = { R4: series([...noisy, 4]) };
    expect([([0, 1, 2] as const).map((k) => rung("RATES", k, { ...high, LEGP_SEMIS: series(up) })), ([0, 1, 2] as const).map((k) => rung("RATES", k, { ...high, LEGP_SEMIS: series(lin(L, 200, -0.1)) }))]).toEqual([["na", "na", "na"], ["unmet", "unmet", "unmet"]]);
  });
});

describe("memory_turn window", () => {
  it("memory_turn window edge: an MU high MU_HIGH_N − 1 closes before the last close (the first close of offHigh's window, which includes the last) reads; one close further back it is out — pins offHigh's n at ±1", () => {
    /** MU_HIGH_N + 20 closes flat at 100, a 150 high `back` closes before the last close. */
    const at = (back: number) => ((f) => `${f.value}/${f.verdict}`)(box({ F8: series([...flat(100, R.MU_HIGH_N + 20 - back - 1), 150, ...flat(100, back)]) }).families.find((f) => f.name === "memory_turn")!);
    expect([R.MU_HIGH_N - 1, R.MU_HIGH_N].map(at)).toStrictEqual(["MU -33.3%/-20.0%/unmet", "MU +0.0%/-20.0%/met"]);
  });
});

describe("gates", () => {
  it("capex rollover: HCX at −10% passes, a tick under holds T2/T3; no close n/a", () => {
    expect([gate("t2-capex-rollover", { HCX: series([R.HCX_GATE_MIN]) }), gate("t3-capex-rollover", { HCX: series([R.HCX_GATE_MIN - TICK]) }), gate("t2-capex-rollover", {})]).toEqual(["met", "unmet", "na"]);
  });
});

describe("escalation box families (Episode gates rows, display only)", () => {
  /** The tripped (unmet) family rows. */
  const names = (e: ReturnType<typeof box>) => e.families.filter((f) => f.verdict === "unmet").map((f) => f.name);
  it("memory_turn at its cut: MU ≥ 20% off its high (inclusive, as the rule's `≤ −20%` prints); no MU close is n/a, one is met", () => {
    const mu = (last: number) => names(box({ F8: series([...flat(100, 10), last]) }));
    expect([mu(100 * (1 - R.ESC_MU_OFF) - TICK), mu(100 * (1 - R.ESC_MU_OFF)), mu(100 * (1 - R.ESC_MU_OFF) + TICK)], "exactly −ESC_MU_OFF trips (the rule prints ≤)").toEqual([["memory_turn"], ["memory_turn"], []]);
    const memo = (s: Partial<SeriesSet>) => ((f) => `${f.value}/${f.verdict}`)(box(s).families.find((f) => f.name === "memory_turn")!);
    expect([memo({}), memo({ F8: series([100]) })]).toStrictEqual(["n/a/na", "MU +0.0%/-20.0%/met"]);
  });
  it("every stored non-probe sign a block cannot reach (outside BOX_ROWS + VETO_ROWS) is a context row (BLOCKING = none), so no escalation blocks it; every reachable one is not", () => {
    const live = JSON.parse(readFileSync("public/semis.json", "utf8")) as LadderLive;
    const reach = new Set<string>([...Object.values(BOX_ROWS).flat(), ...VETO_ROWS]);
    const rows = live.signs.filter((s) => !s.probe);
    expect(rows.filter((s) => contextRow(s) === reach.has(s.sign)).map((s) => s.sign)).toEqual([]);
    expect(rows.find((s) => s.sign === "ai_funding") && contextRow(rows.find((s) => s.sign === "ai_funding")!), "anchor: ai_funding is a stored context row").toBe(true);
  });
  it("manual halves: a taiwan_export block trips its row; a capex_guides block trips no row (its member only carries it); a non-box block trips nothing; an unknown id throws", () => {
    expect(names(box({}, [signRow("taiwan_export", true), signRow("capex_guides", true), signRow("real_yield", true)]))).toEqual(["taiwan_export"]);
    expect(names(box({}, [signRow("mu_dio", true)]))).toEqual([]);
    expect(() => box({}, [signRow("not_a_sign", true)])).toThrow(/not a known sign id/);
  });
  it("no close and no row is unread, never tripped; an unchecked row is unread (named), a checked clear one is read", () => {
    expect(box({})).toMatchObject({ tripped: 0, unread: ["memory_turn (dram_contract)", "taiwan_export (taiwan_export)", "vxsmh", "curve_10y3m", "cg_drop", "yen_carry"] });
    const mu = { F8: series([100]) };
    expect([box(mu, [signRow("dram_contract", false, null)]).unread.includes("memory_turn (dram_contract)"), box(mu, [signRow("dram_contract")]).unread.some((u) => u.startsWith("memory_turn")), names(box({}, [signRow("dram_contract", true, null)]))]).toEqual([true, false, ["memory_turn"]]);
    expect(SIGNS.includes("dram_contract")).toBe(true);
  });
  const famsOf = (e: ReturnType<typeof box>) => Object.fromEntries(e.families.map((f) => [f.name, f])) as Record<(typeof BOX_SIGNS)[number], LadderFamily>;
  it("families: one row per BOX_SIGNS entry in order — a tripped close reads unmet with its value, a block forces unmet whatever the close, a blind close reads n/a, taiwan_export reads off its sign alone", () => {
    const calm = { F8: series(flat(100, 10)), VXSMH: series(flat(20, R.ESC_VOL_MED_N)) };
    const c = famsOf(box(calm, [signRow("dram_contract"), signRow("taiwan_export")]));
    expect(Object.keys(c)).toEqual([...BOX_SIGNS]);
    expect([c.memory_turn, c.taiwan_export, c.vxsmh.live]).toMatchObject([{ value: `MU +0.0%/${(-R.ESC_MU_OFF * 100).toFixed(1)}%`, verdict: "met", signs: [{ sign: "dram_contract", lean: "open", block: false }] }, { name: "taiwan_export", rule: "sign block only", value: "—", verdict: "met", live: { value: "—", verdict: "met" }, signs: [{ sign: "taiwan_export", lean: "open", block: false }], tag: BOX_TAG.taiwan_export }, { value: c.vxsmh.value, verdict: "met" }]);
    const blocked = famsOf(box(calm, [signRow("dram_contract", true)]));
    expect(blocked.memory_turn).toMatchObject({ value: `MU +0.0%/${(-R.ESC_MU_OFF * 100).toFixed(1)}%`, verdict: "unmet", signs: [{ sign: "dram_contract", lean: "bear", block: true }] });
    expect([famsOf(box({}, [signRow("dram_contract")])).memory_turn, famsOf(box({})).vxsmh]).toMatchObject([{ value: "n/a", verdict: "met" }, { value: "n/a", verdict: "na", signs: [] }]);
  });
  it("a live cell whose series heads before the live date copies an older print and says its date; one heading on it stays bare", () => {
    const N = R.ESC_VOL_MED_N;
    const s = { ...EMPTY, F8: series(flat(100, N + 1)), VXSMH: series(flat(20, N)) };
    const f = famsOf(escalation({ s, signs: [] }, R, { x: { s, signs: [] }, s, at: dateAt(N) }));
    expect([f.vxsmh.live!.value, f.memory_turn.live!.value]).toEqual([`${f.vxsmh.value} @${dateAt(N - 1).slice(5)}`, f.memory_turn.value]);
  });
  it("evaluateShipped stamps against its asOf.live (R6's head, newest of BOX_CALM): leg t2-rates (R4) and member credit_confirms (F1) lag and say their date, member move (R6) stays bare", () => {
    const e = evaluateShipped({ ...EMPTY, ...BOX_CALM }, [], R);
    const live = Object.fromEntries(e.escalation.clusters.flatMap((c) => c.members).map((m) => [m.id, m.live]));
    expect([e.asOf.live, e.legs.find((l) => l.key === "t2-rates")!.live.value, live.credit_confirms, live.move]).toEqual([dateAt(R.ESC_VOL_MED_N - 1), expect.stringMatching(new RegExp(` @${dateAt(R.ESC_REAL_DELTA_N).slice(5)}$`)), expect.stringMatching(new RegExp(` @${dateAt(R.ESC_SPREAD_MA_N - 1).slice(5)}$`)), expect.not.stringMatching(/ @\d\d-\d\d$/)]);
  });
  it("gate row: every tranche ends on the ruled box — met with no hold, unmet on a coincident + lead vote, naming the voting clusters; one rule text on all three, the quorum clause prefixed T2·T3:", () => {
    const esc = (t: "T1" | "T2" | "T3") => LEGS.filter((d) => d.tranche === t).at(-1)!;
    const rule = "no coincident + lead cluster vote · no capex_guides block (T1: capex_guides once capex_clock trips)";
    expect((["T1", "T2", "T3"] as const).map((t) => [esc(t).key, esc(t).gate, esc(t).rule(R)])).toEqual([["t1-esc", true, `${rule} · T2·T3: ≥ 70% of members live`], ["t2-esc", true, `${rule} · T2·T3: ≥ 70% of members live`], ["t3-esc", true, `${rule} · T2·T3: ≥ 70% of members live`]]);
    const g = (s: Partial<SeriesSet>) => esc("T2").read(R, { s: { ...EMPTY, ...s }, signs: [] });
    const credit = { ...BOX_CALM, F1: spread(3, 4) };
    expect([g(BOX_CALM), g(credit), g({ ...credit, HCX: series([R.ESC_HCX - TICK]) })]).toEqual([{ value: "votes — · live 5/5 need 4", verdict: "met" }, { value: "votes credit · live 5/5 need 4", verdict: "met" }, { value: "votes credit, capex · live 5/5 need 4", verdict: "unmet" }]);
  });
  it.each([["vxsmh", "VXSMH"]] as const)("%s: a %s close over ESC_VOL_MED_K × its ESC_VOL_MED_N-close median trips, one at it does not (the median includes the close); one close short is unread", (fam, id) => {
    const vol = (x: number, n: number = R.ESC_VOL_MED_N) => series([...flat(100, n - 1), x]);
    const cut = R.ESC_VOL_MED_K * 100;
    const at = (c: Pt[]) => famsOf(box({ [id]: c }))[fam];
    expect([names(box({ [id]: vol(cut + TICK) })), at(vol(cut + 10)).value, at(vol(cut)), names(box({ [id]: vol(cut) })), at(vol(cut + 50, R.ESC_VOL_MED_N - 1)).verdict]).toEqual([[fam], `${INDICATOR[id]} ${(cut + 10).toFixed(2)} > ${R.ESC_VOL_MED_K}×100.00`, expect.objectContaining({ value: `${INDICATOR[id]} ${cut.toFixed(2)} ≤ ${R.ESC_VOL_MED_K}×100.00`, verdict: "met" }), [], "na"]);
  });
  it("vxsmh · yen_carry are shown only: a tripping VXSMH or USD/JPY (−YEN_DROP within YEN_N closes) moves no tranche, no cluster vote and no hold, and stays off VERDICT_IDS", () => {
    const a = evaluateShipped({ ...EMPTY, ...BOX_CALM }, [], R);
    const hot = { VXSMH: series([...flat(100, R.ESC_VOL_MED_N - 1), 200]), F17: series([...flat(150, 2 * R.YEN_N), 150 * (1 - R.YEN_DROP)]) };
    const run = (k: keyof typeof hot, row: "vxsmh" | "yen_carry") => ((b) => [famsOf(b.escalation)[row].verdict, b.tranches, b.escalation.hits, b.escalation.hold])(evaluateShipped({ ...EMPTY, ...BOX_CALM, [k]: hot[k] }, [], R));
    expect([run("VXSMH", "vxsmh"), run("F17", "yen_carry")]).toEqual([["unmet", a.tranches, a.escalation.hits, a.escalation.hold], ["unmet", a.tranches, a.escalation.hits, a.escalation.hold]]);
    expect([VERDICT_IDS.has("VXSMH"), VERDICT_IDS.has("F17"), VERDICT_IDS.has("T10Y3M_RAW")]).toEqual([false, false, true]);
  });
  it("a lagging display-only head (F17) stamps only its own yen_carry live cell, never the escalation legs' live cell (the vote never reads it)", () => {
    const E = R.ESC_SPREAD_MA_N + R.ESC_VOL_MED_N + R.ESC_REAL_DELTA_N;
    /** `vals` dated so the last close lands on `dateAt(end)`. */
    const endAt = (vals: number[], end = E): Pt[] => vals.map((value, i) => ({ date: dateAt(end - vals.length + 1 + i), value }));
    const s = { ...EMPTY, ...Object.fromEntries(Object.entries({ ...BOX_CALM, F8: series(flat(100, 10)), VXSMH: series(flat(20, R.ESC_VOL_MED_N)), T10Y3M_RAW: series([1]), CG: series(flat(1, R.ESC_CG_N + 1)) }).map(([id, pts]) => [id, endAt(pts.map((p) => p.value!))])), F17: endAt(flat(150, 2 * R.YEN_N + 1), E - 3) };
    const e = evaluateShipped(s, [], R);
    expect([e.asOf.live, e.legs.filter((l) => l.key.endsWith("-esc")).map((l) => l.live.value), famsOf(e.escalation).yen_carry.live!.value]).toEqual([dateAt(E), ["t1-esc", "t2-esc", "t3-esc"].map(() => expect.not.stringMatching(/ @\d\d-\d\d/)), expect.stringMatching(new RegExp(` @${dateAt(E - 3).slice(5)}$`))]);
  });
  it("curve_10y3m: raw T10Y3M under ESC_CURVE trips, at it does not, no close is unread; cg_drop: Cu/Au down ESC_CG_DROP over ESC_CG_N closes trips (inclusive), a tick less does not, ESC_CG_N closes is unread", () => {
    expect([names(box({ T10Y3M_RAW: series([R.ESC_CURVE - TICK]) })), names(box({ T10Y3M_RAW: series([R.ESC_CURVE]) })), famsOf(box({})).curve_10y3m.verdict]).toEqual([["curve_10y3m"], [], "na"]);
    const cg = (x: number, n: number = R.ESC_CG_N + 1) => series([...flat(100, n - 1), x]);
    const drop = 100 * (1 - R.ESC_CG_DROP);
    expect([names(box({ CG: cg(drop) })), names(box({ CG: cg(drop + TICK) })), famsOf(box({ CG: cg(drop) })).cg_drop, famsOf(box({ CG: cg(drop, R.ESC_CG_N) })).cg_drop.verdict]).toEqual([["cg_drop"], [], expect.objectContaining({ value: `Cu/Au Δ${R.ESC_CG_N} -10.0%/-10.0%`, verdict: "unmet" }), "na"]);
  });
  it("vxsmh · curve_10y3m · cg_drop each list their own sign row for the board column, but trip on the close only; a dropped row's sign resolves to its cluster member (capex_guides → capex_clock)", () => {
    const NEW = ["vxsmh", "curve_10y3m", "cg_drop"] as const;
    const blocks = NEW.map((n) => signRow(n, true));
    const blind = box({}, blocks);
    expect([blind.hold, NEW.map((n) => famsOf(blind)[n].verdict)]).toEqual([false, NEW.map(() => "na")]);
    const calm = { VXSMH: series(flat(40, R.ESC_VOL_MED_N)), T10Y3M_RAW: series([1]), CG: series(flat(1, R.ESC_CG_N + 1)) };
    const v = toVerdict(asProbeResult(evaluateShipped({ ...EMPTY, ...calm }, [...blocks, signRow("capex_guides")], R)), false);
    expect([v.escalation.tripped, NEW.map((n) => boardFamilies(v, n).map((f) => [f.name, f.verdict, f.signs.map((g) => g.sign)]))]).toEqual([0, NEW.map((n) => [[n, "met", [n]]])]);
    expect(NEW.map((n) => boardReading(v, n).startsWith(`${n} `))).toEqual(NEW.map(() => true));
    expect(boardFamilies(v, "capex_guides").map((f) => f.name)).toEqual(["capex_clock"]);
  });
  it("the live pass: a VXSMH estimate head over K×median (EOD or intraday) trips vxsmh on the family's live cell only, est.-tagged as the leg rows are (an EOD estimate only); the close cell stays on the print; BOX_IDS ∪ member tag series is exactly what the box reads", () => {
    const hot = (provisional: boolean) => [...series(flat(100, R.ESC_VOL_MED_N)), { date: dateAt(R.ESC_VOL_MED_N), value: 200, estimated: true, provisional }];
    const cell = `${INDICATOR.VXSMH} 200.00 > ${R.ESC_VOL_MED_K}×100.00`;
    const fam = (s: SeriesSet) => famsOf(evaluateShipped(s, [], R).escalation).vxsmh;
    const eod = fam({ ...EMPTY, VXSMH: hot(false) });
    expect([eod.verdict, eod.live, fam({ ...EMPTY, VXSMH: hot(true) }).live, fam({ ...EMPTY, VXSMH: series([...flat(100, R.ESC_VOL_MED_N - 1), 200]) }).live]).toEqual(["met", { value: `${cell} est.`, verdict: "unmet" }, { value: cell, verdict: "unmet" }, { value: cell, verdict: "unmet" }]);
    const seen = new Set<string>();
    escalation({ s: new Proxy({} as SeriesSet, { get: (_t, k) => (typeof k === "string" && seen.add(k), []) }), signs: [] }, R);
    const memberIds = box({}).clusters.flatMap((c) => c.members.flatMap((m) => m.tag?.series ?? []));
    expect([...seen].sort()).toEqual([...new Set([...Object.values(BOX_IDS).flat(), ...memberIds])].sort());
  });
  it("the live pass: a stale provisional row mid-series is no session — VT 0.5 · 1.2 ×(N−2) · stale 1.3 · head 1.2 is a run of N−1, not vol_flip's N", () => {
    const N = R.ESC_VOL_FLIP_N;
    const vt = [...series([0.5, ...flat(1.2, N - 2)]), { date: dateAt(N - 1), value: 1.3, provisional: true }, { date: dateAt(N), value: 1.2, provisional: true }];
    const m = evaluateShipped({ ...EMPTY, VT: vt }, [], R).escalation.clusters.flatMap((c) => c.members).find((x) => x.id === "vol_flip")!;
    expect([m.liveCell, m.live]).toEqual([false, expect.stringContaining(` ${N - 1}/${N}`)]);
  });
  it("an `escalation:` outcome on any seeded event blocks its sign rows without throwing", () => {
    const live = JSON.parse(readFileSync(new URL("../public/semis.json", import.meta.url), "utf8")) as LadderLive;
    expect(live.events.length).toBeGreaterThan(0);
    for (const e of live.events) expect(() => box({}, e.signs.map((g) => signRow(g, true, null))), e.event).not.toThrow();
  });
});

describe("clustered box (CLUSTERS · VETO_ROWS)", () => {
  const ruled = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => escalation({ s: { ...EMPTY, ...s }, signs }, R);
  const raw = (t: "T1" | "T2" | "T3") => LEGS.filter((d) => d.tranche === t).map((d) => ({ key: d.key, tranche: t, gate: d.gate ?? false, value: "", verdict: "met" as const }));
  /** Per tranche: [`tally` held with every row met, its esc gate row unmet] off the ruled box. */
  const holds = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => ((x) => (["T1", "T2", "T3"] as const).map((t) => [!tally(t, raw(t), R, escalation(x, R)).clear, LEGS.find((d) => d.key === `${t.toLowerCase()}-esc`)!.read(R, x).verdict === "unmet"]))({ s: { ...EMPTY, ...s }, signs });
  const [NONE, ALL] = [[[false, false], [false, false], [false, false]], [[true, true], [true, true], [true, true]]];
  const calm = BOX_CALM;
  const credit = { F1: spread(3, 4) };
  const rates = { R4: series([...flat(2, R.ESC_REAL_DELTA_N), 2 + R.ESC_REAL_DELTA]), R6: series([...flat(100, R.ESC_VOL_MED_N - 1), 100 * (R.ESC_MOVE_MED_K + 0.1)]) };
  it("credit + rates-shock votes hold every tranche; calm holds none", () => {
    const s = { ...calm, ...credit, ...rates };
    expect([ruled(s).clusters!.filter((c) => c.vote).map((c) => c.name), ruled(s)]).toMatchObject([["rates-shock", "credit"], { hold: true, veto: [], quorum: { live: 5, n: 5, t1Only: false } }]);
    expect([holds(calm), holds(s)]).toEqual([NONE, ALL]);
  });
  it("demoted sign rows cast no vote: curve · cg · taiwan_export · dram_contract tripped beside credit hold nothing; a capex_guides block (veto) holds T2·T3 alone, all three once HCX (its measured half) trips", () => {
    const demoted = { ...calm, ...credit, T10Y3M_RAW: series([-1]), CG: series([...flat(1, R.ESC_CG_N), 0.8]) };
    const rows = [signRow("taiwan_export", true), signRow("dram_contract", true)];
    expect([ruled(demoted, rows).clusters!.filter((c) => c.vote).map((c) => c.name), ruled(demoted, rows).hold, holds(demoted, rows)]).toEqual([["credit"], false, NONE]);
    const veto = [signRow("capex_guides", true)];
    const T2T3 = [[false, false], [true, true], [true, true]];
    expect([ruled(calm, veto), holds(calm, veto)]).toMatchObject([{ hold: false, holdT2T3: true, tripped: 0, veto: ["capex_guides"], clusters: ruled(calm).clusters }, T2T3]);
    const hcx = { ...calm, HCX: series([R.ESC_HCX - TICK]) };
    expect([ruled(hcx, veto), holds(hcx, veto), holds(hcx)]).toMatchObject([{ hold: true, holdT2T3: true, hits: ["capex"], veto: ["capex_guides"] }, ALL, NONE]);
  });
  it("evaluateShipped reads a legacy capex_guides block released when its escalation `spares` the row: no veto; a `called:` neutral without `spares` still vetoes", () => {
    const stored = { ...signRow("capex_guides", true), blocked: { on: "2026-11-04", by: "Mid" } };
    const mid = (spares?: string[]): LadderEvent => ({ date: "2026-11-03", event: "Mid", signs: ["capex_guides"], escalationIf: "e", fizzleIf: "f", holds: [], secondary: false, status: "escalation: x, 11-04 · called: capex_guides=neutral (press only)", ...(spares && { spares }) });
    const veto = (spares?: string[]) => evaluateShipped({ ...EMPTY, ...calm }, [stored], R, undefined, [mid(spares)]).escalation.veto;
    expect([veto(["capex_guides"]), veto()]).toEqual([[], ["capex_guides"]]);
  });
  it("a real_yield block is display only (user 2026-10-31): alone it holds nothing, vetoes nothing and trips no cluster", () => {
    const ry = [signRow("real_yield", true)];
    expect([ruled(calm, ry), holds(calm, ry)]).toMatchObject([{ hold: false, veto: [], tripped: 0 }, NONE]);
  });
  it("below quorum (short history reads na) holds T2/T3 and leaves T1 to the box's hold; the same members before their first point (none) leave the denominator", () => {
    const short = { VT: calm.VT, HCX: calm.HCX, R4: series(flat(2, R.ESC_REAL_DELTA_N)), R6: series(flat(100, R.ESC_VOL_MED_N - 1)), F1: series(flat(3, R.ESC_SPREAD_MA_N - 1)) };
    expect([ruled(short), holds(short)]).toMatchObject([{ hold: false, quorum: { live: 2, n: 5, t1Only: true } }, [[false, false], [true, true], [true, true]]]);
    const pre = { VT: calm.VT, HCX: calm.HCX };
    expect([ruled(pre), holds(pre)]).toMatchObject([{ hold: false, quorum: { live: 2, n: 2, t1Only: false } }, NONE]);
  });
  it("criteria render: above quorum the box is ONE shared row on all three; below quorum T1's row stays its own and T2·T3 share one", () => {
    const g = (set: Partial<SeriesSet>) => splitGates(toVerdict(asProbeResult(evaluateShipped({ ...EMPTY, ...set }, [], R)), false).legs);
    const box = (sg: ReturnType<typeof g>) => [sg.shared.filter((x) => x.leg.leg === "gate: escalation box").map((x) => x.label), sg.own.filter((l) => l.leg === "gate: escalation box").map((l) => l.tranche)];
    const short = { VT: calm.VT, HCX: calm.HCX, R4: series(flat(2, R.ESC_REAL_DELTA_N)), R6: series(flat(100, R.ESC_VOL_MED_N - 1)), F1: series(flat(3, R.ESC_SPREAD_MA_N - 1)) };
    expect([box(g(calm)), box(g(short))]).toEqual([[["escalation box"], []], [["escalation box (T2·T3)"], ["T1"]]]);
  });
  it("each member carries its trips-when rule and the read its cell judged; no history / short history read as such; live only off a latest-print pass", () => {
    const member = (e: ReturnType<typeof ruled>, id: string) => e.clusters.flatMap((c) => c.members.map(({ tag, ...m }) => m)).find((m) => m.id === id);
    const s = { ...calm, ...rates };
    expect([member(ruled(s), "real_yield"), member(ruled(s), "move"), member(ruled(s), "capex_clock"), member(ruled(s), "credit_confirms")]).toEqual([
      { id: "real_yield", cell: "hit", rule: `10y RY Δ${R.ESC_REAL_DELTA_N} ≥ +${R.ESC_REAL_DELTA * 100}bp`, value: `10y RY Δ${R.ESC_REAL_DELTA_N} +${R.ESC_REAL_DELTA * 100}bp/+${R.ESC_REAL_DELTA * 100}bp` },
      { id: "move", cell: "hit", rule: `MOVE > ${R.ESC_MOVE_MED_K}×${R.ESC_VOL_MED_N}d median`, value: `MOVE ${(100 * (R.ESC_MOVE_MED_K + 0.1)).toFixed(2)} > ${R.ESC_MOVE_MED_K}×100.00` },
      { id: "capex_clock", cell: false, rule: `HCX < ${(R.ESC_HCX * 100).toFixed(1)}%`, value: `HCX +2.0%/${(R.ESC_HCX * 100).toFixed(1)}%` },
      { id: "credit_confirms", cell: false, rule: `HY ≥ ${R.ESC_HY_MA_K}× its MA${R.ESC_SPREAD_MA_N}, unless HY Δ${F1_CFG.velocityWindow} ≤ ${F1_CFG.thresholds.amberVelocity} and < its ${R.CREDIT_VEL_HIGH_N}-close high`, value: `HY 3.00/${(3 * R.ESC_HY_MA_K).toFixed(2)} (MA${R.ESC_SPREAD_MA_N} 3.00)` },
    ]);
    expect([member(ruled({ R4: series(flat(2, R.ESC_REAL_DELTA_N)) }), "real_yield"), member(ruled({}), "move")]).toMatchObject([
      { cell: "na", value: `10y RY short of ${R.ESC_REAL_DELTA_N + 1} closes` },
      { cell: "none", value: "MOVE no history" },
    ]);
    const shipped = evaluateShipped({ ...EMPTY, ...s }, [], R).escalation;
    expect([member(ruled(s), "move")!.live, member(shipped, "move")!.live, member(ruled(s), "move")!.liveCell, member(shipped, "move")!.liveCell]).toEqual([undefined, member(shipped, "move")!.value, undefined, "hit"]);
  });
  it("move trips over ESC_MOVE_MED_K × its median, not at it, and not between vxsmh's ESC_VOL_MED_K and it", () => {
    expect(R.ESC_MOVE_MED_K).toBeGreaterThan(R.ESC_VOL_MED_K);
    const cell = (x: number) => ruled({ R6: series([...flat(100, R.ESC_VOL_MED_N - 1), x]) }).clusters.flatMap((c) => c.members).find((m) => m.id === "move")!.cell;
    expect([cell(100 * R.ESC_MOVE_MED_K + TICK), cell(100 * R.ESC_MOVE_MED_K), cell(50 * (R.ESC_VOL_MED_K + R.ESC_MOVE_MED_K))]).toEqual(["hit", false, false]);
  });
  it("vol_flip trips at VT = ESC_VT for ESC_VOL_FLIP_N closes, not a TICK under", () => {
    const N = R.ESC_VOL_FLIP_N;
    const cell = (v: number) => ruled({ VT: series([...flat(R.ESC_VT, N - 1), v]) }).clusters.flatMap((c) => c.members).find((m) => m.id === "vol_flip")!.cell;
    expect([cell(R.ESC_VT), cell(R.ESC_VT - TICK)]).toEqual(["hit", false]);
  });
});

describe("fills over the open SEC0 exit", () => {
  const PRE = 260;
  /** T1's own-legs fill close: MU_RS steps up a tick at `mu` (default PRE + T1F), so T1's memory Δ vote fires there and holds T1_MU_DELTA_N closes. */
  const T1F = 20;
  /** SEC0 calm at 100 (σ > 0, so an exit can open), a −6% exit at PRE held flat (no SEC0 rise, so rates never reads absorbed); HY flat (credit gate met); the MU_RS tick stays inside MU_RS_BAND, and HCX −6% and a rising R4 leave T2/T3 short of their counts. */
  const followSet = (len: number, mu = PRE + T1F): SeriesSet => ({ ...EMPTY, LEGP_SEMIS: series([...calmPre(PRE), ...flat(94, len - PRE)]), F1: series(flat(3, len)), HCX: series(flat(-0.06, len)), R4: series(lin(len, 1, 0.01)), MU_RS: series(Array.from({ length: len }, (_, i) => (i < mu ? 1 : 1 + TICK))) });
  const OK = [signRow("dram_contract")];
  const t = (s: SeriesSet, k: number, signs = OK) => evaluateShipped(s, signs, R).tranches[k]!;
  it("T1 fills on its own legs, not one close early, and never on the clock: with its legs unread it stays out 3×T1F closes past the exit", () => {
    const s = followSet(PRE + T1F + 1);
    expect(openEpisode(s)).toMatchObject({ exit: dateAt(PRE) });
    expect(t(s, 0)).toMatchObject({ met: true, ready: true, since: dateAt(PRE + T1F) });
    expect([evaluateShipped(s, OK, R).sessionsSinceExit, t(followSet(PRE + T1F), 0).met]).toEqual([T1F, false]);
    expect(followOf({ ...followSet(PRE + 3 * T1F), MU_RS: [], R4: [] }, OK, R)?.fills).toEqual([null, null, null]);
  });
  it("T2 never follows T1's fill, nor T3 a latched T2's, with every gate clear; no open exit, no fills", () => {
    const [t1, end] = [PRE + T1F, PRE + 4 * T1F];
    expect([t(followSet(end), 1), t(followSet(end), 2)].map((x) => [x.met, x.clear, x.via])).toEqual([[false, true, undefined], [false, true, undefined]]);
    expect(followOf(followSet(end), OK, R, [dateAt(t1), dateAt(t1 + 1), null])?.fills).toEqual([dateAt(t1), dateAt(t1 + 1), null]);
    const still = { ...followSet(end), LEGP_SEMIS: series(calmPre(end)) };
    expect([followOf(still, OK, R), "sessionsSinceExit" in evaluateShipped(still, OK, R)]).toEqual([null, false]);
  });
  it("catch-up: a SEC0 close over every one of the prior CATCHUP_HIGH_N fires each clear tranche short of its count (via new high); one equal to that high does not", () => {
    /** The episode must stay open over the catch-up close: the pre-exit closes sit outside the CATCHUP_HIGH_N window (else the new high regains
     *  the exit's high) and are calm (RISE ≈ 0.07% of the post-exit low, so a tick over it does not end it). */
    /** A short catch-up window keeps the fixture small; the shipped CATCHUP_HIGH_N edge is pinned by the `peakBack` asserts below. */
    const r = { ...R, CATCHUP_HIGH_N: 20 };
    const len = PRE + r.CATCHUP_HIGH_N + 2;
    const at = (v: number) => ((s) => ({ ...s, LEGP_SEMIS: series([...calmPre(PRE), ...flat(94, len - PRE - 1), v]) }))(followSet(len));
    expect(openEpisode(at(94 + TICK)), "premise: the catch-up close leaves the episode open").toMatchObject({ exit: dateAt(PRE) });
    expect(evaluateShipped(at(94 + TICK), OK, r).tranches.slice(1).map((x) => [x.ready, x.met, x.via])).toEqual([[false, true, "new high"], [false, true, "new high"]]);
    expect(evaluateShipped(at(94), OK, r).tranches.slice(1).map((x) => x.met)).toEqual([false, false]);
    const peakBack = (n: number) => series(Array.from({ length: 300 }, (_, i) => (i === 299 - n ? 101 : i === 299 ? 100.5 : 100)));
    expect([catchUp(peakBack(R.CATCHUP_HIGH_N), R), catchUp(peakBack(R.CATCHUP_HIGH_N + 1), R)]).toEqual([false, true]);
  });
  it("rates rows carry the absorbed clause as a footnote, never in the rule; no other row has one", () => {
    const foot = `absorbed (n/a) if both: 10y hit a ${R.R4_HIGH_N}-close high in the last ${R.ABSORB_N} closes · SEC0 is up over those ${R.ABSORB_N} closes`;
    expect(evaluateShipped(followSet(PRE + T1F + 1), OK, R).legs.filter((l) => l.foot).map((l) => [l.key, l.foot, l.rule.includes("absorbed")])).toEqual(["t1-rates", "t2-rates", "t3-rates"].map((k) => [k, foot, false]));
  });
  it("an exit stays open 1000 closes on until its episode end (a regain or RISE off the low)", () => {
    const s = followSet(PRE + 1000);
    const lastAt = (v: number): SeriesSet => ({ ...s, LEGP_SEMIS: [...s.LEGP_SEMIS.slice(0, -1), { ...s.LEGP_SEMIS.at(-1)!, value: v }] });
    const { rise } = episodes(s.LEGP_SEMIS).at(-1)!;
    expect([openEpisode(s), openEpisode(lastAt((1 + rise) * 94 - TICK))]).toMatchObject([{ exit: dateAt(PRE) }, { exit: dateAt(PRE) }]);
    expect([openEpisode(lastAt((1 + rise) * 94)), openEpisode(lastAt(100))]).toEqual([undefined, undefined]);
  });
  /** exit 1 at PRE ends PRE + 5 (back at its high); exit 2 = PRE + 76 off the post-end 100s. */
  const twoExits = (len: number): number[] => [...calmPre(PRE), ...flat(94, 5), ...flat(100, 71), ...flat(94, len - PRE - 76)];
  const E2 = PRE + 76;
  const ep1 = [dateAt(PRE + 1), dateAt(PRE + 2), dateAt(PRE + 3)];
  it("after an episode end the next exit fills from T1 — no latch from the ended episode carries", () => {
    const s = { ...followSet(E2 + T1F + 1, E2 + T1F), LEGP_SEMIS: series(twoExits(E2 + T1F + 1)) };
    expect(episodes(s.LEGP_SEMIS).map((e) => [e.exit, e.end]).slice(0, 1), "premise: exit 1 ended before exit 2").toEqual([[dateAt(PRE), dateAt(PRE + 5)]]);
    const f = followOf(s, OK, R, ep1)!;
    expect([f.exit, (f.fills[0] ?? "") > dateAt(E2), f.fills.every((d) => d === null || d > dateAt(E2))]).toEqual([dateAt(E2), true, true]);
  });
  it("a latched fill survives a run whose box would block it", () => {
    const s = followSet(PRE + T1F + 1);
    const fill = dateAt(PRE + T1F);
    const block = [signRow("dram_contract", true), signRow("taiwan_export", true), signRow("capex_guides", true)];
    const hot = { ...s, VT: series(flat(1.1, PRE + T1F + 1)) };
    const prior = toVerdict(asProbeResult(evaluateShipped(s, OK, R)), false);
    expect([followOf(hot, block, R)?.fills[0], followOf(hot, block, R, [fill, null, null])?.fills[0]]).toEqual([null, fill]);
    expect(evaluateShipped(hot, block, R, prior).tranches[0]).toMatchObject({ met: false, since: fill, fill: true });
  });
  it("a breach sells nothing: SEC0 held 50% under the pre-fill low after T1's fill keeps T1 and leaves T2's fill where it was", () => {
    const [t1, b] = [PRE + T1F, PRE + T1F + 3];
    const len = b + 20;
    /** HCX ≥ HCX_T2_MIN over (b, b + 10] and a flat R4, so T2's capex + rates fire after the breach. */
    const s = { ...followSet(len), R4: series(flat(1, len)), HCX: series(Array.from({ length: len }, (_, i) => (i > b && i <= b + 10 ? R.HCX_T2_MIN + 0.01 : -0.06))) };
    const deep = { ...s, LEGP_SEMIS: s.LEGP_SEMIS.map((p, i) => (i >= b ? { ...p, value: 0.5 * 94 } : p)) };
    expect(openEpisode(deep), "premise: the breach leaves the episode open").toMatchObject({ exit: dateAt(PRE) });
    const [calm, hit] = [followOf(s, OK, R)!.fills, followOf(deep, OK, R)!.fills];
    expect([calm[0], (calm[1] ?? "") > dateAt(b)], "premise: T2 fills after the breach close").toEqual([dateAt(t1), true]);
    expect(hit).toEqual(calm);
  });
  it("live column: a null-valued live head is dropped, never read as 0 — HY held at its post-exit shock peak stays unmet live", () => {
    const len = PRE + T1F + 5;
    const s = { ...followSet(len), F1: series([...Array.from({ length: PRE + 2 }, (_, i) => (i % 2 ? 3.02 : 3)), 3.2, 3.4, 3.6, 3.8, ...flat(4, len - PRE - 6)]) };
    const head = { ...s, F1: [...s.F1, { date: dateAt(len), value: null, provisional: true }] };
    expect(evaluateShipped(head, OK, R).legs.find((l) => l.key === "t3-credit")).toMatchObject({ verdict: "unmet", live: { verdict: "unmet" } });
  });
  it("fizzle fast fill: every T2-holding event landed fizzle by T1's fill close → T2 fills that close; one pending → no", () => {
    const t1 = PRE + T1F;
    const s = followSet(t1 + 1);
    const ev = (d: number, status: string): LadderEvent => ({ date: dateAt(d), event: `e${d}`, signs: [], escalationIf: "", fizzleIf: "", holds: ["T2", "T3"], secondary: false, status });
    const [fizzled, pending] = [[ev(PRE + 2, "fizzle: x (src)"), ev(t1, "fizzle: y (src)")], [ev(PRE + 2, "fizzle: x (src)"), ev(t1 + 3, "NOT DUE until later")]];
    expect([followOf(s, OK, R, [], fizzled)?.fills, followOf(s, OK, R, [], pending)?.fills]).toEqual([[dateAt(t1), dateAt(t1), null], [dateAt(t1), null, null]]);
    expect([evaluateShipped(s, OK, R, undefined, fizzled).tranches[1], evaluateShipped(s, OK, R, undefined, pending).tranches[1]?.met]).toEqual([expect.objectContaining({ met: true, ready: false, via: "after T1", since: dateAt(t1) }), false]);
  });
  it("replaySemis: the newest replay episode on an open fixture is openEpisode's exit + shock start, ending on the last close; an unmet fixture fills nothing", () => {
    const s = followSet(PRE + T1F + 1);
    const ep = openEpisode(s)!;
    expect(replaySemis(s).at(-1)).toMatchObject({ exit: ep.exit, shockStart: ep.start, end: dateAt(PRE + T1F) });
    expect(replaySemis({ ...followSet(PRE + 3 * T1F), MU_RS: [], R4: [] }).map((e) => e.fills)).toEqual([[null, null, null]]);
  });
  it("the box reaches replaySemis → walkFills → firesAt and evaluateShipped: a hot VT beside DFII10's rise (equity-vol + rates-shock) holds the T1 fill a calm VT makes", () => {
    const len = PRE + T1F + 1;
    const vt = { VT: series(flat(1.1, len)) };
    const s = followSet(len);
    expect([replaySemis(s).at(-1)!.fills[0], replaySemis({ ...s, ...vt }).at(-1)!.fills]).toEqual([dateAt(PRE + T1F), [null, null, null]]);
    expect([evaluateShipped(followSet(len), OK, R).tranches[0]!.met, evaluateShipped({ ...followSet(len), ...vt }, OK, R).tranches[0]!.met]).toEqual([true, false]);
  });
  it("binding closes: the box holding T1 on its fill close counts that close once; a calm VT (no hold) counts none", () => {
    const len = PRE + T1F + 1;
    const s = followSet(len);
    const hot = { ...s, VT: series(flat(1.1, len)) };
    const bound = (x: SeriesSet, form: typeof REPLAY_FORM) => replaySemis(x, REPLAY, form, true).at(-1)!.binding;
    expect(replaySemis(s).at(-1)!.fills[0], "premise: with no hold T1 fills on the last close").toBe(dateAt(PRE + T1F));
    expect([bound(hot, REPLAY_FORM), bound(s, REPLAY_FORM)]).toEqual([[dateAt(PRE + T1F)], []]);
  });
  it("fill drift: a candidate whose box holds (a hot VT) loses the fill the shipped form makes → a mismatch, never a Δ", () => {
    const len = PRE + T1F + 1;
    const s = followSet(len);
    const rows = replaySemis(s, REPLAY, SHIPPED_FORM);
    const shipped: ReplayRun = () => rows;
    const boxed: ReplayRun = (k) => replaySemis({ ...s, VT: series(flat(1.1, len)) }, k, SHIPPED_FORM);
    expect(rows.at(-1)!.fills[0], "premise: the shipped form fills T1 on this fixture with no sign rows, so the box can take a fill away").toBe(dateAt(PRE + T1F));
    expect(driftSummary(fillDrift(s.LEGP_SEMIS, shipped, boxed)).mismatches).toBeGreaterThanOrEqual(1);
  });
});

describe("read tags", () => {
  it("tag.series covers every id the row's dry run reads (rates' absorbed SEC0 branch is past it)", () => {
    expect(LEGS.map((d) => [d.key, readIds((x) => d.read(R, x)).filter((id) => !d.tag.series.includes(id))])).toEqual(LEGS.map((d) => [d.key, []]));
  });
});

describe("hybrid guards at each Semis site — wave 2 against the HALF line since R4's own shock", () => {
  const [ON, OFF] = [{ ...R, HYBRID_GUARDS: true }, { ...R, HYBRID_GUARDS: false }];
  /** spreadWave: calm 79/81, wave 1 at PEAK, the hold (the turn) ×25, then wave 2's one close — its line ½ back from the hold to the peak. */
  const [PEAK, HOLD] = [150, 100];
  const line = HOLD + HALF * (PEAK - HOLD);
  const r4 = (last: number): Pt[] => series(spreadWave(80, 1, PEAK, HOLD, [last]));
  it("premise: wave 1 sits inside the R4_HIGH_N lookback, so the rolling read never sees wave 2 as a new high", () => {
    expect(Math.max(...r4(line + TICK).slice(-R.R4_HIGH_N - 1, -1).map((p) => p.value!))).toBe(PEAK);
  });

  it("r4Quiet T2 (R4 own shockOf): a tick short of the line keeps the no-high run ×T2_R4_N, a tick past re-trips it; flag off → the past close reads quiet", () => {
    const got = (last: number, r: Rules) => FAMS.RATES.rungs[1].read(r, { s: { ...EMPTY, R4: r4(last) }, signs: [] }).count?.got;
    expect([got(line - TICK, ON), got(line + TICK, ON), got(line + TICK, OFF)]).toEqual([R.T2_R4_N, 0, R.T2_R4_N]);
  });

  it("absorbed (SEC0 up over ABSORB_N on the same dates): a tick short of the line is no new R4 high, a tick past is; flag off → the past close is no new R4_HIGH_N-close high", () => {
    const up = (n: number): Pt[] => series(lin(n, 100, 0.1));
    const abs = (last: number, r: Rules) => ((c) => absorbed(r, { s: { ...EMPTY, R4: c, LEGP_SEMIS: up(c.length) }, signs: [] }))(r4(last));
    expect([abs(line - TICK, ON), abs(line + TICK, ON), abs(line + TICK, OFF)]).toEqual([false, true, false]);
  });
});

describe("the --into verdict — licensed index levels are not published", () => {
  it("toVerdict leaves no observed licensed level in any string the fixture's raw reads quote", () => {
    const raw = asProbeResult(evaluateShipped({ ...EMPTY, ...BOX_CALM }, [], R));
    expect(findLicensedLevelsInLeg(raw).length, "premise: the raw reads quote licensed levels").toBeGreaterThan(0);
    expect(findLicensedLevelsInLeg(toVerdict(raw, false))).toEqual([]);
  });
});
