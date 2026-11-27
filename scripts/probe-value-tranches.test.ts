import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findLicensedLevelsInLeg } from "../src/licensed-levels.js";
import { toVerdict, type LadderEvent, type LadderFamily, type LadderSign } from "../src/ladder-live.js";
import { retraceLine } from "../src/ladder-jobs.js";
import { DEEP_ROUTES } from "./ladder-replay-feeds.js";
import { driftSummary, episodes, fillDrift, HOLDOUT_WINDOW, REPLAY, type EpisodeResult, type ReplayKnobs } from "./ladder-replay.js";
import { calm, RATIO_TROUGH, ratioBounce, ratioWave, spreadWave, VOL_PEAK, VOL_PRE_MEDIAN, volShock } from "./ladder-replay.test-helpers.js";
import { HALF, openShockStart, shockOf, VOL_COOL, VOL_K } from "./ladder-shock.js";
import { realizedVol } from "./probe-eufin-tranches.js";
import { ARM_SERIES, boxBinds, DEEP_SHARED, measuredLifts, deepBuilders, FAMILY_IDS, FAMS, famNeed, tally, followOf, openExit, liveLimit, LEGS_SHIPPED, LIVE_ARM, LIVE_FEEDS, LIVE_SERVED, liveFeeds, asProbeResult, coverage, earnWindows, firesAt, MU_EARN_DATES, replayValue, whyFills, type EarnWindow, VALUE_ARM as A, VALUE_ARMS, rvMax, unservedReadsEmpty, worstDrop, compareReads, compareText, escalation, evaluateShipped, familyReads, LEGS, SERIES, SIGNS, tranchesAt, VALUE_RULES as R, VERDICT_IDS, verdictProvisional, VETO_ROWS, volOf, type Inputs, type LiveId, type Pt, type SeriesSet } from "./probe-value-tranches.js";

const N = R.HIGH_N + 10;
const dateOf = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
/** `dateOf` precomputed over the fixture range (every `series` row reads it); out-of-range or negative `i` falls back to the computed form. */
const DATES: readonly string[] = Array.from({ length: 1024 }, (_, i) => dateOf(i));
const dateAt = (i: number): string => DATES[i] ?? dateOf(i);
/** Final closes; a `state` applies to every row. */
const series = (vals: number[], state?: string): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value, ...(state && { state }) }));
const flat = (v: number, n = N): number[] => Array.from({ length: n }, () => v);
/** Flat at `high`, then one last close `dd` below it — the drawdown the zone reads. */
const dip = (high: number, dd: number): number[] => [...flat(high, N - 1), high * (1 - dd)];
/** The same drawdown, the drop day one close outside the veto's window — XDEV's zone fixtures, so no veto fires on them. */
const SETTLE = R.VETO_N + 1;
const settled = (high: number, dd: number): number[] => [...flat(high, N - SETTLE), ...flat(high * (1 - dd), SETTLE)];
const EPS = 1e-6;
/** `pct` as the probe prints it. */
const pc = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

const signRow = (sign: string, block = false): LadderSign => ({ sign, label: sign, lean: block ? "bear" : "open", finding: "", why: "", measurable: "", block, checked: null, due: null, primary: [], search: [], seed: [], sources: [] });
const SIGNS_OK: LadderSign[] = SIGNS.map((s) => signRow(s));
const blocking = (...ids: string[]): LadderSign[] => SIGNS.map((s) => signRow(s, ids.includes(s)));
/** `s` with HY at half its level until ESC_SPREAD_MA_N / 2 closes from the end — the tail then sits past ESC_HY_MA_K × its MA, so `credit_confirms` (the credit veto's measured half) trips; the step predates the HY guard's window. */
const hyUp = (s: SeriesSet): SeriesSet => ({ ...s, F1: s.F1.map((p, i) => (i < s.F1.length - R.ESC_SPREAD_MA_N / 2 ? { ...p, value: p.value! / 2 } : p)) });

/** Closes ending on XDEV's last date (`N − 1`), however many — a history longer than `N` starts before XDEV's. */
const backTo = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(N - vals.length + i), value }));
/** Every dash leg met: XDEV in the first third's zone, semis (SEC0) near its high, HY flat (no shock), yen calm, rel-strength GREEN, banks/rates quiet; R4 · KBE_RS and HY's ESC_SPREAD_MA_N-close history lift the box to quorum. */
const MET: SeriesSet = {
  R4: series(flat(1.5)),
  KBE_RS: series(flat(1)),
  XDEV: series(settled(100, R.ZONE_OPEN)),
  LEGP_SEMIS: series(flat(100)),
  F1: backTo(flat(4.6, R.ESC_SPREAD_MA_N)),
  F17: series(flat(150)),
  MU_RS: series(flat(1), "GREEN"),
  RS_SMH: series(flat(1), "GREEN"),
  HCX: series(flat(0)),
  R2: series(flat(R.ESC_DGS10 - 0.01)),
  KBE: series(flat(100)),
  HYNIX: series(flat(100)),
  AMAT: series(flat(100)),
  F8: series(flat(100)),
  KRW: series(flat(100)),
  COPPER: series(flat(100)),
};
/** Every dash leg unmet: XDEV at its high, semis (SEC0) well off its high, HY wide (flat: no shock, no box vote), yen crashed, both rel-strength RED, 10y at the block, KBE crashed. */
const UNMET: SeriesSet = {
  XDEV: series(flat(100)),
  LEGP_SEMIS: series(dip(100, R.SEMIS_OFF_HIGH_MAX)),
  F1: series(flat(6)),
  F17: series(dip(150, R.ESC_JPY_DROP)),
  MU_RS: series(flat(1), "RED"),
  RS_SMH: series(flat(1), "RED"),
  HCX: series(flat(0)),
  R2: series(flat(R.ESC_DGS10)),
  KBE: series(dip(100, R.ESC_KBE_DROP)),
  HYNIX: series(dip(100, 0.3)),
  AMAT: series(dip(100, 0.3)),
  F8: series(dip(100, 0.3)),
  KRW: series(dip(100, 0.3)),
  COPPER: series(dip(100, 0.3)),
};
const EMPTY: SeriesSet = Object.fromEntries(SERIES.map((id) => [id, []])) as unknown as SeriesSet;
const at = (s: SeriesSet, xdevDd: number): SeriesSet => ({ ...s, XDEV: series(settled(100, xdevDd)) });
/** The stacked arm the live roster replaced — its legs, gates and follow mechanics stay pinned on it. */
const S1 = VALUE_ARMS.find((a) => a.name.startsWith("S1 "))!;
const legsOf = (s: SeriesSet, signs: LadderSign[] = SIGNS_OK) => Object.fromEntries(evaluateShipped(s, signs, R, S1).legs.map((l) => [l.key, l.verdict]));
const tranche = (s: SeriesSet, signs: LadderSign[], t: "T1" | "T2" | "T3") => evaluateShipped(s, signs, R, S1).tranches.find((x) => x.tranche === t)!;
/** The tripped close rows (`familyReads`) — a close hit or a sign block. */
const families = (s: SeriesSet, signs: LadderSign[] = SIGNS_OK): string[] => familyReads({ s, signs }, R).fams.filter((f) => typeof f.hit === "string").map((f) => f.name);
/** The pre-stack roster (replay baseline) — the box, sign and T3-zone mechanics are pinned on it; the stack swaps T3's zone for a trend gate. */
const BASELINE = VALUE_ARMS[0]!;
const shipped = (s: SeriesSet, signs: LadderSign[]) => evaluateShipped(s, signs, R, BASELINE);

describe("roster", () => {
  it("the live roster is the famArm with rates (four voting families + the credit gate): LEGS is LIVE_ARM's defs, follow on, and the verdict's legs follow it", () => {
    expect([LEGS === LIVE_ARM.defs, LIVE_ARM.name, LIVE_ARM.families, LIVE_ARM.follow, LEGS === S1.defs]).toEqual([true, "P5 +rates", 4, true, false]);
    expect(evaluateShipped(MET, SIGNS_OK).legs.map((l) => l.key)).toEqual(LIVE_ARM.defs.map((d) => d.key));
  });
  it("time-stop and auto-follow arithmetic lives only in the arm block; the live verdict reaches it through followOf", () => {
    const parts = readFileSync(new URL("./probe-value-tranches.ts", import.meta.url), "utf8").split(/^\/\/ [▸◂] arms.*$/m);
    const [pre, block, post] = parts;
    expect([parts.length, block?.includes("TIME_STOP_N")], "one ▸/◂ arm block holding the time stop").toEqual([3, true]);
    for (const word of ["TIME_STOP", "AFTER_N", "cascade", "reached["]) expect(`${pre}${post}`.includes(word), word).toBe(false);
    expect(`${pre}`.includes("followOf(arm, c, signs, r, prior?.tranches"), "evaluateShipped wires the follow path off the prior verdict's latch").toBe(true);
  });
  it("evaluateShipped emits the shared verdict shape toVerdict folds", () => {
    const v = toVerdict(asProbeResult(evaluateShipped(MET, SIGNS_OK, R, S1)), false);
    expect(v.tranches.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    expect(v.live).toHaveLength(3);
    expect(v.legs.find((l) => l.key === "t1-zone")!.tip, "the expected cell's tooltip reaches the verdict leg").toContain(`its highest of the last ${R.HIGH_N} closes`);
  });
  it("gates per tranche: the first zone·veto·HY guard; the second adds the MU_RS guard, HCX and equal-weight gates; the last trades its zone for the rising-MA gate and has no veto", () => {
    const gates = (t: string, defs = S1.defs) => defs.filter((d) => d.tranche === t && d.gate).map((d) => d.key.slice(3));
    const added = ["mu-rs-guard", "hcx-gate", "ew-trend"];
    expect([gates("T1"), gates("T2"), gates("T3")]).toEqual([["zone", "veto", "hy-guard"], ["zone", "veto", "hy-guard", ...added], ["trend", "hy-guard", ...added]]);
    expect([gates("T1", LEGS_SHIPPED), gates("T2", LEGS_SHIPPED), gates("T3", LEGS_SHIPPED)], "pre-stack").toEqual([["zone", "veto", "hy-guard"], ["zone", "veto", "hy-guard"], ["zone", "hy-guard"]]);
  });
});

describe("legs", () => {
  it("each dash leg reads met on MET and unmet on UNMET", () => {
    const met = legsOf(MET);
    const unmet = legsOf(UNMET);
    for (const key of ["t1-smh", "t2-rs", "t2-kbe"]) {
      expect(met[key], `${key} met`).toBe("met");
      expect(unmet[key], `${key} unmet`).toBe("unmet");
    }
    expect(legsOf({ ...MET, MU_RS: series(flat(1), "RED") })["t2-rs"], "one RED is not both").toBe("met");
    expect(legsOf(at(MET, R.ZONE_T3))["t3-low"]).toBe("unmet");
    expect(legsOf({ ...MET, XDEV: series([...flat(100, N - 1), 90, 95].slice(-N)) })["t3-low"]).toBe("met");
  });
  it("an empty series reads na and drops out of the tally", () => {
    const legs = legsOf(EMPTY);
    for (const d of S1.defs.filter((l) => l.key !== "t2-esc" && l.key !== "t3-esc")) expect(legs[d.key], d.key).toBe("na");
    expect(tranche(EMPTY, SIGNS_OK, "T1").total).toBe(0);
    expect([legs["t2-esc"], legs["t3-esc"]], "no measured family read → the box criterion is na, not a tick").toEqual(["na", "na"]);
  });
  it("KBE trips the banks family and the second third's KBE leg at ESC_KBE_DROP inside ESC_KBE_N closes, not one tick less, not one close older", () => {
    const drop = (dd: number, closesAgo = 0): SeriesSet => ({ ...MET, KBE: series([...flat(100, N - 1 - closesAgo), 100 * (1 - dd), ...flat(100 * (1 - dd), closesAgo)]) });
    expect(legsOf(drop(R.ESC_KBE_DROP))["t2-kbe"]).toBe("unmet");
    expect(families(drop(R.ESC_KBE_DROP))).toEqual(["banks"]);
    expect(legsOf(drop(R.ESC_KBE_DROP - EPS))["t2-kbe"]).toBe("met");
    expect(families(drop(R.ESC_KBE_DROP - EPS))).toEqual([]);
    expect(families(drop(R.ESC_KBE_DROP, R.ESC_KBE_N - 2)), "high the oldest close of the window").toEqual(["banks"]);
    expect(families(drop(R.ESC_KBE_DROP, R.ESC_KBE_N - 1)), "high one close outside the window").toEqual([]);
  });
  it("worstDrop: the deepest close off the running high, trough after peak only, dated on the trough", () => {
    const pts = (v: number[]) => series(v).map((p, i) => ({ ...p, date: `2026-01-${String(i + 1).padStart(2, "0")}` }));
    expect(worstDrop(pts([80, 90, 100]), 3), "a rise after the window's low is no drop").toEqual({ dd: 0, troughDate: "2026-01-03" });
    expect(worstDrop(pts([100, 70, 90, 60, 100]), 5)).toEqual({ dd: -0.4, troughDate: "2026-01-04" });
    expect(worstDrop(pts([100, 50, 90, 80]), 2)?.dd, "the window starts at its own first close").toBeCloseTo(80 / 90 - 1);
    expect(worstDrop([], 5)).toBeNull();
  });
  it("KBE reads the worst peak-to-trough inside the window — a slide to ESC_KBE_DROP that bounces still trips", () => {
    const trough = 100 * (1 - R.ESC_KBE_DROP);
    const bounced: SeriesSet = { ...MET, KBE: series([...flat(100, N - 2), trough, trough * 1.05]) };
    expect(legsOf(bounced)["t2-kbe"]).toBe("unmet");
    expect(families(bounced)).toEqual(["banks"]);
  });
  it("the 10y level trips the rates family at ESC_DGS10, not under it", () => {
    expect(families({ ...MET, R2: series(flat(R.ESC_DGS10)) })).toEqual(["rates"]);
    expect(families({ ...MET, R2: series(flat(R.ESC_DGS10 - EPS)) })).toEqual([]);
  });
  it("CCC is no Value input: credit reads HY only (user 2026-10-20)", () => {
    expect(["CCC"].filter((id) => ([...SERIES, ...ARM_SERIES] as readonly string[]).includes(id)), "CCC left Value's inputs and the credit family (user 2026-10-20)").toEqual([]);
  });
});

describe("manual rows", () => {
  it("a VETO_ROWS block holds T2·T3 alone on a calm box; any other blocking row holds none — it trips its box family row only", () => {
    const deep = (signs: LadderSign[]) => shipped(at(MET, R.ZONE_T3), signs);
    const ok = deep(SIGNS_OK);
    for (const id of SIGNS.filter((g) => g !== "phl_orders")) {
      const b = deep(blocking(id));
      const veto = (VETO_ROWS as readonly string[]).includes(id);
      expect(b.tranches.map((t) => [t.clear, t.gates]), id).toEqual(ok.tranches.map((t, k) => [!(veto && k > 0) && t.clear, t.gates]));
      expect([b.escalation.hold, b.escalation.holdT2T3], id).toEqual([false, veto]);
      expect(families(at(MET, R.ZONE_T3), blocking(id)).length, `${id}: credit has no close row, its sign rides credit_confirms only`).toBe(id === "credit" ? 0 : 1);
    }
    expect(ok.tranches.map((t) => t.clear)).toEqual([false, true, true]);
  });
});

/** `n` alternating ±`a` log-returns about 100 — σ of the returns ≈ `a`. */
const wiggle = (n: number, a: number, from = 100): number[] => Array.from({ length: n }, (_, i) => from * Math.exp(i % 2 ? a : 0));
const sdOf = (c: number[]): number => {
  const r = c.slice(1).map((v, i) => Math.log(v / c[i]!));
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1));
};

