import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLUSTERS, ESC_FAMILIES, FAMILY_SIGN, type SignLite } from "./probe-eufin-tranches.js";
import { driftSummary, fillDrift, fillDrops, holdoutVerdict, REPLAY, replayTotals, sigmaAt, stopRow, sweepTable, type EpisodeResult, type ReplayKnobs } from "./ladder-replay.js";
import { calm, RATIO_TROUGH, ratioBounce, ratioWave } from "./ladder-replay.test-helpers.js";
import { ARM, armReplay, both, boxHolds, closes, escalation, VETO_ROWS, FAST_LEGS_AT1, held, nest, orderReplay, seriesPoints, judge, realizedVol, SHIPPED_ARM, switchLit, SWITCHES, whyFills, type Arm, type Extra, type LegDef, type Rules } from "./probe-eufin-tranches.js";
import { BOX_KERNEL } from "../src/ladder-box.js";
import { toVerdict, type ReadTag } from "../src/ladder-live.js";
import { evaluate, evaluateShipped, FAST_LEGS, FAST_RULES as P, gateSeries, LEGS, liveLimit, liveSet, replay, replayFills, TRANCHE_RULES as R, type Pt, type Res, type SeriesSet, type TrancheResult } from "./probe-eufin-tranches.js";
import { HALF, openShockStart, peakSince, shockOf } from "./ladder-shock.js";
import { probeTrancheCell } from "../src/ladder-live.js";

const PRE = R.SIGMA_N + 10;
const POST = 40;
/** The fixtures' shock day: the first post-noise close (index PRE) — each series' detected anchor (`shockOf`) is its lowest close before the crossing, PRE − 2. */
const SHOCK = "2026-09-15";
const t0 = Date.parse(`${SHOCK}T00:00:00Z`) - PRE * 86_400_000;
const dayIso = (i: number): string => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
/** Every index the fixtures reach — back over the box member's lead-in, forward past the fixture — built once; an index outside falls back to `dayIso`. */
const LEAD = R.ESC_AT1_LOW_N + R.ESC_AT1_LOW_IN;
const DAYS = Array.from({ length: LEAD + PRE + POST + 100 }, (_, j) => dayIso(j - LEAD));
const dateAt = (i: number): string => DAYS[i + LEAD] ?? dayIso(i);
/** `evaluate(MET)` / `evaluateShipped(MET)`, built once on first use — read-only: no test writes into either result. */
let metEval: ReturnType<typeof evaluate> | undefined;
let metShipped: ReturnType<typeof evaluateShipped> | undefined;
const evalMET = (): ReturnType<typeof evaluate> => (metEval ??= evaluate(MET));
const shippedMET = (): ReturnType<typeof evaluateShipped> => (metShipped ??= evaluateShipped(MET));

/** Calendar days ending PRE days after t0 = SHOCK; a number is a final close, a Pt overrides the generated row. */
function series(vals: (number | Partial<Pt>)[], decision: number | null = null): Pt[] {
  return vals.map((v, i) => (typeof v === "number" ? { date: dateAt(i), value: v, decision } : { date: dateAt(i), value: 1, decision, ...v }));
}
const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const ramp = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
/** Pre-shock noise ±amp around `base` — σ > 0, so the veto cap and the broke test are live. */
const noise = (base: number, amp: number): number[] => Array.from({ length: PRE }, (_, i) => base + (i % 2 ? amp : -amp));
/** Spike to `peak` on the shock's first day, then fall to `to` over `fall` closes and hold. */
const shock = (base: number, amp: number, peak: number, to: number, fall = 10): number[] => [
  ...noise(base, amp),
  ...ramp(peak, to, fall),
  ...rep(to, POST - fall),
];

const MET: SeriesSet = {
  /** Rising: never at a low, so its box member reads no hit at any window. */
  AT1: series(ramp(1, 2, PRE + POST), 0.01),
  EXSH_GATE: series(ramp(20, 31, PRE + POST), 0.05),
};
const UNMET: SeriesSet = {
  /** Falling: every close is a new low, so the AT1 gate never clears. */
  AT1: series(ramp(1, 0.5, PRE + POST), -0.01),
  /** Falling, with ±2% post-shock swings: realized vol runs hot against the calm pre-shock base, and the last close is a new low. */
  EXSH_GATE: series(ramp(31, 20, PRE + POST).map((x, i) => (i < PRE ? x : x * (1 + (i % 2 ? -0.02 : 0.02)))), -0.05),
};
/** MET with EXSH as a drift-free 100/101 calm run of REPLAY.VOL_N + PRE closes (enough to host an episode, `volOf`'s anchor), its last high at PRE − 1, then `lo`/`hi` swings under that high: the drawdown opens on the first `lo` and stays open. */
const volEx = (lo: number, hi: number): SeriesSet => ({ ...MET, EXSH_GATE: Array.from({ length: REPLAY.VOL_N + PRE + POST }, (_, k) => ((j) => ({ date: dateAt(j), value: j >= PRE ? (j % 2 ? hi : lo) : j % 2 ? 101 : 100, decision: 0.05 }))(k - REPLAY.VOL_N)) });
const FAKE_TAG: ReadTag = { indicator: "EXSH", series: ["EXSH_GATE"], job: "level", agg: "kOfN" };
/** One leg's closes reading + `live` reading, as `evaluate().legs` reports it, without the ladder walk. */
const readLeg = (s: SeriesSet, key: string, r: Rules, defs: LegDef[]) => ((d: LegDef) => ({ ...d.read(r, s), live: d.read(r, liveSet(s)) }))(defs.find((d) => d.key === key)!);
const leg = (s: SeriesSet, key: string, r: Rules = R) => readLeg(s, key, r, LEGS);
/** The box member live from its second close and not voting (MET's rising AT1 never sits at its 2-close low): the box holds nothing. */
const QUIET: Partial<Rules> = { ESC_AT1_LOW_N: 2, ESC_AT1_LOW_IN: 1 };
/** The same with the member hitting (AT1's 1-close low = its own close): a coincident vote alone, which holds nothing. */
const LOUD: Partial<Rules> = { ...QUIET, ESC_AT1_LOW_N: 1 };
/** The member never reading (a window no history fills ⇒ `na`): the box below quorum holds T2/T3, never T1. */
const THIN: Partial<Rules> = { ESC_AT1_LOW_N: 1e9 };
const sign = (s: string, block = false): SignLite => ({ sign: s, lean: "open", block });
/** A core-driver block: the box holds every tranche on it alone. */
const VETO = sign(VETO_ROWS[0], true);
/** UNMET's expected verdict per leg: the box row stays met (a lone coincident AT1 vote holds nothing); the vol family reads n/a (no open EXSH drawdown on a fixture this short). */
const unmetVerdict = (key: string): string => (key.endsWith("-esc") ? "met" : key.endsWith("-vol") ? "na" : "unmet");

describe("evaluate — every leg has a passing and a failing fixture", () => {
  it("MET meets every leg and the first two tranches; strict T3 has no criterion leg", () => {
    const res = evalMET();
    for (const l of res.legs) expect(`${l.key}: ${l.verdict}`).toMatch(/: met$/);
    // strict T3 is gates only (trend · AT1 guard · box): no criterion leg, so its need (floor 1) is never met on legs — it fills only on T3_AFTER_N
    expect(res.tranches.map((t) => [t.total, t.met])).toEqual([[1, true], [1, true], [0, false]]);
  });
  it("UNMET fails every leg but the box row, and every tranche", () => {
    const res = evaluate(UNMET);
    expect(res.legs.map((l) => `${l.key}: ${l.verdict}`)).toEqual(res.legs.map((l) => `${l.key}: ${unmetVerdict(l.key)}`));
    expect(res.tranches.map((t) => t.met)).toEqual([false, false, false]);
  });
});

