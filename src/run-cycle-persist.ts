/** Run-cycle persist tail: stored-row projections, then degrade drains + the EOD prune → `drainDegradeLog()` + atomic write → the EOD cleaner (`sweepEodRows`) → the daily-roster sweep. */

import type { Observation, Reading } from "./domain-types.js";
import type { KeyedFallback } from "./fred.js";
import { finalRewriteHeld, type ProviderFallback } from "./prices.js";
import { codeVintages } from "./scorer-vintage.js";
import type { NtfyMessage } from "./ntfy.js";
import { CRON_PRUNE_FRONTIER_DAYS, CRON_PRUNE_RETAIN_DAYS, PRUNE_DEGRADE_SCOPE, type AlertRecord, type DegradeEvent, type StoredReading, type SeriesPoint, type Store } from "./store.js";
import { chainedRatio, navReadingRow, nextNav, scoreboardNavRows, LEG_TICKER, SB_STRAT_ID, SB_BENCH_ID, type LegQuote } from "./scoreboard.js";
import { degrade, drainDegradeLog, drainLateDegrades, recordDegrade } from "./tracks.js";
import { openTraceWindow, runMsUntilHardDeadline, runTimings, timingLine } from "./fetch-budget.js";
import { DB_CALL_TIMEOUT_MS } from "./db-fetch.js";
import { TAIL_DAYS, seamRunAt } from "./series-db-first.js";
import { GAP_FILL_DAYS, isProvisional } from "./intraday.js";
import { ESTIMATE_ROW_IDS } from "./nowcast-score.js";
import { ANCHOR_ROSTER, clearShadowedHeads, dropUnanchoredEstimates, estimateDatesOf, getPrintSeries, stampEstimateSourced, sweepEodRows, sweepRosterEstimates } from "./estimated.js";
import { withStoredLegs } from "./input-series.js";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { eodKeepRunAt, provisionalRoster, quoteRepairIds } from "./run-seeds.js";
import { toStoredReadings } from "./run-core.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { runIntradaySeedTail } from "./run-cycle-seed-tail.js";
import { errMsg } from "./err-msg.js";

/** Hard-deadline headroom the cron prune needs: its own worst case + recordRun's, each one `DB_CALL_TIMEOUT_MS` call. @internal */
export const PRUNE_MIN_HEADROOM_MS = 2 * DB_CALL_TIMEOUT_MS;

/** The newest FINAL SB row + the `estimated` rows after it dated before `asOf`, oldest→newest; no FINAL row ⇒ no tail. */
function relinkTail(series: readonly SeriesPoint[] | undefined, asOf: string): { base?: SeriesPoint; tail: SeriesPoint[] } {
  const rows = series ?? [];
  const i = rows.findLastIndex((r) => r.estimated !== true);
  return i < 0 ? { tail: [] } : { base: rows[i], tail: rows.slice(i + 1).filter((r) => r.date < asOf) };
}

export interface StoredRows {
  globalStoredReadings: StoredReading[];
  downsideStoredReadings: StoredReading[];
  rsStoredReadings: StoredReading[];
  sbStoredReadings: StoredReading[];
}

/** Mail the band only after a DELIVERED push (a suppressed or failed one cleared `pushedAt`); `force` bypasses that gate. @internal */
export const bandMailDue = (push: boolean, pushedAt: string | null, force: boolean | undefined): boolean =>
  (push && pushedAt !== null) || force === true;

