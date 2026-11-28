/**
 * Email channel for the BAND push — the second notify channel `ntfy.ts`'s docblock reserved
 *. Brevo transactional API, plain text, ONE call per
 * chunk of ≤99 subscribers, each subscriber its own `messageVersions` entry (its own `to` + its own
 * body) so nobody sees another address AND the footer's unsubscribe link carries the recipient's
 * address (in the FRAGMENT — see `unsubscribeLink`) for the subscribe page to prefill (user ask
 * 2026-09-05 — supersedes the plan's shared-BCC-body ruling).
 *
 * Contract with the caller (`persistRun`, run-cycle-persist.ts): this function NEVER throws — a
 * failure is logged (`error` dep) and swallowed here, so `push_error` / `pushed_at` / `recordRun`
 * stay byte-identical to the email-less run. The ntfy push is the deliverable; email is best
 * effort on top of it.
 */

import { brevoApiKey, dashboardUrl, emailFrom, emailSendEnabled, type Env } from "./config.js";
import { type FetchLike, fetchOk } from "./feed-http.js";
import type { NtfyMessage } from "./ntfy.js";

/** @internal */
export const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Message versions (= recipients) per Brevo call. Brevo documents 2000 recipients per request
 * (developers.brevo.com/reference/sendtransacemail, 2026-09-05); 99 keeps a failed chunk small
 * and matches the shape the plan ruled. With ≤99 subscribers this is exactly one call.
 * @internal
 */
export const EMAIL_CHUNK = 99;

/** Per-attempt fetch deadline + retry backoff — same posture as `pushNtfy`. */
const EMAIL_TIMEOUT_MS = 10_000;
const EMAIL_RETRY_BACKOFF_MS = 400;

/** Unsubscribe path = the subscribe page's `a=unsub` on `dashboard` (`dashboardUrl(env)`, shared with the push). Pure. */
function unsubscribeUrl(dashboard: string): string {
  return `${dashboard}/subscribe?a=unsub`;
}

/**
 * Per-recipient unsubscribe link. ⚠ The address rides the FRAGMENT (`#email=`), NEVER the query —
 * path + query reach Vercel's request log. Prefill only (`subscribe-view.js`); pure.
 * @internal
 */
export function unsubscribeLink(dashboard: string, email: string): string {
  return `${unsubscribeUrl(dashboard)}#email=${encodeURIComponent(email)}`;
}

/** Split into consecutive groups of at most `size` (last group may be shorter). Pure. @internal */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Mail body: the ntfy title + body verbatim (no second formatter — `buildNotification` is the
 * single source of the wording) plus a footer. With `recipient` the unsubscribe line is that
 * address's prefilled link; without it the generic one (the payload's top-level fallback). `dashboard`
 * undefined (`dashboardUrl` resolved nothing) ⇒ no footer — no Dashboard and no Unsubscribe line; the mail still
 * sends. Pure.
 * @internal
 */
export function emailBody(msg: NtfyMessage, dashboard: string | undefined, recipient?: string): string {
  const footer =
    dashboard === undefined
      ? []
      : [
          "",
          "--",
          `Dashboard: ${dashboard}`,
          `Unsubscribe: ${recipient ? unsubscribeLink(dashboard, recipient) : unsubscribeUrl(dashboard)}`,
        ];
  return [msg.title, "", msg.body, ...footer].join("\n");
}

interface BrevoMessageVersion {
  to: Array<{ email: string }>;
  textContent: string;
}

export interface BrevoPayload {
  sender: { email: string };
  subject: string;
  /** Generic body — Brevo only honours a per-version `textContent` when the top level has one too. */
  textContent: string;
  messageVersions: BrevoMessageVersion[];
}

/**
 * One Brevo request body for one chunk: one message version per recipient, each with a single
 * `to` and its own body, so no subscriber's address ever reaches another's mail. No top-level
 * `to` (Brevo ignores it when versions are present) and no BCC. Pure — header/body policy is
 * unit-tested without a live fetch.
 * @internal
 */
export function brevoPayload(
  msg: NtfyMessage,
  from: string,
  recipients: readonly string[],
  dashboard: string | undefined,
): BrevoPayload {
  return {
    sender: { email: from },
    subject: msg.title,
    textContent: emailBody(msg, dashboard),
    messageVersions: recipients.map((email) => ({ to: [{ email }], textContent: emailBody(msg, dashboard, email) })),
  };
}

function brevoHeaders(apiKey: string): Record<string, string> {
  return { "api-key": apiKey, "content-type": "application/json", accept: "application/json" };
}

/** One chunk: two attempts total (one retry), non-OK status counts as a failure. Throws on the second miss. */
async function sendChunk(
  payload: BrevoPayload,
  apiKey: string,
  fetchImpl: FetchLike | undefined,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<void> {
  await fetchOk(BREVO_SEND_URL, {
    fetchImpl,
    init: { method: "POST", headers: brevoHeaders(apiKey), body: JSON.stringify(payload) },
    timeoutMs: EMAIL_TIMEOUT_MS,
    label: "brevo send failed",
    runBudget: false,
    retry: { attempts: 2, backoffMs: EMAIL_RETRY_BACKOFF_MS, sleep },
  });
}

/** Outcome summary for the caller's log line; `failed` chunks were already `console.error`ed. */
export interface EmailSendResult {
  sent: number; // recipients in chunks that returned 2xx
  failed: number; // recipients in chunks that failed twice
  skipped: "disabled" | "no-recipients" | null;
}

/**
 * Fan the band mail out to `recipients`. Never throws (see module docblock). A chunk that fails
 * twice is logged and the NEXT chunk still sends — a partial delivery beats none.
 */
/** IO seams; each but the required `env` defaults to the real global, resolved per call. */
export interface SendBandEmailDeps {
  fetchImpl?: FetchLike;
  env: Env;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export async function sendBandEmail(
  msg: NtfyMessage,
  recipients: readonly string[],
  deps: SendBandEmailDeps,
): Promise<EmailSendResult> {
  const {
    fetchImpl,
    env,
    sleep,
    warn = (m: string) => console.warn(m),
    error = (m: string) => console.error(m),
  } = deps;
  if (!emailSendEnabled(env)) {
    warn(`[email] send suppressed - set BREVO_API_KEY + EMAIL_FROM to enable: ${msg.title}`);
    return { sent: 0, failed: 0, skipped: "disabled" };
  }
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: "no-recipients" };
  const apiKey = brevoApiKey(env)!;
  const from = emailFrom(env)!;
  const dashboard = dashboardUrl(env);
  let sent = 0;
  let failed = 0;
  for (const group of chunk(recipients, EMAIL_CHUNK)) {
    try {
      await sendChunk(brevoPayload(msg, from, group, dashboard), apiKey, fetchImpl, sleep);
      sent += group.length;
    } catch (err) {
      failed += group.length;
      error(
        `[email] band mail FAILED for ${group.length} recipient(s) (next chunk still sends): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { sent, failed, skipped: null };
}
