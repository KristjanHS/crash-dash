/** Per-leg danger engine over `families.ts FamilyPanel`: pure, no IO/clock — same panel + band → same
 *  field. Consumers `run-core.ts` (notify) + `api/lab.ts` (read); `momentum` only when `memberHistory` passed.
 *  Regression pin: `danger-engine.basics.test.ts`. */
import type { FamilyPanel } from "./families.js";
import type { SeriesPoint } from "./store.js";
import type { State } from "./domain-types.js";
import {
  LEG_FIELD,
  FAMILY_MEMBERS,
  MEMBER_RELEVANCE,
  MEMBER_WEIGHT,
  SIGNALS,
  STUBBED_SIGNALS,
  SUPER_GROUP_OF,
  SUPER_GROUPS,
  CLUSTERS,
  DISP_WIDE_CLUSTERS,
  type LegField,
  type SignalKey,
  type SuperGroup,
  type LegKey,
} from "./danger-ladder.js";
import { isSensitiveState, type CellObserved, type CellState, type Severity, type SignalCell } from "./danger-cell.js";
import { CONFIRM_CLOSES } from "./domain-types.js";
import { confirmedSeries } from "./domain-fold.js";
import { computeLegGrowth, type Growth } from "./growth.js";
// `lagTier`: pure two-tier paint mapping over `Label`, one home — keeps `CellObserved.deepLag` and the
// FE class in lockstep. Value edge guarded by `src/import-cycle.test.ts`.
import { lagTier, type Label } from "./feed-lag.js";
// Member-observation builders in `danger-member-state.ts`. One-way edge (it imports this file
// TYPES-ONLY); no re-export shim — importers point straight at `./danger-member-state.js`.
import {
  SEV_NUM,
  buildMemberState,
  buildMemberStateAt,
  buildMemberStateHeld,
  buildMemberStateHeldAt,
  signalHoldWindowOf,
  noHoldDepth,
} from "./danger-member-state.js";
// cuts/#R2, CONFIRMING veto, deadband/held-pick knobs live in the three files below; re-exported here.
import { SEV_CUTS, DANGER_CUTS, CONC_WEIGHT, type Sev } from "./danger-concentration.js";
import {
  SYSTEMIC_KAPPA,
  shareArm,
  trendGateFactor,
  trendShare,
  type FamiliesLit,
  type ShareArmLeg,
} from "./danger-share.js";
import {
  LOOKBACK,
  SN_ROC_LOOKBACK,
  EW_ROC_LOOKBACK,
  DERISK_DEADBAND,
  pickHeld,
} from "./danger-deadband.js";
export {
  SEV_CUTS,
  DANGER_CUTS,
  CONC_THRESHOLD,
  CONC_WEIGHT,
} from "./danger-concentration.js";
export type { Sev } from "./danger-concentration.js";
export { CONFIRMING_TREND_MEMBERS, trendConfirming } from "./danger-exogenous.js";
export {
  LOOKBACK,
  SN_ROC_LOOKBACK,
  EW_ROC_LOOKBACK,
  DERISK_DEADBAND,
  RERISK_DEADBAND,
  RERISK_BASIS_EPOCH,
} from "./danger-deadband.js";

/** Power-mean exponent p=2 of `t1dial.ts`'s `legP` (D6) — single-sourced, never re-typed. */
export const DANGER_POWER = 2;

/** How a member's severity was OBSERVED: `fresh` (inside cadence) or `lag` (past cadence or never
 *  assessed — held at last state, still carries severity). Absence is a missing `MemberStateMap` key,
 *  never a value here. */
export type MemberObs = "fresh" | "lag";
/** One member's observed severity + how it was observed. */
interface MemberObservation {
  sev: Severity;
  obs: MemberObs;
  /** Feed-lag CLASSIFICATION (`Label`) behind a `lag` obs when the caller measured one; absent when
   *  none supplied. Painted from /lab's neutral diagnostics ramp, never a signal colour. */
  lag?: Label;
  /** TRUE iff this entry's severity was RAISED (or resurrected non-calm) by the signal-hold window —
   *  stamped ONLY in `buildMemberStateHeld`. Display/audit only; no danger-path arithmetic reads it. */
  held?: true;
  /** AGE IN CLOSES of this entry's held severity (`0` = requested close), from `heldFoldMap`. Set only
   *  where `held: true` is; absent = age unknown. Display/audit only — no fold/band/pick/notify reads it. */
  heldAge?: number;
}
/** member id → live OBSERVATION, from d.globalFamilies. A missing key means ABSENT, not calm:
 *  consumers EXCLUDE it from max/worst-of and from both share sums. */
export type MemberStateMap = Record<string, MemberObservation>;

