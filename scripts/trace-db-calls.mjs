// `npm run probe:db-trace` preload: counts fetches per host, adds DB_DELAY_MS to every Supabase-host call
// (simulates the iad1 -> eu-north-1 hop locally), prints each DB call with DB_TRACE=1. A serial chain shows as
// dbWallBusy ~ calls x delay; a concurrent fan-out as dbWallBusy ~ delay.
const t0 = Date.now();
const delay = Number(process.env.DB_DELAY_MS ?? 100);
const dbHost = new URL(process.env.SUPABASE_URL ?? "http://127.0.0.1:54321").host;
const stats = new Map(); // host -> {n, ms}
let dbInFlight = 0, dbMaxInFlight = 0, dbBusyMs = 0, dbBusySince = 0;
const orig = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const isDb = url.host === dbHost;
  const s = stats.get(url.host) ?? { n: 0, ms: 0 };
  stats.set(url.host, s);
  s.n++;
  if (isDb && process.env.DB_TRACE) {
    process.stderr.write(`[dbcall] +${((Date.now() - t0) / 1000).toFixed(2)}s ${init?.method ?? "GET"} ${decodeURIComponent(url.pathname + url.search).slice(0, 150)}\n`);
  }
  const start = Date.now();
  if (isDb) {
    if (dbInFlight++ === 0) dbBusySince = start;
    dbMaxInFlight = Math.max(dbMaxInFlight, dbInFlight);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  try {
    return await orig(input, init);
  } finally {
    s.ms += Date.now() - start;
    if (isDb && --dbInFlight === 0) dbBusyMs += Date.now() - dbBusySince;
  }
};
for (const k of ["log", "warn", "error"]) {
  const f = console[k].bind(console);
  console[k] = (...a) => f(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
}
process.on("exit", () => {
  const rows = [...stats].sort((a, b) => b[1].n - a[1].n).map(([h, s]) => `${h} n=${s.n} sum=${s.ms}ms`);
  process.stderr.write(`\n[latency] delay=${delay}ms total=${((Date.now() - t0) / 1000).toFixed(1)}s dbWallBusy=${(dbBusyMs / 1000).toFixed(1)}s dbMaxInFlight=${dbMaxInFlight}\n[latency] ${rows.join("\n[latency] ")}\n`);
});
