/**
 * Stage A falsifier: no `readings_latest` row dated
 * before today (UTC) may still be PROVISIONAL (`isProvisional`: stored by an intraday run) — an EOD
 * close must have rewritten every one. Read-only.
 *
 *   npm run probe:provisional-rows                                   # prod (read-only)
 *   npx tsx scripts/probe-provisional-rows.ts [--days=30]            # local dev stack
 *
 * Exit 1 on any provisional row older than the previous weekday (`stale`), OR on a row with no `runAt` (the
 * classifier would be blind). A previous-weekday provisional row is `lagging` — reported, exit 0 (U2, see `partitionLagging`).
 * Also exit 1 on an estimate re-stamped as the newest EOD run's own, or on a run row with no `heads` (`readRestamped`).
 * Roster: `provisionalRoster()` (run-seeds.ts) + the last EOD run's ids.
 */
import { provisionalRoster, scanProvisional, type ProvisionalScan } from "../src/run-seeds.js";
import { isoDay } from "../src/dates.js";
import { SESSION_CLOSE_UTC_MIN } from "../src/intraday.js";
import { ESTIMATE_ROW_IDS } from "../src/nowcast-score.js";
import type { StoredReading, Store } from "../src/store.js";

export const staticRoster = provisionalRoster;
export { scanProvisional };

/** The weekday before `today` (a Monday's is Friday) — the one session whose provisional row may still lag. */
export function previousWeekday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return isoDay(d);
}

/** The oldest date still `lagging` for `id`: the previous weekday, one weekday further back per extra day of the
 *  id's `SESSION_CLOSE_UTC_MIN` window past 24 h (the `=X` ids' 48 h ⇒ two weekdays back). */
export function lagFloor(today: string, id: string): string {
  let d = previousWeekday(today);
  for (let n = Math.ceil((SESSION_CLOSE_UTC_MIN[id] ?? 0) / 1440) - 1; n > 0; n--) d = previousWeekday(d);
  return d;
}

/** U2: a provisional row dated on/after `lagFloor` is `lagging`
 *  (the closes provider withholds some settled closes until the next EOD; reported, exit 0); older = `stale` (FAIL). Calendar
 *  weekdays only — a market holiday shifts the boundary by one session either way. */
export function partitionLagging(scan: ProvisionalScan, today: string): { lagging: Map<string, string[]>; stale: Map<string, string[]> } {
  const lagging = new Map<string, string[]>();
  const stale = new Map<string, string[]>();
  for (const [id, dates] of scan.provisional) {
    const prev = lagFloor(today, id);
    const l = dates.filter((d) => d >= prev);
    const s = dates.filter((d) => d < prev);
    if (l.length > 0) lagging.set(id, l);
    if (s.length > 0) stale.set(id, s);
  }
  return { lagging, stale };
}

/** `id@date` of each estimator-id `estimated` row at the EOD stamp that the run's folded `heads` lack — an intraday estimate
 *  `sweepEodRows` re-stamped. `null` = no `heads`: the leg is blind. */
export function restampedEstimates(
  heads: readonly Pick<StoredReading, "indicatorId" | "date">[] | undefined,
  stampRows: readonly StoredReading[],
  ids: readonly string[],
): string[] | null {
  if (heads === undefined) return null;
  const folded = new Set(heads.map((h) => `${h.indicatorId}@${h.date}`));
  const roster = new Set(ids);
  return stampRows
    .filter((r) => r.estimated === true && roster.has(r.indicatorId) && !folded.has(`${r.indicatorId}@${r.date}`))
    .map((r) => `${r.indicatorId}@${r.date}`);
}

/** The restamp leg over the newest original EOD row: its stamp is `firedAt`+1 ms (`writeEstimateRows`). No row ⇒ blind. */
export async function readRestamped(store: Pick<Store, "getLastAlert" | "getReadingsForRun">): Promise<string[] | null> {
  const last = await store.getLastAlert({ notifyBaseline: true, withRunInputs: true });
  if (last === null) return null;
  const stampAt = new Date(Date.parse(last.firedAt) + 1).toISOString();
  return restampedEstimates(last.runInputs?.heads, await store.getReadingsForRun(stampAt), ESTIMATE_ROW_IDS);
}

/** FAIL on any STALE provisional past row (older than the previous weekday), a blind id, an empty scan (an unrunnable
 *  falsifier is not a green one), or a re-stamped estimate / blind restamp leg. Lagging rows pass (U2). */
export function verdictOf(scan: ProvisionalScan, today: string, restamped: readonly string[] | null): "PASS" | "FAIL" {
  const { stale } = partitionLagging(scan, today);
  const clean = restamped !== null && restamped.length === 0;
  return stale.size === 0 && scan.blind.length === 0 && scan.scanned > 0 && clean ? "PASS" : "FAIL";
}

async function main(): Promise<void> {
  const env = process.argv.includes("--env=prod") ? "prod" : "local";
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.slice("--days=".length)) : 30;
  if (!Number.isInteger(days) || days < 1) throw new Error(`[probe-provisional-rows] bad --days: ${daysArg}`);
  if (env === "local") process.loadEnvFile(".env.local");
  const { resolveStore } = await import("./backfill/resolve-store.js");
  const store = await resolveStore(env, "ro");

  const now = new Date();
  const today = isoDay(now);
  const from = isoDay(new Date(now.getTime() - days * 86_400_000));
  const last = await store.getLastAlert();
  const lastRunIds = last ? (await store.getReadingsForRun(last.firedAt)).map((r) => r.indicatorId) : [];
  const ids = [...new Set([...staticRoster(), ...lastRunIds])];

  const scan = await scanProvisional(store, ids, today, from, days + 1);
  const restamped = await readRestamped(store);
  const { lagging, stale } = partitionLagging(scan, today);
  for (const [id, dates] of stale) console.log(`${id}: ${dates.length} STALE provisional (${dates.join(",")})`);
  for (const [id, dates] of lagging) console.log(`${id}: lagging provisional (${dates.join(",")}) — awaits the next EOD`);
  if (scan.blind.length > 0) console.log(`BLIND (no runAt): ${scan.blind.join(",")}`);
  if (restamped === null) console.log("BLIND restamp leg: no original alert row, or its run_inputs carry no heads");
  else if (restamped.length > 0) console.log(`RE-STAMPED estimate(s) at the EOD stamp, absent from heads: ${restamped.join(",")}`);
  const total = [...scan.provisional.values()].reduce((n, d) => n + d.length, 0);
  const verdict = verdictOf(scan, today, restamped);
  console.log(
    `VERDICT: ${verdict} (env=${env}, ids=${ids.length}, rows=${scan.scanned} in [${from}, ${today}), stale=${[...stale.values()].reduce((n, d) => n + d.length, 0)}, lagging=${[...lagging.values()].reduce((n, d) => n + d.length, 0)}, provisional=${total}, blind=${scan.blind.length}, restamped=${restamped?.length ?? "blind"})`,
  );
  if (verdict !== "PASS") process.exitCode = 1;
}

const isDirect = process.argv[1]?.endsWith("probe-provisional-rows.ts") === true;
if (isDirect) {
  await main();
}
