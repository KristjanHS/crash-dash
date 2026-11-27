import { describe, expect, it } from "vitest";
import { findLicensedLevelsInLeg } from "../src/licensed-levels.js";
import { watchOf, type Cell } from "../src/ladder-box.js";
import { toVerdict, type LadderLive, type LadderSign } from "../src/ladder-live.js";
import { applyRun } from "../src/ladder-run.js";
import { MOVE_MEDIAN } from "../src/chart-rail.js";
import { calm as calmPre } from "./ladder-replay.test-helpers.js";
import { claimsFeed, escalation, evaluateShipped, FAMS, intoLive, LEGS, openExit, replaySp500, SERIES, SP500_RULES as R, SP500_WATCH, tally, tranchesAt, VERDICT_IDS, VETO_ROWS, VOTE_FAMILIES, WATCH_CLUSTERS, watchAt, whyFills, type Form, type Inputs, type Pt, type SeriesSet, type WatchSet } from "./probe-sp500-tranches.js";

const DATES: string[] = [];
const dateAt = (i: number): string => (DATES[i] ??= new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const lin = (n: number, from: number, step: number): number[] => Array.from({ length: n }, (_, i) => from + step * i);
const EMPTY = Object.fromEntries(SERIES.map((id) => [id, []])) as unknown as SeriesSet;
const TICK = 1e-4;
const rung = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => FAMS[f].rungs[k].read(R, { s: { ...EMPTY, ...s }, signs: [], ...x }).verdict;
const gate = (key: string, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => LEGS.find((d) => d.key === key)!.read(R, { s: { ...EMPTY, ...s }, signs: [], ...x }).verdict;
const watch = (s: Partial<WatchSet>, signs: LadderSign[] = []) => watchAt({ ...EMPTY, ICSA: [], ...s }, signs, R);
const cells = (key: string, s: Partial<WatchSet>) => ((w) => [w.correction.cell, w.bear.cell])(watch(s).find((r) => r.key === key)!);

describe("roster", () => {
  it("each tranche votes price · vol · rates · breadth; gates credit · g2 · c1 · c2 · c3 · (c4 at T2/T3) · veto · esc; watch-only R5/SPY stay out of VERDICT_IDS", () => {
    const keys = (t: string, g: boolean) => LEGS.filter((d) => d.tranche === t && (d.gate ?? false) === g).map((d) => d.key.slice(3));
    expect([keys("T1", false), keys("T3", false)]).toEqual([[...VOTE_FAMILIES], [...VOTE_FAMILIES]]);
    expect([keys("T1", true), keys("T2", true), keys("T3", true)]).toEqual([["credit", "g2", "c1", "c2", "c3", "veto", "esc"], ...Array(2).fill(["credit", "g2", "c1", "c2", "c3", "c4", "veto", "esc"])]);
    expect([["R5", "SPY"].filter((id) => VERDICT_IDS.has(id as never)), ["GB", "CCC", "R6", "F3"].every((id) => VERDICT_IDS.has(id as never))]).toEqual([[], true]);
  });
});

describe("T2 level edges inclusive", () => {
  const gb = (prior: number, now: number) => series([...flat(prior, R.GB_DELTA_N), now]);
  it("breadth: exactly 3/7 (and prod's 0.429) is not below the cut; under it with Δ20 ≤ 0 holds T1/T2, with Δ20 > 0 passes; T3 needs GB ≥ 3/7", () => {
    expect([rung("BREADTH", 1, { GB: gb(4 / 7, 3 / 7) }), rung("BREADTH", 1, { GB: gb(4 / 7, 0.429) }), rung("BREADTH", 1, { GB: gb(4 / 7, 2 / 7) }), rung("BREADTH", 0, { GB: gb(2 / 7, 2 / 7) }), rung("BREADTH", 1, { GB: gb(1 / 7, 2 / 7) })]).toEqual(["met", "met", "unmet", "unmet", "met"]);
    expect([rung("BREADTH", 2, { GB: gb(4 / 7, 3 / 7) }), rung("BREADTH", 2, { GB: gb(4 / 7, 2 / 7) }), rung("BREADTH", 1, { GB: series([2 / 7]) }), rung("BREADTH", 1, {})]).toEqual(["met", "unmet", "na", "na"]);
  });
  it("R6's median toggle line draws THIS leg's c4 gate too (src/ can't import scripts/)", () => {
    expect(MOVE_MEDIAN).toEqual({ window: R.C4_N, mult: R.C4_K });
  });
  it("gate c4: MOVE at exactly C4_K × its median holds, a tick under passes; short of C4_N closes n/a", () => {
    const move = (v: number, n: number = R.C4_N) => series([...flat(100, n - 1), v]);
    expect([gate("t2-c4", { R6: move(100 * R.C4_K) }), gate("t2-c4", { R6: move(100 * R.C4_K - TICK) }), gate("t3-c4", { R6: move(100, R.C4_N - 1) })]).toEqual(["unmet", "met", "na"]);
  });
  it("gate c2: holds only while BOTH 10y RY Δ63 > +50bp and HY Δ63 > +30bp — either at its cut passes; one unread and the other hot n/a", () => {
    const up = (from: number, d: number) => series([...flat(from, R.C2_DELTA_N), from + d]);
    const c2 = (d4: number, d1: number) => gate("t2-c2", { R4: up(2, d4), F1: up(3, d1) });
    expect([c2(R.C2_R4_MAX + TICK, R.C2_F1_MAX + TICK), c2(R.C2_R4_MAX, R.C2_F1_MAX + TICK), c2(R.C2_R4_MAX + TICK, R.C2_F1_MAX), gate("t2-c2", { F1: up(3, 1) })]).toEqual(["unmet", "met", "met", "na"]);
  });
});

describe("gates at the cut ± 1", () => {
  it("gate g2: holds while SXR8 < MA200 and MA200 falls vs 10 closes back; a dip under a rising MA200 passes; short history n/a", () => {
    const fall = series([...flat(100, R.G2_MA_N), ...lin(20, 99, -1)]);
    const dip = series([...lin(R.G2_MA_N + R.G2_LAG_N, 100, 0.1), 50]);
    expect([gate("t1-g2", { LEGP_SPX: fall }), gate("t2-g2", { LEGP_SPX: dip }), gate("t3-g2", { LEGP_SPX: series(flat(100, R.G2_MA_N + R.G2_LAG_N - 1)) })]).toEqual(["unmet", "met", "na"]);
  });
  it("gate c1: a new 20-close HY high exactly N closes back passes, N−1 back holds — N = 5 at T1, 10 at T2/T3", () => {
    const high = (ago: number) => series(Array.from({ length: 40 }, (_, i) => (i === 39 - ago ? 3.5 : 3)));
    expect([gate("t1-c1", { F1: high(R.C1_T1_N) }), gate("t1-c1", { F1: high(R.C1_T1_N - 1) }), gate("t2-c1", { F1: high(R.C1_N) }), gate("t3-c1", { F1: high(R.C1_N - 1) }), gate("t1-c1", { F1: series(flat(3, R.C1_HIGH_N)) })]).toEqual(["met", "unmet", "met", "unmet", "na"]);
  });
  it("gate c3: holds while NFCI risk > 0 and its Δ vs ≥ 91 days back > −0.30 — NFCI at 0 or Δ at −0.30 passes; no base with NFCI > 0 n/a", () => {
    const nfci = (base: number, now: number, n = 100) => series([...flat(base, n - 1), now]);
    expect([gate("t1-c3", { F3: nfci(0, 0.1) }), gate("t1-c3", { F3: nfci(0, 0) }), gate("t2-c3", { F3: nfci(0.4, 0.1) }), gate("t2-c3", { F3: nfci(0.4 - TICK, 0.1) }), gate("t3-c3", { F3: nfci(0, 0.1, R.C3_DAYS) }), gate("t3-c3", { F3: nfci(0, -0.1, R.C3_DAYS) })]).toEqual(["unmet", "met", "met", "unmet", "na", "met"]);
  });
  it("credit T2: HY ½ back + aged AND CCC ½ back — a CCC short of ½ holds, a CCC with no shock (n/a) passes; T1/T3 read HY alone", () => {
    const PRE = 300;
    const hyCalm = (n: number): number[] => lin(n, 0, 1).map((i) => 3 + 0.01 * (i % 2));
    const shocked = (hold: number) => series([...hyCalm(PRE + 1), 3.2, 3.4, 3.6, 3.8, 4, ...flat(hold, 15)]);
    const x = { exit: dateAt(PRE) };
    expect(gate("t2-credit", { F1: shocked(3.4) }, x), "premise: HY alone meets T2").toBe("met");
    expect([gate("t2-credit", { F1: shocked(3.4), CCC: shocked(3.4) }, x), gate("t2-credit", { F1: shocked(3.4), CCC: shocked(3.8) }, x), gate("t2-credit", { F1: shocked(3.8), CCC: shocked(3.4) }, x), gate("t1-credit", { F1: shocked(3.6), CCC: shocked(4) }, x)]).toEqual(["met", "unmet", "unmet", "met"]);
  });
  it("family rungs ride SXR8 / VT: price T1 no post-exit low ×5 vs ×4, vol T1 VIX/VIX3M < 1 ×3 vs a close at the cut", () => {
    const up = series(lin(300, 100, 0.1));
    expect([rung("PRICE", 0, { LEGP_SPX: up }, { exit: dateAt(299 - R.T1_NO_LOW_N) }), rung("PRICE", 0, { LEGP_SPX: up }, { exit: dateAt(300 - R.T1_NO_LOW_N) }), rung("VOL", 0, { VT: series([1.1, 0.99, 0.99, 0.99]) }), rung("VOL", 0, { VT: series([0.99, R.VT_T1_MAX, 0.99, 0.99]) })]).toEqual(["met", "unmet", "met", "unmet"]);
  });
});

describe("pre-exit watch (SP500_WATCH · WATCH_CLUSTERS)", () => {
  it("cells at each cut, inclusive as printed; a side with no line reads none; short history na", () => {
    const hy = (v: number, n: number = R.W_HY_LOW_N) => ({ F1: series([...flat(2.5, n - 1), v]) });
    expect([cells("hy", hy(2.5 + R.W_HY_RISE)), cells("hy", hy(2.5 + R.W_HY_RISE - TICK)), cells("hy", hy(R.W_HY_BEAR)), cells("hy", hy(2.5, R.W_HY_LOW_N - 1)), cells("hy", {})]).toEqual([["hit", false], [false, false], ["hit", "hit"], ["na", false], ["none", "none"]]);
    const nfci = (v: number, n = R.W_NFCI_DAYS + 1) => ({ F3: series([...flat(-0.6, n - 1), v]) });
    expect([cells("nfci", nfci(-0.6 + R.W_NFCI_RISE)), cells("nfci", nfci(-0.6 + R.W_NFCI_RISE - TICK)), cells("nfci", nfci(R.W_NFCI_BEAR)), cells("nfci", nfci(R.W_NFCI_BEAR + TICK, R.W_NFCI_DAYS))]).toEqual([["hit", false], [false, false], ["hit", false], ["na", "hit"]]);
    const vix = (n: number) => ({ R5: series([...flat(20, 10), ...flat(R.W_VIX, n)]) });
    expect([cells("vix", vix(R.W_VIX_N)), cells("vix", vix(R.W_VIX_N - 1))]).toEqual([["hit", "none"], [false, "none"]]);
    const trend = (n: number) => ({ SPY: series([...lin(R.MA_SLOW_N + 10, 100, 0.1), ...flat(50, n)]) });
    expect([cells("trend", trend(R.W_TREND_N))[0], cells("trend", trend(R.W_TREND_N - 1))[0], cells("trend", { SPY: series(lin(300, 200, -0.3)) }), cells("trend", { SPY: series(lin(300, 100, 0.3)) })]).toEqual(["hit", false, ["hit", "hit"], [false, false]]);
    const claims = (v: number) => ({ ICSA: series([...flat(200_000, R.W_CLAIMS_DAYS), ...flat(v, R.W_CLAIMS_N)]) });
    expect([cells("claims", claims(200_000 * R.W_CLAIMS_K)), cells("claims", claims(200_000 * R.W_CLAIMS_K - 1)), cells("claims", { ICSA: series(flat(200_000, R.W_CLAIMS_DAYS)) })]).toEqual([["none", "hit"], ["none", false], ["none", "na"]]);
    const dip = 200_000 - R.W_CLAIMS_N * 5_000; // one week's dip lowers the 4-wk avg low by only 5k
    expect(cells("claims", { ICSA: series([...flat(200_000, R.W_CLAIMS_DAYS), dip, ...flat(200_000, 10), ...flat(195_000 * R.W_CLAIMS_K - 1, R.W_CLAIMS_N)]) })).toEqual(["none", false]);
  });
  it("manual rows never grade: both cells na, none in the roster, and forcing their cells to hit leaves the grade; a measured row carries its sign rows", () => {
    const sign = (s: string): LadderSign => ({ sign: s, label: s, lean: "bear", finding: "", why: "", measurable: "", block: false, checked: "2026-10-01", due: null, primary: [], search: [], seed: [], sources: [] });
    const rows = watch({}, [sign("hy_oas"), sign("breadth")]);
    const manual = rows.filter((r) => r.manual);
    expect([manual.map((r) => r.key), manual.every((r) => r.correction.cell === "na" && r.bear.cell === "na"), rows.find((r) => r.key === "hy")!.signs]).toEqual([["breadth", "bb", "earnings", "private_credit", "rates"], true, [{ sign: "hy_oas", lean: "bear", block: false }]]);
    const forced = rows.map((r) => (r.manual ? { ...r, correction: { ...r.correction, cell: "hit" as Cell }, bear: { ...r.bear, cell: "hit" as Cell } } : r));
    expect(watchOf(WATCH_CLUSTERS, forced).grade).toBe(watchOf(WATCH_CLUSTERS, rows).grade);
  });
  it("watchOf over the real SP500_WATCH rows grades; a manual row moved into the roster throws", () => {
    const rows = watch({});
    expect(SP500_WATCH.length).toBe(rows.length);
    expect(() => watchOf(WATCH_CLUSTERS, rows)).not.toThrow();
    expect(() => watchOf([...WATCH_CLUSTERS, { name: "breadth", kind: "lead", members: ["breadth"] }], rows)).toThrow(/manual row/);
  });
  it("a watch-only feed heading past its allowance before asOf.close reads stale; its cells never move; a verdict-fed row never tags", () => {
    const N = 100;
    // lag = calendar days each watch-only feed heads before SXR8's last close; F1 (a verdict id) heads 30 back
    const feeds = (lag: number) => ({ ...EMPTY, LEGP_SPX: series(calmPre(N)), F1: series(flat(3, N - 30)), R5: series(flat(20, N - lag)), ICSA: series(flat(200_000, N - lag - (R.W_STALE_CLAIMS_DAYS - R.W_STALE_DAYS))) });
    const tagged = (lag: number) => ((res) => [res.asOf.close, ...["vix", "claims", "hy"].map((k) => res.watch.rows.find((r) => r.key === k)!.now.includes(" · stale @"))])(evaluateShipped(feeds(lag)));
    expect([tagged(R.W_STALE_DAYS), tagged(R.W_STALE_DAYS + 1)]).toEqual([[dateAt(N - 1), false, false, false], [dateAt(N - 1), true, true, false]]);
    const stale = evaluateShipped(feeds(R.W_STALE_DAYS + 1)).watch.rows;
    expect([stale.find((r) => r.key === "claims")!.now.endsWith(` · stale @${dateAt(N - 2 - R.W_STALE_CLAIMS_DAYS).slice(5)}`), stale.map((r) => [r.correction.cell, r.bear.cell])]).toEqual([true, watchAt(feeds(R.W_STALE_DAYS + 1), [], R).map((r) => [r.correction.cell, r.bear.cell])]);
  });
  it("held ⇔ no open SXR8 exit; an open exit is carried, the same one the follow path reads", () => {
    const PRE = 260;
    const open = { ...EMPTY, LEGP_SPX: series([...calmPre(PRE), ...lin(20, 94, -0.01)]) };
    const res = evaluateShipped(open);
    expect([res.watch.held, res.watch.exit, res.sessionsSinceExit !== undefined]).toEqual([false, openExit(open), true]);
    const still = evaluateShipped({ ...EMPTY, LEGP_SPX: series(calmPre(PRE + 20)) }).watch;
    expect([still.held, "exit" in still]).toEqual([true, false]);
  });
});

describe("replay (replaySp500 · whyFills)", () => {
  const PRE = 260;
  const hyCalm = (n: number): number[] => lin(n, 0, 1).map((i) => 3 + 0.01 * (i % 2));
  /** SXR8 ramps to its high (over MA200: g2 met), −6% exit at PRE then a new low every close (price unmet); R4 +0.5bp/close + an accelerating 10y keep rates unmet;
   *  NFCI −0.5 (c3 met), MOVE flat (c4 met); HY's shock closed before the exit, or `hold` = a post-exit HY shock retraced to that level. */
  const followSet = (len: number, hold?: number): SeriesSet => ({
    ...EMPTY,
    LEGP_SPX: series([...calmPre(PRE).map((v, i) => v * (0.5 + (0.5 * i) / (PRE - 1))), ...lin(len - PRE, 94, -0.01)]),
    F1: series(hold === undefined ? [...hyCalm(80), 3.5, 4, 3.5, 3, ...hyCalm(len - 84)] : [...hyCalm(PRE + 1), 3.2, 3.4, 3.6, 3.8, 4, ...flat(hold, len - PRE - 6)]),
    R4: series(lin(len, 1, 0.005)),
    R2: series(lin(len, 0, 1).map((i) => 2 + 1e-5 * i * i)),
    F3: series(flat(-0.5, len)),
    R6: series(flat(100, len)),
  });
  const FULL = PRE + R.TIME_STOP_N + R.T2_AFTER_N + R.T3_AFTER_N + 1;
  const fillsOf = (s: SeriesSet) => replaySp500(s).flatMap((e) => e.fills.flatMap((d, i) => (d === null ? [] : [[e.exit, `T${i + 1}`, d]])));
  it("time stop: gates clear, own legs never ready → T1 fills exactly TIME_STOP_N closes after the exit, not one fewer", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    expect(replaySp500(s).at(-1)).toMatchObject({ exit: openExit(s), fills: [dateAt(PRE + R.TIME_STOP_N), null, null] });
    expect(replaySp500(followSet(PRE + R.TIME_STOP_N)).map((e) => e.fills)).toEqual([[null, null, null]]);
  });
  it("forced episodes replace `episodes`: an exit forced one close later moves the time-stop fill one close later", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 2);
    const e = replaySp500(s).at(-1)!;
    expect(e.fills[0], "premise: the natural exit's time stop").toBe(dateAt(PRE + R.TIME_STOP_N));
    expect(replaySp500(s, undefined, undefined, [{ ...e, exit: dateAt(PRE + 1) }]).map((x) => [x.exit, x.fills[0]])).toEqual([[dateAt(PRE + 1), dateAt(PRE + 1 + R.TIME_STOP_N)]]);
  });
  it("whyFills: one row per replaySp500 fill, routed time stop / after T1 / after T2", () => {
    const s = followSet(FULL, 3.3);
    expect(fillsOf(s).length, "premise: the fixture fills all three tranches").toBe(3);
    expect(whyFills(s).map((w) => [w.exit, w.tranche, w.date, w.via])).toEqual(fillsOf(s).map((f, i) => [...f, ["time stop", "after T1", "after T2"][i]]));
  });
  it("whyFills throws on a fill its re-read cannot route: a T1 rates row met only on its first read of a close fills by count, then re-reads unmet", () => {
    const flaky = (): Form => {
      const seen = new Set<string>();
      return { r: R, defs: LEGS.map((d) => (d.key !== "t1-rates" ? d : { ...d, read: (r, x) => ((day) => (seen.has(day) ? d.read(r, x) : (seen.add(day), { value: "first", verdict: "met" as const })))(x.s.LEGP_SPX.at(-1)?.date ?? "") })) };
    };
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    expect(replaySp500(s, undefined, flaky()).at(-1)!.fills[0]! < dateAt(PRE + R.TIME_STOP_N), "premise: T1 fills by count before the time stop").toBe(true);
    expect(() => whyFills(s, undefined, flaky())).toThrow(/whyFills: T1 \S+ filled with neither its count nor its time stop route/);
  });
  it("REPLAY_BLIND: a CCC short of ½ holds T2 live, yet replaySp500's fills and whyFills' routes equal the CCC-empty run's", () => {
    const s = followSet(FULL, 3.3);
    const hot = { ...s, CCC: s.F1.map((p, i) => (i > PRE + 5 ? { ...p, value: 3.8 } : p)) };
    const t2 = { s: { ...hot, LEGP_SPX: hot.LEGP_SPX.filter((p) => p.date <= dateAt(PRE + R.TIME_STOP_N + R.T2_AFTER_N)) }, signs: [], exit: dateAt(PRE) };
    expect(LEGS.find((d) => d.key === "t2-credit")!.read(R, t2).verdict, "premise: the live verdict reads CCC").toBe("unmet");
    expect([fillsOf(hot), whyFills(hot).map((w) => w.via)]).toEqual([fillsOf(s), whyFills(s).map((w) => w.via)]);
  });
  it("REPLAY_BLIND F2/F5: tranchesAt is equal with F2/F5 forced RED vs empty — the box's ig/tech rows display, never hold", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    const red = (c: Pt[]) => c.map((p) => ({ ...p, state: "RED" }));
    const x: Inputs = { s, signs: [], exit: dateAt(PRE) };
    const xr: Inputs = { ...x, s: { ...s, F2: red(s.LEGP_SPX), F5: red(s.LEGP_SPX) } };
    expect([escalation(x, R).unread.length, escalation(xr, R).unread.length], "premise: the RED rows are read").toEqual([2, 0]);
    expect(tranchesAt(xr, R)).toEqual(tranchesAt(x, R));
  });
});

