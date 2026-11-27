import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, ranges, report, uncoveredLines, type FileCoverage } from "./coverage-gaps.js";

const fc = (path: string, stmts: [line: number, hits: number][], fns: [name: string, line: number, hits: number][] = []): FileCoverage => ({
  path,
  statementMap: Object.fromEntries(stmts.map(([line], i) => [i, { start: { line } }])),
  s: Object.fromEntries(stmts.map(([, hits], i) => [i, hits])),
  fnMap: Object.fromEntries(fns.map(([name, line], i) => [i, { name, loc: { start: { line } } }])),
  f: Object.fromEntries(fns.map(([, , hits], i) => [i, hits])),
});

const LOG = [
  '[tests] ERROR: Coverage for lines (94.23%) does not meet "src/prices.ts" threshold (97%)',
  '[tests] ERROR: Coverage for functions (97.43%) does not meet "src/prices.ts" threshold (98%)',
  '[tests] ERROR: Coverage for statements (90%) does not meet "src/fred.ts" threshold (94%)',
  '[tests] ERROR: Coverage for branches (80%) does not meet "src/run-cycle*.ts" threshold (83%)',
  '[tests] ERROR: Uncovered lines (12) exceed "src/geo.ts" threshold (10)',
].join("\n");

describe("coverage-gaps", () => {
  it("counts a line covered when any statement starting on it ran", () => {
    expect(uncoveredLines(fc("/r/a.ts", [[1, 1], [2, 3], [2, 0], [5, 0], [4, 0]]))).toEqual([4, 5]);
  });

  it("collapses consecutive lines into ranges", () => {
    expect(ranges([3, 4, 5, 9, 11, 12])).toBe("3-5,9,11-12");
    expect(ranges([])).toBe("");
    expect(ranges([1, 3, 5, 7], 2)).toBe("1,3 … +2 more ranges");
  });

  it("reports lines + named unrun functions per file, expands a glob key, and flags a key matching nothing", () => {
    const cov = {
      "/r/src/prices.ts": {
        ...fc("/r/src/prices.ts", [[10, 1], [11, 0], [12, 0], [20, 0], [30, 4]], [["fetchA", 9, 2], ["fetchB", 19, 0], ["(anonymous_2)", 21, 0]]),
        // line 30 ran, but its `??` right arm never did — invisible to statement counts
        branchMap: { 0: { loc: { start: { line: 30 } }, locations: [{ start: { line: 30 } }, undefined] } },
        b: { 0: [4, 0] },
      },
      "/r/src/run-cycle-push.ts": fc("/r/src/run-cycle-push.ts", [[5, 0]]),
      "/r/src/run-cycle-a/b.ts": fc("/r/src/run-cycle-a/b.ts", [[1, 0]]),
      "/r/src/run-core.ts": fc("/r/src/run-core.ts", [[1, 0]]),
    };
    expect(report(LOG, cov, "/r")).toEqual([
      "[coverage] src/prices.ts uncovered lines: 11-12,20 · branches: 30 · functions: fetchB@19, +1 anonymous",
      "[coverage] src/fred.ts: not in coverage-final.json — no line detail",
      "[coverage] src/run-cycle-push.ts uncovered lines: 5",
      "[coverage] src/geo.ts: not in coverage-final.json — no line detail",
    ]);
  });

  it("stays silent on a failed TEST (no threshold line, no json) and says one line when the json is missing", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cov-gaps-")));
    const json = join(dir, "coverage-final.json");
    expect(main("FAIL src/a.test.ts > x", json, dir)).toEqual([]);
    expect(main(LOG, json, dir)).toEqual([`[coverage] ${json} not written — no line detail`]);
    writeFileSync(json, JSON.stringify({ [join(dir, "src/geo.ts")]: fc("", [[7, 0]]) }));
    expect(main(LOG, json, dir)).toContain("[coverage] src/geo.ts uncovered lines: 7");
  });
});
