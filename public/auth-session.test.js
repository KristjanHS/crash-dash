// The shared session seam (J0.2, J0.4 reversed 2026-09-06) — behaviour through a stubbed
// localStorage + fetch, plus the source pins that keep token storage a property of ONE file.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFRESH_KEY,
  RENEW_SKEW_MS,
  SESSION_TIMEBOX_MS,
  SINCE_KEY,
  TOKEN_EXP_KEY,
  TOKEN_KEY,
  SUBSCRIBER_KEY,
  clearSession,
  ensureSession,
  forgetSubscriber,
  rememberSubscriber,
  rememberedSubscriber,
  loadSession,
  refreshRejected,
  revokeSession,
  timeboxExpired,
  sessionRecord,
  storeSession,
  storedRefresh,
  apiFetch,
  canViewPage,
} from "./auth-session.js";
import { baseFetch } from "./http.js";
import { parseAuthHash } from "./journal-view.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** A Map-backed Storage stand-in; every value it ever held is kept for the leak scan. */
function fakeStorage() {
  const m = new Map();
  const written = [];
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
      written.push(String(v));
    },
    removeItem: (k) => m.delete(k),
    size: () => m.size,
    written,
  };
}

const CONN = { url: "https://example.supabase.co", anonKey: "anon-key" };
const FRAGMENT = "#access_token=tok.en.x&refresh_token=REFRESH-1&expires_in=3600&token_type=bearer";

/** A fetch stub that answers once with `status` + `body`, and records the calls. */
function fakeFetch(status, body) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
  fn.calls = calls;
  return fn;
}

let storage;
// The real global fetch, RESTORED (never deleted) in afterEach: the `shared` vitest project runs
// files on one module registry — and one globalThis — per worker, so a `delete globalThis.fetch`
// here leaks into whichever DB-integration file the worker runs next. supabase-js resolves `fetch`
// lazily inside its request closure, so it throws "ReferenceError: fetch is not defined", which the
// disposable-stack marker probe reports as a flaky stack (12 red store.run-history tests,
// 2026-09-06 make ship). Second occurrence of this exact leak — public/families-board.test.js
// carries the same restore; `src/isolation-manifest.test.ts` now lints the delete form out.
const realFetch = globalThis.fetch;
beforeEach(() => {
  storage = fakeStorage();
  globalThis.localStorage = storage;
});
afterEach(() => {
  // localStorage is NOT a Node global, so deleting it does restore the original state.
  delete globalThis.localStorage;
  globalThis.fetch = realFetch;
});

describe("storeSession / loadSession / clearSession", () => {
  it("stores the access token, its expiry AND the refresh token under the three shared keys", () => {
    const parsed = parseAuthHash(FRAGMENT);
    const rec = storeSession(parsed);
    expect(rec).toEqual({ accessToken: "tok.en.x", expiresAt: parsed.expiresAt, refreshToken: "REFRESH-1" });
    expect(storage.getItem(TOKEN_KEY)).toBe("tok.en.x");
    expect(storage.getItem(TOKEN_EXP_KEY)).toBe(String(parsed.expiresAt));
    expect(storedRefresh()).toBe("REFRESH-1");
    expect(loadSession(parsed.expiresAt - 1)).toEqual({ accessToken: "tok.en.x", expiresAt: parsed.expiresAt });
  });

  it("purges an EXPIRED access token unread but keeps the refresh token to renew with", () => {
    const parsed = parseAuthHash(FRAGMENT);
    storeSession(parsed);
    expect(loadSession(parsed.expiresAt)).toBeNull();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(storedRefresh(), "the refresh token is what survives an expiry").toBe("REFRESH-1");
  });

  it("a grant with no new refresh token leaves the stored one standing", () => {
    storeSession(parseAuthHash(FRAGMENT));
    storeSession({ accessToken: "tok.2", expiresAt: Date.now() + 1000 });
    expect(storedRefresh()).toBe("REFRESH-1");
  });

  it("refuses a parse with no token or no expiry; clearSession empties all three keys", () => {
    expect(storeSession(null)).toBeNull();
    expect(storeSession({ accessToken: "x" })).toBeNull();
    expect(storage.size()).toBe(0);
    storeSession(parseAuthHash(FRAGMENT));
    clearSession();
    expect(storage.size()).toBe(0);
    expect(loadSession()).toBeNull();
    expect(storedRefresh()).toBeNull();
  });

  it("sign-out leaves the device subscriber marker standing — the whole point of keeping it here", () => {
    storeSession(parseAuthHash(FRAGMENT));
    rememberSubscriber("  A@x.example  ");
    clearSession();
    expect(rememberedSubscriber()).toBe("A@x.example");
    expect(storage.getItem(SUBSCRIBER_KEY)).toBe("A@x.example");
    forgetSubscriber();
    expect(rememberedSubscriber()).toBeNull();
  });

  it("refuses to remember a blank address, so an empty input never becomes a marker", () => {
    rememberSubscriber("   ");
    rememberSubscriber(null);
    expect(rememberedSubscriber()).toBeNull();
  });

  it("normalizes a missing/blank refresh token to null rather than storing 'undefined'", () => {
    expect(sessionRecord({ accessToken: "a", expiresAt: 1 }).refreshToken).toBeNull();
    expect(sessionRecord({ accessToken: "a", expiresAt: 1, refreshToken: "" }).refreshToken).toBeNull();
  });
});