describe("veto", () => {
  /** A wiggling XDEV with one drop of `k` × VETO_SD σ, `ago` closes before the last (0 = the last close), flat after it. */
  const drop = (k: number, ago: number): number[] => {
    const base = wiggle(N - ago - 1, 0.01);
    const cap = R.VETO_SD * sdOf(base.slice(-(R.SIGMA_N + 1)));
    const low = base.at(-1)! * Math.exp(-k * cap);
    return [...base, low, ...flat(low, ago)];
  };
  it("a daily drop past −VETO_SD σ inside the last VETO_N closes vetoes the first two thirds; one close older, or under the cap, does not", () => {
    const veto = (xdev: number[]) => ((l) => [l["t1-veto"], l["t2-veto"]])(legsOf({ ...MET, XDEV: series(xdev) }));
    expect(veto(drop(1.05, 0))).toEqual(["unmet", "unmet"]);
    expect(veto(drop(1.05, R.VETO_N - 1)), "the oldest close of the window").toEqual(["unmet", "unmet"]);
    expect(veto(drop(1.05, R.VETO_N)), "one close outside the window").toEqual(["met", "met"]);
    expect(veto(drop(0.95, 0)), "under the cap").toEqual(["met", "met"]);
  });
  it("MU vetoes on a fixed MU_VETO_CAP drop, whatever its σ: a −9% day vetoes even on a 5%-σ wiggle, a −7% day passes even when flat", () => {
    const mu = (base: number[], down: number) => legsOf({ ...MET, F8: series([...base, base.at(-1)! * (1 - down)]) })["t1-veto"];
    expect([mu(flat(100, N - 1), R.MU_VETO_CAP + 0.01), mu(wiggle(N - 1, 0.05), R.MU_VETO_CAP + 0.01), mu(flat(100, N - 1), R.MU_VETO_CAP - 0.01)]).toEqual(["unmet", "unmet", "met"]);
    expect([mu(flat(100, N - 1), R.MU_VETO_CAP - 0.001), mu(flat(100, N - 1), R.MU_VETO_CAP)], "a simple-return cap: −7.9% passes, exactly −8% vetoes").toEqual(["met", "unmet"]);
    expect(evaluateShipped({ ...MET, F8: series([...flat(100, N - 1), 100 * (1 - R.MU_VETO_CAP + 0.002)]) }, SIGNS_OK, R, S1).legs.find((l) => l.key === "t1-veto")!.value).toContain("MU -7.8%");
    expect(evaluateShipped({ ...MET, F8: series([...flat(100, N - 1), 100 * (1 - R.MU_VETO_CAP + 0.0004)]) }, SIGNS_OK, R, S1).legs.find((l) => l.key === "t1-veto")!.value, "a return that rounds onto the cap widens").toContain("MU -7.96%/-8%");
  });
  it("a Micron crash day alone vetoes; XDEV calm", () => {
    expect(legsOf({ ...MET, F8: UNMET.F8 })["t1-veto"]).toBe("unmet");
    expect(tranche({ ...MET, F8: UNMET.F8 }, SIGNS_OK, "T1")).toMatchObject({ clear: false, ready: false });
    expect(tranche(MET, SIGNS_OK, "T1")).toMatchObject({ clear: true, ready: true, metCount: 1, total: 2 });
    expect(tranche({ ...MET, LEGP_SEMIS: UNMET.LEGP_SEMIS }, SIGNS_OK, "T1"), "both criteria short: NEED_SLACK forgives one only").toMatchObject({ clear: true, ready: false, metCount: 0 });
  });
});

describe("guards", () => {
  /** HY OAS flat, with one new high `ago` closes before the last that the closes after it only match. */
  const hyHigh = (ago: number): SeriesSet => ((v) => ({ ...MET, F1: series([...flat(v, N - ago - 1), v + 0.001, ...flat(v + 0.001, ago)]) }))(MET.F1[0]!.value!);
  /** The HY guard verdicts per tranche on the stack (`legsOf`) and on the live arm (`LEGS`) — the same rows on both. */
  const g = (ago: number, live = false) => ((l) => [l["t1-hy-guard"], l["t2-hy-guard"], l["t3-hy-guard"]])(live ? Object.fromEntries(evaluateShipped(hyHigh(ago), SIGNS_OK).legs.map((x) => [x.key, x.verdict])) : legsOf(hyHigh(ago)));
  it("a new GUARD_HIGH_N-close HY high inside a tranche's window holds it; one close older passes — on the live arm too, beside its credit gate", () => {
    expect(g(R.T1_HY_GUARD_N - 1)).toEqual(["unmet", "unmet", "unmet"]);
    expect(g(R.T1_HY_GUARD_N)).toEqual(["met", "unmet", "unmet"]);
    expect(g(R.T2_HY_GUARD_N - 1)).toEqual(["met", "unmet", "unmet"]);
    expect(g(Math.max(R.T2_HY_GUARD_N, R.T3_HY_GUARD_N))).toEqual(["met", "met", "met"]);
    expect([g(R.T1_HY_GUARD_N - 1, true), g(R.T1_HY_GUARD_N, true)], "live arm").toEqual([["unmet", "unmet", "unmet"], ["met", "unmet", "unmet"]]);
    const held = (ago: number) => evaluateShipped(hyHigh(ago), SIGNS_OK).tranches[0]!.gates.filter((v) => v === "unmet").length;
    expect(held(R.T1_HY_GUARD_N - 1) - held(R.T1_HY_GUARD_N), "the live T1 guard is a gate of the first third").toBe(1);
  });
  it("the HY guard looks back GUARD_HIGH_N closes: an older higher close does not stop a new high, one inside the lookback does", () => {
    const v = MET.F1[0]!.value!;
    const f1 = (gap: number): SeriesSet => ({ ...MET, F1: series([...flat(v, N - gap - 2), v + 0.002, ...flat(v, gap), v + 0.001]) });
    expect(legsOf(f1(R.GUARD_HIGH_N))["t1-hy-guard"], "prior high one close outside the lookback").toBe("unmet");
    expect(legsOf(f1(R.GUARD_HIGH_N - 1))["t1-hy-guard"], "prior high the lookback's oldest close").toBe("met");
  });
});

describe("sliding references anchor on the open episode's shockStart", () => {
  /** calm() ends on its high 100 at H; `fall(n)` = n closes −1% / −0.2% alternating — the first exits, none rises, so the episode stays open. */
  const H = REPLAY.VOL_N;
  const fall = (n: number): number[] => Array.from({ length: n }).reduce<number[]>((a, _, k) => [...a, a.at(-1)! * (k % 2 ? 0.998 : 0.99)], [100]).slice(1);
  const OPEN = [...calm(), ...fall(R.HIGH_N + 10)];
  /** One close back at the high ends the episode — and is itself the HIGH_N-close high. */
  const CLOSED = [...OPEN, 100];
  /** Short of an episode's VOL_N + 1 closes, long enough for both RV windows: the rolling read alone. */
  const SHORT = Math.max(R.SIGMA_N, R.RV_N) + 1;
  it("premise: OPEN anchors on calm's high, CLOSED on nothing; SHORT holds no episode", () => {
    expect([openShockStart(series(OPEN)), openShockStart(series(CLOSED))]).toEqual([dateAt(H), null]);
    expect(SHORT).toBeLessThan(REPLAY.VOL_N + 1);
  });
  it("volOf: an open XDEV episode moves the base (and the RV-peak scan) to shockStart; closed, it reads the HIGH_N-close high as before", () => {
    const c = series(OPEN);
    // monotone fall: the HIGH_N-close high is the window's first close
    expect([volOf(c, R)!.base, realizedVol(c, c.length - R.HIGH_N, R.SIGMA_N)]).toEqual([realizedVol(c, H, R.SIGMA_N), expect.not.closeTo(realizedVol(c, H, R.SIGMA_N)!, 6)]);
    const pick = (vals: number[]) => ((x) => [x.now, x.peak, x.base])(volOf(series(vals), R)!);
    expect(pick(CLOSED)).toEqual(pick(CLOSED.slice(-SHORT)));
    expect(pick(CLOSED)[2], "vacuity: a stale shockStart anchor reads another base").not.toBe(realizedVol(series(CLOSED), H, R.SIGMA_N));
  });
  it("rvMax: prefixes walked forward read off the memo as a fresh scan; a different close in the scanned range or its RV window re-scans", () => {
    const c = series(Array.from({ length: 90 }, (_, i) => 100 + 8 * Math.sin((i * i) / 7)));
    const F = R.RV_N + 4;
    const fresh = (a: Pt[], hi: number) => rvMax(a.map((p) => ({ ...p })), F, hi, R.RV_N);
    const his = Array.from({ length: c.length - F }, (_, j) => F + j);
    const got = his.map((hi) => rvMax(c.slice(0, hi + 1), F, hi, R.RV_N));
    expect(got).toEqual(his.map((hi) => fresh(c.slice(0, hi + 1), hi)));
    expect(new Set(got.map((g) => g.at)).size, "vacuity: the peak moves along the walk").toBeGreaterThan(2);
    const hi = c.length - 1;
    for (const k of [F + 5, F - 2]) {
      const a = c.slice();
      rvMax(a, F, hi, R.RV_N);
      a[k] = { ...a[k]!, value: a[k]!.value! * 1.5 };
      expect(rvMax(a, F, hi, R.RV_N), `close ${k} replaced in place`).toEqual(fresh(a, hi));
      expect(fresh(a, hi), "vacuity: the replaced close moves the peak").not.toEqual(got.at(-1));
    }
  });
  it("SEC0 off-high: open → off the shockStart close, where the HIGH_N-close high reads 0%; closed → the HIGH_N-close read", () => {
    const low = 100 * (1 - 1.5 * R.SEMIS_OFF_HIGH_MAX);
    const open = [...calm(), ...flat(low, R.HIGH_N + 1)];
    const { rise } = episodes(series(open), { ...REPLAY, FROM: "" }).at(-1)!;
    const closed = [...open, low * (1 + rise)];
    const smh = (vals: number[]) => LEGS_SHIPPED.find((d) => d.key === "t1-smh")!.read(R, { s: { ...MET, LEGP_SEMIS: series(vals) }, signs: [] });
    expect([openShockStart(series(open)), openShockStart(series(closed))], "premise").toEqual([dateAt(H), null]);
    expect([smh(open).verdict, smh(open).value.startsWith(pc(low / 100 - 1)), smh(open.slice(-R.HIGH_N)).verdict]).toEqual(["unmet", true, "met"]);
    expect([smh(closed), smh(closed).verdict]).toEqual([smh(closed.slice(-R.HIGH_N)), "met"]);
  });
});

describe("vol XDEV realized", () => {
  /** Calm to a high at close `H` (≥ SIGMA_N closes in, so it has a base), then `stormN` stormy closes and `calmN` calm ones, drifting down. */
  const H = R.SIGMA_N + 5;
  const path = (stormN: number, calmN: number, calmA = 0.0015): SeriesSet => {
    const up = wiggle(H + 1, 0.002).map((v, i) => v * (1 + 0.001 * i));
    const after = [...Array.from({ length: stormN }, (_, i) => (i % 2 ? 1.02 : 0.975)), ...Array.from({ length: calmN }, (_, i) => (i % 2 ? 1 + calmA : 1 - calmA))];
    const tail = after.reduce<number[]>((a, m) => [...a, a.at(-1)! * m], [up.at(-1)!]).slice(1);
    return { ...MET, XDEV: series([...up, ...tail]) };
  };
  const vol = (s: SeriesSet) => ((l) => [l["t1-vol"], l["t2-vol"], l["t3-vol"]])(legsOf(s));
  it("still stormy: the first third has not rolled over, both baselines exceeded", () => {
    expect(vol(path(R.RV_SLOW_N + 4, 0))).toEqual(["unmet", "unmet", "unmet"]);
  });
  it("storm then RV_N calm closes: the first third's RV rolled off its peak and under its lagged self, the second's back under base, the last's slow window still stormy", () => {
    expect(vol(path(R.RV_N, R.RV_N))).toEqual(["met", "met", "unmet"]);
  });
  it("storm then a full slow window calm: RV no longer falls, yet the first third reads met off the second's level — it never trails it", () => {
    expect(vol(path(R.RV_N, R.RV_SLOW_N + 2))).toEqual(["met", "met", "met"]);
  });
  it("flat vol, no fade: the first third reads the second's level — met under T2_RV_MULT × base, unmet over it", () => {
    const ratio = (a: number) => ((v) => v!.now / v!.base!)(volOf(path(0, R.SIGMA_N, a).XDEV, R));
    expect([ratio(0.0026) < R.T2_RV_MULT, ratio(0.0032) > R.T2_RV_MULT]).toEqual([true, true]);
    expect([0.0026, 0.0032].map((a) => vol(path(0, R.SIGMA_N, a))[0])).toEqual(["met", "unmet"]);
  });
  it("a vol read is a criterion, never a gate", () => {
    const vols = LEGS.filter((l) => l.leg === "vol XDEV realized");
    expect(vols.map((d) => d.key)).toEqual(["t1-vol", "t2-vol", "t3-vol"]);
    for (const d of vols) expect(d.gate, d.key).toBeFalsy();
  });
});

describe("zone gate", () => {
  it("the first third opens at ZONE_OPEN and is closed one tick above it", () => {
    expect(tranche(at(MET, R.ZONE_OPEN), SIGNS_OK, "T1").gates[0]).toBe("met");
    expect(tranche(at(MET, R.ZONE_OPEN - EPS), SIGNS_OK, "T1").gates[0]).toBe("unmet");
  });
  it("the second and last thirds open at their own zone constants", () => {
    expect(tranche(at(MET, R.ZONE_T2), SIGNS_OK, "T2").gates[0]).toBe("met");
    expect(tranche(at(MET, R.ZONE_T2 - EPS), SIGNS_OK, "T2").gates[0]).toBe("unmet");
    expect(shipped(at(MET, R.ZONE_T3), SIGNS_OK).tranches[2]!.gates[0], "pre-stack T3 zone").toBe("met");
    expect(shipped(at(MET, R.ZONE_T3 - EPS), SIGNS_OK).tranches[2]!.gates[0], "pre-stack T3 zone").toBe("unmet");
  });
});

