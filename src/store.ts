/**
 * Persistence seam (v4 §6.7, §9): all DB behind this module — swap is a one-file edit.
 * `SupabaseStore` (prod/dev/CI; `SUPABASE_URL`+`SUPABASE_SERVICE_KEY`, service-role; `getStore("ro")` hands out only its
 * read methods as a `ReadStore`) · `InMemoryStore` (`store-memory.ts`, opt-in test fake, never from `getStore()`) · leaves `store-rows.ts` + `store-guards.ts`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { POSTGREST_MAX_ROWS } from "./postgrest-limits.js";
import { dbFetch } from "./db-fetch.js";
import type { Env } from "./config.js";
import { requireProdWrites, type ProdWritesEnv } from "./prod-writes.js";

import type { State } from "./domain-types.js";
import type { Observation } from "./domain-types.js";
import type { AlertLevel } from "./ladder.js";
import type { SlowBand } from "./slow.js";
import type { BottomState } from "./bottom.js";
import { hydrateR4Phase, type R4Phase } from "./r4.js";
import type { CashLevel, CashPriorRow } from "./cash-overlay.js";
import type { FallShape } from "./v-bear.js";
import type { ExposurePushState } from "./exposure.js";
import type { T1DialResult } from "./t1dial.js";
import type { PersistedPanel } from "./dial-assembly.js";
import type { RunInputs } from "./run-inputs.js";
import type { RunTimings } from "./fetch-budget.js";
import { assertNotTruncated, bucketShortfallIds, chunk, estimateDatesById, paginateRows } from "./store-guards.js";
import { keep, pillarIds, readingIds, type RetainPolicy } from "./store-keep.js";
import { retainable } from "./retention.js";
import { provisionalBefore } from "./intraday.js";
import { mapLimit } from "./map-limit.js";
import {
  ALERT_COLS,
  ALERT_COLUMNS,
  ALERT_COLUMNS_ALL,
  TIER_COLS,
  alertColumns,
  type TierField,
  alertRow,
  rowToAlert,
  slotRow,
  utcFiredDate,
} from "./store-rows.js";

/** One indicator reading for storage (camelCase). `label` omitted — static config; GET /status
 *  reconstructs it from INDICATORS by `indicatorId`, never denormalized. */
export interface StoredReading {
  date: string; // FRED observation date, YYYY-MM-DD (as-of)
  indicatorId: string;
  value: number;
  delta20: number;
  rawState: State;
  state: State;
  // Cron-time decision variable for the 6 derived ids (F4/F5/F6/F8/G1/NVDA), persisted verbatim
  // (nullable double precision); null for non-derived/short-window. Optional so pre-column doubles skip it.
  decision?: number | null;
  // Resolved numeric cut legs the cron scorer used (`Reading.bandCuts`, domain-types.ts) → nullable
  // `band_cuts` jsonb; null for pre-migration/degraded/`{}` bespoke. Optional (test/backfill doubles).
  bandCuts?: Readonly<Record<string, number>> | null;
  // `readings.estimated` (E3): a proxy/carry estimate a final print supersedes (E7, `pickRecent`). Absent ⇒ false.
  estimated?: boolean;
}

/** One `readings_warmup` row in domain shape — see `Store.getWarmup`. */
export interface WarmupRow {
  indicatorId: string;
  date: string; // YYYY-MM-DD
  value: number;
}

/** One `scorer_vintage` row, wire-shaped (snake_case) — per-id code vintage, see `Store.recordScorerVintage`. */
export interface ScorerVintageRow {
  indicator_id: string;
  config_hash: string;
  logic_version: number;
  stamped_at: string; // ISO timestamptz
}

export interface SeriesPoint {
  date: string; // observation date, YYYY-MM-DD
  value: number;
  delta20: number;
  rawState: State;
  state: State;
  // Persisted cron-time decision (see StoredReading.decision); null for non-derived/short windows.
  decision?: number | null;
  // Persisted scorer cut (see StoredReading.bandCuts), wire-keyed; null for unscored/pre-column.
  bandCuts?: Readonly<Record<string, number>> | null;
  // Writing run's `run_at` (ISO timestamptz); `isProvisional` (intraday.ts) reads it. Never on the wire.
  runAt?: string;
  // Served row is an estimate (E3/E7: only when no final row exists for the date). Present only when true.
  estimated?: true;
}

/** Inclusive date bounds for `getSeries` (ISO YYYY-MM-DD); null/omitted = open. Pushed into the
 *  query so an old range is reachable regardless of the `limit` cap (never latest-N-then-filter). */
export interface SeriesRange {
  from?: string | null;
  to?: string | null;
}

/** AlertRecord keys carrying an off-ladder track's band/state (NOT db columns; ALERT_COLS maps them
 *  to slow_band/bottom_state). Here (below tracks.ts) so getLastBand avoids a store→tracks cycle. */
export type BandField = "slowBand" | "bottomState";

/** getLastBand also serves the de-escalation-lag baseline: last non-null raw `dial_band` (skip-degraded
 *  = the "dial-less run must not defeat the N=2 hold" fix). `dialBand` widened only here, not BandField. */
export type LastBandField = BandField | "dialBand";

/** One degrade event in a run (audit rank 6): a feed/track that fell back through `degrade()` (tracks.ts)
 *  records `scope` + caught `reason`, so which families were non-live is recoverable from the alert row. */
/** `notify` events can fire the push caveat (`newDegradeEvents`); `trace` events only persist on `degraded`. */
export type DegradeEffect = "notify" | "trace";

export interface DegradeEvent {
  scope: string;
  reason: string;
  /** Stored rows without the key read as `"notify"` (`rowToAlert`). */
  effect: DegradeEffect;
  /** Structured COVERAGE DEGRADE, set only by the `[coverage]` emitter (run-cycle-dial.ts), one per family
   *  held/tied by non-live data (`FamilyPanel.coverageDegraded`, R5). Absent on every other event. */
  coverage?: CoverageDegrade;
  /** Set only by `drainLateDegrades` (tracks.ts): the event was recorded post-drain (the seed tail; an intraday run's post-commit sweeps), after this
   *  run's push decision, so `effect` is stored `trace` and this keeps the effect it was recorded with. The NEXT
   *  EOD push surfaces a `late: "notify"` event once (`priorLateNotifyEvents`, notify_format.ts). */
  late?: DegradeEffect;
  /** Set on a `NoFreeSourceError` fallback (`degrade()`, or `recordDegrade`'s `kind`): by design, not an outage — outage counters skip it. Absent otherwise. */
  kind?: "no-free-source";
}

/** One non-live roster member behind a `CoverageDegrade` — recorded at run time and served verbatim,
 *  never re-derived (the reading's `date` is frozen; a later age is a different number — review I-3). */
export interface CoverageMark {
  /** roster member id whose non-liveness holds or ties its family's verdict. */
  id: string;
  /** why not live: `lag` past its `lagCutFor`; `absent` did not report and has no in-cut close; `carried`
   *  did not report but last close within `lagCutFor`, re-entered the fold with that state. */
  reason: "lag" | "absent" | "carried";
  /** the member's feed symbol (`Indicator.series`); set for lag/carried, null for absent. */
  series: string | null;
  /** last-known confirmed state the verdict rests on; set for lag/carried, null for absent. */
  state: State | null;
  /** run-time age of the newest close (`Reading.ageDays`); set for lag/carried, null for absent. */
  ageDays: number | null;
}

/** One family whose verdict rested on non-live data (R5) — the structured counterpart of
 *  `FamilyPanel.coverageDegraded`, served verbatim as a `/api/lab` `coverage` entry. */
export interface CoverageDegrade {
  /** FamilyKey whose verdict is carried by non-live data. */
  family: string;
  /** the family's worst-of verdict held/tied (restricted fold for `trend`). */
  verdict: State;
  /** rank-7 CARRIED (zero present members) — the pinned carry rule. */
  carried: boolean;
  members: CoverageMark[];
}

