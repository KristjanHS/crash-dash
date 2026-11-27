/**
 * Load-budget probe (P8): bytes + `x-vercel-cache`
 * + ms per hot URL, projected to a month against the Hobby caps. Exit 0 always. Public `/overview` loads
 * scale with `--audience`; the gated pages (anonymous → `/overview`) with `--owners`.
 *
 *   npm run probe:load-budget -- [--audience=100] [--owners=1] [--loads=5] [--refocus=5] [--pace=8000] [--base=<url>]
 *   npm run probe:load-budget -- --print-urls   # `warmUrls()`, one per line — the post-ship warm list
 *
 * `--refocus` = tab refocuses per user per day. After P9 a refocus is ONE `/api/status` request (the
 * vintage gate in public/refetch-gate.js stops there on an unchanged firedAt) — `REFOCUS_REQUESTS`.
 *
 * The index issues no per-card `/api/series`; the whole hot set stays under Vercel's ~15-req/2-min IP
 * challenge (reference.md §[prod]), walked at `--pace` ms.
 * Static assets (`staticLoads`: HTML + stylesheets + the ONE `bundlePage` bundle `make ship` deploys, bytes =
 * brotli size) are edge requests too, `--asset-revalidate` of loads (default 1: loads >10 min apart revalidate
 * every `max-age=600` asset).
 * CPU (E4) = Σ edge keys × (30 d / s-maxage) × (mean MISS wall − p50 HIT wall): misses scale with key expiries,
 * not users. A pass with no HIT row (post-purge) re-fetches one MISS path warm for the HIT baseline; n/a if that
 * is not a HIT either. Still a wall-ms bound (I/O wait included). Never `?cb=` (400 → no work).
 */

export const HOBBY_CAPS = {
  edgeRequestsPerMonth: 1_000_000,
  functionInvocationsPerMonth: 1_000_000,
  transferBytesPerMonth: 100 * 1024 ** 3,
  activeCpuSecondsPerMonth: 4 * 3600,
} as const;

import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const SLOW_POINTS = 30; // public/app.js SLOW_POINTS (renderZoneSlow) — pinned equal by the test
import { CACHE_STATIC, CACHE_VINTAGE } from "../src/api/http.js";
import { bundlePage } from "./bundle-public.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
import type { ProdConfigEnv } from "./lib/prod-config.js";
// @ts-expect-error — untyped public/*.js import (no allowJs); the ONE /api/lab?hist= key both pages fetch
import { LAB_LOOKBACK } from "../public/lab-lookback.js";

export type HotUrl = { page: "index" | "lab" | "exposure" | "overview"; path: string };

/** The hot set as the front-ends load it (app.js fetchAll + renderZoneSlow; lab.js). */
export function hotSet(): HotUrl[] {
  const index: HotUrl[] = [
    { page: "index", path: "/api/status" },
    { page: "index", path: "/api/indicators" },
    { page: "index", path: "/api/history?limit=2" },
    { page: "index", path: "/api/config" },
    { page: "index", path: "/api/families" },
    { page: "index", path: "/api/danger-model" },
    { page: "index", path: `/api/series?id=price-accel&limit=${SLOW_POINTS}` },
    { page: "index", path: `/api/series?id=complacency-vix&limit=${SLOW_POINTS}` },
    { page: "index", path: `/api/series?id=complacency-high&limit=${SLOW_POINTS}` },
  ];
  const lab: HotUrl[] = [
    { page: "lab", path: `/api/lab?hist=${LAB_LOOKBACK}` },
    { page: "lab", path: "/api/danger-model" },
    { page: "lab", path: "/api/families" },
    { page: "lab", path: "/api/replay" },
  ];
  const exposure: HotUrl[] = [{ page: "exposure", path: "/api/exposure" }];
  // P11/P12: the public `/overview` load (public/overview.js) — 5 requests, every one an edge key the
  // gated pages already mint (a signed-in read sends the same anonymous URL); the ≤8 `/api/series?…&detail=1` per leg pick are NOT on first paint.
  const overview: HotUrl[] = [
    { page: "overview", path: "/api/status" },
    { page: "overview", path: `/api/lab?hist=${LAB_LOOKBACK}` },
    { page: "overview", path: "/api/families" },
    { page: "overview", path: "/api/indicators" },
    { page: "overview", path: "/api/danger-model" },
  ];
  return [...index, ...lab, ...exposure, ...overview];
}

