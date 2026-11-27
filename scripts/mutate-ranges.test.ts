import { describe, expect, it } from "vitest";

import {
  changedSpans,
  isCoreFile,
  type MutationReport,
  pickReport,
  undetectedRanges,
  widenToDecisionNodes,
} from "./mutate-ranges.js";

describe("isCoreFile", () => {
  it("admits the pure core only, never tests or helpers", () => {
    const admitted = ["src/domain-legs.ts", "src/scorers-core.ts", "src/danger-engine.ts", "src/alert-band.ts"];
    const refused = [
      "src/danger-engine.basics.test.ts",
      "src/danger-engine.test-helpers.ts",
      "src/alert-band.floors.test.ts",
      "src/store.ts",
      "src/api/domain-x.ts",
      "scripts/domain-x.ts",
    ];
    expect(admitted.filter(isCoreFile)).toEqual(admitted);
    expect(refused.filter(isCoreFile)).toEqual([]);
  });
});

describe("changedSpans", () => {
  const diff = [
    "diff --git a/src/scorers-core.ts b/src/scorers-core.ts",
    "--- a/src/scorers-core.ts",
    "+++ b/src/scorers-core.ts",
    "@@ -118,2 +120,4 @@ export function x() {",
    "+++ b/src/store.ts",
    "@@ -200 +202 @@",
    "@@ -300,3 +301,0 @@",
    "diff --git a/src/store.ts b/src/store.ts",
    "--- a/src/store.ts",
    "+++ b/src/store.ts",
    "@@ -40 +40,2 @@",
  ].join("\n");

  it("maps added hunks of core files to inclusive spans; skips deletions, non-core files and `+++` hunk content", () => {
    expect([...changedSpans(diff)]).toEqual([
      [
        "src/scorers-core.ts",
        [
          [120, 123],
          [202, 202],
        ],
      ],
    ]);
  });
});

describe("widenToDecisionNodes", () => {
  const source = ["if (x >= cut &&", "    y < other) {", "  z = 1;", "}", "const w = a ? b : c;"].join("\n");

  it("widens a changed line over the multi-line condition it sits in; single-line nodes stay put", () => {
    expect(widenToDecisionNodes(source, [[2, 2], [5, 5]])).toEqual([
      [1, 2],
      [5, 5],
    ]);
  });
});

describe("undetectedRanges", () => {
  const m = (status: string, start: number, end = start) => ({ status, location: { start: { line: start }, end: { line: end } } });
  const report: MutationReport = {
    files: {
      "src/domain-legs.ts": {
        mutants: [m("Killed", 10), m("Survived", 58), m("NoCoverage", 57), m("Survived", 112, 114), m("Survived", 113), m("Timeout", 140), m("Survived", 200)],
      },
    },
  };

  it("merges Survived + NoCoverage spans per line, overlapping or adjacent", () => {
    expect(undetectedRanges(report, "src/domain-legs.ts")).toEqual([
      "src/domain-legs.ts:57-58",
      "src/domain-legs.ts:112-114",
      "src/domain-legs.ts:200-200",
    ]);
  });
});

describe("pickReport", () => {
  const rep = (files: Record<string, string>): MutationReport => ({
    files: Object.fromEntries(Object.entries(files).map(([f, source]) => [f, { source, mutants: [] }])),
  });
  const reports = [
    { path: "core", report: rep({ "src/danger-engine.ts": "v1" }) },
    { path: "changed", report: rep({ "src/danger-engine.ts": "v1", "src/scorers-core.ts": "s1" }) },
  ];

  it("prefers the core report, falls back to changed-lines for files only it mutated", () => {
    expect([pickReport(reports, "src/danger-engine.ts", "v1").path, pickReport(reports, "src/scorers-core.ts", "s1").path]).toEqual([
      "core",
      "changed",
    ]);
  });

  it("fails loud on a file no report holds, or whose source moved since", () => {
    expect(() => pickReport(reports, "src/domain-legs.ts", "x")).toThrow(/is not in core \/ changed/);
    expect(() => pickReport(reports, "src/danger-engine.ts", "v2")).toThrow(/stale/);
  });
});
