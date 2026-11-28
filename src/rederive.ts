/** Re-derive an EOD verdict over official closes: twin A = the run
 *  as stored, twin B = each `estimated` row swapped for the served official row of the SAME (id, date). Reads only. */

import { isDeepStrictEqual } from "node:util";
import { DOWNSIDE_DETECTOR_IDS, RS_LEG_IDS, SLOW_INDICATOR_IDS } from "./registry-price.js";
import type { Reading } from "./domain-types.js";
import type { AlertRecord, SeriesPoint, SeriesRange, Store, StoredReading } from "./store.js";
import type { AlertLevel } from "./ladder.js";
import { utcFiredDate } from "./store-rows.js";
import { reconstructReadings } from "./lab-assembly.js";
import { assembleDial, type PersistedPanel } from "./dial-assembly.js";
import { assembleRun } from "./run-core.js";
import { fromRunInputs, type AssembleRunOpts, type RunInputs } from "./run-inputs.js";
import { GAP_FILL_DAYS, isProvisional } from "./intraday.js";
import { withEstimateHeads } from "./estimated.js";
import { GATE_FAILED_ESTIMATORS } from "./nowcast-score.js";
import { errMsg } from "./err-msg.js";
import { mapLimit } from "./map-limit.js";
import { isoDay } from "./dates.js";
import { recordDegrade } from "./tracks.js";
import { RUN_FETCH_BUDGET_MS, RUN_HARD_DEADLINE_MS } from "./fetch-budget.js";

type RederiveStore = Pick<Store, "getAlertAt" | "getLastAlertBefore" | "getLastBandBefore" | "getReadingsForRun" | "getSeries" | "getSeriesBulk">;
type SeriesStore = Pick<Store, "getSeries" | "getSeriesBulk">;
type Pinned = ReadonlyMap<string, ReadonlyMap<string, SeriesPoint>>;

// Persisted beside the run's readings but never in its notify/global sets (`buildStoredRows`, the track rows).
const SIDE_IDS: ReadonlySet<string> = new Set([...DOWNSIDE_DETECTOR_IDS, ...RS_LEG_IDS]);
const TRACK_CHANNELS: ReadonlySet<string> = new Set(["SLOW", "PENSION", "BOTTOM"]);
const key = (id: string, date: string) => `${id}|${date}`;
const verdictView = (a: AlertRecord) => JSON.parse(JSON.stringify({ level: a.level, dialBand: a.dialBand, dialState: a.dialState ?? null, displayDialState: a.displayDialState ?? null })) as unknown;
// The panel's states only: `cissHistory` holds raw values + vintage stamps, so any swap would differ there.
const states = (p: PersistedPanel | null | undefined) => p && { globalPanel: p.globalPanel, displayPanel: p.displayPanel, heldMemberState: p.heldMemberState };
/** The twins agree iff band, notify dial + panel AND display dial + panel all match. @internal */
export const twinsAgree = (a: AlertRecord, b: AlertRecord): boolean =>
  a.level === b.level && a.dialBand === b.dialBand && isDeepStrictEqual(a.dialState, b.dialState) && isDeepStrictEqual(a.displayDialState ?? null, b.displayDialState ?? null) &&
  isDeepStrictEqual(states(a.panelState), states(b.panelState)) && isDeepStrictEqual(states(a.displayPanelState), states(b.displayPanelState));
const servedView = (a: AlertRecord) => ({ at: Date.parse(a.firedAt), verdict: verdictView(a) });

/** `store`'s series reads cut at `asOf`, with each `pinned` (id → date → point) served in place of its stored row. */
function seriesView(store: SeriesStore, asOf: string, pinned: Pinned = new Map()): SeriesStore {
  const cut = (range?: SeriesRange): SeriesRange => ({ ...range, to: range?.to != null && range.to < asOf ? range.to : asOf });
  const pin = (id: string, pts: SeriesPoint[]) => {
    const byDate = pinned.get(id);
    return byDate === undefined ? pts : pts.map((p) => byDate.get(p.date) ?? p);
  };
  return {
    getSeries: async (id, limit, range) => pin(id, await store.getSeries(id, limit, cut(range))),
    getSeriesBulk: async (ids, opts) => {
      const bulk = await store.getSeriesBulk(ids, { ...opts, range: cut(opts.range) });
      return new Map([...bulk].map(([id, pts]) => [id, pin(id, pts)]));
    },
  };
}

