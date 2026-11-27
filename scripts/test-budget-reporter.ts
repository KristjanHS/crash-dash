/** T1 tripwire (audit-5 §5.1, D1/D2): reds every NON-coverage `vitest run` holding a test over 1 000 ms. Inert under
 * `--coverage` (D2). The ceiling is hand-set. Per-test only (D1 amended 2026-10-03): a per-file ceiling measured file
 * length × machine load, not slowness — it red under load on untouched files and was "fixed" only by splitting.
 * The per-test ceiling hit the same load inflation (measured 2026-10-09: 1350/1232/1018 ms in-suite vs 652/549/391 ms
 * alone), so an in-suite offender is CONFIRMED by re-running it alone on one worker; only a confirmed offender reds.
 * `T1_DEFER_ALONE=<path>` writes the offenders there instead; `scripts/test-budget-confirm.ts` confirms them later.
 * Every run also writes `.vitest-timings.json` (gitignored; `npm run test:slow` prints it) — a watch, never a gate. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

export const TEST_CEILING_MS = 1_000;
export const TIMINGS_FILE = ".vitest-timings.json";
const TOP_N = 20;

export interface Timed {
  name: string;
  ms: number;
  skipped?: boolean;
  /** Absolute module path + the test's own title — what the alone re-run needs to target it. */
  file?: string;
  title?: string;
}
export interface Offender extends Timed {
  ceiling: number;
}

export function overBudget(tests: readonly Timed[]): Offender[] {
  return tests
    .filter((r) => !r.skipped && r.ms > TEST_CEILING_MS)
    .map((r) => ({ ...r, ceiling: TEST_CEILING_MS }))
    .sort((a, b) => b.ms - a.ms);
}

/** `-t` pattern matching each title literally (titles carry backticks, parens, `−`). */
export function titlePattern(titles: readonly string[]): string {
  return [...new Set(titles)].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

export interface Timings {
  at: string;
  wallMs: number;
  tests: number;
  files: number;
  slowestTests: { ms: number; name: string }[];
  slowestFiles: { ms: number; tests: number; file: string }[];
  /** Per-file import + suite-callback time — module-scope fixture work lands here, invisible to the per-test ceiling. */
  slowestCollect: { ms: number; file: string }[];
}

export function summarizeTimings(
  tests: readonly Timed[],
  wallMs: number,
  at: string,
  collect: readonly { file: string; ms: number }[] = [],
): Timings {
  const ran = tests.filter((t) => !t.skipped);
  const byFile = new Map<string, { ms: number; tests: number }>();
  for (const t of ran) {
    const [file = t.name] = t.name.split(" > ");
    const f = byFile.get(file) ?? { ms: 0, tests: 0 };
    f.ms += t.ms;
    f.tests += 1;
    byFile.set(file, f);
  }
  return {
    at,
    wallMs: Math.round(wallMs),
    tests: ran.length,
    files: byFile.size,
    slowestTests: [...ran]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_N)
      .map((t) => ({ ms: Math.round(t.ms), name: t.name })),
    slowestFiles: [...byFile]
      .map(([file, f]) => ({ ms: Math.round(f.ms), tests: f.tests, file }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_N),
    slowestCollect: [...collect]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_N)
      .map((c) => ({ ms: Math.round(c.ms), file: c.file })),
  };
}

/** One key for both sides: in-suite passes `[TestCase.fullName]`, the alone JSON passes `[...ancestorTitles, title]`
 * — vitest 4 joins both with " > ". */
export function testKey(root: string, file: string, path: readonly string[]): string {
  return `${relative(root, file)} > ${path.join(" > ")}`;
}

export interface AloneJson {
  testResults: {
    name: string;
    assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number | null }[];
  }[];
}

/** key → alone-ms. Only a PASSING alone run counts (a test that throws early alone is no evidence); a key shared
 * by several tests (`test.each` without a placeholder) keeps its slowest. */
export function aloneTimings(root: string, json: AloneJson): Map<string, number> {
  const alone = new Map<string, number>();
  for (const f of json.testResults) {
    for (const a of f.assertionResults) {
      if (a.duration == null || a.status !== "passed") continue;
      const key = testKey(root, f.name, [...a.ancestorTitles, a.title]);
      alone.set(key, Math.max(alone.get(key) ?? 0, a.duration));
    }
  }
  return alone;
}

/** An offender is confirmed unless it was MEASURED alone at or under its ceiling — unmeasured stays red. */
export function confirmOffenders(offenders: readonly Offender[], alone: ReadonlyMap<string, number>): Offender[] {
  return offenders.filter((o) => !((alone.get(o.name) ?? Infinity) <= o.ceiling));
}

const ALONE_TIMEOUT_MS = 120_000;

/** Re-run the offenders' files on ONE worker with only their titles selected. A crash, hang or parse failure
 * yields an empty map, so every offender stays confirmed. */
