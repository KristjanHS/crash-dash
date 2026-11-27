/** Post-persist seed tail: every write here runs AFTER recordRun under a fresh `clock()` run_at, never firedAt. */

import {
  type Store,
  type StoredReading,
  type SeriesPoint,
} from "./store.js";
import { finalRewriteHeld } from "./prices.js";
import { realFeeds, type FeedPorts } from "./feed-ports.js";
import { priceLegReadingSeries } from "./pension.js";
import {
  legCloseReadingRows,
  offLadderLegCloseReadingRows,
  legCloseId,
  offLadderLegCloseId,
  LEG_TICKER,
  OFF_LADDER_LEG_TICKER,
  OFF_LADDER_LEG_KEYS,
  SB_BENCH_ID,
  SB_STRAT_ID,
  type LegChainAnchor,
} from "./scoreboard.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";
import { ID_SETS } from "./registry.js";
import { BREADTH_STORE_IDS } from "./registry-price.js";
import { computeLegRs, Y1_MIN_OBS, Y1_MIN_LEGS, type Sleeve } from "./y1.js";
import { growthRsReadingRows } from "./growth.js";
import { pushLegSeries } from "./run-cycle-exposure.js";
import { LADDER } from "./families.js";
import { type Observation, type Reading } from "./domain-types.js";
import { ALL_INDICATORS } from "./registry.js";
import { TREASURY_HEAD_OF } from "./registry-fred.js";
import { LAG_THRESHOLDS } from "./ladder.js";
import { INPUT_SERIES, fillLiveHoles, inputDeepLookbackDays, settledClose, withStoredLegs } from "./input-series.js";
import { graftTreasuryHeadFor } from "./indicator-feed.js";
import { TAIL_DAYS } from "./series-db-first.js";
import { GAP_FILL_DAYS, SESSION_CLOSE_UTC_MIN, finalDates, gapFillFrom, isProvisional, sameValue } from "./intraday.js";
import { dropUnanchoredEstimates, estimateDatesOf, stampEstimated, sweepSupersededEstimates } from "./estimated.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { confirmClosesFor } from "./family-table.js";
import { recordDegrade } from "./tracks.js";
import { FETCH_EDGE_SCORED_IDS } from "./slow.js";
import { isoDay } from "./dates.js";
import type { Env } from "./config.js";

/** The `degraded` scope of every seed-tail failure; the message (id + error) rides as `reason`. */
export const SEED_TAIL_SCOPE = "[seed-tail] seed non-live this run";
/** Has the seed tail aborted `signal`? A call, not a property read — TS would narrow `signal.aborted` across an `await`. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
/** A seed failure: logged, and recorded `trace` so the EOD post-tail `updateRunTrace` persists it — unless the seed tail aborted `signal`. */
function seedWarn(msg: string, signal?: AbortSignal): void {
  console.warn(msg);
  if (!aborted(signal)) recordDegrade(SEED_TAIL_SCOPE, msg, "trace");
}

/** Backfill probe depth: must cover the stored series' depth or older dates re-insert every run (deep backfill passes DEEP_PROBE). */
export const BACKFILL_PROBE_LIMIT = 2000;

/** Wall-clock seam (ISO). Tests must inject a strictly-increasing clock (run.wiring.feeds.test.ts NVDA backfill invariant). */
export type Clock = () => string;
export const wallClock: Clock = () => new Date().toISOString();

/** Max share of stored rows a restate may prune as pre-floor (and, separately, as post-grace tail); above it the restate
 *  throws as truncated — unless the rebuild's first date reached its trim floor. */
export const PRE_FIRST_PRUNE_MAX_SHARE = 0.1;

/** Max share of an official-leg restate's span (series rows ≥ `reshadowFloor`) its gap dates may be; above it the restate throws,
 *  nothing written — a truncated official fetch, not gaps (prod: 5 of ~290 sessions ≈ 1.7%). */
const OFFICIAL_GAP_MAX_SHARE = 0.05;

/** Restate tail grace (calendar days): stored dates more than this past the rebuilt newest bar are pruned; dates within it stay. */
export const RESTATE_TAIL_GRACE_DAYS = 7;

/** Restate tail-prune staleness allowance (calendar days): a fetch whose newest bar is older refuses the tail prune.
 *  ⛔ Never add `RESTATE_TAIL_GRACE_DAYS`: a tail needs age > grace, so grace+lag admits only stale fetches. */
export function restateTailMaxAgeDays(id: string): number {
  const ind = ALL_INDICATORS.find((i) => i.id === id);
  const cadence = ind?.cadence ?? "daily";
  // LAG_THRESHOLDS' daily/weekly tiers are publication SLOTS → calendarized ×7/5; `lagAfterDays` is calendar days.
  const tier = cadence === "daily" || cadence === "weekly" ? Math.ceil((LAG_THRESHOLDS[cadence] * 7) / 5) : LAG_THRESHOLDS[cadence];
  return ind?.lagAfterDays ?? tier;
}

