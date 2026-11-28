// knip over src+api: default arm (entry exports included) = no unused export outside ROSTER;
// --production arm = ratchet on scripts/knip-prod-baseline.json; seamReport = a test seam is tagged
// `/** @internal */`, never a baseline row, and the tag sits only on a test seam.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type TS from "typescript";
import { beforeAll, describe, expect, test } from "vitest";
import { expectClean, loadTs, SCAN_HOOK_TIMEOUT, type FailMessage, type Row, type ScanReport } from "../src/source-scan.test-helpers.js";

const KINDS = ["files", "exports", "types", "enumMembers", "namespaceMembers"] as const;
const BASELINE = "scripts/knip-prod-baseline.json";
/** The gate's scope: scripts/ are entries only, never gated. */
const IN_SCOPE = /^(src|api)\//;
/** Exports the Vercel runtime calls by name: nothing in the repo imports them. */
const HANDLER_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "default", "config"]);

interface KnipHit { file: string; kind: string; name: string }
type KnipIssue = { file: string } & Partial<Record<(typeof KINDS)[number], { name: string }[]>>;

function knip(cwd: string, ...args: string[]): KnipHit[] {
  const r = spawnSync(join(process.cwd(), "node_modules/.bin/knip"), ["--reporter", "json", "--no-progress", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`knip exited ${r.status}: ${r.stderr}`);
  const { issues } = JSON.parse(r.stdout) as { issues: KnipIssue[] };
  return issues.flatMap((i) => KINDS.flatMap((kind) => (i[kind] ?? []).map((e) => ({ file: i.file, kind, name: e.name }))));
}
const label = (h: KnipHit): string => `${h.file} [${h.kind}] ${h.name}`;
const key = (file: string, name: string): string => `${file}\0${name}`;

/** A roster row's reason is `<kind>: <text>`; `parity:` names the test that reads the symbol as source text,
 *  `handler:` is a Vercel route export of a file under api/. */
const REASONS: Readonly<Record<string, (r: Row) => string | null>> = {
  parity: (r) => {
    const test = /\S+\.test\.ts/.exec(r.reason)?.[0];
    return test && existsSync(test) && readFileSync(test, "utf8").includes(`"${r.code}"`) ? null : `no named *.test.ts reads "${r.code}"`;
  },
  handler: (r) => (r.file.startsWith("api/") && HANDLER_EXPORTS.has(r.code) ? null : `not a route export of an api/ file`),
};

const ROSTER: readonly Row[] = [
  { file: "src/disclaimer.ts", code: "DISCLAIMER_LONG", count: 1, reason: "parity: src/disclaimer-parity.test.ts reads the literal from source text" },
  { file: "api/exposure.ts", code: "GET", count: 1, reason: "handler: Vercel route, no test imports it" },
  { file: "api/replay.ts", code: "GET", count: 1, reason: "handler: Vercel route, no test imports it" },
  { file: "api/cron/run.ts", code: "GET", count: 1, reason: "handler: Vercel cron route, no test imports it" },
];

function rosterReport(hits: readonly KnipHit[], roster: readonly Row[]): ScanReport {
  const rostered = new Set(roster.map((r) => key(r.file, r.code)));
  const unrostered = hits.filter((h) => !rostered.has(key(h.file, h.name))).map(label);
  const stale: string[] = [];
  const badReason: string[] = [];
  for (const r of roster) {
    const found = hits.filter((h) => key(h.file, h.name) === key(r.file, r.code)).length;
    if (found !== r.count) stale.push(`${r.file}: pinned ${r.count}×, found ${found}× - ${r.code}`);
    const kind = /^(\S+?): \S/.exec(r.reason)?.[1];
    const check = kind === undefined ? undefined : REASONS[kind];
    const wrong = check ? check(r) : `reason kind ${JSON.stringify(kind ?? r.reason)} ∉ {${Object.keys(REASONS).join(", ")}}`;
    if (wrong !== null) badReason.push(`${r.file}: ${wrong} - ${r.code}`);
  }
  return { hits: [], unrostered, stale, badReason };
}

function baselineReport(hits: readonly KnipHit[], baseline: readonly string[]): ScanReport {
  const got = new Set(hits.map(label));
  const want = new Set(baseline);
  return { hits: [], unrostered: [...got].filter((h) => !want.has(h)).sort(), stale: [...want].filter((h) => !got.has(h)).map((h) => `${BASELINE}: delete row - ${h}`), badReason: [] };
}

/** Who an importer is: a test (incl. test-helpers), prod (`src/`/`api/`), or a script / front-end file.
 *  A `[files]` row or a `src/goldens/**` file is neither: it inherits its own importers' classes. */
type Cls = "test" | "prod" | "script";
interface SrcFile { file: string; text: string }
/** `typeOnly`: an interface/type alias — a whole-namespace VALUE use (`...ns`, `import(…)`) never reaches it. */
interface Exp { local: string | undefined; tags: ReadonlySet<string>; via: { target: string; name: string } | undefined; specifierStmt: boolean; typeOnly: boolean }
interface Mod {
  exports: Map<string, Exp>;
  stars: string[];
  fileImports: Set<string>;
  imports: { target: string; names: readonly string[] | "*" }[];
  /** top-level local → the declared names of each in-module reference's top-level owner ([] = a statement that runs) */
  users: Map<string, string[][]>;
}
const TEST_FILE = /\.test\.[mc]?[jt]s$|\.test-helpers\.ts$|^src\/test-helpers\.ts$/;
const BANNED_TAGS = ["public", "beta", "alias"] as const;

/** A reference, not a declaration's name, a member name, or an import/export binding. */
function isRef(ts: typeof TS, id: TS.Identifier): boolean {
  const p = id.parent as TS.Node & { name?: TS.Node };
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isQualifiedName(p)) return p.left === id;
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id;
  if (ts.isBindingElement(p)) return p.initializer === id;
  if (ts.isExportSpecifier(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return p.name !== id;
}

/** The names a dynamic `import()` reads: `const { a } = await import(…)`, `(await import(…)).a`, or
 *  element i of `const [{ a }, …] = await Promise.all([import(…), …])`; anything else reaches every export. */
function dynamicPick(ts: typeof TS, call: TS.CallExpression): string[] | "*" {
  let up: TS.Node = call.parent;
  let at: number | undefined;
  if (ts.isArrayLiteralExpression(up) && ts.isCallExpression(up.parent) && up.parent.arguments[0] === up) {
    at = up.elements.indexOf(call);
    up = up.parent.parent;
  }
  if (ts.isAwaitExpression(up)) up = up.parent;
  if (at === undefined && ts.isParenthesizedExpression(up) && ts.isPropertyAccessExpression(up.parent)) return [up.parent.name.text];
  let pat: TS.BindingName | undefined = ts.isVariableDeclaration(up) ? up.name : undefined;
  if (pat && at !== undefined) {
    const el = ts.isArrayBindingPattern(pat) ? pat.elements[at] : undefined;
    pat = el && ts.isBindingElement(el) ? el.name : undefined;
  }
  if (!pat || !ts.isObjectBindingPattern(pat) || pat.elements.some((e) => e.dotDotDotToken || (e.propertyName && !ts.isIdentifier(e.propertyName)))) return "*";
  return pat.elements.map((e) => ((e.propertyName ?? e.name) as TS.Identifier).text);
}

function analyse(ts: typeof TS, f: SrcFile, resolve: (spec: string) => string | undefined): Mod {
  const sf = ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest, true);
  const mod: Mod = { exports: new Map(), stars: [], fileImports: new Set(), imports: [], users: new Map() };
  const tagsOf = (n: TS.Node): Set<string> => new Set(ts.getJSDocTags(n).map((t) => t.tagName.text));
  const hasMod = (n: TS.Node, k: TS.SyntaxKind): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === k);
  const names = (n: TS.BindingName): string[] => (ts.isIdentifier(n) ? [n.text] : n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : names(e.name))));
  const target = (spec: TS.Node | undefined): string | undefined => {
    const t = spec && ts.isStringLiteralLike(spec) ? resolve(spec.text) : undefined;
    if (t) mod.fileImports.add(t);
    return t;
  };
  const declare = (name: string, local: string, tags: Set<string>, typeOnly = false): void => {
    const prev = mod.exports.get(name); // overloads: one export, every signature's tags
    mod.exports.set(name, { local, tags: new Set([...(prev?.tags ?? []), ...tags]), via: undefined, specifierStmt: false, typeOnly });
  };
  const units: { node: TS.Node; names: string[] }[] = [];
  const nsLocals = new Map<string, string>();
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        units.push({ node: d, names: names(d.name) });
        if (hasMod(s, ts.SyntaxKind.ExportKeyword)) for (const n of names(d.name)) declare(n, n, tagsOf(d));
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) {
      units.push({ node: s, names: [s.name.text] });
      if (hasMod(s, ts.SyntaxKind.ExportKeyword) && !hasMod(s, ts.SyntaxKind.DefaultKeyword)) declare(s.name.text, s.name.text, tagsOf(s), ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
    } else if (ts.isExportDeclaration(s)) {
      const t = target(s.moduleSpecifier);
      if (!s.exportClause) {
        if (t) mod.stars.push(t);
      } else if (ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          const via = s.moduleSpecifier ? (t ? { target: t, name: from } : undefined) : undefined;
          mod.exports.set(el.name.text, { local: s.moduleSpecifier ? undefined : from, tags: tagsOf(s), via, specifierStmt: true, typeOnly: false });
        }
      }
    } else if (ts.isImportDeclaration(s)) {
      const t = target(s.moduleSpecifier);
      const c = s.importClause;
      if (!t || !c) continue;
      if (c.name) mod.imports.push({ target: t, names: ["default"] });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) nsLocals.set(nb.name.text, t);
      else if (nb) mod.imports.push({ target: t, names: nb.elements.map((e) => (e.propertyName ?? e.name).text) });
    } else units.push({ node: s, names: [] });
  }
  const locals = new Set(units.flatMap((u) => u.names));
  const visit = (n: TS.Node, owner: string[]): void => {
    if (ts.isIdentifier(n)) {
      if (locals.has(n.text) && isRef(ts, n)) mod.users.set(n.text, [...(mod.users.get(n.text) ?? []), owner]);
      const ns = nsLocals.get(n.text);
      const p = n.parent;
      // `ns.member` / `ns.Type` names one export; any other use of the namespace object reaches them all
      if (ns) mod.imports.push({ target: ns, names: ts.isPropertyAccessExpression(p) && p.expression === n ? [p.name.text] : ts.isQualifiedName(p) && p.left === n ? [p.right.text] : "*" });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      const t = target(n.argument.literal);
      let q: TS.EntityName | undefined = n.qualifier;
      while (q && ts.isQualifiedName(q)) q = q.left;
      if (t) mod.imports.push({ target: t, names: q ? [q.text] : "*" });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const t = target(n.arguments[0]);
      if (t) mod.imports.push({ target: t, names: dynamicPick(ts, n) });
    }
    ts.forEachChild(n, (c) => visit(c, owner));
  };
  for (const u of units) visit(u.node, u.names);
  return mod;
}

