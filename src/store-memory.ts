/**
 * `InMemoryStore` — the OPT-IN fake half of the persistence seam (design v4 §6.7), split out of
 * `store.ts` 2026-08-09 so the production module carries only `getStore()`, the `Store`
 * interface and `SupabaseStore`.
 *
 * It is a fake, not Postgres: constructed directly by tests, NEVER returned by `getStore()`
 * (which fails loud without `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` — pinned in
 * `store.pure-seams.test.ts` §"getStore — env selection"). Its job is to satisfy the SAME
 * `Store` contract as `SupabaseStore`, which `store.contract.test.ts` enforces by running one
 * assertion set over both implementations — so every method below is written to mirror a
 * specific SupabaseStore/SQL behaviour, and the comments name which.
 *
 * Dependency direction is one-way: this module imports `store.ts` (and `store-rows.ts` for the
 * shared `utcFiredDate` bucket key); neither must ever import it back.
 */

import { utcFiredDate } from "./store-rows.js";
import { pickRecent } from "./estimated.js";
import { isProvisional } from "./intraday.js";
import { estimateDatesById } from "./store-guards.js";
import { keep, pillarIds, readingIds, type RetainPolicy } from "./store-keep.js";
import { retainable } from "./retention.js";
import type { CashPriorRow } from "./cash-overlay.js";
import type {
  AlertReadOpts,
  AlertRecord,
  AlertSlice,
  CalibrationParam,
  DegradeEvent,
  LastBandField,
  LegPillarPoint,
  LegPillarRow,
  ScorerVintageRow,
  SeriesPoint,
  SeriesRange,
  Store,
  StoredOverride,
  StoredReading,
  WarmupRow,
} from "./store.js";
import type { T1DialResult } from "./t1dial.js";
import type { RunTimings } from "./fetch-budget.js";
import type { Observation } from "./domain-types.js";

/**
 * Newest-first view of the fake's alert log, mirroring `SupabaseStore`'s (`store.ts`) wire order
 * `.order(fired_at, desc).order(id, desc)`. Insertion index stands in for the identity PK, so a
 * tied `firedAt` resolves to the later insert — same winner the DB picks. Copies before sorting:
 * `this.alerts` is the fake's append-only log and callers read it directly in assertions.
 */
function sortedAlertsDesc(alerts: readonly AlertRecord[]): AlertRecord[] {
  return alerts
    .map((a, i) => ({ a, i }))
    // Compare as INSTANTS, not strings: fixtures write `…Z` while prod rows come back as
    // `…+00:00`, and those two spellings of the same moment don't compare lexicographically.
    .sort((x, y) => Date.parse(y.a.firedAt) - Date.parse(x.a.firedAt) || y.i - x.i)
    .map(({ a }) => a);
}

/**
 * Mirror the real store's opt-in `PANEL_COLUMNS` projection (P-1): a narrow (default) read returns a
 * record with NO `panelState`/`displayPanelState` key at all, so the fake and SupabaseStore agree
 * byte-for-byte (`store.contract.test.ts` runs both). A `withPanel` read keeps the panel keys as stored;
 * `run_inputs` likewise rides only a `withRunInputs` read (an unset record reads back as the column's null).
 */
function projectPanel(a: AlertRecord, opts?: AlertReadOpts): AlertRecord {
  const out: AlertRecord = { ...a };
  if (!opts?.withPanel) {
    delete out.panelState;
    delete out.displayPanelState;
  }
  if (opts?.withRunInputs) out.runInputs = a.runInputs ?? null;
  else delete out.runInputs;
  return out;
}

/**
 * The `leg_pillars` PRIMARY KEY as one comparable string — `(obs_date, sleeve,
 * super_group, generator)`, the exact 4-tuple `SupabaseStore.putLegPillars`' upsert (`store.ts`)
 * declares in its
 * `onConflict`. JSON-encoded so a separator can't collide with a member id.
 * Used by the fake to reproduce `ignoreDuplicates`.
 */
function legPillarKey(r: LegPillarRow): string {
  return JSON.stringify([r.obsDate, r.sleeve, r.superGroup, r.generator]);
}

/** The fake's stand-in for the DB server's `now()` — the external clock the SQL prune reads (an entry, like `wallClock`). */
const dbServerNow = (): number => Date.now();