export async function buildStoredRows(
  ctx: RunBase,
  alert: AlertRecord,
  prevDay: AlertRecord | null,
  globalReadings: Reading[],
  price: { downside: Reading[]; rs: Reading[] },
): Promise<StoredRows> {
  const { fetchDailyCloses } = ctx.feeds;
  const globalStoredReadings: StoredReading[] = toStoredReadings(globalReadings);
  // Downside-break detectors (DB_SMH) — persisted-but-don't-notify like the global rows (distinct DB_* ids, no NVDA collision).
  const downsideStoredReadings: StoredReading[] = toStoredReadings(price.downside);
  // EW rel-strength legs (RS_*) — persisted the same way.
  const rsStoredReadings: StoredReading[] = toStoredReadings(price.rs);
  // D9 live scoreboard: one SB_STRAT + one SB_BENCH NAV point per run, chain-linked EUR indexes persisted
  // as display-only rows (families exclude SB_* by omission). Strategy chains by the PREVIOUS DAY's
  // `prevDay.heldSleeve` (intraday must not fork the daily chain; cash/null ⇒ flat); benchmark chains the
  // ACWI proxy (USD→EUR). Own fetches. ANY failure ⇒ NO SB rows this run (chain resumes next run), never
  // aborts the core; an id with no prior SB row seeds at NAV_BASE.
  // Intraday: NO SB rows — the chain only writes when `link > prev.date`, so an in-progress NAV for today
  // would never be replaced by the EOD run and every later NAV would compound off it.
  const sbStoredReadings = ctx.opts.intraday === true ? [] : await degrade<StoredReading[]>(
    "[SB] scoreboard NAV chain unavailable - no SB rows this run",
    "trace",
    [],
    async () => {
      const asOf = alert.date;
      // One bulk read, not two serial getSeries round trips (2 × GAP_FILL_DAYS rows, one IN(...), never the truncation fallback).
      const sbPrior = await ctx.store.getSeriesBulk([SB_STRAT_ID, SB_BENCH_ID], { limit: GAP_FILL_DAYS });
      const prevStrat0 = (sbPrior.get(SB_STRAT_ID) ?? []).at(-1);
      const prevBench0 = (sbPrior.get(SB_BENCH_ID) ?? []).at(-1);
      if (!prevStrat0 && !prevBench0) {
        return scoreboardNavRows({ asOf, prevStrat: prevStrat0, prevBench: prevBench0, prior: { heldSleeve: null, r4Phase: null }, fx: [], benchCloses: [], legCloses: [] });
      }
      // Known approximation: across a degraded-SB gap this chains prevSB(t−2)→t but attributes the span to t−1's prescription. Bounded, rare, display-only.
      const prior = { heldSleeve: prevDay?.heldSleeve ?? null, r4Phase: prevDay?.r4Phase ?? null };
      const closes = new Map<string, Promise<Observation[]>>();
      // The prior held leg's closes are needed only when the chain moves (prior row, non-cash, known sleeve); an unknown sleeve fetches nothing (nextNav throws into degrade).
      const legClosesOf = (p: { heldSleeve: string | null; r4Phase: string | null }): Promise<Observation[]> => {
        const leg: LegQuote | undefined =
          p.heldSleeve !== null && Object.hasOwn(LEG_TICKER, p.heldSleeve) ? (LEG_TICKER as Record<string, LegQuote>)[p.heldSleeve] : undefined;
        if (p.r4Phase === "cash" || leg === undefined) return Promise.resolve([]);
        if (!closes.has(leg.ticker)) closes.set(leg.ticker, fetchDailyCloses(leg.ticker, { now: () => Date.parse(ctx.runAt), env: ctx.env }));
        return closes.get(leg.ticker)!;
      };
      // Defect 3: EURUSD=X's D-1 null bar fills from the stored `DEXUSEU`
      // row, so a USD leg converts at its own date's FX, not the previous FX close.
      const [fx, benchCloses, legCloses] = await Promise.all([
        withStoredLegs(ctx.store, ["EURUSD=X"], (symbol) => fetchDailyCloses(symbol, { now: () => Date.parse(ctx.runAt), env: ctx.env }), TAIL_DAYS, {
          now: new Date(ctx.runAt),
          onFail: (scope, reason) => recordDegrade(scope, reason, "trace"),
        })("EURUSD=X"),
        fetchDailyCloses("ACWI", { now: () => Date.parse(ctx.runAt), env: ctx.env }),
        prevStrat0 !== undefined ? legClosesOf(prior) : Promise.resolve<Observation[]>([]),
      ]);
      // the trailing `estimated` rows re-derive oldest→newest off the newest FINAL row, each written FINAL; the walk stops at the
      // first date still estimate-sourced or failing (a throw/missing close also degrades) — it and later rows keep their estimate.
      type Step = { inputs: Observation[][]; ratio: (from: string, to: string) => number };
      const stopped = new Set<string>();
      const relinkWalk = async (id: string, step: (date: string) => Promise<Step>): Promise<StoredReading[]> => {
        const { base, tail } = relinkTail(sbPrior.get(id), asOf);
        const out: StoredReading[] = [];
        let level: { date: string; value: number } | undefined = base;
        for (const d of tail) {
          if (level === undefined) break;
          try {
            const { inputs, ratio } = await step(d.date);
            if (estimateDatesOf(...inputs).includes(d.date)) {
              stopped.add(id);
              break;
            }
            const row = navReadingRow(id, d.date, level.value * ratio(level.date, d.date));
            out.push(row);
            level = row;
          } catch (e) {
            recordDegrade(`[SB] ${id} re-link stopped - estimate rows stay estimated`, `${d.date}: ${errMsg(e)}`, "trace");
            stopped.add(id);
            break;
          }
        }
        return out;
      };
      const start = { startAtOrBefore: true };
      const relinked = [
        // Each step held the sleeve prescribed before its date (that run's `prevDay`): one alert read per walked date.
        ...(await relinkWalk(SB_STRAT_ID, async (date) => {
          const a = await ctx.store.getLastAlertBefore(date);
          const p = { heldSleeve: a?.heldSleeve ?? null, r4Phase: a?.r4Phase ?? null };
          const leg = await legClosesOf(p);
          return { inputs: [fx, leg], ratio: (from, to) => nextNav(1, leg, fx, from, to, p, start) };
        })),
        ...(await relinkWalk(SB_BENCH_ID, async () => ({
          inputs: [fx, benchCloses],
          ratio: (from, to) => chainedRatio(benchCloses, fx, from, to, "USD", start),
        }))),
      ];
      // A walk stopped short leaves the stored newest (`estimated`) row as the chain's head, so the new row chains off it.
      const levelOf = (id: string, p: SeriesPoint | undefined) => (stopped.has(id) ? p : (relinked.findLast((r) => r.indicatorId === id) ?? p));
      const [stratLevel, benchLevel] = [levelOf(SB_STRAT_ID, prevStrat0), levelOf(SB_BENCH_ID, prevBench0)];
      // Rows date at the newest close ALL needed inputs share (≤ asOf, `chainLinkDate`). A closes provider meta close stamps the row whose
      // value it moves `estimated` (leg/FX → SB_STRAT, ACWI/FX → SB_BENCH); the re-linked rows above are never stamped.
      const rows = scoreboardNavRows({ asOf, prevStrat: stratLevel, prevBench: benchLevel, prior, fx, benchCloses, legCloses });
      const est = new Map([[SB_STRAT_ID, new Set(estimateDatesOf(fx, legCloses))], [SB_BENCH_ID, new Set(estimateDatesOf(fx, benchCloses))]]);
      // A row chained off a still-`estimated` level is itself estimated, so the next run's trailing walk re-links it too.
      for (const [id, lv] of [[SB_STRAT_ID, stratLevel], [SB_BENCH_ID, benchLevel]] as const) {
        if (lv?.estimated === true) for (const r of rows) if (r.indicatorId === id) est.get(id)!.add(r.date);
      }
      // `estimateAnchored`: a NAV estimate whose previous session holds no FINAL row (stored or re-linked) is never written.
      return dropUnanchoredEstimates([...relinked, ...stampEstimateSourced(rows, est)], sbPrior, ctx.runAt);
    },
  );
  return { globalStoredReadings, downsideStoredReadings, rsStoredReadings, sbStoredReadings };
}

