import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { brokenRows, type EquivalentRow, type MutationReport, triageUndetected } from "./mutate-ranges.js";

const ROWS = JSON.parse(readFileSync("scripts/mutate-equivalents.json", "utf8")) as EquivalentRow[];
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const row = (over: Partial<EquivalentRow> = {}): EquivalentRow => ({
  file: "src/x.ts",
  mutator: "EqualityOperator",
  replacement: "i <= n",
  src: "for (let i = 0; i < n; i++) {",
  orig: "i < n",
  reason: "equivalent - the extra pass reads undefined",
  ...over,
});

describe("scripts/mutate-equivalents.json", () => {
  it("every row names a live source line of its file and a reason", () => {
    expect(brokenRows(ROWS, read)).toEqual([]);
  });

  it("can fail: a moved line, a missing file and an empty reason are all reported", () => {
    const src = (f: string) => (f === "src/x.ts" ? "  for (let i = 0; i < n; i++) {\n" : null);
    expect(brokenRows([row()], src)).toEqual([]);
    const bad = [row({ src: "for (let i = 0; i <= n; i++) {" }), row({ file: "src/gone.ts" }), row({ reason: " " })];
    expect(brokenRows(bad, src)).toEqual(bad);
  });
});

/** `path:line` of every `Stryker disable` comment directive; a bare string mention is not one. */
const disableHits = (files: { path: string; text: string }[]) =>
  files.flatMap(({ path, text }) =>
    text.split("\n").flatMap((l, i) => (/\/[/*]+\s*Stryker\s+disable/i.test(l) ? [`${path}:${i + 1}`] : [])),
  );

describe("no Stryker disable in src/ - an equivalent is a row", () => {
  it("no src/**/*.ts carries a disable directive", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ path: `src/${f}`, text: readFileSync(`src/${f}`, "utf8") }));
    expect(files.length).toBeGreaterThan(0);
    expect(disableHits(files)).toEqual([]);
  });

  it("can fail: a line or block directive is reported, a string mention is not", () => {
    const text = 'const a = 1;\n  // Stryker disable next-line EqualityOperator: x\n/* Stryker disable all */\nconst s = "Stryker disable";';
    expect(disableHits([{ path: "src/x.ts", text }])).toEqual(["src/x.ts:2", "src/x.ts:3"]);
  });
});

describe("triageUndetected", () => {
  const source = "a\n  for (let i = 0; i < n; i++) {\n  while (k > 0 && k / n > p) k--;\nb";
  // Stryker columns: 1-based, end exclusive.
  const m = (status: string, line: number, col: [number, number], replacement: string, mutatorName = "EqualityOperator") => ({
    status,
    mutatorName,
    replacement,
    location: { start: { line, column: col[0] }, end: { line, column: col[1] } },
  });
  const report: MutationReport = {
    files: {
      "src/x.ts": {
        source,
        mutants: [
          m("Survived", 2, [19, 24], "i <= n"),
          m("Survived", 2, [19, 24], "i >= n"),
          m("Killed", 2, [19, 24], "false", "ConditionalExpression"),
          m("Survived", 3, [10, 15], "true", "ConditionalExpression"),
          m("Survived", 3, [19, 28], "true", "ConditionalExpression"),
        ],
      },
    },
  };
  const guard = row({ mutator: "ConditionalExpression", replacement: "true", src: "while (k > 0 && k / n > p) k--;", orig: "k > 0" });

  it("excuses only the exact listed mutant: never a same-line sibling, even one sharing mutator + replacement", () => {
    const { open, stale } = triageUndetected(report, "src/x.ts", [row(), guard]);
    expect(open.map((x) => `${x.location.start.line}:${x.replacement}`)).toEqual(["2:i >= n", "3:true"]);
    expect(stale).toEqual([]);
  });

  it("a row is stale only on a line the report mutated: its mutant killed there, never a line a partial report skipped", () => {
    const killed = row({ mutator: "ConditionalExpression", replacement: "false" });
    const unmutated = row({ src: "b", orig: "b" });
    expect(triageUndetected(report, "src/x.ts", [killed, unmutated]).stale).toEqual([killed]);
    expect(() => triageUndetected({ files: {} }, "src/x.ts", [row()])).toThrow(/not in the mutation report/);
  });
});
