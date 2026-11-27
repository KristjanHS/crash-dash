import { afterEach, expect, test, describe, vi } from "vitest";
import { clearRunBudget, startRunBudget } from "./fetch-budget.js";
import type { FetchLike } from "./feed-http.js";
import { ntfyHeaders, pushNtfy } from "./ntfy.js";
import { ntfyPushEnabled } from "./config.js";

const noSleep = async (): Promise<void> => {};
const okResponse = (): Response => new Response("{}", { status: 200, statusText: "OK" });

const DASH = "https://dash.example";

describe("ntfyHeaders (header policy §6.5 priority)", () => {
  test("sets Title + Click (dashboard link on tap); adds Tags and Priority when present", () => {
    expect(ntfyHeaders({ title: "t", body: "b" }, DASH)).toEqual({ Title: "t", Click: DASH });
    expect(ntfyHeaders({ title: "t", body: "b", tags: "rotating_light", priority: 5 }, DASH)).toEqual({
      Title: "t",
      Click: DASH,
      Tags: "rotating_light",
      Priority: "5",
    });
  });

  test("no dashboard url ⇒ no Click header (the push itself is unaffected)", () => {
    expect(ntfyHeaders({ title: "t", body: "b", priority: 4 }, undefined)).toEqual({ Title: "t", Priority: "4" });
  });

  test("omits Tags and Priority when absent (no 'undefined' header)", () => {
    const h = ntfyHeaders({ title: "t", body: "b" }, DASH);
    expect("Tags" in h).toBe(false);
    expect("Priority" in h).toBe(false);
  });

  test("priority 0 is still emitted - the guard is !== undefined, not falsy", () => {
    expect(ntfyHeaders({ title: "t", body: "b", priority: 0 }, DASH).Priority).toBe("0");
  });
});

describe("pushNtfy - Click comes from dashboardUrl(env)", () => {
  const headersOf = async (env: Record<string, string>): Promise<Record<string, string>> => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await pushNtfy({ title: "t", body: "b" }, { fetchImpl, env: { NTFY_TOPIC: "test-topic", ...env }, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledOnce(); // sent either way
    return (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
  };

  test("PROD_ALIAS set ⇒ Click = its https origin", async () => {
    expect((await headersOf({ PROD_ALIAS: "dash.example" })).Click).toBe(DASH);
  });

  test("no PROD_ALIAS and no Vercel production url ⇒ still POSTs, with no Click", async () => {
    expect("Click" in (await headersOf({}))).toBe(false);
  });
});

describe("ntfyPushEnabled - never POST to the public dev topic off-prod", () => {
  test("explicitly-set topic ⇒ enabled (dev opts in with their own topic)", () => {
    expect(ntfyPushEnabled({ NTFY_TOPIC: "my-private-topic" })).toBe(true);
  });
});

describe("prod unset-topic guard - no public dev-topic fallback (audit rank 2)", () => {
  test("prod (VERCEL or NODE_ENV) + unset topic ⇒ pushNtfy throws and never touches fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(pushNtfy({ title: "t", body: "b" }, { fetchImpl, env: { VERCEL: "1" } })).rejects.toThrow(/NTFY_TOPIC is unset on prod/);
    await expect(pushNtfy({ title: "t", body: "b" }, { fetchImpl, env: { NODE_ENV: "production" } })).rejects.toThrow(
      /NTFY_TOPIC is unset on prod/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("prod + explicit topic ⇒ pushes to that topic, not the dev default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await pushNtfy({ title: "t", body: "b" }, { fetchImpl, env: { VERCEL: "1", NTFY_TOPIC: "owner-private-topic" } });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://ntfy.sh/owner-private-topic");
  });
});

describe("pushNtfy - timeout + one retry (audit rank 1)", () => {
  afterEach(() => clearRunBudget());
  // An explicit topic opts in to a real push; `noSleep` collapses the retry backoff.
  const deps = (fetchImpl: FetchLike) => ({ fetchImpl, env: { NTFY_TOPIC: "test-topic" }, sleep: noSleep });

  test("passes an AbortSignal timeout to every fetch (a hung ntfy can't stall the cron)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await pushNtfy({ title: "t", body: "b" }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("retries ONCE on a thrown fetch, then succeeds (transient network drop)", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("network drop")).mockResolvedValueOnce(okResponse());
    await expect(pushNtfy({ title: "t", body: "b" }, deps(fetchImpl))).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("a non-OK HTTP status counts as failure: retries once, then throws (no silent drop)", async () => {
    const bad = { ok: false, status: 503, statusText: "Service Unavailable" } as Response;
    const fetchImpl = vi.fn().mockResolvedValue(bad);
    await expect(pushNtfy({ title: "t", body: "b" }, deps(fetchImpl))).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("an exhausted run fetch budget does not abort the push (it runs after the fetch phase)", async () => {
    startRunBudget(0, performance.now(), () => {});
    await new Promise((r) => setTimeout(r, 5));
    const fetchImpl = vi.fn<FetchLike>(async (_u, init) => (init?.signal?.aborted ? Promise.reject(new Error("aborted")) : okResponse()));
    await expect(pushNtfy({ title: "t", body: "b" }, deps(fetchImpl))).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("suppressed off-prod (unset, blank or whitespace-only topic) ⇒ never touches fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse()); // a regression must not POST to the real dev topic
    // UNSET is the dev default (no public-topic fallback); blank and whitespace-only read as unset too.
    for (const env of [{}, { NTFY_TOPIC: "" }, { NTFY_TOPIC: "   " }]) {
      await pushNtfy({ title: "t", body: "b" }, { fetchImpl, env, sleep: noSleep });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
