// Pure range builders for `npm run mutate:changed` / `mutate:confirm` → Stryker `--mutate file:a-b` entries.
import ts from "typescript";

/** 1-based inclusive line span. */
export type Span = [number, number];

/** The pure core: `src/{domain,scorers,danger}-*.ts` + `src/alert-band.ts`, never a test or test-helpers file. */
export function isCoreFile(path: string): boolean {
  return /^src\/(?:(?:domain|scorers|danger)-[^/]+|alert-band)\.ts$/.test(path) && !/\.test(?:-helpers)?\.ts$/.test(path);
}

/** `git diff -U0` → added/changed line spans per core file; pure deletions (`+a,0`) mutate nothing. */
export function changedSpans(diff: string): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  let file: string | null = null;
  let inHeader = false; // `+++` is a path only between `diff --git` and the file's first `@@`
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    inHeader = false;
    if (file === null || !isCoreFile(file)) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) out.set(file, [...(out.get(file) ?? []), [start, start + count - 1]]);
  }
  return out;
}

/** Sort + merge overlapping or adjacent spans. */
export function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Stryker mutates a node only when it lies wholly in range: widen each span over every multi-line decision node it touches. */
export function widenToDecisionNodes(source: string, spans: Span[]): Span[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const nodes: Span[] = [];
  const visit = (n: ts.Node): void => {
    let target: ts.Node | undefined;
    if (ts.isBinaryExpression(n) || ts.isConditionalExpression(n) || ts.isPrefixUnaryExpression(n)) target = n;
    else if (ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) target = n.expression;
    else if (ts.isForStatement(n)) target = n.condition;
    if (target) {
      const a = line(target.getStart(sf));
      const b = line(target.getEnd());
      if (b > a) nodes.push([a, b]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = spans.map(([a, b]): Span => [a, b]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of out) {
      for (const [a, b] of nodes) {
        if (a <= s[1] && b >= s[0] && (a < s[0] || b > s[1])) {
          s[0] = Math.min(s[0], a);
          s[1] = Math.max(s[1], b);
          grew = true;
        }
      }
    }
  }
  return mergeSpans(out);
}

export function toRanges(file: string, spans: Span[]): string[] {
  return spans.map(([a, b]) => `${file}:${a}-${b}`);
}

export interface ReportMutant {
  status: string;
  mutatorName?: string;
  replacement?: string;
  location: { start: { line: number; column?: number }; end: { line: number; column?: number } };
}

/** One excused equivalent mutant (`scripts/mutate-equivalents.json`): `src` = its start line's trimmed text, `orig` = the exact mutated source text. */
export interface EquivalentRow {
  file: string;
  mutator: string;
  replacement: string;
  src: string;
  orig: string;
  reason: string;
}

const isUndetected = (m: ReportMutant) => m.status === "Survived" || m.status === "NoCoverage";

/** The source text a mutant replaces (Stryker columns: 1-based, end exclusive). */
export function mutatedText(lines: string[], { start, end }: ReportMutant["location"]): string {
  const span = lines.slice(start.line - 1, end.line);
  span[span.length - 1] = span.at(-1)?.slice(0, (end.column ?? 1) - 1) ?? "";
  span[0] = span[0]?.slice((start.column ?? 1) - 1) ?? "";
  return span.join("\n");
}

function listedBy(row: EquivalentRow, m: ReportMutant, lines: string[]): boolean {
  return (
    row.mutator === m.mutatorName &&
    row.replacement === m.replacement &&
    row.src === lines[m.location.start.line - 1]?.trim() &&
    row.orig === mutatedText(lines, m.location)
  );
}

/** `file`'s undetected mutants no row excuses (`open`), and rows matching no undetected mutant on a line this report mutated (`stale`). */
export function triageUndetected(report: MutationReport, file: string, rows: EquivalentRow[]) {
  const entry = report.files[file];
  if (!entry) throw new Error(`${file} is not in the mutation report`);
  const lines = (entry.source ?? "").split("\n");
  const undetected = entry.mutants.filter(isUndetected);
  const mutatedSrc = new Set(entry.mutants.map((m) => lines[m.location.start.line - 1]?.trim()));
  const own = rows.filter((r) => r.file === file);
  return {
    open: undetected.filter((m) => !own.some((r) => listedBy(r, m, lines))),
    stale: own.filter((r) => mutatedSrc.has(r.src) && !undetected.some((m) => listedBy(r, m, lines))),
  };
}

/** Rows whose `src` no longer appears as a trimmed line of their file, or that carry no reason. */
export function brokenRows(rows: EquivalentRow[], readSource: (file: string) => string | null): EquivalentRow[] {
  return rows.filter((r) => {
    const source = readSource(r.file);
    return !r.reason.trim() || source === null || !source.split("\n").some((l) => l.trim() === r.src);
  });
}
export interface MutationReport {
  files: Record<string, { source?: string; mutants: ReportMutant[] }>;
}

/** First report holding `file` (core run before changed-lines run); throws when none does or its source differs from `current`. */
export function pickReport(reports: { path: string; report: MutationReport }[], file: string, current: string) {
  const hit = reports.find((r) => r.report.files[file]);
  if (!hit) throw new Error(`${file} is not in ${reports.map((r) => r.path).join(" / ")} — run \`npm run mutate\` or \`mutate:changed\` first`);
  if (hit.report.files[file]!.source !== current) {
    throw new Error(`${file} changed since ${hit.path} was written — its survivor lines are stale; re-run the mutation run first`);
  }
  return hit;
}

/** Survived + NoCoverage mutants of `file` in a Stryker JSON report → merged `file:a-b` line ranges. */
export function undetectedRanges(report: MutationReport, file: string): string[] {
  const entry = report.files[file];
  if (!entry) throw new Error(`${file} is not in the mutation report`);
  const spans = entry.mutants
    .filter(isUndetected)
    .map((m): Span => [m.location.start.line, m.location.end.line]);
  return toRanges(file, mergeSpans(spans));
}
