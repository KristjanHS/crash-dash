/**
 * Estimate-row precedence (E1/E3/E7). The SQL read paths
 * (`readings_latest`, `readings_newest{,_n}`, migration 20261003120000) are the source; this mirrors them.
 */
import type { SeriesPoint, Store, StoredReading } from "./store.js";
import type { Observation, Reading } from "./domain-types.js";
import { GAP_FILL_DAYS, finalDates, gapFillFrom, isProvisional } from "./intraday.js";
import { daysBetween, NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { GATE_FAILED_ESTIMATORS } from "./nowcast-score.js";
import type { OilNowcast } from "./oil-nowcast.js";
import { DAILY_ROSTER } from "./last-print.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_COMPONENTS } from "./registry-composite.js";
import { PRICE_SCORERS } from "./registry-price.js";
import { isSovereignYield } from "./quote-graft.js";
import { prevSession, recentMarketDay } from "./source-holidays.js";
import { chainedDisplayIds, legCloseQuotes } from "./scoreboard.js";
import { inputSeriesSymbolOf, settledClose } from "./input-series.js";

/** An estimate on `date` stands only if `date` is an `id` session (`recentMarketDay`) whose
 *  previous session (`prevSession`) is one of `finals` (`anchorFinals`) — else `date` is a gap. */
export function estimateAnchored(id: string, finals: ReadonlySet<string>, date: string): boolean {
  return recentMarketDay(id, date) === date && finals.has(prevSession(id, date));
}

type AnchorRow = { date: string; runAt?: string; estimated?: boolean };
const LISTING_OF: ReadonlyMap<string, string> = new Map([
  ...legCloseQuotes().map(([id, q]): [string, string] => [id, q.ticker]),
  ...PRICE_SCORERS.flatMap((s): [string, string][] => (s.calendar === undefined ? [] : [[s.indicator.id, s.calendar]])),
]);
const listingOf = (id: string): string => LISTING_OF.get(id) ?? inputSeriesSymbolOf(id);

const oldestOf = (rows: readonly AnchorRow[]): string => rows.reduce((m, p) => (p.date < m ? p.date : m), rows[0]?.date ?? "");

/** `rows`' anchors, walked by date: each FINAL (`settledClose` on `id`'s listing); a settled EU close stored `estimated` only if
 *  `anchorExempt`, itself anchored on an earlier anchor, or its previous session precedes `oldest` (the read's bound). */
function anchorRows<P extends AnchorRow>(id: string, rows: readonly P[], oldest = oldestOf(rows)): P[] {
  const finals = new Set<string>();
  const out: P[] = [];
  for (const p of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!settledClose(listingOf(id), p, id)) continue;
    if (p.estimated === true && !anchorExempt(id, p) && prevSession(id, p.date) >= oldest && !estimateAnchored(id, finals, p.date)) continue;
    finals.add(p.date);
    out.push(p);
  }
  return out;
}

/** The anchor's FINAL dates (`anchorRows`). */
const anchorFinals = (id: string, rows: readonly AnchorRow[], oldest?: string): Set<string> =>
  new Set(anchorRows(id, rows, oldest).map((p) => p.date));

/** Sovereign cards whose row past the newest close is a sovereign-quote quote head stored `estimated`; + CMP_ legs = `quoteRepairIds`, the
 *  persist roster and (via `QUOTE_HEAD_IDS`) the anchor exemption. */
export const QUOTE_GRAFT_CARDS = ["BONOS", "BUND"] as const;
export const quoteRepairIds = (): ReadonlySet<string> =>
  new Set(QUOTE_GRAFT_CARDS.flatMap((id) => [id, ...(COMPOSITE_COMPONENTS[id] ?? []).map((c) => c.id)]));

/** Ids whose estimate is a sovereign-quote quote head — the `liveHead` sovereign-yield ids (R-ids) + `quoteRepairIds` — kept unanchored past EOD. */
const QUOTE_HEAD_IDS: ReadonlySet<string> = new Set([
  ...ALL_INDICATORS.filter((i) => i.estimator?.kind === "carry-level" && i.estimator.leads.every(isSovereignYield)).map((i) => i.id),
  ...quoteRepairIds(),
]);