/** Freshness stamp for `buildMemberState`: a minimal `{ id, lag }` projection of the `Reading` stamp so
 *  this module never imports the reading layer. `lag: undefined` (or id absent) ⇒ `obs: "lag"`, never fresh. */
export interface MemberFreshness {
  id: string;
  lag?: boolean;
  /** Set (with NO `lag` key) when the feed's publication calendar could not be built, so lateness is
   *  UNCOMPUTABLE; `lag === undefined` holds it, never reads it fresh. */
  unmeasured?: boolean;
  /** OPTIONAL feed-lag `Label` for a lagging id, measured by the caller (`lagRowFor`, src/feed-lag.ts);
   *  threaded to `MemberObservation.lag`, counted into `CellObserved.deepLag`. Omitted ⇒ plain `lag`. */
  label?: Label;
  /** Set when the newest stored row is intraday (`isProvisional`, src/intraday.ts); display-only. */
  provisional?: true;
}

/** One super-group pillar's reading — a TAGGED UNION (`.value` without narrowing on `kind` is a compile
 *  error): `scored` | `uncomparable`/`not-live` (no observed family). */
export type PillarScore =
  | { kind: "scored"; value: number }
  | { kind: "uncomparable"; reason: "not-live" };

/** A leg's four share-arm terms (`shareArm`); `LegRow.danger` = their max, null / `uncomparable` ⇒ 0.
 *  A pillar reads `uncomparable`/`not-live` iff no family of its super-group is observed on the leg. */
export interface SubDangers {
  /** EARLY-WARN pillar share (credit/rates/valuation). */
  earlyWarn: PillarScore;
  /** STRESS-NOW pillar share (volatility/cross-asset). */
  stressNow: PillarScore;
  /** uT share × `trendGateFactor`; `null` when no uT member is observed. */
  trend: number | null;
  /** min(gp share, `GP_CAP_FRACTION` × cuts.amber); `null` when no gp member is observed. */
  gp: number | null;
}

/** The ONE narrowing seam for a `PillarScore`: its number, or `null` when the pillar carries none — so
 *  a third arm is one edit, not a repo-wide sweep. */
export function pillarValue(p: PillarScore): number | null {
  return p.kind === "scored" ? p.value : null;
}

/** The named 2×2 regime from a leg's EW×SN pillar pair at the AMBER cut: CALM (both low) / DETER (EW hi)
 *  / STRESS (both hi) / RECOV (SN hi). A non-live pillar counts as LOW. */
export type Regime = "calm" | "deter" | "stress" | "recov";

/** A per-close pillar pair (each super-group's live sub-danger) — the input the regime fold quantizes
 *  then confirms. */
export interface PillarPair {
  ew: { value: number; live: boolean };
  sn: { value: number; live: boolean };
}

/** A leg's danger row: the static properties + derived cells/danger, and momentum
 *  only when a history window was supplied to `computeField`. */
export interface LegRow extends LegField {
  cells: SignalCell[];
  /** W0 coverage per super-group (`computeCoverage`): `capable` = `CAPABLE_FAMILIES` size, `live` =
   *  cells with a sensitive state. Additive DISPLAY field, REQUIRED; nothing on the danger path reads it. */
  coverage: Record<SuperGroup, { live: number; capable: number }>;
  /** Share-lit leg danger ∈ [0,1] = max of the `subDangers` terms. */
  danger: number;
  /** the four share-arm terms behind `danger` (first-class drill-down). */
  subDangers: SubDangers;
  /** the named 2×2 regime from EW×SN, folded through the 2-close confirmation idiom so a 1-close
   *  quantize-border blip can't flip it. */
  regime: Regime;
  /** `/lab` RRG-quadrant y-axis: ROC over LOOKBACK closes in SEVERITY space (`√danger`), normalised by
   *  `MOMENTUM_DIVISOR` (= √DANGER_CUTS.amber), clamped [−1,1]. Present ONLY when memberHistory passed. */
  momentum?: number;
  /** RAW STRESS-NOW delta over SN_ROC_LOOKBACK (5) closes in raw SN units, clamped [−1,1], NO divisor.
   *  Present ONLY when `cissHistory` passed AND SN live now+at t−5 AND the t−5 base is OBSERVED (cold-start suppresses). */
  snRoc?: number;
  /** RAW EARLY-WARN delta over EW_ROC_LOOKBACK (20) closes in raw EW units, clamped [−1,1], NO divisor.
   *  Same presence contract as `snRoc` with EARLY-WARN substituted (cold-start suppresses). */
  ewRoc?: number;
  /** #R2: true when this leg is in a CLUSTERS pair AND a sibling's own-danger ≥
   *  CONC_THRESHOLD — a correlated-twin false-safe read. own `danger` stays unaffected. */
  concentrated: boolean;
  /** G1 growth pillar (`computeLegGrowth`). DISPLAY-ONLY: never enters the danger scalar or `held`
   *  (`pickHeld`'s docblock). `rsMomLive` (⊂ `live`) = the cross-sectional terms contributed. */
  growth?: { value: Growth; live: boolean; rsMomLive: boolean };
  /** DISPLAY-ONLY trend read: `value` = ungated `uT` share (`trendShare`), `null` when no uT member is observed;
   *  `counting` = `trendGateFactor`(share EW, share SN, cuts.amber) > 0. */
  trend: { value: number | null; counting: boolean };
  /** DISPLAY-ONLY per-pillar lit/of family counts from the share arm (`legDangerShare`). */
  familiesLit: FamiliesLit;
}