/** Insert-missing `series` dates under a FRESH `clock()` run_at — never firedAt, or /status's run_at-keyed read picks them up. */
export async function backfillHistory(
  store: Store,
  id: string,
  series: Reading[],
  probeLimit: number = BACKFILL_PROBE_LIMIT,
  clock: Clock,
  reshadowFloor?: string,
  pruneCalendarHoles = false,
  // The id's depth cutoff (`backfillCutoffFor`), passed in by the CLI — `src/` must not import `scripts/`.
  depthCutoff?: string,
  asOf: string = clock().slice(0, 10),
  // `specCutoff`: the bound the readings were trimmed at (deeper than `depthCutoff` by a read-path head).
  trimFloor: string | undefined = depthCutoff,
  // Dates the series was scored off an `estimated` obs (`estimateDatesOf`): written `estimated`, never FINAL.
  estimateDates: ReadonlySet<string> = new Set(),
  // Official-leg gaps (sovereign spread + CMP_ legs, plan R1): never FINAL — on one ≥ `reshadowFloor` a stored non-estimate row is
  // deleted and rewritten `estimated` (the series row, else its own value); never pruned as a calendar hole.
  keepHoles: ReadonlySet<string> = new Set(),
  // The seed tail's abort (`runSeedTail`): checked before each store write — no write once it fires.
  signal?: AbortSignal,
): Promise<number> {
  if (series.length === 0) return 0;
  const gapDates = new Set([...keepHoles].filter((d) => d >= (reshadowFloor ?? "")));
  const span = series.filter((r) => r.date >= (reshadowFloor ?? "")).length;
  if (gapDates.size > span * OFFICIAL_GAP_MAX_SHARE) {
    throw new Error(
      `[backfill] ${id}: refusing official-gap rewrite — ${gapDates.size} gap date(s) over ${span} row(s) ≥ ${reshadowFloor ?? "(no floor)"} (> ${OFFICIAL_GAP_MAX_SHARE * 100}%); the official fetch looks truncated`,
    );
  }
  const existing = new Map((await store.getSeries(id, probeLimit)).map((p) => [p.date, p]));
  if (aborted(signal)) return 0;
  // Restate-only prune of rows the rebuild can never re-shadow: calendar holes, pre-floor rows, post-grace tail.
  // ⚠ The floor is the DEEPER of depthCutoff/first — pruning at `first` deletes a warm-up head (a spread's σ window) the depth keeps.
  if (pruneCalendarHoles) {
    const have = new Set(series.map((r) => r.date));
    const dates = [...have].sort();
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const floor = depthCutoff !== undefined && depthCutoff < first ? depthCutoff : first;
    const preFirst = [...existing.keys()].filter((d) => d < floor);
    // A rebuild whose first bar lands within one lag tier of its trim floor reached the depth: its pre-floor rows are policy surplus.
    const reachedDepth = trimFloor !== undefined && Date.parse(`${first}T00:00:00Z`) - Date.parse(`${trimFloor}T00:00:00Z`) <= restateTailMaxAgeDays(id) * 86_400_000;
    if (!reachedDepth && preFirst.length > existing.size * PRE_FIRST_PRUNE_MAX_SHARE) {
      throw new Error(
        `[backfill] ${id}: refusing restate prune — ${preFirst.length} of ${existing.size} stored rows predate the prune floor ${floor} (> ${PRE_FIRST_PRUNE_MAX_SHARE * 100}%); the fetch looks truncated`,
      );
    }
    const graceEdge = isoDay(new Date(Date.parse(`${last}T00:00:00Z`) + RESTATE_TAIL_GRACE_DAYS * 86_400_000));
    const tail = [...existing.keys()].filter((d) => d > graceEdge);
    if (tail.length > existing.size * PRE_FIRST_PRUNE_MAX_SHARE) {
      throw new Error(
        `[backfill] ${id}: refusing restate prune — ${tail.length} of ${existing.size} stored rows postdate the tail edge ${graceEdge} (> ${PRE_FIRST_PRUNE_MAX_SHARE * 100}%); the fetch looks truncated`,
      );
    }
    const age = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000;
    if (tail.length > 0 && age > restateTailMaxAgeDays(id)) {
      throw new Error(
        `[backfill] ${id}: refusing restate prune — ${tail.length} tail row(s) past ${graceEdge}, but the fetch's newest bar ${last} is ${age}d before ${asOf} (> ${restateTailMaxAgeDays(id)}d); the fetch looks stale`,
      );
    }
    const holes = [...existing.keys()].filter((d) => d > first && d < last && !have.has(d) && !keepHoles.has(d));
    const stranded = [...holes, ...preFirst, ...tail];
    if (stranded.length > 0) {
      const n = await store.deleteReadingsOnDates(id, stranded);
      console.log(
        `[backfill] ${id}: pruned ${n} stranded row(s) on ${stranded.length} date(s) (${holes.length} calendar-hole, ${preFirst.length} pre-first, ${tail.length} post-grace tail)`,
      );
      for (const d of stranded) existing.delete(d);
    }
  }
  const gapFinal = [...existing.values()].filter((p) => gapDates.has(p.date) && p.estimated !== true);
  if (aborted(signal)) return 0;
  if (gapFinal.length > 0) {
    await store.deleteReadingsOnDates(id, gapFinal.map((p) => p.date));
    for (const p of gapFinal) existing.delete(p.date);
  }
  const inSeries = new Set(series.map((r) => r.date));
  const restamped: StoredReading[] = gapFinal
    .filter((p) => !inSeries.has(p.date))
    .map((p) => ({ date: p.date, indicatorId: id, value: p.value, delta20: p.delta20, rawState: p.rawState, state: p.state, decision: p.decision ?? null, bandCuts: p.bandCuts ?? null }));
  // An estimate-sourced date already holding a settled row (estimate or print) is left alone — no print to land.
  const estHeld = new Set([...existing].filter(([d, p]) => estimateDates.has(d) && !isProvisional(p, id)).map(([d]) => d));
  // A restate skipping a date it rebuilt is not silent: e.g. an alert-run FINAL row its delete spared holds the date.
  const heldRestated = pruneCalendarHoles ? [...estHeld].filter((d) => inSeries.has(d)).sort() : [];
  if (heldRestated.length > 0) console.log(`[backfill] ${id}: ${heldRestated.length} estimate date(s) held by a settled stored row, not restated: ${heldRestated.join(", ")}`);
  // After the prune (which must still see them): provisional/`estimated` stored rows count as missing so the print lands over them.
  for (const [d, p] of existing) if (isProvisional(p, id) || p.estimated === true) existing.delete(d);
  const toRow = toStoredReading;
  const missing: StoredReading[] = series.filter((r) => !existing.has(r.date) && !estHeld.has(r.date)).map(toRow);
  // Decision repair: re-insert the STORED point verbatim with only `decision` filled — never rewrite history values.
  const repairs: StoredReading[] = series
    .filter((r) => r.decision != null && (existing.get(r.date)?.decision ?? null) == null && existing.has(r.date))
    .map((r) => {
      const p = existing.get(r.date)!;
      return {
        date: p.date,
        indicatorId: id,
        value: p.value,
        delta20: p.delta20,
        rawState: p.rawState,
        state: p.state,
        decision: r.decision,
      };
    });
  // Revision re-shadow: rewrite stored dates ≥ `reshadowFloor` from the FRESH series row; `undefined` ⇒ no re-shadow.
  const reshadows: StoredReading[] =
    reshadowFloor === undefined
      ? []
      : series.filter((r) => existing.has(r.date) && r.date >= reshadowFloor && !estimateDates.has(r.date)).map(toRow);
  // Set order is precedence: re-shadow > repair > missing.
  const byDate = new Map<string, StoredReading>();
  for (const r of missing) byDate.set(r.date, r);
  for (const r of repairs) byDate.set(r.date, r);
  for (const r of reshadows) byDate.set(r.date, r);
  for (const r of restamped) byDate.set(r.date, r);
  if (byDate.size === 0 || aborted(signal)) return 0;
  const runAt = clock();
  // Stamp the `missing` rows on an estimate date; a repair keeps its stored print's flag.
  const rows = stampEstimated([...byDate.values()], new Set([...estimateDates, ...gapDates].filter((d) => !existing.has(d))));
  await store.recordReadings(rows, runAt);
  const repairNote = repairs.length > 0 ? `, repaired ${repairs.length} null-decision row(s)` : "";
  const reshadowNote = reshadows.length > 0 ? `, re-shadowed ${reshadows.length} revised tail row(s)` : "";
  console.log(`[backfill] ${id}: seeded ${missing.length} historical reading(s)${repairNote}${reshadowNote}`);
  return rows.length;
}