describe("ensureSession — the renewal that replaced the per-tab timeout", () => {
  const now = 1_000_000;

  it("serves a comfortably-live session without touching the network", async () => {
    globalThis.fetch = fakeFetch(200, {});
    storeSession({ accessToken: "a", expiresAt: now + RENEW_SKEW_MS + 1, refreshToken: "R" });
    expect(await ensureSession(CONN, now)).toEqual({ accessToken: "a", expiresAt: now + RENEW_SKEW_MS + 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renews an expired session and stores the ROTATED refresh token", async () => {
    globalThis.fetch = fakeFetch(200, { access_token: "new.tok", refresh_token: "REFRESH-2", expires_in: 3600 });
    storeSession({ accessToken: "old", expiresAt: now - 1, refreshToken: "REFRESH-1" });
    const rec = await ensureSession(CONN, now);
    expect(rec).toEqual({ accessToken: "new.tok", expiresAt: now + 3_600_000, refreshToken: "REFRESH-2" });
    expect(storedRefresh(), "a rotated token replaces the one just spent").toBe("REFRESH-2");
    const { url, init } = globalThis.fetch.calls[0];
    expect(url).toBe(`${CONN.url}/auth/v1/token?grant_type=refresh_token`);
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "REFRESH-1" });
  });

  it("renews inside the skew window, so no fetch ever starts with a token about to die", async () => {
    globalThis.fetch = fakeFetch(200, { access_token: "new.tok", refresh_token: "R2", expires_in: 3600 });
    storeSession({ accessToken: "old", expiresAt: now + RENEW_SKEW_MS - 1, refreshToken: "R1" });
    expect((await ensureSession(CONN, now)).accessToken).toBe("new.tok");
  });

  it("signs the device out when the refresh token is REJECTED (revoked / rotated away)", async () => {
    globalThis.fetch = fakeFetch(401, { error_code: "refresh_token_not_found" });
    storeSession({ accessToken: "old", expiresAt: now - 1, refreshToken: "R" });
    expect(await ensureSession(CONN, now)).toBeNull();
    expect(storage.size(), "a dead credential is forgotten, not retried forever").toBe(0);
  });

  it("keeps the credential through a rate limit, a 5xx and an offline fetch", async () => {
    for (const status of [429, 503]) {
      globalThis.fetch = fakeFetch(status, { error: "nope" });
      clearSession();
      storeSession({ accessToken: "old", expiresAt: now - 1, refreshToken: "R" });
      expect(await ensureSession(CONN, now), `status ${status}`).toBeNull();
      expect(storedRefresh(), `status ${status} must not sign the visitor out`).toBe("R");
    }
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await ensureSession(CONN, now)).toBeNull();
    expect(storedRefresh()).toBe("R");
  });

  it("does nothing at all with no stored refresh token", async () => {
    globalThis.fetch = fakeFetch(200, {});
    expect(await ensureSession(CONN, now)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("classifies a refresh answer on BOTH status and body — a proxy 4xx is not a revocation", () => {
    const err = { error: "invalid_grant" };
    expect([400, 401, 403, 422].map((s) => refreshRejected(s, err))).toEqual([true, true, true, true]);
    expect([200, 429, 500, 503].map((s) => refreshRejected(s, err))).toEqual([false, false, false, false]);
    // A captive portal / WAF answering 403 with HTML (no parsed body) must NOT clear the session.
    expect(refreshRejected(403, null)).toBe(false);
    expect(refreshRejected(403, {})).toBe(false);
  });

  it("keeps a sibling tab's rotated token when THIS tab's replay is the thing rejected", async () => {
    storeSession({ accessToken: "old", expiresAt: now - 1, refreshToken: "R1" });
    globalThis.fetch = vi.fn(async () => {
      // The other tab renews while this request is in flight.
      storeSession({ accessToken: "sib", expiresAt: now + 3_600_000, refreshToken: "R2" });
      return { ok: false, status: 401, json: async () => ({ error: "invalid_grant" }) };
    });
    await ensureSession(CONN, now);
    expect(storedRefresh(), "the good token the sibling stored must survive").toBe("R2");
  });

  it("issues ONE POST when several modules on a page ask at once (rotation is single-use)", async () => {
    storeSession({ accessToken: "old", expiresAt: now - 1, refreshToken: "R1" });
    globalThis.fetch = fakeFetch(200, { access_token: "new.tok", refresh_token: "R2", expires_in: 3600 });
    const all = await Promise.all([ensureSession(CONN, now), ensureSession(CONN, now), ensureSession(CONN, now)]);
    expect(globalThis.fetch.calls.length, "a second POST would replay a spent token").toBe(1);
    for (const rec of all) expect(rec.accessToken).toBe("new.tok");
  });
});

describe("apiFetch / canViewPage — the gated pages' read and gate seam", () => {
  it("apiFetch is http.js baseFetch itself: no read gains a credential or an extra query param", () => {
    expect(apiFetch).toBe(baseFetch);
  });

  it("canViewPage: false with no session, true on a live one", async () => {
    expect(await canViewPage()).toBe(false);
    storeSession({ accessToken: "tok-1", expiresAt: Date.now() + 3_600_000 });
    expect(await canViewPage()).toBe(true);
  });

  it("canViewPage judges through ensureSession, not the raw token: a live token past the 36 h timebox is refused", async () => {
    storeSession({ accessToken: "tok-1", expiresAt: Date.now() + 3_600_000 });
    localStorage.setItem(SINCE_KEY, String(Date.now() - SESSION_TIMEBOX_MS));
    expect(await canViewPage()).toBe(false);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull(); // the timebox cleared it
  });
});

describe("the 36 h timebox — Supabase's own is Pro-only, so the seam owns it", () => {
  it("stamps the sign-in once and never lets a renewal extend it", () => {
    storeSession({ accessToken: "a", expiresAt: Date.now() + 1000, refreshToken: "R1" });
    const since = storage.getItem(SINCE_KEY);
    expect(Number(since)).toBeGreaterThan(0);
    storeSession({ accessToken: "b", expiresAt: Date.now() + 1000, refreshToken: "R2" });
    expect(storage.getItem(SINCE_KEY), "a renewal must not restart the clock").toBe(since);
  });

  it("stops renewing once the box is up, and revokes what is still usable", async () => {
    const t0 = 5_000_000;
    globalThis.fetch = fakeFetch(204, {});
    storeSession({ accessToken: "live.tok", expiresAt: t0 + SESSION_TIMEBOX_MS + 60_000, refreshToken: "R" });
    storage.setItem(SINCE_KEY, String(t0));
    expect(timeboxExpired(t0 + SESSION_TIMEBOX_MS - 1)).toBe(false);
    expect(await ensureSession(CONN, t0 + SESSION_TIMEBOX_MS)).toBeNull();
    expect(globalThis.fetch.calls[0].url).toBe(`${CONN.url}/auth/v1/logout`);
    expect(storage.size(), "a boxed-out session leaves nothing behind").toBe(0);
  });
});

describe("revokeSession — sign-out kills the durable credential server-side", () => {
  it("posts the bearer to /auth/v1/logout, then clears storage", async () => {
    globalThis.fetch = fakeFetch(204, {});
    storeSession({ accessToken: "live.tok", expiresAt: Date.now() + RENEW_SKEW_MS + 60_000, refreshToken: "R" });
    await revokeSession(CONN);
    const { url, init } = globalThis.fetch.calls[0];
    expect(url).toBe(`${CONN.url}/auth/v1/logout`);
    expect(init.headers.authorization).toBe("Bearer live.tok");
    expect(storage.size()).toBe(0);
  });

  it("RENEWS an expired session first, so the durable token is never orphaned server-side", async () => {
    // Without the renewal, `loadSession()` reads null for a lapsed access token, the POST is
    // skipped, and the refresh token stays valid forever with nothing left that can kill it.
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return url.includes("logout")
        ? { ok: true, status: 204, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ access_token: "fresh", refresh_token: "R2", expires_in: 3600 }) };
    });
    storeSession({ accessToken: "stale", expiresAt: Date.now() - 1, refreshToken: "R1" });
    await revokeSession(CONN);
    expect(calls.map((c) => c.url.split("/auth/v1/")[1])).toEqual(["token?grant_type=refresh_token", "logout"]);
    expect(calls[1].init.headers.authorization).toBe("Bearer fresh");
    expect(storage.size()).toBe(0);
  });

  it("still clears the device when the revoke call fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    storeSession({ accessToken: "live.tok", expiresAt: Date.now() + RENEW_SKEW_MS + 60_000, refreshToken: "R" });
    await revokeSession(CONN);
    expect(storage.size()).toBe(0);
  });
});

