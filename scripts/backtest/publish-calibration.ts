/**
 * Publish derived calibration cut-points to Supabase (crash-logic plan Phase 1
 * Stage 2, Task B — run via `npx tsx scripts/backtest/publish-calibration.ts`).
 *
 * Reads `scripts/backtest/calibration.json` (produced by the harness, Task A) and
 * writes its params through the store seam (`recordCalibration` → the append-only
 * `calibration` table, vintage-stamped by the harness's top-level `computed_at`).
 * The Vercel app then scores against the latest vintage via `getCalibration()`.
 *
 * Fails LOUD if creds are absent (getStore throws) — same posture as run-cycle-ctx.ts. The
 * GitHub Actions workflow guards invocation on secret presence; the script itself
 * just runs the seam and reports the count written.
 *
 * CONTENT-IDEMPOTENT: `calibration` is append-only and `recordCalibration` is a plain
 * INSERT, so re-running against an unchanged `calibration.json` would duplicate the whole
 * vintage. Since `make ship` publishes on EVERY release (scripts/ship.sh §5b), the script
 * skips when the store already carries every file param at identical values — see
 * `decidePublish` for why the check is on CONTENT and not on `computed_at`.
 * `--force` publishes unconditionally (recovery from a partial write / a deliberate revert).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { getStore, type CalibrationParam } from "../../src/store.js";
import { readEnv } from "../../src/config.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The on-disk JSON contract the harness writes (snake_case). */
interface CalibrationFile {
  schema_version: number;
  computed_at: string; // ISO-8601 UTC — the vintage stamp carried onto every param
  ndx_window: { start: string; end: string };
  params: Array<{
    market?: string | null; // (market, mode) cell — absent/null = shared/target-blind row (②)
    mode?: string | null;
    channel: string;
    metric: string;
    value: number;
    ci_low: number | null;
    ci_high: number | null;
    method: string;
    n_events: number | null;
    window_start: string | null;
    window_end: string | null;
    notes: string | null;
  }>;
}

/** What the publish should do about the store's current content. */
export type PublishDecision =
  | { action: "publish"; computedAt: string; reason: string }
  | { action: "skip"; reason: string }
  | { action: "stale"; reason: string };

const keyOf = (p: CalibrationParam) => JSON.stringify([p.market, p.mode, p.channel, p.metric]);

/** Everything except `computedAt` — the publish exists to move THESE, not the stamp. */
const contentOf = (p: CalibrationParam) =>
  JSON.stringify([p.value, p.method, p.ciLow, p.ciHigh, p.nEvents, p.windowStart, p.windowEnd, p.notes]);