/** The seam checks over a whole tree (pure: `files` carries every text):
 *  (a) CLASS — a baseline row with live in-module use and only test importers is a test seam: tag it;
 *      a re-export row with only test importers: import the defining module.
 *  (b) TAG SCOPE — an `@internal` export needs live in-module use, ≥1 importer, only test importers.
 *  (c) BAN — `@public`/`@beta`/`@alias` on a src/api export; `@internal` in `src/api/types.ts` or on an `export { … }`.
 *  Live in-module use is a fixed point: a reference counts when its top-level owner runs, is a prod-imported
 *  export (neither a row nor tagged), or is itself live — so a row used only by another dead row stays dead.
 *  `tagged` counts the in-scope `@internal` exports analysed and `importedBy` exposes the importer walk: the
 *  real-tree run's vacuity anchors (a clean report over an empty or unresolved tree reads as a pass). */
interface ImportedBy { by: string[]; testOnly: boolean; nonTest: string[] }
interface SeamReport { lines: string[]; tagged: number; importedBy: (file: string, name: string) => ImportedBy }
function seamReport(ts: typeof TS, files: readonly SrcFile[], baseline: readonly string[]): SeamReport {
  const paths = new Set(files.map((f) => f.file));
  const resolver = (from: string) => (spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const stem = base.replace(/\.m?js$/, "");
    return [base, `${stem}.ts`, `${stem}.mts`, `${stem}/index.ts`].find((p) => paths.has(p));
  };
  const mods = new Map(files.map((f) => [f.file, analyse(ts, f, resolver(f.file))] as const));
  const rows = new Set(baseline);
  const fileRows = new Set(baseline.flatMap((r) => /^(\S+) \[files\] /.exec(r)?.[1] ?? []));
  const importers = new Map<string, Set<string>>();
  const fileImporters = new Map<string, Set<string>>();
  const push = <V>(m: Map<string, Set<V>>, k: string, v: V): void => void m.set(k, (m.get(k) ?? new Set<V>()).add(v));
  const exportNames = (file: string, seen = new Set<string>()): string[] => {
    const m = mods.get(file);
    if (!m || seen.has(file)) return [];
    seen.add(file);
    return [...[...m.exports].filter(([n, e]) => n !== "default" && !e.typeOnly).map(([n]) => n), ...m.stars.flatMap((s) => exportNames(s, seen))];
  };
  // an import of a re-exported name is an importer of every hop, down to the defining module
  const addNamed = (file: string, name: string, by: string, seen = new Set<string>()): void => {
    if (seen.has(key(file, name))) return;
    seen.add(key(file, name));
    push(importers, key(file, name), by);
    const m = mods.get(file);
    const e = m?.exports.get(name);
    if (e?.via) addNamed(e.via.target, e.via.name, by, seen);
    else if (!e) for (const s of m?.stars ?? []) addNamed(s, name, by, seen);
  };
  for (const [file, m] of mods) {
    for (const t of m.fileImports) push(fileImporters, t, file);
    for (const i of m.imports) for (const n of i.names === "*" ? exportNames(i.target) : i.names) addNamed(i.target, n, file);
  }
  const classOf = (file: string, seen = new Set<string>()): Cls[] => {
    if (TEST_FILE.test(file)) return ["test"];
    if (!fileRows.has(file) && !file.startsWith("src/goldens/")) return [/^(src|api)\//.test(file) ? "prod" : "script"];
    if (seen.has(file)) return [];
    seen.add(file);
    return [...(fileImporters.get(file) ?? [])].flatMap((i) => classOf(i, seen));
  };
  const importedBy = (file: string, name: string): ImportedBy => {
    const by = [...(importers.get(key(file, name)) ?? [])].sort();
    const nonTest = by.filter((b) => classOf(b).some((c) => c !== "test"));
    return { by, nonTest, testOnly: nonTest.length === 0 && by.some((b) => classOf(b).length > 0) };
  };
  const liveMemo = new Map<string, Set<string>>();
  const liveLocals = (file: string, m: Mod): Set<string> => {
    const hit = liveMemo.get(file);
    if (hit) return hit;
    const live = new Set<string>();
    for (const [name, e] of m.exports) {
      const quiet = rows.has(`${file} [exports] ${name}`) || rows.has(`${file} [types] ${name}`) || e.tags.has("internal");
      if (e.local && !quiet) live.add(e.local);
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const [local, owners] of m.users) {
        if (live.has(local) || !owners.some((o) => o.length === 0 || o.some((n) => live.has(n)))) continue;
        live.add(local);
        grew = true;
      }
    }
    liveMemo.set(file, live);
    return live;
  };
  const defOf = (file: string, name: string): string => {
    const e = mods.get(file)?.exports.get(name);
    return e?.via ? defOf(e.via.target, e.via.name) : file;
  };
  const out: string[] = [];
  let tagged = 0;
  for (const row of baseline) {
    const [, file = "", name = ""] = /^(\S+) \[(?:exports|types)\] (\S+)$/.exec(row) ?? [];
    const m = mods.get(file);
    const e = m?.exports.get(name);
    // src/api/types.ts rows stay rows: the tag is banned there (contract.test.ts reads it as source text)
    if (!m || !e || file === "src/api/types.ts" || !importedBy(file, name).testOnly) continue;
    if (e.via) out.push(`${file} [class] ${name} - only tests import it: import it from \`${defOf(file, name)}\`, drop the re-export and the row`);
    else if (e.local && liveLocals(file, m).has(e.local)) out.push(`${file} [class] ${name} - a test seam: tag it \`/** @internal */\`, delete the row`);
  }
  for (const [file, m] of mods) {
    if (!IN_SCOPE.test(file) || TEST_FILE.test(file)) continue;
    for (const [name, e] of m.exports) {
      for (const t of BANNED_TAGS) if (e.tags.has(t)) out.push(`${file} [ban] ${name} - \`@${t}\` silences both knip arms`);
      if (!e.tags.has("internal")) continue;
      tagged++;
      if (file === "src/api/types.ts") out.push(`${file} [ban] ${name} - \`@internal\` on a read-API contract type (src/api/contract.test.ts reads this file)`);
      else if (e.specifierStmt) out.push(`${file} [ban] ${name} - \`@internal\` on an \`export { … }\` statement: tag the declaration`);
      else {
        const { by, nonTest } = importedBy(file, name);
        const why = [
          e.local && liveLocals(file, m).has(e.local) ? "" : "no live in-module use (test-only code: test through the public seam and drop `export`, or restore the row)",
          by.length ? "" : "no importer (drop `export`)",
          nonTest.length ? `a non-test importer: ${nonTest.join(", ")} (drop the tag; a script seam keeps its row)` : "",
        ].filter(Boolean);
        if (why.length) out.push(`${file} [scope] ${name} - \`@internal\` but ${why.join("; ")}`);
      }
    }
  }
  return { lines: out.sort(), tagged, importedBy };
}

