import { describe, expect, it } from "vitest";
import { findLicensedLevelsInLeg } from "../src/licensed-levels.js";
import { R4_ESC } from "../src/chart-rail.js";
import { toVerdict, type LadderEvent, type LadderFamily, type LadderSign } from "../src/ladder-live.js";
import type { CreditRules } from "./ladder-credit.js";
import { coverageOf } from "./ladder-replay-feeds.js";
import { acceptance, driftSummary, episodes, fillDrift, HOLDOUT_WINDOW, holdoutVerdict, REPLAY, type ReplayRun } from "./ladder-replay.js";
import { calm as calmPre, RATIO_TROUGH, ratioBounce, ratioWave } from "./ladder-replay.test-helpers.js";
import { HALF, openShockStart } from "./ladder-shock.js";
import { SEMIS_RULES } from "./probe-semis-tranches.js";
import { asProbeResult, BOX_SIGNS, escalation, evaluateShipped, FAMS, famNeed, followOf, INDICATOR, LEGS, openExit, replaySpit, SHIPPED_FORM, SPIT_RULES as R, SERIES, tally, VERDICT_IDS, VOTE_FAMILIES, whyFills, type Inputs, type Pt, type Rules, type SeriesSet } from "./probe-spit-tranches.js";
import { VALUE_RULES } from "./probe-value-tranches.js";

const DATES: string[] = [];
const dateAt = (i: number): string => (DATES[i] ??= new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const lin = (n: number, from: number, step: number): number[] => Array.from({ length: n }, (_, i) => from + step * i);
const EMPTY = Object.fromEntries(SERIES.map((id) => [id, []])) as unknown as SeriesSet;
const signRow = (sign: string, block = false, checked: string | null = "2026-10-01"): LadderSign => ({ sign, label: sign, lean: block ? "bear" : "open", finding: "", why: "", measurable: "", block, checked, due: null, primary: [], search: [], seed: [], sources: [] });
const cell = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => FAMS[f].rungs[k].read(R, { s: { ...EMPTY, ...s }, signs: [], ...x });
const rung = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => cell(f, k, s, x).verdict;
const gate = (key: string, s: Partial<SeriesSet>, x: Partial<Inputs> = {}) => LEGS.find((d) => d.key === key)!.read(R, { s: { ...EMPTY, ...s }, signs: [], ...x }).verdict;
const box = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => escalation({ s: { ...EMPTY, ...s }, signs }, R);
/** The tripped Episode gates display rows, in `BOX_SIGNS` order. */
const names = (e: ReturnType<typeof box>) => e.families.filter((f) => f.verdict === "unmet").map((f) => f.name);
const TICK = 1e-4;
const spread = (base: number, last: number) => series([...flat(base, R.ESC_SPREAD_MA_N - 1), last]);
/** Every ruled-box member live and none voting. */
const CALM = { VT: series(flat(0.5, R.ESC_VOL_FLIP_N)), R4: series(flat(2, R.ESC_REAL_DELTA_N + 1)), F1: spread(3, 3), HCX: [{ date: dateAt(0), value: -0.05, state: "AMBER" }] };

describe("roster", () => {
  it("every tranche counts every family but credit, credit a gate at each; gates per plan §3", () => {
    const keys = (t: string, g: boolean) => LEGS.filter((d) => d.tranche === t && (d.gate ?? false) === g).map((d) => d.key.slice(3));
    const gates = ["credit", "g1", "veto", "esc"];
    expect([keys("T1", false), keys("T2", false), keys("T3", false)]).toEqual([[...VOTE_FAMILIES], [...VOTE_FAMILIES], [...VOTE_FAMILIES]]);
    expect([keys("T1", true), keys("T2", true), keys("T3", true)]).toEqual([gates, gates, gates]);
    expect(["CCC"].filter((id) => (SERIES as readonly string[]).includes(id)), "CCC left Spit's inputs (user 2026-10-20)").toEqual([]);
    expect((["T1", "T2", "T3"] as const).map((t) => LEGS.filter((d) => d.tranche === t && d.gate).at(-1)!.leg), "every tranche's gates end on the box").toEqual(["gate: escalation box", "gate: escalation box", "gate: escalation box"]);
  });
  it("credit knobs (`CreditRules`, ladder-credit.ts): Semis · Spit · Value carry one value each — a leg's fork reds here", () => {
    const keys = Object.keys({ BASE_N: 1, SIGMA_N: 1, BROKE_SD: 1, T1_RETRACE: 1, T2_RETRACE: 1, T2_PEAK_AGE_N: 1, T3_RETRACE: 1, ESC_HY_MA_K: 1, ESC_SPREAD_MA_N: 1 } satisfies Record<Exclude<keyof CreditRules, "CREDIT_VEL_HIGH_N">, 1>) as (keyof CreditRules)[];
    const pick = (r: CreditRules) => Object.fromEntries(keys.map((k) => [k, r[k]]));
    expect(Object.values(pick(R)).every(Number.isFinite), "premise: every knob a number on Spit").toBe(true);
    expect({ semis: pick(SEMIS_RULES), value: pick(VALUE_RULES) }).toEqual({ semis: pick(R), value: pick(R) });
  });

  it("R4's Δ120 chart overlay draws THIS leg's real-yield escalation member (src/ can't import scripts/)", () => {
    expect(R4_ESC).toEqual({ window: R.ESC_REAL_DELTA_N, value: R.ESC_REAL_DELTA });
  });
});

describe("tally: needs and gates", () => {
  const raw = (t: "T1" | "T2" | "T3", met: number, n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, tranche: t, gate: false, value: "", verdict: i < met ? ("met" as const) : ("unmet" as const) }));
  const esc0 = box(CALM);
  it("need 1 / 2 / 3 of the four voting families; NEED_SLACK floors it when fewer read", () => {
    expect((["T1", "T2", "T3"] as const).map((t) => famNeed(t, VOTE_FAMILIES.length))).toEqual([1, 2, 3]);
    expect([tally("T3", raw("T3", 0, 2), R, esc0).need, tally("T2", raw("T2", 2, 4), R, esc0).ready, tally("T2", raw("T2", 1, 4), R, esc0).ready, tally("T3", raw("T3", 3, 4), R, esc0).ready, tally("T3", raw("T3", 2, 4), R, esc0).ready]).toEqual([1, true, false, true, false]);
  });
  const rows = (t: "T1" | "T2" | "T3", unmet: readonly string[]) => LEGS.filter((d) => d.tranche === t).map((d) => ({ key: d.key, tranche: t, gate: d.gate ?? false, value: "", verdict: unmet.includes(d.key) ? ("unmet" as const) : ("met" as const) }));
  it("quiet credit casts no T2/T3 vote: its gate reads met on an HY shock closed before the exit, yet T2 still needs 2 / T3 3 of the voting four", () => {
    const hy = series([...lin(80, 0, 1).map((i) => 3 + 0.01 * (i % 2)), 3.5, 4, 3.5, 3, ...lin(400, 0, 1).map((i) => 3 + 0.01 * (i % 2))]);
    const exit = hy[380]!.date;
    expect(["t2-credit", "t3-credit"].map((k) => gate(k, { F1: hy }, { exit })), "premise: quiet HY meets the gate").toEqual(["met", "met"]);
    expect([tally("T2", rows("T2", ["t2-price", "t2-vol", "t2-rates"]), R, esc0).ready, tally("T2", rows("T2", ["t2-price", "t2-vol"]), R, esc0).ready, tally("T3", rows("T3", ["t3-price", "t3-vol"]), R, esc0).ready, tally("T3", rows("T3", ["t3-price"]), R, esc0).ready]).toEqual([false, true, false, true]);
  });
});

