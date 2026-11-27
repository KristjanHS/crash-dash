/**
 * Email-subscription PURE seam. DOM-free by
 * construction: plain data in, plain data out, so `subscribe-view.test.js` covers it with no
 * jsdom (`frontend.md` §Testable slices go in a pure seam module). `subscribe.js` is the shell
 * that owns `document`, `fetch` and `location`; its only storage is the shared per-tab session
 * seam (`auth-session.js`, J0.2).
 *
 * The flow this seam shapes: the visitor asks for a magic link whose `redirect_to` carries the
 * intent (`?a=sub` / `?a=unsub`); Supabase Auth mails it; the click lands back here with a
 * session in the fragment, and the page performs THAT intent against `email_subscribers` with
 * the visitor's own bearer — the magic link IS the double opt-in, and the table's RLS
 * (`user_id = auth.uid()`) is what makes a forged row impossible. The token helpers the journal
 * already has (`parseAuthHash`, `sessionExpired`, `userIdFromJwt`) are imported there, not copied.
 */

import { SUPABASE_ANON_KEY, SUPABASE_ORIGIN } from "./supabase-host.js";

/** The page's own path as the site serves it (`vercel.json` cleanUrls) — also the redirect allow-list entry. */
export const SUBSCRIBE_PATH = "/subscribe";

/** The two intents a magic link can carry. Anything else is treated as "no intent" (a plain visit). */
export const ACTIONS = Object.freeze(["sub", "unsub"]);

/**
 * The magic-link return target: origin + the FIXED page path + the intent, nothing from
 * `location.href` (S-3 — the link the visitor arrived on may carry any path/query/fragment).
 * An unknown action throws rather than mailing a link that lands with no intent.
 */
export function subscribeRedirect(origin, action) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown subscribe action: ${String(action)}`);
  return `${String(origin ?? "").replace(/\/+$/, "")}${SUBSCRIBE_PATH}?a=${action}`;
}

/** The intent carried in the page's query string (`?a=sub|unsub`), or null when absent/unknown. */
export function actionFromLocation(search) {
  const a = new URLSearchParams(String(search ?? "").replace(/^\?/, "")).get("a");
  return ACTIONS.includes(a) ? a : null;
}

/**
 * The unsubscribe link's prefill, never trusted (the deleted row comes off the JWT). Reads the
 * FRAGMENT first (`#email=`, what `unsubscribeLink` emits); `?email=` is the already-sent-mail fallback.
 */
export function emailFromLocation(search, hash) {
  return validEmail(param(hash, "#").get("email")) ?? validEmail(param(search, "?").get("email"));
}

