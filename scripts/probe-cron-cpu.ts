/**
 * Cron runtime reduction: what runs in the cron's
 * two fetch-FREE windows? The latency probe proved they exist (~1.1s and ~0.9s with
 * no request in flight); this one names the frames inside them.
 *
 * Runs the REAL scoring cycle under the V8 sampling profiler with the SAME
 * write-blocking fetch wrapper `probe-cron-latency.ts` uses (non-GET/HEAD on the
 * Supabase host and every ntfy push short-circuited, read-only PostgREST RPCs
 * passed through), then:
 *   1. rebuilds the fetch timeline and derives the fetch-free gaps from it,
 *   2. slices the CPU profile to each gap and reports self-time by frame there,
 *   3. reports whole-cycle self-time by frame and by module.
 *
 * The gap slice is the point. A whole-cycle profile is dominated by await-idle
 * frames and says nothing about which main-thread work gates the run; the gaps are
 * where the wall clock is CPU and nothing else.
 *
 *   npm run probe:cron-cpu              # dev DB (.env.local)
 *   bash scripts/with-prod-config.sh tsx scripts/probe-cron-cpu.ts   # prod DB, still write-blocked
 *
 * Flags: --gap-ms=<n> minimum gap width to report (default 250)
 *        --top=<n>    frames per table (default 15)
 *        --save=<f>   also write the raw .cpuprofile (load it in Chrome DevTools)
 */
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { runScoringCycle } from "../src/run-cycle.js";
import { wallClock } from "../src/run-seeds.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
const GAP_MS = arg("gap-ms", 250);
const TOP = arg("top", 15);
const SAVE = process.argv.find((a) => a.startsWith("--save="))?.split("=")[1];

type Call = { host: string; path: string; ms: number; at: number; blocked: boolean };
const calls: Call[] = [];
const supaHost = new URL(env.SUPABASE_URL ?? "http://none.invalid").host;
const realFetch = globalThis.fetch;
const T_ORIGIN = performance.now();

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  // Kept byte-identical in intent to probe-cron-latency.ts: read-RPCs are POSTs and MUST
  // pass through, or the store's bulk paths fall back to per-id loops and the profile
  // measures the probe's own artifact instead of the cron's shape.
  const WRITE_RPCS = ["/rest/v1/rpc/record_run", "/rest/v1/rpc/record_intraday_run", "/rest/v1/rpc/prune_shadowed_readings"];
  const isWrite =
    url.host === supaHost &&
    method !== "GET" &&
    method !== "HEAD" &&
    (WRITE_RPCS.includes(url.pathname) || !url.pathname.startsWith("/rest/v1/rpc/"));
  const blocked = isWrite || url.host === "ntfy.sh";
  const t0 = performance.now();
  if (blocked) {
    calls.push({ host: url.host, path: url.pathname, ms: 0, at: t0 - T_ORIGIN, blocked });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  try {
    return await realFetch(input, init);
  } finally {
    calls.push({ host: url.host, path: url.pathname, ms: performance.now() - t0, at: t0 - T_ORIGIN, blocked });
  }
});

const session = new Session();
session.connect();
await session.post("Profiler.enable");
// 100µs: the gaps are ~1s, so this is ~10k samples across a window — enough to
// separate frames without the 1ms default's quantisation hiding short-but-hot ones.
await session.post("Profiler.setSamplingInterval", { interval: 100 });
await session.post("Profiler.start");
// Anchor the profile's clock to the fetch timeline's. The sample mapping below does NOT
// read `profile.startTime` — it uses this `performance.now()` capture, taken one statement
// after `Profiler.start` returns, which the two clocks' shared OS monotonic source makes
// coincide with `profile.startTime` to sub-millisecond over an 11s run.
const PROF_START_AT = performance.now() - T_ORIGIN;

const t0 = performance.now();
const CYCLE_START_AT = t0 - T_ORIGIN;
try {
  await runScoringCycle(wallClock, { env });
} catch (err) {
  console.error("[probe] cycle threw (expected if a blocked write was load-bearing):", err instanceof Error ? err.message : err);
}
const total = performance.now() - t0;
// Gap boundaries MUST live in the same T_ORIGIN coordinates as `Call.at` and the sample
// timeline. `total` is a duration, not a T_ORIGIN offset — using it as the closing bound
// would shift the first and last gap by the profiler-setup delta and drop tail samples.
const CYCLE_END_AT = performance.now() - T_ORIGIN;

