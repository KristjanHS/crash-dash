import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { watchOf, type Cell } from "../src/ladder-box.js";
import { applyRun } from "../src/ladder-run.js";
import { ma } from "../src/ladder-jobs.js";
import { toVerdict, watchContextRows, watchRows, type LadderEvent, type LadderLive, type LadderSign } from "../src/ladder-live.js";
import { eachSeries, episodes, pct, upTo } from "./ladder-replay.js";
import { calm as calmPre } from "./ladder-replay.test-helpers.js";
import { evaluateShipped, intoLive, SEMIS_RULES as R, type Pt, type Rules } from "./probe-semis-tranches.js";
import { SERIES, type SeriesSet } from "./semis-series.js";
import { openEpisode, SEMIS_WATCH, WATCH_CLUSTERS, watchAt, watchLatched, watchTimeline, type WatchSession } from "./semis-watch.js";

const dateAt = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const lin = (n: number, from: number, step: number): number[] => Array.from({ length: n }, (_, i) => from + step * i);
const EMPTY = Object.fromEntries(SERIES.map((id) => [id, []])) as unknown as SeriesSet;
const signRow = (sign: string, block = false, checked: string | null = "2026-10-01"): LadderSign => ({ sign, label: sign, lean: block ? "bear" : "open", finding: "", why: "", measurable: "", block, checked, due: null, primary: [], search: [], seed: [], sources: [] });
const TICK = 1e-4;

