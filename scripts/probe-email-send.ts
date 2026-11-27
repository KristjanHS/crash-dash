/**
 * Prod band-mail trigger — a verify step.
 *
 *   npm run probe:email-send            # prod (default): .env.prod's CRON_SECRET + the live URL
 *   npm run probe:email-send -- --base=http://localhost:3000   # a `vercel dev` / preview URL
 *
 * WHAT IT DOES: GET `<base>/api/cron/run?email=force` with the bearer — the REAL cron path on
 * Vercel runs a normal cycle and then mails the CURRENT band to every `email_subscribers` row via
 * the prod Brevo key + verified sender (`runScoringCycle({forceEmail:true})`, `run-cycle.ts`).
 * The fan-out is otherwise gated on a DELIVERED band push, so this is the only on-demand way to
 * prove the prod send leg end-to-end. Persistence + the ntfy push are unchanged by the flag.
 *
 * ⚠ Every subscriber receives a mail. Run it deliberately, not as a smoke step.
 *
 * The per-recipient count is in the function log (`[email] band mail (forced): N sent`):
 *   npx vercel logs <prod alias> --since 5m | grep '\[email\]'
 */
import { cronSecret, readEnv } from "../src/config.js";
import { CRON_PATH, triggerCron } from "./lib/cron-trigger.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

const arg = (k: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const base = (arg("base") ?? prodBaseUrl()).replace(/\/$/, "");
const env = readEnv();
const secret = cronSecret(env);
if (!secret) {
  console.error("CRON_SECRET missing — run via `npm run probe:email-send` (loads .env.prod) or export it.");
  process.exit(2);
}

console.log(`[probe:email-send] GET ${base}${CRON_PATH}?email=force`);
const res = await triggerCron(base, "?email=force", secret, env);
const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
console.log(`[probe:email-send] HTTP ${res.status} level=${String(body.level ?? "?")} firedAt=${String(body.firedAt ?? "?")}`);
if (!res.ok) {
  console.error(body);
  process.exit(1);
}
console.log("[probe:email-send] cycle ran; check the inbox + the function log for `[email] band mail (forced)`.");

export {};
