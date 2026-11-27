// G13 (ruling Q1 = b): type-aware ESLint gate.
// Exactly these rules, all `error`, no preset. Tests and `scripts/` are OUT of this gate (Q7);
// the baseline ratchet is `eslint-suppressions.json` (`npm run lint:ts:prune` after every fix).
// `.mjs` not `.ts`: ESLint needs the `jiti` devDep to load a TS config — zero extra deps wins.
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Bare `eslint` (the `check` step) walks the whole repo: ignore everything but the two gated trees,
  // or every `.js`/`scripts/`/`coverage/` file gets parsed and reports stray unused-directive warnings.
  {
    ignores: [
      "**/*",
      "!src/",
      "!src/**",
      "!api/",
      "!api/**",
      "**/*.test.ts",
      "**/*.test-helpers.ts",
      "src/test-helpers.ts", // test-only fixture without the `.test-helpers` dot (imported only by *.test.ts)
    ],
  },
  {
    files: ["src/**/*.ts", "api/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-conversion": "error",
      "@typescript-eslint/no-unnecessary-template-expression": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],
      "@typescript-eslint/restrict-template-expressions": "error",
    },
  },
  {
    // Patch + live-leg JSON is only cast, never type-vetted: its `!!` / `String()` normalise real runtime values.
    files: ["src/ladder-run.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-conversion": "off" },
  },
);