describe("the strict set carries the shared gate roster on its later tranches", () => {
  it("with no AT1 closes the AT1 guards read n/a and pass; the box, its one member absent (t1Only), is what holds T2/T3", () => {
    const noAt1 = { ...MET, AT1: [] };
    expect(["t2-at1-guard", "t3-at1-guard"].map((k) => leg(noAt1, k).verdict)).toEqual(["na", "na"]);
    expect(["t1-esc", "t2-esc", "t3-esc"].map((k) => leg(noAt1, k).verdict)).toEqual(["met", "unmet", "unmet"]);
    expect(evaluate(noAt1).tranches.map((t) => t.ready)).toEqual([true, false, false]);
    // the same set with the box rows dropped: nothing else holds T2 (strict T3 never readies on legs: no criterion leg)
    expect(evaluate(noAt1, R, LEGS.filter((d) => !d.key.endsWith("-esc"))).tranches.map((t) => t.ready).slice(0, 2)).toEqual([true, true]);
  });
  it("strict t2-price reads EXSH alone — an AT1 below its MA50 no longer unmeets it", () => {
    expect(leg({ ...MET, AT1: UNMET.AT1 }, "t2-price").verdict).toBe("met");
  });
});

describe("independent fills + time stop", () => {
  it("the second tranche fills on its own legs + gates while T1 never clears", () => {
    // T1's own EXSH > MA20 run (T1_EXSH_N) never completes; no later tranche reads it.
    const res = evaluate(MET, { ...R, T1_EXSH_N: 999 });
    expect(res.tranches.map((t) => [t.ready, t.met, t.filled])).toEqual([[false, false, false], [true, true, true], [false, false, false]]);
  });
  it("T1 fires via the time stop after TIME_STOP_N closes with the escalation box clear — not when it trips", () => {
    const r = { ...R, EXIT_DATE: SHOCK, TIME_STOP_N: POST - 1 };
    const t1 = (s: SeriesSet, at: Partial<Rules> = {}) => evaluate(s, { ...r, ...at }).tranches[0]!;
    const noT1 = { ...MET, EXSH_GATE: UNMET.EXSH_GATE };
    const fired = t1(noT1);
    expect([fired.met, fired.via]).toEqual([true, "time stop"]);
    expect(fired.met).not.toBe(evaluate(noT1, { ...r, TIME_STOP_N: POST }).tranches[0]!.met);
    expect([t1(noT1, QUIET).via, evaluate(noT1, r, LEGS, undefined, [VETO]).tranches[0]!.met], "the box clear → the time stop; a veto holding it → none").toEqual(["time stop", false]);
  });
});

describe("closes = final prints only; live = estimated + intraday head as prints", () => {
  /** AT1 rising for more than HIGH_N closes, one 0.5 break (a new HIGH_N-close low), then `good` closes at 0.8 (none a low) and the `tail`. */
  const N = R.T2_AT1_GUARD_N;
  const at1 = (good: number, tail: (number | Partial<Pt>)[] = []) => ({ ...MET, AT1: series([...ramp(1, 2, R.HIGH_N + 5), 0.5, ...rep(0.8, good), ...tail]) });
  const guard = (s: SeriesSet) => leg(s, "t2-at1-guard");
  it("a provisional head never completes a ×N run, but its `live` does", () => {
    const l = guard(at1(N - 1, [{ value: 0.8, provisional: true }]));
    expect([l.verdict, l.count]).toEqual(["unmet", { got: N - 1, need: N }]);
    expect(l.live.verdict).toBe("met");
  });
  it("an estimated row inside the window breaks the closes run, not the live one", () => {
    const l = guard(at1(N, [{ value: 0.8, estimated: true }, ...rep(0.8, 4)]));
    expect([l.count, l.live.count]).toEqual([{ got: 4, need: N }, { got: N, need: N }]);
  });
  it("a lagging estimated tail is skipped like the provisional head, not a break", () => {
    expect(guard(at1(N, [{ value: 0.8, estimated: true }])).count).toEqual({ got: N, need: N });
  });
  it("a stale provisional row mid-series breaks the run in both views; only the head is skipped", () => {
    const l = guard(at1(N, [{ value: 0.8, provisional: true }, ...rep(0.8, 4)]));
    expect([l.count, l.live.count]).toEqual([{ got: 4, need: N }, { got: 4, need: N }]);
  });
  it("estimated rows never set the peak", () => {
    const pts = [
      { date: SHOCK, value: 140 },
      { date: "2099-01-01", value: 200, estimated: true },
    ];
    expect(peakSince(pts, SHOCK)).toEqual({ value: 140, date: SHOCK });
  });
  it("a provisional head never sets the shock's last close", () => {
    const sh = shockOf([...series(shock(80, 1, 140, 90)), { date: "2099-01-01", value: 200, provisional: true }], R)!;
    expect([sh.last, sh.peak]).toEqual([90, 140]);
  });
});

describe("a live head lagging the newest live head says its date", () => {
  it("AT1 one session short: its legs read `@MM-DD`, every other leg stays bare", () => {
    const res = evaluate({ ...MET, AT1: MET.AT1.slice(0, -1) });
    // The box gate row reads AT1 among its `reads`, so it dates too.
    const isAt1 = (key: string) => ((d) => (d.reads ?? [d.id]).includes("AT1"))(LEGS.find((d) => d.key === key)!);
    const tagged = res.legs.filter((l) => l.live.value.endsWith(` @${MET.AT1.at(-2)!.date.slice(5)}`)).map((l) => l.key);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged).toEqual(res.legs.map((l) => l.key).filter(isAt1));
    expect(res.legs.filter((l) => !isAt1(l.key) && / @\d\d-\d\d$/.test(l.live.value))).toEqual([]);
  });
});

describe("an estimate live head says ` est.`", () => {
  const estHead = (pts: Pt[]): Pt[] => pts.map((p, i, a) => (i === a.length - 1 ? { ...p, estimated: true } : p));
  it("per cell: a leg reading an estimate head ends ` est.` after its `@MM-DD` lag tag; a final-headed leg stays bare", () => {
    const res = evaluate({ ...MET, AT1: estHead(MET.AT1.slice(0, -1)) });
    const readsAt1 = (key: string) => ((d) => (d.reads ?? [d.id]).includes("AT1"))(LEGS.find((d) => d.key === key)!);
    const tagged = res.legs.filter((l) => l.live.value.endsWith(` @${MET.AT1.at(-2)!.date.slice(5)} est.`)).map((l) => l.key);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged).toEqual(res.legs.map((l) => l.key).filter(readsAt1));
    expect(res.legs.filter((l) => !readsAt1(l.key) && l.live.value.endsWith(" est."))).toEqual([]);
    expect(evalMET().legs.filter((l) => l.live.value.endsWith(" est."))).toEqual([]);
  });
  it("asOf = the newest close, the newest live head, est = any live head an estimate — carried into the verdict", () => {
    const n = MET.AT1.length;
    const allEst = Object.fromEntries(Object.entries(MET).map(([id, pts]) => [id, estHead(pts)])) as SeriesSet;
    expect(evaluate(allEst).asOf).toEqual({ close: dateAt(n - 2), live: dateAt(n - 1), est: true });
    expect(evalMET().asOf).toEqual({ close: dateAt(n - 1), live: dateAt(n - 1), est: false });
    expect(toVerdict(evaluateShipped(allEst), false).asOf).toEqual({ close: dateAt(n - 2), live: dateAt(n - 1), est: true });
  });
  it("a lagging estimate head tags only its own `@MM-DD est.` cell — the header's est reads heads ON asOf.live", () => {
    const n = MET.AT1.length;
    const res = evaluate({ ...MET, AT1: estHead(MET.AT1.slice(0, -1)) });
    expect(res.asOf).toEqual({ close: dateAt(n - 1), live: dateAt(n - 1), est: false });
    expect(res.legs.some((l) => l.live.value.endsWith(` @${dateAt(n - 2).slice(5)} est.`))).toBe(true);
  });
  it("a head both provisional and estimated is `(prov.)`, never ` est.` — no cell tag, asOf.est false", () => {
    const n = MET.AT1.length;
    const provEst = Object.fromEntries(Object.entries(MET).map(([id, pts]) => [id, pts.map((p, i, a) => (i === a.length - 1 ? { ...p, provisional: true, estimated: true } : p))])) as SeriesSet;
    const res = evaluate(provEst);
    expect(res.asOf).toEqual({ close: dateAt(n - 2), live: dateAt(n - 1), est: false });
    expect(res.legs.filter((l) => l.live.value.endsWith(" est."))).toEqual([]);
  });
});

