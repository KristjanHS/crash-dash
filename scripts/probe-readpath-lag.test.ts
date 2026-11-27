import { describe, expect, it } from "vitest";
import type { PublicationCalendar } from "../src/publication-calendar.js";
import { LAG_THRESHOLDS } from "../src/ladder.js";
import { maxSlot, scoreSlots, slotGate } from "./probe-readpath-lag.js";

/** THE slot cut under test, imported — never restated (threshold single-touch-point). */
const CUT = LAG_THRESHOLDS.daily;

/** A minority-calendar feed that skips 01-07/01-08, against a grid whose PEERS published on both —
 *  so a healthy read spends extra slots those days. Hand-derived: readPathAges walks obs 2026-01-05
 *  across [01-06 .. 01-09], and the same-day decrement zeros each publication day the store lacks
 *  pre-release, leaving slots [0,1,2,3] and a max of 3 on the Friday. */
const TARGET = ["2026-01-05", "2026-01-06", "2026-01-09"];
const GRID: PublicationCalendar = {
  cohort: "TEST",
  dates: ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"],
};

describe("probe-readpath-lag slot arm", () => {
  it("scores per-id slot ages with the same-day publication decrement and picks the max", () => {
    const scored = scoreSlots(TARGET, GRID, "TEST"); // an unlisted id: no closures, the fixture's hand-derivation holds
    expect(scored.map((s) => s.slot)).toEqual([0, 1, 2, 3]);
    const max = maxSlot(scored);
    expect(max.slot).toBe(3);
    expect(max.day).toBe("2026-01-09");
  });

  it("gates a feed at the cut PASS and one over it FAIL, and reports the worst", () => {
    expect(slotGate([CUT], CUT).fail).toBe(false);
    expect(slotGate([CUT + 1], CUT).fail).toBe(true);
    expect(slotGate([0, CUT + 1, 1], CUT).worst).toBe(CUT + 1);
  });
});
