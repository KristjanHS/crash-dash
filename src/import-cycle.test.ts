/**
 * Permanent transitive import-cycle guard (stage5c spec §4 slice 5c.1, falsifier F8).
 *
 * The 2026-07-20 TDZ incident was a *transitive* value cycle — no single file
 * imported itself, so a direct-import grep saw nothing. Its blast radius is NOT a
 * citable number: re-measurements of the same edge (CORE-9 Stages A and E,
 * 2026-08-01) returned different collect-failure counts, because the symptom is
 * runtime- and entry-order-dependent (vitest: an undefined binding, `TypeError` on
 * first deref; native ESM: a TDZ `ReferenceError`; a families-first entry graph: no
 * error at all). Cite the CLASS, never a count. This test
 * builds the whole relative-import graph over `src/` + `api/` and fails on ANY
 * cycle in the VALUE-edge graph.
 *
 * Deliberate design points:
 * - **No new dependencies.** `node:fs` walk + a comment-stripping scan for the
 *   specifier forms this repo uses (`from "…"`, `import type … from "…"`,
 *   bare `import "…"`, dynamic `import("…")`, and `export … from "…"` — a
 *   re-export's edge is a real runtime edge and must be followed).
 * - **Relative specifiers only**, resolved through the `.js`-specifier
 *   convention back to the `.ts` file on disk (`dev-workflow.md` §Import
 *   convention). Bare package specifiers and non-`.ts` targets are ignored.
 * - **`import type` / `export type` edges are RECORDED but never fail.** A
 *   type-only edge is erased at runtime and cannot TDZ; it is reported in the
 *   failure message only. `import { type X } from "…"` is a VALUE edge — the
 *   statement still emits — and is treated as one.
 * - Failure prints each cycle as `a → b → c → a`, not a bare boolean.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", "api"] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "dist", "coverage"]);

/** Every `.ts` file under the scan roots, repo-relative with `/` separators. */
function collectFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir))) {
      if (SKIP_DIRS.has(entry)) continue;
      const rel = `${dir}/${entry}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(rel);
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return out.sort();
}

/**
 * Blank out comments and string/template bodies' comment-lookalikes.
 * Quote-aware so a `"https://…"` URL is not mistaken for a line comment, and so
 * a commented-out import never contributes an edge (comment lines are excluded
 * from the graph by construction).
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n"; // keep line structure for ^-anchored regexes
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface RawEdge {
  readonly spec: string;
  readonly typeOnly: boolean;
}

/** `import`/`export … from "…"`, with the `type` modifier captured (statement-level only). */
const FROM_RE = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[^;]*?from[ \t]*["']([^"']+)["']/gm;
/** Bare side-effect import: `import "./x.js";` */
const BARE_RE = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;
/** Dynamic import — always a value edge. */
const DYNAMIC_RE = /\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g;

function parseEdges(source: string): RawEdge[] {
  const src = stripComments(source);
  const edges: RawEdge[] = [];
  for (const m of src.matchAll(FROM_RE)) {
    edges.push({ spec: m[2] ?? "", typeOnly: m[1] !== undefined });
  }
  for (const m of src.matchAll(BARE_RE)) edges.push({ spec: m[1] ?? "", typeOnly: false });
  for (const m of src.matchAll(DYNAMIC_RE)) edges.push({ spec: m[1] ?? "", typeOnly: false });
  return edges;
}

/**
 * Resolve a RELATIVE specifier to a repo-relative `.ts` path, honouring the
 * `.js`-specifier convention. Returns undefined for package specifiers and for
 * anything that does not land on a `.ts`/`.tsx` file on disk (`.json`, `.mjs`,
 * a real `public/*.js`).
 */
function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.jsx$/, ".tsx"),
    base,
    `${base}.ts`,
    `${base}/index.ts`,
  ];
  for (const cand of candidates) {
    if (!cand.endsWith(".ts") && !cand.endsWith(".tsx")) continue;
    try {
      if (statSync(path.join(ROOT, cand)).isFile()) return cand;
    } catch {
      /* not on disk — try the next shape */
    }
  }
  return undefined;
}

/** Accepted import EDGES, each `[from, to]`, DELETED from the graph before the search (edge-scoped, never a
 *  post-hoc cycle filter: `findCycles` records one cycle per back edge). A row matching no real edge reds. */
const ALLOWED_EDGES: ReadonlyArray<readonly [from: string, to: string]> = [];

type Graph = ReadonlyMap<string, readonly string[]>;

