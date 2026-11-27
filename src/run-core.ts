/** Pure, IO-free core of the run loop — never add fetch, store IO or push here (`runScoringCycle` owns IO). */

import { DUAL_AXIS_IDS, velocityFiringCount } from "./domain-legs.js";
import { PLACEHOLDER_STATE_IDS } from "./registry-price.js";
import { type Reading } from "./domain-types.js";
import {
  assessFreshness,
  decideReassert,
  type AlertLevel,
  type Freshness,
} from "./ladder.js";
import type { NtfyMessage } from "./ntfy.js";
import type { PersistedPanel } from "./dial-assembly.js";
import { EXPOSURE_F1_LIMIT, EXPOSURE_GT_LIMIT, resolveCompoundFloor, resolveOverlayStepDown, type Posture } from "./exposure.js";
import { applyFallShape, type FallShapeVerdict } from "./v-bear.js";
import {
  type AlertRecord,
  type BandField,
  type DegradeEvent,
  type StoredReading,
  type SeriesPoint,
} from "./store.js";
import { recordDegrade, type ScoredTrack } from "./tracks.js";
import { toStoredReadings } from "./store-rows.js";
import { decideProvisional, type ProvisionalDecision } from "./provisional.js";
import { buildNotification, formatRunSummary } from "./notify_format.js";
import {
  LADDER,
  rungOfSleeve,
  type FamilyPanel,
} from "./families.js";
import {
  computeField,
  trendConfirming,
  RERISK_BASIS_EPOCH,
  type MemberHistoryEntry,
} from "./danger-engine.js";
import { buildMemberState } from "./danger-member-state.js";
import type { T1DialResult } from "./t1dial.js";
import { computeR4, R4_RESTING, type R4State, type R4Result, type R4Phase } from "./r4.js";
import { computeCashOverlay, buildCashOverlayWindow, resolveCash, CASH_REHYDRATE_DATES, type CashLevel, type CashPriorRow } from "./cash-overlay.js";
import { applyDivergenceBump, computeAlertBandDetail, coverageArmed, DE_ESCALATION_DAYS, escalatorFloorDetail, regimeToBand, verdictHoldLegs, type BandReason } from "./alert-band.js";
import { STAGE1_TRIGGER_IDS } from "./registry-geo.js";
import { STATE_RANK } from "./domain-types.js";
import { decideRotationHold } from "./rotation-commit.js";
import { loadGeoInputs } from "./geo.js";
import type { OilNowcast } from "./oil-nowcast.js";
import { isoDay } from "./dates.js";

interface AssembledRun {
  asOf: string;
  freshness: Freshness;
  alert: AlertRecord;
  storedReadings: StoredReading[];
  /** `lateSeen`: the `LATE_NOTIFY_SEEN_SCOPE` markers (notify_format.ts) — inert here; the live IO shell records them. */
  notification: { push: boolean; message: NtfyMessage; lateSeen: DegradeEvent[] };
  /** Provisional raw-RED push — MUST NOT touch the band, stored states or `alert.level`/`pushedAt`/`pushError`. */
  provisional: ProvisionalDecision;
  /** Every scored track's rows + `storedSeries(asOf)` newest — keep SEPARATE from `storedReadings` and fold
   *  over `scored`, never a hardcoded track list. Display only, never scored. */
  trackStoredReadings: StoredReading[];
  /** Bubble-tier notify; null message when degraded/no push. */
  slowNotification: { push: boolean; message: NtfyMessage | null };
  /** Bottom-tier notify; null message when degraded/no push. */
  bottomNotification: { push: boolean; message: NtfyMessage | null };
  consoleLines: string[];
}

// Defined in `store-rows.ts`; re-exported for existing importers.
export { toStoredReadings };

/**
 * Seed `stored` with this run's rows for `id`, this run winning per date — byte-equal to a post-persist `getSeries`.
 * `limit` MUST equal the read limit of `stored` (F1's `scanArmLatch` floor is an index).
 */
