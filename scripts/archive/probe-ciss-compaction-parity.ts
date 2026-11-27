/**
 * CISS-compaction parity probe — proves the
 * destructive `20260905150000_alert_log_compact_ciss_history.sql` rewrite preserved EVERY persisted
 * close: for each `alert_log` row present in a PRE-migration `backups`-branch snapshot (full-point
 * `cissHistory`, one object per close) AND in prod (one G/A/R string per id), the two decode to the
 * same `MemberHistoryEntry[]`. Also the byte ceiling: the newest prod row's `cissHistory` must be
 * under `CISS_BYTES_CEILING` (plan target ≈ 4 KB; measured 4,484 B on row 440 the day it shipped).
 *
 *   npm run probe:ciss-parity -- --file=<alert_log.sql> [--env=prod]
 *
 *   --file   the pre-migration snapshot — the LAST legacy-shaped `alert_log.sql` on the backups
 *            branch is commit 0d05bc6d (2026-09-04 03:01 +0300, 422 rows):
 *            `git show 0d05bc6d:supabase/backups/alert_log.sql > /tmp/alert_log.sql`
 *
 * Rows are keyed by `fired_at` (the dump omits `id`; one cron run = one `fired_at`). Rows fired AFTER
 * the snapshot are expected in prod only (written compact by the new code) and are checked for shape
 * + decodability, never parity. A snapshot row ABSENT from prod is a FAIL (nothing prunes alert_log).
 *
 * The snapshot side decodes with its OWN legacy reader (`legacyStates`) rather than the Stage 2
 * branch of `decodeCissHistory`, so this probe outlives that branch's deletion and its verdict does
 * not depend on the code under test reading its own old shape.
 *
 * Exit 1 on ANY differing row, any snapshot row missing from prod, any prod row still legacy-shaped
 * or undecodable, or a byte ceiling breach. Falsifier demo: run against a snapshot whose tuple was
 * hand-edited (flip one `"state": "RED"` → `"AMBER"`) → `FAIL … 1 row differs`.
 */
import { readFileSync } from "node:fs";
import { decodeCissHistory } from "../src/store-rows.js";
import type { PersistedCissEntry } from "../src/store-rows.js";
import type { MemberHistoryEntry } from "../src/danger-engine.js";
import { pullProdCreds, liveResolveDeps } from "./backfill/resolve-store.js";
import { argOf, envArgStrict } from "./lib/cli.js";

/** The ceiling — "expect `ciss` < 8,000"
 *  (2× the ≈4 KB target, 100× under the 576 KB it replaced). */
export const CISS_BYTES_CEILING = 8_000;

/** Pre-migration wire shape: full `SeriesPoint`s; only `state` is load-bearing
 * . */
type LegacyCissEntry = { id: string; history: Array<{ state?: unknown }> };

export interface SnapshotAlertRow {
  fired_at: string; // normalised ISO (see `normTs`)
  panel_state: string | null; // raw jsonb text
}

/* ---------- pure seams ---------- */

/** `quote_nullable(col::text)` timestamptz (`2026-09-05 09:06:25.108+00`) and PostgREST
 *  (`2026-09-05T09:06:25.108+00:00`) → one comparable ISO string. */
export function normTs(raw: string): string {
  let s = raw.trim().replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s = `${s}:00`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`probe-ciss-parity: unparseable timestamp ${JSON.stringify(raw)}`);
  return new Date(ms).toISOString();
}

/** Scan the dump's `INSERT INTO public.alert_log (cols) VALUES (…),(…);` statement(s) into
 *  `{fired_at, panel_state}` rows. A char-level scanner (not a regex): the jsonb literal holds
 *  commas, parens and `''`-escaped quotes, and the column list is 50+ wide and dump-derived. */
