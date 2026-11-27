/**
 * Alert-band plumbing shared by the notify path: the 4-value alert band
 * (OK/WATCH/WARNING/CRITICAL), notify-on-upgrade-only / no-repeat discipline
 * (v4 §6.5), the weekly re-assert, and the feed-freshness heartbeat. Stateless
 * pure functions — persistence lives in store.ts, band derivation in
 * alert-band.ts (the T1 dial replaced the per-channel verdict engine, O2).
 */

import { decideUpward } from "./notify_tier.js";
import type { Cadence, Indicator } from "./domain-types.js";

export type AlertLevel = "OK" | "WATCH" | "WARNING" | "CRITICAL";

export const ALERT_RANK: Record<AlertLevel, number> = {
  OK: 0,
  WATCH: 1,
  WARNING: 2,
  CRITICAL: 3,
};

interface NotifyDecision {
  push: boolean;
  transition: string | null; // "WATCH -> WARNING" when push, else null. ASCII arrow: Title is an HTTP header (latin1).
}

/**
 * Notify-on-upward-change (v4 §6.5): push only when the alert level rises.
 * Same-level repeats and downgrades are silent. `last === null` (first-ever run)
 * is treated as an OK baseline — a green first run is silent, an already-elevated
 * first run pushes. Pure: no IO, no time.
 */
export function decideNotify(last: AlertLevel | null, next: AlertLevel): NotifyDecision {
  return decideUpward((l) => ALERT_RANK[l], last ?? "OK", next);
}

/** Re-assert a stuck alert if this many days have passed since the last push (Phase 3). */
export const REASSERT_AFTER_DAYS = 7;

/**
 * Weekly re-assert (v4 §5 pre-mortem, Phase 3): should a still-elevated alert be
 * re-pushed even without an upward change? True only when the level is
 * `>= WARNING` AND it's been `>= intervalDays` since the last actual push
 * (`lastPushAt`, distinct from the last run). A null `lastPushAt` means we've
 * never pushed while this high — assert now. Pure: `now`/`lastPushAt` are ISO
 * strings passed in. run-core.ts always computes this and ORs it with the upward-change
 * push (an upward change still wins the title); it only changes the outcome when
 * notify-on-change would otherwise have stayed silent.
 */
export function decideReassert(
  level: AlertLevel,
  lastPushAt: string | null,
  now: string,
  opts: { lastPushFailed?: boolean; intervalDays?: number } = {},
): boolean {
  const { lastPushFailed = false, intervalDays = REASSERT_AFTER_DAYS } = opts;
  // Audit rank 1: a WARRANTED push that FAILED to deliver (push_error set on the latest alert)
  // re-fires the band next run regardless of interval — the owner never received it.
  // push_error is only set for a warranted (>= WATCH) push, but the band may have DROPPED
  // since the failure: only re-fire while the current level still warrants a push (>= WATCH);
  // a band back at OK makes the missed push moot.
  if (lastPushFailed && ALERT_RANK[level] >= ALERT_RANK.WATCH) return true;
  if (ALERT_RANK[level] < ALERT_RANK.WARNING) return false;
  if (lastPushAt === null) return true;
  const days = (Date.parse(now) - Date.parse(lastPushAt)) / 86_400_000;
  return days >= intervalDays;
}

/**
 * A feed older than this many CALENDAR days is "lag" — the WHOLE-RUN heartbeat (Phase 3), and since
 * slice 3 (2026-09-09) that is its ONLY role: it is the default cut of {@link assessFreshness}, which
 * `run-core.ts` runs over the run's max observation date.
 *
 * ⚠ DECOUPLED FROM {@link LAG_THRESHOLDS}`.daily` ON 2026-09-09. That tier moved to PUBLICATION
 * SLOTS and reads 1; this stays 4 CALENDAR days, deliberately, because the heartbeat is the
 * backstop for the one case slot age cannot see — a wholly frozen roster, where every slot age
 * reads 0 because nothing published at all. Converting it would delete the backstop.
 *
 * ⚠ 4, NOT 3 (2026-08-03) — the difference is STRUCTURAL, not slack. A T+1-published business-day
 * series read on a Monday is FOUR calendar days old at best (Thursday's value; Friday's has not
 * been published by anyone yet), so a cut of 3 was unsatisfiable by a perfectly healthy feed on
 * 27.5% of all days.
 *
 * The AMBITION is still 3 — see {@link AMBITION_THRESHOLDS}, which keeps every day past
 * that visible in the `/lab` footnote without arming a mark.
 */
const STALE_AFTER_DAYS = 4;

