import { defineConfig } from "vitest/config";

import { sharedTestOptions } from "./vitest.shared.js";

// `npm run mutate` only: the core suites as ONE shared-registry project (scores are lower bounds).
// Not vitest.config.ts: under its two projects no mutant activates (2.65 %); the full suite isolated runs ~5 h.
export default defineConfig(({ mode }) => {
  const { env, exclude, testTimeout, hookTimeout } = sharedTestOptions(mode);
  return {
    test: {
      env,
      exclude,
      testTimeout,
      hookTimeout,
      include: ["src/alert-band.*.test.ts", "src/danger-*.test.ts", "src/dashboard.*.test.ts", "src/t1dial.test.ts"],
      pool: "threads",
      isolate: false,
    },
  };
});
