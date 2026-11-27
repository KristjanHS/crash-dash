import { describe, expect, it } from "vitest";
import { BOX_KERNEL, boxOf, kleeneAnd, kleeneOr, watchOf, type Cell, type Roster } from "./ladder-box";

type Id = "a" | "b" | "c" | "d" | "e";
const ROSTER = [
  { name: "rates", kind: "lead", members: ["a", "b", "c"] },
  { name: "credit", kind: "coincident", members: ["d"] },
  { name: "vol", kind: "coincident", members: ["e"] },
] as const satisfies Roster<Id>;
// @ts-expect-error — `zz` is not a member id: `satisfies Roster<Id>` must reject the typo
const TYPO = [{ name: "x", kind: "lead", members: ["zz"] }] as const satisfies Roster<Id>;
void TYPO;

const cells = (over: Partial<Record<Id, Cell>> = {}): Record<Id, Cell> => ({ a: false, b: false, c: false, d: false, e: false, ...over });
const rates = (over: Partial<Record<Id, Cell>>) => boxOf(ROSTER, cells(over)).clusters[0];

describe("boxOf", () => {
  it("majority of live: 1 of 2 live no vote, 2 of 3 votes", () => {
    expect(rates({ a: "hit", c: "na" })).toMatchObject({ hits: 1, live: 2, vote: false });
    expect(rates({ a: "hit", b: "hit" })).toMatchObject({ hits: 2, live: 3, vote: true });
    expect(rates({ a: "hit" })).toMatchObject({ hits: 1, live: 3, vote: false });
  });

  it("all-n/a no vote", () => {
    expect(rates({ a: "na", b: "na", c: "na" })).toMatchObject({ hits: 0, live: 0, vote: false });
  });

  it("quorum boundary: q live clears, q - 1 live is T1 only", () => {
    const ids = ["a", "b", "c", "d", "e"] as const;
    const q = Math.ceil(BOX_KERNEL.QUORUM_SHARE * ids.length);
    expect(q).toBeGreaterThan(0);
    const dark = (k: number) => cells(Object.fromEntries(ids.slice(0, k).map((id) => [id, "na"])));
    expect(boxOf(ROSTER, dark(ids.length - q))).toMatchObject({ live: q, n: ids.length, quorum: q, t1Only: false });
    expect(boxOf(ROSTER, dark(ids.length - q + 1))).toMatchObject({ live: q - 1, t1Only: true });
  });

  it("pre-history none: leaves the denominator, a post-history n/a does not", () => {
    const q3 = Math.ceil(BOX_KERNEL.QUORUM_SHARE * 3);
    expect(boxOf(ROSTER, cells({ a: "none", b: "none" }))).toMatchObject({ live: 3, n: 3, quorum: q3, t1Only: false });
    expect(boxOf(ROSTER, cells({ a: "na", b: "na" }))).toMatchObject({ live: 3, n: 5 });
    expect(boxOf(ROSTER, cells({ a: "none", b: "none", c: "none", d: "none", e: "none" }))).toMatchObject({ n: 0, t1Only: true });
  });

  it("hold needs a coincident and a lead vote; two coincident alone do not hold", () => {
    expect(boxOf(ROSTER, cells({ d: "hit", e: "hit" }))).toMatchObject({ votes: ["credit", "vol"], hold: false });
    expect(boxOf(ROSTER, cells({ a: "hit", b: "hit" }))).toMatchObject({ votes: ["rates"], hold: false });
    expect(boxOf(ROSTER, cells({ a: "hit", b: "hit", d: "hit" }))).toMatchObject({ votes: ["rates", "credit"], hold: true });
  });

  it("`leadAlone`: a lead vote holds without a coincident one; coincident votes alone still do not", () => {
    const lead = (opts = {}) => boxOf(ROSTER, cells({ a: "hit", b: "hit" }), [], opts).hold;
    expect([lead(), lead({ leadAlone: true }), boxOf(ROSTER, cells({ d: "hit", e: "hit" }), [], { leadAlone: true }).hold]).toEqual([false, true, false]);
  });

  it("members: each roster id with its own cell, in roster order", () => {
    expect(boxOf(ROSTER, cells({ a: "hit", b: "na", c: "none", e: "hit" })).clusters.map((c) => c.members)).toEqual([
      [{ id: "a", cell: "hit" }, { id: "b", cell: "na" }, { id: "c", cell: "none" }],
      [{ id: "d", cell: false }],
      [{ id: "e", cell: "hit" }],
    ]);
  });

  it("a veto holds its reach with zero votes: all → every tranche, T2T3 → T2·T3 only", () => {
    expect(boxOf(ROSTER, cells(), [{ name: "capex_guides", reach: "all" }])).toMatchObject({ votes: [], hold: true, holdT2T3: true, veto: ["capex_guides"] });
    expect(boxOf(ROSTER, cells(), [{ name: "capex_guides", reach: "T2T3" }])).toMatchObject({ votes: [], hold: false, holdT2T3: true, veto: ["capex_guides"] });
    expect(boxOf(ROSTER, cells())).toMatchObject({ hold: false, holdT2T3: false });
  });
});

