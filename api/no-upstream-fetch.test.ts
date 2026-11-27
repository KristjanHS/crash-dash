/**
 * Load-tolerance P1 guard: NO live api/
 * handler may reach an upstream feed at request time — every input series is cron-persisted and
 * store-read (src/input-series.ts). Scans every .ts under api/ EXCEPT *.test.ts and the api/cron subtree (the cron
 * IS the sanctioned upstream writer), strips comments, and reds on any feed symbol/module — in the handler
 * file itself AND across its transitive import graph, static + dynamic (a feed reached through a `src/` helper).
 *
 * Graph scope: value-level relative `import`/`export … from` edges (and side-effect imports); `import type` /
 * `export type` carry no runtime edge and are skipped. A string-literal relative dynamic `import("…")` is an
 * edge too (bound names `<dynamic>`), followed like a static one unless `ALLOWED_DYNAMIC_EDGES` stops the walk
 * at it; a non-literal `import(expr)` THROWS — a specifier the walk cannot resolve would hide its subgraph.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const API_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(API_DIR, "..");
const UPSTREAM =
  /fetchSeries|fetchDailyCloses|fetchEbp|fetchIndicatorObservations|fetchCape|src\/fred\.js|src\/prices\.js/;

/** Every .ts under api/, minus *.test.ts and the api/cron subtree. */
function liveHandlerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(API_DIR, full) === "cron") continue; // the cron path MAY fetch upstream
      out.push(...liveHandlerFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Blank block comments (newline-preserving, so reported line numbers stay true) and skip
 *  `//`-opened lines. Trailing mid-line `//` text is NOT stripped — a false positive there
 *  fails loud and gets the comment reworded; masking real code would be the worse failure. */
function codeLines(src: string): { line: string; n: number }[] {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  return blanked
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !line.trimStart().startsWith("//"));
}

const CODE = new Map<string, string>();
const codeOf = (file: string): string => {
  let code = CODE.get(file);
  if (code === undefined) CODE.set(file, (code = codeLines(readFileSync(file, "utf8")).map(({ line }) => line).join("\n")));
  return code;
};
const rel = (file: string): string => relative(REPO, file);

// ── Transitive graph ────────────────────────────────────────────────────────────────────────────

/** A runtime outbound HTTP call site: bare/global `fetch(` (never a `.fetch(` method or `prefetch(`). No
 *  space before `(`: trailing `//` prose ("symbols to fetch (union …)") is not stripped by `codeLines`. */
