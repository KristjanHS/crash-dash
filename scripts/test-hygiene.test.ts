/**
 * Test hygiene over every collected test file: no `.only`, no `.skip` without a reason comment, no `expect`
 * inside an `if` (a branch that never runs passes vacuously). Zero exceptions, so no roster
 *.
 */
import { globSync } from "node:fs";
import { matchesGlob } from "node:path";
import type TS from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

import { expectClean, loadTs, misfires, scan, SCAN_HOOK_TIMEOUT, type ScanReport, type Visitor } from "../src/source-scan.test-helpers.js";
import { sharedTestOptions } from "../vitest.shared.js";

let ts: typeof TS; // loaded in `beforeAll`: keeps typescript.js out of collect time

// The `shared` project's include; its exclude plus the isolated list cover every collected file.
const EXCLUDE = sharedTestOptions("test").exclude;
const excluded = (p: string): boolean => EXCLUDE.some((g) => matchesGlob(p, g) || matchesGlob(`${p}/x`, g));
const TEST_FILES = globSync(["**/*.test.ts", "**/*.test.js"], { exclude: excluded }).sort();

const ONLY = "only";
const SKIP = "skip-without-reason";
const IF_EXPECT = "expect-in-if";
const KINDS = [ONLY, SKIP, IF_EXPECT] as const;
const RUNNERS = new Set(["it", "test", "describe", "suite"]);

/** The leftmost identifier of `a.b.c`, else null. */
const rootName = (e: TS.Expression): string | null => {
  let x = e;
  while (ts.isPropertyAccessExpression(x)) x = x.expression;
  return ts.isIdentifier(x) ? x.text : null;
};

const commentLines = new WeakMap<TS.SourceFile, Set<number>>();
/** 0-based lines carrying (or ending) a comment with text in it, from the AST's own comment ranges. */
const linesWithComment = (sf: TS.SourceFile): Set<number> => {
  const cached = commentLines.get(sf);
  if (cached) return cached;
  const out = new Set<number>();
  const text = sf.getFullText();
  const add = (ranges: TS.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (!/\w/.test(text.slice(r.pos, r.end))) continue;
      out.add(sf.getLineAndCharacterOfPosition(r.pos).line);
      out.add(sf.getLineAndCharacterOfPosition(r.end).line);
    }
  };
  const go = (n: TS.Node): void => {
    add(ts.getLeadingCommentRanges(text, n.pos));
    add(ts.getTrailingCommentRanges(text, n.end));
    ts.forEachChild(n, go);
  };
  go(sf);
  commentLines.set(sf, out);
  return out;
};

/** True when `n` sits in an `if`'s then- or else-branch, at any depth, nested functions included. */
const insideIfBranch = (n: TS.Node): boolean => {
  for (let c = n, p = n.parent; p; c = p, p = p.parent) {
    if (ts.isIfStatement(p) && (p.thenStatement === c || p.elseStatement === c)) return true;
  }
  return false;
};

const HYGIENE: Visitor = {
  visit: (n) => {
    if (ts.isPropertyAccessExpression(n) && RUNNERS.has(rootName(n.expression) ?? "")) {
      if (n.name.text === "only") return ONLY;
      if (n.name.text === "skip") {
        const sf = n.getSourceFile();
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        const lines = linesWithComment(sf);
        return lines.has(line) || lines.has(line - 1) ? null : SKIP;
      }
      return null;
    }
    if (!ts.isCallExpression(n)) return null;
    const c = n.expression;
    const isExpect = (ts.isIdentifier(c) && c.text === "expect") || (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "expect" && /^(soft|poll)$/.test(c.name.text));
    return isExpect && insideIfBranch(n) ? IF_EXPECT : null;
  },
};

describe("test hygiene: no .only, no unexplained .skip, no expect inside an if", () => {
  let report: ScanReport;
  beforeAll(async () => {
    ts = await loadTs();
    report = scan({ ...HYGIENE, files: TEST_FILES, roster: [], reasons: {} });
  }, SCAN_HOOK_TIMEOUT);

  test("the population is every collected test file: both projects, FE suites and this file", () => {
    expect(TEST_FILES).toContain("scripts/test-hygiene.test.ts");
    expect(TEST_FILES).toContain("src/boundary-guards.test.ts");
    expect(TEST_FILES.some((f) => /^public\/.*\.test\.js$/.test(f))).toBe(true);
    expect(TEST_FILES).toContain("src/db-fetch.test.ts");
  });

  test("no hit in any test file", () => {
    expectClean(report, {
      what: "a focused test, an unexplained skip, or an expect inside an if",
      why: "`.only` silently drops every other test; a bare `.skip` hides a dead test; an `if`-guarded expect passes vacuously when the branch never runs",
      move: "drop `.only`; put the reason for a `.skip` on its line or the line above; filter to the branch's rows, assert the set is non-empty, then assert unconditionally",
      never: "roster an exception, or replace the branch with `expect(true)`",
    });
  });

  test("can fail: each kind fires; conditional gates, an expect after an if and a reasoned skip do not", () => {
    const fire: [string, string][] = [
      ['it.only("x", () => {});', ONLY],
      ['describe.only("x", () => {});', ONLY],
      ["test.only.each([1])('%s', () => {});", ONLY],
      ["test.concurrent.only('x', () => {});", ONLY],
      ['it.skip("x", () => {});', SKIP],
      ["describe.skip.each([1])('%s', () => {});", SKIP],
      ['const t = 1; // \nit.skip("x", () => {});', SKIP],
      ["if (a) expect(a).toBe(1);", IF_EXPECT],
      ["if (a) {} else { expect(a).toBe(1); }", IF_EXPECT],
      ["for (const r of rows) if (r.k) expect.soft(r.v).toBe(1);", IF_EXPECT],
      ["function check(x: number) { if (x > 0) { for (const y of [x]) expect(y).toBe(1); } }", IF_EXPECT],
      ['if (a) it("x", () => { expect(a).toBe(1); });', IF_EXPECT],
    ];
    const decoys = [
      'it.skipIf(a)("x", () => {});',
      'describe.runIf(a)("x", () => {});',
      'it("x", (ctx) => { ctx.skip(); });',
      'it.skip("x", () => {}); // flaky upstream feed',
      '// upstream feed is down\nit.skip("x", () => {});',
      "/* the reason,\n   over two lines */\ntest.skip('x', () => {});",
      "if (a) {}\nexpect(a).toBe(1);",
      "if (expect(a)) {}",
      "if (!a) throw new Error('premise');\nexpect(a.b).toBe(1);",
      "expect(a ? 1 : 2).toBe(1);",
      'const s = "it.only(); if (a) expect(a)";',
      "// it.only('x')\nconst z = 1;",
      "list.only; obj.skip; other.only();",
    ];
    expect(misfires(HYGIENE, KINDS, fire, decoys)).toEqual([]);
  });
});