export { QUOTE_GRAFT_CARDS, quoteRepairIds } from "./estimated.js";

/** A run's scored series per persisted id, oldest→newest — the gap-fill carrier (`gapFillSweep`). */
export type SeriesById = Map<string, readonly StoredReading[]>;

/** A fixed-date aggregate's window: ECY's month M-01 closes a month on, so its FINAL write-back (an estimated M row is
 *  "missing") must reach ~3 months back; a revising feed's, its revision horizon. Every other id: `GAP_FILL_DAYS`. */
const GAP_FILL_DAYS_OF: Readonly<Record<string, number>> = {
  ECY: 100,
  // The ECB's weekly CISS release re-issues ~24 days back (2026-11-09: 10-16..11-06) + a week for an EOD whose ECB fetch failed.
  ECISS: 35,
};

/** Official write-back over the last `GAP_FILL_DAYS` (`GAP_FILL_DAYS_OF`) of each carried series under `clock()`, never firedAt (skips
 *  newest + `confirmClosesFor` head): a date with no FINAL row, or whose served value is not the official one (`sameValue`), is
 *  written. `valueRepair: false` (intraday, an unclaimed provider hop), `insertOnlyIds` and `FETCH_EDGE_SCORED_IDS` write missing
 *  dates only; `insertOnlyReason` names why on the summary line. `insertOnOrAfter` (intraday: the run's own date): an earlier date is
 *  written only where its stored head is absent or `estimated`, the row is FINAL at `clock()` and the id is not in `pastHeldIds`
 *  (`rederiveOnWrite` keys off store state, not `onWritten`, so the next EOD re-derives it). Never throws: non-finite rows
 *  drop, a failed batch retries per id, probe/per-id failures go to `recordDegrade`. */