describe("family rungs at the cut ± 1", () => {
  const L = 300;
  /** Monotone rising QDVE — every MA test passes; the exit set `n` closes back fixes the no-low run at `n`. */
  const up = series(lin(L, 100, 0.1));
  const back = (n: number) => dateAt(L - 1 - n);
  it("price: no post-exit low ×5 (T1) / ×20 with a rising MA50 (T2) — the cut fires, one fewer does not; a falling QDVE fails T2/T3; no exit n/a", () => {
    expect([rung("PRICE", 0, { LEGP_SPIT: up }, { exit: back(R.T1_NO_LOW_N) }), rung("PRICE", 0, { LEGP_SPIT: up }, { exit: back(R.T1_NO_LOW_N - 1) }), rung("PRICE", 1, { LEGP_SPIT: up }, { exit: back(R.T2_NO_LOW_N) }), rung("PRICE", 1, { LEGP_SPIT: up }, { exit: back(R.T2_NO_LOW_N - 1) })]).toEqual(["met", "unmet", "met", "unmet"]);
    const down = series([...lin(L - 30, 200, -0.1), ...flat(170, 30)]);
    expect([rung("PRICE", 1, { LEGP_SPIT: down }, { exit: back(25) }), rung("PRICE", 2, { LEGP_SPIT: down }), rung("PRICE", 0, { LEGP_SPIT: up })]).toEqual(["unmet", "unmet", "na"]);
  });
  it("price T3: > rising MA50 and > rising MA200 — a rising QDVE passes, a close under its MA50 holds, under 210 closes n/a", () => {
    const dip = series([...lin(L - 1, 100, 0.1), 100 + 0.1 * (L - 30)]);
    expect([rung("PRICE", 2, { LEGP_SPIT: up }), rung("PRICE", 2, { LEGP_SPIT: dip }), rung("PRICE", 2, { LEGP_SPIT: series(lin(R.MA_SLOW_N + R.MA_RISING_N - 1, 100, 0.1)) })]).toEqual(["met", "unmet", "na"]);
  });
  it("price T2/T3: the close, its post-exit low and the MAs print at one width — the widest pair's", () => {
    // T3: MA50 58.00 sits 2 dp off the close 60.604, MA200 60.601 needs 3. T2: the low 58.00 is 2 dp off, MA50 60.601 needs 3.
    const t3 = cell("PRICE", 2, { LEGP_SPIT: series([...flat(61.468, 160), ...flat((2900 - 60.604) / 49, 49), 60.604]) }).value;
    const t2c = series([...flat(58, 20), ...flat((50 * 60.601 - 60.604 - 2 * 58) / 47, 47), 58, 58, 60.604]);
    const t2 = cell("PRICE", 1, { LEGP_SPIT: t2c }, { exit: t2c.at(-3)!.date }).value;
    expect([t3, t2]).toEqual([expect.stringMatching(/^60\.604>MA50 58\.000✓ · .* · >MA200 60\.601✓ · /), expect.stringMatching(/^no low 60\.604\/58\.000 \(\d\d-\d\d\)[✓✗] · >MA50 60\.601✓ · /)]);
  });
  it("vol T1: VIX/VIX3M < 1.0 ×3 — at the cut holds, under 3 closes n/a", () => {
    expect([rung("VOL", 0, { VT: series([1.1, 0.99, 0.99, 0.99]) }), rung("VOL", 0, { VT: series([0.99, R.VT_T1_MAX, 0.99, 0.99]) }), rung("VOL", 0, { VT: series([0.9, 0.9]) })]).toEqual(["met", "unmet", "na"]);
  });
  it("vol T2/T3: no post-exit low ×15 / ×20 and VIX/VIX3M < 0.9 (T3 ×10) — each half one short holds", () => {
    const vt = (v: number, n = 30) => series([...flat(0.8, n - 1), v]);
    const vt10 = (ago: number) => series(Array.from({ length: 30 }, (_, i) => (i === 30 - ago ? R.VT_MAX : 0.8)));
    expect([rung("VOL", 1, { LEGP_SPIT: up, VT: vt(R.VT_MAX - TICK) }, { exit: back(R.VOL_T2_NO_LOW_N) }), rung("VOL", 1, { LEGP_SPIT: up, VT: vt(R.VT_MAX) }, { exit: back(R.VOL_T2_NO_LOW_N) }), rung("VOL", 1, { LEGP_SPIT: up, VT: vt(0.8) }, { exit: back(R.VOL_T2_NO_LOW_N - 1) })]).toEqual(["met", "unmet", "unmet"]);
    const x3 = { exit: back(R.VOL_T3_NO_LOW_N) };
    expect([rung("VOL", 2, { LEGP_SPIT: up, VT: vt10(R.VT_T3_N + 1) }, x3), rung("VOL", 2, { LEGP_SPIT: up, VT: vt10(R.VT_T3_N) }, x3), rung("VOL", 2, { LEGP_SPIT: up, VT: vt10(R.VT_T3_N + 1) }, { exit: back(R.VOL_T3_NO_LOW_N - 1) })]).toEqual(["met", "unmet", "unmet"]);
  });
  it("value cells: a one-run row's count trails (no inline got/need, no own mark), a two-run row counts per part; a derived line prints its source date", () => {
    const vt = series([...flat(0.8, 29), 0.85]);
    expect([cell("PRICE", 0, { LEGP_SPIT: up }, { exit: back(R.T1_NO_LOW_N) }), cell("PRICE", 1, { LEGP_SPIT: up }, { exit: back(R.T2_NO_LOW_N) }), cell("VOL", 0, { VT: series([1.1, 0.99, 0.99, 0.99]) }), cell("VOL", 1, { LEGP_SPIT: up, VT: vt }, { exit: back(R.VOL_T2_NO_LOW_N) }), cell("VOL", 2, { LEGP_SPIT: up, VT: vt }, { exit: back(R.VOL_T3_NO_LOW_N) }), cell("RATES", 0, { R4: series(flat(2, 80)) })]).toEqual([
      { value: "no low 129.90/129.40 (10-22)", verdict: "met", count: { got: 5, need: 5 } },
      { value: "no low 129.90/127.90 (10-07)✓ · >MA50 127.45✓ · MA50 Δ10 1.000>0✓", verdict: "met", count: { got: 20, need: 20 } },
      { value: "0.99<1", verdict: "met", count: { got: 3, need: 3 } },
      { value: "no low 129.90/128.40 (10-12)✓ · VT 0.85<0.9✓", verdict: "met", count: { got: 15, need: 15 } },
      { value: "no low 129.90/127.90 (10-07) 20/20✓ · VT 0.85<0.9 10/10✓", verdict: "met" },
      { value: "Δ63 0.00≤0.25", verdict: "met", count: { got: 5, need: 5 } },
    ]);
    const rs = series([...flat(1, 60), 1.0001]);
    expect([cell("PRICE", 2, { LEGP_SPIT: up }).value, cell("CAPEX", 2, { RS_SMH: rs }).value, cell("CAPEX", 1, { RS_SMH: rs, HCX: [{ date: dateAt(0), value: -0.03, state: "GREEN" }] }).value], "the close prints once; a single-series cell drops the id, a mixed one keeps it").toEqual([
      "129.90>MA50 127.45✓ · MA50 Δ10 1.000>0✓ · >MA200 119.95✓ · MA200 Δ10 1.000>0✓",
      "1.0001>MA50 1.0000✓",
      "HCX GREEN✓ · RS_SMH 1.0001>MA10 1.0000✓ · Δ10 0.0001>0✓",
    ]);
  });
  it("rates T1: DFII10 Δ63 ≤ +25bp ×5 — a breach 5 closes back passes, 4 back holds, at the cut passes; short history n/a", () => {
    const r4 = (ago: number, v = 2.3) => series(Array.from({ length: 80 }, (_, i) => (i === 80 - ago ? v : 2)));
    expect([rung("RATES", 0, { R4: r4(R.R4_QUIET_N + 1) }), rung("RATES", 0, { R4: r4(R.R4_QUIET_N) }), rung("RATES", 0, { R4: r4(1, 2 + R.R4_D_MAX) }), rung("RATES", 0, { R4: series(flat(2, R.R4_DELTA_N + R.R4_QUIET_N - 1)) })]).toEqual(["met", "unmet", "met", "na"]);
  });
  it("rates T2/T3: 10y z(Δ20) < 1 ×5 — a falling 10y passes, a final spike holds; T3 also needs the DFII10 rung", () => {
    const tenY = lin(300, 0, 1).map((i) => 2 + 0.5 * Math.sin(i / 20));
    const spike = series([...tenY.slice(0, -1), tenY.at(-21)! + 1]);
    expect([rung("RATES", 1, { R2: series(tenY) }), rung("RATES", 1, { R2: spike }), rung("RATES", 1, { R2: series(tenY.slice(0, 20)) })]).toEqual(["met", "unmet", "na"]);
    expect([rung("RATES", 2, { R2: series(tenY), R4: series(flat(2, 80)) }), rung("RATES", 2, { R2: series(tenY), R4: series([...flat(2, 79), 2.3]) }), rung("RATES", 2, { R2: spike, R4: series(flat(2, 80)) })]).toEqual(["met", "unmet", "unmet"]);
  });
  it("AI-capex: T1 SEC0 off its 60-close high > −10% · T2 HCX ≠ RED with RS_SMH > rising MA10 · T3 RS_SMH > MA50", () => {
    expect([rung("CAPEX", 0, { LEGP_SEMIS: series([...flat(100, 30), 90 + TICK]) }), rung("CAPEX", 0, { LEGP_SEMIS: series([...flat(100, 30), 90]) }), rung("CAPEX", 0, {})]).toEqual(["met", "unmet", "na"]);
    const hcx = (state: string | null) => [{ date: dateAt(0), value: -0.03, state }];
    const rs = series([...flat(1, 20), 1 + TICK]);
    expect([rung("CAPEX", 1, { HCX: hcx("GREEN"), RS_SMH: rs }), rung("CAPEX", 1, { HCX: hcx("RED"), RS_SMH: rs }), rung("CAPEX", 1, { HCX: hcx("GREEN"), RS_SMH: series(flat(1, 21)) }), rung("CAPEX", 1, { HCX: hcx(null), RS_SMH: rs })]).toEqual(["met", "unmet", "unmet", "na"]);
    expect([rung("CAPEX", 2, { RS_SMH: series([...flat(1, 60), 1 + TICK]) }), rung("CAPEX", 2, { RS_SMH: series(flat(1, 61)) }), rung("CAPEX", 2, { RS_SMH: series(flat(1, R.RS_SLOW_N - 1)) })]).toEqual(["met", "unmet", "na"]);
  });
});

