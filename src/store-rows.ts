/**
 * Row mappers for the `alert_log` table — the domain↔DB shape, split out of `store.ts` 2026-08-09
 * (audit round 3, R7) alongside `store-guards.ts`. Ergonomic only: no behaviour change.
 *
 * Dependency direction is one-way, the same seam `store-memory.ts` established: this module owns
 * the alert column maps and imports only TYPES from `store.ts`; `store.ts` imports the values
 * back. Nothing here does IO.
 */
import { hydrateR4Phase } from "./r4.js";
import { regimeToBand } from "./alert-band.js";
import { canonicalSleeve } from "./families.js";
import type { AlertLevel } from "./ladder.js";
import type { FallShape } from "./v-bear.js";
import type { ExposurePushState } from "./exposure.js";
import type { T1DialResult } from "./t1dial.js";
import type { PersistedPanel } from "./dial-assembly.js";
import type { MemberHistoryEntry } from "./danger-engine.js";
import type { State } from "./domain-types.js";
import type { AlertRecord, DegradeEvent } from "./store.js";
import type { RunInputs } from "./run-inputs.js";
import type { RunTimings } from "./fetch-budget.js";
import { isoDay } from "./dates.js";

/**
 * The UTC calendar date a run fired on — the key the two multi-row alert reads
 * (`getRecentAlerts` / `getAlertsSince`) collapse same-date duplicates on, in BOTH
 * implementations (the fake must not diverge from prod).
 *
 * Parsed rather than sliced: PostgREST renders `timestamptz` in the DB's timezone
 * (`...T21:00:00+00:00`) while the fake's fixtures use `Z` — `new Date(..).toISOString()`
 * normalizes both to UTC, so the bucket can't drift with a connection-timezone setting the
 * way a `firedAt.slice(0,10)` would. Matches the UTC-midnight cutoff `getLastAlertBefore`
 * already compares against (`${date}T00:00:00Z`).
 *
 * Exported for the fake in `store-memory.ts`, which must collapse on the SAME key — not part of
 * the persistence API surface.
 */
export function utcFiredDate(firedAt: string): string {
  return isoDay(new Date(firedAt));
}

// `toStoredReadings` lives in the type-only leaf `store-project.ts` (2026-08-31, DB-first stage 4.2).
// Re-exported for the existing importers.
export { toStoredReadings } from "./store-project.js";

export const ALERT_COLS = {
  date: "obs_date",
  level: "alert_level",
  bandReason: "band_reason",
  fin: "fin",
  rate: "rate",
  geoFlags: "geo_flags",
  geoCalmStreak: "geo_calm_streak",
  coincident: "coincident",
  finReds: "fin_reds",
  firedAt: "fired_at",
  pushedAt: "pushed_at",
  rederivedFrom: "rederived_from",
  // Replay inputs (migration 20261007120000) — OPT-IN read (`withRunInputs`), never in a served read set.
  runInputs: "run_inputs",
  pushError: "push_error",
  degraded: "degraded",
  // Per-run phase marks (migration 20261105120000); rewritten post-tail by `updateRunTrace`.
  timings: "timings",
  r4Phase: "r4_phase",
  r4EntryFiredAt: "r4_entry_fired_at",
  r4ReentryRung: "r4_reentry_rung",
  dialBand: "dial_band",
  heldSleeve: "held_sleeve",
  reriskConfirmCount: "rerisk_confirm_count",
  heldDays: "held_days",
  // W5-a cash overlay (migration 20260718130000). Real columns, NOT tier_state jsonb: the overlay
  // is a live decision-state field like r4_*/dial_band/held_sleeve (the same group that migration
  // 20260716210000 deliberately left OUT of the jsonb), and `dial_target_rung` is queried as a
  // number by W5-c's journal.
  cashOverlay: "cash_overlay",
  cashOverlaySince: "cash_overlay_since",
  cashOverlayReason: "cash_overlay_reason",
  // W5-d fall shape (migration 20260720170000). Real columns, not tier_state jsonb: the class is a
  // live decision-state field like cash_overlay/dial_band, and `fall_velocity` /
  // `credit_dwell_closes` are queried as numbers by the W5-e drawdown reuse the migration names.
  fallShape: "fall_shape",
  fallVelocity: "fall_velocity",
  creditDwellCloses: "credit_dwell_closes",
  dialTargetRung: "dial_target_rung",
  // The whole assembled dial persisted as one jsonb blob (migration 20260721120000). `dial_band` /
  // `dial_target_rung` above are DERIVED projections of this on write, never independently truthful
  // once it is set. In ALERT_COLUMNS so every SELECT pulls it and checkSchema asserts it.
  dialState: "dial_state",
  // The assembled family panel persisted whole as one jsonb blob (migration 20260818130000): the
  // four `assembleDial` fields `/api/lab` consumes (`PersistedPanel`). WIDE read set only (P-1:
  // `PANEL_COLUMNS`); checkSchema asserts it. Written from the SAME `assembleDial` return as
  // `dial_state`, so panel and dial share one vintage.
  panelState: "panel_state",
  // E12 DISPLAY dial/panel (migration 20261003140000): estimates included; the two above stay the notify axis.
  displayDialState: "display_dial_state",
  displayPanelState: "display_panel_state",
  // The single jsonb column the off-ladder tier fields (slow/bottom/pension) fold into as of
  // migration 20260716210000 (Stage 3). Read via `tier_state->>'<key>'`; TIER_COLS below maps
  // each domain field to its jsonb key. In ALERT_COLUMNS so every SELECT pulls it, checkSchema
  // asserts it, and rowToAlert can unpack the fields from it.
  tierState: "tier_state",
} as const;