/** Opt-in fake for pure-logic tests — never returned by getStore(). */
export class InMemoryStore implements Store {
  /** Row-retention policy every id-keyed write filters through (`keep`) — mirrors `SupabaseStore`'s. */
  private readonly retain: RetainPolicy;

  constructor(retain: RetainPolicy = retainable) {
    this.retain = retain;
  }

  readonly readings: Array<StoredReading & { runAt: string }> = [];
  /** `readings` grouped by indicatorId, extended lazily from the tail; any non-append change (an
   *  internal delete, a test's `readings.length = 0`) breaks the tail check and rebuilds it. */
  private readonly byId = new Map<string, Array<StoredReading & { runAt: string }>>();
  private byIdLen = 0;
  private byIdLast: unknown = undefined;
  readonly alerts: AlertRecord[] = [];
  readonly calibration: CalibrationParam[] = [];
  /** Test seam: push rows here to seed getOverrides (no app-side write path exists). */
  readonly overrides: StoredOverride[] = [];
  /** Replayed per-leg pillar rows, keyed on the same 4-tuple PK the table uses. */
  readonly legPillars: LegPillarRow[] = [];
  /** `readings_warmup` fake — keyed `${indicatorId}|${date}`, upsert semantics (feed wins). */
  readonly warmup = new Map<string, WarmupRow & { runAt: string }>();
  /** `scorer_vintage` fake — keyed on indicator_id, upsert semantics (last stamp wins). */
  readonly scorerVintage = new Map<string, ScorerVintageRow>();
  /**
   * Test seam (6.2): simulate a prod PostgREST `[api] max_rows` set LOWER than the assumed
   * cap (the silent-truncation cliff). When set, `maxRowsProbe`'s bounded select yields at
   * most this many rows; undefined ⇒ no server cap (returns min(count, assumedCap)).
   */
  maxRowsCap: number | undefined = undefined;
  /** `email_subscribers` fake — test seam: push addresses here (the browser is the only writer). */
  readonly subscribers: string[] = [];

  async recordReadings(readings: StoredReading[], runAt: string): Promise<void> {
    // `estimated: false` normalizes to absent — the shape SupabaseStore reads back.
    for (const { estimated, ...r } of keep(readings, readingIds, this.retain)) this.readings.push({ ...r, ...(estimated === true ? { estimated } : {}), runAt });
  }

  async recordAlert(alert: AlertRecord): Promise<void> {
    this.alerts.push(alert);
  }

  async recordRun(readings: StoredReading[], runAt: string, alert: AlertRecord): Promise<void> {
    // In-memory writes can't partially fail, so "atomic" is trivially satisfied by
    // the two appends — this just mirrors the Supabase RPC's all-or-nothing contract.
    await this.recordReadings(readings, runAt);
    // Append-only (mirrors the record_run RPC since 20260717010000_record_run_append_only.sql):
    // every run's alert row stands, including a second run inside one UTC fired-date. The
    // same-day replace this fake used to mirror is GONE — resolving same-date duplicates is the
    // read layer's job (max fired_at wins), not the write path's. Readings were never deduped.
    await this.recordAlert(alert);
  }

  async recordIntradayRun(readings: StoredReading[], runAt: string, slot: AlertRecord): Promise<void> {
    // Mirrors `record_intraday_run`'s all-or-nothing contract (in-memory writes can't partially fail).
    await this.recordReadings(readings, runAt);
    await this.putIntradayVerdict(slot);
  }

  async rewriteIntradayVerdict(slot: AlertRecord): Promise<number> {
    if (this.intradayVerdict === null || Date.parse(this.intradayVerdict.firedAt) !== Date.parse(slot.firedAt)) return 0;
    await this.putIntradayVerdict(slot);
    return 1;
  }

  async backfillDialState(firedAt: string, dialState: T1DialResult): Promise<boolean> {
    // Mirror of the SupabaseStore UPDATE: populate `dialState` only where it is still null (the
    // mandatory NULL-only guard — never clobber a live-persisted blob), returning true iff a match
    // was updated. Mutates in place; multiple rows can share a firedAt (intraday re-runs).
    let updated = false;
    for (const a of this.alerts) {
      if (a.firedAt === firedAt && a.dialState == null) {
        a.dialState = dialState;
        updated = true;
      }
    }
    return updated;
  }

  async updateRunTrace(firedAt: string, trace: { timings: RunTimings | null; degraded: DegradeEvent[] }): Promise<number> {
    let matched = 0;
    for (const a of this.alerts) {
      if (a.firedAt === firedAt) {
        a.timings = trace.timings;
        a.degraded = trace.degraded;
        matched++;
      }
    }
    return matched;
  }

