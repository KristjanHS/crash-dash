import { readdirSync, readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTs, misfires, scanText, type Visitor } from "../src/source-scan.test-helpers.js";

// public/ guards; raw writes → public/write-seam.test.js.

let ts: typeof TS;
// Any callee whose last identifier names a fetch seam (`fetch`, `baseFetch`, `apiFetch`, `fetchImpl`, `fetchFn`, `fetchOnce`,
// `globalThis.fetch`), minus the http.js helpers. A bare `fetch<Noun>` (fetchAll, fetchSlot, fetchSeries) is an app-level
// loader that itself goes through request — matching it would flag every caller of a timed read.
const FETCH = /(?:^f|F)etch(?:Impl|Fn|Once)?$/;
const HTTP_HELPER = /^(?:request|getJson|send)$/;
const calleeName = (e: TS.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
const isFetchCall = (n: TS.CallExpression): boolean => {
  const name = calleeName(n.expression);
  return name !== null && FETCH.test(name) && !HTTP_HELPER.test(name);
};
/** `timeoutMs: null` or `timeoutMs: 0` — composeSignal treats both as no timeout. */
const offTimeout = (e: TS.Expression): boolean =>
  e.kind === ts.SyntaxKind.NullKeyword || (ts.isNumericLiteral(e) && Number(e.text) === 0);
const hasSignal = (o: TS.ObjectLiteralExpression): boolean =>
  o.properties.some((p) => ts.isSpreadAssignment(p) || (p.name !== undefined && p.name.getText() === "signal"));

const VISITOR: Visitor = {
  visit: (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "timeoutMs" && offTimeout(n.initializer)) return "no-timeout";
    if (!ts.isCallExpression(n) || !isFetchCall(n) || n.arguments.some(ts.isSpreadElement)) return null;
    const init = n.arguments[1];
    if (init === undefined) return "fetch-no-signal";
    return ts.isObjectLiteralExpression(init) && !hasSignal(init) ? "fetch-no-signal" : null;
  },
};
const KINDS = ["no-timeout", "fetch-no-signal"] as const;

describe("public/ production modules: every fetch abortable", () => {
  beforeAll(async () => {
    ts = await loadTs();
  });

  it("the visitor fires on each kind and spares the forwarding/abortable shapes", () => {
    const fire = [
      ['request("/api/x", { timeoutMs: null });', "no-timeout"],
      ['getJson("/api/x", { timeoutMs: 0 });', "no-timeout"],
      ['fetchImpl("/api/x");', "fetch-no-signal"],
      ['globalThis.fetch(u, { method: "POST" });', "fetch-no-signal"],
      ['fetchOnce("/api/x");', "fetch-no-signal"],
      ['fetchFn(u, { cache: "no-cache" });', "fetch-no-signal"],
      ["this.fetch(u);", "fetch-no-signal"],
    ] as const;
    const decoys = [
      'request("/api/x", { timeoutMs: API_TIMEOUT_MS });',
      "fetchImpl(url, init);",
      'fetchImpl("/api/x", { signal });',
      "fetchImpl(u, { ...init, headers });",
      "globalThis.fetch(...args);",
      'request("/api/x", { fetchImpl: fetchOnce, timeoutMs: API_TIMEOUT_MS });',
      'getJson("/api/x", { timeoutMs: 5 });',
      "fetchAll();",
      "fetchSlot(c);",
      "fetchOnceVia(apiFetch);",
    ];
    expect(misfires(VISITOR, KINDS, fire, decoys)).toEqual([]);
  });

  it("no production public/*.js carries a hit", () => {
    const files = readdirSync("public").filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    expect(files).toContain("lab.js");
    const hits = files.flatMap((f) => scanText(`public/${f}`, readFileSync(`public/${f}`, "utf8"), VISITOR));
    expect(
      hits.map((h) => `${h.file}:${h.line} [${h.kind}] ${h.code}`),
      "a fetch goes through http.js request/getJson/send with a timeout",
    ).toEqual([]);
  });
});

