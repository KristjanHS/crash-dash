/**
 * The reusable backfill runner CLI (design §6, plan Phase 3).
 *
 *   npm run backfill -- <name | all | --all | safe | --safe> [--env=local|prod] [--dry-run] [--confirm-destructive]
 *                                                            [--restate=<id,…>]  (default --env=local)
 *   `safe` = every SELECTABLE job EXCEPT the destructive vintage writers (DESTRUCTIVE_JOBS) — never
 *   gated. Both selectors also drop `BY_NAME_ONLY_JOBS` (jobs whose prod table does not exist yet).
 *   `--restate=<id,…>` re-scores + re-writes those ids' FULL stored history (cut-retune
 *   propagation, `dbreak` only — see backfill.ts's ⚠ RESTATE note). Destructive-gated: like
 *   `slow`, it shadows history and the self-prune then deletes what it shadowed.
 *   `--require-primary-feed` sets the strict-primary-feed latch (`setRequirePrimaryFeed`, prices.ts) —
 *   inert while daily closes have no free source. **`--confirm-destructive` IMPLIES it** (ruled `[USER]`
 *   2026-08-02 — a destructive pass is a history rewrite); `--allow-fallback-feed` opts back out.
 *   The cron path arms neither.
 *   `--closes=<n>` sizes a replay window (`legpillars` only); a bare / non-integer / <1 value is a
 *   usage error, never a silent fall back to the job's default.
 *
 * Pure `parseArgs` (unit-tested directly) + an IO shell `main` (inject a fake
 * `makeStore` for tests). Env-file loading is the runner's job, conditional on
 * `--env=local`, so a host `--env=prod` run never picks up local creds (footgun guard).
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { datedDeleteClause, makeDryRunStore } from "./dry-run-store.js";
import { REGISTRY, type BackfillJob } from "./registry.js";
import { resolveStore } from "./resolve-store.js";
import { setRequirePrimaryFeed } from "../../src/prices.js";
import { BACKFILL_PRUNE_RETAIN_DAYS, type Store } from "../../src/store.js";

export interface ParsedArgs {
  jobs: BackfillJob[] | null; // null ⇒ print list (no job/selector given)
  all: boolean;
  env: "local" | "prod";
  dryRun: boolean;
  confirmDestructive: boolean;
  restate: readonly string[];     // ids to rebuild in full under changed CUTS (empty ⇒ normal pass)
  reshadowAll: readonly string[]; // raw-close ids to re-write in full under a fresh VINTAGE (empty ⇒ normal pass)
  // `--deepen[=<id,…>]`: force a `full` fetch to re-deepen a frozen left edge. `"all"` ⇒ bare (every spec); `string[]` ⇒
  // named ids, which also narrow the pass to deepen ∪ restate. Insert-missing ⇒ NOT gated; only `supportsDeepen` jobs accept it.
  deepen?: readonly string[] | "all";
  /**
   * EFFECTIVE strict-primary-feed state, not a raw flag mirror: `--require-primary-feed` sets it, and
   * `--confirm-destructive` IMPLIES it (ruled `[USER]` 2026-08-02) unless `--allow-fallback-feed` opts
   * back out. It is handed to `setRequirePrimaryFeed` (prices.ts), inert while daily closes have no free source.
   */
  requirePrimaryFeed: boolean;
  /** `--allow-fallback-feed`: cancels the `--confirm-destructive` implication (DEXUSEU-style re-shadows). */
  allowFallbackFeed: boolean;
  closes?: number;            // replay-window size for `--closes`-capable jobs (undefined ⇒ the job's default)
  error?: string;             // set ⇒ print error + usage, exit 1
}

/**
 * Jobs whose pass re-inserts history under a fresh vintage and then DELETES the vintages it
 * shadowed. `all` inherits the gate by containing them — it is not listed separately.
 */
export const DESTRUCTIVE_JOBS = ["slow"];

