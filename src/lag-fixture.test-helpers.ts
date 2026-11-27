/**
 * Shared PUBLICATION-SLOT fixtures for the freshness suites (slice 3, 2026-09-09).
 *
 * NOT a `*.test.ts` file, so vitest never collects it — same idiom as
 * `src/dashboard.test-helpers.ts`, `src/danger-engine.test-helpers.ts` and
 * `src/api-series.test-helpers.ts`.
 *
 * ⚠ WHY THIS EXISTS AT ALL — THE VACUITY TRAP. Since slice 3 the run-path stamp
 * (`stampFreshness`, scorers-core.ts) scores `daily`/`weekly` ids in PUBLICATION SLOTS against a
 * grid derived by `containmentGrid` from the observation dates it was handed. That grid THROWS below
 * `MIN_CALENDAR_SOURCES` (2) independent daily sources, and `lagCalendarsFrom` reports the throw as
 * `null` = NOT ASSESSED, leaving the reading UNSTAMPED. A hand-built fixture of one or two readings
 * is therefore below the floor by construction: nothing gets stamped, `verdictHoldLegs` returns `[]`,
 * and every "no leg is flagged" assertion passes for the WRONG reason. {@link peerPool} supplies the
 * peers that put a fixture over the floor, and {@link stampWithPeers} slices them back off.
 *
 * ⚠ AND WHY THE PEERS ARE ONE-PER-DAY. A `Reading` carries exactly ONE observation date, so the
 * grid a run can derive is the SET OF DISTINCT DATES its readings sit on — a peer contributes one
 * publication day, not a history. To give a fixture a grid with N publication days you need N peers.
 * {@link BUSINESS_DAYS} is that ladder: weekday-only, so a fixture spanning a weekend measures FEWER
 * slots than calendar days, which is the whole point of the conversion and keeps these fixtures from
 * silently re-testing the calendar rule.
 */

import type { Reading } from "./domain-types.js";
import type { FeedCalendarToday } from "./dates.js";
import { lagCalendarsFrom, stampFreshness } from "./scorers-core.js";
import { US_FEDERAL_HOLIDAYS } from "./market-closures.js";

/** The pinned evaluation clock for every slot fixture — a WEDNESDAY, so `today` is itself a
 *  publication day and a healthy T+1 feed reads exactly one slot behind. Pinned, never
 *  `new Date()`: a wall-clock fixture on a lag gate is a calendar time-bomb
 *  (`.claude/rules/testing-project.md`). */
export const SLOT_TODAY = "2026-06-24";

/** Weekday-only ISO dates in `[from, to]`, ascending, minus the US federal holidays. The synthetic
 *  publication calendar every fixture below is graded against — Sat/Sun are absent, so slot age <
 *  calendar age across a weekend; the federal days are absent from the GRID itself, so `slotAge`'s
 *  excusal (market-closures.ts, grid days only) never fires in these suites and the ladder's
 *  arithmetic (`slotsOld`) agrees with the stamp for every id by construction — the excusal path is
 *  covered by publication-calendar.test.ts + release-delay.test.ts, not here. Pure, no clock. */
function businessDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !US_FEDERAL_HOLIDAYS.includes(iso)) out.push(iso);
  }
  return out;
}

/** ~9 weeks of publication days ending at {@link SLOT_TODAY} — deep enough that
 *  `lagCutFor("weekly")` slots back is still inside the ladder with room to spare. */
const BUSINESS_DAYS: readonly string[] = businessDays("2026-04-20", SLOT_TODAY);

/**
 * The date exactly `slots` PUBLICATION DAYS before {@link SLOT_TODAY} — the one way these suites are
 * allowed to pick a fixture date. Callers pass a value DERIVED from `lagCutFor` (e.g. `cut + 1` for
 * "one publication past its cut"), so moving a cut in `LAG_THRESHOLDS` moves the fixture with it and
 * no test ever restates a cut's value (`.claude/rules` threshold single-touch-point).
 */
export function slotsOld(slots: number): string {
  const at = BUSINESS_DAYS.length - 1 - slots;
  if (at < 0) throw new Error(`slotsOld(${slots}): beyond the ${BUSINESS_DAYS.length}-day fixture ladder`);
  return BUSINESS_DAYS[at]!;
}

/** A synthetic INDEPENDENT daily peer printing on exactly one publication day. Its id is namespaced
 *  so it can never collide with a registry id (and so a stray one is obvious in a failure diff). */
function peer(date: string): Reading {
  return {
    indicator: { id: `__PEER_${date}`, label: date, longLabel: date, series: date, channel: "FIN", thresholds: {} },
    date,
    level: 0,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
  };
}

/** One independent daily peer per publication day in {@link BUSINESS_DAYS} — enough sources to clear
 *  `MIN_CALENDAR_SOURCES`, and enough distinct dates to make every slot in the window countable. */
const peerPool = (): Reading[] => BUSINESS_DAYS.map(peer);

/**
 * Stamp `readings` against the synthetic publication calendar — the peers join the grid-derivation
 * pool and are then sliced back off, so the caller gets its OWN readings, stamped, in order.
 * `stampFreshness` is order-preserving, which is what makes the slice exact.
 *
 * ⚠ ASSERT THE STAMP LANDED. A caller whose subject goes unstamped (`ageDays === undefined`) is back
 * in the vacuity trap this module exists to close, so this throws rather than returning a silently
 * unassessed row for a `daily`/`weekly` id.
 */
export function stampWithPeers<T extends Reading>(
  readings: readonly T[],
  today: string | FeedCalendarToday = SLOT_TODAY,
): T[] {
  const pool = [...readings, ...peerPool()];
  const stamped = stampFreshness(pool, today, lagCalendarsFrom(pool)).slice(0, readings.length) as T[];
  for (const r of stamped) {
    const cadence = r.indicator.cadence ?? "daily";
    if ((cadence === "daily" || cadence === "weekly") && r.ageDays === undefined) {
      throw new Error(
        `stampWithPeers: ${r.indicator.id} went UNSTAMPED (no publication grid) - the fixture is ` +
          `below MIN_CALENDAR_SOURCES and every downstream "not flagged" assertion would be vacuous`,
      );
    }
  }
  return stamped;
}

/**
 * A {@link CarryAgeOf} for the absent-member carry gate's suites: the count of PUBLICATION DAYS in
 * `(date, asOf]` on a weekday calendar.
 *
 * ⚠ WHY THE SUITES NEED ONE AT ALL. Since slice 3 `assembleDial` carries an absent member only when
 * it is given BOTH `carryLagCutById` and `carryAgeOf` — omitting the resolver means the vintage is
 * unjudgeable, and a member whose vintage cannot be judged stays absent (fail-safe). A carry test
 * that passes only the cut map therefore carries NOTHING and every "…is carried" assertion in it
 * goes vacuously red / every "…stays absent" one vacuously green.
 *
 * ⚠ AND WHY IT IS A CALENDAR AND NOT A GRID. In production this callback is bound to
 * `resolveFreshness` over the run's derived publication calendars (run-cycle-dial.ts). These suites hold
 * PROJECTIONS (`{id, state}` points), not `Reading`s, so no grid can be derived from them. A
 * weekday calendar is the honest stand-in: it counts the same quantity in the same unit, which is
 * all the gate's contract (age vs. the id's own cut) depends on. What it deliberately does NOT
 * model is grid derivation — that is `lagCalendarsFrom`'s own suite's job, not this gate's.
 */
export const businessDayAgeOf = (_id: string, date: string, asOf: string): number | null =>
  date >= asOf ? 0 : businessDays(date, asOf).filter((d) => d > date).length;
