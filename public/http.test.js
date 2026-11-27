import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { API_TIMEOUT_MS, getJson, request, send } from "./http.js";

const dir = new URL("./", import.meta.url);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const prodSources = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => [f, stripComments(readFileSync(new URL(f, dir), "utf8"))]);
/** The call's argument text, from its opening paren to the matching close (paren depth only). */
function callArgs(src, open) {
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const answer = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
/** Never answers; rejects with the signal's reason once it aborts — a fetch that honours `signal`. */
const hanging = () =>
  vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));

describe("http.js", () => {
  it("getJson parses a 2xx and throws `HTTP <status>` with .status on a non-2xx", async () => {
    await expect(getJson("/api/x", { fetchImpl: answer(200, { a: 1 }) })).resolves.toEqual({ a: 1 });
    await expect(getJson("/api/x", { fetchImpl: answer(503, {}) })).rejects.toMatchObject({ message: "HTTP 503", status: 503 });
  });

  it("the timeout aborts a request that never answers", async () => {
    await expect(getJson("/api/x", { fetchImpl: hanging(), timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("a caller signal aborts too, composed with the default timeout", async () => {
    const ac = new AbortController();
    const p = request("/api/x", { fetchImpl: hanging(), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("timeoutMs: null with no init calls fetchImpl with the url ALONE (fetchOnce's prefetch take)", async () => {
    const f = answer(200, {});
    await request("/api/status", { fetchImpl: f, timeoutMs: null });
    expect(f.mock.calls[0]).toEqual(["/api/status"]);
  });

  it("send POSTs a JSON body with a JSON content-type beside the caller's headers; no body adds none", async () => {
    const f = answer(201, {});
    await send("/rest/x", { headers: { apikey: "k" }, body: { a: 1 }, fetchImpl: f });
    const [, init] = f.mock.calls[0];
    expect(init).toMatchObject({ method: "POST", body: '{"a":1}', headers: { "content-type": "application/json", apikey: "k" } });
    await send("/rest/x", { method: "DELETE", headers: { apikey: "k" }, fetchImpl: f });
    expect(f.mock.calls[1][1]).toMatchObject({ method: "DELETE", headers: { apikey: "k" } });
    expect(f.mock.calls[1][1].headers).not.toHaveProperty("content-type");
    expect(f.mock.calls[1][1]).not.toHaveProperty("body");
  });

  it("no production public/*.js but http.js reaches the global fetch (an alias or a bare `fetch(`)", () => {
    const GLOBAL_FETCH = /globalThis\.fetch|(^|[^.\w$])fetch\(/m;
    const sources = prodSources();
    // Establishes the scan: http.js itself must match, or the regex has gone blind.
    expect(GLOBAL_FETCH.test(sources.find(([f]) => f === "http.js")[1])).toBe(true);
    expect(sources.filter(([f, src]) => f !== "http.js" && GLOBAL_FETCH.test(src)).map(([f]) => f)).toEqual([]);
  });

  it("every same-origin /api read via getJson/request/send outlives the handler's maxDuration", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    // The FE never reads `api/cron/*` (its own 300 s cap) — only the read handlers bound this timeout.
    const reads = Object.entries(vercel.functions ?? {}).filter(([glob]) => !glob.startsWith("api/cron/"));
    const maxDuration = Math.max(...reads.map(([, f]) => f.maxDuration ?? 0));
    expect(maxDuration).toBeGreaterThan(0);
    expect(API_TIMEOUT_MS).toBeGreaterThanOrEqual(maxDuration * 1000);
    const apiSites = [];
    for (const [f, src] of prodSources()) {
      if (f === "http.js") continue;
      for (const m of src.matchAll(/(?<![.\w$])(?:getJson|request|send)\(/g)) {
        const args = callArgs(src, m.index + m[0].length - 1);
        if (/^\s*[`"'](?:\/api\b|\$\{API\})/.test(args)) apiSites.push({ f, args: args.replace(/\s+/g, " ") });
      }
    }
    expect(apiSites.length, "no /api call sites found — the scan is vacuous").toBeGreaterThanOrEqual(9);
    // load-cycle.js passes `via` = bare(): timeoutMs null, i.e. no timeout at all.
    const short = apiSites.filter(({ args }) => !/\bAPI_TIMEOUT_MS\b|,\s*via\s*$/.test(args)).map(({ f, args }) => `${f}: ${args.slice(0, 70)}`);
    expect(short).toEqual([]);
  });
});
