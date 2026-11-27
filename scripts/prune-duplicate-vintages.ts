/**
 * Prune duplicate `readings` vintages for one indicator id: keep the SERVED vintage per obs_date
 * (final before estimate, then max run_at, tie-break max id — the `readings_latest` / `readings_newest_n`
 * order since 20261003120000), delete every other row.
 * Born 2026-09-10: `seedInputSeriesOnCron` diffed NTFS's full-history fetch against a 600-date probe
 * and re-inserted the 10,633 older dates EVERY cron (2026-09-05..10 → 415k NTFS rows, 65% of the
 * table). The code fix bounds the diff (`run-seeds.ts` probeFloor); this drains the rows it left.
 * Nothing served changes: `readings_latest` already collapses to the kept row.
 *
 *   npm run prune:vintages -- --id=NTFS            (dry run: counts only)
 *   npm run prune:vintages -- --id=NTFS --apply    (deletes, then re-counts and asserts 1 row/date)
 * Loads `.env.prod` (SUPABASE_URL + SUPABASE_SERVICE_KEY). Re-runnable: a clean id deletes 0.
 */
import { createClient } from "@supabase/supabase-js";
import { POSTGREST_MAX_ROWS } from "../src/postgrest-limits.js";
import { argOf, hasFlag } from "./lib/cli.js";
import { readEnv } from "../src/config.js";
import { requireProdWrites } from "../src/prod-writes.js";

const id = argOf("id");
if (!id) throw new Error("usage: --id=<indicator_id> [--apply]");
const apply = hasFlag("apply");
const env = readEnv();
const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL + SUPABASE_SERVICE_KEY required (npm run prune:vintages loads the checkout's prod config)");
// --apply deletes: refuse first when prod writes are off (the dry run only counts).
if (apply) requireProdWrites("the vintage prune", process.env);
const client = createClient(url, key);

const PAGE = POSTGREST_MAX_ROWS; // a page shorter than the cap ends the scan
const DELETE_BATCH = 800; // ids ride the URL (`in.(…)`), keep it well under the ~16KB limit

type Row = { id: number; obs_date: string; run_at: string };
const rows: Row[] = [];
for (let offset = 0; ; offset += PAGE) {
  const { data, error } = await client
    .from("readings")
    .select("id, obs_date, run_at")
    .eq("indicator_id", id)
    .order("obs_date", { ascending: false })
    .order("estimated", { ascending: true }) // E7: a final beats any estimate (20261003120000)
    .order("run_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE - 1);
  if (error) throw new Error(`readings scan failed: ${error.message}`);
  const page = (data ?? []) as Row[];
  rows.push(...page);
  if (page.length < PAGE) break;
}
const kept = new Set<string>();
const doomed: number[] = [];
// Offset pages share no snapshot: a cron insert mid-scan shifts later rows down one, so a
// page-boundary row is read TWICE — its second copy would land in `doomed` and delete a served
// row (masked by the concurrent insert in the re-count). Inserts can only duplicate a row under
// desc offset paging, never skip one, so a primary-key dedupe closes it.
const seen = new Set<number>();
for (const r of rows) {
  if (seen.has(r.id)) continue;
  seen.add(r.id);
  if (kept.has(r.obs_date)) doomed.push(r.id);
  else kept.add(r.obs_date);
}
console.log(`[prune] ${id}: ${rows.length} rows, ${kept.size} distinct dates, ${doomed.length} duplicate vintage(s)${apply ? "" : " (dry run — pass --apply to delete)"}`);
if (!apply || doomed.length === 0) process.exit(0);

let deleted = 0;
for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
  const batch = doomed.slice(i, i + DELETE_BATCH);
  const { count, error } = await client.from("readings").delete({ count: "exact" }).eq("indicator_id", id).in("id", batch);
  if (error) throw new Error(`delete batch at ${i} failed: ${error.message}`);
  deleted += count ?? 0;
}
const { count: after, error: e2 } = await client.from("readings").select("id", { count: "exact", head: true }).eq("indicator_id", id);
if (e2) throw new Error(`re-count failed: ${e2.message}`);
console.log(`[prune] ${id}: deleted ${deleted}, ${after} row(s) remain for ${kept.size} date(s)`);
// A cron landing mid-prune can add a fresh vintage; anything else is a defect in the keep rule.
if ((after ?? 0) < kept.size) throw new Error(`[prune] ${id}: ${after} rows < ${kept.size} dates — served rows LOST`);
