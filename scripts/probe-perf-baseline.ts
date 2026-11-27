/**
 * Read-only PROD probe: per-call latency of the store reads that sit behind the read-API
 * handlers, so an endpoint's wall-clock can be attributed to DB round trips vs compute.
 *
 *     npm run probe:perf-baseline        # reads .env.prod, WRITES NOTHING
 *
 * ⚠ **PROD, not dev** (`research-probes.md` §The instrument is a claim too): the dev DB has no cron, so its tables are stale
 * by construction and a latency measured there is an artifact of the last backfill's row count.
 *
 * WHAT IT MEASURES — each store read `api/lab.ts` / `api/status.ts` issue, timed N times, reported
 * as min/median/max plus the row count returned. The RTT floor (a trivial one-row read) is measured
 * first and printed alongside, so a call that costs ~1×RTT is a round-trip cost and a call that
 * costs many is doing real server-side work (or paging).
 *
 * WHAT IT DOES NOT MEASURE: this runs from the developer's network, NOT from the Vercel region.
 * The absolute milliseconds are therefore an upper bound on the lambda's DB cost; the RATIO to the
 * RTT floor, and the RELATIVE ordering of the calls, are the transferable numbers.
 *
 * GUARDS (each can exit non-zero):
 *   G1 EMPTY DB — no last alert ⇒ THROW. Every timing below would then measure an empty-table
 *      fast path and read as "the DB is fast" when it is only empty.
 *      CAN-FIRE DEMO: point SUPABASE_URL at a fresh project; G1 fires before any timing prints.
 *   G2 RTT FLOOR UNMEASURABLE — a non-positive or absurd (>10s) floor ⇒ THROW, since every
 *      ratio below divides by it.
 *      CAN-FIRE DEMO: set SUPABASE_URL to an unroutable host; the floor read rejects and G2 fires.
 *   G3 HANDLER NOT LIVE — the whole-handler arm's GET answers non-200 ⇒ THROW (a 400/404 fast path
 *      would read as a fast handler).
 *      CAN-FIRE DEMO: change the arm's `hist=20` to `hist=21` (off-grid ⇒ 400); G3 fires on sample 1.
 */
import { getStore } from "../src/store.js";
import { liveResolveDeps, pullProdCreds } from "./backfill/resolve-store.js";
import { isoDay } from "../src/dates.js";

const N = Number(process.env.PERF_SAMPLES ?? 5);

function stats(ms: number[]): { min: number; med: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  return { min: s[0]!, med: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! };
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number[]; size: number }> {
  const ms: number[] = [];
  let size = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const out = await fn();
    ms.push(performance.now() - t0);
    size = Array.isArray(out) ? out.length : out instanceof Map ? out.size : out == null ? 0 : 1;
  }
  return { label, ms, size };
}

