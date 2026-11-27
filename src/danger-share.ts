/** Share-lit leg danger: family = Σ w·sev / Σ w over observed relevant members, pillar = `FAMILY_LEG_WEIGHT`
 *  mean × systemic boost, leg = max(EW, SN, trend, gp). Pure. Falsifier: `src/danger-share.test.ts`. */
import { DANGER_CUTS, concThresholdOf } from "./danger-concentration.js";
import { reriskDeadbandOf } from "./danger-deadband.js";
import { SEV_NUM } from "./danger-member-state.js";
import {
  FAMILY_LEG_WEIGHT,
  FAMILY_MEMBERS,
  LEG_SENSITIVITY,
  MEMBER_WEIGHT,
  SIGNALS,
  STUBBED_SIGNALS,
  SUPER_GROUP_OF,
  type LegKey,
  type SignalKey,
} from "./danger-ladder.js";

/** Lit / gp-cap / trend-knee cuts; every share-path read takes them as a parameter, default `DANGER_CUTS`. */
export type ShareCuts = Readonly<{ amber: number; red: number }>;
/** gp alone caps at this fraction of `cuts.amber` — strictly below it, so oil alone never sets a band or #R2 (USER 2026-10-25). */
export const GP_CAP_FRACTION = 0.95;
/** Breadth boost κ on `computeField`'s default arm (USER 2026-10-25) — 0 ⇒ `familiesLit` is display only. */
export const SYSTEMIC_KAPPA = 0;
/** member id → observed severity; a missing key is ABSENT (out of both sums), never calm. */
export type ShareMemberState = Readonly<Record<string, Readonly<{ sev: keyof typeof SEV_NUM }> | undefined>>;
export type SharePillar = "EARLY-WARN" | "STRESS-NOW";
interface LitCount {
  lit: number;
  of: number;
}
export interface PillarShare extends LitCount {
  value: number;
}
export interface FamiliesLit {
  earlyWarn: LitCount;
  stressNow: LitCount;
}
export interface LegDangerShare {
  danger: number;
  earlyWarn: PillarShare | null;
  stressNow: PillarShare | null;
  /** uT share × `trendGateFactor`(EW, SN, cuts.amber); `null` when no uT member is observed. */
  trend: number | null;
  /** min(gp share, `GP_CAP_FRACTION` × cuts.amber); `null` when no gp member is observed. */
  gp: number | null;
  familiesLit: FamiliesLit;
}

/** R4 structural-zero predicate: `true` ⇒ every member weighs 0 on that leg (`familyShare` → `null`).
 *  ∅ today — always `false`. */
function isStructuralZero(family: SignalKey, sleeve: string): boolean {
  void family;
  void sleeve;
  return false;
}

/** Ramp knee of `trendGateFactor`; DERIVES from `DANGER_CUTS.amber` — never a literal. */
export const TREND_GATE_FLOOR = DANGER_CUTS.amber;

/** Trend gate ∈ [0,1] = `min(1, max(ew, sn) / floor)` over the share EW/SN pillars; `legDangerShare`
 *  passes its `cuts.amber` as the knee. */
export function trendGateFactor(ew: number, sn: number, floor: number = TREND_GATE_FLOOR): number {
  return Math.min(1, Math.max(0, ew, sn) / floor);
}

const PILLAR_FAMILIES: Record<SharePillar, readonly SignalKey[]> = {
  "EARLY-WARN": SIGNALS.filter((f) => SUPER_GROUP_OF[f] === "EARLY-WARN"),
  "STRESS-NOW": SIGNALS.filter((f) => SUPER_GROUP_OF[f] === "STRESS-NOW"),
};

/** Σ w·sev and Σ w over the family's observed members, w = `MEMBER_WEIGHT` relevance; `null` = unobserved
 *  or not relevant on the leg (w = 0 on a structural-zero cell). */
function weightedSeverity(family: SignalKey, sleeve: string, state: ShareMemberState): { num: number; den: number } | null {
  if (STUBBED_SIGNALS.has(family) || isStructuralZero(family, sleeve)) return null;
  let num = 0;
  let den = 0;
  for (const m of FAMILY_MEMBERS[family]) {
    const w = MEMBER_WEIGHT[m]?.[sleeve as LegKey];
    const obs = state[m];
    if (w === undefined || w <= 0 || obs === undefined) continue;
    num += w * SEV_NUM[obs.sev];
    den += w;
  }
  return den === 0 ? null : { num, den };
}

/** Σ w·sev / Σ w over the family's observed members — the weights are RELATIVE only. */
export function familyShare(family: SignalKey, sleeve: string, state: ShareMemberState): number | null {
  const s = weightedSeverity(family, sleeve, state);
  return s === null ? null : s.num / s.den;
}

/** The trend (`uT`) share: observed Σ w·sev / Σ w × min(1, full Σ w) — full = every `uT` member reaching the leg,
 *  observed or not, so a leg whose trend weights sum below 1 tops out at that sum and an absent member stays dropped. */
export function trendShare(sleeve: string, state: ShareMemberState): number | null {
  const s = weightedSeverity("uT", sleeve, state);
  if (s === null) return null;
  let full = 0;
  for (const m of FAMILY_MEMBERS.uT) {
    const w = MEMBER_WEIGHT[m]?.[sleeve as LegKey];
    if (w !== undefined && w > 0) full += w;
  }
  return (s.num / s.den) * Math.min(1, full);
}

