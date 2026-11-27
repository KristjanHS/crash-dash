import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PREFETCH_TTL_MS, dropPrefetches, fetchOnce, fetchOnceVia, prefetchThenGate } from "./gate-prefetch.js";
import { SUPABASE_ORIGIN } from "./supabase-host.js";

const src = (f) =>
  readFileSync(new URL(`./${f}`, import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

describe("prefetchThenGate - the session renewal is off the data path", () => {
  it("the first /api fetch starts while ensureSession is still held open", async () => {
    const order = [];
    const fetchImpl = (u) => (order.push(`fetch ${u}`), Promise.resolve({ ok: true, u }));
    let release;
    const held = new Promise((r) => (release = () => (order.push("session"), r(true))));
    const gated = Promise.resolve(prefetchThenGate(["/api/p4-a"], () => held, fetchImpl)).then((open) => (order.push("open"), open));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["fetch /api/p4-a"]);
    release();
    expect(await gated).toBe(true);
    expect(order).toEqual(["fetch /api/p4-a", "session", "open"]);
    expect(await fetchOnce("/api/p4-a")).toEqual({ ok: true, u: "/api/p4-a" });
  });

  it("a url is prefetched once; a rejected untaken prefetch raises no unhandled rejection", async () => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let n = 0;
      const fetchImpl = () => (n++, Promise.reject(new Error("offline")));
      await prefetchThenGate(["/api/p4-b", "/api/p4-b"], async () => false, fetchImpl);
      expect(n).toBe(1);
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      dropPrefetches();
    }
  });

  it("dropPrefetches hands a later fetchOnce to the network, and app.js drops after its boot cycle", async () => {
    await prefetchThenGate(["/api/p4-d"], async () => true, () => Promise.resolve("boot"));
    dropPrefetches();
    expect(await fetchOnce("/api/p4-d", undefined, Date.now, () => Promise.resolve("network"))).toBe("network");
    expect(src("app.js")).toMatch(/^fetchAll\(\)\.finally\(\(\) => dropPrefetches\(\)\);/m);
  });

  it("fetchOnceVia takes the prefetch once, then misses through ITS fetchImpl (app.js: the auth wrapper)", async () => {
    await prefetchThenGate(["/api/p4-e"], async () => true, () => Promise.resolve("boot"));
    const via = fetchOnceVia((url) => Promise.resolve(`via:${url}`));
    expect(await via("/api/p4-e")).toBe("boot");
    expect(await via("/api/p4-e")).toBe("via:/api/p4-e");
  });

  it("a signal-only init (request's timeout) takes the prefetch; any other init key misses; the prefetch carries a signal", async () => {
    const inits = [];
    await prefetchThenGate(["/api/p4-f", "/api/p4-g"], async () => true, (_url, init) => (inits.push(init), Promise.resolve("boot")));
    expect(inits.every((i) => i?.signal instanceof AbortSignal)).toBe(true);
    const net = () => Promise.resolve("network");
    expect(await fetchOnce("/api/p4-f", { signal: AbortSignal.timeout(1000) }, Date.now, net)).toBe("boot");
    expect(await fetchOnce("/api/p4-g", { signal: AbortSignal.timeout(1000), headers: {} }, Date.now, net)).toBe("network");
    // A null init reads as no init: it takes the prefetch rather than throwing in the key check.
    await prefetchThenGate(["/api/p4-h"], async () => true, () => Promise.resolve("boot"));
    expect(await fetchOnce("/api/p4-h", null, Date.now, net)).toBe("boot");
    dropPrefetches();
  });

  it("an untaken prefetch older than PREFETCH_TTL_MS is dropped, never served as fresh", async () => {
    let t = 0;
    await prefetchThenGate(["/api/p4-c"], async () => true, () => Promise.resolve("stale"), () => t);
    t = PREFETCH_TTL_MS;
    expect(await fetchOnce("/api/p4-c", undefined, () => t, () => Promise.resolve("fresh"))).toBe("fresh");
  });

  it("every gated page starts its reads before awaiting the gate; auth-nav has no top-level await", () => {
    for (const f of ["app.js", "lab.js", "exposure.js"]) {
      const s = src(f);
      expect(s, f).toMatch(/prefetchThenGate\(/);
      expect(s, f).toMatch(/^if \(!\(await prefetchThenGate\(BOOT_URLS, canViewPage[,)]/m);
    }
    expect(src("auth-nav.js")).not.toMatch(/^\S.*\bawait\b/m);
  });

  it("each gated page preconnects to the pinned Supabase origin", () => {
    for (const f of ["index.html", "lab.html", "exposure.html"]) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), f).toContain(
        `<link rel="preconnect" href="${SUPABASE_ORIGIN}" crossorigin />`,
      );
    }
  });
});
