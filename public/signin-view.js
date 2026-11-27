/**
 * Sign-in / sign-out PURE seam for `/signin` — DOM-free, so `signin-view.test.js` runs with no
 * jsdom (`frontend.md` §Testable slices go in a pure seam module). `signin.js` is the shell that
 * owns `document`, `fetch` and `location`; `auth-nav.js` is the tiny shell every page loads to
 * relabel its nav link from the same session.
 *
 * Why a page of its own: `/subscribe` CREATES the account (`create_user: true`, double opt-in for
 * the mail list) and `/journal` signs in only for its own card. Someone who already has an account
 * and wants the full dashboard / lab / exposure needed to re-subscribe to get a session. This page
 * mails a magic link with `create_user: false` (an unknown address is refused, pointed at
 * `/subscribe`), lands the click back HERE, keeps the session through `auth-session.js`
 * (J0.2; durable and renewed since J0.4 was reversed), and offers the one "Sign out" that
 * returns the visitor to the public `/overview` only.
 *
 * Sign out drops the stored session: "log out ⇒ see the public page only" is the ruling (2026-09-06).
 */
import { emailFromJwt } from "./subscribe-view.js";

/** The page's own path as the site serves it (`vercel.json` cleanUrls) — also the redirect allow-list entry. */
export const SIGNIN_PATH = "/signin";

/** The magic-link return target: origin + the FIXED page path, nothing from `location.href` (S-3). */
export const signinRedirect = (origin) => `${String(origin ?? "").replace(/\/+$/, "")}${SIGNIN_PATH}`;

/**
 * What the signed-in card shows: the address off the session's own JWT. Null when there is no
 * live session or the token carries no email claim — the shell then shows the sign-in card.
 */
export function accountFromSession(session) {
  const email = session?.accessToken ? emailFromJwt(session.accessToken) : null;
  return email ? { email } : null;
}

/**
 * The nav link every page carries (`<a data-auth-nav href="/signin">`): one label per state.
 * Both states point at `/signin` — the page itself is where sign-out lives.
 */
export function authNavLabel(session) {
  return accountFromSession(session) ? "Signed in · sign out" : "Sign in";
}

/**
 * Sign out = forget the stored session (the shell revokes it server-side first). `clearSession` is the
 * auth-session seam's own remover, injected so the test proves it is called.
 */
export function signOutEverywhere({ clearSession }) {
  clearSession();
}

/** The one-line status per outcome — a single table so the shell and the test share the copy. */
export const MESSAGES = Object.freeze({
  sent: "Link sent - open it from the inbox of that address to sign in.",
  noAccount:
    "No account for that address yet. Subscribe to the email alerts first - that one confirmation mail creates the account - then sign in here.",
  expired: "Link expired - request a new one.",
  signedOut: "Signed out - this tab now shows the public page only.",
  unconfigured: "Sign-in is not configured on this deployment yet.",
});