export function seedSeriesWithRun(
  stored: SeriesPoint[],
  runRows: StoredReading[],
  id: string,
  limit: number,
): SeriesPoint[] {
  const byDate = new Map(stored.map((p) => [p.date, p]));
  for (const r of runRows) {
    if (r.indicatorId !== id) continue;
    // Drop only `indicatorId` — the seeded point must keep `bandCuts`, matching `getSeries`.
    const { indicatorId: _dropped, estimated, ...point } = r;
    const prev = byDate.get(point.date);
    if (estimated === true && prev !== undefined && prev.estimated !== true) continue; // E7: a stored final beats this run's estimate
    byDate.set(point.date, estimated === true ? { ...point, estimated } : point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
}

/** Defined in `exposure.ts` — re-exported only; never restate the numbers. */
export { EXPOSURE_F1_LIMIT, EXPOSURE_GT_LIMIT };

/**
 * Newest reading date (`undefined` when empty). MUST throw on a non-ISO date: the max is lexicographic,
 * so one malformed cell would date the whole run.
 */
export function latestReadingDate(readings: Reading[]): string | undefined {
  for (const r of readings) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      throw new Error(
        `non-ISO reading date from ${r.indicator.id}: ${r.date} - refusing to derive asOf (feed format changed upstream)`,
      );
    }
  }
  return readings.map((r) => r.date).sort().at(-1);
}

/**
 * Pure core of one scoring cycle — `now`/`geoFlags` stay injected, never read here. Never add an
 * `equityPct` input beside `exposurePosture`: the weight is derived here off the bound.
 */
