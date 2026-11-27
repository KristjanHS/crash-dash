/**
 * CLI entry only — nothing imports this file (its re-exports were retired 2026-10-25).
 * The run loop lives in:
 *   run-core.ts  — the pure, IO-free layer (assembleRun + forward walk)
 *   run-seeds.ts — post-persist backfill/seed tail + clock seam
 *   run-cycle.ts — the IO shell (fetch → assemble → push → persist → tail seeds)
 *
 * Run: npm start  (tsx src/run.ts)
 */

import { pathToFileURL } from "node:url";

import { runScoringCycle } from "./run-cycle.js";
import { wallClock } from "./run-seeds.js";
import { isIntradayCronRun } from "./intraday.js";
import { readEnv } from "./config.js";

// CLI entry — only when run directly (`tsx src/run.ts`), not when imported by
// the Vercel cron function. import.meta.url matches argv[1] only on direct exec.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runScoringCycle(wallClock, { env: readEnv(), intraday: isIntradayCronRun(new Date()) }).catch((err: unknown) => {
    console.error("crash-dash run failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