interface Graphs {
  /** Value-edge graph with the ALLOWED_EDGES rows removed — the failing set. */
  readonly value: Graph;
  /** Value + type edges, same rows removed — reported, never failing. */
  readonly all: Graph;
  readonly edgeCount: number;
  /** ALLOWED_EDGES rows that were NOT present in the raw value graph (stale). */
  readonly lagAllowed: readonly string[];
}

function buildGraphs(files: readonly string[]): Graphs {
  const value = new Map<string, string[]>();
  const all = new Map<string, string[]>();
  let edgeCount = 0;
  for (const file of files) {
    value.set(file, []);
    all.set(file, []);
  }
  for (const file of files) {
    for (const edge of parseEdges(readFileSync(path.join(ROOT, file), "utf8"))) {
      const target = resolveSpec(file, edge.spec);
      if (target === undefined || target === file) continue;
      edgeCount++;
      all.get(file)?.push(target);
      if (!edge.typeOnly) value.get(file)?.push(target);
    }
  }
  const lagAllowed: string[] = [];
  for (const [from, to] of ALLOWED_EDGES) {
    if (!(value.get(from) ?? []).includes(to)) lagAllowed.push(`${from} → ${to}`);
    value.set(from, (value.get(from) ?? []).filter((t) => t !== to));
    all.set(from, (all.get(from) ?? []).filter((t) => t !== to));
  }
  return { value, all, edgeCount, lagAllowed };
}

/**
 * Cycle DETECTOR — a colour-marking DFS that records one cycle per back edge.
 * NOT an all-simple-cycles enumerator: a node is never revisited once BLACK, so
 * two distinct cycles sharing a back edge yield only the first one found. That
 * is sufficient for a boolean "is the graph acyclic" guard (any cycle at all
 * produces at least one back edge) but it is why exemptions here must remove
 * EDGES from the graph rather than filter cycles out of this function's result.
 * Each hit is rendered `a → b → … → a`, deduped by node set.
 */
export function findCycles(graph: Graph): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join("|");
        if (!found.has(key)) found.set(key, [...cycle, next]);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of [...graph.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return [...found.values()].map((cycle) => cycle.join(" → ")).sort();
}

describe("import-cycle guard - the relative-import graph over src/ + api/ is acyclic", () => {
  const files = collectFiles();
  const { value, all, edgeCount, lagAllowed } = buildGraphs(files);

  it("scans a non-empty graph (a guard over zero files can never fail)", () => {
    // Floors, not exact counts: they trip if the walk or the specifier scan
    // silently stops matching, without churning on every added module.
    expect(files.length).toBeGreaterThan(100);
    expect(edgeCount).toBeGreaterThan(200);
  });

  it("pins WHY the exemption is edge-scoped: one cycle per back edge, not all cycles", () => {
    // The reviewer's counterexample. Two cycles share the `growth → danger-engine`
    // back edge; the detector emits only the exempted one, so a cycle-set filter
    // would have discarded the genuine finding routed through `newfile`.
    const shared = new Map<string, string[]>([
      ["src/danger-engine.ts", ["src/growth.ts", "src/newfile.ts"]],
      ["src/growth.ts", ["src/danger-engine.ts"]],
      ["src/newfile.ts", ["src/growth.ts"]],
    ]);
    expect(findCycles(shared)).toEqual([
      "src/danger-engine.ts → src/growth.ts → src/danger-engine.ts",
    ]);
    // Deleting the allowed EDGE (`danger-engine → growth`) instead surfaces it.
    const pruned = new Map<string, string[]>([...shared].map(([k, v]) => [k, [...v]]));
    pruned.set("src/danger-engine.ts", ["src/newfile.ts"]);
    expect(findCycles(pruned)).toEqual([
      "src/danger-engine.ts → src/newfile.ts → src/growth.ts → src/danger-engine.ts",
    ]);
  });

  it("has ZERO cycles among value edges (after the ALLOWED_EDGES rows are deleted)", () => {
    const valueCycles = findCycles(value);
    const typeCycles = findCycles(all).filter((c) => !valueCycles.includes(c));
    const message = [
      `value-edge import cycles (${valueCycles.length}):`,
      ...valueCycles.map((c) => `  ${c}`),
      typeCycles.length > 0
        ? `type-only cycles (reported, NOT failing):\n${typeCycles.map((c) => `  ${c}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    expect(valueCycles, message).toEqual([]);
  });

  it("consumes every ALLOWED_EDGES row (a row matching no real edge is stale - delete it)", () => {
    expect(lagAllowed, `stale ALLOWED_EDGES rows: ${lagAllowed.join(", ")}`).toEqual([]);
  });
});
