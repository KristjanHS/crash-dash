/**
 * Re-derive EOD verdicts over the now-served official closes (the cron does only the newest date).
 *   npm run rederive -- --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--apply] [--env=prod]
 * Dry-run by default: one line per original row. `--apply` writes through `applyRederive` (the cron's idempotent path).
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { argOf, envArgStrict, hasFlag } from "./lib/cli.js";
import { applyRederive, rederiveRun, servedWithOriginals } from "../src/rederive.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const from = argOf("from");
const to = argOf("to") ?? "9999-12-31";
if (from === undefined || !ISO.test(from) || (argOf("to") !== undefined && !ISO.test(to))) {
  console.log("ABORT: --from=YYYY-MM-DD is required (--to optional, same format).");
  process.exit(1);
}
const env = envArgStrict("local");
if (env === "local") {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // no .env.local: resolveStore fails loud below
  }
}
const apply = hasFlag("apply");
const store = await resolveStore(env, "rw", liveResolveDeps);
// `getRecentAlerts` counts fired-dates; a calendar-day span bounds it (+7 for the weekend/holiday slack).
const limit = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 7;
const rows = (await servedWithOriginals(store, limit)).filter(({ orig }) => orig.date >= from && orig.date <= to).reverse();
const band = (a: { level: string; dialBand: string | null }) => `${a.level}/${a.dialBand ?? "-"}`;
let changed = 0;
let failed = 0;
for (const { served, orig } of rows) {
  try {
    if (apply) {
      const { row, removed, unverifiable } = await applyRederive(store, orig);
      if (row !== null) changed++;
      const outcome = unverifiable !== undefined ? `UNVERIFIABLE, left as served (${unverifiable})` : row === null ? "unchanged" : band(row);
      console.log(`${orig.date}  ${band(orig)} → ${outcome}${removed > 0 ? ` (replaced ${removed})` : ""}`);
    } else {
      const out = await rederiveRun(store, orig);
      if (out.kind === "superseded") changed++;
      const stale = served !== orig && out.kind === "agree" ? " (stale superseding row would be removed)" : "";
      const outcome = out.kind === "unverifiable" ? `UNVERIFIABLE, would be left as served (${out.reason})` : out.kind === "agree" ? "unchanged" : band(out.alert);
      console.log(`${orig.date}  ${band(orig)} → ${outcome}${stale}`);
    }
  } catch (err) {
    failed++;
    console.log(`${orig.date}  ERROR  ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`${rows.length} original row(s), ${changed} re-derived${apply ? " (written)" : " — dry-run, pass --apply to write"}, ${failed} failed on the ${env} store`);
if (failed > 0) process.exit(1);