/** The live dial band the held pick filters within (from `computeT1Dial(...).band`). */
export interface DangerBand {
  lo: number;
  hi: number;
  label?: string;
}

/** `computeField` result: every leg's danger row + the band + the calmest-in-band pick. */
export interface FieldResult {
  legRows: LegRow[];
  band: DangerBand;
  /** the calmest (lowest-danger) leg whose risk-rank is in-band; `null` when the band
   *  is empty (caller falls back to `LADDER[targetRung−1]`). Never throws. */
  held: LegRow | null;
  /** the EXOGENOUS read-out — DISPLAY only (already in `legRows[].danger`). `floor` = min over the 9 legs
   *  of the share arm's capped `gp` term (unobserved ⇒ 0); `active` = `floor > 0`. */
  exogenous: { active: boolean; floor: number };
  /** THE MEMBER MAP THE CELLS WERE BUILT FROM (`stateNow` — the HELD map, or unheld on the degrade).
   *  NOT `globalFamilies`. A missing key means ABSENT, never calm. */
  memberState: MemberStateMap;
}

/** The slice of the /lab response the engine reads. ⚠ `globalFamilies` is fed the DIAL panel
 *  (DIAL_FAMILIES) on both server call sites, NOT the wider served panel — no display-only SLOW legs. */
export interface DangerInput {
  globalFamilies?: FamilyPanel[];
  /** OPTIONAL freshness stamp for the panel's members — engine input only, projected by the caller
   *  from stamped `Reading`s. Omitted ⇒ every member reads `obs: "lag"` (severity-neutral). */
  freshness?: readonly MemberFreshness[];
}

/** One member's history window, oldest→newest. `state`-only: the persisted copy is a G/A/R string per id
 *  (`encodeCissHistory`, store-rows.ts). The `/api/lab` `?hist` window passes full points and never reaches the wire. */
export interface MemberHistoryEntry {
  id: string;
  history: Pick<SeriesPoint, "state">[];
}

function isRelevant(memberId: string, sleeve: string): boolean {
  const set = MEMBER_RELEVANCE[memberId];
  return !!set && set.has(sleeve);
}

/** Every member `computeCells` folds into a measured cell on ≥1 leg (EW/SN pillars, the `uT` trend and
 *  `gp` exogenous terms) — served as `dangerRoster.pillarIds`; a shown member outside it moves no danger. */
export const PILLAR_MEMBER_IDS: readonly string[] = [
  ...new Set(
    SIGNALS.filter((f) => !STUBBED_SIGNALS.has(f)).flatMap((f) =>
      FAMILY_MEMBERS[f].filter((m) => LEG_FIELD.some((l) => isRelevant(m, l.sleeve))),
    ),
  ),
];

/** Weight-scaled-max leg RAG: severity ∈ [0,1] banded at `SEV_CUTS`. This is the leg GATE;
 *  `channel-score.ts` channelScore is the display-only rollup and must never be imported by a gate path. */
export function scaledSevBand(scaled: Sev): State {
  return scaled >= SEV_CUTS.red ? "RED" : scaled >= SEV_CUTS.amber ? "AMBER" : "GREEN";
}
/** ⚠ `legRAG` has ZERO production callers (probe + tests only). A coverage claim at the RAG layer needs a
 *  separate band-pinned held-sleeve assertion to reach the production path. */
export function legRAG(cells: SignalCell[]): State {
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `wsev` null only for na/insensitive/fully-unobserved; the
  // `Math.max(0,…)` seed floors at 0, so the coalesce adds nothing.
  return scaledSevBand(Math.max(0, ...cells.map((c) => c.wsev ?? 0)) as Sev);
}

/** `/lab` RRG-quadrant momentum normaliser — module-private, DISPLAY-ONLY (`run-core.ts` omits momentum).
 *  ROC taken in severity space (√danger), normalised by one leg-RAG band width. Do NOT convert x to
 *  severity — that would strand `DANGER_CUTS`. */
