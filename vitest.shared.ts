import { configDefaults } from "vitest/config";
import { loadEnv } from "vite";

/**
 * Shared test options for the two projects declared in `vitest.config.ts` (`test.projects`;
 * they lived in a `vitest.workspace.ts` until the Vitest 4 upgrade removed that file).
 *
 * WHY TWO PROJECTS. Module *collection* — importing each test file's src graph — was the
 * suite's dominant cost, not the assertions: measured 51s of the ~93s total CPU, because
 * every file is collected in its own isolated environment and re-imports the same src graph
 * (an empty test file costs ~12ms). Running
 * with `isolate: false` shares one module registry per worker and collapses collect to ~5s.
 *
 * But `isolate: false` breaks `vi.mock`: the mock only applies if no earlier file in that
 * worker already pulled the real module into the shared registry. Measured, that is exactly
 * what happens — `api/health-view.test.ts` + `api/meta.test.ts` got the REAL `store.js`,
 * reached for live Supabase, and burned 7s per test on network timeouts. The same hazard
 * covers env stubbing and fake timers, which are per-environment state.
 *
 * So the split is by *isolation need*, not by directory: ISOLATED_TESTS below runs the old
 * isolated way, everything else shares. `src/isolation-manifest.test.ts` is the guard that
 * keeps the list honest — it fails if a file outside the list reaches for a mock/env/timer
 * seam, so a new `vi.mock` can never silently land in the shared project.
 *
 * Measured on 2 cores (the CI runner shape), full suite: 54s → 23s.
 */

/**
 * Test files that MUST keep their own environment: they call `vi.mock`, `vi.doMock`,
 * `vi.stubEnv`, `vi.useFakeTimers`, or WRITE `process.env`. Repo-relative paths; kept in sync
 * by `src/isolation-manifest.test.ts`, which also caps the list (`ISOLATED_TESTS_BUDGET`).
 * Each entry carries a `//` reason (why the seam cannot be injected); a blank line ends a comment's run.
 */
export const ISOLATED_TESTS = [
  // A hand-rolled global stubber (`globalThis.fetch` / `document` / `localStorage`):
  // browser-seam suite for `public/*.js`, stubbing without `vi.stubGlobal`'s unstub. Isolated
  // so a missed restore cannot reach another file — see HELPER_SEAMS above.
  "public/auth-session.test.js",

  // `vi.stubGlobal("fetch")` + `vi.useFakeTimers` — `dbFetch` reads `globalThis.fetch` per call, the caps are wall-clock.
  "src/db-fetch.test.ts",

  // `vi.useFakeTimers` drives the run fetch budget's deadline over hanging feeds — the clock is the subject.
  "src/run.wiring.feeds.test.ts",
] as const;

/**
 * The `vi.*` half of the seam set: the calls that STUB per-environment state and therefore
 * silently no-op (or leak) under a shared module registry.
 *
 * `spyOn` is in the list because under a shared registry `globalThis` and `console` are
 * shared across every file in the worker: a `vi.spyOn(globalThis, "fetch")` that is not
 * hand-restored leaks the stub into every LATER file in that worker, order-dependently.
 * Nothing sets `restoreMocks: true`, so the restore is the author's to remember — which is
 * exactly the kind of invisible coupling this split must not rely on.
 *
 * This is ALSO the set that propagates transitively out of a `*.test-helpers.ts` — except an
 * `installRunTestHooks` caller, whose afterEach undoes `spyOn`/`stubGlobal`/`stubEnv` (ruling Q-E).
 *
 * A bare `globalThis.<name> = …` is in the set for the same reason as `spyOn`: it IS
 * `vi.stubGlobal` written by hand, with the same one-globalThis-per-worker leak and none of
 * vitest's unstubbing. Its absence is how `public/auth-session.test.js` scanned clean into
 * `shared` and left every later file in its worker without a global `fetch` (2026-09-06:
 * 12 red `store.run-history` integration tests, a file it has nothing to do with). Assignment
 * only — a `globalThis.x === y` READ mutates nothing, hence the negative lookahead on `=`.
 */
export const HELPER_SEAMS =
  /\bvi\.(mock|doMock|spyOn|stubEnv|stubGlobal|useFakeTimers|setSystemTime)\b|\bglobalThis\.\w+\s*=(?!=)|\bprocess\.env(\.\w+|\[[^\]]+\])?\s*(\?\?|\|\||&&|\+)?=(?!=)|\bdelete\s+process\.env\b|\bObject\.assign\(\s*process\.env\b/;

/**
 * Source seams that force isolation — the regex the manifest guard scans for in a TEST file.
 * A `process.env` WRITE leaks like `globalThis.x =`; a bare READ (a `hasDb` lane gate) is inert.
 */
export const ISOLATION_SEAMS = HELPER_SEAMS;

/** Hand-set with headroom — never re-pin it at the live count. */
export const ISOLATED_TESTS_BUDGET = 10;

export function sharedTestOptions(mode: string) {
  // Load .env / .env.local into the test process env (Node-side), so the
  // integration suite picks up SUPABASE_URL + SUPABASE_SERVICE_KEY from the local
  // `supabase start` stack. Prefix "" = load all vars, not just VITE_-prefixed.
  const env = loadEnv(mode, process.cwd(), "");
  // The truncating DB-integration suite (the store.*.test.ts family / backfill-slow.test.ts,
  // gated `describe.runIf(hasDb)` on DB_TESTS==="1") is the ONLY reason files must
  // run serially — see fileParallelism below. Read the gate from the SAME source the
  // test-side hasDb sees: vitest merges `test.env` (this loadEnv) into the worker's
  // process.env, so DB_TESTS can arrive via the shell OR a .env file. Reading only
  // process.env here (config-eval, pre-merge) would miss a .env-set flag and
  // parallelize the truncating suite — the exact cross-file race the guard prevents.
  const DB_TESTS = (process.env.DB_TESTS ?? env.DB_TESTS) === "1";
  // INTEG_EXCLUDE (comma-separated repo-relative test paths) is set ONLY by
  // scripts/run-integration-tests.sh phase 2: the DB-truncating files it names already
  // ran serially in phase 1, so this pass excludes them and may parallelize even though
  // DB_TESTS=1 is still armed — nothing left in the run touches the live DB.
  const INTEG_EXCLUDE = (process.env.INTEG_EXCLUDE ?? env.INTEG_EXCLUDE ?? "")
    .split(",")
    .filter(Boolean);
  return {
    env,
    // An in-tree worktree under .claude/ (the harness's own `-w`/EnterWorktree
    // checkout) carries duplicate test files;
    // collecting them doubles DB-integration failures on runs without a local DB.
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.stryker-tmp/**", // `npm run mutate` sandbox copies of every test
      "scripts/archive/**",
      ...INTEG_EXCLUDE,
    ],
    testTimeout: 15_000, // headroom for the first Docker/PostgREST round-trip on a cold runner
    // Matches testTimeout; a whole-tree TS-parse `beforeAll` passes its own `SCAN_HOOK_TIMEOUT` instead.
    hookTimeout: 15_000,
    DB_TESTS,
    INTEG_EXCLUDE,
  };
}