type DegradeNote = Pick<DegradeEvent, "scope" | "reason">;

/** One persisted degrade event per provenance hop (keyed→keyless FRED, price provider→provider), ids listed, summaries deduped. @internal */
export function provenanceDegradeEvents(keyedFallbacks: readonly KeyedFallback[], providerHops: readonly ProviderFallback[]): DegradeNote[] {
  const events: DegradeNote[] = [];
  if (keyedFallbacks.length > 0) {
    const summaries = [...new Set(keyedFallbacks.map((f) => f.summary))];
    events.push({
      scope: `[fred] keyed API fell back to keyless CSV (${keyedFallbacks.length} series)`,
      reason: `${keyedFallbacks.map((f) => f.series).join(", ")} - ${summaries.join(" | ")}`,
    });
  }
  // One event per distinct from→to pair, in first-seen order.
  const hopsByPair = new Map<string, typeof providerHops>();
  for (const h of providerHops) {
    const key = `${h.from}→${h.to}`;
    hopsByPair.set(key, [...(hopsByPair.get(key) ?? []), h]);
  }
  for (const hits of hopsByPair.values()) {
    const { from, to } = hits[0]!;
    const summaries = [...new Set(hits.map((h) => h.summary))];
    events.push({
      scope: `[prices] ${from} fell back to ${to} (${hits.length} symbol${hits.length === 1 ? "" : "s"})`,
      reason: `${hits.map((h) => h.symbol).join(", ")} - ${summaries.join(" | ")}`,
    });
  }
  return events;
}

