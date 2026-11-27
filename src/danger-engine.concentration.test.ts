import { describe, it, expect } from "vitest";
import type { State } from "./domain-types.js";
import { computeField, type FieldResult } from "./danger-engine.js";
import { CONC_THRESHOLD, CONC_WEIGHT } from "./danger-concentration.js";
import { FAMILY_MEMBERS, LEG_SENSITIVITY, SIGNALS, type LegKey } from "./danger-ladder.js";
import { gf } from "./danger-engine.test-helpers.js";

/** Full panel: every family member observed GREEN except `fired`. */
const ALL_IDS = [...new Set(SIGNALS.flatMap((f) => FAMILY_MEMBERS[f]))];
const panel = (fired: Readonly<Record<string, State>>) =>
  gf(ALL_IDS.map((id) => ({ id, state: fired[id] ?? "GREEN" })));
const row = (f: FieldResult, sleeve: LegKey) => f.legRows.find((r) => r.sleeve === sleeve)!;
const own = (f: FieldResult, sleeve: LegKey) => row(f, sleeve).danger * LEG_SENSITIVITY[sleeve];

// Semis-heavy stress (F11 reaches Semis + EM but not S&P IT): Semis ≥ the #R2 threshold, S&P IT calmer
// than EM. No surviving member lifts Semis far enough above EM for the 0.6×sibling bump to out-rank EM,
// so this panel pins the badge (the flag), not a hold move.
const SEMIS_HOT: Record<string, State> = { F11: "RED", FXH: "RED", F9: "RED", CG: "RED" };
const band = { lo: 1, hi: 3 }; // in-band: Semis(1), S&P IT(2), EM(3)

describe("computeField - #R2 concentration cap", () => {
  it("control - full panel GREEN: no concentration flag, Semis held", () => {
    const f = computeField(panel({}), band);
    expect(f.legRows.filter((r) => r.concentrated).map((r) => r.sleeve)).toEqual([]);
    expect(f.held?.sleeve).toBe("Semis");
  });

  it("Semis ≥ CONC_THRESHOLD flags its twin S&P IT; the bump stays under S&P IT's own danger, so it holds", () => {
    const f = computeField(panel(SEMIS_HOT), band);
    // Premises: Semis elevated; S&P IT's own danger is below EM's and above CONC_WEIGHT × Semis.
    expect(own(f, "Semis")).toBeGreaterThanOrEqual(CONC_THRESHOLD);
    expect(own(f, "S&P IT")).toBeLessThan(own(f, "EM"));
    expect(own(f, "S&P IT")).toBeGreaterThan(CONC_WEIGHT * own(f, "Semis"));
    expect(row(f, "S&P IT").concentrated).toBe(true);
    expect(row(f, "Semis").concentrated).toBe(false); // S&P IT is under the threshold
    expect(f.held?.sleeve).toBe("S&P IT");
  });
});

describe("computeField - DISP widens the concentration cluster to include EM", () => {
  // EM is never in the base [Semis, S&P IT] cluster, so `EM.concentrated` lights ONLY via the widening.
  it("DISP GREEN ⇒ EM NOT concentrated; DISP AMBER ⇒ EM joins the cluster", () => {
    const emConc = (disp: State) => row(computeField(panel({ ...SEMIS_HOT, DISP: disp }), band), "EM").concentrated;
    expect([emConc("GREEN"), emConc("AMBER")]).toEqual([false, true]);
  });

  it("a sibling reads LEG_SENSITIVITY-scaled danger - EM plain ≥ CONC_THRESHOLD but scaled below flags nobody", () => {
    const f = computeField(panel({ R5: "RED", DISP: "RED" }), band);
    // premise: EM is the only plain-elevated cluster leg, and only its sensitivity drops it under
    expect([row(f, "EM").danger >= CONC_THRESHOLD, own(f, "EM") < CONC_THRESHOLD]).toEqual([true, true]);
    expect([own(f, "Semis"), own(f, "S&P IT")].filter((d) => d >= CONC_THRESHOLD)).toEqual([]);
    expect(f.legRows.filter((r) => r.concentrated).map((r) => r.sleeve)).toEqual([]);
  });
});
