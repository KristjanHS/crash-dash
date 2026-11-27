/**
 * Disaster-recovery backup of the prod tables to supabase/backups/<table>.sql.
 *
 * We snapshot ALL persisted data — not just the strictly-irreplaceable `alert_log`:
 *   - `readings` IS re-derivable from public FRED/closes-provider feeds (the backfill) TODAY,
 *     but only while those feeds keep serving full free history. A feed capping depth,
 *     going keyed, or disappearing would make the deep backfill unrecoverable — so we
 *     insure it with a snapshot rather than betting DR on a third party's free tier.
 *   - `calibration` is a published vintage (re-derivable from the harness, but exact
 *     reproduction is fiddly — cheap to snapshot).
 *   - `alert_log` is the genuinely irreplaceable run history.
 *   - `readings_warmup` (CG's burned scorer head) is
 *     re-derivable by the next deep-arm cron; dumped so "ALL persisted data" stays literally true.
 * See docs/reference.md §[dr] overview for the full model + restore procedure.
 *
 * Emits plain INSERTs (id OMITTED — GENERATED ALWAYS AS IDENTITY regenerates on load),
 * one statement per keyset page (PAGE rows, per table) ordered by id ascending. Batching by id
 * range gives two properties at once: column names appear once per page instead of once
 * per row, AND — because ids are assigned in insertion order — a later dump only regrows
 * the final partial page. Full pages commit once; daily deltas stay tiny.
 *
 * Each table lands as `<table>.NNN.sql` PARTS of at most PART_BYTES, packed greedily in id order.
 * 2026-09-05: the single `readings.sql` reached 106 MB and GitHub's pre-receive hook rejected the
 * push (100 MiB hard cap per file) — the daily job had been failing on a size no code checked. The
 * greedy cut is a function of the statement PREFIX, and full pages are kept verbatim, so every part
 * but the last stays byte-identical across dumps (one git blob each; the delta story is unchanged).
 * Each part is standalone SQL; a restore loads them in name order. A statement that alone exceeds
 * the bound is refused here (`splitIntoParts`) rather than at GitHub — that is why `alert_log`, whose
 * rows carry a ~500 KB `panel_state` blob, pages at 20 rows, not 5000.
 *
 * ⚠ Full pages are append-stable, NOT immutable: the daily prune deletes shadowed vintages inside
 * them, and the kept statements retain those rows (audit SCRIPT-3). A snapshot is therefore a
 * SUPERSET of live prod, not a mirror, bounded by `compactionDue` (full re-dump once the kept rows'
 * dead fraction reaches `COMPACT_DEAD_FRACTION`) — see `resumeGuardOk` and docs/reference.md §[dr] The backup.
 *
 * Reuses the quote_nullable(col::text) literal trick from scripts/preview/dump-seed.sh
 * (generic over column type; a migration that adds a column is captured automatically).
 * Keyset pagination (WHERE id > last) bounds each Management-API response.
 *
 * Auth: the Management API SQL endpoint with a personal access token
 * (SUPABASE_ACCESS_TOKEN, or ~/.supabase/access-token locally) — no DB password needed.
 *
 *   npm run backup:data            # writes supabase/backups/{readings,alert_log,calibration,readings_warmup}.sql
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { prodProjectRef } from "../supabase-project.js";
import { readEnv, type Env } from "../../src/config.js";

const TABLES = ["readings", "alert_log", "calibration", "readings_warmup"] as const;
type Table = (typeof TABLES)[number];
const OUT_DIR = "supabase/backups";
/**
 * Rows per keyset page = rows per INSERT statement (id-aligned, stable batches). A change forces one
 * full re-dump of that table (the meta line pins the page size). readings ≈ 110 B/row → ~550 KB/page
 * (probed 2026-07-16); alert_log rows are ~25 KB since `panel_state.cissHistory` became G/A/R strings
 * (20260905150000; they were ~576 KB with full points — a 100-row page measured 49.6 MB on 2026-09-05
 * and the guard below fired, hence the interim 20) → 500 rows ≈ 12 MB/statement, 3× headroom under
 * PART_BYTES. 5000 would be one multi-GB statement.
 */
const PAGE_BY_TABLE: Record<Table, number> = { readings: 5000, alert_log: 500, calibration: 5000, readings_warmup: 5000 };
/** Max bytes of statements per snapshot file. GitHub warns at 50 MB and rejects at 100 MiB. */
export const PART_BYTES = 40 * 1024 * 1024;

async function accessToken(env: Env): Promise<string> {
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (token) return token.trim();
  return (await readFile(join(homedir(), ".supabase", "access-token"), "utf8")).trim();
}