/** E3, in place: an id whose stored newest is `estimated` (no print) is guarded against the newest PRINT beneath it. @internal */
export async function printsBeneathEstimates(store: Pick<Store, "getSeries">, newestStored: Map<string, SeriesPoint[]>): Promise<void> {
  for (const [id, pts] of newestStored) if (pts[0]?.estimated === true) newestStored.set(id, await getPrintSeries(store, id, 1));
}

/** A row OLDER than its id's stored newest print is replaced by that print (one event each); a provisional newest is never carried. @internal */
export function carryRegressedRows(rows: readonly StoredReading[], newestStored: ReadonlyMap<string, readonly SeriesPoint[]>): { rows: StoredReading[]; events: DegradeNote[] } {
  const events: DegradeNote[] = [];
  const out = rows.map((r) => {
    const newest = newestStored.get(r.indicatorId)?.[0];
    // A provisional (intraday) newest print is never carried: re-stamping it with this run's run_at finalizes it.
    if (!newest || r.date >= newest.date || isProvisional(newest, r.indicatorId)) return r;
    events.push({ scope: `[monotonicity] ${r.indicatorId} obs_date regressed - carried stored row forward`, reason: `run ${r.date} < stored ${newest.date}` });
    return { date: newest.date, indicatorId: r.indicatorId, value: newest.value, delta20: newest.delta20, rawState: newest.rawState, state: newest.state, decision: newest.decision, bandCuts: newest.bandCuts ?? null };
  });
  return { rows: out, events };
}

/** Intraday: a past-date `heldIds` row over an EARLIER run's FINAL print on that date (estimated: `printsBeneathEstimates`) is replaced
 *  by that print, written at this run's runAt so the run-keyed board keeps the id; event iff the value differs. */
function holdFinalRows(rows: readonly StoredReading[], newestStored: ReadonlyMap<string, readonly SeriesPoint[]>, runAt: string, heldIds: ReadonlySet<string>): { rows: StoredReading[]; events: DegradeNote[] } {
  const events: DegradeNote[] = [];
  const [today, seamAt] = [runAt.slice(0, 10), Date.parse(seamRunAt(runAt))];
  const out = rows.map((r) => {
    const newest = newestStored.get(r.indicatorId)?.[0];
    if (!heldIds.has(r.indicatorId) || r.date >= today || !newest || newest.date !== r.date || isProvisional(newest, r.indicatorId)) return r;
    if (newest.runAt === undefined || Date.parse(newest.runAt) >= seamAt) return r;
    if (r.value !== newest.value) events.push({ scope: `[final-hold] ${r.indicatorId} intraday row differs from the FINAL row - stored row carried`, reason: `${r.date}: run ${r.value} vs stored ${newest.value}` });
    return { date: newest.date, indicatorId: r.indicatorId, value: newest.value, delta20: newest.delta20, rawState: newest.rawState, state: newest.state, decision: newest.decision, bandCuts: newest.bandCuts ?? null };
  });
  return { rows: out, events };
}

/** EOD post-tail write: final `timings` + the post-drain events appended to `degraded`. Best-effort — never fails the run. */
export async function persistRunTrace(ctx: RunBase, alert: AlertRecord): Promise<void> {
  const timings = runTimings();
  if (timings) console.log(timingLine(timings));
  alert.timings = timings;
  alert.degraded = [...(alert.degraded ?? []), ...drainLateDegrades()];
  openTraceWindow(performance.now());
  try {
    const matched = await ctx.store.updateRunTrace(alert.firedAt, { timings, degraded: alert.degraded });
    if (matched === 0) console.warn(`[timing] post-tail trace matched no alert_log row at ${alert.firedAt}`);
  } catch (err) {
    console.warn(`[timing] post-tail trace not written: ${errMsg(err)}`);
  }
}

