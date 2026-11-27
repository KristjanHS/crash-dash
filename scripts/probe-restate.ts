/**
 * One-command retune propagation: `npm run restate -- --id <id> [--since YYYY-MM-DD] [--env=prod|dev] [--dry-run] [--confirm-destructive]`
 * (`--env=dev` is the default and needs the local stack up: `scripts/db.sh up dev`).
 * Thin CLI over the REAL backfill restate seam (`backfillAll`/`backfillDownsideBreaks` `opts.restate`) — never reimplement scoring or upsert here.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { backfillAll, backfillDownsideBreaks, isoCutoff, liveDeps, livePensionDeps } from "./backfill.js";
import { datedDeleteClause, makeDryRunStore } from "./backfill/dry-run-store.js";
import { seededIds } from "./backfill/registry.js";
import { destructiveConfirmError } from "./backfill/run.js";
import { resolveStore } from "./backfill/resolve-store.js";
import { setRequirePrimaryFeed } from "../src/prices.js";
import { DOWNSIDE_DETECTORS } from "../src/registry-price.js";
import { BACKFILL_PRUNE_RETAIN_DAYS, type Store } from "../src/store.js";

export interface RestateArgs {
  id: string;
  since?: string;
  env: "local" | "prod";
  dryRun: boolean;
  confirmDestructive: boolean;
  error?: string;
}

const USAGE =
  "usage: npm run restate -- --id <indicator-or-DB_-id> [--since YYYY-MM-DD] [--env=prod|dev] [--dry-run] [--confirm-destructive]";

/** Pure arg parse — `--id`/`--since` take a value (`--id F9` or `--id=F9`); one id per run. */
export function parseRestateArgs(argv: string[]): RestateArgs {
  const out: RestateArgs = { id: "", env: "local", dryRun: false, confirmDestructive: false };
  const fail = (error: string): RestateArgs => ({ ...out, error });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const valued = (flag: string): string | undefined =>
      a === flag ? argv[++i] : a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : undefined;
    if (a === "--id" || a.startsWith("--id=")) {
      const v = valued("--id");
      if (!v || v.startsWith("--")) return fail("--id needs a value: --id F9");
      // One id per run: the two restate jobs take disjoint id sets, so a comma list could
      // straddle both and half-run; invoke once per id instead.
      if (v.includes(",")) return fail(`--id takes ONE id (got: ${v}) — run once per id`);
      if (out.id) return fail(`--id given twice (${out.id}, ${v}) — run once per id`);
      out.id = v;
    } else if (a === "--since" || a.startsWith("--since=")) {
      const v = valued("--since");
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail(`--since needs YYYY-MM-DD (got: ${v ?? "(nothing)"})`);
      out.since = v;
    } else if (a === "--env=prod") out.env = "prod";
    else if (a === "--env=dev" || a === "--env=local") out.env = "local";
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm-destructive") out.confirmDestructive = true;
    else return fail(`unknown argument: ${a}`);
  }
  if (!out.id) return fail("--id is required");
  if (out.error === undefined) {
    // Reuse the runner's REAL prod gate verbatim (jobs=[] — the restate flag alone trips it).
    const gate = destructiveConfirmError([], out.env, { ...out, restate: [out.id] });
    if (gate) return fail(gate);
  }
  return out;
}

/** Smallest whole-year window whose `isoCutoff` reaches back to `since` (superset, never a clip). */
export function yearsReaching(since: string, now: Date): number {
  let y = 1;
  while (isoCutoff(now, y) > since && y < 200) y++;
  return y;
}

/** Injected so a test can drive the write/prune ORDER without a store or a live feed. */
export interface RestateDeps {
  makeStore: (env: "local" | "prod") => Promise<Store>;
  backfillAll: typeof backfillAll;
  backfillDownsideBreaks: typeof backfillDownsideBreaks;
}
const LIVE_DEPS: RestateDeps = { makeStore: (env) => resolveStore(env, "rw"), backfillAll, backfillDownsideBreaks };

export async function main(argv: string[], injected: RestateDeps = LIVE_DEPS): Promise<number> {
  const parsed = parseRestateArgs(argv);
  if (parsed.error) {
    console.error(`[restate] ${parsed.error}\n${USAGE}`);
    return 1;
  }
  const { id, since, env, dryRun } = parsed;
  if (env === "local" && existsSync(".env.local")) process.loadEnvFile(".env.local"); // prod NEVER loads it
  // A restate is a history rewrite — strict primary feed always, same ruling as --confirm-destructive.
  setRequirePrimaryFeed(true);
  console.log("[restate] --require-primary-feed armed (a no-op while daily closes have no free source)");
  const years = since === undefined ? undefined : yearsReaching(since, new Date());
  if (since !== undefined) {
    console.warn(
      `[restate] --since ${since} shrinks the SCORING window too (fetch trims at the cutoff): history-anchored ` +
        `scorers restate differently than a full run, and rows older than the cutoff keep the old model — omit --since to rebuild all.`,
    );
  }
  const live: Store = await injected.makeStore(env);
  const dry = dryRun ? makeDryRunStore(live) : null;
  const store = dry?.store ?? live;

  const isDetector = DOWNSIDE_DETECTORS.some((d) => d.indicator.id === id);
  // Route by roster; a typo'd id falls to `indicators`, whose own fail-loud guard names the known set.
  // `only: [id]` narrows the pass to THIS id (2026-08-16 [USER]): the wrapper no longer insert-missing
  // seeds its job's other ids, so an unrelated feed's failure can neither abort nor widen the run.
  // `backfill -- <job> --restate=` keeps the full pass.
  let perId: Record<string, number>;
  let failures: readonly { id: string; error: string }[] = [];
  if (isDetector) {
    perId = (await injected.backfillDownsideBreaks(store, livePensionDeps, { restate: [id], years, only: [id] })).perLeg;
  } else {
    const res = await injected.backfillAll(store, liveDeps, { restate: [id], years, only: [id] });
    perId = res.seeded;
    failures = res.failures;
  }
  console.log(
    `[restate] ${id} (${env}): ${perId[id] ?? 0} row(s) re-written via ${isDetector ? "dbreak" : "indicators"}`,
  );
  // PRUNE BEFORE REPORTING FAILURES (2026-08-16): the old order threw first, so a written vintage
  // stayed shadowed by the old one — prod served the pre-restate rows while the CLI reported failure.
  const wrote = seededIds(perId);
  if (wrote.length > 0) {
    const pruned = await store.pruneShadowedReadings(wrote, BACKFILL_PRUNE_RETAIN_DAYS);
    if (!dry) console.log(`[restate] pruned ${pruned} shadowed row(s) across ${wrote.join(", ")}`);
  }
  if (dry) {
    const scope = dry.tally.pruneIds.length > 0 ? dry.tally.pruneIds.join(", ") : "(nothing to prune)";
    console.log(
      `[restate] DRY-RUN: would write ${dry.tally.rows} row(s);${datedDeleteClause(dry.tally)} prune scope: ${scope} — NOTHING WRITTEN`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} indicator(s) failed: ${failures.map((f) => f.id).join(", ")}`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[restate] FAILED — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