export function assembleRun(opts: {
  readings: Reading[];
  /** Persistence input (`storedReadings` = `toStoredReadings` over it); omitted ⇒ `readings`. A live-verdict
   *  state override MUST NOT reach it — it would stamp a synthetic state into back-dated history. */
  readingsForStore?: Reading[];
  last: AlertRecord | null;
  /** SCORING prev-state (latest alert of a PRIOR fired-day): dwell/streak/R4/hold MUST read this, never
   *  `last` (the notify baseline). Absent ⇒ `last`; `null` = no prior fired-day. */
  prevDay?: AlertRecord | null;
  lastPush: AlertRecord | null;
  now: string;
  geoFlags?: number;
  /** Declared GEO crisis stage 0–4, folded in as `STAGE_TO_FLAGS[stage]` extra flags; default 0. */
  crisisStage?: number;
  /** Off-ladder tracks in TRACKS order; default `[]` ⇒ all off-ladder alert fields null. */
  scored?: ScoredTrack[];
  /** The last NON-NULL band per track (TRACKS order) — the degraded-safe notify baseline. */
  lastBands?: (string | null)[];
  /** T1 danger dial — build it the SAME way `/api/lab` does. Absent ⇒ r4 columns stay null (R4 never fires). */
  dial?: T1DialResult;
  /** The exact `.families` fed to `computeT1Dial`; absent ⇒ no auto-hold, `heldSleeve` null. */
  globalFamilies?: FamilyPanel[];
  /** Member history (hold / regime / ROC) — MUST be fetched on the cron path too; absent ⇒ unheld member state, no regime/ROC bases. */
  cissHistory?: MemberHistoryEntry[];
  /** Persisted to `panel_state` in the same write as `dialState`; absent ⇒ null and the read path re-runs `assembleDial`. */
  panelState?: PersistedPanel;
  /** DISPLAY dial (estimates included) → `display_dial_state`; absent ⇒ null. Never feeds notify. */
  displayDialState?: T1DialResult;
  /** DISPLAY panel twin of `panelState` → `display_panel_state`; absent ⇒ null. */
  displayPanelState?: PersistedPanel;
  /** Growth-pillar RS/momentum per sleeve for `computeField`; absent ⇒ trend-only growth. They move the served
   *  growth only, never `held`; `growth.live` is NOT a "rs/mom supplied" predicate (any term ⇒ live). */
  rsBySleeve?: Map<string, number | null>;
  momBySleeve?: Map<string, number | null>;
  /** Last N−1 non-null raw dial bands, most-recent first, from store history; absent ⇒ `[prevDay.dialBand]`. */
  recentDialBands?: AlertLevel[];
  /** Last `CASH_REHYDRATE_DATES` alert rows, most-recent first, for the cash-overlay window. Absent ⇒
   *  `[prevDay]` — a TESTS-ONLY fallback; the cron path MUST always pass it. */
  recentAlerts?: CashPriorRow[];
  /** This close's exposure posture; the equity weight MUST be derived from it here, never passed beside it.
   *  null ⇒ an unsized push, never a fabricated weight. */
  exposurePosture?: Posture | null;
  /** V-vs-bear verdict; `v-shaped` suppresses the cash overlay only (band/dial/held untouched). null ⇒ 'indeterminate'. */
  fallShape?: FallShapeVerdict | null;
  /** Snapshot of the degrade log (`peekDegradeLog()`) for the push caveat; absent ⇒ count-only annotation. */
  degradeEvents?: DegradeEvent[];
  /** QQQ distance-to-252d-high + calibrated near-high tol — feed BOTH band paths' divergence bump; null ⇒ no bump. */
  spDistToHigh?: number | null;
  nearHighTol?: number | null;
  /** GLOBAL-channel readings (F10 lives only here) — never feed the band, the stored rows or the summary. */
  globalReadings?: Reading[];
  /** Same-day BRENT/G1 spot estimates + the notify dial's folded heads, by id, for the push's `est.` clauses only —
   *  never a Reading, a stored row, or a band input. */
  oilEst?: Partial<Record<string, OilNowcast | null>>;
}): AssembledRun {
  const { readings, last, lastPush, now, geoFlags = 0, crisisStage = 0, scored = [], lastBands = [], dial, globalFamilies, cissHistory, recentDialBands, recentAlerts, degradeEvents, exposurePosture = null, fallShape = null, spDistToHigh = null, nearHighTol = null } = opts;
  // Only `undefined` falls back to `last`; an explicit null MUST stay null (first-hold semantics).
  const prevDay = opts.prevDay === undefined ? last : opts.prevDay;
  const asOf = latestReadingDate(readings) ?? now.slice(0, 10);
  // Gate every per-close counter on this — a re-run that re-sees the same close must not double-count.
  const newTradingClose = prevDay?.date == null || asOf > prevDay.date;

  // GEO calm streak: an absent trigger reading MUST hold the prior value — blindness is neither calm nor lit.
  const prevCalmStreak = prevDay?.geoCalmStreak ?? DE_ESCALATION_DAYS;
  const triggerStates = [...STAGE1_TRIGGER_IDS].map(
    (id) => readings.find((r) => r.indicator.id === id)?.state,
  );
  const anyTriggerLit = triggerStates.some((s) => s !== undefined && STATE_RANK[s] >= STATE_RANK.AMBER);
  const allTriggersGreen = triggerStates.every((s) => s === "GREEN");
  const geoCalmStreak = anyTriggerLit
    ? 0
    : allTriggersGreen && newTradingClose
      ? prevCalmStreak + 1
      : prevCalmStreak;

  // MUST run before the band site — its phase feeds the escalator floor. No dial ⇒ stays `R4_RESTING`
  // (reassigned, never mutated).
  let r4: R4Result = R4_RESTING;
  if (dial) {
    const hyOas = readings.find((r) => r.indicator.id === "F1")?.level ?? null;
    const vt = readings.find((r) => r.indicator.id === "VT")?.level ?? null;
    const prior: R4State = {
      phase: prevDay?.r4Phase ?? "equity",
      entryFiredAt: prevDay?.r4EntryFiredAt ?? null,
      reentryRung: prevDay?.r4ReentryRung ?? null,
    };
    r4 = computeR4(dial, hyOas, vt, prior, () => now);
  }

  // The cash overlay READS the dial and MUST never feed the ladder (band/dialBand/heldSleeve/push dedup).
  // `applyFallShape` wraps its OUTPUT so the column, the /lab chip and the push body read one object.
  const cashOverlay = applyFallShape(
    computeCashOverlay(
      dial ?? null,
      {
        recentTargetRungs: buildCashOverlayWindow(recentAlerts ?? (prevDay ? [prevDay] : []), asOf),
        since: prevDay?.cashOverlaySince ?? null,
      },
      () => now,
    ),
    fallShape?.shape ?? "indeterminate",
  );

  // Band and `bandReason` MUST come from the same deciding branch below — no parallel re-derivation.
  // `verdictHoldLegs` reads each reading's `stampFreshness` stamp — never resolve against a second clock here.
  const legsLagging = verdictHoldLegs(readings);

  let band: AlertLevel;
  let bandReason: BandReason;
  if (dial) {
    const detail = computeAlertBandDetail({
      dial,
      readings,
      geoFlags,
      crisisStage,
      geoCalmStreak,
      r4Phase: r4.phase,
      recentDialBands: recentDialBands ?? (prevDay?.dialBand != null ? [prevDay.dialBand] : []),
      verdictHoldFloor: legsLagging.length > 0 ? (prevDay?.level ?? undefined) : undefined,
      // Coverage floor peers MUST stay a subset of the panel's population and exclude `PLACEHOLDER_STATE_IDS`
      // — that can only fail to arm; widening them can over-arm the WATCH floor.
      coverageArmed: coverageArmed(
        opts.globalFamilies ?? [],
        readings
          .filter((r) => !PLACEHOLDER_STATE_IDS.has(r.indicator.id))
          .map((r) => ({ cadence: r.indicator.cadence, lag: r.lag })),
      ),
      spDistToHigh,
      nearHighTol,
    });
    band = detail.band;
    bandReason = detail.reason;
  } else {
    // No dial ⇒ floor-only: the FIRE key stays un-turned and the verdict-hold MUST NOT be applied here.
    const floor = escalatorFloorDetail(readings, geoFlags, r4.phase, false, false, crisisStage, false, geoCalmStreak);
    const bumped = applyDivergenceBump(
      { band: floor.band, reason: floor.source ? `floor:${floor.source}` : "no-dial" },
      readings,
      spDistToHigh,
      nearHighTol,
    );
    band = bumped.band;
    bandReason = bumped.reason;
  }

  // Diagnostic only — `band`/`bandReason` and `alert-band.ts` MUST never read it. Scan main + GLOBAL
  // readings: a GLOBAL-channel id lives only in `globalReadings`.
  const velocityFiring = velocityFiringCount(
    opts.globalReadings ? [...readings, ...opts.globalReadings] : readings,
  );
  console.log(`[d3] velocityFiring=${velocityFiring}/${DUAL_AXIS_IDS.length} dual-axis ids (diagnostic only, band untouched)`);
  // MUST stay on the same axis as `computeAlertBandDetail`'s `dialBand` — the lag window re-reads these
  // persisted values as `recentDialBands`.
  const dialBand: AlertLevel | null = dial ? regimeToBand(dial.notifyRegime) : null;

  // Auto-hold needs dial + panel, else `heldSleeve` stays null (never undefined). `held` may sit either
  // side of the dial sleeve — the dial gives the band, the per-leg read picks the sleeve.
  let heldSleeve: string | null = null;
  let reriskConfirmCount = 0;
  let heldDays = 0;
  let hold: {
    held: string;
    dialSleeve: string;
    override: boolean;
    prevHeld: string | null;
    changed: boolean;
  } | undefined;
  if (dial && globalFamilies) {
    // MUST span both reading sets — F10 lives only in `globalReadings`. Unstamped `lag` ⇒ "not assessed".
    const freshness = [...readings, ...(opts.globalReadings ?? [])].map((r) => ({
      id: r.indicator.id,
      lag: r.lag,
    }));
    // `prevTarget` MUST be the prior DIAL target, never the held rung (dial-vs-pick ping-pongs the hold);
    // `prevHeld`/`prevRung` stay held reads. Map sleeves only via `rungOfSleeve` (shared with api/exposure.ts).
    const prevHeld = prevDay?.heldSleeve ?? null;
    const prevRung = rungOfSleeve(prevHeld) ?? 0;
    const prevTarget = prevDay?.dialTargetRung ?? null;
    const field = computeField(
      { globalFamilies, freshness },
      dial.band,
      undefined,
      prevTarget,
      cissHistory,
      opts.rsBySleeve,
      opts.momBySleeve,
      // `assembleRun` MUST run above `drainDegradeLog()` or this event misses the persisted trace.
      { onDegrade: (scope, reason) => recordDegrade(scope, reason, "notify") },
      dial.targetRung, // the ●: `rising` compares it (not `band.hi`) to prevTarget now that hi floats
    );
    const dialSleeve = LADDER[dial.targetRung - 1] ?? LADDER[LADDER.length - 1]!;
    // Structural floor only — never taken on live data; nothing may silently rely on it.
    if (!field.held) {
      console.warn(
        `[auto-hold] empty in-band field for band ${dial.band.lo}-${dial.band.hi} - falling back to dial sleeve ${dialSleeve}`,
      );
    }
    const candidateSleeve = field.held?.sleeve ?? dialSleeve;

    // Advances per FIRED-DATE (a re-run pushes it; `heldDays` doesn't) — intended, do not fix. A streak from
    // before `RERISK_BASIS_EPOCH` reads as 0 here — never rewrite the stored `alert_log` rows instead.
    const prevConfirmLagging = prevDay?.date != null && prevDay.date < RERISK_BASIS_EPOCH;
    const prevConfirmCount = prevConfirmLagging ? 0 : (prevDay?.reriskConfirmCount ?? 0);
    const candidateRung = rungOfSleeve(candidateSleeve) ?? 0;
    // MUST compare against the HELD rung (`prevRung`), not `prevTarget`.
    const improving = prevRung > 0 && dial.targetRung < prevRung;
    // Re-risk also needs no trend member confirmed RED; de-risk stays un-gated.
    const trendOk = trendConfirming(buildMemberState({ globalFamilies, freshness }));
    const decision = decideRotationHold({
      candidateSleeve,
      prevHeld,
      prevRung,
      candidateRung,
      improving,
      trendOk,
      prevConfirmCount,
      prevHeldDays: prevDay?.heldDays ?? 0,
      newClose: newTradingClose,
      // Leave `drawdownGateFires` and `gates` unset — probe-only seams; the live path has no timing gate.
    });
    heldSleeve = decision.heldSleeve;
    reriskConfirmCount = decision.reriskConfirmCount;
    heldDays = decision.heldDays;

    // `hold` is a NOTIFY payload: its notify fields MUST read `last`, never `prevDay`.
    const notifyPrevHeld = last?.heldSleeve ?? null;
    hold = {
      held: heldSleeve,
      dialSleeve,
      override: heldSleeve !== dialSleeve,
      // MUST share `changed`'s baseline or the text disagrees with the dedup key.
      prevHeld: notifyPrevHeld,
      // Push trigger — MUST dedup against `last`, never `prevDay` (else same-day re-runs re-push);
      // a null baseline is a silent first hold.
      changed: notifyPrevHeld != null && heldSleeve !== notifyPrevHeld,
    };
  }

  // Compound floor: apply after `heldSleeve` resolves, via the SAME resolver as `api/exposure.ts`.
  const heldRung = rungOfSleeve(heldSleeve);
  const floored = resolveCompoundFloor(exposurePosture, heldRung);
  // Step-down is NOT re-clamped by the floor and keys off the PUBLISHED cash level, never `cashOverlay.level`;
  // nothing here may feed back into `computeCashOverlay`.
  const publishedCash = resolveCash(r4, cashOverlay, floored.equityPct).level;
  const equityPct = resolveOverlayStepDown(floored.posture, publishedCash).equityPct;

  const { lines, summary } = formatRunSummary(readings, band, dial, globalFamilies);

  const freshness = assessFreshness(asOf, now.slice(0, 10));

  // Decide the push here so the alert row records its intent; it stays upward-only vs `last.level`.
  const reassertDue = decideReassert(band, lastPush?.pushedAt ?? null, now, {
    lastPushFailed: last?.pushError != null,
  });
  const notification = buildNotification(last, band, dial, globalFamilies, readings, asOf, { freshness, reassertDue, r4, hold, degradeEvents, cashOverlay, equityPct, verdictHoldLegs: legsLagging, oilEst: opts.oilEst, globalReadings: opts.globalReadings });

  // Kept apart from `notification`: its ONLY alert-row write is `provisionalPushedAt`.
  const provisional = decideProvisional(
    opts.globalReadings ? [...readings, ...opts.globalReadings] : readings,
    last?.provisionalPushedAt ?? null,
    now,
  );

  // Persistence takes the honest array — never a live-verdict override (see `readingsForStore`).
  const storedReadings: StoredReading[] = toStoredReadings(opts.readingsForStore ?? readings);
  const alert: AlertRecord = {
    date: asOf,
    // `fin`/`rate`/`coincident`/`finReds` are dead NOT-NULL columns held neutral until dropped;
    // `geoFlags` is live — persist the real injected count.
    level: band,
    bandReason,
    fin: 0,
    rate: 0,
    geoFlags,
    geoCalmStreak,
    coincident: "GREEN",
    finReds: 0,
    firedAt: now,
    // INTENT here; `runScoringCycle` overwrites `pushedAt`/`pushError` with the send OUTCOME.
    pushedAt: notification.push ? now : null,
    pushError: null,
    // `runScoringCycle` overwrites this with the drained degrade events before `recordRun`.
    degraded: [],
    // Persist EVERY run (null = unknown, read as news) — the next push dedups its caveat against it.
    nonLiveFamilies: globalFamilies ? globalFamilies.filter((f) => !f.live).map((f) => f.key) : null,
    // CARRY-FORWARD: a quiet run MUST keep the prior stamp or the cooldown resets every cron.
    provisionalPushedAt: provisional.push ? now : (last?.provisionalPushedAt ?? null),
    // Init NULL (degraded ≠ CALM); overwritten by each scored track's `alertFields` below.
    slowScore: null,
    slowBand: null,
    slowMaxScore: null,
    bottomState: null,
    vix: null,
    vix3m: null,
    ratio: null,
    // A dial-less run MUST persist null — the local `r4` defaults to a live resting value.
    r4Phase: dial ? r4.phase : null,
    r4EntryFiredAt: r4.entryFiredAt,
    r4ReentryRung: r4.reentryRung,
    dialBand,
    // `alertRow` derives `dial_band`/`dial_target_rung` from this blob — never write them independently.
    dialState: dial ?? null,
    panelState: opts.panelState ?? null,
    displayDialState: opts.displayDialState ?? null,
    displayPanelState: opts.displayPanelState ?? null,
    heldSleeve,
    reriskConfirmCount,
    heldDays,
    // The overlay's OWN level only ('off' | 'partial'); 'full' is r4Phase's — merge only via `resolveCash`.
    cashOverlay: cashOverlay.level,
    cashOverlaySince: cashOverlay.since,
    cashOverlayReason: cashOverlay.reason,
    dialTargetRung: dial ? dial.targetRung : null,
    // Read-time-only columns — nothing reads them back.
    fallShape: fallShape?.shape ?? "indeterminate",
    fallVelocity: fallShape?.velocity ?? null,
    creditDwellCloses: fallShape?.dwell ?? null,
  };
  // A track absent from `scored` keeps its literal nulls; projections touch disjoint columns.
  Object.assign(alert, ...scored.map((s) => s.alertFields));

  // Baseline MUST be the prior NON-NULL band (`lastBands[i]`), never this run's field. `scored[i]` and
  // `lastBands[i]` are positionally coupled — keep their orders matched.
  const trackNotes = scored.map((s, i) => ({ field: s.baselineField, note: s.notification(lastBands[i] ?? null, asOf) }));
  const noteFor = (field: BandField): { push: boolean; message: NtfyMessage | null } =>
    trackNotes.find((t) => t.field === field)?.note ?? { push: false, message: null };
  const slowNotification = noteFor("slowBand");
  const bottomNotification = noteFor("bottomState");

  // Fold over `scored` generically — never a hardcoded track list.
  const trackStoredReadings = scored.flatMap((s) => [
    ...s.rows,
    ...[...s.storedSeries(asOf).values()].flatMap((series) => series.slice(-1)),
  ]);

  return {
    asOf,
    freshness,
    alert,
    storedReadings,
    notification,
    provisional,
    trackStoredReadings,
    slowNotification,
    bottomNotification,
    consoleLines: [...lines, `${summary} · as of ${asOf}`],
  };
}

