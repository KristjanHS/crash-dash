/**
 * Static first-party ESM import graph — the instrument behind `arch-rules.test.ts`. Walks the STATIC
 * eval graph only: `import type`/`export type` are erased by esbuild (no runtime module), and a module
 * reached only through `await import()` is not an edge.
 */
import { readFileSync, globSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

/** Every deployed Vercel function under `api/`, repo-relative, sorted. */
export const deployedHandlers = (): string[] =>
  globSync("api/**/*.ts")
    .filter((f) => !f.endsWith(".test.ts"))
    .sort();

/** Resolve a relative `./x.js` specifier to its repo-relative `.ts` source; bare specifiers → null. */
export function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node builtin / node_modules → external
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base.replace(/\.js$/, ".ts"), `${base}.ts`, base]) {
    try {
      readFileSync(cand);
      return relative(process.cwd(), cand);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// `import|export … from "spec"` and bare `import "spec"`; group 1 marks the type-only form.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

// Per-file edges, parsed once per process and shared by every `reachable()` walk.
const edges = new Map<string, string[]>();

/** Direct runtime imports of one file (repo-relative). */
export function directImports(file: string): string[] {
  let out = edges.get(file);
  if (!out) edges.set(file, (out = parseImports(file)));
  return out;
}

function parseImports(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[1]) continue; // `import type` / `export type` → erased
    const r = resolveSpec(file, m[2] ?? m[3]!);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Every first-party module reachable from `entry` (entry included), mapped to the module that first
 * imported it — so a violation can print its path back to the entry.
 */
export function reachable(entry: string): Map<string, string | null> {
  const start = relative(process.cwd(), resolve(entry));
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const r of directImports(f)) {
      if (parent.has(r)) continue;
      parent.set(r, f);
      queue.push(r);
    }
  }
  return parent;
}

/** `entry → … → target` along the BFS tree `reachable()` built. */
export function importPath(graph: Map<string, string | null>, target: string): string[] {
  const path: string[] = [];
  for (let n: string | null | undefined = target; n; n = graph.get(n)) path.unshift(n);
  return path;
}