describe("replay", () => {
  /** A 59-return σ window, so the calm run fits the fixture: it ends on its high at close X − 1, the exit lands on close X. */
  const K = { ...REPLAY, FROM: dateAt(0), VOL_N: 59 };
  const X = K.VOL_N + 1;
  const drop = 95;

  it("fills land strictly after the exit (strict T3, no criterion leg, never fills); an unmet set never fills", () => {
    const exit = dateAt(PRE + 20);
    expect(replayFills(MET, { ...R, EXIT_DATE: exit }, dateAt(PRE + POST - 1))).toEqual([dateAt(PRE + 21), dateAt(PRE + 21), null]);
    expect(replayFills(UNMET, { ...R, EXIT_DATE: exit }, dateAt(PRE + POST - 1))).toEqual([null, null, null]);
  });
  it("return = one third per fill marked at the episode end; totals split by shape", () => {
    const px = [...calm(X), drop, ...rep(drop, PRE + POST - X - 2), 2 * drop];
    const s = { ...MET, EXSH_GATE: series(px, 0.05) };
    const [e] = replay(s, { ...R, ...QUIET, TIME_STOP_N: 0 }, [], K);
    expect(e!.fills.map((d) => d !== null)).toEqual([true, false, false]);
    expect([e!.hold, e!.ret]).toEqual([1, 1 / 3]);
    expect(replayTotals([e!, { ...e!, shape: "BEAR", ret: -0.5 }], "ret")).toEqual({ bear: -0.5, all: 1 / 3 - 0.5 });
  });
  it("offline pin: the replay rows, sweep table, stop row and verdict on the one-fill fixture print byte-for-byte as pinned", () => {
    const px = [...calm(X), drop, ...rep(drop, PRE + POST - X - 2), 2 * drop];
    const rows = replay({ ...MET, EXSH_GATE: series(px, 0.05) }, { ...R, ...QUIET, TIME_STOP_N: 0 }, [], K);
    const sig = sigmaAt(closes(series(px)), X - 1, K.VOL_N)!;
    expect(rows).toEqual([{ shockStart: dateAt(X - 1), exit: dateAt(X), end: dateAt(PRE + POST - 1), open: false, drop: K.DROP_K * sig * Math.sqrt(21 / 252), rise: K.RISE_K * sig, shape: "V", troughLag: 0, hold: 1, ret: 1 / 3, fills: [dateAt(X + 1), null, null], drops: [{ trough: 0, end: 1 }, null, null] }]);
    expect(sweepTable(rows)).toBe(
      [
        "sold        end         shape  low@  hold     rules    fills (trough/end)   * = hold < 0",
        `${dateAt(X)}  ${dateAt(PRE + POST - 1)}  V         0  +100.0%   +33.3%  ${dateAt(X + 1).slice(5)} +0.0%/+100.0% · — · —`,
        "bear total (0)                         +0.0%    +0.0%",
        "all (1)                              +100.0%   +33.3%",
      ].join("\n"),
    );
    expect(stopRow("pinned", rows)).toBe("pinned               worst bear  +0.0%  worst fill  +0.0%  all  +33.3%");
    expect(holdoutVerdict(rows)).toEqual({ bears: 0, realBears: 0, worstBear: 0, worstFill: 0, pass: false, thin: true });
    const bears = [1, 2, 3].map(() => ({ ...rows[0]!, shape: "BEAR" as const, ret: -0.02, drops: [{ trough: -0.1, end: -0.05 }, null, null] }));
    expect(holdoutVerdict([...rows, ...bears])).toEqual({ bears: 3, realBears: 0, worstBear: -0.02, worstFill: -0.1, pass: true, thin: false });
  });
  it("order: the second tranche's own legs met before the first fills, or with it never filling, is flagged early", () => {
    const px = [...calm(X), drop, ...rep(drop, PRE + POST - X - 1)];
    const s = { ...MET, EXSH_GATE: series(px, 0.05) };
    /** One leg per tranche, met from close `from` on, never when null. */
    const on = (tranche: "T1" | "T2", from: number | null): LegDef => ({ key: tranche, tranche, leg: tranche, id: "EXSH_GATE", tag: FAKE_TAG, rule: () => "", read: (_r, t) => ({ value: "", verdict: from !== null && closes(t.EXSH_GATE).at(-1)!.date >= dateAt(from) ? "met" : "unmet" }) });
    const order = (t1: number | null, t2: number) => orderReplay(s, K, { ...P, TIME_STOP_N: 999 }, [on("T1", t1), on("T2", t2)])[0]!;
    const [ok, early, late] = [order(X + 5, X + 9), order(null, X + 9), order(X + 9, X + 5)];
    expect([ok.t1, ok.t2, ok.early, early.t1, early.t2, early.early, late.early]).toEqual([dateAt(X + 5), dateAt(X + 9), false, null, dateAt(X + 9), true, true]);
  });
  it("gateSeries: decision = close / MA200 − 1, null before 200 closes", () => {
    const g = gateSeries([...rep(10, 199), 30].map((value, i) => ({ date: dateAt(i), value })));
    expect([g[198]!.decision, g[199]!.decision]).toEqual([null, 30 / ((199 * 10 + 30) / 200) - 1]);
  });
});