const MOMENTUM_DIVISOR = Math.sqrt(DANGER_CUTS.amber);

/** State-keyed severity ∈ [0,1] (numeric scale identical to `SEV_NUM`); unscaled linear scale. */
export const STATE_SEV: Record<State, number> = { RED: 1, AMBER: 0.5, GREEN: 0 };
/** Weight-scaled RAG band for ONE member across `legs`: the legRAG cut over `max` of
 *  `memberWeight·severity`. Per-member so the tech confirmer stays tech-ONLY. */
export function memberScaledBand(memberId: string, state: State, legs: readonly string[]): State {
  const sev = STATE_SEV[state];
  return scaledSevBand(Math.max(0, ...legs.map((leg) => memberWeight(memberId, leg) * sev)) as Sev);
}

/** Per-member × leg danger weight ∈ [0,1]. `MEMBER_WEIGHT` is the sole reach table (`MEMBER_RELEVANCE`
 *  derived from it); 0 = irrelevant. */
export function memberWeight(memberId: string, sleeve: string): number {
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `MEMBER_WEIGHT` is the sole reach table, so a missing entry
  // IS zero reach, not an unobserved weight.
  return MEMBER_WEIGHT[memberId]?.[sleeve as LegKey] ?? 0;
}

/** The observations present for a member list — the ONE place absence is filtered out, so every consumer
 *  excludes an absent member the same way. Order-preserving. */
function observedMembers(
  members: readonly string[],
  memberState: MemberStateMap,
): MemberObservation[] {
  const out: MemberObservation[] = [];
  for (const m of members) {
    const o = memberState[m];
    if (o !== undefined) out.push(o);
  }
  return out;
}

/** The observation census for a member list — `fresh`/`lag` are the members that ENTER a
 *  severity max, `absent` the ones excluded from it. See `SignalCell.observed`. */
function censusOf(members: readonly string[], memberState: MemberStateMap): CellObserved {
  let fresh = 0;
  let lag = 0;
  let absent = 0;
  let deepLag = 0;
  const absentIds: string[] = [];
  for (const m of members) {
    const o = memberState[m];
    if (o === undefined) {
      absent++;
      absentIds.push(m);
    } else if (o.obs === "fresh") fresh++;
    else {
      lag++;
      // `deepLag` is a SUBSET of `lag` via `lagTier`; the three-way total is untouched. No `??` default —
      // an unmeasured lag stays plain `lag`, never an "UNKNOWN" stand-in.
      if (o.lag !== undefined && lagTier(o.lag) === "deep") deepLag++;
    }
  }
  return { fresh, lag, absent, deepLag, absentIds };
}

/** Max of `memberWeight(m) × sev(m)` over the OBSERVED members (absent excluded), with its argmax member
 *  (first-wins on strict `>`); `null` when fully unobserved. */
function observedWeightedMax(
  members: readonly string[],
  sleeve: string,
  memberState: MemberStateMap,
): { value: number; member: string } | null {
  let best: { value: number; member: string } | null = null;
  for (const m of members) {
    const o = memberState[m];
    if (o === undefined) continue; // ABSENT — excluded from the max
    const v = memberWeight(m, sleeve) * SEV_NUM[o.sev];
    if (best === null || v > best.value) best = { value: v, member: m };
  }
  return best;
}

const EMPTY_CENSUS: CellObserved = { fresh: 0, lag: 0, absent: 0, deepLag: 0, absentIds: [] };

/** Build a leg's per-signal cells: each family's cell = worst observed state among its RELEVANT members,
 *  plus `wsev` (`observedWeightedMax`); `na` (stubbed/memberless) and `insensitive` cells carry `null`. */
