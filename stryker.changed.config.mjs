// `npm run mutate:changed` only: own report + incremental files, so the core report `mutate:confirm` prefers is never overwritten.
import base from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  jsonReporter: { fileName: "reports/mutation/changed.json" },
  incrementalFile: "reports/stryker-incremental-changed.json",
};