async function main(): Promise<void> {
  // Creds pulled LIVE via the Management API — never from .env.prod, whose SUPABASE_ANON_KEY is
  // rotted (`Invalid API key`). `store` is exactly the handlers' handle: `getStore("ro")`, the
  // service key behind a read-only store, so these numbers are the handlers' numbers.
  const { url, key, anonKey } = await pullProdCreds(liveResolveDeps, "ro");
  const env = { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, SUPABASE_ANON_KEY: anonKey };
  const store = getStore("ro", env);

  const verdict = await store.getLastAlert();
  if (!verdict) throw new Error("[G1] prod DB has no alert_log rows — every timing below would measure an empty-table fast path");
  const firedDate = verdict.date;

  const floor = await time("RTT floor (getLastAlert, 1 row)", () => store.getLastAlert());
  const floorMed = stats(floor.ms).med;
  if (!(floorMed > 0) || floorMed > 10_000) throw new Error(`[G2] RTT floor unmeasurable (${floorMed.toFixed(0)}ms) — the ratios below divide by it`);

  const rows: Array<{ label: string; ms: number[]; size: number }> = [floor];
  rows.push(await time("getReadingsForRun (full run fan-out)", () => store.getReadingsForRun(verdict.firedAt)));
  rows.push(await time("getRecentAlerts(30)", () => store.getRecentAlerts(30)));
  // A/B ARM for the alert read: same table, same 30-date window, but three narrow columns
  // instead of every alert_log column (which includes the jsonb tier/state payloads). A large
  // gap attributes getRecentAlerts's cost to PAYLOAD WIDTH, not to round trips or the sort.
  rows.push(await time("  A/B: getAlertsSince(-30d) narrow cols", () => store.getAlertsSince(isoDaysAgo(30))));
  // The SHIPPED narrow sibling (P2): same window, same fired-date collapse, two output columns.
  rows.push(await time("  getCashPriors(30) [shipped narrow]", () => store.getCashPriors(30)));
  rows.push(await time("getAlertsSince(-180d)", () => store.getAlertsSince(isoDaysAgo(180))));
  rows.push(await time("getCalibration", () => store.getCalibration()));
  rows.push(await time("getOverrides(-180d)", () => store.getOverrides(isoDaysAgo(180))));
  rows.push(await time("getLastBandBefore(dialBand)", () => store.getLastBandBefore("dialBand", firedDate)));
  rows.push(await time("getSeries(F1, 400)", () => store.getSeries("F1", 400)));
  rows.push(await time("getSeriesBulk(9 ids, 400)", () => store.getSeriesBulk(NINE, { limit: 400 })));
  // A/B ARM for the bulk read. getSeriesBulk's non-limit-1 path orders `readings_latest` by
  // obs_date DESC across 9 ids — an ORDER BY the view's DISTINCT ON (indicator_id, obs_date,
  // run_at) cannot serve, so it materializes those ids' whole history before the LIMIT bites.
  // The per-id read filters to ONE indicator_id and IS served by readings_obs_idx. If the bulk
  // path were index-served this arm would be SLOWER (9 round trips vs 1), so a faster arm here
  // falsifies "bulk is the cheap shape" rather than merely restating it.
  rows.push(await time("  A/B: 9x getSeries in parallel", () => Promise.all(NINE.map((id) => store.getSeries(id, 400)))));
  // WHOLE-HANDLER ARM: the live `/api/lab?hist=20` GET end to end (reads + compute). `hist` is grid-locked
  // and unknown params 400, so a curl edge MISS can't be forced — this is the only cold-handler number.
  // `handle` is GET's body; it gets the same "ro" store GET would build from `env`.
  // ⚠ Sample 1 is colder than the rest: `computeLegAttribution` memoizes its synth read per `firedAt`.
  const { handle } = await import("../api/lab.js");
  rows.push(
    await time("handle(): GET /api/lab?hist=20 (live)", async () => {
      const res = await handle(() => getStore("ro", env), new Request("https://x/api/lab?hist=20"));
      if (res.status !== 200) throw new Error(`[G3] /api/lab answered ${res.status}, not 200 — not timing the live path`);
      return (await res.json());
    }),
  );

  console.log(`\nprod store latency — ${N} samples each, ms (rows returned)\n`);
  console.log("call".padEnd(40) + "min".padStart(8) + "med".padStart(8) + "max".padStart(8) + "rows".padStart(8) + "  xRTT");
  for (const r of rows) {
    const s = stats(r.ms);
    console.log(
      r.label.padEnd(40) +
        s.min.toFixed(0).padStart(8) +
        s.med.toFixed(0).padStart(8) +
        s.max.toFixed(0).padStart(8) +
        String(r.size).padStart(8) +
        "  " +
        (s.med / floorMed).toFixed(1) + "x",
    );
  }
  // The handler arm is excluded: it already contains the reads above, so summing it double-counts.
  const reads = rows.slice(1).filter((r) => !r.label.startsWith("handle()"));
  const serial = reads.reduce((a, r) => a + stats(r.ms).med, 0);
  console.log(`\nsum of medians (a fully SERIAL handler would pay this): ${serial.toFixed(0)}ms`);
  console.log(`slowest single call (a fully PARALLEL handler pays this): ${Math.max(...reads.map((r) => stats(r.ms).med)).toFixed(0)}ms`);
}

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return isoDay(d);
}

const NINE = ["F1", "F2", "F4", "F5", "F6", "F8", "F9", "F13", "BUND"];

await main();
