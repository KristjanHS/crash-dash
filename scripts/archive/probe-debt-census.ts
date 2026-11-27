/** AI-agent debt census: ONE syntax-only AST
 *  pass (`ts.createSourceFile`, no Program — `src/locality-lint.test.ts` precedent) over `src/**`, `api/**`,
 *  `public/**`, report-only, always exit 0. `npx tsx scripts/archive/probe-debt-census.ts [--json] [--out=<path>] [--since=<rev>]`
 *  — table to stdout; `--json` prints one object; `--out` writes it; `--since` re-runs the scan over `git archive <rev>`
 *  and prints each metric's delta + sites per 100 commits. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isoDay } from "../../src/dates.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PATH_CLASSES = ["notify/danger", "read-api", "feed", "store", "public", "other"] as const;
type PathClass = (typeof PATH_CLASSES)[number];
type Hit = { file: string; line: number; kind: string; snippet: string; cls: PathClass; note?: string };
const KINDS = [
  "catch:rethrow", "catch:log+rethrow", "catch:log+continue", "catch:return-default", "catch:empty", "catch:other",
  "promise-swallow", "default-site", "cast:as", "cast:non-null", "cast:boundary", "fetch:raw", "fetch:no-signal",
  "clock:Date.now", "clock:new Date", "env:read", "from:unguarded-read", "from:single", "from:write",
] as const;
const BOUNDARY = /JSON\.parse|\.json\(\)|\.select\(|rows\[|\.data\b/;
const LOGGER = /^console\.|(^|\.)(log|warn|error|info|debug|degrade\w*|logger)$/;
const GUARD = /paginateRows|assertNotTruncated/;
const isTest = (f: string): boolean => /\.test\.(ts|js)$|\.test-helpers\.ts$/.test(f) || f === "src/test-helpers.ts";

/** Tests (`it`/`test`, any modifier or `.each`) whose every `expect(` chain is a `toHaveBeenCalled*` matcher. */
function callOnlyTests(file: string, text: string): number {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isTestCall = (c: ts.CallExpression): boolean => /^(it|test)\b/.test(c.expression.getText(sf)) && c.arguments.some((a) => ts.isFunctionLike(a));
  const isCallMatcher = (e: ts.CallExpression): boolean => {
    let p: ts.Node = e;
    while (ts.isPropertyAccessExpression(p.parent) || (ts.isCallExpression(p.parent) && p.parent.expression === p)) {
      p = p.parent;
      if (ts.isPropertyAccessExpression(p) && /^toHaveBeen(Nth|Last)?Called/.test(p.name.text)) return true;
    }
    return false;
  };
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const kinds: boolean[] = [];
      const inner = (x: ts.Node): void => {
        if (ts.isCallExpression(x) && /^expect(\.soft)?$/.test(x.expression.getText(sf))) kinds.push(isCallMatcher(x));
        ts.forEachChild(x, inner);
      };
      node.arguments.forEach(inner);
      if (kinds.length && kinds.every(Boolean)) n++;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

// ---------------------------------------------------------------- AST helpers
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
}
/** A fabricated value: number, string, `[]`, `{}` (metric 2's RHS set). */
function isDefaultLiteral(e: ts.Expression): boolean {
  const u = unwrap(e);
  return ts.isNumericLiteral(u) || ts.isStringLiteralLike(u) ||
    (ts.isArrayLiteralExpression(u) && u.elements.length === 0) || (ts.isObjectLiteralExpression(u) && u.properties.length === 0) ||
    (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(u.operand));
}
/** `return <literal|undefined|null|true|false>` (or bare `return`). */
function isDefaultReturn(e: ts.Expression | undefined): boolean {
  if (!e) return true;
  const u = unwrap(e);
  return isDefaultLiteral(u) || u.kind === ts.SyntaxKind.NullKeyword || u.kind === ts.SyntaxKind.TrueKeyword ||
    u.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(u) && u.text === "undefined");
}
/** Walk `n` without crossing into nested functions; true once `pred` matches. */
function containsShallow(n: ts.Node, pred: (x: ts.Node) => boolean): boolean {
  let found = false;
  const go = (x: ts.Node): void => {
    if (found) return;
    if (pred(x)) { found = true; return; }
    if (x !== n && ts.isFunctionLike(x)) return;
    ts.forEachChild(x, go);
  };
  go(n);
  return found;
}
const isLogCall = (x: ts.Node, sf: ts.SourceFile): boolean => ts.isCallExpression(x) && LOGGER.test(x.expression.getText(sf));
function catchClass(c: ts.CatchClause, sf: ts.SourceFile): string {
  const b = c.block;
  if (b.statements.length === 0) return "catch:empty";
  const logs = containsShallow(b, (x) => isLogCall(x, sf));
  if (containsShallow(b, ts.isThrowStatement)) return logs ? "catch:log+rethrow" : "catch:rethrow";
  if (b.statements.some((x) => ts.isReturnStatement(x) && isDefaultReturn(x.expression))) return "catch:return-default";
  return logs ? "catch:log+continue" : "catch:other";
}
/** `.catch(() => <literal|undefined|[]|{}>)`, `.catch(() => {})`, `.catch(() => { return <default>; })`. */
function isPromiseSwallow(n: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "catch") return false;
  const fn = n.arguments[0];
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const body = fn.body;
  if (!ts.isBlock(body)) return isDefaultReturn(body);
  if (body.statements.length === 0) return true;
  const only = body.statements[0];
  return body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only) && isDefaultReturn(only.expression);
}
/** `fetch(url, opts)`: does `opts` carry a `signal`? "unknown" = non-literal options / spread. */
function fetchSignal(n: ts.CallExpression): "yes" | "no" | "unknown" {
  const o = n.arguments[1];
  if (!o) return "no";
  if (!ts.isObjectLiteralExpression(o)) return "unknown";
  if (o.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "signal")) return "yes";
  return o.properties.some(ts.isSpreadAssignment) ? "unknown" : "no";
}
/** Climb the member chain a `.from(` sits in, then its enclosing function body. */
function fromGuardScope(n: ts.Node, sf: ts.SourceFile): string {
  let top: ts.Node = n;
  while (top.parent && (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent) ||
    ts.isAwaitExpression(top.parent) || ts.isParenthesizedExpression(top.parent))) top = top.parent;
  let fn: ts.Node | undefined = top;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  return `${top.getText(sf)}\n${fn?.getText(sf) ?? ""}`;
}
/** Names read off `process.env`; a bare `process.env` handed on whole (a default param, an argument) yields `*`. */
function envName(n: ts.Node, sf: ts.SourceFile): string[] {
  if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === "process.env") return [n.name.text];
  if (ts.isPropertyAccessExpression(n) && n.getText(sf) === "process.env" && !ts.isElementAccessExpression(n.parent) &&
    !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) &&
    !(ts.isVariableDeclaration(n.parent) && ts.isObjectBindingPattern(n.parent.name))) return ["*"];
  if (ts.isElementAccessExpression(n) && n.expression.getText(sf) === "process.env" && ts.isStringLiteralLike(n.argumentExpression)) {
    return [n.argumentExpression.text];
  }
  if (ts.isVariableDeclaration(n) && n.initializer?.getText(sf) === "process.env" && ts.isObjectBindingPattern(n.name)) {
    return n.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
  }
  return [];
}


