/**
 * Sign-in / sign-out thin shell: DOM + fetch + the shared per-tab session. Every decision (the
 * redirect target, the account read, the copy, what sign-out clears) lives in the pure
 * signin-view.js seam, which is where the tests are. This file runs module-level DOM side effects
 * and is NEVER imported by a test (`frontend.md`).
 *
 * Zero Vercel functions: the browser talks to GoTrue (magic link) directly, exactly like the
 * journal and /subscribe. `create_user: false` — this page never creates accounts; that is
 * `/subscribe`'s job (the double opt-in for the mail list doubles as sign-up).
 */
import { otpUrl, parseAuthHash, sessionExpired } from "./journal-view.js";
import { clearSession, ensureSession, loadSession, revokeSession, storeSession } from "./auth-session.js";
import { publicConnection } from "./subscribe-view.js";
import { send } from "./http.js";
import { MESSAGES, accountFromSession, signOutEverywhere, signinRedirect } from "./signin-view.js";

const $ = (id) => document.getElementById(id);
const conn = publicConnection();

function say(text, tone) {
  const el = $("msg");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function render() {
  const account = accountFromSession(loadSession());
  $("in-card").hidden = Boolean(account);
  $("out-card").hidden = !account;
  if (account) $("who").textContent = account.email;
}

async function sendLink() {
  if (!conn) return say(MESSAGES.unconfigured, "bad");
  const email = $("email").value.trim();
  if (!email) return say("Enter your email first.", "bad");
  say("Sending…");
  try {
    // `redirect_to` is a QUERY parameter (GoTrue ignores it in the body — journal.js has the note).
    const res = await send(`${otpUrl(conn)}?redirect_to=${encodeURIComponent(signinRedirect(location.origin))}`, {
      headers: { apikey: conn.anonKey },
      body: { email, create_user: false },
    });
    if (!res.ok) {
      // GoTrue answers an unknown address under `create_user: false` with a 4xx ("Signups not
      // allowed for otp") — the expected newcomer failure, so name the sign-up path.
      const body = res.status === 400 || res.status === 422 || res.status === 429 ? await res.text() : "";
      if (/signup|sign-?ups?/i.test(body)) return say(MESSAGES.noAccount, "bad");
      throw new Error(`HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    }
    say(MESSAGES.sent, "good");
  } catch (err) {
    say(`Could not send the link - ${err.message}`, "bad");
  }
}

/** The click landed: keep the session, strip the fragment so a reload never replays it. */
function adoptHashSession() {
  const parsed = parseAuthHash(location.hash);
  if (!parsed) return;
  history.replaceState(null, "", location.pathname);
  if (parsed.error) return say(parsed.error, "bad");
  if (sessionExpired(parsed.expiresAt) || !storeSession(parsed)) return say(MESSAGES.expired, "bad");
}

async function signOut() {
  // Revoke server-side first (kills the durable refresh token), then clear this device.
  await revokeSession(conn);
  signOutEverywhere({ clearSession });
  render();
  say(MESSAGES.signedOut, "good");
}

$("send").addEventListener("click", sendLink);
$("out").addEventListener("click", signOut);
if (!conn) say(MESSAGES.unconfigured, "bad");
adoptHashSession();
await ensureSession(conn);
render();
