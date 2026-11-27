import { afterEach, describe, expect, test } from "vitest";
import { clearRunBudget, startRunBudget } from "./fetch-budget.js";
import { type FeedHttpOpts, fetchJson, fetchOk, fetchParsed, fetchText, HttpStatusError } from "./feed-http.js";

type Call = { url: string; init?: RequestInit };

/** A scripted wire: each call takes the next `Response` (or throws the next error); the last entry repeats. */
function wire(...script: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
  };
  return { calls, fetchImpl };
}

const ok = (body: string): Response => new Response(body, { status: 200 });
const bad = (status: number, statusText: string): Response => new Response("err-body", { status, statusText });

function retryOpts(fetchImpl: FeedHttpOpts["fetchImpl"], retry: Partial<NonNullable<FeedHttpOpts["retry"]>> = {}) {
  const sleeps: number[] = [];
  const opts: FeedHttpOpts = {
    fetchImpl,
    timeoutMs: 1_000,
    label: "X fetch failed",
    retry: { attempts: 3, backoffMs: 7, sleep: async (ms) => void sleeps.push(ms), ...retry },
  };
  return { opts, sleeps };
}

describe("fetchText / fetchJson (one attempt by default)", () => {
  test("a non-OK throws HttpStatusError with the label message and the status fields, after ONE call", async () => {
    const { calls, fetchImpl } = wire(bad(503, "Service Unavailable"));
    const err = await fetchText("https://x/a?api_key=SECRET#f", { fetchImpl, timeoutMs: 1_000, label: "X fetch failed for Y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).message).toBe("X fetch failed for Y: 503 Service Unavailable");
    expect(err).toMatchObject({ status: 503, statusText: "Service Unavailable", url: "https://x/a" });
    expect(calls).toHaveLength(1);
  });

  test("statusMessage overrides the message and can read the response body", async () => {
    const { fetchImpl } = wire(bad(500, "Internal"));
    const statusMessage = async (res: Response) => `custom ${res.status}: ${await res.text()}`;
    await expect(fetchText("https://x", { fetchImpl, timeoutMs: 1_000, label: "unused", statusMessage })).rejects.toThrow(
      /^custom 500: err-body$/,
    );
  });

  test("passes the caller's init through and attaches a per-attempt abort signal", async () => {
    const { calls, fetchImpl } = wire(ok("body"));
    const init = { headers: { "User-Agent": "ua" } };
    expect(await fetchText("https://x", { fetchImpl, init, timeoutMs: 1_000, label: "X" })).toBe("body");
    expect(calls[0]!.init?.headers).toEqual({ "User-Agent": "ua" });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.signal?.aborted).toBe(false);
  });

  test("a caller-supplied signal is composed in: aborting it aborts the fetch's signal", async () => {
    const { calls, fetchImpl } = wire(ok("body"));
    const ctl = new AbortController();
    await fetchText("https://x", { fetchImpl, init: { signal: ctl.signal }, timeoutMs: 60_000, label: "X" });
    const seen = calls[0]!.init!.signal!;
    expect(seen).not.toBe(ctl.signal);
    ctl.abort();
    expect(seen.aborted).toBe(true);
  });

  test("fetchJson hands the parsed JSON to the hand parser; a non-JSON body throws the SyntaxError", async () => {
    const parse = (u: unknown) => (u as { n: number }).n * 2;
    expect(await fetchJson("https://x", parse, { fetchImpl: wire(ok('{"n":21}')).fetchImpl, timeoutMs: 1_000, label: "X" })).toBe(42);
    await expect(fetchJson("https://x", parse, { fetchImpl: wire(ok("<html>")).fetchImpl, timeoutMs: 1_000, label: "X" })).rejects.toThrow(
      SyntaxError,
    );
  });

  test("fetchJson: `badJson` replaces the SyntaxError, sees the raw body, and the retry veto sees its error", async () => {
    const { calls, fetchImpl } = wire(ok("<html>"));
    const badJson = (text: string, err: unknown) => new Error(`bad ${text} ${err instanceof SyntaxError}`);
    const retryOn = (err: unknown) => !(err instanceof Error && err.message.startsWith("bad"));
    const { opts } = retryOpts(fetchImpl, { retryOn });
    await expect(fetchJson("https://x", (u) => u, { ...opts, badJson })).rejects.toThrow(/^bad <html> true$/);
    expect(calls).toHaveLength(1);
  });
});

describe("the retry loop", () => {
  test("retries up to `attempts`, sleeping `backoffMs` between (not after the last), then throws the last error", async () => {
    const { calls, fetchImpl } = wire(new Error("net-1"), bad(502, "Bad Gateway"), bad(503, "Busy"));
    const { opts, sleeps } = retryOpts(fetchImpl);
    await expect(fetchText("https://x", opts)).rejects.toThrow(/^X fetch failed: 503 Busy$/);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([7, 7]);
  });

  test("returns the first success without further calls", async () => {
    const { calls, fetchImpl } = wire(bad(500, "E"), ok("fine"));
    expect(await fetchText("https://x", retryOpts(fetchImpl).opts)).toBe("fine");
    expect(calls).toHaveLength(2);
  });

  test("retryOn=false rethrows at once, unwrapped by giveUp", async () => {
    const { calls, fetchImpl } = wire(bad(404, "Not Found"), ok("never"));
    const retryOn = (e: unknown) => e instanceof HttpStatusError && e.status >= 500;
    const giveUp = () => new Error("wrapped");
    await expect(fetchText("https://x", retryOpts(fetchImpl, { retryOn, giveUp }).opts)).rejects.toThrow(/^X fetch failed: 404 Not Found$/);
    expect(calls).toHaveLength(1);
  });

  test("the parse runs inside the attempt: a parse throw (e.g. 0 rows) is retried like a fetch failure", async () => {
    const { calls, fetchImpl } = wire(ok(""), ok("row"));
    const parse = (t: string) => {
      if (!t) throw new Error("0 observations");
      return t;
    };
    expect(await fetchParsed("https://x", parse, retryOpts(fetchImpl).opts)).toBe("row");
    expect(calls).toHaveLength(2);
  });

  test("windowMs: no retry STARTS once elapsed + backoff reaches the window; giveUp sees attempts + elapsed", async () => {
    let t = 0;
    const { calls, fetchImpl } = wire(bad(503, "Busy"));
    const fetchTicking = (url: string, init?: RequestInit) => ((t += 5), fetchImpl(url, init));
    const seen: { attempts: number; elapsedMs: number }[] = [];
    const giveUp = (err: unknown, info: { attempts: number; elapsedMs: number }) => (seen.push(info), new Error(`gave up: ${String(err)}`));
    // attempt 1 ends at t=5 (5+7 < 13 → retry), attempt 2 ends at t=10 (10+7 ≥ 13 → stop), far below attempts=10.
    const { opts } = retryOpts(fetchTicking, { attempts: 10, windowMs: 13, now: () => t, giveUp });
    await expect(fetchText("https://x", opts)).rejects.toThrow(/^gave up: HttpStatusError: X fetch failed: 503 Busy$/);
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([{ attempts: 2, elapsedMs: 10 }]);
  });

  test("rewriteUrl picks each attempt's URL (1-based)", async () => {
    const { calls, fetchImpl } = wire(bad(503, "Busy"), bad(503, "Busy"), ok("ok"));
    const rewriteUrl = (url: string, attempt: number) => (attempt === 1 ? url : `${url}?_=${attempt}`);
    await fetchText("https://x/a", retryOpts(fetchImpl, { rewriteUrl }).opts);
    expect(calls.map((c) => c.url)).toEqual(["https://x/a", "https://x/a?_=2", "https://x/a?_=3"]);
  });

  test("every attempt gets a FRESH signal", async () => {
    const { calls, fetchImpl } = wire(bad(503, "Busy"), ok("ok"));
    await fetchText("https://x", retryOpts(fetchImpl).opts);
    expect(calls[0]!.init!.signal).not.toBe(calls[1]!.init!.signal);
  });
});

describe("runBudget opt-out", () => {
  afterEach(() => clearRunBudget());

  test("an exhausted run budget aborts the default call; runBudget: false still goes through", async () => {
    startRunBudget(0, performance.now(), () => {});
    await new Promise((r) => setTimeout(r, 5)); // the deadline fires, as after a hung fetch phase
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
      init?.signal?.aborted ? Promise.reject(init.signal.reason as Error) : Promise.resolve(ok("sent"));
    const opts: FeedHttpOpts = { fetchImpl, timeoutMs: 10_000, label: "push failed" };
    await expect(fetchText("https://x", opts)).rejects.toThrow(/run fetch budget/);
    await expect(fetchText("https://x", { ...opts, runBudget: false })).resolves.toBe("sent");
  });
});

describe("fetchOk", () => {
  test("a 2xx resolves unread: a body that would fail to read never triggers a retry", async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls++;
      const res = ok("sent");
      Object.defineProperty(res, "text", { value: () => Promise.reject(new Error("body stream reset")) });
      return Promise.resolve(res);
    };
    await expect(fetchOk("https://x", retryOpts(fetchImpl).opts)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});