  /** The intraday slot (a retired plan L1) — a plain field, never in `alerts`. */
  intradayVerdict: AlertRecord | null = null;

  async putIntradayVerdict(alert: AlertRecord): Promise<void> {
    const { runInputs: _runInputs, ...slot } = alert; // mirrors `slotRow`: the served slot never carries run_inputs
    this.intradayVerdict = slot;
  }

  async getIntradayVerdict(): Promise<AlertRecord | null> {
    return this.intradayVerdict;
  }

  async clearIntradayVerdict(): Promise<void> {
    this.intradayVerdict = null;
  }

  async getLastAlert(opts?: AlertReadOpts): Promise<AlertRecord | null> {
    // Same winner as `getRecentAlerts(1)` (max firedAt, later insert on a tie); `notifyBaseline` drops superseding rows.
    const last = sortedAlertsDesc(this.alerts).find((a) => !opts?.notifyBaseline || a.rederivedFrom == null);
    return last ? projectPanel(last, opts) : null;
  }

  async getLastPush(): Promise<AlertRecord | null> {
    // Newest-PUSHED original row (max pushedAt, like SupabaseStore's `pushed_at desc`; superseding rows never count).
    // Narrow projection (no `withPanel` seam): SupabaseStore selects ALERT_COLUMNS here, so drop the panelState key.
    const pushed = sortedAlertsDesc(this.alerts).filter((a) => a.pushedAt !== null && a.rederivedFrom == null);
    const found = pushed.sort((x, y) => Date.parse(y.pushedAt!) - Date.parse(x.pushedAt!))[0];
    return found ? projectPanel(found) : null;
  }

  async getLastBand(field: LastBandField): Promise<string | null> {
    // Newest non-null band for `field`, skipping degraded (null) runs — see the `Store`
    // interface (`store.ts`).
    return ((sortedAlertsDesc(this.alerts).find((a) => a[field] !== null && a.rederivedFrom == null)?.[field] as string | null) ?? null);
  }

  async getLastAlertBefore(firedDateIso: string): Promise<AlertRecord | null> {
    // Strictly before UTC midnight of firedDateIso — ISO-8601 Z strings compare lexically. Narrow
    // projection (SupabaseStore selects ALERT_COLUMNS here), so drop the panelState key.
    const cutoff = `${firedDateIso}T00:00:00`;
    const found = sortedAlertsDesc(this.alerts).find((a) => a.firedAt < cutoff);
    return found ? projectPanel(found) : null;
  }

  async getAlertAt(firedAt: string, opts?: AlertReadOpts): Promise<AlertRecord | null> {
    // Instant compare: a Postgres read-back spells `+00:00` where a fixture writes `Z`.
    const found = sortedAlertsDesc(this.alerts).find((a) => Date.parse(a.firedAt) === Date.parse(firedAt));
    return found ? projectPanel(found, opts) : null;
  }

  async getLastBandBefore(field: LastBandField, firedDateIso: string): Promise<string | null> {
    const cutoff = `${firedDateIso}T00:00:00`;
    return ((sortedAlertsDesc(this.alerts)
      .find((a) => a.firedAt < cutoff && a[field] !== null)?.[field] as string | null) ?? null);
  }

  async getReadingsForRun(runAt: string): Promise<StoredReading[]> {
    return this.readings.filter((r) => r.runAt === runAt).map(({ runAt: _runAt, ...r }) => r);
  }

  async getReadingVersions(indicatorId: string, date: string): Promise<SeriesPoint[]> {
    return this.readingsOf(indicatorId)
      .filter((r) => r.date === date)
      .map(({ date: d, value, delta20, rawState, state, decision, bandCuts, runAt, estimated }) => ({ date: d, value, delta20, rawState, state, decision, bandCuts: bandCuts ?? null, runAt, ...(estimated === true ? { estimated } : {}) }));
  }

