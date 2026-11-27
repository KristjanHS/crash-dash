/**
 * Architecture rules — which layer may reach which, over the static import graph. A rule changes only
 * when the design does, never because code grew.
 */
import { readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

import { expectClean, type Hit, loadTs, misfires, type ReasonCheck, type Row, scan, type ScanReport, sourceFiles, unwrap, type Visitor } from "../src/source-scan.test-helpers.js";
import { deployedHandlers, importPath, reachable } from "./import-graph.js";

// Fetchers, the notifier and the scoring cycle belong to the cron alone; a read handler rescored from
// stored rows never needs them.
const RUN_PATH_ONLY = [
  "src/fred.ts",
  "src/prices.ts",
  "src/ntfy.ts",
  "src/run-core.ts",
  "src/run-cycle.ts",
  "src/run-cycle-ctx.ts",
  "src/run-cycle-persist.ts",
  "src/run-cycle-seed-tail.ts",
  "src/run-cycle-push.ts",
  "src/run-cycle-estimates.ts",
  "src/run-cycle-graft.ts",
  "src/run-cycle-exposure.ts",
  "src/run-cycle-dial.ts",
  "src/run-cycle-fred.ts",
  "src/run-cycle-confirmers.ts",
  "src/run-cycle-feeds.ts",
  "src/run-seeds.ts",
];

const readHandlers = deployedHandlers().filter((h) => !h.startsWith("api/cron/"));

describe("read handlers never reach a run-path module", () => {
  test("the read-handler population is non-empty and excludes the cron", () => {
    expect(readHandlers.length).toBeGreaterThan(0);
    expect(deployedHandlers()).toContain("api/cron/run.ts");
  });

  test("the cron reaches every run-path module (the rule's targets resolve)", () => {
    const cron = reachable("api/cron/run.ts");
    expect(RUN_PATH_ONLY.filter((m) => !cron.has(m))).toEqual([]);
  });

  test.each(readHandlers)("%s", (handler) => {
    const graph = reachable(handler);
    const paths = RUN_PATH_ONLY.filter((m) => graph.has(m)).map((m) => importPath(graph, m).join(" → "));
    expect(paths).toEqual([]);
  });
});

// The pure core scores what it is handed: it never reaches a fetcher, the store, the notifier or the cycle.
const SCORING_CORE = sourceFiles("src/").filter((f) => /^src\/(domain-|scorers-|danger-|alert-band|ladder|t1dial|families)[^/]*\.ts$/.test(f));
const IO_SHELL = /^src\/(fred|prices|ntfy|run|run-[^/]*|store|store-[^/]*)\.ts$/;
const shellPaths = (entry: string): string[] => {
  const graph = reachable(entry);
  return [...graph.keys()].filter((m) => IO_SHELL.test(m)).map((m) => importPath(graph, m).join(" → "));
};

describe("the pure core never reaches an IO-shell module at runtime (`import type` is erased)", () => {
  test("the population spans every core prefix", () => {
    for (const f of ["src/domain-fold.ts", "src/scorers-core.ts", "src/danger-engine.ts", "src/alert-band.ts", "src/ladder.ts", "src/ladder-run.ts", "src/t1dial.ts", "src/families.ts"]) expect(SCORING_CORE).toContain(f);
  });

  test("can fail: the cycle reaches the notifier, the store and a fetcher", () => {
    const hit = shellPaths("src/run-cycle.ts").map((p) => p.split(" → ").at(-1));
    expect(hit).toEqual(expect.arrayContaining(["src/ntfy.ts", "src/store.ts", "src/fred.ts"]));
  });

  test.each(SCORING_CORE)("%s", (file) => {
    expect(shellPaths(file)).toEqual([]);
  });
});

// Why `at()` throws: a non-null assertion on a SERIES INDEX (`values[i]!`) turns an
// out-of-range read into a silent NaN GREEN; the pure core indexes through `at()` (`src/series-math.ts`), which
// throws so the feed's `degrade()` records the drop. Keyed record lookups (`CONFIG_OF[id]!`) are not series
// indexes and stay — each one is a roster row below; a row whose site is gone fails (stale), a new site fails (open).
let ts: typeof TS; // loaded in `beforeAll`: keeps typescript.js out of collect time

const PURE_CORE_FILES = sourceFiles("src/").filter((f) => /^src\/(scorers|domain)-[^/]*\.ts$/.test(f));

const INDEX_ASSERTION = "index-assertion";
/** A `!` whose operand (parens / `as` / `satisfies` peeled) is an element access: `xs[i]!`, `(xs[i])!`. */
const INDEX_VISITOR: Visitor = {
  visit: (n) => (ts.isNonNullExpression(n) && ts.isElementAccessExpression(unwrap(n.expression)) ? INDEX_ASSERTION : null),
};

/** `keyed-lookup`: the subscript is the indicator `id` — a record key, never a series counter. */
const keyedLookup: ReasonCheck = (hit: Hit) => {
  const acc = unwrap((hit.node as TS.NonNullExpression).expression) as TS.ElementAccessExpression;
  const arg = acc.argumentExpression;
  return ts.isIdentifier(arg) && arg.text === "id" ? null : `subscript \`${arg.getText()}\` is not the indicator \`id\` key`;
};
const INDEX_REASONS = { "keyed-lookup": keyedLookup } as const;

const KEYED_LOOKUPS: readonly Row[] = [
  { file: "src/scorers-price.ts", code: "return BREADTH_CONFIG_OF[id]!;", count: 1, reason: "keyed-lookup: per-indicator breadth config, keyed by the registry id" },
  { file: "src/scorers-price.ts", code: "return RATIO_VS_MA_CONFIG_OF[id]!;", count: 1, reason: "keyed-lookup: per-indicator ratio-vs-MA config, keyed by the registry id" },
  { file: "src/scorers-price.ts", code: "return RETURN_OR_MA_CONFIG_OF[id]!;", count: 1, reason: "keyed-lookup: per-indicator return-or-MA config, keyed by the registry id" },
  {
    file: "src/scorers-price.ts",
    code: "return Object.hasOwn(overrides, id) ? { ...overrides[id]! } : { amber: DOWNSIDE_AMBER, red: DOWNSIDE_RED };",
    count: 1,
    reason: "keyed-lookup: downside override, read only behind its own `Object.hasOwn(overrides, id)` guard",
  },
];

const INDEX_MSG = {
  what: "a non-null assertion on an element access in the pure core",
  why: "`xs[i]!` reads an out-of-range index as undefined and scores it a silent NaN GREEN",
  move: "index through `at(xs, i)` (`src/series-math.ts`, throws), or roster a record lookup with reason kind `keyed-lookup:`",
  never: "roster a series index as a keyed lookup",
};

describe("pure core indexes through at(): no `xs[i]!` outside the keyed-lookup roster", () => {
  let report: ScanReport;
  beforeAll(async () => {
    ts = await loadTs();
    report = scan({ ...INDEX_VISITOR, files: PURE_CORE_FILES, roster: KEYED_LOOKUPS, reasons: INDEX_REASONS });
  });

  test("the population is the scorers-* and domain-* modules", () => {
    expect(PURE_CORE_FILES).toContain("src/scorers-core.ts");
    expect(PURE_CORE_FILES).toContain("src/domain-fold.ts");
    expect(PURE_CORE_FILES.some((f) => f.endsWith(".test.ts") || f.endsWith(".test-helpers.ts"))).toBe(false);
  });

  test("every index assertion is a rostered keyed lookup (open)", () => {
    expectClean({ ...report, stale: [], badReason: [] }, INDEX_MSG);
  });

  test("every roster row still names a live site at its count, keyed by `id` (stale)", () => {
    expectClean({ ...report, unrostered: [] }, INDEX_MSG);
  });

  test("can fail: index assertions hit; compares, `at()`, strings and comments do not; a non-`id` row is a bad reason", () => {
    const fire: [string, string][] = [
      ["const a = values[i]!;", INDEX_ASSERTION],
      ["out[idx[j]!] = m;", INDEX_ASSERTION],
      ["const c = (xs[i])!;", INDEX_ASSERTION],
    ];
    const decoys = [
      "if (xs[i] !== y) {}",
      "if (xs[i]!== y) {}",
      "const b = at(xs, i)!;",
      'const s = "values[i]!";',
      "// values[i]! in a comment\nconst z = 1;",
      "/** `n[i]! < ma` docblock */\nconst w = 2;",
    ];
    expect(misfires(INDEX_VISITOR, [INDEX_ASSERTION], fire, decoys)).toEqual([]);
    const fixture = { file: "src/x.ts", text: "const a = values[i]!;\nconst b = CONFIG_OF[id]!;" };
    const rows: Row[] = [
      { file: "src/x.ts", code: "const a = values[i]!;", count: 1, reason: "keyed-lookup: a counter dressed as a key" },
      { file: "src/x.ts", code: "const b = CONFIG_OF[id]!;", count: 1, reason: "keyed-lookup: a real key" },
      { file: "src/x.ts", code: "const gone = OLD_OF[id]!;", count: 1, reason: "keyed-lookup: a site no longer there" },
    ];
    const r = scan({ ...INDEX_VISITOR, files: [fixture], roster: rows, reasons: INDEX_REASONS });
    expect({ unrostered: r.unrostered, stale: r.stale, badReason: r.badReason }).toEqual({
      unrostered: [],
      stale: ["src/x.ts: pinned 1×, found 0× - const gone = OLD_OF[id]!;"],
      badReason: ["src/x.ts:1 [keyed-lookup] subscript `i` is not the indicator `id` key - const a = values[i]!;"],
    });
    expect(scan({ ...INDEX_VISITOR, files: [fixture], roster: [], reasons: INDEX_REASONS }).unrostered).toHaveLength(2);
  });
});

const isBarrel = (text: string): boolean => {
  const stmts = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  return stmts.length > 0 && stmts.every((s) => /^export \* from "[^"]+"$/.test(s));
};

describe("no src/ module is an `export *`-only barrel", () => {
  test("import the defining file", () => {
    expect(sourceFiles("src/").filter((f) => isBarrel(readFileSync(f, "utf8")))).toEqual([]);
  });

  test("can fail: a commented two-line re-export file is a barrel; one with a declaration is not", () => {
    expect(isBarrel('/** doc */\nexport * from "./a.js";\nexport * from "./b.js";\n')).toBe(true);
    expect(isBarrel('export * from "./a.js";\nexport const x = 1;\n')).toBe(false);
    expect(isBarrel("// only a comment\n")).toBe(false);
  });
});
