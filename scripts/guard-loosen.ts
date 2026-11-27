/** commit-msg gate (G1): a staged change that loosens a guard vs HEAD needs a
 *  `Guard-loosened: <path> — <why>` trailer. Usage: `node --import tsx scripts/guard-loosen.ts <msg-file> <repo>`. */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import ts from "typescript";

const git = (repo: string, ...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const show = (repo: string, rev: string): string | null => {
  const r = git(repo, "show", rev);
  return r.status === 0 ? r.stdout : null;
};
/** One `Guard-loosened: <path> — <why>` line; the commit-msg gate and the probe's audit both read it. */
const TRAILER = /^Guard-loosened:[ \t]*(\S+)[ \t]+(?:—|--?)[ \t]+(\S.*)$/gm;

const BASELINES = /^(scripts\/knip-prod-baseline|eslint-suppressions|scripts\/size-ceilings)\.json$/;
const ROSTERS = /(^|\/)[^/]*(roster|stand-ins)[^/]*\.test\.ts$/;
const GATES = /^(\.claude\/hooks\/|\.claude\/settings[^/]*\.json$|scripts\/git-hooks\/|knip\.json$|scripts\/((size-ratchet|unused-exports)\.test|guard-loosen)\.ts$)/;

const shape = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const hasNumber = (v: unknown): boolean => typeof v === "number" || (!!v && typeof v === "object" && Object.values(v).some(hasNumber));

/** A number rose, appeared, or stopped being a number (a dropped key too, unless `dropOk(path)`: absence is the
 *  tighter default there); an array gained an element; string/boolean leaves are text. */
function jsonLoosens(before: unknown, after: unknown, dropOk: (path: string[]) => boolean, path: string[] = []): boolean {
  if (after === undefined) return !dropOk(path) && hasNumber(before);
  if (typeof after === "number") return typeof before !== "number" || after > before;
  if (shape(before) !== shape(after) && hasNumber(before)) return true;
  if (Array.isArray(after)) {
    if (!Array.isArray(before)) return true;
    const had = new Set(before.map((x) => JSON.stringify(x)));
    return after.some((x) => !had.has(JSON.stringify(x)));
  }
  if (after && typeof after === "object") {
    const [b, a] = [shape(before) === "object" ? (before as Record<string, unknown>) : {}, after as Record<string, unknown>];
    return [...new Set([...Object.keys(b), ...Object.keys(a)])].some((k) => jsonLoosens(b[k], a[k], dropOk, [...path, k]));
  }
  return false;
}
/** A dropped suppression is a tightening; a dropped per-file ceiling falls back to `LIMIT`. */
const DROP_OK: Record<string, (path: string[]) => boolean> = {
  "eslint-suppressions.json": () => true,
  "scripts/size-ceilings.json": (p) => p.length === 2 && p[0] === "ceilings",
};

/** End index (exclusive) of the string literal opening at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j + 1;
  }
  return src.length;
}
const STR = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;

/** Roster rows `{ file, …, count?, reason|verdict }` → (file, reason) → summed count, plus the text with the rows cut out. */
function rows(src: string): { keys: Map<string, number>; rest: string } {
  const keys = new Map<string, number>();
  let rest = "";
  let from = 0;
  for (const m of src.matchAll(/\{\s*file:\s*/g)) {
    if (m.index < from) continue;
    let end = m.index + 1;
    for (let depth = 0; end < src.length; ) {
      const c = src[end];
      if (c === '"' || c === "'" || c === "`") end = skipString(src, end);
      else if (c === "{") { depth++; end++; }
      else if (c === "}" && depth-- === 0) { end++; break; }
      else end++;
    }
    const body = src.slice(m.index, end);
    const file = STR.exec(src.slice(m.index + m[0].length))?.[1];
    const why = /\b(?:reason|verdict):\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(body)?.[1];
    if (!file || !why) continue;
    const key = `${file}\0${why}`;
    keys.set(key, (keys.get(key) ?? 0) + Number(/\bcount:\s*(\d+)/.exec(body)?.[1] ?? 1));
    rest += src.slice(from, m.index);
    from = end;
  }
  return { keys, rest: rest + src.slice(from) };
}
/** `src` minus what the criteria table rules silent: comments, imports, the trailing number of an `it(`/`test(` call and
 *  `timeout:` numbers (→ `T`). Comments are read off the parsed tokens' trivia, so `//` in a string or regex stays. */
function code(src: string): string {
  const sf = ts.createSourceFile("roster.ts", src, ts.ScriptTarget.Latest, true);
  const timeouts = new Set<ts.Node>();
  let out = "";
  const visit = (n: ts.Node): void => {
    if (n.pos === n.end || ts.isImportDeclaration(n) || (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)) return;
    if (ts.isCallExpression(n) && n.arguments.length > 2 && /^(it|test)$/.test(calleeRoot(n.expression))) timeouts.add(n.arguments[n.arguments.length - 1]!);
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "timeout") timeouts.add(n.initializer);
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(visit);
    const trivia = src.slice(n.pos, n.getStart(sf)).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    out += trivia + (ts.isNumericLiteral(n) && timeouts.has(n) ? "T" : src.slice(n.getStart(sf), n.end));
  };
  visit(sf);
  return out;
}
const calleeRoot = (e: ts.Expression): string =>
  ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) ? calleeRoot(e.expression) : ts.isIdentifier(e) ? e.text : "";