describe("escalation box", () => {
  const oneHit: SeriesSet = { ...MET, R2: series(flat(R.ESC_DGS10)) };
  it("a lone manual block trips its family row but neither the box nor the pre-stack 'box at 0' criterion (one close trip fails it); the live box gate row prints votes · veto · live/n vs quorum", () => {
    const deep = (s: SeriesSet, signs: LadderSign[]) => legsOf(at(s, R.ZONE_T3), signs);
    expect([families(MET, blocking("dram_contract")), escalation({ s: MET, signs: blocking("dram_contract") }, R).hits]).toEqual([["Micron"], []]);
    for (const id of ["dram_contract", "capex"]) expect([deep(MET, blocking(id))["t2-esc"], deep(MET, blocking(id))["t3-esc"]], id).toEqual(["met", "met"]);
    expect(tranchesAt({ s: at(MET, R.ZONE_T3), signs: blocking("dram_contract") }, R, LEGS_SHIPPED)[1]!.ready, "a Micron block leaves the second third ready").toBe(true);
    expect([deep(oneHit, SIGNS_OK)["t2-esc"], deep(oneHit, SIGNS_OK)["t3-esc"]]).toEqual(["unmet", "unmet"]);
    const box = (s: SeriesSet, signs: LadderSign[], key = "t1-esc") => LEGS.find((l) => l.key === key)!.read(R, { s, signs });
    const vetoed = "votes — · veto credit · live 3/3 need 3";
    expect([box(MET, SIGNS_OK), box(oneHit, blocking("capex")), box(MET, blocking("credit")), box(MET, blocking("credit"), "t2-esc")]).toEqual([{ value: "votes — · live 3/3 need 3", verdict: "met" }, { value: "votes — · live 3/3 need 3", verdict: "met" }, { value: vetoed, verdict: "met" }, { value: vetoed, verdict: "unmet" }]);
    expect(["t1-esc", "t2-esc", "t3-esc"].map((k) => LEGS.find((l) => l.key === k)!.rule(R))).toEqual(Array(3).fill(`no coincident + lead vote · no ${VETO_ROWS.join("/")} veto (T1: credit once credit_confirms trips, rates once rates_jump trips) · T2·T3: live ≥ quorum`));
  });
  it("families: one row per FAMILIES entry — a block forces ✗ whatever the close, a blind close reads n/a, Micron and capex read off their signs alone; a dropped close row's signs and near ride its member", () => {
    const fams = (s: SeriesSet, signs: LadderSign[] = SIGNS_OK) => Object.fromEntries(escalation({ s, signs }, R).families.map((f) => [f.name, f])) as Record<"Micron" | "yen" | "capex", LadderFamily>;
    const calm = fams(MET);
    expect(Object.keys(calm)).toEqual(["Micron", "yen", "capex"]);
    expect([calm.capex.value, calm.capex.verdict, calm.capex.signs.map((g) => g.sign), calm.yen.live]).toEqual(["—", "met", ["capex", "ai_revenue"], { value: calm.yen.value, verdict: calm.yen.verdict }]);
    expect([calm.Micron.value, calm.Micron.verdict, calm.Micron.signs.map((g) => g.sign)]).toEqual(["—", "met", ["dram_contract", "hbm", "mu_strike", "kr_chip_ex"]]);
    const members = (s: SeriesSet) => Object.fromEntries(escalation({ s, signs: SIGNS_OK }, R).clusters.flatMap((c) => c.members).map((m) => [m.id, m]));
    const m = members(MET);
    expect([m.rates_jump!.signs, m.rates_jump!.near, m.credit_confirms!.signs?.map((g) => g.sign), m.kbe_rs_drop!.signs]).toEqual([[{ sign: "rates", lean: "open", block: false }], true, ["credit"], undefined]);
    expect("near" in members({ ...MET, R2: UNMET.R2 }).rates_jump!, "a tripped close row is no near-miss").toBe(false);
    const blind = fams({ ...MET, F17: [] }, blocking("jpy_carry"));
    expect(blind.yen).toMatchObject({ value: "n/a", verdict: "unmet" });
    expect(fams({ ...MET, F17: [] }, []).yen, "blind with no sign row").toMatchObject({ value: "n/a", verdict: "na", signs: [] });
  });
  it("the live pass: each family's live cell re-reads the latest prints, est.-tagged; FAMILY_IDS is exactly what the family rows read", () => {
    const head = (c: Pt[], value: number): Pt[] => [...c, { date: dateAt(N), value, estimated: true }];
    const s: SeriesSet = { ...MET, F17: head(MET.F17, 150 * (1 - R.ESC_JPY_DROP)) };
    const res = evaluateShipped(s, SIGNS_OK);
    const f = Object.fromEntries(res.escalation.families.map((x) => [x.name, x]));
    expect([f.yen!.verdict, f.yen!.live]).toEqual(["met", { value: `JPY ${pc(-R.ESC_JPY_DROP)}/${pc(-R.ESC_JPY_DROP)} est.`, verdict: "unmet" }]);
    expect(f.capex!.live, "sign-only: the close cell in both").toEqual({ value: "—", verdict: "met" });
    const seen = new Set<string>();
    familyReads({ s: new Proxy({} as SeriesSet, { get: (_t, k) => (typeof k === "string" && seen.add(k), []) }), signs: [] }, R);
    expect([...seen].sort()).toEqual([...new Set(Object.values(FAMILY_IDS).flat())].sort());
  });
  it("family trips cast no vote: a rates close trip, alone or beside a capex block, leaves every tranche as clear as none", () => {
    const one = shipped(at(oneHit, R.ZONE_T3), SIGNS_OK);
    const two = shipped(at(oneHit, R.ZONE_T3), blocking("capex"));
    expect([families(at(oneHit, R.ZONE_T3), blocking("capex")), two.escalation.hits, two.escalation.hold]).toEqual([["rates", "capex"], [], false]);
    expect([one, two].map((r) => r.tranches.map((t) => t.clear))).toEqual([[false, true, true], [false, true, true]]);
    expect(one.tranches[0]!.gates[0]).toBe("unmet");
  });
  it("UNMET trips every close-read family", () => {
    expect(families(UNMET)).toEqual(["banks", "yen", "rates"]);
  });
  it("near-miss: an untripped family past 1 − ESC_NEAR of the way to its trigger, or a level within ESC_NEAR_GAP of it, is named, closest first; a calm or tripped family is not", () => {
    const climb = (to: number): Pt[] => series([...flat(5, N - 1), to]);
    const near = (s: Partial<SeriesSet>) => escalation({ s: { ...MET, R2: series(flat(5)), ...s }, signs: SIGNS_OK }, R).near;
    expect(near({})).toEqual([]);
    expect(near({ R2: climb(5.3) })).toEqual(["rates 5.30/5.35"]);
    expect(near({ R2: climb(5.2) }), "past neither the progress line nor the gap floor").toEqual([]);
    expect(near({ R2: series(flat(R.ESC_DGS10 - 0.01)) }), "parked a bp under its trigger: the gap floor names it").toEqual(["rates 5.34/5.35"]);
    expect(near({ R2: series([...flat(5.25, N - 1), 5.3]) }), "inside the gap floor, under the progress line").toEqual(["rates 5.30/5.35"]);
    expect(near({ R2: climb(5.34), F17: series(dip(150, R.ESC_JPY_DROP * 0.8)) })).toEqual(["rates 5.34/5.35", "yen -6.4%/-8.0%"]);
    expect(near({ R2: climb(R.ESC_DGS10) })).toEqual([]);
  });
  it("yen trips on F17 past ESC_JPY_DROP or a jpy_carry block; no close and no row is unread", () => {
    const fell: SeriesSet = { ...MET, F17: series(dip(150, R.ESC_JPY_DROP)) };
    expect([families(fell), families(MET, blocking("jpy_carry"))]).toEqual([["yen"], ["yen"]]);
    const box = (s: SeriesSet, signs: typeof SIGNS_OK) => S1.defs.find((l) => l.key === "t2-esc")!.read(R, { s, signs }).value;
    expect([box(MET, blocking("jpy_carry")), box(fell, SIGNS_OK)], "the pre-stack box cell names close-read trips only").toEqual(["0/3", "1/3 (yen)"]);
    expect(families({ ...MET, F17: [] }, blocking("jpy_carry"))).toEqual(["yen"]);
    expect(escalation({ s: { ...MET, F17: [] }, signs: [] }, R).unread).toContain("yen");
  });
  it("a kr_chip_ex block trips Micron; phl_orders feeds no family, so its block throws", () => {
    expect(families(MET, blocking("kr_chip_ex"))).toEqual(["Micron"]);
    expect(() => escalation({ s: MET, signs: blocking("phl_orders") }, R)).toThrow(/"phl_orders" feeds no box family/);
  });
  it("no id reads empty when the deployed build does not serve it: every unserved id's 400 throws", () => {
    const body = '{"error":"id must be one of: F1, KBE"}';
    expect(SERIES.filter((id) => unservedReadsEmpty(id, 400, body))).toEqual([]);
  });
  it("a family with no sign row or no close is unread, not tripped", () => {
    const e = escalation({ s: MET, signs: [] }, R);
    expect(families(MET, [])).toEqual([]);
    expect([e.unread, escalation({ s: { ...MET, F17: [] }, signs: [] }, R).unread]).toEqual([["Micron", "capex"], ["Micron", "yen", "capex"]]);
    const closeless = { ...MET, KBE: [], R2: [] };
    const shippedBox = (s: SeriesSet) => S1.defs.find((l) => l.key === "t2-esc")!.read(R, { s, signs: SIGNS_OK });
    expect(shippedBox(closeless), "the pre-stack cell names its blind close reads, met while any reads clear").toEqual({ value: "0/3 · no close banks, rates", verdict: "met" });
    expect(shippedBox({ ...closeless, F17: [] }), "every close read blind → na").toEqual({ value: "0/3 · no close banks, yen, rates", verdict: "na" });
  });
});

describe("clustered box (CLUSTERS · VETO_ROWS)", () => {
  const ruled = (s: Partial<SeriesSet>, signs: LadderSign[] = SIGNS_OK) => escalation({ s: { ...EMPTY, ...s }, signs }, R);
  const raw = (t: "T1" | "T2" | "T3") => LEGS.filter((d) => d.tranche === t).map((d) => ({ key: d.key, tranche: t, gate: d.gate ?? false, value: "", verdict: "met" as const }));
  /** Per tranche: [`tally` held with every row met, its esc gate row unmet] off the ruled box. */
  const holds = (s: Partial<SeriesSet>, signs: LadderSign[] = SIGNS_OK) => ((x) => (["T1", "T2", "T3"] as const).map((t) => [!tally(t, raw(t), R, escalation(x, R)).clear, LEGS.find((d) => d.key === `${t.toLowerCase()}-esc`)!.read(R, x).verdict === "unmet"]))({ s: { ...EMPTY, ...s }, signs });
  const [NONE, ALL] = [[[false, false], [false, false], [false, false]], [[true, true], [true, true], [true, true]]];
  const spread = (calmV: number, lastV: number): Pt[] => series([...flat(calmV, R.ESC_SPREAD_MA_N), lastV]);
  const calmBox = { F1: spread(3, 3), KBE_RS: series(flat(1, R.ESC_KBE_RS_N + 1)), R2: series(flat(4, R.ESC_RATES_DELTA_N + 1)), R4: series(flat(2, R.ESC_RATES_DELTA_N + 1)) };
  const credit = { F1: spread(3, 4) };
  const rates = { R2: series([...flat(4, R.ESC_RATES_DELTA_N), 4 + R.ESC_DGS10_DELTA]), R4: series([...flat(2, R.ESC_RATES_DELTA_N), 2 + R.ESC_REAL_DELTA]) };
  it("credit + rates-shock votes hold every tranche; tripped · need · hits = the votes, one per Kind", () => {
    const s = { ...calmBox, ...credit, ...rates };
    expect([ruled(s).clusters.filter((c) => c.vote).map((c) => c.name), ruled(s)]).toMatchObject([["credit", "rates-shock"], { tripped: 2, need: 2, hits: ["credit", "rates-shock"], hold: true, veto: [], quorum: { live: 3, n: 3, t1Only: false } }]);
    expect([holds(calmBox), holds(s), holds({ ...calmBox, ...credit })]).toEqual([NONE, ALL, NONE]);
    expect(ruled({ ...calmBox, R2: rates.R2 }).clusters.filter((c) => c.vote), "Kleene AND: 10y without DFII10 casts no vote").toEqual([]);
    const banks = { ...calmBox, ...credit, KBE_RS: series([...flat(1, R.ESC_KBE_RS_N), 1 - R.ESC_KBE_RS_DROP]) };
    expect([ruled(banks).clusters.filter((c) => c.vote).map((c) => c.name), ruled(banks).hold], "two coincident votes, no lead: no hold").toEqual([["credit", "bank-funding"], false]);
  });
  it("demoted sign rows cast no vote: yen (F17 crash + jpy_carry) · capex · ai_revenue blocks beside credit hold nothing; a credit or rates block (veto) holds T2·T3 alone with zero votes, all three once its measured member trips", () => {
    const s = { ...calmBox, ...credit, F17: series([...flat(150, R.ESC_JPY_N - 1), 150 * (1 - R.ESC_JPY_DROP)]) };
    const rows = blocking("jpy_carry", "capex", "ai_revenue");
    expect(families({ ...EMPTY, ...s }, rows), "premise: both sign-row families trip").toEqual(["yen", "capex"]);
    expect([ruled(s, rows).clusters.filter((c) => c.vote).map((c) => c.name), ruled(s, rows).hold, holds(s, rows)]).toEqual([["credit"], false, NONE]);
    const T2T3 = [[false, false], [true, true], [true, true]];
    for (const id of ["credit", "rates"]) expect([ruled(calmBox, blocking(id)), holds(calmBox, blocking(id))], id).toMatchObject([{ hold: false, holdT2T3: true, veto: [id], clusters: ruled(calmBox).clusters.map(({ name, vote, hits, live }) => ({ name, vote, hits, live })) }, T2T3]);
    for (const [id, trip] of [["credit", credit], ["rates", rates]] as const) expect([holds({ ...calmBox, ...trip }), holds({ ...calmBox, ...trip }, blocking(id))], id).toEqual([NONE, ALL]);
  });
  it("members carry their trips-when rule and the read judged; short or absent history says so; live re-reads the live inputs, est.-tagged", () => {
    const [M, K] = [R.ESC_SPREAD_MA_N, R.ESC_KBE_RS_N];
    const s = { ...EMPTY, ...calmBox, ...credit, KBE_RS: series([...flat(1, K), 0.95]), R4: [] };
    const liveKbe = series([...flat(1, K), 1 - R.ESC_KBE_RS_DROP]).map((p, i) => (i === K ? { ...p, estimated: true } : p));
    const e = escalation({ s, signs: SIGNS_OK }, R, { x: { s: { ...s, KBE_RS: liveKbe }, signs: SIGNS_OK }, s: { ...s, KBE_RS: liveKbe } as Record<LiveId, Pt[]>, at: liveKbe.at(-1)!.date });
    const m = Object.fromEntries(e.clusters.flatMap((c) => c.members).map((x) => [x.id, x]));
    const hyRead = (calmV: number, lastV: number): string => ((ma) => `HY ${lastV.toFixed(2)}/${(R.ESC_HY_MA_K * ma).toFixed(2)} (MA${M} ${ma.toFixed(2)})`)((calmV * (M - 1) + lastV) / M);
    expect(m).toMatchObject({
      credit_confirms: { cell: "hit", rule: `HY ≥ ${R.ESC_HY_MA_K}× its MA${M}`, value: hyRead(3, 4) },
      kbe_rs_drop: { cell: false, rule: `KBE/SPY ≤ −${R.ESC_KBE_RS_DROP * 100}% over ${K} closes`, value: `KBE/SPY -5.0%/-${(R.ESC_KBE_RS_DROP * 100).toFixed(1)}%`, live: `KBE/SPY -${(R.ESC_KBE_RS_DROP * 100).toFixed(1)}%/-${(R.ESC_KBE_RS_DROP * 100).toFixed(1)}% est.`, liveCell: "hit" },
      rates_jump: { cell: false, value: "10y +0bp · 10y RY no history" },
    });
  });
  it("below quorum (short history reads na) holds T2/T3 and leaves T1 to the box's hold; the same members before their first point (none) leave the denominator", () => {
    const short = { ...calmBox, F1: series(flat(3, R.ESC_SPREAD_MA_N - 1)), R2: series(flat(4, R.ESC_RATES_DELTA_N)), R4: series(flat(2, R.ESC_RATES_DELTA_N)) };
    expect([ruled(short), holds(short)]).toMatchObject([{ hold: false, quorum: { live: 1, n: 3, t1Only: true } }, [[false, false], [true, true], [true, true]]]);
    const pre = { KBE_RS: calmBox.KBE_RS };
    expect([ruled(pre), holds(pre)]).toMatchObject([{ hold: false, quorum: { live: 1, n: 1, t1Only: false } }, NONE]);
  });
});