export function computeCells(leg: LegField, memberState: MemberStateMap): SignalCell[] {
  return SIGNALS.map((family): SignalCell => {
    const relevant = FAMILY_MEMBERS[family].filter((m) => isRelevant(m, leg.sleeve));
    if (STUBBED_SIGNALS.has(family) || relevant.length === 0) {
      const na = STUBBED_SIGNALS.has(family) || FAMILY_MEMBERS[family].length === 0;
      return { family, cellState: na ? "na" : "insensitive", M: 0, N: 0, wsev: null, observed: EMPTY_CENSUS, held: null };
    }
    // cellState/M run over OBSERVED members only (absent ≠ calm); `N` stays the STRUCTURAL relevant
    // count (the M-of-N denominator).
    const states = observedMembers(relevant, memberState).map((o) => o.sev);
    const N = relevant.length;
    const M = states.filter((s) => s === "elev" || s === "lit").length;
    let cellState: CellState;
    if (states.some((s) => s === "lit")) cellState = "lit";
    else if (states.some((s) => s === "elev")) cellState = "elev";
    // `calm` also covers the FULLY-UNOBSERVED cell (every relevant member absent); `observed.absent === N`
    // distinguishes it from a genuinely calm cell. Only `wsev` goes honest (below), not the state machine.
    else cellState = "calm";
    // `null` must survive — `null*x` is 0 in JS, i.e. false "calm".
    const raw = observedWeightedMax(relevant, leg.sleeve, memberState);
    const wsev = raw === null ? null : raw.value;
    // `held` non-null iff the argmax member's entry was RAISED by the hold window (`buildMemberStateHeld`).
    const argmaxEntry = raw === null ? undefined : memberState[raw.member];
    const held =
      raw !== null && argmaxEntry?.held === true
        ? { member: raw.member, closes: signalHoldWindowOf(raw.member), ageCloses: argmaxEntry.heldAge }
        : null;
    return { family, cellState, M, N, wsev, observed: censusOf(relevant, memberState), held };
  });
}

/** Capable families per super-group (W0 coverage denominator): non-stubbed `SIGNALS` with ≥1 member,
 *  DERIVED — read it, never restate the set (a restated copy rotted when ECY seated `vb`). */
export const CAPABLE_FAMILIES: Record<SuperGroup, SignalKey[]> = SUPER_GROUPS.reduce(
  (acc, sg) => {
    acc[sg] = SIGNALS.filter(
      (f) => SUPER_GROUP_OF[f] === sg && !STUBBED_SIGNALS.has(f) && FAMILY_MEMBERS[f].length > 0,
    );
    return acc;
  },
  {} as Record<SuperGroup, SignalKey[]>,
);

/** Per-super-group coverage for a leg's cells: `capable` = `CAPABLE_FAMILIES` size, `live` = cells with a
 *  SENSITIVE state. Additive DISPLAY read. */
function computeCoverage(
  cells: SignalCell[],
): Record<SuperGroup, { live: number; capable: number }> {
  const stateOf = new Map(cells.map((c) => [c.family, c.cellState]));
  return SUPER_GROUPS.reduce(
    (acc, sg) => {
      const capableSet = CAPABLE_FAMILIES[sg];
      // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `computeCells` emits a cell for EVERY `SIGNALS` family, so
      // `stateOf` is total; "na" is the non-counting direction, so the guard can't inflate coverage.
      const live = capableSet.filter((f) => isSensitiveState(stateOf.get(f) ?? "na")).length;
      acc[sg] = { live, capable: capableSet.length };
      return acc;
    },
    {} as Record<SuperGroup, { live: number; capable: number }>,
  );
}

/** A share pillar value as a `PillarScore`: `null` ⇒ `not-live`. */
function sharePillarScore(value: number | null): PillarScore {
  return value === null ? { kind: "uncomparable", reason: "not-live" } : { kind: "scored", value };
}

/** Quantize one close's pillar pair to the raw 2×2 regime at `DANGER_CUTS.amber` (non-live pillar = LOW):
 *  CALM=both low / DETER=EW hi / STRESS=both hi / RECOV=SN hi. */
export function quantizeRegime(p: PillarPair): Regime {
  const ewHi = p.ew.live && p.ew.value >= DANGER_CUTS.amber;
  const snHi = p.sn.live && p.sn.value >= DANGER_CUTS.amber;
  if (ewHi && snHi) return "stress";
  if (ewHi) return "deter";
  if (snHi) return "recov";
  return "calm";
}

/** Confirmed regime over per-close pillar pairs (oldest→newest): quantize each, then the shared 2-close
 *  fold (`confirmedSeries`) so a border blip can't flip it. Empty ⇒ `calm`. Keeps `CONFIRM_CLOSES=2`, not CONFIRM_TIERS. */
export function confirmedRegime(series: PillarPair[]): Regime {
  if (series.length === 0) return "calm";
  return confirmedSeries(series.map(quantizeRegime), CONFIRM_CLOSES).at(-1)!;
}

/** PROBE-ONLY CONTROL ARMS — reach the engine ONLY through `computeFieldProbe`, never the production
 *  signature. `dial-assembly.ts`'s fourth seam is deliberately NOT carried — do not add an arm for it here. */