/** Never commit a reading OLDER than the stored newest — carry it forward; a failed read = no guard. */
async function guardPersistRows(ctx: RunBase, assembled: readonly StoredReading[]): Promise<StoredReading[]> {
  const guardIds = [...new Set(assembled.map((r) => r.indicatorId))];
  let newestStored = new Map<string, SeriesPoint[]>();
  try {
    newestStored = await ctx.store.getSeriesBulk(guardIds, { limit: 1 });
    await printsBeneathEstimates(ctx.store, newestStored);
  } catch (err) {
    recordDegrade(
      "[monotonicity] guard skipped this run - newest-stored read failed",
      errMsg(err),
      "trace",
    );
  }
  const guarded = carryRegressedRows(assembled, newestStored);
  // A non-primary (`finalRewriteHeld`) close never supersedes a past-date FINAL row on an intraday run; EOD rewrites.
  const heldIds = new Set([...ctx.fallbackClaims].filter(([sym]) => finalRewriteHeld(sym)).flatMap(([, ids]) => [...ids]));
  // A reading scored off an `estimated` obs (a quote, a proxy carry — `headObs`) is stored `estimated`, daytime included.
  // Stamped BEFORE the hold: a carried FINAL row is never stamped `estimated`.
  const stamped = stampEstimateSourced(guarded.rows, ctx.estimateSourced);
  const held = ctx.opts.intraday === true ? holdFinalRows(stamped, newestStored, ctx.runAt, heldIds) : { rows: stamped, events: [] };
  for (const e of [...guarded.events, ...held.events]) recordDegrade(e.scope, e.reason, "trace");
  return held.rows;
}

/** Prune shadowed vintages (the cron only INSERTs). EOD only; `null` ids = GC scope, never this run's writes (a write-scoped
 *  id could be excluded forever). A throw is a `trace` event on `degraded` (`/lab` marks it), never pushed.
 *  ⚠ CRON_PRUNE_RETAIN_DAYS is mandatory: unfloored, it deletes yesterday's provenance nightly. `pinAlertRuns: false` — the
 *  ONLY opt-out (`fired_at` on every run would make this GC a no-op). `since` frontier keeps it under the 8 s statement cap.
 *  ⚠ LATENCY: it precedes recordRun, so with < PRUNE_MIN_HEADROOM_MS left to the hard deadline it is SKIPPED (recorded):
 *  the alert row outranks a GC the next run's frontier redoes. */
async function pruneShadowedOnCron(ctx: RunBase): Promise<void> {
  if (ctx.opts.intraday === true) return;
  if ((ctx.opts.msUntilHardDeadline?.() ?? runMsUntilHardDeadline(performance.now())) < PRUNE_MIN_HEADROOM_MS) {
    const reason = "skipped - too close to the run hard deadline";
    console.warn(`${PRUNE_DEGRADE_SCOPE}: ${reason}`);
    recordDegrade(PRUNE_DEGRADE_SCOPE, reason, "trace");
    return;
  }
  const since = new Date(Date.parse(ctx.runAt) - CRON_PRUNE_FRONTIER_DAYS * 86_400_000).toISOString();
  const pruned = await degrade(PRUNE_DEGRADE_SCOPE, "trace", 0, () => ctx.store.pruneShadowedReadings(null, CRON_PRUNE_RETAIN_DAYS, false, since));
  if (pruned > 0) console.log(`Pruned ${pruned} shadowed reading vintage row(s).`);
}