describe("each third on its own legs", () => {
  it("the second third is met while the first is unmet", () => {
    const deep = tranchesAt({ s: at(MET, R.ZONE_T3), signs: SIGNS_OK }, R, LEGS_SHIPPED);
    expect(deep.map((t) => t.ready)).toEqual([false, true, true]);
    expect(deep[0]!.gates[0]).toBe("unmet");
    expect(deep[2]).toMatchObject({ gates: ["met", "met"], clear: true, metCount: 1, total: 2 });
  });
});

describe("comparator display reads", () => {
  /** Closes rising by `step` up to the `peak`-th close, then flat under it: the high sits at index `peak - 1`. */
  const peakAt = (peak: number, step = 0.1): number[] => Array.from({ length: N }, (_, i) => (i < peak ? 100 + step * (i + 1) : 100));
  it("prints each name off its own high and names the earlier high as the one that broke first", () => {
    const k = compareReads({ ...MET, HYNIX: series(peakAt(N - 10)), F8: series(peakAt(N - 3)) }, R);
    expect(k.hynix!.highDate).toBe(dateAt(N - 11));
    expect(k.mu!.highDate).toBe(dateAt(N - 4));
    expect(k.hynix!.dd).toBeCloseTo(100 / (100 + 0.1 * (N - 10)) - 1, 9);
    expect(k.first).toBe("HYNIX");
    expect(compareReads({ ...MET, HYNIX: series(peakAt(N - 3)), F8: series(peakAt(N - 10)) }, R).first).toBe("MU");
    expect(compareReads(MET, R).first).toBe("same day");
    expect(compareReads({ ...MET, HYNIX: [] }, R)).toMatchObject({ hynix: null, first: null });
    const lines = compareText(k, R);
    expect(lines[0]).toContain("Hynix broke its high first");
    expect(lines[0]).toContain(`(${R.HIGH_N}-close highs)`);
    for (const l of lines) expect(l).toContain("display only, never a gate");
  });
  it("reads the AMAT:MU ratio against the ratio's own MA, aligned by date", () => {
    const amat = [...flat(100, N - 1), 110];
    const k = compareReads({ ...MET, AMAT: series(amat), F8: series(flat(200)) }, R);
    const lastRatio = 110 / 200;
    const m = (0.5 * (R.MA_N - 1) + lastRatio) / R.MA_N;
    expect(k.amatMu!.vsMa).toBeCloseTo(lastRatio / m - 1, 9);
    expect(compareText(k, R)[1]).toContain(`vs its MA${R.MA_N}`);
    // The ratio's LEVEL (rebased AMAT over a raw Micron close) is arbitrary — the line prints the vs-MA read and no other number.
    expect(compareText(k, R)[1]!.replace(`MA${R.MA_N}`, "MA")).toMatch(/^AMAT:MU [+-]\d+\.\d% vs its MA — /);
    expect(compareReads({ ...MET, AMAT: series(amat).slice(-(R.MA_N - 1)) }, R).amatMu, "short of a full MA window").toBeNull();
    expect(compareReads({ ...MET, F8: [] }, R).amatMu, "no Micron close to divide by").toBeNull();
  });
  it("each change line reads the last close over the one HIGH_N closes back, and nothing short of HIGH_N + 1 closes", () => {
    const k = compareReads({ ...MET, KRW: series([...flat(100, N - R.HIGH_N - 1), 90, ...flat(95, R.HIGH_N - 1), 99]), COPPER: series(dip(100, 0.034)) }, R);
    expect(k.krw).toBeCloseTo(99 / 90 - 1, 9);
    expect(k.copper).toBeCloseTo(-0.034, 9);
    const lines = compareText(k, R);
    expect(lines[2]).toBe(`USD/KRW +10.0% over ${R.HIGH_N} closes — display only, never a gate`);
    expect(lines[3]).toBe(`Copper -3.4% over ${R.HIGH_N} closes — display only, never a gate`);
    const short = compareReads({ ...MET, KRW: MET.KRW.slice(-R.HIGH_N), COPPER: MET.COPPER.slice(-(R.HIGH_N + 1)) }, R);
    expect(short.krw, "HIGH_N closes: no close HIGH_N back").toBeNull();
    expect(short.copper, "HIGH_N + 1 closes reads").toBe(0);
    expect(compareText(short, R)[2]).toBe(`USD/KRW — over ${R.HIGH_N} closes — display only, never a gate`);
  });
  it("no comparator read is a criterion, gate or box input: crashing or emptying HYNIX, AMAT, KRW and COPPER moves no leg, tally or family", () => {
    const base = evaluateShipped(MET, SIGNS_OK);
    const DISPLAY = ["HYNIX", "AMAT", "KRW", "COPPER"] as const;
    expect([...VERDICT_IDS].filter((id) => (DISPLAY as readonly string[]).includes(id))).toEqual([]);
    for (const s of [{ ...MET, ...Object.fromEntries(DISPLAY.map((id) => [id, series(dip(100, 0.5))])) }, { ...MET, ...Object.fromEntries(DISPLAY.map((id) => [id, []])) }] as SeriesSet[]) {
      const got = evaluateShipped(s, SIGNS_OK);
      expect(got.legs).toEqual(base.legs);
      expect(got.tranches).toEqual(base.tranches);
      expect(got.escalation).toEqual(base.escalation);
    }
  });
  it("a provisional head on a display-only row never flags the verdict provisional; one on a read id does", () => {
    const provHead = (c: Pt[]): Pt[] => [...c.slice(0, -1), { ...c.at(-1)!, provisional: true }];
    expect(verdictProvisional(MET), "settled closes").toBe(false);
    for (const id of ["HYNIX", "AMAT", "KRW", "COPPER"] as const) expect(verdictProvisional({ ...MET, [id]: provHead(MET[id]) }), id).toBe(false);
    for (const id of ["XDEV", "F1", "RS_SMH", "F8"] as const) expect(verdictProvisional({ ...MET, [id]: provHead(MET[id]) }), id).toBe(true);
  });
});

describe("live as-of + est.", () => {
  const estHead = (c: Pt[]): Pt[] => [...c.slice(0, -1), { ...c.at(-1)!, estimated: true }];
  const estKeys = (s: SeriesSet): string[] => evaluateShipped(s, SIGNS_OK, R, S1).legs.filter((l) => l.live.value.endsWith(" est.")).map((l) => l.key);
  it("a leg ends ` est.` when any series it reads heads on an estimate — HY tags the live arm's credit gates, RS_SMH tags t2-rs (src MU_RS); final heads stay bare", () => {
    expect(estKeys(MET)).toEqual([]);
    const liveEst = (s: SeriesSet): string[] => evaluateShipped(s, SIGNS_OK).legs.filter((l) => l.live.value.endsWith(" est.")).map((l) => l.key);
    expect(liveEst({ ...MET, F1: estHead(MET.F1) })).toEqual(expect.arrayContaining(["t1-credit", "t2-credit", "t3-credit"]));
    expect(liveEst({ ...MET, F1: estHead(MET.F1) })).not.toContain("t1-semis");
    expect(estKeys({ ...MET, RS_SMH: estHead(MET.RS_SMH) })).toEqual(["t2-rs"]);
  });
  it("the live arm's vol T3 live cell reads the served VIX head (R5, a LIVE_SERVED id): ` @MM-DD est.` on an estimated head lagging XDEV's; a VIX run short of T3_VIX_N closes unmeets it", () => {
    /** 259 closes at 20 then one a point over the cut VOL_K × 20 (the median stays 20 at any K > ½), so only the 10s run. */
    const hi = VOL_K * 20 + 1;
    const vix = (n: number) => [...series([...flat(20, 259), hi, ...flat(10, n)]), { date: dateAt(260 + n), value: 9, estimated: true }];
    const vol = (n: number) => evaluateShipped({ ...MET, XDEV: series(flat(100, 300)), R5: vix(n) }, SIGNS_OK).legs.find((l) => l.key === "t3-vol")!.live;
    expect([vol(A.T3_VIX_N).verdict, vol(A.T3_VIX_N).value, vol(0).verdict]).toEqual(["met", expect.stringMatching(new RegExp(`VIX 9\\.00/\\S+ @${dateAt(260 + A.T3_VIX_N).slice(5)} est\\.$`)), "unmet"]);
  });
  it("asOf over the verdict's read ids: newest close, newest live head, est — a display-only estimate head never sets it", () => {
    const allEst = Object.fromEntries(SERIES.map((id) => [id, estHead(MET[id])])) as SeriesSet;
    expect(toVerdict(evaluateShipped(allEst, SIGNS_OK), false).asOf).toEqual({ close: dateAt(N - 2), live: dateAt(N - 1), est: true });
    expect(evaluateShipped(MET, SIGNS_OK).asOf).toEqual({ close: dateAt(N - 1), live: dateAt(N - 1), est: false });
    expect(evaluateShipped({ ...MET, HYNIX: estHead(MET.HYNIX) }, SIGNS_OK).asOf.est).toBe(false);
  });
});

describe("rules object", () => {
  it("every leg reads the rules passed in — the zone rule text names the custom high window, the live arm's T2 credit gate the custom retrace and peak age", () => {
    const custom = evaluateShipped(MET, SIGNS_OK, { ...R, HIGH_N: 7 }, S1);
    const legs = Object.fromEntries(custom.legs.map((l) => [l.key, l]));
    expect(legs["t1-zone"]!.rule).toContain("7-close high");
    const credit = evaluateShipped(MET, SIGNS_OK, { ...R, T2_RETRACE: 0.25, T2_PEAK_AGE_N: 7 }).legs.find((l) => l.key === "t2-credit")!.rule;
    expect([credit.includes("peak − 0.25·"), credit.endsWith("peak ≥ 7 closes old")]).toEqual([true, true]);
    expect(legs["t2-esc"]!.rule, "credit reads no close row since HY moved to ladder-credit").toBe("0/3 families tripped");
  });
  it("the verdict carries no EU-Fin regime gap, and the display read names its MA window", () => {
    const res = evaluateShipped(MET, SIGNS_OK);
    expect("exshVsMa200" in res.regime).toBe(false);
    expect(res.display).toMatchObject({ maN: R.MA_N, zoneSince: dateAt(N - SETTLE) });
    const lastClose = 100 * (1 - R.ZONE_OPEN);
    expect(res.display.vsMa).toBeCloseTo(lastClose / ((100 * (R.MA_N - SETTLE) + lastClose * SETTLE) / R.MA_N) - 1, 9);
  });
});

describe("--replay= coverage", () => {
  it("lists verdict ids blind or under MIN_COVER of XDEV's closes in the window; only a partial id outside SHALLOW throws", () => {
    const s: SeriesSet = { ...MET, F1: MET.F1.slice(-50), F17: MET.F17.slice(-(HOLDOUT_WINDOW.MIN_COVER * N)), HYNIX: [], R5: [], RSP_SPY: MET.XDEV, QQQE_QQQ: MET.XDEV.slice(-50) };
    expect(coverage(s, dateAt(0), dateAt(N - 1)), "the live roster's closes-feed ratios are verdict ids too").toMatchObject({ blind: ["R5"], partial: ["F1", "QQQE_QQQ"], sparse: ["F1", "QQQE_QQQ"] });
  });
});

describe("--replay= deep feeds (`deepBuilders`)", () => {
  it("every DEEP_SHARED id's builder IS the DEEP_ROUTES function; the Value-only ids build locally", () => {
    const b = deepBuilders();
    expect(DEEP_SHARED.filter((id) => b[id] !== DEEP_ROUTES[id] || DEEP_ROUTES[id] === undefined), "a shared id must route through DEEP_ROUTES, not a local copy").toEqual([]);
    expect(Object.keys(b).filter((id) => !(DEEP_SHARED as readonly string[]).includes(id)).sort()).toEqual(["KBE_RS", "MU_CLOSE", "MU_OPEN", "QQQE_QQQ", "RSP_SPY", "XDEV"]);
    expect(Object.keys(b).filter((id) => id in DEEP_ROUTES && !(DEEP_SHARED as readonly string[]).includes(id)), "a routed id built locally").toEqual([]);
  });
});