export async function gapFillSweep(
  store: Store,
  carried: SeriesById,
  asOf: string,
  clock: Clock,
  {
    valueRepair = true,
    insertOnlyIds,
    insertOnlyReason,
    insertOnOrAfter,
    pastHeldIds,
    onWritten,
    log = (line: string) => console.log(line),
  }: {
    valueRepair?: boolean;
    insertOnlyIds?: ReadonlySet<string>;
    insertOnlyReason?: string;
    insertOnOrAfter?: string;
    pastHeldIds?: ReadonlySet<string>;
    onWritten?: (id: string, date: string) => void;
    log?: (line: string) => void;
  } = {},
): Promise<number> {
  const fromOf = (id: string): string => {
    const days = GAP_FILL_DAYS_OF[id];
    return days === undefined ? gapFillFrom(asOf) : isoDay(new Date(Date.parse(`${asOf}T00:00:00Z`) - days * 86_400_000));
  };
  const windows = new Map<string, StoredReading[]>();
  for (const [id, series] of carried) {
    const since = fromOf(id);
    const floor = pastHeldIds?.has(id) === true ? insertOnOrAfter : undefined;
    const w = series.slice(confirmClosesFor(id), -1).filter((r) => r.date >= since && (floor === undefined || r.date >= floor));
    if (w.length > 0) windows.set(id, w);
  }
  if (windows.size === 0) return 0;
  // One probe per window length, newest `days + 1` per id: a calendar day holds ≤1 served row, so the whole window always fits.
  const byDays = new Map<number, string[]>();
  for (const id of windows.keys()) {
    const days = GAP_FILL_DAYS_OF[id] ?? GAP_FILL_DAYS;
    byDays.set(days, [...(byDays.get(days) ?? []), id]);
  }
  const stored = new Map<string, SeriesPoint[]>();
  try {
    for (const [days, ids] of byDays)
      for (const [id, points] of await store.getSeriesBulk(ids, { limit: days + 1, range: { from: fromOf(ids[0]!) } })) stored.set(id, points);
  } catch (err) {
    recordDegrade("[gap-fill] stored-window probe failed - sweep skipped this run", errText(err), "notify");
    return 0;
  }
  const missing = new Map<string, StoredReading[]>();
  const repaired = new Map<string, number>();
  for (const [id, w] of windows) {
    const points = stored.get(id) ?? [];
    const existing = finalDates(points, id);
    const served = new Map(points.map((p) => [p.date, p.value]));
    const repairs = valueRepair && !FETCH_EDGE_SCORED_IDS.has(id) && insertOnlyIds?.has(id) !== true;
    const byDate = new Map(points.map((p) => [p.date, p]));
    // Before the floor: absent or estimated head only (never a provisional one), and only a row already FINAL at this write.
    const pastRepair = (r: StoredReading): boolean => {
      const head = byDate.get(r.date);
      return (head === undefined || head.estimated === true) && !isProvisional({ date: r.date, runAt: clock() }, id);
    };
    const add = w.filter((r) => (insertOnOrAfter !== undefined && r.date < insertOnOrAfter ? pastRepair(r) : !existing.has(r.date) || (repairs && !sameValue(served.get(r.date)!, r.value))));
    const finite = add.filter((r) => Number.isFinite(r.value) && Number.isFinite(r.delta20));
    if (finite.length < add.length) console.warn(`[gap-fill] ${id}: dropped ${add.length - finite.length} non-finite row(s)`);
    if (finite.length > 0) missing.set(id, finite);
    repaired.set(id, finite.filter((r) => existing.has(r.date)).length);
  }
  const insert = async (ids: string[]): Promise<number> => {
    const rows = ids.flatMap((id) => missing.get(id)!);
    await store.recordReadings(rows, clock());
    for (const r of rows) onWritten?.(r.indicatorId, r.date);
    for (const id of ids) {
      const w = missing.get(id)!;
      console.log(`[gap-fill] ${id}: wrote ${w.length} date(s) (${repaired.get(id)} value-repaired) ${w.map((r) => r.date).join(",")}`);
    }
    return rows.length;
  };
  const written = await (async (): Promise<number> => {
    if (missing.size === 0) return 0;
    try {
      return await insert([...missing.keys()]);
    } catch {
      let n = 0;
      for (const id of missing.keys()) {
        try {
          n += await insert([id]);
        } catch (err) {
          recordDegrade(`[gap-fill] ${id} insert failed - missing dates not filled this run`, errText(err), "notify");
        }
      }
      return n;
    }
  })();
  // The churn falsifier: a settled store reads `wrote 0` on a re-run.
  const why = insertOnlyReason === undefined ? "" : `: ${insertOnlyReason}`;
  const held = [...windows.keys()].filter((id) => insertOnlyIds?.has(id) === true).length;
  const note = !valueRepair ? ` (insert-only run${why})` : held > 0 ? ` (${held} id(s) insert-only${why})` : "";
  log(`[gap-fill] wrote ${written} row(s) over ${missing.size} id(s)${note}`);
  return written;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The `LEGP_*` ids `seedLegClosesOnCron` writes (ladder + off-ladder legs). */
function legCloseIds(): string[] {
  return [...LADDER.map((sleeve) => legCloseId(sleeve)), ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId)];
}

/** The ids whose official close the post-persist seed tail writes (`seedInputSeriesOnCron`'s `INPUT_SERIES`, `seedLegClosesOnCron`'s
 *  `LEGP_*`) — after `persistRun`, so the EOD cleaner never re-stamps their daytime heads (`eodKeepRunAt`). */
function seedTailIds(): string[] {
  return [...INPUT_SERIES.map((s) => s.id), ...legCloseIds()];
}

/** `EodRun.keepRunAt`: the seed-tail ids ∪ every id whose `SESSION_CLOSE_UTC_MIN` window passes 24 h — its D−1 row is still
 *  provisional at EOD D and its settled close lands in a later run's fetch, after this cleaner. */
export function eodKeepRunAt(): ReadonlySet<string> {
  const multiDay = Object.entries(SESSION_CLOSE_UTC_MIN).filter(([, min]) => min > 24 * 60).map(([id]) => id);
  return new Set([...seedTailIds(), ...multiDay]);
}

/** Every persisted id a run or seed writes (registry incl. the DB and RS legs, component, chart-only, input, breadth, leg, SB). */
export function provisionalRoster(): string[] {
  return [
    ...ID_SETS.all,
    ...ID_SETS.cmp,
    ...CHART_ONLY_INDICATORS.map((i) => i.id),
    ...INPUT_SERIES.map((s) => s.id),
    ...Object.values(BREADTH_STORE_IDS).map((i) => i.id),
    ...legCloseIds(),
    SB_STRAT_ID,
    SB_BENCH_ID,
  ];
}

export interface ProvisionalScan {
  /** id → provisional past dates (ids with none omitted). */
  provisional: Map<string, string[]>;
  /** ids whose points carry no `runAt` — `isProvisional` reads those as final, so they blind the scan. */
  blind: string[];
  scanned: number;
}