describe("fast rule set", () => {
  const LAST = dateAt(PRE + POST - 1);
  const plus = (d: string, n: number): string => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
  /** No time stop, so `ready` is the legs alone. */
  const LEGS_ONLY = { ...P, TIME_STOP_N: 999 };
  const ev = (s: SeriesSet, r = LEGS_ONLY) => evaluate(s, r, FAST_LEGS);
  const pleg = (s: SeriesSet, key: string, r = LEGS_ONLY) => readLeg(s, key, r, FAST_LEGS);

  it("MET meets every leg but the vol family (n/a: no open EXSH drawdown — its fixtures are in `volOf`'s describe) and all three tranches; UNMET fails every one but the box row", () => {
    const met = ev(MET);
    for (const l of met.legs) expect(`${l.key}: ${l.verdict}`).toMatch(/-vol$/.test(l.key) ? /: na$/ : /: met$/);
    expect(met.tranches.map((t) => t.met)).toEqual([true, true, true]);
    const unmet = ev(UNMET);
    expect(unmet.legs.map((l) => `${l.key}: ${l.verdict}`)).toEqual(unmet.legs.map((l) => `${l.key}: ${unmetVerdict(l.key)}`));
    expect(unmet.tranches.map((t) => t.met)).toEqual([false, false, false]);
  });
  it("needs climb the ladder (OQ3), each short of both families", () => {
    expect(P.T1_NEED <= P.T2_NEED && P.T2_NEED <= P.T3_NEED).toBe(true);
    // both families live (the vol family needs an open EXSH drawdown)
    for (const t of ev(volEx(96, 97)).tranches) expect(`${t.tranche} ${t.total} ${t.need < t.total}`).toBe(`${t.tranche} 2 true`);
  });
  it("an AT1 low gates the later tranches with every live family met: gates sit outside the count", () => {
    const ts = ev({ ...MET, AT1: spike(MET.AT1, 2, 0.5) }).tranches;
    expect(ts.map((t) => t.ready)).toEqual([true, false, false]);
    // gates sit outside the count: met/total/need are the non-gate legs, the gate verdicts ride alongside
    // every roster ends on the escalation-box row (met: the fixture's box holds nothing)
    // T1 [esc] · T2 [AT1 guard, esc] · T3 [trend, AT1 guard, esc]; the vol family reads n/a, so each tranche counts its one live price rung (need floors at 1)
    expect(ts.map((t) => [t.metCount, t.total, t.need, t.gates])).toEqual([[1, 1, 1, ["met"]], [1, 1, 1, ["unmet", "met"]], [1, 1, 1, ["met", "unmet", "met"]]]);
    const t1 = evalMET().tranches[0]!;
    expect([probeTrancheCell(ts[1]!), probeTrancheCell(t1)]).toEqual(["✗: 1/1 need 1 · gates ✗✓", "✓: 1/1 need 1 · gates ✓"]);
  });
  /** `bad` = a close that breaks the leg, placed `back` closes before the last. */
  const spike = (pts: Pt[], back: number, value: number): Pt[] => pts.map((p, i, a) => (i === a.length - 1 - back ? { ...p, value } : p));
  it.each([
    ["t1-price", "T1_NO_LOW_N", "EXSH_GATE", 1],
    ["t2-at1-guard", "T2_AT1_GUARD_N", "AT1", 0.5],
    ["t3-at1-guard", "T3_AT1_GUARD_N", "AT1", 0.5],
    ["t2-price", "T2_NO_LOW_N", "EXSH_GATE", 1],
  ] as const)("%s reads %s: N good closes after a break is met, N − 1 is not", (key, k, id, bad) => {
    const r = { ...LEGS_ONLY, [k]: 7 };
    const defs = FAST_LEGS.some((d) => d.key === key) ? FAST_LEGS : LEGS;
    const at = (back: number) => readLeg({ ...MET, [id]: spike(MET[id], back, bad) }, key, r, defs).verdict;
    expect([at(6), at(7)]).toEqual(["unmet", "met"]);
  });
  it("an AT1 low gates T2 and T3 but never T1; no AT1 closes reads n/a and passes the guards — the box (its one member absent, t1Only) holds T2/T3", () => {
    expect(ev({ ...MET, AT1: spike(MET.AT1, 2, 0.5) }).tranches.map((t) => t.ready)).toEqual([true, false, false]);
    expect(["t2-at1-guard", "t3-at1-guard"].map((k) => pleg({ ...MET, AT1: [] }, k).verdict)).toEqual(["na", "na"]);
    expect(ev({ ...MET, AT1: [] }).tranches.map((t) => t.ready)).toEqual([true, false, false]);
    expect(pleg({ ...MET, AT1: MET.AT1.slice(-P.HIGH_N) }, "t2-at1-guard").verdict).toBe("na");
  });
  it("value cells date their derived lines", () => {
    const falling = { ...MET, EXSH_GATE: series(ramp(31, 20, PRE + POST), 0.05) };
    expect([pleg(MET, "t1-price").value, pleg(falling, "t3-price").value]).toEqual(["31.00/28.68 (10-01)", "20.000 >MA50 22.472✗ · MA50 22.472 >23.482 (10-14)✗"]);
  });
  it("the trend gate reads EXSH > MA200 alone — a falling MA50 fails the current gate only", () => {
    const falling = { ...MET, EXSH_GATE: series(ramp(31, 20, PRE + POST), 0.05) };
    expect([pleg(falling, "t3-trend").verdict, leg(falling, "t3-trend").verdict]).toEqual(["met", "unmet"]);
    expect(pleg({ ...MET, EXSH_GATE: series(ramp(20, 31, PRE + POST), -0.05) }, "t3-trend").verdict).toBe("unmet");
    // the value is the comparison itself — close/MA200 (backed out of the gap) and the signed gap
    expect([pleg(falling, "t3-trend").value, leg(falling, "t3-trend").value]).toEqual(["20.00/19.05 (+5.0%)", "20.00/19.05 (+5.0%)"]);
    expect(pleg({ ...MET, EXSH_GATE: series(ramp(20, 31, PRE + POST), -0.05) }, "t3-trend").value).toBe("31.00/32.63 (-5.0%)");
  });
  it("the later tranches fire AFTER_N closes after the one before them with their legs short — never while a guard is tripped", () => {
    // vol runs hot (4× swings) and the price rung meets only at T1: T2/T3 stay short on legs
    const s = volEx(94, 98);
    const r = { ...LEGS_ONLY, EXIT_DATE: dateAt(PRE + 5), T2_NEED: 99, T3_NEED: 99, NEED_SLACK: 0 };
    const fills = (rules = r) => replayFills(s, rules, LAST, FAST_LEGS);
    const [t1, t2, t3] = fills();
    expect([t2, t3]).toEqual([plus(t1!, P.T2_AFTER_N), plus(t1!, P.T2_AFTER_N + P.T3_AFTER_N)]);
    expect(fills({ ...r, T2_AFTER_N: 0 }).slice(1)).toEqual([null, null]);
    // the cell names the time path, so a ✓ over a short count is never unexplained
    const late = evaluate(s, r, FAST_LEGS).tranches.slice(1);
    expect(late.map((t) => [t.ready, t.met, t.via])).toEqual([[false, true, "after T1"], [false, true, "after T2"]]);
    expect(probeTrancheCell(late[0]!)).toMatch(/^✓: \d+\/\d+ need \d+ \(after T1\)/);
    expect(fills({ ...r, T2_AT1_GUARD_N: 999, T3_AT1_GUARD_N: 999 }).slice(1)).toEqual([null, null]);
  });
});