/** Every importer the checks can see: src, api, scripts (minus knip's ignored archive), public. */
function treeFiles(): SrcFile[] {
  const out: SrcFile[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isSymbolicLink() || e.name === "node_modules" || e.name.startsWith(".") || p === "scripts/archive") continue;
      if (e.isDirectory()) walk(p);
      else if (/\.[mc]?[jt]s$/.test(e.name)) out.push({ file: p, text: readFileSync(p, "utf8") });
    }
  };
  for (const r of ["src", "api", "scripts", "public"]) walk(r);
  return out;
}

const SEAM_MSG: FailMessage = {
  what: "test seam carried as a baseline row, or `@internal` off a test seam (seamReport)",
  why: "a row hides a seam's intent behind a ratchet; a misplaced tag blinds knip --production to a live or dead export",
  move: "each line names its move",
  never: "add `@public`/`@beta`/`@alias` or a knip.json exclusion, or tag a script seam",
};

const DEFAULT_MSG: FailMessage = {
  what: "export nothing imports (knip)",
  why: "a dead export reads as a live seam",
  move: "delete it, or drop `export` if only this file uses it",
  never: "add a re-export to silence this",
};
const PROD_MSG: FailMessage = {
  what: "export only tests or one-off scripts import (knip --production)",
  why: "a test-only export widens the module surface for a test's convenience",
  move: `used in its own module: \`/** @internal */\`, no row · a re-export: import the defining module · test-only code: test through the public seam and drop \`export\`, or add the row to \`${BASELINE}\``,
  never: "add a re-export, or move the symbol into a *.test-helpers.ts to silence this; `@public`/`@beta`/`@alias`, a knip.json exclusion",
};