/**
 * `tier_state` jsonb key for `nonLiveFamilies`. NOT part of TIER_COLS/TIER_FIELDS: those 20
 * fields had a like-named legacy column (retired IN PLACE — see TIER_COLS below); this one has no
 * legacy column (it was born in the jsonb). Handled explicitly in alertRow/rowToAlert.
 */
const NON_LIVE_FAMILIES_KEY = "non_live_families";

/**
 * `tier_state` jsonb key for `provisionalPushedAt` (lever 2(a)). Same jsonb-only treatment as
 * `NON_LIVE_FAMILIES_KEY` — no column, no migration, handled explicitly in alertRow/rowToAlert.
 */
const PROVISIONAL_PUSHED_AT_KEY = "provisional_pushed_at";

/**
 * `tier_state` jsonb key for `slowMaxScore` (OFF-2, 2026-08-08) — the DENOMINATOR the run's
 * `slowScore` was scored against (`2 × activeCount`, src/slow.ts). Same jsonb-only treatment as
 * `SLEEVE_DD_KEY`: no column, no migration, NOT a TIER_COLS member, handled explicitly in
 * alertRow/rowToAlert. It is persisted rather than re-derived at read time because `activeCount`
 * is the count of SCORED slow components on THAT run — the `/status` read path has only the
 * OBSERVABILITY rows (complacency split in two), so their count is not the denominator.
 */
const SLOW_MAX_SCORE_KEY = "slow_max_score";

/**
 * `tier_state` jsonb key for `exposureState` (the exposure-push repeat fix, 2026-08-09). Same
 * jsonb-only treatment as `SLEEVE_DD_KEY`: no column, no migration, NOT a TIER_COLS member, handled
 * explicitly in alertRow/rowToAlert.
 */
const EXPOSURE_STATE_KEY = "exposure_state";

/**
 * The 20 tier fields that MOVED into the `tier_state` jsonb column (Stage 3, migration
 * 20260716210000): domain camelCase → the jsonb key. The like-named legacy columns are RETIRED IN
 * PLACE: unwritten since Stage 2a, permanently NULL, and NO DROP migration will ever ship (USER
 * ruling 2026-08-01 — a destructive DROP against an irreplaceable prod history is not worth schema
 * tidiness). Do not re-open that; the columns staying is the decision, not an unfinished step.
 * These are the off-ladder / display-only tiers — none feed the fast verdict.
 * One map still serves three call sites: alertRow (build the jsonb), rowToAlert (unpack the 6
 * fields from the decoded jsonb), and getLastBand (jsonb `->>` read).
 *
 * ⚠ **`tier_state` is pinned at EXACTLY 6 keys** — `store.pure-seams.test.ts` parses `jsonb_build_object` out of
 * migration `20260716210000` and asserts the `TIER_COLS` key set equals it. A new jsonb-born field must
 * use the **explicit-key** pattern (`SLEEVE_DD_KEY`, …), NOT `TIER_COLS`. `record_run` strips
 * **top-level** nulls only, so nulls nested inside a jsonb map survive the round-trip.
 */