describe("gates", () => {
  it("G1 deep bear: holds only while QDVE < 85% of its 252-close high AND < MA200; under 252 closes n/a", () => {
    const fromTop = (v: number) => series([...flat(100, 260), v]);
    const climb = (v: number) => series([...lin(251, 40, 0.24), v]);
    expect([gate("t1-g1", { LEGP_SPIT: fromTop(85 - TICK) }), gate("t2-g1", { LEGP_SPIT: fromTop(85) }), gate("t3-g1", { LEGP_SPIT: climb(85 - TICK) }), gate("t1-g1", { LEGP_SPIT: series(flat(100, R.G1_HIGH_N - 1)) })]).toEqual(["unmet", "met", "met", "na"]);
    expect(LEGS.find((d) => d.key === "t1-g1")!.leg, "the gate names the series it reads").toContain(INDICATOR.LEGP_SPIT);
  });
  it("veto: a QDVE daily drop past 3σ inside the last 5 holds every tranche; a milder one passes; short history n/a", () => {
    const px = (r: number) => series([...lin(70, 0, 1).map((i) => 100 + (i % 2)), 100 * Math.exp(r)]);
    expect([gate("t1-veto", { LEGP_SPIT: px(-0.05) }), gate("t3-veto", { LEGP_SPIT: px(-0.02) }), gate("t2-veto", { LEGP_SPIT: series(flat(100, 60)) })]).toEqual(["unmet", "met", "na"]);
  });
});

