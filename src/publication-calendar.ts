import { isoDay } from "./dates.js";
/**
 * SLOT AGE — a feed's age in its publisher's own publication days, replacing calendar days for the
 * `daily`/`weekly` cadences. Design ruled 2026-09-08 (four `[USER]` sub-rulings).
 * Falsifier: `npm run probe:readpath-lag`.
 *
 * ⚠ SINCE R14.4 A CALENDAR IS A PER-TARGET GRID, not a union over a tz cohort. {@link containmentGrid}
 * builds it from the TARGET'S OWN dates unioned with those of its containment peers — every daily feed
 * that never printed on a chargeable day the target was live and silent. A foreign calendar (sovereign-quote Bund
 * on US Labor Day, FRED on Whit Monday) disagrees on the target's silent days and is dropped, so the
 * grid self-partitions off the target's own printed days rather than pooling a whole tz's feeds. The
 * `cohort` field on {@link PublicationCalendar} is a diagnostic label only ({@link publicationCalendar}
 * takes whatever string the caller passes); on the containment path `containmentGrid` sets it to the
 * TARGET ID, not a tz key. `feedTimeZone` (`FEED_TZ_OF`, feed-lag.ts) keeps ONLY its "today" role now.
 *
 * ⚠ THE ALL-PEERS-DARK CASE IS REACHABLE and does NOT read 0: with every peer dropped or dark the grid
 * is exactly the target's OWN dates, so its slots are the target's own prints and it self-partitions
 * correctly off them. The {@link MIN_CALENDAR_SOURCES} floor is a REGISTRY-SHAPE guard, not a data
 * guard — a dark INDEPENDENT peer (zero rows, kept in the candidate pool) still counts toward the
 * source count, so the floor asks "does the registry give this target ≥2 independent peers", never
 * "did those peers print". What reads 0 is a WHOLLY FROZEN roster — nothing prints after some date,
 * the target included — because then no slot falls in `(today, asOf]`; THAT case is backstopped by
 * the whole-run heartbeat (`assessFreshness` over the run's max date, run-core.ts), which STAYS on
 * calendar days. Never add weekday slots here to cover it: that re-imports the holiday term this file
 * exists to delete.
 *
 * ⚠ BELOW {@link MIN_CALENDAR_SOURCES} INDEPENDENT SOURCES THIS THROWS (§12 R2): a target with too few
 * independent peers has nobody to corroborate whether its own silence was a holiday, so its grid is
 * not a calendar. {@link publicationCalendar} THROWS below the floor, the same shape as its empty-dates
 * throw. The source COUNT is injected — deriving "independent" (a composite leg is not its own
 * source) needs the registry, and this file stays registry-free and pure; that walk lives in
 * `feed-lag.ts` (`compositeComponentLegIds`, stamped onto each feed's `independent` flag).
 *
 * Pure — `today`, the dates and the source count are injected, so this can never disagree with its caller about the day.
 */

/** `YYYY-MM-DD`. ISO dates sort lexicographically — that is what {@link countAfter} relies on. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A per-target grid's publication days, ascending and unique. `cohort` is a diagnostic label only —
 *  nothing branches on it; {@link containmentGrid} sets it to the TARGET ID (R14.4), the general
 *  {@link publicationCalendar} to whatever string the caller passes. */
export interface PublicationCalendar {
  readonly cohort: string;
  readonly dates: readonly IsoDate[];
}

/** A target with fewer independent sources than this cannot answer whether its own silence was a
 *  holiday, so its grid is not a calendar (§12 R2). Two is the minimum that gives a dark feed a peer. */
export const MIN_CALENDAR_SOURCES = 2;

/**
 * Build a grid's calendar from the observation dates its feeds carry (duplicates expected, collapsed here).
 *
 * ⚠ THROWS BELOW {@link MIN_CALENDAR_SOURCES} independent sources, and THROWS ON EMPTY — both rather
 * than returning a calendar that would make every {@link slotAge} 0 and read the target as
 * fresh. A thin candidate set or no rows is an absence to REPORT, never coalesced to 0. `independentSources`
 * is the count of contributing feeds that fetch on their own (a composite leg shares its parent's fetch
 * and is not one), derived by the caller off the registry.
 * @internal
 */