export interface Freshness {
  lag: boolean;
  ageDays: number; // slots (daily/weekly, read path) OR calendar days (monthly/quarterly, and every calendar-day caller) — read `unit`
  /**
   * The UNIT of `ageDays` (§5's two-unit wart, surfaced in the type so no consumer can pair the
   * number with the wrong unit). `assessFreshness`/`assessIndicatorFreshness` are the calendar-day
   * path and always stamp `"days"` — since slice 3 that path is the whole-run heartbeat plus the
   * monthly/quarterly cadences ONLY. The slot path (`stampFreshness` on the run, `freshnessFrom`
   * stages 1-2 on the read, both for daily/weekly) builds this value directly with `"slots"`.
   */
  unit: "slots" | "days";
}

/**
 * Heartbeat (v4 §6.5, Phase 3): is the data feed fresh? Compares the freshest
 * FRED observation date (`asOf`) against `today` — both `YYYY-MM-DD`. A run that
 * keeps firing but reads frozen FRED data (vs. the dead-man ping, which catches a
 * run that stops firing) is caught here. Pure: `Date.parse` of a date-only string
 * is UTC midnight, so the diff is deterministic and timezone-free.
 *
 * ⚠ THE OLD "occasional benign lag is acceptable" CARVE-OUT IS RETIRED (2026-08-03).
 * This docblock used to say a holiday weekend can push `ageDays` to 4–5 legitimately and
 * that the resulting false lag was tolerable because the heartbeat was informational /
 * non-paging. BOTH halves failed: the feed-lag wave (2026-08-02) promoted this same bit
 * onto the Dashboard cards and family headings, so it is no longer non-paging; and the
 * lag was never "occasional" — it is every Monday and nearly every Tuesday. The fix is
 * that the CUT now covers the publication calendar ({@link LAG_THRESHOLDS}), so a
 * "lag" here means a feed genuinely missed a release rather than that a weekend passed.
 */
export function assessFreshness(asOf: string, today: string, maxAgeDays = STALE_AFTER_DAYS): Freshness {
  const ageDays = Math.floor((Date.parse(today) - Date.parse(asOf)) / 86_400_000);
  return { lag: ageDays > maxAgeDays, ageDays, unit: "days" };
}

/**
 * Per-cadence lag cut (audit rank 6 — per-feed lag). The whole-run heartbeat above only knows the
 * MAX date across all readings, so one fresh feed masks a frozen one; this drives the PER-INDICATOR
 * age surfaced in /api/status, the `/lab` board, and the run path's `Reading.lag` stamp.
 *
 * ⚠ TWO UNITS, ONE TABLE (slice 3, 2026-09-09).
 * `daily`/`weekly` are counted in PUBLICATION SLOTS (`slotAge`, publication-calendar.ts): the feed's
 * own publication days strictly after its newest observation. `monthly`/`quarterly` stay CALENDAR
 * days — a daily containment grid has no opinion about when a monthly feed is due. Every producer
 * stamps `Freshness.unit`, so no number is ever paired with the wrong unit.
 *
 * ⚠ THE READ/RUN TWO-TABLE STATE IS GONE. `LAG_SLOT_THRESHOLDS`/`slotCutFor` — the read-path-only
 * slot tier that shipped in slice 2 — were DELETED here on 2026-09-09; both paths now resolve
 * through {@link lagCutFor} over this one table, which is what makes the divergence unre-openable.
 *
 * ⚠ `daily: 1` REPLACED THE CALENDAR-DAY `4` (which was `STALE_AFTER_DAYS`), and the two are now
 * DECOUPLED. {@link STALE_AFTER_DAYS} keeps its 4 for the whole-run calendar-day heartbeat
 * (`assessFreshness`, run-core.ts), which stays on calendar days BY RULING: it is the backstop for
 * a wholly frozen roster, the one case slot age reads 0. The old 4 was the STRUCTURAL Monday
 * reading of a healthy T+1 feed (Thursday's value is the newest that exists anywhere, so a cut of 3
 * was unsatisfiable on 27.5% of all days); slots delete that weekend/holiday term outright, so a
 * healthy T+1 feed reads exactly ONE publication behind on every weekday and 1 stays maximally
 * sensitive — a single missed release reads 2 and is flagged the next day.
 *
 * ⚠ `weekly: 5` REPLACED `9` on the same ruling and for the same reason: a weekly feed rides the
 * SAME daily union grid and spends ~5 daily slots between prints, so one publication behind is ~5
 * slots and the holiday term that inflated its calendar-day cut drops out.
 *
 * ⚠ THE SURVIVING PER-ID `lagAfterDays` OVERRIDES ARE CALENDAR-DAY VALUES, resolved as slots by
 * {@link lagCutFor}, on weekly AND daily ids — roster: `grep -n lagAfterDays src/registry-*.ts`.
 * Every one must stay LOOSER than its tier, so no override can manufacture a lag flag.
 *
 * ⚠ SCOPE: the roster that structurally reaches the daily tier is DELIBERATELY NOT ENUMERATED HERE
 * — an id list restated beside the table that owns it rots (the copy that used to sit on this line
 * had rotted twice). `scripts/probe-readpath-lag.ts` DERIVES the cluster from the registry.
 *
 * ⚠ `deepLagRhythm` (feed-lag.ts) floors the DEEP-LAG bar at 2× the TIER, so these values move that
 * bar for every explicitly-registered id whose registered cadence resolves here. Disclosed, not
 * guarded — a guard would have to restate the tier, creating the second source {@link lagCutFor}
 * exists to prevent.
 */
