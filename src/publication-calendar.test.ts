import { describe, expect, it } from "vitest";

/** The excusal term is REQUIRED (no silent default); these cases count raw grid slots. */
const NO_EXCUSAL = () => false;
import {
  CALENDAR_KNOBS,
  CONTAINMENT_TOLERANCE,
  containmentGrid,
  type FeedObservations,
  MIN_CALENDAR_SOURCES,
  publicationCalendar,
  slotAge,
} from "./publication-calendar.js";

/** Every kernel case here is about the DATES, not the source floor, so they pass the minimum
 *  healthy count. The floor's own behaviour is pinned in its dedicated block below. */
const OK = MIN_CALENDAR_SOURCES;

/**
 * The live 2026-09-08 shape, which is why this file exists. US Labor Day fell on Monday 09-07, so
 * the H.15 release for Friday 09-04 slipped to Tuesday 09-08 16:15 ET. Reading at 09:00 ET that
 * Tuesday, DGS10's newest observation was 2026-09-03 — 5 CALENDAR days old, over the shipped cut of
 * 4, and prod flagged it (with 14 peers) as lagging.
 *
 * The dates below are the cohort's REAL prints: US feeds printed 09-01..09-04, nothing printed on
 * the holiday Monday, and nothing had printed yet at 09:00 on the Tuesday.
 */
const US_LABOR_DAY_WEEK = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];

describe("publicationCalendar", () => {
  it("collapses the duplicate prints every cohort feed contributes", () => {
    const cal = publicationCalendar("America/Chicago", [...US_LABOR_DAY_WEEK, ...US_LABOR_DAY_WEEK], OK);
    expect(cal.dates).toEqual(US_LABOR_DAY_WEEK);
    expect(cal.cohort).toBe("America/Chicago");
  });

  it("sorts, so a caller may hand it rows in any order", () => {
    expect(publicationCalendar("utc", ["2026-09-04", "2026-09-01"], OK).dates).toEqual(["2026-09-01", "2026-09-04"]);
  });

  it("THROWS on an empty calendar rather than reading every feed as fresh", () => {
    expect(() => publicationCalendar("America/Chicago", [], OK)).toThrow(/no observation dates/);
  });

  it("throws on a non-ISO date rather than sorting it into the grid", () => {
    expect(() => publicationCalendar("America/Chicago", ["09/04/2026"], OK)).toThrow(/non-ISO/);
  });

  it("THROWS below the source floor rather than trusting a one-feed cohort's silence (§12 R2)", () => {
    // A cohort with one independent source cannot tell its own silence from a holiday. The count is
    // derived one short of the floor, never restated, so retiring the floor toward 0 reds this line.
    expect(() =>
      publicationCalendar("thin", US_LABOR_DAY_WEEK, MIN_CALENDAR_SOURCES - 1),
    ).toThrow(/independent source/);
  });

  it("does NOT throw at exactly the source floor — the same dates that just threw", () => {
    expect(publicationCalendar("euro-area", US_LABOR_DAY_WEEK, MIN_CALENDAR_SOURCES).dates).toEqual(
      US_LABOR_DAY_WEEK,
    );
  });
});