/** Intraday on its own day (`isProvisional`, `runAt` on `date`) — a forward-dated row is not, nor an EU close settled at
 *  `runAt` (`settledClose` on `id`'s listing): it anchors, so it is judged. */
const intradayHead = (id: string, p: AnchorRow): boolean =>
  isProvisional(p, id) && Date.parse(p.runAt!) >= Date.parse(`${p.date}T00:00:00Z`) && !settledClose(listingOf(id), p, id);

/** A STORED row the anchor never judges: a `QUOTE_HEAD_IDS` quote head, or `intradayHead`; a settled EU close enters only as an
 *  anchor (`anchorFinals`), never exempt. The dial's gate (`gateUnanchoredReadings`) exempts `intradayHead` only: the EOD dial reads the last FINAL. */
function anchorExempt(id: string, p: AnchorRow): boolean {
  return QUOTE_HEAD_IDS.has(id) || intradayHead(id, p);
}

/** `series`' estimate dates breaking `estimateAnchored`, judged only where the previous session lies inside the read. */
export function unanchoredEstimateDates(id: string, series: readonly AnchorRow[], exempt: (id: string, p: AnchorRow) => boolean = anchorExempt): string[] {
  const oldest = oldestOf(series);
  const finals = anchorFinals(id, series, oldest);
  return series
    .filter((p) => p.estimated === true && !exempt(id, p) && prevSession(id, p.date) >= oldest && !estimateAnchored(id, finals, p.date))
    .map((p) => p.date);
}

/** `estimateAnchored`'s swept + served roster: every daily id served as a value — `DAILY_ROSTER`, the daily chart-only ids, `chainedDisplayIds`. */
export const ANCHOR_ROSTER: readonly string[] = [...new Set([
  ...DAILY_ROSTER,
  ...CHART_ONLY_INDICATORS.filter((i) => (i.obsCadence ?? i.cadence ?? "daily") === "daily").map((i) => i.id),
  ...chainedDisplayIds(),
])];

/** `rows` less each `estimated` row breaking `estimateAnchored` — finals = `anchorRows` over `stored` plus `rows` written at
 *  `runAt`, bounded by `stored`'s oldest date (none stored ⇒ every settled estimate judged); a settled one stays iff it anchors. */
export function dropUnanchoredEstimates(rows: readonly StoredReading[], stored: ReadonlyMap<string, readonly SeriesPoint[]>, runAt: string): StoredReading[] {
  const stamped = rows.map((r) => ({ ...r, runAt }));
  const anchors = new Map<string, AnchorRow[]>();
  const anchorsOf = (id: string): AnchorRow[] => {
    const own = stored.get(id) ?? [];
    if (!anchors.has(id)) anchors.set(id, anchorRows<AnchorRow>(id, [...own, ...stamped.filter((r) => r.indicatorId === id)], oldestOf(own)));
    return anchors.get(id)!;
  };
  return rows.filter((r, i) => {
    const p = stamped[i]!;
    if (r.estimated !== true || anchorExempt(r.indicatorId, p)) return true;
    const walked = anchorsOf(r.indicatorId);
    return settledClose(listingOf(r.indicatorId), p, r.indicatorId) ? walked.includes(p) : estimateAnchored(r.indicatorId, new Set(walked.map((a) => a.date)), r.date);
  });
}

/** `readings` with each `ANCHOR_ROSTER` reading scored off an estimate (`sourced`) on a date breaking `estimateAnchored` at
 *  `runAt` swapped for its id's last FINAL row (`carried`, else `stored`) — none ⇒ dropped. Same reference when none applies.
 *  A stored-row read failure anchors on the run's prints alone and goes to `onReadFail` (the cron passes `recordDegrade`). */