const MS_PER_WALK_DAY = 86_400_000;

/** One day of the forward-walk leg path. */
export interface WalkLegStep {
  day: number;
  date: string;
  band: AlertLevel;
  heldSleeve: string | null;
  r4Phase: R4Phase | null;
  r4ReentryRung: number | null;
  cashOverlay: CashLevel;
  /** Re-risk confirm counter for this day. Never add a `{lo,hi}` band column beside it — it is constant
   *  across a walk (`dial` is frozen). */
  reriskConfirmCount: number;
}

/** Day-0 prod position + rolling-window tails the caller reads from the store once. */
interface WalkSeed {
  /** `getLastAlert()` — used as BOTH day-1 `prevDay` and the notify baseline. */
  alert: AlertRecord;
  /** `getLastBandBefore("dialBand")` tail, most-recent first. */
  recentDialBands: AlertLevel[];
  /** `getCashPriors(CASH_REHYDRATE_DATES)`, most-recent first. */
  recentAlerts: CashPriorRow[];
}

/** Today's conditions, held constant for all N days; the caller does every store read. */
interface WalkFrozenInputs {
  readings: Reading[];
  lastPush: AlertRecord | null;
  geoFlags?: number;
  /** Omitted ⇒ the LIVE config stage (not 0), so a walk day matches the next cron; tests pass 0. */
  crisisStage?: number;
  dial?: T1DialResult;
  globalFamilies?: FamilyPanel[];
  cissHistory?: MemberHistoryEntry[];
  exposurePosture?: Posture | null;
  fallShape?: FallShapeVerdict | null;
}

