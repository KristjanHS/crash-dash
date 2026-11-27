import { describe, it, expect } from "vitest";
import type { State } from "./domain-types.js";
import {
  GLOBAL_FAMILIES,
  computeFamilyPanel,
  coincidentContribution,
  TREND_COINCIDENT_DAMPING,
  type FamilyPanel,
} from "./families.js";
import { computeT1Dial, techConfirmerFromPanel, techConfirmerBreadth } from "./t1dial.js";
import { computeField, type DangerInput } from "./danger-engine.js";
import { legDangerShare, type ShareMemberState } from "./danger-share.js";

/**
 * STAGE-2 GATE (Option C).
 *
 * Reconstructs the 2026-07-21 DB_SMH-solo false-RED signature (DB_SMH stressed → RED
 * while GT/GB and every other trend member is calm) and PINS that §3 — restricting the
 * DIAL's `coincidentP` trend contribution to GT/GB only — cures it: the dial rung no
 * longer solo-trips upward on DB_SMH alone.
 *
 * A slow US-tech trend proxy (F4 — the semis-momentum leg) is DUAL-PATH to the band: it
 * reaches the rung via `coincidentP` (trend `.contribution`) AND via `techConfirmerP`
 * (`positionRaw = max(leadingP, coincidentP, techConfirmerP)`). This GATE proves the rung
 * does not trip on EITHER path from a lone trend-proxy solo — §3 kills the coincidentP path
 * (trend depth restricted to GT/GB), and the {F4,F5} ≥2-of-2 floor kills the
 * techConfirmerP path (the floor's firing side is pinned in t1dial.test.ts's techConfirmerBreadth
 * block, so the `techConfirmerP` 0 below is not a vacuously-dead lever).
 *
 * NOTE (fast-breaks EARLY-WARN redesign, 2026-07-21): the ORIGINAL false-RED culprit `DB_SMH`
 * has LEFT the trend family (D-D) and reverted OUT of the confirmer slot (D-C) — it now feeds
 * its own capped EARLY-WARN sub-signal (`earlyWarnFires`/`ewFloor`, tested in alert-band.floors.test.ts),
 * so it is no path to the band at all. These fixtures therefore exercise the SURVIVING slow
 * proxy F4 to keep §3 + the confirmer floor under a real, non-vacuous member.
 *
 * RED-DEMO: revert `coincidentContribution` (families.ts) to the full-family
 * `f.contribution` and the coincidentP + targetRung assertions below go red (the solo-RED
 * lift reappears). Confirmed 2026-07-21.
 */

const S = (id: string, state: State) => ({ id, state });

/** Panel over GLOBAL_FAMILIES from a member-state list (the dial's real reduction path). */
const panelOf = (readings: { id: string; state: State }[]): FamilyPanel[] =>
  computeFamilyPanel(readings, GLOBAL_FAMILIES).families;

/** DangerInput for computeField — a single panel; the engine flattens `.members`. */
const gf = (members: { id: string; state: State }[]): DangerInput => ({
  globalFamilies: [
    { key: "credit", label: "", state: null, live: true, firing: false, contribution: null, absent: 0, members: members.map((m) => ({ ...m, label: m.id })) },
  ],
});

const semisDanger = (f: ReturnType<typeof computeField>) =>
  f.legRows.find((r) => r.sleeve === "Semis")!.danger;

describe("STAGE-2 GATE: §3 cures the DB_SMH-solo false-RED (Option C)", () => {
  // The 2026-07-21 signature: DB_SMH RED (the FAST 63-day drawdown-break), GT/GB and the
  // other trend members CALM, a background ARM (credit AMBER) already firing so the
  // within-band position lever (coincidentP) is what a stray trend-RED would push.
  const soloReadings: { id: string; state: State }[] = [
    S("F1", "AMBER"), // credit → ARMED (a firing leader)
    S("R1", "GREEN"), // rates live, calm
    S("R5", "GREEN"), // volatility live, calm
    S("CG", "GREEN"), // cross-asset live, calm
    S("GT", "GREEN"), // global trend calm  ← §3's kept members
    S("GB", "GREEN"), // global breadth calm ←
    S("F4", "RED"), // the slow US-tech trend proxy, solo stress (∉ GT/GB, a confirmer slot)
    S("F5", "GREEN"), // US breadth calm
    S("G1", "GREEN"), // geopolitics live, calm
  ];

  it("THE CURE: the dial rung does NOT solo-trip to WARNING (rung ≥ 5) on a lone trend proxy", () => {
    const panel = panelOf(soloReadings);
    // Premise: the F4 solo DOES light the trend family, so coincidentP === 0 below is the cure.
    expect(panel.find((f) => f.key === "trend")!.firing).toBe(true);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel)); // 0 (path 2 blocked)
    const dial = computeT1Dial(panel, techP);
    // Both band-depth levers are neutralised, so positionP stays at the armed floor:
    expect(dial.coincidentP).toBe(0);
    expect(dial.techConfirmerP).toBe(0);
    // targetRung stays at the ARMED-no-position rung 4 (WATCH), BELOW WARNING (rung ≥ 5).
    // RED-DEMO: full-family coincidentContribution → coincidentP = 1/3 → rung 4.667 → targetRung 5.
    expect(dial.targetRung).toBeLessThan(5);
    expect(dial.targetRung).toBe(4);
  });
});