/**
 * Jobs held OUT of the `safe` / `all` selectors while their target table does not exist in prod.
 * Same shape as `DESTRUCTIVE_JOBS` (a name list the selectors filter by), different reason: not
 * "this deletes rows" but "this cannot run at all yet". They stay reachable BY NAME
 * (`npm run backfill -- <job>`), which is how a local seed is driven.
 *
 * EMPTY since W4 Stage 4.5 shipped
 * `20260725220000_add_leg_pillars` to prod: `legpillars` was the sole entry, held out because
 * the prod seed runs `safe --env=prod` and would have failed the default prod seed at
 * `putLegPillars` — AFTER the other jobs had already written. With the table in prod it is an
 * ordinary selectable job.
 *
 * Keep the mechanism: the next table-creating job re-uses this list for the same window, between
 * "the writer lands on main" and "the migration reaches prod".
 */
// `fxhcmpdeep`: a 20y one-shot USER-owned seed — never in the routine prod seed (a 20y price-feed pull).
export const BY_NAME_ONLY_JOBS: string[] = ["fxhcmpdeep"];

/** The jobs a SELECTOR (`all` / `safe`) resolves to — the registry minus the by-name-only ones. */
export const selectableRegistry = (registry: BackfillJob[] = REGISTRY): BackfillJob[] => registry.filter((j) => !BY_NAME_ONLY_JOBS.includes(j.name));

/**
 * Pure gate (unit-tested): the destructive jobs against prod demand an explicit
 * `--confirm-destructive`, so the Action's one-click dropdown can never delete prod rows on
 * its own. A dry run writes nothing, so it is never gated — it is the intended way to see
 * the counts and prune scope first.
 */
export function destructiveConfirmError(
  jobs: BackfillJob[],
  env: "local" | "prod",
  opts: { dryRun: boolean; confirmDestructive: boolean; restate?: readonly string[]; reshadowAll?: readonly string[] },
): string | undefined {
  if (env !== "prod" || opts.dryRun || opts.confirmDestructive) return undefined;
  const hits = jobs.filter((j) => DESTRUCTIVE_JOBS.includes(j.name)).map((j) => j.name);
  // `--restate` / `--reshadow-all` are destructive for the SAME reason `slow` is — they re-write
  // stored dates under a fresh vintage and the runner's self-prune then deletes the rows they
  // shadow. Gated on the FLAG, not the job name, so a plain job stays an ungated insert-missing pass.
  const restating = opts.restate ?? [];
  const reshadowing = opts.reshadowAll ?? [];
  if (hits.length === 0 && restating.length === 0 && reshadowing.length === 0) return undefined;
  const what =
    hits.length > 0
      ? hits.join(", ")
      : restating.length > 0
        ? `--restate=${restating.join(",")}`
        : `--reshadow-all=${reshadowing.join(",")}`;
  return (
    `refusing ${what} against --env=prod without --confirm-destructive: ` +
    `this pass re-inserts history and DELETES the vintages it shadows. Re-run with --dry-run first ` +
    `to see the row counts and the exact prune scope.`
  );
}

/** The non-destructive subset — every SELECTABLE job EXCEPT the vintage-shadow (destructive) ones.
 *  Derived from `DESTRUCTIVE_JOBS` (the SSOT), so a new destructive job is auto-excluded from `safe`;
 *  `BY_NAME_ONLY_JOBS` is excluded on top of that. */
export const safeRegistry = (registry: BackfillJob[] = REGISTRY): BackfillJob[] =>
  selectableRegistry(registry).filter((j) => !DESTRUCTIVE_JOBS.includes(j.name));

/**
 * Pure arg parse — unit-tested directly. Accepts one job name, the `all`/`--all` selector, the
 * `safe`/`--safe` selector (all jobs except the destructive vintage writers), plus --env=,
 * --dry-run, --confirm-destructive and --restate=<id,…>.
 *
 * A job name is REQUIRED to seed anything: `npm run backfill -- --env=prod` with no
 * positional job only prints the job list and exits 0, seeding nothing. To seed prod:
 * `npm run backfill -- indicators --env=prod`.
 */