export interface WalkForwardResult {
  /** The day-N assembled run (its `.alert` is the endpoint the board renders). */
  final: AssembledRun;
  /** Per-day leg/rung path, day 1..N. */
  legPath: WalkLegStep[];
}

/**
 * Pure forward walk (`/lab?walk=N`) from prod's position, today's conditions frozen, `n >= 1`. MUST reuse
 * `assembleRun` so a walk day is byte-identical to a cron day.
 */
export function walkForward(seed: WalkSeed, frozen: WalkFrozenInputs, n: number): WalkForwardResult {
  const seedDate = seed.alert.date ?? (frozen.readings.map((r) => r.date).sort().at(-1) as string);
  const seedMs = Date.parse(`${seedDate}T00:00:00.000Z`);
  const simulated: AlertRecord[] = []; // oldest-first (append order)
  const legPath: WalkLegStep[] = [];
  let prev: AlertRecord = seed.alert;
  let final: AssembledRun | null = null;

  for (let d = 1; d <= n; d++) {
    const dateStr = isoDay(new Date(seedMs + d * MS_PER_WALK_DAY));
    const nowIso = `${dateStr}T21:00:00.000Z`;
    // Re-date so `asOf` strictly advances; never mutate the shared indicator ref.
    const readings = frozen.readings.map((r) => ({ ...r, date: dateStr }));
    // Nulls are dropped from the dial-band window, mirroring the cron's non-null read.
    const newestFirst = [...simulated].reverse();
    const recentDialBands: AlertLevel[] = [
      ...newestFirst.map((a) => a.dialBand).filter((b): b is AlertLevel => b != null),
      ...seed.recentDialBands,
    ];
    const recentAlerts: CashPriorRow[] = [...newestFirst, ...seed.recentAlerts].slice(0, CASH_REHYDRATE_DATES);

    const run = assembleRun({
      readings,
      last: prev,
      prevDay: prev,
      lastPush: frozen.lastPush,
      now: nowIso,
      geoFlags: frozen.geoFlags ?? 0,
      crisisStage: frozen.crisisStage ?? loadGeoInputs().crisisStage,
      dial: frozen.dial,
      globalFamilies: frozen.globalFamilies,
      cissHistory: frozen.cissHistory,
      recentDialBands,
      recentAlerts,
      exposurePosture: frozen.exposurePosture ?? null,
      fallShape: frozen.fallShape ?? null,
    });
    simulated.push(run.alert);
    legPath.push({
      day: d,
      date: run.asOf,
      band: run.alert.level,
      heldSleeve: run.alert.heldSleeve,
      r4Phase: run.alert.r4Phase,
      r4ReentryRung: run.alert.r4ReentryRung,
      cashOverlay: run.alert.cashOverlay,
      reriskConfirmCount: run.alert.reriskConfirmCount,
    });
    prev = run.alert;
    final = run;
  }
  // n >= 1 by contract, so `final` is always assigned.
  return { final: final as AssembledRun, legPath };
}