export async function gateUnanchoredReadings<R extends Reading>(
  readings: readonly R[],
  run: { runAt: string; sourced: ReadonlyMap<string, ReadonlySet<string>>; carried: ReadonlyMap<string, readonly StoredReading[]> },
  store: Pick<Store, "getSeriesBulk">,
  onReadFail: (scope: string, reason: string) => void = (scope, reason) => console.warn(`${scope}: ${reason}`),
): Promise<readonly R[]> {
  const ids = new Set(ANCHOR_ROSTER);
  const hit = readings.filter((r) => ids.has(r.indicator.id) && run.sourced.get(r.indicator.id)?.has(r.date) === true && !intradayHead(r.indicator.id, { date: r.date, runAt: run.runAt, estimated: true }));
  if (hit.length === 0) return readings;
  const printsOf = (id: string): StoredReading[] => (run.carried.get(id) ?? []).filter((c) => run.sourced.get(id)?.has(c.date) !== true);
  const stored = await store.getSeriesBulk([...new Set(hit.map((r) => r.indicator.id))], { limit: GAP_FILL_DAYS }).catch((err: unknown) => {
    onReadFail("[anchor] stored-row read failed - anchoring on this run's prints only", err instanceof Error ? err.message : String(err));
    return new Map<string, SeriesPoint[]>();
  });
  const swap = new Map<R, R | null>();
  for (const r of hit) {
    const id = r.indicator.id;
    const anchors = anchorRows<StoredReading | SeriesPoint>(id, [...printsOf(id), ...(stored.get(id) ?? [])]);
    if (estimateAnchored(id, new Set(anchors.map((p) => p.date)), r.date)) continue;
    const last = anchors.filter((p) => p.date < r.date).at(-1);
    const { lag: _lag, ageDays: _age, ...rest } = r;
    swap.set(r, last === undefined ? null : ({ ...rest, date: last.date, level: last.value, delta20: last.delta20, rawState: last.rawState, state: last.state, decision: last.decision ?? null, bandCuts: last.bandCuts ?? null } as R));
    console.log(`[anchor] ${id}: ${r.date} estimate unanchored - ${last === undefined ? "no FINAL row, reading dropped" : `reading its ${last.date} FINAL`}`);
  }
  return swap.size === 0 ? readings : readings.flatMap((r) => (swap.has(r) ? (swap.get(r) === null ? [] : [swap.get(r)!]) : [r]));
}

/** E7 winner of one (id, date): a final row beats an estimate, then newest runAt, then the LATER insert
 *  (`next` — SQL's `id desc`). Mirrors `order by estimated asc, run_at desc, id desc`. */
export function pickRecent<P extends { runAt: string; estimated?: boolean }>(kept: P | undefined, next: P): P {
  if (kept === undefined) return next;
  const keptEst = kept.estimated === true;
  if (keptEst !== (next.estimated === true)) return keptEst ? next : kept;
  return Date.parse(next.runAt) >= Date.parse(kept.runAt) ? next : kept;
}

/** E3 sweep: delete `id`'s estimate rows (newest `limit` dates) on every date whose served row is a FINAL print, and on
 *  every served-estimate date the next print skipped (`ORPHAN_SKIP_MAX_DAYS`). A provisional quote keeps its estimate. */
export async function sweepSupersededEstimates(store: Store, id: string, limit: number): Promise<number> {
  const dates = supersededEstimateDates(id, await store.getSeries(id, limit));
  return dates.length === 0 ? 0 : store.deleteEstimatesOnDates(id, dates);
}