export function parseArgs(argv: string[], registry: BackfillJob[] = REGISTRY): ParsedArgs {
  let env: "local" | "prod" = "local";
  let all = false;
  let safe = false;
  let dryRun = false;
  let restate: readonly string[] = [];
  let reshadowAll: readonly string[] = [];
  let deepen: readonly string[] | "all" | undefined;
  // Pre-scanned, NOT accumulated in the loop below: `requirePrimaryFeed`'s default is derived from
  // both of these, and several error exits return mid-loop — deriving from `let`s the loop has not
  // reached yet would make the reported value depend on flag ORDER on the command line.
  const confirmDestructive = argv.includes("--confirm-destructive");
  const allowFallbackFeed = argv.includes("--allow-fallback-feed");
  // The implication (ruled `[USER]` 2026-08-02): every destructive path is a history REWRITE, where a
  // silent non-primary fallback bakes a second feed's numbers into the series permanently and still
  // reports success. So `--confirm-destructive` arms strict-primary by default; `--allow-fallback-feed`
  // is the escape for the runs where a fallback is BY DESIGN (the pension job's DEXUSEU re-shadow).
  // Making the escape explicit — rather than carving DEXUSEU out inside the feed seam — keeps every
  // fallback-tolerant run visible at the call site and in shell history.
  let requirePrimaryFeed = confirmDestructive && !allowFallbackFeed;
  let closes: number | undefined;
  const positionals: string[] = [];
  for (const a of argv) {
    if (a === "--all") all = true;
    else if (a === "--safe") safe = true;
    else if (a === "--env=prod") env = "prod";
    else if (a === "--env=local") env = "local";
    else if (a === "--dry-run") dryRun = true;
    // Both pre-scanned above; the branches exist so they are not "unknown flag".
    else if (a === "--confirm-destructive" || a === "--allow-fallback-feed") { /* handled pre-loop */ }
    // Arms the strict-primary-feed latch in prices.ts, so a non-primary fallback (typically the free
    // tier's hourly cap) throws instead of quietly re-seeding history from the very feed a re-seed
    // exists to eliminate. Explicit here, IMPLIED by --confirm-destructive (see the pre-loop note).
    // Nothing on the cron path arms it, so the cron keeps its lenient degrade behavior.
    else if (a === "--require-primary-feed") requirePrimaryFeed = true;
    // A bare `--restate` / `--restate=` names nothing to rebuild; accepting it would run a normal
    // pass and report success, which is the failure this op cannot afford (see backfill.ts ⚠).
    else if (a === "--restate" || a === "--restate=")
      return { jobs: null, all, env, dryRun, confirmDestructive, restate, reshadowAll, requirePrimaryFeed, allowFallbackFeed, closes, error: "--restate needs ids: --restate=DB_XLK (comma-separated)" };
    else if (a.startsWith("--restate=")) restate = a.slice("--restate=".length).split(",").filter(Boolean);
    // Same guard for `--reshadow-all` — a bare/empty flag names nothing to re-seed.
    else if (a === "--reshadow-all" || a === "--reshadow-all=")
      return { jobs: null, all, env, dryRun, confirmDestructive, restate, reshadowAll, requirePrimaryFeed, allowFallbackFeed, closes, error: "--reshadow-all needs ids: --reshadow-all=LEGP_us_large (comma-separated)" };
    else if (a.startsWith("--reshadow-all=")) reshadowAll = a.slice("--reshadow-all=".length).split(",").filter(Boolean);
    // `--deepen` (bare) ⇒ every spec; `--deepen=<ids>` ⇒ those ids. Unlike `--restate`, a bare flag
    // is VALID (it deepens the whole pass) and it is never gated — head-repair only ADDS older dates.
    else if (a === "--deepen") deepen = "all";
    else if (a.startsWith("--deepen=")) {
      const ids = a.slice("--deepen=".length).split(",").filter(Boolean);
      deepen = ids.length > 0 ? ids : "all"; // `--deepen=` names nothing ⇒ treat as the bare "all"
    }
    // `--closes=<n>` sizes a replay window. A bare / non-integer / <1 value must be a usage error:
    // silently falling back to the job's default would seed a window the operator did not ask for
    // and report success — the same failure shape as a dropped `--restate`.
    else if (a === "--closes" || a === "--closes=" || a.startsWith("--closes=")) {
      const raw = a.slice("--closes=".length);
      const n = Number(raw);
      // `/^\d+$/` FIRST: `Number.isInteger` alone admits the exotic numeric literals `1e3` (→1000)
      // and `0x10` (→16), neither of which is "a positive integer" as the error message promises —
      // and both of which would silently size a window nobody typed.
      if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) {
        return { jobs: null, all, env, dryRun, confirmDestructive, restate, reshadowAll, requirePrimaryFeed, allowFallbackFeed, closes,
          error: `--closes needs a positive integer: --closes=900 (got: ${raw === "" ? "(nothing)" : raw})` };
      }
      closes = n;
    }
    else if (a.startsWith("--")) return { jobs: null, all, env, dryRun, confirmDestructive, restate, reshadowAll, requirePrimaryFeed, allowFallbackFeed, closes, error: `unknown flag: ${a}` };
    else positionals.push(a);
  }
  const base = { all, env, dryRun, confirmDestructive, restate, reshadowAll, requirePrimaryFeed, allowFallbackFeed, closes, deepen };
  // The two flags state opposite intents. Silently letting one win would leave the operator believing
  // the other held — the same "reports success under a flag that did not apply" failure the bare
  // `--restate` guard exists for. Checked AFTER the loop so flag order cannot change the outcome.
  if (allowFallbackFeed && requirePrimaryFeed) {
    return { ...base, jobs: null, error: "--allow-fallback-feed contradicts --require-primary-feed: pass one" };
  }
  /** Every resolved-job exit runs the gate — a selector must never route around it. */
  const gated = (jobs: BackfillJob[]): ParsedArgs => {
    // A job that would silently DROP `--restate`/`--reshadow-all` must fail, not run a normal pass
    // under a flag the user believes propagated a retune / re-seed.
    const unsupportedRestate = restate.length > 0 ? jobs.filter((j) => !j.supportsRestate).map((j) => j.name) : [];
    if (unsupportedRestate.length > 0) {
      return { ...base, jobs: null, error: `--restate is not supported by: ${unsupportedRestate.join(", ")}` };
    }
    const unsupportedReshadow = reshadowAll.length > 0 ? jobs.filter((j) => !j.supportsReshadowAll).map((j) => j.name) : [];
    if (unsupportedReshadow.length > 0) {
      return { ...base, jobs: null, error: `--reshadow-all is not supported by: ${unsupportedReshadow.join(", ")}` };
    }
    // Same shape as the two guards above: a job that would DROP `--closes` must fail rather than
    // run its default window under a flag the operator believes sized the replay.
    const unsupportedCloses = closes !== undefined ? jobs.filter((j) => !j.supportsCloses).map((j) => j.name) : [];
    if (unsupportedCloses.length > 0) {
      return { ...base, jobs: null, error: `--closes is not supported by: ${unsupportedCloses.join(", ")}` };
    }
    // Same drop-the-flag guard: only `indicators` re-deepens (it alone drives `backfillAll`), so
    // `--deepen` against any other job would exit 0 having deepened nothing.
    const unsupportedDeepen = deepen !== undefined ? jobs.filter((j) => !j.supportsDeepen).map((j) => j.name) : [];
    if (unsupportedDeepen.length > 0) {
      return { ...base, jobs: null, error: `--deepen is not supported by: ${unsupportedDeepen.join(", ")}` };
    }
    const error = destructiveConfirmError(jobs, env, base);
    return error ? { ...base, jobs: null, error } : { ...base, jobs };
  };
  // `safe` (the non-destructive subset) is checked before `all`: it can never be gated (it holds
  // no destructive job), so a bare prod seed needs no --confirm-destructive.
  if (positionals.includes("safe") || safe) return gated(safeRegistry(registry));
  if (positionals.includes("all")) all = true;
  base.all = all;
  if (all) return gated(selectableRegistry(registry));
  const names = positionals.filter((p) => p !== "all" && p !== "safe");
  // Same reason as the bare-`--restate` guard: printing the job list and exiting 0 would read as
  // "the retune propagated" when nothing ran.
  if (names.length === 0 && restate.length > 0) {
    return { ...base, jobs: null, error: "--restate needs a job: npm run backfill -- dbreak --restate=DB_XLK" };
  }
  if (names.length === 0 && reshadowAll.length > 0) {
    return { ...base, jobs: null, error: "--reshadow-all needs a job: npm run backfill -- legs --reshadow-all=LEGP_us_large" };
  }
  if (names.length === 0 && closes !== undefined) {
    return { ...base, jobs: null, error: "--closes needs a job: npm run backfill -- legpillars --closes=900" };
  }
  if (names.length === 0 && deepen !== undefined) {
    return { ...base, jobs: null, error: "--deepen needs a job: npm run backfill -- indicators --deepen" };
  }
  if (names.length === 0) return { ...base, jobs: null };          // → print list
  if (names.length > 1) return { ...base, jobs: null, error: `one job at a time (got: ${names.join(", ")})` };
  const job = registry.find((j) => j.name === names[0]);
  if (!job) return { ...base, jobs: null, error: `unknown job: ${names[0]}` };
  return gated([job]);
}