/**
 * R2-1 — GT/GB's FIELD-LEVEL share is DAMPED.
 * GT/GB drive both the dial's uniform band-depth lever and per-leg gated trend danger, so the
 * field-level half is scaled by `TREND_COINCIDENT_DAMPING`; the per-leg half is untouched (pinned
 * by the `legDangerShare` / `computeField` block below, which reads no damping).
 *
 * RED-DEMO: drop the ` * TREND_COINCIDENT_DAMPING` factor in `coincidentContribution`
 * (families.ts) and the "strictly below the undamped depth" assertion goes red — trend and
 * cross-asset then read the SAME depth at the same worst-of state.
 */
describe("R2-1: trend's coincidentP share is damped, and ONLY trend's", () => {
  // Two coincident families at the SAME worst-of state (RED) — the discriminating fixture:
  // pre-damping they contribute identically, so any gap between them IS the damping.
  const redReadings: { id: string; state: State }[] = [
    S("F1", "AMBER"), // credit → a firing leader (background ARM)
    S("GT", "RED"), // ← COINCIDENT_TREND_MEMBERS, the damped path
    S("GB", "RED"), // ←
    S("CG", "RED"), // cross-asset RED — an UNDAMPED coincident family at the same state
  ];

  it("damps the GT/GB depth below an undamped coincident family at the same state", () => {
    const panel = panelOf(redReadings);
    const trend = panel.find((f) => f.key === "trend")!;
    const xa = panel.find((f) => f.key === "cross-asset")!;
    // Non-vacuity: the two families' UNDAMPED depths agree, so the comparison below can only
    // separate them via the damping factor (they are the same worst-of state).
    expect(trend.state).toBe("RED");
    expect(xa.contribution).toBe(trend.contribution);
    // Scope: a non-trend coincident family passes through at FULL depth.
    expect(coincidentContribution(xa)).toBe(xa.contribution);
    // The bite: trend's field-level share is strictly smaller. Removing the multiplier makes
    // these two EQUAL.
    expect(coincidentContribution(trend)!).toBeLessThan(coincidentContribution(xa)!);
    // …and it is a damping, not a mute — the GT/GB regime still reaches the band lever.
    expect(coincidentContribution(trend)!).toBeGreaterThan(0);
    // Shape (tracks the constant, pins no literal): exactly the family depth scaled once.
    expect(coincidentContribution(trend)).toBe(trend.contribution! * TREND_COINCIDENT_DAMPING);
    expect(TREND_COINCIDENT_DAMPING).toBeLessThan(1);
  });
});

describe("STAGE-2 GATE: the share trend term still DEEPENS a slow trend leg (the per-leg ask survives)", () => {
  const band = { lo: 1, hi: 9 };
  const SEV = { RED: "lit", AMBER: "elev", GREEN: "calm" } as const;
  const st = (spec: Record<string, keyof typeof SEV>): ShareMemberState =>
    Object.fromEntries(Object.entries(spec).map(([id, v]) => [id, { sev: SEV[v] }]));
  // Semis EW share = .5·1.0 / (1.0 + .6 + .8·3) = .125 (rt only); uT share: GT RED beside GB GREEN = .5.
  const EW = { R4: "AMBER", R1: "GREEN", R3: "GREEN", R6: "GREEN", R7: "GREEN" } as const;
  const UT_HALF = { GT: "RED", GB: "GREEN" } as const;
  // Ramp knee = cuts.amber, so the knee is placed against the fixed EW share.
  const semis = (spec: Record<string, keyof typeof SEV>, knee: number) =>
    legDangerShare("Semis", st(spec), 0, { amber: knee, red: 0.9 });

  it("the trend term is 0 with no pillar observed and full uT share at or above the knee", () => {
    expect(semis(UT_HALF, 0.125).trend).toBe(0); // no EW/SN family observed ⇒ gate closed
    expect(semis({ ...EW, ...UT_HALF }, 0.125).earlyWarn!.value).toBeCloseTo(0.125, 12); // premise
    expect(semis({ ...EW, ...UT_HALF }, 0.125).trend).toBeCloseTo(0.5, 12); // EW at the knee ⇒ full
    expect(semis({ ...EW, ...UT_HALF }, 0.125 / 1.5).trend).toBeCloseTo(0.5, 12); // EW 1.5× knee ⇒ capped at full
  });

  it("the trend term deepens danger only when it exceeds the pillar", () => {
    expect(semis({ ...EW, ...UT_HALF }, 0.125).danger).toBeCloseTo(0.5, 12); // uT .5 > EW .125 ⇒ deepens
    // uT share .5·1.0 / (1.0 + 1.0 + 1.0 + .8 + .6 + .6) = .1 < EW .125 ⇒ inert
    const low = semis({ ...EW, GT: "AMBER", GB: "GREEN", F6: "GREEN", F4: "GREEN", F5: "GREEN", F8: "GREEN" }, 0.125);
    expect(low.trend).toBeCloseTo(0.1, 12);
    expect(low.danger).toBeCloseTo(0.125, 12);
  });

  it("gate CLOSED (notify-safe): F4 RED alone can NOT manufacture Semis field danger", () => {
    // No EW/SN stress → trendGateFactor 0 → gatedTrend 0 → a RED trend alone adds nothing.
    const calm = computeField(gf([S("F4", "RED")]), band);
    expect(semisDanger(calm)).toBe(0);
  });
});
