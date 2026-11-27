/**
 * Trigger the deployed cron (`<base>/api/cron/run<query>` with the CRON_SECRET bearer) — a prod WRITE (a full cycle,
 * persistence, the push; `?email=force` also mails every subscriber), so the prod-writes switch is consulted FIRST,
 * before any network call.
 *
 * Bash twin: `scripts/lib/cron-trigger.sh` (`cron_trigger`) — every CRON_SECRET-bearing trigger in scripts/ goes
 * through one of the two (`scripts/lib/cron-trigger.test.ts` greps for strays).
 */
import { requireProdWrites, type ProdWritesEnv } from "../../src/prod-writes.js";

export const CRON_PATH = "/api/cron/run";

export async function triggerCron(
  base: string,
  query: string,
  secret: string,
  env: ProdWritesEnv,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  requireProdWrites("the cron trigger", env);
  const { timeoutMs = 90_000, fetchImpl = fetch } = opts;
  return fetchImpl(`${base.replace(/\/$/, "")}${CRON_PATH}${query}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
