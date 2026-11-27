// Names the uncovered lines + functions behind a red per-file coverage threshold, so a failed
// `make ship` points at the gap instead of costing a re-run just to find it. ship.sh pipes the
// run's `ERROR: Coverage for … does not meet "<file>" threshold` lines in on stdin and passes
// the istanbul `coverage-final.json` that `$COV`'s json reporter wrote alongside the summary.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Pos { line: number }
export interface FileCoverage {
  path: string;
  statementMap: Record<string, { start: Pos }>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; loc: { start: Pos } }>;
  f: Record<string, number>;
  branchMap?: Record<string, { loc: { start: Pos }; locations: ({ start: Pos } | undefined)[] }>;
  b?: Record<string, number[]>;
}

/** Threshold keys named by vitest's errors (`does not meet` and the negative-threshold `exceed`), deduped, first-seen order. */
export function failingFiles(log: string): string[] {
  const files = [...log.matchAll(/(?:does not meet|exceed) "([^"]+)" threshold/g)].map((m) => m[1]!);
  return [...new Set(files)];
}

/** Lines whose best statement count is 0 — istanbul's own getLineCoverage rule. */
export function uncoveredLines(fc: FileCoverage): number[] {
  const best = new Map<number, number>();
  for (const [id, { start }] of Object.entries(fc.statementMap)) {
    best.set(start.line, Math.max(best.get(start.line) ?? 0, fc.s[id] ?? 0));
  }
  return [...best].filter(([, n]) => n === 0).map(([line]) => line).sort((a, b) => a - b);
}

/** Lines holding an untaken branch arm — an `if` with no `else`, `??`, `||` leave no zero-count statement. */
export function uncoveredBranchLines(fc: FileCoverage): number[] {
  const lines = new Set<number>();
  for (const [id, counts] of Object.entries(fc.b ?? {})) {
    const br = fc.branchMap?.[id];
    counts.forEach((n, i) => { if (n === 0 && br) lines.add(br.locations[i]?.start.line ?? br.loc.start.line); });
  }
  return [...lines].sort((a, b) => a - b);
}

/** Named unrun functions, plus a count of anonymous ones (closures carry no fix-pointing name). */
export function uncoveredFunctions(fc: FileCoverage): string[] {
  const unrun = Object.entries(fc.fnMap).filter(([id]) => (fc.f[id] ?? 0) === 0).map(([, fn]) => fn);
  const named = unrun.filter((fn) => !fn.name.startsWith("(anonymous"));
  const anon = unrun.length - named.length;
  return [...named.map((fn) => `${fn.name}@${fn.loc.start.line}`), ...(anon ? [`+${anon} anonymous`] : [])];
}

/** [3,4,5,9] → "3-5,9"; past `cap` ranges the tail collapses to a count, so a broad red stays one line. */
export function ranges(lines: number[], cap = 25): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const from = lines[i]!;
    while (lines[i + 1] === lines[i]! + 1) i++;
    out.push(from === lines[i] ? `${from}` : `${from}-${lines[i]}`);
  }
  return out.length > cap ? `${out.slice(0, cap).join(",")} … +${out.length - cap} more ranges` : out.join(",");
}

/** Coverage keys a threshold key names — vitest threshold keys are globs (`src/run-cycle*.ts`). */
export function matchFiles(key: string, files: string[], root: string): string[] {
  const re = new RegExp(`^${resolve(root, key).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
  return files.filter((f) => re.test(f)).sort();
}

/** One report line per file a failing key names; a key matching nothing says so rather than vanishing. */
export function report(log: string, coverage: Record<string, FileCoverage>, root: string): string[] {
  return failingFiles(log).flatMap((key) => {
    const hits = matchFiles(key, Object.keys(coverage), root);
    if (!hits.length) return [`[coverage] ${key}: not in coverage-final.json — no line detail`];
    return hits.map((path) => {
      const fc = coverage[path]!;
      const fns = uncoveredFunctions(fc);
      const brs = ranges(uncoveredBranchLines(fc));
      return `[coverage] ${relative(root, path)} uncovered lines: ${ranges(uncoveredLines(fc)) || "none"}${brs ? ` · branches: ${brs}` : ""}${fns.length ? ` · functions: ${fns.join(", ")}` : ""}`;
    });
  });
}

/** Silent when no threshold went red — a failed TEST deletes the reports dir (`reportOnFailure: false`). */
export function main(log: string, json: string, root: string): string[] {
  if (!failingFiles(log).length) return [];
  if (!existsSync(json)) return [`[coverage] ${json} not written — no line detail`];
  // realpath: coverage keys are physical paths, a symlinked TMPDIR would otherwise match nothing.
  return report(log, JSON.parse(readFileSync(json, "utf8")), realpathSync(root));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [json, root = process.cwd()] = process.argv.slice(2);
  if (!json) throw new Error("usage: coverage-gaps.ts <coverage-final.json> [root] < vitest-output");
  for (const line of main(readFileSync(0, "utf8"), json, root)) console.error(line);
}
