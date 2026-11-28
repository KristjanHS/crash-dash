/**
 * Run-wide fetch budget (DATA-4): ONE elapsed-time (`performance.now()`) deadline shared by every feed of a
 * scoring cycle.
 *
 * Per-attempt timeouts cannot buy this guarantee. The cycle's phases are SEQUENTIAL
 * (baa10y → INDICATORS → price/vix → confirmers → tracks → globals → scoreboard), so
 * even at an 8s per-attempt timeout the chain can still exceed the cron's `maxDuration`
 * — the function is killed mid-flight, nothing is persisted, and the day's vintage is
 * gone for good (Vercel never retries). A budget bounds the SUM instead of each term:
 * once it fires, every in-flight and every subsequent fetch aborts at once, each feed's
 * EXISTING degrade path treats that abort exactly like a timeout, and the cycle reaches
 * recordRun degraded rather than not at all.
 *
 * Module-level, reset at `runScoringCycle` entry — the same idiom (and the same
 * "runScoringCycle is serial in prod" premise) as the degrade collector in tracks.ts.
 * Unset (CLI probes, backfill scripts, feed unit tests) ⇒ `runFetchSignal` returns the
 * bare per-attempt timeout, i.e. today's exact behavior.
 */

import { setMaxListeners } from "node:events";

/** `vercel.json` `functions["api/cron/*.ts"].maxDuration` × 1000 — pinned by `api/deploy-budget.test.ts`. @internal */
export const RUN_MAX_DURATION_MS = 300_000;

/**
 * The whole cycle's fetch allowance; persist + the seed tail keep the rest of `RUN_HARD_DEADLINE_MS`. Keep the
 * commit point inside `smoke-cron.sh`'s `MAX_WAIT_SECS`. Validated by the all-feeds-hang test in run.wiring.feeds.test.ts.
 */
export const RUN_FETCH_BUDGET_MS = 90_000;

/**
 * The degrade-event `scope` the cron path records when the run-wide deadline fired. It is the
 * ONE machine-readable marker distinguishing "a feed is genuinely dark" from "we ran out of
 * time" — `notify_format` forces the calm-ward caveat on it regardless of how few families
 * went non-live, because a budget abort can starve exactly one family and still bias the band.
 * A scope constant (not a substring match on an abort message) so the signal cannot rot when a
 * feed rewraps its error text.
 */
export const BUDGET_ABORT_SCOPE = "[fetch-budget] run-wide fetch deadline fired";

/** Anchor + this = the cron's last moment for any DB call, 5 s inside the `RUN_MAX_DURATION_MS` kill. */
export const RUN_HARD_DEADLINE_MS = RUN_MAX_DURATION_MS - 5_000;

/** The post-tail trace write's own deadline (`openTraceWindow`) — 1 s inside the kill. @internal */
export const RUN_TRACE_DEADLINE_MS = RUN_MAX_DURATION_MS - 1_000;

/** Ceiling on the cold-start offset `process.uptime()` may charge (observed cold start ~9 s). @internal */
export const MAX_COLD_OFFSET_MS = 15_000;

let deadline: AbortSignal | null = null;
let hardDeadline: AbortSignal | null = null;
let hardDeadlineAt: number | null = null;
let anchor: { at: number; cold: boolean } | null = null;
let processAnchored = false;

/** One run's phase marks, persisted as `alert_log.timings`: ms since the run anchor (the budget start on an un-anchored CLI run). */
export interface RunTimings {
  /** null = un-anchored (CLI) run. */
  cold: boolean | null;
  /** The cold-start/handler offset `startRunBudget` charged to the budget. */
  anchorMs: number;
  marks: Record<string, number>;
}
let timingBase: number | null = null;
let timings: RunTimings | null = null;

/**
 * Cron handler entry: anchor the run clock. The first call in a process is a cold start and anchors at
 * process start (`now - uptimeMs`, clamped to `MAX_COLD_OFFSET_MS`); later (warm) calls anchor at `now`.
 */
export function markRunAnchor(now: number, uptimeMs: number = process.uptime() * 1000): void {
  const cold = !processAnchored;
  processAnchored = true;
  anchor = { at: cold ? now - Math.min(uptimeMs, MAX_COLD_OFFSET_MS) : now, cold };
}

/** `reason` for a DB signal must be a `DOMException` "AbortError" — postgrest-js retries any other GET failure 3× with backoff. */
function abortingSignal(ms: number, reason: () => Error): AbortSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(reason()), Math.max(0, ms));
  timer.unref?.();
  // Every fetch of the run composes onto this ONE signal, so the listener count is
  // the run's fetch count (~40) — well past the EventTarget leak warning's default 10.
  setMaxListeners(0, ctl.signal);
  return ctl.signal;
}

/**
 * Open a fresh budget for one cycle. The timer is `unref`'d so the deadline never holds
 * the CLI process open past a fast run, and a new call supersedes any previous budget.
 * A pending `markRunAnchor` (the cron path) charges its elapsed time to the budget and arms the
 * DB hard deadline; without one (CLI) the budget starts now with no hard deadline — the 10 s DB cap still applies.
 */