/** In-memory tree: each check's failure line once, plus decoys only a correct walker leaves clean —
 *  a row used only by a dead row (fixed point), a seam reached via a `[files]` row (class inheritance),
 *  and a prod namespace import that names one member. Each importer-resolution path owes a line that moves
 *  when it breaks: a destructured `await import(…)` and its `Promise.all([…])` element (`DYN`/`ARR`, with
 *  `DYNSAFE` beside them proving the pick names only what it binds), a 2-hop `export { … } from` chain
 *  (`HOP`), an `export *` barrel (`STAR`), an `import("…").T` type node (`Shape`), a `src/goldens/` file
 *  inheriting its test importer's class (`GOLD`), a bare top-level call as a row's only live user
 *  (`RUNNER`), the `src/api/types.ts` row exemption (`Wire`), and a test's `...ns` spread that never
 *  reaches a type (`Opts`). */
const SEAM_FIXTURE: readonly SrcFile[] = [
  { file: "src/run.ts", text: 'import * as M from "./m.js";\nM.go();\n' },
  {
    file: "src/m.ts",
    text: [
      "export const ROW = 1;",
      "/** @internal */ export const GOOD = 2;",
      "/** @internal */ export const NOUSE = 3;",
      "/** @internal */ export const NOIMP = 4;",
      "/** Read by a script. @internal */ export const SCRIPTED = 5;",
      "/** @internal */ export const VIAFAKE = 6;",
      "export const DEADROW = 7;",
      "export const DEADUSER = (): number => DEADROW;",
      "/** @public */ export const PUB = 8;",
      "const local = 9;",
      "/** @internal */ export { local };",
      "export const go = (): number => ROW + GOOD + NOIMP + SCRIPTED + VIAFAKE + local;",
    ].join("\n"),
  },
  { file: "src/q.ts", text: "export const SEAM2 = 1;\n" },
  { file: "src/p.ts", text: 'export { SEAM2 } from "./q.js";\n' },
  { file: "src/fake.ts", text: 'import { VIAFAKE } from "./m.js";\nexport const fake = VIAFAKE;\n' },
  { file: "src/m.test.ts", text: 'import { ROW, GOOD, NOUSE, DEADROW, DEADUSER } from "./m.js";\nimport { SEAM2 } from "./p.js";\nimport { fake } from "./fake.js";\n' },
  { file: "src/api/types.ts", text: "/** @internal */ export interface Contract { a: number }\nexport interface Wire { b: number }\nexport type Pair = [Wire, Wire];\n" },
  { file: "scripts/s.ts", text: 'import { SCRIPTED } from "../src/m.js";\n' },
  {
    file: "src/d.ts",
    text: "/** @internal */ export const DYN = 1;\n/** @internal */ export const ARR = 2;\n/** @internal */ export const DYNSAFE = 3;\nexport const sum = (): number => DYN + ARR + DYNSAFE;\n",
  },
  { file: "src/z.ts", text: "export const ZERO = 0;\n" },
  { file: "src/dyn.ts", text: 'const { DYN } = await import("./d.js");\nconst [{ ZERO }, { ARR }] = await Promise.all([import("./z.js"), import("./d.js")]);\nexport const dyn = DYN + ZERO + ARR;\n' },
  { file: "src/h0.ts", text: "/** @internal */ export const HOP = 1;\nexport const useHop = (): number => HOP;\n" },
  { file: "src/h1.ts", text: 'export { HOP } from "./h0.js";\n' },
  { file: "src/h2.ts", text: 'export { HOP } from "./h1.js";\n' },
  { file: "src/star.ts", text: "/** @internal */ export const STAR = 1;\nexport const useStar = (): number => STAR;\n" },
  { file: "src/bar.ts", text: 'export * from "./star.js";\n' },
  { file: "src/ty.ts", text: "/** @internal */ export interface Shape { a: number }\nexport const mk = (): Shape => ({ a: 1 });\n" },
  { file: "src/edges.ts", text: 'import { HOP } from "./h2.js";\nimport { STAR } from "./bar.js";\nexport type Edge = import("./ty.js").Shape;\nexport const edges = HOP + STAR;\n' },
  { file: "src/gm.ts", text: "/** @internal */ export const GOLD = 1;\nexport const useGold = (): number => GOLD;\n" },
  { file: "src/goldens/g.ts", text: 'import { GOLD } from "../gm.js";\nexport const golden = GOLD;\n' },
  { file: "src/main.ts", text: "export const RUNNER = (): number => 1;\nRUNNER();\n" },
  { file: "src/tyrow.ts", text: "export interface Opts { a: number }\nexport const make = (o: Opts): number => o.a;\n" },
  {
    file: "src/n.test.ts",
    text: 'import { DYNSAFE } from "./d.js";\nimport { RUNNER } from "./main.js";\nimport type { Wire } from "./api/types.js";\nimport { golden } from "./goldens/g.js";\nimport * as TR from "./tyrow.js";\nconst all = { ...TR };\n',
  },
];
const SEAM_FIXTURE_ROWS = [
  "src/m.ts [exports] ROW",
  "src/m.ts [exports] DEADROW",
  "src/m.ts [exports] DEADUSER",
  "src/p.ts [exports] SEAM2",
  "src/fake.ts [files] src/fake.ts",
  "src/main.ts [exports] RUNNER",
  "src/api/types.ts [types] Wire",
  "src/tyrow.ts [types] Opts",
];

