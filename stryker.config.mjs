// On-demand mutation score over the notify path, decision mutators only (`npm run mutate`) — never a gate (Q4); scores go in the commit message (Q18).
// `mutate:changed` / `mutate:confirm` (scripts/mutate-*.ts) pass their own `--mutate` ranges, which replace this list.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },
  coverageAnalysis: "perTest",
  ignoreStatic: true, // module-init mutants rerun the whole suite each (~19 % of mutants, ~83 % of the time)
  mutate: [
    "src/alert-band.ts",
    "src/danger-*.ts",
    "src/domain-fold.ts",
    "src/domain-legs.ts",
    "!src/**/*.test.ts",
    "!src/**/*.test-helpers.ts",
  ],
  // Kept: Conditional, Equality, Logical, Arithmetic, Boolean, Unary (A3s). Excluded ones still instrument, as Ignored.
  mutator: {
    excludedMutations: [
      "ArrayDeclaration",
      "ArrowFunction",
      "AssignmentOperator",
      "BlockStatement",
      "CallExpression",
      "MethodExpression",
      "ObjectLiteral",
      "OptionalChaining",
      "Regex",
      "StringLiteral",
      "UpdateOperator",
    ],
  },
  // Stryker copies .gitignored files too: keep secrets, dangling skill symlinks and Python venvs out of the sandbox.
  ignorePatterns: ["/.env*", "!/.env.example", "/.vercel", "/certs", "/coverage", "/state", "/.claude/skills", "**/.venv", "**/__pycache__", "**/.*_cache", "scripts/preview/out", "scripts/backtest/data-g4", "supabase/backups", "supabase/.temp", "supabase/seed.sql"],
  reporters: ["clear-text", "progress", "json"],
  clearTextReporter: { reportMutants: false, reportTests: false },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  concurrency: 8, // 10-thread box, [USER] 2026-10-26: 8 workers, 2 threads left for the OS + sibling sessions
  tempDirName: ".stryker-tmp",
  thresholds: { high: 80, low: 60, break: null },
};