/** (id, date) → the served official row, for each `estimated` run row that has one now. Never a newer date. One bulk read at a
 *  time: each takes the store's newest-n RPC, and `rederiveOnWrite` already runs `VERDICT_CHECK_CONCURRENCY` of these at once. */
async function officialRows(store: SeriesStore, stored: readonly StoredReading[]): Promise<Map<string, SeriesPoint>> {
  const idsByDate = new Map<string, Set<string>>();
  for (const r of stored) if (r.estimated === true) idsByDate.set(r.date, (idsByDate.get(r.date) ?? new Set()).add(r.indicatorId));
  const out = new Map<string, SeriesPoint>();
  for (const [date, ids] of idsByDate) {
    const bulk = await store.getSeriesBulk([...ids], { limit: 1, range: { from: date, to: date } });
    for (const id of ids) {
      const p = bulk.get(id)?.at(-1);
      if (p !== undefined && p.date === date && p.estimated !== true && !isProvisional(p, id)) out.set(key(id, date), p);
    }
  }
  return out;
}

const swapStored = (r: StoredReading, p: SeriesPoint): StoredReading => {
  const { estimated: _estimated, ...rest } = r;
  return { ...rest, value: p.value, delta20: p.delta20, rawState: p.rawState, state: p.state, decision: p.decision ?? null, bandCuts: p.bandCuts ?? null };
};
const swapReading = (r: Reading, p: SeriesPoint): Reading =>
  ({ ...r, level: p.value, delta20: p.delta20, rawState: p.rawState, state: p.state, decision: p.decision ?? null, bandCuts: p.bandCuts ?? null });

// `slow` = the SLOW track's legs: dial rows only (the display panel lists them), never `assembleRun`'s readings.
interface Split { notify: Reading[]; global: Reading[]; side: Reading[]; slow: Reading[] }
function split(readings: readonly Reading[], globalIds: ReadonlySet<string>): Split {
  const out: Split = { notify: [], global: [], side: [], slow: [] };
  for (const r of readings) {
    if (SLOW_INDICATOR_IDS.has(r.indicator.id)) out.slow.push(r);
    if (TRACK_CHANNELS.has(r.indicator.channel)) continue;
    (SIDE_IDS.has(r.indicator.id) ? out.side : globalIds.has(r.indicator.id) ? out.global : out.notify).push(r);
  }
  return out;
}

type RunBase = Omit<AssembleRunOpts, "readings" | "globalReadings" | "dial" | "globalFamilies" | "cissHistory" | "panelState" | "displayDialState" | "displayPanelState">;

/** One twin: the notify + display dials over `view` (`run-cycle-dial.ts`'s two calls), then `assembleRun`. `heads` fold
 *  as there (`withEstimateHeads`): the notify dial bar `GATE_FAILED_ESTIMATORS`, the display dial all. */