describe("Episode gates display rows (BOX_SIGNS)", () => {
  it("earnings: RS_XLK new 60-close low trips · yen: USD/JPY ≥ 3% off its 60-close high trips — inclusive, as the rule's `≤ −3%` prints", () => {
    expect([names(box({ RS_XLK: series([...flat(1, 60), 1 - TICK]) })), names(box({ RS_XLK: series(flat(1, 61)) }))]).toEqual([["earnings"], []]);
    const yen = (last: number) => names(box({ F17: series([...flat(150, 59), last]) }));
    expect([yen(150 * (1 - R.ESC_JPY_DROP) - TICK), yen(150 * (1 - R.ESC_JPY_DROP)), yen(150 * (1 - R.ESC_JPY_DROP) + TICK)], "exactly −ESC_JPY_DROP trips (the rule prints ≤)").toEqual([["yen"], ["yen"], []]);
  });
  it("manual halves: a mapped row's block trips its row, a member's row (hyper_capex) trips no family; antitrust (context only) and an unknown id throw on a block", () => {
    expect(names(box({}, [signRow("hyper_capex", true), signRow("semi_policy", true), signRow("crowding", true)]))).toEqual(["yen", "policy"]);
    expect(() => box({}, [signRow("antitrust", true)])).toThrow(/"antitrust" is context only/);
    expect(() => box({}, [signRow("not_a_sign", true)])).toThrow(/not a known sign id/);
  });
  it("no close and no row is unread, never tripped; an unchecked row is unread (named), a checked clear one is read", () => {
    expect(box({})).toMatchObject({ unread: ["earnings (it_revisions, aapl_demand)", "yen (jpy_carry, crowding)", "policy (semi_policy)"] });
    expect([box({}, [signRow("semi_policy", false, null)]).unread.includes("policy (semi_policy)"), box({}, [signRow("semi_policy")]).unread.some((u) => u.startsWith("policy")), names(box({}, [signRow("semi_policy", true, null)]))]).toEqual([true, false, ["policy"]]);
  });
  it("families: one row per BOX_SIGNS entry in order — a tripped close reads ✗ with its value, a block forces ✗ whatever the close, a blind close reads n/a, policy reads off its signs alone; no live box, so live repeats the close", () => {
    const fams = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => Object.fromEntries(box(s, signs).families.map((f) => [f.name, f])) as Record<(typeof BOX_SIGNS)[number], LadderFamily>;
    const calm = fams({ RS_XLK: series(flat(1, 61)), F17: series(flat(150, 60)) }, [signRow("semi_policy"), signRow("rates")]);
    expect(Object.keys(calm)).toEqual([...BOX_SIGNS]);
    expect([calm.earnings.value, calm.yen.value, calm.policy.value, calm.policy.verdict, calm.policy.signs.map((g) => g.sign)]).toEqual(["RS_XLK 1.0000/1.0000", "JPY +0.0%/-3.0%", "—", "met", ["semi_policy"]]);
    for (const f of Object.values(calm)) expect(f.live, `${f.name}: no live box → the close cell repeats`).toEqual({ value: f.value, verdict: f.verdict });
    expect("near" in calm.yen).toBe(false);
    const blocked = fams({ RS_XLK: series(flat(1, 61)) }, [signRow("aapl_demand", true), signRow("jpy_carry", true)]);
    expect([blocked.earnings, blocked.yen]).toMatchObject([{ value: "RS_XLK 1.0000/1.0000", verdict: "unmet", signs: expect.arrayContaining([{ sign: "aapl_demand", lean: "bear", block: true }]) }, { value: "n/a", verdict: "unmet" }]);
    expect(fams({}).yen, "blind with no sign row").toMatchObject({ value: "n/a", verdict: "na", signs: [] });
  });
  it("a dropped row's signs ride its cluster member: rates → real_yield, credit · ai_funding → credit_confirms, hyper_capex → hcx_red; a memberless sign stays off", () => {
    const signsOf = (e: ReturnType<typeof box>) => Object.fromEntries(e.clusters.flatMap((c) => c.members).map((m) => [m.id, (m.signs ?? []).map((g) => g.sign)]));
    expect(signsOf(box({}, [signRow("rates"), signRow("credit"), signRow("ai_funding"), signRow("hyper_capex", true), signRow("crowding")]))).toEqual({ real_yield: ["rates"], credit_confirms: ["credit", "ai_funding"], hcx_red: ["hyper_capex"], vol_flip: [] });
  });
});

