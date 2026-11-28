import { describe, expect, test } from "vitest";
import {
  legRAG,
  memberScaledBand,
  scaledSevBand,
  computeCells,
  type Sev,
  type MemberStateMap,
} from "./danger-engine.js";
import type { SignalCell } from "./danger-cell.js";
import { LEG_FIELD } from "./danger-ladder.js";
import { SEV_CUTS } from "./danger-concentration.js";

/** A lit (RED-severity) cell whose weighted severity is `wsev` — the only field legRAG reads.
 *  `observed` (OQ-5 Stage 5.2) is shape only: `legRAG` never consults the census. */
const litCell = (wsev: number): SignalCell => ({
  family: "cr",
  cellState: "lit",
  M: 1,
  N: 1,
  wsev,
  // B2 hold-window provenance: shape only — `legRAG` reads `wsev`/`cellState` alone.
  held: null,
  observed: { fresh: 1, lag: 0, absent: 0, deepLag: 0 },
});

/** OQ-5 Stage 5.2 — lift a `{id: Severity}` shorthand into a `MemberStateMap` of observations.
 *  Every listed member is stamped `fresh`; per S-2 a `stale` member is HELD at its last state and
 *  folds identically, so the choice is severity-neutral for these leg-RAG cases. Members NOT
 *  listed stay ABSENT (no key) and are excluded from the `wsev` max — which is exactly the regime
 *  these fixtures want: they probe ONE member's weight against the leg's red/amber cuts. */
const obs = (m: Record<string, "lit" | "elev" | "calm">): MemberStateMap =>
  Object.fromEntries(Object.entries(m).map(([id, sev]) => [id, { sev, obs: "fresh" as const }]));

describe("legRAG - weight-scaled max (non-compensatory)", () => {
  test("(a) near-zero-weight RED does NOT flip a leg", () => {
    expect(legRAG([litCell(0.1)])).toBe("GREEN");
  });

  test("(b) full-weight RED does flip a leg", () => {
    expect(legRAG([litCell(1.0)])).toBe("RED");
  });

  test("all-na / empty → GREEN", () => {
    expect(legRAG([])).toBe("GREEN");
    expect(
      legRAG([
        { family: "cr", cellState: "na", M: 0, N: 0, wsev: null, observed: { fresh: 0, lag: 0, absent: 0, deepLag: 0 }, held: null },
      ]),
    ).toBe("GREEN");
  });
});

describe("memberScaledBand - real MEMBER_WEIGHT wiring (Stage-2 tech confirmer)", () => {
  // ⚠ THE 'NO-OP' READING IS DEAD FOR F5. The confirmer's two live inputs no longer band alike:
  // F4 (0.8 on Semis) still clears `SEV_CUTS.red`, so band === raw state for it; F5's 2026-08-30
  // demotion put its row BELOW that cut, so an F5 RED now bands to AMBER. Regression pin — if a
  // MEMBER_WEIGHT edit drops F4's Semis weight below the red cut too, this flips and forces a
  // look at the notify-path change (which is exactly what the F5 edit was, and it moved 3 pins).
  // NVDA is no longer a confirmer input (demoted to detail-only 2026-07-22); it stays here as a plain
  // MEMBER_WEIGHT case — the leg is still resolvable (registry def kept), so the map still maps it.
  test("high-weight tech member is NOT discounted (production path)", () => {
    expect(memberScaledBand("F4", "RED", ["Semis", "S&P IT"])).toBe("RED");
    expect(memberScaledBand("NVDA", "GREEN", ["Semis", "S&P IT"])).toBe("GREEN");
  });

  // The discount path actually fires with a real sub-1.0 weight: R1 carries 0.4 on EU-Fin, so a
  // RED there scales to 0.4 → AMBER (degraded one band). Proves the wiring isn't vacuously inert.
  test("a sub-1.0 real weight degrades a RED one band", () => {
    expect(memberScaledBand("R1", "RED", ["EU-Fin"])).toBe("AMBER");
  });
});

// Real MEMBER_WEIGHT × computeCells wiring: the named member is the only one carrying severity, so
// its weight on the leg alone decides the band. Members omitted from the map are ABSENT (OQ-5
// Stage 5.2) — excluded from the `wsev` max, not imputed calm.
// `MEMBER_WEIGHT.F8.Semis` is 0.6: a full-RED F8 alone
// bands Semis AMBER, never RED — MU is one of five SEC0 names.
describe("leg-RAG wiring - trend (F6/F8 → Semis) and credit-appetite (F13 → Value, EU-Fin) members", () => {
  test.each([
    ["F6 RED alone → Semis RED (full-weight 1.0 ⇒ wsev 1.0 ≥ the red cut)", "Semis", { F6: "lit" }, "RED"],
    ["F6 AMBER → Semis AMBER (wsev 1.0·0.5 = 0.5, between the cuts)", "Semis", { F6: "elev" }, "AMBER"],
    ["F6 GREEN → no effect (Semis GREEN)", "Semis", { F6: "calm" }, "GREEN"],
    ["F8 RED alone → Semis AMBER, not RED (0.6 weight ⇒ wsev 0.6 below the red cut)", "Semis", { F8: "lit" }, "AMBER"],
    ["F13 RED alone → Value RED (full-weight 1.0 ⇒ wsev 1.0 ≥ the red cut)", "Value", { F13: "lit" }, "RED"],
    ["F13 RED → EU-Fin AMBER, not RED (soft 0.4 weight ⇒ wsev 0.4 below the red cut)", "EU-Fin", { F13: "lit" }, "AMBER"],
  ] as const)("%s", (_, sleeve, members, expected) => {
    const leg = LEG_FIELD.find((l) => l.sleeve === sleeve)!;
    expect(legRAG(computeCells(leg, obs(members)))).toBe(expected);
  });
});

describe("scaledSevBand - cut boundaries (derived from SEV_CUTS, both edges inclusive ≥)", () => {
  test("just-below is the lower band, exactly-at is the higher", () => {
    // Premise guard: the "just below" derivations read as boundaries only while both cuts are
    // strictly positive and ordered — reds if either is retired to 0 or the pair collapses.
    expect(SEV_CUTS.amber).toBeGreaterThan(0);
    expect(SEV_CUTS.red).toBeGreaterThan(SEV_CUTS.amber);
    expect(scaledSevBand((SEV_CUTS.amber - 0.01) as Sev)).toBe("GREEN");
    expect(scaledSevBand(SEV_CUTS.amber)).toBe("AMBER");
    expect(scaledSevBand((SEV_CUTS.red - 0.01) as Sev)).toBe("AMBER");
    expect(scaledSevBand(SEV_CUTS.red)).toBe("RED");
  });
});