describe("veto rows (VETO_ROWS · graded reach)", () => {
  const signRow = (sign: string, block = false): LadderSign => ({ sign, label: sign, lean: block ? "bear" : "open", finding: "", why: "", measurable: "", block, checked: "2026-10-01", due: null, primary: [], search: [], seed: [], sources: [] });
  const spread = (base: number, last: number) => series([...flat(base, R.ESC_SPREAD_MA_N - 1), last]);
  /** Every ruled-box member live and none voting; `credit` trips `credit_confirms` (a coincident vote alone — no hold). */
  const calm: Partial<SeriesSet> = { VT: series(flat(0.5, R.ESC_VOL_FLIP_N)), R4: series(flat(2, R.ESC_REAL_DELTA_N + 1)), F1: spread(3, 3) };
  const credit: Partial<SeriesSet> = { ...calm, F1: spread(3, 4) };
  const raw = (t: "T1" | "T2" | "T3") => LEGS.filter((d) => d.tranche === t).map((d) => ({ key: d.key, tranche: t, gate: d.gate ?? false, value: "", verdict: "met" as const }));
  /** Per tranche: [`tally` held with every row met, its esc gate row unmet] off the ruled box. */
  const holds = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => ((x) => (["T1", "T2", "T3"] as const).map((t) => [!tally(t, raw(t), R, escalation(x, R)).clear, LEGS.find((d) => d.key === `${t.toLowerCase()}-esc`)!.read(R, x).verdict === "unmet"]))({ s: { ...EMPTY, ...s }, signs });
  const [NONE, T2T3, ALL] = [[[false, false], [false, false], [false, false]], [[false, false], [true, true], [true, true]], [[true, true], [true, true], [true, true]]];
  const esc = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => escalation({ s: { ...EMPTY, ...s }, signs }, R);
  it("a private_credit block holds T2·T3, T1 not — no box member is its measured half; every veto row alone holds T2·T3 with zero votes", () => {
    expect([esc(calm).hits, esc(calm).quorum, holds(calm)], "premise: a calm box at quorum").toEqual([[], { live: 3, n: 3, need: 3, t1Only: false }, NONE]);
    expect([esc(calm, [signRow("private_credit", true)]), holds(calm, [signRow("private_credit", true)])]).toMatchObject([{ hold: false, holdT2T3: true, veto: ["private_credit"] }, T2T3]);
    for (const id of VETO_ROWS) expect([esc(calm, [signRow(id, true)]).hold, esc(calm, [signRow(id, true)]).holdT2T3, holds(calm, [signRow(id, true)])], id).toEqual([false, true, T2T3]);
  });
  it("an hy_oas or ccc_bb block holds all three once credit_confirms (HY OAS, its measured half) trips; private_credit · earnings · tech_lead stay T2·T3 beside the same trip", () => {
    expect([esc(credit).hits, holds(credit)], "premise: credit_confirms trips, a coincident vote alone").toEqual([["credit"], NONE]);
    for (const id of VETO_ROWS) expect(holds(credit, [signRow(id, true)]), id).toEqual(id === "hy_oas" || id === "ccc_bb" ? ALL : T2T3);
  });
  it("evaluateShipped's read day demotes a block past reviewBy one tier (effectiveReach, never persisted): all → T2·T3, T2·T3 → no veto", () => {
    const stamped = (reach?: "T2T3"): LadderSign => ({ ...signRow("hy_oas", true), blocked: { on: "2026-10-01", setRun: "2026-10-01", reviewBy: "2026-10-22", ...(reach && { reach }) } });
    const read = (s: LadderSign, today: string) => ((e) => [e.hold, e.holdT2T3, e.veto])(evaluateShipped({ ...EMPTY, ...credit }, [s], R, undefined, [], today).escalation);
    expect([read(stamped(), "2026-10-22"), read(stamped(), "2026-10-23"), read(stamped("T2T3"), "2026-10-23")]).toEqual([[true, true, ["hy_oas"]], [false, true, ["hy_oas"]], [false, false, []]]);
  });
});