export const TIER_COLS = {
  slowScore: "slow_score",
  slowBand: "slow_band",
  bottomState: "bottom_state",
  vix: "vix",
  vix3m: "vix3m",
  ratio: "ratio",
} as const;

export type TierField = keyof typeof TIER_COLS;
const TIER_FIELDS = Object.keys(TIER_COLS) as TierField[];

// NARROW default read set (P-1): every column EXCEPT the `PANEL_COLUMNS` jsonb blobs only /api/lab
// consumes. `getLastAlert`/`getRecentAlerts` select this unless `withPanel` opts in.
const PANEL_COLUMNS: ReadonlySet<string> = new Set([ALERT_COLS.panelState, ALERT_COLS.displayPanelState]);
export function alertColumns(opts?: { withPanel?: boolean; withRunInputs?: boolean }): string {
  return Object.values(ALERT_COLS)
    .filter((c) => (opts?.withPanel || !PANEL_COLUMNS.has(c)) && (opts?.withRunInputs || c !== ALERT_COLS.runInputs))
    .join(",");
}
export const ALERT_COLUMNS = alertColumns();
// WIDE read set: adds the `PANEL_COLUMNS` back. Selected only where a panel is consumed (`api/lab.ts`, which serves it).
export const ALERT_COLUMNS_WITH_PANEL = alertColumns({ withPanel: true });
// `checkSchema`'s set: EVERY code-read column — panel_state and run_inputs included — is probed.
export const ALERT_COLUMNS_ALL = alertColumns({ withPanel: true, withRunInputs: true });

/** The `intraday_verdict` slot row: `alertRow` minus `run_inputs` — the slot is served (`servedVerdict`), never replayed. */
export function slotRow(a: AlertRecord): Record<string, unknown> {
  const { [ALERT_COLS.runInputs]: _runInputs, ...row } = alertRow(a);
  return row;
}

