import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import TestBudgetReporter, {
  aloneTimings,
  confirmDeferred,
  confirmOffenders,
  overBudget,
  summarizeTimings,
  type T1Io,
  TEST_CEILING_MS,
  testKey,
  titlePattern,
} from "./test-budget-reporter.js";

describe("alone re-run confirmation", () => {
  const root = "/r";
  const key = testKey(root, "/r/f.test.ts", ["s > t"]); // the in-suite shape: [TestCase.fullName]
  const row = (title: string, duration: number, status = "passed") => ({ ancestorTitles: ["s"], title, status, duration });
  const json = (...rows: ReturnType<typeof row>[]) => ({ testResults: [{ name: "/r/f.test.ts", assertionResults: rows }] });
  const [offender] = overBudget([{ name: key, ms: TEST_CEILING_MS * 2 }]);

  test("an offender measured passing alone under the ceiling clears; over it stays", () => {
    expect(confirmOffenders([offender!], aloneTimings(root, json(row("t", TEST_CEILING_MS / 2))))).toEqual([]);
    expect(confirmOffenders([offender!], aloneTimings(root, json(row("t", TEST_CEILING_MS + 1))))).toHaveLength(1);
  });

  test("unmeasured, failing-alone, or a fast duplicate-name twin never clears it", () => {
    expect(confirmOffenders([offender!], new Map())).toHaveLength(1);
    expect(confirmOffenders([offender!], aloneTimings(root, json(row("t", 2, "failed"))))).toHaveLength(1);
    const twins = aloneTimings(root, json(row("t", TEST_CEILING_MS + 1), row("t", 5)));
    expect(confirmOffenders([offender!], twins)).toHaveLength(1);
  });
});

describe("titlePattern", () => {
  test("matches each title literally, regex metacharacters included", () => {
    const titles = ["a (b) `c` [d] D−1 x.y?", "plain"];
    const re = new RegExp(titlePattern(titles));
    for (const t of titles) expect(re.test(`suite ${t}`)).toBe(true);
    expect(re.test("a b `c` d D−1 xxy")).toBe(false);
  });
});

describe("summarizeTimings", () => {
  test("ranks tests and per-file sums slowest first, skipped excluded", () => {
    const s = summarizeTimings(
      [
        { name: "f1.test.ts > a", ms: 10 },
        { name: "f1.test.ts > b", ms: 30 },
        { name: "f2.test.ts > c", ms: 25 },
        { name: "f2.test.ts > skip", ms: 999, skipped: true },
      ],
      100,
      "t",
      [
        { file: "f1.test.ts", ms: 5.4 },
        { file: "f2.test.ts", ms: 120.6 },
      ],
    );
    expect(s.slowestCollect).toEqual([
      { ms: 121, file: "f2.test.ts" },
      { ms: 5, file: "f1.test.ts" },
    ]);
    expect(s.slowestTests.map((t) => t.name)).toEqual(["f1.test.ts > b", "f2.test.ts > c", "f1.test.ts > a"]);
    expect(s.slowestFiles).toEqual([
      { ms: 40, tests: 2, file: "f1.test.ts" },
      { ms: 25, tests: 1, file: "f2.test.ts" },
    ]);
    expect([s.tests, s.files]).toEqual([3, 2]);
  });
});

describe("overBudget", () => {
  test("names each test strictly over the ceiling, slowest first", () => {
    const tests = [
      { name: "a > at ceiling", ms: TEST_CEILING_MS },
      { name: "a > over", ms: TEST_CEILING_MS + 1 },
      { name: "b > further over", ms: TEST_CEILING_MS + 2 },
    ];
    expect(overBudget(tests).map((o) => o.name)).toEqual(["b > further over", "a > over"]);
  });

  test("a skipped test is exempt", () => {
    expect(overBudget([{ name: "t", ms: TEST_CEILING_MS * 2, skipped: true }])).toEqual([]);
  });
});

describe("T1_DEFER_ALONE", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t1-defer-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const io = (alone: Map<string, number>, env: Record<string, string> = {}): T1Io => ({
    env,
    write: () => {},
    measure: () => alone,
  });

  const slowModule = (ms: number) =>
    ({
      moduleId: join(dir, "f.test.ts"),
      diagnostic: () => ({ collectDuration: 1 }),
      children: {
        allTests: () => [{ fullName: "s > t", name: "t", result: () => ({ state: "passed" }), diagnostic: () => ({ duration: ms }) }],
      },
    }) as unknown as TestModule;

  test("set: the reporter writes the offenders to the path and leaves exitCode alone", () => {
    const out = join(dir, "offenders.json");
    const r = new TestBudgetReporter(io(new Map(), { T1_DEFER_ALONE: out }));
    r.onInit({ config: { coverage: { enabled: false }, root: dir } } as unknown as Vitest);
    r.onTestRunEnd([slowModule(TEST_CEILING_MS * 2)]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
      { name: "f.test.ts > s > t", ms: TEST_CEILING_MS * 2, ceiling: TEST_CEILING_MS, file: join(dir, "f.test.ts"), title: "t" },
    ]);
  });

  test("the deferred confirm exits 0 measured under the ceiling, 1 unmeasured, over it, or unreadable", () => {
    const path = join(dir, "offenders.json");
    const [o] = overBudget([{ name: "f.test.ts > s > t", ms: TEST_CEILING_MS * 2 }]);
    writeFileSync(path, JSON.stringify([o]));
    expect(confirmDeferred(path, dir, io(new Map([[o!.name, TEST_CEILING_MS / 2]])))).toBe(0);
    expect(confirmDeferred(path, dir, io(new Map([[o!.name, TEST_CEILING_MS + 1]])))).toBe(1);
    expect(confirmDeferred(path, dir, io(new Map()))).toBe(1);
    expect(confirmDeferred(join(dir, "missing.json"), dir, io(new Map()))).toBe(1);
    writeFileSync(path, "{}");
    expect(confirmDeferred(path, dir, io(new Map()))).toBe(1);
  });
});