describe("applyRun on the sp500 leg", () => {
  it("the run row carries the verdict's watch grade", () => {
    const hot = series([...flat(2.6, R.W_HY_LOW_N - 1), 2.6 + R.W_HY_RISE]);
    const v = toVerdict(evaluateShipped({ ...EMPTY, F1: hot }), false);
    const situation = { lean: "a", slow: "b", fast: "c", decides: "d", flips: "e" };
    const live: LadderLive = { run: "2026-10-24", rules: [], signs: [], events: [], calendar: [], runs: [], situation };
    const { next } = applyRun(intoLive(live, v), { signs: {}, situation }, "2026-10-26", "sp500");
    expect([next.runs[0]?.watch, v.watch?.rows.find((r) => r.key === "hy")?.correction.cell]).toEqual([v.watch!.grade, "hit"]);
  });
});

describe("claimsFeed", () => {
  it("maps FRED observations to points; a fetch error rejects (never [] — an empty feed would move the watch grade)", async () => {
    const ok = await claimsFeed(() => Promise.resolve([{ date: "2026-10-17", value: 200_000 }]), new Date("2026-10-24T00:00:00Z"));
    expect(ok).toEqual([{ date: "2026-10-17", value: 200_000 }]);
    await expect(claimsFeed(() => Promise.reject(new Error("503")), new Date("2026-10-24T00:00:00Z"))).rejects.toThrow("503");
  });
});

describe("the --into verdict — licensed index levels are not published", () => {
  it("toVerdict leaves no observed licensed level in any string the fixture's raw reads quote", () => {
    const raw = evaluateShipped({ ...EMPTY, F1: series([...flat(2.6, R.W_HY_LOW_N - 1), 2.6 + R.W_HY_RISE]) });
    expect(findLicensedLevelsInLeg(raw).length, "premise: the raw reads quote licensed levels").toBeGreaterThan(0);
    expect(findLicensedLevelsInLeg(toVerdict(raw, false))).toEqual([]);
  });
});
