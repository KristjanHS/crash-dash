import { describe, it, expect } from "vitest";
import { decideRotationHold, type DecideRotationHoldInput } from "./rotation-commit.js";
import { RERISK_DWELL_DAYS, LEGACY_RERISK_GATES } from "./danger-ladder.js";

// Base input: a re-risk-eligible shape (wants a more-aggressive leg) with the ONE surviving gate
// (`trendOk`) green — individual cases override the one field under test. `prevHeld` rung 5,
// candidate rung 2.
//
// ⚠ Every fixture below is DERIVED from the constants, never a restated literal. `RERISK_CONFIRM - 1`
// and `RERISK_DWELL_DAYS - 1` are BANNED as fixture expressions since the 2026-08-07 symmetry ruling:
// at the shipped 1/0 they evaluate to 0 and **-1**, and a negative dwell made three tests pass for a
// reason no close can ever reproduce. Where a case genuinely needs an UNMET timing gate it drives the
// frozen `LEGACY_RERISK_GATES` through `decideRotationHold`'s probe seam instead — that is the only honest way
// to exercise a gate the live constants can no longer fail.
const base: DecideRotationHoldInput = {
  candidateSleeve: "S&P IT", // rung 2 (more aggressive)
  prevHeld: "S&P 500", // rung 5
  prevRung: 5,
  candidateRung: 2,
  improving: true,
  trendOk: true,
  prevConfirmCount: 0, // no streak banked — at RERISK_CONFIRM = 1 this close alone is the streak
  prevHeldDays: RERISK_DWELL_DAYS, // dwell already cleared (0 closes are owed)
  newClose: false,
  drawdownGateFires: false, // W5-e gate OFF by default ⇒ the whole existing suite is the fail-safe pin
};

// A dwell that is SHORT of the legacy gate but non-negative, derived from the frozen pair so a §5
// re-arm of `LEGACY_RERISK_GATES` carries it. Used only on the probe-seam arms.
const LEGACY_DWELL_SHORT = LEGACY_RERISK_GATES.dwellDays - 1;

describe("decideRotationHold - Stage 3.1 behavior freeze (commit machine)", () => {
  it("de-risk to a MORE-defensive leg commits now + resets the streak", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "Staples", // rung 9 (more defensive than prev rung 5)
      candidateRung: 9,
      prevConfirmCount: 3,
      improving: false,
    });
    expect(r.heldSleeve).toBe("Staples");
    expect(r.reriskConfirmCount).toBe(0);
  });

  it("first-ever hold (prevHeld null) commits the candidate + resets streak", () => {
    const r = decideRotationHold({
      ...base,
      prevHeld: null,
      prevRung: 0,
      prevConfirmCount: 0,
      prevHeldDays: 0,
    });
    expect(r.heldSleeve).toBe("S&P IT");
    expect(r.reriskConfirmCount).toBe(0);
    expect(r.heldDays).toBe(0);
  });

  it("hold-in-place (candidate == prev) commits + resets streak", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "S&P 500",
      candidateRung: 5, // not < prevRung ⇒ not wantsMoreAggressive
    });
    expect(r.heldSleeve).toBe("S&P 500");
    expect(r.reriskConfirmCount).toBe(0);
  });

  // (was: "improving but streak short — HOLD prior, carry incremented counter") — §3.6 new pin (a).
  // At RERISK_CONFIRM = 1 there is no such thing as a short streak: the FIRST close commits.
  it("a re-risk commits on the FIRST close - zero banked streak, zero heldDays, no hold", () => {
    const r = decideRotationHold({ ...base, prevConfirmCount: 0, prevHeldDays: 0, newClose: true, gates: { confirm: 1, dwellDays: 0 } });
    expect(r.heldSleeve).toBe("S&P IT"); // rotated on close 1, not queued
    expect(r.reriskConfirmCount).toBe(0);
    expect(r.heldDays).toBe(0); // reset by the rotation itself
  });

  // (was: "wants aggressive but NOT improving — HOLD prior, reset streak") — §3.6 new pin (b).
  // The exact case §3.2's `improving` drop exists for: the DIAL band is stable (`improving === false`)
  // while the FIELD re-orders toward a more-aggressive leg. Pre-2026-08-07 this held; it now commits.
  it("a re-risk under a STABLE band (improving = false) commits - the dial no longer vetoes the field", () => {
    const r = decideRotationHold({ ...base, improving: false, prevConfirmCount: 3, newClose: true });
    expect(r.heldSleeve).toBe("S&P IT"); // committed despite improving === false
    expect(r.reriskConfirmCount).toBe(0); // banked streak discarded by the commit
    expect(r.heldDays).toBe(0);
  });

  // §3.6 new pin (c) — the ONE surviving re-risk gate, shown demonstrably capable of firing: same
  // fixture as the commit case above, `trendOk` alone flipped.
  it("trendOk = false STILL blocks a re-risk - the one surviving gate", () => {
    const committed = decideRotationHold({ ...base, trendOk: true, newClose: true });
    const blocked = decideRotationHold({ ...base, trendOk: false, newClose: true });
    expect(committed.heldSleeve).toBe("S&P IT"); // the gate is the ONLY difference between these two
    expect(blocked.heldSleeve).toBe("S&P 500"); // prior leg held
    expect(blocked.reriskConfirmCount).toBe(1); // improving ⇒ the streak accumulates behind the veto
  });
});