function param(raw, lead) {
  return new URLSearchParams(String(raw ?? "").replace(lead === "#" ? /^#/ : /^\?/, ""));
}

function validEmail(value) {
  const e = value?.trim() ?? "";
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e) ? e : null;
}

/** The `email` claim of a JWT — what the row stores beside the id. Null on anything unparseable. */
export function emailFromJwt(token) {
  const claims = jwtClaims(token);
  const email = claims?.email;
  return typeof email === "string" && email !== "" ? email : null;
}

function jwtClaims(token) {
  const part = String(token ?? "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/**
 * The PostgREST row for the upsert. Both fields come off the SAME token: `user_id` is what the
 * insert policy checks, `email` is the address the cron will BCC. Null when the token carries
 * neither — the shell then reports rather than posting a row the database would reject.
 */
export function subscriberRow(token) {
  const claims = jwtClaims(token);
  const userId = claims?.sub;
  const email = emailFromJwt(token);
  if (typeof userId !== "string" || userId === "" || !email) return null;
  return { user_id: userId, email };
}

/**
 * The browser-side connection — the pinned host plus the PUBLIC anon key, both literals in
 * `supabase-host.js`. Null unless the key is key-shaped (`sb_publishable_…` or a JWT) — an unstamped
 * repo copy holds a placeholder: the page then says so instead of sending requests GoTrue would 401.
 * A shape test, never a comparison with the placeholder text: the deploy stamp rewrites that token
 * everywhere, so a comparison would become `key === <real key>` and null the live page.
 */
export function publicConnection(anonKey = SUPABASE_ANON_KEY) {
  const key = String(anonKey ?? "").trim();
  return /^(sb_publishable_|eyJ)/.test(key) ? { url: SUPABASE_ORIGIN, anonKey: key } : null;
}

/** PostgREST endpoints for the list, built from the connection. */
export const subscribersUrl = (conn) => `${conn.url}/rest/v1/email_subscribers`;
export const unsubscribeUrl = (conn, userId) =>
  `${conn.url}/rest/v1/email_subscribers?user_id=eq.${encodeURIComponent(String(userId))}`;

/**
 * The own-row lookup behind the "already subscribed?" check. Filtered by id even though RLS
 * (`user_id = auth.uid()`) already hides every other row — the filter is what makes the intent
 * readable, the policy is what makes it safe. Only the address comes back: the check needs to
 * know the row exists and which address it holds, nothing else.
 * Spelled out from `conn.url` like its neighbours rather than composed from them: the CSP
 * connect-src lint (`api/security-headers.test.ts`) resolves a fetched helper ONE hop, so a
 * helper built on another helper reads as an underivable origin and fails the gate.
 */
export const ownRowUrl = (conn, userId) =>
  `${conn.url}/rest/v1/email_subscribers?user_id=eq.${encodeURIComponent(String(userId))}&select=email&limit=1`;

/** The address on the own row PostgREST returned (a one-element array), or null when the list has none. */
export function subscribedEmail(rows) {
  const email = Array.isArray(rows) ? rows[0]?.email : undefined;
  return typeof email === "string" && email !== "" ? email : null;
}

/**
 * Two addresses naming the same mailbox for the purposes of this page: the typed input vs a JWT
 * claim or a stored row. Case- and space-insensitive, which is how GoTrue itself stores them;
 * nothing subtler (no plus-tag folding) — a wrong answer here only mails a link the visitor asked
 * for, and the upsert is idempotent either way.
 */
export function sameAddress(a, b) {
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const left = norm(a);
  return left !== "" && left === norm(b);
}

/** The one-line status per outcome — a single table so the shell and the test share the copy. */
export const MESSAGES = Object.freeze({
  sent: "Link sent - open it from the inbox of that address to confirm. If that address is already subscribed the link just signs you in; nothing is duplicated.",
  deviceSubscribed:
    "That address is already subscribed from this browser - no link sent. If you unsubscribed on another device, use Send the link anyway.",
  alreadySubscribed:
    "That address is already subscribed - no link sent, nothing to do. This tab is signed in already: open the dashboard, lab or journal from the links above, or use Unsubscribe below to stop the mails.",
  alreadyConfirmed:
    "You were already subscribed - nothing changed, and this tab is now signed in. Next time sign in on /signin instead; subscribing again is never needed.",
  subscribed: "Subscribed ✓ - band alerts will reach this address. Your account is ready and this tab is signed in - open the dashboard, lab or journal from the links above.",
  removed:
    "Removed ✓ - no more mails to this address. This stops the mails only: your account and your journal entries stay, and you can sign in any time on /signin. To erase everything instead, use Delete my account on /journal.",
  expired: "Link expired - request a new one.",
  nointent: "This link carried no intent - the redirect allow-list must contain /subscribe* (owner). Request a new link.",
  unconfigured: "Email alerts are not configured on this deployment yet.",
  unsubPrompt:
    "Enter the address to remove and click Unsubscribe - a confirmation link follows. This stops the mails and keeps your account; to erase everything, use Delete my account on /journal.",
  unsubPrefilled:
    "Click Unsubscribe to remove this address - a confirmation link follows. This stops the mails and keeps your account; to erase everything, use Delete my account on /journal.",
});
