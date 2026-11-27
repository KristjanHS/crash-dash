// Email subscriptions — the pure seam (subscribe-view.js) plus the page-level invariants a markup
// test alone cannot reach: every id the shell looks up exists in subscribe.html.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  MESSAGES,
  SUBSCRIBE_PATH,
  actionFromLocation,
  emailFromLocation,
  emailFromJwt,
  ownRowUrl,
  publicConnection,
  sameAddress,
  subscribeRedirect,
  subscribedEmail,
  subscriberRow,
  subscribersUrl,
  unsubscribeUrl,
} from "./subscribe-view.js";
import { SUPABASE_ORIGIN } from "./supabase-host.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const HTML = read("subscribe.html");
const SHELL = read("subscribe.js");

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims) => `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;

describe("subscribeRedirect / actionFromLocation", () => {
  it("returns origin + the fixed path + the intent, stripping trailing slashes", () => {
    expect(subscribeRedirect("https://x.example/", "sub")).toBe(`https://x.example${SUBSCRIBE_PATH}?a=sub`);
    expect(subscribeRedirect("https://x.example", "unsub")).toBe(`https://x.example${SUBSCRIBE_PATH}?a=unsub`);
  });
  it("refuses an unknown intent rather than mailing a link with none", () => {
    expect(() => subscribeRedirect("https://x.example", "delete")).toThrow(/unknown subscribe action/);
    expect(() => subscribeRedirect("https://x.example", undefined)).toThrow();
  });
  it("round-trips through the query string and ignores anything else", () => {
    for (const a of ACTIONS) {
      const url = new URL(subscribeRedirect("https://x.example", a));
      expect(actionFromLocation(url.search)).toBe(a);
    }
    expect(actionFromLocation("?a=delete")).toBeNull();
    expect(actionFromLocation("")).toBeNull();
    expect(actionFromLocation(undefined)).toBeNull();
  });
  it("emailFromLocation reads the mail footer's prefill beside the intent, null unless address-shaped", () => {
    const search = `?a=unsub&email=${encodeURIComponent("a+b@x.test")}`;
    expect(actionFromLocation(search)).toBe("unsub");
    expect(emailFromLocation(search)).toBe("a+b@x.test"); // legacy `?email=` footers still prefill
    expect(emailFromLocation("?a=unsub")).toBeNull();
    expect(emailFromLocation("?email=")).toBeNull();
    expect(emailFromLocation("?email=not-an-address")).toBeNull();
    expect(emailFromLocation("?email=%3Cb%3Ex%40y.z")).toBeNull(); // markup-ish junk is not an address
    expect(emailFromLocation(undefined)).toBeNull();
  });

  it("emailFromLocation reads the FRAGMENT first, the query only as the legacy fallback", () => {
    const hash = `#email=${encodeURIComponent("a+b@x.test")}`;
    expect(emailFromLocation("?a=unsub", hash)).toBe("a+b@x.test");
    expect(emailFromLocation(undefined, hash)).toBe("a+b@x.test");
    // Both present and disagreeing: the fragment wins (it is the shape unsubscribeLink emits now).
    expect(emailFromLocation("?email=old%40x.test", hash)).toBe("a+b@x.test");
    // A junk fragment falls through to the query rather than swallowing the prefill.
    expect(emailFromLocation("?email=old%40x.test", "#email=not-an-address")).toBe("old@x.test");
    expect(emailFromLocation("?a=unsub", "#email=")).toBeNull();
    // A magic-link landing fragment carries no `email` — it must not be mistaken for a prefill.
    expect(emailFromLocation("?a=unsub", "#access_token=x&expires_in=3600")).toBeNull();
  });
});

describe("JWT claims", () => {
  const token = jwt({ sub: "11111111-2222-3333-4444-555555555555", email: "a@x.example" });
  it("emailFromJwt reads the email claim, null otherwise", () => {
    expect(emailFromJwt(token)).toBe("a@x.example");
    expect(emailFromJwt(jwt({ sub: "u" }))).toBeNull();
    expect(emailFromJwt("garbage")).toBeNull();
    expect(emailFromJwt(null)).toBeNull();
  });
  it("subscriberRow carries both columns off the same token, null when either is missing", () => {
    expect(subscriberRow(token)).toEqual({ user_id: "11111111-2222-3333-4444-555555555555", email: "a@x.example" });
    expect(subscriberRow(jwt({ email: "a@x.example" }))).toBeNull();
    expect(subscriberRow(jwt({ sub: "u" }))).toBeNull();
  });
});

