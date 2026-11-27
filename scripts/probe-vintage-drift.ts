/**
 * Vintage-drift detector — diffs the CODE's per-indicator scorer vintage
 * (`codeVintages()`: config hash + `logicVersion`, src/scorer-vintage.ts) against the
 * STORED `scorer_vintage` table and names what a deploy owes a restate on the two axes
 * ruling 1 scopes it to — the registry entry's config hash and `logicVersion`
 * (A1, rulings 1 + 4).
 *
 * NOT A VINTAGE AXIS (stated, not detected): the calibration vintage `make ship` §5b
 * publishes before the deploy. Scorers read those published params at run time, so a
 * calibration republish can move scored state under a byte-identical hash — that path
 * owes its own restate decision (the §5b step's `stale`/`published` outcome is the cue).
 *
 *   npm run probe:vintage-drift -- --env=prod                 # read-only diff (default)
 *   npm run probe:vintage-drift -- --env=prod --applied=<f>   # + drift-by-decree from migrations
 *   npm run probe:vintage-drift -- --env=prod --stamp         # upsert current vintage, all ids
 *   npm run probe:vintage-drift -- --env=prod --stamp=F9,F11  # …named subset only
 * The read-only diff defaults to prod (the table only exists there); `--stamp` WRITES and
 * refuses an implicit env — every other probe defaults local, and a bare `--stamp` upserting
 * prod would mask the next ship's drift (the failure this probe exists to catch).
 *
 * CALLED BY `scripts/ship.sh` post-deploy (Stage 7): after the prod smoke gate, before the
 * push — exit 1 makes ship auto-run the printed `bash scripts/restate-prod.sh <ids>` line, `--stamp` the
 * restated ids, and re-check; a `DRIFT-NORESTATE` id aborts the release.
 *
 * OUTPUT CONTRACT (ship.sh parses these prefixes — keep them exact):
 *   `DRIFT <id> config <old>→<new> | logic v<old>→v<new>`   restatable hash/logic drift
 *   `DRIFT <id> by-migration <basename>`                    drift-by-decree (`--applied`)
 *   `DRIFT-NORESTATE <id> …`                                same two shapes, id has NO
 *       backfill spec (ruling 4b): neither `backfillAll` nor `backfillDownsideBreaks`
 *       accepts it, so the restate would throw — ship must die naming it instead.
 *   `STAMP-ONLY <id>`                                       code id with no stored row
 *   `bash scripts/restate-prod.sh <id,id,…>`                exactly once, iff any
 *       restatable drift — comma-joined, the script's own argument form.
 * Exit 1 on ANY drift (restatable or NORESTATE); 0 when clean or stamp-only.
 *
 * FIRST-DEPLOY RULE (ruling 1, pinned in the test): a code id with NO stored row is
 * `STAMP-ONLY`, never drift — an empty/partial table (first ship, new indicator) must
 * not restate everything. `--stamp` is the seed: upsert the current code vintage
 * (all ids, or the named subset), print `STAMPED <n>`, exit 0, no diff. The default
 * run is READ-ONLY — `--stamp` is the only write path.
 *
 * `--applied=<manifest>` — a newline list of migration file paths (ship's migrate step
 * writes it). Each existing file's HEAD comment block is scanned for `-- restate: <id,…>`
 * (case-insensitive on `restate`, tolerant of spaces around the colon/commas); the ids
 * union into the drift set as drift-by-decree, hash-clean or not — a purge migration
 * auto-enqueues its paired restate. A listed path that doesn't exist is skipped with a
 * `WARN` line, never a crash.
 *
 * TABLE-ABSENT (pre-ship): before Stage 8's migration lands, the prod read errors with
 * a missing-relation message — treated as "table absent — pre-ship; every id is
 * STAMP-ONLY", exit 0, with a `TABLE-ABSENT` line saying so.
 *
 * KNOWN LIMITATION (accepted): a
 * prod cron firing in the deploy→detector window (~1–2 min) would stamp the new vintage before the detector
 * reads it, masking one drift. Accepted — deploys happen only via `make ship`, and the ad-hoc probe plus the
 * next retune's detector run bound the exposure.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { codeVintages, diffVintages } from "../src/scorer-vintage.js";
import type { ScorerVintageRow, Store } from "../src/store.js";
import { restatableIds } from "./backfill.js";
import { argOf, envArgStrict, hasFlag } from "./lib/cli.js";

/** The two seams the probe touches — lets the test drive an `InMemoryStore` (or a stub). The write seam is
 *  optional: only `--stamp` writes, so the plain diff runs on a `getStore("ro")` handle that has none. */
