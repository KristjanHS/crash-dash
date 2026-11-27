/**
 * Guards the `shared` / `isolated` split in vitest.config.ts (`test.projects`).
 *
 * The `shared` project runs with `isolate: false` — one module registry per worker. That is
 * where the suite's speed comes from (collect 51s → 5s, full run 54s → 23s on 2 cores), and
 * it is only safe for files that never touch per-environment state. A module mock in a
 * shared file does not throw; it SILENTLY no-ops whenever an earlier file already imported
 * the real module, so the test passes against the real seam — reaching the network, in the
 * measured case, at 7s a test. That failure mode is invisible without this guard.
 *
 * So: every test file that reaches for a mock/env/timer seam must be listed in
 * ISOLATED_TESTS, and every listed file must still need it (a stale entry is pure cost —
 * it opts a file back into per-file isolation for nothing).
 *
 * WHAT THE SCAN COVERS. Two globs, not one:
 *   · `**​/*.test.ts` + `**​/*.test.js` — the collected suite, matched against ISOLATION_SEAMS.
 *     These are the files that can be ISOLATED_TESTS entries.
 *   · `**​/*.test-helpers.ts` — NOT collected by vitest and so never a manifest entry, but a
 *     helper can hold the seam calls on its importers' behalf (`installRunTestHooks` in
 *     `src/run.test-helpers.ts` is three `vi.spyOn`s (the console silencer), a `vi.stubGlobal` and two `vi.stubEnv`s). The property is therefore TRANSITIVE: a
 *     helper matching HELPER_SEAMS marks every test file that imports it as seam-carrying,
 *     even when that test file's own text is clean — except an `installRunTestHooks` caller
 *     (ruling Q-E, RUN_HOOKS below). Without this, a file drawing its seams from a helper
 *     would scan seam-free and land in `shared` with nothing undoing them. (An env WRITE is a
 *     seam in both sets; a bare env READ is in neither — it is inert under a shared registry.)
 *
 * Both scans are textual, so a seam named only in a comment still counts. That errs toward
 * over-isolating one file, never toward a silently-dead mock.
 *
 * CAN-FAIL DEMONSTRATION (each executed on the date shown, reverted after confirming one red):
 *   1. add an env stub to src/geo.test.ts (unlisted) ⇒ "must be listed" names it, red (2026-08-01).
 *   2. delete "src/ntfy.test.ts" from ISOLATED_TESTS ⇒ same assertion names it, red (2026-08-01).
 *   3. add "src/geo.test.ts" (seam-free) to ISOLATED_TESTS ⇒ the stale-entry check reds (2026-08-01).
 *   4. TRANSITIVITY (2026-08-09): add a temp `src/run.reddemo.test.ts` whose own text names NO
 *      seam and whose only seam is `installRunTestHooks` (the shape a future `run.*.test.ts`
 *      would take), unlisted ⇒ "must be listed" names it, red. Re-run with the helper glob
 *      typo'd (transitivity off, i.e. the pre-2026-08-09 scan): that same assertion goes GREEN
 *      on the identical file — which is the blind spot this scan closes — and only the
 *      collection anchor below reds. (Since Q-E that file shares; the demo holds for a helper
 *      seam with no `installRunTestHooks(` call.)
 *   5. Q-E (2026-10-18): `vi.mock("./ntfy.js")` in src/run.exposure.test.ts ⇒ "must be listed"
 *      names it.
 *   6. Store tripwire (2026-11-01): `stubEnv` dropped from HOOK_UNDONE while the hook's beforeEach
 *      blanks SUPABASE_URL/SUPABASE_SERVICE_KEY ⇒ "must be listed" names the 9 unlisted hook callers.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  HELPER_SEAMS,
  ISOLATED_TESTS,
  ISOLATED_TESTS_BUDGET,
  ISOLATION_SEAMS,
} from "../vitest.shared.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// This file is its own exception: the docblock above names the seams it scans for, so a
// textual scan would always flag it. It uses none of them.
const SELF = "src/isolation-manifest.test.ts";

const scan = (patterns: string[]) =>
  globSync(patterns, {
    cwd: repoRoot,
    exclude: (p) =>
      /(^|[\\/])(node_modules|\.claude|dist|\.git)([\\/]|$)/.test(p),
  })
    .map((p) => p.split(path.sep).join("/"))
    .sort();

// Each file's text, read once per module and shared by every scan below.
const texts = new Map<string, string>();
const read = (rel: string): string =>
  texts.get(rel) ?? texts.set(rel, readFileSync(path.join(repoRoot, rel), "utf8")).get(rel)!;

// Same collection set the `shared` project uses, minus the sibling-worktree
// duplicates and vendored copies the config already excludes.
const allTests = scan(["**/*.test.ts", "**/*.test.js"]).filter(
  (p) => p !== SELF,
);

// Helpers that stub on their importers' behalf. Not collected by vitest, so they can never be
// ISOLATED_TESTS entries — instead their seam-ness propagates to whoever imports them.
const seamHelpers = scan(["**/*.test-helpers.ts"]).filter((p) =>
  HELPER_SEAMS.test(read(p)),
);