  async getRecentAlerts(limit: number, opts?: AlertReadOpts): Promise<AlertRecord[]> {
    if (limit <= 0) return [];
    // Collapse to one row per UTC fired-date (latest run wins) BEFORE the cap — mirrors
    // SupabaseStore. Scanning newest→oldest makes the FIRST row seen for a date that date's
    // latest run. Slicing to `limit` FIRST and collapsing after would starve the window
    // whenever a date carries a re-run (the latest-N-then-filter bug).
    // Sort by `firedAt` DESC (insertion index DESC as the tiebreaker) rather than trusting
    // insertion order: SupabaseStore orders `fired_at DESC, id DESC` on the WIRE, so a fixture
    // that records an out-of-order firedAt (a backfill, a replay) must yield the same winner
    // here. `[...this.alerts].reverse()` alone was last-INSERTED-wins, which is a different rule.
    const byDate = new Map<string, AlertRecord>();
    for (const a of sortedAlertsDesc(this.alerts)) {
      const key = utcFiredDate(a.firedAt);
      if (!byDate.has(key)) byDate.set(key, a);
      if (byDate.size === limit) break; // window full — everything further back is older
    }
    return [...byDate.values()].map((a) => projectPanel(a, opts));
  }

  async getCashPriors(limit: number): Promise<CashPriorRow[]> {
    if (limit <= 0) return [];
    // NARROW sibling of getRecentAlerts — SAME collapse (one row per UTC fired-date, latest run
    // wins, scanning firedAt DESC) and SAME cap, projecting only the two CashPriorRow fields. Kept
    // in lockstep with getRecentAlerts above so the store.contract parity test holds.
    const byDate = new Map<string, CashPriorRow>();
    for (const a of sortedAlertsDesc(this.alerts)) {
      const key = utcFiredDate(a.firedAt);
      if (byDate.has(key)) continue;
      byDate.set(key, { date: a.date, dialTargetRung: a.dialTargetRung });
      if (byDate.size === limit) break; // window full — everything further back is older
    }
    return [...byDate.values()];
  }