/** One run's alert-ladder verdict, as stored in alert_log. */
export interface AlertRecord {
  date: string; // as-of date of the run's data
  level: AlertLevel;
  // The band-derivation reason (audit rank 13): `floor:credit|geo|r4|rate` (hard escalator lifted the
  // band), `lag-hold`, `regime`, or `no-dial`. Nullable text; alert-band.ts's `BandReason` documents it.
  bandReason: string | null;
  fin: number;
  rate: number;
  geoFlags: number;
  // Auto-geo stand-down dwell (migration 20260815120000): consecutive scored closes with the
  // stage-trigger ids all GREEN. Null/absent ⇒ pre-migration, seed "calm".
  geoCalmStreak?: number | null;
  coincident: State;
  finReds: number;
  firedAt: string; // ISO-8601 timestamp this run fired (every run)
  pushedAt: string | null; // ISO-8601 timestamp this run pushed, or null if silent (Phase 3 re-assert)
  // superseding row: the ORIGINAL row's firedAt (this row sits 2 ms after it — +1 ms is the run's estimate stamp — never pushed). Absent on an original.
  rederivedFrom?: string;
  // Push OUTCOME (audit rank 1): null when the warranted push delivered (or none warranted); error text
  // on failure — pushed_at then stays null so getLastPush skips it and decideReassert re-fires next run.
  pushError: string | null;
  // Persisted degrade trace (audit rank 6): every `degrade()` fallback this run as {scope,reason}.
  // `[]` = fully-live run; null = pre-migration. Isolated from the verdict — never feeds scoring.
  degraded: DegradeEvent[] | null;
  // Per-run phase marks; absent on pre-migration rows and doubles that never ran a cycle.
  timings?: RunTimings | null;
  // Slow "bubble-state" tier (Phase 3 1B): 0–N score + band, every run. Nullable: degrades to null
  // (≠ CALM) on feed-down, distinguishing degraded from CALM. Isolated — never feeds the fast verdict.
  slowScore: number | null;
  slowBand: SlowBand | null;
  // Denominator slowScore was scored against (`2 × activeCount`, src/slow.ts) — jsonb-only
  // (SLOW_MAX_SCORE_KEY). Persisted (read path can't reconstruct activeCount); null ⇒ render "score / —".
  slowMaxScore: number | null;
  // VIX bottom-signal tier: confirmed off-ladder state, every run. Nullable: degrades to null (≠ CALM)
  // on VIXCLS/VXVCLS feed-down. Isolated — never feeds the fast verdict.
  bottomState: BottomState | null;
  // VIX bottom-signal numbers (Stage 5): front, 3-month, term ratio driving bottomState — read-only, isolated. Null as a
  // group on a degraded run; vix/vix3m (redacted) also null on the served /status + /history.
  vix: number | null;
  vix3m: number | null;
  ratio: number | null;
  // R4 cash-breaker (extreme-only, over the T1 dial): r4Phase text `equity|cash|reentry`, legacy rows
  // narrowed by `hydrateR4Phase`; r4EntryFiredAt/r4ReentryRung. Null group ⇒ pre-migration; notify-only.
  r4Phase: R4Phase | null;
  r4EntryFiredAt: string | null;
  r4ReentryRung: number | null;
  // Raw T1-dial band `regimeToBand(dial.notifyRegime)` — the notify axis (W3-c) BEFORE escalator floor
  // and lag. Persisted so the lag can count low runs (level is escalator-masked). Null: pre-migration/no-dial.
  dialBand: AlertLevel | null;
  // The whole assembled dial (`T1DialResult`) as `dial_state` jsonb — the compute-once seam; dialBand/
  // dialTargetRung become projections of it in `alertRow` when non-null. Null: pre-migration/no-dial run.
  dialState: T1DialResult | null;
  // Four `assembleDial` fields the `/api/lab` read consumes (`PersistedPanel`, dial-assembly.ts) as
  // `panel_state` jsonb, same vintage as dialState. OPTIONAL (P-1): only a `withPanel` read carries it.
  panelState?: PersistedPanel | null;
  // E12 DISPLAY twins (estimates included) of dialState/panelState; null on dial-less/legacy rows.
  // `displayPanelState` is OPTIONAL like panelState: only a `withPanel` read carries it.
  displayDialState: T1DialResult | null;
  displayPanelState?: PersistedPanel | null;
  // Replay inputs (`alert_log.run_inputs`, src/run-inputs.ts); null = pre-migration. OPTIONAL: only a `withRunInputs` read carries it.
  runInputs?: RunInputs | null;
  // Auto-hold held sleeve (i7a): calmest-in-band leg, persisted EVERY run before notify so on-held-change
  // dedups vs last persisted (not only pushed). Null: pre-migration/degraded — a silent baseline.
  heldSleeve: string | null;
  // Re-risk confirm counter (M5/M8): consecutive IMPROVING runs, int default 0. NOT A GATE since
  // 2026-08-07 (RERISK_CONFIRM=1) — keep (re-arm case); advances per fired-date not per close, intended.
  reriskConfirmCount: number;
  // Held-leg min-dwell ledger (M7): closes the held leg survived, resets to 0 on held change; int default 0.
  // NOT A GATE since 2026-08-07 (RERISK_DWELL_DAYS=0) — kept (FE + re-arm); newClose-gated, not hand-pushable.
  heldDays: number;
  // W5-a cash-overlay level `off|partial` — NEVER the resolved CashState ('full' is R4's terminal, in
  // r4Phase). Non-nullable (text default 'off', fail-safe). Typed `Exclude<CashLevel,"full">` — a compile guard.
  cashOverlay: Exclude<CashLevel, "full">;
  // ISO stamp the overlay went ACTIVE (the entry, preserved across active runs). Null while off.
  cashOverlaySince: string | null;
  // Legible /lab trigger string (Stage 3.1). Display-only — never read back into the fold.
  cashOverlayReason: string | null;
  // W5-d fall shape (migration 20260720170000): V-vs-bear class this run, every run. Non-nullable,
  // default 'indeterminate' (the safe value — only 'v-shaped' diverges from today's behaviour).
  fallShape: FallShape;
  // Drawdown/trading day (<0 falling). null = "not measurable" (no closes), DISTINCT from 0 (at the peak — collapsing them
  // lets a dead feed read as a fresh peak); also null (redacted) on the served /status + /history.
  fallVelocity: number | null;
  // Consecutive confirmed-RED credit closes, max over F1/F2. Nullable: null = history shorter than
  // BEAR_DWELL_CLOSES, which v-bear.ts refuses to report small (a small dwell reads as 'v-shaped').
  creditDwellCloses: number | null;
  // The dial's `targetRung` this run (arch §9's missing column). UD-1(c) reads a RISE in it across
  // closes; the LADDER.indexOf(heldSleeve)+1 proxy diverges when the hold gate binds. Null: pre-mig/no-dial.
  dialTargetRung: number | null;
  // Non-live family keys this run (GLOBAL_FAMILIES entries with live:false). Persisted in `tier_state`
  // jsonb so the calm-ward caveat dedups on the SAME set, not the degrade log. Null prior = NEWS (fail open).
  nonLiveFamilies: string[] | null;
  // Provisional push timestamp (lever 2(a)) — raw-RED bypass's last push, `tier_state.provisional_pushed_at`.
  // NOT pushedAt/level (would silence next day's confirmed RED). Optional; carried forward for the 7-day cooldown.
  provisionalPushedAt?: string | null;
  // Exposure push dedup baseline (`tier_state.exposure_state`): bounded+raw posture + the two keys' edges
  // this run saw, stamped every run (carry-forward on degrade) so next run compares vs last observed. Nullable.
  exposureState?: ExposurePushState | null;
}

/** One derived calibration cut-point from the off-line harness (append-only, vintage capture): a re-run
 *  of the same (channel, metric) is re-stored, app reads the latest via getCalibration(). Nullable per migration. */
export interface CalibrationParam {
  /** The (market, mode) cell calibrated for (e.g. ('ndx','crash')). Both null = legacy target-blind row,
   *  collapsing per (channel, metric). */
  market: string | null;
  mode: string | null;
  channel: string;
  metric: string;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  method: string;
  nEvents: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  notes: string | null;
  computedAt: string; // ISO-8601
}

/** One recorded manual override (D9 gate (b), Fork 2 `overrides`): user acted against the prescribed leg.
 *  Read-only from the app (writes are manual, service-role); assignable to scoreboard.ts's `OverrideRow`. */
export interface StoredOverride {
  obsDate: string; // YYYY-MM-DD
  note: string | null;
}

/** The alert-row slice the D9 time-in-cash guardrail reads (assignable to scoreboard.ts's `ScoreboardAlertRow`). */
export interface AlertSlice {
  date: string; // alert obs_date, YYYY-MM-DD
  r4Phase: R4Phase | null;
}

/** One replayed per-leg super-group pillar for `leg_pillars` (EW W4 4.2). `value` NULLABLE by design —
 *  an `uncomparable` pillar carries no number, never impute 0. `superGroup` plain string (no danger-engine import). */
export interface LegPillarRow {
  obsDate: string; // YYYY-MM-DD
  sleeve: string;
  superGroup: string;
  value: number | null;
  estimated: boolean;
  /** Plaintext roster: sorted member-ids of the capable families, joined with ",". */
  basis: string;
  /** Engine-formula vintage — the PK's 4th column, so vintages CO-EXIST. */
  generator: string;
}

/** One point of a (sleeve, super_group, generator) pillar series, oldest→newest — the Stage 4.3 rolling
 *  ECDF input. Uses `date` not `obsDate` (caller knows the series), so the key columns aren't repeated. */
export interface LegPillarPoint {
  date: string; // YYYY-MM-DD
  value: number | null;
  estimated: boolean;
  basis: string;
}

/** Opt-in read flags for the alert reads (P-1). */
export interface AlertReadOpts {
  /** Select the `panel_state` jsonb blob too. Default false — only /api/lab consumes it. */
  withPanel?: boolean;
  /** Select the `run_inputs` jsonb too. Default false — only a re-derive replays it; never served. */
  withRunInputs?: boolean;
  /** `getLastAlert` only: skip `rederivedFrom` rows — the NOTIFY baseline is the last band the user was told. */
  notifyBaseline?: boolean;
}