describe("clustered box (CLUSTERS · VETO_ROWS)", () => {
  const ruled = box;
  const raw = (t: "T1" | "T2" | "T3") => LEGS.filter((d) => d.tranche === t).map((d) => ({ key: d.key, tranche: t, gate: d.gate ?? false, value: "", verdict: "met" as const }));
  /** Per tranche: [`tally` held with every row met, its esc gate row unmet] off the ruled box. */
  const holds = (s: Partial<SeriesSet>, signs: LadderSign[] = []) => ((x) => (["T1", "T2", "T3"] as const).map((t) => [!tally(t, raw(t), R, escalation(x, R)).clear, LEGS.find((d) => d.key === `${t.toLowerCase()}-esc`)!.read(R, x).verdict === "unmet"]))({ s: { ...EMPTY, ...s }, signs });
  const [NONE, ALL] = [[[false, false], [false, false], [false, false]], [[true, true], [true, true], [true, true]]];
  const calm = CALM;
  const credit = { F1: spread(3, 4) };
  const rates = { R4: series([...flat(2, R.ESC_REAL_DELTA_N), 2 + R.ESC_REAL_DELTA]) };
  it("credit + rates-shock votes hold every tranche; tripped/hits = the voting clusters, need 2; the gate row prints votes · live/n vs quorum", () => {
    const s = { ...calm, ...credit, ...rates };
    expect([ruled(s).clusters.filter((c) => c.vote).map((c) => c.name), ruled(s)]).toMatchObject([["rates-shock", "credit"], { tripped: 2, need: 2, hits: ["rates-shock", "credit"], hold: true, veto: [], quorum: { live: 4, n: 4, t1Only: false } }]);
    expect([holds(calm), holds(s)]).toEqual([NONE, ALL]);
    expect(LEGS.find((d) => d.key === "t2-esc")!.read(R, { s: { ...EMPTY, ...s }, signs: [signRow("it_revisions", true)] }).value).toBe("votes rates-shock, credit · veto it_revisions · live 4/4 need 3");
  });
  it("demoted sign rows cast no vote: RS_XLK (earnings) and yen tripped beside credit, plus aapl_demand / crowding blocks, hold nothing", () => {
    const demoted = { ...calm, ...credit, RS_XLK: series([...flat(1, R.ESC_RS_LOW_N), 1 - TICK]), F17: series([...flat(150, R.ESC_JPY_N - 1), 150 * (1 - R.ESC_JPY_DROP) - TICK]) };
    const rows = [signRow("aapl_demand", true), signRow("crowding", true)];
    expect(names(box(demoted, rows)), "premise: their display rows trip").toEqual(["earnings", "yen"]);
    expect([ruled(demoted, rows).clusters.filter((c) => c.vote).map((c) => c.name), ruled(demoted, rows).hold, holds(demoted, rows)]).toEqual([["credit"], false, NONE]);
  });
  it("a veto-row block (hyper_capex · it_revisions · ai_funding · semi_policy) holds T2·T3 alone with zero votes, T1 not", () => {
    const T2T3 = [[false, false], [true, true], [true, true]];
    for (const id of ["hyper_capex", "it_revisions", "ai_funding", "semi_policy"]) expect([ruled(calm, [signRow(id, true)]), holds(calm, [signRow(id, true)])], id).toMatchObject([{ hold: false, holdT2T3: true, veto: [id], clusters: ruled(calm).clusters }, T2T3]);
  });
  it("a hyper_capex block holds all three once hcx_red (HCX, its measured half) trips; ai_funding (unmapped) stays T2·T3 beside a tripped credit_confirms, it_revisions beside a tripped hcx_red", () => {
    const T2T3 = [[false, false], [true, true], [true, true]];
    const hcxRed = { ...calm, HCX: [{ ...calm.HCX[0]!, state: "RED" }] };
    const cr = { ...calm, ...credit };
    expect([ruled(hcxRed).hits, holds(hcxRed), ruled(cr).hits, holds(cr)], "premise: each trip is a vote alone — no hold").toEqual([["cycle"], NONE, ["credit"], NONE]);
    expect([holds(hcxRed, [signRow("hyper_capex", true)]), holds(hcxRed, [signRow("it_revisions", true)]), holds(cr, [signRow("ai_funding", true)])]).toEqual([ALL, T2T3, T2T3]);
  });
  it("below quorum (short history reads na) holds T2/T3 and leaves T1 to the box's hold; the same members before their first point (none) leave the denominator", () => {
    const short = { VT: calm.VT, HCX: calm.HCX, R4: series(flat(2, R.ESC_REAL_DELTA_N)), F1: series(flat(3, R.ESC_SPREAD_MA_N - 1)) };
    expect([ruled(short), holds(short)]).toMatchObject([{ hold: false, quorum: { live: 2, n: 4, t1Only: true } }, [[false, false], [true, true], [true, true]]]);
    const pre = { VT: calm.VT, HCX: calm.HCX };
    expect([ruled(pre), holds(pre)]).toMatchObject([{ hold: false, quorum: { live: 2, n: 2, t1Only: false } }, NONE]);
  });
  it("each member carries its trips-when rule and the read its cell judged: hit, false, short (na) and pre-history (none)", () => {
    const cut = Math.round(R.ESC_REAL_DELTA * 100);
    const hyRead = (base: number, last: number) => ((m) => `HY ${last.toFixed(2)}/${(R.ESC_HY_MA_K * m).toFixed(2)} (MA${R.ESC_SPREAD_MA_N} ${m.toFixed(2)})`)((base * (R.ESC_SPREAD_MA_N - 1) + last) / R.ESC_SPREAD_MA_N);
    const rows = (s: Partial<SeriesSet>) => Object.fromEntries(ruled(s).clusters.flatMap((c) => c.members.map((m) => [m.id, [m.cell, m.rule, m.value]])));
    const credit = [`HY ≥ ${R.ESC_HY_MA_K}× its MA${R.ESC_SPREAD_MA_N}`];
    expect(rows({ ...calm, F1: spread(3, 4), R4: series([...flat(2, R.ESC_REAL_DELTA_N), 2 + (cut + 7) / 100]) })).toEqual({
      real_yield: ["hit", `10y RY Δ${R.ESC_REAL_DELTA_N} ≥ +${cut}bp`, `+${cut + 7}bp/+${cut}bp`],
      credit_confirms: ["hit", ...credit, hyRead(3, 4)],
      hcx_red: [false, "HCX RED", "HCX AMBER"],
      vol_flip: [false, `VIX/VIX3M ≥ ${R.ESC_VT} ×${R.ESC_VOL_FLIP_N}`, `VT 0.50 (≥${R.ESC_VT} 0/${R.ESC_VOL_FLIP_N})`],
    });
    expect(rows({ VT: calm.VT, R4: series(flat(2, R.ESC_REAL_DELTA_N)) })).toMatchObject({ real_yield: ["na", expect.any(String), `short of ${R.ESC_REAL_DELTA_N + 1} closes`], credit_confirms: ["none", ...credit, "HY no history"], hcx_red: ["none", "HCX RED", "no history"] });
  });
});