export type VintageStore = Pick<Store, "getScorerVintages"> & Partial<Pick<Store, "recordScorerVintage">>;

export interface VintageDriftOpts {
  /** `--applied=<file>`: manifest of just-applied migration paths (drift-by-decree). */
  applied?: string;
  /** `--stamp` / `--stamp=<id,…>`: upsert the code vintage and exit — the ONLY write path. */
  stamp?: "all" | readonly string[];
  now?: Date;
}

export interface VintageDriftResult {
  exitCode: 0 | 1;
  lines: string[];
  restatable: string[];
  noRestate: string[];
  stampOnly: string[];
}

/**
 * Head-comment `-- restate: <id,…>` ids of one migration's SQL text. Case-insensitive on
 * `restate`, spaces tolerated around the colon and commas; only the file's LEADING
 * comment block is scanned (first non-comment, non-blank line ends it), so a literal in
 * the SQL body can never decree a restate.
 */
export function migrationRestateIds(sqlText: string): string[] {
  const ids: string[] = [];
  for (const raw of sqlText.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) break;
    const m = /^--\s*restate\s*:\s*(.+)$/i.exec(line);
    if (m) {
      ids.push(
        ...m[1]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
    }
  }
  return ids;
}

/** Missing-relation shapes PostgREST/Postgres surface pre-migration (Stage 8 ships the DDL). */
const TABLE_ABSENT_RE = /(does not exist|schema cache)/i;

/**
 * The whole detector, pure over its store seam (no process.exit, no console) — the CLI
 * `main()` below prints `lines` and sets the exit code; the test drives this directly.
 * `codeRows` defaults to the live registry's vintages; tests inject synthetic rows.
 */
