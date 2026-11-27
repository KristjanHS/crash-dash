import { afterEach, describe, expect, test, vi } from "vitest";
import { clearRunBudget, startRunBudget } from "./fetch-budget.js";
import type { FetchLike } from "./feed-http.js";
import {
  BREVO_SEND_URL,
  EMAIL_CHUNK,
  brevoPayload,
  chunk,
  emailBody,
  sendBandEmail,
  unsubscribeLink,
} from "./email.js";
import { emailSendEnabled } from "./config.js";

const MSG = { title: "WARNING - band moved", body: "line 1\nline 2", tags: "warning", priority: 4 };
const DASH = "https://dash.example";

describe("pure builders", () => {
  test("chunk splits into consecutive groups of at most size, last one shorter", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 99)).toEqual([[1]]);
    expect(() => chunk([1], 0)).toThrow(/>= 1/);
  });

  test("emailBody = title + body verbatim + footer; generic unsubscribe link without a recipient", () => {
    const body = emailBody(MSG, DASH);
    expect(body.startsWith("WARNING - band moved\n\nline 1\nline 2\n")).toBe(true);
    expect(body).toContain(`Dashboard: ${DASH}`);
    expect(body.endsWith(`\nUnsubscribe: ${DASH}/subscribe?a=unsub`)).toBe(true);
  });

  test("emailBody with no dashboard url ⇒ title + body only: no Dashboard and no Unsubscribe line", () => {
    expect(emailBody(MSG, undefined)).toBe("WARNING - band moved\n\nline 1\nline 2");
    expect(emailBody(MSG, undefined, "a@x.test")).toBe("WARNING - band moved\n\nline 1\nline 2");
  });

  test("emailBody with a recipient carries that address in the unsubscribe link, url-encoded, intent intact", () => {
    const body = emailBody(MSG, DASH, "a+b@x.test");
    expect(body).toContain(`Unsubscribe: ${unsubscribeLink(DASH, "a+b@x.test")}`);
    // J0.5.5: the address rides the FRAGMENT, never the query — path + query reach Vercel's
    // request log, the fragment never leaves the browser.
    expect(unsubscribeLink(DASH, "a+b@x.test")).toBe(`${DASH}/subscribe?a=unsub#email=a%2Bb%40x.test`);
    const u = new URL(unsubscribeLink(DASH, "a+b@x.test"));
    expect(u.searchParams.get("a")).toBe("unsub");
    expect(u.searchParams.get("email")).toBeNull();
    expect(u.hash).toBe("#email=a%2Bb%40x.test");
    expect(new URLSearchParams(u.hash.slice(1)).get("email")).toBe("a+b@x.test");
  });

  test("brevoPayload: one message version per recipient, single `to` each, own body; no top-level to/bcc", () => {
    const p = brevoPayload(MSG, "from@x.test", ["a@x.test", "b@x.test"], DASH);
    expect(p.sender).toEqual({ email: "from@x.test" });
    expect(p.subject).toBe(MSG.title);
    expect(p.textContent).toBe(emailBody(MSG, DASH)); // Brevo honours per-version bodies only when the top level has one
    expect(p.messageVersions).toEqual([
      { to: [{ email: "a@x.test" }], textContent: emailBody(MSG, DASH, "a@x.test") },
      { to: [{ email: "b@x.test" }], textContent: emailBody(MSG, DASH, "b@x.test") },
    ]);
    expect(p).not.toHaveProperty("to");
    expect(p).not.toHaveProperty("bcc");
    // No subscriber address may appear anywhere but inside its OWN version.
    const [a, b] = p.messageVersions;
    expect(JSON.stringify(a)).not.toContain("b@x.test");
    expect(JSON.stringify(b)).not.toContain("a@x.test");
    expect(JSON.stringify({ ...p, messageVersions: undefined })).not.toMatch(/[ab]@x\.test/);
  });
});