describe("follow path over the open QDVE exit", () => {
  const PRE = 260;
  /** HY alternating 3.00/3.01: σ > 0, so a rise past base + BROKE_SD σ opens its shock. */
  const hyCalm = (n: number): number[] => lin(n, 0, 1).map((i) => 3 + 0.01 * (i % 2));
  /** QDVE calm at 100 (σ > 0, so an exit can open), a −6% exit at PRE then a slow slide (a new low every close: price never meets); HY calm save one shock closed long before the exit (credit gate met); R4 rising +0.5bp/close and an accelerating 10y keep rates unmet. */
  const followSet = (len: number): SeriesSet => ({
    ...EMPTY,
    LEGP_SPIT: series([...calmPre(PRE), ...lin(len - PRE, 94, -0.01)]),
    F1: series([...hyCalm(80), 3.5, 4, 3.5, 3, ...hyCalm(len - 84)]),
    R4: series(lin(len, 1, 0.005)),
    R2: series(lin(len, 0, 1).map((i) => 2 + 1e-5 * i * i)),
  });
  const t = (s: SeriesSet, k: number, signs: LadderSign[] = []) => evaluateShipped(s, signs, R).tranches[k]!;
  it("T1 fires on the time stop TIME_STOP_N closes after the exit, not one fewer", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    expect(openExit(s)).toBe(dateAt(PRE));
    expect(t(s, 0)).toMatchObject({ met: true, ready: false, via: "time stop", since: dateAt(PRE + R.TIME_STOP_N) });
    expect([evaluateShipped(s, [], R).sessionsSinceExit, t(followSet(PRE + R.TIME_STOP_N), 0).met]).toEqual([R.TIME_STOP_N, false]);
  });
  it("T2 follows T2_AFTER_N closes after T1's fill, not one fewer; no open exit, no follow", () => {
    const end = PRE + R.TIME_STOP_N + R.T2_AFTER_N + 1;
    expect(t(followSet(end), 1)).toMatchObject({ met: true, via: "after T1", since: dateAt(end - 1) });
    expect(t(followSet(end - 1), 1).met).toBe(false);
    const still = { ...followSet(end), LEGP_SPIT: series(calmPre(end)) };
    expect([followOf(still, [], R), "sessionsSinceExit" in evaluateShipped(still, [], R)]).toEqual([null, false]);
  });
  it("a latched fill survives a run whose box would block it (a hyper_capex block with HCX RED, its measured half, reaches T1)", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    const hot = { ...s, HCX: [{ date: dateAt(0), value: -0.05, state: "RED" }] };
    const fill = dateAt(PRE + R.TIME_STOP_N);
    const block = [signRow("hyper_capex", true), signRow("semi_policy", true)];
    const prior = toVerdict(asProbeResult(evaluateShipped(s, [], R)), false);
    expect([followOf(s, block, R)?.fills[0], followOf(hot, [], R)?.fills[0]], "premise: HCX calm the block leaves T1; HCX RED alone holds nothing").toEqual([fill, fill]);
    expect([followOf(hot, block, R)?.fills[0], followOf(hot, block, R, [fill, null, null])?.fills[0]]).toEqual([null, fill]);
    expect(evaluateShipped(hot, block, R, prior).tranches[0]).toMatchObject({ met: false, since: fill, fill: true });
  });
  it("events hold T2/T3 only: a pending T2/T3 event leaves T1's time stop alone; every one landed fizzle by T1's fill close → T2 fills that close", () => {
    const t1 = PRE + R.TIME_STOP_N;
    const s = followSet(t1 + 1);
    const ev = (d: number, status: string): LadderEvent => ({ date: dateAt(d), event: `e${d}`, signs: [], escalationIf: "", fizzleIf: "", holds: ["T2", "T3"], secondary: false, status });
    expect([followOf(s, [], R, [], [ev(PRE + 2, "fizzle: x (src)"), ev(t1, "fizzle: y (src)")])?.fills, followOf(s, [], R, [], [ev(PRE + 2, "fizzle: x (src)"), ev(t1 + 3, "NOT DUE until later")])?.fills]).toEqual([[dateAt(t1), dateAt(t1), null], [dateAt(t1), null, null]]);
  });
  it("replaySpit: the newest replay episode on an open fixture is openExit's exit, ending on the last close; a time-stop-only fixture fills T1 exactly TIME_STOP_N closes after the exit, not one fewer", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    expect(replaySpit(s).at(-1)).toMatchObject({ exit: openExit(s), end: dateAt(PRE + R.TIME_STOP_N), fills: [dateAt(PRE + R.TIME_STOP_N), null, null] });
    expect(replaySpit(followSet(PRE + R.TIME_STOP_N)).map((e) => e.fills)).toEqual([[null, null, null]]);
  });
  it("the box reaches replaySpit / followOf / evaluateShipped → firesAt: a hot VT beside DFII10's rise (equity-vol + rates-shock) holds the T1 time-stop fill", () => {
    const len = PRE + R.TIME_STOP_N + 1;
    const s = { ...followSet(len), VT: series(flat(1.1, len)), R4: series(lin(len, 1, 0.0075)) };
    expect([replaySpit(s).at(-1)!.fills, followOf(s, [], R)!.fills, t(s, 0).met]).toEqual([[null, null, null], [null, null, null], false]);
  });
  it("binding closes: the box holding the T1 time-stop close counts it once; the same close with the credit gate unreadable (BASE_N past the history: no HY shock) counts none", () => {
    const len = PRE + R.TIME_STOP_N + 1;
    const s = { ...followSet(len), VT: series(flat(1.1, len)), R4: series(lin(len, 1, 0.0075)) };
    const bound = (r: Rules) => replaySpit(s, REPLAY, { r, defs: LEGS }).at(-1)!.binding;
    expect([bound(R), bound({ ...R, BASE_N: len })]).toEqual([[dateAt(PRE + R.TIME_STOP_N)], []]);
  });
  it("replaySpit: a fixture whose gates never clear (no HY → the credit gate n/a) fills nothing (no time stop through an unmet gate)", () => {
    expect(replaySpit({ ...followSet(PRE + 3 * R.TIME_STOP_N), F1: [] }).map((e) => e.fills)).toEqual([[null, null, null]]);
  });
  it("credit gates T2/T3 on the follow path: HY 40% back from its post-exit peak fills T1 only, 60% back adds T2, 70% back adds T3", () => {
    const len = PRE + R.TIME_STOP_N + R.T2_AFTER_N + R.T3_AFTER_N + 1;
    const hy = (hold: number) => ({ ...followSet(len), F1: series([...hyCalm(PRE + 1), 3.2, 3.4, 3.6, 3.8, 4, ...flat(hold, len - PRE - 6)]) });
    const [t1, t2, t3] = [PRE + R.TIME_STOP_N, PRE + R.TIME_STOP_N + R.T2_AFTER_N, len - 1].map(dateAt);
    expect([3.6, 3.4, 3.3].map((v) => followOf(hy(v), [], R)!.fills)).toEqual([[t1, null, null], [t1, t2, null], [t1, t2, t3]]);
  });
  it("whyFills: one row per replaySpit fill (exit · tranche · date), each routed by the follow path firesFrom took — time stop / after T1 / after T2", () => {
    const len = PRE + R.TIME_STOP_N + R.T2_AFTER_N + R.T3_AFTER_N + 1;
    const s = { ...followSet(len), F1: series([...hyCalm(PRE + 1), 3.2, 3.4, 3.6, 3.8, 4, ...flat(3.3, len - PRE - 6)]) };
    const fills = replaySpit(s).flatMap((e) => e.fills.flatMap((d, i) => (d === null ? [] : [[e.exit, `T${i + 1}`, d]])));
    expect(fills.length, "premise: the fixture fills all three tranches").toBe(3);
    expect(whyFills(s).map((w) => [w.exit, w.tranche, w.date])).toEqual(fills);
    expect(whyFills(s).map((w) => [w.via, w.rows.map((r) => r.key).includes("credit")])).toEqual([["time stop", true], ["after T1", true], ["after T2", true]]);
  });
  it("--replay: an RS_XLK history short of MIN_COVER × QDVE's in-window closes reads THIN naming RS_XLK; the same fixture with RS_XLK full names nothing short", () => {
    const len = PRE + R.TIME_STOP_N + 1;
    const base = followSet(len);
    const full = Object.fromEntries(SERIES.map((id) => [id, base[id].length ? base[id] : series(flat(1, len))])) as SeriesSet;
    const ids = [...new Set(["LEGP_SPIT", ...VERDICT_IDS])];
    const cov = (s: SeriesSet) => coverageOf(s, ids, "LEGP_SPIT", dateAt(0), dateAt(len - 1));
    const short = { ...full, RS_XLK: full.RS_XLK.slice(0, Math.ceil(HOLDOUT_WINDOW.MIN_COVER * len) - 1) };
    const rows = replaySpit(short);
    expect(rows.length, "the fixture replays its one exit").toBe(1);
    expect([cov(short).short, acceptance(holdoutVerdict(rows), cov(short).short)]).toEqual([["RS_XLK"], "THIN"]);
    expect(cov(full).short).toEqual([]);
  });
  it("fill drift: a candidate whose box holds every close (DFII10 Δ and HY/MA cuts at 0 → rates-shock + credit vote) loses T1's time-stop fill → a mismatch, never a Δ", () => {
    const s = followSet(PRE + R.TIME_STOP_N + 1);
    const rows = replaySpit(s, REPLAY, SHIPPED_FORM);
    const boxed: ReplayRun = (k) => replaySpit(s, k, { r: { ...R, ESC_REAL_DELTA: 0, ESC_HY_MA_K: 0 }, defs: LEGS });
    expect(rows.map((e) => e.fills).flat().some((f) => f !== null), "premise: the shipped form fills on the fixture, so a held box can mismatch").toBe(true);
    expect(driftSummary(fillDrift(s.LEGP_SPIT, () => rows, boxed, REPLAY)).mismatches).toBeGreaterThanOrEqual(1);
  });
});