/** Scan `[from, today)` of each id's `readings_latest` series through the store's real read. */
export async function scanProvisional(
  store: Pick<Store, "getSeriesBulk">,
  ids: readonly string[],
  today: string,
  from: string,
  limit: number,
): Promise<ProvisionalScan> {
  const series = await store.getSeriesBulk([...new Set(ids)], { limit, range: { from } });
  const provisional = new Map<string, string[]>();
  const blind: string[] = [];
  let scanned = 0;
  for (const [id, points] of series) {
    const past = points.filter((p) => p.date < today);
    scanned += past.length;
    if (past.some((p) => p.runAt === undefined)) blind.push(id);
    const dates = past.filter((p) => isProvisional(p, id)).map((p) => p.date);
    if (dates.length > 0) provisional.set(id, dates);
  }
  return { provisional, blind, scanned };
}

/** A scored `Reading` as the `readings` row backfill, restate and gap-fill all write. */
export function toStoredReading(r: Reading): StoredReading {
  return {
    date: r.date,
    indicatorId: r.indicator.id,
    value: r.level,
    delta20: r.delta20,
    rawState: r.rawState,
    state: r.state,
    decision: r.decision,
    // Keep `?? null` in step with `readingRow` (store.ts): cron and backfill must write identical `band_cuts` JSON.
    bandCuts: r.bandCuts ?? null,
  };
}


/** CAPE probe: MUST exceed the full 1871→now monthly row count (~1866, +12/yr) or old dates re-insert every run. */
const CAPE_PROBE_LIMIT = 5000;

/** Closed CAPE months (before the run clock's UTC month) whose stored FINAL row `backfillCapeOnCron` value-repairs each run. */
export const F7_REPAIR_MONTHS = 3;

/** The open CAPE month's floor: the 1st of `runAt`'s UTC month — F7 rows dated on/after it are stored `estimated` (both CAPE writers). */
export function capeOpenFloor(runAt: string): string {
  const now = new Date(runAt);
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

/** Cron-path F7 CAPE seed (display card; ECY reads the live CAPE fetch, not F7); twin of scripts/backfill.ts `backfillCape`. Rows dated in or past the
 *  run clock's UTC month are stored `estimated`, replaced every run; closed months insert-missing + `F7_REPAIR_MONTHS` value repair.
 *  ⚠ Plain try/catch, NOT `degrade`: post-`drainDegradeLog()`, a degrade event here never persists (`logDegrade` prints it via console.error). */
export async function backfillCapeOnCron(store: Store, clock: Clock, fetchCape: FeedPorts["fetchCape"] = realFeeds.fetchCape, signal?: AbortSignal): Promise<void> {
  try {
    const runAt = clock();
    const now = new Date(runAt);
    const openFloor = capeOpenFloor(runAt);
    const repairFloor = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - F7_REPAIR_MONTHS, 1)));
    const raw = priceLegReadingSeries("F7", await fetchCape());
    if (raw.length === 0) return;
    const rows = stampEstimated(raw, new Set(raw.filter((r) => r.date >= openFloor).map((r) => r.date)));
    const stored = await store.getSeries("F7", CAPE_PROBE_LIMIT);
    const final = finalDates(stored, "F7");
    const missing = rows.filter((r) => r.estimated === true || !final.has(r.date)); // an open-month row is rewritten every run
    const repairs = tailValueRepairs(rows, stored.filter((p) => final.has(p.date)), true, repairFloor);
    const toWrite: StoredReading[] = [...missing, ...repairs];
    if (toWrite.length === 0 || aborted(signal)) return;
    await store.recordReadings(toWrite, runAt);
    if (aborted(signal)) return;
    // A FINAL row on an open month shadows its estimate (`pickRecent`): delete it before `settleEstimateRows`' sweep does the estimate.
    // Only where this run wrote that month's estimate — a fetch missing the open month (head-row parse miss) must not regress the head.
    const fetched = new Set(rows.map((r) => r.date));
    const frozen = [...final].filter((d) => d >= openFloor && fetched.has(d));
    if (frozen.length > 0) await store.deleteNonEstimatesOnDates("F7", frozen);
    await settleEstimateRows(store, "F7", stored, toWrite, runAt);
    console.log(`[cape] seeded ${missing.length} CAPE reading(s), repaired ${repairs.length}`);
  } catch (err) {
    seedWarn(`[cape] seed non-live this run: ${err instanceof Error ? err.message : String(err)}`, signal);
  }
}

/** Catch-up dates offered to `legCloseReadingRows`: must span the longest inter-cron gap a leg accrues (venue lag + holiday);
 *  keep small — an unanchored leg seeds from this base. */
const LEG_CATCHUP_DATES = 10;

/** The newest `LEG_CATCHUP_DATES` close dates across the legs' feeds, ≤ asOf. ⛔ Never `[asOf]` alone: Xetra legs publish a
 *  session later — pinned by `run.tracks.test.ts` § "a venue that publishes a day behind asOf". */
function legCatchUpDates(byTicker: Record<string, Observation[]>, asOf: string): string[] {
  const dates = new Set<string>();
  for (const obs of Object.values(byTicker)) {
    for (const o of obs) if (o.date <= asOf) dates.add(o.date);
  }
  return [...dates].sort().slice(-LEG_CATCHUP_DATES);
}

/** Cron-path per-leg EUR close seed (`LEGP_*`, display-only). ⚠ Plain try/catch, NOT `degrade` (post-drain, as
 *  `backfillCapeOnCron`); keep it in the tail so `RUN_FETCH_BUDGET_MS` starves it first. */