// Relative-specifier form of a helper as its importers write it (`./run.test-helpers.js` —
// `.js` extensions on relative imports, per the repo's import convention).
const specifierOf = (helper: string) => `${path.basename(helper, ".ts")}.js`;

// Ruling Q-E (2026-10-18): `installRunTestHooks`'s afterEach runs `vi.restoreAllMocks()` +
// `vi.unstubAllGlobals()` + `vi.unstubAllEnvs()`, so a caller may share when its own text AND the helper's carry no
// seam beyond the three that afterEach undoes. Any other seam in either still isolates it.
const RUN_HOOKS = "src/run.test-helpers.ts";
const HOOK_UNDONE = /\bvi\.(spyOn|stubGlobal|stubEnv)\b/g;
// A spy made in beforeAll/afterAll outlives the per-test restore, so such a file keeps its spies.
const ALL_HOOKS = /\b(beforeAll|afterAll)\(/;
const residualSeam = (text: string) =>
  ISOLATION_SEAMS.test(ALL_HOOKS.test(text) ? text : text.replace(HOOK_UNDONE, ""));
// Column-0 only: a call nested in a describe/test body does not cover the whole file.
const CALLS_RUN_HOOKS = /^installRunTestHooks\(/m;

const usesSeam = (rel: string) => {
  const text = read(rel);
  if (CALLS_RUN_HOOKS.test(text)) {
    return (
      residualSeam(text) ||
      seamHelpers.some((h) => text.includes(specifierOf(h)) && (h !== RUN_HOOKS || residualSeam(read(h))))
    );
  }
  return (
    ISOLATION_SEAMS.test(text) ||
    seamHelpers.some((h) => text.includes(specifierOf(h)))
  );
};

// T2 rule: an entry's reason is its trailing `//`, else the `//` block directly above the
// unbroken run of entries it sits in — a blank line ends the run.
function entryReasons(src: string): Map<string, string | null> {
  const block = /export const ISOLATED_TESTS = \[\n([\s\S]*?)\n\] as const;/.exec(src)?.[1] ?? "";
  const reasons = new Map<string, string | null>();
  let above: string | null = null;
  let inComment = false;
  for (const line of block.split("\n")) {
    const entry = /^\s*"([^"]+)",\s*(?:\/\/(.*))?$/.exec(line);
    const comment = /^\s*\/\/(.*)$/.exec(line);
    if (entry) reasons.set(entry[1] as string, entry[2] ?? above);
    else if (comment) above = `${inComment ? above : ""} ${comment[1]}`;
    else above = null;
    inComment = comment !== null;
  }
  return reasons;
}

const mockTargets = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .flatMap((l) => [...l.matchAll(/\bvi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g)].map((m) => m[1] as string));

function reasonOffenders(
  reasons: Map<string, string | null>,
  readFile: (rel: string) => string,
): string[] {
  return [...reasons].flatMap(([f, why]) => {
    if (why === null) return [`${f}: no \`//\` reason comment`];
    const targets = f.startsWith("api/") ? mockTargets(readFile(f)) : [];
    const storeOnly = targets.length > 0 && targets.every((t) => /(^|\/)store\.js$/.test(t));
    return storeOnly || /no handle/i.test(why) ? [`${f}: export \`handle(store, req)\``] : [];
  });
}

