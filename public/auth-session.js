/**
 * The ONE browser session seam for `/journal`, `/subscribe`, `/signin` and the P11 page gate. Pages read
 * through `apiFetch` and gate on `canViewPage`, never on the session keys directly.
 *
 * J0.4 REVERSED (user ruling 2026-09-06): the access token AND the rotated `refresh_token` live
 * in `localStorage`, so one sign-in holds across tabs and restarts until "Sign out".
 *
 * `jwt_exp` stays 3600 s and an expired access token is still refused locally before any fetch —
 * renewal is a fresh grant through `ensureSession`, never a stretched expiry.
 *
 * Sign out must go through `revokeSession`: forgetting a durable refresh token does not kill it.
 *
 * `localStorage` is named, not injected, so the source pins in `auth-session.test.js` and
 * `journal-view.test.js` see the calls; tests stub `globalThis.localStorage`.
 */
import { parseTokenResponse, refreshUrl, logoutUrl, sessionExpired } from "./journal-view.js";
import { publicConnection } from "./subscribe-view.js";
import { baseFetch, send } from "./http.js";

export const TOKEN_KEY = "cd.auth.token";
export const TOKEN_EXP_KEY = "cd.auth.token.expires";
export const REFRESH_KEY = "cd.auth.refresh";
export const SINCE_KEY = "cd.auth.since";

/** The fetch every gated page reads `/api/*` through: every request is anonymous, so it is `baseFetch` as-is. */
export const apiFetch = baseFetch;

/** True iff the visitor may load a gated page: a live session (renewed first via `ensureSession`). */
export async function canViewPage() {
  return Boolean(await ensureSession());
}

/**
 * Device-local "this browser subscribed that address" marker — not a credential, and `clearSession`
 * must never remove it (pinned in `auth-session.test.js`). Advisory: a stale marker owes an escape.
 */
export const SUBSCRIBER_KEY = "cd.sub.email";

/** Remember that this browser confirmed a subscription for `email`. */
export function rememberSubscriber(email) {
  const address = String(email ?? "").trim();
  if (address !== "") localStorage.setItem(SUBSCRIBER_KEY, address);
}

/** The address this browser last confirmed a subscription for, or null. */
export function rememberedSubscriber() {
  return localStorage.getItem(SUBSCRIBER_KEY) || null;
}

/** Drop the marker — the unsubscribe path, the one place this browser learns the row is gone. */
export function forgetSubscriber() {
  localStorage.removeItem(SUBSCRIBER_KEY);
}

/**
 * Hard bound on one sign-in: 36 h (user ruling 2026-09-06), after which renewal stops and a fresh
 * magic link is required. CLIENT-SIDE — Supabase's own `sessions_timebox` is Pro-only and this
 * project is free-tier, so this bounds the convenience, it does not enforce anything on a holder
 * of the refresh token. Set once at sign-in; a renewal never extends it.
 */
export const SESSION_TIMEBOX_MS = 129_600_000;

/** Renew this far ahead of expiry, so a page never starts a fetch with a token about to die. */
export const RENEW_SKEW_MS = 120_000;

/** The gate awaits renewal, so a hung auth host must not hold the page open indefinitely. */
export const REFRESH_TIMEOUT_MS = 8_000;

/** The one in-flight renewal. A rotated refresh token is single-use: two POSTs race the family. */
let inFlight = null;

/** The record that is allowed into storage: the access token, its expiry, and the refresh token. */
export function sessionRecord(parsed) {
  const accessToken = parsed?.accessToken;
  const expiresAt = Number(parsed?.expiresAt);
  if (typeof accessToken !== "string" || accessToken === "" || !Number.isFinite(expiresAt)) return null;
  const refreshToken = typeof parsed?.refreshToken === "string" && parsed.refreshToken !== "" ? parsed.refreshToken : null;
  return { accessToken, expiresAt, refreshToken };
}

/** Persist a parsed session (magic-link fragment or refresh grant). Returns it, or null when unusable. */
export function storeSession(parsed) {
  const rec = sessionRecord(parsed);
  if (!rec) return null;
  if (!localStorage.getItem(SINCE_KEY)) localStorage.setItem(SINCE_KEY, String(Date.now()));
  localStorage.setItem(TOKEN_KEY, rec.accessToken);
  localStorage.setItem(TOKEN_EXP_KEY, String(rec.expiresAt));
  // A grant that returns no new refresh token leaves the stored one in place, never blanks it.
  if (rec.refreshToken) localStorage.setItem(REFRESH_KEY, rec.refreshToken);
  return rec;
}

