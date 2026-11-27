import { readdirSync, readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { type FailMessage, loadTs, SCAN_HOOK_TIMEOUT, sourceFiles } from "../src/source-scan.test-helpers.js";

// Size ratchet: a file fails only past its OWN ceiling.
// ⛔ `size-ceilings.json` is hand-edited only: raise ONE 250-line bucket with a `reasons` entry; lower it only on a user-picked split.

interface Ceilings {
  LIMIT: number;
  ceilings: Record<string, number>;
  reasons: Record<string, string>;
}
const CEILINGS = JSON.parse(readFileSync("scripts/size-ceilings.json", "utf8")) as Ceilings;

/** Declared data-table modules: rows, not logic. */
const DATA_TABLES = new Set([
  "src/registry-fred.ts",
  "src/registry-price.ts",
  "src/registry-composite.ts",
  "src/registry-geo.ts",
  "src/danger-ladder.ts",
  "src/family-descriptor-rows.ts",
]);

let ts: typeof TS;
let files: string[];
let sizes: (readonly [string, number])[];
beforeAll(async () => {
  ts = await loadTs();
  files = inScope();
  sizes = files.map((f) => [f, codeLines(f, readFileSync(f, "utf8"))] as const);
}, SCAN_HOOK_TIMEOUT);

/** Lines holding at least one non-comment token (a multi-line string or template counts every line it spans). */
function codeLines(file: string, text: string): number {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const lines = new Set<number>();
  const go = (n: TS.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(go);
    if (n.kind === ts.SyntaxKind.EndOfFileToken || n.getStart(sf) === n.getEnd()) return;
    const a = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
    for (let l = a; l <= b; l++) lines.add(l);
  };
  go(sf);
  return lines.size;
}

function inScope(): string[] {
  const pub = readdirSync("public")
    .filter((f) => f.endsWith(".js") && !f.includes(".test."))
    .map((f) => `public/${f}`);
  return [...sourceFiles("src/", "api/"), ...pub].filter((f) => !f.startsWith("src/goldens/") && !DATA_TABLES.has(f)).sort();
}

const fail = (file: string): FailMessage => ({
  what: "file grew past its own ceiling",
  why: "every growth past the ceiling makes the next split a rewrite",
  move: file.startsWith("api/")
    ? "put the NEW handler logic in `src/api-routes/<handler>-<view>.ts` (the handler parses, dispatches, serializes)"
    : "put the NEW code in a new or smaller module; if it belongs here, raise ONE bucket in scripts/size-ceilings.json with a `reasons` entry",
  never: "move existing code out to make room — that is a planned split, not this change",
});

/** Over-ceiling files, each rendered with its own fail message. */
function overCeiling(sizes: readonly (readonly [string, number])[], c: Ceilings): string[] {
  return sizes
    .filter(([f, n]) => n > (c.ceilings[f] ?? c.LIMIT))
    .map(([f, n]) => {
      const m = fail(f);
      return `${f}: ${n} code lines > ceiling ${c.ceilings[f] ?? c.LIMIT} — ${m.what}: ${m.why}\n  the move: ${m.move}\n  never: ${m.never}`;
    });
}

/** Rows naming a gone / out-of-scope file, at or under LIMIT, off a 250 bucket, or a reason with no row. */
function staleRows(c: Ceilings, live: ReadonlySet<string>): string[] {
  return [
    ...Object.entries(c.ceilings)
      .filter(([f, n]) => !live.has(f) || n <= c.LIMIT || n % 250 !== 0)
      .map(([f, n]) => `${f}: ${n} — delete the row (file gone / out of scope) or fix the bucket`),
    ...Object.keys(c.reasons)
      .filter((f) => !(f in c.ceilings))
      .map((f) => `${f}: reason without a ceiling row`),
  ];
}

describe("code-file size ratchet", () => {
  it("counts code lines only: comments, JSDoc and blanks out; a multi-line template counts every line", () => {
    const src = ["/** doc", " * more */", "// note", "", "const a = 1; // trailing", "const t = `x", "y`;", "/* block */ const b = 2;"].join("\n");
    expect(codeLines("f.ts", src)).toBe(4);
  });

  it("no in-scope file is past its ceiling", () => {
    expect(files.length).toBeGreaterThan(200);
    const out = overCeiling(sizes, CEILINGS);
    expect(out, `\n${out.join("\n\n")}`).toEqual([]);
  });

  it("every ceiling row names a live in-scope file, sits above LIMIT on a 250 bucket, and carries no orphan reason", () => {
    const bad = staleRows(CEILINGS, new Set(files));
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });

  it("can fail: a file one line past its ceiling is reported, and an api/ file's move names src/api-routes/", () => {
    const c: Ceilings = { LIMIT: 600, ceilings: { "api/lab.ts": 1000 }, reasons: {} };
    const out = overCeiling(
      [
        ["api/lab.ts", 1001],
        ["src/new.ts", 601],
        ["src/ok.ts", 600],
      ],
      c,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("src/api-routes/<handler>-<view>.ts");
    expect(out[1]).toContain("new or smaller module");
    const rows: Ceilings = { LIMIT: 600, ceilings: { "src/gone.ts": 750, "src/a.ts": 700, "src/b.ts": 500, "src/c.ts": 750 }, reasons: { "src/d.ts": "x" } };
    expect(staleRows(rows, new Set(["src/a.ts", "src/b.ts", "src/c.ts"])).map((r) => r.split(":")[0])).toEqual(["src/gone.ts", "src/a.ts", "src/b.ts", "src/d.ts"]);
  });
});
