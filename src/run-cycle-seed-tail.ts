/** Run-cycle post-persist seed tail: the concurrent EOD seed batch, allSettled-then-rethrow; a skipped/failed task records a `notify` degrade naming its ids. */

import type { Reading } from "./domain-types.js";
import {
  backfillHistory,
  backfillCapeOnCron,
  seedLegClosesOnCron,
  seedGrowthRsOnCron,
  seedInputSeriesOnCron,
  inputSeriesFeeds,
  BACKFILL_PROBE_LIMIT,
} from "./run-seeds.js";
import type { RunBase } from "./run-cycle-ctx.js";
import type { Store } from "./store.js";
import type { Clock } from "./run-seeds.js";
import { isoDay } from "./dates.js";
import type { Env } from "./config.js";
import { realFeeds, type FeedPorts } from "./feed-ports.js";
import { markPhase, runHardDeadline } from "./fetch-budget.js";
import { recordDegrade } from "./tracks.js";
import { SEED_TAIL_SCOPE } from "./run-seeds.js";
import { errMsg } from "./err-msg.js";
import { INPUT_SERIES } from "./input-series.js";
import { LADDER } from "./families.js";
import { OFF_LADDER_LEG_KEYS, legCloseId, offLadderLegCloseId } from "./scoreboard.js";
import { growthRsId } from "./growth.js";

/**
 * The intraday seed tail: the input series (C3), then the `LEGP_*` closes of every day BEFORE the run's UTC date
 * ([USER] 2026-10-05) — today's bar is in progress, so its row stays the EOD seed's. A close a past EOD could not
 * write (the closes provider serves a Xetra D bar only after the 22:00 run; the EOD cron is weekday-only) lands on the next intraday
 * run instead of the next EOD. Rows dated before today are written past their 21:05 cutoff, so they are FINAL.
 * Both seeds are fail-safe (try/catch inside).
 */
export async function runIntradaySeedTail(store: Store, env: Env, clock: Clock, feeds: FeedPorts = realFeeds): Promise<void> {
  await seedInputSeriesOnCron(store, env, clock, undefined, inputSeriesFeeds(feeds));
  const yesterday = isoDay(new Date(Date.parse(`${clock().slice(0, 10)}T00:00:00Z`) - 86_400_000));
  await seedLegClosesOnCron(store, env, clock, yesterday, feeds);
}

/** One `runSeedTail` task: its `tail.<name>` mark, the ids it seeds (named by its degrade), whether it has settled, and its rejection. */
interface TailTask {
  readonly name: string;
  readonly ids: readonly string[];
  settled: boolean;
  rejected?: { reason: unknown };
  readonly p: Promise<unknown>;
}

/** The ids the `legs` serial pair seeds: the ladder + off-ladder `LEGP_*` closes, then the ladder's `GRS_*` RS cache. */
const LEGS_TASK_IDS: readonly string[] = [
  ...LADDER.map((sleeve) => legCloseId(sleeve)),
  ...OFF_LADDER_LEG_KEYS.map((leg) => offLadderLegCloseId(leg)),
  ...LADDER.map((sleeve) => growthRsId(sleeve)),
];
const INPUT_IDS: readonly string[] = INPUT_SERIES.map((s) => s.id);

/** Resolves `"deadline"` once `signal` aborts (at once if it already has). */
const abortOf = (signal: AbortSignal): Promise<"deadline"> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve("deadline");
    else signal.addEventListener("abort", () => resolve("deadline"), { once: true });
  });

/**
 * Per the 2026-11-06 `runSeedTail` ruling: a skipped or failed tail task records a `notify` degrade
 * (`SEED_TAIL_SCOPE`) naming its ids — never a silent drop (2026-11-04). Three paths:
 * - REJECTED: the task's ids + error, every rejection (the FIRST is still rethrown, as before).
 * - SKIPPED (an input-series id): the fail-safe per-id seed warn, routed through this tail's sink so it records `notify`.
 * - SKIPPED (the run hard deadline fired with the task unsettled): its ids, then abort the tasks' `signal`, close the tail
 *   (a late degrade/mark from an abandoned task is dropped) and return WITHOUT awaiting them — rethrowing a rejection that
 *   settled first — so `persistRunTrace` writes the trace inside its own window, not killed past `maxDuration`.
 * ⚠ The tail runs post-`drainDegradeLog`, after this run's push: `persistRunTrace` persists these via `drainLateDegrades`, which
 *   stores them `effect: "trace"` + `late: "notify"` — so the NEXT EOD push surfaces them once (`priorLateNotifyEvents`).
 */