export interface Store {
  /** Append every reading from one run (vintage capture — never overwrites). */
  recordReadings(readings: StoredReading[], runAt: string): Promise<void>;
  /** Append one alert-ladder verdict to the audit log. */
  recordAlert(alert: AlertRecord): Promise<void>;
  /** Persist one run ATOMICALLY (P4): readings + commit-point alert in one transaction, so a partial
   *  failure can't orphan readings. recordReadings/recordAlert remain for partial states in tests. */
  recordRun(readings: StoredReading[], runAt: string, alert: AlertRecord): Promise<void>;
  /** The intraday twin of `recordRun`: readings + the `intraday_verdict` slot (`putIntradayVerdict`'s shape) in ONE
   *  transaction (`record_intraday_run`), so new readings never sit beside an older run's verdict and the slot's
   *  `run_at` marks the run committed (`scripts/smoke-cron.sh`). */
  recordIntradayRun(readings: StoredReading[], runAt: string, slot: AlertRecord): Promise<void>;
  /** Rewrite the slot's row ONLY while it still holds `slot.firedAt`'s run (a newer run's slot is left alone). Returns rows matched. */
  rewriteIntradayVerdict(slot: AlertRecord): Promise<number>;
  /** Backfill `dial_state` for rows at `firedAt` still NULL (C1). The `dial_state IS NULL` guard is
   *  MANDATORY (idempotent, never overwrites a live blob); never deletes. Returns true iff a row updated. */
  backfillDialState(firedAt: string, dialState: T1DialResult): Promise<boolean>;
  /** Post-seed-tail rewrite of ONLY `timings` + `degraded` on the row(s) at `firedAt`; never a scoring column. Returns rows matched. */
  updateRunTrace(firedAt: string, trace: { timings: RunTimings | null; degraded: DegradeEvent[] }): Promise<number>;
  /** The ONE provisional (intraday) run's verdict, held OUTSIDE `alert_log` so no notify/scoring baseline
   *  can read it (a retired plan L1). Upsert = each daytime run overwrites. */
  putIntradayVerdict(alert: AlertRecord): Promise<void>;
  /** The intraday slot, or null when empty / cleared. Read only through `servedVerdict` (intraday.ts) by `/api/lab`, `/api/status`, `/api/exposure`. */
  getIntradayVerdict(): Promise<AlertRecord | null>;
  /** Empty the slot — the EOD run's post-`recordRun` step (a stale intraday verdict never outlives its day), and a
   *  `rederive: false` intraday run's (readings only, so every verdict read falls back to the EOD row). */
  clearIntradayVerdict(): Promise<void>;
  /** Most-recent alert_log row, or null — the SERVED verdict (a superseding row included). `notifyBaseline`
   *  skips superseding rows; `withPanel` selects `panel_state` too (default off — only /api/lab needs it). */
  getLastAlert(opts?: AlertReadOpts): Promise<AlertRecord | null>;
  /** Most-recent ORIGINAL alert_log row that actually PUSHED (`pushed_at not null`), or null — weekly re-assert. */
  getLastPush(): Promise<AlertRecord | null>;
  /** Most-recent NON-NULL off-ladder band value on an ORIGINAL row, or null — the per-track NOTIFY baseline
   *  (skip degraded rows: null ≠ CALM, else re-fires the 2026-06-28 dup-notify bug; skip superseding rows). */
  getLastBand(field: LastBandField): Promise<string | null>;
  /** Newest alert_log row fired STRICTLY BEFORE UTC midnight of `firedDateIso` — the SCORING prev-state
   *  read (same-day re-run must not double-tick dwell/streak). Notify baseline stays getLastAlert(); don't merge. */
  getLastAlertBefore(firedDateIso: string): Promise<AlertRecord | null>;
  /** The alert_log row fired at exactly `firedAt` (latest insert on a tie), or null — a re-derive's original + its refs. */
  getAlertAt(firedAt: string, opts?: AlertReadOpts): Promise<AlertRecord | null>;
  /** getLastBand with getLastAlertBefore's strictly-before-UTC-midnight cutoff (keeps skip-degraded).
   *  Scoring baselines (dial-band lag) read THIS; per-track notify baselines stay getLastBand. */
  getLastBandBefore(field: LastBandField, firedDateIso: string): Promise<string | null>;
  /** Readings for one run (`run_at === runAt`), or [] — backs GET /status. the run loop (`run-cycle-ctx.ts`) uses one runAt for
   *  readings + alert.firedAt, so the alert is the commit point: a readings-only partial run stays invisible. */
  getReadingsForRun(runAt: string): Promise<StoredReading[]>;
  /** Every stored row for one (indicator, obs_date) in insert order, `runAt` set — the vintages readings_latest
   *  collapses (`pickRecent` names the served one). Backs `npm run why`. */
  getReadingVersions(indicatorId: string, date: string): Promise<SeriesPoint[]>;
  /** Most-recent alert_log rows newest-first, capped at `limit` — backs GET /history. ONE ROW PER UTC
   *  FIRED-DATE (latest run wins), keyed on fired-at not obs_date; `limit` counts DATES, not rows. */
  getRecentAlerts(limit: number, opts?: AlertReadOpts): Promise<AlertRecord[]>;
  /** NARROW `{date, dialTargetRung}` sibling of getRecentAlerts (same RPC/collapse) for buildCashOverlayWindow
   *  — 870ms→~73ms/30 dates (Perf P2). Row-for-row the getRecentAlerts slice (contract test pins it). */
  getCashPriors(limit: number): Promise<CashPriorRow[]>;
  /** Per-indicator /series history: one point per obs_date (latest run_at), newest `limit` dates,
   *  oldest→newest. Optional [from,to] anchors BEFORE the limit so an old range survives the newest-N cap. */
  getSeries(indicatorId: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]>;
  /** Batched multi-series read — ONE round trip; each id exactly as getSeries(id, limit, range), every
   *  requested id present ([] if none), in input order. Collapses the ~25-member dial fan-out (Perf-A3). */
  getSeriesBulk(ids: string[], opts: { limit: number; range?: SeriesRange }): Promise<Map<string, SeriesPoint[]>>;
  /** Append a batch of derived calibration params (vintage capture, never overwrites); no-op on empty. */
  recordCalibration(params: CalibrationParam[]): Promise<void>;
  /** Latest calibration param per (channel, metric) — the current cut-points (max computedAt per key). */
  getCalibration(): Promise<CalibrationParam[]>;
  /** Manual-override rows with `obs_date >= sinceIsoDate`, oldest→newest — D9 gate (b). No app write path
   *  (manual insert, Fork 2); the InMemory fake seeds via its `overrides` array. */
  getOverrides(sinceIsoDate: string): Promise<StoredOverride[]>;
  /** {date, r4Phase} slice of alert_log with `obs_date >= sinceIsoDate`, oldest→newest — D9 time-in-cash.
   *  Named getAlertsSince (not a getRecentAlerts overload). Collapsed one row per UTC fired-date; `since` on obs_date. */
  getAlertsSince(sinceIsoDate: string): Promise<AlertSlice[]>;
  /** Warm-up head: raw feed obs below the first emitted
   *  reading, newest `limit`, oldest→newest. NOT vintaged (one row per (indicator,date), feed wins). */
  getWarmup(indicatorId: string, limit: number): Promise<Observation[]>;
  /** Upsert warm-up rows on (indicator_id, obs_date); no-op on an empty batch. */
  recordWarmup(rows: WarmupRow[], runAt: string): Promise<void>;
  /** Upsert per-id code vintages on `indicator_id` (last stamp wins); no-op on an empty batch. */
  recordScorerVintage(rows: readonly ScorerVintageRow[]): Promise<void>;
  /** Every stored vintage row — the drift detector diffs these against the live registry. */
  getScorerVintages(): Promise<ScorerVintageRow[]>;
  /** Insert-missing a batch of replayed pillar rows; returns the count handed in that `keep` retains (the legpillars backfill
   *  is the only writer). Chunks at LEG_PILLAR_CHUNK, upserts ignoreDuplicates on the 4-col PK; no-op on empty. */
  putLegPillars(rows: LegPillarRow[]): Promise<number>;
  /** One (sleeve, super_group, generator) pillar series, oldest→newest, newest `limit` (Stage 4.3 ECDF).
   *  `generator` is a REQUIRED filter — vintages share the (obs_date, sleeve, super_group) prefix by design. */
  getLegPillarSeries(
    sleeve: string,
    superGroup: string,
    generator: string,
    limit: number,
  ): Promise<LegPillarPoint[]>;
  /** `generator` of the NEWEST row for (sleeve, super_group) across ALL vintages, or null when no history
   *  — the 4.4 stale-basis probe telling stale-vintage from never-written apart. One row, empty-branch only. */
  getLegPillarLatestGenerator(sleeve: string, superGroup: string): Promise<string | null>;
  /** Assert the DB schema has every column this code reads — throw naming the absent column (backs
   *  /api/health's bearer-gated deep probe), before a cron silently reads garbage (2026-06-27 outage class). No-op for the fake. */
  checkSchema(): Promise<void>;
  /** Every `email_subscribers.email` for the cron band-mail fan-out (src/email.ts). Service-role read; empty when none. */
  listSubscriberEmails(): Promise<string[]>;
  /** Delete shadowed vintages per (indicator_id, obs_date), keeping the readings_latest row; returns deleted count.
   *  null ids = every id (GC); null ids+null retainDays RAISES; retainDays = retention floor (cron: CRON_PRUNE_RETAIN_DAYS); pinAlertRuns (default true) spares alert-run rows.
   *  since (ISO instant) = frontier: only rows that became deletable since then — a shadower written at/after `since`, or
   *  run_at in [since − retainDays, now − retainDays) — are visited (migration 20261020120000); null/omitted = full sweep. */
  pruneShadowedReadings(
    indicatorIds: string[] | null,
    retainDays?: number | null,
    pinAlertRuns?: boolean,
    since?: string | null,
  ): Promise<number>;
  /** Restate-only prune (calendar holes, pre-floor rows, post-grace tail — `backfillHistory`): delete
   *  EVERY vintage of `indicatorId` on exactly `dates`. Unconditional (no floor/pin) — a date the feed
   *  can't produce has no re-shadowable vintage. */
  deleteReadingsOnDates(indicatorId: string, dates: string[]): Promise<number>;
  /** Delete only `estimated` rows of `indicatorId` on `dates` (E3 sweep), never an alert run's (`run_at` = a `fired_at`); returns the count.
   *  `before`: only rows whose `run_at` is earlier — a run replacing its predecessors' estimates (I6). */
  deleteEstimatesOnDates(indicatorId: string, dates: string[], before?: string): Promise<number>;
  /** Delete every superseding row of the original at `origFiredAt` (`rederived_from`) and the readings at its fired_at;
   *  returns the alert rows removed. A re-derive's replace step — the original and its readings are never touched. */
  deleteRederived(origFiredAt: string): Promise<number>;
  /** Delete every NON-estimate row of `indicatorId` on `dates`, FINAL included — keeps the E3 estimate (`settleEstimateRows`).
   *  `pinAlertRuns`: spare an alert run's row too (`run_at` = a `fired_at`, as `deleteEstimatesOnDates`) — the restate's own-estimate clear. */
  deleteNonEstimatesOnDates(indicatorId: string, dates: string[], pinAlertRuns?: boolean): Promise<number>;
  /** Delete only the PROVISIONAL non-estimate rows of `indicatorId` on `dates` — `run_at` before each date's own
   *  `provisionalBefore` bound (`isProvisional`), so a FINAL row on the date never matches — nor an alert run's (`run_at` = a `fired_at`). The EOD cleaner's (`sweepEodRows`) deleter. */
  deleteProvisionalOnDates(indicatorId: string, dates: string[]): Promise<number>;
  /** Per id of `ids` holding any raw `estimated` row dated `from` on, its dates (sorted, deduped) — a FINAL-shadowed one included. */
  getEstimateDates(ids: string[], from: string): Promise<Map<string, string[]>>;
  /** Live PostgREST max_rows probe (Deploy-A4): count-gated (free on a small table); only a count above
   *  `assumedCap` issues one bounded select. Returns {count, observed}; observed<assumedCap ⇒ lowered cap. */
  maxRowsProbe(assumedCap: number): Promise<{ count: number; observed: number | null }>;
}

/** Single source for each table's snake_case columns ↔ camelCase keys — every SELECT/INSERT/mapper reads
 *  from here (P3). `runAt` has no StoredReading field but drives getSeries ORDER BY / checkSchema — don't drop it. */
const READINGS_COLS = {
  date: "obs_date",
  indicatorId: "indicator_id",
  value: "value",
  delta20: "delta20",
  rawState: "raw_state",
  state: "state",
  decision: "decision",
  bandCuts: "band_cuts",
  runAt: "run_at",
  estimated: "estimated",
} as const;

const CALIBRATION_COLS = {
  market: "market",
  mode: "mode",
  channel: "channel",
  metric: "metric",
  value: "value",
  ciLow: "ci_low",
  ciHigh: "ci_high",
  method: "method",
  nEvents: "n_events",
  windowStart: "window_start",
  windowEnd: "window_end",
  notes: "notes",
  computedAt: "computed_at",
} as const;

const OVERRIDES_COLS = {
  obsDate: "obs_date",
  note: "note",
} as const;

/** `leg_pillars` (migration 20260725220000) — the first four are its PRIMARY KEY. */
const LEG_PILLAR_COLS = {
  obsDate: "obs_date",
  sleeve: "sleeve",
  superGroup: "super_group",
  generator: "generator",
  value: "value",
  estimated: "estimated",
  basis: "basis",
} as const;

/** PK columns in table order — `putLegPillars`' upsert onConflict target, derived from LEG_PILLAR_COLS. */
const LEG_PILLAR_CONFLICT = [
  LEG_PILLAR_COLS.obsDate,
  LEG_PILLAR_COLS.sleeve,
  LEG_PILLAR_COLS.superGroup,
  LEG_PILLAR_COLS.generator,
].join(",");

/** Rows per putLegPillars upsert round trip (~16k rows/job; same order as the readings backfill). */
export const LEG_PILLAR_CHUNK = 1000;

