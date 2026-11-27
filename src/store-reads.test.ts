/**
 * Unguarded store reads — the roster. Every `.from(…)` chain in `src/store*.ts` and `api/**` (tests
 * excluded) is classified at test time from the syntax tree (no Program, as `scripts/archive/probe-debt-census.ts`):
 *
 *   write          — the chain carries `.insert/.upsert/.update/.delete(`
 *   single         — the chain carries `.single(`/`.maybeSingle(`
 *   guarded-read   — `paginateRows`/`assertNotTruncated` appears in the chain's own statement or in a
 *                    continuation statement that names the chain's binding (see below), OR the `.from(`
 *                    sits inside the callback passed as `paginateRows`'s first argument. A sentinel
 *                    elsewhere in the enclosing function does NOT count: a second unbounded `.select()`
 *                    after a sentinel-guarded one is its own unguarded read.
 *   unguarded-read — everything else: it MUST be in `ROSTER` below with its one-word reason, or it fails here
 *
 * What it buys: a new `.select()` that can be cut at PostgREST `max_rows` (`POSTGREST_MAX_ROWS`,
 * `src/postgrest-limits.ts`) without a sentinel fails named by file, function and table, instead of waiting
 * for the next starved series (`store-guards.ts`'s `bucketShortfallIds` docblock has the history).
 * The five reads that could genuinely
 * truncate got `assertNotTruncated` in the same slice and are therefore NOT rostered — a read is rostered
 * only when its row count is bounded by construction.
 *
 * A chain split across statements (`let query = …from(); … await query.limit(1)`) is read as ONE chain: the
 * later statements in the same block that name the chain's binding — an identifier (`const x = await …`) or
 * every name of a destructuring pattern (`const { data, error } = await …`) — are appended before
 * classifying, transitively (`const rows = asRows(data); assertNotTruncated(rows.length, …)` follows `data`
 * into `rows`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARD = /\b(paginateRows|assertNotTruncated)\b/;
let ts: typeof TS; // loaded in `beforeAll`: keeps typescript.js out of collect time
const isTest = (f: string): boolean => /\.test\.(ts|js)$|\.test-helpers\.ts$/.test(f) || f === "src/test-helpers.ts";

type Kind = "write" | "single" | "guarded-read" | "unguarded-read";
interface Site {
  file: string;
  line: number;
  /** `<enclosing function name>(<table>)#<ordinal of this unguarded read within that function>` */
  key: string;
  kind: Kind;
}

/**
 * The ruled roster: reads whose row count is bounded by construction, so `max_rows` cannot cut them.
 *   limit-1    — `.limit(1)` newest-row reads (the `.limit(1)` is on the chain, or on its continuation)
 *   limit-0    — `.limit(0)` projection probe: no rows requested, only the column list is validated
 *   head-count — `head: true, count: "exact"`: Content-Range only, no rows shipped
 *   cap-probe  — the max_rows measurement itself: a cut IS the observation (`maxRowsProbe`)
 *   bounded-by-prior-sentinel — the `.in(col, keys)` key list was itself read by a sentinel-guarded select in
 *                the same function, so this read returns at most as many rows as that one did
 */
const ROSTER: Record<string, string> = {
  "src/store.ts getIntradayVerdict(intraday_verdict)#1": "limit-1",
  "src/store.ts lastOriginalAlert(alert_log)#1": "limit-1",
  "src/store.ts getLastAlertBefore(alert_log)#1": "limit-1",
  "src/store.ts getAlertAt(alert_log)#1": "limit-1",
  "src/store.ts getLastPush(alert_log)#1": "limit-1",
  "src/store.ts lastNonNullBand(alert_log)#1": "limit-1",
  "src/store.ts lastNonNullTier(alert_log)#1": "limit-1",
  "src/store.ts getLegPillarLatestGenerator(leg_pillars)#1": "limit-1",
  "src/store.ts checkSchema(<table>)#1": "limit-0",
  "src/store.ts maxRowsProbe(readings)#1": "head-count",
  "src/store.ts maxRowsProbe(readings)#2": "cap-probe",
  "src/store.ts deleteUnpinnedRows(alert_log)#1": "bounded-by-prior-sentinel",
  "src/store.ts deleteProvisionalOnDates(alert_log)#1": "bounded-by-prior-sentinel",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
    if (e.isSymbolicLink() || e.name === "node_modules") continue;
    if (e.isDirectory()) walk(`${dir}${e.name}/`, out);
    else out.push(`${dir}${e.name}`);
  }
  return out;
}