function loadEnvFileIfExists(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path); // Node 24; guard since it throws on a missing file
}

/** The runner's process-global side effects; tests inject a recording fake. */
export interface RunIo {
  log(line: string): void;
  error(line: string): void;
  loadEnvFile(path: string): void;
  setRequirePrimaryFeed(on: boolean): void;
}

export const liveRunIo: RunIo = { log: console.log, error: console.error, loadEnvFile: loadEnvFileIfExists, setRequirePrimaryFeed };

function printList(registry: BackfillJob[], io: RunIo): void {
  io.log("backfill jobs:");
  for (const j of registry) io.log(`  ${j.name} — ${j.description}`);
  io.log("\nusage: npm run backfill -- <job|all|safe> [--env=local|prod] [--dry-run] [--confirm-destructive]");
  io.log("                            [--restate=<id,…>] [--reshadow-all=<id,…>] [--closes=<n>]");
  io.log("  all  = every selectable job (incl. the destructive vintage writers); safe = those EXCEPT them;");
  if (BY_NAME_ONLY_JOBS.length > 0) {
    io.log(`  ${BY_NAME_ONLY_JOBS.join("/")} is in NEITHER selector — run it by name (its prod table does not exist yet);`);
  }
  io.log("  --env defaults to local; --dry-run reports counts + prune scope and writes nothing;");
  io.log(`  --confirm-destructive is REQUIRED for ${DESTRUCTIVE_JOBS.join("/")} (and all) against --env=prod.`);
  const restatable = registry.filter((j) => j.supportsRestate).map((j) => j.name);
  io.log(
    `  --restate=<id,…> rebuilds those ids' FULL history after a CUT retune (${restatable.join("/")} only,` +
      ` also --confirm-destructive against prod); the pass runs ONLY the named ids.`,
  );
  const reshadowable = registry.filter((j) => j.supportsReshadowAll).map((j) => j.name);
  io.log(
    `  --reshadow-all=<id,…> re-writes those raw-close ids' FULL history under a fresh vintage (feed re-seed;` +
      ` ${reshadowable.join("/")} only, also --confirm-destructive against prod).`,
  );
  const windowed = registry.filter((j) => j.supportsCloses).map((j) => j.name);
  io.log(`  --closes=<n> sizes the replay window in stored closes (${windowed.join("/")} only).`);
  const deepenable = registry.filter((j) => j.supportsDeepen).map((j) => j.name);
  io.log(
    `  --deepen[=<id,…>] re-fetches full history to re-deepen a frozen left edge after a window change` +
      ` (${deepenable.join("/")} only; bare ⇒ every spec; named ids ⇒ the pass runs only those + --restate ids; insert-missing).`,
  );
  io.log(
    "  --require-primary-feed accepted; a no-op while daily closes have no free source. IMPLIED by --confirm-destructive.",
  );
  io.log(
    "  --allow-fallback-feed cancels that implication (also a no-op here).",
  );
}

