/**
 * Notification layer: ntfy (no account; topic name is the shared secret).
 * Abstracted behind one function (v4 §9) so swapping to Telegram/email later
 * is a single edit. The topic now lives in env (config.ntfyTopic) — see config.ts.
 */

import { dashboardUrl, ntfyTopic, ntfyPushEnabled, type Env } from "./config.js";
import { type FetchLike, fetchOk } from "./feed-http.js";

export interface NtfyMessage {
  title: string; // ASCII only — HTTP headers reject non-latin1 chars
  body: string;
  tags?: string; // comma-separated ntfy tag/emoji names
  priority?: number; // ntfy delivery priority 1 (min) .. 5 (max, bypasses DND)
}

/**
 * Assemble the ntfy request headers from a message. Pure (no IO) so the
 * header policy — which fields are present/omitted — is unit-testable without
 * a live `fetch`. Omitted optional fields produce no header (no "undefined").
 * `dashboard` (`dashboardUrl(env)`) is the tap target (`Click`); undefined ⇒ no `Click`, the push still sends.
 * @internal
 */
export function ntfyHeaders(msg: NtfyMessage, dashboard: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Title: msg.title };
  if (dashboard !== undefined) headers.Click = dashboard;
  if (msg.tags) headers.Tags = msg.tags;
  if (msg.priority !== undefined) headers.Priority = String(msg.priority);
  return headers;
}

/** Per-attempt fetch deadline — the push is the deliverable, so a hung ntfy.sh must
 *  not stall the whole cron (audit rank 1). Node aborts the fetch at this bound. */
const NTFY_TIMEOUT_MS = 10_000;
/** Short backoff before the single retry — smooths a transient blip without stalling. */
const NTFY_RETRY_BACKOFF_MS = 400;

/** IO seams; each but the required `env` defaults to the real global, resolved per call. */
export interface PushNtfyDeps {
  fetchImpl?: FetchLike;
  env: Env;
  sleep?: (ms: number) => Promise<void>;
}

export async function pushNtfy(msg: NtfyMessage, deps: PushNtfyDeps): Promise<void> {
  const { fetchImpl, env, sleep } = deps;
  if (!ntfyPushEnabled(env)) {
    // Blank/unset NTFY_TOPIC outside prod → don't POST to the PUBLIC dev topic.
    console.warn(`[ntfy] push suppressed - set NTFY_TOPIC to enable: ${msg.title}`);
    return;
  }
  const headers = ntfyHeaders(msg, dashboardUrl(env));
  const url = `https://ntfy.sh/${ntfyTopic(env)}`;

  // Two attempts total (one retry): the push the owner reads is the least-guarded link,
  // so a transient timeout / 5xx / network drop gets one more shot before it counts as a
  // failure the caller records (run-cycle-push.ts persists push_error + re-asserts next run). A non-OK
  // HTTP status is a failure, same as a thrown fetch — both retry, then throw.
  await fetchOk(url, {
    fetchImpl,
    init: { method: "POST", headers, body: msg.body },
    timeoutMs: NTFY_TIMEOUT_MS,
    label: "ntfy push failed",
    runBudget: false,
    retry: { attempts: 2, backoffMs: NTFY_RETRY_BACKOFF_MS, sleep },
  });
}

/** Re-exported so run-cycle-push.ts can log the destination topic — and tell a real send from a
 *  suppressed one (`pushNtfy` returns void either way) — without a config import. */
export { ntfyTopic, ntfyPushEnabled } from "./config.js";