export function publicationCalendar(
  cohort: string,
  observationDates: Iterable<IsoDate>,
  independentSources: number,
): PublicationCalendar {
  if (independentSources < MIN_CALENDAR_SOURCES) {
    throw new Error(
      `publicationCalendar(${cohort}): ${independentSources} independent source(s), below the floor of ${MIN_CALENDAR_SOURCES} - a one-feed cohort cannot tell its own silence from a holiday, so this is an absence to report, not a calendar`,
    );
  }
  const seen = new Set<IsoDate>();
  for (const d of observationDates) {
    if (!ISO_DATE.test(d)) throw new Error(`publicationCalendar(${cohort}): non-ISO observation date ${JSON.stringify(d)}`);
    seen.add(d);
  }
  if (seen.size === 0) {
    throw new Error(
      `publicationCalendar(${cohort}): no observation dates - an empty calendar reads every feed as fresh, so this is a store/fetch failure to report, not a calendar`,
    );
  }
  return { cohort, dates: [...seen].sort() };
}

/** A peer may print on at most this many days `target` was live and silent before it stops being a
 *  peer (R14.2). ZERO since §16 ruling 15.1: a nonzero slack let a foreign calendar through (Good
 *  Friday 2026-04-03 sat exactly AT tolerance 1 and injected a phantom slot into VIXCLS).
 *  ⚠ THERE IS NO OUTAGE EXCUSE. An "outage quorum" path (three knobs excusing a silent day most
 *  same-calendar peers printed) was DELETED 2026-09-13 (A4):
 *  counterfactually neutralised over 3y FRED and the prod 130-obs roster it changed ZERO
 *  grid dates and ZERO throws. A target outage while its peers print therefore strips every peer and
 *  THROWS below {@link MIN_CALENDAR_SOURCES} — an absence `feed-lag.ts` contains PER FEED
 *  (`unmeasured`), never a grid coalesced to 0. Tests DERIVE the boundary from this symbol; the
 *  literal lives only here. */
export const CONTAINMENT_TOLERANCE = 0;

/** The knob `containmentGrid` reads, as ONE overridable bag whose live value is the exported constant
 *  above (single touch point — never restate it here). The parameter exists so a test or probe can
 *  rerun the grid with the tolerance neutralised; production callers never pass it. */
export interface CalendarKnobs {
  readonly containmentTolerance: number;
}
/** @internal */
export const CALENDAR_KNOBS: CalendarKnobs = { containmentTolerance: CONTAINMENT_TOLERANCE };

/** Observations per feed to scan when deriving a publication calendar or measuring a feed's OWN
 *  rhythm. ~6 months of dailies — long enough that a weekly feed still clears `MIN_GAPS`, short
 *  enough that a cadence CHANGE mid-history doesn't dominate the p90.
 *
 *  ⚠ IT LIVES HERE, in the registry-free leaf, because THREE consumers need it and two of them
 *  cannot import the third: `scripts/probe-feed-lag.ts` and `/lab`'s stage-2 deep read take it via
 *  `feed-lag.ts` (which re-exports it verbatim, so every existing importer is unchanged), while the
 *  RUN-path stamp (`stampFreshness`, scorers-core.ts) is forbidden to import `feed-lag.ts` at all —
 *  that file pulls the registry, and `registry → scorers → scorers-core` would close a cycle
 *  (`src/import-cycle.test.ts` reds on it). ONE depth constant, no second copy
 * . */
export const LAG_SCAN_LIMIT = 130;

const DAY_MS = 86_400_000;

/** One feed's dates plus whether it fetches on its own — a composite leg shares its parent's fetch,
 *  so `independent` is false and it does not count toward the {@link MIN_CALENDAR_SOURCES} floor. The
 *  flag is INJECTED; deriving it needs the registry and this file stays registry-free. */
export interface FeedObservations {
  readonly id: string;
  readonly dates: readonly IsoDate[];
  readonly independent: boolean;
}

const WEEKDAY = new Map<IsoDate, number>();
const weekdayOf = (d: IsoDate): number => {
  let w = WEEKDAY.get(d);
  if (w === undefined) WEEKDAY.set(d, (w = new Date(`${d}T00:00:00Z`).getUTCDay()));
  return w;
};

/** Saturday/Sunday is never a publication SLOT, whoever stamped it. §16 ruling 15.2 only stops a
 *  weekend from CHARGING a peer; a kept peer's weekend stamp (a vendor's Saturday ghost bar, the sovereign-yield quote feed
 *  IT10Y/ES10Y 2026-09-26) still unioned into every daily grid and aged each feed one phantom slot.
 *  This removes slots only — it never adds weekday ones (the frozen-cohort ⚠ above stands). */
const isWeekend = (d: IsoDate): boolean => {
  const w = weekdayOf(d);
  return w === 0 || w === 6;
};

