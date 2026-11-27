import { describe, expect, it } from "vitest";
import { compareBandCuts, REL_TOL } from "./probe-band-cuts-parity.js";

const KEYS = ["postInvAmber"] as const;

describe("compareBandCuts", () => {
  const D = "2026-09-01";
  it.each([
    ["counts a stored value that differs from the fresh re-score as a mismatch", { postInvAmber: 1.5 }, { postInvAmber: 1.6 }, { compared: 1, mismatched: 1, storedNull: 0, details: [`${D} postInvAmber stored=1.5 fresh=1.6`] }],
    ["passes a stored value within REL_TOL of the fresh one", { postInvAmber: 1.5 }, { postInvAmber: 1.5 * (1 + REL_TOL / 10) }, { compared: 1, mismatched: 0, storedNull: 0 }],
    ["counts stored null where the fresh re-score has a finite cut as storedNull", null, { postInvAmber: 1.6 }, { compared: 0, mismatched: 0, storedNull: 1 }],
    ["treats null on BOTH sides (an R1 unarmed day) as OK", null, undefined, { compared: 0, mismatched: 0, storedNull: 0 }],
    ["counts a stored key the fresh re-score does not emit as a mismatch", { postInvAmber: 1.5 }, undefined, { compared: 0, mismatched: 1, storedNull: 0 }],
    ["ignores stored keys outside the id's wire-key set", { velEvtRed: 9 }, { velEvtRed: 1 }, { compared: 0, mismatched: 0, storedNull: 0 }],
  ])("%s", (_, stored, fresh, want) => {
    expect(compareBandCuts([{ date: D, stored, fresh }], KEYS)).toMatchObject({ rows: 1, ...want });
  });
});