describe("drawdown watch (SEMIS_WATCH · WATCH_CLUSTERS)", () => {
  const watch = (s: Partial<SeriesSet>, events: LadderEvent[] = [], signs: LadderSign[] = []) => watchAt({ ...EMPTY, ...s }, signs, events, R);
  const cells = (key: string, s: Partial<SeriesSet>, events: LadderEvent[] = []) => ((w) => [w.correction.cell, w.bear.cell])(watch(s, events).find((r) => r.key === key)!);
  /** The close x after `pre` with x === k × MA(n) of `[...pre, x]` in float (fixed point; asserted). */
  const atCut = (pre: number[], k: number, n: number): number => {
    let x = pre.at(-1)!;
    for (let j = 0; j < 100 && x !== k * ma(series([...pre, x]), n)!; j++) x = k * ma(series([...pre, x]), n)!;
    expect(x, "atCut fixed point").toBe(k * ma(series([...pre, x]), n)!);
    return x;
  };
  it("cells at each cut ± 1, inclusive as printed; a side with no line reads none; short history na", () => {
    const trend = (n: number) => ({ LEGP_SEMIS: series([...flat(100, R.MA_FAST_N + 10), ...flat(90, n)]) });
    expect([cells("sec0", trend(R.W_TREND_N))[0], cells("sec0", trend(R.W_TREND_N - 1))[0], cells("sec0", { LEGP_SEMIS: series(lin(300, 200, -0.3)) }), cells("sec0", { LEGP_SEMIS: series(lin(300, 100, 0.3)) })]).toEqual(["hit", false, ["hit", "hit"], [false, false]]);
    const secPre = [...flat(100, R.MA_FAST_N + 10), ...flat(90, R.W_TREND_N - 1)];
    const secCut = atCut(secPre, R.MA_FAST_K, R.MA_FAST_N);
    expect([cells("sec0", { LEGP_SEMIS: series([...secPre, secCut]) })[0], cells("sec0", { LEGP_SEMIS: series([...secPre, secCut - TICK]) })[0]], "the last close at MA_FAST_K × MA50 exactly, then a tick under").toEqual([false, "hit"]);
    const bear = (v: number[]) => cells("sec0", { LEGP_SEMIS: series(v) })[1];
    const fall = lin(300, 200, -0.3);
    expect(
      [bear([...lin(250, 200, -0.4), ...flat(160, 49), 100]), bear([...flat(100, 100), ...flat(200, 150), ...flat(140, 30)]), bear([...fall.slice(0, -1), 130])],
      "each fails one conjunct only: MA50 ≥ MA200 · MA200 ≥ its level W_MA200_LAG_N back · close ≥ MA50 (close < MA200 follows from the other two)",
    ).toEqual([false, false, false]);
    const hy = (v: number, n: number = R.W_HY_N) => ({ F1: series([...flat(2.5, n), v]) });
    expect([cells("hy", hy(2.5 + R.W_HY_D10)), cells("hy", hy(2.5 + R.W_HY_D10 - TICK)), cells("hy", hy(9, R.W_HY_N - 1)), cells("hy", {})], "absolute Δ: cut, a tick under, one close short of the window").toEqual([["hit", "none"], [false, "none"], ["na", "none"], ["none", "none"]]);
    /** HCX at its 12-mo high (0) for `n` closes, then `v`: the change rules read v − 0. */
    const hcx = (v: number, n: number = R.W_HCX_BEAR_N) => ({ HCX: series([...flat(0, n), v]) });
    expect(
      [cells("hcx", hcx(R.W_HCX_D20)), cells("hcx", hcx(R.W_HCX_D20 + TICK)), cells("hcx", hcx(R.W_HCX_D63)), cells("hcx", hcx(R.W_HCX_D63 + TICK)), cells("hcx", hcx(R.W_HCX_D63, R.W_HCX_BEAR_N - 1)), cells("hcx", hcx(-0.5, R.W_HCX_N - 1)), cells("hcx", {})],
      "Δ20 at its cut, a tick over · Δ63 at its cut, a tick over · one close short of the Δ63 window · of the Δ20 window",
    ).toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], ["hit", "na"], ["na", "na"], ["none", "none"]]);
    expect(cells("hcx", { HCX: series([...flat(R.W_HCX_D63, R.W_HCX_BEAR_N + 1)]) }), "a level parked deep off its high, unchanged: no change rule fires").toEqual([false, false]);
    const mu = (v: number, n: number = R.MU_HIGH_N) => ({ F8: series([...flat(100, n - 1), v]) });
    expect([cells("mu", mu(100 * (1 + R.W_MU_CORR))), cells("mu", mu(100 * (1 + R.W_MU_CORR) + TICK)), cells("mu", mu(100 * (1 + R.W_MU_BEAR))), cells("mu", mu(100 * (1 + R.W_MU_BEAR) + TICK)), cells("mu", mu(50, R.MU_HIGH_N - 1))]).toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], ["na", "na"]]);
    const dd = (k: number, high: number = 100, gap: number = R.W_EPDD_HIGH_N - 1) => ({ LEGP_SEMIS: series([high, ...flat(100, gap), 100 * (1 + k)]) });
    expect([cells("epdd", dd(R.W_EPDD_CORR)), cells("epdd", dd(R.W_EPDD_CORR + TICK)), cells("epdd", dd(R.W_EPDD_BEAR)), cells("epdd", dd(R.W_EPDD_BEAR + TICK)), cells("epdd", dd(0, 200)), cells("epdd", dd(0, 200, R.W_EPDD_HIGH_N - 2))], "no episode ever opens (flat closes): the high is the W_EPDD_HIGH_N-close one").toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], [false, false], ["hit", "hit"]]);
    const r10 = (v: number, n: number = R.W_R10_N) => ({ LEGP_SEMIS: series([...flat(100, n), v]) });
    expect([cells("r10", r10(100 * (1 + R.W_R10_CORR))), cells("r10", r10(100 * (1 + R.W_R10_CORR) + TICK)), cells("r10", r10(100 * (1 + R.W_R10_BEAR))), cells("r10", r10(100 * (1 + R.W_R10_BEAR) + TICK)), cells("r10", r10(50, R.W_R10_N - 1))]).toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], ["na", "na"]]);
    const vx = (k: number, n: number = R.W_VXSMH_N) => ({ VXSMH: series([...flat(40, n), 40 * (1 + k)]) });
    expect([cells("vxsmh", vx(R.W_VXSMH_D10)), cells("vxsmh", vx(R.W_VXSMH_D10 - TICK)), cells("vxsmh", vx(1, R.W_VXSMH_N - 1)), cells("vxsmh", {})], "relative Δ: cut, a tick under, one close short of the window").toEqual([["hit", "none"], [false, "none"], ["na", "none"], ["none", "none"]]);
    const ry = (v: number, n: number = R.W_RY_N) => ({ R4: series([...flat(2, n), v]) });
    expect(
      [cells("ry", ry(2 + R.W_RY_D20)), cells("ry", ry(2 + R.W_RY_D20 - TICK)), cells("ry", ry(2 + R.W_RY_BEAR)), cells("ry", ry(2 + R.W_RY_BEAR - TICK)), cells("ry", ry(9, R.W_RY_N - 1)), cells("ry", {})],
      "absolute Δ: correction cut, a tick under · bear cut, a tick under · one close short of the window",
    ).toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], ["na", "na"], ["none", "none"]]);
    const rs = (k: number, n: number = R.W_RS_N) => ({ RS_SMH: series([...flat(0.7, n), 0.7 * (1 + k)]) });
    expect(
      [cells("rs", rs(R.W_RS_D20)), cells("rs", rs(R.W_RS_D20 + TICK)), cells("rs", rs(R.W_RS_BEAR)), cells("rs", rs(R.W_RS_BEAR + TICK)), cells("rs", rs(-0.5, R.W_RS_N - 1)), cells("rs", {})],
      "relative Δ: correction cut, a tick over · bear cut, a tick over · one close short of the window",
    ).toEqual([["hit", false], [false, false], ["hit", "hit"], ["hit", false], ["na", "na"], ["none", "none"]]);
  });
  it("stretch: the epdd anchor high at W_STRETCH_K × its own MA_SLOW_N exactly hits, a tick under does not, short of MA_SLOW_N closes there na; bear none", () => {
    const pre = flat(100, R.MA_SLOW_N - 1);
    const x = atCut(pre, R.W_STRETCH_K, R.MA_SLOW_N);
    const at = (p: number[], hi: number) => cells("stretch", { LEGP_SEMIS: series([...p, hi, ...flat(110, 3)]) });
    expect([at(pre, x), at(pre, x - TICK), at(pre.slice(1), x)], "closes of 110 after the high: the MA is the high's own, never the newest").toEqual([["hit", "none"], [false, "none"], ["na", "none"]]);
  });
  it("bbb: Δ10 leg at its cut hits, a tick under false · low-rise leg at low + W_BBB_RISE hits, a tick under false, the low aged out of W_BBB_LOW_N false · short na · empty none", () => {
    const d10 = (v: number) => cells("bbb", { BBB: series([...flat(1, R.W_BBB_LOW_N), v]) });
    const rise = (v: number, n: number = R.W_BBB_LOW_N - 1) => cells("bbb", { BBB: series([1, ...flat(v, n)]) });
    expect(R.W_BBB_D10 < R.W_BBB_RISE, "the Δ10 fixture stays under the low-rise cut").toBe(true);
    expect([d10(1 + R.W_BBB_D10), d10(1 + R.W_BBB_D10 - TICK), rise(1 + R.W_BBB_RISE), rise(1 + R.W_BBB_RISE - TICK), rise(1 + R.W_BBB_RISE, R.W_BBB_LOW_N), cells("bbb", { BBB: series(flat(1, R.W_BBB_N)) }), cells("bbb", {})]).toEqual([
      ["hit", "none"], [false, "none"], ["hit", "none"], [false, "none"], [false, "none"], ["na", "none"], ["none", "none"],
    ]);
  });
  it("hy reads Δ over W_HY_N closes: a W_HY_D10 jump stays hit W_HY_N closes after it, false on the next", () => {
    const F1 = series([...flat(2.5, R.W_HY_N), ...flat(2.5 + R.W_HY_D10, R.W_HY_N + 1)]);
    expect([0, 1].map((k) => cells("hy", { F1: F1.slice(0, 2 * R.W_HY_N + k) })[0])).toEqual(["hit", false]);
  });
  describe("events row", () => {
    const LAST = 40;
    const SEC0 = { LEGP_SEMIS: series(flat(100, LAST + 1)) };
    const ev = (back: number, status: string, holds: LadderEvent["holds"] = []): LadderEvent => ({ date: dateAt(LAST - back), event: `e${back}`, signs: ["hbm"], escalationIf: "", fizzleIf: "", holds, secondary: false, status });
    const at = (...events: LadderEvent[]) => cells("events", SEC0, events);
    it("a sign-only escalation inside W_EVENT_DAYS hits, one day older does not; a mixed (holds-event or not, [USER] R4) and any fizzle never count; one dated after the close is not landed", () => {
      expect([at(ev(R.W_EVENT_DAYS, "escalation: x")), at(ev(R.W_EVENT_DAYS + 1, "escalation: x")), at(ev(0, "mixed: x", ["T2"])), at(ev(0, "mixed: x")), at(ev(0, "fizzle: x", ["T2"]), ev(0, "fizzle: y")), at(ev(-1, "escalation: x", ["T2"])), at(ev(0, "NOT DUE until x"))]).toEqual([["hit", false], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false]]);
    });
    it("carriers: W_CARRIER_N escalations inside W_EVENT_DAYS hit; one a day older, or a holds-event mixed in its place, does not; bear none; a forced hit leaves the grade", () => {
      expect(R.W_CARRIER_N, "premise: N − 1 ≥ 1").toBeGreaterThan(1);
      const esc = (n: number): LadderEvent[] => Array.from({ length: n }, (_, i) => ev(i, `escalation: ${i}`));
      const car = (...events: LadderEvent[]) => cells("carriers", SEC0, events);
      expect([car(...esc(R.W_CARRIER_N)), car(...esc(R.W_CARRIER_N - 1), ev(R.W_EVENT_DAYS + 1, "escalation: old")), car(...esc(R.W_CARRIER_N - 1), ev(0, "mixed: m", ["T2"]))]).toEqual([["hit", "none"], [false, "none"], [false, "none"]]);
      // A −10 % last close: coincident votes, no lead → ELEVATED; a carriers lead vote would make it HIGH.
      const rows = watch({ LEGP_SEMIS: series([...flat(100, R.MA_SLOW_N + R.W_MA200_LAG_N + 10), 90]) });
      const forced = rows.map((r) => (r.key === "carriers" ? { ...r, correction: { ...r.correction, cell: "hit" as Cell } } : r));
      expect([rows.find((r) => r.key === "carriers")!.role, watchOf(WATCH_CLUSTERS, forced).grade]).toEqual(["context", watchOf(WATCH_CLUSTERS, rows).grade]);
    });
    it("bear: W_EVENT_BEAR_N escalations inside W_EVENT_BEAR_DAYS (one day older does not), or one holds-event escalation; no SEC0 close reads none", () => {
      expect([at(ev(0, "escalation: a"), ev(R.W_EVENT_BEAR_DAYS, "escalation: b"))[1], at(ev(0, "escalation: a"), ev(R.W_EVENT_BEAR_DAYS + 1, "escalation: b"))[1], at(ev(0, "escalation: a", ["T3"]))[1], cells("events", {}, [ev(0, "escalation: a")])]).toEqual(["hit", false, "hit", ["none", "none"]]);
    });
    it("carries the sign rows of the events it counted, none when nothing counts", () => {
      const row = (events: LadderEvent[]) => watch(SEC0, events, [signRow("hbm"), signRow("capex_guides")]).find((r) => r.key === "events")!.signs;
      expect([row([ev(0, "escalation: x")]), row([ev(0, "fizzle: x")])]).toEqual([[{ sign: "hbm", lean: "open", block: false }], undefined]);
    });
  });
  it("watchOf over the real SEMIS_WATCH rows grades; manual rows never grade (forced hits leave it) and one moved into the roster throws", () => {
    const rows = watch({});
    const manual = rows.filter((r) => r.manual);
    expect([SEMIS_WATCH.length, manual.map((r) => r.key)]).toEqual([rows.length, ["capex_guides", "dram_contract", "hbm", "ai_funding", "sox_breadth", "taiwan_export", "pc_demand"]]);
    expect(() => watchOf(WATCH_CLUSTERS, rows)).not.toThrow();
    const forced = rows.map((r) => (r.manual ? { ...r, correction: { ...r.correction, cell: "hit" as Cell }, bear: { ...r.bear, cell: "hit" as Cell } } : r));
    expect(watchOf(WATCH_CLUSTERS, forced).grade).toBe(watchOf(WATCH_CLUSTERS, rows).grade);
    expect(() => watchOf([...WATCH_CLUSTERS, { name: "memory", kind: "lead", members: ["pc_demand"] }], rows)).toThrow(/manual row/);
  });
  it("WATCH_CLUSTERS members ⇔ the SEMIS_WATCH rows with no role and not manual (a role row in a cluster type-checks but must not vote)", () => {
    const graded = SEMIS_WATCH.filter((d) => !("manual" in d) && !d.role).map((d) => d.key);
    expect(WATCH_CLUSTERS.flatMap((c): string[] => [...c.members]).sort()).toEqual([...graded].sort());
    expect(graded).toContain("epdd");
  });
  describe("HIGH latch (watchLatched)", () => {
    const B = R.MA_SLOW_N + R.W_MA200_LAG_N + 10;
    /** SEC0 at 100 for B closes, then the tails: SEC0 90 votes depth and speed (coincident) at once. The lead is the events row, its windows narrowed
     *  to the close's own date (`Q`): per tail close L = a sign-only escalation (correction vote), H = a holding one (bear vote), C = none. */
    type Lead = "L" | "C" | "H";
    type World = { s: SeriesSet; ev: LadderEvent[] };
    const Q: Rules = { ...R, W_EVENT_DAYS: 0, W_EVENT_BEAR_DAYS: 0 };
    const leads = (from: number, lead: Lead[]): LadderEvent[] =>
      lead.flatMap((k, i) => (k === "C" ? [] : [{ date: dateAt(from + i), event: `e${i}`, signs: [], escalationIf: "", fizzleIf: "", holds: k === "H" ? ["T2" as const] : [], secondary: false, status: "escalation: x" }]));
    const set = (sec0: number[], lead: Lead[], extra: Partial<SeriesSet> = {}): World => ({ s: { ...EMPTY, LEGP_SEMIS: series([...flat(100, B), ...sec0]), ...extra }, ev: leads(B, lead) });
    const trail = (w: World, f: (y: SeriesSet, ev: LadderEvent[]) => string, from: number = B) => w.s.LEGP_SEMIS.slice(from).map((p) => f(eachSeries(SERIES, w.s, upTo(p.date)), w.ev));
    const raw = (r: Rules = Q) => (y: SeriesSet, ev: LadderEvent[]) => watchOf(WATCH_CLUSTERS, watchAt(y, [], ev, r)).grade;
    const open = (y: SeriesSet) => (openEpisode(y) ? "open" : "-");
    /** `set` over E zigzag 100/98 closes (episode drop ≈ 6 %, rise ≈ 14 %: a −18 % close opens one, a bounce to −14 % keeps it open); flat closes never open one. */
    const E = 260;
    const zig = Array.from({ length: E }, (_, i) => ((E - 1 - i) % 2 === 0 ? 100 : 98));
    const ep = (sec0: number[], lead: Lead[], extra: Partial<SeriesSet> = {}): World => ({ s: { ...EMPTY, LEGP_SEMIS: series([...zig, ...sec0]), ...extra }, ev: leads(E, lead) });
    const latched = (r: Rules = Q) => (y: SeriesSet, ev: LadderEvent[]) => ((w) => `${w.grade}${w.latched ? ` @${w.latched}` : ""}${w.stretched ? ` ^${w.stretched}` : ""}${w.lifted ? ` +${w.lifted.join("+")}` : ""}`)(watchLatched(y, [], ev, r));
    /** `f` under Q, but on session `d` r10's window outruns the closes (na → thin: every other roster member is live). */
    const thinOn = (d: string, f: (r: Rules) => (y: SeriesSet, ev: LadderEvent[]) => string) => (y: SeriesSet, ev: LadderEvent[]) => f(y.LEGP_SEMIS.at(-1)!.date === d ? { ...Q, W_R10_N: y.LEGP_SEMIS.length } : Q)(y, ev);
    it("a raw HIGH holds HIGH over no-lead sessions while the episode is open and epdd ≤ W_LATCH_DD, released at −14 %", () => {
      expect(R.W_LATCH_DD, "premise: the latch acts on ELEVATED, which needs the depth row's correction hit").toBeLessThanOrEqual(R.W_EPDD_CORR);
      const w = ep(flat(100, 4).map((x, i) => x * (1 + [-0.18, -0.16, R.W_LATCH_DD, R.W_LATCH_DD + 0.01][i]!)), ["L", "C", "C", "C"]);
      expect(trail(w, open, E), "vacuity: the episode is open on every tail close").toEqual(flat(0, 4).map(() => "open"));
      expect([trail(w, raw(), E), trail(w, latched(), E)]).toEqual([
        ["HIGH", "ELEVATED", "ELEVATED", "ELEVATED"],
        ["HIGH", `HIGH @${dateAt(E)}`, `HIGH @${dateAt(E)}`, "ELEVATED"],
      ]);
    });
    it("no open episode (flat closes, σ = 0) never latches, at any depth", () => {
      const w = set([82, 84], ["L", "C"]);
      expect([trail(w, open), trail(w, raw()), trail(w, latched())]).toEqual([["-", "-"], ["HIGH", "ELEVATED"], ["HIGH", "ELEVATED"]]);
    });
    it("a (thin) session reads thin, never lifted, and the next non-thin session re-latches ([USER] R8)", () => {
      const w = ep([82, 84, 84, 84], ["L", "C", "C", "C"]);
      expect([trail(w, thinOn(dateAt(E + 2), raw), E), trail(w, thinOn(dateAt(E + 2), latched), E)]).toEqual([
        ["HIGH", "ELEVATED", "ELEVATED (thin)", "ELEVATED"],
        ["HIGH", `HIGH @${dateAt(E)}`, "ELEVATED (thin)", `HIGH @${dateAt(E)}`],
      ]);
    });
    it("SEVERE = lead bear ∧ (epdd ≤ W_EPDD_BEAR ∨ r10 ≤ W_R10_BEAR), HY flat: depth alone, speed alone, neither → HIGH", () => {
      expect(R.W_R10_BEAR > R.W_EPDD_BEAR, "a step to the r10 bear cut leaves epdd above its bear cut").toBe(true);
      const at = (tail: number[]) => ((w) => raw()(w.s, w.ev))(set(tail, tail.map((): Lead => "H"), { F1: series(flat(2.5, B + tail.length)) }));
      const slide = lin(31, 100, (100 * R.W_EPDD_BEAR) / 30).slice(1);
      expect([at(slide), at([100, 100 * (1 + R.W_R10_BEAR)]), at([100, 100 * (1 + R.W_R10_BEAR) + 1])], "a holding escalation on every tail close").toEqual(["SEVERE", "SEVERE", "HIGH"]);
    });
    it("a raw SEVERE latches HIGH, never SEVERE; `latched` = the latest raw HIGH/SEVERE session", () => {
      const w = ep([80, 80, 80, 84], ["L", "H", "H", "C"]);
      expect([trail(w, raw(), E), trail(w, latched(), E)]).toEqual([["HIGH", "SEVERE", "SEVERE", "ELEVATED"], ["HIGH", "SEVERE", "SEVERE", `HIGH @${dateAt(E + 2)}`]]);
    });
    describe("confirmer lift", () => {
      /** `vals` dated to end on SEC0 tail close B (the confirmers' Δ windows end there). */
      const upToB = (vals: number[]): Pt[] => vals.map((value, j) => ({ date: dateAt(B - vals.length + 1 + j), value }));
      const vxHit = upToB([...flat(40, R.W_VXSMH_N), 40 * (1 + R.W_VXSMH_D10)]);
      const hyHit = upToB([...flat(2.5, R.W_HY_N), 2.5 + R.W_HY_D10]);
      const bbbHit = upToB([...flat(1, R.W_BBB_N), 1 + R.W_BBB_D10]);
      const at = (sec0: number, lead: Lead, extra: Partial<SeriesSet>) => ((w) => latched()(w.s, w.ev))(set([sec0], [lead], extra));
      it("a confirmer `na` (HY, BBB and VXSMH one close in) with every roster member live is not (thin)", () => {
        const w = set([90], ["C"], { VXSMH: upToB([40]), F1: upToB([2.5]), BBB: upToB([1]) });
        expect([watchAt(w.s, [], w.ev, Q).filter((x) => x.role === "confirmer").map((x) => x.correction.cell), raw()(w.s, w.ev)]).toEqual([["na", "na", "na"], "ELEVATED"]);
      });
      it("ELEVATED → HIGH only while a lead votes: a confirmer hit with a lead lifts (`lifted` = its keys), beside coincident votes alone it does not; a (thin) one never", () => {
        const thin = ((w) => thinOn(dateAt(B), latched)(w.s, w.ev))(set([100], ["L"], { VXSMH: vxHit }));
        expect([at(100, "L", { VXSMH: vxHit }), at(100, "L", { VXSMH: vxHit, F1: hyHit }), at(100, "L", { BBB: bbbHit }), at(90, "C", { VXSMH: vxHit, F1: hyHit, BBB: bbbHit }), at(100, "L", { VXSMH: upToB([...flat(40, R.W_VXSMH_N), 40 * (1 + R.W_VXSMH_D10) - 1]) }), thin]).toEqual([
          "HIGH +vxsmh",
          "HIGH +hy+vxsmh",
          "HIGH +bbb",
          "ELEVATED",
          "ELEVATED",
          "ELEVATED (thin)",
        ]);
      });
    });
    describe("stretch step", () => {
      /** Anchor high = W_STRETCH_K × the zigzag's MA_SLOW_N ± 2, then tail × the high (0.82: opens an episode, epdd votes depth). */
      const cut = R.W_STRETCH_K * ma(series(zig), R.MA_SLOW_N)!;
      const drop = (hi: number, tail: number[], lead: Lead[], extra: Partial<SeriesSet> = {}) => ep([hi, ...tail.map((k) => hi * k)], ["C", ...lead], extra);
      const fell = [0.82, 0.82, 0.82];
      it("a stretched anchor steps a non-lead ELEVATED → HIGH (`stretched` = the anchor date); an unstretched one does not", () => {
        const [up, under] = [drop(cut + 2, fell, ["C", "C", "C"]), drop(cut - 2, fell, ["C", "C", "C"])];
        expect([trail(up, open, E + 1), trail(under, open, E + 1)], "vacuity: the episode is open after the drop in both").toEqual([flat(0, 3).map(() => "open"), flat(0, 3).map(() => "open")]);
        expect([trail(up, raw(), E), trail(up, latched(), E), trail(under, latched(), E)]).toEqual([
          ["CALM", "ELEVATED", "ELEVATED", "ELEVATED"],
          ["CALM", ...flat(0, 3).map(() => `HIGH ^${dateAt(E)}`)],
          ["CALM", "ELEVATED", "ELEVATED", "ELEVATED"],
        ]);
      });
      it("a raw HIGH stays as-is, and a session both latched and stretched carries both", () => {
        expect(trail(drop(cut + 2, fell, ["L", "C", "C"]), latched(), E)).toEqual(["CALM", "HIGH", `HIGH @${dateAt(E + 1)} ^${dateAt(E)}`, `HIGH @${dateAt(E + 1)} ^${dateAt(E)}`]);
      });
      it("hysteresis: enters at epdd ≤ W_STRETCH_DD, holds while ≤ W_STRETCH_HOLD, released it needs W_STRETCH_DD again", () => {
        expect(R.W_STRETCH_DD, "premise: entry deeper than hold").toBeLessThan(R.W_STRETCH_HOLD);
        expect(R.W_STRETCH_HOLD + 0.01, "premise: the fixture's released session stays ELEVATED (depth row's correction hit)").toBeLessThanOrEqual(R.W_EPDD_CORR);
        const [dd, hold] = [1 + R.W_STRETCH_DD, 1 + R.W_STRETCH_HOLD];
        const w = drop(cut + 2, [0.82, hold + 0.01, dd + 0.01, dd, dd + 0.01, hold, hold + 0.01], flat(0, 7).map(() => "C" as Lead));
        expect(trail(w, open, E + 1), "vacuity: the episode is open on every tail close").toEqual(flat(0, 7).map(() => "open"));
        const H = `HIGH ^${dateAt(E)}`;
        expect([trail(w, raw(), E), trail(w, latched(), E)]).toEqual([
          ["CALM", ...flat(0, 7).map(() => "ELEVATED")],
          ["CALM", H, "ELEVATED", "ELEVATED", H, H, H, "ELEVATED"],
        ]);
      });
      it("CALM in an open stretched episode never steps (a bounce to −4 %)", () => {
        const w = drop(cut + 2, [0.82, 0.96], ["C", "C"]);
        expect([trail(w, open, E + 1), trail(w, latched(), E)]).toEqual([["open", "open"], ["CALM", `HIGH ^${dateAt(E)}`, "CALM"]]);
      });
      it("a (thin) session is never stepped; the next non-thin one is", () => {
        const w = drop(cut + 2, fell, ["C", "C", "C"]);
        expect(trail(w, thinOn(dateAt(E + 2), latched), E)).toEqual(["CALM", `HIGH ^${dateAt(E)}`, "ELEVATED (thin)", `HIGH ^${dateAt(E)}`]);
      });
    });
  });
  it("held ⇔ no open SEC0 episode; an open one's exit is carried", () => {
    const PRE = 260;
    const open = { ...EMPTY, LEGP_SEMIS: series([...calmPre(PRE), ...lin(20, 85, -0.01)]) };
    const w = evaluateShipped(open).watch;
    expect([w.held, w.exit]).toEqual([false, openEpisode(open)!.exit]);
    const still = evaluateShipped({ ...EMPTY, LEGP_SEMIS: series(calmPre(PRE + 20)) }).watch;
    expect([still.held, "exit" in still]).toEqual([true, false]);
  });
});

