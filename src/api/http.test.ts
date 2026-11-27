/**
 * Unit pins for the shared read-API header policies (src/api/http.ts). The handler suites
 * prove where each policy is SERVED; this file pins what each policy SAYS, so a retune of
 * one constant cannot silently change the negotiated edge behaviour of every consumer.
 */
import { describe, expect, test } from "vitest";

import {
  DEGRADED_HEADERS,
  VINTAGE_HEADERS,
  VINTAGE_TAG,
  parseLimit,
  rejectUnknownParams,
  serveRedactable,
} from "./http.js";

describe("serveRedactable — redact(raw) to every request, on the handler's headers", () => {
  type Body = { level: number | null };
  const redact = (): Body => ({ level: null });
  const serve = async (publicHeaders?: Record<string, string> | (() => Record<string, string>)) => {
    const res = await serveRedactable(Promise.resolve<Body>({ level: 7 }), redact, publicHeaders ? { publicHeaders } : undefined);
    return { cache: res.headers.get("Cache-Control"), tag: res.headers.get("Vercel-Cache-Tag"), body: (await res.json()) as Body };
  };

  test("the redacted body rides the vintage default, or the handler's headers (a thunk read once the body settles)", async () => {
    expect(await serve()).toEqual({ cache: VINTAGE_HEADERS["Cache-Control"], tag: VINTAGE_TAG, body: { level: null } });
    expect(await serve(DEGRADED_HEADERS)).toEqual({ cache: DEGRADED_HEADERS["Cache-Control"], tag: VINTAGE_TAG, body: { level: null } });
    expect(await serve(() => DEGRADED_HEADERS)).toEqual({ cache: DEGRADED_HEADERS["Cache-Control"], tag: VINTAGE_TAG, body: { level: null } });
  });

  test("a Response from the body passes through untouched", async () => {
    const notFound = Response.json({ error: "none" }, { status: 404 });
    expect(await serveRedactable(Promise.resolve<Body | Response>(notFound), redact)).toBe(notFound);
  });
});

describe("DEGRADED_HEADERS (P12.d - negative caching for store-degraded 200s)", () => {
  test("keeps the vintage tag, so the cron's purge still reaches a degraded copy early", () => {
    expect(DEGRADED_HEADERS["Vercel-Cache-Tag"]).toBe(VINTAGE_TAG);
    expect(VINTAGE_HEADERS["Vercel-Cache-Tag"]).toBe(VINTAGE_TAG);
  });
  test("stays CDN-cached: a degraded 200 still carries an s-maxage", () => {
    expect(DEGRADED_HEADERS["Cache-Control"]).toMatch(/s-maxage=\d+/);
  });
});

describe("rejectUnknownParams (S-1 cache-key canonicalisation)", () => {
  test("an unknown param (?cb=) is refused: 400, no-store, naming the param - it cannot mint an edge key", async () => {
    const res = rejectUnknownParams(new URLSearchParams("id=F1&cb=123"), ["id"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res!.json()) as { error: string }).error).toContain('"cb"');
  });

  test("every-param-known passes through as null; a no-param request passes an EMPTY allowlist", () => {
    expect(rejectUnknownParams(new URLSearchParams("id=F1&limit=5"), ["id", "limit"])).toBeNull();
    expect(rejectUnknownParams(new URLSearchParams(), [])).toBeNull();
  });

  test("an EMPTY allowlist refuses any param at all", () => {
    expect(rejectUnknownParams(new URLSearchParams("cb=1"), [])?.status).toBe(400);
  });
});

describe("parseLimit (`?limit=` parse + clamp shared by /series and /meta)", () => {
  const opts = { def: 50, max: 500 };

  test("absent ⇒ the default; an in-range integer, both bounds included, passes through as a number", () => {
    expect(parseLimit(null, opts)).toBe(opts.def);
    expect(parseLimit("1", opts)).toBe(1);
    expect(parseLimit("120", opts)).toBe(120);
    expect(parseLimit(String(opts.max), opts)).toBe(opts.max);
  });

  test.each(["0", String(opts.max + 1), "2.5", "abc", "", "-3"])("limit=%j is refused: an uncached 400 naming the allowed range", async (raw) => {
    const res = parseLimit(raw, opts);
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(400);
    expect(r.headers.get("Cache-Control")).toBeNull(); // a bad request must not mint an edge copy
    expect(((await r.json()) as { error: string }).error).toBe(`limit must be an integer in 1..${opts.max}`);
  });
});