export function alertRow(a: AlertRecord): Record<string, unknown> {
  // Build the tier_state jsonb from the 20 moved fields, stripping nulls so a degraded/absent
  // field is an ABSENT key — matching the migration backfill (jsonb_strip_nulls) so the
  // `tier_state->>'<key>' is null` read filter treats "never set" and "degraded to null"
  // identically. Numbers/strings pass through as their JS values (jsonb stores them natively).
  const tierState: Record<string, unknown> = {};
  const row: Record<string, unknown> = {
    [ALERT_COLS.date]: a.date,
    [ALERT_COLS.level]: a.level,
    [ALERT_COLS.bandReason]: a.bandReason,
    [ALERT_COLS.fin]: a.fin,
    [ALERT_COLS.rate]: a.rate,
    [ALERT_COLS.geoFlags]: a.geoFlags,
    [ALERT_COLS.geoCalmStreak]: a.geoCalmStreak ?? null,
    [ALERT_COLS.coincident]: a.coincident,
    [ALERT_COLS.finReds]: a.finReds,
    [ALERT_COLS.firedAt]: a.firedAt,
    [ALERT_COLS.pushedAt]: a.pushedAt,
    [ALERT_COLS.rederivedFrom]: a.rederivedFrom ?? null,
    [ALERT_COLS.runInputs]: a.runInputs ?? null,
    [ALERT_COLS.pushError]: a.pushError,
    [ALERT_COLS.degraded]: a.degraded,
    [ALERT_COLS.timings]: a.timings ?? null,
    [ALERT_COLS.r4Phase]: a.r4Phase,
    [ALERT_COLS.r4EntryFiredAt]: a.r4EntryFiredAt,
    [ALERT_COLS.r4ReentryRung]: a.r4ReentryRung,
    // `dial_state` = the whole assembled dial (jsonb; Supabase serializes the object, like tier_state
    // below). `dial_band`/`dial_target_rung` are PROJECTIONS of it when it is non-null — the SAME
    // field mapping run-core.ts uses (`regimeToBand(dial.notifyRegime)` and `dial.targetRung`) — so the
    // scalar columns can never diverge from the blob. Legacy/degraded (null dialState) rows fall back
    // to the independently-passed scalar.
    [ALERT_COLS.dialState]: a.dialState,
    // `panel_state` = the four consumed `assembleDial` fields (jsonb; Supabase serializes the object,
    // like dial_state above). Written whole from the SAME return as `dialState`, so a co-written
    // row's panel and dial share one vintage; a null (legacy/no-panel run) reads DEGRADED on
    // /api/lab — recomputed fresh, so its panel is never OLDER than the dial (can be newer).
    // `cissHistory` rides the column as one G/A/R string per id (`encodeCissHistory`) — 576 KB → ~4 KB
    // per row; `rowToAlert` is the ONE decode site.
    [ALERT_COLS.panelState]: a.panelState == null ? null : encodePersistedPanel(a.panelState),
    [ALERT_COLS.displayDialState]: a.displayDialState,
    [ALERT_COLS.displayPanelState]: a.displayPanelState == null ? null : encodePersistedPanel(a.displayPanelState),
    [ALERT_COLS.dialBand]: a.dialState != null ? regimeToBand(a.dialState.notifyRegime) : a.dialBand,
    [ALERT_COLS.heldSleeve]: a.heldSleeve,
    [ALERT_COLS.reriskConfirmCount]: a.reriskConfirmCount,
    [ALERT_COLS.heldDays]: a.heldDays,
    // W5-a cash overlay — written EVERY run before notify (INTENT semantics, mirror of
    // dialBand/heldSleeve). `cashOverlay` is never null, so record_run's top-level-null strip
    // can't fall the column back to its 'off' default by accident.
    [ALERT_COLS.cashOverlay]: a.cashOverlay,
    [ALERT_COLS.cashOverlaySince]: a.cashOverlaySince,
    [ALERT_COLS.cashOverlayReason]: a.cashOverlayReason,
    // W5-d fall shape — written EVERY run (Stage 3.1, compute+persist only). `fallShape` is never
    // null, so record_run's top-level-null strip can't fall the column back to its
    // 'indeterminate' default by accident; the two measures stay nullable by design.
    [ALERT_COLS.fallShape]: a.fallShape,
    [ALERT_COLS.fallVelocity]: a.fallVelocity,
    [ALERT_COLS.creditDwellCloses]: a.creditDwellCloses,
    // Projection of `dial_state` (dial.targetRung) when present; else the passed scalar (legacy/degraded).
    [ALERT_COLS.dialTargetRung]: a.dialState != null ? a.dialState.targetRung : a.dialTargetRung,
  };
  // Legacy columns RETIRED IN PLACE (Stage 2a): the 20 moved fields now build ONLY the tier_state
  // jsonb (the canonical read path). The like-named legacy columns still EXIST and stay — unwritten
  // and permanently NULL; no DROP will ship (see TIER_COLS). Strip-null so an
  // absent/degraded field is an absent key — matching the migration backfill (jsonb_strip_nulls).
  for (const field of TIER_FIELDS) {
    const v = (a as unknown as Record<string, unknown>)[field];
    if (v != null) tierState[TIER_COLS[field]] = v;
  }
  // Non-live family keys (audit-extras 1.2 fix): jsonb-only, strip-null like the tier fields so
  // "never set" and "absent" read back identically as null.
  if (a.nonLiveFamilies != null) tierState[NON_LIVE_FAMILIES_KEY] = a.nonLiveFamilies;
  // Provisional-push timestamp: jsonb-only, strip-null like the tier fields above.
  if (a.provisionalPushedAt != null) tierState[PROVISIONAL_PUSHED_AT_KEY] = a.provisionalPushedAt;
  // Slow-track denominator (OFF-2): jsonb-only, strip-null like the tier fields above, so a
  // degraded slow run reads back null and the panel drops its denominator instead of inventing one.
  if (a.slowMaxScore != null) tierState[SLOW_MAX_SCORE_KEY] = a.slowMaxScore;
  // Exposure push dedup axis: jsonb-only, strip-null like the keys above. Absent = "no baseline",
  // which the next run reads as a SILENT establish-only run — never a push.
  if (a.exposureState != null) tierState[EXPOSURE_STATE_KEY] = a.exposureState;
  row[ALERT_COLS.tierState] = tierState;
  return row;
}

