// `npm run mutate:confirm` only: the full suite, isolated, over the survivor lines `scripts/mutate-confirm.ts` passes.
// Own report + incremental files, so the core-tests report it reads survivors from is never overwritten.
// GOTCHA (2026-10-31, X5): `incremental` reuses a mutant's old status when its line + covering tests are unchanged — a change in a
// NON-mutated dependency (series-math.ts) is invisible to it. After such a change, confirm with `--force` or the old survivors come back.
import base from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  vitest: { configFile: "vitest.stryker-full.config.ts" },
  jsonReporter: { fileName: "reports/mutation/confirm.json" },
  incrementalFile: "reports/stryker-incremental-confirm.json",
};