export interface ProbeArms {
  /** PROBE-ONLY: forces `holdOn = false`, so all member-state sites fall back to the unheld builders
   *  while `cissHistory` keeps flowing. Suppresses the `danger:timing-hold` degrade. Only `probe-leg-ordering.ts --before=hold`. */
  probeHoldOff?: boolean;
  /** PROBE-ONLY: runs the signal hold with its RELEASE BRANCH SKIPPED (the pre-arm-C plain max) — the
   *  exact C-vs-CUR control. Independent of `probeHoldOff`; only `probe-leg-ordering.ts --before=holdrelease`. */
  probeHoldNoRelease?: boolean;
  /** SWEEP SEAM: the held-pick deadband, replacing the directional `rising ? DERISK : RERISK` resolution
   *  for BOTH directions when passed. Omitted ⇒ byte-unchanged. */
  probeDeadbandOverride?: number;
}

/** Derive the per-leg danger field, then pick the calmest in-band leg (else `null`). Deadband
 *  DIRECTIONAL vs `prevTarget` (rising ⇒ DERISK / falling/stable ⇒ RERISK / cold-start ⇒ RISING). Never throws. */
function computeFieldCore(
  d: DangerInput,
  band: DangerBand,
  memberHistory?: MemberHistoryEntry[],
  prevTarget?: number | null,
  cissHistory?: MemberHistoryEntry[],
  rsBySleeve?: Map<string, number | null>,
  momBySleeve?: Map<string, number | null>,
  /** OBSERVABILITY SEAM: `onDegrade(scope, reason)` = `recordDegrade` (tracks.ts) on the cron path; every
   *  other caller omits it. A callback, not an import, to avoid an import cycle. */
  opts?: {
    onDegrade?: (scope: string, reason: string) => void;
  },
  /** The ● (`dial.targetRung`), so `rising` compares the ● to `prevTarget` — NOT `band.hi`, which
   *  floats above the ● at calm targets. Omitted ⇒ `band.hi` fallback (pre-fixed-width geometry). */
  targetRung?: number | null,
  /** The probe-only control arms, reachable ONLY through `computeFieldProbe`; `computeField` cannot pass it. */
  probe?: ProbeArms,
): FieldResult {
  // SIGNAL-HOLD GATE: the hold is reconstructed from `cissHistory`; no usable depth ⇒ unheld fallback
  // (`noHoldDepth` OWNS the "wider than undefined" test). `probeHoldOff` forces the same fallback.
  const probeHoldOff = probe?.probeHoldOff === true;
  const noDepth = noHoldDepth(cissHistory);
  const holdOn = !probeHoldOff && !noDepth;
  // Emit ONLY for the genuine no-depth degrade — a deliberate probe arm is not a degrade.
  if (noDepth && !probeHoldOff) {
    opts?.onDegrade?.(
      "danger:timing-hold",
      "no member-history depth - per-member signal hold (SIGNAL_HOLD_CLOSES) disabled, member states unheld",
    );
  }
  // `probeHoldNoRelease` rides ON TOP of `holdOn`: it changes the FOLD the held builders run, threaded
  // to the three member-state sites and nothing else.
  const probeHoldNoRelease = probe?.probeHoldNoRelease === true;
  const stateNow = holdOn ? buildMemberStateHeld(d, cissHistory, probeHoldNoRelease) : buildMemberState(d);
  const statePrev = memberHistory
    ? holdOn
      ? buildMemberStateHeldAt(memberHistory, LOOKBACK, probeHoldNoRelease)
      : buildMemberStateAt(memberHistory, LOOKBACK)
    : null;

  const arm = shareArm({ kind: "share", kappa: SYSTEMIC_KAPPA });
  const pairOf = (s: ShareArmLeg): PillarPair => ({
    // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — the 0 rides `live: false`; no reader takes it as calm.
    ew: { value: s.earlyWarn ?? 0, live: s.earlyWarn !== null },
    sn: { value: s.stressNow ?? 0, live: s.stressNow !== null },
  });

  // Speed-arrow cold-start predicate: TRUE iff every gated member has ≥ lookback+1 observed closes (any
  // short member suppresses). Empty relevant set ⇒ the super-group's whole roster.
  const cissDepth = new Map((cissHistory ?? []).map((h) => [h.id, h.history.length]));
  const observedAtLookback = (sleeve: string, sg: SuperGroup, lookback: number): boolean => {
    const families = SIGNALS.filter((f) => !STUBBED_SIGNALS.has(f) && SUPER_GROUP_OF[f] === sg);
    const relevant = families.flatMap((f) => FAMILY_MEMBERS[f].filter((m) => isRelevant(m, sleeve)));
    const members = relevant.length > 0 ? relevant : families.flatMap((f) => FAMILY_MEMBERS[f]);
    // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — absent history IS depth 0, which fails `d > lookback`.
    return members.every((m) => (cissDepth.get(m) ?? 0) > lookback);
  };

  // The share arm as-of t−j, on the SAME (held) member-state clock as t.
  const shareAt = (l: LegField, j: number): ShareArmLeg =>
    arm.leg(
      l.sleeve,
      holdOn ? buildMemberStateHeldAt(cissHistory!, j, probeHoldNoRelease) : buildMemberStateAt(cissHistory!, j),
    );
  const pillarPairAt = (l: LegField, j: number): PillarPair => pairOf(shareAt(l, j));
  // Build the oldest→newest pillar series the 2-close fold quantizes+confirms (last CONFIRM_CLOSES
  // closes). No cissHistory / too short ⇒ single-close series (raw = confirmed) — never crash/impute.
  const regimeSeries = (l: LegField, now: PillarPair): PillarPair[] => {
    if (!cissHistory) return [now];
    const maxLen = Math.max(0, ...cissHistory.map((h) => h.history.length));
    const depth = Math.min(CONFIRM_CLOSES, maxLen);
    if (depth <= 1) return [now];
    const series: PillarPair[] = [];
    for (let j = depth - 1; j >= 1; j--) series.push(pillarPairAt(l, j)); // t−(depth−1) … t−1
    series.push(now); // t — reuse the already-computed live pair
    return series;
  };

  // The share arm's capped `gp` term per leg (unobserved ⇒ 0), collected only to SERVE `FieldResult.exogenous`.
  const gpTermBySleeve = new Map<string, number>();

  // Own-danger per sleeve = `LEG_SENSITIVITY` × share danger — #R2 and `pickHeld` read it; rows keep plain `danger`.
  const ownDanger = new Map<string, number>();
  const legRows: LegRow[] = LEG_FIELD.map((l) => {
    const cells = computeCells(l, stateNow);
    const s = arm.leg(l.sleeve, stateNow);
    // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — DISPLAY-only; an unobserved `gp` term contributed 0 to the leg's max.
    gpTermBySleeve.set(l.sleeve, s.gp ?? 0);
    const danger = s.danger;
    const now = pairOf(s);
    const subDangers: SubDangers = {
      earlyWarn: sharePillarScore(s.earlyWarn),
      stressNow: sharePillarScore(s.stressNow),
      trend: s.trend,
      gp: s.gp,
    };
    // 2-close confirmation over the real per-close pillar history (`regimeSeries`) so a lone
    // quantize-border blip at t can't flip the chip; degrades to single-close when history is absent.
    const regime = confirmedRegime(regimeSeries(l, now));
    // G1 growth pillar. DISPLAY-ONLY: never enters the danger scalar or `held`. Both prod pick paths supply the maps; omitting them ⇒ `rsMomLive: false`.
    const growth = computeLegGrowth(cells, l, rsBySleeve?.get(l.sleeve) ?? null, momBySleeve?.get(l.sleeve) ?? null);
    // DISPLAY-ONLY ledger Trend column: the ungated uT trend share + the share arm's own gate. Nothing below reads it.
    const uTShare = trendShare(l.sleeve, stateNow);
    const trend = {
      value: uTShare,
      counting: uTShare !== null && trendGateFactor(now.ew.value, now.sn.value, DANGER_CUTS.amber) > 0,
    };
    // W0 coverage (additive DISPLAY field) — read by NOTHING on the danger/pick path.
    const coverage = computeCoverage(cells);
    const row: LegRow = {
      ...l, cells, coverage, danger, subDangers, regime, concentrated: false, growth, trend,
      familiesLit: s.familiesLit,
    };
    if (statePrev) {
      // D8: ROC in SEVERITY space (√danger), normalised by one leg-RAG band width — see MOMENTUM_DIVISOR.
      const roc = (Math.sqrt(danger) - Math.sqrt(arm.leg(l.sleeve, statePrev).danger)) / MOMENTUM_DIVISOR;
      row.momentum = Math.max(-1, Math.min(1, roc));
    }
    // SN speed arrow: raw stressNow delta over SN_ROC_LOOKBACK closes via the SAME `pillarPairAt` path
    // (raw SN units, no divisor). Cold-start guard: t−5 base must be OBSERVED (`observedAtLookback`), else suppress.
    if (cissHistory && now.sn.live && observedAtLookback(l.sleeve, "STRESS-NOW", SN_ROC_LOOKBACK)) {
      const snPrev = pillarPairAt(l, SN_ROC_LOOKBACK).sn;
      if (snPrev.live) {
        row.snRoc = Math.max(-1, Math.min(1, now.sn.value - snPrev.value));
      }
    }
    // EW speed arrow: the SN block's contract with EARLY-WARN substituted, over EW_ROC_LOOKBACK.
    if (cissHistory && now.ew.live && observedAtLookback(l.sleeve, "EARLY-WARN", EW_ROC_LOOKBACK)) {
      const ewPrev = pillarPairAt(l, EW_ROC_LOOKBACK).ew;
      if (ewPrev.live) {
        row.ewRoc = Math.max(-1, Math.min(1, now.ew.value - ewPrev.value));
      }
    }
    ownDanger.set(l.sleeve, s.ownDanger);
    return row;
  });

  // #R2: cluster siblings' own-danger keyed by sleeve (never mutates a leg's own-danger bar). DISP
  // elevated (AMBER/RED) widens the cluster to `DISP_WIDE_CLUSTERS` (EM joins); else base `CLUSTERS`. Membership only.
  const dispElevated = stateNow["DISP"]?.sev === "lit" || stateNow["DISP"]?.sev === "elev";
  const effectiveClusters = dispElevated ? DISP_WIDE_CLUSTERS : CLUSTERS;
  const maxSiblingDanger = new Map<string, number>();
  for (const cluster of effectiveClusters) {
    for (const sleeve of cluster) {
      // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `ownDanger` is total over `legRows` and 0 is the identity
      // of the enclosing `Math.max` (already seeded at 0).
      const siblingMax = Math.max(
        0,
        ...cluster.filter((s) => s !== sleeve).map((s) => ownDanger.get(s) ?? 0),
      );
      maxSiblingDanger.set(sleeve, siblingMax);
    }
  }
  const effDanger = new Map<string, number>();
  const concThreshold = arm.concThreshold;
  for (const l of legRows) {
    const own = ownDanger.get(l.sleeve)!;
    const sibMax = maxSiblingDanger.get(l.sleeve);
    // Gate the pick-bump on the SAME threshold as the badge (sibMax >= concThreshold), so a pick change
    // on the ntfy-pushed hold always has a lit badge explaining it.
    if (sibMax !== undefined && sibMax >= concThreshold) {
      l.concentrated = true;
      effDanger.set(l.sleeve, Math.max(own, CONC_WEIGHT * sibMax));
    } else {
      effDanger.set(l.sleeve, own);
    }
  }

  // Held pick = anti-whipsaw buffer band, DIRECTIONAL: rising danger ⇒ DERISK_DEADBAND (strict calmest
  // in-band); falling/stable ⇒ RERISK_DEADBAND (inertia). Cold-start/null ⇒ RISING. Probe override replaces the resolution.
  const rising = prevTarget == null ? true : (targetRung ?? band.hi) > prevTarget;
  const deadband = probe?.probeDeadbandOverride ?? (rising ? DERISK_DEADBAND : arm.reriskDeadband);
  const held = pickHeld(legRows, band, (l) => effDanger.get(l.sleeve)!, deadband);

  // `exogenous.floor` = MIN per-leg capped `gp` term over the 9 legs (0 seed for an empty ladder).
  const exoFloor = gpTermBySleeve.size === 0 ? 0 : Math.min(...gpTermBySleeve.values());
  return { legRows, band, held, exogenous: { active: exoFloor > 0, floor: exoFloor }, memberState: stateNow };
}