export async function seedLegClosesOnCron(
  store: Store,
  env: Env,
  clock: Clock,
  asOf: string,
  { fetchDailyCloses }: Pick<FeedPorts, "fetchDailyCloses"> = realFeeds,
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Off-ladder legs fetch in an ISOLATED arm: a rejected off-ladder feed must not abort the ladder legs' seed.
    const ladderTickers = [...new Set(Object.values(LEG_TICKER).map((l) => l.ticker))];
    const offLadderTickers = [...new Set(Object.values(OFF_LADDER_LEG_TICKER).map((l) => l.ticker))].filter(
      (t) => !ladderTickers.includes(t),
    );
    // FX via `withStoredLegs`: a D-1 null `EURUSD=X` bar fills from stored `DEXUSEU`, so a USD leg converts at its own date's FX.
    const now = new Date(clock());
    // Leg tickers fill from stored `INPUT_SERIES` rows (`head` incl.); a date absent from the live feed is written `estimated`
    // (stored price, not the live adjusted vintage) — the anchor skips it and a later live run re-chains D final.
    const liveDates = new Map<string, Set<string>>();
    const fetchLive = async (symbol: string): Promise<Observation[]> => {
      const live = await fetchDailyCloses(symbol, { now: () => now.getTime(), env });
      liveDates.set(symbol, new Set(live.filter((o) => o.estimated !== true).map((o) => o.date))); // a closes provider meta close is not live
      return live;
    };
    // After `recordRun`: an event is lost, so the stored-leg failure stays console-only.
    const postRecord = (): void => undefined;
    const legFeed = withStoredLegs(store, [...ladderTickers, ...offLadderTickers], fetchLive, TAIL_DAYS, { now, head: true, onFail: postRecord });
    const [fx, ...ladderCloses] = await Promise.all([
      withStoredLegs(store, ["EURUSD=X"], (symbol) => fetchDailyCloses(symbol, { now: () => now.getTime(), env }), TAIL_DAYS, { now, onFail: postRecord })("EURUSD=X"),
      ...ladderTickers.map((t) => legFeed(t)),
    ]);
    // A rejected off-ladder fetch yields [] for that ticker (one warn line) — no LEGP_COMMOD row this run.
    const offLadderCloses = await Promise.all(
      offLadderTickers.map(async (t) => {
        try {
          return await legFeed(t);
        } catch (err) {
          const msg = `[legp] off-ladder ${t} close feed non-live this run: ${err instanceof Error ? err.message : String(err)}`;
          console.warn(msg);
          if (!aborted(signal)) recordDegrade(SEED_TAIL_SCOPE, msg, "trace");
          return [] as Observation[];
        }
      }),
    );
    const byTicker = Object.fromEntries([
      ...ladderTickers.map((t, i) => [t, ladderCloses[i] ?? []]),
      ...offLadderTickers.map((t, i) => [t, offLadderCloses[i] ?? []]),
    ]);
    // Chain rebase: advance each leg's stored level by a within-this-fetch EUR ratio (SB `nextNav`), never write a raw EUR close.
    const legIds = legCloseIds();
    if (aborted(signal)) return;
    // Anchor on the newest FINAL non-estimated row; none ⇒ the newest row, never a raw-close restart.
    const bulk = await store.getSeriesBulk(legIds, { limit: LEG_CATCHUP_DATES });
    const prior = new Map<string, LegChainAnchor>();
    for (const id of legIds) {
      const rows = bulk.get(id) ?? [];
      const last = rows.filter((p) => !isProvisional(p, id) && p.estimated !== true).at(-1) ?? rows.at(-1);
      if (last) prior.set(id, { level: last.value, date: last.date });
    }
    const dates = legCatchUpDates(byTicker, asOf);
    const tickerOf = new Map<string, string>([
      ...LADDER.map((sleeve) => [legCloseId(sleeve), LEG_TICKER[sleeve].ticker] as const),
      ...OFF_LADDER_LEG_KEYS.map((leg) => [offLadderLegCloseId(leg), OFF_LADDER_LEG_TICKER[leg].ticker] as const),
    ]);
    const runAt = clock();
    const chained = [
      ...legCloseReadingRows(byTicker, fx, dates, prior),
      ...offLadderLegCloseReadingRows(byTicker, fx, dates, prior),
    ].map((r) => (liveDates.get(tickerOf.get(r.indicatorId)!)?.has(r.date) === true ? r : { ...r, estimated: true }));
    // `estimateAnchored`: an estimate chained off a non-FINAL session is never written — the date stays a gap.
    const rows = dropUnanchoredEstimates(chained, bulk, runAt);
    if (rows.length === 0 || aborted(signal)) return;
    await store.recordReadings(rows, runAt);
    if (aborted(signal)) return;
    // As `writeEstimateRows` (run-cycle-persist.ts): a repeat run's head estimate REPLACES the older one on that date, never stacks.
    const estimatedDates = new Map<string, string[]>();
    for (const r of rows) if (r.estimated === true) estimatedDates.set(r.indicatorId, [...(estimatedDates.get(r.indicatorId) ?? []), r.date]);
    for (const [id, ds] of estimatedDates) await store.deleteEstimatesOnDates(id, ds, runAt);
    for (const id of legIds) if ((bulk.get(id) ?? []).some((p) => p.estimated === true)) await sweepSupersededEstimates(store, id, LEG_CATCHUP_DATES);
    console.log(`[legp] seeded ${rows.length} per-leg close row(s) at ${asOf} (${[...estimatedDates.values()].flat().length} estimated)`);
  } catch (err) {
    seedWarn(`[legp] leg-close seed non-live this run: ${err instanceof Error ? err.message : String(err)}`, signal);
  }
}

/** Cron-path growth-RS seed: `GRS_*` cache rows of `computeLegRs` over persisted `LEGP_*`. ⚠ MUST run AFTER `seedLegClosesOnCron`,
 *  under its own run_at, never folded into `runStoredReadings`; plain try/catch, NOT `degrade` (post-drain). */