describe("decideRotationHold - Stage 3.2 M7 dwell + M8 explicit per-direction lag", () => {
  it("de-risk commits with heldDays 0, prevConfirmCount 0, trendOk false - nothing gates it", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "Staples",
      candidateRung: 9,
      improving: false,
      trendOk: false,
      prevConfirmCount: 0,
      prevHeldDays: 0,
      newClose: true,
    });
    expect(r.heldSleeve).toBe("Staples");
    expect(r.heldDays).toBe(0); // reset on the de-risk move itself
  });

  // Stage-4 seam pin (e), dwell half. The LIVE gate can no longer block anything, so the ONLY way to
  // show the dwell term is real machinery — and not a deleted no-op — is to drive the frozen legacy
  // pair through the probe override and reproduce the pre-2026-08-07 decision. The two arms below
  // share every field except `gates`, so a seam that could not change the answer would fail them.
  it("SEAM: LEGACY_RERISK_GATES reproduces the OLD dwell block; the live gates commit the same input", () => {
    const shared = {
      ...base,
      prevConfirmCount: LEGACY_RERISK_GATES.confirm - 1, // legacy streak met on this close
      prevHeldDays: LEGACY_DWELL_SHORT,
      newClose: false, // dwellNow = LEGACY_DWELL_SHORT < LEGACY_RERISK_GATES.dwellDays
    };
    const legacy = decideRotationHold({ ...shared, gates: LEGACY_RERISK_GATES });
    expect(legacy.heldSleeve).toBe("S&P 500"); // held, not rotated — the pre-2026-08-07 answer
    expect(legacy.reriskConfirmCount).toBe(LEGACY_RERISK_GATES.confirm); // streak still accumulates
    expect(legacy.heldDays).toBe(LEGACY_DWELL_SHORT); // unchanged (held, no new close)

    const live = decideRotationHold(shared); // same input, override omitted ⇒ shipped constants
    expect(live.heldSleeve).toBe("S&P IT"); // the seam DOES change the answer
    expect(live.reriskConfirmCount).toBe(0);
  });

  // Stage-4 seam pin, `improving` half (review finding 2, 2026-08-07). The other seam arms all
  // inherit `improving: true` from `base`, so they could not see that the seam was reproducing only
  // the TIMING half of the old condition. This is the exact divergence: every timing gate CLEARED,
  // trend green, and only `improving` false — the pre-ruling code HELD, the shipped code commits.
  // A `{confirm, dwellDays}`-only seam would commit on the legacy arm too and this test would red.
  it("SEAM: LEGACY_RERISK_GATES also reproduces the DROPPED `improving` term (timing fully cleared)", () => {
    const shared = {
      ...base,
      improving: false, // stable band, field re-ordering toward a more-aggressive leg
      prevConfirmCount: LEGACY_RERISK_GATES.confirm, // legacy streak already banked
      prevHeldDays: LEGACY_RERISK_GATES.dwellDays, // legacy dwell already paid
      newClose: true,
    };
    const legacy = decideRotationHold({ ...shared, gates: LEGACY_RERISK_GATES });
    expect(legacy.heldSleeve).toBe("S&P 500"); // HELD — the pre-2026-08-07 answer, timing notwithstanding
    expect(legacy.reriskConfirmCount).toBe(0); // not improving ⇒ the streak resets behind the hold

    const live = decideRotationHold(shared); // same input, seam omitted ⇒ shipped condition
    expect(live.heldSleeve).toBe("S&P IT"); // commits: `improving` is no longer a commit term
    // Non-vacuity: the legacy arm must be blocked by `improving` ALONE, not by a timing gate that
    // happens to be unmet — both timing terms are satisfied on this exact input.
    expect(shared.prevConfirmCount + 1).toBeGreaterThanOrEqual(LEGACY_RERISK_GATES.confirm);
    expect(shared.prevHeldDays + 1).toBeGreaterThanOrEqual(LEGACY_RERISK_GATES.dwellDays);
  });

  it("SEAM: under LEGACY_RERISK_GATES a new close pays the last dwell day and commits", () => {
    const r = decideRotationHold({
      ...base,
      prevConfirmCount: LEGACY_RERISK_GATES.confirm - 1,
      prevHeldDays: LEGACY_DWELL_SHORT,
      newClose: true, // dwellNow = LEGACY_RERISK_GATES.dwellDays ⇒ legacy dwell cleared
      gates: LEGACY_RERISK_GATES,
    });
    expect(r.heldSleeve).toBe("S&P IT"); // rotated
    expect(r.reriskConfirmCount).toBe(0);
    expect(r.heldDays).toBe(0); // reset on the rotation
  });

  it("heldDays ticks once per new close when the leg is held in place", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "S&P 500",
      candidateRung: 5, // hold in place
      prevHeldDays: 3,
      newClose: true,
    });
    expect(r.heldSleeve).toBe("S&P 500");
    expect(r.heldDays).toBe(4); // 3 + 1
  });

  it("held-in-place does NOT tick heldDays on a weekend/holiday re-run (no new close)", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "S&P 500",
      candidateRung: 5,
      prevHeldDays: 3,
      newClose: false,
    });
    expect(r.heldDays).toBe(3); // unchanged
  });

  // The surviving blocker carries the same two-close shape the dwell used to: a trend-vetoed re-risk
  // banks the streak while it waits, and commits on the first close the veto lifts.
  it("trend-blocked-but-improving accumulates the streak, then commits on the close the veto lifts", () => {
    const blocked = decideRotationHold({ ...base, trendOk: false, prevConfirmCount: 5, newClose: true });
    expect(blocked.heldSleeve).toBe("S&P 500");
    expect(blocked.reriskConfirmCount).toBe(6);
    const cleared = decideRotationHold({
      ...base,
      trendOk: true,
      prevConfirmCount: blocked.reriskConfirmCount,
      prevHeldDays: blocked.heldDays,
      newClose: true,
    });
    expect(cleared.heldSleeve).toBe("S&P IT");
  });

  // (was: "de-risk → immediate re-bounce is dwell-blocked a full RERISK_DWELL_DAYS closes")
  // The de-risk's heldDays reset still happens, but at RERISK_DWELL_DAYS = 0 it costs NOTHING: the
  // re-bounce commits on the very next close. Same fixture, opposite verdict — this is the plan's
  // "accepted cost" (§5) pinned, and the LEGACY arm shows the old block was real machinery.
  it("de-risk → immediate re-bounce now COMMITS (dwell reset is free); LEGACY gates still block it", () => {
    // de-risk move resets heldDays to 0
    const derisk = decideRotationHold({
      ...base,
      candidateSleeve: "Staples",
      candidateRung: 9,
      improving: false,
      prevHeldDays: 20,
      newClose: true,
    });
    expect(derisk.heldDays).toBe(0);
    // immediate re-bounce attempt off that zeroed dwell
    const rebounce = {
      ...base,
      prevHeld: "Staples",
      prevRung: 9,
      candidateSleeve: "S&P IT",
      candidateRung: 2,
      prevConfirmCount: 5,
      prevHeldDays: derisk.heldDays, // 0
      newClose: true,
    };
    expect(decideRotationHold(rebounce).heldSleeve).toBe("S&P IT"); // free re-bounce
    expect(decideRotationHold({ ...rebounce, gates: LEGACY_RERISK_GATES }).heldSleeve).toBe("Staples");
  });
});

