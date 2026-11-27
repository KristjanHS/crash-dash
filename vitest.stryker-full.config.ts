import { defineConfig } from "vitest/config";

import { sharedTestOptions } from "./vitest.shared.js";

// `npm run mutate:confirm` only: every test file as ONE isolated project (vi.mock-safe; mutants activate, unlike vitest.config.ts's two projects).
export default defineConfig(({ mode }) => {
  const { env, exclude, testTimeout, hookTimeout } = sharedTestOptions(mode);
  return {
    test: {
      env,
      exclude,
      testTimeout,
      hookTimeout,
      include: ["**/*.test.ts", "**/*.test.js"],
      pool: "threads",
      isolate: true,
    },
  };
});