export function parseAlertLogSnapshot(sql: string): SnapshotAlertRow[] {
  const out: SnapshotAlertRow[] = [];
  const HEADER = /INSERT INTO public\.alert_log \(([^)]+)\) VALUES /g;
  let h: RegExpExecArray | null;
  let seen = 0;
  while ((h = HEADER.exec(sql)) !== null) {
    seen++;
    const cols = (h[1] ?? "").split(",");
    const iFired = cols.indexOf("fired_at");
    const iPanel = cols.indexOf("panel_state");
    if (iFired < 0 || iPanel < 0) throw new Error(`probe-ciss-parity: header lacks fired_at/panel_state: ${cols.join(",")}`);
    let i = HEADER.lastIndex;
    // tuples: '(' field (',' field)* ')' [',' | ';']
    for (;;) {
      if (sql[i] !== "(") throw new Error(`probe-ciss-parity: expected '(' at ${i}`);
      i++;
      const fields: (string | null)[] = [];
      for (;;) {
        if (sql.startsWith("NULL", i)) {
          fields.push(null);
          i += 4;
        } else if (sql[i] === "'") {
          let j = i + 1;
          let buf = "";
          for (;;) {
            const q = sql.indexOf("'", j);
            if (q < 0) throw new Error(`probe-ciss-parity: unterminated literal at ${i}`);
            buf += sql.slice(j, q);
            if (sql[q + 1] === "'") {
              buf += "'";
              j = q + 2;
            } else {
              j = q + 1;
              break;
            }
          }
          fields.push(buf);
          i = j;
        } else {
          throw new Error(`probe-ciss-parity: unexpected char ${JSON.stringify(sql[i])} at ${i}`);
        }
        if (sql[i] === ",") {
          i++;
          continue;
        }
        if (sql[i] === ")") {
          i++;
          break;
        }
        throw new Error(`probe-ciss-parity: expected ',' or ')' at ${i}`);
      }
      if (fields.length !== cols.length) throw new Error(`probe-ciss-parity: tuple has ${fields.length} fields, header ${cols.length}`);
      const fired = fields[iFired];
      if (fired == null) throw new Error("probe-ciss-parity: NULL fired_at in snapshot");
      out.push({ fired_at: normTs(fired), panel_state: fields[iPanel] ?? null });
      if (sql[i] === ",") {
        i++;
        continue;
      }
      if (sql[i] === ";") break;
      throw new Error(`probe-ciss-parity: expected ',' or ';' after tuple at ${i}`);
    }
  }
  if (seen === 0) throw new Error("probe-ciss-parity: no `INSERT INTO public.alert_log (…) VALUES` statement in the file");
  return out;
}

/** The snapshot's own reader: keep ONLY `state`, exactly what the Stage 2 branch did. Throws on a
 *  point without a string state (the migration mapped those to `?`, which prod's decode rejects). */
export function legacyStates(entries: readonly LegacyCissEntry[]): MemberHistoryEntry[] {
  return entries.map((e) => ({
    id: e.id,
    history: e.history.map((p) => {
      if (typeof p.state !== "string") throw new Error(`legacy point without state on ${e.id}`);
      return { state: p.state as MemberHistoryEntry["history"][number]["state"] };
    }),
  }));
}

export interface ProdAlertRow {
  fired_at: string; // normalised ISO
  panel_state: { cissHistory?: unknown } | null;
}

export interface ParityReport {
  snapshotRows: number;
  snapshotWithPanel: number;
  prodRows: number;
  compared: number;
  equal: number;
  differing: Array<{ fired_at: string; reason: string }>;
  missingFromProd: string[];
  prodOnly: number;
  prodBad: Array<{ fired_at: string; reason: string }>; // legacy-shaped or undecodable prod rows
}

const isCompact = (ch: unknown): ch is PersistedCissEntry[] =>
  Array.isArray(ch) && ch.every((e) => e !== null && typeof e === "object" && typeof (e as { states?: unknown }).states === "string");

export function compareRows(snapshot: readonly SnapshotAlertRow[], prod: readonly ProdAlertRow[]): ParityReport {
  const byFired = new Map(prod.map((r) => [r.fired_at, r]));
  const rep: ParityReport = {
    snapshotRows: snapshot.length,
    snapshotWithPanel: 0,
    prodRows: prod.length,
    compared: 0,
    equal: 0,
    differing: [],
    missingFromProd: [],
    prodOnly: 0,
    prodBad: [],
  };
  const snapKeys = new Set<string>();
  for (const s of snapshot) {
    snapKeys.add(s.fired_at);
    const p = byFired.get(s.fired_at);
    if (!p) {
      rep.missingFromProd.push(s.fired_at);
      continue;
    }
    if (s.panel_state == null) {
      if (p.panel_state != null) rep.differing.push({ fired_at: s.fired_at, reason: "snapshot panel_state NULL, prod non-null" });
      continue;
    }
    rep.snapshotWithPanel++;
    const legacy = (JSON.parse(s.panel_state) as { cissHistory?: unknown }).cissHistory;
    const compact = p.panel_state?.cissHistory;
    rep.compared++;
    try {
      const a = JSON.stringify(legacyStates(legacy as LegacyCissEntry[]));
      if (!isCompact(compact)) throw new Error("prod cissHistory is not the compact {id,states}[] shape");
      const b = JSON.stringify(decodeCissHistory(compact));
      if (a === b) rep.equal++;
      else rep.differing.push({ fired_at: s.fired_at, reason: firstDiff(legacy as LegacyCissEntry[], compact) });
    } catch (e) {
      rep.differing.push({ fired_at: s.fired_at, reason: (e as Error).message });
    }
  }
  for (const p of prod) {
    if (snapKeys.has(p.fired_at)) continue;
    rep.prodOnly++;
    const ch = p.panel_state?.cissHistory;
    if (ch === undefined || p.panel_state === null) continue; // no-panel run — nothing to check
    if (!isCompact(ch)) {
      rep.prodBad.push({ fired_at: p.fired_at, reason: "not compact {id,states}[]" });
      continue;
    }
    try {
      decodeCissHistory(ch);
    } catch (e) {
      rep.prodBad.push({ fired_at: p.fired_at, reason: (e as Error).message });
    }
  }
  return rep;
}

