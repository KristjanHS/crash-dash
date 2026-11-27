/**
 * The Supabase client's `global.fetch`: once a process opens a run budget (cron, `npm start`), every DB call is capped
 * at `DB_CALL_TIMEOUT_MS` (to response headers) and at the run's hard deadline; before that (backfills, read API) plain fetch.
 * Also the per-run DB tally behind the cron's one `[db]` log line.
 */

import { runBudgetOpen, runHardDeadline } from "./fetch-budget.js";

export const DB_CALL_TIMEOUT_MS = 10_000;

interface DbStats {
  calls: number;
  failed: number;
  busyMs: number;
  maxInFlight: number;
  slowestMs: number;
}

let stats: DbStats = { calls: 0, failed: 0, busyMs: 0, maxInFlight: 0, slowestMs: 0 };
let inFlight = 0;
let busySince = 0;

/** Keeps `inFlight` — an overlapping invocation's calls still settle into it. */
export function resetDbStats(): void {
  stats = { calls: 0, failed: 0, busyMs: 0, maxInFlight: inFlight, slowestMs: 0 };
  busySince = performance.now();
}

export function dbStats(): Readonly<DbStats> {
  return { ...stats };
}

export function dbStatsLine(): string {
  const s = stats;
  return `[db] calls=${s.calls} failed=${s.failed} busy=${(s.busyMs / 1000).toFixed(1)}s maxInFlight=${s.maxInFlight} slowest=${(s.slowestMs / 1000).toFixed(1)}s`;
}

/** Reads `globalThis.fetch` per call, so a test stub or `scripts/trace-db-calls.mjs` sees every DB call. */
export const dbFetch: typeof fetch = async (input, init) => {
  const start = performance.now();
  if (inFlight++ === 0) busySince = start;
  stats.calls++;
  stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!runBudgetOpen()) return await globalThis.fetch(input, init);
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(new DOMException(`[db] call exceeded ${DB_CALL_TIMEOUT_MS}ms - aborted`, "AbortError")), DB_CALL_TIMEOUT_MS);
    const hard = runHardDeadline();
    const own = init?.signal;
    const parts = [ctl.signal, ...(hard ? [hard] : []), ...(own ? [own] : [])];
    return await globalThis.fetch(input, { ...init, signal: parts.length === 1 ? ctl.signal : AbortSignal.any(parts) });
  } catch (err) {
    stats.failed++;
    throw err;
  } finally {
    clearTimeout(timer);
    const end = performance.now();
    stats.slowestMs = Math.max(stats.slowestMs, end - start);
    if (--inFlight === 0) stats.busyMs += end - busySince;
  }
};