/**
 * The harness fixture's closes are seeded synthetic series (`npm run synth:fixtures`) — real market data
 * is not distributed with this repository; its `events` are the semis leg's own calendar. Each pin below
 * is either a mechanics property (holds on any closes) or a regression pin over the seeded series.
 */
describe("drawdown watch — seeded closes 2024-10..2026-10 (probe-semis-tranches.watch.json)", () => {
  type Fx = { ids: string[]; series: Partial<Record<string, [string, number][]>>; events: Pick<LadderEvent, "date" | "event" | "signs" | "holds" | "status">[] };
  const fx = JSON.parse(readFileSync(new URL("./probe-semis-tranches.watch.json", import.meta.url), "utf8")) as Fx;
  const s = Object.fromEntries(SERIES.map((id) => [id, (fx.series[id] ?? []).map(([date, value]) => ({ date, value }))])) as SeriesSet;
  const events: LadderEvent[] = fx.events.map((e) => ({ escalationIf: "", fizzleIf: "", secondary: false, ...e }));
  const dates = s.LEGP_SEMIS.map((p) => p.date);
  const at = new Map(dates.map((d, i) => [d, i]));
  let tl: WatchSession[] = [];
  beforeAll(() => {
    tl = watchTimeline(s, [], events, R);
  });
  it("holds every series a SEMIS_WATCH row tag names, ≥ 260 sessions each, to 10-30 (F1 + BBB to 10-29, FRED lag)", () => {
    const read = [...new Set(SEMIS_WATCH.flatMap((d) => ("manual" in d ? [] : d.tag.series)))];
    const missing = read.filter((id) => !fx.ids.includes(id));
    expect(missing, `fixture lacks ${missing.join(", ")} — add it to WATCH_SERIES in scripts/backtest/synth-fixtures.ts, run \`npm run synth:fixtures\` and commit`).toEqual([]);
    expect(read.filter((id) => (fx.series[id]?.length ?? 0) < 260 || !fx.series[id]?.length || fx.series[id]!.at(-1)![0] < (id === "F1" || id === "BBB" ? "2026-10-29" : "2026-10-30"))).toEqual([]);
  });
  /** Admission ([USER] R5): correction first hit ≤ FIRST_N sessions after each BEAR `shockStart` (a) · lit < CALM_MAX of calm sessions (b) · off at every BEAR's `shockStart` high (c). */
  const ADMIT = { FIRST_N: 10, CALM_MAX: 0.15 } as const;
  it("admission table: each graded row's verdict over the fixture's BEAR episodes, the calm sessions and the BEAR highs", () => {
    const c = s.LEGP_SEMIS;
    const eps = episodes(c);
    const bears = eps.filter((e) => e.shape === "BEAR");
    expect(bears.length >= 1, "vacuity: ≥ 1 BEAR episode").toBe(true);
    const calm = dates.filter((d) => !eps.some((e) => d >= e.shockStart && d <= e.end));
    const cell = (k: string, i: number): boolean => tl[i]!.cells[k]![0] === "hit";
    /** Each graded row, plus the depth ∨ speed union the coincident rows are admitted on ([USER] R7). */
    const graded: [string, (i: number) => boolean][] = [...Object.keys(tl.at(-1)!.cells).map((k): [string, (i: number) => boolean] => [k, (i) => cell(k, i)]), ["epdd∨r10", (i) => cell("epdd", i) || cell("r10", i)]];
    const lines: string[] = [];
    const verdicts: Record<string, string> = {};
    for (const [k, hit] of graded) {
      const fails: string[] = [];
      const perBear = bears.map((e) => {
        const [a, b] = [at.get(e.shockStart)!, at.get(e.end)!];
        const span = Array.from({ length: b - a + 1 }, (_, j) => a + j);
        const f = span.find(hit);
        if (f === undefined || f - a > ADMIT.FIRST_N) fails.push(`a:${e.shockStart.slice(5)}`);
        return `${e.shockStart.slice(5)} ${f === undefined ? "never" : `+${f - a} (${pct(c[f]!.value! / c[a]!.value! - 1)})`} · ${span.filter(hit).length}/${span.length}`;
      });
      const lit = calm.filter((d) => hit(at.get(d)!)).length;
      if (lit >= ADMIT.CALM_MAX * calm.length) fails.push("b");
      const pc = bears.some((e) => hit(at.get(e.shockStart)!));
      if (pc) fails.push("c");
      lines.push(`${k.padEnd(8)} ${perBear.join(" | ")} | calm ${lit}/${calm.length} | highs ${pc ? "hit" : "off"}`);
      verdicts[k] = fails.join(" ") || "admit";
    }
    console.log(lines.join("\n"));
    expect(verdicts).toEqual({
      sec0: "a:11-10",
      // The stretch pre-condition inverts (c): its "c" = ON at a BEAR high is its pass, never a failure.
      stretch: "b c",
      epdd: "b",
      r10: "a:11-10",
      hy: "admit",
      bbb: "admit",
      hcx: "a:11-10",
      mu: "admit",
      vxsmh: "admit",
      ry: "a:11-10",
      rs: "a:11-10",
      events: "a:11-10",
      carriers: "a:11-10",
      "epdd∨r10": "b",
    });
  });
  it("grade trail: every stretched session grades HIGH, none SEVERE; the grade mix over the seeded closes", () => {
    const mix: Record<string, number> = {};
    for (const x of tl) mix[x.grade] = (mix[x.grade] ?? 0) + 1;
    expect([[...new Set(tl.filter((x) => x.stretched).map((x) => x.grade))], tl.filter((x) => x.grade === "SEVERE").map((x) => x.date)]).toEqual([["HIGH"], []]);
    expect(mix).toEqual({ "CALM (thin)": 10, CALM: 307, ELEVATED: 160, HIGH: 67 });
  });
  it("the stretch step lifts only open-episode sessions, never a rebound one (in no episode); its anchors", () => {
    const c = s.LEGP_SEMIS;
    const eps = episodes(c);
    const rebound = (d: string): boolean => !eps.some((e) => d >= e.shockStart && d <= e.end);
    const stepped = tl.filter((x) => x.stretched);
    expect(stepped.filter((x) => rebound(x.date) || !openEpisode(eachSeries(SERIES, s, upTo(x.date)))).map((x) => x.date), "every stepped session sits in an open episode").toEqual([]);
    expect([...new Set(stepped.map((x) => x.stretched))], "vacuity: some session is stepped · its anchors over the seeded closes").toEqual(["2025-11-10", "2026-09-22"]);
  });
  it("confirmer lift: no lead-voted session (R4: the 10-21 / 10-28 holds-event mixeds no longer count; no fixture escalation), so lifted none", () => {
    const lead = tl.filter((x) => x.cells.events![0] === "hit");
    expect([tl.filter((x) => x.lifted).map((x) => `${x.date}+${x.lifted!.join("+")}`), lead.map((x) => `${x.date.slice(5)} ${x.grade} ${x.cells.hy![0]} ${x.cells.bbb![0]} ${x.cells.vxsmh![0]}`)]).toEqual([[], []]);
  });
  it("bbb (Stage 6.3, pin only): its hit sessions over the seeded closes, as runs of consecutive sessions", () => {
    const runs: [string, string][] = [];
    tl.forEach((x, i) => {
      if (x.cells.bbb![0] !== "hit") return;
      if (i > 0 && tl[i - 1]!.cells.bbb![0] === "hit") runs.at(-1)![1] = x.date;
      else runs.push([x.date, x.date]);
    });
    expect(runs.map(([a, b]) => (a === b ? a : `${a}..${b}`))).toEqual(["2025-11-12..2025-11-28", "2025-12-03", "2026-03-31..2026-06-29", "2026-07-09", "2026-07-13..2026-07-17"]);
  });
  it("no fixture session latches: capex is context-only since Stage 4.1 (the accept path is the unit latch tests + the applyRun seam below)", () => {
    expect(tl.filter((x) => x.latched).map((x) => `${x.date}@${x.latched}`)).toEqual([]);
  });
  it("applyRun on the semis leg: the run row stores the verdict's grade and a move from the newest graded run pushes", () => {
    // The fixture no longer latches (capex is context): a sign-only escalation on 01-15, windowed to its own date, restores that session's raw HIGH.
    const lead: LadderEvent = { date: "2026-01-15", event: "lead", signs: [], escalationIf: "", fizzleIf: "", holds: [], secondary: false, status: "escalation: x" };
    const v = toVerdict(evaluateShipped(eachSeries(SERIES, s, upTo("2026-01-16")), [], { ...R, W_EVENT_DAYS: 0 }, undefined, [...events, lead]), false);
    const situation = { lean: "a", slow: "b", fast: "c", decides: "d", flips: "e" };
    const was = v.watch!.grade === "CALM" ? "HIGH" : "CALM";
    const live: LadderLive = { run: "2026-01-15", rules: [], signs: [], events: [], calendar: [], runs: [{ date: "2026-01-15", t1: "-", t2: "-", t3: "-", live: "-", watch: was }], situation };
    const { next, alert } = applyRun(intoLive(live, v), { signs: {}, situation }, "2026-01-16", "semis");
    expect([v.watch!.grade, next.runs[0]?.watch, alert?.title.includes(`watch ${was}->${v.watch!.grade}`)], "evaluateShipped carries the latched 01-16 grade").toEqual(["HIGH", "HIGH", true]);
    expect(alert?.body).toContain(`Drawdown watch: ${was} → HIGH (latched from ${v.watch!.latched!.slice(5)} · stretched from ${v.watch!.stretched!.slice(5)}) (correction votes`);
    const RANK = { votes: 0, confirmer: 1, step: 2 } as const;
    const roles = watchRows(v).map(([label = ""]) => ({ label, role: (/ · (confirmer|step)\)$/.exec(label)?.[1] ?? "votes") as keyof typeof RANK }));
    const roleOf = (label: string) => roles.find((x) => x.label.startsWith(`${label} (`))?.role;
    const ctx = watchContextRows(v);
    const inCtx = (label: string) => ctx.some(([l = ""]) => l.startsWith(`${label} (`));
    expect(
      [roles.every((x, i) => i === 0 || RANK[roles[i - 1]!.role] <= RANK[x.role]), roleOf("SEC0 off high"), roleOf("HY OAS"), roleOf("SEC0 stretch"), inCtx("HCX capex basket"), inCtx("capex guides"), inCtx("SEC0 stretch"), [...watchRows(v), ...ctx].some((r) => r.join("|").includes("not graded") || r[0]!.includes("· context"))],
      "graded rows rank voters → confirmer → step (stretch feeds the grade); context + manual rows sit in their own table, no per-row not-graded text",
    ).toEqual([true, "votes", "confirmer", "step", true, true, false, false]);
    const stored = applyRun(intoLive({ ...live, runs: [{ ...live.runs[0]!, watch: "HIGH" }] }, v), { signs: {}, situation }, "2026-01-16", "semis").alert;
    expect([v.watch!.latched, v.watch!.stretched, stored?.title.includes("watch") ?? false, stored?.body.includes("Drawdown watch") ?? false], "a latched (and stretched) HIGH over a stored HIGH is no move").toEqual(["2026-01-15", "2025-11-10", false, false]);
  });
});