function firstDiff(legacy: readonly LegacyCissEntry[], compact: readonly PersistedCissEntry[]): string {
  if (legacy.length !== compact.length) return `id count ${legacy.length} vs ${compact.length}`;
  for (let k = 0; k < legacy.length; k++) {
    const l = legacy[k]!;
    const c = compact[k]!;
    if (l.id !== c.id) return `id order: ${l.id} vs ${c.id} at index ${k}`;
    if (l.history.length !== c.states.length) return `${l.id}: ${l.history.length} points vs ${c.states.length} chars`;
    for (let j = 0; j < c.states.length; j++) {
      const ls = String(l.history[j]?.state ?? "?")[0];
      if (ls !== c.states[j]) return `${l.id}[${j}]: ${String(l.history[j]?.state)} vs '${c.states[j]}'`;
    }
  }
  return "decoded JSON differs (no positional diff found)";
}

/* ---------- IO ---------- */

/** Wide read of every alert_log row, oldest first, paged by id. Service-role key over REST, read-only. */
async function fetchProdRows(): Promise<ProdAlertRow[]> {
  const { url, key } = await pullProdCreds(liveResolveDeps);
  console.log(`host: ${new URL(url).host}`);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const PAGE = 100; // ≈ 22 KB/row post-compaction → ≈ 2 MB/page
  const out: ProdAlertRow[] = [];
  let afterId = 0;
  for (;;) {
    const res = await fetch(`${url}/rest/v1/alert_log?select=id,fired_at,panel_state&id=gt.${afterId}&order=id.asc&limit=${PAGE}`, {
      headers,
    });
    if (!res.ok) throw new Error(`alert_log read failed: ${res.status} ${res.statusText}`);
    const page = (await res.json()) as Array<{ id: number; fired_at: string; panel_state: ProdAlertRow["panel_state"] }>;
    for (const r of page) out.push({ fired_at: normTs(r.fired_at), panel_state: r.panel_state });
    if (page.length < PAGE) break;
    afterId = page[page.length - 1]!.id;
  }
  return out;
}

async function main(): Promise<void> {
  const env = envArgStrict("prod");
  if (env !== "prod") {
    console.log("ABORT: --env=local has no alert_log cron history to assert against — this is a PROD falsifier.");
    process.exit(1);
  }
  const file = argOf("file");
  if (!file) {
    console.log("ABORT: --file=<pre-migration alert_log.sql> is required (see the docblock for the git show command).");
    process.exit(1);
  }
  const snapshot = parseAlertLogSnapshot(readFileSync(file, "utf8"));
  const prod = await fetchProdRows();
  const rep = compareRows(snapshot, prod);

  const newest = prod[prod.length - 1];
  const cissBytes = newest?.panel_state?.cissHistory === undefined ? null : JSON.stringify(newest.panel_state.cissHistory).length;
  const panelBytes = newest?.panel_state == null ? null : JSON.stringify(newest.panel_state).length;

  console.log(`snapshot rows: ${rep.snapshotRows} (${rep.snapshotWithPanel} with a panel) · prod rows: ${rep.prodRows} · prod-only (post-snapshot): ${rep.prodOnly}`);
  console.log(`compared: ${rep.compared} · equal: ${rep.equal} · differing: ${rep.differing.length} · snapshot rows missing from prod: ${rep.missingFromProd.length} · prod rows bad: ${rep.prodBad.length}`);
  for (const d of rep.differing.slice(0, 10)) console.log(`  DIFF ${d.fired_at}: ${d.reason}`);
  for (const m of rep.missingFromProd.slice(0, 10)) console.log(`  MISSING ${m}`);
  for (const b of rep.prodBad.slice(0, 10)) console.log(`  BAD ${b.fired_at}: ${b.reason}`);
  console.log(`newest row (${newest?.fired_at ?? "none"}): cissHistory ${cissBytes ?? "n/a"} B (ceiling ${CISS_BYTES_CEILING}) · panel_state ${panelBytes ?? "n/a"} B`);

  const ceilingOk = cissBytes !== null && cissBytes < CISS_BYTES_CEILING;
  const pass = rep.compared > 0 && rep.differing.length === 0 && rep.missingFromProd.length === 0 && rep.prodBad.length === 0 && ceilingOk;
  console.log(`VERDICT: ${pass ? "PASS" : "FAIL"}${ceilingOk ? "" : " (byte ceiling)"}${rep.compared === 0 ? " (nothing compared — vacuous)" : ""}`);
  process.exit(pass ? 0 : 1);
}

const isDirect = process.argv[1]?.endsWith("probe-ciss-compaction-parity.ts") === true;
if (isDirect) {
  await main();
}