async function twin(view: SeriesStore, asOf: string, slowArmed: boolean, base: RunBase, { notify, global, side, slow }: Split, heads: readonly StoredReading[]): Promise<AlertRecord> {
  const all = [...notify, ...global, ...side, ...slow];
  const rows = (hs: readonly StoredReading[]) =>
    (withEstimateHeads(all, hs, (r) => r) ?? all).map((r) => ({ id: r.indicator.id, state: r.state, lag: r.lag, factor: r.indicator.geoFactor }));
  // A twin on a failed member-history read is not comparable: throw, so the caller keeps the served row and records the degrade.
  const onCissReadError = (_ids: readonly string[], err: unknown): never => { throw err instanceof Error ? err : new Error(errMsg(err)); };
  const notifyToday = utcFiredDate(base.now);
  const d = await assembleDial({ readings: rows(heads.filter((h) => !GATE_FAILED_ESTIMATORS.has(h.indicatorId))), asOf, store: view, slowArmed, notifyToday, onCissReadError });
  const display = await assembleDial({ readings: rows(heads), asOf, store: view, slowArmed, onCissReadError });
  const panel = (x: typeof d): PersistedPanel => ({ globalPanel: x.globalPanel, displayPanel: x.displayPanel, cissHistory: x.cissHistory, heldMemberState: x.heldMemberState });
  return assembleRun({
    ...base, readings: notify, globalReadings: global, dial: d.dial, globalFamilies: d.globalPanel, cissHistory: d.cissHistory,
    panelState: panel(d), displayDialState: display.dial, displayPanelState: panel(display),
  }).alert;
}

const nextDay = (date: string): string => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000));

/** A ref's row; one `deleteRederived` dropped (a superseding prev-day) falls back to the row served for its fired-date now. */
async function refRow(store: RederiveStore, firedAt: string | null): Promise<AlertRecord | null> {
  if (firedAt === null) return null;
  const row = await store.getAlertAt(firedAt);
  if (row !== null) return row;
  const day = utcFiredDate(firedAt);
  const served = await store.getLastAlertBefore(nextDay(day));
  if (served === null || utcFiredDate(served.firedAt) !== day) throw new Error(`rederiveVerdict: run_inputs ref ${firedAt} has no alert_log row on ${day}`);
  return served;
}

/** Per-run state no stored reading reproduces — a row without `run_inputs` keeps the original's. */
const frozenFields = (o: AlertRecord): Partial<AlertRecord> => ({
  heldSleeve: o.heldSleeve, reriskConfirmCount: o.reriskConfirmCount, heldDays: o.heldDays,
  cashOverlay: o.cashOverlay, cashOverlaySince: o.cashOverlaySince, cashOverlayReason: o.cashOverlayReason,
  fallShape: o.fallShape, fallVelocity: o.fallVelocity, creditDwellCloses: o.creditDwellCloses,
  r4Phase: o.r4Phase, r4EntryFiredAt: o.r4EntryFiredAt, r4ReentryRung: o.r4ReentryRung,
  slowScore: o.slowScore, slowBand: o.slowBand, slowMaxScore: o.slowMaxScore, bottomState: o.bottomState, vix: o.vix, vix3m: o.vix3m, ratio: o.ratio,
});

/** The superseding row's fired_at: +1 ms is the run's own estimate/carry stamp (`persistRun`'s `stampAt`). @internal */
export const supersedingFiredAt = (firedAt: string): string => new Date(Date.parse(firedAt) + 2).toISOString();

/** What a re-derive reads of `orig`'s run: its row, its readings, and the estimate heads its dials folded. */
interface RunEvidence {
  full: AlertRecord;
  ri: RunInputs | null;
  storedA: StoredReading[];
  headsA: StoredReading[];
  stampAt: string;
  /** False when the heads came from `readings` at `stampAt` — rows the cleaners may since have deleted. */
  headsStored: boolean;
}

async function loadRun(store: RederiveStore, orig: AlertRecord): Promise<RunEvidence> {
  const full = await store.getAlertAt(orig.firedAt, { withPanel: true, withRunInputs: true });
  if (full === null) throw new Error(`rederiveVerdict: no alert_log row at ${orig.firedAt}`);
  const ri: RunInputs | null = full.runInputs ?? null;
  // The run's estimate heads: `run_inputs` when stored, else its `writeEstimateRows` rows 1 ms past firedAt.
  const stampAt = new Date(Date.parse(full.firedAt) + 1).toISOString();
  const [storedA, headsA] = await Promise.all([
    store.getReadingsForRun(full.firedAt),
    ri?.heads !== undefined
      ? ri.heads.map((h): StoredReading => ({ ...h, estimated: true }))
      : store.getReadingsForRun(stampAt).then((rs) => rs.filter((r) => r.estimated === true)),
  ]);
  return { full, ri, storedA, headsA, stampAt, headsStored: ri?.heads !== undefined };
}