export const LAG_THRESHOLDS: Record<Cadence, number> = {
  daily: 1, // PUBLICATION SLOTS — a T+1 feed is exactly one publication behind; why → the docblock
  weekly: 5, // PUBLICATION SLOTS — ~5 daily slots between weekly prints; why → the docblock
  monthly: 40, // CALENDAR days — ~one publication + slack
  quarterly: 120, // CALENDAR days — ~one publication + slack
};

/**
 * THE AMBITION, not the alarm — the cuts the user WANTS these feeds to meet (the pre-2026-08-03
 * `LAG_THRESHOLDS`: daily 3 / weekly 9). {@link LAG_THRESHOLDS} had to move to the publication
 * calendar so the board stops crying lag on healthy feeds; this table keeps the tighter target
 * VISIBLE without arming a mark from it.
 *
 * ⚠ THESE FOUR ARE CALENDAR DAYS, ALL OF THEM, and they did NOT follow {@link LAG_THRESHOLDS} into
 * publication slots on 2026-09-09 (ruled).
 * `impliedCadenceFor`/`shouldCorrect`
 * (feed-lag.ts) read this table to bucket observation SPACING — a genuine calendar-day quantity —
 * so a slot-valued daily tier here would reclassify every feed's spacing. The two tables are no
 * longer comparable number-for-number; only this one is in days across the board.
 *
 * A feed past its ambition but inside its cut is NOT lagging, is NOT marked, and does NOT reach the
 * notify path. Read through {@link ambitionCutFor}, never indexed directly, so a per-feed
 * `lagAfterDays` cannot silently raise the ambition too.
 *
 * ⚠ IT IS NOT INERT — RETUNING A VALUE HERE IS A BEHAVIOURAL CHANGE. `impliedCadenceFor`
 * (feed-lag.ts) reads THIS table, not the alarm one, to answer "which cadence bucket is this
 * observation SPACING?", and `shouldCorrect` branches on that answer. Tighten `daily` and a 3d-spaced
 * unregistered feed reclassifies daily → weekly, which turns `shouldCorrect` into a COARSENING
 * advisor — advice to widen a cut, the direction §I8.3 forbids. These four are the pure release-
 * spacing buckets. Pinned by `probe-feed-lag.test.ts` (the implied-cadence ladder itself),
 * `registry.test.ts` (the table) and `alert-band.compose.test.ts` (the ambition-vs-alarm split).
 *
 * ⚠ NOT a second lag rule, and NO SURFACE RENDERS IT YET. It arms no mark and no notify: no
 * scorer, no band, no `verdictHoldLegs`, no `CellObserved` reads it. The intended DISPLAY consumer is a
 * concise "beyond target" overview line in `/lab`'s ledger footnote (beside `feedLagFootHtml`),
 * listing every feed whose age exceeds the ambitious 3d/9d so a creeping publication lag is
 * trackable before it becomes an alarm — that is the [USER] ask of 2026-08-03 and it is STAGED, not
 * shipped. Arming a MARK from this table would be a new ruling: the alarm has exactly one source
 * ({@link lagCutFor}) and this stays a reference beside it.
 */
export const AMBITION_THRESHOLDS: Record<Cadence, number> = {
  daily: 3, // the pre-2026-08-03 daily cut — met by every same-day-close feed, missed by T+1 FRED
  // the pre-2026-08-03 weekly cut. F3 rides past it every week — but NOT the flat "6→12" an
  // earlier copy of this comment claimed: the 157-Wednesday measurement (F3 entry, `registry.ts`)
  // puts a NORMAL week's peak below its own `lagAfterDays`, which is reached only in the weeks
  // whose successor release slips behind a Monday US holiday. Read the peak there, not here.
  weekly: 9,
  // ⚠ These two intentionally track {@link LAG_THRESHOLDS}'s monthly/quarterly. They are bare
  // literals, so retuning either tier there desyncs `impliedCadenceFor`'s spacing buckets from the
  // alarm table silently — change both, or give them a shared constant.
  monthly: 40,
  quarterly: 120,
};