/** THE PRODUCTION ENTRY POINT — contract on `computeFieldCore`. Takes every arg except the probe control
 *  arms, which its signature cannot express, so no production call site can reach a measurement branch. */
export function computeField(
  d: DangerInput,
  band: DangerBand,
  memberHistory?: MemberHistoryEntry[],
  prevTarget?: number | null,
  cissHistory?: MemberHistoryEntry[],
  rsBySleeve?: Map<string, number | null>,
  momBySleeve?: Map<string, number | null>,
  opts?: { onDegrade?: (scope: string, reason: string) => void },
  targetRung?: number | null,
): FieldResult {
  return computeFieldCore(
    d,
    band,
    memberHistory,
    prevTarget,
    cissHistory,
    rsBySleeve,
    momBySleeve,
    opts,
    targetRung,
  );
}

/** THE PROBE-SIDE WRAPPER — `computeField` plus a required `ProbeArms`. Callers are `scripts/probe-*.ts`
 *  and seam tests only; nothing under `src/`/`api/` may call it. Passing `{}` is exactly `computeField`. */
export function computeFieldProbe(
  d: DangerInput,
  band: DangerBand,
  memberHistory: MemberHistoryEntry[] | undefined,
  prevTarget: number | null | undefined,
  cissHistory: MemberHistoryEntry[] | undefined,
  rsBySleeve: Map<string, number | null> | undefined,
  momBySleeve: Map<string, number | null> | undefined,
  opts: { onDegrade?: (scope: string, reason: string) => void } | undefined,
  probe: ProbeArms,
  targetRung?: number | null,
): FieldResult {
  return computeFieldCore(
    d,
    band,
    memberHistory,
    prevTarget,
    cissHistory,
    rsBySleeve,
    momBySleeve,
    opts,
    targetRung,
    probe,
  );
}
