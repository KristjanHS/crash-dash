import { describe, expect, it } from "vitest";
import { findNetNewRulingIds } from "./check-ruling-ids.js";

const diff = (file: string, minus: string[], plus: string[], oldFile = file): string =>
  [`diff --git a/${oldFile} b/${file}`, `--- a/${oldFile}`, `+++ b/${file}`, "@@ -1 +1 @@", ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join("\n");
const ids = (d: string): string[] => findNetNewRulingIds(d).map((v) => `${v.file}:${v.id}`);

describe("findNetNewRulingIds", () => {
  it("flags a ruling id minted in a comment, a trailing comment and a test title", () => {
    expect(ids(diff("src/a.ts", [], ["  // E12: carry marker", "  x(); // per S4", '  it("U2: lagging row", () => {'])))
      .toEqual(["src/a.ts:E12", "src/a.ts:S4", "src/a.ts:U2"]);
  });

  it("never scans code, indicator ids, the dial name or tranche names", () => {
    expect(ids(diff("src/a.ts", [], [
      "const s = B0 + B1 * pct(nav);",
      'fetchBundYield("Y02");',
      "Date.parse(`${d}T00:00:00Z`);",
      "// F5 and R6 and G1 feed the T1 dial; G3-hormuz is a geo flag",
      '  it("BUND short dates T2 sovereigns not T3", () => {',
      "// git diff -U0 range",
      'const u = "x // E12";',
    ]))).toEqual([]);
  });

  it("reports every `+` site of a net-new id, not just the first", () => {
    expect(ids(diff("src/a.ts", [], ["// G4: seam gate", '  it("G4 fails the seam", () => {'])))
      .toEqual(["src/a.ts:G4", "src/a.ts:G4"]);
  });

  it("passes a reworded cite and blocks only the net-new one", () => {
    expect(ids(diff("api/lab.ts", ["// E3: served marker"], ["// E3: served STORED marker", "// L4: new arm"])))
      .toEqual(["api/lab.ts:L4"]);
  });

  it("passes a cross-file move and blocks a copy into a second file", () => {
    const move = diff("src/a.ts", ["// E3: marker"], []) + "\n" + diff("src/b.ts", [], ["// E3: marker"]);
    expect(ids(move)).toEqual([]);
    expect(ids(diff("src/b.ts", [], ["// E3: marker"]))).toEqual(["src/b.ts:E3"]);
  });

  it("ignores removals, docs and the probe archive", () => {
    expect(ids(diff("src/a.ts", ["// E3: gone"], []))).toEqual([]);
    expect(ids(diff("docs/backlog.md", [], ["// E12 owed"]))).toEqual([]);
    expect(ids(diff("scripts/archive/probe-x.ts", [], ["// K1 arm"]))).toEqual([]);
  });

  it("exempts registry ids exactly, not by letter", () => {
    expect(ids(diff("src/a.ts", [], ["// R9 and R10 rulings, R6 indicator", "// G5 and G2.2 rulings", "// T4 ruling, T3 tranche"])))
      .toEqual(["src/a.ts:R9", "src/a.ts:R10", "src/a.ts:G5", "src/a.ts:G2", "src/a.ts:T4"]);
  });

  it("counts an id once per line", () => {
    expect(ids(diff("src/a.ts", ["// E3: a"], ["// E3: a, see E3"]))).toEqual([]);
  });

  it("reads `+++ ` inside a hunk as content, not a file header", () => {
    expect(ids(diff("src/a.ts", [], ["++ x", "// E12 owed"]))).toEqual(["src/a.ts:E12"]);
  });

  it("reads shell comments only in shell files", () => {
    expect(ids(diff("scripts/ship.sh", [], ["# D1 gate", "run x  # per W6"]))).toEqual(["scripts/ship.sh:D1", "scripts/ship.sh:W6"]);
    expect(ids(diff("src/a.ts", [], ["#D1;"]))).toEqual([]);
  });
});