/** Run one SQL statement via the Management API query endpoint; returns the result rows. */
async function runQuery(ref: string, token: string, query: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`[backup] Management API query failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return (await res.json()) as Array<Record<string, unknown>>;
}

/**
 * One keyset page aggregated into a single multi-row INSERT. Returns the page's max `id`
 * (cursor for the next page) and `cnt` (source rows, to detect the last page) alongside
 * the statement. `id` is excluded from the INSERT (only non-identity cols are passed);
 * each value → quote_nullable(col::text): an escaped literal that casts back to the
 * column's type on load. PG17 emits shortest round-trippable floats by default (no GUC).
 * Over an empty page the aggregate yields one row with cnt=0 / stmt=NULL → the caller stops.
 */
function pageQuery(table: string, cols: readonly string[], afterId: number, limit: number): string {
  const tuple = cols.map((c) => `quote_nullable("${c}"::text)`).join("||','||");
  return (
    `select max(id) as id, count(*) as cnt, ` +
    `'INSERT INTO public.${table} (${cols.join(",")}) VALUES ' || string_agg('('||${tuple}||')', ',' order by id) || ';' as stmt ` +
    `from (select * from public.${table} where id > ${afterId} order by id limit ${limit}) s`
  );
}

/* ---------- incremental-resume seams (pure, unit-tested in dump.test.ts) ---------- */

export interface SnapshotMeta {
  page: number;
  resumeAfterId: number; // max id of the last FULL page (ids are absent from the INSERTs — the header is the only carrier)
  rows: number;
}

export function formatMetaLine(m: SnapshotMeta): string {
  return `-- meta: page=${m.page} resume_after_id=${m.resumeAfterId} rows=${m.rows}`;
}

export function parseMetaLine(line: string): SnapshotMeta | null {
  const match = /^-- meta: page=(\d+) resume_after_id=(\d+) rows=(\d+)$/.exec(line);
  if (!match) return null;
  return { page: Number(match[1]), resumeAfterId: Number(match[2]), rows: Number(match[3]) };
}

export function splitSnapshot(content: string): { meta: SnapshotMeta | null; statements: string[] } {
  const lines = content.split("\n");
  const meta = lines.map(parseMetaLine).find((m) => m !== null) ?? null;
  const statements = lines.filter((l) => l.startsWith("INSERT INTO "));
  return { meta, statements };
}

/**
 * The count-guard verdict: may the kept pages be trusted? Two independent questions, because after
 * SCRIPT-3 relaxed the count test neither one alone is sufficient.
 *
 * `actual` — rows remaining at or below the resume point — is tested `<=`, not `==` (audit SCRIPT-3):
 * the daily prune deletes shadowed vintages BELOW the resume point, so shrinkage is expected and must
 * not void the resume.
 *
 * `maxId` — the table's GLOBAL top id — is why this is not just a count test. **Id reuse manifests as
 * SHRINKAGE, not growth**, so a count-only `<=` guard cannot see it: the emitted INSERTs omit `id`
 * (identity regenerates on load), so a restore / truncate-and-reseed restarts ids at 1. The count below
 * a prod-scale `afterId` then collapses, `<=` passes, the `id > afterId` page loop returns nothing, and
 * the snapshot freezes at its stale pages while every post-restore row goes un-backed-up indefinitely —
 * the exact scenario this script exists for. Requiring `maxId >= afterId` rejects that; a prune only
 * ever deletes rows, never lowers the top id, so the legitimate case still passes.
 *
 * A failed probe (null) is rejected too — under `<=` the old `-1` sentinel would otherwise satisfy the
 * count test.
 */
export function resumeGuardOk(g: { actual: number | null; expected: number; maxId: number | null; afterId: number }): boolean {
  const { actual, expected, maxId, afterId } = g;
  if (actual === null || maxId === null) return false;
  if (!Number.isFinite(actual) || !Number.isFinite(maxId)) return false;
  if (actual < 0 || actual > expected) return false;
  return maxId >= afterId;
}

/**
 * Dead-row fraction of the kept pages at which a resume is abandoned for a full re-dump (A5).
 * Hand-set: a restate week measured 34 % (2026-09-05), the
 * organic daily prune ~6 % — never restate it in a test fixture.
 */
export const COMPACT_DEAD_FRACTION = 0.25;

/**
 * Compaction verdict, evaluated only after `resumeGuardOk` passed: `expected − actual` is the count
 * of rows the kept pages still carry that prod has pruned (a restate inserts a fresh full history
 * under new ids and the self-prune deletes the shadowed one — inside locked pages). Full re-dumping
 * once that dead weight passes the fraction is what bounds the snapshot (the sawtooth), so a
 * `BACKUP_FULL=1` is never owed after a restate batch. Returns the dead count when due, else null.
 */
export function compactionDue(g: { actual: number; expected: number }, fraction = COMPACT_DEAD_FRACTION): number | null {
  if (g.expected <= 0) return null;
  const dead = g.expected - g.actual;
  return dead / g.expected >= fraction ? dead : null;
}

export type ResumePlan =
  | { full: true; reason: string }
  | { full: false; afterId: number; fullPages: number; keep: string[] };

/**
 * Decide whether a previous snapshot can seed an incremental dump. Full pages are append-stable —
 * ids are monotonic and rows are never UPDATEd — so we keep them verbatim and drop only the trailing
 * partial statement (it regrows).
 *
 * Rows below `afterId` CAN disappear: the daily prune deletes shadowed `readings` vintages, which are
 * old rows and therefore live inside the kept range. That is why the caller's count-guard is
 * `count(id<=afterId) <= fullPages*page` and not `==` (audit SCRIPT-3, ruled 2026-07-20) — an `==`
 * guard voided the plan after every prune and forced a full re-dump of ~118k rows daily.
 *
 * ⚠ Consequence, accepted deliberately: the kept statements still carry the pruned rows, so a resumed
 * snapshot is a SUPERSET of live prod, not a mirror, and a restore resurrects pruned vintages. For an
 * irreplaceable audit trail that is the safer direction, but it is a real semantic — see
 * `docs/reference.md` §[dr] What the live write path deletes.
 */
export function planResume(content: string, currentPage: number): ResumePlan {
  const { meta, statements } = splitSnapshot(content);
  if (!meta) return { full: true, reason: "no meta line (pre-incremental snapshot)" };
  if (meta.page !== currentPage) return { full: true, reason: `page size changed ${meta.page} -> ${currentPage}` };
  const fullPages = Math.floor(meta.rows / meta.page);
  if (statements.length < fullPages) return { full: true, reason: "statement count below full-page count" };
  const keep = statements.slice(0, fullPages);
  // Integrity guard on the kept statements themselves — the count-guard validates the DB,
  // not the file. A truncated restore or a future multi-line value (newline in a free-text
  // column) would otherwise self-perpetuate in the DR snapshot silently forever.
  if (keep.some((s) => !s.endsWith(";"))) return { full: true, reason: "malformed kept statement (truncated or multi-line)" };
  return { full: false, afterId: meta.resumeAfterId, fullPages, keep };
}

/* ---------- part files (pure, unit-tested in dump.test.ts) ---------- */

export function partFileName(table: string, index: number): string {
  return `${table}.${String(index).padStart(3, "0")}.sql`;
}

/** This table's part files among `names`, in numeric order. The legacy single `<table>.sql` is not a part. */
export function snapshotPartFiles(names: readonly string[], table: string): string[] {
  const re = new RegExp(`^${table}\\.(\\d{3})\\.sql$`);
  return names
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.n);
}

/**
 * Greedy in-order packing of statements into parts of at most `maxBytes` (statement bytes + one
 * newline each). Boundaries depend only on the prefix, so appending statements never moves an
 * earlier cut. Always yields at least one part (the header rides on part 000). A single statement
 * over the bound is refused: a part is only bounded if its statements are.
 */
export function splitIntoParts(statements: readonly string[], maxBytes: number): string[][] {
  const parts: string[][] = [[]];
  let used = 0;
  for (const s of statements) {
    const bytes = Buffer.byteLength(s, "utf8") + 1;
    if (bytes > maxBytes) {
      throw new Error(
        `[backup] one INSERT statement is ${bytes} bytes, over the ${maxBytes}-byte part bound — lower that table's PAGE in PAGE_BY_TABLE`,
      );
    }
    if (used + bytes > maxBytes && parts[parts.length - 1]!.length > 0) {
      parts.push([]);
      used = 0;
    }
    parts[parts.length - 1]!.push(s);
    used += bytes;
  }
  return parts;
}