  async getSeries(indicatorId: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> {
    // Collapse to the E7 winner per obs_date (`pickRecent` == readings_latest's order).
    const byDate = new Map<string, StoredReading & { runAt: string }>();
    for (const r of this.readingsOf(indicatorId)) byDate.set(r.date, pickRecent(byDate.get(r.date), r));
    const from = range?.from ?? null;
    const to = range?.to ?? null;
    return [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      // Range-anchor BEFORE the limit (ISO dates compare lexicographically) — mirrors
      // the Supabase gte/lte, so an old range survives the newest-N cap instead of being
      // starved by a slice-then-filter.
      .filter((r) => (from === null || r.date >= from) && (to === null || r.date <= to))
      .slice(-limit) // most-recent `limit` dates within the (optional) range
      .map(({ date, value, delta20, rawState, state, decision, bandCuts, runAt, estimated }) => ({ date, value, delta20, rawState, state, decision, bandCuts: bandCuts ?? null, runAt, ...(estimated === true ? { estimated } : {}) }));
  }

  private readingsOf(indicatorId: string): ReadonlyArray<StoredReading & { runAt: string }> {
    const rs = this.readings;
    if (this.byIdLen > rs.length || (this.byIdLen > 0 && rs[this.byIdLen - 1] !== this.byIdLast)) {
      this.byId.clear();
      this.byIdLen = 0;
    }
    for (let i = this.byIdLen; i < rs.length; i++) {
      const r = rs[i];
      if (r === undefined) continue; // a test's sparse `readings.length = N`
      const bucket = this.byId.get(r.indicatorId);
      if (bucket) bucket.push(r);
      else this.byId.set(r.indicatorId, [r]);
    }
    this.byIdLen = rs.length;
    this.byIdLast = rs[rs.length - 1];
    return this.byId.get(indicatorId) ?? [];
  }

  async getSeriesBulk(
    ids: string[],
    opts: { limit: number; range?: SeriesRange },
  ): Promise<Map<string, SeriesPoint[]>> {
    // The fake has no wire cap, so exact per-id semantics = reuse getSeries per id.
    // The Map preserves input `ids` order and includes every requested id (→ [] if empty).
    const out = new Map<string, SeriesPoint[]>();
    for (const id of ids) out.set(id, await this.getSeries(id, opts.limit, opts.range));
    return out;
  }

  async getWarmup(indicatorId: string, limit: number): Promise<Observation[]> {
    return [...this.warmup.values()]
      .filter((r) => r.indicatorId === indicatorId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(limit <= 0 ? Infinity : -limit) // `slice(-0)` is the whole array; paginateRows(fn, 0) is []
      .map(({ date, value }) => ({ date, value }));
  }

  async recordWarmup(rows: WarmupRow[], runAt: string): Promise<void> {
    for (const r of keep(rows, readingIds, this.retain)) this.warmup.set(`${r.indicatorId}|${r.date}`, { ...r, runAt });
  }

  async recordScorerVintage(rows: readonly ScorerVintageRow[]): Promise<void> {
    for (const r of rows) this.scorerVintage.set(r.indicator_id, { ...r });
  }

  async getScorerVintages(): Promise<ScorerVintageRow[]> {
    return [...this.scorerVintage.values()].map((r) => ({ ...r }));
  }

  async pruneShadowedReadings(
    indicatorIds: string[] | null,
    retainDays?: number | null,
    pinAlertRuns = true,
    since?: string | null,
  ): Promise<number> {
    // Mirrors the SQL guard (20260719120000): an unfloored blanket prune is unrepresentable.
    if (indicatorIds === null && retainDays == null) {
      throw new Error(
        "prune_shadowed_readings: p_ids null (all indicators) requires a p_retain_days retention floor - " +
          "an unfloored blanket prune would destroy all per-run provenance",
      );
    }
    // null ⇒ GC scope: every id is in scope (mirrors `p_ids is null or …` in SQL).
    const inScope = indicatorIds === null ? () => true : ((set) => (id: string) => set.has(id))(new Set(indicatorIds));
    // Same keep-rule as the SQL function: the E7 winner (`pickRecent`), tie → latest insert (id order).
    const keep = new Map<string, number>();
    this.readings.forEach((r, i) => {
      if (!inScope(r.indicatorId)) return;
      const k = `${r.indicatorId}|${r.date}`;
      const prev = keep.get(k);
      if (pickRecent(prev === undefined ? undefined : this.readings[prev], r) === r) keep.set(k, i);
    });
    const winners = new Set(keep.values());
    // Retention floor, mirroring `p_retain_days`: null/undefined ⇒ no floor.
    const cutoff = retainDays == null ? null : dbServerNow() - retainDays * 86_400_000;
    // Alert-run pin, mirroring `p_pin_alert_runs`: a run someone can ask `getReadingsForRun`
    // about is never emptied. Compare as INSTANTS (fixtures write `…Z`, prod `…+00:00`).
    const pinned = pinAlertRuns ? new Set(this.alerts.map((a) => Date.parse(a.firedAt))) : null;
    const eligible = (r: { runAt: string }) =>
      (cutoff === null || Date.parse(r.runAt) < cutoff) && !(pinned?.has(Date.parse(r.runAt)) ?? false);
    // Frontier, mirroring `p_since` (20261020120000): null ⇒ every row is a candidate (full sweep); else only
    // (1) rows sharing a key with an in-scope row written at/after `since`, or (2) rows whose run_at lies in
    // [since − R, now − R), R = retainDays (null ⇒ 0).
    const candidate = ((): ((r: { indicatorId: string; date: string; runAt: string }) => boolean) => {
      if (since == null) return () => true;
      const from = Date.parse(since);
      const retainMs = (retainDays ?? 0) * 86_400_000;
      const fresh = new Set(
        this.readings.filter((r) => inScope(r.indicatorId) && Date.parse(r.runAt) >= from).map((r) => `${r.indicatorId}|${r.date}`),
      );
      const floorFrom = from - retainMs;
      const floorTo = dbServerNow() - retainMs;
      return (r) => fresh.has(`${r.indicatorId}|${r.date}`) || (Date.parse(r.runAt) >= floorFrom && Date.parse(r.runAt) < floorTo);
    })();
    const survivors = this.readings.filter(
      (r, i) => !inScope(r.indicatorId) || winners.has(i) || !candidate(r) || !eligible(r),
    );
    const deleted = this.readings.length - survivors.length;
    this.readings.length = 0;
    this.readings.push(...survivors);
    return deleted;
  }

  async recordCalibration(params: CalibrationParam[]): Promise<void> {
    for (const p of params) this.calibration.push(p);
  }

  async getCalibration(): Promise<CalibrationParam[]> {
    // Collapse to the latest computedAt per (market, mode, channel, metric) — same
    // vintage rule the calibration_latest view enforces in SQL (DISTINCT ON groups
    // NULLs as equal, so legacy null/null rows collapse per (channel, metric)).
    // JSON key: unambiguous for nulls (`String(null)` would collide with a literal
    // "null" market).
    const byKey = new Map<string, CalibrationParam>();
    for (const p of this.calibration) {
      const key = JSON.stringify([p.market, p.mode, p.channel, p.metric]);
      const prev = byKey.get(key);
      if (!prev || p.computedAt > prev.computedAt) byKey.set(key, p);
    }
    return [...byKey.values()];
  }

  async getOverrides(sinceIsoDate: string): Promise<StoredOverride[]> {
    return this.overrides
      .filter((o) => o.obsDate >= sinceIsoDate)
      .sort((a, b) => a.obsDate.localeCompare(b.obsDate))
      .map((o) => ({ ...o }));
  }

  async getAlertsSince(sinceIsoDate: string): Promise<AlertSlice[]> {
    // Filter on obs_date (the contract), collapse on FIRED-date (max fired_at wins) — mirrors
    // SupabaseStore, which reads `fired_at DESC` so its first-seen row IS the date's max.
    // Walking newest→oldest by firedAt and keeping the FIRST hit per date reproduces that.
    // Unconditional `.set()` over insertion order did NOT: it was last-INSERTED-wins, which
    // diverges the moment a fixture records an earlier firedAt after a later one.
    // Two rows sharing an obs_date but fired on DIFFERENT dates both survive: that is the
    // intraday/yesterday's-obs_date regime, and eating one would lose a real close.
    const byFiredDate = new Map<string, AlertRecord>();
    for (const a of sortedAlertsDesc(this.alerts)) {
      if (a.date < sinceIsoDate) continue;
      const key = utcFiredDate(a.firedAt);
      if (!byFiredDate.has(key)) byFiredDate.set(key, a);
    }
    return [...byFiredDate.values()]
      .reverse() // firedAt-DESC scan order → oldest-first, exactly as SupabaseStore does
      .map((a) => ({ date: a.date, r4Phase: a.r4Phase }))
      // Contract is oldest→newest by obs_date; sort is stable, so rows sharing an obs_date keep
      // the firedAt-ASCENDING order the reverse above put them in — mirrors SupabaseStore's tail.
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async putLegPillars(input: LegPillarRow[]): Promise<number> {
    const rows = keep(input, pillarIds, this.retain);
    // `ignoreDuplicates` on the 4-column PK: an already-present key is SKIPPED, never
    // overwritten — the same insert-missing semantics SupabaseStore gets from the upsert.
    // The key index is REBUILT per call rather than kept as a field: `legPillars` is a public
    // test seam a fixture may push into directly, and a long-lived Set would silently desync from
    // it. Rebuilt, it is O(n) per call instead of the `.some()` scan's O(n·m) — which cost ~3s per
    // 4,500-row `/lab` fixture (measured 2026-07-25, api/lab.test.ts's three seeded W4 tests).
    const seen = new Set(this.legPillars.map(legPillarKey));
    for (const r of rows) {
      const key = legPillarKey(r);
      if (seen.has(key)) continue; // in-batch duplicates included — the upsert skips those too
      seen.add(key);
      this.legPillars.push({ ...r });
    }
    return rows.length;
  }

  async getLegPillarSeries(
    sleeve: string,
    superGroup: string,
    generator: string,
    limit: number,
  ): Promise<LegPillarPoint[]> {
    const series = this.legPillars
      .filter((p) => p.sleeve === sleeve && p.superGroup === superGroup && p.generator === generator)
      .sort((a, b) => a.obsDate.localeCompare(b.obsDate));
    // Newest `limit` points, written exactly as the Supabase tail slice is (same `-0` guard).
    return series
      .slice(Math.max(0, series.length - limit))
      .map((p) => ({ date: p.obsDate, value: p.value, estimated: p.estimated, basis: p.basis }));
  }

  async getLegPillarLatestGenerator(sleeve: string, superGroup: string): Promise<string | null> {
    // NO generator filter — that is the whole point (see the `Store` interface docblock in
    // `store.ts`). Newest obs_date
    // across every stored vintage; `sort` on a fresh `filter` copy, never on `this.legPillars`.
    const rows = this.legPillars
      .filter((p) => p.sleeve === sleeve && p.superGroup === superGroup)
      .sort((a, b) => a.obsDate.localeCompare(b.obsDate));
    return rows.length === 0 ? null : rows[rows.length - 1]!.generator;
  }

  async deleteReadingsOnDates(indicatorId: string, dates: string[]): Promise<number> {
    // Mirrors the SupabaseStore DELETE: every vintage on the named (indicatorId, obs_date) pairs.
    const drop = new Set(dates);
    const before = this.readings.length;
    let w = 0;
    for (const r of this.readings) if (!(r.indicatorId === indicatorId && drop.has(r.date))) this.readings[w++] = r;
    this.readings.length = w;
    return before - w;
  }

  async deleteEstimatesOnDates(indicatorId: string, dates: string[], before?: string): Promise<number> {
    const drop = new Set(dates);
    const older = (runAt: string): boolean => before === undefined || Date.parse(runAt) < Date.parse(before);
    const pinned = new Set(this.alerts.map((a) => Date.parse(a.firedAt))); // the alert-run pin, as `pruneShadowedReadings`
    const hit = (r: StoredReading & { runAt: string }): boolean =>
      r.indicatorId === indicatorId && drop.has(r.date) && r.estimated === true && older(r.runAt) && !pinned.has(Date.parse(r.runAt));
    // Pure perf: the run calls this once per id per cycle and it usually matches nothing, so probe
    // the id's own bucket first and skip the whole-table compaction (O(all readings)) on a miss.
    // The bucket keeps table order, so its first hit is the table's first: compact from there only.
    const first = this.readingsOf(indicatorId).find(hit);
    if (first === undefined) return 0;
    const n = this.readings.length;
    let w = this.readings.indexOf(first);
    for (let i = w; i < n; i++) {
      const r = this.readings[i]!;
      if (!hit(r)) this.readings[w++] = r;
    }
    this.readings.length = w;
    return n - w;
  }

  async getEstimateDates(ids: string[], from: string): Promise<Map<string, string[]>> {
    const want = new Set(ids);
    return estimateDatesById(this.readings.filter((r) => want.has(r.indicatorId) && r.estimated === true && r.date >= from).map((r) => [r.indicatorId, r.date] as const));
  }

  async deleteRederived(origFiredAt: string): Promise<number> {
    const orig = Date.parse(origFiredAt);
    const gone = this.alerts.filter((a) => a.rederivedFrom != null && Date.parse(a.rederivedFrom) === orig);
    const runAts = new Set(gone.map((a) => Date.parse(a.firedAt)));
    let w = 0;
    for (const r of this.readings) if (!runAts.has(Date.parse(r.runAt))) this.readings[w++] = r;
    this.readings.length = w;
    w = 0;
    for (const a of this.alerts) if (!gone.includes(a)) this.alerts[w++] = a;
    this.alerts.length = w;
    return gone.length;
  }

  async deleteNonEstimatesOnDates(indicatorId: string, dates: string[], pinAlertRuns = false): Promise<number> {
    const drop = new Set(dates);
    const before = this.readings.length;
    let w = 0;
    const pinned = new Set(pinAlertRuns ? this.alerts.map((a) => Date.parse(a.firedAt)) : []); // the alert-run pin, as `deleteEstimatesOnDates`
    for (const r of this.readings) if (!(r.indicatorId === indicatorId && drop.has(r.date) && r.estimated !== true && !pinned.has(Date.parse(r.runAt)))) this.readings[w++] = r;
    this.readings.length = w;
    return before - w;
  }

  async deleteProvisionalOnDates(indicatorId: string, dates: string[]): Promise<number> {
    const drop = new Set(dates);
    const before = this.readings.length;
    let w = 0;
    const pinned = new Set(this.alerts.map((a) => Date.parse(a.firedAt))); // the alert-run pin, as `deleteEstimatesOnDates`
    for (const r of this.readings) if (!(r.indicatorId === indicatorId && drop.has(r.date) && r.estimated !== true && isProvisional(r, indicatorId) && !pinned.has(Date.parse(r.runAt)))) this.readings[w++] = r;
    this.readings.length = w;
    return before - w;
  }

  async checkSchema(): Promise<void> {
    // No schema to drift — the fake's shape is the domain shape by construction.
  }

  async listSubscriberEmails(): Promise<string[]> {
    return [...this.subscribers];
  }

  async maxRowsProbe(assumedCap: number): Promise<{ count: number; observed: number | null }> {
    const count = this.readings.length; // the head+count:"exact" equivalent
    if (count <= assumedCap) return { count, observed: null };
    // Gated: the bounded select returns min(count, assumedCap), further capped by a simulated
    // server `max_rows` (maxRowsCap) when a test lowers it below the assumption.
    const observed = Math.min(count, assumedCap, this.maxRowsCap ?? Number.POSITIVE_INFINITY);
    return { count, observed };
  }
}
