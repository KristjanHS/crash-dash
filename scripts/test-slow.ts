/** `npm run test:slow` — prints the last run's `.vitest-timings.json` (written by scripts/test-budget-reporter.ts).
 * In-suite durations: they include worker contention, so read them as a ranking, not as per-test cost. */
import { readFileSync } from "node:fs";

import { TIMINGS_FILE, type Timings } from "./test-budget-reporter.js";

const N = Number(process.argv[2] ?? 10);
let t: Timings;
try {
  t = JSON.parse(readFileSync(TIMINGS_FILE, "utf8")) as Timings;
} catch {
  console.error(`no ${TIMINGS_FILE} — run \`npm test\` first`);
  process.exit(1);
}
console.log(`${t.at}  wall ${t.wallMs} ms · ${t.tests} tests · ${t.files} files`);
console.log(`\nslowest files (summed test ms):`);
for (const f of t.slowestFiles.slice(0, N)) console.log(`  ${String(f.ms).padStart(6)}  ${f.file} (${f.tests})`);
console.log(`\nslowest tests:`);
for (const x of t.slowestTests.slice(0, N)) console.log(`  ${String(x.ms).padStart(6)}  ${x.name.slice(0, 160)}`);
console.log(`\nslowest collect (import + module scope, per file):`);
// `?? []`: a timings file written before the field existed.
for (const c of (t.slowestCollect ?? []).slice(0, N)) console.log(`  ${String(c.ms).padStart(6)}  ${c.file}`);