describe("source pins — the seam is the ONLY token storage on any page", () => {
  const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("no shell clears storage off a falsy ensureSession — that would wipe a live credential", () => {
    // The seam returns null for offline / 429 / 5xx while deliberately KEEPING the refresh token.
    for (const name of ["journal.js", "subscribe.js", "signin.js", "auth-nav.js", "app.js", "lab.js", "exposure.js"]) {
      const src = code(read(name));
      expect(src, `${name} must not clear storage on a transient renewal failure`).not.toMatch(
        /ensureSession\([^)]*\)[^;]*;\s*\n?\s*if \(!\w+\) return (drop|clear)Session/,
      );
    }
  });

  it("the shells route through the seam and hold no token storage call of their own", () => {
    for (const name of ["journal.js", "subscribe.js", "signin.js"]) {
      const src = code(read(name));
      expect(src, `${name} must import the shared seam`).toMatch(/from "\.\/auth-session\.js"/);
      expect(src, `${name} must not write the token itself`).not.toMatch(/Storage\.setItem\(\s*TOKEN/);
      expect(src, `${name} must not read the token itself`).not.toMatch(/Storage\.getItem\(\s*TOKEN/);
    }
  });

  it("R7: the gated shells read /series + /status only through apiFetch", () => {
    for (const name of ["app.js", "lab.js"]) {
      // `request(url, { fetchImpl: apiFetch, … })` is an apiFetch read with a timeout.
      const src = code(read(name)).replace(/\brequest\(((?:(?!\brequest\()[^;])*?), \{ fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS \}\)/g, "apiFetch($1)");
      expect(src, name).toMatch(/^import \{[^}]*\bapiFetch\b[^}]*\} from "\.\/auth-session\.js";$/m);
      expect(src.match(/\bapiFetch\(/g)?.length, name).toBeGreaterThanOrEqual(1);
      expect(src, name).not.toMatch(
        /(?<![\w.])(fetch|getJson|request|send)\(\s*(`\$\{API\}|["'`]\/api)\/(series|status)\b|(?<![\w.])(fetch|getJson|request|send)\(companionSeriesUrl/,
      );
    }
    // app.js: the boot /status prefetch AND the load cycle's miss both ride the seam.
    expect(code(read("app.js"))).toMatch(/fetch: fetchOnceVia\(apiFetch\)/);
    expect(code(read("app.js"))).toMatch(/prefetchThenGate\(BOOT_URLS, canViewPage, apiFetch\)/);
  });

  it("every sign-out path revokes rather than merely forgetting", () => {
    for (const name of ["journal.js", "signin.js"]) {
      const src = code(read(name));
      const body = src.slice(src.indexOf("function signOut("));
      expect(body.slice(0, body.indexOf("\n}")), `${name} signOut must revoke`).toContain("revokeSession(");
    }
  });
});