/**
 * The weekdays a feed has EVER printed on — the only days on which its silence is evidence about
 * anything (§16 ruling 15.2). A daily feed's set is Mon–Fri, so holidays stay evidence and weekends
 * stop being counted; a weekly feed's set is its single print weekday, so its six non-print weekdays
 * stop charging every daily peer and the daily union grid falls out as a DERIVATION rather than a
 * `cadence !== "daily"` branch. Read off the feed's own dates: nothing is injected and this file
 * stays registry-free.
 */
function printedWeekdays(dates: readonly IsoDate[]): Set<number> {
  const out = new Set<number>();
  for (const d of dates) out.add(weekdayOf(d));
  return out;
}

/** A feed's weekday dates, or `null` if any date is non-ISO. Memoised per object: both callers reuse
 *  ONE candidate array across every target, so this runs once per feed per run, not per target. */
const SLOT_DATES = new WeakMap<FeedObservations, readonly IsoDate[] | null>();
function slotDatesOf(f: FeedObservations): readonly IsoDate[] | null {
  let out = SLOT_DATES.get(f);
  if (out === undefined) {
    out = f.dates.every((d) => ISO_DATE.test(d)) ? f.dates.filter((d) => !isWeekend(d)) : null;
    SLOT_DATES.set(f, out);
  }
  return out;
}

/** A feed's slot dates joined into ONE string — an exact content key (never a hash), memoised per
 *  object like {@link slotDatesOf}. Pure perf: feeds sharing a date window add identical slots to the
 *  grid union, so `containmentGrid` unions each distinct slot list once instead of once per peer. */
const SLOT_KEY = new WeakMap<FeedObservations, string>();
function slotKeyOf(f: FeedObservations, slots: readonly IsoDate[]): string {
  let out = SLOT_KEY.get(f);
  if (out === undefined) {
    out = slots.join(",");
    SLOT_KEY.set(f, out);
  }
  return out;
}

/** The calendar days `target` was LIVE (between its first and last print), SILENT (did not print),
 *  and on a weekday it prints on at all ({@link printedWeekdays}). */
function liveSilentDays(sortedTargetDates: readonly IsoDate[]): Set<IsoDate> {
  const out = new Set<IsoDate>();
  if (sortedTargetDates.length === 0) return out;
  const printed = new Set(sortedTargetDates);
  const plausible = printedWeekdays(sortedTargetDates);
  const hi = Date.parse(sortedTargetDates[sortedTargetDates.length - 1]!);
  for (let t = Date.parse(sortedTargetDates[0]!); t <= hi; t += DAY_MS) {
    // `t` is a UTC midnight, so its weekday is day-number arithmetic (1970-01-01 was a Thursday, 4)
    // — the same value `new Date(t).getUTCDay()` returns, without two Date allocations per day.
    if (!plausible.has((((t / DAY_MS + 4) % 7) + 7) % 7)) continue;
    const d = isoDay(new Date(t));
    if (printed.has(d)) continue;
    out.add(d);
  }
  return out;
}

/**
 * The containment-peer grid for `target` (R14.1/R14.2): its own dates unioned with those of every
 * candidate that never printed on a day `target` was live and silent, tolerating
 * {@link CONTAINMENT_TOLERANCE} such day. A candidate that had not started yet in the window sits
 * outside `[first, last]`, so it costs no mismatch and stays a peer.
 *
 * ⚠ ONE filter runs BEFORE anything is charged (§16 ruling 15.2): a day on a weekday `target` never
 * prints ({@link printedWeekdays}) is not evidence at all. EVERY other live-silent day is chargeable —
 * the outage-quorum excuse that once sat here was deleted on measurement (see
 * {@link CONTAINMENT_TOLERANCE}); a day every peer printed reads as a calendar difference and strips
 * them, and the floor below reports it. Weekend dates are dropped from the grid itself ({@link isWeekend}).
 *
 * Built THROUGH {@link publicationCalendar}, so the {@link MIN_CALENDAR_SOURCES} floor — counted over
 * `target` + its INDEPENDENT peers (R14.3) — and the empty/non-ISO throws are the SAME mechanism: a
 * peer set below the floor is an absence to report, never a grid coalesced to 0. THROWS on an empty
 * `target` for the same reason — a feed the store never heard of has no live window and is `NO-DATA`
 * upstream, never a grid read fresh off its peers.
 */