describe("replay arms", () => {
  /** The calm run as in `replay`; RISE_K 100 puts the rise end out of the dips' reach, so each episode ends on the regain. */
  const K = { ...REPLAY, FROM: dateAt(0), VOL_N: 59, RISE_K: 100 };
  const X = K.VOL_N + 1;
  const NO_X: Extra = { EPATH: [], HICP: [] };
  const PLAIN: Arm = { esc: {}, stop: 0, scope: "T1", sw: "none" };

  it("the EXSH switch lights under MA200 (or short of MA200_CONFIRM_N closes); nothing lights on MET", () => {
    const s = { ...MET, EXSH_GATE: series(rep(1, 5), -0.05) };
    expect(SWITCHES.filter((k) => switchLit(k, s, NO_X, dateAt(0)))).toEqual(["exsh-ma200"]);
    expect(SWITCHES.filter((k) => switchLit(k, MET, NO_X, dateAt(0)))).toEqual([]);
    expect(switchLit("exsh-ma200", { ...MET, EXSH_GATE: series(rep(1, 5)) }, NO_X, dateAt(0))).toBe(true);
  });

  it("EPATH + HICP: a lit path and a positive HICP change, the HICP point read HICP_LAG_DAYS late", () => {
    const x = (state: string, hicp: number): Extra => ({ EPATH: [{ date: dateAt(0), value: 1, state }], HICP: [{ date: dateAt(0), value: hicp }] });
    const at = (e: Extra, day: number) => switchLit("epath-hicp", MET, e, dateAt(day));
    expect([at(x("AMBER", 1), ARM.HICP_LAG_DAYS), at(x("AMBER", 1), ARM.HICP_LAG_DAYS - 1), at(x("GREEN", 1), 99), at(x("RED", -1), 99)]).toEqual([true, false, false, false]);
  });

  /** Exit at X, four flat closes, one close 5% under them, flat again, then double. */
  const px = [...calm(X), 95, ...rep(95, 4), 90, ...rep(95, PRE + POST - X - 7), 190];
  const DIP = { ...MET, EXSH_GATE: series(px, 0.05) };
  /** Every tranche fires on its time path, one close apart. */
  const TIMED = { ...QUIET, TIME_STOP_N: 0, T2_AFTER_N: 1, T3_AFTER_N: 1 };
  const retCache = new Map<string, unknown>();
  const ret = (arm: Partial<Arm>) => armReplay(DIP, NO_X, { ...PLAIN, esc: TIMED, ...arm }, K, retCache)[0]!;

  it("the plain arm is the fast-set replay; a lit switch is the strict-set replay", () => {
    const strip = (rows: EpisodeResult[]) => rows.map((e) => [e.ret, e.fills]);
    expect(strip(armReplay(DIP, NO_X, PLAIN, K))).toEqual(strip(replay(DIP, P, FAST_LEGS, K)));
    const under = { ...DIP, EXSH_GATE: series(px, -0.05) };
    expect(strip(armReplay(under, NO_X, { ...PLAIN, sw: "exsh-ma200" }, K))).toEqual(strip(replay(under, R, undefined, K)));
  });

  it("a close under the stop line sells the tranche, which refills on a later close; scope picks which tranches", () => {
    const loss = 90 / 95 - 1;
    expect(ret({}).fills[0]).toBe(dateAt(X + 1));
    expect(ret({}).ret).toBeCloseTo(1, 10);
    expect(ret({ stop: 0.02 }).ret).toBeCloseTo(1 + loss / 3, 10);
    expect(ret({ stop: 0.02, scope: "all" }).ret).toBeCloseTo(1 + loss, 10);
    expect(ret({ stop: 0.06 }).ret).toBeCloseTo(1, 10);
  });

  it("a stopped tranche's trough runs to its sell close; its refill is read against its own entry", () => {
    // sold at 90 under the 2% line, the next close sinks to 80 unheld, the refill there never dips
    const sink = { ...MET, EXSH_GATE: series([...calm(X), 95, ...rep(95, 4), 90, 80, ...rep(95, PRE + POST - X - 8), 190], 0.05) };
    const e = armReplay(sink, NO_X, { ...PLAIN, esc: TIMED, stop: 0.02 }, K)[0]!;
    expect([e.drops[0]!.trough, fillDrops(sink.EXSH_GATE, e.fills, e.end)[0]!.trough]).toEqual([expect.closeTo(90 / 95 - 1, 10), expect.closeTo(80 / 95 - 1, 10)]);
  });

  it("a fill stop sells every tranche at fill × (1 − cut) only while its gate is lit, and refills it only once the gate is dark", () => {
    const loss = 90 / 95 - 1;
    /** DIP with EXSH under its MA200 from X+4 to X+8 (the switch reads dark 3 closes later), 92 through X+10. */
    const lo = X + 4;
    const win = series([...calm(X), 95, ...rep(95, 4), 90, ...rep(92, 5), ...rep(95, PRE + POST - X - 12), 190]).map((p, i) => ({ ...p, decision: i >= lo && i <= lo + 4 ? -0.05 : 0.05 }));
    const WIN = { ...MET, EXSH_GATE: win };
    const BEAR = { cut: ARM.BEAR_STOP, gate: "exsh-ma200" as const };
    // one armReplay cache per series (every arm here shares esc/sw, and `fillStop` sits outside the memo keys) + one result per (series, fillStop)
    const caches = new Map<SeriesSet, Map<string, unknown>>();
    const runs = new Map<string, EpisodeResult>();
    const run = (s: SeriesSet, fillStop: Arm["fillStop"]): EpisodeResult => {
      const cache = caches.get(s) ?? caches.set(s, new Map()).get(s)!;
      const key = `${[...caches.keys()].indexOf(s)}|${JSON.stringify(fillStop ?? null)}`;
      return runs.get(key) ?? runs.set(key, armReplay(s, NO_X, { ...PLAIN, esc: TIMED, ...(fillStop && { fillStop }) }, K, cache)[0]!).get(key)!;
    };
    expect(run(WIN, undefined).ret).toBeCloseTo(1, 10);
    expect(run(DIP, BEAR).ret).toBeCloseTo(1, 10);
    expect(run(WIN, { ...BEAR, cut: 0.06 }).ret).toBeCloseTo(1, 10);
    // sold at 90; the refill waits out the lit closes at 92 and buys back at 95
    expect(run(WIN, BEAR).ret).toBeCloseTo(loss + 1, 10);
    expect(run(WIN, BEAR).drops.map((d) => d!.trough)).toEqual([loss, loss, loss].map((x) => expect.closeTo(x, 10)));
    // ungated, the refill lands on the next close it is ready — inside the lit stretch at 92
    expect(run(WIN, { ...BEAR, gate: null }).ret).toBeCloseTo(loss + 190 / 92 - 1, 10);
    // the gate relit over a refill held above its line keeps it held (99, not 100: regaining the high would end the episode)
    const hi = PRE + 20;
    const relit = series([...calm(X), 95, ...rep(95, 4), 90, ...rep(92, 5), ...rep(95, hi - X - 11), ...rep(99, PRE + POST - hi - 1), 190]).map((p, i) => ({ ...p, decision: (i >= lo && i <= lo + 4) || (i >= hi && i <= hi + 1) ? -0.05 : 0.05 }));
    expect(run({ ...MET, EXSH_GATE: relit }, BEAR).ret).toBeCloseTo(loss + 1, 10);
  });

  it("fill drift (`fillDrift` on `armReplay`): a candidate whose box holds T2/T3 throughout (THIN: the member never reads, below quorum) mismatches", () => {
    // the shipped run once, on K: the premise and fillDrift read the same rows
    const rows = armReplay(DIP, NO_X, SHIPPED_ARM, K);
    const candidate = (k: ReplayKnobs): EpisodeResult[] => armReplay(DIP, NO_X, { ...SHIPPED_ARM, esc: { ...SHIPPED_ARM.esc, ...THIN } }, k);
    expect(rows.map((e) => e.fills).flat().some((f) => f !== null), "premise: the shipped arm fills on the fixture, so a held box can mismatch").toBe(true);
    expect(driftSummary(fillDrift(DIP.EXSH_GATE, () => rows, candidate, K)).mismatches).toBeGreaterThanOrEqual(1);
  });

  it("binding closes (`armReplay` bound): a close the box alone holds counts once; the same close with the AT1 guard unmet counts none", () => {
    // AT1 starts at X + 2: its member reads n/a on its first ESC_AT1_LOW_N − 1 closes (X+2..X+4), so the box sits below quorum and holds T2's time path (t1Only);
    // the AT1 guard reads n/a until it holds over HIGH_N closes (from X+4); at X+5 the member reads and votes nothing, and T2 fills
    const esc = { ...TIMED, ESC_AT1_LOW_N: 4, HIGH_N: 2, T2_AT1_GUARD_N: 1, T3_AT1_GUARD_N: 1 };
    const short = { ...DIP, AT1: DIP.AT1.filter((p) => p.date >= dateAt(X + 2)) };
    const run = (s: SeriesSet) => ((bound) => [armReplay(s, NO_X, { ...PLAIN, esc }, K, new Map(), {}, FAST_LEGS, bound)[0]!.fills.slice(0, 2), [...bound.values()]])(new Map<string, string[]>());
    expect(run(short)).toEqual([[dateAt(X + 1), dateAt(X + 5)], [[dateAt(X + 2), dateAt(X + 3), dateAt(X + 4)]]]);
    // an AT1 low at X+4 (a new HIGH_N-close low, the guard's first live close): the box still holds there, but so does the guard — that close binds no more
    const at1Low = { ...short, AT1: short.AT1.map((p) => (p.date === dateAt(X + 4) ? { ...p, value: 0.5 } : p)) };
    expect(run(at1Low)).toEqual([[dateAt(X + 1), dateAt(X + 5)], [[dateAt(X + 2), dateAt(X + 3)]]]);
  });

  it("why rows (`whyFills`): one per non-null `armReplay` fill, routed as its cascade fired it", () => {
    const fillsOf = (arm: Arm) => armReplay(DIP, NO_X, arm, K).flatMap((e) => e.fills.filter((f) => f !== null));
    const why = (arm: Arm) => whyFills(DIP, K, arm).map((w) => [w.tranche, w.date, w.via]);
    // T1's need out of its legs' reach: only its time stop fills it
    const timed = { ...PLAIN, esc: { ...TIMED, T1_NEED: Infinity, NEED_SLACK: -Infinity } };
    const fills = fillsOf(timed);
    expect(why(timed)).toEqual(["time stop", "after T1", "after T2"].map((via, i) => [`T${i + 1}`, fills[i], via]));
    expect(fills).toHaveLength(3);
    const shipped = whyFills(DIP, K);
    expect(shipped.map((w) => w.date)).toEqual(fillsOf(SHIPPED_ARM));
    expect(shipped.length, "premise: the shipped arm fills on the fixture").toBeGreaterThan(0);
    // T1 and T2 on their own counts (the vol family n/a, price met); T3's price rung falls short, so it fills on the after-T2 cascade
    expect(shipped.map((w) => [w.tranche, w.via])).toEqual([["T1", "count 1/1"], ["T2", "count 1/1"], ["T3", "after T2"]]);
    expect(shipped.every((w) => w.rows.length > 0 && w.rows.every((r) => !/^t\d-/.test(r.key)))).toBe(true);
  });

  it("judge passes on the worst bear and the current total, best arm first", () => {
    const [e] = replay(DIP, R, [], K);
    const run = (arm: Partial<Arm>, bears: number[], v = 0) => ({ arm: { ...PLAIN, ...arm }, rows: [...bears.map((r) => ({ ...e!, shape: "BEAR" as const, ret: r })), { ...e!, shape: "V" as const, ret: v }] });
    const cut = ARM.PASS_WORST_BEAR;
    const judged = judge([run({}, [cut - 0.001, 0.5]), run({ stop: 0.02, sw: "epath-hicp" }, [cut, 0.1]), run({ stop: 0.02 }, [cut, 0.1]), run({ sw: "exsh-ma200" }, [0.05], 0.3), run({ stop: 0.05 }, [0, 0])], 0.05);
    expect(judged.map((j) => [j.arm.stop, j.arm.sw, j.knobs, j.pass])).toEqual([[0, "exsh-ma200", 1, true], [0.02, "none", 1, true], [0.02, "epath-hicp", 2, true], [0, "none", 0, false], [0.05, "none", 1, false]]);
    expect(judged.at(-2)!.worstBear).toBeCloseTo(cut - 0.001, 10);
  });
});