describe("slotAge", () => {
  const cal = publicationCalendar("America/Chicago", US_LABOR_DAY_WEEK, OK);

  it("scores the live 2026-09-08 case 1, where the calendar-day rule scored 5", () => {
    // Only 09-04 sits in (09-03, 09-08]: the weekend is not a publication day, Labor Day printed
    // nothing, and nothing had printed yet on the Tuesday morning.
    expect(slotAge("2026-09-03", "2026-09-08", cal, NO_EXCUSAL)).toBe(1);
  });

  it("a same-day feed reads 0 and a T+1 feed reads 1 on the same morning", () => {
    expect(slotAge("2026-09-04", "2026-09-08", cal, NO_EXCUSAL)).toBe(0);
    expect(slotAge("2026-09-03", "2026-09-08", cal, NO_EXCUSAL)).toBe(1);
  });

  it("adds exactly one per missed publication, so a genuinely dark feed separates fast", () => {
    expect(slotAge("2026-09-02", "2026-09-08", cal, NO_EXCUSAL)).toBe(2);
    expect(slotAge("2026-09-01", "2026-09-08", cal, NO_EXCUSAL)).toBe(3);
    expect(slotAge("2026-08-31", "2026-09-08", cal, NO_EXCUSAL)).toBe(4);
  });

  describe("`excused` - a closure after the target's last print is dropped from the count, never added", () => {
    // Columbus week 2026: NYSE peers printed Mon 10-12, so it sits on every FRED feed's grid.
    const week = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
    const grid = publicationCalendar("fred", week, OK);
    const columbus = (d: string) => d === "2026-10-12";

    it("Tue 10-13 over a Thu 10-08 print: 3 raw slots, 2 once Monday is excused (the T+1 margin holds)", () => {
      expect(slotAge("2026-10-08", "2026-10-13", grid, NO_EXCUSAL)).toBe(3);
      expect(slotAge("2026-10-08", "2026-10-13", grid, columbus)).toBe(2);
    });

    it("the excused day is only subtracted inside `(asOf, today]`", () => {
      expect(slotAge("2026-10-12", "2026-10-13", grid, columbus)).toBe(1); // asOf itself is not in the window
      expect(slotAge("2026-10-08", "2026-10-09", grid, columbus)).toBe(1); // window ends before Monday
      expect(slotAge("2026-10-08", "2026-10-12", grid, columbus)).toBe(1); // today is the excused day: 10-09 only
    });

    it("never goes below 0 and never counts a non-grid date", () => {
      expect(slotAge("2026-10-13", "2026-10-13", grid, () => true)).toBe(0);
      expect(slotAge("2026-10-08", "2026-10-13", grid, () => true)).toBe(0);
      expect(slotAge("2026-10-08", "2026-10-13", grid, (d) => d === "2026-10-10")).toBe(3); // a Saturday is not a slot
    });
  });

  it("does not advance across a weekend or a holiday", () => {
    // Fri 09-04 → Sat, Sun, and the holiday Monday all leave a T+1 feed at its healthy 1.
    for (const today of ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"]) {
      expect(slotAge("2026-09-03", today, cal, NO_EXCUSAL)).toBe(1);
    }
  });

  it("is inclusive of `today` once the cohort has printed for it", () => {
    // Same reading on the Tuesday AFTER the delayed release lands: 09-08 joins the calendar and the
    // T+1 feed that is still stuck on 09-03 steps to 2 — the missed release, caught on the next slot.
    const withTuesday = publicationCalendar("America/Chicago", [...US_LABOR_DAY_WEEK, "2026-09-08"], OK);
    expect(slotAge("2026-09-03", "2026-09-08", withTuesday, NO_EXCUSAL)).toBe(2);
    expect(slotAge("2026-09-04", "2026-09-08", withTuesday, NO_EXCUSAL)).toBe(1);
  });

  it("clamps a feed stamped ahead of the reading calendar to 0 rather than underflowing", () => {
    // ⚠ The calendar MUST hold a date in `(today, asOf]` or this case cannot discriminate: with a
    // calendar that ends before `today`, both counts are already 0 and the raw formula returns 0
    // with the clamp deleted. `withTuesday` prints on 09-08, so the mutant returns -1 here.
    const withTuesday = publicationCalendar("America/Chicago", [...US_LABOR_DAY_WEEK, "2026-09-08"], OK);
    expect(slotAge("2026-09-08", "2026-09-04", withTuesday, NO_EXCUSAL)).toBe(0);
    expect(slotAge("2026-09-09", "2026-09-08", withTuesday, NO_EXCUSAL)).toBe(0);
    expect(slotAge("2026-09-08", "2026-09-08", withTuesday, NO_EXCUSAL)).toBe(0);
  });

  it("THE FROZEN-COHORT HOLE, pinned: a dark cohort reads 0, so the run heartbeat owns that case", () => {
    // Nothing printed after 09-04. Every feed in the cohort — however old — reads fresh here, which
    // is why `run-core.ts`'s whole-run heartbeat stays on CALENDAR days. If this ever returns
    // non-zero the split described in `publication-calendar.ts` has changed and run-core must be
    // revisited in the same commit.
    expect(slotAge("2026-09-04", "2026-12-25", cal, NO_EXCUSAL)).toBe(0);
  });

  it("throws on non-ISO input rather than comparing garbage lexicographically", () => {
    expect(() => slotAge("09/03/2026", "2026-09-08", cal, NO_EXCUSAL)).toThrow(/non-ISO asOf/);
    expect(() => slotAge("2026-09-03", "tomorrow", cal, NO_EXCUSAL)).toThrow(/non-ISO today/);
  });
});

