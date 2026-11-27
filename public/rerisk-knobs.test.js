import { describe, expect, test } from "vitest";
import { reriskGateCopy } from "./rerisk-knobs.js";

// The footer must gate each clause on its OWN served field: the discriminating arm is dwell 1 with
// confirm left at 1, which a whole-sentence gate on `reriskConfirm` would render as "no dwell clock".
describe("reriskGateCopy - one clause per served field", () => {
  test("both retired (confirm 1, dwell 0) say so, with no chips", () => {
    const { sentence, chips } = reriskGateCopy({ reriskConfirm: 1, reriskDwellDays: 0 });
    expect(sentence).toContain("no confirm-streak or dwell clock");
    expect(chips).toBe("");
  });

  test("DWELL re-armed alone (0 → 1, confirm still 1) names the dwell and never claims it is retired", () => {
    const { sentence, chips } = reriskGateCopy({ reriskConfirm: 1, reriskDwellDays: 1 });
    expect(sentence).not.toContain("no confirm-streak or dwell clock");
    expect(sentence).toContain("1 close held since the leg last changed");
    expect(sentence).not.toContain("consecutive improving closes"); // confirm is still a tautology
    expect(chips).toBe(" · dwell 1");
  });

  test("CONFIRM re-armed alone (1 → 2, dwell still 0) names only the streak", () => {
    const { sentence, chips } = reriskGateCopy({ reriskConfirm: 2, reriskDwellDays: 0 });
    expect(sentence).toBe(" And re-risk to a more-aggressive leg needs 2 consecutive improving closes.");
    expect(chips).toBe(" · confirm 2×");
  });

  test("BOTH re-armed reads as one sentence with both clauses and both chips", () => {
    const { sentence, chips } = reriskGateCopy({ reriskConfirm: 2, reriskDwellDays: 3 });
    expect(sentence).toBe(
      " And re-risk to a more-aggressive leg needs 2 consecutive improving closes and 3 closes held since the leg last changed.",
    );
    expect(chips).toBe(" · confirm 2× · dwell 3");
  });

  test("an absent model (failed /api/danger-model fetch) degrades to the retired copy, never a NaN chip", () => {
    const { sentence, chips } = reriskGateCopy(null);
    expect(sentence).toContain("no confirm-streak or dwell clock");
    expect(chips).toBe("");
  });
});