describe("T1 arms", () => {
  const r: Rules = { ...P, TIME_STOP_N: 999 };
  const ready = (s: SeriesSet, at: Partial<Rules> = {}, defs = FAST_LEGS) => evaluate(s, { ...r, ...at }, defs).tranches[0]!.ready;
  /** EXSH calm pre-shock, then falling every close in −3%/−0.5% steps: the equity-side price family unmet (vol n/a: too short for an episode), AT1 credit as MET. */
  const fall = [...Array.from({ length: PRE - 1 }, (_, i) => (i % 2 ? 0.001 : -0.001)), ...Array.from({ length: POST }, (_, i) => (i % 2 ? -0.005 : -0.03))];
  const DOWN = { ...MET, EXSH_GATE: series(fall.reduce((a, x) => [...a, a.at(-1)! * (1 + x)], [100]), 0.05) };

  it("T1_MIX needs a met credit-side AND a met equity-side family (the AT1 arm, the one credit-side family)", () => {
    expect([ready(DOWN, {}, FAST_LEGS_AT1), ready(DOWN, { T1_MIX: 1 }, FAST_LEGS_AT1), ready(MET, { T1_MIX: 1 }, FAST_LEGS_AT1)]).toEqual([true, false, true]);
  });

  it("held() counts a family met only on ≥ T1_HOLD_K of the latest T1_HOLD_M closes; K = 0 reads the latest close alone", () => {
    const last = closes(MET.EXSH_GATE).slice(-5).map((p) => p.date);
    const fake = (met: string[]): LegDef => ({ key: "t1-x", tranche: "T1", leg: "x", id: "EXSH_GATE", tag: FAKE_TAG, rule: () => "", read: (_r, s) => ({ value: "", verdict: met.includes(closes(s.EXSH_GATE).at(-1)!.date) ? "met" : "unmet" }) });
    const at = (met: string[], k: number) => held(fake(met)).read({ ...r, T1_HOLD_K: k, T1_HOLD_M: 5 }, MET).verdict;
    expect([at(last.slice(-2), 0), at(last.slice(0, 3), 0), at(last.slice(-2), 3), at([last[0]!, ...last.slice(-2)], 3)]).toEqual(["met", "unmet", "unmet", "met"]);
  });

  it("the AT1 family is n/a without a pre-shock close, met with no post-shock low, unmet under one", () => {
    const at1 = (s: SeriesSet) => evaluate(s, r, FAST_LEGS_AT1).legs.find((l) => l.key === "t1-at1")!.verdict;
    const n = PRE + POST;
    expect([at1({ ...MET, AT1: [] }), at1(MET), at1({ ...MET, AT1: series(ramp(1, 0.5, n)) })]).toEqual(["na", "met", "unmet"]);
    const t1Criteria = (defs: LegDef[]) => defs.filter((d) => d.tranche === "T1" && !d.gate).length;
    expect(t1Criteria(FAST_LEGS_AT1)).toBe(t1Criteria(FAST_LEGS) + 1);
  });
});

describe("shipped rule", () => {
  const gate = (sign: (i: number) => number): Pt[] => MET.EXSH_GATE.map((p, i) => ({ ...p, decision: sign(i) }));
  const keys = (defs: { key: string }[]) => defs.map((d) => d.key);

  it("the latest close's switch picks the set shown; the other set is tallied apart", () => {
    const above = shippedMET();
    const under = evaluateShipped({ ...MET, EXSH_GATE: gate(() => -0.05) });
    expect([above.regime.set, above.inactive.set, keys(above.legs)]).toEqual(["fast", "strict", keys(FAST_LEGS)]);
    expect([under.regime.set, under.inactive.set, keys(under.legs)]).toEqual(["strict", "fast", keys(evalMET().legs)]);
    expect(under.inactive.tranches.map((t) => t.total)).toEqual(above.tranches.map((t) => t.total));
    // the fast T1 price rung: T1_NO_LOW_N closes after the exit with no new post-exit low (vol n/a)
    expect([above.tranches[0]!.since, above.tranches[0]!.filled]).toEqual([dateAt(PRE + 16 + P.T1_NO_LOW_N), true]);
    expect(dateAt(PRE + 16)).toBe(R.EXIT_DATE);
  });

  it("each close is judged on its own set: the first tranche fills once MA200_CONFIRM_N closes in a row sit above MA200, never on a one-close poke", () => {
    expect(ARM.MA200_CONFIRM_N).toBeGreaterThan(1);
    const FLIP = PRE + 30;
    // EXSH a sawtooth from the shock on — 40 / a floor rising 0.01 a close from 28: every floor close sits under MA20, so the strict first tranche
    // (t1-exsh-ma20 ×T1_EXSH_N) never clears; after the first post-exit floor no close is a new post-exit low, so the fast one (t1-price) fills on its own legs.
    const saw = (sign: (i: number) => number): SeriesSet => ({ ...MET, EXSH_GATE: gate(sign).map((p, i) => (i < PRE ? p : { ...p, value: (i - PRE) % 2 ? 28 + 0.01 * (i - PRE) : 40 })) });
    const shipped = evaluateShipped(saw((i) => (i < FLIP ? -0.05 : 0.05))).tranches[0]!;
    expect([evaluate(saw(() => 0.05)).tranches[0]!.since, shipped.since]).toEqual([null, dateAt(FLIP + ARM.MA200_CONFIRM_N - 1)]);
    expect(evaluateShipped(saw((i) => (i === FLIP ? 0.05 : -0.05))).tranches[0]!.since).toBeNull();
    expect(evaluate(saw(() => 0.05), P, FAST_LEGS).tranches[0]!.since! < dateAt(FLIP)).toBe(true);
  });

});

describe("toVerdict — the live-state verdict off an evaluation", () => {
  const tr = (tranche: TrancheResult["tranche"], met: boolean, since: string | null, extra: Partial<TrancheResult> = {}): TrancheResult => ({ tranche, metCount: 2, total: 4, need: 3, gates: [], ready: met, clear: true, met, filled: since !== null, since, ...extra });
  const closesT = [tr("T1", true, "2026-09-01", { via: "time stop" }), tr("T2", false, null, { ready: true }), tr("T3", false, null)];
  const liveT = [tr("T1", true, "2026-08-28"), tr("T2", true, "2026-09-02", { metCount: 3, gates: ["met", "unmet"] }), tr("T3", false, null)];
  const rest = { regime: { set: "fast", exshVsMa200: 0.02 } } as unknown as Omit<Res, "tranches" | "tranchesLive">;
  const res: Res = { ...rest, tranches: closesT, tranchesLive: liveT };
  const proj = (t: TrancheResult) => [t.tranche, t.met, t.since, t.metCount, t.total, t.need, t.ready, t.via, t.gates];

  it("maps closes→tranches and tranchesLive→live (met→ok, since→filledSince), prov passes through", () => {
    for (const prov of [true, false]) {
      const v = toVerdict(res, prov);
      expect(v.tranches.map((t) => [t.id, t.ok, t.filledSince, t.met, t.total, t.need, t.ready, t.via, t.gates])).toEqual(closesT.map(proj));
      expect(v.live.map((t) => [t.id, t.ok, t.filledSince, t.met, t.total, t.need, t.ready, t.via, t.gates])).toEqual(liveT.map(proj));
      expect([v.prov, v.regime]).toEqual([prov, rest.regime]);
      expect(v).not.toHaveProperty("tranchesLive");
    }
  });

  it("a leg's tip reaches the verdict leg — a rung's own, never the rung below's; none where the rule has none", () => {
    const at = ((legs) => (key: string) => legs.find((l) => l.key === key)!)(toVerdict(shippedMET(), false).legs);
    expect([at("t2-vol").rule, at("t3-vol").rule]).toEqual(["RV10 ≤ 1.5× base", "RV20 ≤ 1.2× base"]);
    expect(at("t2-vol").tip).toBe("RV10 = EXSH's annualised 10-close realized vol; base = its RV over the 60 closes before the drawdown's shock start. Needs RV10 ≤ 1.5× base on the latest close — equity vol back near its pre-shock norm.");
    expect([at("t3-vol").tip?.includes("RV20 ≤ 1.2× base"), "tip" in at("t3-trend")]).toEqual([true, false]);
  });
});