export async function persistRun(
  ctx: RunBase,
  alert: AlertRecord,
  notification: { push: boolean; message: NtfyMessage },
  storedReadings: StoredReading[],
  trackStoredReadings: StoredReading[],
  { globalStoredReadings, downsideStoredReadings, rsStoredReadings, sbStoredReadings }: StoredRows,
  estimateRows: StoredReading[],
): Promise<"intraday-done" | "eod"> {
  // Keyed→keyless FRED fallbacks folded into ONE `trace` event (a keyed fallback is HOW data arrived, not a bad
  // signal; collector rationale: fred.ts `drainKeyedFallbacks`). Dedup on the SERIES-FREE summary.
  for (const e of provenanceDegradeEvents(ctx.feeds.drainKeyedFallbacks(), ctx.feeds.drainProviderFallbacks())) recordDegrade(e.scope, e.reason, "trace");
  const assembledStoredReadings = [...storedReadings, ...trackStoredReadings, ...globalStoredReadings, ...downsideStoredReadings, ...rsStoredReadings, ...sbStoredReadings];

  const persistedReadings = await guardPersistRows(ctx, assembledStoredReadings);

  // The estimate rows' `run_at`: 1 ms past firedAt (off /status's run-keyed read) — the EOD cleaner's re-stamp shares it.
  const stampAt = new Date(Date.parse(ctx.runAt) + 1).toISOString();
  // E3: the estimate rows at `stampAt`; then I6 deletes every OLDER run's estimate on this run's estimate dates (the intraday
  // head included), so repeat runs replace rather than stack. Returns id → the dates this run holds an `estimated` row on:
  // its persisted (recordRun/recordIntradayRun/recordReadings) estimate-sourced readings always, the estimate rows only once their insert
  // landed — so the EOD cleaner never re-stamps a head over an estimate that DID land, nor deletes one for an estimate that
  // never did. A provisional non-estimate head shadowing one is the cleaners' (`sweepEodRows`, `clearShadowedHeads`).
  // The intraday branch records its warn-only steps (`trace`, post-drain ⇒ the slot's late rewrite); the EOD calls run after `recordRun`, console only.
  const traceFail = (scope: string, reason: string): void => recordDegrade(scope, reason, "trace");
  const afterRecord = (): void => undefined;
  const writeEstimateRows = async (onFail: (scope: string, reason: string) => void): Promise<Map<string, Set<string>>> => {
    const datesOf = (rows: readonly StoredReading[]): Map<string, Set<string>> => {
      const m = new Map<string, Set<string>>();
      for (const r of rows) m.set(r.indicatorId, (m.get(r.indicatorId) ?? new Set()).add(r.date));
      return m;
    };
    const persisted = persistedReadings.filter((r) => r.estimated === true);
    const dates = datesOf([...estimateRows, ...persisted]);
    if (dates.size === 0) return dates;
    let inserted = estimateRows.length === 0;
    try {
      if (estimateRows.length > 0) await ctx.store.recordReadings(estimateRows, stampAt);
      inserted = true;
      for (const [id, ds] of dates) await ctx.store.deleteEstimatesOnDates(id, [...ds], ctx.runAt);
    } catch (err) {
      console.warn(`[nowcast] estimate rows not written/deduped: ${errMsg(err)}`);
      onFail("[nowcast] estimate rows not written/deduped", errMsg(err));
    }
    return inserted ? dates : datesOf(persisted);
  };
  await pruneShadowedOnCron(ctx);
  // E3 + `estimateAnchored` — THE persisted-estimate gate: superseded and unanchored estimates die, intraday too; EOD after the cleaner below.
  const sweepDailyRoster = async (onFail: (scope: string, reason: string) => void): Promise<void> => {
    try {
      await sweepRosterEstimates(ctx.store, ANCHOR_ROSTER, GAP_FILL_DAYS + NOWCAST_MAX_CARRY_DAYS);
    } catch (err) {
      console.warn(`[estimate-sweep] daily-roster read failed - superseded/unanchored rows linger: ${errMsg(err)}`);
      onFail("[estimate-sweep] daily-roster read failed - superseded/unanchored rows linger", errMsg(err));
    }
  };
  // INTRADAY: readings only — no alert row (the commit point every notify/scoring baseline reads), no
  // email; of the post-persist seeds only the intraday tail (input series + pre-today leg closes). The EOD run's rows supersede these per obs_date (`readings_latest`).
  if (ctx.opts.intraday === true) {
    // L1: the assembled verdict goes to the `intraday_verdict` slot (never `alert_log`) — what `/lab`, `/status`
    // and `/api/exposure` serve (`servedVerdict`) — in ONE transaction with the readings (`recordIntradayRun`), so
    // new readings never sit beside an older run's verdict and the slot marks the commit (`scripts/smoke-cron.sh`).
    // `rederive: false` = readings only: the slot is emptied instead, best-effort. A throw here fails the run, as `recordRun` does.
    alert.degraded = drainDegradeLog();
    if (ctx.opts.rederive === false) {
      await ctx.store.recordReadings(persistedReadings, ctx.runAt);
      try {
        await ctx.store.clearIntradayVerdict();
      } catch (err) {
        console.warn(`[intraday] verdict slot not cleared - verdict reads serve a stale vintage: ${errMsg(err)}`);
      }
    } else await ctx.store.recordIntradayRun(persistedReadings, ctx.runAt, alert);
    const written = await writeEstimateRows(traceFail);
    // Daytime, an older run's provisional non-estimate head would shadow this run's estimate: the cleaner's shadowing rule
    // only. A date this run itself wrote a non-estimate row on is left out (that row is this run's own reading).
    for (const r of persistedReadings) if (r.estimated !== true) written.get(r.indicatorId)?.delete(r.date);
    try {
      await clearShadowedHeads(ctx.store, written, GAP_FILL_DAYS);
    } catch (err) {
      console.warn(`[shadow-sweep] roster read failed - a provisional head may shadow an estimate: ${errMsg(err)}`);
      traceFail("[shadow-sweep] roster read failed - a provisional head may shadow an estimate", errMsg(err));
    }
    await sweepDailyRoster(traceFail);
    // A degrade the post-commit steps above recorded reaches the slot's `degraded` trace by a best-effort
    // rewrite — the intraday twin of EOD's `persistRunTrace` (the committed verdict itself is unchanged).
    const late = drainLateDegrades();
    if (ctx.opts.rederive !== false && late.length > 0) {
      alert.degraded = [...alert.degraded, ...late];
      try {
        if ((await ctx.store.rewriteIntradayVerdict(alert)) === 0) console.warn(`[intraday] slot trace not rewritten - a newer run holds the slot`);
      } catch (err) {
        console.warn(`[intraday] slot trace not rewritten - ${late.length} post-commit degrade(s) missing from it: ${errMsg(err)}`);
      }
    }
    // C3: the intraday seed tail (input series + pre-today leg closes); its provisional D is "missing" to the EOD seed (A7), so rewritten.
    if (ctx.opts.deferIntradaySeed !== true) await runIntradaySeedTail(ctx.store, ctx.env, ctx.clock, ctx.feeds);
    return "intraday-done";
  }
  // Every degrade recorded before this line persists here; a later one rides only `persistRunTrace`'s post-tail write.
  alert.degraded = drainDegradeLog();
  await ctx.store.recordRun(persistedReadings, ctx.runAt, alert);
  const estimated = await writeEstimateRows(afterRecord);
  // L1: the EOD row supersedes any daytime verdict — empty the slot (best-effort; `/lab` also compares `firedAt`).
  try {
    await ctx.store.clearIntradayVerdict();
  } catch (err) {
    console.warn(`[intraday] verdict slot not cleared: ${errMsg(err)}`);
  }
  // Email fan-out — placed AFTER recordRun (persist first; a hanging Brevo could hit maxDuration). Runs only
  // after a DELIVERED push (a failed push re-asserts next run, so no subscriber gets a band the owner didn't).
  // Own try/catch (best-effort).
  if (bandMailDue(notification.push, alert.pushedAt, ctx.opts.forceEmail)) {
    try {
      const recipients = await ctx.store.listSubscriberEmails();
      const r = await ctx.notify.sendBandEmail(notification.message, recipients, { env: ctx.env });
      const tag = ctx.opts.forceEmail === true ? " (forced)" : "";
      if (r.skipped === null) console.log(`[email] band mail${tag}: ${r.sent} sent, ${r.failed} failed`);
      else console.log(`[email] band mail${tag} skipped: ${r.skipped}`);
    } catch (err) {
      console.error(`[email] band mail fan-out FAILED (row untouched): ${errMsg(err)}`);
    }
  }

  // Stamp per-id code vintages after the persist; fail-safe (an unstamped run re-reads as drift ⇒ one idempotent restate), so never abort the tail.
  try {
    await ctx.store.recordScorerVintage(codeVintages(new Date(ctx.runAt)));
  } catch (err) {
    console.warn(`[vintage] scorer-vintage stamp skipped this run: ${errMsg(err)}`);
  }

  // The ONE EOD cleaner (`sweepEodRows`) — superseded estimates die, a provisional head shadowing this run's estimate
  // goes, every other provisional non-estimate head dated ≤ D is re-stamped as this run's estimate (an `estimated` head keeps
  // its own run_at). After `writeEstimateRows` (it classifies
  // off this run's estimates) and the fetch-phase gap-fills (they finalize every date the feed re-printed); BEFORE the daily-roster sweep.
  try {
    await sweepEodRows(
      ctx.store,
      [...provisionalRoster(), ...ESTIMATE_ROW_IDS, ...quoteRepairIds(), ...ctx.estimateSourced.keys(), ...persistedReadings.map((r) => r.indicatorId)],
      GAP_FILL_DAYS + NOWCAST_MAX_CARRY_DAYS,
      { today: ctx.firedDateIso, firedAt: ctx.runAt, stampAt, estimated, keepRunAt: eodKeepRunAt() },
    );
  } catch (err) {
    console.warn(`[eod-sweep] roster read failed - superseded/provisional rows linger: ${errMsg(err)}`);
  }
  await sweepDailyRoster(afterRecord);
  return "eod";
}