const { profile } = await session.post("Profiler.stop");
await session.post("Profiler.disable");
session.disconnect();
if (SAVE) {
  writeFileSync(SAVE, JSON.stringify(profile));
  console.log(`[probe] raw profile written to ${SAVE}`);
}

// ---- profile -> (offset_ms, frame) samples, on the fetch timeline's clock -------
type Frame = { name: string; url: string; line: number };
const byId = new Map<number, Frame>();
for (const n of profile.nodes ?? []) {
  const f = n.callFrame;
  byId.set(n.id, {
    name: f.functionName || "(anonymous)",
    url: (f.url || "").replace(/^file:\/\//, "").replace(process.cwd() + "/", ""),
    line: (f.lineNumber ?? -1) + 1,
  });
}
const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
type Sample = { at: number; ms: number; id: number };
const sampled: Sample[] = [];
let cursorUs = 0;
for (let i = 0; i < samples.length; i++) {
  cursorUs += deltas[i] ?? 0;
  sampled.push({ at: PROF_START_AT + cursorUs / 1000, ms: (deltas[i] ?? 0) / 1000, id: samples[i]! });
}

const label = (f: Frame): string => {
  const where = f.url ? `${f.url}:${f.line}` : "(native)";
  return `${f.name}  ${where}`;
};
const tally = (rows: Sample[]): Array<[string, number]> => {
  const m = new Map<string, number>();
  for (const s of rows) {
    const f = byId.get(s.id);
    if (!f) continue;
    // (program)/(idle)/(garbage collector) are V8's own buckets — keep them, they are
    // the answer when the answer is "not our code".
    m.set(label(f), (m.get(label(f)) ?? 0) + s.ms);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
};
const printTable = (rows: Array<[string, number]>, denom: number, top: number): void => {
  for (const [name, ms] of rows.slice(0, top)) {
    const pct = denom > 0 ? ((ms / denom) * 100).toFixed(1) : "0.0";
    console.log(`${ms.toFixed(0).padStart(7)}ms ${pct.padStart(5)}%  ${name}`);
  }
};

// ---- fetch-free gaps, derived from the timeline ---------------------------------
const busy = calls
  .filter((c) => !c.blocked && c.ms > 0)
  .map((c) => [c.at, c.at + c.ms] as [number, number])
  .sort((a, b) => a[0] - b[0]);
const merged: Array<[number, number]> = [];
for (const iv of busy) {
  const last = merged[merged.length - 1];
  if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
  else merged.push([...iv]);
}
const gaps: Array<[number, number]> = [];
let cur = CYCLE_START_AT;
for (const [s, e] of merged) {
  if (s - cur >= GAP_MS) gaps.push([cur, s]);
  cur = Math.max(cur, e);
}
if (CYCLE_END_AT - cur >= GAP_MS) gaps.push([cur, CYCLE_END_AT]);

console.log(`\n=== cycle wall clock: ${(total / 1000).toFixed(2)}s over ${calls.length} fetches ===`);
console.log(`profile: ${sampled.length} samples @100us, ${gaps.length} fetch-free gaps >= ${GAP_MS}ms\n`);

const gapTotal = gaps.reduce((s, [a, b]) => s + (b - a), 0);
console.log(`-- fetch-free gaps: ${(gapTotal / 1000).toFixed(2)}s of ${(total / 1000).toFixed(2)}s wall (${((gapTotal / total) * 100).toFixed(0)}%) --`);
for (const [a, b] of gaps) console.log(`  ${(a / 1000).toFixed(2)}s -> ${(b / 1000).toFixed(2)}s  (${(b - a).toFixed(0)}ms)`);

for (const [a, b] of gaps) {
  const rows = sampled.filter((s) => s.at >= a && s.at < b);
  const width = b - a;
  console.log(`\n-- gap ${(a / 1000).toFixed(2)}s -> ${(b / 1000).toFixed(2)}s (${width.toFixed(0)}ms), self time by frame --`);
  if (rows.length === 0) {
    console.log("  (no samples landed in this window — profiler clock alignment is off, or the gap is off-thread)");
    continue;
  }
  printTable(tally(rows), width, TOP);
}

console.log(`\n-- whole cycle, self time by frame (top ${TOP}) --`);
printTable(tally(sampled), total, TOP);

console.log(`\n-- whole cycle, self time by module (top ${TOP}) --`);
const byMod = new Map<string, number>();
for (const s of sampled) {
  const f = byId.get(s.id);
  if (!f) continue;
  const mod = f.url || "(native)";
  byMod.set(mod, (byMod.get(mod) ?? 0) + s.ms);
}
printTable([...byMod].sort((a, b) => b[1] - a[1]), total, TOP);