/**
 * The live session, or null — an expired ACCESS token is purged unread (H-3). The refresh token
 * deliberately survives that purge: it is what `ensureSession` uses to get a new access token.
 */
export function loadSession(now = Date.now()) {
  const accessToken = localStorage.getItem(TOKEN_KEY);
  const expires = localStorage.getItem(TOKEN_EXP_KEY);
  if (!accessToken || sessionExpired(expires, now)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    return null;
  }
  return { accessToken, expiresAt: Number(expires) };
}

/** The stored refresh token, or null. */
export function storedRefresh() {
  return localStorage.getItem(REFRESH_KEY) || null;
}

/** Forget the session: exactly the four `cd.auth.*` keys, never `SUBSCRIBER_KEY`. */
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(SINCE_KEY);
}

/** Has this sign-in outlived `SESSION_TIMEBOX_MS`? An unset/unparseable start counts as fresh. */
export function timeboxExpired(now = Date.now()) {
  const since = Number(localStorage.getItem(SINCE_KEY));
  return Number.isFinite(since) && since > 0 && now - since >= SESSION_TIMEBOX_MS;
}

/**
 * Whether a refresh answer means "this credential is dead" (forget it) rather than "not now"
 * (keep it, try again next page load). Both halves are required: a GoTrue rejection status AND a
 * GoTrue-shaped error body — a captive portal or corporate proxy answering 403/451 with HTML is
 * not this account being revoked, and must never sign the visitor out.
 */
export function refreshRejected(status, body) {
  if (![400, 401, 403, 422].includes(status)) return false;
  return Boolean(body && (body.error || body.error_code || body.msg || body.message));
}

/**
 * Renew the pair when the access token is gone or within `RENEW_SKEW_MS` of expiry. Returns the
 * live session or null. A transient failure keeps whatever is still usable; only an outright
 * rejection clears storage.
 */
export async function ensureSession(conn, now = Date.now()) {
  const live = loadSession(now);
  if (timeboxExpired(now)) {
    // The 36 h bound is up: revoke what is still usable, then require a fresh magic link.
    if (live) await postLogout(conn ?? publicConnection(), live.accessToken);
    clearSession();
    return null;
  }
  if (live && live.expiresAt - now > RENEW_SKEW_MS) return live;
  const refresh = storedRefresh();
  // `?? publicConnection()` not a default parameter: `/journal` passes an explicitly null `conn`
  // until its box is filled, and a default only fires on `undefined`.
  const c = conn ?? publicConnection();
  if (!refresh || !c || typeof fetch !== "function") return live;
  if (inFlight) return inFlight; // one renewal per page, whoever asks first (rotation is single-use)
  inFlight = renew(c, refresh, now, live).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The renewal itself; `ensureSession` owns the in-flight guard around it. */
async function renew(conn, refresh, now, live) {
  let res;
  let body = null;
  try {
    res = await send(refreshUrl(conn), {
      headers: { apikey: conn.anonKey },
      body: { refresh_token: refresh },
      timeoutMs: REFRESH_TIMEOUT_MS,
    });
    body = await res.json();
  } catch {
    // Offline, blocked, timed out, or a non-JSON body: the stored credential is presumed good.
    if (!res) return live;
  }
  if (refreshRejected(res.status, body)) {
    // Another tab may have renewed while this request was in flight; its rotated token is good,
    // and clearing here would sign BOTH tabs out over a replay this tab caused.
    if (storedRefresh() === refresh) clearSession();
    return loadSession(now);
  }
  if (!res.ok) return live;
  return storeSession(parseTokenResponse(body, now)) ?? live;
}

/**
 * Sign out for real: tell GoTrue to revoke the session (so the durable refresh token dies
 * server-side too), then forget it locally. Best effort — the local clear happens either way,
 * and is what the caller's UI reflects.
 */
export async function revokeSession(conn) {
  const c = conn ?? publicConnection();
  // Renew FIRST: `loadSession` alone returns null once the access token lapses, and skipping the
  // POST would leave the durable refresh token alive server-side with no way left to kill it.
  const live = await ensureSession(c);
  if (live) await postLogout(c, live.accessToken);
  clearSession();
}

/** The revoke call itself, best effort — every caller clears storage regardless of the answer. */
async function postLogout(conn, accessToken) {
  if (!conn || typeof fetch !== "function") return;
  try {
    await send(logoutUrl(conn), {
      headers: { apikey: conn.anonKey, authorization: `Bearer ${accessToken}` },
      timeoutMs: REFRESH_TIMEOUT_MS,
    });
  } catch {
    /* offline: the caller's local clear still signs this device out */
  }
}
