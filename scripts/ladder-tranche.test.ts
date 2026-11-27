import { describe, expect, it, vi } from "vitest";
import type { TrancheId as Tranche } from "../src/ladder-live.js";
import { episodes, REPLAY, type Pt } from "./ladder-replay.js";
import { calm } from "./ladder-replay.test-helpers.js";
import { boxHolds, boxStatus, clearedBox, famNeedOf, fizzleFill, followedOf, latchedFills, openExitOf, sinceOf, tallyOf, votesText, walkFollow, type BoxHold, type NeedKnobs, type RawLeg, type TrancheResult, type Verdict } from "./ladder-tranche.js";

const leg = (tranche: Tranche, verdict: Verdict, extra: Partial<RawLeg> = {}): RawLeg => ({ key: `${tranche}-${verdict}`, tranche, gate: false, value: "", verdict, ...extra });
/** `met` met + `unmet` unmet criteria on `t`. */
const crit = (t: Tranche, met: number, unmet: number): RawLeg[] => [...Array.from({ length: met }, () => leg(t, "met")), ...Array.from({ length: unmet }, () => leg(t, "unmet"))];
/** 0.28·25 and 0.56·25 land a float ulp over 7 and 14. */
const SHARES = { FAM_T2_SHARE: 0.28, FAM_T3_SHARE: 0.56 };
const flat = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
const BOX = { calm: { hold: false, quorum: { t1Only: false } }, hold: { hold: true, quorum: { t1Only: false } }, short: { hold: false, quorum: { t1Only: true } }, t2t3: { hold: false, holdT2T3: true, quorum: { t1Only: false } } } satisfies Record<string, BoxHold>;

describe("famNeedOf / tallyOf: needs and gates", () => {
  it("famNeedOf: T1 needs 1 at any N; T2/T3 ⌈share·N⌉, a product a float ulp over an integer taking that integer", () => {
    expect((["T1", "T2", "T3"] as const).map((t) => [famNeedOf(t, 4, SHARES), famNeedOf(t, 25, SHARES)])).toEqual([[1, 1], [2, 7], [3, 14]]);
  });
  it("need per NeedKnobs: famNeed over families · readable less slack, floored at 1 · the lower of both · an absorbed rung drops a family only under absorbedDrops", () => {
    const absorbed = [...crit("T2", 0, 2), leg("T2", "na", { absorbed: true })];
    const rows: [string, NeedKnobs, RawLeg[], number][] = [
      ["families", { shares: SHARES, families: 25 }, crit("T2", 0, 3), 7],
      ["slack", { shares: SHARES, slack: 1 }, crit("T2", 0, 4), 3],
      ["slack floor", { shares: SHARES, slack: 1 }, crit("T2", 0, 1), 1],
      ["families + slack", { shares: SHARES, families: 25, slack: 1 }, crit("T2", 0, 4), 3],
      ["absorbedDrops: ⌈0.28·3⌉", { shares: SHARES, families: 4, absorbedDrops: true }, absorbed, 1],
      ["no absorbedDrops: ⌈0.28·4⌉", { shares: SHARES, families: 4 }, absorbed, 2],
    ];
    expect(rows.map(([name, k, legs]) => [name, tallyOf("T2", legs, null, k).need])).toEqual(rows.map(([name, , , need]) => [name, need]));
  });
  const k: NeedKnobs = { shares: SHARES, slack: 1 };
  it("ready on need met criteria with every gate met; one fewer, an unmet gate or an n/a gate holds; an n/a criterion leaves the count", () => {
    const gate = (v: Verdict) => leg("T2", v, { gate: true });
    expect([tallyOf("T2", crit("T2", 2, 1), null, k), tallyOf("T2", crit("T2", 1, 2), null, k)].map((r) => [r.need, r.ready, r.clear])).toEqual([[2, true, true], [2, false, true]]);
    expect([gate("unmet"), gate("na")].map((g) => tallyOf("T2", [...crit("T2", 3, 0), gate("met"), g], null, k)).map((r) => [r.ready, r.clear, r.gates])).toEqual([[false, false, ["met", "unmet"]], [false, false, ["met", "na"]]]);
    expect(tallyOf("T2", [...crit("T2", 1, 0), leg("T2", "na"), leg("T2", "na")], null, k)).toMatchObject({ metCount: 1, total: 1, need: 1, ready: true });
    expect(tallyOf("T2", [...crit("T2", 2, 1), ...crit("T1", 0, 5), leg("T3", "unmet", { gate: true })], null, k), "another tranche's legs never count").toMatchObject({ total: 3, ready: true });
  });
  it("box: a hold holds every tranche, holdT2T3 or below quorum only T2/T3, a calm or absent box none — boxHolds and the tally's clear agree", () => {
    const holds = (e: BoxHold) => (["T1", "T2", "T3"] as const).map((t) => [boxHolds(t, e), !tallyOf(t, crit(t, 3, 0), e, k).clear]);
    expect([holds(BOX.hold), holds(BOX.short), holds(BOX.t2t3), holds(BOX.calm)]).toEqual([Array(3).fill([true, true]), [[false, false], [true, true], [true, true]], [[false, false], [true, true], [true, true]], Array(3).fill([false, false])]);
    expect(tallyOf("T2", crit("T2", 3, 0), null, k).ready, "no box read").toBe(true);
  });
});

