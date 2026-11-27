import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

import { ISOLATED_TESTS, sharedTestOptions } from "./vitest.shared.js";

// The RUN shape (which files, which pool, isolation) is the `projects` array below — two
// projects split by isolation NEED (rationale + measurements → vitest.shared.ts):
//   `shared`   — the mock-free files, one module registry per worker (isolate: false). The
//                suite's cost was collection, not assertions; sharing the registry removes it.
//   `isolated` — the files that use vi.mock / env stubbing / fake timers, which are
//                per-environment state and silently no-op under a shared registry.
// Vitest 4 dropped `vitest.workspace.ts` (the file this array replaced, removed in the 2 → 4
// upgrade); projects now live in the root config, next to the coverage + parallelism keys a
// project cannot carry. The root `test` block ALSO keeps env/exclude/testTimeout/hookTimeout so a direct
// `vitest run <file>` still behaves.
export default defineConfig(({ mode }) => {
  const { env, exclude, testTimeout, hookTimeout, DB_TESTS, INTEG_EXCLUDE } = sharedTestOptions(mode);
  return {
    test: {
      env,
      exclude,
      testTimeout,
      hookTimeout,
      // Content-hashed transform cache in node_modules/.experimental-vitest-cache; projects inherit it.
      experimental: { fsModuleCache: true },
      // T1 duration ceilings on every non-coverage, non-DB run (D2); a CLI `--reporter` REPLACES this list.
      reporters: DB_TESTS ? ["default"] : ["default", "./scripts/test-budget-reporter.ts"],
      projects: ["shared", "isolated"].map((name) => {
        const isolated = name === "isolated";
        return {
          test: {
            name,
            env,
            testTimeout,
            hookTimeout,
            include: isolated ? [...ISOLATED_TESTS] : ["**/*.test.ts", "**/*.test.js"],
            exclude: isolated ? exclude : [...exclude, ...ISOLATED_TESTS],
            // threads beats forks once isolation is off (no per-file process spawn: measured
            // `prepare` 16s → 0.1s). The isolated project keeps threads too so both projects
            // draw from one pool rather than competing across two runtimes.
            pool: "threads" as const,
            // Shared members STUB nothing — no vi.mock/spyOn/stubEnv/fake timer — so one module
            // registry per worker is safe for them. A module-scope `process.env` READ is fine and
            // does happen: store.contract / store.leg-pillars / store.run-history are shared
            // members that import store.test-helpers.ts, whose `hasDb` gate reads SUPABASE_URL /
            // SUPABASE_SERVICE_KEY / DB_TESTS at import time. A read mutates nothing for a later
            // file to inherit; what keeps those suites' truncates from racing is the root
            // `fileParallelism` guard below (`!DB_TESTS`, plus its INTEG_EXCLUDE escape), not isolation. Conversely the isolated
            // members need their own environment — that is the whole
            // reason they are listed. LOAD-BEARING on Vitest 4, unlike 2.1.9 where a
            // project-level `isolate` was silently dropped and the speedup came only from
            // run-unit-tests.sh's `--no-isolate` CLI flag: measured 2026-08-08 on this suite,
            // `--project=shared` alone runs in 4.6s, the same run with `--isolate` takes 10.2s.
            // Rule → .claude/rules/testing-project.md.
            isolate: isolated,
            // A test that runs no `expect` fails: a filter that drains to nothing must not pass vacuously.
            // Per project: an inline project does not inherit the root `test` block.
            expect: { requireAssertions: true },
            // NB `fileParallelism` — the DB-truncation serial guard — is deliberately NOT here.
            // Pool shape resolves once per run (ONE Tinypool), so a project-level value is
            // silently dropped; it lives in the root `test` block below.
          },
        };
      }),
      // MUST stay at the ROOT. Pool shape resolves ONCE per run (one Tinypool), so a per-project
      // `fileParallelism` is not representable and is silently dropped. NOT because it is in
      // Vitest's `NonProjectOptions` union — checked 4.1.10, it is not, and neither is
      // `maxWorkers`; that union is a type-level filter, and the runtime reason is the pool.
      //
      // Disabled only when DB_TESTS=1. The integration suites share ONE local Supabase and
      // the store.*.test.ts suites truncate `readings`/`alert_log`/`calibration` before each test
      // (delete().gte("id",0) = every row); under parallel workers that global wipe races a
      // concurrent DB test mid-flight — e.g. backfill-slow.test.ts's vintage-shadowing row
      // vanishing → "expected length 1, got 0". With INTEG_EXCLUDE set
      // (run-integration-tests.sh phase 2) those files are out of the run entirely, so the
      // guard protects nothing and the pass parallelizes like a unit run.
      //
      // Inert for scripts/run-unit-tests.sh (DB_TESTS unset there), so it costs the
      // shared-registry speedup nothing.
      fileParallelism: !DB_TESTS || INTEG_EXCLUDE.length > 0,
      // Root for the same reason as `fileParallelism` above. `isolate: false` makes each extra worker
      // re-import the whole barrel graph, so CPU scales far worse than wall: measured 2026-08-20,
      // 10 workers = 9.97 s wall / 42.2 s import CPU, 6 = 10.19 s / 24.1 s. Trading 0.2 s of wall
      // for 18 s of CPU is right on a box shared with sibling worktrees and `make ship`.
      // `min` is LOAD-BEARING: a bare 6 would force six workers onto a 2-core CI runner.
      maxWorkers: Math.min(6, availableParallelism()),
      coverage: {
        // `npm run coverage` surfaces gaps objectively. The store integration
        // branch only counts when a local DB is up; without it those lines read as
        // uncovered — expected, not a regression.
        provider: "v8",
        reporter: ["text", "html"],
        include: ["src/**/*.ts"],
        // *.test-helpers.ts + test-helpers.ts are fixtures (a `src/danger-*.ts` glob would aggregate one); types.ts is a mirror, no logic.
        exclude: ["src/**/*.test.ts", "src/**/*.test-helpers.ts", "src/test-helpers.ts", "src/api/types.ts"],
        // Per-file GATE (CI fails on regression), not a blanket %. Per-row tightness is
        // stated at the `thresholds` block below — do not restate it here, that duplication
        // is how the two descriptions drifted apart in the first place.
        // Deliberately UNGATED: ntfy.ts (a thin POST shim). store.ts gates at its no-DB
        // measurement − ~2pp (Q17: a DB-up run only scores higher). Glob keys only ⇒ no global threshold.
        //
        // These now GATE CI (`.github/workflows/ci.yml` runs the check with --coverage,
        // TEST-1 2026-08-08). Before that they only ran on a manual `npm run coverage`,
        // and two rows had rotted unnoticed — re-measured against HEAD on wiring:
        //   · `src/run.ts` became a 28-line re-export barrel + CLI entry (Stage 5a); its
        //     only uncovered statements are the `invokedDirectly` branch, unreachable
        //     under vitest, so the row read 40/50/0/40 and could never pass. Retargeted
        //     onto the three files the logic MOVED to, which is what the row was gating.
        //   · `src/fred.ts` branches measured 76.38, not the >85 the old row assumed.
        //
        // Rows are measured-at-HEAD minus ~2pp of headroom — tight enough that a dropped
        // test trips them, loose enough that a covered line added does not — EXCEPT for
        // the four cells called out as loose floors below. That distinction is the whole
        // honesty of this block: an earlier revision of this comment claimed the
        // minus-2pp property for every number, which was false for six of them (re-measured
        // 2026-08-08: fred.ts stmts 94.94 vs a 55 floor, lines 97.53 vs 55, fns 100 vs 50;
        // prices.ts stmts 96.5 vs 90, lines 99.4 vs 90, branches 85.71 vs 70). The four
        // stable rows there are ratcheted; the genuinely brittle cells stay loose and now
        // SAY so, rather than hiding behind a blanket sentence. When you re-measure, either
        // move the number or move it into the loose-floor list — never widen the sentence.
        thresholds: {
          // LOOSE FLOOR (deliberate): ladder.ts measures 100 across the board. Held at 95
          // because it is a large hand-maintained table where one new uncovered helper is a
          // normal intermediate state, not a regression worth failing CI over.
          "src/ladder.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
          // Exactly measured — no headroom by design; geo.ts is small and fully covered.
          "src/geo.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
          // branches is a LOOSE FLOOR (measures 85.71): the provider-selection
          // and per-symbol error arms swing with feed-shape fixtures, so a minus-2pp branch
          // bar here would red-flag routine fixture edits. The other three are ratcheted.
          "src/prices.ts": { statements: 94, branches: 70, functions: 98, lines: 97 },
          "src/run-core.ts": { statements: 96, branches: 92, functions: 94, lines: 97 },
          "src/run-cycle*.ts": { statements: 93, branches: 83, functions: 94, lines: 93 },
          "src/run-seeds.ts": { statements: 96, branches: 77, functions: 100, lines: 96 },
          // The old row's "only parseFredCsv is unit-testable; fetchSeries is a network shim"
          // rationale is stale — fetchSeries IS driven under a mocked fetch, which is why the
          // file measures 94.94/76.38/100/97.53 against floors of 55/74/50/55.
          "src/fred.ts": { statements: 92, branches: 74, functions: 98, lines: 95 },
          "src/danger-*.ts": { statements: 95, branches: 87, functions: 95, lines: 96 },
          "src/scorers-*.ts": { statements: 94, branches: 88, functions: 95, lines: 95 },
          "src/alert-band.ts": { statements: 98, branches: 95, functions: 98, lines: 98 },
          "src/t1dial.ts": { statements: 98, branches: 94, functions: 98, lines: 98 },
          // Re-measured 2026-11-17 (no-DB, ship phase B): 22.45/16.03/19.35/26.85. Was 25.59/21.05/23.76/29.47
          // before a refactor moved a session-check helper set (18 of 23 branches covered) out of
          // store.ts — covered code left, no test was lost.
          "src/store.ts": { statements: 20, branches: 14, functions: 17, lines: 24 },
          // The redaction seam. Measured 2026-11-17 (no-DB): http.ts 97.67/97.22/100/97.29.
          "src/api/http.ts": { statements: 95, branches: 95, functions: 98, lines: 95 },
        },
      },
    },
  };
});