export function measureAlone(root: string, offenders: readonly Offender[]): Map<string, number> {
  const dir = mkdtempSync(join(tmpdir(), "test-budget-"));
  const out = join(dir, "alone.json");
  try {
    const files = [...new Set(offenders.map((o) => o.file!))];
    // A CLI `--reporter` REPLACES the config list, so this child never loads this reporter (no recursion).
    spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        ...files,
        "-t",
        titlePattern(offenders.map((o) => o.title!)),
        "--maxWorkers=1",
        "--reporter=json",
        `--outputFile=${out}`,
      ],
      { cwd: root, stdio: "ignore", env: process.env, timeout: ALONE_TIMEOUT_MS },
    );
    return aloneTimings(root, JSON.parse(readFileSync(out, "utf8")) as AloneJson);
  } catch {
    return new Map();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The reporter's side effects — injected so its test needs no `vi.*` seam (`ISOLATED_TESTS`). */
export interface T1Io {
  env: Readonly<Record<string, string | undefined>>;
  write: (text: string) => void;
  measure: (root: string, offenders: readonly Offender[]) => Map<string, number>;
}
const LIVE_IO: T1Io = { env: process.env, write: (text) => void process.stderr.write(text), measure: measureAlone };

/** Confirm offenders alone and print the verdict; returns the exit code (1 = a confirmed offender). */
export function reportOffenders(root: string, offenders: readonly Offender[], io: T1Io = LIVE_IO): number {
  const alone = io.measure(root, offenders);
  const confirmed = confirmOffenders(offenders, alone);
  if (confirmed.length === 0) {
    const worst = Math.round(Math.max(...offenders.map((o) => alone.get(o.name)!)));
    io.write(
      `\nT1 load-only: ${offenders.length} test(s) > ${TEST_CEILING_MS} ms in-suite, all ≤ ${worst} ms alone (not a failure)\n`,
    );
    return 0;
  }
  const rows = confirmed.map((o) => {
    const a = alone.get(o.name);
    const aloneTxt = a == null ? "alone: not measured" : `alone ${Math.round(a)} ms`;
    return `  test ${Math.round(o.ms)} ms in-suite, ${aloneTxt} > ${o.ceiling} ms  ${o.name}`;
  });
  io.write(`\nT1 test budget exceeded (scripts/test-budget-reporter.ts):\n${rows.join("\n")}\n`);
  return 1;
}

/** The deferred half: confirm a `T1_DEFER_ALONE` file. An unreadable file exits 1. */
export function confirmDeferred(path: string, root: string, io: T1Io = LIVE_IO): number {
  let offenders: unknown;
  try {
    offenders = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    offenders = e;
  }
  if (!Array.isArray(offenders)) {
    io.write(`\nT1 deferred offenders unreadable (${path}): ${String(offenders)}\n`);
    return 1;
  }
  return offenders.length === 0 ? 0 : reportOffenders(root, offenders as Offender[], io);
}

export default class TestBudgetReporter implements Reporter {
  private coverage = false;
  private root = process.cwd();
  private startedAt = Date.now();
  private readonly io: T1Io;
  /** Vitest passes its reporter options (`{}`) here, so merge over the live IO, never replace it. */
  constructor(io: Partial<T1Io> = {}) {
    this.io = { ...LIVE_IO, ...io };
  }
  onInit(vitest: Vitest): void {
    this.coverage = vitest.config.coverage.enabled;
    this.root = vitest.config.root;
    this.startedAt = Date.now();
  }
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    if (this.coverage) return;
    const tests: Timed[] = [];
    const collect = modules.map((m) => ({ file: relative(this.root, m.moduleId), ms: m.diagnostic().collectDuration }));
    for (const m of modules) {
      for (const t of m.children.allTests()) {
        const state = t.result().state;
        tests.push({
          name: testKey(this.root, m.moduleId, [t.fullName]),
          ms: t.diagnostic()?.duration ?? 0,
          skipped: state === "skipped" || state === "pending",
          file: m.moduleId,
          title: t.name,
        });
      }
    }
    const timings = summarizeTimings(tests, Date.now() - this.startedAt, new Date().toISOString(), collect);
    try {
      writeFileSync(join(this.root, TIMINGS_FILE), `${JSON.stringify(timings, null, 2)}\n`);
    } catch {
      // A watch file, never a gate — an unwritable tree must not red the run.
    }
    const offenders = overBudget(tests);
    if (offenders.length === 0) return;
    const deferTo = this.io.env.T1_DEFER_ALONE;
    if (deferTo) {
      const rows = offenders.map(({ name, ms, ceiling, file, title }) => ({ name, ms, ceiling, file, title }));
      writeFileSync(deferTo, `${JSON.stringify(rows)}\n`);
      this.io.write(`\nT1 deferred: ${offenders.length} offender(s)\n`);
      return;
    }
    if (reportOffenders(this.root, offenders, this.io) !== 0) process.exitCode = 1;
  }
}