describe("containmentGrid (R14.2 — the cohort is DERIVED, not keyed)", () => {
  const feed = (id: string, dates: string[], independent = true): FeedObservations => ({ id, dates, independent });

  // The 2023-10-10 defect, in miniature: a bond target skips two bond-only holidays (10-12, 10-19);
  // an equity peer prints them, a second bond feed skips them like the target.
  const BOND = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-20"];
  const EQ = [...BOND, "2026-10-12", "2026-10-19"].sort(); // prints on the two bond-only holidays

  it("the Columbus-Day case: an equity peer's holiday prints do NOT advance a bond feed's grid", () => {
    // EQ disagrees on 2 days (> the tolerance), so it is dropped; the aligned second bond feed keeps
    // the floor. If EQ were a peer, 10-19 would enter the grid and the healthy read below would be 2.
    // BOND appears in its own candidate list too (as `freshnessFrom` passes the full roster) — the
    // self-skip must not double-count it as a peer/source.
    const grid = containmentGrid(feed("BOND", BOND), [feed("EQ", EQ), feed("BOND2", BOND), feed("BOND", BOND)]);
    expect(grid.dates).not.toContain("2026-10-12");
    expect(grid.dates).not.toContain("2026-10-19");
    expect(slotAge("2026-10-16", "2026-10-20", grid, NO_EXCUSAL)).toBe(1);
  });

  // Two full weeks of weekdays (2026-11-02 Mon .. 2026-11-13 Fri). The target skips K =
  // CONTAINMENT_TOLERANCE + 1 interior ones, so a peer can be built printing on EXACTLY the
  // tolerance (kept) or one past it (dropped) — the boundary derives from the symbol. Every skipped
  // day falls on a weekday the target prints elsewhere, so §16's plausibility filter keeps them
  // chargeable; the markers sit after the window and cost nothing.
  const WEEKDAYS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
  const K = CONTAINMENT_TOLERANCE + 1;
  const SILENT = WEEKDAYS.slice(5, 5 + K);
  const T = WEEKDAYS.filter((x) => !SILENT.includes(x));
  const MARK_KEEP = "2026-11-16";
  const MARK_DROP = "2026-11-17";

  it("keeps a peer that prints on EXACTLY the tolerance of silent days", () => {
    const p = feed("P_KEEP", [...T, ...SILENT.slice(0, CONTAINMENT_TOLERANCE), MARK_KEEP]);
    expect(containmentGrid(feed("T", T), [p]).dates).toContain(MARK_KEEP); // marker present ⇒ kept
  });

  it("drops a peer that prints on one MORE than the tolerance of silent days", () => {
    const keep = feed("P_KEEP", [...T, ...SILENT.slice(0, CONTAINMENT_TOLERANCE), MARK_KEEP]);
    const drop = feed("P_DROP", [...T, ...SILENT.slice(0, CONTAINMENT_TOLERANCE + 1), MARK_DROP]);
    const grid = containmentGrid(feed("T", T), [keep, drop]);
    expect(grid.dates).not.toContain(MARK_DROP); // marker absent ⇒ dropped
    expect(grid.dates).toContain(MARK_KEEP); // ...while the exactly-tolerance peer survives to hold the floor
  });

  it("the knobs bag defaults to the live constants, and an override actually moves the grid", () => {
    const keep = feed("P_KEEP", [...T, ...SILENT.slice(0, CONTAINMENT_TOLERANCE), MARK_KEEP]);
    const drop = feed("P_DROP", [...T, ...SILENT.slice(0, CONTAINMENT_TOLERANCE + 1), MARK_DROP]);
    const live = containmentGrid(feed("T", T), [keep, drop]);
    expect(containmentGrid(feed("T", T), [keep, drop], CALENDAR_KNOBS).dates).toEqual(live.dates); // explicit bag == default
    expect(CALENDAR_KNOBS.containmentTolerance).toBe(CONTAINMENT_TOLERANCE); // the bag reads the constant, never restates it
    const relaxed = containmentGrid(feed("T", T), [keep, drop], { ...CALENDAR_KNOBS, containmentTolerance: Infinity });
    expect(relaxed.dates).toContain(MARK_DROP); // neutralised tolerance ⇒ the over-tolerance peer is a peer again
  });

  // A4 (2026-09-13): the outage-quorum excuse is GONE. This is the old "EXCUSES a silent day every
  // peer printed" pin rewritten into the new contract — the same fixture that used to keep MARK_KEEP
  // now strips every peer and throws. A fixture with a single peer would pass under BOTH contracts
  // (one voter never met the old min-voters gate), so five are used: the old code excused 5/5.
  it("does NOT excuse a silent day EVERY peer printed — a target outage strips its peers and throws", () => {
    const peers = Array.from({ length: 5 }, (_, i) => feed(`P${i}`, [...WEEKDAYS, MARK_KEEP]));
    expect(() => containmentGrid(feed("T", T), peers)).toThrow(/independent source/);
  });

  it("charges a foreign-calendar peer while the aligned peers keep the floor", () => {
    const aligned = Array.from({ length: 4 }, (_, i) => feed(`P${i}`, [...T, MARK_KEEP]));
    const foreign = feed("FOREIGN", [...WEEKDAYS, MARK_DROP]);
    const grid = containmentGrid(feed("T", T), [...aligned, foreign]);
    expect(grid.dates).not.toContain(MARK_DROP);
    expect(grid.dates).toContain(MARK_KEEP);
  });

  // The BAML OAS SUPERSET shape (prints every VIXCLS day plus month-end weekends) — once the case the
  // quorum's voter filter existed for. Without any excuse path it is plain containment: a superset
  // peer prints the target's silent day, so it is dropped and its weekend stamps never union in.
  it("drops a SUPERSET peer and keeps its weekend prints out of the grid", () => {
    const supersets = Array.from({ length: 5 }, (_, i) => feed(`SUP${i}`, [...T, ...SILENT, "2026-11-07", "2026-11-08", MARK_DROP]));
    const aligned = feed("P_ALIGNED", [...T, MARK_KEEP]);
    const grid = containmentGrid(feed("T", T), [...supersets, aligned]);
    expect(grid.dates).not.toContain(MARK_DROP);
    expect(grid.dates).not.toContain("2026-11-07");
    expect(grid.dates).toContain(MARK_KEEP); // the same-calendar peer still holds the floor
  });

  // The 2026-09-26 live shape: the source served a Saturday sovereign-yield bar, the sovereign legs stored it,
  // and — a Mon–Fri target never being silent on a Saturday — those legs stayed peers of every daily
  // feed, so the Saturday entered each grid and 17 feeds read one slot behind on the Monday.
  it("never admits a weekend date as a slot, even from a peer it keeps", () => {
    const SAT = "2026-11-14";
    const MON = "2026-11-16";
    const weekendPrinter = feed("SAT_PEER", [...T, SAT, MON]);
    const aligned = feed("P_ALIGNED", [...T, MON]);
    const grid = containmentGrid(feed("T", T), [weekendPrinter, aligned]);
    expect(grid.dates).toContain(MON); // the peer IS kept — its weekday prints still count...
    expect(grid.dates).not.toContain(SAT); // ...but its Saturday is no publication day
    expect(slotAge(T.at(-1)!, MON, grid, NO_EXCUSAL)).toBe(1); // Friday's print read on Monday: one slot, not two
  });

  // §16 ruling 15.2 — a weekly target's non-print weekdays are not evidence, so daily feeds stay
  // peers and the weekly grid IS the daily union (§5's assumption, derived rather than branched).
  it("admits daily peers for a WEEKLY target — its non-print weekdays are not evidence", () => {
    const wednesdays = ["2026-11-04", "2026-11-11", "2026-11-18", "2026-11-25", "2026-12-02"];
    const dailyA = feed("DAILY_A", [...WEEKDAYS, "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-25", "2026-12-02"]);
    const dailyB = feed("DAILY_B", dailyA.dates as string[]);
    const grid = containmentGrid(feed("WEEKLY", wednesdays), [dailyA, dailyB]);
    expect(grid.dates).toContain("2026-11-17"); // a daily-only Tuesday reached the weekly grid
    expect(grid.dates).toContain("2026-11-04"); // ...alongside the target's own prints
  });

  it("THROWS below the floor when every peer is dropped — an absence to report, not a grid", () => {
    // EQ is the only candidate and disagrees twice, so BOND is left with itself alone (1 source).
    expect(() => containmentGrid(feed("BOND", BOND), [feed("EQ", EQ)])).toThrow(/independent source/);
  });

  it("counts the floor in INDEPENDENT sources: a composite leg peer does not lift a lone feed (R14.3)", () => {
    // BOND2 is a perfect peer but shares its parent's fetch, so it is not a source; BOND is still 1.
    expect(() => containmentGrid(feed("BOND", BOND), [feed("BOND2", BOND, false)])).toThrow(/independent source/);
  });

  it("does not penalise a peer for prints made before the target had started (R14.2 live-window)", () => {
    // f starts 10-08; g prints 10-05..10-07 BEFORE f was live, then aligns. Those pre-start prints
    // are outside f's [first,last] window, so they cost no mismatch and g stays a peer.
    const f = ["2026-10-08", "2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
    const gEarly = feed("G_EARLY", ["2026-10-05", "2026-10-06", "2026-10-07", ...f, "2026-10-26"]);
    expect(containmentGrid(feed("F", f), [gEarly]).dates).toContain("2026-10-26"); // marker present ⇒ kept
  });

  it("THROWS on an empty target — a zero-row feed is NO-DATA upstream, never a grid off its peers", () => {
    expect(() => containmentGrid(feed("F", []), [feed("G", BOND)])).toThrow(/no observation dates/);
  });

  // Targeted asserts for the memoised build (the R1 legacy-parity oracle, discharged): the slow-path
  // throw, a dropped peer never read, the pre-1970 weekday arithmetic, and per-object memo hits.
  it("an ACCEPTED non-ISO peer throws via publicationCalendar; a DROPPED one is never read", () => {
    const aligned = feed("P_ALIGNED", [...T, MARK_KEEP]);
    expect(() => containmentGrid(feed("T", T), [aligned, feed("BAD", [...T, "11/16/2026"])])).toThrow(/non-ISO/);
    expect(containmentGrid(feed("T", T), [aligned, feed("BAD_DROPPED", [...WEEKDAYS, "garbage"])]).dates).toContain(MARK_KEEP);
  });

  it("charges a pre-1970 silent weekday (negative-epoch weekday arithmetic)", () => {
    // Wed 1969-12-03 is silent for a target that prints Wednesdays (12-10), so a peer printing it is
    // dropped and its marker never unions in.
    const pre = ["1969-12-01", "1969-12-02", "1969-12-04", "1969-12-05", "1969-12-08", "1969-12-09", "1969-12-10"];
    const grid = containmentGrid(feed("PRE", pre), [feed("P_ALIGNED", pre), feed("P_DROP", ["1969-12-03", "1969-12-15"])]);
    expect(grid.dates).toEqual(pre);
  });

  it("memo hits: one candidate array reused across targets and calls builds the same grids", () => {
    const pool = [feed("A", T), feed("B", [...T, MARK_KEEP]), feed("C", T)];
    const want = [...T, MARK_KEEP].sort();
    for (let rep = 0; rep < 2; rep++) for (const t of pool) expect(containmentGrid(t, pool).dates, `${t.id} rep ${rep}`).toEqual(want);
  });
});
