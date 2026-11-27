import { describe, expect, it } from "vitest";
import { coverageOf, DEEP_ROUTES, dropBadPrints, mergeDeep, replayScorecard, STORED_ONLY, type ReplaySpec } from "./ladder-replay-feeds.js";
import { HOLDOUT_WINDOW, REPLAY, scoreEpisode, type Episode } from "./ladder-replay.js";
import { calm } from "./ladder-replay.test-helpers.js";
import type { Pt } from "./probe-eufin-tranches.js";
import { replaySpec as semisSpec, VERDICT_IDS as SEMIS_IDS } from "./probe-semis-tranches.js";
import { replaySpec as spitSpec, VERDICT_IDS as SPIT_IDS } from "./probe-spit-tranches.js";
import { replaySpec as sp500Spec, VERDICT_IDS as SP500_IDS } from "./probe-sp500-tranches.js";

const dateAt = (i: number): string => new Date(Date.UTC(2019, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (n: number): Pt[] => Array.from({ length: n }, (_, i) => ({ date: dateAt(i), value: 1 }));

describe("deep routes", () => {
  it("every Semis, S&P IT and S&P 500 verdict id has an upstream route or is stored-only", () => {
    const unrouted = [...new Set<string>([...SEMIS_IDS, ...SPIT_IDS, ...SP500_IDS])].filter((id) => DEEP_ROUTES[id] === undefined && !STORED_ONLY.includes(id));
    expect(unrouted).toEqual([]);
  });
  it("a pending-ship id (T10Y3M_RAW) the build does not serve yet takes its route unchecked; any other routed id with no stored closes throws", () => {
    for (const id of ["T10Y3M_RAW"]) expect(mergeDeep({ [id]: [] }, { [id]: series(3) }, [id])[id], id).toHaveLength(3);
    expect(() => mergeDeep({ R4: [] }, { R4: series(3) }, ["R4"])).toThrow(/R4/);
  });
  it("parity reads the stored closes only: an estimated row past PARITY_TOL on an upstream-final date never trips it", () => {
    const stored = series(3).map((p, i) => (i === 2 ? { ...p, value: 1.5, estimated: true } : p));
    expect(mergeDeep({ R4: stored }, { R4: series(3) }, ["R4"]).R4).toHaveLength(3);
  });
});

describe("coverageOf", () => {
  it("flags an id at 0.89 × the fund's in-window closes and admits one at 0.9", () => {
    const s = { FUND: series(100), A: series(89), B: series(90) };
    const cov = coverageOf(s, ["FUND", "A", "B"], "FUND", dateAt(0), dateAt(99));
    expect(cov.n).toEqual({ FUND: 100, A: 89, B: 90 });
    expect(cov.short).toEqual(["A"]);
  });
  it("a weekly id counts against the fund's ISO weeks: one close a week covers, a dropped week under 0.9 is short", () => {
    const fund = series(140); // 2019-01-01 (Tue) on: 21 ISO weeks
    const weekly = (skip: number): Pt[] => fund.filter((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5).slice(skip);
    const s = { FUND: fund, W: weekly(0), X: weekly(2) };
    const cov = coverageOf(s, ["W", "X"], "FUND", dateAt(0), dateAt(139), 0.9, ["W", "X"]);
    expect(cov.n).toEqual({ W: 20, X: 18 });
    expect(cov.short).toEqual(["X"]);
  });
});

describe("dropBadPrints", () => {
  it("drops XDEV 2025-10-24 only, leaves other ids' same date", () => {
    const pts = ["2025-10-23", "2025-10-24", "2025-10-27"].map((date) => ({ date, value: 1 }));
    expect(dropBadPrints("XDEV", pts).map((p) => p.date)).toEqual(["2025-10-23", "2025-10-27"]);
    expect(dropBadPrints("F1", pts)).toHaveLength(3);
  });
  it("drops each 2014 XDEV ≈25 print and keeps the run around them", () => {
    const bad = ["2014-09-11", "2014-09-12", "2014-09-15", "2014-09-16", "2014-09-17", "2014-09-18", "2014-09-19", "2014-09-30", "2014-10-08", "2014-10-10", "2014-10-21", "2014-10-22", "2014-10-31"];
    const keep = ["2014-09-10", "2014-09-22", "2014-10-09", "2014-11-03"];
    const pts = [...bad, ...keep].map((date) => ({ date, value: 1 }));
    expect(dropBadPrints("XDEV", pts).map((p) => p.date)).toEqual(keep);
  });
});

describe("replayScorecard", () => {
  const TODAY = "2022-12-31";
  const at = (i: number): string => new Date(Date.UTC(2022, 0, 3) + i * 86_400_000).toISOString().slice(0, 10);
  const flat = (n: number): Pt[] => Array.from({ length: n }, (_, i) => ({ date: at(i), value: 100 }));
  type Syn = Record<string, Pt[]>;
  /** THIN_BEARS flat-price BEAR episodes, each filled once: PASS unless `cov.short` turns it THIN. */
  const rows = (px: Pt[], bind: boolean) =>
    Array.from({ length: Math.max(1, HOLDOUT_WINDOW.THIN_BEARS) }, (_, i) => {
      const ep: Episode = { shockStart: at(i * 30), exit: at(i * 30 + 5), end: at(i * 30 + 25), open: false, drop: 0.05, rise: 0.05, shape: "BEAR", troughLag: 10 };
      return { ...scoreEpisode(px, ep, [at(i * 30 + 10), null, null]), ...(bind && { binding: [at(i * 30 + 10)] }) };
    });
  const spec = (over: Partial<ReplaySpec<Syn>> = {}): ReplaySpec<Syn> => ({
    fund: "FUND",
    px: "PX",
    ids: ["FUND", "A"],
    trim: (all, f) => Object.fromEntries(Object.entries(all).map(([id, c]) => [id, f(c)])),
    run: (s, _k, bind) => rows(s.FUND!, bind),
    why: () => [{ exit: at(5), tranche: "T1", date: at(10), trough: 0, rows: [{ key: "k", gate: false, verdict: "met" }], via: "count 1/1" }],
    head: { verdict: "H-verdict", drift: "H-drift", why: "H-why", p0: "H-p0" },
    ...over,
  });
  /** A's 50 closes vs FUND's 100: A is short. */
  const run = async (arg: string, sp: ReplaySpec<Syn>, feeds: Syn = { FUND: flat(100), A: flat(50) }) => {
    const out: string[] = [];
    let calls = 0;
    const done = replayScorecard("B", arg, sp, TODAY, async () => (calls++, feeds), (l) => out.push(l)).then(() => out.join("\n"));
    return { done, calls: () => calls };
  };
  const print = async (arg: string, sp: ReplaySpec<Syn> = spec()): Promise<string> => (await run(arg, sp)).done;

  it.each([
    ["sweep", "H-verdict", /→ THIN · \d+ real bear\(s\) · THIN: A short$/m],
    ["drift:sweep", "H-drift", /→ DRIFT PASS/],
    ["why:sweep", "H-why", /\| count 1\/1$/m],
    ["p0:sweep", "H-p0", /^ruled\s+0\s+\d+\s+pass\s+THIN$/m],
  ])("%s prints its own head, then its own table; a short id turns PASS into THIN", async (arg, head, table) => {
    const text = await print(arg);
    expect(text).toContain(`\n${arg} ${REPLAY.FROM} → ${TODAY} · ${head}\n`);
    expect(text).toMatch(table);
  });
  it("coverage header: closes per id, then the short ids; the ISO-week clause only when a weekly id is in `ids`", async () => {
    expect((await print("sweep")).split("\n").slice(0, 2)).toEqual([
      `closes in ${REPLAY.FROM} → ${TODAY}: FUND 100 · A 50`,
      `history starts: FUND ${at(0)} · A ${at(0)} · short (under ${HOLDOUT_WINDOW.MIN_COVER} × PX's in-window closes): A`,
    ]);
    expect(await print("sweep", spec({ ids: ["FUND", "A", "F3"] }))).toContain(`short (under ${HOLDOUT_WINDOW.MIN_COVER} × PX's in-window closes; weekly F3: × its ISO weeks): A, F3`);
  });
  it("a mode with no head throws naming `deferred`, before `feeds` is called; the real sp500 spec defers p0", async () => {
    const { p0: _p0, ...noP0 } = spec().head;
    for (const [sp, msg] of [[spec({ head: noP0, deferred: "needs X" }), /p0 is deferred for the PX replay \(needs X\)/], [sp500Spec as unknown as ReplaySpec<Syn>, /p0 is deferred .*firesFrom/]] as const) {
      const r = await run("p0:sweep", sp);
      await expect(r.done).rejects.toThrow(msg);
      expect(r.calls()).toBe(0);
    }
  });
  it("p0 throws on an episode with no `binding`", async () => {
    await expect(print("p0:sweep", spec({ run: (s) => rows(s.FUND!, false) }))).rejects.toThrow(/no binding days/);
  });
  /** Fund = calm() to its high, then a drop that opens one episode in the sweep window; every other id empty. */
  it.each([
    ["semis", "p0:sweep", semisSpec],
    ["spit", "p0:sweep", spitSpec],
    ["sp500", "why:sweep", sp500Spec],
  ] as const)("%s's real spec runs on synthetic feeds and prints its own head for %s", async (_leg, arg, real) => {
    const fund = [...calm(), ...Array.from({ length: 20 }, (_, i) => 99 - i * 0.1)].map((value, i) => ({ date: new Date(Date.UTC(2021, 2, 1) + i * 86_400_000).toISOString().slice(0, 10), value }));
    const sp = real as unknown as ReplaySpec<Syn>;
    const mode = arg.slice(0, arg.indexOf(":")) as "p0" | "why";
    const r = await run(arg, sp, Object.fromEntries(sp.ids.map((id) => [id, id === sp.fund ? fund : []])));
    expect(await r.done).toContain(` · ${sp.head[mode]!}\n`);
  });
});
