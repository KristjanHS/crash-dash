/**
 * GET /api/cron/run — internal: fetch, score, persist, notify (openapi.yaml
 * `runCron`). Scheduled by vercel.json; Vercel Cron invokes it with GET and an
 * `Authorization: Bearer $CRON_SECRET` header (Vercel's built-in cron auth).
 *
 * Fails loud (500) if CRON_SECRET is unset so a misconfigured deploy can never
 * run the cycle unauthenticated. Returns the stored verdict.
 * Vercel Node function (Web-handler signature).
 */
import { invalidateByTag } from "@vercel/functions";
import { cronBearerOk, cronSecret, readEnv, type Env } from "../../src/config.js";
import { runScoringCycle, seedIntradayTail } from "../../src/run-cycle.js";
import type { Clock } from "../../src/run-seeds.js";
import { isIntradayCronRun } from "../../src/intraday.js";
import { VINTAGE_TAG } from "../../src/api/http.js";
import { markRunAnchor } from "../../src/fetch-budget.js";
import { dbStatsLine, resetDbStats } from "../../src/db-fetch.js";

/** `handle`'s injectable seams; `CRON_DEPS` holds the production one for each, and `GET` runs with exactly those. */
export interface CronDeps {
  runScoringCycle: typeof runScoringCycle;
  seedIntradayTail: (env: Env, clock: Clock) => Promise<void>;
  invalidateByTag: (tag: string) => Promise<unknown>;
  /** Per-purge cap; a purge still pending at it counts as failed (`X-Vintage-Purged: false`). */
  purgeTimeoutMs: number;
  /** The entry's ONE env read; the cycle, the seed tail and `cronSecret` all take this value. */
  readEnv: () => Env;
  /** The configured bearer secret; `undefined` ⇒ the fail-loud 500. */
  cronSecret: (env: Env) => string | undefined;
  /** The entry's wall clock: the intraday/EOD split and the cycle's `Clock` both read it. */
  now: () => Date;
  error: (...args: unknown[]) => void;
}

export const CRON_DEPS: Readonly<CronDeps> = Object.freeze({
  runScoringCycle,
  seedIntradayTail,
  invalidateByTag,
  purgeTimeoutMs: 10_000,
  readEnv,
  cronSecret,
  now: () => new Date(),
  // Deferred lookup: the logger is resolved per call, not captured at module load.
  error: (...args: unknown[]) => console.error(...args),
});

export async function GET(req: Request): Promise<Response> {
  markRunAnchor(performance.now());
  resetDbStats();
  try {
    return await handle(req);
  } finally {
    console.log(dbStatsLine());
  }
}

/** The auth + error boundary around one cycle; any seam left out of `over` is the production one. */
export async function handle(req: Request, over: Partial<CronDeps> = {}): Promise<Response> {
  const deps: CronDeps = { ...CRON_DEPS, ...over };
  const env = deps.readEnv();
  const secret = deps.cronSecret(env);
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  // The constant-time compare lives in config.ts, shared with /api/health's deep-probe gate.
  if (!cronBearerOk(req, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Fail loud but JSON-parseable: an upstream error (FRED down, Supabase reject)
  // returns a 500 with a readable body instead of Vercel's opaque HTML 500. The
  // full stack still lands in the Vercel function log.
  try {
    // `?email=force` (owner verify, Stage 5): mail the current band to every subscriber even
    // without a band change. Same bearer gate as the run itself; nothing else changes.
    const params = new URL(req.url).searchParams;
    const forceEmail = params.get("email") === "force";
    // Intraday (silent, alert-less) per `isIntradayCronRun` (intraday.ts): before 21:05 UTC or any UTC weekend;
    // `?email=force` overrides only the weekday cutoff.
    const intraday = isIntradayCronRun(deps.now(), forceEmail);
    // `?rederive=0` (intraday only): readings only — the verdict slot is emptied, so every verdict read stays
    // on the last EOD run (RunCycleOptions.rederive). Ignored on an EOD run, which always writes alert_log.
    const rederive = params.get("rederive") !== "0";
    const clock: Clock = () => deps.now().toISOString();
    // The purge, NOT the TTL, is what makes this run visible: every `VINTAGE_HEADERS` read
    // ships a day-long s-maxage+SWR (P-2), so a swallowed failure here is a day-stale board.
    // It rides a HEADER, never the body — `openapi.yaml` pins this response to `AlertRecord`.
    let purged = true;
    // Bounded: a hung commit-point purge must not stall the seed tail into the maxDuration kill.
    const purge = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.invalidateByTag(VINTAGE_TAG),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${deps.purgeTimeoutMs} ms`)), deps.purgeTimeoutMs);
          }),
        ]);
      } catch (err) {
        purged = false;
        deps.error(`[cron] edge purge of "${VINTAGE_TAG}" FAILED - board may serve stale:`, err);
      } finally {
        clearTimeout(timer);
      }
    };
    // EOD purges twice: at the commit point (`onCommitted`, before the seed tail — a maxDuration kill there can't
    // hide the committed run) and again here, so the tail's seeded rows are served too.
    const verdict = await deps.runScoringCycle(
      clock,
      intraday ? { env, forceEmail, intraday, deferIntradaySeed: true, ...(rederive ? {} : { rederive }) } : { env, forceEmail, intraday, onCommitted: purge },
    );
    await purge();
    // Intraday seed tail (input series + pre-today leg closes) runs AFTER the purge (a ~50-fetch loop): a maxDuration
    // kill here can't hide the readings.
    if (intraday) {
      try {
        await deps.seedIntradayTail(env, clock);
      } catch (err) {
        deps.error("[cron] intraday seed tail failed:", err);
      }
      // Re-purge so the tail's rows are served too (a read between the two purges would edge-cache the pre-tail copy all day).
      await purge();
    }
    // `runInputs` is replay-only, never on the wire (openapi's `AlertRecord` omits it).
    const { runInputs: _runInputs, ...body } = verdict;
    return Response.json(body, { headers: { "X-Vintage-Purged": String(purged) } });
  } catch (err) {
    // Log BEFORE returning: the catch swallows the throw into the response body,
    // which `vercel crons run` never surfaces — without this, a cron that 500s on
    // every run (e.g. a prod schema drift) leaves no log breadcrumb beyond the
    // status code, and the last `console.log` (an indicator line) masquerades as
    // the failure. The full stack lands in the Vercel function log.
    deps.error("[cron] scoring cycle failed:", err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
