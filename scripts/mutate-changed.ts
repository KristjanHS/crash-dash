// `npm run mutate:changed -- [base]` — Stryker over only the pure-core lines changed vs `base` (default origin/main); core tests, so a lower bound.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { changedSpans, toRanges, widenToDecisionNodes } from "./mutate-ranges.js";

const base = process.argv[2] ?? "origin/main";
const diff = execFileSync(
  "git",
  ["diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", base, "--", "src/"],
  { encoding: "utf8", maxBuffer: 64 << 20 },
);
const ranges = [...changedSpans(diff)].flatMap(([file, spans]) =>
  toRanges(file, widenToDecisionNodes(readFileSync(file, "utf8"), spans)),
);
if (ranges.length === 0) {
  console.log(`mutate:changed — no changed pure-core lines vs ${base}`);
  process.exit(0);
}
console.log(`mutate:changed — ${ranges.length} range(s) vs ${base}:\n  ${ranges.join("\n  ")}`);
const run = spawnSync("npx", ["stryker", "run", "stryker.changed.config.mjs", "--mutate", ranges.join(",")], {
  stdio: "inherit",
});
process.exit(run.status ?? 1);