/** The census of the tree at `root` (a path ending `/`); `withChurn` reads `git log` there (a `git archive` has no history). */
function census(root: string, withChurn: boolean) {
  // ---------------------------------------------------------------- file sets
  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(`${root}${dir}`)) return out;
    for (const e of readdirSync(`${root}${dir}`, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === "node_modules" || (dir === "scripts/" && e.name === "archive")) continue;
      if (e.isDirectory()) walk(`${dir}${e.name}/`, out);
      else out.push(`${dir}${e.name}`);
    }
    return out;
  }
  const ALL = [...walk("src/"), ...walk("api/"), ...walk("public/"), ...walk("scripts/")];
  const CODE = ALL.filter((f) =>
    (f.startsWith("public/") ? f.endsWith(".js") : /^(src|api)\//.test(f) && f.endsWith(".ts") && !f.endsWith(".d.ts")) && !isTest(f),
  );
  const TESTS = ALL.filter((f) => /^(src|api|scripts)\//.test(f) && f.endsWith(".test.ts"));
  const CODE_SET = new Set(CODE);

  /** `src/danger-engine.stand-ins.test.ts` FILES list — its sites are already ruled one by one; counted, never listed. */
  const rosterFile = `${root}src/danger-engine.stand-ins.test.ts`;
  const ROSTERED = new Set(
    [...((existsSync(rosterFile) ? readFileSync(rosterFile, "utf8") : "").match(/const FILES = \[([\s\S]*?)\] as const/)?.[1] ?? "")
      .matchAll(/"([^"]+\.ts)"/g)].map((m) => `src/${m[1]}`),
  );

  function pathClass(file: string, text: string): PathClass {
    if (file.startsWith("public/")) return "public";
    if (file.startsWith("api/") || file.startsWith("src/api/")) return "read-api";
    const b = basename(file, ".ts");
    if (/^store/.test(b)) return "store";
    if (/^(run-|alert-band|danger-|ladder|ntfy|t1dial|families|domain-|scorers-)/.test(b)) return "notify/danger";
    if (/^(fred|prices|geo|confirmers|fetch-budget)$/.test(b) || /feed/.test(b) || /from "\.\/fetch-budget/.test(text)) return "feed";
    return "other";
  }

  // ---------------------------------------------------------------- the pass
  const hits: Hit[] = [];
  let rostered = 0;
  const envReads = new Map<string, string[]>();
  let fromGuarded = 0;
  const loc = new Map<string, number>();

  for (const file of CODE) {
    const text = readFileSync(`${root}${file}`, "utf8");
    const lines = text.split("\n");
    loc.set(file, lines.length);
    const cls = pathClass(file, text);
    const kind = file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const push = (n: ts.Node, k: string, note?: string): void => {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const snippet = (lines[line - 1] ?? "").trim().slice(0, 110);
      hits.push(note === undefined ? { file, line, kind: k, snippet, cls } : { file, line, kind: k, snippet, cls, note });
    };
    const lineOf = (n: ts.Node): string => lines[sf.getLineAndCharacterOfPosition(n.getStart(sf)).line] ?? "";
    const dbFile = /^src\/store[^/]*\.ts$/.test(file) || file.startsWith("api/");
    const envFile = file.startsWith("src/") || file.startsWith("api/");

    const visit = (n: ts.Node): void => {
      if (ts.isCatchClause(n)) push(n, catchClass(n, sf));
      if (ts.isCallExpression(n) && isPromiseSwallow(n)) push(n, "promise-swallow");
      if (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        isDefaultLiteral(n.right)) {
        if (ROSTERED.has(file)) rostered++;
        else push(n, "default-site", n.operatorToken.getText(sf));
      }
      if ((ts.isAsExpression(n) && n.type.getText(sf) !== "const") || ts.isNonNullExpression(n)) {
        push(n, ts.isAsExpression(n) ? "cast:as" : "cast:non-null");
        if (BOUNDARY.test(lineOf(n))) push(n, "cast:boundary", ts.isAsExpression(n) ? "as" : "!");
      }
      if (ts.isCallExpression(n) && /^(globalThis\.)?fetch$/.test(n.expression.getText(sf)) && file !== "src/fetch-budget.ts") {
        const sig = fetchSignal(n);
        push(n, "fetch:raw", `signal=${sig}`);
        if (sig === "no") push(n, "fetch:no-signal");
      }
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "Date.now") push(n, "clock:Date.now");
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && (n.arguments?.length ?? 0) === 0) push(n, "clock:new Date");
      if (envFile) for (const name of envName(n, sf)) {
        push(n, "env:read", name);
        envReads.set(name, [...(envReads.get(name) ?? []), `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`]);
      }
      if (dbFile && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" &&
        !/^[A-Z]/.test(n.expression.expression.getText(sf))) {
        const scope = fromGuardScope(n, sf);
        if (GUARD.test(scope)) fromGuarded++;
        else if (/\.(insert|upsert|update|delete)\(/.test(scope)) push(n, "from:write");
        else if (/\.(single|maybeSingle)\(/.test(scope)) push(n, "from:single");
        else push(n, "from:unguarded-read");
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ---------------------------------------------------------------- env, mocks, churn
  const envExample = (existsSync(`${root}.env.example`) ? readFileSync(`${root}.env.example`, "utf8") : "").split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)(=|$)/)?.[1]).filter((k): k is string => k !== undefined);
  const readNotInExample = [...envReads.keys()].filter((k) => k !== "*" && !envExample.includes(k)).sort();
  const envPassthrough = envReads.get("*") ?? [];
  const exampleNeverRead = envExample.filter((k) => !envReads.has(k)).sort();

  const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;
  const mocks = TESTS.map((file) => {
    const t = readFileSync(`${root}${file}`, "utf8");
    const expects = count(t, /\bexpect\(/g);
    const called = count(t, /\.toHaveBeen(?:Nth|Last)?Called\w*/g);
    return { file, expects, calledShare: expects ? +(called / expects).toFixed(2) : 0, callOnly: callOnlyTests(file, t) };
  }).sort((a, b) => b.calledShare - a.calledShare || b.callOnly - a.callOnly).slice(0, 10);

  const churnLog = withChurn ? execFileSync("git", ["log", "--since=6.months", "--name-only", "--format="], { cwd: root, encoding: "utf8" }) : "";
  const churn = new Map<string, number>();
  for (const f of churnLog.split("\n")) if (CODE_SET.has(f)) churn.set(f, (churn.get(f) ?? 0) + 1);
  const hotspots = [...churn].map(([file, commits]) => ({ file, commits, loc: loc.get(file) ?? 0, score: commits * (loc.get(file) ?? 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 10);

  // ---------------------------------------------------------------- summary + output
  const summary: Record<string, Record<PathClass, number>> = {};
  for (const k of KINDS) summary[k] = Object.fromEntries(PATH_CLASSES.map((c) => [c, 0])) as Record<PathClass, number>;
  for (const h of hits) summary[h.kind]![h.cls]++;
  const total = (k: string): number => PATH_CLASSES.reduce((s, c) => s + (summary[k]?.[c] ?? 0), 0);
  const sumLoc = (fs: string[]): number => fs.reduce((s, f) => s + (loc.get(f) ?? readFileSync(`${root}${f}`, "utf8").split("\n").length), 0);
  const by = (k: string): Hit[] => hits.filter((h) => h.kind === k);

  const report = {
    generatedAt: isoDay(new Date()),
    populations: { code: { files: CODE.length, loc: sumLoc(CODE) }, tests: { files: TESTS.length, loc: sumLoc(TESTS) } },
    summary,
    totals: Object.fromEntries(KINDS.map((k) => [k, total(k)])),
    hits: {
      catches: hits.filter((h) => h.kind.startsWith("catch:")),
      promiseSwallow: by("promise-swallow"),
      defaults: by("default-site"),
      defaultsRostered: rostered,
      castBoundary: by("cast:boundary"),
      fetch: by("fetch:raw"),
      clock: hits.filter((h) => h.kind.startsWith("clock:")),
      env: { reads: Object.fromEntries([...envReads].sort()), readNotInExample, exampleNeverRead, passthrough: envPassthrough },
      from: { guarded: fromGuarded, hits: hits.filter((h) => h.kind.startsWith("from:")) },
      mocks,
      churn: hotspots,
    },
  };
  return report;
}
type Report = ReturnType<typeof census>;

/** Per-metric totals at `base` vs `head`, plus net new sites per 100 commits between them. */
function censusDelta(base: Report, head: Report, commits: number) {
  const metrics = (r: Report): Record<string, number> => ({ ...r.totals, "default-site:rostered": r.hits.defaultsRostered });
  const b = metrics(base), h = metrics(head);
  return Object.keys(h).map((k) => {
    const delta = (h[k] ?? 0) - (b[k] ?? 0);
    return { metric: k, base: b[k] ?? 0, head: h[k] ?? 0, delta, per100: commits > 0 ? +((delta * 100) / commits).toFixed(1) : null };
  });
}

/** Extract `rev`'s scanned dirs into a temp dir and census it; the dir is removed afterwards. */
function censusAt(rev: string): Report {
  const dir = mkdtempSync(join(tmpdir(), "debt-census-"));
  try {
    const has = (p: string): boolean => {
      try { execFileSync("git", ["cat-file", "-e", `${rev}:${p}`], { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; }
    };
    const paths = ["src", "api", "public", "scripts", ".env.example"].filter(has);
    const tar = join(dir, "rev.tar");
    execFileSync("git", ["archive", "-o", tar, rev, ...paths], { cwd: ROOT });
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    rmSync(tar);
    return census(`${dir}/`, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const report = census(ROOT, true);
const since = arg("since");
const delta = since === undefined ? undefined : (() => {
  const commits = Number(execFileSync("git", ["rev-list", "--count", `${since}..HEAD`], { cwd: ROOT, encoding: "utf8" }).trim());
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "api", "public"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  return { since, commits, dirty, rows: censusDelta(censusAt(since), report, commits) };
})();
const out = arg("out");
if (out) writeFileSync(out, `${JSON.stringify({ ...report, delta }, null, 2)}\n`);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...report, delta }));
} else {
  const pad = (s: string | number | null, w: number): string => String(s ?? "-").padStart(w);
  const w = 14;
  const { populations: pop, summary, totals, hits: h } = report;
  console.log(`debt census ${report.generatedAt} — code ${pop.code.files} files / ${pop.code.loc} LOC (src+api .ts, public .js, no tests, no scripts); tests ${pop.tests.files} files`);
  console.log(`${"metric".padEnd(22)}${PATH_CLASSES.map((c) => pad(c, w)).join("")}${pad("total", 8)}`);
  for (const k of KINDS) console.log(`${k.padEnd(22)}${PATH_CLASSES.map((c) => pad(summary[k]![c], w)).join("")}${pad(totals[k]!, 8)}`);
  console.log(`\ndefault-site rostered (stand-ins FILES, not listed): ${h.defaultsRostered}`);
  console.log(`.from( guarded by paginateRows/assertNotTruncated: ${h.from.guarded}; unguarded by kind above`);
  console.log(`\nenv names read but absent from .env.example: ${h.env.readNotInExample.join(", ") || "(none)"}`);
  console.log(`env example keys never read by name in src+api: ${h.env.exampleNeverRead.join(", ") || "(none)"} — whole-object pass-through at: ${h.env.passthrough.join(", ") || "(none)"}`);
  console.log("\nmock top 10 by called-share (toHaveBeenCalled* ÷ expect(; call-only = tests with no state assertion):");
  for (const m of h.mocks) console.log(`  called ${pad(m.calledShare, 5)}  call-only ${pad(m.callOnly, 3)}  of ${pad(m.expects, 4)} expects  ${m.file}`);
  console.log("\nchurn × LOC top 10 (commits in 6 months × current lines):");
  for (const c of h.churn) console.log(`  ${pad(c.score, 8)}  ${pad(c.commits, 3)} × ${pad(c.loc, 5)}  ${c.file}`);
  if (delta) {
    console.log(`\ndelta since ${delta.since} (${delta.commits} commits; working tree vs ${delta.since}):`);
    if (delta.dirty) console.log("⚠ head side includes uncommitted changes under src/api/public");
    console.log(`${"metric".padEnd(22)}${pad("base", 8)}${pad("head", 8)}${pad("delta", 8)}${pad("per100", 8)}`);
    for (const r of delta.rows) console.log(`${r.metric.padEnd(22)}${pad(r.base, 8)}${pad(r.head, 8)}${pad(r.delta > 0 ? `+${r.delta}` : r.delta, 8)}${pad(r.per100, 8)}`);
  }
  if (out) console.log(`\nJSON written to ${out}`);
}