export type RederiveResult =
  | { kind: "agree" }
  | { kind: "superseded"; alert: AlertRecord; readings: StoredReading[] }
  /** No stored heads and none left in `readings`, while a superseding row is served: never revert it on missing evidence. */
  | { kind: "unverifiable"; reason: string };

/** The superseding row for `orig` (`supersedingFiredAt`, `rederivedFrom`, never pushed), or null when the twins agree.
 *  Throws on an unverifiable row — callers that must tell it apart use `rederiveRun`. */
export async function rederiveVerdict(store: RederiveStore, orig: AlertRecord): Promise<AlertRecord | null> {
  const out = await rederiveRun(store, orig);
  if (out.kind === "unverifiable") throw new Error(`rederiveVerdict: ${out.reason}`);
  return out.kind === "superseded" ? out.alert : null;
}

/** `rederiveVerdict` plus twin B's reading set — what `recordRun` persists beside the row so it serves a board. */
export async function rederiveRun(store: RederiveStore, orig: AlertRecord, evidence?: RunEvidence): Promise<RederiveResult> {
  const ev = evidence ?? (await loadRun(store, orig));
  const { full, ri, storedA, headsA, stampAt } = ev;
  const asOf = full.date;
  const official = await officialRows(store, [...storedA, ...headsA]);
  const swap = (r: StoredReading): StoredReading => {
    const p = official.get(key(r.indicatorId, r.date));
    return p === undefined ? r : swapStored(r, p);
  };
  const storedB = storedA.map(swap);
  const headsB = headsA.map(swap);
  // Twin A sees the run's own estimates on the swapped (id, date)s; B the official rows — the ONLY difference.
  const pinned = new Map<string, Map<string, SeriesPoint>>();
  for (const [r, runAt] of [...storedA.map((r) => [r, full.firedAt] as const), ...headsA.map((r) => [r, stampAt] as const)]) {
    if (!official.has(key(r.indicatorId, r.date))) continue;
    const { indicatorId: id, value, delta20, rawState, state, decision, bandCuts, date } = r;
    pinned.set(id, (pinned.get(id) ?? new Map()).set(date, { date, value, delta20, rawState, state, decision: decision ?? null, bandCuts: bandCuts ?? null, runAt, estimated: true }));
  }
  const globalIds: ReadonlySet<string> = ri !== null
    ? new Set((ri.globalReadings ?? []).map((g) => g.id))
    : new Set(reconstructReadings(storedA).filter((r) => r.indicator.channel === "GLOBAL").map((r) => r.indicator.id));
  const twins = [reconstructReadings(storedA), reconstructReadings(storedB)].map((rs) => split(rs, globalIds));
  const slowArmed = full.slowBand !== null && full.slowBand !== "CALM";

  // No run_inputs: the prev-day row + dial-band tail the cycle reads (`getLastAlertBefore`/`getLastBandBefore` on its fired date).
  const frozenBase = async (): Promise<RunBase> => {
    const day = utcFiredDate(full.firedAt);
    const [prevDay, lastDialBand] = await Promise.all([store.getLastAlertBefore(day), store.getLastBandBefore("dialBand", day)]);
    return { last: null, prevDay, lastPush: null, now: full.firedAt, geoFlags: full.geoFlags, recentDialBands: lastDialBand != null ? [lastDialBand as AlertLevel] : [] };
  };
  const frozen = ri === null ? await frozenBase() : null;
  const run = async (s: Split, heads: readonly StoredReading[], view: SeriesStore, swapGlobals: boolean): Promise<AlertRecord> => {
    if (ri === null) return twin(view, asOf, slowArmed, frozen!, s, heads);
    const [last, prevDay, lastPush] = await Promise.all([refRow(store, ri.refs.last), refRow(store, ri.refs.prevDay), refRow(store, ri.refs.lastPush)]);
    const { readings, globalReadings = [], ...replay } = fromRunInputs(ri, s.notify);
    const global = swapGlobals ? globalReadings.map((g) => { const p = official.get(key(g.indicator.id, g.date)); return p === undefined ? g : swapReading(g, p); }) : globalReadings;
    return twin(view, asOf, slowArmed, { ...replay, last, prevDay, lastPush, now: full.firedAt }, { notify: readings, global, side: s.side, slow: s.slow }, heads);
  };
  const a = await run(twins[0]!, headsA, seriesView(store, asOf, pinned), false);
  const b = await run(twins[1]!, headsB, seriesView(store, asOf), true);
  const same = twinsAgree(a, b);
  // Heads neither stored nor left in `readings` (the cleaners delete them): a served superseding row this run can't
  // reproduce may rest on heads now gone — never revert it on missing evidence.
  if (!ev.headsStored && headsA.length === 0) {
    const sup = await store.getAlertAt(supersedingFiredAt(full.firedAt));
    if (sup !== null && sup.rederivedFrom != null && (same || !isDeepStrictEqual(verdictView(sup), verdictView(b))))
      return { kind: "unverifiable", reason: `no estimate heads stored for ${full.firedAt} nor left in readings; served superseding row ${sup.firedAt} not reproduced` };
  }
  if (same) return { kind: "agree" };
  const alert: AlertRecord = {
    ...b,
    ...(ri === null ? frozenFields(full) : {}),
    date: asOf,
    firedAt: supersedingFiredAt(full.firedAt),
    rederivedFrom: full.firedAt,
    pushedAt: null,
    pushError: null,
    degraded: full.degraded,
    timings: full.timings ?? null,
    provisionalPushedAt: full.provisionalPushedAt ?? null,
    exposureState: full.exposureState ?? null,
    runInputs: ri,
  };
  return { kind: "superseded", alert, readings: storedB };
}