export async function runVintageDrift(
  store: VintageStore,
  opts: VintageDriftOpts = {},
  codeRows: readonly ScorerVintageRow[] = codeVintages(opts.now ?? new Date()),
): Promise<VintageDriftResult> {
  const lines: string[] = [];

  // ---- --stamp: the only write path; no diff, exit 0 -----------------------------------
  if (opts.stamp !== undefined) {
    const byId = new Map(codeRows.map((r) => [r.indicator_id, r]));
    let rows: ScorerVintageRow[];
    if (opts.stamp === "all") {
      rows = [...codeRows];
    } else {
      const unknown = opts.stamp.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        // Fail LOUD on a typo'd id (mirrors backfill's --restate validation): a stamp that
        // silently skipped an id would leave the next detector run re-reporting its drift.
        lines.push(`STAMP ABORT: unknown id(s) ${unknown.join(", ")} — nothing written`);
        return { exitCode: 1, lines, restatable: [], noRestate: [], stampOnly: [] };
      }
      rows = opts.stamp.map((id) => byId.get(id)!);
    }
    if (!store.recordScorerVintage) throw new Error("[vintage-drift] --stamp needs a read-write store");
    await store.recordScorerVintage(rows);
    lines.push(`STAMPED ${rows.length}`);
    return { exitCode: 0, lines, restatable: [], noRestate: [], stampOnly: [] };
  }

  // ---- read the stored vintages (READ-ONLY from here on) -------------------------------
  let stored: ScorerVintageRow[];
  try {
    stored = await store.getScorerVintages();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/scorer_vintage/i.test(msg) && TABLE_ABSENT_RE.test(msg)) {
      lines.push(`TABLE-ABSENT scorer_vintage — pre-ship; treating every id as STAMP-ONLY (${msg})`);
      stored = [];
    } else {
      throw e;
    }
  }
  const { drift, stampOnly } = diffVintages(codeRows, stored);

  // ---- drift-by-decree from --applied migrations ---------------------------------------
  const decree: { id: string; source: string }[] = [];
  if (opts.applied !== undefined) {
    if (!existsSync(opts.applied)) {
      lines.push(`WARN --applied manifest not found, skipped: ${opts.applied}`);
    } else {
      const paths = readFileSync(opts.applied, "utf8")
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      for (const p of paths) {
        if (!existsSync(p)) {
          lines.push(`WARN --applied migration not found, skipped: ${p}`);
          continue;
        }
        for (const id of migrationRestateIds(readFileSync(p, "utf8"))) {
          decree.push({ id, source: basename(p) });
        }
      }
    }
  }

  // ---- partition (ruling 4b) + emit ----------------------------------------------------
  const restatableSet = new Set(restatableIds());
  const restatable: string[] = [];
  const noRestate: string[] = [];
  const claim = (id: string): string[] => (restatableSet.has(id) ? restatable : noRestate);
  const seen = new Set<string>();

  for (const d of drift) {
    seen.add(d.id);
    claim(d.id).push(d.id);
    const prefix = restatableSet.has(d.id) ? "DRIFT" : "DRIFT-NORESTATE";
    lines.push(
      `${prefix} ${d.id} config ${d.configHash.old}→${d.configHash.new} | logic v${d.logicVersion.old}→v${d.logicVersion.new}`,
    );
  }
  for (const { id, source } of decree) {
    if (seen.has(id)) continue; // already reported by the hash diff — one line per id
    seen.add(id);
    claim(id).push(id);
    const prefix = restatableSet.has(id) ? "DRIFT" : "DRIFT-NORESTATE";
    lines.push(`${prefix} ${id} by-migration ${source}`);
  }
  for (const id of stampOnly) lines.push(`STAMP-ONLY ${id}`);
  if (restatable.length > 0) lines.push(`bash scripts/restate-prod.sh ${restatable.join(",")}`);

  const exitCode: 0 | 1 = restatable.length > 0 || noRestate.length > 0 ? 1 : 0;
  return { exitCode, lines, restatable, noRestate, stampOnly };
}

/**
 * The abort message for a `--stamp` run that never named its store, or null when the
 * argv is fine. Pure, so the guard is pinned by the test rather than by a prod scare.
 */
export function stampEnvAbort(argv: readonly string[]): string | null {
  const stamping = hasFlag("stamp", argv) || argOf("stamp", argv) !== undefined;
  if (!stamping || argOf("env", argv) !== undefined) return null;
  return "ABORT: --stamp writes scorer_vintage — name the store explicitly (--env=local|prod); the read-only diff is the only mode that defaults to prod.";
}

async function main(): Promise<void> {
  const abort = stampEnvAbort(process.argv);
  if (abort !== null) {
    console.log(abort);
    process.exit(1);
  }
  const env = envArgStrict("prod");
  // Runtime import so merely importing this module (the test does) never touches cred IO.
  const { resolveStore, liveResolveDeps } = await import("./backfill/resolve-store.js");
  const stampArg = argOf("stamp");
  const stamp: VintageDriftOpts["stamp"] = hasFlag("stamp")
    ? "all"
    : stampArg !== undefined
      ? stampArg
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined;
  // Only `--stamp` writes, so only it asks for a read-write store (and so consults the prod-writes switch).
  const store = stamp === undefined ? await resolveStore(env, "ro", liveResolveDeps) : await resolveStore(env, "rw", liveResolveDeps);
  const res = await runVintageDrift(store, { applied: argOf("applied"), stamp });
  for (const l of res.lines) console.log(l);
  process.exitCode = res.exitCode;
}

const isMain = process.argv[1]?.endsWith("probe-vintage-drift.ts") ?? false;
if (isMain) {
  await main();
}
