import { describe, it, expect } from "vitest";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import type { State } from "./domain-types.js";
import { GLOBAL_FAMILIES } from "./families.js";
import {
  computeField,
  trendConfirming,
  DANGER_CUTS,
  type MemberHistoryEntry,
} from "./danger-engine.js";
import { buildMemberState } from "./danger-member-state.js";
import { FAMILY_MEMBERS, MEMBER_WEIGHT } from "./danger-ladder.js";
import { gf } from "./danger-engine.test-helpers.js";
import { CONFIRMING_TREND_MEMBERS } from "./danger-exogenous.js";
import { LOOKBACK } from "./danger-deadband.js";

describe("EXOGENOUS - the weighted per-leg `gp` term", () => {
  // The ALERT-ladder side of the reconcile (G1 still counts as a geo flag in
  // escalatorFloor GEO base — a double-count RULED intended, §0.5) is pinned by alert-band.compose.test.ts
  // "GEO auto oil (G1 non-GREEN on GEO channel) counts toward the base" (one manual flag + one
  // elevated G1 oil reading = base 2 → WARNING).
  const band = { lo: 1, hi: 9 };
  it("a lone oil shock keeps every leg's danger below amber; the gp CELL carries the unscaled member weight", () => {
    const shock = computeField(gf([{ id: "OVX", state: "RED" }]), band);
    expect(shock.legRows.length).toBe(9);
    for (const l of shock.legRows) expect(l.danger).toBeLessThan(DANGER_CUTS.amber);
    // The cell is display severity (weight × sev, no scale); the cap lives on the danger term only.
    const exUS = shock.legRows.find((l) => l.sleeve === "ex-US")!;
    expect(exUS.cells.find((c) => c.family === "gp")!.wsev).toBe(MEMBER_WEIGHT.OVX!["ex-US"]!);
  });

  it("exogenous.floor = the MIN per-leg gp term (not the max, not a cell wsev)", () => {
    // OVX AMBER + G1 GREEN spreads the gp share across legs: EU-Fin sits below the cap, the rest at it.
    const r = computeField(gf([{ id: "OVX", state: "AMBER" }, { id: "G1", state: "GREEN" }]), band);
    const terms = r.legRows.map((l) => l.subDangers.gp ?? 0);
    const cellMin = Math.min(...r.legRows.map((l) => l.cells.find((c) => c.family === "gp")!.wsev ?? 0));
    expect(Math.max(...terms)).toBeGreaterThan(Math.min(...terms)); // fixture discriminates min vs max
    expect(cellMin).not.toBeCloseTo(Math.min(...terms), 6); // …and term vs cell
    expect(r.exogenous).toEqual({ active: true, floor: Math.min(...terms) });
  });

  it("momentum mirror: G1 lit now AND at t−N ⇒ momentum 0 (the term is symmetric on both ROC ends)", () => {
    const history: MemberHistoryEntry[] = [
      {
        id: "G1",
        history: Array.from({ length: LOOKBACK + 1 }, (_, i) => ({
          date: `d${i}`,
          value: 1,
          delta20: 0,
          rawState: "RED" as State,
          state: "RED" as State,
        })),
      },
    ];
    const r = computeField(gf([{ id: "G1", state: "RED" }]), band, history);
    expect(r.legRows.every((l) => l.momentum === 0)).toBe(true);
  });
});

describe("trendConfirming - the CONFIRMING veto is GT/GB only (R4, 2026-07-18)", () => {
  const confirming = (members: { id: string; state: State }[]) =>
    trendConfirming(buildMemberState(gf(members)));

  it("a lone US-tech proxy RED no longer blocks re-risk", () => {
    // Pre-R4 every uT member vetoed, so each of these returned false. The proxies joined the uT
    // ledger column for DISPLAY (2026-07-13) and were never meant to gate rotation.
    for (const id of ["F4", "F5", "F6", "F8"]) {
      expect(confirming([{ id, state: "RED" }])).toBe(true);
    }
  });

  it("a GT or GB RED still blocks re-risk", () => {
    expect(confirming([{ id: "GT", state: "RED" }])).toBe(false);
    expect(confirming([{ id: "GB", state: "RED" }])).toBe(false);
    // and a proxy RED alongside a calm pair is still confirming
    expect(
      confirming([
        { id: "GT", state: "GREEN" },
        { id: "GB", state: "GREEN" },
        { id: "F4", state: "RED" },
      ]),
    ).toBe(true);
  });

  it("absent members are calm ⇒ confirming (a missing feed can't block re-risk)", () => {
    expect(confirming([])).toBe(true);
  });

  it("every CONFIRMING member is a real uT member (no drift from the family table)", () => {
    for (const m of CONFIRMING_TREND_MEMBERS) expect(FAMILY_MEMBERS["uT"]).toContain(m);
  });
});

describe("Stage 2.1 - FAMILY_MEMBERS derives from DIAL_FAMILIES (the SLOW-leg depth bug)", () => {
  // The display-only SLOW legs are never persisted on the dial axis, so a SLOW id in `vl` reads as a
  // permanently absent member there.
  const SLOW_VL_IDS = ["price-accel", "complacency-vix", "complacency-high", "complacency-duration"];

  it("FAMILY_MEMBERS.vl carries NO slow leg - and the guard is non-vacuous", () => {
    // Vacuity guards first: these ids must really be SLOW, really be declared `volatility` members
    // on the DISPLAY table, and `vl` must really be non-empty. Without all three this assertion
    // would pass against a typo'd id list or an empty family.
    for (const id of SLOW_VL_IDS) expect(SLOW_INDICATOR_IDS.has(id)).toBe(true);
    const displayVol = GLOBAL_FAMILIES.find((f) => f.key === "volatility")!;
    for (const id of SLOW_VL_IDS) expect(displayVol.ids).toContain(id);
    expect(FAMILY_MEMBERS.vl.length).toBeGreaterThan(0);

    for (const id of SLOW_VL_IDS) expect(FAMILY_MEMBERS.vl).not.toContain(id);
  });
});