type ApplyStore = RederiveStore & Pick<Store, "deleteRederived" | "recordRun">;
export interface ApplyResult { row: AlertRecord | null; removed: number; unverifiable?: string }

/** Serve `orig`'s re-derive: any older superseding row (+ its readings) goes, a fresh one lands iff the twins disagree.
 *  Always from the ORIGINAL, so a repeat never stacks rows; never pushes; an unverifiable row is left untouched. */
export async function applyRederive(store: ApplyStore, orig: AlertRecord, evidence?: RunEvidence): Promise<ApplyResult> {
  const out = await rederiveRun(store, orig, evidence);
  if (out.kind === "unverifiable") return { row: null, removed: 0, unverifiable: out.reason };
  const removed = await store.deleteRederived(orig.firedAt);
  if (out.kind === "superseded") await store.recordRun(out.readings, out.alert.firedAt, out.alert);
  return { row: out.kind === "superseded" ? out.alert : null, removed };
}

export type OnWriteResult = ({ orig: AlertRecord } & ApplyResult) | { firedAt: string; error: string };

type OnWriteStore = ApplyStore & Pick<Store, "getRecentAlerts" | "getReadingVersions">;

// `swapStored`'s fields: a FINAL vintage equal on these swaps in nothing new.
const sameOfficial = (a: SeriesPoint, b: SeriesPoint): boolean =>
  a.value === b.value && a.delta20 === b.delta20 && a.rawState === b.rawState && a.state === b.state &&
  isDeepStrictEqual(a.decision ?? null, b.decision ?? null) && isDeepStrictEqual(a.bandCuts ?? null, b.bandCuts ?? null);

/** The vintage of `id` on `p.date` served before `checkedAt` — the newest non-estimate row then (`pickRecent`; a tie goes to the
 *  later insert) — is a FINAL row with `p`'s content: `p` swaps in nothing that check did not already read. */
