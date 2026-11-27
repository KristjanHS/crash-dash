/**
 * Restore `readings` rows for named ids from a snapshot on a separate backup repo's data-only `backups` branch
 * (docs/reference.md §[dr]),
 * inserting ONLY rows the target store lacks — the surgical counterpart of the whole-table restore.
 *
 * Born 2026-09-04: a purge migration deleted ~1,800 real
 * winter-regime Friday bars on the five closes-provider `=X` ids; the pre-purge snapshot had them.
 *
 *   npm run backup:restore-rows -- --file=<readings.sql> --ids=F11,F17 [--env=local|prod]
 *        [--dow=5,6] [--skip-ghost-weeks] [--min-run-at=<iso>] [--confirm]
 *
 *   --file      the snapshot — the concatenated `readings.NNN.sql` parts (name order = id order):
 *               `git archive <backup-remote>/backups supabase/backups | tar -xO --wildcards 'supabase/backups/readings.*.sql' > /tmp/x.sql`
 *   --ids       comma-separated indicator ids to restore.
 *   --dow       restrict to these UTC weekdays of `obs_date` (0=Sun … 6=Sat); default all.
 *   --skip-ghost-weeks  skip a Fri/Sat row whose week (Sun…Sat) also holds a Sunday row for the
 *               same id in the SNAPSHOT — the `=X` summer-regime cron ghost (§2c); never re-insert it.
 *   --min-run-at  keep only snapshot rows captured at/after this `run_at` — pins the restore to one
 *               feed vintage when the snapshot mixes two (F11: FRED DEXCHUS Mon–Fri rows shadowed by the
 *               2026-08 CNY=X rebase; a FRED Friday in a summer week whose Sunday bar is a holiday gap
 *               would otherwise slip past the ghost rule).
 *   --confirm   write. Default is a dry run that prints the per-id tally and the first/last dates.
 *
 * Filters, in order: id ∈ ids · dow ∈ dow · newest `run_at` vintage per (id, obs_date) — the snapshot is
 * a SUPERSET of prod (it retains pruned vintages) · obs_date inside the target's own [first, last]
 * span for that id · (id, obs_date) absent from the target · not a ghost. Rows are inserted verbatim
 * (value/delta20/states/run_at/decision), so a restored row is the pre-loss vintage, not a re-score.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { keep } from "../../src/store-keep.js";
import { retainable } from "../../src/retention.js";

import { argOf, envArgStrict, hasFlag } from "../lib/cli.js";
import { liveResolveDeps, pullProdCreds, resolveStore } from "../backfill/resolve-store.js";
import { isoDay } from "../../src/dates.js";
import { readEnv } from "../../src/config.js";

export interface SnapshotRow {
  obs_date: string;
  indicator_id: string;
  value: string;
  delta20: string | null;
  raw_state: string;
  state: string;
  run_at: string;
  decision: string | null;
}

const COLS = ["obs_date", "indicator_id", "value", "delta20", "raw_state", "state", "run_at", "decision"] as const;
const TUPLE = /\(('(?:[^']|'')*'|NULL)(?:,('(?:[^']|'')*'|NULL)){7}\)/g;
const FIELD = /'((?:[^']|'')*)'|NULL/g;

const unquote = (lit: string): string | null => (lit === "NULL" ? null : lit.slice(1, -1).replace(/''/g, "'"));

/** Parse the dump's `INSERT … VALUES (…),(…)` tuples for the wanted ids. Column order = the dump's. */
export function parseSnapshotRows(sql: string, ids: ReadonlySet<string>): SnapshotRow[] {
  const headers = [...sql.matchAll(/INSERT INTO public\.readings \(([^)]+)\) VALUES/g)];
  if (headers.length === 0) throw new Error("restore-rows: no `INSERT INTO public.readings (…) VALUES` statement in the file");
  for (const h of headers) {
    // EVERY header, not just the first: dump.ts re-derives columns per run, so a snapshot can mix
    // 8-column pages with later 9-column (band_cuts) pages whose tuples the 8-field TUPLE regex skips.
    const cols = (h[1] ?? "").split(",");
    if (cols.join(",") !== COLS.join(",")) throw new Error(`restore-rows: column order ${cols.join(",")} ≠ expected ${COLS.join(",")}`);
  }
  const out: SnapshotRow[] = [];
  for (const m of sql.matchAll(TUPLE)) {
    const fields = [...m[0].slice(1, -1).matchAll(FIELD)].map((f) => unquote(f[0]));
    if (fields.length !== 8) continue;
    const id = fields[1] ?? null;
    if (id == null || !ids.has(id)) continue;
    const [obs_date, , value, delta20, raw_state, state, run_at, decision] = fields;
    if (obs_date == null || value == null || raw_state == null || state == null || run_at == null) continue;
    out.push({ obs_date, indicator_id: id, value, delta20: delta20 ?? null, raw_state, state, run_at, decision: decision ?? null });
  }
  return out;
}

export const dowOf = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();
const shift = (d: string, days: number): string => isoDay(new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400e3));

