/**
 * Where does the cron's wall clock go? Runs the REAL scoring cycle with a
 * fetch wrapper that times every request, then prints the slowest hosts,
 * the slowest single calls, and the Supabase (PostgREST) share.
 *
 * READ-ONLY by construction: on the Supabase host, non-GET/HEAD requests are
 * short-circuited with a synthetic 200 unless they are read-only PostgREST RPCs
 * (/rest/v1/rpc/* other than the WRITE_RPCS below, which stay blocked); every
 * ntfy push is short-circuited too. So pointing it at .env.prod measures prod
 * latency without writing a row or firing a push.
 *
 *   npm run probe:cron-latency              # dev DB (.env.local)
 *   bash scripts/with-prod-config.sh tsx scripts/probe-cron-latency.ts   # prod DB, still write-blocked
 */
import { runScoringCycle } from "../src/run-cycle.js";
import { wallClock } from "../src/run-seeds.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

type Call = { host: string; path: string; q: string; method: string; ms: number; at: number; blocked: boolean };
const calls: Call[] = [];
const supaHost = new URL(env.SUPABASE_URL ?? "http://none.invalid").host;
const realFetch = globalThis.fetch;
const T_ORIGIN = performance.now();

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  // Read-RPCs are POSTs (PostgREST convention) and MUST pass through, or the store's
  // bulk paths silently fall back to their per-id loops and the probe measures its own
  // artifact. Only the genuine mutations are short-circuited.
  const WRITE_RPCS = ["/rest/v1/rpc/record_run", "/rest/v1/rpc/record_intraday_run", "/rest/v1/rpc/prune_shadowed_readings"];
  const isWrite =
    url.host === supaHost &&
    method !== "GET" &&
    method !== "HEAD" &&
    (WRITE_RPCS.includes(url.pathname) || !url.pathname.startsWith("/rest/v1/rpc/"));
  const blocked = isWrite || url.host === "ntfy.sh";
  const t0 = performance.now();
  if (blocked) {
    calls.push({ host: url.host, path: url.pathname, q: url.search.replace(/api_key=[^&]*/, "api_key=REDACTED").slice(0, 160), method, ms: 0, at: t0 - T_ORIGIN, blocked });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  try {
    return await realFetch(input, init);
  } finally {
    calls.push({ host: url.host, path: url.pathname, q: url.search.replace(/api_key=[^&]*/, "api_key=REDACTED").slice(0, 160), method, ms: performance.now() - t0, at: t0 - T_ORIGIN, blocked });
  }
});

const t0 = performance.now();
try {
  await runScoringCycle(wallClock, { env });
} catch (err) {
  console.error("[probe] cycle threw (expected if a blocked write was load-bearing):", err instanceof Error ? err.message : err);
}
const total = performance.now() - t0;

const byHost = new Map<string, { n: number; ms: number }>();
for (const c of calls) {
  const e = byHost.get(c.host) ?? { n: 0, ms: 0 };
  e.n += 1;
  e.ms += c.ms;
  byHost.set(c.host, e);
}
console.log(`\n=== cycle wall clock: ${(total / 1000).toFixed(2)}s over ${calls.length} fetches ===`);
console.log("\n-- by host (serial+parallel sum, so it can exceed wall clock) --");
for (const [host, e] of [...byHost].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`${(e.ms / 1000).toFixed(2).padStart(7)}s  n=${String(e.n).padStart(3)}  ${host}`);
}
console.log("\n-- 25 slowest single calls --");
for (const c of [...calls].sort((a, b) => b.ms - a.ms).slice(0, 25)) {
  console.log(`${(c.ms / 1000).toFixed(2).padStart(7)}s  ${c.method.padEnd(5)} ${c.host}${c.path}`);
}
const supa = calls.filter((c) => c.host === supaHost && !c.blocked);
console.log(`\n-- postgrest reads: n=${supa.length}, sum ${(supa.reduce((s, c) => s + c.ms, 0) / 1000).toFixed(2)}s --`);
console.log("\n-- full timeline (start@ +dur) --");
for (const c of [...calls].sort((a, b) => a.at - b.at)) {
  console.log(`${(c.at / 1000).toFixed(2).padStart(7)}s +${(c.ms / 1000).toFixed(2)}s ${c.method.padEnd(4)} ${c.host}${c.path}${c.q}`);
}