const FETCH_CALL = /(?<![\w$.])fetch\(|globalThis\.fetch\b/;

/** A module is a FEED (upstream-fetch module) iff its own code calls `fetch` — derived, not enumerated,
 *  so a new feed client is covered the day it lands. */
const isFeed = (file: string): boolean => FETCH_CALL.test(codeOf(file));

// `(import|export) <clause> from "<rel>"` or a side-effect `import "<rel>"`; `type`-only statements skipped.
const IMPORT_RE = /^[ \t]*(?:import|export)\s+(?!type\b)(?:([^;'"]*?)\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gm;
/** Every dynamic `import(` call (never `.import(` / `reimport(`); each must be a string literal `DYNAMIC_LITERAL_RE` reads. */
const DYNAMIC_CALL_RE = /(?<![\w$.])import\s*\(/g;
const DYNAMIC_LITERAL_RE = /(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** The string-literal specifiers of `file`'s dynamic `import()` calls; a non-literal one THROWS. */
function dynamicSpecifiers(file: string): string[] {
  const code = codeOf(file);
  const specs = [...code.matchAll(DYNAMIC_LITERAL_RE)].map((m) => m[1]!);
  const calls = [...code.matchAll(DYNAMIC_CALL_RE)].length;
  if (calls !== specs.length) throw new Error(`${rel(file)}: ${calls - specs.length} non-literal dynamic import(s) — the walk cannot follow them`);
  return specs;
}

/** The VALUE bindings a statement takes: named (minus inline `type`), `default`, or `*` (namespace/star). */
function boundNames(clause: string | undefined): string[] {
  if (clause === undefined) return ["<side-effect>"];
  const names: string[] = [];
  const braces = clause.match(/\{([^}]*)\}/);
  for (const part of (braces?.[1] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!part.startsWith("type ")) names.push(part.split(/\s+as\s+/)[0]!.trim());
  }
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
  if (/\*/.test(outside)) names.push("*");
  else if (outside) names.push("default");
  return names;
}

interface Edge { from: string; to: string; names: string[] }

/** The relative static- and dynamic-import edges out of `file`; an unresolvable specifier THROWS (a silently
 *  dropped edge would hide the subgraph behind it). */
function edgesOf(file: string): Edge[] {
  const out: Edge[] = [];
  const push = (spec: string, names: string[]): void => {
    const abs = resolve(dirname(file), spec);
    const target = [abs.replace(/\.js$/, ".ts"), abs].find((p) => existsSync(p));
    if (!target) throw new Error(`${rel(file)}: unresolvable import "${spec}"`);
    out.push({ from: file, to: target, names });
  };
  for (const m of codeOf(file).matchAll(IMPORT_RE)) push(m[2]!, boundNames(m[1]));
  for (const spec of dynamicSpecifiers(file)) if (/^\.{1,2}\//.test(spec)) push(spec, ["<dynamic>"]);
  return out;
}

/** Dynamic-import edges the walk STOPS at (neither feed-checked nor descended) — each a request-time load whose
 *  subgraph is sanctioned as a whole. A new dynamic import anywhere else is walked like a static one. */
const ALLOWED_DYNAMIC_EDGES: readonly { from: string; to: string; reason: string }[] = [
  {
    from: "api/lab.ts",
    to: "src/run-core.ts",
    reason: "the `?walk=` path binds only `walkForward`, a synchronous pure forward walk over store-read inputs — `run-core.ts`'s reach into `tracks.ts` → `fred.ts` is never called",
  },
];

/** Edges INTO a feed module a live handler may take — each row a value-free use, bound names pinned
 *  (a later import of the module's fetcher through the same edge reds). */
const ALLOWED_FEED_EDGES: readonly { from: string; to: string; names: readonly string[]; reason: string }[] = [
  {
    from: "src/store.ts",
    to: "src/db-fetch.ts",
    names: ["dbFetch"],
    reason: "the Supabase client's transport — the store read IS the sanctioned request-time path",
  },
];

/** Walk `entry`'s graph; return every non-allowlisted edge into a feed (with its path) + the rows used. */
function feedEdges(entry: string): { hits: string[]; usedRows: Set<number>; usedDynamic: Set<number>; reached: Set<string> } {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const hits: string[] = [];
  const usedRows = new Set<number>();
  const usedDynamic = new Set<number>();
  const chain = (f: string): string => {
    const path: string[] = [];
    for (let at: string | null | undefined = f; at; at = parent.get(at)) path.unshift(rel(at));
    return path.join(" → ");
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const e of edgesOf(file)) {
      const stop = e.names.includes("<dynamic>") ? ALLOWED_DYNAMIC_EDGES.findIndex((r) => r.from === rel(e.from) && r.to === rel(e.to)) : -1;
      if (stop >= 0) {
        usedDynamic.add(stop);
        continue;
      }
      if (isFeed(e.to)) {
        const row = ALLOWED_FEED_EDGES.findIndex((r) => r.from === rel(e.from) && r.to === rel(e.to));
        const ok = row >= 0 && e.names.every((n) => ALLOWED_FEED_EDGES[row]!.names.includes(n));
        if (ok) usedRows.add(row);
        else hits.push(`${chain(e.from)} → ${rel(e.to)} {${e.names.join(", ")}}`);
      }
      if (!parent.has(e.to)) {
        parent.set(e.to, file);
        queue.push(e.to);
      }
    }
  }
  return { hits, usedRows, usedDynamic, reached: new Set([...parent.keys()].map(rel)) };
}

describe("api/ read handlers never import or call an upstream feed", () => {
  test("zero upstream feed references outside comments", () => {
    const files = liveHandlerFiles(API_DIR);
    expect(files.length).toBeGreaterThan(0); // vacuity: an empty scan must not pass
    const hits: string[] = [];
    for (const file of files) {
      for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
        if (UPSTREAM.test(line)) hits.push(`${relative(API_DIR, file)}:${n}: ${line.trim()}`);
      }
    }
    expect(hits, `upstream feed reference(s) in live api/ handlers:\n${hits.join("\n")}`).toEqual([]);
  });

  test("no handler's transitive import graph (static + dynamic) reaches a feed module (bar the allowlisted edges)", () => {
    // Vacuity anchors on things a fix never drains: the classifier still recognizes the canonical feed,
    // and the walker still crosses from a handler into `src/` (a broken IMPORT_RE collapses this).
    // `src/feed-http.ts` is the one client; a feed module (fred) is caught one hop on, at its edge into it.
    expect(isFeed(join(REPO, "src/feed-http.ts"))).toBe(true);
    expect(feedEdges(join(REPO, "src/fred.ts")).hits.some((h) => h.startsWith("src/fred.ts → src/feed-http.ts {"))).toBe(true);
    expect(isFeed(join(REPO, "src/families.ts"))).toBe(false);
    expect(feedEdges(join(API_DIR, "lab.ts")).reached.has("src/families.ts")).toBe(true);
    // The dynamic-import extractor still reads lab's `?walk=` load (a broken DYNAMIC_LITERAL_RE drains this).
    expect(dynamicSpecifiers(join(API_DIR, "lab.ts"))).toEqual(["../src/run-core.js", "../src/run-core.js"]);

    const hits: string[] = [];
    const used = new Set<number>();
    const usedDynamic = new Set<number>();
    for (const file of liveHandlerFiles(API_DIR)) {
      const r = feedEdges(file);
      hits.push(...r.hits);
      for (const i of r.usedRows) used.add(i);
      for (const i of r.usedDynamic) usedDynamic.add(i);
    }
    expect(hits, `feed module(s) in a live handler's import graph:\n${hits.join("\n")}`).toEqual([]);
    // A row no handler graph takes any more is stale — delete it rather than let it pre-authorize a future edge.
    const stale = ALLOWED_FEED_EDGES.filter((_, i) => !used.has(i)).map((r) => `${r.from} → ${r.to}`);
    expect(stale, "stale ALLOWED_FEED_EDGES row(s)").toEqual([]);
    const staleDynamic = ALLOWED_DYNAMIC_EDGES.filter((_, i) => !usedDynamic.has(i)).map((r) => `${r.from} → ${r.to}`);
    expect(staleDynamic, "stale ALLOWED_DYNAMIC_EDGES row(s)").toEqual([]);
  });
});
