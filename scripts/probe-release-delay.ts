/**
 * WHY. F1 (HY OAS) is T+1 at FRED — obs `D` lands during `D+1` — so it reads slot age 2 every
 * morning against `daily: 1` and was served "behind" while perfectly healthy
 * The fix scores `age - delay(id) > cut`,
 * and `delay(id)` is DERIVED here — except `RELEASE_DELAY_HAND_FLOOR` (src/release-delay.ts), re-applied to an id
 * this run could not measure, so a regen never silently reverts a hand value to 0.
 *
 * WHAT IT MEASURES. `readings` is append-only, so `min(run_at)` per `(indicator_id, obs_date)` is the
 * first time prod stored that observation. Per daily/weekly id, over the last `--window` days of
 * observation dates: `slotAge(obs_date, todayOnFeedCalendar(tz, minRunAt), containmentGrid(id))`,
 * the SAME grid + today-resolution the read path scores with.
 *
 * ESTIMATOR — the MODE over LIVE-RUN samples, not a median. The first prod run (2026-09-10) showed
 * every id as a tight mode at the true delay PLUS a linear one-each ramp (F1: `1:22` then
 * `9,10,...,49` once each): a bulk backfill stamps a whole window on ONE `run_at`, so those rows'
 * "first persist" is the backfill date and their delay grows with age. A median over that read F1
 * as 18. A live run stores exactly ONE new observation per id, so a `run_at` shared by ≥2 obs dates
 * of the same id is a bulk write and its samples are dropped; the mode over the survivors (ties →
 * the smaller) is the delay. Fewer than `MIN_LIVE_SAMPLES` survivors ⇒ `unmeasured` (scored 0).
 *
 * SAME-WRITER POOL. The served `LEGP_*` ids are ALL written by one call, `seedLegClosesOnCron`
 * (one fetch, one `asOf` clip, one run_at), so they share one release delay by mechanism. A leg
 * short of `MIN_LIVE_SAMPLES` of its own (a newly added off-ladder leg — LEGP_COMMOD/LEGP_RAFI
 * arrived backfill-only and read false-behind every morning at delay 0) takes the mode over the
 * pooled live samples of its writer group instead. Own samples, when sufficient, always win.
 *
 * INPUT DONORS. A derived id listed in `RELEASE_DELAY_INPUT_DONORS` (src/release-delay.ts) is floored
 * at the max of the delays of the ids whose fetches carry its inputs — it cannot print before them —
 * and, short of its own samples, takes that max outright. Donors must resolve in the main pass.
 *
 * WHAT IT WRITES. `scripts/release-delay.snapshot.json` (`--dry` prints only) — the committed table
 * `src/release-delay.ts` indexes at module load. Commit the JSON in the same commit as any scorer
 * change; `src/release-delay.test.ts` pins its id set to the live registry.
 *
 *   npm run probe:release-delay            # writes the snapshot
 *   npm run probe:release-delay -- --dry   # prints the table, writes nothing
 *   npm run probe:release-delay -- --ids=F1,R2 --window=90
 *
 * ⚠ Reads the PROD store (read-only; the only write is the local JSON).
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CADENCE_OF, compositeComponentLegIds, compositeLegParentIndex, FEED_TZ_OF, LAG_CHUNK_IDS } from "../src/feed-lag.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { POSTGREST_MAX_ROWS } from "../src/postgrest-limits.js";
import { containmentGrid, LAG_SCAN_LIMIT, slotAge, type FeedObservations } from "../src/publication-calendar.js";
import { isSlotExcused } from "../src/market-closures.js";
import { RELEASE_DELAY_HAND_FLOOR } from "../src/release-delay.js";
import { LADDER } from "../src/families.js";
import { legCloseId, OFF_LADDER_LEG_KEYS, offLadderLegCloseId } from "../src/scoreboard.js";
import { RELEASE_DELAY_INPUT_DONORS } from "../src/release-delay.js";
import { getStore } from "../src/store.js";
import { paginateRows } from "../src/store-guards.js";
import { argOf, hasFlag } from "./lib/cli.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const WINDOW_DAYS = Number(argOf("window") ?? 90);
const ONLY = argOf("ids")?.split(",");
const DRY = hasFlag("dry");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "release-delay.snapshot.json");

const now = new Date();
const from = isoDay(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));

// --- the grids: identical shape to freshnessFrom's stage 1 / probe-slot-grid-tail ---------------
const store = getStore("ro", env);
const slotIds = [...CADENCE_OF.keys()].filter((id) => {
  const c = CADENCE_OF.get(id) ?? "daily";
  return c === "daily" || c === "weekly";
});
const chunks: string[][] = [];
for (let i = 0; i < slotIds.length; i += LAG_CHUNK_IDS) chunks.push(slotIds.slice(i, i + LAG_CHUNK_IDS));
const parts = await Promise.all(chunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT })));
const seriesById = new Map<string, readonly { date: string }[]>();
for (const m of parts) for (const [id, pts] of m) seriesById.set(id, pts);
const legIds = compositeComponentLegIds();
const legParent = compositeLegParentIndex();
const allDailyFeeds: FeedObservations[] = slotIds
  .filter((id) => (CADENCE_OF.get(id) ?? "daily") === "daily")
  .map((id) => ({ id, dates: (seriesById.get(id) ?? []).map((p) => p.date), independent: !legIds.has(id) }));

// --- first-persist time per (id, obs_date): ordered scan, first row per key wins -----------------
const client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
interface Row { indicator_id: string; obs_date: string; run_at: string }
const rows = await paginateRows<Row>(
  async (offset, count) => {
    const { data, error } = await client
      .from("readings")
      .select("indicator_id,obs_date,run_at")
      .gte("obs_date", from)
      .in("indicator_id", slotIds)
      .eq("estimated", false) // E3: an estimate lands before its print — a release is a PRINT's first run_at
      .order("indicator_id").order("obs_date").order("run_at")
      .range(offset, offset + count - 1);
    if (error) throw new Error(`readings scan failed: ${error.message}`);
    return data;
  },
  Number.MAX_SAFE_INTEGER,
  POSTGREST_MAX_ROWS,
);
const firstRunAt = new Map<string, Map<string, string>>(); // id → obs_date → min run_at
for (const r of rows) {
  let m = firstRunAt.get(r.indicator_id);
  if (m == null) firstRunAt.set(r.indicator_id, (m = new Map()));
  if (!m.has(r.obs_date)) m.set(r.obs_date, r.run_at); // ordered by run_at asc ⇒ first is min
}

// --- the delay per id ---------------------------------------------------------------------------
/** Below this many live-run samples the mode is noise, not a measurement. */
const MIN_LIVE_SAMPLES = 5;
const mode = (xs: number[]): number => {
  const hist = new Map<number, number>();
  for (const x of xs) hist.set(x, (hist.get(x) ?? 0) + 1);
  return [...hist].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
};
const delays: Record<string, number> = {};
const unmeasured: string[] = [];
/** The ids `seedLegClosesOnCron` writes — one writer ⇒ one release delay (see SAME-WRITER POOL). */
const LEG_WRITER = new Set([...LADDER.map(legCloseId), ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId)]);
const liveSamples = new Map<string, number[]>(); // id → its own live-run samples
/** Max of `id`'s input donors' delays, or null when it has none / any is not yet measured (named in the log). */
const donorFloor = (id: string): number | null => {
  const donors = RELEASE_DELAY_INPUT_DONORS[id] ?? [];
  const missing = donors.filter((d) => !(d in delays));
  if (donors.length === 0) return null;
  if (missing.length > 0) {
    console.log(`${id.padEnd(16)} donor(s) ${missing.join(",")} unmeasured - no donor floor`);
    return null;
  }
  return Math.max(...donors.map((d) => delays[d]!));
};
const short: { id: string; line: string }[] = []; // ids below MIN_LIVE_SAMPLES, resolved after the pass
for (const id of ONLY ?? slotIds) {
  const own = (seriesById.get(id) ?? []).map((p) => p.date);
  const firsts = firstRunAt.get(id);
  // A composite leg with a fetched DAILY parent rides the PARENT's grid — exactly what freshnessFrom
  // scores it on — so its samples are counted on the same calendar the read path uses.
  const parentId = legParent.get(id);
  const gridId = parentId != null && CADENCE_OF.get(parentId) === "daily" ? parentId : id;
  const gridDates = gridId === id ? own : (seriesById.get(gridId) ?? []).map((p) => p.date);
  let grid;
  try {
    grid = containmentGrid({ id: gridId, dates: gridDates, independent: !legIds.has(gridId) }, allDailyFeeds);
  } catch (err) {
    console.log(`${id.padEnd(16)} UNGRIDDABLE: ${(err as Error).message}`);
    unmeasured.push(id);
    continue;
  }
  if (firsts == null || firsts.size === 0) {
    console.log(`${id.padEnd(16)} no rows in window`);
    unmeasured.push(id);
    continue;
  }
  const tz = FEED_TZ_OF.get(id);
  // A run_at shared by ≥2 obs dates of this id is a bulk write (backfill/repair), never a live run.
  const perRun = new Map<string, number>();
  for (const runAt of firsts.values()) perRun.set(runAt, (perRun.get(runAt) ?? 0) + 1);
  const samples: number[] = [];
  let bulk = 0;
  for (const [obs, runAt] of firsts) {
    if ((perRun.get(runAt) ?? 0) > 1) { bulk++; continue; }
    samples.push(slotAge(obs, todayOnFeedCalendar(tz, new Date(runAt)), grid, (d, post) => isSlotExcused(gridId, d, post)));
  }
  const hist = new Map<number, number>();
  for (const s of samples) hist.set(s, (hist.get(s) ?? 0) + 1);
  const dist = [...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ");
  liveSamples.set(id, samples);
  if (samples.length < MIN_LIVE_SAMPLES) {
    short.push({ id, line: `${samples.length} live samples (< ${MIN_LIVE_SAMPLES}), ${bulk} bulk-written  dist[${dist}]` });
    continue;
  }
  // A derived id's own mode is FLOORED at its input donors' — it cannot print before them, and a 0/1 own split ties low.
  const d = Math.max(mode(samples), donorFloor(id) ?? 0);
  delays[id] = d;
  console.log(`${id.padEnd(16)} delay=${d}  live=${samples.length} bulk=${bulk}  dist[${dist}]`);
}
for (const { id, line } of short) {
  const pooled = LEG_WRITER.has(id) ? [...LEG_WRITER].flatMap((w) => liveSamples.get(w) ?? []) : [];
  if (pooled.length >= MIN_LIVE_SAMPLES) {
    delays[id] = mode(pooled);
    console.log(`${id.padEnd(16)} delay=${delays[id]}  POOLED over the LEGP_* writer (${pooled.length} samples); own: ${line}`);
    continue;
  }
  const floor = donorFloor(id);
  if (floor != null) {
    delays[id] = floor;
    console.log(`${id.padEnd(16)} delay=${floor}  INPUT DONORS ${RELEASE_DELAY_INPUT_DONORS[id]!.join(",")}; own: ${line}`);
    continue;
  }
  console.log(`${id.padEnd(16)} UNMEASURED: ${line}`);
  unmeasured.push(id);
}
// A composite leg on a daily parent's grid carries the PARENT's delay (release-delay.test.ts pins it):
// the legs' own samples split near 50/50 (CMP_GB_SPY 0:24 1:25 vs GB 0:21, 2026-09-23), so a per-leg
// mode flips on noise while the parent's is clean.
for (const [leg, parent] of legParent) {
  if (!(leg in delays) && !unmeasured.includes(leg)) continue; // not in this run's roster
  if (CADENCE_OF.get(parent) !== "daily") continue;
  if (parent in delays) {
    delays[leg] = delays[parent]!;
    if (unmeasured.includes(leg)) unmeasured.splice(unmeasured.indexOf(leg), 1);
  } else if (leg in delays) {
    delete delays[leg];
    unmeasured.push(leg);
  }
}

// Hand floor LAST: an id this run could not measure keeps its hand value instead of reverting to 0 (release-delay.ts).
for (const [id, floor] of Object.entries(RELEASE_DELAY_HAND_FLOOR)) {
  if (!unmeasured.includes(id)) continue;
  unmeasured.splice(unmeasured.indexOf(id), 1);
  delays[id] = floor;
  console.log(`${id.padEnd(16)} delay=${floor}  HAND FLOOR (unmeasured this run; RELEASE_DELAY_HAND_FLOOR)`);
}

if (DRY || ONLY) {
  console.log(`\n(dry / partial run - snapshot not written)`);
} else {
  const snapshot = { capturedAt: now.toISOString(), windowDays: WINDOW_DAYS, delays, unmeasured };
  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\nwrote ${OUT}: ${Object.keys(delays).length} measured, ${unmeasured.length} unmeasured`);
}