/** Files of this table to delete after a write: the legacy single file and any part beyond the new set. */
export function staleSnapshotFiles(names: readonly string[], table: string, keep: readonly string[]): string[] {
  const kept = new Set(keep);
  const legacy = `${table}.sql`;
  return names.filter((n) => (n === legacy || snapshotPartFiles([n], table).length === 1) && !kept.has(n));
}

export type TableLogEvent =
  | { kind: "compaction"; dead: number; expected: number }
  | { kind: "resume"; afterId: number; fullPages: number; pruned: number }
  | { kind: "rejected"; why: string }
  | { kind: "wrote"; rows: number; parts: number; secs: string };

/** Per-table progress line. `ci` (a public Actions log) gets no numbers: counts/ids would publish prod data volume. */
export function tableLogLine(table: string, ev: TableLogEvent, ci: boolean): string {
  switch (ev.kind) {
    case "compaction":
      return ci
        ? `[backup] ${table}: compaction — full re-dump`
        : `[backup] ${table}: compaction — ${ev.dead} of the ${ev.expected} kept-page rows are pruned in prod (≥ ${COMPACT_DEAD_FRACTION * 100}%) — full re-dump`;
    case "resume": {
      if (ci) return `[backup] ${table}: resuming from the kept full pages`;
      // Surfaced, not swallowed: the snapshot now knowingly holds rows prod no longer has.
      const note = ev.pruned > 0 ? `, ${ev.pruned} row(s) pruned in prod but retained in the snapshot` : "";
      return `[backup] ${table}: resuming after id ${ev.afterId} (${ev.fullPages} full pages kept${note})`;
    }
    case "rejected":
      return ci ? `[backup] ${table}: resume guard rejected — full re-dump` : `[backup] ${table}: resume guard rejected (${ev.why}) — full re-dump`;
    case "wrote":
      return ci
        ? `[backup] wrote ${table}`
        : `[backup] wrote ${OUT_DIR}/${table}.{000..${String(ev.parts - 1).padStart(3, "0")}}.sql — ${ev.rows} row(s), ${ev.parts} part(s), ${ev.secs}s`;
  }
}

