// /signin — the pure seam (signin-view.js) plus the page-level invariants a markup test alone
// cannot reach: every id the shell looks up exists in signin.html, the shell never creates accounts,
// and EVERY entry page carries the relabelled sign-in link (auth-nav.js) — ruling 2026-09-06.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { MESSAGES, SIGNIN_PATH, accountFromSession, authNavLabel, signOutEverywhere, signinRedirect } from "./signin-view.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const HTML = read("signin.html");
const SHELL = read("signin.js");

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims) => `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;

/** Every page a visitor can land on that is not itself /signin: each must link it. */
const NAV_PAGES = ["index.html", "overview.html", "lab.html", "exposure.html", "journal.html", "subscribe.html", "about.html"];

describe("signinRedirect", () => {
  it("is origin + the fixed path, stripping trailing slashes", () => {
    expect(signinRedirect("https://x.example/")).toBe(`https://x.example${SIGNIN_PATH}`);
    expect(signinRedirect("https://x.example")).toBe("https://x.example/signin");
  });
});

describe("accountFromSession / authNavLabel", () => {
  const session = { accessToken: jwt({ sub: "u", email: "a@x.example" }), expiresAt: 1 };
  it("reads the address off the session's own token, null without one", () => {
    expect(accountFromSession(session)).toEqual({ email: "a@x.example" });
    expect(accountFromSession({ accessToken: jwt({ sub: "u" }) })).toBeNull();
    expect(accountFromSession(null)).toBeNull();
  });
  it("labels the nav link per state", () => {
    expect(authNavLabel(session)).toBe("Signed in · sign out");
    expect(authNavLabel(null)).toBe("Sign in");
  });
});

describe("signOutEverywhere", () => {
  it("clears the stored session, once", () => {
    const clearSession = vi.fn();
    signOutEverywhere({ clearSession });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });
});

describe("page wiring", () => {
  it("every id the shell looks up exists in signin.html", () => {
    for (const id of [...new Set([...SHELL.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]))]) {
      expect(HTML, `signin.js reads #${id}, which signin.html never renders`).toContain(`id="${id}"`);
    }
  });
  it("the shell NEVER creates accounts (create_user: false) and lands the link back on /signin", () => {
    expect(SHELL).toContain("create_user: false");
    expect(SHELL).not.toContain("create_user: true");
    expect(SHELL).toContain("signinRedirect(location.origin)");
  });
  it("every status message the shell shows comes from the shared table", () => {
    for (const key of [...SHELL.matchAll(/MESSAGES\.(\w+)/g)].map((m) => m[1])) {
      expect(MESSAGES, `MESSAGES.${key} is used by the shell but missing from the table`).toHaveProperty(key);
    }
    expect(MESSAGES.noAccount, "the newcomer message must name the sign-up path").toMatch(/subscribe/i);
  });
  it("sign-out points the visitor at the public page, and the page links /subscribe for newcomers", () => {
    expect(HTML).toContain('href="/overview"');
    expect(HTML).toContain('href="/subscribe"');
  });
});

describe("linked from every page", () => {
  it("each entry page carries the relabelled sign-in link and loads auth-nav.js", () => {
    for (const page of NAV_PAGES) {
      const html = read(page).replace(/<!--[\s\S]*?-->/g, "");
      expect(html, `${page} has no data-auth-nav link to ${SIGNIN_PATH}`).toMatch(
        new RegExp(`<a[^>]*href="${SIGNIN_PATH}"[^>]*data-auth-nav`),
      );
      expect(html, `${page} does not load auth-nav.js, so its link never relabels`).toContain('src="./auth-nav.js"');
    }
  });
  it("auth-nav.js is storage-only: no fetch, no redirect, no gate", () => {
    const src = read("auth-nav.js").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(src).not.toMatch(/\bfetch\(|location\.(replace|assign|href)/);
  });
  it("the subscribe page says subscribing creates the account and points existing users at /signin", () => {
    const sub = read("subscribe.html").replace(/<!--[\s\S]*?-->/g, "");
    expect(sub).toMatch(/creates your crash-dash account/);
    expect(sub).toMatch(/<a href="\/signin">Sign in<\/a>/);
    expect(sub).toMatch(/<title>[^<]*sign up[^<]*<\/title>/i);
  });
});