describe("capex SEC0 off-high anchors on the open SEC0 episode's shockStart", () => {
  it("open → off the shockStart close, where the SEMIS_HIGH_N-close high reads 0%; closed → the SEMIS_HIGH_N-close read", () => {
    const low = 100 * (1 - 1.5 * R.SEMIS_OFF_MAX);
    const open = [...calmPre(), ...flat(low, R.SEMIS_HIGH_N + 1)];
    const { rise } = episodes(series(open), { ...REPLAY, FROM: "" }).at(-1)!;
    const closed = [...open, low * (1 + rise)];
    const sec0 = (vals: number[]) => FAMS.CAPEX.rungs[0].read(R, { s: { ...EMPTY, LEGP_SEMIS: series(vals) }, signs: [] });
    expect([openShockStart(series(open)), openShockStart(series(closed))], "premise").toEqual([dateAt(REPLAY.VOL_N), null]);
    expect([sec0(open).verdict, sec0(open).value.startsWith(`${((low / 100 - 1) * 100).toFixed(1)}%`), sec0(open.slice(-R.SEMIS_HIGH_N)).verdict]).toEqual(["unmet", true, "met"]);
    expect([sec0(closed), sec0(closed).verdict]).toEqual([sec0(closed.slice(-R.SEMIS_HIGH_N)), "met"]);
  });
});

