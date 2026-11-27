import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type TS from "typescript";
import { expect } from "vitest";

// One source-scan harness: a new guard declares `visit` + roster + reason kinds.
// Rows are `{file, code, count, reason}`, never a line number; `reason` = `<kind>: <text>`, kind from the guard's own `reasons` table.

let tsMod: typeof TS | undefined;
/** typescript, required lazily on first use — a static import puts typescript.js into collect time. */
function ts(): typeof TS {
  tsMod ??= createRequire(import.meta.url)("typescript") as typeof TS;
  return tsMod;
}
/** Pass to a `beforeAll` that parses the whole tree: pure CPU, cannot hang, only slows with box load (15s crossed 2026-11-09). */
export const SCAN_HOOK_TIMEOUT = 60_000;
/** The guard's own `ts` handle, from a `beforeAll`. */
export async function loadTs(): Promise<typeof TS> {
  return ts();
}

const isTestFile = (f: string): boolean => /\.test\.ts$|\.test-helpers\.ts$|\.d\.ts$/.test(f) || f === "src/test-helpers.ts";
/** Non-test `.ts` files under each root (`"src/"`), symlinks and `node_modules` skipped. */
export function sourceFiles(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (e.name.endsWith(".ts") && !isTestFile(`${dir}${e.name}`)) out.push(`${dir}${e.name}`);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

export function unwrap(e: TS.Expression): TS.Expression {
  let x = e;
  while (ts().isParenthesizedExpression(x) || ts().isAsExpression(x) || ts().isSatisfiesExpression(x)) x = x.expression;
  return x;
}
/** True once `pred` matches inside `n`, never crossing into a nested function. */
export function has(n: TS.Node, pred: (x: TS.Node) => boolean): boolean {
  let found = false;
  const go = (x: TS.Node): void => {
    if (found || (x !== n && ts().isFunctionLike(x))) return;
    if (pred(x)) found = true;
    else ts().forEachChild(x, go);
  };
  go(n);
  return found;
}
/** Name of the enclosing named function / method / `const f = () =>`, else `<module>`. */
export function owner(n: TS.Node): string {
  const t = ts();
  for (let p = n.parent; p; p = p.parent) {
    if ((t.isFunctionDeclaration(p) || t.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((t.isArrowFunction(p) || t.isFunctionExpression(p)) && (t.isVariableDeclaration(p.parent) || t.isPropertyAssignment(p.parent))) return p.parent.name.getText();
  }
  return "<module>";
}

export interface Hit {
  file: string;
  line: number;
  kind: string;
  code: string;
  node: TS.Node;
}
export interface Row {
  file: string;
  code: string;
  count: number;
  reason: string;
}
/** A mechanical check for one reason kind: `null` when the hit honours the reason, else what is wrong. Search `handlerBody(hit.node)`, not `hit.node`. */
export type ReasonCheck = (hit: Hit, reason: string) => string | null;
/** The code a failure handler runs: a catch clause's block, a `.catch(fn)` / `.then(ok, fn)` handler's body, else the node itself. */
export function handlerBody(n: TS.Node): TS.Node {
  const t = ts();
  if (t.isCatchClause(n)) return n.block;
  if (t.isCallExpression(n) && t.isPropertyAccessExpression(n.expression)) {
    const fn = n.expression.name.text === "catch" ? n.arguments[0] : n.expression.name.text === "then" ? n.arguments[1] : undefined;
    if (fn && (t.isArrowFunction(fn) || t.isFunctionExpression(fn))) return fn.body;
  }
  return n;
}
/** `visit` returns the hit's kind (or null); `label` overrides the default code = the trimmed source line. */
export interface Visitor {
  visit: (n: TS.Node) => string | null;
  label?: (n: TS.Node, line: string) => string;
}
type Source = string | { file: string; text: string };

// One parse per file per worker: `shared` runs isolate:false, so every guard in the worker reuses it.
const parsed = new Map<string, TS.SourceFile>();
function parse(file: string, text: string): TS.SourceFile {
  const hit = parsed.get(file);
  if (hit?.text === text) return hit;
  const sf = ts().createSourceFile(file, text, ts().ScriptTarget.Latest, true);
  parsed.set(file, sf);
  return sf;
}

export function scanText(file: string, text: string, v: Visitor): Hit[] {
  const sf = parse(file, text);
  const lines = text.split("\n");
  const hits: Hit[] = [];
  const go = (n: TS.Node): void => {
    const kind = v.visit(n);
    if (kind !== null) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const src = (lines[line] ?? "").trim();
      hits.push({ file, line: line + 1, kind, code: v.label ? v.label(n, src) : src, node: n });
    }
    ts().forEachChild(n, go);
  };
  go(sf);
  return hits;
}

export interface ScanSpec extends Visitor {
  files: readonly Source[];
  /** Drop hits another guard owns before the roster diff. */
  keep?: (h: Hit) => boolean;
  roster: readonly Row[];
  /** The guard's reason kinds; a kind's check runs on every hit its rows cover. */
  reasons: Readonly<Record<string, ReasonCheck | null>>;
}
export interface ScanReport {
  hits: Hit[];
  unrostered: string[];
  stale: string[];
  badReason: string[];
}

/** Sites sharing a file + code share one row and so one reason; give them distinct `label`s to split them. */
const key = (file: string, code: string): string => `${file}\0${code}`;
/** The `<kind>` of `<kind>: <text>`; undefined when the reason has no text after the kind. */
const reasonKind = (reason: string): string | undefined => /^(\S+?): \S/.exec(reason)?.[1];

export function scan(spec: ScanSpec): ScanReport {
  const all = spec.files.flatMap((s) => (typeof s === "string" ? scanText(s, readFileSync(s, "utf8"), spec) : scanText(s.file, s.text, spec)));
  const hits = spec.keep ? all.filter(spec.keep) : all;
  const byKey = new Map<string, Hit[]>();
  for (const h of hits) byKey.set(key(h.file, h.code), [...(byKey.get(key(h.file, h.code)) ?? []), h]);
  const rostered = new Set(spec.roster.map((r) => key(r.file, r.code)));
  const unrostered = hits.filter((h) => !rostered.has(key(h.file, h.code))).map((h) => `${h.file}:${h.line} [${h.kind}] ${h.code}`);
  const stale: string[] = [];
  const badReason: string[] = [];
  const rows = new Set<string>();
  for (const r of spec.roster) {
    if (rows.has(key(r.file, r.code))) {
      stale.push(`${r.file}: duplicate row - ${r.code}`);
      continue;
    }
    rows.add(key(r.file, r.code));
    const found = byKey.get(key(r.file, r.code)) ?? [];
    if (found.length !== r.count) stale.push(`${r.file}: pinned ${r.count}×, found ${found.length}× - ${r.code}`);
    const kind = reasonKind(r.reason);
    if (kind === undefined || !Object.hasOwn(spec.reasons, kind)) {
      badReason.push(`${r.file}: reason kind ${JSON.stringify(kind ?? r.reason)} ∉ {${Object.keys(spec.reasons).join(", ")}} - ${r.code}`);
      continue;
    }
    const check = spec.reasons[kind];
    for (const h of check ? found : []) {
      const wrong = check!(h, r.reason);
      if (wrong !== null) badReason.push(`${h.file}:${h.line} [${kind}] ${wrong} - ${h.code}`);
    }
  }
  return { hits, unrostered, stale, badReason };
}

/** One fail-message shape for every guard: what was found · why it matters · the move · what never to do. */
export interface FailMessage {
  what: string;
  why: string;
  move: string;
  never: string;
}
const render = (head: string, m: FailMessage, rows: string[]): string =>
  `${head} — ${m.what}: ${m.why}\n  the move: ${m.move}\n  never: ${m.never}\n${rows.map((r) => `  ${r}`).join("\n")}`;

/** Assert the report is clean in ONE expect, so every failing class prints the guard's message over its rows. */
export function expectClean(r: ScanReport, m: FailMessage): void {
  const staleMsg: FailMessage = { ...m, move: "update `count`, or delete the row when the site is gone", never: "leave a row the code no longer has" };
  const reasonMsg: FailMessage = { ...m, move: "pick a kind the guard declares and honour its check", never: "invent a kind to fit the site" };
  const blocks = [
    r.unrostered.length ? render("UNROSTERED", m, r.unrostered) : "",
    r.stale.length ? render("STALE ROW", staleMsg, r.stale) : "",
    r.badReason.length ? render("BAD REASON", reasonMsg, r.badReason) : "",
  ].filter(Boolean);
  expect(blocks.length, `\n${blocks.join("\n\n")}`).toBe(0);
}

/** Ability to fail: every kind fires on its fixture, each fixture yields exactly its kind, and no decoy hits. */
export function misfires(v: Visitor, kinds: readonly string[], fire: readonly (readonly [string, string])[], decoys: readonly string[]): string[] {
  const out = kinds.filter((k) => !fire.some(([, f]) => f === k)).map((k) => `no fixture fires ${k}`);
  for (const [src, kind] of fire) {
    const got = scanText("fixture.ts", src, v).map((h) => h.kind).join();
    if (got !== kind) out.push(`fixture wants ${kind}, got ${got || "nothing"}: ${src}`);
  }
  for (const src of decoys) for (const h of scanText("fixture.ts", src, v)) out.push(`decoy hit [${h.kind}]: ${src}`);
  return out;
}