describe("kleeneAnd", () => {
  it("false dominates n/a; n/a dominates hit", () => {
    expect(kleeneAnd("hit", "na")).toBe("na");
    expect(kleeneAnd(false, "na")).toBe(false);
    expect(kleeneAnd("hit", "hit")).toBe("hit");
  });
  it("pre-history leg drops out: hit ∧ none = hit, false ∧ none = false, all none = none", () => {
    expect(kleeneAnd("hit", "none")).toBe("hit");
    expect(kleeneAnd(false, "none")).toBe(false);
    expect(kleeneAnd("none", "none")).toBe("none");
  });
});

describe("kleeneOr", () => {
  it("hit dominates n/a; n/a dominates false; a none leg drops out", () => {
    expect([kleeneOr("na", "hit"), kleeneOr(false, "na"), kleeneOr(false, "none"), kleeneOr("hit", "none"), kleeneOr("none", "none")]).toEqual(["hit", "na", false, "hit", "none"]);
  });
});

describe("watchOf", () => {
  const ids = ["a", "b", "c", "d", "e"] as const;
  const rows = (corr: Partial<Record<Id, Cell>> = {}, bear: Partial<Record<Id, Cell>> = {}) => ids.map((key) => ({ key, correction: { cell: cells(corr)[key] }, bear: { cell: cells(bear)[key] } }));
  const grade = (corr: Partial<Record<Id, Cell>> = {}, bear: Partial<Record<Id, Cell>> = {}) => watchOf(ROSTER, rows(corr, bear)).grade;
  it("grade ladder: CALM · ELEVATED (a correction vote) · HIGH (correction hold) · SEVERE (bear hold); a bear coincident vote without a lead stays below SEVERE", () => {
    expect([grade(), grade({ d: "hit" }), grade({ a: "hit", b: "hit", d: "hit" }), grade({ a: "hit", b: "hit", d: "hit" }, { a: "hit", b: "hit", d: "hit" }), grade({ d: "hit" }, { d: "hit", e: "hit" })]).toEqual(["CALM", "ELEVATED", "HIGH", "SEVERE", "ELEVATED"]);
  });
  it("` (thin)` when the correction box is below quorum", () => {
    expect(grade({ a: "na", b: "na", c: "na", d: "hit" })).toBe("ELEVATED (thin)");
  });
  it("a box below quorum caps the grade at ELEVATED (thin): a bear hold with the bear box thin is not SEVERE; a thin calm reads CALM (thin)", () => {
    const hold = { a: "hit", b: "hit", d: "hit" } as const;
    expect([grade(hold, { ...hold, c: "na", e: "na" }), grade(hold, { c: "na", d: "na", e: "na" }), grade({}, { c: "na", d: "na", e: "na" })]).toEqual(["ELEVATED (thin)", "ELEVATED (thin)", "CALM (thin)"]);
  });
  it("a manual row in the roster throws, off the roster it never grades; a roster member with no row throws", () => {
    const manual = { key: "f" as Id, manual: true as const, correction: { cell: "hit" as Cell }, bear: { cell: "hit" as Cell } };
    expect(watchOf(ROSTER, [...rows(), manual]).grade).toBe("CALM");
    expect(() => watchOf(ROSTER, rows().map((r) => (r.key === "d" ? { ...r, manual: true as const } : r)))).toThrow(/manual row/);
    expect(() => watchOf(ROSTER, rows().filter((r) => r.key !== "e"))).toThrow(/no watch row/);
  });
});