/** The tier fields that are numbers (the rest are string enums / bands). */
const TIER_NUMERIC: ReadonlySet<TierField> = new Set([
  "slowScore",
  "vix",
  "vix3m",
  "ratio",
]);

/**
 * Unpack the 20 off-ladder tier fields from a row's decoded `tier_state` jsonb (Stage 3).
 * An absent (stripped-null) key → null; a numeric key is coerced via Number (identity when the
 * jsonb already decoded it to a number, load-bearing only if a value ever arrives as text). The
 * per-value casts mirror the pre-split explicit coercions (SlowBand/BottomState/… are opaque to TS
 * either way). Missing/`null` tier_state (a pre-migration row, though backfill left none) → all null.
 */
function tierFieldsFromRow(row: Record<string, unknown>): Pick<AlertRecord, TierField> {
  const tier = (row[ALERT_COLS.tierState] ?? {}) as Record<string, unknown>;
  const out = {} as Record<TierField, unknown>;
  for (const field of TIER_FIELDS) {
    const v = tier[TIER_COLS[field]];
    out[field] = v == null ? null : TIER_NUMERIC.has(field) ? Number(v) : v;
  }
  return out as Pick<AlertRecord, TierField>;
}

/** `tier_state->non_live_families` → `string[] | null` (absent/malformed ⇒ null). */
function nonLiveFamiliesFromRow(row: Record<string, unknown>): string[] | null {
  const tier = (row[ALERT_COLS.tierState] ?? {}) as Record<string, unknown>;
  const v = tier[NON_LIVE_FAMILIES_KEY];
  return Array.isArray(v) ? v.map(String) : null;
}

/**
 * `tier_state->slow_max_score` → `number | null` (absent/non-finite ⇒ null). Absent on a degraded
 * slow run and on every row written before OFF-2 shipped; both mean "denominator unknown", which
 * the panel must render as such.
 */