/** E3 over ONE bulk read of `ids`, every run: superseded estimates and every unanchored estimate (`estimateAnchored`) die. Per-id failures warn. */
export async function sweepRosterEstimates(store: Pick<Store, "getSeriesBulk" | "deleteEstimatesOnDates">, ids: readonly string[], limit: number): Promise<void> {
  for (const [id, series] of await store.getSeriesBulk([...ids], { limit })) {
    try {
      const swept = supersededEstimateDates(id, series);
      const n = swept.length === 0 ? 0 : await store.deleteEstimatesOnDates(id, swept);
      if (n > 0) console.log(`[estimate-sweep] ${id}: deleted ${n} superseded estimate row(s)`);
      const loose = unanchoredEstimateDates(id, series).filter((d) => !swept.includes(d));
      const u = loose.length === 0 ? 0 : await store.deleteEstimatesOnDates(id, loose);
      if (u > 0) console.log(`[estimate-sweep] ${id}: deleted ${u} unanchored estimate row(s) ${loose.join(",")}`);
    } catch (err) {
      console.warn(`[estimate-sweep] ${id}: sweep skipped - superseded/unanchored rows linger: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The dates whose served row in `series` is a provisional NON-estimate head on one of `claimed` — it shadows the estimate
 *  there (`pickRecent` ranks any non-estimate first). Served provisional ⇒ the date holds no FINAL row. The ONE shadowing rule. */
function shadowingHeadDates(id: string, series: readonly SeriesPoint[], claimed: ReadonlySet<string>): string[] {
  return series.filter((p) => claimed.has(p.date) && p.estimated !== true && isProvisional(p, id)).map((p) => p.date);
}

async function deleteShadowingHeads(store: Pick<Store, "deleteProvisionalOnDates">, id: string, dates: readonly string[]): Promise<void> {
  if (dates.length === 0) return;
  const n = await store.deleteProvisionalOnDates(id, [...dates]);
  if (n > 0) console.log(`[shadow-sweep] ${id}: deleted provisional head(s) ${dates.join(",")}`);
}

/** The daytime half of the cleaner's shadowing rule: per id of `written` (id → the dates a run wrote an `estimated` row on),
 *  delete the provisional NON-estimate head shadowing it — no superseded sweep, no re-stamp. ONE bulk read; per-id failures warn. */
export async function clearShadowedHeads(
  store: Pick<Store, "getSeriesBulk" | "deleteProvisionalOnDates">,
  written: ReadonlyMap<string, ReadonlySet<string>>,
  limit: number,
): Promise<void> {
  if (written.size === 0) return;
  const bulk = await store.getSeriesBulk([...written.keys()], { limit });
  for (const [id, series] of bulk) {
    try {
      await deleteShadowingHeads(store, id, shadowingHeadDates(id, series, written.get(id) ?? new Set()));
    } catch (err) {
      console.warn(`[${id}] shadowing-head sweep failed - a provisional head may shadow the estimate: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** What the EOD run hands its cleaner: its fired date, the `run_at` a re-stamp writes at (writeEstimateRows' 1 ms past
 *  firedAt), and id → the dates this run wrote an `estimated` row on (empty when that write failed). */
export interface EodRun {
  today: string;
  /** This run's `run_at`: every row at or past it is the run's own (`recordRun`, its estimates) — never a head, even on a
   *  forced EOD run before the cutoff, whose own rows `isProvisional` would otherwise flag. */
  firedAt: string;
  stampAt: string;
  estimated: ReadonlyMap<string, ReadonlySet<string>>;
  /** Ids never re-stamped (rules 1–2 still apply): their official close lands AFTER this cleaner (the post-persist seed
   *  tail, or a later run's fetch for a >24 h `SESSION_CLOSE_UTC_MIN` id — `eodKeepRunAt`), so a pre-settle daytime head must keep its own `run_at` for `settledClose` to reject it (a re-stamp at the
   *  EOD `run_at` would pass as settled and freeze the midday value FINAL), and re-stamping it ahead of its own close is churn. */
  keepRunAt: ReadonlySet<string>;
}

/** The ONE EOD cleaner, ONE bulk read of `ids`' newest `limit` served
 *  rows, then per id: (1) E3 — its raw `estimated` rows (`getEstimateDates`: a FINAL shadows one in `getSeriesBulk`) on
 *  `supersededEstimateDates` die, a provisional head reading as an estimate there (a head the feed printed past is an
 *  orphan); (2) a provisional NON-estimate head on such an orphan date, or on a date this run wrote an estimate on (it would
 *  shadow it — `pickRecent` ranks any non-estimate first), is deleted, `run_at`-bounded so a FINAL row never goes;
 *  (3) every other provisional NON-estimate head in the gap-fill window up to `today` is RE-STAMPED as this run's own `estimated`
 *  row at `stampAt` (the old row deleted): a quote, never a D−1 carry. An `estimated` head this run could not re-derive keeps its
 *  own `run_at` — `/lab` labels it intraday. Per-id failures warn. */
export async function sweepEodRows(
  store: Pick<Store, "getSeriesBulk" | "getEstimateDates" | "deleteEstimatesOnDates" | "deleteProvisionalOnDates" | "recordReadings">,
  ids: readonly string[],
  limit: number,
  run: EodRun,
): Promise<void> {
  const bulk = await store.getSeriesBulk([...new Set(ids)], { limit });
  const from = [...bulk.values()].flatMap((s) => (s[0] === undefined ? [] : [s[0].date])).sort()[0];
  if (from === undefined) return;
  const held = await store.getEstimateDates([...bulk.keys()], from);
  const windowFrom = gapFillFrom(run.today);
  const ownRow = (p: SeriesPoint): boolean => p.runAt !== undefined && Date.parse(p.runAt) >= Date.parse(run.firedAt);
  for (const [id, series] of bulk) {
    try {
      const own = new Set(held.get(id) ?? []);
      const heads = new Set(series.filter((p) => p.date >= windowFrom && p.date <= run.today && isProvisional(p, id) && !ownRow(p)));
      const view = series.map((p) => (heads.has(p) && p.estimated !== true ? { ...p, estimated: true as const } : p));
      const superseded = new Set(supersededEstimateDates(id, view));
      const swept = [...superseded].filter((d) => own.has(d));
      if (swept.length > 0) {
        const n = await store.deleteEstimatesOnDates(id, swept);
        if (n > 0) console.log(`[estimate-sweep] ${id}: deleted ${n} superseded estimate row(s)`);
      }
      const written = run.estimated.get(id) ?? new Set<string>();
      await deleteShadowingHeads(store, id, shadowingHeadDates(id, [...heads], new Set([...superseded, ...written])));
      const restamp = run.keepRunAt.has(id)
        ? []
        : [...heads].filter((p) => p.estimated !== true && !superseded.has(p.date) && !written.has(p.date));
      if (restamp.length === 0) continue;
      await store.recordReadings(
        restamp.map(({ runAt: _runAt, ...p }) => ({ ...p, indicatorId: id, estimated: true })),
        run.stampAt,
      );
      const dates = restamp.map((p) => p.date);
      await store.deleteProvisionalOnDates(id, dates);
      await store.deleteEstimatesOnDates(id, dates, run.stampAt);
      console.log(`[eod-sweep] ${id}: re-stamped provisional head(s) ${dates.join(",")} as this run's estimate`);
    } catch (err) {
      console.warn(`[${id}] EOD sweep failed - superseded/provisional rows linger: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** A skipped date's next print lands within a long holiday weekend; a fixed-date aggregate's (ECY's month) only a cadence
 *  later — so an estimate whose next print is further off is no orphan: its date keeps the estimate until its own print. */
const ORPHAN_SKIP_MAX_DAYS = 6;

/** The dates `sweepSupersededEstimates` deletes on, off an already-read series (`sweepRosterEstimates`' bulk read shares it). */
function supersededEstimateDates(id: string, series: readonly SeriesPoint[]): string[] {
  const final = finalDates(series, id);
  const sorted = [...final].sort();
  const skipped = (date: string): boolean => {
    const next = sorted.find((f) => f > date);
    return next !== undefined && daysBetween(date, next) <= ORPHAN_SKIP_MAX_DAYS;
  };
  return series.filter((p) => final.has(p.date) || (p.estimated === true && skipped(p.date))).map((p) => p.date);
}

/** Rows past the newest print an estimate/carry can occupy — the over-read both readers below add to `n`. */
export const ESTIMATE_OVER_READ = NOWCAST_MAX_CARRY_DAYS + 1;

/** `id`'s newest `n` NON-estimate points — estimate rows sit on at most `NOWCAST_MAX_CARRY_DAYS` dates past the newest
 *  print (inclusive), so the over-read always reaches `n` prints. For reads that must stay on prints. */
export async function getPrintSeries(store: Pick<Store, "getSeries">, id: string, n: number): Promise<SeriesPoint[]> {
  return (await store.getSeries(id, n + ESTIMATE_OVER_READ)).filter((p) => p.estimated !== true).slice(-n);
}

export type RowKeep = (id: string, p: SeriesPoint) => boolean;
/** Every stored row is an observation; an estimate is D's reading. */
export const isObservation: RowKeep = () => true;
/** Each notify keep's run date (`notifyObservationOn`'s `today`), read by `keptRows` to gap-judge that read. */
const NOTIFY_KEEPS = new WeakMap<RowKeep, string>();
/** The cron NOTIFY dial's stored-row filter for a run fired on `today`: drops a failed-gate estimator's estimates and every
 *  provisional (daytime) row but an `estimated` one dated before `today` (a kept intraday estimate folds from D+1). */
export function notifyObservationOn(today: string): RowKeep {
  const keep: RowKeep = (id, p) =>
    !(p.estimated === true && GATE_FAILED_ESTIMATORS.has(id)) && (!isProvisional(p, id) || (p.estimated === true && p.date < today));
  NOTIFY_KEEPS.set(keep, today);
  return keep;
}

/** The notify read's gaps in `id`'s `series` for a run fired on `today`, as `gateUnanchoredReadings` judges a gated quote head
 *  (its only exemption an `intradayHead` dated `today` or later — the row `notifyObservationOn` drops; a kept intraday estimate
 *  from before `today` is judged like the EOD-stamped row it stands in for): each unanchored estimate plus every estimate back
 *  to the last anchor before it — the FINAL the gate reads. */
function notifyGapDates(id: string, series: readonly AnchorRow[], today: string): string[] {
  if (!QUOTE_HEAD_IDS.has(id) || !ANCHOR_ROSTER.includes(id)) return [];
  const finals = [...anchorFinals(id, series)].sort();
  const gaps = unanchoredEstimateDates(id, series, (gid, p) => p.date >= today && intradayHead(gid, p));
  return series.filter((p) => p.estimated === true && gaps.some((u) => p.date <= u && p.date > (finals.findLast((f) => f < u) ?? ""))).map((p) => p.date);
}

/** `id`'s `series` less each row `keep` drops; the notify read (`notifyObservationOn`) also drops its `notifyGapDates` estimates. */
export function keptRows<P extends SeriesPoint>(id: string, series: readonly P[], keep: RowKeep): P[] {
  const today = NOTIFY_KEEPS.get(keep);
  const gaps = new Set(today === undefined ? [] : notifyGapDates(id, series, today));
  return series.filter((p) => keep(id, p) && !(p.estimated === true && gaps.has(p.date)));
}

/** `id`'s newest `n` rows passing `keptRows` — the dropped rows sit within `NOWCAST_MAX_CARRY_DAYS` past the newest print, inside the over-read. */
export async function getObservedSeries(store: Pick<Store, "getSeries">, id: string, n: number, keep: RowKeep = isObservation): Promise<SeriesPoint[]> {
  return keptRows(id, await store.getSeries(id, n + ESTIMATE_OVER_READ), keep).slice(-n);
}

/** `r`'s head: the last estimate on its id dated past it and anchored on `r`'s own date (`estimateAnchored` — a chained estimate never heads). */
const headOf = (r: Reading, estimates: readonly StoredReading[]): StoredReading | undefined =>
  estimates.findLast((e) => e.indicatorId === r.indicator.id && e.date > r.date && estimateAnchored(r.indicator.id, new Set([r.date]), e.date));

/** E13 display readings: an id whose `estimated` row is dated past its scored print takes that row's folded head
 *  (E1/E7: a print on the same date wins). `null` ⇒ no estimate applies — the display dial IS the notify dial. */
export function withEstimateHeads<R extends Reading>(readings: readonly R[], estimates: readonly StoredReading[], restamp: (r: R) => R): R[] | null {
  let applied = false;
  const out = readings.map((r) => {
    const e = headOf(r, estimates);
    if (e === undefined) return r;
    applied = true;
    const { lag: _lag, ageDays: _age, ...rest } = r;
    const head = { ...rest, date: e.date, level: e.value, delta20: e.delta20, rawState: e.rawState, state: e.state, decision: e.decision ?? null, bandCuts: e.bandCuts ?? null };
    return restamp(head as R);
  });
  return applied ? out : null;
}

/** The heads `withEstimateHeads` folds into the NOTIFY dial (failed-gate estimators barred), keyed by id, as the
 *  push body's `est.` input: `fromDate` is the print each head runs past. */
export function notifyHeadEstimates(readings: readonly Reading[], estimates: readonly StoredReading[]): Record<string, OilNowcast> {
  const est = estimates.filter((e) => !GATE_FAILED_ESTIMATORS.has(e.indicatorId));
  return Object.fromEntries(
    readings.flatMap((r) => {
      const e = headOf(r, est);
      return e === undefined ? [] : [[r.indicator.id, { date: e.date, value: e.value, fromDate: r.date, state: e.state }]];
    }),
  );
}

/** `heads` under `oil`: oil's own nowcast wins its id's value, the head's `state` rides it; a null/absent oil slot keeps the head. */
export function mergeHeadEstimates(heads: Record<string, OilNowcast>, oil: Partial<Record<string, OilNowcast | null>>): Record<string, OilNowcast | null> {
  const out: Record<string, OilNowcast | null> = { ...heads };
  for (const [id, o] of Object.entries(oil)) {
    const h = heads[id];
    out[id] = o == null ? (h ?? null) : h === undefined ? o : { ...o, state: h.state };
  }
  return out;
}

/** The dates any of `legs` carries an `estimated` obs on (a quote head, never an official print) — a reading scored
 *  there is estimate-sourced. Sorted, deduped. */
export function estimateDatesOf(...legs: readonly (readonly Observation[] | undefined)[]): string[] {
  return [...new Set(legs.flatMap((leg) => (leg ?? []).filter((o) => o.estimated === true).map((o) => o.date)))].sort();
}

/** `rows` with each one on `dates` flagged `estimated` — daytime rows included (a daytime head is provisional by
 *  `run_at` AND `estimated`). Same reference per untouched row. */
export function stampEstimated<R extends { date: string; estimated?: boolean }>(rows: readonly R[], dates: ReadonlySet<string>): R[] {
  return rows.map((r) => (dates.has(r.date) && r.estimated !== true ? { ...r, estimated: true } : r));
}

/** `stampEstimated` per id over a run's persisted rows, off the run's estimate-sourced record (`markEstimateSourced`). */
export function stampEstimateSourced(rows: readonly StoredReading[], sourced: ReadonlyMap<string, ReadonlySet<string>>): StoredReading[] {
  return rows.map((r) => stampEstimated([r], sourced.get(r.indicatorId) ?? new Set<string>())[0]!);
}

/** The gap-fill carrier minus each estimate-sourced row BEHIND the newest — `gapFillSweep` skips the newest slot by
 *  position, so dropping it would shift that skip onto an official row. An estimate-sourced row never lands FINAL. */
export function withoutEstimateSourced(
  carried: ReadonlyMap<string, readonly StoredReading[]>,
  sourced: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, readonly StoredReading[]> {
  return new Map(
    [...carried].map(([id, series]) => {
      const ds = sourced.get(id);
      return [id, ds === undefined ? series : series.filter((r, i) => i === series.length - 1 || !ds.has(r.date))];
    }),
  );
}