/**
 * The AMBITION cut for one indicator — the display-only companion to {@link lagCutFor}.
 *
 * Deliberately reads ONLY the cadence tier: a per-indicator `lagAfterDays` raises the ALARM cut
 * for a feed whose publisher genuinely runs slower, and letting it raise the ambition too would
 * hide exactly the feed the footnote exists to keep visible.
 *
 * The override population is bigger than the two families usually named, and most of it does NOT
 * ride past the ambition. The enumeration is `RULED` in `registry.test.ts`: F3 (weekly 12), EBP
 * (monthly 70) and the weekly `11`s — G1 and BRENT. The `=X` FX pairs ride the bare daily tier.
 * Against `MEASURED_MAX_AGE_90D` in that same file and `lag = age > cut`:
 *  · **F3** genuinely rides past the 9d weekly ambition — 10–12d on 2 of every 7 days in a normal
 *    release week (3 of 8 in a holiday week), so it is the specimen the overview must not lose.
 *  · **EBP** measures a max age of 55d against the 40d monthly ambition — also past target.
 *  · the two weekly `11`s (G1/BRENT) measure 6, so they normally sit INSIDE the 9d
 *    ambition. Their override buys HEADROOM for a slipped H.10/oil release, not a routine breach —
 *    reading the tier keeps them assessable against the target on the days they do slip.
 * Pure.
 *
 * ⚠ NO PRODUCTION CALL SITE TODAY — the only reader is `alert-band.compose.test.ts`. It is STAGED for the
 * `/lab` "beyond target" overview described on {@link AMBITION_THRESHOLDS}; do not delete it as dead.
 */
export function ambitionCutFor(ind: Pick<Indicator, "cadence">): number {
  return AMBITION_THRESHOLDS[ind.cadence ?? "daily"];
}

/**
 * THE lag-cut resolver (E7): a per-indicator `lagAfterDays` wins, else the
 * indicator's cadence tier, else the "daily" tier (the `Indicator` default). One
 * function so the notify flag, the reading stamp, /api/status and the /lab board can
 * never resolve a different number for the same id. Pure.
 */
export function lagCutFor(ind: Pick<Indicator, "cadence" | "lagAfterDays">): number {
  return ind.lagAfterDays ?? LAG_THRESHOLDS[ind.cadence ?? "daily"];
}

/**
 * Is ANY DAILY feed in `rows` fresh right now? The divergence-not-age guard:
 * the retired index-feed
 * liveness guard's `flowing` predicate, generalized — its `^`/index-symbol restriction is
 * dropped, the DAILY-ONLY restriction is kept verbatim. A weekly/monthly series is fresh by its own
 * cut for days at a stretch, so letting one vote "the world is still reporting" would arm a
 * coverage claim straight through a market closure; only a fresh DAILY peer proves the outage is
 * LOCAL to the degraded feed rather than a holiday or a whole-run fetch failure.
 *
 * `lag === undefined` (never assessed) is NOT fresh — no clock lives here, so this cannot
 * fabricate freshness. `cadence` defaults to "daily" (the `Indicator` default).
 *
 * Introduces NO threshold: `lag` was already resolved upstream through {@link lagCutFor},
 * which stays the sole lag-resolution point. Pure.
 */
export function someDailyFeedFresh(rows: readonly { cadence?: Cadence; lag?: boolean }[]): boolean {
  return rows.some((r) => (r.cadence ?? "daily") === "daily" && r.lag === false);
}

/**
 * Freshness of ONE indicator's newest observation against `today`, using its
 * cadence's threshold (LAG_THRESHOLDS). `cadence` defaults to "daily" (the
 * Indicator default). An optional per-indicator `lagAfterDays` (E7) overrides the
 * cadence tier for that id; omitted ⇒ byte-unchanged behaviour, which is why the
 * 3-arg call sites and their pins stand. Pure — the same UTC-midnight date diff as
 * assessFreshness.
 */
export function assessIndicatorFreshness(
  asOf: string,
  today: string,
  cadence: Cadence = "daily",
  lagAfterDays?: number,
): Freshness {
  return assessFreshness(asOf, today, lagCutFor({ cadence, lagAfterDays }));
}