describe("connection + endpoints", () => {
  it("publicConnection is null unless the key is key-shaped, and pins the host otherwise", () => {
    expect(publicConnection()).toBeNull(); // the unstamped repo copy (a placeholder)
    expect(publicConnection("  ")).toBeNull();
    expect(publicConnection("k")).toBeNull();
    expect(publicConnection(" sb_publishable_k ")).toEqual({ url: SUPABASE_ORIGIN, anonKey: "sb_publishable_k" });
    expect(publicConnection("eyJx.y.z")).toEqual({ url: SUPABASE_ORIGIN, anonKey: "eyJx.y.z" });
  });
  it("the REST urls target email_subscribers on the pinned origin; the delete is id-filtered", () => {
    const conn = { url: SUPABASE_ORIGIN, anonKey: "k" };
    expect(subscribersUrl(conn)).toBe(`${SUPABASE_ORIGIN}/rest/v1/email_subscribers`);
    expect(unsubscribeUrl(conn, "abc")).toBe(`${SUPABASE_ORIGIN}/rest/v1/email_subscribers?user_id=eq.abc`);
  });
  it("the duplicate check reads ONE own row and only its address", () => {
    const url = new URL(ownRowUrl({ url: SUPABASE_ORIGIN, anonKey: "k" }, "ab c"));
    expect(url.pathname).toBe("/rest/v1/email_subscribers");
    expect(url.searchParams.get("user_id")).toBe("eq.ab c");
    expect(url.searchParams.get("select")).toBe("email");
    expect(url.searchParams.get("limit")).toBe("1");
  });
});

describe("duplicate check", () => {
  it("subscribedEmail reads the address off the one-row answer, null when the list has none", () => {
    expect(subscribedEmail([{ email: "a@x.example" }])).toBe("a@x.example");
    expect(subscribedEmail([])).toBeNull();
    expect(subscribedEmail([{ email: "" }])).toBeNull();
    expect(subscribedEmail(null)).toBeNull();
    expect(subscribedEmail({ email: "a@x.example" })).toBeNull(); // PostgREST answers an array
  });
  it("sameAddress folds case and surrounding space, and never matches an empty address", () => {
    expect(sameAddress(" A@X.example ", "a@x.example")).toBe(true);
    expect(sameAddress("a@x.example", "b@x.example")).toBe(false);
    expect(sameAddress("", "")).toBe(false);
    expect(sameAddress(null, undefined)).toBe(false);
    expect(sameAddress("a+tag@x.example", "a@x.example")).toBe(false); // no plus-tag folding
  });
});

describe("page wiring", () => {
  it("every id the shell looks up exists in subscribe.html", () => {
    const ids = [...SHELL.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of new Set(ids)) expect(HTML, `subscribe.js looks up #${id}`).toMatch(new RegExp(`id="${id}"`));
  });
  it("the shell sends BOTH intents with create_user: true (strangers have no auth user yet)", () => {
    expect(SHELL).toMatch(/create_user:\s*true/);
    expect(SHELL).not.toMatch(/create_user:\s*false/);
  });
  it("the unsubscribe path is the id-filtered DELETE, the subscribe path an idempotent upsert", () => {
    expect(SHELL).toMatch(/method:\s*"DELETE"/);
    expect(SHELL).toMatch(/resolution=merge-duplicates/);
  });
  it("the shell checks the list BEFORE mailing a subscribe link, and again on the confirmation return", () => {
    // The pre-send check is what stops a second mail; the return-path check is what tells a
    // signed-out returning subscriber, who cannot be asked before the click (RLS).
    expect(SHELL).toMatch(/action === "sub" && \(await alreadySubscribed\(email\)\)/);
    expect(SHELL).toMatch(/listedAddress\(parsed\.accessToken, row\.user_id\)/);
    // Both checks ride the visitor's own bearer — never the anon key alone.
    expect(SHELL).toMatch(/ownRowUrl\(conn, userId\)[\s\S]{0,200}authorization: `Bearer \$\{accessToken\}`/);
  });
  it("the device marker is written on both confirmed-subscribe paths and cleared on unsubscribe", () => {
    // B: the marker is what answers a
    // signed-out returning subscriber, so it must be set wherever the row is known good.
    expect([...SHELL.matchAll(/rememberSubscriber\(row\.email\)/g)]).toHaveLength(2);
    expect(SHELL).toMatch(/forgetSubscriber\(\)/);
  });
  it("a marker match blocks the send but stays escapable — the notice offers Send anyway", () => {
    expect(SHELL).toMatch(/!force && sameAddress\(rememberedSubscriber\(\), email\)/);
    expect(SHELL).toMatch(/offerSendAnyway\(true\)[\s\S]{0,80}MESSAGES\.deviceSubscribed/);
    expect(SHELL).toMatch(/\$\("sendanyway"\)\.addEventListener\([\s\S]{0,60}force: true/);
  });
  it("every status message the shell shows comes from the shared table", () => {
    for (const key of Object.keys(MESSAGES)) expect(SHELL).toMatch(new RegExp(`MESSAGES\\.${key}\\b`));
  });
});
