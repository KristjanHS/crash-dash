/**
 * Email-subscription thin shell: DOM + fetch + the shared per-tab session. Every decision (the
 * redirect target, the intent parse, the row shape, the copy) lives in the pure subscribe-view.js
 * seam, which is where the tests are. This file runs module-level DOM side effects and is NEVER
 * imported by a test (`frontend.md`).
 *
 * Zero Vercel functions: the browser talks to GoTrue (magic link) and PostgREST
 * (`email_subscribers`, RLS-scoped to the visitor's own row) directly, exactly like the journal.
 * Auth is wired on this page and the journal only; index/lab/exposure keep reading anon with no
 * login. The session a magic link lands here is kept through `auth-session.js` (J0.2) — the
 * same posture the journal has — so `/journal` opened afterwards is already signed in, in any
 * tab and after a restart (J0.4 reversed 2026-09-06).
 */
import { parseAuthHash, sessionExpired, otpUrl } from "./journal-view.js";
import { ensureSession, forgetSubscriber, rememberSubscriber, rememberedSubscriber, storeSession } from "./auth-session.js";
import { getJson, send } from "./http.js";
import {
  MESSAGES,
  actionFromLocation,
  emailFromLocation,
  ownRowUrl,
  publicConnection,
  sameAddress,
  subscribeRedirect,
  subscribedEmail,
  subscriberRow,
  subscribersUrl,
  unsubscribeUrl,
} from "./subscribe-view.js";

const $ = (id) => document.getElementById(id);
const conn = publicConnection();

function say(text, tone) {
  const el = $("msg");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/** Show/hide the stale-marker escape. Hidden on every path that is not the device-hint notice. */
function offerSendAnyway(on) {
  $("sendanyway").hidden = !on;
}

/**
 * The address already on the list, read with the visitor's OWN bearer. `email_subscribers` grants
 * `anon` nothing and every policy is `user_id = auth.uid()`, so this can only ever answer for the
 * signed-in visitor's own row — which is the point: no anonymous caller can probe whether some
 * other address is subscribed. Any failure (offline, expired token, RLS) answers null and the
 * caller falls through to the normal flow rather than blocking on a check that is only an
 * optimisation.
 */
async function listedAddress(accessToken, userId) {
  try {
    return subscribedEmail(await getJson(ownRowUrl(conn, userId), {
      headers: { apikey: conn.anonKey, authorization: `Bearer ${accessToken}` },
    }));
  } catch {
    return null;
  }
}

/**
 * Pre-send duplicate check for a tab holding a live session for the SAME address (`listedAddress`).
 * A signed-out visitor has no bearer, so `rememberedSubscriber()` answers for them instead.
 */
async function alreadySubscribed(email) {
  const live = await ensureSession(conn);
  const claims = live ? subscriberRow(live.accessToken) : null;
  if (!claims || !sameAddress(claims.email, email)) return false;
  return sameAddress(await listedAddress(live.accessToken, claims.user_id), email);
}

async function sendLink(action, { force = false } = {}) {
  if (!conn) return say(MESSAGES.unconfigured, "bad");
  offerSendAnyway(false);
  const email = $("email").value.trim();
  if (!email) return say("Enter your email first.", "bad");
  // Don't mail a confirmation for a subscription that already exists — say so instead.
  if (action === "sub" && (await alreadySubscribed(email))) return say(MESSAGES.alreadySubscribed, "good");
  // Signed out, but THIS browser confirmed that address: say so instead of mailing another link.
  // Advisory — the row may have been deleted elsewhere, so `force` (the escape button) skips it.
  if (action === "sub" && !force && sameAddress(rememberedSubscriber(), email)) {
    offerSendAnyway(true);
    return say(MESSAGES.deviceSubscribed, "good");
  }
  say("Sending…");
  try {
    // `redirect_to` is a QUERY parameter (GoTrue ignores it in the body — journal.js has the
    // full note); the intent rides on it so the click lands back here knowing what to do.
    const res = await send(`${otpUrl(conn)}?redirect_to=${encodeURIComponent(subscribeRedirect(location.origin, action))}`, {
      headers: { apikey: conn.anonKey },
      // `create_user: true` — unlike the journal, a stranger has no auth user yet; the magic
      // link both creates it and proves the address. The list row itself is written only after
      // the click, so an unconfirmed address never receives a band mail.
      body: { email, create_user: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 400 || res.status === 422 || res.status === 429 ? ` — ${await res.text()}` : ""}`);
    say(MESSAGES.sent, "good");
  } catch (err) {
    say(`Could not send the link - ${err.message}`, "bad");
  }
}

/** The click landed: perform the intent the link carried with the one-shot session, then forget it. */
async function completeFromHash() {
  const parsed = parseAuthHash(location.hash);
  const action = actionFromLocation(location.search);
  if (!parsed) {
    // A mail's unsubscribe link carries the recipient's address - prefill so the visitor only clicks.
    // A live stored session (a link clicked on any page here) prefills from its own claims.
    const live = await ensureSession(conn);
    const prefill = emailFromLocation(location.search, location.hash) ?? (live ? subscriberRow(live.accessToken)?.email ?? null : null);
    if (prefill && !$("email").value) $("email").value = prefill;
    if (action === "unsub") {
      say(prefill ? MESSAGES.unsubPrefilled : MESSAGES.unsubPrompt);
    }
    return;
  }
  // Strip the fragment first so a reload never replays a used token.
  history.replaceState(null, "", location.pathname);
  if (parsed.error) return say(parsed.error, "bad");
  if (!conn) return say(MESSAGES.unconfigured, "bad");
  if (sessionExpired(parsed.expiresAt)) return say(MESSAGES.expired, "bad");
  const row = subscriberRow(parsed.accessToken);
  if (!row) return say(MESSAGES.expired, "bad");
  // Keep the sign-in (J0.2): the journal, opened from anywhere, needs no second link.
  storeSession(parsed);
  // A valid token with no `?a=` means the allow-list entry dropped the query — a distinct fault.
  if (!action) return say(MESSAGES.nointent, "bad");
  $("email").value = row.email;
  const headers = { apikey: conn.anonKey, authorization: `Bearer ${parsed.accessToken}` };
  try {
    if (action === "sub") {
      // The row may already be there (a second confirmation, or a link clicked twice): report that
      // rather than the first-time copy. A row holding a DIFFERENT address (the account's mail was
      // changed since) falls through to the upsert, which brings it in line with the new claim.
      if (sameAddress(await listedAddress(parsed.accessToken, row.user_id), row.email)) {
        rememberSubscriber(row.email);
        return say(MESSAGES.alreadyConfirmed, "good");
      }
      const res = await send(subscribersUrl(conn), {
        // merge-duplicates: a second confirmation is an idempotent upsert on the pk, never a 409.
        headers: { ...headers, prefer: "return=minimal, resolution=merge-duplicates" },
        body: row,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      rememberSubscriber(row.email);
      say(MESSAGES.subscribed, "good");
    } else {
      const res = await send(unsubscribeUrl(conn, row.user_id), { method: "DELETE", headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      forgetSubscriber();
      say(MESSAGES.removed, "good");
    }
  } catch (err) {
    say(`Could not finish - ${err.message}`, "bad");
  }
}

$("sub").addEventListener("click", () => sendLink("sub"));
$("unsub").addEventListener("click", () => sendLink("unsub"));
$("sendanyway").addEventListener("click", () => sendLink("sub", { force: true }));
if (!conn) say(MESSAGES.unconfigured, "bad");
completeFromHash();
