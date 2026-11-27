import { describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import { makeStoredReading } from "./test-helpers.js";
import { LADDER } from "./families.js";
import { legCloseId } from "./scoreboard.js";
import type { Observation } from "./domain-types.js";
import { estimatorOf } from "./nowcast-score.js";
import { oilNowcastHead, pushLegSeries } from "./run-cycle-exposure.js";

// The EOD ruling: D's latest value drives the push, stored `estimated`.
describe("pushLegSeries - the push's growth maps read the served LEGP_* row, estimates included", () => {
  test("an `estimated` D row reaches the push; a FINAL row still wins its own date", async () => {
    const store = new InMemoryStore();
    const id = legCloseId(LADDER[0]);
    await store.recordReadings([makeStoredReading(id, { date: "2026-10-01", value: 5, estimated: true })], "2026-10-01T21:00:00.000Z");
    await store.recordReadings([makeStoredReading(id, { date: "2026-10-01", value: 1 })], "2026-10-02T10:00:00.000Z");
    await store.recordReadings([makeStoredReading(id, { date: "2026-10-02", value: 2, estimated: true })], "2026-10-02T22:00:00.000Z");
    const legs = await pushLegSeries(store);
    expect(legs.get(LADDER[0])?.map((p) => [p.date, p.value, p.estimated === true])).toEqual([
      ["2026-10-01", 1, false],
      ["2026-10-02", 2, true],
    ]);
    expect([...legs.keys()]).toEqual([...LADDER]);
  });
});

// The push clause's oil head, called directly (was 4 cycles in run.exposure.test.ts). G1 calendar: Wed 01-14, Thu 01-15,
// Fri 01-16, MLK Mon 01-19 (no G1 session), Tue 01-20. Futures closes are CL=F-shaped; the run's wiring of the
// value into `run_inputs.oilEst` is pinned once, on the all-GREEN cycle in run.wiring.test.ts.
describe("oilNowcastHead - the G1 push clause takes the nowcast one session past its print", () => {
  const beta = estimatorOf("G1", "carry-log").beta;
  const obs = (pairs: [string, number][]): Observation[] => pairs.map(([date, value]) => ({ date, value }));
  const carried = (level: number, now: number, base: number): number => level * Math.exp(beta * Math.log(now / base));
  test.each([
    {
      name: "one session past the print, off the READING's level (a stored row on its date never wins)",
      print: "2026-01-15", stored: obs([["2026-01-14", 79], ["2026-01-15", 999]]),
      futures: obs([["2026-01-15", 100], ["2026-01-16", 101], ["2026-01-20", 103]]), fired: "2026-01-20",
      want: { date: "2026-01-16", fromDate: "2026-01-15", value: carried(80, 101, 100) },
    },
    {
      name: "never chained across a session with no print (01-16 has no future bar, so 01-20 is a gap)",
      print: "2026-01-15", stored: obs([["2026-01-14", 79]]),
      futures: obs([["2026-01-15", 100], ["2026-01-20", 103]]), fired: "2026-01-20", want: null,
    },
    {
      name: "stored prints past the reading are capped away (they would anchor the chained 01-20 bar)",
      print: "2026-01-15", stored: obs([["2026-01-14", 79], ["2026-01-16", 500]]),
      futures: obs([["2026-01-15", 100], ["2026-01-20", 103]]), fired: "2026-01-20", want: null,
    },
    {
      name: "Tue after MLK Day takes Tue, never the Mon holiday bar",
      print: "2026-01-16", stored: obs([["2026-01-15", 79]]),
      futures: obs([["2026-01-16", 100], ["2026-01-19", 101], ["2026-01-20", 102]]), fired: "2026-01-20",
      want: { date: "2026-01-20", fromDate: "2026-01-16", value: carried(80, 102, 100) },
    },
    {
      name: "a Fri bar on a Thu run (print Thu) lands nothing",
      print: "2026-01-15", stored: obs([["2026-01-14", 79]]),
      futures: obs([["2026-01-15", 100], ["2026-01-16", 101]]), fired: "2026-01-15", want: null,
    },
    {
      name: "S2a/R11a walk-back: no future bar on the print's date carries the EARLIER stored print",
      print: "2026-01-16", stored: obs([["2026-01-14", 77], ["2026-01-15", 78]]),
      futures: obs([["2026-01-15", 100], ["2026-01-20", 103]]), fired: "2026-01-20",
      want: { date: "2026-01-20", fromDate: "2026-01-15", value: carried(78, 103, 100) },
    },
    {
      name: "S2a/R11a contrast: the same world with no stored prints has nothing to walk back to",
      print: "2026-01-16", stored: undefined,
      futures: obs([["2026-01-15", 100], ["2026-01-20", 103]]), fired: "2026-01-20", want: null,
    },
  ])("$name", ({ print, stored, futures, fired, want }) => {
    const got = oilNowcastHead("G1", { date: print, level: 80 }, stored, futures, fired);
    expect(got).toEqual(want === null ? null : { date: want.date, fromDate: want.fromDate, value: expect.closeTo(want.value, 10) });
  });
});