export async function runSeedTail(
  ctx: RunBase,
  backfillSeries: { id: string; series: Reading[]; estimateDates: readonly string[] }[],
  alertDate: string,
): Promise<void> {
  // Post-recordRun seed tail, run CONCURRENTLY. Each task seeds under its own indicator_id with a DISTINCT
  // run_at (≠ firedAt) so historical rows surface only via /series, never /status's run_at-keyed read.
  // ⚠ ONE ORDERING CONSTRAINT: seedGrowthRsOnCron stays AFTER seedLegClosesOnCron (its RS axis needs today's
  // `LEGP_*` persisted) — a SERIAL PAIR that races alongside the batch, never two members of it.
  // ⚠ Starve-first is SAFE here: starting seedLegClosesOnCron concurrently only makes RUN_FETCH_BUDGET_MS
  // less likely to starve it. allSettled-then-rethrow (not bare Promise.all) so a second rejection can't leak unhandled.
  // Each task stamps `tail.<name>` when it settles — which one owns the tail's wall time.
  // `closed` (set as the deadline return aborts `signal`): every degrade/mark below is dropped once the tail has returned.
  const ctl = new AbortController();
  const { signal } = ctl;
  let closed = false;
  const degrade = (msg: string): void => {
    if (!closed) recordDegrade(SEED_TAIL_SCOPE, msg, "notify");
  };
  const task = (name: string, ids: readonly string[], run: () => Promise<unknown>): TailTask => {
    const t: { name: string; ids: readonly string[]; settled: boolean; rejected?: { reason: unknown }; p?: Promise<unknown> } = { name, ids, settled: false };
    t.p = (async () => {
      try {
        return await run();
      } catch (err) {
        t.rejected = { reason: err };
        degrade(`[tail.${name}] ${ids.join(",")} not seeded - task rejected: ${errMsg(err)}`);
        throw err;
      } finally {
        t.settled = true;
        if (!closed) markPhase(`tail.${name}`);
      }
    })();
    return t as TailTask;
  };
  // An input-series seed warn names its id (`[input-series] <id> seed non-live …`); the roster-wide one (probe failed) skips every id.
  const inputWarn = (msg: string): void => {
    console.warn(msg);
    const id = /^\[input-series\] (\S+) seed non-live/.exec(msg)?.[1];
    const named = id !== undefined && INPUT_IDS.includes(id);
    degrade(named ? msg : `${msg} - skipped ${INPUT_IDS.join(",")}`);
  };
  const tasks: TailTask[] = [
    // Backfill NVDA's history, one task per id (FXH legs persist inside their fetch, not here).
    ...backfillSeries.map((b) =>
      task(b.id, [b.id], () =>
        backfillHistory(ctx.store, b.id, b.series, BACKFILL_PROBE_LIMIT, ctx.clock, undefined, false, undefined, undefined, undefined, new Set(b.estimateDates), undefined, signal),
      ),
    ),
    // Keep the CAPE leg (F7, a display-only card — ECY scores the run's live CAPE fetch, stored F7 on a failed fetch) fresh. Best-effort, distinct run_at.
    task("cape", ["F7"], () => backfillCapeOnCron(ctx.store, ctx.clock, ctx.feeds.fetchCape, signal)),
    // Persist the nine legs' EUR closes (`LEGP_*`), then cache the cross-sectional RS off them. Serial pair (ordering constraint above).
    task("legs", LEGS_TASK_IDS, async () => {
      await seedLegClosesOnCron(ctx.store, ctx.env, ctx.clock, alertDate, ctx.feeds, signal);
      await seedGrowthRsOnCron(ctx.store, ctx.clock, alertDate, signal);
    }),
    // Persist the read handlers' upstream input series as raw rows (src/input-series.ts roster) so
    // api/series|replay|lab can go store-only. No ordering dep; rides the concurrent batch.
    task("inputs", INPUT_IDS, () => seedInputSeriesOnCron(ctx.store, ctx.env, ctx.clock, inputWarn, inputSeriesFeeds(ctx.feeds), undefined, signal)),
  ];
  const settledAll = Promise.allSettled(tasks.map((t) => t.p));
  const hard = runHardDeadline();
  if (hard !== null && (await Promise.race([settledAll, abortOf(hard)])) === "deadline" && tasks.some((t) => !t.settled)) {
    for (const t of tasks.filter((x) => !x.settled)) degrade(`[tail.${t.name}] ${t.ids.join(",")} skipped - unsettled at the run hard deadline`);
    closed = true;
    ctl.abort(hard.reason);
    const early = tasks.find((t) => t.rejected !== undefined)?.rejected;
    if (early) throw early.reason;
    return;
  }
  const tailFailure = (await settledAll).find((r) => r.status === "rejected");
  if (tailFailure) throw (tailFailure).reason;
}