// `node --check` parses one file; a renamed or dropped export only breaks in the browser. Each relative static import,
// re-export and `import("…")` in a production module must name an existing file exporting every named binding.
type Read = (path: string) => string | null;
const parse = (path: string, text: string): TS.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const isExported = (n: TS.Node): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (n: TS.Node): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
const boundNames = (b: TS.BindingName): string[] =>
  ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundNames(e.name)));
const resolveRel = (from: string, spec: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) seg === ".." ? parts.pop() : seg !== "." && parts.push(seg);
  return parts.join("/");
};

function exportsOf(path: string, read: Read, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  const text = read(path);
  if (text === null || seen.has(path)) return out;
  seen.add(path);
  for (const s of parse(path, text).statements) {
    if (ts.isExportAssignment(s)) out.add("default");
    else if (ts.isExportDeclaration(s)) {
      if (s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) out.add(e.name.text);
      else if (s.exportClause) out.add(s.exportClause.name.text);
      else if (s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier))
        for (const n of exportsOf(resolveRel(path, s.moduleSpecifier.text), read, seen)) if (n !== "default") out.add(n);
    } else if (isExported(s) && isDefault(s)) out.add("default");
    else if (isExported(s) && ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) for (const n of boundNames(d.name)) out.add(n);
    else if (isExported(s) && (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) out.add(s.name.text);
  }
  return out;
}

/** `file:line binding ← spec` for every link that does not resolve. */
function brokenLinks(path: string, read: Read): string[] {
  const sf = parse(path, read(path) ?? "");
  const out: string[] = [];
  const check = (node: TS.Node, spec: string, names: string[]): void => {
    if (!spec.startsWith(".")) return;
    const target = resolveRel(path, spec);
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (read(target) === null) return void out.push(`${path}:${line} <file> ← ${spec}`);
    const have = exportsOf(target, read);
    for (const n of names) if (!have.has(n)) out.push(`${path}:${line} ${n} ← ${spec}`);
  };
  const visit = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text) : [];
      check(n, n.moduleSpecifier.text, [...(c?.name ? ["default"] : []), ...named]);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const named = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : [];
      check(n, n.moduleSpecifier.text, named);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      check(n, n.arguments[0].text, []);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const readDisk: Read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

describe("public/ production modules: every relative import resolves to a named export", () => {
  beforeAll(async () => {
    ts = await loadTs();
  });

  it("can fail: a dropped export, a missing default, a missing file and a dead dynamic import hit; live links do not", () => {
    const files: Record<string, string> = {
      "public/a.js": [
        'import { x, gone } from "./b.js";',
        'import d from "./b.js";',
        'import "./missing.js";',
        'export { z as zz, w } from "./b.js";',
        'import { x as y2, s } from "./c.js";',
        'const m = await import("./nope.js");',
        'import { y } from "./b.js";',
        'import { ext } from "node:fs";',
      ].join("\n"),
      "public/b.js": "export const x = 1;\nexport function z() {}\nconst w = 2;\nexport { w };\nexport const { y } = { y: 3 };",
      "public/c.js": 'export * from "./b.js";\nexport class s {}',
    };
    const read: Read = (p) => files[p] ?? null;
    expect(brokenLinks("public/a.js", read)).toEqual([
      "public/a.js:1 gone ← ./b.js",
      "public/a.js:2 default ← ./b.js",
      "public/a.js:3 <file> ← ./missing.js",
      "public/a.js:6 <file> ← ./nope.js",
    ]);
  });

  it("no production public/*.js carries a broken link", () => {
    const files = readdirSync("public").filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    expect(files).toContain("lab.js");
    expect(exportsOf("public/http.js", readDisk).has("request")).toBe(true);
    expect(files.flatMap((f) => brokenLinks(`public/${f}`, readDisk)), "import a name the target file exports, or export it there").toEqual([]);
  });
});
