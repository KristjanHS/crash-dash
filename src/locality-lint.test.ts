/**
 * Locality lint (stage3 spec §3.3, design §3.4 + §8 ruling).
 *
 * Guards the layers stages 1–2b emptied of tunables: a top-level SCREAMING_CASE
 * `const` in the scorer split (`scorers-core.ts` / `scorers-price.ts` /
 * `scorers-composite.ts`) or the domain split (`domain-types.ts` /
 * `domain-cuts.ts` / `domain-legs.ts` / `domain-fold.ts`) whose initializer is a numeric literal (or an object/array
 * table whose leaves are all numeric) is a re-created hand-typed tunable —
 * those live in `registry.ts` / `family-descriptor-rows.ts`, the one sanctioned
 * layer.
 *
 * Syntax-only: `ts.createSourceFile`, no Program, no type checker.
 *
 * Scan set is deliberately just the scorer split + domain split. `registry.ts` +
 * `family-descriptor-rows.ts` ARE the sanctioned home; other modules' dial/band/
 * notify tunables sit outside the indicator loop — extending the scan set is
 * Stage-5/6 business.
 */
import { readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

let ts: typeof TS; // loaded in `beforeAll`: keeps typescript.js out of collect time

const SCAN_FILES = [
  "src/scorers-core.ts",
  "src/scorers-price.ts",
  "src/scorers-composite.ts",
  "src/domain-types.ts",
  "src/domain-cuts.ts",
  "src/domain-legs.ts",
  "src/domain-fold.ts",
] as const;

/**
 * Exempt [file, name] pairs — each with a one-line reason (declaration site is
 * what the scanner sees):
 * - ["src/domain-types.ts", "VELOCITY_WINDOW"] — kernel constant (stage2b spec
 *   §1): global 20-trading-day velocity lookback; per-indicator registry
 *   override is the only sanctioned variation.
 * - ["src/domain-types.ts", "CONFIRM_CLOSES"] — kernel constant (stage2b spec
 *   §1): v4 §6.1 confirmation-fold width, not an indicator tunable.
 * - ["src/domain-types.ts", "STATE_RANK"] — structural GREEN<AMBER<RED ordinal
 *   for state comparison, not a tunable (spec §3.3's scalar-only baseline grep
 *   missed this object-branch hit; recorded as a deviation in slice 3.4).
 */
const ALLOW: ReadonlyArray<readonly [file: string, name: string]> = [
  ["src/domain-types.ts", "VELOCITY_WINDOW"],
  ["src/domain-types.ts", "CONFIRM_CLOSES"],
  ["src/domain-types.ts", "STATE_RANK"],
  // Structural break-DETECTION bound for `spliceChainedIndex`, not a per-indicator dial/band: it
  // separates a real daily move from a chained-index base re-anchor, so it has no home in the family
  // tables. Its own docblock justifies the value; the gap is pinned in dashboard.composites.test.ts.
  ["src/scorers-price.ts", "CHAIN_BREAK_RATIO"],
  // Structural quiet-market EMIT bound for the read path's `maxChainRatio`, not a per-indicator
  // dial/band: it separates a real daily move from a sub-threshold base cliff worth surfacing, so it
  // has no home in the family tables. Its own docblock justifies the value.
  ["src/scorers-price.ts", "CHAIN_QUIET_RATIO"],
];

const SCREAMING = /^[A-Z][A-Z0-9_]*$/;

/** Strip `as const` / `satisfies` / parens so the wrapped literal is judged. */
function unwrap(expr: TS.Expression): TS.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** (a) NumericLiteral, or (b) PrefixUnaryExpression(MinusToken, NumericLiteral). */
function isNumericLeaf(expr: TS.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return true;
  return (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  );
}

/** (c) non-empty Object/ArrayLiteral whose leaf values are ALL of (a)/(b) — nested tables recurse. */
function isNumericTable(expr: TS.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) {
    return (
      e.properties.length > 0 &&
      e.properties.every(
        (p) => ts.isPropertyAssignment(p) && isFlaggableInitializer(p.initializer),
      )
    );
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.length > 0 && e.elements.every((el) => isFlaggableInitializer(el));
  }
  return false;
}

function isFlaggableInitializer(expr: TS.Expression): boolean {
  return isNumericLeaf(expr) || isNumericTable(expr);
}

interface Flag {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

function scan(file: string): Flag[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const flags: Flag[] = [];
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!SCREAMING.test(name)) continue;
      if (decl.initializer === undefined || !isFlaggableInitializer(decl.initializer)) continue;
      const line = source.getLineAndCharacterOfPosition(decl.name.getStart(source)).line + 1;
      flags.push({ file, line, name });
    }
  }
  return flags;
}

describe("locality lint - no hand-typed numeric tunables in the scorer/domain split", () => {
  let flagsByFile: Map<string, Flag[]>;
  beforeAll(async () => {
    ts = (await import("typescript")).default;
    flagsByFile = new Map(SCAN_FILES.map((f) => [f, scan(f)]));
  });

  it("flags nothing outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [file, flags] of flagsByFile) {
      for (const flag of flags) {
        if (ALLOW.some(([af, an]) => af === file && an === flag.name)) continue;
        offenders.push(
          `${flag.file}:${flag.line} ${flag.name} - tunables live in registry.ts/family-descriptor-rows.ts`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("consumes every allowlist row (a row matching nothing is stale - delete it)", () => {
    const unconsumed = ALLOW.filter(
      ([file, name]) => !(flagsByFile.get(file) ?? []).some((flag) => flag.name === name),
    ).map(([file, name]) => `${file} ${name}`);
    expect(unconsumed, `stale ALLOW rows: ${unconsumed.join(", ")}`).toEqual([]);
  });
});