describe("sinceOf", () => {
  const px = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"].map((date) => ({ date }));
  it("the oldest close of the newest ready run — an older ready close past a break never extends it; a not-ready newest close is null", () => {
    const ready = new Set(["2026-01-05", "2026-01-07", "2026-01-08"]);
    const readyAt = vi.fn((d: string) => ready.has(d));
    expect(sinceOf(px, readyAt)).toBe("2026-01-07");
    expect(readyAt.mock.calls.map(([d]) => d), "the walk stops at the break").toEqual(["2026-01-08", "2026-01-07", "2026-01-06"]);
    expect(sinceOf(px, (d) => d !== "2026-01-08")).toBeNull();
  });
});

describe("walkFollow / latchedFills", () => {
  const EXIT = "2026-01-05";
  const after = ["2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"].map((date) => ({ date }));
  it("a latched fill on or after the exit stays, one older drops — so a later episode fills from T1", () => {
    expect(latchedFills(EXIT, ["2026-01-04", EXIT, "2026-01-07"])).toEqual([null, EXIT, "2026-01-07"]);
    expect(latchedFills(EXIT)).toEqual([null, null, null]);
  });
  it("a latched fill survives a fire that never fires; each tranche keeps its first firing close; fire sees the fills before its close", () => {
    const seen: (string | null)[][] = [];
    const f = walkFollow(EXIT, after, [EXIT, null, null], (d, fills) => (seen.push([...fills]), [false, d >= "2026-01-07", d >= "2026-01-08"]));
    expect(f).toEqual({ exit: EXIT, fills: [EXIT, "2026-01-07", "2026-01-08"], n: 4 });
    expect(seen.slice(0, 3)).toEqual([[EXIT, null, null], [EXIT, null, null], [EXIT, "2026-01-07", null]]);
  });
  it("the walk stops once all three are filled: fire is not called again", () => {
    const fire = vi.fn((_d: string, _f: readonly (string | null)[]) => [true, true, true]);
    expect(walkFollow(EXIT, after, [], fire).fills).toEqual(Array(3).fill("2026-01-06"));
    expect(walkFollow(EXIT, after, [EXIT, EXIT, EXIT], fire).n).toBe(4);
    expect(fire).toHaveBeenCalledTimes(1);
  });
  it("openExitOf: the newest episode's exit while it is open — an ended earlier one never answers; none open → undefined", () => {
    const PRE = REPLAY.VOL_N + 1;
    const date = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const pts = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: date(i), value }));
    /** exit 1 at PRE ends PRE + 5 (back at its high); exit 2 at PRE + 76 stays open. */
    const two = pts([...calm(PRE), ...flat(94, 5), ...flat(100, 71), ...flat(94, 5)]);
    expect(episodes(two).map((e) => [e.exit, e.open]), "premise: one ended, one open").toEqual([[date(PRE), false], [date(PRE + 76), true]]);
    expect([openExitOf(two), openExitOf(two.slice(0, PRE + 76))]).toEqual([date(PRE + 76), undefined]);
  });
});

