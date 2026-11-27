import { describe, it, expect } from "vitest";
import { heldTransitions, heldWalkVerdict, type HeldStep } from "./held-walk.js";

const step = (date: string, held: string, rung: number): HeldStep => ({ date, held, rung });

describe("heldTransitions — held changes between consecutive closes", () => {
  it("labels a move to a higher rung de-risk and to a lower rung re-risk", () => {
    const t = heldTransitions([step("d1", "Semis", 1), step("d2", "Health", 8), step("d3", "Value", 4)]);
    expect(t).toEqual([
      { date: "d2", from: "Semis", to: "Health", direction: "de-risk" },
      { date: "d3", from: "Health", to: "Value", direction: "re-risk" },
    ]);
  });
  it("emits nothing for a hold-in-place close or the first close", () => {
    expect(heldTransitions([step("d1", "EM", 3), step("d2", "EM", 3)])).toEqual([]);
    expect(heldTransitions([step("d1", "EM", 3)])).toEqual([]);
  });
});

describe("heldWalkVerdict — the walk passes only when it rotates both ways", () => {
  it("passes with at least one de-risk and one re-risk, counting distinct held legs", () => {
    const v = heldWalkVerdict([step("d1", "Semis", 1), step("d2", "Health", 8), step("d3", "Semis", 1)]);
    expect(v).toMatchObject({ deRisks: 1, reRisks: 1, ok: true, distinctHeld: ["Semis", "Health"] });
  });
  it("fails a window with de-risks but no re-risk", () => {
    const v = heldWalkVerdict([step("d1", "Semis", 1), step("d2", "EM", 3), step("d3", "Health", 8)]);
    expect(v).toMatchObject({ deRisks: 2, reRisks: 0, ok: false });
  });
  it("fails a window with re-risks but no de-risk", () => {
    const v = heldWalkVerdict([step("d1", "Health", 8), step("d2", "Semis", 1)]);
    expect(v).toMatchObject({ deRisks: 0, reRisks: 1, ok: false });
  });
  it("fails a window that never moves", () => {
    expect(heldWalkVerdict([step("d1", "EM", 3), step("d2", "EM", 3)]).ok).toBe(false);
  });
});