export function containmentGrid(
  target: FeedObservations,
  candidates: Iterable<FeedObservations>,
  knobs: CalendarKnobs = CALENDAR_KNOBS,
): PublicationCalendar {
  for (const d of target.dates) if (!ISO_DATE.test(d)) throw new Error(`containmentGrid(${target.id}): non-ISO observation date ${JSON.stringify(d)}`);
  if (target.dates.length === 0) throw new Error(`containmentGrid(${target.id}): no observation dates - a zero-row feed has no live window and is NO-DATA upstream, not a grid`);
  const sorted = [...target.dates].sort();
  const cands = [...candidates];
  const silent = liveSilentDays(sorted);
  const seen = new Set<IsoDate>(slotDatesOf(target));
  const accepted: FeedObservations[] = [];
  let sources = target.independent ? 1 : 0;
  let clean = true;
  const unioned = new Set<string>(); // slot-list content keys already added to `seen`
  for (const g of cands) {
    if (g.id === target.id) continue;
    let mismatch = 0;
    // `silent` is empty for any target that printed every day it could (the common case), so no
    // candidate date can charge a mismatch — skip the per-date scan (pure perf, same result).
    if (silent.size > 0) for (const d of g.dates) if (silent.has(d) && ++mismatch > knobs.containmentTolerance) break;
    if (mismatch > knobs.containmentTolerance) continue;
    accepted.push(g);
    const slots = slotDatesOf(g);
    if (slots === null) clean = false;
    else {
      const key = slotKeyOf(g, slots);
      if (!unioned.has(key)) {
        unioned.add(key);
        for (const d of slots) seen.add(d);
      }
    }
    if (g.independent) sources++;
  }
  // Every throw (floor, empty, non-ISO) is publicationCalendar's own — rebuilt only on that path.
  if (!clean || sources < MIN_CALENDAR_SOURCES || seen.size === 0) {
    const all = [target, ...accepted].flatMap((f) => f.dates.filter((d) => !ISO_DATE.test(d) || !isWeekend(d)));
    return publicationCalendar(target.id, all, sources);
  }
  return { cohort: target.id, dates: [...seen].sort() };
}

/** Count of `dates` strictly after `after` — binary search, so a 130-row window costs ~7 steps. */
function countAfter(dates: readonly IsoDate[], after: IsoDate): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= after) lo = mid + 1;
    else hi = mid;
  }
  return dates.length - lo;
}

/**
 * Publication days in `(asOf, today]`. A healthy feed reads its publisher's own delay — 0 same-day,
 * 1 for T+1 — and each missed print adds exactly 1, so a caller compares against that delay alone.
 *
 * ⚠ `asOf >= today` CLAMPS TO 0: an ahead-stamped row is a provisional/timezone artifact (the `=X`
 * newest-day print, `docs/backlog.md`) and a negative age would underflow every comparison downstream.
 *
 * `excused(d, postDaysAfter)` (REQUIRED, INJECTED — this file stays registry-free; an optional arm let four call sites
 * silently count holidays, code review 2026-10-13): a grid day on which the feed could
 * not have gained a print (its source or its publisher was closed, `isSlotExcused` in market-closures.ts) is not
 * counted; `postDaysAfter` is the count of grid days in `(d, today]`, so a publisher closure stops being excused
 * once the publisher has had a post day after it.
 * The grid is still the union of the target's peers, and a closure that falls AFTER the target's last print is
 * invisible to containment (nobody has printed since, so no peer is charged for printing on it): NYSE peers put
 * Columbus Day 2026-10-12 on every FRED feed's grid and 14 healthy feeds read one slot behind (2026-10-13). This
 * only REMOVES slots, exactly as the file's frozen-cohort ⚠ allows — it never adds a weekday.
 */
export function slotAge(
  asOf: IsoDate,
  today: IsoDate,
  calendar: PublicationCalendar,
  excused: (d: IsoDate, postDaysAfter: number) => boolean,
): number {
  if (!ISO_DATE.test(asOf)) throw new Error(`slotAge: non-ISO asOf ${JSON.stringify(asOf)}`);
  if (!ISO_DATE.test(today)) throw new Error(`slotAge: non-ISO today ${JSON.stringify(today)}`);
  if (asOf >= today) return 0;
  const raw = countAfter(calendar.dates, asOf) - countAfter(calendar.dates, today);
  if (raw === 0) return raw;
  // Subtract the excused grid days in the SAME window — never below 0, never a day outside `(asOf, today]`.
  // `postDaysAfter` = grid days in `(d, today]`, so the predicate can excuse a publisher closure only until the
  // publisher's first post day after it has passed (market-closures.ts `isSlotExcused`).
  let dropped = 0;
  const window = calendar.dates.filter((d) => d > asOf && d <= today);
  window.forEach((d, i) => {
    if (excused(d, window.length - 1 - i)) dropped++;
  });
  return raw - dropped;
}