/** The PUBLIC page's (`/overview`) deduped hot set, first-seen order — scripts/deploy-prod-local.sh warms
 *  exactly this. The signed-in pages (index/lab/exposure) are not warmed. */
export function warmUrls(): string[] {
  return [...new Set(hotSet().filter((u) => u.page === "overview").map((u) => u.path))];
}

export type Sample = {
  page: HotUrl["page"];
  path: string;
  status: number;
  cache: string;
  bytes: number;
  ms: number;
  serverTiming: string;
};

export type Args = { base: string; audience: number; owners: number; loads: number; refocus: number; assetRevalidate: number; pace: number };
export type Knobs = Pick<Args, "audience" | "owners" | "loads" | "refocus" | "assetRevalidate">;

/** Edge requests per tab refocus after P9: `/api/status` alone (public/refetch-gate.js `refetchPlan` → "stop"). */
export const REFOCUS_REQUESTS = 1;

/** `--base=` wins; else the prod alias (`prodBaseUrl(env)` — refuses when none is configured). */
export function parseArgs(argv: readonly string[], env: ProdConfigEnv = process.env): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const num = (k: string, d: number) => {
    const v = get(k);
    const n = v == null ? d : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number, got ${v}`);
    return n;
  };
  return {
    base: (get("base") ?? prodBaseUrl(env)).replace(/\/$/, ""),
    audience: num("audience", 100),
    owners: num("owners", 1),
    loads: num("loads", 5),
    refocus: num("refocus", 5),
    assetRevalidate: Math.min(1, num("asset-revalidate", 1)),
    pace: num("pace", 8000),
  };
}

export const PAGE_HTML: Record<HotUrl["page"], string> = { index: "index.html", lab: "lab.html", exposure: "exposure.html", overview: "overview.html" };

/** First-paint static files of `entry` (public/-relative): the HTML, its stylesheets + module scripts, and every
 *  STATIC relative import below them — a dynamic `import()` is lazy, not first paint. */
export function staticGraph(entry: string, read: (rel: string) => string): string[] {
  const seen = new Set<string>();
  const visit = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const specs = rel.endsWith(".html")
      ? [...src.matchAll(/<(?:script|link)\b[^>]*>/g)]
          .map((m) => m[0])
          .filter((t) => /type="module"/.test(t) || /rel="stylesheet"/.test(t))
          .map((t) => /(?:src|href)="([^"]+)"/.exec(t)?.[1])
      : [...src.matchAll(/(?:\bfrom|^\s*import)\s*["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of specs) if (spec && /^\.{1,2}\//.test(spec)) visit(posix.normalize(posix.join(posix.dirname(rel), spec)));
  };
  visit(entry);
  return [...seen];
}

export type StaticLoad = { requests: number; bytes: number };
const PUBLIC_DIR = new URL("../public/", import.meta.url);

/** The DEPLOYED static load per page (E1 remedy A): the `bundlePage`-rewritten HTML + its stylesheets + ONE
 *  bundle — `make ship` replaces the module graph with it. Bytes default to the brotli size, the encoding the edge serves (E2). */
export function staticLoads({
  sizeOf = (text: string) => brotliCompressSync(text).byteLength,
  bundle = bundlePage, // a test seam: real esbuild is pinned in bundle-public.test.ts
}: { sizeOf?: (text: string) => number; bundle?: typeof bundlePage } = {}): Record<HotUrl["page"], StaticLoad> {
  const read = (rel: string) => {
    const url = new URL(rel, PUBLIC_DIR);
    if (!existsSync(url)) throw new Error(`staticGraph: public/${rel} is imported but missing`);
    return readFileSync(url, "utf8");
  };
  const out = {} as Record<HotUrl["page"], StaticLoad>;
  for (const [page, htmlRel] of Object.entries(PAGE_HTML) as [HotUrl["page"], string][]) {
    const { html, bundleRel, code } = bundle(fileURLToPath(PUBLIC_DIR), htmlRel);
    const styles = staticGraph(htmlRel, read).filter((f) => f.endsWith(".css"));
    out[page] = {
      requests: 1 + styles.length + (bundleRel ? 1 : 0),
      bytes: sizeOf(html) + styles.reduce((a, f) => a + sizeOf(read(f)), 0) + (bundleRel ? sizeOf(code) : 0),
    };
  }
  return out;
}

/** Per-page request count + bytes for ONE page load;
 *  `statics` = that page's static files (edge requests, not function calls). */
export type PageLoad = { page: HotUrl["page"]; requests: number; bytes: number; statics: StaticLoad };

const NO_STATICS: StaticLoad = { requests: 0, bytes: 0 };

export function perPageLoad(samples: readonly Sample[], statics?: Record<HotUrl["page"], StaticLoad>): PageLoad[] {
  const pages: HotUrl["page"][] = ["index", "lab", "exposure", "overview"];
  return pages.map((page) => {
    const rows = samples.filter((s) => s.page === page);
    const bytes = rows.reduce((a, s) => a + s.bytes, 0);
    return { page, requests: rows.length, bytes, statics: statics?.[page] ?? NO_STATICS };
  });
}

export type Projection = {
  edgeRequests: number;
  transferBytes: number;
  /** ALL-MISS bound: every request runs the function. ALL-HIT is 0 by construction. */
  missInvocations: number;
  /** Key-expiry bound (`cpuBound`); NaN when no MISS row, or no HIT baseline, was observed. */
  cpuSeconds: number;
};

/** Month = 30 days. Loads/day per page as a fraction of `loads`; `/overview` × audience, the gated pages × owners. */
export const PAGE_WEIGHT: Record<HotUrl["page"], number> = { index: 1, lab: 0.5, exposure: 0.25, overview: 1 };

/** Bytes of ONE refocus: the `/api/status` sample (0 when the probe carried none). */
export function refocusBytes(samples: readonly Sample[]): number {
  return samples.find((s) => s.path === "/api/status")?.bytes ?? 0;
}

export const viewers = (page: HotUrl["page"], k: Knobs) => (page === "overview" ? k.audience : k.owners);

/** Edge TTL per route, read off the handler's `Cache-Control` constant (Vercel strips `s-maxage` client-side). */
export function edgeTtlSeconds(path: string): number {
  const cc = path.startsWith("/api/config") ? CACHE_STATIC : CACHE_VINTAGE;
  const m = /s-maxage=(\d+)/.exec(cc);
  if (!m) throw new Error(`no s-maxage in '${cc}'`);
  return Number(m[1]);
}

/** E4: each distinct edge key misses once per TTL; a miss costs mean MISS wall − p50 HIT wall (no server-timing).
 *  `warmHitMs` = the HIT baseline when `samples` carry no HIT row (`sampleHotSet`'s warm re-fetch); NaN without
 *  either — a 0 ms baseline would bill the runner→edge network as CPU (false ALERT). */
export function cpuBound(samples: readonly Sample[], warmHitMs?: number): number {
  const miss = samples.filter((s) => isMiss(s.cache)).map((s) => s.ms);
  if (miss.length === 0) return Number.NaN;
  const hits = samples.filter((s) => s.cache === "HIT").map((s) => s.ms).sort((a, b) => a - b);
  const hitP50 = hits.length ? hits[Math.floor(hits.length / 2)]! : warmHitMs;
  if (hitP50 === undefined) return Number.NaN;
  const missMs = Math.max(0, miss.reduce((a, m) => a + m, 0) / miss.length - hitP50);
  const refreshes = (path: string) => (30 * 86400) / edgeTtlSeconds(path);
  const keys = new Set(samples.map((s) => s.path));
  const expiries = [...keys].reduce((a, p) => a + refreshes(p), 0);
  return (expiries * missMs) / 1000;
}

export function project(pages: readonly PageLoad[], samples: readonly Sample[], k: Knobs, warmHitMs?: number): Projection {
  const loadsPerMonth = (page: HotUrl["page"]) => viewers(page, k) * k.loads * PAGE_WEIGHT[page] * 30;
  let edgeRequests = 0;
  let transferBytes = 0;
  for (const p of pages) {
    edgeRequests += (p.requests + k.assetRevalidate * p.statics.requests) * loadsPerMonth(p.page);
    transferBytes += (p.bytes + k.assetRevalidate * p.statics.bytes) * loadsPerMonth(p.page);
  }
  // Refocus term (P9): `refocus`/user/day × REFOCUS_REQUESTS — it multiplied the whole index set before P9.
  const refocusPerMonth = (k.audience + k.owners) * k.refocus * 30;
  edgeRequests += REFOCUS_REQUESTS * refocusPerMonth;
  transferBytes += refocusBytes(samples) * refocusPerMonth;
  const apiRequests = pages.reduce((a, p) => a + p.requests * loadsPerMonth(p.page), 0) + REFOCUS_REQUESTS * refocusPerMonth;
  return { edgeRequests, transferBytes, missInvocations: apiRequests, cpuSeconds: cpuBound(samples, warmHitMs) };
}

export function isMiss(cache: string): boolean {
  const c = cache.toUpperCase();
  return c === "MISS" || c === "REVALIDATED" || c === "PRERENDER";
}

export function fmtBytes(b: number): string {
  if (!Number.isFinite(b)) return "n/a";
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

const pct = (v: number, cap: number) => (Number.isFinite(v) ? `${((100 * v) / cap).toFixed(0)}%` : "n/a");

/** The §4-shaped table. Pure — the test pins its shape. */
export function renderBudget(pages: readonly PageLoad[], proj: Projection, k: Knobs): string[] {
  const lines = [
    `== per page load`,
    ...pages.map((p) => `  ${p.page.padEnd(9)} ${String(p.requests).padStart(3)} req  ${fmtBytes(p.bytes)}  + ${p.statics.requests} static ${fmtBytes(p.statics.bytes)}`),
    `  ${"refocus".padEnd(9)} ${String(REFOCUS_REQUESTS).padStart(3)} req  (P9: /api/status only)`,
    `== month @ ${k.audience} audience (overview 1.0) + ${k.owners} owners (index 1.0 · lab 0.5 · exposure 0.25) × ${k.loads} loads/day + ${k.refocus} refocus/day · statics ×${k.assetRevalidate}`,
    `  ${"metric".padEnd(34)} ${"cap".padStart(10)} ${"projected".padStart(12)} ${"% cap".padStart(6)}`,
    `  ${"edge requests".padEnd(34)} ${"1 M".padStart(10)} ${fmtNum(proj.edgeRequests).padStart(12)} ${pct(proj.edgeRequests, HOBBY_CAPS.edgeRequestsPerMonth).padStart(6)}`,
    `  ${"fast data transfer".padEnd(34)} ${"100 GB".padStart(10)} ${fmtBytes(proj.transferBytes).padStart(12)} ${pct(proj.transferBytes, HOBBY_CAPS.transferBytesPerMonth).padStart(6)}`,
    `  ${"function invocations (ALL-HIT)".padEnd(34)} ${"1 M".padStart(10)} ${"0".padStart(12)} ${"0%".padStart(6)}`,
    `  ${"function invocations (ALL-MISS)".padEnd(34)} ${"1 M".padStart(10)} ${fmtNum(proj.missInvocations).padStart(12)} ${pct(proj.missInvocations, HOBBY_CAPS.functionInvocationsPerMonth).padStart(6)}`,
    `  ${"active CPU (key expiries, wall)".padEnd(34)} ${"4 h".padStart(10)} ${fmtCpu(proj.cpuSeconds).padStart(12)} ${pct(proj.cpuSeconds, HOBBY_CAPS.activeCpuSecondsPerMonth).padStart(6)}`,
    `  ${"supabase egress".padEnd(34)} ${"5 GB".padStart(10)} ${"misses only".padStart(12)} ${"n/a".padStart(6)}`,
  ];
  if (!Number.isFinite(proj.cpuSeconds)) {
    lines.push(
      "  M4: no MISS row, or no HIT baseline, observed. To measure the miss cost run",
      "      `npx vercel cache purge --type cdn -y` then re-run this probe once (ONE pass, paced).",
    );
  }
  return lines;
}

const fmtNum = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a");
const fmtCpu = (s: number) => (Number.isFinite(s) ? `${(s / 3600).toFixed(2)} h` : "n/a");

// ─── IO shell ────────────────────────────────────────────────────────────────────────────

export type WireResponse = { status: number; headers: IncomingHttpHeaders; wireBytes: number; body: Buffer };

/** E2: Vercel bills WIRE bytes — read the raw stream (no auto-decode; the edge sends no content-length on
 *  chunked br), then decode for the JSON readers. */
export function fetchWire(url: string): Promise<WireResponse> {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    req(url, { headers: { "User-Agent": "crash-dash-probe-load-budget", "Accept-Encoding": "br, gzip, deflate" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
        try {
          const body = enc === "br" ? brotliDecompressSync(raw) : enc === "gzip" ? gunzipSync(raw) : enc === "deflate" ? inflateSync(raw) : raw;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, wireBytes: raw.byteLength, body });
        } catch (e) {
          reject(e);
        }
      });
    })
      .on("error", reject)
      .end();
  });
}

const header = (h: IncomingHttpHeaders, k: string) => [h[k]].flat()[0] ?? "";

function toSample(u: Pick<HotUrl, "page" | "path">, res: WireResponse, ms: number): Sample {
  return {
    page: u.page,
    path: u.path,
    status: res.status,
    cache: (header(res.headers, "x-vercel-cache") || "ABSENT").toUpperCase(),
    bytes: res.wireBytes,
    ms,
    serverTiming: header(res.headers, "server-timing"),
  };
}

async function fetchOne(base: string, u: HotUrl): Promise<Sample> {
  const t0 = performance.now();
  const res = await fetchWire(base + u.path);
  if (u.path === "/api/status") warnNullDeployId(res.body);
  return toSample(u, res, Math.round(performance.now() - t0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** P9.2 paints from localStorage only when `/api/status.deployId` is set — null on prod means `VERCEL_DEPLOYMENT_ID` is unset at runtime and the slice is silently inert. */
function warnNullDeployId(body: Buffer): void {
  try {
    const j = JSON.parse(body.toString("utf8")) as { deployId?: unknown };
    if (typeof j.deployId !== "string" || j.deployId === "") console.log("  ⚠ /api/status.deployId is null — P9.2 never paints from storage (VERCEL_DEPLOYMENT_ID unset at runtime?)");
  } catch {
    /* not JSON — the row above already shows the status */
  }
}

/** The paced hot-set walk — shared with `probe-outcomes.ts`, which projects the same samples. */
export async function sampleHotSet(
  args: Pick<Args, "base" | "pace">,
): Promise<{ pages: PageLoad[]; samples: Sample[]; warmHitMs?: number }> {
  const urls = hotSet();
  const dedup = new Map<string, HotUrl[]>();
  for (const u of urls) dedup.set(u.path, [...(dedup.get(u.path) ?? []), u]);
  console.log(`probe-load-budget  base=${args.base}  urls=${dedup.size} (${urls.length} page-slots)  pace=${args.pace}ms`);
  const samples: Sample[] = [];
  let i = 0;
  for (const [path, slots] of dedup) {
    if (i++ > 0 && args.pace > 0) await sleep(args.pace);
    const s = await fetchOne(args.base, slots[0]!);
    console.log(
      `  ${slots.map((x) => x.page).join("+").padEnd(13)} ${path.padEnd(52)} ${s.status} ${s.cache.padEnd(11)} ${fmtBytes(s.bytes).padStart(9)} ${String(s.ms).padStart(5)}ms ${s.serverTiming}`,
    );
    // Non-2xx = a broken hot path: throw so probe-outcomes' weekly run crashes → ntfy + exit 1.
    if (s.status < 200 || s.status >= 300) throw new Error(`${path} ${s.status} — hot-set sample is not 2xx`);
    for (const slot of slots) samples.push({ ...s, page: slot.page });
  }
  const warmHitMs = await warmHitBaseline(args, samples);
  return { pages: perPageLoad(samples, staticLoads()), samples, warmHitMs };
}

/** 5b: a pass with MISS rows but no HIT row (post-purge, M4) re-fetches ONE missed path — now edge-warm — for
 *  `cpuBound`'s network baseline. undefined when not needed, or when the re-fetch is not a HIT either. */
async function warmHitBaseline(args: Pick<Args, "base" | "pace">, samples: readonly Sample[]): Promise<number | undefined> {
  if (samples.some((s) => s.cache === "HIT")) return undefined;
  const missed = samples.find((s) => isMiss(s.cache));
  if (!missed) return undefined;
  if (args.pace > 0) await sleep(args.pace);
  const s = await fetchOne(args.base, { page: missed.page, path: missed.path });
  console.log(`  warm re-fetch ${missed.path.padEnd(52)} ${s.status} ${s.cache.padEnd(11)} ${String(s.ms).padStart(5)}ms  (5b HIT baseline)`);
  return s.cache === "HIT" ? s.ms : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--print-urls")) {
    for (const path of warmUrls()) console.log(path);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const { pages, samples, warmHitMs } = await sampleHotSet(args);
  const proj = project(pages, samples, args, warmHitMs);
  for (const line of renderBudget(pages, proj, args)) console.log(line);
}

if (process.argv[1] && /probe-load-budget\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