/** Row-free text with whitespace runs and the commas a cut row leaves behind dropped. */
const normalize = (rest: string) =>
  rest
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, ""))
    .filter(Boolean)
    .join("\n");

/** Why `path` loosens its guard going from `before` to `after` (null = absent), or undefined. */
export function loosening(path: string, before: string | null, after: string | null): string | undefined {
  if (GATES.test(path)) return before === after ? undefined : "edits a gate";
  const kind = BASELINES.test(path) ? "baseline" : ROSTERS.test(path) ? "roster" : undefined;
  if (!kind || before === null) return undefined;
  if (after === null) return `deletes the ${kind}`;
  if (kind === "baseline") {
    try {
      return jsonLoosens(JSON.parse(before), JSON.parse(after), DROP_OK[path] ?? (() => false)) ? "an entry was added or a number rose" : undefined;
    } catch {
      return "no longer parses as JSON";
    }
  }
  const [b, a] = [rows(code(before)), rows(code(after))];
  if (!b.keys.size && !a.keys.size) return before === after ? undefined : "edits a roster with no rows to score";
  if ([...a.keys].some(([k, n]) => n > (b.keys.get(k) ?? 0))) return "a row was added or its reason changed";
  return normalize(b.rest) === normalize(a.rest) ? undefined : "edits the roster's checks outside its rows";
}

export type TrailerRow = { sha: string; date: string; path: string; why: string; verdict: "OK" | "UNTOUCHED" | "NOT-LOOSENED" };

/** Every trailer committed since `since`, re-scored against its commit's first parent. */
export function trailerAudit(repo: string, since: string): TrailerRow[] {
  // A bare date reads as that date at the current time of day; pin it to midnight so the whole since-day counts.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since} 00:00` : since;
  const log = git(repo, "log", "-E", "--grep=^Guard-loosened:", `--since=${from}`, "--format=%H%x00%cI%x00%B%x01");
  return log.stdout.split("\x01").flatMap((rec) => {
    const [sha = "", date = "", body = ""] = rec.trim().split("\0");
    if (!body) return [];
    const touched = new Set(git(repo, "show", "--format=", "--name-only", "--no-renames", "--diff-merges=first-parent", sha).stdout.split("\n"));
    return [...body.matchAll(TRAILER)].map(([, path = "", why = ""]): TrailerRow => ({
      sha: sha.slice(0, 9),
      date,
      path,
      why,
      verdict: !touched.has(path) ? "UNTOUCHED" : loosening(path, show(repo, `${sha}^:${path}`), show(repo, `${sha}:${path}`)) ? "OK" : "NOT-LOOSENED",
    }));
  });
}

function gate(msgFile: string, repo: string): void {
  if (git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0) return;
  const names = git(repo, "diff", "--cached", "--name-only", "--no-renames").stdout.split("\n").filter(Boolean);
  const trailered = new Set([...readFileSync(msgFile, "utf8").matchAll(TRAILER)].map((m) => m[1]));
  const missing = names.flatMap((p) => {
    const why = loosening(p, show(repo, `HEAD:${p}`), show(repo, `:${p}`));
    return why && !trailered.has(p) ? [`  ${p} — ${why}`] : [];
  });
  if (missing.length) {
    console.error(`commit-msg: this commit loosens a guard vs HEAD without a trailer:\n${missing.join("\n")}\n`
      + "add one trailer line per path (the commit then asks for approval):  Guard-loosened: <path> — <why>");
    process.exit(1);
  }
}

// realpath: the commit-msg test runs this file through a symlink, and Node resolves the main module's links.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const [msgFile = "", repo = "."] = process.argv.slice(2);
  gate(msgFile, repo);
}
