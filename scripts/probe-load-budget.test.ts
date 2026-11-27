import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  cpuBound,
  fetchWire,
  hotSet,
  warmUrls,
  isMiss,
  parseArgs,
  perPageLoad,
  project,
  refocusBytes,
  REFOCUS_REQUESTS,
  renderBudget,
  sampleHotSet,
  SLOW_POINTS,
  staticGraph,
  staticLoads,
  type Sample,
  PAGE_HTML,
} from "./probe-load-budget.js";

const K = { audience: 100, owners: 2, loads: 5, refocus: 0, assetRevalidate: 1 };
const sample = (over: Partial<Sample>): Sample => ({
  page: "index",
  path: "/api/x",
  status: 200,
  cache: "HIT",
  bytes: 1000,
  ms: 50,
  serverTiming: "",
  ...over,
});

describe("probe-load-budget — pure core", () => {
  it("hotSet: index 9 (no per-card /series); lab 4; exposure 1 (app.js/lab.js load paths)", () => {
    const urls = hotSet();
    expect(urls.filter((u) => u.page === "index")).toHaveLength(9);
    expect(urls.filter((u) => u.page === "lab")).toHaveLength(4);
    expect(urls.filter((u) => u.page === "exposure")).toHaveLength(1);
    // the index's only /api/series reads are renderZoneSlow's three bubble-state legs — no per-card fan-out
    const seriesIds = urls.filter((u) => u.page === "index" && u.path.startsWith("/api/series"))
      .map((u) => new URL(u.path, "http://x").searchParams.get("id"));
    expect(seriesIds.length).toBeGreaterThan(0);
    for (const id of seriesIds) expect(["price-accel", "complacency-vix", "complacency-high"]).toContain(id);
    // P12.c: the public page — the 5 URLs public/overview.js issues on first paint, no series fan-out
    expect(urls.filter((u) => u.page === "overview").map((u) => u.path)).toEqual([
      "/api/status",
      "/api/lab?hist=20",
      "/api/families",
      "/api/indicators",
      "/api/danger-model",
    ]);
  });

  it("SLOW_POINTS mirrors public/app.js SLOW_POINTS (the bubble-state /series limit never drifts)", () => {
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const m = /^const SLOW_POINTS = (\d+);/m.exec(app);
    expect(m, "public/app.js lost its `const SLOW_POINTS = <n>;`").not.toBeNull();
    expect(Number(m![1])).toBe(SLOW_POINTS);
  });

  it("deploy-prod-local.sh warms from --print-urls, never a hand-copied /api list", () => {
    const sh = readFileSync(new URL("./deploy-prod-local.sh", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(sh).toMatch(/probe-load-budget\.ts --print-urls/);
    expect(sh).toMatch(/done <<< "\$WARM_URLS"/);
    expect(sh).not.toMatch(/for path in [^\n]*\/api\//);
  });

  it("warmUrls() is the deduped public /overview hot set (no signed-in-only path), under the ~15-req IP challenge", () => {
    const urls = warmUrls();
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toEqual(["/api/status", "/api/lab?hist=20", "/api/families", "/api/indicators", "/api/danger-model"]);
    expect(urls.length).toBeLessThan(15);
  });

  it("parseArgs: defaults + knobs; a negative knob throws", () => {
    const d = parseArgs([], { PROD_ALIAS: "prod-alias.invalid" });
    expect(d).toMatchObject({ audience: 100, owners: 1, loads: 5, refocus: 5, assetRevalidate: 1, pace: 8000 });
    expect(parseArgs(["--asset-revalidate=3"], { PROD_ALIAS: "prod-alias.invalid" }).assetRevalidate).toBe(1);
    expect(d.base).toBe("https://prod-alias.invalid");
    // No --base and no alias configured → refuses (no built-in default); --base alone needs no config.
    expect(() => parseArgs([], { PROD_CONFIG_DIR: "/nonexistent.invalid" })).toThrow(/no target configured/);
    expect(parseArgs(["--base=https://x.invalid"], { PROD_CONFIG_DIR: "/nonexistent.invalid" }).base).toBe("https://x.invalid");
    expect(parseArgs(["--base=http://localhost:3000/", "--audience=7", "--pace=0"], {})).toMatchObject({
      base: "http://localhost:3000",
      audience: 7,
      pace: 0,
    });
    expect(() => parseArgs(["--owners=-1"], { PROD_ALIAS: "prod-alias.invalid" })).toThrow(/--owners/);
  });

  it("perPageLoad sums each page's sampled requests + bytes", () => {
    const samples = [
      sample({ bytes: 5000 }),
      sample({ path: "/api/series?id=price-accel&limit=30", bytes: 900 }),
      sample({ page: "lab", bytes: 40000 }),
    ];
    const pages = perPageLoad(samples);
    expect(pages.find((p) => p.page === "index")).toEqual({ page: "index", requests: 2, bytes: 5900, statics: { requests: 0, bytes: 0 } });
    expect(pages.find((p) => p.page === "lab")).toEqual({ page: "lab", requests: 1, bytes: 40000, statics: { requests: 0, bytes: 0 } });
  });

  it("project: edge requests = Σ page requests × viewers × loads × weight × 30 — overview × audience, gated × owners", () => {
    const rows = [sample({ bytes: 100 }), sample({ page: "lab", bytes: 200 }), sample({ page: "overview", bytes: 300 })];
    const pages = perPageLoad(rows);
    const proj = project(pages, rows, K);
    // index 1 × 2 owners × 5 × 1.0 × 30 = 300 ; lab 1 × 2 × 5 × 0.5 × 30 = 150 ; overview 1 × 100 × 5 × 1.0 × 30 = 15 000
    expect(proj.edgeRequests).toBe(15_450);
    expect(proj.transferBytes).toBe(100 * 300 + 200 * 150 + 300 * 15_000);
  });

  it("staticGraph: HTML + stylesheet + static module graph; a dynamic import(), an icon link and a comment are not first paint", () => {
    const files: Record<string, string> = {
      "p.html": `<link rel="stylesheet" href="./s.css" /><link\n rel="icon" href="data:x" /><script type="module" src="./a.js"></script>`,
      "s.css": "body{}",
      "a.js": `import { b } from "./lib/b.js";\n// re-exported from "./gone.js" once\nconst l = () => import("./lazy.js");`,
      "lib/b.js": `export * from "../a.js";`,
    };
    expect(staticGraph("p.html", (r) => files[r]!)).toEqual(["p.html", "s.css", "a.js", "lib/b.js"]);
  });

  it("staticLoads (E1 remedy A): the deployed bundle, never the loose module graph", () => {
    const read = (rel: string) => readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");
    // brotli q11 is ~1.6 s and feeds only bytes > 0; real esbuild is pinned in bundle-public.test.ts — here ONE bundle per page.
    const bundle = (_dir: string, htmlRel: string) => ({ html: read(htmlRel), bundleRel: "page.bundle.js", code: "bundle" });
    const loads = staticLoads({ sizeOf: (t) => t.length, bundle });
    for (const page of ["index", "lab", "exposure", "overview"] as const) {
      expect(loads[page].requests).toBeLessThan(staticGraph(PAGE_HTML[page], read).length);
      expect(loads[page].bytes).toBeGreaterThan(0);
    }
  });

  it("project: statics are edge requests + transfer at --asset-revalidate, never function invocations", () => {
    const rows = [sample({ page: "overview", bytes: 300 })];
    const pages = perPageLoad(rows, { index: { requests: 0, bytes: 0 }, lab: { requests: 0, bytes: 0 }, exposure: { requests: 0, bytes: 0 }, overview: { requests: 60, bytes: 50_000 } });
    const full = project(pages, rows, K);
    const half = project(pages, rows, { ...K, assetRevalidate: 0.5 });
    // overview 100 × 5 × 30 = 15 000 loads
    expect(full.edgeRequests).toBe(61 * 15_000);
    expect(half.edgeRequests).toBe(31 * 15_000);
    expect(full.transferBytes).toBe((300 + 50_000) * 15_000);
    expect(full.missInvocations).toBe(15_000);
  });

  it("cpuBound (E4): Σ keys × 30 d / s-maxage × (mean MISS − p50 HIT); NaN with no MISS row", () => {
    const rows = [
      sample({ path: "/api/status", cache: "MISS", ms: 1100 }),
      sample({ path: "/api/config", ms: 100 }),
      sample({ path: "/api/series?id=A&limit=30", ms: 100 }),
    ];
    // status: 30 expiries (s-maxage 86400) · config: 720 (3600) · series: 30 → 780 × 1 s
    expect(cpuBound(rows)).toBeCloseTo(780, 6);
    expect(project(perPageLoad(rows), rows, K).cpuSeconds).toBeCloseTo(780, 6);
    expect(Number.isNaN(cpuBound([sample({})]))).toBe(true);
  });

  it("cpuBound (5b): zero HIT rows → the warm re-fetch baseline; NaN without one (never a 0 ms baseline)", () => {
    const rows = [
      sample({ path: "/api/status", cache: "MISS", ms: 1100 }),
      sample({ path: "/api/config", cache: "MISS", ms: 1100 }),
    ];
    // status 30 + config 720 expiries × (1100 − 100) ms
    expect(cpuBound(rows, 100)).toBeCloseTo(750, 6);
    expect(project(perPageLoad(rows), rows, K, 100).cpuSeconds).toBeCloseTo(750, 6);
    expect(Number.isNaN(cpuBound(rows))).toBe(true);
    // a HIT row in the pass wins over the re-fetch baseline: (30 + 720 + lab 30) expiries × (1100 − 600) ms
    expect(cpuBound([...rows, sample({ path: "/api/lab", ms: 600 })], 100)).toBeCloseTo(390, 6);
  });

  it("project: the refocus term is refocus/viewer/day × REFOCUS_REQUESTS (P9) × (audience + owners) × 30, priced at the /api/status bytes", () => {
    const rows = [sample({ path: "/api/status", bytes: 17_000 }), sample({ page: "lab", bytes: 200 })];
    const pages = perPageLoad(rows);
    const base = project(pages, rows, K);
    const withRefocus = project(pages, rows, { ...K, refocus: 5 });
    expect(REFOCUS_REQUESTS).toBeGreaterThan(0); // premise: else the request term vanishes and the delta proves nothing
    expect(withRefocus.edgeRequests - base.edgeRequests).toBe(REFOCUS_REQUESTS * 102 * 5 * 30);
    expect(withRefocus.transferBytes - base.transferBytes).toBe(17_000 * 102 * 5 * 30);
    expect(refocusBytes([sample({ page: "lab", bytes: 200 })])).toBe(0);
  });

  it("isMiss: MISS/REVALIDATED/PRERENDER mean the function ran; HIT/STALE/ABSENT do not", () => {
    for (const c of ["MISS", "miss", "REVALIDATED", "PRERENDER"]) expect(isMiss(c)).toBe(true);
    for (const c of ["HIT", "STALE", "ABSENT", ""]) expect(isMiss(c)).toBe(false);
  });

  it("renderBudget: carries every Hobby cap line, the §4 shape, and the M4 purge hint when no MISS was seen", () => {
    const rows = [sample({ bytes: 100 }), sample({ bytes: 50 })];
    const pages = perPageLoad(rows);
    const lines = renderBudget(pages, project(pages, rows, K), K);
    const text = lines.join("\n");
    for (const label of ["edge requests", "fast data transfer", "function invocations (ALL-HIT)", "function invocations (ALL-MISS)", "active CPU", "supabase egress"])
      expect(text).toContain(label);
    expect(text).toContain("M4: no MISS row, or no HIT baseline, observed");
    expect(text).toContain("npx vercel cache purge --type cdn -y");
  });

  it("the default pass stays under the ~15-request IP-challenge window", () => {
    // 9 index + 4 lab + 1 exposure, minus the 2 index/lab overlaps (/families, /danger-model);
    // the 5 overview URLs are ALL already in the set (zero new distinct keys)
    const distinct = new Set(hotSet().map((u) => u.path)).size;
    expect(distinct).toBeLessThanOrEqual(15);
  });
});

describe("probe-load-budget — sampleHotSet", () => {
  it("throws on a non-2xx hot-set row (probe-outcomes crash → ntfy + exit 1), never samples it as data", async () => {
    const srv = createServer((req, res) => {
      res.writeHead(req.url === "/api/indicators" ? 500 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      await expect(sampleHotSet({ base, pace: 0 })).rejects.toThrow("/api/indicators 500");
    } finally {
      srv.close();
    }
  });
});

describe("probe-load-budget — fetchWire (E2)", () => {
  it("counts the brotli wire bytes, not the decoded body", async () => {
    const json = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: `ID${i}`, v: i })) });
    const wire = brotliCompressSync(json);
    const srv = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "br", "x-vercel-cache": "hit" });
      res.end(wire);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const res = await fetchWire(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/x`);
      expect(res.wireBytes).toBe(wire.byteLength);
      expect(res.wireBytes).toBeLessThan(Buffer.byteLength(json));
      expect(res.body.toString("utf8")).toBe(json);
    } finally {
      srv.close();
    }
  });
});