/** The call's whole chain: up through member accesses/calls/awaits/parens to the statement it sits in. */
function chainTop(n: TS.Node): TS.Node {
  let top: TS.Node = n;
  while (
    top.parent &&
    (ts.isPropertyAccessExpression(top.parent) ||
      ts.isCallExpression(top.parent) ||
      ts.isAwaitExpression(top.parent) ||
      ts.isParenthesizedExpression(top.parent))
  )
    top = top.parent;
  return top;
}

/** The identifiers a binding name introduces: `x` → [x]; `{ data, error }` / `[a, b]` → every leaf name. */
function bindingNames(name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  return out;
}

/** Names declared by a statement's `const`/`let` declarations (so a continuation can be followed transitively). */
function declaredNames(s: TS.Statement): string[] {
  if (!ts.isVariableStatement(s)) return [];
  return s.declarationList.declarations.flatMap((d) => bindingNames(d.name));
}

/**
 * Chain text + the continuation statements: same block, later, naming the chain's binding (identifier or any
 * name of a destructuring pattern), followed transitively through the names those statements declare.
 */
function chainText(n: TS.Node, sf: TS.SourceFile): string {
  const top = chainTop(n);
  let text = top.getText(sf);
  const decl = top.parent;
  if (decl && ts.isVariableDeclaration(decl)) {
    const names = new Set(bindingNames(decl.name));
    const stmt = decl.parent.parent; // VariableDeclarationList → VariableStatement
    const block = stmt.parent;
    if (ts.isBlock(block)) {
      const after = block.statements.slice(block.statements.indexOf(stmt as TS.Statement) + 1);
      for (const s of after) {
        const st = s.getText(sf);
        // A later statement that opens its own `.from(` is its own site: never let its `.delete(`/sentinel colour this one.
        if (/\.from\(/.test(st) || ![...names].some((name) => new RegExp(`\\b${name}\\b`).test(st))) continue;
        text += `\n${st}`;
        for (const d of declaredNames(s)) names.add(d);
      }
    }
  }
  return text;
}

function enclosingFunctions(n: TS.Node): TS.SignatureDeclaration[] {
  const out: TS.SignatureDeclaration[] = [];
  for (let p: TS.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) out.push(p);
  return out;
}

function functionName(fns: TS.SignatureDeclaration[]): string {
  for (const f of fns) if (f.name && ts.isIdentifier(f.name)) return f.name.text;
  return "<anonymous>";
}

/** True when `n` sits inside a function expression passed as the FIRST argument of `paginateRows(…)`. */
function inPaginateCallback(fns: TS.SignatureDeclaration[]): boolean {
  return fns.some(
    (f) =>
      (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) &&
      ts.isCallExpression(f.parent) &&
      f.parent.arguments[0] === f &&
      /\bpaginateRows$/.test(f.parent.expression.getText()),
  );
}

/** Classify one `.from(` call; exported for the synthetic check only — the roster is keyed off the result. */
export function classify(chain: string, paginated: boolean): Kind {
  if (paginated || GUARD.test(chain)) return "guarded-read";
  if (/\.(insert|upsert|update|delete)\(/.test(chain)) return "write";
  if (/\.(single|maybeSingle)\(/.test(chain)) return "single";
  return "unguarded-read";
}

/** Every `.from(` site in one source text, with its classification. Pure over the text so a synthetic file runs the same path. */
export function scanSource(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const sites: Site[] = [];
  const ordinal = new Map<string, number>();
  const visit = (n: TS.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "from" &&
      !/^[A-Z]/.test(n.expression.expression.getText(sf)) // `Array.from` is not a query
    ) {
      const fns = enclosingFunctions(n);
      const kind = classify(chainText(n, sf), inPaginateCallback(fns));
      const arg = n.arguments[0];
      const table = arg && ts.isStringLiteral(arg) ? arg.text : "<table>";
      const base = `${file} ${functionName(fns)}(${table})`;
      const k = (ordinal.get(base) ?? 0) + 1;
      ordinal.set(base, k);
      sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, key: `${base}#${k}`, kind });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

let SITES: Site[];
let unguarded: Site[];

describe("store reads: every unguarded `.from(` is rostered (bounded by construction)", () => {
  beforeAll(async () => {
    ts = (await import("typescript")).default;
    const files = [...walk("src/"), ...walk("api/")].filter(
      (f) => f.endsWith(".ts") && !isTest(f) && (/^src\/store[^/]*\.ts$/.test(f) || f.startsWith("api/")),
    );
    SITES = files.flatMap((f) => scanSource(f, readFileSync(`${ROOT}${f}`, "utf8")));
    unguarded = SITES.filter((s) => s.kind === "unguarded-read");
  });

  it("the scan is live — sees writes, guarded reads and the store at all", () => {
    // Anchored on kinds the roster never drains, so the floor cannot certify an empty roster.
    expect(SITES.filter((s) => s.kind === "write").length).toBeGreaterThan(5);
    expect(SITES.filter((s) => s.kind === "guarded-read").length).toBeGreaterThan(5);
    expect(SITES.some((s) => s.key.startsWith("src/store.ts getSeries(readings_latest)"))).toBe(true);
  });

  it("every unguarded read is in the roster", () => {
    const unruled = unguarded.filter((s) => !(s.key in ROSTER)).map((s) => `UNRULED read ${s.file}:${s.line} - ${s.key}`);
    expect(unruled).toEqual([]);
  });

  it("no roster row is stale (the site exists and is still unguarded)", () => {
    const live = new Set(unguarded.map((s) => s.key));
    expect(Object.keys(ROSTER).filter((k) => !live.has(k))).toEqual([]);
  });

  it("the classifier can fail: a synthetic unbounded select is unguarded; its guarded/write/single twins are not", () => {
    const src = `
      class S {
        async bad() { const { data } = await this.client.from("t").select("*").gte("d", x); return data; }
        async split() { let q = this.client.from("t").select("*"); q = q.lt("d", y); const { data } = await q.single(); return data; }
        async ok() { const rows = await paginateRows(async (o, c) => { const { data } = await this.client.from("t").select("*").range(o, c); return data; }, 10); return rows; }
        async w() { await this.client.from("t").insert({}); }
        async arr() { return Array.from(new Set([1])); }
        async destructured() { const { data, error } = await this.client.from("t").select("*"); if (error) throw error; const rows = asRows(data); assertNotTruncated(rows.length, "t"); return rows; }
        async second() { const { data } = await this.client.from("t").select("*"); assertNotTruncated(data.length, "t"); const more = await this.client.from("u").select("*").in("id", data); return more; }
        async notFirst() { const rows = await paginateRows(10, async (o, c) => { const { data } = await this.client.from("t").select("*").range(o, c); return data; }); return rows; }
      }`;
    expect(scanSource("synthetic.ts", src).map((s) => [s.key, s.kind])).toEqual([
      ["synthetic.ts bad(t)#1", "unguarded-read"],
      ["synthetic.ts split(t)#1", "single"],
      ["synthetic.ts ok(t)#1", "guarded-read"],
      ["synthetic.ts w(t)#1", "write"],
      ["synthetic.ts destructured(t)#1", "guarded-read"],
      ["synthetic.ts second(t)#1", "guarded-read"],
      ["synthetic.ts second(u)#1", "unguarded-read"],
      ["synthetic.ts notFirst(t)#1", "unguarded-read"],
    ]);
  });
});