/** ms since epoch; throws rather than silently ordering an unparseable stamp. */
function stampMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparseable calibration computed_at: ${iso}`);
  return ms;
}

/**
 * Decide whether to publish `file` over the store's collapsed current rows.
 *
 * Keyed on CONTENT, never on the stamp alone. Two facts make a stamp-only check useless:
 * the retired `harness.py` pinned `SOURCE_DATE_EPOCH` to the committed `computed_at`, so real cut-point
 * edits shipped under an UNCHANGED stamp (two earlier commits); and `backtest.yml` dispatches
 * (workflow deleted 2026-08-15) published wall-clock-stamped vintages never committed back,
 * so prod's stamp can sit permanently ahead of the file's. A stamp-only guard would skip forever in both directions
 * — the exact "calibration silently lags the code" this wiring exists to prevent.
 *
 * Three outcomes:
 *  · `skip`    — every file key is stored with identical content. Nothing to move. (This also
 *                covers a PARTIAL prior insert: a key missing from the store, or stored at old
 *                content, breaks the match and republishes.)
 *  · `stale`   — content differs AND the store's newest stamp is strictly newer than the
 *                file's, i.e. prod carries a vintage the repo doesn't have (a CI harness run).
 *                Refuse to revert it silently; the caller warns and the user re-runs the
 *                harness or passes `--force`.
 *  · `publish` — with a stamp that WINS the vintage collapse: the file's own when it is
 *                newest, otherwise the store's max + 1s (the pinned-stamp case, where the
 *                file's own stamp would tie and lose to the stored rows).
 */
export function decidePublish(stored: CalibrationParam[], file: CalibrationParam[]): PublishDecision {
  const storedByKey = new Map(stored.map((p) => [keyOf(p), p]));
  const changed = file.filter((p) => {
    const prev = storedByKey.get(keyOf(p));
    return prev === undefined || contentOf(prev) !== contentOf(p);
  });
  if (changed.length === 0) {
    return { action: "skip", reason: `all ${file.length} param(s) already stored with identical values` };
  }

  const fileStamp = file[0]!.computedAt;
  const fileMs = stampMs(fileStamp);
  let maxStoredMs = -Infinity;
  let maxStoredIso = "";
  for (const p of stored) {
    const ms = stampMs(p.computedAt);
    if (ms > maxStoredMs) [maxStoredMs, maxStoredIso] = [ms, p.computedAt];
  }

  if (maxStoredMs > fileMs) {
    return {
      action: "stale",
      reason:
        `${changed.length} param(s) differ, but the store carries a NEWER vintage (${maxStoredIso}) ` +
        `than calibration.json (${fileStamp}) — publishing would revert it`,
    };
  }

  // Equal stamps are the SOURCE_DATE_EPOCH-pinned case: same instant ⇒ the stored rows would
  // survive the `computed_at DESC` collapse, so the new content must be stamped strictly later.
  const computedAt =
    maxStoredMs < fileMs ? fileStamp : new Date(maxStoredMs + 1000).toISOString();
  return {
    action: "publish",
    computedAt,
    reason:
      `${changed.length} of ${file.length} param(s) differ from the store` +
      (computedAt === fileStamp ? "" : ` (re-stamped ${computedAt} — file stamp ${fileStamp} would tie)`),
  };
}

async function main(): Promise<void> {
  const env = readEnv();
  const force = process.argv.slice(2).includes("--force");
  const path = join(SCRIPT_DIR, "calibration.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as CalibrationFile;

  // Stays schema_version 1: the (market, mode) fan-out rides ADDITIVE nullable columns
  // (market/mode/…), never a schema bump — so publish hard-requires ==1 and rejects otherwise.
  // calibration.json is keyed by market/mode, NOT indicator; a COINCIDENT-membership change
  // (VT/R6) moves it only INDIRECTLY via the shifted CRITICAL day-set (small ci_low/ci_high +
  // computed_at), never as new keys.
  if (file.schema_version !== 1) {
    throw new Error(
      `calibration.json schema_version ${file.schema_version} is unsupported (expected 1); ` +
        "calibration.json is a frozen vintage (harness.py deleted 2026-08-15) — update the publisher mapping.",
    );
  }

  // snake_case JSON → camelCase domain; the run-level computed_at stamps every param.
  const params: CalibrationParam[] = file.params.map((p) => ({
    market: p.market ?? null,
    mode: p.mode ?? null,
    channel: p.channel,
    metric: p.metric,
    value: p.value,
    ciLow: p.ci_low ?? null,
    ciHigh: p.ci_high ?? null,
    method: p.method,
    nEvents: p.n_events ?? null,
    windowStart: p.window_start ?? null,
    windowEnd: p.window_end ?? null,
    notes: p.notes ?? null,
    computedAt: file.computed_at,
  }));

  const store = getStore("rw", env);
  const decision = force
    ? ({ action: "publish", computedAt: file.computed_at, reason: "--force" } as const)
    : decidePublish(await store.getCalibration(), params);

  // Every path prints exactly one `[publish-calibration] <verb>` line — the release chain
  // (scripts/publish-calibration-prod.sh) ASSERTS one of them, so a silently-no-op'ing step
  // can never read as a green publish.
  if (decision.action === "skip") {
    console.log(`[publish-calibration] skipped — ${decision.reason}`);
    return;
  }
  if (decision.action === "stale") {
    console.log(`[publish-calibration] ::warning:: stale — ${decision.reason}; pass --force to overwrite`);
    return;
  }

  const stamped = params.map((p) => ({ ...p, computedAt: decision.computedAt }));
  await store.recordCalibration(stamped);
  console.log(
    `[publish-calibration] wrote ${stamped.length} param(s) @ ${decision.computedAt} — ${decision.reason}`,
  );
}

// Entry guard: `decidePublish` is unit-tested, and importing this module must NOT run the
// publish (it would hit getStore() and exit(1) under vitest). Only a direct
// `tsx scripts/backtest/publish-calibration.ts` invocation publishes.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