/* ---------------------------------------------------------------------------------- */

/** The previous snapshot's text: concatenated parts, else the legacy single file, else null. */
async function readSnapshot(names: readonly string[], table: string): Promise<string | null> {
  const parts = snapshotPartFiles(names, table);
  if (parts.length > 0) {
    // A missing middle part would read as a shorter statement list, which the `<=` count-guard
    // cannot distinguish from a prune — refuse to resume on a numbering gap (full dump instead).
    if (parts.some((n, i) => n !== partFileName(table, i))) {
      console.log(`[backup] ${table}: part numbering has a gap (${parts.join(", ")}) — full dump`);
      return null;
    }
    const texts = await Promise.all(parts.map((n) => readFile(join(OUT_DIR, n), "utf8")));
    return texts.join("\n");
  }
  return readFile(join(OUT_DIR, `${table}.sql`), "utf8").catch(() => null);
}

async function nonIdentityCols(ref: string, token: string, table: string): Promise<string[]> {
  const rows = await runQuery(
    ref,
    token,
    `select column_name from information_schema.columns ` +
      `where table_schema='public' and table_name='${table}' and is_identity='NO' order by ordinal_position`,
  );
  return rows.map((r) => String(r.column_name));
}

/** Dump one table to OUT_DIR/<table>.NNN.sql parts; returns the row count written and the part count. */
export async function dumpTable(ref: string, token: string, table: Table): Promise<{ rows: number; parts: number }> {
  const PAGE = PAGE_BY_TABLE[table];
  const ci = process.env.GITHUB_ACTIONS === "true";
  const cols = await nonIdentityCols(ref, token, table);
  if (cols.length === 0) throw new Error(`[backup] ${table}: no non-identity columns — wrong project ref?`);

  let statements: string[] = [];
  let rowCount = 0;
  let afterId = 0;
  let lastFullAfterId = 0; // resume_after_id for the header meta line

  // Incremental resume: seed from the previous snapshot's full pages when it parses and the
  // count-guard finds no MORE rows below resume_after_id than the kept pages already hold.
  // BACKUP_FULL=1 skips the resume: the prompt way to SHRINK a snapshot after a prod purge (`compactionDue`
  // below is the other, once the dead fraction is high enough), since a
  // resumed snapshot retains every pruned row by design (SCRIPT-3).
  const dirNames = await readdir(OUT_DIR);
  const existing = process.env.BACKUP_FULL ? null : await readSnapshot(dirNames, table);
  if (process.env.BACKUP_FULL) console.log(`[backup] ${table}: full dump — BACKUP_FULL set`);
  if (existing !== null) {
    const plan = planResume(existing, PAGE);
    if (plan.full) {
      console.log(`[backup] ${table}: full dump — ${plan.reason}`);
    } else if (plan.fullPages === 0) {
      // Small table (rows < PAGE): resume degenerates to a full dump anyway — skip the count-guard query.
    } else {
      const expected = plan.fullPages * PAGE;
      // max(id) rides along in the SAME query — it costs no extra round-trip and it is what catches a
      // restore/truncate-and-reseed, which the count test alone reads as ordinary prune shrinkage.
      // `top` is the table's GLOBAL max id, deliberately NOT scoped to `id <= afterId`: a prune can
      // delete the boundary row itself, so the windowed max would dip below afterId on a perfectly
      // legitimate prune and reject it. The global top only moves backwards on a reseed.
      const guard = await runQuery(
        ref,
        token,
        `select (select count(*) from public.${table} where id <= ${plan.afterId}) as cnt, ` +
          `(select coalesce(max(id), 0) from public.${table}) as top`,
      );
      // `== null` means the guard query returned nothing — a failed probe, not an empty table
      // (count(*) always yields a row). The old `=== expected` test rejected that for free; under `<=`
      // a -1 sentinel would SATISFY the count test, so resumeGuardOk rejects it explicitly.
      const raw = guard[0]?.cnt;
      const rawTop = guard[0]?.top;
      const actual = raw == null ? null : Number(raw);
      const maxId = rawTop == null ? null : Number(rawTop);
      const dead = actual === null ? null : compactionDue({ actual, expected });
      if (dead !== null && resumeGuardOk({ actual, expected, maxId, afterId: plan.afterId })) {
        console.log(tableLogLine(table, { kind: "compaction", dead, expected }, ci));
      } else if (resumeGuardOk({ actual, expected, maxId, afterId: plan.afterId })) {
        statements = plan.keep;
        rowCount = expected;
        afterId = plan.afterId;
        lastFullAfterId = plan.afterId;
        const pruned = expected - (actual ?? expected);
        console.log(tableLogLine(table, { kind: "resume", afterId: plan.afterId, fullPages: plan.fullPages, pruned }, ci));
      } else {
        const why =
          actual === null || maxId === null
            ? "guard query returned no result"
            : maxId < plan.afterId
              ? `top id ${maxId} is below the resume point ${plan.afterId} — ids were reseeded (restore/truncate), not pruned`
              : `${actual} rows below id ${plan.afterId}, more than the ${expected} the kept pages hold`;
        console.log(tableLogLine(table, { kind: "rejected", why }, ci));
      }
    }
  }

  for (;;) {
    const page = (await runQuery(ref, token, pageQuery(table, cols, afterId, PAGE)))[0];
    const cnt = Number(page?.cnt ?? 0);
    if (cnt === 0) break;
    statements.push(String(page!.stmt));
    rowCount += cnt;
    afterId = Number(page!.id);
    if (cnt < PAGE) break;
    lastFullAfterId = afterId;
  }

  const parts = splitIntoParts(statements, PART_BYTES);
  const names = parts.map((_, i) => partFileName(table, i));
  const header = (i: number) =>
    i === 0
      ? [
          `-- Disaster-recovery snapshot of prod public.${table} (part 000 of ${names.length}; parts load in name order, each standalone SQL).`,
          `-- Generated by scripts/backup/dump.ts (npm run backup:data). Restore: docs/reference.md §[dr] Restore procedure.`,
          `-- id omitted (GENERATED ALWAYS → regenerates on load). ${PAGE} rows/statement, id-aligned. Rows: ${rowCount}.`,
          `-- May be a SUPERSET of prod: resumed pages retain rows since pruned upstream. Restoring resurrects them.`,
          formatMetaLine({ page: PAGE, resumeAfterId: lastFullAfterId, rows: rowCount }),
          "",
        ].join("\n")
      : // No part count here: a new part being born must not rewrite every earlier part's blob.
        `-- Disaster-recovery snapshot of prod public.${table} (part ${String(i).padStart(3, "0")}; header + meta line in ${names[0]}).\n\n`;
  await Promise.all(parts.map((p, i) => writeFile(join(OUT_DIR, names[i]!), header(i) + p.join("\n") + "\n")));
  // A shrunk full re-dump or the legacy single file would otherwise linger and double-load on restore.
  await Promise.all(staleSnapshotFiles(dirNames, table, names).map((n) => rm(join(OUT_DIR, n))));
  return { rows: rowCount, parts: names.length };
}

export async function main(): Promise<number> {
  const env = readEnv();
  const ref = prodProjectRef(env);
  const token = await accessToken(env);
  if (!token) throw new Error("[backup] no access token (SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token)");

  await mkdir(OUT_DIR, { recursive: true });
  const ci = process.env.GITHUB_ACTIONS === "true";
  for (const table of TABLES) {
    const t0 = Date.now();
    const { rows, parts } = await dumpTable(ref, token, table);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(tableLogLine(table, { kind: "wrote", rows, parts, secs }, ci));
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Message only: a stack/cause can carry request bodies or prod row data into public CI logs.
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