describe("--replay= arms (each alone vs baseline, `firesAt`)", () => {
  const arm = (name: string) => VALUE_ARMS.find((a) => a.name.startsWith(name))!;
  const fire = (a: string, s: SeriesSet, fills: (string | null)[] = [null, null, null], exit = dateAt(0)): boolean[] => firesAt(arm(a), { s, signs: SIGNS_OK }, R, fills, s.XDEV, exit, dateAt(N - 1));
  it("follow: out of every zone, T1 fires TIME_STOP_N closes after the exit (not one fewer), T2/T3 AFTER_N after the latched fill before; T3's zone gate → XDEV over a rising MA", () => {
    const high: SeriesSet = { ...MET, XDEV: series(flat(100)) };
    expect(fire("baseline", high, [null, null, null], dateAt(N - 1 - A.TIME_STOP_N))).toEqual([false, false, false]);
    expect(fire("B5", high, [null, null, null], dateAt(N - 1 - A.TIME_STOP_N))[0]).toBe(true);
    expect(fire("B5", high, [null, null, null], dateAt(N - A.TIME_STOP_N))[0]).toBe(false);
    expect(fire("B5", high, [dateAt(N - 1 - A.T2_AFTER_N), null, null], dateAt(N - 2))[1]).toBe(true);
    expect(fire("B5", high, [dateAt(N - A.T2_AFTER_N), null, null], dateAt(N - 2))[1]).toBe(false);
    const up: SeriesSet = { ...MET, XDEV: series(Array.from({ length: N }, (_, i) => 100 * 1.001 ** i)) };
    const v: SeriesSet = { ...MET, XDEV: series([...flat(120, 20), ...flat(90, N - 30), ...flat(100, 10)]) };
    expect([fire("baseline", up)[2], fire("B5", up)[2], fire("baseline", v)[2], fire("B5", v)[2]], "rising XDEV fills T3; over a falling MA it holds").toEqual([false, true, true, false]);
  });
  it("muRsGuard: a new MU_RS_LOW_N-close MU_RS low inside the guard window holds T2 and T3; one close older passes", () => {
    const low = (ago: number): SeriesSet => ({ ...at(MET, R.ZONE_T3), MU_RS: series([...flat(1, N - 1 - ago), 0.99, ...flat(0.99, ago)], "GREEN") });
    expect(fire("baseline", low(A.T2_MU_RS_GUARD_N - 1)).slice(1)).toEqual([true, true]);
    expect(fire("B7", low(A.T2_MU_RS_GUARD_N - 1)).slice(1)).toEqual([false, false]);
    expect(fire("B7", low(Math.max(A.T2_MU_RS_GUARD_N, A.T3_MU_RS_GUARD_N))).slice(1)).toEqual([true, true]);
  });
  /** T3-ready fixture. */
  const T3 = at(MET, R.ZONE_T3);
  /** Arm feeds past N closes (T3's lagged MA50, 6-mo return), the last dated with every other fixture's. */
  const LONG = Math.max(A.EW_MID_N + A.EW_RISE_N, A.MU_MOM_N) + 10;
  const long = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(N - vals.length + i), value }));
  it("hcxGate: an HCX RED state holds T2 and T3; AMBER passes", () => {
    const hcx = (state: string): SeriesSet => ({ ...T3, HCX: series(flat(-0.2), state) });
    expect([fire("baseline", hcx("RED")).slice(1), fire("B9a", hcx("RED")).slice(1), fire("B9a", hcx("AMBER")).slice(1)]).toEqual([[true, true], [false, false], [true, true]]);
  });
  it("muMom: MU down (or flat) over MU_MOM_N closes holds T2 only; MU up passes", () => {
    const mu = (g: number): SeriesSet => ({ ...T3, F8: long(Array.from({ length: LONG }, (_, i) => 100 * g ** i)) });
    expect([fire("baseline", mu(0.999)).slice(1), fire("B9b", mu(0.999)).slice(1), fire("B9b", mu(1)).slice(1), fire("B9b", mu(1.001)).slice(1)]).toEqual([[true, true], [false, true], [false, true], [true, true]]);
  });
  it("ewTrend: either ratio passes T2 (MA20 > MA50) and T3 (MA50 above its value EW_RISE_N back); a fresh V passes T2 only; a recovery under its MA200 passes T3; both falling or one unread holds", () => {
    const up = Array.from({ length: LONG }, (_, i) => 1 + 0.001 * i);
    const down = Array.from({ length: LONG }, (_, i) => 2 - 0.001 * i);
    const v = [...flat(2, LONG - 60), ...Array.from({ length: 30 }, (_, i) => 2 - (i + 1) / 30), ...Array.from({ length: 30 }, (_, i) => 1 + 0.03 * (i + 1))];
    /** 180 closes falling 2 → 1.82, then 30 rising 0.004 each: MA50 rising, still under the MA200 the retired T3 read. */
    const rec = [...Array.from({ length: 180 }, (_, i) => 2 - 0.001 * i), ...Array.from({ length: 30 }, (_, i) => 1.821 + 0.004 * (i + 1))];
    const ma = (c: number[], n: number) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
    expect([ma(rec, A.EW_MID_N) > ma(rec.slice(0, -A.EW_RISE_N), A.EW_MID_N), ma(rec, A.EW_MID_N) < ma(rec, 200)]).toEqual([true, true]);
    const ew = (a: number[], b: number[]): SeriesSet => ({ ...T3, RSP_SPY: long(a), QQQE_QQQ: long(b) });
    expect([fire("baseline", ew(down, down)).slice(1), fire("B9c", ew(up, up)).slice(1), fire("B9c", ew(v, v)).slice(1), fire("B9c", ew(rec, rec)).slice(1)]).toEqual([[true, true], [true, true], [true, false], [true, true]]);
    expect([fire("B9c", ew(up, down)).slice(1), fire("B9c", ew(down, up)).slice(1), fire("B9c", ew(down, down)).slice(1), fire("B9c", ew(up, [])).slice(1), fire("B9c", ew(flat(1, LONG), flat(1, LONG))).slice(1)]).toEqual([[true, true], [true, true], [false, false], [false, false], [false, false]]);
  });
  it("an absent arm feed reads n/a and holds its gate, as every value gate", () => {
    expect([fire("baseline", T3), fire("B9a", T3), fire("B9c", T3)].map((f) => f.slice(1))).toEqual([[true, true], [false, false], [false, false]]);
  });
  const fireW = (a: string, s: SeriesSet, wins: EarnWindow[]): boolean[] => firesAt(arm(a), { s, signs: SIGNS_OK }, R, [null, null, null], s.XDEV, dateAt(0), dateAt(N - 1), wins);
  const win = (from: number, d1: number, fast = false): EarnWindow => ({ d: dateAt(d1 - 1), from: dateAt(from), d1: dateAt(d1), fast });
  it("MU-report arm hold: T2/T3 held while the close sits in [from, D+1] (both ends inclusive), T1 untouched; one close outside passes; baseline ignores windows", () => {
    expect([fireW("baseline", T3, [win(N - 8, N - 1)]), fireW("B2-fast", T3, [win(N - 8, N - 1)]), fireW("B2-fast", T3, [win(N - 1, N + 3)])].map((f) => f.slice(1))).toEqual([[true, true], [false, false], [false, false]]);
    expect([fireW("B2-fast", T3, [win(N - 8, N - 2)]), fireW("B2-fast", T3, [win(N, N + 3)])].map((f) => f.slice(1))).toEqual([[true, true], [true, true]]);
    expect([fireW("baseline", MET, [])[0], fireW("B2-fast", MET, [win(N - 8, N - 1)])[0]]).toEqual([true, true]);
  });
  it("MU-report arm fill: a fast window fires T2 (only) on the first XDEV close strictly after D+1 even with T2's gates unmet — not on D+1, not a close later", () => {
    expect([fireW("baseline", UNMET, [win(N - 9, N - 2, true)]), fireW("B2-fast", UNMET, [win(N - 9, N - 2, true)])]).toEqual([[false, false, false], [false, true, false]]);
    expect([fireW("B2-fast", UNMET, [win(N - 9, N - 1, true)])[1], fireW("B2-fast", UNMET, [win(N - 9, N - 3, true)])[1], fireW("B2-fast", UNMET, [win(N - 9, N - 2)])[1]]).toEqual([false, false, false]);
  });
  /** MU bars: 100 flat through D (index 25), `hi` at index `hiAt`, D+1 opens `o1` and closes `c1`. */
  const D = 25;
  const muBars = (o1: number, c1: number, hi = 100, hiAt = 0) => {
    const c = [...flat(100, D + 1).map((v, i) => (i === hiAt ? hi : v)), c1, c1];
    return earnWindows(series(c.map((v, i) => (i === D + 1 ? o1 : v))), series(c), [dateAt(D)]);
  };
  it("earnWindows: from = EARN_HOLD_N closes before D, d1 = next session; fast iff gap up, ≥ EARN_KEEP_GAP of it kept, close over the EARN_HIGH_N-close high to D", () => {
    expect(muBars(110, 106)).toEqual([{ d: dateAt(D), from: dateAt(D - A.EARN_HOLD_N), d1: dateAt(D + 1), fast: true }]);
    const gap = 10, keep = 100 + A.EARN_KEEP_GAP * gap;
    expect([muBars(100 + gap, keep)[0]!.fast, muBars(99, 106)[0]!.fast, muBars(100 + gap, keep - 0.01)[0]!.fast]).toEqual([true, false, false]);
    expect([muBars(110, 106, 107, D + 1 - A.EARN_HIGH_N)[0]!.fast, muBars(110, 106, 107, D - A.EARN_HIGH_N)[0]!.fast, muBars(110, 106, 106, D - 1)[0]!.fast]).toEqual([false, true, false]);
    expect(earnWindows(series(flat(100, 10)), series(flat(100, 10)), [dateAt(9), "2020-01-01"])).toEqual([{ d: dateAt(9), from: dateAt(9 - A.EARN_HOLD_N), d1: "9999-12-31", fast: false }]);
  });
  /** The replay fixture: UNMET's last closes held flat L closes, XDEV calm then 94 at close EXIT (the exit; a short σ window, `KX`), MU 100 then 106 from D+1 (index d+1) on. */
  const EXIT = 70;
  const KX = { ...REPLAY, FROM: dateAt(0), VOL_N: EXIT - 1 };
  const L = 120, d = MU_EARN_DATES.indexOf("2026-03-18") >= 0 ? (Date.parse("2026-03-18") - Date.parse(dateAt(0))) / 86_400_000 : NaN;
  const flatOf = (src: SeriesSet): SeriesSet => Object.fromEntries(Object.entries(src).map(([id, c]) => [id, series(flat(c.at(-1)!.value!, L), c[0]?.state ?? undefined)])) as SeriesSet;
  const base = flatOf(UNMET);
  const mu = [...flat(100, d + 1), 106, ...flat(106, L - d - 2)];
  const s = (o1: number): SeriesSet => ({ ...base, XDEV: series([...calm(EXIT), ...flat(94, L - EXIT)]), MU_CLOSE: series(mu), MU_OPEN: series(mu.map((v, i) => (i === d + 1 ? o1 : v))) });
  it("MU-report arm in replayValue: a fast MU report after the exit fills T2 on the first XDEV close after D+1, where baseline leaves T2 empty", () => {
    const t2 = (name: string, o1 = 110) => replayValue(s(o1), KX, R, arm(name)).map((e) => e.fills[1]);
    expect([t2("baseline"), t2("B2-fast"), t2("B2-fast", 99)]).toEqual([[null], [dateAt(d + 2)], [null]]);
  });
  it("whyFills: one row per replayValue non-null fill, routed `count` (ready) or `fast MU report` (B2-fast's T2), rows keyed without the `t<k>-` prefix", () => {
    const why = whyFills(s(110), KX, R, arm("B2-fast"));
    const fills = replayValue(s(110), KX, R, arm("B2-fast")).flatMap((e) => e.fills.flatMap((f, i) => (f === null ? [] : [[`T${i + 1}`, f]])));
    expect(why.map((w) => [w.tranche, w.date]), "one row per non-null fill").toEqual(fills);
    expect(why.map((w) => [w.via, w.rows.length > 0 && w.rows.every((r) => !/^t\d-/.test(r.key))])).toEqual([["count 1/1", true], ["fast MU report", true]]);
  });
  it("fill drift (`fillDrift` on `replayValue`): a candidate whose box always holds (ESC_DGS10_DELTA · ESC_REAL_DELTA · ESC_KBE_RS_DROP at −1: rates-shock + bank-funding vote on every close) mismatches", () => {
    // `s(…)` is UNMET-based (its box trips, nothing fills — a drift over it is vacuous): the same shape off MET (box clear, so the follow path fills T1 TIME_STOP_N closes past the exit), its XDEV kept.
    // HY OAS (the credit gate at every tranche): 70 calm closes, +0.2 a close to 6.00 after the exit, then −0.1 a close over L closes (a shock that retraces past every gate's line).
    const hyL = series([...Array.from({ length: 70 }, (_, i) => (i % 2 ? 4.02 : 4)), 4, ...Array.from({ length: 10 }, (_, i) => 4.2 + 0.2 * i), ...Array.from({ length: L - 81 }, (_, i) => 6 - 0.1 * (i + 1))]);
    const met: SeriesSet = { ...s(110), ...flatOf(MET), XDEV: s(110).XDEV, F1: hyL };
    const px = met.XDEV;
    const shipped = (k: ReplayKnobs): EpisodeResult[] => replayValue(met, k, R, LIVE_ARM);
    const candidate = (k: ReplayKnobs): EpisodeResult[] => replayValue(met, k, { ...R, ESC_DGS10_DELTA: -1, ESC_REAL_DELTA: -1, ESC_KBE_RS_DROP: -1 }, LIVE_ARM);
    const K = KX;
    const rows = shipped(K);
    expect(rows.map((e) => e.fills).flat().some((f) => f !== null), "premise: the live arm fills on the fixture, so a held box can mismatch").toBe(true);
    expect(driftSummary(fillDrift(px, () => rows, candidate, K)).mismatches).toBeGreaterThanOrEqual(1);
  });
  it("MU_EARN_DATES: ascending, unique, weekdays", () => {
    expect([...new Set(MU_EARN_DATES)].sort()).toEqual(MU_EARN_DATES);
    expect(MU_EARN_DATES.filter((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toEqual([]);
  });
  it("every arm leg's source is a SERIES or ARM_SERIES id, and every arm feed the live verdict reads is in the live set (LIVE_FEEDS or LIVE_SERVED)", () => {
    for (const a of VALUE_ARMS) for (const d of a.defs) expect(([...SERIES, ...ARM_SERIES] as readonly string[]).includes(d.src.id), `${a.name} ${d.key}`).toBe(true);
    const read = ARM_SERIES.filter((id) => (VERDICT_IDS as ReadonlySet<string>).has(id));
    expect(read, "P5's vol T3 reads VIX, the box R4 · KBE_RS").toEqual(["R4", "R5", "KBE_RS", "RSP_SPY", "QQQE_QQQ"]);
    expect(read.filter((id) => !([...LIVE_FEEDS, ...LIVE_SERVED] as readonly string[]).includes(id))).toEqual([]);
    expect(LIVE_SERVED.filter((id) => !VERDICT_IDS.has(id)), "a served id no leg reads only adds a fetch that can abort the run").toEqual([]);
  });
  it("stackArms: every member's non-LEGS leg exactly once, the t3-zone swap kept in slot, follow on", () => {
    const s1 = arm("S1");
    const own = ["B5", "B7", "B9a", "B9c"].flatMap((n) => arm(`${n} `).defs.filter((d) => !LEGS_SHIPPED.includes(d)));
    expect(own.map((d) => d.key)).toEqual(["t3-trend", "t2-mu-rs-guard", "t3-mu-rs-guard", "t2-hcx-gate", "t3-hcx-gate", "t2-ew-trend", "t3-ew-trend"]);
    for (const d of own) expect(s1.defs.filter((e) => e === d).length, d.key).toBe(1);
    expect(s1.defs.length).toBe(LEGS_SHIPPED.length + own.length - 1);
    const z = LEGS_SHIPPED.findIndex((l) => l.key === "t3-zone");
    expect([s1.defs.some((d) => d.key === "t3-zone"), s1.defs[z]!.key]).toEqual([false, "t3-trend"]);
    expect([s1.follow, s1.earn]).toEqual([true, false]);
  });
});

describe("live follow path (followOf over the open XDEV exit) and live feeds", () => {
  /** Ratio closes rising over `n` (≥ T3's lagged MA50), the last dated `end`. */
  const ratioTo = (end: number, n = A.EW_MID_N + A.EW_RISE_N + 10): Pt[] => Array.from({ length: n }, (_, i) => ({ date: dateAt(end - n + 1 + i), value: 1 + 0.001 * i }));
  const feeds = (end: number): Partial<SeriesSet> => ({ RSP_SPY: ratioTo(end), QQQE_QQQ: ratioTo(end) });
  const PRE = REPLAY.VOL_N + 1;
  /** MET's last close per id but R4 · KBE_RS over `len` closes (HCX GREEN), both ratio feeds rising; XDEV calm to its high 100, then flat 99 from the exit at PRE — out of every zone. */
  const followSet = (len: number, withFeeds = true): SeriesSet => ({
    ...(Object.fromEntries(Object.entries(MET).filter(([id]) => id !== "R4" && id !== "KBE_RS").map(([id, c]) => [id, series(flat(c.at(-1)!.value!, len), id === "HCX" ? "GREEN" : (c[0]?.state ?? undefined))])) as SeriesSet),
    XDEV: series([...calm(PRE), ...flat(99, len - PRE)]),
    ...(withFeeds && feeds(len - 1)),
  });
  const t = (s: SeriesSet, k: number) => evaluateShipped(s, SIGNS_OK, R, S1).tranches[k]!;
  /** `s` plus a KBE/SPY that starts the close after T1's time-stop fill: no point at T1's (out of the denominator), short of ESC_KBE_RS_N at T2's (na). */
  const lateKbeRs = (s: SeriesSet): SeriesSet => ({ ...s, KBE_RS: Array.from({ length: A.T2_AFTER_N }, (_, i) => ({ date: dateAt(PRE + A.TIME_STOP_N + 1 + i), value: 1 })) });
  it("T1 fires on the time stop TIME_STOP_N closes after the open exit (not one fewer), out of zone; the pre-stack roster never follows", () => {
    const at15 = followSet(PRE + A.TIME_STOP_N + 1);
    expect(followOf(S1, at15, SIGNS_OK, R)).toMatchObject({ exit: dateAt(PRE), n: A.TIME_STOP_N });
    const v = evaluateShipped(at15, SIGNS_OK, R, S1);
    expect(v.tranches[0]).toMatchObject({ met: true, ready: false, filled: true, via: "time stop", since: dateAt(PRE + A.TIME_STOP_N) });
    expect(v.sessionsSinceExit).toBe(A.TIME_STOP_N);
    expect(v.tranchesLive[0]).toMatchObject({ met: true, via: "time stop" });
    const pre = shipped(at15, SIGNS_OK);
    expect([t(followSet(PRE + A.TIME_STOP_N), 0).met, pre.tranches[0]!.met, "sessionsSinceExit" in pre]).toEqual([false, false, false]);
  });
  it("the box reaches followOf → firesAt, evaluateShipped and replayValue: a credit block (veto) holds the T1 time-stop fill the unblocked run makes once credit_confirms trips, alone it leaves T1; below quorum holds T2's", () => {
    const at15 = followSet(PRE + A.TIME_STOP_N + 1);
    const hot = hyUp(at15);
    const veto = blocking("credit");
    const fill = dateAt(PRE + A.TIME_STOP_N);
    expect([escalation({ s: hot, signs: SIGNS_OK }, R).hits, escalation({ s: at15, signs: SIGNS_OK }, R).hits], "premise: hyUp trips credit_confirms, a coincident vote alone").toEqual([["credit"], []]);
    expect([SIGNS_OK, veto].flatMap((g) => [at15, hot].map((s) => followOf(S1, s, g, R)!.fills[0])), "[calm, credit_confirms tripped] × [no block, credit block]").toEqual([fill, fill, fill, null]);
    expect([SIGNS_OK, veto].flatMap((g) => [at15, hot].map((s) => evaluateShipped(s, g, R, S1).tranches[0]!.met))).toEqual([true, true, true, false]);
    const full = followSet(PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1);
    const end = lateKbeRs(full);
    expect(escalation({ s: end, signs: [] }, R).quorum, "premise: KBE/SPY starts after T1's fill, short of ESC_KBE_RS_N at T2's → below quorum").toMatchObject({ t1Only: true });
    expect([full, end].map((s) => replayValue(s, REPLAY, R, S1).at(-1)!.fills.slice(0, 2))).toEqual([[dateAt(PRE + A.TIME_STOP_N), dateAt(PRE + A.TIME_STOP_N + A.T2_AFTER_N)], [dateAt(PRE + A.TIME_STOP_N), null]]);
  });
  it("whyFills on the follow path: a time-stop T1 and its T2 after it route by `VIA` (`time stop` · `after T1`)", () => {
    const full = followSet(PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1);
    expect(whyFills(full, REPLAY, R, S1).slice(-2).map((w) => [w.tranche, w.date, w.via])).toEqual([["T1", dateAt(PRE + A.TIME_STOP_N), "time stop"], ["T2", dateAt(PRE + A.TIME_STOP_N + A.T2_AFTER_N), "after T1"]]);
  });
  it("replayValue's binding closes (boxBinds): the below-quorum hold on T2's time-stop close counts 1, 0 at quorum; with T2's EW-trend gate unmet the same close counts 0", () => {
    const at = (withFeeds: boolean, short = true): SeriesSet => ((full) => (short ? lateKbeRs(full) : full))(followSet(PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1, withFeeds));
    const ep = (a: typeof S1, s: SeriesSet) => replayValue(s, REPLAY, R, a, true).at(-1)!;
    expect(ep(S1, at(false)).fills[0], "premise: T1 still fills without the EW feeds, so T2's time stop is reached").toBe(dateAt(PRE + A.TIME_STOP_N));
    expect([ep(S1, at(true)).binding, ep(S1, at(true, false)).binding, ep(S1, at(false)).binding]).toEqual([[dateAt(PRE + A.TIME_STOP_N + A.T2_AFTER_N)], [], []]);
    const live = LIVE_ARM;
    const at15 = followSet(PRE + A.TIME_STOP_N + 1);
    const binds = (signs: LadderSign[]) => ((x: Inputs) => boxBinds(live, x, R, [null, null, null], firesAt(live, x, R, [null, null, null], at15.XDEV, dateAt(PRE), dateAt(PRE + A.TIME_STOP_N)), at15.XDEV, dateAt(PRE), dateAt(PRE + A.TIME_STOP_N)))({ s: at15, signs });
    expect([binds(blocking("credit")), binds(SIGNS_OK)], "the live arm's box gate rows clear too: a credit veto binds T1's time-stop close").toEqual([true, false]);
  });
  it("T2 auto-follows T2_AFTER_N closes after T1's latched fill (not one fewer); no open exit, no follow", () => {
    const end = PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1;
    expect(followOf(S1, followSet(end), SIGNS_OK, R)?.fills.slice(0, 2)).toEqual([dateAt(PRE + A.TIME_STOP_N), dateAt(end - 1)]);
    expect(t(followSet(end), 1)).toMatchObject({ met: true, ready: false, via: "after T1", since: dateAt(end - 1) });
    expect(t(followSet(end - 1), 1).met).toBe(false);
    const calm: SeriesSet = { ...followSet(end), XDEV: series(flat(100, end)) };
    expect([followOf(S1, calm, SIGNS_OK, R), "sessionsSinceExit" in evaluateShipped(calm, SIGNS_OK, R, S1)]).toEqual([null, false]);
    const backAt = (len: number, v: number): SeriesSet => ((s) => ({ ...s, XDEV: [...s.XDEV.slice(0, -1), { ...s.XDEV.at(-1)!, value: v }] }))(followSet(len));
    expect([openExit(followSet(PRE + 301)), openExit(backAt(PRE + 301, 98.9)), openExit(backAt(PRE + 301, 100))], "the exit stays open, any age, until its episode end — not under its MA50, ended by the close back at its high, as replay's").toEqual([dateAt(PRE), dateAt(PRE), undefined]);
    expect(followOf(S1, backAt(PRE + 301, 100), SIGNS_OK, R), "followOf stops following once the exit's episode has ended").toBeNull();
    const allLatched = Array.from({ length: 3 }, () => dateAt(PRE));
    expect(followOf(S1, followSet(PRE + 301), SIGNS_OK, R, allLatched)?.n, "followOf adds no age cap of its own over the open exit (every third latched, so its walk exits at once)").toBe(300);
  });
  it("a latched fill survives a run whose signs would block it, and the blocked run's verdict keeps it for the next", () => {
    const s = followSet(PRE + A.TIME_STOP_N + 1);
    const hot = hyUp(s);
    const fill = dateAt(PRE + A.TIME_STOP_N);
    const block = blocking("credit", "rates");
    const prior = toVerdict(asProbeResult(evaluateShipped(s, SIGNS_OK, R, S1)), false);
    expect(prior.tranches[0]).toMatchObject({ ok: true, filledSince: fill });
    expect([followOf(S1, hot, block, R)?.fills[0], followOf(S1, hot, block, R, [fill, null, null])?.fills[0]], "recomputed with today's blocks (credit_confirms tripped) it un-fills; latched it stays").toEqual([null, fill]);
    const blocked = evaluateShipped(hot, block, R, S1, prior);
    expect(blocked.tranches[0]).toMatchObject({ met: false, since: fill, fill: true });
    expect(evaluateShipped(hot, block, R, S1, toVerdict(asProbeResult(blocked), false)).tranches[0]!.since, "carried through a blocked run").toBe(fill);
  });
  it("T2 follows a latch as-is, not a recomputed T1; a latch dated before the open exit (an earlier episode) drops, one on the exit close is kept", () => {
    const early = PRE + 3;
    expect(followOf(S1, followSet(early + A.T2_AFTER_N + 1), SIGNS_OK, R, [dateAt(early), null, null])?.fills.slice(0, 2)).toEqual([dateAt(early), dateAt(early + A.T2_AFTER_N)]);
    const s = hyUp(followSet(PRE + A.TIME_STOP_N + 1));
    const block = blocking("credit", "rates");
    expect([followOf(S1, s, block, R, [dateAt(PRE - 1), null, null])?.fills[0], followOf(S1, s, block, R, [dateAt(PRE), null, null])?.fills[0]]).toEqual([null, dateAt(PRE)]);
  });
  describe("fizzle fast fill: every deciding event landed fizzle: on T1's fill close → T2 fills that close (allFizzled)", () => {
    const ev = (date: string, holds: ("T2" | "T3")[], status: string): LadderEvent => ({ date, event: `e${date}${status.slice(0, 3)}`, signs: [], escalationIf: "", fizzleIf: "", holds, secondary: false, status });
    const t1 = PRE + A.TIME_STOP_N;
    const s = followSet(t1 + 1);
    const FIZ = "fizzle: in line (src)";
    const fills = (evs: LadderEvent[], latched: (string | null)[] = []) => followOf(S1, s, SIGNS_OK, R, latched, evs)?.fills;
    const deciding = [ev(dateAt(PRE + 2), ["T2", "T3"], FIZ), ev(dateAt(t1), ["T2", "T3"], FIZ), ev(dateAt(t1 + 30), [], "NOT DUE until later")];
    it("all fizzled → T2 filled on the T1 close, met and latched in the verdict; T3 does not skip ahead", () => {
      expect(fills(deciding)).toEqual([dateAt(t1), dateAt(t1), null]);
      const res = evaluateShipped(s, SIGNS_OK, R, S1, undefined, deciding);
      expect(res.tranches.map((t) => [t.met, t.since ?? null])).toEqual([[true, dateAt(t1)], [true, dateAt(t1)], [false, null]]);
      const prior = toVerdict(asProbeResult(res), false);
      expect(fills([], prior.tranches.map((t) => t.filledSince)), "a stored fast fill latches with no events").toEqual([dateAt(t1), dateAt(t1), null]);
    });
    it("one unresolved, one escalation, one dated after the close, or no deciding event → no fast fill", () => {
      const swap = (e: LadderEvent) => [deciding[0]!, e, deciding[2]!];
      expect([
        fills(swap(ev(dateAt(t1), ["T2", "T3"], "NOT DUE until later"))),
        fills(swap(ev(dateAt(t1), ["T2", "T3"], "escalation: missed (src)"))),
        fills(swap(ev(dateAt(t1 + 1), ["T2", "T3"], FIZ))),
        fills([ev(dateAt(t1), [], FIZ), deciding[2]!]),
        followOf(S1, followSet(t1 + 1, false), SIGNS_OK, R, [], deciding)?.fills,
      ], "the 5th: all fizzled but T2's own gates read n/a (ratio feeds down)").toEqual(Array.from({ length: 5 }, () => [dateAt(t1), null, null]));
    });
    it("the fast fill moves T2 alone: T1/T3 fire as without it on every close, and T3 then runs off T2's fill as off a latched one", () => {
      const long = followSet(t1 + A.T3_AFTER_N + 1);
      const fire = (d: string, fizzled: boolean) => firesAt(S1, { s: Object.fromEntries(Object.entries(long).map(([id, c]) => [id, c.filter((p) => p.date <= d)])) as SeriesSet, signs: SIGNS_OK }, R, [null, null, null], long.XDEV, dateAt(PRE), d, [], fizzled);
      const days = long.XDEV.filter((p) => p.date > dateAt(PRE)).map((p) => p.date);
      expect(days.map((d) => [fire(d, true)[0], fire(d, true)[2]])).toEqual(days.map((d) => [fire(d, false)[0], fire(d, false)[2]]));
      expect(fire(dateAt(t1), true), "T1's fill close: T2 rides it, T3 does not").toEqual([true, true, false]);
      expect(followOf(S1, long, SIGNS_OK, R, [], deciding)?.fills).toEqual(followOf(S1, long, SIGNS_OK, R, [dateAt(t1), dateAt(t1), null])?.fills);
    });
  });
  it("the live path reads the open exit into the family rungs (t1-price on its close and live rows) and sinceOf's walk; the same closes with no exit read n/a", () => {
    const s = followSet(PRE + A.TIME_STOP_N + 1);
    const leg = evaluateShipped(s, SIGNS_OK).legs.find((l) => l.key === "t1-price")!;
    expect([leg.verdict, leg.live.verdict, LIVE_ARM.defs.find((d) => d.key === "t1-price")!.read(R, { s, signs: SIGNS_OK }).verdict]).toEqual(["met", "met", "na"]);
    const only = { name: "price only", note: "", follow: false, families: 1, defs: [FAMS.PRICE.rungs[0]] };
    expect(evaluateShipped(s, SIGNS_OK, R, only).tranches[0]!.since, "first close 5 past the exit's low").toBe(dateAt(PRE + A.T1_NO_LOW_N));
  });
  it("the credit gate holds T2 on its own legs and on the follow path while HY sits over its ½ line (T1's ⅓ met), and lets both fill once HY is back past it", () => {
    const len = PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1;
    /** HY calm 4.00/4.02 to the exit at PRE, +0.2 a close to its 6.00 peak (PRE + 10), then `tail` to the last close. */
    const hy = (tail: number): number[] => [...Array.from({ length: PRE + 1 }, (_, i) => (i % 2 ? 4.02 : 4)), ...Array.from({ length: 10 }, (_, i) => 4.2 + 0.2 * i), ...flat(tail, len - PRE - 11)];
    const sh = shockOf(series(hy(6)), R)!;
    const [l1, l2] = [R.T1_RETRACE, R.T2_RETRACE].map((f) => retraceLine(sh, f)) as [number, number];
    expect([sh.broke, l2 < l1, len - PRE - 11 >= R.T2_PEAK_AGE_N], "premise: HY broke, T2's line sits under T1's, the peak is T2_PEAK_AGE_N old by the last close").toEqual([true, true, true]);
    const [back, between] = [l2 - 0.05, (l1 + l2) / 2];
    /** XDEV chops +0.03% / back after the exit: inside the episode's rise band, over T2_RV_MULT × the calm base — so the vol family stays short. */
    const chop = followSet(len).XDEV.map((p, i) => (i > PRE && i % 2 ? { ...p, value: p.value! * 1.0003 } : p));
    const set = (tail: number, rs?: Pt[]): SeriesSet => ({ ...followSet(len), XDEV: chop, ...(rs && { RS_SMH: rs }), F1: series(hy(tail)) });
    expect([followOf(LIVE_ARM, set(back), SIGNS_OK, R)?.exit, evaluateShipped(set(back), SIGNS_OK).legs.find((l) => l.key === "t2-vol")!.verdict], "premise: the exit stays open through the chop; vol unmet").toEqual([dateAt(PRE), "unmet"]);
    const semisMet = series(Array.from({ length: len }, (_, i) => 1 + 0.001 * i), "GREEN");
    const t2 = (tail: number) => {
      const v = evaluateShipped(set(tail, semisMet), SIGNS_OK);
      const verdict = (k: string) => v.legs.find((l) => l.key === k)!.verdict;
      return [verdict("t1-credit"), verdict("t2-credit"), verdict("t2-esc"), v.tranches[1]!.ready, followOf(LIVE_ARM, set(tail), SIGNS_OK, { ...R, NEED_SLACK: 0 }, [dateAt(PRE + A.TIME_STOP_N), null, null])?.fills[1] ?? null];
    };
    expect(t2(back), "[T1 · T2 credit gates, the box, ready on price + semis, follow fill with own families short (no slack)]").toEqual(["met", "met", "met", true, dateAt(len - 1)]);
    expect(t2(between), "over T2's line: T2 held on both paths, the box clear").toEqual(["met", "unmet", "met", false, null]);
  });
  it("the live read takes DEEP_IDS (XDEV among them) deeper than the rest (liveLimit), so followOf's episodes scan starts where replay's stored read does", () => {
    expect([liveLimit("XDEV") > liveLimit("KBE"), readFileSync(new URL("./probe-value-tranches.ts", import.meta.url), "utf8").includes("fetchSeries(base, id, liveLimit(id))")]).toEqual([true, true]);
  });
  it("an unavailable ratio feed reads n/a and holds T2/T3 — on the follow path and on their own legs", () => {
    const end = PRE + A.TIME_STOP_N + A.T2_AFTER_N + 1;
    const ew = (s: SeriesSet) => evaluateShipped(s, SIGNS_OK, R, S1).legs.filter((l) => l.key.endsWith("-ew-trend")).map((l) => l.verdict);
    expect([t(followSet(end, false), 0).met, t(followSet(end, false), 1).met, ew(followSet(end, false))]).toEqual([true, false, ["na", "na"]]);
    const own: SeriesSet = { ...at(MET, R.ZONE_T2), HCX: series(flat(0), "GREEN") };
    expect([t({ ...own, ...feeds(N - 1) }, 1).ready, t(own, 1).ready, t({ ...own, ...feeds(N - 1), QQQE_QQQ: [] }, 1).ready]).toEqual([true, false, false]);
  });
  it("liveFeeds: a pair whose leg throws reads []; the rest the inner-joined ratio, a running-day or estimated head provisional", async () => {
    const obs = (vals: number[], est = false) => vals.map((value, i) => ({ date: dateAt(i), value, ...(est && i === vals.length - 1 && { estimated: true }) }));
    const dailyCloses = async (sym: string) => {
      if (sym === "QQQE") throw new Error("down");
      return sym === "RSP" ? obs([2, 4, 6]) : obs([1, 2], sym === "SPY");
    };
    const after = await liveFeeds(dailyCloses, new Date(`${dateAt(1)}T22:00:00Z`));
    expect(after).toEqual({ RSP_SPY: [{ date: dateAt(0), value: 2 }, { date: dateAt(1), value: 2, provisional: true }], QQQE_QQQ: [] });
    const during = await liveFeeds(async (sym) => obs(sym === "RSP" ? [2, 4] : [1, 2]), new Date(`${dateAt(1)}T15:00:00Z`));
    expect([during.RSP_SPY.map((p) => p.provisional === true), (await liveFeeds(async (sym) => obs(sym === "RSP" ? [2, 4] : [1, 2]), new Date(`${dateAt(1)}T22:00:00Z`))).RSP_SPY.map((p) => p.provisional === true)]).toEqual([[false, true], [false, false]]);
  });
});

describe("family arms (`famArm`)", () => {
  const arm = (name: string) => VALUE_ARMS.find((a) => a.name.startsWith(name))!;
  /** One family rung's verdict at the newest close, post-shock reads anchored on `exit` (an index). */
  const rung = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, exit?: number) => FAMS[f].rungs[k].read(R, { s: { ...MET, ...s }, signs: [], ...(exit !== undefined && { exit: dateAt(exit) }) }).verdict;
  /** The cell text a rung prints — every condition in its rule shows its own value. */
  const cell = (f: keyof typeof FAMS, k: 0 | 1 | 2, s: Partial<SeriesSet>, exit?: number) => FAMS[f].rungs[k].read(R, { s: { ...MET, ...s }, signs: [], ...(exit !== undefined && { exit: dateAt(exit) }) }).value;
  const raw = (t: "T1" | "T2" | "T3", met: number, n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, tranche: t, gate: false, value: "", verdict: i < met ? ("met" as const) : ("unmet" as const) }));
  const esc0 = escalation({ s: MET, signs: [] }, R);
  it("F10 need: 1 / ⌈0.4N⌉ / ⌈0.6N⌉ of N (N=4,5 → 1/2/3, N=6 → 1/3/4), NEED_SLACK still floors it; the stack's tally (no N) keeps all-less-slack", () => {
    const needs = (n: number, live = n) => (["T1", "T2", "T3"] as const).map((t) => tally(t, raw(t, 0, live), R, esc0, n).need);
    expect([4, 5, 6].map((n) => (["T1", "T2", "T3"] as const).map((t) => famNeed(t, n)))).toEqual([[1, 2, 3], [1, 2, 3], [1, 3, 4]]);
    expect([needs(4), needs(5), needs(6), needs(6, 4)]).toEqual([[1, 2, 3], [1, 2, 3], [1, 3, 4], [1, 3, 3]]);
    expect(tally("T2", raw("T2", 0, 6), R, esc0).need, "no N = S1").toBe(5);
    expect([tally("T2", raw("T2", 3, 6), R, esc0, 6).ready, tally("T2", raw("T2", 2, 6), R, esc0, 6).ready]).toEqual([true, false]);
  });
  it("rosters: price·vol·semis, +rates, +rates+banks vote — no KBE-speed or RS-state criterion; credit a gate at every tranche, ahead of the stack's gates less zones/trend, + T3 veto and MA200, the box gate last; need counts the voting families only", () => {
    const keys = (a: string, t: string, gate: boolean) => arm(a).defs.filter((d) => d.tranche === t && (d.gate ?? false) === gate).map((d) => d.key.slice(3));
    const p4 = ["price", "vol", "semis"];
    expect([keys("P4", "T1", false), keys("P5", "T2", false), keys("P6", "T3", false)]).toEqual([p4, [...p4, "rates"], [...p4, "rates", "banks"]]);
    expect(["P4", "P5", "P6"].map((a) => [arm(a).families, arm(a).follow, (["T1", "T2", "T3"] as const).map((t) => famNeed(t, arm(a).families!))])).toEqual([[3, true, [1, 2, 2]], [4, true, [1, 2, 3]], [5, true, [1, 2, 3]]]);
    expect([keys("P6", "T1", true), keys("P6", "T2", true), keys("P6", "T3", true)]).toEqual([["credit", "veto", "hy-guard", "esc"], ["credit", "veto", "hy-guard", "mu-rs-guard", "hcx-gate", "ew-trend", "esc"], ["credit", "hy-guard", "mu-rs-guard", "hcx-gate", "ew-trend", "veto", "ma200", "esc"]]);
  });
  it("firesAt threads the exit into the family reads: a no-low run after an early exit fires T1, the same series with the exit on its last close does not", () => {
    const x = { s: { ...MET, XDEV: series([...flat(100, 20), 90, 91, 92, 93, 94, 95]) }, signs: SIGNS_OK };
    const only = { name: "price only", note: "", follow: false, families: 1, defs: [FAMS.PRICE.rungs[0]] };
    expect([firesAt(only, x, R, [null, null, null], x.s.XDEV, dateAt(19), dateAt(25))[0], firesAt(only, x, R, [null, null, null], x.s.XDEV, dateAt(25), dateAt(25))[0]]).toEqual([true, false]);
  });
  it("price XDEV / banks KBE: no post-exit low ×5 (T1) and ×15 (KBE T2) — the 5th close above the low fires, the 4th does not; no exit → n/a", () => {
    const after = (n: number) => series([...flat(100, 20), 90, ...Array.from({ length: n }, (_, i) => 91 + i)]);
    expect([rung("PRICE", 0, { XDEV: after(A.T1_NO_LOW_N) }, 19), rung("PRICE", 0, { XDEV: after(A.T1_NO_LOW_N - 1) }, 19), rung("PRICE", 0, { XDEV: after(A.T1_NO_LOW_N) })]).toEqual(["met", "unmet", "na"]);
    expect([rung("BANKS", 1, { KBE: after(A.T2_NO_LOW_N) }, 19), rung("BANKS", 1, { KBE: after(A.T2_NO_LOW_N - 1) }, 19)]).toEqual(["met", "unmet"]);
    expect(cell("PRICE", 0, { XDEV: after(A.T1_NO_LOW_N) }, 19), "the post-exit low's date, no series id").toBe(`${(90 + A.T1_NO_LOW_N).toFixed(2)}/90.00 (${dateAt(20).slice(5)})`);
  });
  it("vol T3: RV20 ≤ 1.2× base AND VIX under VOL_K× its 250d median ×5 (no VIX shock open: the rolling median) — the 5th close under fires, the 4th not; no VIX → the RV half alone", () => {
    /** 259 closes at 15 then one a point over the cut VOL_K × 15 (the median stays 15 at any K > ⅔), so only the 10s run. */
    const vix = (n: number) => series([...flat(15, 259), VOL_K * 15 + 1, ...flat(10, n)]);
    const xdev = series(flat(100, 300));
    expect([rung("VOL", 2, { XDEV: xdev, R5: vix(A.T3_VIX_N) }), rung("VOL", 2, { XDEV: xdev, R5: vix(A.T3_VIX_N - 1) }), rung("VOL", 2, { XDEV: xdev })]).toEqual(["met", "unmet", "met"]);
    const storm = series([...flat(100, 280), ...Array.from({ length: 20 }, (_, i) => (i % 2 ? 103 : 97))]);
    expect(FAMS.VOL.rungs[2].read(R, { s: { ...MET, XDEV: storm, R5: vix(A.T3_VIX_N - 1) }, signs: [] }), "each part named + marked; VIX's run is the count even when RV binds").toMatchObject({ value: expect.stringMatching(new RegExp(`^RV${R.RV_SLOW_N} \\S+✗ · VIX 10\\.00/${(VOL_K * 15).toFixed(2).replace(".", "\\.")}✗$`)), verdict: "unmet", count: { got: A.T3_VIX_N - 1, need: A.T3_VIX_N } });
  });
  it("vol T3 VIX half (`volNormal`): VIX's own shock open → under VOL_K × its pre-shock median ×5 at the cut ± a tick, or cooling (≤ (1 − VOL_COOL) × peak, falling ×2) with no run", () => {
    const xdev = series(flat(100, 300));
    const vix = (tail: number[]) => series(volShock(tail));
    const [cut, line] = [VOL_K * VOL_PRE_MEDIAN, (1 - VOL_COOL) * VOL_PEAK];
    /** Strictly between the pre-shock VOL_PRE_MEDIAN × K and volShock's rolling 34 × K at any K > 0: over the anchored cut, under the rolling one. */
    const between = (VOL_K * (VOL_PRE_MEDIAN + 34)) / 2;
    expect(shockOf(vix([cut - 0.01]), A)?.open, "premise: VIX's own shockOf (the rung's knobs) is open").toBe(true);
    const r5 = (tail: number[]) => rung("VOL", 2, { XDEV: xdev, R5: vix(tail) });
    expect([flat(cut - 0.01, A.T3_VIX_N), flat(cut - 0.01, A.T3_VIX_N - 1), [...flat(cut - 0.01, A.T3_VIX_N - 1), cut], flat(between, A.T3_VIX_N)].map(r5), "anchored median: a close between the pre-shock 20 × K and the rolling 34 × K is over the anchored cut").toEqual(["met", "unmet", "unmet", "unmet"]);
    expect([[31, 30.5, line], [31, 30.5, line + 0.01], [30.5, 30.5, line]].map(r5), "cooling: at the line ×2 falls met; a tick over, or one fall, not").toEqual(["met", "unmet", "unmet"]);
    expect(FAMS.VOL.rungs[2].read(R, { s: { ...MET, XDEV: xdev, R5: vix([31, 30.5, line]) }, signs: [] }).value).toMatch(new RegExp(`· VIX ${line.toFixed(2).replace(".", "\\.")}/${cut.toFixed(2).replace(".", "\\.")} cooling✓$`));
  });
  it("semis: T1 SEC0 > −10% off high alone · T2 RS_SMH > MA10 and Δ10 > 0 · T3 RS_SMH > MA50", () => {
    expect([rung("SEMIS", 0, {}), rung("SEMIS", 0, { LEGP_SEMIS: UNMET.LEGP_SEMIS })]).toEqual(["met", "unmet"]);
    const up = series(Array.from({ length: 60 }, (_, i) => 1 + 0.001 * i));
    const v = series([...flat(1, 50), ...flat(0.9, 9), 0.99]);
    const down = series(Array.from({ length: 60 }, (_, i) => 2 - 0.001 * i));
    expect([up, v, down].map((c) => [rung("SEMIS", 1, { RS_SMH: c }), rung("SEMIS", 2, { RS_SMH: c })])).toEqual([["met", "met"], ["unmet", "met"], ["unmet", "unmet"]]);
    expect(cell("SEMIS", 1, { RS_SMH: down }), "Δ10 shows its value").toMatch(/ Δ10 -\d\.\d{4} >0✗$/);
    expect(cell("SEMIS", 1, { RS_SMH: down }), "the MA cut names its window").toMatch(new RegExp(`^\\d\\.\\d{4} >MA${A.RS_FAST_N} \\d\\.\\d{4}✗ `));
  });
  it("a cut read off an MA some closes back prints that close's date: price T3 MA rising, EW T3 (T2 compares today's MAs, no date)", () => {
    const md = (i: number): string => dateAt(i).slice(5);
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const [m, back] = [avg(up.slice(-A.T3_MA_N)), avg(up.slice(0, -A.MA_RISING_LAG).slice(-A.T3_MA_N))];
    expect(cell("PRICE", 2, { XDEV: series(up) })).toBe(`159.00 >MA${A.T3_MA_N} ${m.toFixed(2)}✓ · MA${A.T3_MA_N} ${m.toFixed(2)} >${back.toFixed(2)} (${md(59 - A.MA_RISING_LAG)})✓`);
    // The MA prints twice: an MA 0.003 over its lagged self drags the close and both MAs to 3 dp.
    const [N, lag, ma] = [A.T3_MA_N, A.MA_RISING_LAG, 100 + 10 / A.T3_MA_N];
    const oneWidth = [...flat((N * (ma - 0.003) - (N - lag) * 100) / lag, lag), ...flat(100, N - 1), 110];
    expect(cell("PRICE", 2, { XDEV: series(oneWidth) })).toBe(`110.000 >MA${N} ${ma.toFixed(3)}✓ · MA${N} ${ma.toFixed(3)} >${(ma - 0.003).toFixed(3)} (${md(N - 1)})✓`);
    const ratio = (g: number): Pt[] => series(Array.from({ length: 70 }, (_, i) => 1 + g * i));
    const ew = (k: string) => LEGS.find((d) => d.key === k)!.read(R, { s: { ...MET, RSP_SPY: ratio(0.001), QQQE_QQQ: ratio(-0.001) }, signs: [] }).value;
    expect(ew("t3-ew-trend")).toMatch(new RegExp(`^RSP_SPY \\d\\.\\d{4}/\\d\\.\\d{4} \\(${md(69 - A.EW_RISE_N)}\\)✓ · QQQE_QQQ \\d\\.\\d{4}/\\d\\.\\d{4} \\(${md(69 - A.EW_RISE_N)}\\)✗$`));
    expect(ew("t2-ew-trend")).toMatch(/^RSP_SPY \d\.\d{4}\/\d\.\d{4}✓ · QQQE_QQQ \d\.\d{4}\/\d\.\d{4}✗$/);
  });
  it("rates US 10y: T1 no 20-close high ×5 (a high 5 closes back passes, 4 back holds) · T2/T3 z(Δ20) < 1 ×5 — a jump on the last close holds", () => {
    const spike = (ago: number) => series([...flat(4, 40 - 1 - ago), 4.5, ...flat(4, ago)]);
    expect([rung("RATES", 0, { R2: spike(A.T1_RATES_N) }), rung("RATES", 0, { R2: spike(A.T1_RATES_N - 1) })]).toEqual(["met", "unmet"]);
    const calm = Array.from({ length: 300 }, (_, i) => 5 - 0.002 * i + 0.01 * (i % 3));
    expect([rung("RATES", 1, { R2: series(calm) }), rung("RATES", 2, { R2: series([...calm.slice(0, -1), calm.at(-1)! + 0.3]) })]).toEqual(["met", "unmet"]);
  });
  it("banks T3: KBE/SPY (KBE_RS) > MA50; unread → n/a", () => {
    const rs = (g: number) => series(Array.from({ length: 60 }, (_, i) => 1 + g * i));
    expect([rung("BANKS", 2, { KBE_RS: rs(0.001) }), rung("BANKS", 2, { KBE_RS: rs(-0.001) }), rung("BANKS", 2, { KBE_RS: [] })]).toEqual(["met", "unmet", "na"]);
  });
});