describe("fizzleFill", () => {
  const D = "2026-01-09";
  const clear = () => true;
  it("fires T2 on T1's fill close — T1 latched on it or firing on it — when fizzled and T2 clear; T1/T3 untouched", () => {
    expect([fizzleFill([false, false, false], [D, null, null], D, true, clear), fizzleFill([true, false, false], [null, null, null], D, true, clear)]).toEqual([[false, true, false], [true, true, false]]);
  });
  it("no fast fill on a later close than T1's fill, with T1 unfilled, with T2's gates unmet, nor unfizzled — where T2's clear is never read", () => {
    const thunk = vi.fn(() => true);
    expect(fizzleFill([false, false, false], [null, null, null], D, true, clear), "T1 neither latched nor firing").toEqual([false, false, false]);
    expect([fizzleFill([true, false, false], ["2026-01-02", null, null], D, true, clear), fizzleFill([true, false, false], [null, null, null], D, true, () => false), fizzleFill([true, false, false], [null, null, null], D, false, thunk)]).toEqual(Array(3).fill([true, false, false]));
    expect(thunk).not.toHaveBeenCalled();
  });
});

describe("followedOf", () => {
  const D = "2026-01-09";
  const t = (tranche: Tranche, ready: boolean): TrancheResult => ({ ...tallyOf(tranche, [], null, { shares: SHARES, slack: 0 }), ready, met: ready, filled: ready });
  const ts = [t("T1", true), t("T2", false), t("T3", false)];
  const via = () => "after T1" as const;
  it("fired overrides ready; a tranche met by the follow alone names via; a fill sets since/fill, else the newest close when met by the follow", () => {
    const rows = followedOf(ts, [false, true, true], [null, null, "2026-01-07"], D, via);
    expect(rows.map((r) => [r.met, r.filled, r.via, r.since, r.fill])).toEqual([[false, false, undefined, null, undefined], [true, true, "after T1", D, true], [true, true, "after T1", "2026-01-07", true]]);
  });
  it("no follow: met is the tally's ready, no via; a stored fill still carries as since/fill, met or not", () => {
    const rows = followedOf(ts, null, [null, null, "2026-01-03"], D, via);
    expect(rows.map((r) => [r.met, r.via, r.since, r.fill])).toEqual([[true, undefined, null, undefined], [false, undefined, null, undefined], [false, undefined, "2026-01-03", true]]);
  });
});

describe("box text: votesText / boxStatus / clearedBox", () => {
  it("votesText: voting clusters (— when none) · the veto clause only with a veto · live/n need quorum", () => {
    const q = { live: 4, n: 5, need: 4 };
    expect([votesText({ hits: ["credit", "rates"], veto: ["x"], quorum: q }), votesText({ hits: [], veto: [], quorum: q })]).toEqual(["votes credit, rates · veto x · live 4/5 need 4", "votes — · live 4/5 need 4"]);
  });
  it("boxStatus: a hold wins over holdT2T3, holdT2T3 over below quorum; clearedBox lifts all three, keeps every other field and leaves its input as read", () => {
    const both = { hold: true, holdT2T3: true, quorum: { t1Only: true, live: 2 }, tag: "k" };
    expect([BOX.hold, BOX.t2t3, { ...BOX.t2t3, quorum: { t1Only: true } }, BOX.short, BOX.calm, both].map(boxStatus)).toEqual(["holds every tranche", "holds T2·T3", "holds T2·T3", "below quorum — T1 only", "no hold", "holds every tranche"]);
    expect([clearedBox(both), both]).toEqual([{ hold: false, holdT2T3: false, quorum: { t1Only: false, live: 2 }, tag: "k" }, { hold: true, holdT2T3: true, quorum: { t1Only: true, live: 2 }, tag: "k" }]);
  });
});
