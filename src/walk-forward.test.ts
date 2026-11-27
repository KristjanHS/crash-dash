// Pure unit tests for `walkForward` (src/run-core.ts) — the read-only `/lab?walk=N` forward walk.
// DB-free: the helper is IO-free by contract (the caller does the store reads and passes them in),
// so every delayed/lagged action can be exercised over synthesized frozen conditions. Each test
// picks a seed + frozen dial where the walk MUST move state day-over-day, so a broken threading
// (windows, prevDay, clock advance) goes red rather than silently holding.
import { describe, test, expect } from "vitest";

import { walkForward } from "./run-core.js";
import { makeAlert, makeDial } from "./test-helpers.js";
import { R4_EXIT_HY, R4_EXIT_VT, R4_RATCHET_DAYS } from "./r4.js";
import type { Channel, Reading, State } from "./domain-types.js";

const MS_PER_DAY = 86_400_000;

/** A minimal confirmed Reading — `date` is overwritten per-day by the walk, so its value here is
 *  immaterial. `level` feeds the R4 tail gates (F1 = HY-OAS %, VT = VIX/VIX3M ratio). */
const reading = (id: string, channel: Channel, state: State, level: number): Reading => ({
  indicator: { id, label: id, longLabel: id, series: id, channel, thresholds: {} },
  date: "2026-06-26",
  level,
  delta20: 0,
  rawState: state,
  state,
  decision: null,
});

// Tails CLEAR and every leg GREEN, so nothing but the R4 phase machine / de-escalation lag can move
// the band — the isolation the tests need. Both levels are DERIVED from their cuts (never restated),
// so a retune of either cut carries the fixture with it.
const calmReadings = (): Reading[] => [
  reading("F1", "FIN", "GREEN", R4_EXIT_HY - 0.5),
  reading("VT", "COINCIDENT", "GREEN", R4_EXIT_VT - 0.05),
];

// A dial shallow enough to EXIT/re-enter the ladder (targetRung ≤ R4_EXIT_RUNG — read the cut from
// `src/r4.ts`; the walk assertions below also pin this rung as the walk's TARGET, so it is a fixture
// input here, not a restatement of the cut), pillars live, no families firing (enterCond can never
// re-arm the breaker). The whole book is DERIVED from the rung (`makeDial`) — rung 3 with a
// fully-split leader axis ⇒ band {1,3}. It is NOT "Calm": at rung 3 the score sits exactly on the
// Caution cut, so its raw dial band is WATCH. The de-escalation test below therefore needs its own,
// genuinely calm dial rather than this one.
const exitTargetDial = () => makeDial({ rung: 3, pillarsLive: true }, { leaderSplit: 1 });

const SEED_DATE = "2026-06-25";

describe("walkForward - R4 re-entry rung walk (D8)", () => {
  test("laddered re-entry climbs one rung/day from the most-defensive rung to the live target", () => {
    const seed = {
      alert: makeAlert({
        date: SEED_DATE,
        r4Phase: "reentry" as const,
        r4ReentryRung: 9, // most-defensive on-ladder rung (R4_REENTRY_START)
        r4EntryFiredAt: null,
      }),
      recentDialBands: [],
      recentAlerts: [],
    };
    // 9 → 8 → 7 → 6 → 5 → 4 → (3 = target ⇒ complete). Six calendar days to land.
    const { final, legPath } = walkForward(
      seed,
      { readings: calmReadings(), lastPush: null, dial: exitTargetDial(), crisisStage: 0 },
      6,
    );

    expect(legPath.map((s) => s.r4ReentryRung)).toEqual([8, 7, 6, 5, 4, null]);
    expect(legPath[4]!.r4Phase).toBe("reentry"); // day 5 still walking
    expect(final.alert.r4Phase).toBe("equity"); // day 6 fully re-invested onto the target rung
    expect(final.alert.r4ReentryRung).toBeNull();
  });
});

describe("walkForward - idle-cash ratchet (R4_RATCHET_DAYS)", () => {
  const inCashSeed = (entryDaysAgo: number) => ({
    alert: makeAlert({
      date: SEED_DATE,
      r4Phase: "cash" as const,
      r4EntryFiredAt: new Date(Date.parse(`${SEED_DATE}T00:00:00.000Z`) - entryDaysAgo * MS_PER_DAY).toISOString(),
      r4ReentryRung: null,
    }),
    recentDialBands: [],
    recentAlerts: [],
  });
  const frozen = { readings: calmReadings(), lastPush: null, dial: exitTargetDial(), crisisStage: 0 };

  // NOT "calm days": the frozen dial is `exitTargetDial()` (rung 3 ⇒ Caution/WATCH). The ratchet reads
  // `targetRung`, never the band, so a Caution dial is a legitimate exit close — the title says DAYS IN
  // CASH, which is the gate's actual input.
  test(`≥ ${R4_RATCHET_DAYS} days in cash ⇒ ratchet snaps straight to target on the first exit close`, () => {
    const { final } = walkForward(inCashSeed(R4_RATCHET_DAYS + 5), frozen, 1);
    expect(final.alert.r4Phase).toBe("equity");
    expect(final.alert.r4ReentryRung).toBeNull();
  });

  test("a short stay walks the ladder instead of snapping (distinguishes the ratchet boundary)", () => {
    const { final } = walkForward(inCashSeed(2), frozen, 1);
    expect(final.alert.r4Phase).toBe("reentry");
    expect(final.alert.r4ReentryRung).toBe(9);
  });
});

describe("walkForward - de-escalation lag (DE_ESCALATION_DAYS)", () => {
  test("a dropped dial band holds one extra day, then steps DOWN on day 2 (N=2)", () => {
    // Frozen dial is genuinely Calm (rung 1 ⇒ dialBand OK — `exitTargetDial` above is Caution/WATCH
    // and would leave nothing for the lag to step DOWN to) but the prod tail's last raw band was
    // WARNING: the lag must hold WARNING for the first day and only release to OK once the window
    // rolls past it. Nothing in this test reads the rung — only the raw band the lag sits over.
    const seed = {
      alert: makeAlert({ date: SEED_DATE, r4Phase: "equity" as const, dialBand: "WARNING" as const }),
      recentDialBands: ["WARNING" as const],
      recentAlerts: [],
    };
    const { legPath } = walkForward(
      seed,
      { readings: calmReadings(), lastPush: null, dial: makeDial({ pillarsLive: true }), crisisStage: 0 },
      2,
    );
    expect(legPath[0]!.band).toBe("WARNING"); // day 1: lag-held above the raw Calm dial
    expect(legPath[1]!.band).toBe("OK"); // day 2: WARNING has rolled out of the N-day window
  });
});