async function seenBefore(store: Pick<Store, "getReadingVersions">, id: string, p: SeriesPoint, checkedAt: number): Promise<boolean> {
  let prior: SeriesPoint | undefined;
  let priorAt = -Infinity;
  for (const v of await store.getReadingVersions(id, p.date)) {
    const at = v.runAt === undefined ? NaN : Date.parse(v.runAt);
    if (v.estimated !== true && at < checkedAt && at >= priorAt) [prior, priorAt] = [v, at];
  }
  return prior !== undefined && !isProvisional(prior, id) && sameOfficial(prior, p);
}

/** Vintage reads `anyUnseen` issues at once — small, so it stops near the first unseen row instead of reading every fresh one. */
const VERSION_READ_BATCH = 3;

/** Some served official row (`officialRows`) is news to a check run at `checkedAt` (null = never checked): written at/after it, and
 *  not `seenBefore`. Only a row written since the check can be news, so the vintage reads are for those alone, a batch at a time,
 *  stopping at the first batch holding an unseen row. */
async function anyUnseen(store: Pick<Store, "getReadingVersions">, official: ReadonlyMap<string, SeriesPoint>, checkedAt: number | null): Promise<boolean> {
  if (checkedAt === null) return official.size > 0;
  const fresh = [...official].filter(([, p]) => p.runAt !== undefined && Date.parse(p.runAt) >= checkedAt);
  for (let i = 0; i < fresh.length; i += VERSION_READ_BATCH) {
    const seen = await Promise.all(fresh.slice(i, i + VERSION_READ_BATCH).map(([k, p]) => seenBefore(store, k.slice(0, k.lastIndexOf("|")), p, checkedAt)));
    if (seen.some((s) => !s)) return true;
  }
  return false;
}

/** Verdict checks in flight at once: each is a panel + run_inputs row read, 1–2 reading reads and a newest-n RPC per estimated
 *  date, and the Supabase statement timeout is shared — `GAP_FILL_DAYS` of them under one `Promise.all` timed it out. */
const VERDICT_CHECK_CONCURRENCY = 3;

/** Hard-deadline headroom a re-derive needs to START: the step runs in the fetch phase, so an apply begins only while the run is
 *  inside `RUN_FETCH_BUDGET_MS` — persist + the seed tail keep the rest of `RUN_HARD_DEADLINE_MS`, as that budget promises them. */
const REDERIVE_APPLY_MIN_HEADROOM_MS = RUN_HARD_DEADLINE_MS - RUN_FETCH_BUDGET_MS;

const NOT_WRITTEN = "superseding verdict not written - served row keeps the estimated closes";
/** The `[rederive]` degrade scope of a failed step (`run-cycle-dial.ts`): a run that recorded it checked no verdict. */
export const REDERIVE_STEP_FAILED_SCOPE = `[rederive] ${NOT_WRITTEN}`;
/** The `[rederive]` degrade scope of one verdict's failed check or re-derive (recorded by `rederiveOnWrite`), keyed by its ORIGINAL's
 *  fired_at (stable across a superseding row coming or going): a run that recorded it never checked that verdict. @internal */
export const rederiveFailedScope = (origFiredAt: string): string => `[rederive] ${origFiredAt}: ${NOT_WRITTEN}`;

/** The EOD cron trigger, writer-agnostic: every ORIGINAL row of the newest `GAP_FILL_DAYS` fired-dates whose estimated (id, date)s
 *  hold a FINAL row the last EOD run (the newest row, whose own step checked every older one) never read is re-derived, oldest first;
 *  one failing date never blocks the rest. A verdict the newest row's `degraded` says that step failed on (`rederiveFailedScope`,
 *  `REDERIVE_STEP_FAILED_SCOPE`) counts as never checked, so a failure retries on the next EOD instead of keeping its estimates.
 *  Each failing verdict is recorded here (`rederiveFailedScope`, notify) and returned — and so is each one a re-derive would start
 *  with under `REDERIVE_APPLY_MIN_HEADROOM_MS` left (`msUntilHardDeadline`): deferred, so the next EOD retries it. */