export function startRunBudget(
  budgetMs: number,
  now: number,
  log: (msg: string) => void = console.log,
): void {
  const elapsed = anchor ? now - anchor.at : 0;
  deadline = abortingSignal(budgetMs - elapsed, () => new Error(`run fetch budget of ${budgetMs}ms exhausted - feed aborted`));
  hardDeadline = anchor
    ? abortingSignal(
        RUN_HARD_DEADLINE_MS - elapsed,
        () => new DOMException(`[db] run hard deadline of ${RUN_HARD_DEADLINE_MS}ms fired - call aborted`, "AbortError"),
      )
    : null;
  hardDeadlineAt = anchor ? anchor.at + RUN_HARD_DEADLINE_MS : null;
  timingBase = anchor ? anchor.at : now;
  timings = { cold: anchor ? anchor.cold : null, anchorMs: Math.round(elapsed), marks: {} };
  if (anchor) log(`[budget] anchor offset=${(elapsed / 1000).toFixed(1)}s (${anchor.cold ? "cold" : "warm"})`);
  anchor = null;
}

/** The run's DB hard deadline — armed only on an anchored (cron) run. */
export function runHardDeadline(): AbortSignal | null {
  return hardDeadline;
}

/**
 * Post-tail trace write ONLY (every tail task has settled): re-arm the DB hard deadline at `RUN_TRACE_DEADLINE_MS`,
 * so a tail that spent the run's hard deadline cannot also abort `updateRunTrace`. No-op when none is armed.
 */
export function openTraceWindow(now: number): void {
  if (hardDeadlineAt === null) return;
  const traceAt = hardDeadlineAt - RUN_HARD_DEADLINE_MS + RUN_TRACE_DEADLINE_MS;
  hardDeadline = abortingSignal(
    traceAt - now,
    () => new DOMException(`[db] run trace deadline of ${RUN_TRACE_DEADLINE_MS}ms fired - call aborted`, "AbortError"),
  );
  hardDeadlineAt = traceAt;
}

/** Ms left until the DB hard deadline fires; `Infinity` when none is armed (CLI, tests). */
export function runMsUntilHardDeadline(now: number): number {
  return hardDeadlineAt === null ? Infinity : hardDeadlineAt - now;
}

/** Stamp phase `name` at `performance.now()`; a no-op before the first `startRunBudget`. */
export function markPhase(name: string): void {
  if (timings !== null && timingBase !== null) timings.marks[name] = Math.round(performance.now() - timingBase);
}

/** A copy of this run's marks so far, or null when no budget was opened. */
export function runTimings(): RunTimings | null {
  return timings === null ? null : { ...timings, marks: { ...timings.marks } };
}

/** The one `[timing]` log line: seconds since the anchor per mark, in stamp order. */
export function timingLine(t: RunTimings): string {
  const marks = Object.entries(t.marks).map(([k, ms]) => `${k}=${(ms / 1000).toFixed(1)}`);
  const anchorTag = t.cold === null ? "cli" : t.cold ? "cold" : "warm";
  return `[timing] anchor=${(t.anchorMs / 1000).toFixed(1)}s(${anchorTag}) ${marks.join(" ")}`;
}

/**
 * Did THIS cycle's run-wide deadline actually fire? True only once the budget is exhausted;
 * false when no budget is open (CLI probes / unit tests) or when the run finished inside it.
 * Read once after the fetch phase so the run can record `BUDGET_ABORT_SCOPE`.
 */
export function runBudgetExhausted(): boolean {
  return deadline?.aborted ?? false;
}

/** Is a run budget open (the cron cycle, or a warm container after one)? False for backfill scripts and the direct-feed probes. */
export function runBudgetOpen(): boolean {
  return deadline !== null;
}

/** Drop the budget (no deadline ⇒ per-attempt timeouts only). Test-isolation seam. */
export function clearRunBudget(): void {
  deadline = null;
  hardDeadline = null;
  hardDeadlineAt = null;
  anchor = null;
  processAnchored = false;
  timingBase = null;
  timings = null;
}

/**
 * The signal a feed passes to `fetch`: its OWN per-attempt timeout composed with the run
 * deadline, whichever fires first. The per-attempt timeout is NOT replaced — it still
 * turns a single stalled request into a fast, retryable failure; the deadline only caps
 * what the retries and the sequential phases can add up to.
 */
export function runFetchSignal(perAttemptMs: number): AbortSignal {
  const perAttempt = AbortSignal.timeout(perAttemptMs);
  return deadline ? AbortSignal.any([perAttempt, deadline]) : perAttempt;
}

/** A feed client's injectable `fetchImpl` seam; `feed-http.ts` defaults it to the global
 *  `fetch` read per CALL — never defined here, or api/no-upstream-fetch.test.ts sees this module as a feed. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