describe("decideRotationHold - W5-e drawdown-gate rung clamp (D-1 seam, D-2 bidirectional, D-3 drop-and-recompute)", () => {
  it("gate ON: a >+1 de-risk is capped to +1 rung/run", () => {
    const r = decideRotationHold({
      ...base,
      candidateSleeve: "Staples", // rung 9, a +4 de-risk from rung 5
      candidateRung: 9,
      improving: false,
      drawdownGateFires: true,
    });
    expect(r.heldSleeve).toBe("ex-US"); // rung 6 = prevRung 5 + 1, NOT "Staples" (gate OFF: the Stage 3.1 de-risk case)
    expect(r.heldDays).toBe(0); // the clamped move is still a held-leg change
  });

  it("gate ON (D-2 bidirectional): a >+1 RE-RISK that M8 permits is ALSO capped to -1 rung/run", () => {
    // prevHeld rung 9, candidate rung 6 (a -3 re-risk) with every re-risk gate green (base), so M8
    // commits the rotation and the clamp then caps the ascent. This is the load-bearing §9 case:
    // measured bite is ~entirely re-risk, so a de-risk-only clamp (the stale §5 default) would be inert.
    const r = decideRotationHold({
      ...base,
      prevHeld: "Staples",
      prevRung: 9,
      candidateSleeve: "ex-US", // rung 6
      candidateRung: 6,
      drawdownGateFires: true,
    });
    expect(r.heldSleeve).toBe("Health"); // rung 8 = prevRung 9 - 1, NOT "ex-US"
  });

  it("gate ON but re-risk BLOCKED by M8 (trend veto): clamp is a no-op - composes with M8, not around it", () => {
    const r = decideRotationHold({
      ...base,
      prevHeld: "Staples",
      prevRung: 9,
      candidateSleeve: "ex-US",
      candidateRung: 6,
      trendOk: false, // M8 HOLDS prior ⇒ committed rung == prevRung ⇒ nothing to clamp
      newClose: true,
      drawdownGateFires: true,
    });
    expect(r.heldSleeve).toBe("Staples"); // M8 already held; the clamp never forces a phantom step
  });

  it("D-3 drop-and-recompute: a +3 de-risk steps +1 then +1 from the RECOMPUTED prev, no carried distance", () => {
    // run 1: prevRung 2, candidate rung 5 (+3), gate ON ⇒ committed rung 3
    const run1 = decideRotationHold({
      ...base,
      prevHeld: "S&P IT", // rung 2
      prevRung: 2,
      candidateSleeve: "S&P 500", // rung 5
      candidateRung: 5,
      improving: false,
      drawdownGateFires: true,
    });
    expect(run1.heldSleeve).toBe("EM"); // rung 3 = 2 + 1
    // run 2: the dial re-derives the SAME candidate (rung 5); prev is now the clamped rung 3. No "owed"
    // distance is persisted — it steps another +1 from the fresh prev (drop-and-recompute, no migration).
    const run2 = decideRotationHold({
      ...base,
      prevHeld: run1.heldSleeve, // rung 3
      prevRung: 3,
      candidateSleeve: "S&P 500", // rung 5, still +2 away
      candidateRung: 5,
      improving: false,
      drawdownGateFires: true,
    });
    expect(run2.heldSleeve).toBe("Value"); // rung 4 = 3 + 1, another single step
  });
});