describe("hybrid guards at each Spit site — wave 2 against the HALF line since the series' own shock", () => {
  const [ON, OFF] = [{ ...R, HYBRID_GUARDS: true }, { ...R, HYBRID_GUARDS: false }];
  // the rolling read (flag off) on the short close: the hold / bounces fill the whole lookback, so wave 2 short of the line is still a new extreme there

  it("escalation earnings (RS_XLK own episode): a tick above the line stays clear, a tick under trips; flag off → under the ESC_RS_LOW_N-close low trips the short close", () => {
    /** ratioWave: calm to 100, the trough RATIO_TROUGH, ×ESC_RS_LOW_N bounces (the turn), then wave 2's one close — its line ½ down from the bounce to the trough. */
    const line = ratioBounce() + HALF * (RATIO_TROUGH - ratioBounce());
    const at = (last: number, r: typeof ON | typeof OFF) => names(escalation({ s: { ...EMPTY, RS_XLK: series(ratioWave(R.ESC_RS_LOW_N, [last])) }, signs: [] }, r)).includes("earnings");
    expect([at(line + TICK, ON), at(line - TICK, ON), at(line + TICK, OFF)]).toEqual([false, true, true]);
  });
});

describe("the --into verdict — licensed index levels are not published", () => {
  it("toVerdict leaves no observed licensed level in any string the fixture's raw reads quote", () => {
    const raw = asProbeResult(evaluateShipped({ ...EMPTY, ...CALM }, [], R));
    expect(findLicensedLevelsInLeg(raw).length, "premise: the raw reads quote licensed levels").toBeGreaterThan(0);
    expect(findLicensedLevelsInLeg(toVerdict(raw, false))).toEqual([]);
  });
});