/** IO shell: load env (local only) → resolve store → dispatch → exit code. Store, registry and IO injectable for tests. */
export async function main(
  argv: string[],
  makeStore: (env: "local" | "prod") => Promise<Store> = (env) => resolveStore(env, "rw"),
  registry: BackfillJob[] = REGISTRY,
  io: RunIo = liveRunIo,
): Promise<number> {
  const parsed = parseArgs(argv, registry);
  if (parsed.error) { io.error(`[backfill] ${parsed.error}`); printList(registry, io); return 1; }
  if (!parsed.jobs) { printList(registry, io); return 0; }

  if (parsed.env === "local") io.loadEnvFile(".env.local"); // prod NEVER loads it (footgun guard)
  // Arm BEFORE the store resolves and long before any job fetches. Inert while daily closes have no free source.
  if (parsed.requirePrimaryFeed) {
    io.setRequirePrimaryFeed(true);
    // Name the SOURCE: under the implication the operator may never have typed the flag, and a line
    // quoting a flag that is absent from their command reads as a bug rather than as the guard working.
    const via = "--require-primary-feed: armed (a no-op while daily closes have no free source)";
    io.log(`[backfill] ${via}`);
    if (!argv.includes("--require-primary-feed")) {
      io.log("[backfill]   (armed by --confirm-destructive; pass --allow-fallback-feed to opt out)");
    }
  } else if (parsed.allowFallbackFeed) {
    io.log("[backfill] --allow-fallback-feed: the strict-primary-feed latch stays off on this destructive run");
  }
  const store: Store = await makeStore(parsed.env);

  const failures: string[] = [];
  for (const job of parsed.jobs) {
    // A dry run drives the SAME dispatch below against a tallying wrapper, so the counts and
    // prune scope it reports are the live path's, not a second implementation of it.
    const dry = parsed.dryRun ? makeDryRunStore(store) : null;
    const target = dry?.store ?? store;
    const tag = parsed.dryRun ? `DRY-RUN ${job.name}` : job.name;
    try {
      // Frontier for the self-prune below: every registry pass stamps its run_at from a clock read INSIDE
      // `job.run` (`opts.now ?? new Date()` / backfill.ts's `opts.clock ?? wallClock` — no pass is handed an older `now`),
      // so each row this job shadows has a shadower at/after this instant. Re-check that before a job
      // injects a historical vintage — such a job must pass `null` (full sweep) instead.
      const jobStart = new Date().toISOString();
      const { summary, ids, failures: itemFailures } = await job.run(target, {
        restate: parsed.restate,
        reshadowAll: parsed.reshadowAll,
        closes: parsed.closes,
        dryRun: parsed.dryRun,
        deepen: parsed.deepen,
      });
      io.log(`[backfill] ${tag} (${parsed.env}): ${summary}`);
      // Rung-4 self-prune: a pass (backfill-slow especially) re-inserts history under
      // a fresh run_at; delete the vintages it just shadowed so nothing accumulates.
      // FLOORED (2026-07-23): an unfloored prune also deletes the LIVE cron run's row for
      // every id this pass touches — see `BACKFILL_PRUNE_RETAIN_DAYS` for why that is not a
      // redundant duplicate and what it broke on /lab.
      if (ids.length > 0) {
        const pruned = await target.pruneShadowedReadings(ids, BACKFILL_PRUNE_RETAIN_DAYS, undefined, jobStart);
        if (!dry) io.log(`[backfill] ${job.name}: pruned ${pruned} shadowed row(s)`);
      }
      if (dry) {
        const scope = dry.tally.pruneIds.length > 0 ? dry.tally.pruneIds.join(", ") : "(nothing to prune)";
        io.log(
          `[backfill] ${tag}: would write ${dry.tally.rows} row(s);${datedDeleteClause(dry.tally)} prune scope: ${scope} — NOTHING WRITTEN`,
        );
      }
      // Survived per-item failures are reported AFTER the prune above, never as a throw from the job:
      // throwing first skips the prune and leaves what DID write shadowed by the vintage it replaced.
      if (itemFailures !== undefined && itemFailures.length > 0) {
        failures.push(job.name);
        io.error(`[backfill] ${job.name}: ${itemFailures.length} item(s) FAILED — ${itemFailures.join(", ")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(job.name);
      io.error(`[backfill] ${job.name}: FAILED — ${msg}`);
    }
  }
  if (failures.length > 0) {
    io.error(`[backfill] ${failures.length} job(s) FAILED: ${failures.join(", ")} — re-run to retry`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    // Message only: a stack/cause can carry request bodies or prod row data into public CI logs.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