describe("read tags", () => {
  it("muMom (the MU 6-month arm) is a level read — MU / MU[−N] − 1 > 0 is a return ratio, retagged off speed", () => {
    const b9b = VALUE_ARMS.find((a) => a.name.startsWith("B9b"))!;
    const mu = b9b.defs.filter((d) => !LEGS_SHIPPED.includes(d));
    expect(mu.map((d) => d.tag)).toEqual([{ series: ["F8"], job: "level", agg: "allOf", indicator: expect.any(String) }]);
  });
});

describe("relative-form window edges", () => {
  const B7 = VALUE_ARMS.find((a) => a.name.startsWith("B7 "))!;
  const def = (key: string) => [...LEGS_SHIPPED, ...B7.defs].find((d) => d.key === key)!;
  it("window edges: an extreme exactly n closes before the last close is in the window, one close further back it is out — RATES T1 (A.RATES_HIGH_N high) and the MU_RS guard (A.MU_RS_LOW_N low) pin newExtreme's n at ±1", () => {
    /** 60 closes flat at `base`, `spike` `back` closes before the last close, the last at `end` (between the two). */
    const edge = (base: number, spike: number, end: number, back: number): Pt[] => series([...flat(base, 60 - back - 1), spike, ...flat(base, back - 1), end]);
    const read = (k: number) => {
      const x: Inputs = { s: { ...EMPTY, R2: edge(3, 3.5, 3.25, A.RATES_HIGH_N + k), MU_RS: edge(1, 0.9, 0.95, A.MU_RS_LOW_N + k) }, signs: SIGNS_OK };
      return { ratesT1: FAMS.RATES.rungs[0].read(R, x), muRs: [def("t2-mu-rs-guard").read(R, x), def("t3-mu-rs-guard").read(R, x)] };
    };
    expect([0, 1].map(read)).toStrictEqual([
      { ratesT1: { value: "3.25/3.50 (02-09)", verdict: "met", count: { got: 5, need: 5 } }, muRs: [{ value: "0.9500/0.9000 (02-09)", verdict: "met", count: { got: 10, need: 10 } }, { value: "0.9500/0.9000 (02-09)", verdict: "met", count: { got: 10, need: 10 } }] },
      { ratesT1: { value: "3.25/3.00 (02-28)", verdict: "unmet", count: { got: 0, need: 5 } }, muRs: [{ value: "0.9500/1.0000 (02-28)", verdict: "unmet", count: { got: 0, need: 10 } }, { value: "0.9500/1.0000 (02-28)", verdict: "unmet", count: { got: 0, need: 10 } }] },
    ]);
  });
});