/** `FAMILY_LEG_WEIGHT` mean of the pillar's observed families × (1 + κ·(lit − 1)/(of − 1)), capped at 1;
 *  lit ⇔ share ≥ cuts.amber, boost 0 when of ≤ 1 or lit = 0. `null` when no family is observed. */
export function pillarShare(
  pillar: SharePillar,
  sleeve: string,
  state: ShareMemberState,
  kappa: number,
  cuts: ShareCuts = DANGER_CUTS,
): PillarShare | null {
  let num = 0;
  let den = 0;
  let lit = 0;
  let of = 0;
  for (const family of PILLAR_FAMILIES[pillar]) {
    const share = familyShare(family, sleeve, state);
    if (share === null) continue;
    const flw = family === "gp" ? undefined : FAMILY_LEG_WEIGHT[family][sleeve as LegKey];
    if (flw === undefined)
      throw new Error(`pillarShare: observed ${family}×${sleeve} has no FAMILY_LEG_WEIGHT entry - add one.`);
    num += flw * share;
    den += flw;
    of++;
    if (share >= cuts.amber) lit++;
  }
  if (of === 0) return null;
  const boost = of > 1 ? (kappa * Math.max(0, lit - 1)) / (of - 1) : 0;
  return { value: Math.min(1, (den > 0 ? num / den : 0) * (1 + boost)), lit, of };
}

const litCount = (p: PillarShare | null): LitCount => (p === null ? { lit: 0, of: 0 } : { lit: p.lit, of: p.of });

/** Per leg, per pillar: families with share ≥ cuts.amber over observed relevant families. */
export function familiesLit(sleeve: string, state: ShareMemberState, cuts: ShareCuts = DANGER_CUTS): FamiliesLit {
  return {
    earlyWarn: litCount(pillarShare("EARLY-WARN", sleeve, state, 0, cuts)),
    stressNow: litCount(pillarShare("STRESS-NOW", sleeve, state, 0, cuts)),
  };
}

/** Leg danger = max(EW, SN, `trendShare` × `trendGateFactor`(EW, SN, cuts.amber), min(gp share, `GP_CAP_FRACTION` × cuts.amber));
 *  an unobserved term is 0. */
export function legDangerShare(
  sleeve: string,
  state: ShareMemberState,
  kappa: number,
  cuts: ShareCuts = DANGER_CUTS,
): LegDangerShare {
  const earlyWarn = pillarShare("EARLY-WARN", sleeve, state, kappa, cuts);
  const stressNow = pillarShare("STRESS-NOW", sleeve, state, kappa, cuts);
  const ew = earlyWarn === null ? 0 : earlyWarn.value;
  const sn = stressNow === null ? 0 : stressNow.value;
  const uT = trendShare(sleeve, state);
  const gpShare = familyShare("gp", sleeve, state);
  const trend = uT === null ? null : uT * trendGateFactor(ew, sn, cuts.amber);
  const gp = gpShare === null ? null : Math.min(gpShare, GP_CAP_FRACTION * cuts.amber);
  return {
    danger: Math.max(ew, sn, trend === null ? 0 : trend, gp === null ? 0 : gp),
    earlyWarn,
    stressNow,
    trend,
    gp,
    familiesLit: { earlyWarn: litCount(earlyWarn), stressNow: litCount(stressNow) },
  };
}

/** The share engine's knobs — `computeField` runs `SYSTEMIC_KAPPA`; `computeFieldProbe` may override; `cuts` omitted ⇒ `DANGER_CUTS`. */
export interface ShareProbeEngine {
  kind: "share";
  kappa: number;
  cuts?: ShareCuts;
}
export interface ShareArmLeg {
  danger: number;
  familiesLit: FamiliesLit;
  /** `LEG_SENSITIVITY[leg]` × `danger` — what #R2 and `pickHeld` read; the row keeps plain `danger`. */
  ownDanger: number;
  /** The pillar share values (`PillarShare.value`); `null` when the pillar has no observed family. */
  earlyWarn: number | null;
  stressNow: number | null;
  /** `legDangerShare`'s trend / gp terms; `danger` = max(earlyWarn, stressNow, trend, gp), null ⇒ 0. */
  trend: number | null;
  gp: number | null;
}
export interface ShareArm {
  /** #R2 elevated level and re-risk deadband at the arm's cuts. */
  concThreshold: number;
  reriskDeadband: number;
  leg(sleeve: string, state: ShareMemberState): ShareArmLeg;
}

export function shareArm({ kappa, cuts = DANGER_CUTS }: ShareProbeEngine): ShareArm {
  return {
    concThreshold: concThresholdOf(cuts),
    reriskDeadband: reriskDeadbandOf(cuts),
    leg(sleeve, state) {
      if (!Object.hasOwn(LEG_SENSITIVITY, sleeve)) throw new Error(`shareArm: ${sleeve} has no LEG_SENSITIVITY entry - add one.`);
      const sens = LEG_SENSITIVITY[sleeve as LegKey];
      const r = legDangerShare(sleeve, state, kappa, cuts);
      return {
        danger: r.danger,
        familiesLit: r.familiesLit,
        ownDanger: sens * r.danger,
        earlyWarn: r.earlyWarn?.value ?? null,
        stressNow: r.stressNow?.value ?? null,
        trend: r.trend,
        gp: r.gp,
      };
    },
  };
}
