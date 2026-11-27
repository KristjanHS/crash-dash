/**
 * Stage 4 historical backfill — populate `alert_log.dial_state` for existing rows that predate the
 * C1 persist-assembled-dial column (OQ-B).
 *
 *   npm run backfill:dial-state                      # LIVE DEV store (db.sh with dev)
 *   npm run backfill:dial-state -- --env=prod --limit=5000
 *
 * WHAT IT DOES: for each recent alert row whose `dial_state` is still NULL, reconstruct the dial via
 * the SAME seam the round-trip probe recomputes with — `assembleDial({ readings, asOf, store }).dial`
 * over that run's persisted readings — and write it into `dial_state` under the store's mandatory
 * NULL-only guard. So the persisted blob round-trips deep-equal to a fresh recompute, and
 * `scripts/probe-dial-roundtrip.ts` passes.
 *
 * IDEMPOTENT & RE-RUNNABLE: `backfillDialState` updates only NULL `dial_state` rows, so a second run
 * updates 0. NEVER deletes/truncates/resets — the dev-DB history is irreplaceable (`docs/reference.md`
 * §[runbook] Database (local Supabase)). Rows with no reconstructable readings (`getReadingsForRun` empty) are skipped, not failed.
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

import { resolveStore, liveResolveDeps } from "./resolve-store.js";
import { assembleDial } from "../../src/dial-assembly.js";
import type { Store } from "../../src/store.js";

/** Store surface the backfill core needs — read the log/readings + assembleDial's series reads + write. */
export type BackfillStore = Pick<
  Store,
  "getRecentAlerts" | "getReadingsForRun" | "getSeries" | "getSeriesBulk" | "backfillDialState"
>;

export interface BackfillDialStateSummary {
  scanned: number; // alert rows returned by getRecentAlerts(limit)
  updated: number; // rows that were NULL and got a reconstructed dial_state
  alreadyPopulated: number; // rows that already carried a non-null dial_state (skipped, untouched)
  skippedNoReadings: number; // NULL rows with no reconstructable readings (can't recompute)
}

/**
 * Pure-ish core (store injected) — unit-tested over InMemoryStore, no live DB. Reconstructs each
 * NULL-`dialState` row's dial exactly as the probe's RECOMPUTE arm does and writes it back.
 */
export async function backfillDialStateCore(
  store: BackfillStore,
  opts: { limit: number; log?: (msg: string) => void },
): Promise<BackfillDialStateSummary> {
  const log = opts.log ?? (() => {});
  const alerts = await store.getRecentAlerts(opts.limit);
  let updated = 0;
  let alreadyPopulated = 0;
  let skippedNoReadings = 0;

  for (const a of alerts) {
    if (a.dialState != null) {
      alreadyPopulated++;
      continue;
    }
    const stored = await store.getReadingsForRun(a.firedAt);
    if (stored.length === 0) {
      skippedNoReadings++;
      log(`  skip ${a.date} (${a.firedAt}): no reconstructable readings`);
      continue;
    }
    // SAME inputs, SAME call the probe's RECOMPUTE arm uses — so the persisted blob deep-equals a
    // fresh recompute. Do NOT reshape this mapping without re-running probe-dial-roundtrip.
    const readings = stored.map((r) => ({ id: r.indicatorId, state: r.state }));
    const { dial } = await assembleDial({ readings, asOf: a.date, store });
    const did = await store.backfillDialState(a.firedAt, dial);
    if (did) {
      updated++;
    } else {
      // Lost the NULL-only race (a concurrent writer populated it) — count as already-populated.
      alreadyPopulated++;
    }
  }
  return { scanned: alerts.length, updated, alreadyPopulated, skippedNoReadings };
}

// ---------- args ----------
const argOf = (argv: string[], name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

export interface ParsedArgs {
  env: "local" | "prod";
  limit: number;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const env = (argOf(argv, "env") ?? "local") as "local" | "prod";
  if (env !== "local" && env !== "prod") return { env: "local", limit: 0, error: `--env must be local|prod (got ${env})` };
  const limit = Number(argOf(argv, "limit") ?? 5000);
  if (!Number.isFinite(limit) || limit < 1) return { env, limit: 0, error: `--limit must be a positive integer (got ${argOf(argv, "limit")})` };
  return { env, limit };
}

function loadEnvFileIfExists(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path); // Node 24; guard since it throws on a missing file
}

/** IO shell: load env (local only) → resolve store → run core → print summary → exit code. */
export async function main(
  argv: string[],
  makeStore: (env: "local" | "prod") => Promise<BackfillStore> = (env) => resolveStore(env, "rw", liveResolveDeps),
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`[backfill:dial-state] ${parsed.error}`);
    return 1;
  }
  if (parsed.env === "local") loadEnvFileIfExists(".env.local"); // prod NEVER loads it (footgun guard)

  let store: BackfillStore;
  try {
    store = await makeStore(parsed.env);
  } catch (e: unknown) {
    console.error(
      `[backfill:dial-state] no store reachable for --env=${parsed.env} — ${e instanceof Error ? e.message : String(e)}\n` +
        `    The dev stack defaults DOWN — re-run under the front door:\n` +
        `      npm run backfill:dial-state\n` +
        `    (or hold it open with \`scripts/db.sh up dev\`). Populate .env.local, or pass --env=prod.`,
    );
    return 1;
  }

  const s = await backfillDialStateCore(store, { limit: parsed.limit, log: (m) => console.log(m) });
  console.log(
    `[backfill:dial-state] (${parsed.env}) scanned=${s.scanned}  updated=${s.updated}  ` +
      `already-populated=${s.alreadyPopulated}  skipped-no-readings=${s.skippedNoReadings}`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