describe("hybrid guards at each Value site — wave 2 against the HALF line since the series' own shock", () => {
  const [ON, OFF] = [{ ...R, HYBRID_GUARDS: true }, { ...R, HYBRID_GUARDS: false }];
  const TICK = 1e-4;
  const read = (d: (typeof LEGS_SHIPPED)[number], r: typeof ON | typeof OFF, s: Partial<SeriesSet>) => ((o) => [o.verdict, o.count?.got])(d.read(r, { s: { ...MET, ...s }, signs: SIGNS_OK }));
  /** spreadWave: calm 79/81, wave 1 at PEAK (the since-shock extreme), the hold ×`holdN` (the turn), then wave 2's one close — its line ½ back from the hold to the peak. */
  const [PEAK, HOLD] = [150, 100];
  const SPREAD_LINE = HOLD + HALF * (PEAK - HOLD);
  const spread = (last: number, holdN: number): Pt[] => series(spreadWave(80, 1, PEAK, HOLD, [last], holdN));
  /** ratioWave: calm to 100, the trough RATIO_TROUGH (the since-shock low), ×`n` bounces (the turn), then wave 2's one close — its line ½ down from the bounce to the trough. */
  const RATIO_LINE = ratioBounce() + HALF * (RATIO_TROUGH - ratioBounce());
  const ratio = (last: number, n: number): Pt[] => series(ratioWave(n, [last]));
  // the rolling read (flag off) on the short close: the hold / bounces fill the whole lookback, so wave 2 short of the line is still a new extreme there

  it("t1-hy-guard (F1 own shockOf): a tick short of the line holds the run ×T1_HY_GUARD_N, a tick past re-trips it; flag off → the GUARD_HIGH_N-close high trips the short close", () => {
    const d = LEGS_SHIPPED.find((x) => x.key === "t1-hy-guard")!;
    const at = (last: number, r: typeof ON | typeof OFF) => read(d, r, { F1: spread(last, R.GUARD_HIGH_N) });
    expect([at(SPREAD_LINE - TICK, ON), at(SPREAD_LINE + TICK, ON), at(SPREAD_LINE - TICK, OFF)]).toEqual([["met", R.T1_HY_GUARD_N], ["unmet", 0], ["unmet", 0]]);
  });

  it("t2-mu-rs-guard (MU_RS own episode): a tick above the line holds ×T2_MU_RS_GUARD_N, a tick under re-trips; flag off → the MU_RS_LOW_N-close low trips the short close", () => {
    const d = VALUE_ARMS.find((a) => a.name.startsWith("B7 "))!.defs.find((x) => x.key === "t2-mu-rs-guard")!;
    const at = (last: number, r: typeof ON | typeof OFF) => read(d, r, { MU_RS: ratio(last, A.MU_RS_LOW_N) });
    expect([at(RATIO_LINE + TICK, ON), at(RATIO_LINE - TICK, ON), at(RATIO_LINE + TICK, OFF)]).toEqual([["met", A.T2_MU_RS_GUARD_N], ["unmet", 0], ["unmet", 0]]);
  });

  it("rates T1 R2 no-high (R2 own shockOf): a tick short holds ×T1_RATES_N, a tick past re-trips; flag off → the RATES_HIGH_N-close high trips the short close", () => {
    const at = (last: number, r: typeof ON | typeof OFF) => read(FAMS.RATES.rungs[0], r, { R2: spread(last, A.RATES_HIGH_N) });
    expect([at(SPREAD_LINE - TICK, ON), at(SPREAD_LINE + TICK, ON), at(SPREAD_LINE - TICK, OFF)]).toEqual([["met", A.T1_RATES_N], ["unmet", 0], ["unmet", 0]]);
  });
});