describe("vitest project isolation manifest", () => {
  test("collection found the suite (a broken glob must not make the guard vacuous)", () => {
    expect(allTests.length).toBeGreaterThan(100);
    // The helper glob has its own vacuity floor: a typo there would silently disable
    // transitivity — every scan would still pass, and a helper-only-seam file would slip
    // into `shared`. `src/run.test-helpers.ts` is the seam-carrying helper today.
    expect(seamHelpers).toContain("src/run.test-helpers.ts");
  });

  test("every file using a mock/env/timer seam is in ISOLATED_TESTS", () => {
    const listed = new Set<string>(ISOLATED_TESTS);
    expect(allTests.filter((f) => usesSeam(f) && !listed.has(f))).toEqual([]);
  });

  test("no stale entry: every listed file still needs its own environment", () => {
    expect(ISOLATED_TESTS.filter((f) => !usesSeam(f))).toEqual([]);
  });

  test("the isolated project stays inside its hand-set budget", () => {
    expect(ISOLATED_TESTS.length).toBeLessThanOrEqual(ISOLATED_TESTS_BUDGET);
    // Early warning: two slots short of the wall is the ruling point, not a silent fill.
    expect(
      ISOLATED_TESTS.length,
      `${ISOLATED_TESTS.length} of ${ISOLATED_TESTS_BUDGET}: re-rule the budget or de-isolate`,
    ).toBeLessThanOrEqual(ISOLATED_TESTS_BUDGET - 2);
  });

  test("every entry carries a reason comment; an api store-only mock owes a handle seam", () => {
    const reasons = entryReasons(read("vitest.shared.ts"));
    // Parser vacuity anchor: a broken block regex would find no entries and pass both arms.
    expect([...reasons.keys()]).toEqual([...ISOLATED_TESTS]);
    expect(reasonOffenders(reasons, read)).toEqual([]);
  });

  test("the reason check flags a blank-line-broken run, a store-only api mock and a `no handle` reason", () => {
    const src = [
      "export const ISOLATED_TESTS = [",
      '  "a.test.ts", // trailing',
      "  // block",
      '  "b.test.ts",',
      '  "c.test.ts",',
      "",
      '  "d.test.ts",',
      "  // seam",
      '  "api/x.test.ts",',
      "  // no handle yet",
      '  "api/y.test.ts",',
      "] as const;",
    ].join("\n");
    const files: Record<string, string> = {
      "api/x.test.ts": 'vi.mock("../src/store.js", () => ({}));\n// vi.mock("../src/fred.js");',
      "api/y.test.ts": 'vi.mock("../src/fred.js", () => ({}));',
    };
    expect(reasonOffenders(entryReasons(src), (f) => files[f] ?? "")).toEqual([
      "d.test.ts: no `//` reason comment",
      "api/x.test.ts: export `handle(store, req)`",
      "api/y.test.ts: export `handle(store, req)`",
    ]);
  });

  test("an env WRITE is a seam in every spelling; an env READ is not", () => {
    const writes = [
      "process.env.X = y",
      'process.env["X"] = y',
      "delete process.env.X",
      "Object.assign(process.env, o)",
      'process.env.X ??= "t"',
      "process.env = { ...saved }",
    ];
    expect(writes.filter((w) => !ISOLATION_SEAMS.test(w))).toEqual([]);
    const reads = [
      'process.env.DB_TESTS === "1"',
      "const u = process.env.SUPABASE_URL;",
      "{ ...process.env, PATH: p }",
    ];
    expect(reads.filter((r) => ISOLATION_SEAMS.test(r))).toEqual([]);
  });

  // A DIFFERENT hazard of the same shared registry: one globalThis per worker. A file that
  // deletes a global Node actually provides leaves it MISSING for every later file in that
  // worker, and the failure lands nowhere near the culprit — `delete globalThis.fetch` in a
  // public/*.test.js afterEach reappeared as 12 red store.run-history integration tests
  // ("ReferenceError: fetch is not defined" out of supabase-js, reported by the
  // disposable-stack probe as a flaky stack; 2026-09-06 make ship, its second occurrence).
  // Restoring the captured value is the fix, so the lint bans only the delete FORM.
  //
  // Deleting a name Node does NOT provide (document, localStorage) is fine — undefined is the
  // original state — hence the `in globalThis` test rather than a hand-kept name list, which
  // would rot as Node adds globals. The regex is anchored to a statement (leading whitespace,
  // trailing `;`) so prose naming the pattern in a docblock stays legal.
  //
  // CAN-FAIL DEMONSTRATION (2026-09-06): restoring `delete globalThis.fetch;` in
  // public/auth-session.test.js's afterEach reds this test naming that file:line, and the
  // same revert reds src/store.run-history.test.ts under `npm run check:integration`.
  // Silencing output, or asserting a diagnostic line, is never worth isolation: take a `log`/`warn`
  // param instead. The allowlist only shrinks; a stale row reds too.
  test("no test file spies on console outside the shrinking allowlist", () => {
    // The one row: `installRunTestHooks`' silencer, restored by its own afterEach (Q-E); run tests read its spy (`runWarns()` / `vi.mocked(console.*)`).
    const CONSOLE_SPY_ALLOW = ["src/run.test-helpers.ts"];
    const spies = [...allTests, ...scan(["**/*.test-helpers.ts"])]
      .filter((f) => read(f).split("\n").some((l) => !/^\s*(\/\/|\*)/.test(l) && /\bspyOn\(\s*(?:globalThis\.)?console\b/.test(l)))
      .sort();
    expect(spies).toEqual(CONSOLE_SPY_ALLOW);
  });

  test("no test file deletes a global Node provides (it leaks to the rest of the worker)", () => {
    const offenders = allTests.flatMap((f) =>
      !read(f).includes("globalThis.") ? [] : [...read(f).matchAll(/^\s*delete\s+globalThis\.(\w+)\s*;/gm)]
        .map((m) => m[1] as string)
        .filter((name) => name in globalThis)
        .map((name) => `${f}: delete globalThis.${name} (restore it instead)`),
    );
    expect(offenders).toEqual([]);
  });
});