describe("nest / both — two readings into one", () => {
  it("nest: prev n/a → n/a · next n/a → prev · else met iff both, reading the binding part", () => {
    const r = (verdict: "met" | "unmet" | "na", value: string) => ({ value, verdict });
    const [met, unmet, na] = [r("met", "a"), r("unmet", "b"), r("na", "c")];
    expect([nest(na, met), nest(met, na), nest(unmet, na), nest(met, met), nest(met, unmet), nest(unmet, met)]).toEqual([na, met, unmet, met, unmet, unmet]);
    expect([nest(met, r("met", "d")).value, nest(unmet, r("met", "d")).value]).toEqual(["d", "b"]);
  });
  it("both: n/a on either side yields the other, both n/a → n/a, else met iff both", () => {
    const r = (verdict: "met" | "unmet" | "na", value: string) => ({ value, verdict });
    const [met, unmet, na] = [r("met", "a"), r("unmet", "b"), r("na", "c")];
    expect([both(na, na), both(na, unmet), both(unmet, na), both(na, met), both(met, met), both(met, unmet)]).toEqual([na, unmet, unmet, met, met, unmet]);
  });
});

describe("the ladder's new readers", () => {
  const LEGS_ONLY = { ...P, TIME_STOP_N: 999 };
  const fleg = (s: SeriesSet, key: string) => readLeg(s, key, LEGS_ONLY, FAST_LEGS);

  it("realizedVol: annualised sample sd of the n log returns ending at i — ln1.1·√(n/(n−1)) for ±ln1.1; null short of n + 1 closes or n < 2", () => {
    const geo = series(Array.from({ length: 12 }, (_, k) => 100 * 1.01 ** k));
    const alt = series(Array.from({ length: 12 }, (_, k) => (k % 2 ? 110 : 100)));
    expect(realizedVol(geo, 11, 10)).toBeCloseTo(0, 12);
    expect(realizedVol(alt, 11, 10)).toBeCloseTo(Math.log(1.1) * Math.sqrt(10 / 9) * Math.sqrt(252), 12);
    expect([realizedVol(alt, 9, 10), realizedVol(alt, 10, 10) !== null, realizedVol(alt, 11, 1)]).toEqual([null, true, null]);
  });

  describe("vol rungs off EXSH's own open drawdown (`volOf`)", () => {
    const vols = (s: SeriesSet) => ["t1-vol", "t2-vol", "t3-vol"].map((k) => fleg(s, k));
    const [calmish, hot] = [volEx(96, 97), volEx(94, 98)];

    it("premise: the episode's shock is the calm run's last high, still open; cut short of REPLAY.VOL_N calm closes none opens and every rung reads n/a", () => {
      expect(openShockStart(calmish.EXSH_GATE)).toBe(dateAt(PRE - 1));
      expect(vols({ ...calmish, EXSH_GATE: calmish.EXSH_GATE.slice(REPLAY.VOL_N - 5) }).map((l) => l.verdict)).toEqual(["na", "na", "na"]);
    });

    it("RV near the pre-shock base meets every rung; a 4× wider swing fails every rung; T2/T3 print RV over its base cut", () => {
      expect([vols(calmish).map((l) => l.verdict), vols(hot).map((l) => l.verdict)]).toEqual([["met", "met", "met"], ["unmet", "unmet", "unmet"]]);
      expect(vols(calmish).slice(1).map((l) => l.value)).toEqual(["17.3/23.9", "16.9/19.1"]);
    });

    it("EXSH reads deeper than AT1 live (`liveLimit`), so its own calm run fits the fetch", () => {
      expect(liveLimit("EXSH_GATE")).toBeGreaterThan(liveLimit("AT1"));
    });
  });
});