describe("measured lifts", () => {
  const CCC = "bear = CCC ≥ 12.5 % or HY OAS ≥ 3.5 %; fizzle = CCC < 11.5 %";
  const credit = (measurable = CCC, on = "2026-11-01"): LadderSign[] => SIGNS.map((s) => (s === "credit" ? { ...signRow(s, true), measurable, blocked: { on } } : signRow(s)));
  const ccc = (...v: number[]) => async (id: string) => (id === "BAMLH0A3HYC" ? v.map((value, i) => ({ date: `2026-11-1${i}`, value })) : []);
  const run = async (signs: LadderSign[], read: (id: string) => Promise<{ date: string; value: number }[]>) => {
    const m = await measuredLifts(signs, read);
    const v = toVerdict(asProbeResult(evaluateShipped(at(MET, R.ZONE_T3), signs, R, LIVE_ARM, undefined, [], undefined, m.lifts)), false);
    return { veto: v.escalation.veto, holdT2T3: v.escalation.holdT2T3, lifts: v.lifts, notes: m.notes };
  };
  it("CCC 11.4, 11.4 drops the credit veto and stamps verdict.lifts; 11.4, 11.6 keeps it", async () => {
    expect(await run(credit(), ccc(11.4, 11.4))).toMatchObject({ veto: [], holdT2T3: false, lifts: [{ sign: "credit", series: "BAMLH0A3HYC", value: 11.4, date: "2026-11-11" }] });
    expect([await run(credit(), ccc(11.4, 11.6)), await run(credit(), ccc(11.6, 11.4))]).toMatchObject([{ veto: ["credit"], holdT2T3: true, lifts: undefined }, { veto: ["credit"], lifts: undefined }]);
  });
  it("block on 11-13: CCC 11.4 on 11-12 + 11-13 keeps the veto (an older close predates it); 11-13 + 11-16 lifts", async () => {
    const dated = (...d: string[]) => async (id: string) => (id === "BAMLH0A3HYC" ? d.map((date) => ({ date, value: 11.4 })) : []);
    expect(await run(credit(CCC, "2026-11-13"), dated("2026-11-12", "2026-11-13"))).toMatchObject({ veto: ["credit"], lifts: undefined, notes: ["measured lift held: credit — BAMLH0A3HYC closes since 11-12 predate the block (11-13)"] });
    expect(await run(credit(CCC, "2026-11-13"), dated("2026-11-13", "2026-11-16"))).toMatchObject({ veto: [], lifts: [{ sign: "credit", date: "2026-11-16", since: "2026-11-13" }] });
  });
  it("clause drift (`fizzle = CCC < 11.0`) keeps the veto and prints the drift line; a fetch failure or a one-close series keeps it", async () => {
    expect(await run(credit("bear = CCC ≥ 12.5 %; fizzle = CCC < 11.0 %"), ccc(10.9, 10.9))).toMatchObject({ veto: ["credit"], lifts: undefined, notes: ["measured lift off: credit — clause drift"] });
    expect(await run(credit(), () => Promise.reject(new Error("FRED 503")))).toMatchObject({ veto: ["credit"], lifts: undefined, notes: ["measured lift held: credit — BAMLH0A3HYC unread — FRED 503"] });
    expect(await run(credit(), ccc(11.4))).toMatchObject({ veto: ["credit"], lifts: undefined });
  });
});

describe("the --into verdict — licensed index levels are not published", () => {
  it("toVerdict leaves no observed licensed level in any string the fixture's raw reads quote", () => {
    const raw = asProbeResult(evaluateShipped(MET, SIGNS_OK, R, S1));
    expect(findLicensedLevelsInLeg(raw).length, "premise: the raw reads quote licensed levels").toBeGreaterThan(0);
    expect(findLicensedLevelsInLeg(toVerdict(raw, false))).toEqual([]);
  });
});