export async function rederiveOnWrite(store: OnWriteStore, msUntilHardDeadline: () => number): Promise<OnWriteResult[]> {
  const recent = await store.getRecentAlerts(GAP_FILL_DAYS);
  const newest = recent[0];
  const lastCheck = newest === undefined ? null : Date.parse(newest.rederivedFrom ?? newest.firedAt);
  const failed = new Set((newest?.degraded ?? []).map((e) => e.scope));
  const checkedBy = (origFiredAt: string): number | null =>
    failed.has(REDERIVE_STEP_FAILED_SCOPE) || failed.has(rederiveFailedScope(origFiredAt)) ? null : lastCheck;
  const attempt = async <T>(origFiredAt: string, f: () => Promise<T>): Promise<T | { firedAt: string; error: string }> => {
    try {
      return await f();
    } catch (err) {
      recordDegrade(rederiveFailedScope(origFiredAt), errMsg(err), "notify");
      return { firedAt: origFiredAt, error: errMsg(err) };
    }
  };
  // The checks only read, so they run concurrently (bounded) — and every one before any re-derive's writes (its readings re-stamp the
  // official closes at the superseding fired_at, a same-content vintage an older stamp would make a newer verdict's check read as seen).
  const checks = await mapLimit(recent, VERDICT_CHECK_CONCURRENCY, (served) => {
    const origFiredAt = served.rederivedFrom ?? served.firedAt;
    return attempt(origFiredAt, async () => {
      const orig = served.rederivedFrom == null ? served : await store.getAlertAt(served.rederivedFrom);
      if (orig === null) throw new Error(`superseding row ${served.firedAt} names a missing original ${served.rederivedFrom}`);
      const ev = await loadRun(store, orig);
      const fire = await anyUnseen(store, await officialRows(store, [...ev.storedA, ...ev.headsA]), served === newest ? null : checkedBy(origFiredAt));
      return { orig, ev, fire };
    });
  });
  const out: OnWriteResult[] = [];
  for (const c of checks.reverse()) {
    if ("error" in c) out.push(c);
    else if (c.fire) {
      const left = msUntilHardDeadline();
      if (left < REDERIVE_APPLY_MIN_HEADROOM_MS) {
        const error = `deferred - ${Math.round(left)} ms to the run hard deadline, under the ${REDERIVE_APPLY_MIN_HEADROOM_MS} ms a re-derive needs`;
        recordDegrade(rederiveFailedScope(c.orig.firedAt), error, "notify");
        out.push({ firedAt: c.orig.firedAt, error });
      } else out.push(await attempt(c.orig.firedAt, async () => ({ orig: c.orig, ...(await applyRederive(store, c.orig, c.ev)) })));
    }
  }
  return out;
}

/** Each fired-date's SERVED row (newest first, `limit` dates) beside its ORIGINAL — the CLI's and the probe's walk. */
export async function servedWithOriginals(store: Pick<Store, "getRecentAlerts" | "getAlertAt">, limit: number): Promise<Array<{ served: AlertRecord; orig: AlertRecord }>> {
  const out: Array<{ served: AlertRecord; orig: AlertRecord }> = [];
  for (const served of await store.getRecentAlerts(limit)) {
    const orig = served.rederivedFrom == null ? served : await store.getAlertAt(served.rederivedFrom);
    if (orig === null) throw new Error(`superseding row ${served.firedAt} names a missing original ${served.rederivedFrom}`);
    out.push({ served, orig });
  }
  return out;
}

/** The served row is what a re-derive over `orig` yields now: the fresh superseding row, or `orig` itself when null. */
export const servedMatches = (served: AlertRecord, orig: AlertRecord, fresh: AlertRecord | null): boolean =>
  isDeepStrictEqual(servedView(served), servedView(fresh ?? orig));