export async function seedGrowthRsOnCron(store: Store, clock: Clock, asOf: string, signal?: AbortSignal): Promise<void> {
  try {
    const legSeries = await pushLegSeries(store); // the push's served rows, D's estimate included
    const { rs, lookbacksUsed } = computeLegRs(legSeries);
    // Date GRS rows at the RS axis's newest date, not `asOf` — run.tracks.test.ts pins GRS-date == LEGP-date.
    const rowDate = rsAxisNewest(legSeries) ?? asOf;
    const rows = growthRsReadingRows(rs, rowDate);
    if (rows.length === 0 || aborted(signal)) return;
    await store.recordReadings(rows, clock());
    console.log(`[grs] seeded ${rows.length} row(s) at ${rowDate}, lookbacks ${lookbacksUsed}/3`);
  } catch (err) {
    seedWarn(`[grs] growth-RS seed non-live this run: ${err instanceof Error ? err.message : String(err)}`, signal);
  }
}

/** Newest date on the RS axis: the date intersection over `computeLegRs`-eligible legs (mirror its axis); `null` below
 *  `Y1_MIN_LEGS`. NOT the max close across legs — a leg that skipped today must pull the as-of back. */
function rsAxisNewest(legSeries: Map<Sleeve, SeriesPoint[]>): string | null {
  const eligible = LADDER.filter((s) => (legSeries.get(s)?.length ?? 0) >= Y1_MIN_OBS);
  if (eligible.length < Y1_MIN_LEGS) return null;
  const dateSets = eligible.map((s) => new Set((legSeries.get(s) ?? []).map((p) => p.date)));
  const shared = [...(dateSets[0] as Set<string>)].filter((d) => dateSets.every((set) => set.has(d))).sort();
  return shared.at(-1) ?? null;
}

/** Input catch-up probe: must cover every date a non-full fetch returns (FRED default window ≈ 550 trading rows), or stored dates re-insert. */
export const INPUT_CATCHUP_PROBE = 600;

/** Raw FRED id → the indicator id whose Treasury same-day head covers it, DERIVED from `TREASURY_HEAD_OF` — never hand-write a second roster. */
const TREASURY_RAW_TO_INDICATOR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(TREASURY_HEAD_OF).map((indicatorId) => {
    const ind = ALL_INDICATORS.find((i) => i.id === indicatorId);
    if (ind === undefined) {
      throw new Error(`[input-series] TREASURY_HEAD_OF id ${indicatorId} is absent from ALL_INDICATORS`);
    }
    return [ind.series, indicatorId];
  }),
);

/** Treasury/`tailRepair` ids only: stored `TAIL_DAYS`-tail rows whose fresh 4-field values differ (keep the diff identical to
 *  `series-db-first.ts`'s); `[]` otherwise. The window floors at `floor` when given, else `TAIL_DAYS` before the freshest fetched date. */
function tailValueRepairs(
  fresh: readonly StoredReading[],
  stored: readonly SeriesPoint[],
  repair: boolean,
  floor?: string,
): StoredReading[] {
  if (!repair || fresh.length === 0) return [];
  const priorByDate = new Map(stored.map((p) => [p.date, p]));
  const newest = fresh.reduce((max, r) => (r.date > max ? r.date : max), "");
  const tailFloor = floor ?? isoDay(new Date(Date.parse(newest) - TAIL_DAYS * 86_400_000));
  return fresh.filter((r) => {
    if (r.date < tailFloor || r.estimated === true) return false; // an estimate never overwrites a FINAL row
    const p = priorByDate.get(r.date);
    return (
      p !== undefined &&
      (p.value !== r.value || p.delta20 !== r.delta20 || p.rawState !== r.rawState || p.state !== r.state)
    );
  });
}

/** After an input-series write: dedup this run's `estimated` rows, delete a daytime provisional head that would shadow one
 *  (`pickRecent` ranks any non-estimate first), and sweep the estimates a FINAL print now supersedes. */
async function settleEstimateRows(store: Store, id: string, stored: readonly SeriesPoint[], written: readonly StoredReading[], runAt: string): Promise<void> {
  const estDs = written.filter((r) => r.estimated === true).map((r) => r.date);
  if (estDs.length > 0) {
    await store.deleteEstimatesOnDates(id, estDs, runAt);
    const shadowing = [...new Set(stored.filter((p) => estDs.includes(p.date) && p.estimated !== true && isProvisional(p, id)).map((p) => p.date))];
    if (shadowing.length > 0) await store.deleteNonEstimatesOnDates(id, shadowing);
  }
  if (stored.some((p) => p.estimated === true)) await sweepSupersededEstimates(store, id, GAP_FILL_DAYS + NOWCAST_MAX_CARRY_DAYS);
}

export interface InputSeriesFeeds {
  fetchSeries: FeedPorts["fetchSeries"];
  fetchDailyCloses: FeedPorts["fetchDailyCloses"];
  fetchNtfsSeries: FeedPorts["fetchNtfsSeries"];
  fetchDramSpot: FeedPorts["fetchDramSpot"];
  fetchTreasuryColumn: FeedPorts["fetchTreasuryColumn"];
}

/** The five `InputSeriesFeeds` ports picked off `ports`. */
export const inputSeriesFeeds = ({ fetchSeries, fetchDailyCloses, fetchNtfsSeries, fetchDramSpot, fetchTreasuryColumn }: InputSeriesFeeds = realFeeds): InputSeriesFeeds => ({
  fetchSeries,
  fetchDailyCloses,
  fetchNtfsSeries,
  fetchDramSpot,
  fetchTreasuryColumn,
});