describe("escalation box families (ESC_FAMILIES + escLeg)", () => {
  const sign = (s: string, block = false): SignLite => ({ sign: s, lean: "open", block });
  const unmet = (e: ReturnType<typeof escalation>) => e.families.filter((f) => f.verdict === "unmet").map((f) => f.name);
  const member = (e: ReturnType<typeof escalation>, id: string) => e.clusters.flatMap((c) => c.members).find((m) => m.id === id)!;

  it("bank actions + sovereign events are the family rows: no close read prints —, a block on a row's sign unmeets it; the member's sign rides the member and unmeets no row", () => {
    const e = escalation(MET, R, [sign("Bank / insurer windfall taxes"), sign("Single-institution stress", true)]);
    // an unblocked sign row → met; no sign row at all → n/a
    expect(e.families.map((f) => [f.name, f.rule, f.value, f.verdict])).toEqual([["bank actions", "a block sign", "—", "met"], ["sovereign events", "a block sign", "—", "na"]]);
    expect([member(e, "at1").signs, member(escalation(MET, R), "at1").signs], "at1 carries its blocked sign; with none, no signs").toEqual([[sign("Single-institution stress", true)], undefined]);
    expect([unmet(escalation(MET, R, [sign("Supervisors pressuring dividends / buybacks", true)])), unmet(escalation(MET, R, [sign("ECB backstop (TPI)", true)]))]).toEqual([["bank actions"], ["sovereign events"]]);
  });

  it("a sign string outside the attachment table lands in no row and unmeets none, blocked or not", () => {
    const e = escalation(MET, R, [sign("Martian landing", true)]);
    expect([unmet(e), e.families.every((f) => f.signs.length === 0), e.clusters.flatMap((c) => c.members).some((m) => m.signs)]).toEqual([[], true, false]);
  });

  it("every live sign row of public/eufin.json attaches to exactly one family or member", () => {
    const live = JSON.parse(readFileSync(new URL("../public/eufin.json", import.meta.url), "utf8")) as { signs: { sign: string }[] };
    expect(live.signs.length).toBeGreaterThan(0);
    const rows = Object.keys(FAMILY_SIGN) as (keyof typeof FAMILY_SIGN)[];
    expect(rows).toEqual(expect.arrayContaining([...ESC_FAMILIES, ...CLUSTERS.flatMap((c) => c.members)]));
    const homes = (s: string) => rows.filter((f) => FAMILY_SIGN[f].includes(s));
    expect(live.signs.map((g) => [g.sign, homes(g.sign).length])).toEqual(live.signs.map((g) => [g.sign, 1]));
    expect(rows.flatMap((f) => FAMILY_SIGN[f]).filter((s) => !live.signs.some((g) => g.sign === s)), "no table entry names a sign the live file lacks").toEqual([]);
  });

  it("the `escalation box` gate row ends every tranche's roster in both sets and reads the box: votes · veto · live/n vs quorum", () => {
    for (const defs of [LEGS, FAST_LEGS]) expect((["T1", "T2", "T3"] as const).map((t) => defs.filter((d) => d.tranche === t && d.gate).at(-1)!.leg)).toEqual(["gate: escalation box", "gate: escalation box", "gate: escalation box"]);
    const box = (t: string) => LEGS.find((d) => d.key === `${t}-esc`)!;
    expect([box("t1").rule(R), box("t2").rule(R)]).toEqual([box("t3").rule(R), box("t3").rule(R)]);
    expect(box("t1").rule(R)).toBe(`no veto · T2·T3: live ≥ ${Math.round(BOX_KERNEL.QUORUM_SHARE * 100)}%`);
    const [Q, L] = [{ ...R, ...QUIET }, { ...R, ...LOUD }];
    // LOUD: the one coincident cluster votes — shown, it holds nothing alone
    expect([box("t2").read(Q, MET), box("t2").read(L, MET), box("t2").read(Q, MET, [sign("Bank / insurer windfall taxes", true)]), box("t2").read(Q, MET, [VETO])]).toEqual([
      { value: "votes — · live 1/1 need 1", verdict: "met" },
      { value: "votes credit · live 1/1 need 1", verdict: "met" },
      { value: "votes — · live 1/1 need 1", verdict: "met" },
      { value: `votes — · veto ${VETO.sign} · live 1/1 need 1`, verdict: "unmet" },
    ]);
    const blocked = evaluateShipped(MET, [sign("Bank / insurer windfall taxes", true), sign("Earnings revisions / guidance tone", true)]);
    expect([unmet(blocked.escalation), blocked.escalation.hold], "two levy-side bank rows block one family row and cast no vote").toEqual([["bank actions"], false]);
    expect(shippedMET().escalation.families.map((f) => f.name), "signs default to none: the family still renders").toEqual([...ESC_FAMILIES]);
  });

  describe("the box (CLUSTERS · VETO_ROWS): one coincident member, the veto rows, the quorum", () => {
    const ruled = (s: Partial<SeriesSet>, signs: SignLite[] = []) => escalation({ ...MET, ...s }, R, signs);
    /** Per tranche: [`boxHolds`, its esc gate row unmet]. */
    const holds = (s: Partial<SeriesSet>, signs: SignLite[] = []) => (["T1", "T2", "T3"] as const).map((t) => [boxHolds(t, ruled(s, signs)), LEGS.find((d) => d.key === `${t.toLowerCase()}-esc`)!.read(R, { ...MET, ...s }, signs).verdict === "unmet"]);
    const [NONE, ALL] = [[[false, false], [false, false], [false, false]], [[true, true], [true, true], [true, true]]];
    /** AT1 sliding to an ESC_AT1_LOW_N-close low over its last ESC_AT1_LOW_N closes, then two closes back up: the credit vote, its low 2 closes ago. */
    const credit = series([...rep(1, R.ESC_AT1_LOW_IN), ...ramp(2, 1.9, R.ESC_AT1_LOW_N), 1.95, 1.96]);
    it("the member carries its trips-when `rule` and the read its cell judged (`value`); `live` = the latest-print read", () => {
      const at1 = (s: Partial<SeriesSet>) => ruled(s).clusters[0]!.members[0]!;
      const rule = `AT1 RS at a ${R.ESC_AT1_LOW_N}-close low in the last ${R.ESC_AT1_LOW_IN}`;
      expect([at1({ AT1: credit }), at1({})]).toMatchObject([
        { id: "at1", cell: "hit", rule, value: `AT1 RS ${R.ESC_AT1_LOW_N}-close low 2 closes ago` },
        { id: "at1", cell: false, rule },
      ]);
      const lowHead = { ...MET, AT1: [...MET.AT1, { date: dateAt(PRE + POST), value: 0.5, provisional: true }] };
      expect(evaluate(lowHead).escalation.clusters[0]!.members[0], "a provisional head moves `live`, never the close").toMatchObject({ id: "at1", cell: false, live: `AT1 RS ${R.ESC_AT1_LOW_N}-close low on the latest close`, liveCell: "hit" });
    });
    it("a levy block casts no vote and the credit vote alone holds nothing; a veto-row block holds alone with zero votes", () => {
      const levy = [sign("Bank / insurer windfall taxes", true)];
      expect([ruled({ AT1: credit }, levy).hits, ruled({ AT1: credit }, levy).veto, holds({ AT1: credit }, levy)]).toEqual([["credit"], [], NONE]);
      for (const row of VETO_ROWS) expect([ruled({}, [sign(row, true)]), holds({}, [sign(row, true)])]).toMatchObject([{ hold: true, veto: [row], hits: [], clusters: ruled({}).clusters }, ALL]);
    });
    it("below quorum (a short history reads na) holds T2/T3 and frees T1; AT1 before its first close (none) leaves the denominator, still t1Only", () => {
      const short = series(rep(1, R.ESC_AT1_LOW_N));
      expect([ruled({ AT1: short }), holds({ AT1: short })]).toMatchObject([{ hold: false, quorum: { live: 0, n: 1, need: 1, t1Only: true } }, [[false, false], [true, true], [true, true]]]);
      expect(ruled({ AT1: [] }).quorum).toEqual({ live: 0, n: 0, need: 0, t1Only: true });
    });
    it("the box reaches the replay walk and the live verdict: below quorum holds every fill past T1; a veto holds the time stop with no esc gate row", () => {
      expect(replayFills(MET, { ...R, ...THIN, EXIT_DATE: dateAt(PRE + 20) }, dateAt(PRE + POST - 1))).toEqual([dateAt(PRE + 21), null, null]);
      const stop = { ...R, EXIT_DATE: SHOCK, TIME_STOP_N: POST - 1 };
      const noT1 = { ...MET, EXSH_GATE: UNMET.EXSH_GATE };
      const bare = LEGS.filter((d) => !d.key.endsWith("-esc"));
      expect([evaluate(noT1, stop, bare).tranches[0]!.via, evaluate(noT1, stop, bare, undefined, [VETO]).tranches[0]!.met], "no esc gate row: the time stop reads `boxHolds` through `tally` alone").toEqual(["time stop", false]);
      expect([shippedMET().tranches[0]!.met, evaluateShipped(MET, [VETO]).tranches[0]!.met]).toEqual([true, false]);
    });
  });
});

describe("weekend rows at the read seam", () => {
  it("a daily read drops a weekend-dated row (ICE's month-end mark); a monthly read keeps its weekend 1st", () => {
    const pts = [{ date: "2026-05-29", value: 2.68 }, { date: "2026-05-31", value: 2.73 }, { date: "2026-06-01", value: 2.65 }];
    expect(seriesPoints("u", { points: pts }).map((p) => p.date)).toEqual(["2026-05-29", "2026-06-01"]);
    expect(seriesPoints("u", { points: [{ date: "2026-08-01", value: 0.2 }] }, false)).toHaveLength(1);
  });
});

describe("redacted reads", () => {
  it("a redacted /api/series body throws — never reads as na (the 05811472 regime flip)", () => {
    expect(() => seriesPoints("u", { points: [{ date: "2026-10-09", value: null }], redacted: true })).toThrow(/redacted/);
    expect(seriesPoints("u", { points: [{ date: "2026-10-09", value: 3.2 }] })).toEqual([{ date: "2026-10-09", value: 3.2 }]);
  });
});

describe("hybrid guard at the AT1 site — wave 2 against the HALF line since the series' own shock", () => {
  const [ON, OFF] = [{ ...R, HYBRID_GUARDS: true }, { ...R, HYBRID_GUARDS: false }];
  const TICK = 1e-4;
  const at = (s: SeriesSet, key: string, r: Rules) => ((o) => [o.verdict, o.count?.got])(leg(s, key, r));

  it("t2-at1-guard (AT1 own episode): a tick above the line holds ×T2_AT1_GUARD_N, a tick under re-trips; flag off → the HIGH_N-close low trips the short close", () => {
    /** ratioWave: calm to 100, the trough RATIO_TROUGH, ×HIGH_N bounces (the turn, filling the rolling lookback), then wave 2's one close — its line ½ down from the bounce to the trough. */
    const line = ratioBounce() + HALF * (RATIO_TROUGH - ratioBounce());
    const at1 = (last: number) => series(ratioWave(R.HIGH_N, [last]));
    expect([at({ ...MET, AT1: at1(line + TICK) }, "t2-at1-guard", ON), at({ ...MET, AT1: at1(line - TICK) }, "t2-at1-guard", ON), at({ ...MET, AT1: at1(line + TICK) }, "t2-at1-guard", OFF)]).toEqual([
      ["met", R.T2_AT1_GUARD_N],
      ["unmet", 0],
      ["unmet", 0],
    ]);
  });
});