describe("unused exports (knip)", () => {
  // knip runs in beforeAll: the spawns are fixture work, outside TEST_CEILING_MS.
  let fixture: KnipHit[] = [];
  let fixtureProd: KnipHit[] = [];
  let repo: KnipHit[] = [];
  let prod: KnipHit[] = [];
  let ts: typeof TS;
  let seams: SeamReport;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "knip-fx-"));
    try {
      writeFileSync(join(dir, "package.json"), '{ "name": "fx", "type": "module" }');
      writeFileSync(join(dir, "knip.json"), '{ "entry": ["src/index.ts!", "scripts/tool.ts"], "project": ["src/**/*.ts!"] }');
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "src/index.ts"), 'import { used } from "./lib.js";\nconsole.log(used);\nexport const entryDead = 3;\n');
      writeFileSync(join(dir, "src/lib.ts"), "export const used = 1;\nexport const dead = 2;\nexport type Dead = number;\n/** @internal */\nexport const tagged = 5;\n");
      writeFileSync(join(dir, "scripts/tool.ts"), 'export { dead } from "../src/lib.js";\nexport const toolDead = 4;\n');
      fixture = knip(dir, "--include-entry-exports").filter((h) => IN_SCOPE.test(h.file));
      fixtureProd = knip(dir, "--production").filter((h) => IN_SCOPE.test(h.file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    repo = knip(process.cwd(), "--include-entry-exports").filter((h) => IN_SCOPE.test(h.file));
    prod = knip(process.cwd(), "--production");
    ts = await loadTs();
    seams = seamReport(ts, treeFiles(), JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
  }, 60_000 + SCAN_HOOK_TIMEOUT);

  test("fixture: an entry's own export and a script-re-exported dead export are caught; both reports can fail", () => {
    expect(fixture.map(label).sort()).toEqual(["src/index.ts [exports] entryDead", "src/lib.ts [exports] dead", "src/lib.ts [exports] tagged", "src/lib.ts [types] Dead"]);
    const r = rosterReport(fixture, [{ file: "src/lib.ts", code: "gone", count: 1, reason: "made-up: x" }, { file: "src/index.ts", code: "entryDead", count: 1, reason: "handler: x" }]);
    const b = baselineReport(fixture, ["src/lib.ts [exports] dead", "src/lib.ts [exports] gone"]);
    expect([r.unrostered.length, r.stale.length, r.badReason.length, b.unrostered.length, b.stale.length]).toEqual([3, 1, 2, 3, 1]);
  });

  test("default arm: every unused export is deleted, un-exported or rostered", () => {
    expectClean(rosterReport(repo, ROSTER), DEFAULT_MSG);
  });

  test("fixture: `@internal` hides a dead export from --production only, and the default arm still sees it (pins the tag's semantics across knip upgrades)", () => {
    expect(fixtureProd.map(label).sort()).toEqual(["src/lib.ts [exports] dead", "src/lib.ts [types] Dead"]);
  });

  test("--production arm: test-only exports match the baseline", () => {
    expectClean(baselineReport(prod, JSON.parse(readFileSync(BASELINE, "utf8")) as string[]), PROD_MSG);
  });

  test("seam fixture: each check and each importer-resolution path fires its exact line; every decoy stays clean", () => {
    const nonTest = (by: string): string => `\`@internal\` but a non-test importer: ${by} (drop the tag; a script seam keeps its row)`;
    expect(seamReport(ts, SEAM_FIXTURE, SEAM_FIXTURE_ROWS).lines).toEqual([
      "src/api/types.ts [ban] Contract - `@internal` on a read-API contract type (src/api/contract.test.ts reads this file)",
      `src/d.ts [scope] ARR - ${nonTest("src/dyn.ts")}`,
      `src/d.ts [scope] DYN - ${nonTest("src/dyn.ts")}`,
      `src/h0.ts [scope] HOP - ${nonTest("src/edges.ts")}`,
      "src/m.ts [ban] PUB - `@public` silences both knip arms",
      "src/m.ts [ban] local - `@internal` on an `export { … }` statement: tag the declaration",
      "src/m.ts [class] ROW - a test seam: tag it `/** @internal */`, delete the row",
      "src/m.ts [scope] NOIMP - `@internal` but no importer (drop `export`)",
      "src/m.ts [scope] NOUSE - `@internal` but no live in-module use (test-only code: test through the public seam and drop `export`, or restore the row)",
      `src/m.ts [scope] SCRIPTED - ${nonTest("scripts/s.ts")}`,
      "src/main.ts [class] RUNNER - a test seam: tag it `/** @internal */`, delete the row",
      "src/p.ts [class] SEAM2 - only tests import it: import it from `src/q.ts`, drop the re-export and the row",
      `src/star.ts [scope] STAR - ${nonTest("src/edges.ts")}`,
      `src/ty.ts [scope] Shape - ${nonTest("src/edges.ts")}`,
    ]);
  });

  test("seams: every test seam is tagged `@internal` (no row), and every tag sits on a test seam", () => {
    expectClean({ hits: [], unrostered: seams.lines, stale: [], badReason: [] }, SEAM_MSG);
  });

  test("seams: the real-tree walk is not vacuous — it analyses ≥1 tagged export, and a script's import of src/ resolves", () => {
    expect(seams.tagged).toBeGreaterThan(0);
    expect(seams.importedBy("src/alert-band.ts", "computeAlertBand").nonTest).toContain("scripts/simulate-notify.ts");
  });
});