function slowMaxScoreFromRow(row: Record<string, unknown>): number | null {
  const tier = (row[ALERT_COLS.tierState] ?? {}) as Record<string, unknown>;
  const v = tier[SLOW_MAX_SCORE_KEY];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `tier_state->exposure_state` → `ExposurePushState | null` (absent/malformed ⇒ null). Decoded by
 * PostgREST like the other jsonb-only maps. Absent on a row written before the field existed, and on
 * a run whose exposure feed was degraded with no prior state to carry — both mean "no baseline", and
 * the next run establishes one silently rather than pushing against nothing.
 *
 * The shape is validated STRUCTURALLY, not cast: a legacy/hand-edited row missing `rawPosture` would
 * otherwise flow into the comparator as `undefined` and, on a rung-blind pair, compare `undefined`
 * against a real posture — a manufactured transition, the exact failure the pair symmetry exists to
 * prevent.
 */
function exposureStateFromRow(row: Record<string, unknown>): ExposurePushState | null {
  const tier = (row[ALERT_COLS.tierState] ?? {}) as Record<string, unknown>;
  const v = tier[EXPOSURE_STATE_KEY];
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  // The latch field differs per key (`arm.armed` vs `fire.fired`) — check each by its own name, or
  // the guard passes on a half-decoded key and hands the comparator an `undefined` edge.
  const keyed = (k: unknown, latch: "armed" | "fired"): boolean =>
    k != null &&
    typeof k === "object" &&
    typeof (k as Record<string, unknown>)[latch] === "boolean" &&
    typeof (k as Record<string, unknown>).approaching === "boolean";
  if (typeof s.posture !== "string" || typeof s.rawPosture !== "string") return null;
  if (typeof s.rungBlind !== "boolean") return null;
  if (!keyed(s.arm, "armed") || !keyed(s.fire, "fired")) return null;
  return v as ExposurePushState;
}

/** `tier_state->provisional_pushed_at` → ISO string | null (absent/malformed ⇒ null). */
function provisionalPushedAtFromRow(row: Record<string, unknown>): string | null {
  const tier = (row[ALERT_COLS.tierState] ?? {}) as Record<string, unknown>;
  const v = tier[PROVISIONAL_PUSHED_AT_KEY];
  return v == null ? null : String(v);
}

const withDegradeEffect = (e: Omit<DegradeEvent, "effect"> & Partial<Pick<DegradeEvent, "effect">>): DegradeEvent => ({ ...e, effect: e.effect ?? "notify" });

/** alert_log row (snake_case PostgREST) → AlertRecord (camelCase domain). Exported for the
 *  non-DB `alertRow`→decode→`rowToAlert` round-trip unit test (the jsonb tier_state split). */
export function rowToAlert(row: Record<string, unknown>): AlertRecord {
  return {
    date: String(row[ALERT_COLS.date]),
    level: row[ALERT_COLS.level] as AlertLevel,
    bandReason: row[ALERT_COLS.bandReason] == null ? null : String(row[ALERT_COLS.bandReason]),
    fin: Number(row[ALERT_COLS.fin]),
    rate: Number(row[ALERT_COLS.rate]),
    geoFlags: Number(row[ALERT_COLS.geoFlags]),
    geoCalmStreak: row[ALERT_COLS.geoCalmStreak] == null ? null : Number(row[ALERT_COLS.geoCalmStreak]),
    coincident: row[ALERT_COLS.coincident] as State,
    finReds: Number(row[ALERT_COLS.finReds]),
    firedAt: String(row[ALERT_COLS.firedAt]),
    pushedAt: row[ALERT_COLS.pushedAt] == null ? null : String(row[ALERT_COLS.pushedAt]),
    // Key present only on a superseding row — an original row round-trips with no `rederivedFrom` key.
    ...(row[ALERT_COLS.rederivedFrom] == null ? {} : { rederivedFrom: String(row[ALERT_COLS.rederivedFrom]) }),
    pushError: row[ALERT_COLS.pushError] == null ? null : String(row[ALERT_COLS.pushError]),
    // jsonb round-trips decoded; null on a pre-migration row. A legacy event without `effect` reads `"notify"`.
    degraded: row[ALERT_COLS.degraded] == null ? null : (row[ALERT_COLS.degraded] as Parameters<typeof withDegradeEffect>[0][]).map(withDegradeEffect),
    // Key present only when stamped — a pre-migration row round-trips with no `timings` key.
    ...(row[ALERT_COLS.timings] == null ? {} : { timings: row[ALERT_COLS.timings] as RunTimings }),
    // The 20 off-ladder tier fields now live in the tier_state jsonb (Stage 3). PostgREST returns
    // the whole column DECODED (numbers as numbers, strings as strings — unlike the `->>'k'` text
    // accessor getLastBand uses), so a stripped-null (degraded/absent) key reads back as
    // undefined → null; a set numeric key is already a number (Number() is then a harmless
    // identity pin). Backfill made this uniform across historical rows — no legacy-column fallback.
    ...tierFieldsFromRow(row),
    // Non-live family keys (audit-extras 1.2 fix): jsonb array, decoded by PostgREST. Absent
    // (stripped-null / pre-migration row) → null, which the caveat gate reads as NEWS.
    nonLiveFamilies: nonLiveFamiliesFromRow(row),
    // Slow-track denominator (OFF-2, jsonb-only). Absent (stripped-null / degraded slow run / a
    // row written before this field existed) → null.
    slowMaxScore: slowMaxScoreFromRow(row),
    // Provisional-push timestamp (jsonb-only, lever 2(a)). Absent (stripped-null / pre-lever
    // row) → null, which `decideProvisional` reads as "never pushed" ⇒ the cooldown is open.
    provisionalPushedAt: provisionalPushedAtFromRow(row),
    // Exposure push dedup axis (jsonb-only). Absent (stripped-null / pre-field row / an exposure
    // outage with no prior state to carry) → null, which the next run treats as "no baseline":
    // establish it silently, never push against nothing.
    exposureState: exposureStateFromRow(row),
    // Narrowed by VALUE, not by cast — `r4_phase` is plain text with no DB CHECK, and rows written
    // before NF-1(A) carry the retired `arm1`/`arm2`. Those hydrate to `equity` (the resting state),
    // so a legacy prior can never re-enter a phase the engine no longer has. null (pre-migration /
    // degraded run) stays null: the next run's prior falls back to `equity` anyway.
    r4Phase: row[ALERT_COLS.r4Phase] == null ? null : hydrateR4Phase(row[ALERT_COLS.r4Phase]),
    r4EntryFiredAt: row[ALERT_COLS.r4EntryFiredAt] == null ? null : String(row[ALERT_COLS.r4EntryFiredAt]),
    r4ReentryRung: row[ALERT_COLS.r4ReentryRung] == null ? null : Number(row[ALERT_COLS.r4ReentryRung]),
    dialBand: row[ALERT_COLS.dialBand] == null ? null : (row[ALERT_COLS.dialBand] as AlertLevel),
    // Whole assembled dial. jsonb round-trips already DECODED by PostgREST (an object, like tier_state
    // / degraded above) — pass through, null on a pre-migration/legacy or degraded row.
    dialState: row[ALERT_COLS.dialState] == null ? null : (row[ALERT_COLS.dialState] as T1DialResult),
    // Whole assembled family panel. jsonb round-trips already DECODED by PostgREST (an object, like
    // dial_state / tier_state above) — pass through, null on a pre-migration/legacy or no-panel row.
    // Null is the DEGRADED-fallback trigger on /api/lab, never a stale serve.
    // OPT-IN key (P-1): the `panel_state` column rides the row ONLY on a wide
    // `ALERT_COLUMNS_WITH_PANEL` read; a narrow read returns NO such key, so the property is OMITTED
    // here (never null). /api/status & /api/exposure spread `verdict` whole and must emit NO
    // panelState key; a wide read of a legacy/no-panel row keeps `panelState:null` — lab's fallback.
    ...(ALERT_COLS.panelState in row
      ? { panelState: row[ALERT_COLS.panelState] == null ? null : decodePersistedPanel(row[ALERT_COLS.panelState] as PersistedPanelRow) }
      : {}),
    // E12 display twins: dial rides the narrow set like `dialState`; panel is OPT-IN like `panelState`.
    displayDialState: row[ALERT_COLS.displayDialState] == null ? null : (row[ALERT_COLS.displayDialState] as T1DialResult),
    ...(ALERT_COLS.displayPanelState in row
      ? { displayPanelState: row[ALERT_COLS.displayPanelState] == null ? null : decodePersistedPanel(row[ALERT_COLS.displayPanelState] as PersistedPanelRow) }
      : {}),
    // OPT-IN like `panelState`: only a `withRunInputs` read carries the key. jsonb arrives decoded; `fromRunInputs` checks `v`.
    ...(ALERT_COLS.runInputs in row ? { runInputs: (row[ALERT_COLS.runInputs] ?? null) as RunInputs | null } : {}),
    // The ONE hydration seam where a stored `held_sleeve` becomes a domain `heldSleeve`, so it is
    // also the one place the rung-7 rename's legacy spelling is mapped forward (`canonicalSleeve`,
    // families.ts) — display/history scope: chart labels and the rendering of pre-rename rows.
    heldSleeve: row[ALERT_COLS.heldSleeve] == null ? null : canonicalSleeve(String(row[ALERT_COLS.heldSleeve])),
    // NON-nullable in the domain, but a pre-migration row read via a pre-default DB (or the direct
    // recordAlert path before backfill) can surface null → treat as 0 (a fresh streak), never NaN.
    reriskConfirmCount: row[ALERT_COLS.reriskConfirmCount] == null ? 0 : Number(row[ALERT_COLS.reriskConfirmCount]),
    // NON-nullable in the domain, but a pre-migration row (or the direct recordAlert path before
    // backfill) can surface null → treat as 0 (a fresh dwell), never NaN.
    heldDays: row[ALERT_COLS.heldDays] == null ? 0 : Number(row[ALERT_COLS.heldDays]),
    // W5-a cash overlay. NON-nullable in the domain: a pre-migration row (or a pre-default DB)
    // surfaces null → 'off', the same fail-safe the dial-less branch writes.
    // Narrowed by VALUE, not by cast: the column is free text, so a stray/legacy value (including
    // 'full', which is R4's magnitude and must never reach the overlay's own column) reads back as
    // 'off' rather than being asserted into a type the DB does not enforce.
    cashOverlay: row[ALERT_COLS.cashOverlay] === "partial" ? "partial" : "off",
    cashOverlaySince: row[ALERT_COLS.cashOverlaySince] == null ? null : String(row[ALERT_COLS.cashOverlaySince]),
    cashOverlayReason: row[ALERT_COLS.cashOverlayReason] == null ? null : String(row[ALERT_COLS.cashOverlayReason]),
    dialTargetRung: row[ALERT_COLS.dialTargetRung] == null ? null : Number(row[ALERT_COLS.dialTargetRung]),
    // W5-d fall shape. NON-nullable in the domain: a pre-migration row (or a pre-default DB)
    // surfaces null → 'indeterminate', the same fail-safe every degraded branch of
    // `classifyFallShape` writes. Narrowed by VALUE, not by cast: the column is free text (no DB
    // CHECK — the enum is owned by `src/v-bear.ts`), so a stray/legacy value reads back as
    // 'indeterminate' rather than being asserted into a type the DB does not enforce. That is also
    // the safe direction: only 'v-shaped' diverges from today's behaviour.
    fallShape: row[ALERT_COLS.fallShape] === "v-shaped" || row[ALERT_COLS.fallShape] === "bear"
      ? (row[ALERT_COLS.fallShape] as FallShape)
      : "indeterminate",
    fallVelocity: row[ALERT_COLS.fallVelocity] == null ? null : Number(row[ALERT_COLS.fallVelocity]),
    creditDwellCloses: row[ALERT_COLS.creditDwellCloses] == null ? null : Number(row[ALERT_COLS.creditDwellCloses]),
  };
}

// ─── panel_state.cissHistory codec ─────────────────────────────────────────────────────────────────
// The member-history window used to be persisted as 40 ids × 90 full `SeriesPoint`s (576 KB/row, 96 % of the
// row). No reader touches anything but `pt.state` and `.length` (`MemberHistoryEntry` docblock), so the
// wire shape is one string per id — one char per close, oldest→newest, `G`/`A`/`R`. Unknown states
// THROW on both sides: a silent drop would shift every later close by one and corrupt the hold walk.

/** Wire shape of one `cissHistory` entry on `alert_log.panel_state`. */
export interface PersistedCissEntry {
  id: string;
  /** `G`/`A`/`R` per close, oldest→newest; `.length` = the point count. */
  states: string;
}
/** `alert_log.panel_state` as stored: `PersistedPanel` with the compact `cissHistory`. */
type PersistedPanelRow = Omit<PersistedPanel, "cissHistory"> & { cissHistory: PersistedCissEntry[] };

const STATE_CHAR: Record<State, string> = { GREEN: "G", AMBER: "A", RED: "R" };
const CHAR_STATE: Record<string, State> = { G: "GREEN", A: "AMBER", R: "RED" };

export function encodeCissHistory(history: readonly MemberHistoryEntry[]): PersistedCissEntry[] {
  return history.map((h) => ({
    id: h.id,
    states: h.history
      .map((p) => {
        const c = STATE_CHAR[p.state];
        if (c === undefined) throw new Error(`encodeCissHistory: unknown state ${JSON.stringify(p.state)} on ${h.id}`);
        return c;
      })
      .join(""),
  }));
}

/** The wire shape is `{id, states}` only — `20260905150000` rewrote every legacy full-point row on prod.
 *  A non-G/A/R char throws rather than shifting later closes. */
export function decodeCissHistory(entries: readonly PersistedCissEntry[]): MemberHistoryEntry[] {
  return entries.map((e) => ({
    id: e.id,
    history: Array.from(e.states, (c) => {
      const state = CHAR_STATE[c];
      if (state === undefined) throw new Error(`decodeCissHistory: unknown state char ${JSON.stringify(c)} on ${e.id}`);
      return { state };
    }),
  }));
}

function encodePersistedPanel(p: PersistedPanel): PersistedPanelRow {
  return { ...p, cissHistory: encodeCissHistory(p.cissHistory) };
}
function decodePersistedPanel(p: PersistedPanelRow): PersistedPanel {
  return { ...p, cissHistory: decodeCissHistory(p.cissHistory) };
}