export interface SelectOpts {
  dow?: ReadonlySet<number>;
  skipGhostWeeks: boolean;
  minRunAt?: string;
  /** Per id: the target's stored dates (absence test) — the span filter is derived from it. */
  targetDates: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The pure selection: which snapshot rows get inserted. */
export function selectRows(rows: readonly SnapshotRow[], opts: SelectOpts): SnapshotRow[] {
  // newest run_at vintage per (id, date)
  const newest = new Map<string, SnapshotRow>();
  for (const r of rows) {
    if (opts.minRunAt && r.run_at < opts.minRunAt) continue;
    const k = `${r.indicator_id}|${r.obs_date}`;
    const cur = newest.get(k);
    if (!cur || r.run_at > cur.run_at) newest.set(k, r);
  }
  const snapDates = new Map<string, Set<string>>();
  for (const r of newest.values()) {
    if (!snapDates.has(r.indicator_id)) snapDates.set(r.indicator_id, new Set());
    snapDates.get(r.indicator_id)!.add(r.obs_date);
  }
  const span = new Map<string, [string, string]>();
  for (const [id, dates] of opts.targetDates) {
    const sorted = [...dates].sort();
    const first = sorted[0];
    const last = sorted.at(-1);
    if (first !== undefined && last !== undefined) span.set(id, [first, last]);
  }
  const out: SnapshotRow[] = [];
  for (const r of newest.values()) {
    const dow = dowOf(r.obs_date);
    if (opts.dow && !opts.dow.has(dow)) continue;
    const sp = span.get(r.indicator_id);
    if (!sp || r.obs_date < sp[0] || r.obs_date > sp[1]) continue;
    if (opts.targetDates.get(r.indicator_id)?.has(r.obs_date)) continue;
    if (opts.skipGhostWeeks && dow >= 5 && snapDates.get(r.indicator_id)?.has(shift(r.obs_date, -dow))) continue;
    out.push(r);
  }
  return out.sort((a, b) => (a.indicator_id + a.obs_date < b.indicator_id + b.obs_date ? -1 : 1));
}

async function main(): Promise<void> {
  const file = argOf("file");
  const idsArg = argOf("ids");
  if (!file || !idsArg) {
    console.log("usage: --file=<readings.sql> --ids=<id,…> [--env=local|prod] [--dow=5,6] [--skip-ghost-weeks] [--confirm]");
    process.exit(2);
  }
  const env = envArgStrict("local");
  const ids = new Set(idsArg.split(",").filter(Boolean));
  const dowArg = argOf("dow");
  const dow = dowArg ? new Set(dowArg.split(",").map(Number)) : undefined;
  const confirm = hasFlag("confirm");
  const skipGhostWeeks = hasFlag("skip-ghost-weeks");
  const minRunAt = argOf("min-run-at");

  const store = await resolveStore(env, "rw", liveResolveDeps); // cross-guards --env vs the creds in env
  const rows = parseSnapshotRows(readFileSync(file, "utf8"), ids);
  const targetDates = new Map<string, Set<string>>();
  for (const id of ids) targetDates.set(id, new Set((await store.getSeries(id, 20000)).map((p) => p.date)));
  // Out-of-store `readings` writer: apply the store's retention policy itself (`store-keep.ts`).
  const picked = keep(selectRows(rows, { dow, skipGhostWeeks, minRunAt, targetDates }), (r) => [r.indicator_id], retainable);

  console.log(`[restore-rows] ${env} · snapshot ${file} · ${rows.length} snapshot rows for ${[...ids].join(",")}`);
  for (const id of ids) {
    const mine = picked.filter((r) => r.indicator_id === id);
    const t = targetDates.get(id)!;
    console.log(
      `  ${id}: target ${t.size} dates · insert ${mine.length}` +
        (mine.length ? ` (${mine[0]?.obs_date} → ${mine.at(-1)?.obs_date})` : "") +
        ` · run_at vintages: ${[...new Set(mine.map((r) => r.run_at.slice(0, 7)))].join(" ")}`,
    );
  }
  if (!confirm) {
    console.log("[restore-rows] DRY RUN — pass --confirm to insert.");
    return;
  }
  const creds =
    env === "prod"
      ? await pullProdCreds(liveResolveDeps, "rw")
      : { url: readEnv().SUPABASE_URL!, key: readEnv().SUPABASE_SERVICE_KEY! };
  const client = createClient(creds.url, creds.key, { auth: { persistSession: false, autoRefreshToken: false } });
  let inserted = 0;
  for (let i = 0; i < picked.length; i += 500) {
    const chunk = picked.slice(i, i + 500).map((r) => ({
      obs_date: r.obs_date,
      indicator_id: r.indicator_id,
      value: Number(r.value),
      delta20: r.delta20 == null ? null : Number(r.delta20),
      raw_state: r.raw_state,
      state: r.state,
      run_at: r.run_at,
      decision: r.decision == null ? null : Number(r.decision), // double precision column, like value/delta20
    }));
    const { error } = await client.from("readings").insert(chunk);
    if (error) throw new Error(`[restore-rows] insert failed after ${inserted} rows: ${error.message}`);
    inserted += chunk.length;
  }
  console.log(`[restore-rows] inserted ${inserted} rows into ${env}.`);
}

if (process.argv[1]?.endsWith("restore-rows.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