const READINGS_COLUMNS = Object.values(READINGS_COLS).join(",");
const CALIBRATION_COLUMNS = Object.values(CALIBRATION_COLS).join(",");
const OVERRIDES_COLUMNS = Object.values(OVERRIDES_COLS).join(",");
const LEG_PILLAR_COLUMNS = Object.values(LEG_PILLAR_COLS).join(",");

/** ⚠ Never compare a stored `double precision` from these rows with `===` (PostgREST 15-sig-digit round-trip
 *  is inexact) — use `Math.abs(a-b) <= 1e-9*Math.max(1,|a|,|b|)` (`scripts/probe-vix-vintage.ts`). */
function asRows(data: unknown): Array<Record<string, unknown>> {
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** Re-exported from `postgrest-limits.ts` so this file stays the one place importers read the cap, while
 *  feed-lag.ts reads it without an edge back into this module. */
export { POSTGREST_MAX_ROWS };

/** Retention floor (days) the CRON path hands pruneShadowedReadings — shadowed rows newer than this stay.
 *  Cron writes one row per indicator at its latest obs_date (doesn't advance daily), so no floor deletes real provenance. */
export const CRON_PRUNE_RETAIN_DAYS = 30;

/** Frontier overlap (days) the CRON path hands pruneShadowedReadings as `since = runAt − this`: the prune visits only
 *  rows that became deletable inside that window; the pruning EOD cron is weekday-only (`vercel.json`), so up to 4 consecutive
 *  failed cron prunes self-heal on the next success. A longer gap (or a pin removed after the fact) needs a manual full sweep (`since` null). */
export const CRON_PRUNE_FRONTIER_DAYS = 7;

/** The `degraded[]` scope a failed cron prune persists on its run's alert row; `/api/lab` matches it EXACTLY (`pruneFailed`). */
export const PRUNE_DEGRADE_SCOPE = "[prune] shadowed-vintage prune skipped this run";

/** Retention floor (days) the BACKFILL path hands pruneShadowedReadings — short (its own shadows ARE dups)
 *  but NOT null: a pass covering today shadows the live cron row (the only getReadingsForRun vintage). */
export const BACKFILL_PRUNE_RETAIN_DAYS = 3;

/** Per-call row cap for getSeriesBulk: ids are chunked so each RPC fetches ≤ this; only a `limit` above it
 *  alone takes the per-id (paginating) path. */
const SERIES_BULK_MAX_ROWS = POSTGREST_MAX_ROWS;
/** Per-call id cap for readings_newest_n — a statement-time budget: 161 ids in one call hit the 8s timeout (2026-11-07). */
export const SERIES_BULK_MAX_IDS_PER_CALL = 40;
/** Max readings_newest_n chunks in flight per getSeriesBulk — the statement timeout is shared under DB load. */
export const SERIES_BULK_CONCURRENCY = 3;

/** Map one `readings_latest` row to a `SeriesPoint` — shared by getSeries + getSeriesBulk. */
function rowToSeriesPoint(row: Record<string, unknown>): SeriesPoint {
  return {
    date: String(row[READINGS_COLS.date]),
    value: Number(row[READINGS_COLS.value]),
    delta20: Number(row[READINGS_COLS.delta20]),
    rawState: row[READINGS_COLS.rawState] as State,
    state: row[READINGS_COLS.state] as State,
    decision: row[READINGS_COLS.decision] == null ? null : Number(row[READINGS_COLS.decision]),
    bandCuts: (row[READINGS_COLS.bandCuts] as Record<string, number> | null | undefined) ?? null,
    ...(row[READINGS_COLS.runAt] == null ? {} : { runAt: String(row[READINGS_COLS.runAt]) }),
    ...(row[READINGS_COLS.estimated] === true ? { estimated: true as const } : {}),
  };
}

/** Build the snake_case row for one reading from the column maps — the single place the domain→DB shape
 *  is assembled, shared by the direct inserts and the record_run RPC (P4) so the two can't drift. */
function readingRow(r: StoredReading, runAt: string): Record<string, unknown> {
  return {
    [READINGS_COLS.date]: r.date,
    [READINGS_COLS.indicatorId]: r.indicatorId,
    [READINGS_COLS.value]: r.value,
    [READINGS_COLS.delta20]: r.delta20,
    [READINGS_COLS.rawState]: r.rawState,
    [READINGS_COLS.state]: r.state,
    [READINGS_COLS.decision]: r.decision,
    // jsonb: `?? null` keeps an absent cut an explicit SQL NULL (never undefined, which the RPC rejects).
    [READINGS_COLS.bandCuts]: r.bandCuts ?? null,
    [READINGS_COLS.runAt]: runAt,
    // Always sent: record_run's jsonb_populate_recordset turns a missing key into NULL (NOT NULL fails).
    [READINGS_COLS.estimated]: r.estimated === true,
  };
}

function calibrationRow(p: CalibrationParam): Record<string, unknown> {
  return {
    [CALIBRATION_COLS.market]: p.market,
    [CALIBRATION_COLS.mode]: p.mode,
    [CALIBRATION_COLS.channel]: p.channel,
    [CALIBRATION_COLS.metric]: p.metric,
    [CALIBRATION_COLS.value]: p.value,
    [CALIBRATION_COLS.ciLow]: p.ciLow,
    [CALIBRATION_COLS.ciHigh]: p.ciHigh,
    [CALIBRATION_COLS.method]: p.method,
    [CALIBRATION_COLS.nEvents]: p.nEvents,
    [CALIBRATION_COLS.windowStart]: p.windowStart,
    [CALIBRATION_COLS.windowEnd]: p.windowEnd,
    [CALIBRATION_COLS.notes]: p.notes,
    [CALIBRATION_COLS.computedAt]: p.computedAt,
  };
}

/** `LegPillarRow` → the `leg_pillars` insert shape. Every column explicit: estimated/basis/generator are
 *  NOT NULL in the DDL, so a dropped column fails loud. `value` alone may be null. */
function legPillarRow(r: LegPillarRow): Record<string, unknown> {
  return {
    [LEG_PILLAR_COLS.obsDate]: r.obsDate,
    [LEG_PILLAR_COLS.sleeve]: r.sleeve,
    [LEG_PILLAR_COLS.superGroup]: r.superGroup,
    [LEG_PILLAR_COLS.generator]: r.generator,
    [LEG_PILLAR_COLS.value]: r.value,
    [LEG_PILLAR_COLS.estimated]: r.estimated,
    [LEG_PILLAR_COLS.basis]: r.basis,
  };
}

/** Production + dev + CI: Supabase Postgres via `@supabase/supabase-js`. */
export class SupabaseStore implements Store {
  private readonly client: SupabaseClient;
  /** Row-retention policy every id-keyed write filters through (`keep`); a seam for `retention.wiring.test.ts`. */
  private readonly retain: RetainPolicy;

  constructor(url: string, key: string, retain: RetainPolicy = retainable) {
    this.retain = retain;
    // Service-role, server-side only: no session to persist, no auto-refresh.
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: dbFetch },
    });
  }

  async recordReadings(readings: StoredReading[], runAt: string): Promise<void> {
    const kept = keep(readings, readingIds, this.retain);
    if (kept.length === 0) return;
    const { error } = await this.client.from("readings").insert(kept.map((r) => readingRow(r, runAt)));
    if (error) throw new Error(`Supabase insert into readings failed: ${error.message}`);
  }

  async recordAlert(alert: AlertRecord): Promise<void> {
    const { error } = await this.client.from("alert_log").insert(alertRow(alert));
    if (error) throw new Error(`Supabase insert into alert_log failed: ${error.message}`);
  }

  async recordRun(readings: StoredReading[], runAt: string, alert: AlertRecord): Promise<void> {
    // One transaction (P4): record_run() inserts readings+alert atomically. Same shapes as the direct inserts.
    const { error } = await this.client.rpc("record_run", {
      p_readings: keep(readings, readingIds, this.retain).map((r) => readingRow(r, runAt)),
      p_alert: alertRow(alert),
    });
    if (error) throw new Error(`Supabase record_run failed: ${error.message}`);
  }

  async recordIntradayRun(readings: StoredReading[], runAt: string, slot: AlertRecord): Promise<void> {
    const { error } = await this.client.rpc("record_intraday_run", {
      p_readings: keep(readings, readingIds, this.retain).map((r) => readingRow(r, runAt)),
      p_run_at: slot.firedAt,
      p_slot: slotRow(slot),
    });
    if (error) throw new Error(`Supabase record_intraday_run failed: ${error.message}`);
  }

  async rewriteIntradayVerdict(slot: AlertRecord): Promise<number> {
    const { data, error } = await this.client.from("intraday_verdict").update({ row: slotRow(slot) }).eq("run_at", slot.firedAt).select("id");
    if (error) throw new Error(`Supabase rewrite of intraday_verdict failed: ${error.message}`);
    return asRows(data).length;
  }

  async backfillDialState(firedAt: string, dialState: T1DialResult): Promise<boolean> {
    // NULL-only guard (`.is(dial_state, null)`) is mandatory: never overwrite a live blob, stays idempotent.
    // `.select` returns the touched rows — its length is the matched signal; dialState rides as the jsonb value.
    const { data, error } = await this.client
      .from("alert_log")
      .update({ [ALERT_COLS.dialState]: dialState })
      .eq(ALERT_COLS.firedAt, firedAt)
      .is(ALERT_COLS.dialState, null)
      .select(ALERT_COLS.firedAt);
    if (error) throw new Error(`Supabase backfill dial_state failed: ${error.message}`);
    return asRows(data).length > 0;
  }

  async updateRunTrace(firedAt: string, trace: { timings: RunTimings | null; degraded: DegradeEvent[] }): Promise<number> {
    const { data, error } = await this.client
      .from("alert_log")
      .update({ [ALERT_COLS.timings]: trace.timings, [ALERT_COLS.degraded]: trace.degraded })
      .eq(ALERT_COLS.firedAt, firedAt)
      .select(ALERT_COLS.firedAt);
    if (error) throw new Error(`Supabase update run trace failed: ${error.message}`);
    return asRows(data).length;
  }

  async putIntradayVerdict(alert: AlertRecord): Promise<void> {
    // Same row shape `record_run` takes (`alertRow`) minus `run_inputs` (the slot is served), as ONE jsonb value.
    const { error } = await this.client
      .from("intraday_verdict")
      .upsert({ id: true, run_at: alert.firedAt, row: slotRow(alert) }, { onConflict: "id" });
    if (error) throw new Error(`Supabase upsert into intraday_verdict failed: ${error.message}`);
  }

  async getIntradayVerdict(): Promise<AlertRecord | null> {
    const { data, error } = await this.client.from("intraday_verdict").select("row").eq("id", true).limit(1);
    if (error) throw new Error(`Supabase read intraday_verdict failed: ${error.message}`);
    const row = asRows(data)[0]?.row as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  }

  async clearIntradayVerdict(): Promise<void> {
    const { error } = await this.client.from("intraday_verdict").delete().eq("id", true);
    if (error) throw new Error(`Supabase delete from intraday_verdict failed: ${error.message}`);
  }

  async pruneShadowedReadings(
    indicatorIds: string[] | null,
    retainDays?: number | null,
    pinAlertRuns = true,
    since?: string | null,
  ): Promise<number> {
    // Empty array is still a no-op; null is GC scope (every id) and must reach the RPC.
    if (indicatorIds !== null && indicatorIds.length === 0) return 0;
    // One server-side transaction: keeps the readings_latest row per (indicator_id, obs_date), deletes the rest.
    const { data, error } = await this.client.rpc("prune_shadowed_readings", {
      p_ids: indicatorIds,
      p_retain_days: retainDays ?? null,
      p_pin_alert_runs: pinAlertRuns,
      p_since: since ?? null,
    });
    if (error) throw new Error(`Supabase prune_shadowed_readings failed: ${error.message}`);
    return (data as number | null) ?? 0;
  }

  async deleteReadingsOnDates(indicatorId: string, dates: string[]): Promise<number> {
    let total = 0;
    // An `.in()` list that can exceed IN_LIST_CHUNK goes through `chunk`.
    for (const part of chunk(dates)) {
      const { count, error } = await this.client
        .from("readings")
        .delete({ count: "exact" })
        .eq(READINGS_COLS.indicatorId, indicatorId)
        .in(READINGS_COLS.date, part);
      if (error) throw new Error(`Supabase delete from readings failed: ${error.message}`);
      total += count ?? 0;
    }
    return total;
  }

  async deleteEstimatesOnDates(indicatorId: string, dates: string[], before?: string): Promise<number> {
    const rows: Array<Record<string, unknown>> = [];
    for (const part of chunk(dates)) {
      const q = this.client
        .from("readings")
        .select(`id, ${READINGS_COLS.runAt}`)
        .eq(READINGS_COLS.indicatorId, indicatorId)
        .in(READINGS_COLS.date, part)
        .eq(READINGS_COLS.estimated, true);
      const { data, error } = await (before === undefined ? q : q.lt(READINGS_COLS.runAt, before));
      if (error) throw new Error(`Supabase read estimates from readings failed: ${error.message}`);
      const got = asRows(data);
      // Per-(indicator, dates) across vintages — a max_rows cut here would leave unpruned estimates behind, silently.
      assertNotTruncated(got.length, "deleteEstimatesOnDates(readings)");
      rows.push(...got);
    }
    return this.deleteUnpinnedRows(rows, "estimates");
  }

  /** Delete `rows` (each `id` + `run_at`) by id, sparing an alert run's (`run_at` = a `fired_at`); returns the count. */
  private async deleteUnpinnedRows(rows: Array<Record<string, unknown>>, what: string): Promise<number> {
    if (rows.length === 0) return 0;
    // The alert-run pin, as `prune_shadowed_readings`' `a.fired_at = d.run_at`: compared as instants (`…Z` vs `…+00:00`).
    const runAts = [...new Set(rows.map((r) => String(r[READINGS_COLS.runAt])))];
    const pinned = new Set<number>();
    for (const part of chunk(runAts)) {
      const pins = await this.client.from("alert_log").select(ALERT_COLS.firedAt).in(ALERT_COLS.firedAt, part);
      if (pins.error) throw new Error(`Supabase read alert_log pins failed: ${pins.error.message}`);
      for (const a of asRows(pins.data)) pinned.add(Date.parse(String(a[ALERT_COLS.firedAt])));
    }
    const ids = rows.filter((r) => !pinned.has(Date.parse(String(r[READINGS_COLS.runAt])))).map((r) => Number(r.id));
    let total = 0;
    for (const part of chunk(ids)) {
      const del = await this.client.from("readings").delete({ count: "exact" }).in("id", part);
      if (del.error) throw new Error(`Supabase delete ${what} from readings failed: ${del.error.message}`);
      total += del.count ?? 0;
    }
    return total;
  }

  async deleteRederived(origFiredAt: string): Promise<number> {
    const { data, error } = await this.client.from("alert_log").select(ALERT_COLS.firedAt).eq(ALERT_COLS.rederivedFrom, origFiredAt);
    if (error) throw new Error(`Supabase read superseding alert_log rows failed: ${error.message}`);
    const firedAts = asRows(data).map((r) => String(r[ALERT_COLS.firedAt]));
    // A cut list would delete the alert rows (`.eq` below, complete) but orphan the readings of the rows past the cap.
    assertNotTruncated(firedAts.length, "deleteRederived(alert_log)");
    if (firedAts.length === 0) return 0;
    // The row first: a failed readings delete then leaves unserved rows, never a served row over an empty board.
    const del = await this.client.from("alert_log").delete({ count: "exact" }).eq(ALERT_COLS.rederivedFrom, origFiredAt);
    if (del.error) throw new Error(`Supabase delete superseding alert_log rows failed: ${del.error.message}`);
    for (const part of chunk([...new Set(firedAts)])) {
      const rd = await this.client.from("readings").delete().in(READINGS_COLS.runAt, part);
      if (rd.error) throw new Error(`Supabase delete superseding readings failed: ${rd.error.message}`);
    }
    return del.count ?? 0;
  }

  async getEstimateDates(ids: string[], from: string): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.client
      .from("readings")
      .select(`${READINGS_COLS.indicatorId}, ${READINGS_COLS.date}`)
      .in(READINGS_COLS.indicatorId, ids)
      .eq(READINGS_COLS.estimated, true)
      .gte(READINGS_COLS.date, from);
    if (error) throw new Error(`Supabase read estimate dates from readings failed: ${error.message}`);
    const rows = asRows(data);
    assertNotTruncated(rows.length, "readings (estimate dates)");
    return estimateDatesById(rows.map((r) => [String(r[READINGS_COLS.indicatorId]), String(r[READINGS_COLS.date])]));
  }

  async deleteNonEstimatesOnDates(indicatorId: string, dates: string[], pinAlertRuns = false): Promise<number> {
    if (dates.length === 0) return 0;
    if (pinAlertRuns) {
      const rows: Array<Record<string, unknown>> = [];
      for (const part of chunk(dates)) {
        const { data, error } = await this.client
          .from("readings")
          .select(`id, ${READINGS_COLS.runAt}`)
          .eq(READINGS_COLS.indicatorId, indicatorId)
          .in(READINGS_COLS.date, part)
          .eq(READINGS_COLS.estimated, false);
        if (error) throw new Error(`Supabase read non-estimates from readings failed: ${error.message}`);
        // The read feeds a delete, so a silent max_rows cut is an incomplete clear.
        assertNotTruncated(asRows(data).length, "deleteNonEstimatesOnDates(readings)");
        rows.push(...asRows(data));
      }
      return this.deleteUnpinnedRows(rows, "non-estimates");
    }
    const { count, error } = await this.client
      .from("readings")
      .delete({ count: "exact" })
      .eq(READINGS_COLS.indicatorId, indicatorId)
      .in(READINGS_COLS.date, dates)
      .eq(READINGS_COLS.estimated, false);
    if (error) throw new Error(`Supabase delete non-estimates from readings failed: ${error.message}`);
    return count ?? 0;
  }

  async deleteProvisionalOnDates(indicatorId: string, dates: string[]): Promise<number> {
    if (dates.length === 0) return 0;
    const { data, error } = await this.client
      .from("readings")
      .select(`id, ${READINGS_COLS.date}, ${READINGS_COLS.runAt}`)
      .eq(READINGS_COLS.indicatorId, indicatorId)
      .in(READINGS_COLS.date, [...new Set(dates)])
      .eq(READINGS_COLS.estimated, false);
    if (error) throw new Error(`Supabase read provisional rows from readings failed: ${error.message}`);
    // Same posture as deleteEstimatesOnDates: the read feeds a delete, so a silent cut is an incomplete prune.
    assertNotTruncated(asRows(data).length, "deleteProvisionalOnDates(readings)");
    // The `run_at` bound is per obs date (a FINAL row's `run_at` precedes a LATER date's bound), so it filters here.
    const rows = asRows(data).filter((r) => Date.parse(String(r[READINGS_COLS.runAt])) < Date.parse(provisionalBefore(String(r[READINGS_COLS.date]), indicatorId)));
    if (rows.length === 0) return 0;
    // The alert-run pin, as `deleteEstimatesOnDates`: a forced EOD run before the cutoff writes provisional-looking rows of its own.
    const runAts = [...new Set(rows.map((r) => String(r[READINGS_COLS.runAt])))];
    const pins = await this.client.from("alert_log").select(ALERT_COLS.firedAt).in(ALERT_COLS.firedAt, runAts);
    if (pins.error) throw new Error(`Supabase read alert_log pins failed: ${pins.error.message}`);
    const pinned = new Set(asRows(pins.data).map((a) => Date.parse(String(a[ALERT_COLS.firedAt]))));
    const ids = rows.filter((r) => !pinned.has(Date.parse(String(r[READINGS_COLS.runAt])))).map((r) => Number(r.id));
    if (ids.length === 0) return 0;
    const del = await this.client.from("readings").delete({ count: "exact" }).in("id", ids);
    if (del.error) throw new Error(`Supabase delete provisional rows from readings failed: ${del.error.message}`);
    return del.count ?? 0;
  }

  async getLastAlert(opts?: AlertReadOpts): Promise<AlertRecord | null> {
    if (opts?.notifyBaseline) return this.lastOriginalAlert(opts);
    const [latest] = await this.getRecentAlerts(1, opts);
    return latest ?? null;
  }

  /** Newest row with `rederived_from IS NULL` — `alert_log_recent`'s order (`fired_at desc, id desc`), one row. */
  private async lastOriginalAlert(opts?: AlertReadOpts): Promise<AlertRecord | null> {
    const { data, error } = await this.client
      .from("alert_log")
      .select(alertColumns(opts))
      .is(ALERT_COLS.rederivedFrom, null)
      .order(ALERT_COLS.firedAt, { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const [row] = asRows(data);
    return row ? rowToAlert(row) : null;
  }

  async getLastAlertBefore(firedDateIso: string): Promise<AlertRecord | null> {
    // Timestamp comparison (not a date cast) — index-friendly and timezone-unambiguous.
    const { data, error } = await this.client
      .from("alert_log")
      .select(ALERT_COLUMNS)
      .lt(ALERT_COLS.firedAt, `${firedDateIso}T00:00:00Z`)
      .order(ALERT_COLS.firedAt, { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const row = data?.[0] as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  }

  async getAlertAt(firedAt: string, opts?: AlertReadOpts): Promise<AlertRecord | null> {
    const { data, error } = await this.client
      .from("alert_log")
      .select(alertColumns(opts))
      .eq(ALERT_COLS.firedAt, firedAt)
      .order("id", { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const [row] = asRows(data);
    return row ? rowToAlert(row) : null;
  }

  async listSubscriberEmails(): Promise<string[]> {
    const { data, error } = await this.client.from("email_subscribers").select("email");
    if (error) throw new Error(`Supabase read email_subscribers failed: ${error.message}`);
    const rows = data ?? [];
    // A silent max_rows cut would drop subscribers past the cap; throw so the fan-out skips loud, never partial.
    assertNotTruncated(rows.length, "listSubscriberEmails(email_subscribers)");
    return rows.map((r) => (r).email);
  }

  async getLastPush(): Promise<AlertRecord | null> {
    const { data, error } = await this.client
      .from("alert_log")
      .select(ALERT_COLUMNS)
      .not(ALERT_COLS.pushedAt, "is", null)
      .is(ALERT_COLS.rederivedFrom, null)
      .order(ALERT_COLS.pushedAt, { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const row = data?.[0] as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  }

  /** Newest value of an off-ladder band column, skipping degraded (col IS NULL) runs so a hiccup never
   *  erases the last real band. Ordered by fired_at (most runs silent). Shared by slow+bottom baselines. */
  private async lastNonNullBand(col: string, beforeTs?: string): Promise<string | null> {
    let query = this.client
      .from("alert_log")
      .select(col)
      .not(col, "is", null);
    if (beforeTs !== undefined) query = query.lt(ALERT_COLS.firedAt, beforeTs);
    else query = query.is(ALERT_COLS.rederivedFrom, null); // getLastBand = notify baseline: originals only
    const { data, error } = await query
      .order(ALERT_COLS.firedAt, { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const row = data?.[0] as Record<string, unknown> | undefined;
    return row ? (row[col] as string) : null;
  }

  /** Newest run whose `tier_state.<key>` is set, skipping degraded (absent-key) rows — the jsonb analog of
   *  lastNonNullBand (bands moved to tier_state, Stage 3). `->>` yields TEXT; aliased `val:` pins the key. */
  private async lastNonNullTier(jsonKey: string, beforeTs?: string): Promise<string | null> {
    const path = `tier_state->>${jsonKey}`;
    let query = this.client
      .from("alert_log")
      .select(`val:${path}`)
      .not(path, "is", null);
    if (beforeTs !== undefined) query = query.lt(ALERT_COLS.firedAt, beforeTs);
    else query = query.is(ALERT_COLS.rederivedFrom, null); // getLastBand = notify baseline: originals only
    const { data, error } = await query
      .order(ALERT_COLS.firedAt, { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const row = data?.[0] as Record<string, unknown> | undefined;
    return row ? (row.val as string) : null;
  }

  async getLastBand(field: LastBandField): Promise<string | null> {
    // slow/bottom/pension bands live in tier_state (jsonb); dialBand stays a column. Routed by which map holds it.
    if (field in TIER_COLS) return this.lastNonNullTier(TIER_COLS[field as TierField]);
    return this.lastNonNullBand(ALERT_COLS[field as Exclude<LastBandField, TierField>]);
  }

  async getLastBandBefore(field: LastBandField, firedDateIso: string): Promise<string | null> {
    // Same routing as getLastBand, cut off strictly before UTC midnight of firedDateIso.
    const beforeTs = `${firedDateIso}T00:00:00Z`;
    if (field in TIER_COLS) return this.lastNonNullTier(TIER_COLS[field as TierField], beforeTs);
    return this.lastNonNullBand(ALERT_COLS[field as Exclude<LastBandField, TierField>], beforeTs);
  }

  async getRecentAlerts(limit: number, opts?: AlertReadOpts): Promise<AlertRecord[]> {
    if (limit <= 0) return [];
    // `limit` counts DATES: the alert_log_recent RPC (20260818120000) collapses one row per UTC fired-date
    // (latest run wins) in SQL. `.order(fired_at desc)` pins newest-date-first. Keyed fired-date, not obs_date.
    const { data, error } = await this.client
      .rpc("alert_log_recent", { p_limit: limit })
      .select(alertColumns(opts))
      .order(ALERT_COLS.firedAt, { ascending: false });
    if (error) throw new Error(`Supabase read alert_log_recent failed: ${error.message}`);
    const rows = asRows(data);
    // FORWARD guard: the RPC caps at `limit` and every caller is under HISTORY_MAX_LIMIT, so this can't fire today.
    assertNotTruncated(rows.length, "getRecentAlerts(alert_log_recent)");
    return rows.map(rowToAlert);
  }

  async getCashPriors(limit: number): Promise<CashPriorRow[]> {
    if (limit <= 0) return [];
    // NARROW sibling of getRecentAlerts (SAME alert_log_recent RPC/collapse), projecting only the two columns
    // buildCashOverlayWindow reads. `fired_at` rides ONLY as the .order() key (PostgREST needs it projected).
    const { data, error } = await this.client
      .rpc("alert_log_recent", { p_limit: limit })
      .select(`${ALERT_COLS.date},${ALERT_COLS.dialTargetRung},${ALERT_COLS.firedAt}`)
      .order(ALERT_COLS.firedAt, { ascending: false });
    if (error) throw new Error(`Supabase read alert_log_recent failed: ${error.message}`);
    const rows = asRows(data);
    assertNotTruncated(rows.length, "getCashPriors(alert_log_recent)");
    // Map exactly as rowToAlert does for these two fields, so the slice matches byte-for-byte.
    return rows.map((row) => ({
      date: String(row[ALERT_COLS.date]),
      dialTargetRung: row[ALERT_COLS.dialTargetRung] == null ? null : Number(row[ALERT_COLS.dialTargetRung]),
    }));
  }

  async getReadingsForRun(runAt: string): Promise<StoredReading[]> {
    // One round-trip on run_at (readings_run_idx). Readings surface only once the alert row exists (commit point).
    const { data, error } = await this.client.from("readings").select(READINGS_COLUMNS).eq(READINGS_COLS.runAt, runAt);
    if (error) throw new Error(`Supabase read readings failed: ${error.message}`);
    const rows = asRows(data);
    // Unbounded (one run ≈ 40 rows) — sentinel anyway so a future fan-out that balloons a run surfaces loud.
    assertNotTruncated(rows.length, "getReadingsForRun(readings)");
    return rows.map((row) => ({
      date: String(row[READINGS_COLS.date]),
      indicatorId: String(row[READINGS_COLS.indicatorId]),
      value: Number(row[READINGS_COLS.value]),
      delta20: Number(row[READINGS_COLS.delta20]),
      rawState: row[READINGS_COLS.rawState] as State,
      state: row[READINGS_COLS.state] as State,
      decision: row[READINGS_COLS.decision] == null ? null : Number(row[READINGS_COLS.decision]),
      // jsonb round-trips as a parsed object; `?? null` normalizes an absent/legacy column.
      bandCuts: (row[READINGS_COLS.bandCuts] as Record<string, number> | null) ?? null,
      ...(row[READINGS_COLS.estimated] === true ? { estimated: true } : {}),
    }));
  }

  async getReadingVersions(indicatorId: string, date: string): Promise<SeriesPoint[]> {
    // Raw `readings`, not the view; `id` order = insert order, the view's last tiebreak.
    const { data, error } = await this.client
      .from("readings")
      .select(READINGS_COLUMNS)
      .eq(READINGS_COLS.indicatorId, indicatorId)
      .eq(READINGS_COLS.date, date)
      .order("id", { ascending: true });
    if (error) throw new Error(`Supabase read readings versions failed: ${error.message}`);
    const rows = asRows(data);
    assertNotTruncated(rows.length, "getReadingVersions(readings)");
    return rows.map(rowToSeriesPoint);
  }

  async getSeries(indicatorId: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> {
    // PAGINATES via `.range()` — PostgREST max_rows caps every response regardless of `.limit(n)` (rank 15);
    // vintage collapse is in SQL (readings_latest, P5); range pushed BEFORE the limit so old windows survive.
    const rows = await paginateRows(async (offset, count) => {
      let query = this.client
        .from("readings_latest")
        .select(READINGS_COLUMNS)
        .eq(READINGS_COLS.indicatorId, indicatorId);
      if (range?.from != null) query = query.gte(READINGS_COLS.date, range.from);
      if (range?.to != null) query = query.lte(READINGS_COLS.date, range.to);
      const { data, error } = await query
        .order(READINGS_COLS.date, { ascending: false })
        .range(offset, offset + count - 1);
      if (error) throw new Error(`Supabase read readings_latest failed: ${error.message}`);
      return asRows(data);
    }, limit);

    return rows.map(rowToSeriesPoint).reverse();
  }

  async getSeriesBulk(
    ids: string[],
    opts: { limit: number; range?: SeriesRange },
  ): Promise<Map<string, SeriesPoint[]>> {
    const { limit, range } = opts;
    // Seed every id with [] up front, input order, so a member with no rows is present-and-empty.
    const out = new Map<string, SeriesPoint[]>(ids.map((id) => [id, [] as SeriesPoint[]]));
    if (ids.length === 0) return out;

    // limit:1 (freshness stamp) uses the readings_newest RPC — one index probe per id: through
    // readings_latest the LIMIT can't push past DISTINCT ON (prod walked 240k rows → 3s timeout). Absent = answer.
    if (limit === 1 && range == null) {
      const { data, error } = await this.client.rpc("readings_newest", { p_ids: ids });
      if (error) throw new Error(`Supabase read readings_newest failed: ${error.message}`);
      const rows = asRows(data);
      // RPC rides the same max_rows wire cap; guard so a >5000-id call can't report its tail present-and-empty.
      assertNotTruncated(rows.length, "readings_newest", ids.length);
      for (const row of rows) out.set(String(row[READINGS_COLS.indicatorId]), [rowToSeriesPoint(row)]);
      return out;
    }

    // General path (limit>1): readings_newest_n RPC — a LATERAL per-id limit under unnest so the per-id LIMIT
    // stays in-plan (832ms→162ms, 9 ids/400). Optional [from,to] filters inside the RPC BEFORE the limit.
    // Past the wire cap: RPC chunks of ≤ cap rows each, `SERIES_BULK_CONCURRENCY` in flight — never per-id serial reads (98 of them timed the cron out).
    const idsPerCall = Math.min(Math.floor(SERIES_BULK_MAX_ROWS / limit), SERIES_BULK_MAX_IDS_PER_CALL);
    if (idsPerCall < 1) {
      for (const id of ids) out.set(id, await this.getSeries(id, limit, range));
      return out;
    }
    const chunks = Array.from({ length: Math.ceil(ids.length / idsPerCall) }, (_, i) => ids.slice(i * idsPerCall, (i + 1) * idsPerCall));
    const rows = (
      await mapLimit(chunks, SERIES_BULK_CONCURRENCY, async (chunk) => {
          // Explicit nulls when range absent — PostgREST maps them to the SQL default-null args (newest-N per id).
          const { data, error } = await this.client.rpc("readings_newest_n", {
            p_ids: chunk,
            p_limit: limit,
            p_from: range?.from ?? null,
            p_to: range?.to ?? null,
          });
          if (error) throw new Error(`Supabase read readings_newest_n failed: ${error.message}`);
          const chunkRows = asRows(data);
          // Bound = chunk × limit, not chunk.length: a wire-capped result would report its tail as fabricated absences.
          assertNotTruncated(chunkRows.length, "readings_newest_n", chunk.length * limit);
          return chunkRows;
      })
    ).flat();

    // Bucket per id, then sort each oldest→newest (getSeries reverses to the same); one row per date ⇒ total sort.
    const buckets = new Map<string, SeriesPoint[]>();
    for (const row of rows) {
      const id = String(row[READINGS_COLS.indicatorId]);
      let bucket = buckets.get(id);
      if (!bucket) buckets.set(id, (bucket = []));
      bucket.push(rowToSeriesPoint(row));
    }
    for (const id of ids) {
      out.set(id, (buckets.get(id) ?? []).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
    }

    // Shortfall repair, a runtime parity net vs RPC-vs-getSeries drift: the RPC's true per-id limit makes a
    // spurious short bucket impossible, so a short bucket = a genuinely short series; re-fetch via getSeries.
    const short = bucketShortfallIds(ids, out, limit);
    const repaired = await Promise.all(short.map((id) => this.getSeries(id, limit, range)));
    short.forEach((id, i) => out.set(id, repaired[i]!));
    return out;
  }

  async getWarmup(indicatorId: string, limit: number): Promise<Observation[]> {
    // Same PostgREST max_rows posture as getSeries: paginate newest-first, then reverse.
    const rows = await paginateRows(async (offset, count) => {
      const { data, error } = await this.client
        .from("readings_warmup")
        .select("obs_date, value")
        .eq("indicator_id", indicatorId)
        .order("obs_date", { ascending: false })
        .range(offset, offset + count - 1);
      if (error) throw new Error(`Supabase read readings_warmup failed: ${error.message}`);
      return asRows(data);
    }, limit);
    return rows.map((r) => ({ date: String(r.obs_date), value: Number(r.value) })).reverse();
  }

  async recordWarmup(rows: WarmupRow[], runAt: string): Promise<void> {
    const kept = keep(rows, readingIds, this.retain);
    if (kept.length === 0) return;
    const { error } = await this.client
      .from("readings_warmup")
      .upsert(
        kept.map((r) => ({ indicator_id: r.indicatorId, obs_date: r.date, value: r.value, run_at: runAt })),
        { onConflict: "indicator_id,obs_date" },
      );
    if (error) throw new Error(`Supabase upsert readings_warmup failed: ${error.message}`);
  }

  async recordScorerVintage(rows: readonly ScorerVintageRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.client
      .from("scorer_vintage")
      .upsert([...rows], { onConflict: "indicator_id" });
    if (error) throw new Error(`Supabase upsert scorer_vintage failed: ${error.message}`);
  }

  async getScorerVintages(): Promise<ScorerVintageRow[]> {
    const { data, error } = await this.client
      .from("scorer_vintage")
      .select("indicator_id, config_hash, logic_version, stamped_at");
    if (error) throw new Error(`Supabase read scorer_vintage failed: ${error.message}`);
    const rows = asRows(data);
    // One row per indicator (PK) — sentinel anyway, as getReadingsForRun: a silent cut reads as "never stamped".
    assertNotTruncated(rows.length, "getScorerVintages(scorer_vintage)");
    return rows.map((r) => ({
      indicator_id: String(r.indicator_id),
      config_hash: String(r.config_hash),
      logic_version: Number(r.logic_version),
      stamped_at: String(r.stamped_at),
    }));
  }

  async recordCalibration(params: CalibrationParam[]): Promise<void> {
    if (params.length === 0) return;
    const { error } = await this.client.from("calibration").insert(params.map(calibrationRow));
    if (error) throw new Error(`Supabase insert into calibration failed: ${error.message}`);
  }

  async getCalibration(): Promise<CalibrationParam[]> {
    // Latest-vintage collapse is in SQL (calibration_latest view, DISTINCT ON (channel, metric)); no JS dedupe.
    const { data, error } = await this.client.from("calibration_latest").select(CALIBRATION_COLUMNS);
    if (error) throw new Error(`Supabase read calibration_latest failed: ${error.message}`);
    const rows = asRows(data);
    // One row per (channel, metric) — sentinel anyway: a cut here would silently drop calibrated cuts to priors.
    assertNotTruncated(rows.length, "getCalibration(calibration_latest)");
    return rows.map(rowToCalibration);
  }

  async getOverrides(sinceIsoDate: string): Promise<StoredOverride[]> {
    const { data, error } = await this.client
      .from("overrides")
      .select(OVERRIDES_COLUMNS)
      .gte(OVERRIDES_COLS.obsDate, sinceIsoDate)
      .order(OVERRIDES_COLS.obsDate, { ascending: true });
    if (error) throw new Error(`Supabase read overrides failed: ${error.message}`);
    const rows = asRows(data);
    // Unbounded trailing-window read — sentinel so a truncated override history can't undercount the D9 gate.
    assertNotTruncated(rows.length, "getOverrides(overrides)");
    return rows.map((row) => ({
      obsDate: String(row[OVERRIDES_COLS.obsDate]),
      note: row[OVERRIDES_COLS.note] == null ? null : String(row[OVERRIDES_COLS.note]),
    }));
  }

  async getAlertsSince(sinceIsoDate: string): Promise<AlertSlice[]> {
    // obs_date is `date` (since 20260716200000); a YYYY-MM-DD string compares identically in .gte(). `fired_at`
    // joins the projection because the COLLAPSE keys on it (the filter stays on obs_date); unbounded read, no limit.
    const { data, error } = await this.client
      .from("alert_log")
      .select(`${ALERT_COLS.date},${ALERT_COLS.r4Phase},${ALERT_COLS.firedAt}`)
      .gte(ALERT_COLS.date, sinceIsoDate)
      .order(ALERT_COLS.firedAt, { ascending: false })
      // Secondary key on an EXACT fired_at tie (same-second re-run, or a backfill stamping a whole day at
      // one instant): the later INSERT is the later run. Same rule `alert_log_recent` uses server-side
      // (`fired_at desc, alert_log.id desc`) and the same rule InMemoryStore uses. Without it the collapse
      // below kept whichever row PostgREST returned first — the SUPERSEDED run's r4Phase, which feeds
      // `timeInCashShare`. `id` is not in ALERT_COLS (never projected); it is ordered on, never read.
      .order("id", { ascending: false })
      .order(ALERT_COLS.date, { ascending: true });
    if (error) throw new Error(`Supabase read alert_log failed: ${error.message}`);
    const rows = asRows(data);
    // Sentinel BEFORE the collapse: it must see the raw wire count or dedup masks a cap-sized page as short.
    assertNotTruncated(rows.length, "getAlertsSince(alert_log)");
    // One row per UTC FIRED-date, latest wins (rows fired_at DESC, then id DESC ⇒ first seen = latest run
    // even on an exact fired_at tie) — counts dates, not runs.
    const byFiredDate = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = utcFiredDate(String(row[ALERT_COLS.firedAt]));
      if (!byFiredDate.has(key)) byFiredDate.set(key, row);
    }
    return [...byFiredDate.values()]
      .reverse() // fired_at DESC scan order → oldest-first
      .map((row) => ({
        date: String(row[ALERT_COLS.date]),
        // Narrowed by VALUE (`hydrateR4Phase`): free-text column, rows before NF-1(A) (2026-07-26) can carry
        // the retired `arm1`/`arm2` — HISTORY, never live. null stays null (no r4 state).
        r4Phase: row[ALERT_COLS.r4Phase] == null ? null : hydrateR4Phase(row[ALERT_COLS.r4Phase]),
      }))
      // Contract is oldest→newest by obs_date; stable sort keeps same-date rows fired_at-ascending.
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async putLegPillars(input: LegPillarRow[]): Promise<number> {
    const rows = keep(input, pillarIds, this.retain);
    if (rows.length === 0) return 0;
    // CHUNKED UPSERT (not one-shot .insert): ~16k rows/run, must be re-runnable. `ignoreDuplicates` (ON
    // CONFLICT DO NOTHING) makes a second identical run a no-op on the 4-col PK; a plain .insert would red.
    for (let i = 0; i < rows.length; i += LEG_PILLAR_CHUNK) {
      const chunk = rows.slice(i, i + LEG_PILLAR_CHUNK);
      const { error } = await this.client
        .from("leg_pillars")
        .upsert(chunk.map(legPillarRow), { onConflict: LEG_PILLAR_CONFLICT, ignoreDuplicates: true });
      if (error) throw new Error(`Supabase upsert into leg_pillars failed: ${error.message}`);
    }
    return rows.length;
  }

  async getLegPillarSeries(
    sleeve: string,
    superGroup: string,
    generator: string,
    limit: number,
  ): Promise<LegPillarPoint[]> {
    // All THREE `.eq()`s load-bearing (`generator` especially: vintages share the (obs_date, sleeve,
    // super_group) prefix). `.limit(limit)` DESC then reverse — bounded at the wire (review 2026-07-25 I2).
    const { data, error } = await this.client
      .from("leg_pillars")
      .select(LEG_PILLAR_COLUMNS)
      .eq(LEG_PILLAR_COLS.sleeve, sleeve)
      .eq(LEG_PILLAR_COLS.superGroup, superGroup)
      .eq(LEG_PILLAR_COLS.generator, generator)
      .order(LEG_PILLAR_COLS.obsDate, { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Supabase read leg_pillars failed: ${error.message}`);
    const rows = asRows(data);
    // Truncation sentinel re-aimed for the bounded read: what still truncates silently is a caller asking
    // MORE than max_rows (wire cap wins over .limit). Can-fire is pinned in store.pure-seams.test.ts.
    assertNotTruncated(rows.length, "getLegPillarSeries(leg_pillars)", limit);
    // Back to oldest→newest (every caller's rolling window); `.reverse()` on the fresh asRows array.
    return rows.reverse().map((row) => ({
      date: String(row[LEG_PILLAR_COLS.obsDate]),
      value: row[LEG_PILLAR_COLS.value] == null ? null : Number(row[LEG_PILLAR_COLS.value]),
      estimated: Boolean(row[LEG_PILLAR_COLS.estimated]),
      basis: String(row[LEG_PILLAR_COLS.basis]),
    }));
  }

  async getLegPillarLatestGenerator(sleeve: string, superGroup: string): Promise<string | null> {
    // TWO `.eq()`s (omitting `generator` lets this SEE a stale vintage). NOT index-ordered — scans the
    // (sleeve, super_group) prefix across vintages (~1.8k rows, sub-ms, empty-branch only). One row → no sentinel.
    const { data, error } = await this.client
      .from("leg_pillars")
      .select(LEG_PILLAR_COLS.generator)
      .eq(LEG_PILLAR_COLS.sleeve, sleeve)
      .eq(LEG_PILLAR_COLS.superGroup, superGroup)
      .order(LEG_PILLAR_COLS.obsDate, { ascending: false })
      .limit(1);
    if (error) throw new Error(`Supabase read leg_pillars generator failed: ${error.message}`);
    const rows = asRows(data);
    const gen = rows[0]?.[LEG_PILLAR_COLS.generator];
    return gen == null ? null : String(gen);
  }

  async checkSchema(): Promise<void> {
    // Select every column with `.limit(0)`: PostgREST validates the projection with no rows, so a missing
    // column errors naming it (42703) instead of a silent NaN. readings_latest/calibration/calibration_latest asserted too.
    // `leg_pillars` enumerated because it fails INVISIBLY: ewPctCell (src/lab-served-field.ts) degrades a failed
    // read to {kind:"warmup"} on purpose, so a missing migration would paint (—) on all nine legs, like warm-up.
    // All checks run in PARALLEL (perf top-5 P5); the first failure in declared order is the one thrown.
    const tables = [
      ["readings", READINGS_COLUMNS],
      ["alert_log", ALERT_COLUMNS_ALL],
      ["readings_latest", READINGS_COLUMNS],
      ["calibration", CALIBRATION_COLUMNS],
      ["calibration_latest", CALIBRATION_COLUMNS],
      ["overrides", OVERRIDES_COLUMNS],
      ["leg_pillars", LEG_PILLAR_COLUMNS],
      ["intraday_verdict", "id,run_at,row"],
    ] as const;
    // RPCs whose consumers degrade silently on purpose, so a missing one would be invisible: readings_newest
    // (20260811190000, /lab's Lag column → NOT MEASURED), readings_newest_n (20260818140000), alert_log_recent
    // (20260818120000, getRecentAlerts/getCashPriors collapse). Empty-ids / limit:0 calls validate existence.
    const rpcs = [
      ["readings_newest", { p_ids: [] }],
      ["readings_newest_n", { p_ids: [], p_limit: 0 }],
      ["alert_log_recent", { p_limit: 0 }],
    ] as const;
    const [tableErrors, rpcErrors] = await Promise.all([
      Promise.all(tables.map(async ([table, columns]) => (await this.client.from(table).select(columns).limit(0)).error)),
      Promise.all(rpcs.map(async ([fn, args]) => (await this.client.rpc(fn, args)).error)),
    ]);
    tableErrors.forEach((error, i) => {
      if (error) throw new Error(`Supabase schema check failed for ${tables[i]![0]} (column drift?): ${error.message}`);
    });
    rpcErrors.forEach((error, i) => {
      if (error) throw new Error(`Supabase schema check failed for ${rpcs[i]![0]} (RPC missing?): ${error.message}`);
    });
  }

  async maxRowsProbe(assumedCap: number): Promise<{ count: number; observed: number | null }> {
    // Cheap head+count:"exact" — no rows shipped. `head:true` → Content-Range count, empty body.
    const { count, error } = await this.client
      .from("readings")
      .select("*", { head: true, count: "exact" });
    if (error) throw new Error(`Supabase count readings failed: ${error.message}`);
    const total = count ?? 0;
    if (total <= assumedCap) return { count: total, observed: null };
    // Gated: table bigger than the assumed cap, so one bounded select measures the real wire cap.
    const { data, error: selErr } = await this.client
      .from("readings")
      .select(READINGS_COLS.date)
      .limit(assumedCap);
    if (selErr) throw new Error(`Supabase max-rows probe failed: ${selErr.message}`);
    return { count: total, observed: data?.length ?? 0 };
  }
}

/** calibration_latest row (snake_case PostgREST) → CalibrationParam (camelCase domain). */
function rowToCalibration(row: Record<string, unknown>): CalibrationParam {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    market: str(row[CALIBRATION_COLS.market]),
    mode: str(row[CALIBRATION_COLS.mode]),
    channel: String(row[CALIBRATION_COLS.channel]),
    metric: String(row[CALIBRATION_COLS.metric]),
    value: Number(row[CALIBRATION_COLS.value]),
    ciLow: num(row[CALIBRATION_COLS.ciLow]),
    ciHigh: num(row[CALIBRATION_COLS.ciHigh]),
    method: String(row[CALIBRATION_COLS.method]),
    nEvents: num(row[CALIBRATION_COLS.nEvents]),
    windowStart: str(row[CALIBRATION_COLS.windowStart]),
    windowEnd: str(row[CALIBRATION_COLS.windowEnd]),
    notes: str(row[CALIBRATION_COLS.notes]),
    computedAt: String(row[CALIBRATION_COLS.computedAt]),
  };
}

/** Env slice the store reads — tests pass a literal. Key notes (the `_SERVICE_KEY` spelling) sit on `ENV_KEYS`;
 *  `SUPABASE_ANON_KEY` rides along for the browser pages' sign-in session, never for a store.
 *  `VERCEL` + `VERCEL_DEPLOYMENT_ID` + `PROD_WRITES` feed the host-side write switch in `getStore` (`src/prod-writes.ts`). */
export type StoreEnv = Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_KEY" | "SUPABASE_ANON_KEY" | "VERCEL" | "VERCEL_DEPLOYMENT_ID"> &
  ProdWritesEnv;

/** Store access mode: `"rw"` = the full `Store` (cron/scripts); `"ro"` = a `ReadStore` (read handlers, probes),
 *  read-only by its missing write methods, not by key — both run on the service key. */
export type StoreMode = "rw" | "ro";

/** Fail closed on a mode outside the union: an untyped caller (tsx never typechecks) can land any value in the
 *  mode slot — e.g. a deps object — and every write-switch check reads "not `ro`" as a write. Throws before any IO. */
export function assertStoreMode(mode: unknown, where: string): asserts mode is StoreMode {
  if (mode !== "ro" && mode !== "rw") {
    const shown = typeof mode === "string" ? JSON.stringify(mode) : typeof mode;
    throw new Error(`[store] ${where}: mode must be "ro" or "rw", got ${shown} — a stale caller passing its deps in the mode slot?`);
  }
}

/** A deployed Vercel function, not a host-side run that merely carries `VERCEL`: `vercel dev` and a pulled env
 *  file both set `VERCEL=1`, but only a deployment has a `dpl_` deployment id (prod `/api/status` serves one).
 *  Docs: https://vercel.com/docs/environment-variables/system-environment-variables — "VERCEL_DEPLOYMENT_ID … The unique identifier for the deployment" (example `dpl_7Gw5…`); the vercel CLI 41.7.8 dev server sets VERCEL=1, VERCEL_ENV=development, VERCEL_REGION=dev1 and no deployment id. */
function isDeployedVercelRuntime(env: Pick<StoreEnv, "VERCEL" | "VERCEL_DEPLOYMENT_ID">): boolean {
  return env.VERCEL === "1" && /^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID ?? "");
}

/** The read half of `Store` — `dry-run-store.ts`'s `READ_THROUGH` set; `listSubscriberEmails` is deliberately absent. */
type ReadMethod = Extract<keyof Store, `get${string}`> | "checkSchema" | "maxRowsProbe";
export type ReadStore = Pick<Store, ReadMethod>;

/** Runtime twin of `ReadMethod` — the ONLY methods a `getStore("ro")` handle holds. */
const READ_METHODS = [
  "getIntradayVerdict",
  "getLastAlert",
  "getLastPush",
  "getLastBand",
  "getLastAlertBefore",
  "getAlertAt",
  "getLastBandBefore",
  "getReadingsForRun",
  "getReadingVersions",
  "getRecentAlerts",
  "getCashPriors",
  "getSeries",
  "getSeriesBulk",
  "getCalibration",
  "getOverrides",
  "getAlertsSince",
  "getWarmup",
  "getScorerVintages",
  "getLegPillarSeries",
  "getLegPillarLatestGenerator",
  "getEstimateDates",
  "checkSchema",
  "maxRowsProbe",
] as const satisfies readonly ReadMethod[];
// Exhaustiveness: a `get*` added to `Store` but not listed above makes this `true` assignment a type error.
type MissingReadMethod = Exclude<ReadMethod, (typeof READ_METHODS)[number]>;
const readMethodsExhaustive: [MissingReadMethod] extends [never] ? true : MissingReadMethod = true;
void readMethodsExhaustive;

/** A plain object of ONLY the read methods (no prototype chain ⇒ a write method is `undefined` at run time);
 *  each forwarder looks the method up per call, so a prototype patch applied after `getStore` still lands. */
function readOnly(store: Store): ReadStore {
  const ro: Record<string, unknown> = {};
  for (const name of READ_METHODS) {
    ro[name] = (...args: unknown[]) => (store[name] as (...a: unknown[]) => unknown).apply(store, args);
  }
  return Object.freeze(ro) as unknown as ReadStore;
}

/** Supabase on URL+SERVICE_KEY (both modes; fail loud without): "rw" = full `Store`, "ro" = `readOnly` view.
 *  `make` builds the store from (url, key) — the test seam for the key the client gets.
 *  Write switch: a host-side "rw" store from the default factory (any target, local stack included) passes only
 *  when the checkout's prod-writes switch is on (`requireProdWrites`); a deployed Vercel function
 *  (`isDeployedVercelRuntime` — the deployed cron) skips it, and an injected `make` never reaches a database, so
 *  it is not consulted. Any mode other than exactly "ro" counts as a write; one outside the union throws first. */
export function getStore(mode: "ro", env: StoreEnv, make?: (url: string, key: string) => Store): ReadStore;
export function getStore(mode: "rw", env: StoreEnv, make?: (url: string, key: string) => Store): Store;
export function getStore(mode: StoreMode, env: StoreEnv, make?: (url: string, key: string) => Store): ReadStore | Store;
export function getStore(
  mode: StoreMode,
  env: StoreEnv,
  make?: (url: string, key: string) => Store,
): ReadStore | Store {
  assertStoreMode(mode, "getStore");
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: serviceKey } = env;
  if (!url || !serviceKey) {
    throw new Error(
      "[store] SUPABASE_URL and SUPABASE_SERVICE_KEY are required. " +
        "Local dev: the stack defaults DOWN - bring it up via `scripts/db.sh up dev` (or run the " +
        "wrapping npm script, e.g. `npm start`, which does it for you) and copy its API URL + " +
        "service_role key into .env.local. " +
        "Prod: set them in the Vercel project env.",
    );
  }
  if (mode !== "ro" && !make && !isDeployedVercelRuntime(env)) requireProdWrites("a read-write store", env);
  const store = make ? make(url, serviceKey) : new SupabaseStore(url, serviceKey);
  return mode === "ro" ? readOnly(store) : store;
}