/** Max `INPUT_SERIES` ids `seedInputSeriesOnCron` seeds concurrently. */
const INPUT_SEED_POOL = 6;

/** Cron-path input-series seed: every `INPUT_SERIES` id as raw GREEN rows; an unseeded id fetches full history once (a `snapshot` id has none — one snapshot), else insert-missing.
 *  ⚠ Plain per-id try/catch, NOT `degrade` (post-drain, as `backfillCapeOnCron`) — one id's outage never aborts the others. */
export async function seedInputSeriesOnCron(
  store: Store,
  env: Env,
  clock: Clock,
  warn: (msg: string) => void = seedWarn,
  feeds: InputSeriesFeeds = inputSeriesFeeds(),
  log: (msg: string) => void = console.log,
  // The seed tail's abort: no next id, write or warn once it fires.
  signal?: AbortSignal,
): Promise<void> {
  // EVERY roster id seeds here — the DB-first seam persists R1–R5 under indicator ids, never the raw ids.
  const specs = INPUT_SERIES;
  let bulk: Map<string, SeriesPoint[]>;
  try {
    bulk = await store.getSeriesBulk(
      specs.map((s) => s.id),
      { limit: INPUT_CATCHUP_PROBE },
    );
  } catch (err) {
    warn(`[input-series] seed non-live this run (probe failed): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let rowCount = 0;
  let idCount = 0;
  let repairCount = 0;
  let skippedRepairs = 0;
  const seedNow = new Date(clock());
  const seedOne = async (spec: (typeof specs)[number]): Promise<void> => {
    try {
      const stored = bulk.get(spec.id) ?? [];
      const existing = new Set(stored.map((p) => p.date));
      const unseeded = existing.size === 0;
      const deepDays = inputDeepLookbackDays(spec, seedNow);
      let obs =
        spec.feed === "fred"
          ? await feeds.fetchSeries(spec.symbol ?? spec.id, { ...(unseeded ? { fullHistory: true } : {}), now: seedNow, env })
          : spec.feed === "ntfs"
          ? await feeds.fetchNtfsSeries(seedNow, env, feeds) // full history by construction (gsw.ts); the date-diff keeps the write small
          : spec.feed === "snapshot"
          ? await feeds.fetchDramSpot(spec.symbol ?? spec.id)
          : await feeds.fetchDailyCloses(
              spec.symbol ?? spec.id,
              unseeded
                ? { deep: true, ...(deepDays !== undefined ? { lookbackDays: deepDays } : {}), now: () => seedNow.getTime(), env }
                : { now: () => seedNow.getTime(), env },
            );
      // Treasury same-day head: raw DGS2/DGS10/DFII10 score ONE Treasury vintage per run; use `clock()`, never a bare `new Date()`.
      const treasuryIndicatorId = TREASURY_RAW_TO_INDICATOR[spec.id];
      if (treasuryIndicatorId !== undefined) obs = await graftTreasuryHeadFor(treasuryIndicatorId, obs, clock(), feeds.fetchTreasuryColumn);
      const estDates = new Set(estimateDatesOf(obs)); // read before `fillLiveHoles`, which rebuilds the obs
      // Price legs: live holes fill from stored `settledClose` rows (live wins) so a dropped D-1 bar is rewritten FINAL;
      // never freeze a pre-close provisional value final.
      if (spec.feed === "price") obs = fillLiveHoles(obs, stored.filter((p) => settledClose(spec.symbol ?? spec.id, p, spec.id)));
      // The diff is valid only INSIDE the probed window: a full probe floors at its oldest date, else ntfs full history re-inserts every cron.
      const probeFloor = existing.size >= INPUT_CATCHUP_PROBE ? (stored[0]!.date) : "";
      const runAt = clock();
      const fresh = stampEstimated(priceLegReadingSeries(spec.id, obs), estDates); // a head row is stored `estimated`
      // `existing` (all dates) sizes unseeded/probeFloor; a provisional date is missing, never a repair.
      const final = finalDates(stored, spec.id);
      const missing = fresh.filter((r) => r.date >= probeFloor && !final.has(r.date));
      // Tail repair: Treasury + `tailRepair` ids only; `missing` and `repairs` are disjoint.
      const due = tailValueRepairs(fresh, stored.filter((p) => final.has(p.date)), treasuryIndicatorId !== undefined || spec.tailRepair === true);
      // R1: a non-primary-served price symbol never rewrites a FINAL row.
      const held = spec.feed === "price" && finalRewriteHeld(spec.symbol ?? spec.id);
      const repairs = held ? [] : due;
      if (held) skippedRepairs += due.length;
      const toWrite = [...missing, ...repairs];
      if (toWrite.length === 0 || aborted(signal)) return;
      await store.recordReadings(toWrite, runAt);
      if (aborted(signal)) return;
      await settleEstimateRows(store, spec.id, stored, toWrite, runAt);
      rowCount += missing.length;
      repairCount += repairs.length;
      if (missing.length > 0) idCount += 1;
    } catch (err) {
      if (!aborted(signal)) warn(`[input-series] ${spec.id} seed non-live this run: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Bounded pool: up to INPUT_SEED_POOL ids in flight, each worker pulling the next roster id.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length && !aborted(signal)) await seedOne(specs[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(INPUT_SEED_POOL, specs.length) }, worker));
  const repairNote = repairCount > 0 ? `, repaired ${repairCount} tail row(s)` : "";
  const skipNote = skippedRepairs > 0 ? ` (tail repair held: non-primary feed, ${skippedRepairs} row(s))` : "";
  log(`[input-series] seeded ${rowCount} row(s) across ${idCount} id(s)${repairNote}${skipNote}`);
}