describe("sendBandEmail", () => {
  afterEach(() => clearRunBudget());
  const ENV = { BREVO_API_KEY: "test-key", EMAIL_FROM: "sender@x.test" };
  const noSleep = async (): Promise<void> => {}; // the retry backoff
  const ok = () => new Response("{}", { status: 201, statusText: "Created" });
  const bad = () => new Response("{}", { status: 500, statusText: "Boom" });

  test("blank BREVO_API_KEY or EMAIL_FROM ⇒ disabled: warns, never touches fetch (prod included)", async () => {
    const fetchImpl = vi.fn();
    const warn = vi.fn();
    const blankKey = { ...ENV, BREVO_API_KEY: "   " };
    expect(emailSendEnabled(blankKey)).toBe(false);
    expect(await sendBandEmail(MSG, ["a@x.test"], { fetchImpl, warn, env: { ...blankKey, VERCEL: "1" } })).toEqual({
      sent: 0,
      failed: 0,
      skipped: "disabled",
    });
    const noFrom = { BREVO_API_KEY: "test-key" };
    expect(await sendBandEmail(MSG, ["a@x.test"], { fetchImpl, warn, env: noFrom })).toEqual({ sent: 0, failed: 0, skipped: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("zero recipients ⇒ no call", async () => {
    const fetchImpl = vi.fn();
    expect(await sendBandEmail(MSG, [], { fetchImpl, env: ENV })).toEqual({ sent: 0, failed: 0, skipped: "no-recipients" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("≤99 recipients ⇒ exactly ONE Brevo call with the api-key header and one version per address", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const recipients = Array.from({ length: EMAIL_CHUNK }, (_, i) => `u${i}@x.test`);
    expect(await sendBandEmail(MSG, recipients, { fetchImpl, env: ENV })).toEqual({ sent: 99, failed: 0, skipped: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(BREVO_SEND_URL);
    expect(init.headers as Record<string, string>).toMatchObject({ "api-key": "test-key", "content-type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body.messageVersions).toHaveLength(99);
    expect(body.messageVersions[7]).toEqual({ to: [{ email: "u7@x.test" }], textContent: emailBody(MSG, undefined, "u7@x.test") });
    expect(body.sender).toEqual({ email: "sender@x.test" });
  });

  test("the footer links come from dashboardUrl(env); none resolved ⇒ the mail still sends, footer-less", async () => {
    const bodyOf = async (env: Record<string, string>): Promise<{ textContent: string; messageVersions: Array<{ textContent: string }> }> => {
      const fetchImpl = vi.fn().mockResolvedValue(ok());
      expect(await sendBandEmail(MSG, ["a@x.test"], { fetchImpl, env: { ...ENV, ...env } })).toEqual({ sent: 1, failed: 0, skipped: null });
      return JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    };
    const linked = await bodyOf({ VERCEL_PROJECT_PRODUCTION_URL: "dash.example" });
    expect(linked.messageVersions[0]!.textContent).toContain(`Unsubscribe: ${unsubscribeLink(DASH, "a@x.test")}`);
    const bare = await bodyOf({});
    for (const t of [bare.textContent, bare.messageVersions[0]!.textContent]) {
      expect(t).not.toMatch(/Dashboard:|Unsubscribe:/);
    }
  });

  test("250 recipients ⇒ 3 chunks (99/99/52); a chunk failing twice is logged, the next still sends", async () => {
    const responses = [ok(), bad(), bad(), ok()]; // chunk1 ok · chunk2 fail+retry fail · chunk3 ok
    const fetchImpl = vi.fn<FetchLike>(async () => responses.shift()!);
    const error = vi.fn();
    const recipients = Array.from({ length: 250 }, (_, i) => `u${i}@x.test`);
    expect(await sendBandEmail(MSG, recipients, { fetchImpl, error, env: ENV, sleep: noSleep })).toEqual({
      sent: 151,
      failed: 99,
      skipped: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const sizes = fetchImpl.mock.calls.map((c) => JSON.parse(c[1]!.body as string).messageVersions.length);
    expect(sizes).toEqual([99, 99, 99, 52]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/FAILED for 99 recipient/);
  });

  test("a transient miss is retried once and counts as sent; never throws to the caller", async () => {
    const responses = [bad(), ok()];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    expect(await sendBandEmail(MSG, ["a@x.test"], { fetchImpl, env: ENV, sleep: noSleep })).toEqual({ sent: 1, failed: 0, skipped: null });
  });

  test("an exhausted run fetch budget does not abort the send (it runs after the fetch phase)", async () => {
    startRunBudget(0, performance.now(), () => {});
    await new Promise((r) => setTimeout(r, 5));
    const fetchImpl = vi.fn<FetchLike>(async (_u, init) => (init?.signal?.aborted ? Promise.reject(new Error("aborted")) : ok()));
    expect(await sendBandEmail(MSG, ["a@x.test"], { fetchImpl, env: ENV, sleep: noSleep, error: vi.fn() })).toEqual({ sent: 1, failed: 0, skipped: null });
  });

  test("a rejecting fetch (network drop) is swallowed after the retry — the caller never sees a throw", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(sendBandEmail(MSG, ["a@x.test"], { fetchImpl, env: ENV, sleep: noSleep, error: vi.fn() })).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: null,
    });
  });
});
