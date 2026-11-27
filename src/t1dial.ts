/**
 * T1 danger-regime dial — the two-tier structured aggregation (Approach C).
 *
 * Pure leaf: same family panels → same dial, no clock/IO. It RE-AGGREGATES the
 * `FamilyPanel[]` that `families.ts` already reduced from a run's confirmed
 * readings — it never touches feeds or re-scores. Rendered as a SECOND /lab panel
 * beside the iteration-2 flat-breadth+veto panel; the two coexist by design
 * (dual-panel decision, slice 1a).
 *
 * Why a tiered rule instead of flat breadth: leading and coincident families fire
 * at different times by construction, so LEADING breadth alone selects the band
 * (the structural anti-double-count) and coincident families only position WITHIN
 * it — a technical selloff (coincident-only) can never manufacture a crisis band.
 *
 * TWO-KEY MODEL (L1 Stage 2, 2026-07-16): rungs 7–9 are reachable ONLY when BOTH keys
 * turn — `armed` (an ARM/LEADING family firing: credit or rates) AND `fired` (a FIRE/
 * coincident family firing: volatility, cross-asset or trend). Unprimed caps at rung 3
 * (`UNARMED_CAP`), primed-but-unfired at rung 5 (`ARMED_UNFIRED_CAP` = `UNARMED_CAP + POSITION_SPAN`). The unprimed side also carries
 * a graded FLOOR rising with coincident RED breadth to `SHOCK_RUNG=6` — the 2020/2008 vol-shock class
 * credit structurally misses (this replaces, and RETIRES, the old M6/P3 VT partial
 * band-selection: `volShockSelection`, `VT_SELECT_WEIGHT`, `VOLSHOCK_VIX_FLOOR`, the
 * `vixLevel` param — the floor now covers it without letting a coincident family
 * set `armed`). [USER RATIFIED 2026-07-16, L1 qimpag round.]
 *
 * DEC-B4(i) (2026-07-18) — that escape was formerly a BOOLEAN override (vol AND cross-asset AND
 * trend all live-and-RED ⇒ lift to 6, else nothing), i.e. a cliff: r=2 capped at 3, r=3 jumped to 6.
 * It is now the graded floor `LADDER_MIN + (SHOCK_RUNG−LADDER_MIN)·(r/F)^γ` (γ=SHOCK_CONVEXITY, convex
 * per Increment B 2026-07-22), r = live-and-RED
 * coincidents. Rungs 7–9 stay two-key ARITHMETICALLY (r ≤ F ⇒ floor ≤ 6), not by a branch. NOTE this
 * lifts the effective UNPRIMED ceiling above the Calm band at r ≥ 2 — see `shockFloor` in
 * computeT1Dial; the "coincident-only can never leave Calm" property is narrowed, not preserved.
 *
 * Slice-1a simplification still standing: graded g is the COARSE
 * `CONTRIBUTION {0, .5, 1}` map, not a continuous g∈[0,1].
 *
 * Rotation-slice-1 (P2): the old boolean band cliff (L=0→[1,3], 1→[4,6], 2→[7,9]) is
 * replaced by a graded floor rising linearly with ARM BREADTH — L, the COUNT of live
 * LEADING families firing — from LADDER_MIN to the deepest floor the ladder admits;
 * positionP scales within `[lo, lo + POSITION_SPAN]`.
 *
 * DEC-B3 (2026-07-18) — the floor is breadth ONLY. It formerly rose with `Lg` (Σ firing-leader
 * coarse contribution), which let leader DEPTH select the band while `leadingP` read that same
 * depth to position within it: Finding F's double-count. An Amber→Red step on one leader now
 * moves exactly POSITION_SPAN — one band width, never across bands — in a FIRED world; an
 * UNFIRED world may truncate that step against `ARMED_UNFIRED_CAP` (Alt A, W2-b), so the
 * unfired Amber→Red separation can collapse below POSITION_SPAN.
 *
 * The §5-step-2 **leading-boundary tiebreak** IS wired (coarse): band selection stays
 * breadth-only (the structural anti-double-count), but a firing leader positions WITHIN
 * its band by how far it sits above the amber floor — so an AMBER leader (sits at the
 * band floor, it only just qualified) reaches a different rung than a deep-RED leader
 * (rides the band top, about to escalate). This is what makes AMBER ≠ RED on the dial.
 */
import { STATE_RANK, type State } from "./domain-types.js";
import type { FamilyKey, FamilyPanel, FamilyRegime } from "./families.js";
import { FAMILY_OF_SIGNAL, regimeFor, notifyRegimeFor, rungCut, coincidentContribution, PER_LEG_ONLY_MEMBERS } from "./families.js";
import type { SuperGroup } from "./danger-ladder.js";
import { SIGNALS, SUPER_GROUP_OF, MEMBER_WEIGHT } from "./danger-ladder.js";
import { memberScaledBand, DANGER_POWER, type MemberStateMap } from "./danger-engine.js";
import { SEV_STATE } from "./danger-member-state.js";
import { DOWNSIDE_DETECTOR_IDS, RS_LEG_OF } from "./registry-price.js";

/** Coarse contribution levels (mirror families.ts CONTRIBUTION): a firing family is
 *  AMBER=0.5 or RED=1. Used to measure a firing leader's depth ABOVE the amber floor. */
const AMBER = 0.5;
const RED = 1;

// Stage-1 seam: read a family's BAND role; the ONE
// fallback mirrors its own unrestricted values when `band` is absent (optional field).
// Since D1 (family-colour-follows-danger) f.state/.firing/.contribution ARE the band role, so this is an
// IDENTITY for credit/rates too — KEEP it: the split is the seam's contract, not code to "simplify" away.
const bandOf = (f: FamilyPanel) =>
  f.band ?? { state: f.state, firing: f.firing, contribution: f.contribution, ids: f.members.map((m) => m.id) };

/** slice-4: min detectors that must be amber-or-worse before the US-tech confirmer fires.
 *  One screaming detector is one region, not systemic — so a hard ≥2-of-2 breadth floor
 *  over the {F4,F5} slots (both must fire; NVDA demoted to detail-only 2026-07-22). */
const TECH_CONFIRMER_FLOOR = 2;

/**
 * v1 EARLY-WARN sub-signal membership (fast-breaks redesign §1, 2026-07-21): the fast downside-break
 * detectors routed OFF the Confirming axis onto their own early-warning output. Two members:
 * `DB_SMH` (it PASSED its frozen B3 lead-validation gate — but as a −8/−15 detector; the
 * 2026-07-23 retune onto −5/−8 fires strictly earlier and is NOT re-validated) and `DB_XLK` (SP500IT coverage rung 1,
 * 2026-07-23 — the direct read on the 100%-held S&P-500-IT pension track; UNCALIBRATED priors of
 * its OWN via `downsideCuts`, numerically equal to DB_SMH's since DB_SMH was retuned onto the same
 * −5/−8 later that day — no lead-validation replay yet).
 *
 * ⚠ This axis is DELIBERATELY OFF `LEADING`/`leadingFiring`/`leadingP` — it must NEVER arm the crisis
 * band (D-B / V-arm). Its ONLY notify role is `ewFloor` (alert-band.ts), hard-capped at WATCH.
 *
 * MEMBERSHIP IS DERIVED, NOT CURATED (B-1 ruling — it
 * OVERRIDES the A1 "keep curated" recommendation): the roster IS
 * `DOWNSIDE_DETECTOR_IDS` (`registry.ts`), so adding a downside detector is the one registry-row edit.
 * ⚠ Accepted consequence, stated at ruling time: `earlyWarnFires` ORs across members with NO
 * N-of-M, so every future downside detector auto-joins the notify path (per-member it is now
 * break-AND-rel-strength, 2026-08-15). If the push rate bites, the fix is an N-of-M gate on `ew` —
 * NOT a re-curated list.
 */
export const EARLY_WARN_MEMBERS: readonly string[] = DOWNSIDE_DETECTOR_IDS;

/**
 * The EW sub-signal fire (K-threshold = AMBER): a member fires when its break state is AMBER+ AND
 * its `RS_LEG_OF` rel-strength sibling's confirmed state is AMBER+ (2026-08-15 AND-gate); OR across
 * members, no N-of-M — one gated member fires the floor. Absent RS reading ⇒ gate OPEN, break alone
 * fires (fail-toward-signal on data loss); absent/GREEN member ⇒ does not fire. Reads confirmed
 * `{id,state}` readings (the fast breaks are persisted rows, NOT trend-family panel members since
 * D-D), the SAME shape the dial assembly already has. This is the SINGLE source of the EW fire:
 * `assembleDial` sets it on the dial (`fastBreakEW`) and `escalatorFloorDetail` reads that off the
 * dial for `ewFloor`.
 */
export function earlyWarnFires(readings: readonly { id: string; state: State }[]): boolean {
  const byId = new Map(readings.map((r) => [r.id, r.state]));
  const firing = (s: State | undefined) => s === "AMBER" || s === "RED";
  return EARLY_WARN_MEMBERS.some((id) => {
    if (!firing(byId.get(id))) return false;
    const rsId = RS_LEG_OF[id];
    const rs = rsId === undefined ? undefined : byId.get(rsId);
    return rs === undefined || firing(rs);
  });
}

/** Ladder geometry — the three numbers the graded floor is an expression OVER. `positionP` scales the
 *  ● within `[lo, lo + POSITION_SPAN]`, so a full ARM set may floor no deeper than
 *  `LADDER_MAX − POSITION_SPAN` without the band top overflowing the ladder. That bound is what forces
 *  the floor's slope (see `lo` in computeT1Dial) — it is derived there, never typed in. */
export const LADDER_MIN = 1;
/** Exported so a fixture can clamp its hand-passed rung to the SAME bound `computeT1Dial`'s tail
 *  applies (`rung = Math.min(rung, LADDER_MAX)`) instead of emitting an unreachable rung. */
export const LADDER_MAX = 9;
export const POSITION_SPAN = 2;

/** Bubble-arming K1: `slowArmed` scales the notify
 *  cuts ×this via `notifyRegimeFor(dangerScore / ARMED_CUT_SCALE)`. ONE definition — derive fixtures
 *  from it, never restate the value. */
export const ARMED_CUT_SCALE = 0.9;

/** Two-key caps (L1 Stage 2): with no FIRE family firing the dial can't exceed rung 5; with no ARM
 *  family firing it can't exceed rung 3 — so rungs 7–9 require BOTH keys (primed AND fired). */
const UNARMED_CAP = 3;
export const ARMED_UNFIRED_CAP = UNARMED_CAP + POSITION_SPAN;
/** The unprimed floor's DEEPEST reach — the rung a FULL live-and-RED coincident set (r = F) floors at
 *  even unprimed (the vol-shock class credit misses). Below full breadth the floor grades down toward
 *  LADDER_MIN (DEC-B4(i); see `shockFloor` in computeT1Dial), so this is the r = F endpoint, not a
 *  branch's constant. Formerly equal to ARMED_UNFIRED_CAP; Alt A (2026-07-18, W2-b) narrowed that
 *  cap to `UNARMED_CAP + POSITION_SPAN` (=5) on band geometry alone, so SHOCK_RUNG is now DECOUPLED
 *  and stays at its RED-ratified endpoint (6) — a full triple-RED coincident shock now floors one
 *  rung DEEPER than primed-but-unfired. Two-key intact: SHOCK_RUNG < 7, so 7–9 still need BOTH keys. */
const SHOCK_RUNG = 6;
/** γ — Increment B (2026-07-22): the unprimed shockFloor grades CONVEXLY (quadratic) in coincident RED
 *  breadth, not linearly. Systemic stress is super-additive in co-movement (CISS, OFR-FSI treat this as
 *  the defining property of joint stress), so the middle cools: {1, 2.67, 4.33, 6} → {1, 1.56, 3.22, 6}.
 *  Endpoints are invariant under any γ ((0/F)^γ=0, (F/F)^γ=1). Not fitted; γ=2 is the CISS convention. */
const SHOCK_CONVEXITY = 2;

/** Graded systemic bump (L1 Stage 3): cross-asset breadth is the "everything moves together"
 *  systemic tell, so its family state adds +0.5 (AMBER) / +1 (RED) to the rung — but ONLY beside
 *  ≥1 other firing ARM∪FIRE family (an isolated cross-asset move is a rotation, not systemic).
 *  Applied at pipeline step 3, BEFORE the two-key caps, so an unprimed bump still can't exceed
 *  rung 3 and 7–9 stay strictly two-key. Replaces the Stage-2-retired boolean dispersionBump. */
const SYSTEMIC_BUMP_AMBER = 0.5;
const SYSTEMIC_BUMP_RED = 1;

/**
 * Reduce the two US-tech downside slots to the band-independent breadth the dial folds in (slice 4).
 * Per-leg-RAG Stage 2 (Option A): the slots are now the WEIGHT-SCALED tech-leg legRAG bands of the
 * two tech members {F4,F5} (memberWeight on Semis/S&P IT → scaledSevBand, assembled in
 * dial-assembly.ts), NOT the raw detector states — so a low-weight RED can no longer lift the
 * confirmer the way the old flat detector mean did. (NVDA was the third slot until 2026-07-22, when it
 * was demoted to detail-only and dropped from the confirmer; the denominator is now /2.) The gate SHAPE
 * is unchanged: fixed-denominator arithmetic mean of the coarse CONTRIBUTION {GREEN:0, AMBER:0.5, RED:1}
 * over ALL 2 slots — but 0 unless ≥2 are amber-or-worse (`TECH_CONFIRMER_FLOOR`, i.e. 2-of-2). Monotonic
 * in both breadth and depth: a deeper or extra firing slot never lowers it (why fixed-denominator, not
 * mean-over-firing). Absent feeds count as not-firing (drop toward under-reaction, never a false
 * escalation); all absent → 0. The result feeds `computeT1Dial(..., techConfirmerP)` as a within-band
 * deepener only — it can never select a higher band. Pass exactly the 2 slots (null for a
 * guard-lit/dropped feed) so the denominator stays 2. */
export function techConfirmerBreadth(states: readonly (State | null | undefined)[]): number {
  const firing = states.filter((s) => s === "AMBER" || s === "RED").length;
  if (firing < TECH_CONFIRMER_FLOOR) return 0;
  const depth = (s: State | null | undefined) => (s === "RED" ? RED : s === "AMBER" ? AMBER : 0);
  return states.reduce((sum, s) => sum + depth(s), 0) / states.length;
}

/** US-tech downside-breadth confirmer, mirroring dial-assembly.ts's sourcing EXACTLY (per-leg-RAG Stage 2):
 *  the 2 slots read the trend-family {F4,F5} member states off the GLOBAL panel via
 *  `memberScaledBand` on the tech legs. D-C (2026-07-21, fast-breaks EARLY-WARN redesign) REVERTED
 *  the B5 F4→DB_SMH swap: a confirmer slot must hold SLOW members, so the fast DB_SMH break was
 *  pulled back out and F4 restored. NVDA was the third slot until 2026-07-22, when it was demoted to
 *  detail-only and dropped from the confirmer (removing its panel lookup so the demotion can't strand a
 *  slot / fire a spurious `onMissing` degrade). F4/F5 stay trend-family members (families.ts), so this
 *  still resolves them off the GLOBAL panel — the §1 stranding is gone by construction (V-noStrand). The
 *  mean is now over 2 slots and the ≥2-of-2 `TECH_CONFIRMER_FLOOR` means both must fire. Sourcing from
 *  the panel keeps /lab on the real notify rung AND makes the confirmer scenario-drivable (a
 *  `?s=F5:RED` override flows in). Extracted from api/lab.ts (replay Stage 1.1) so both /lab
 *  consumers share one implementation.
 *
 *  ⛔ A FROZEN COPY OF THIS FUNCTION'S PRE-STAGE-6.2 MERGE LIVES IN THE PROBE, AND IT CARRIES A RE-PIN
 *  DUTY ON *THIS* SYMBOL: `techConfirmerFromPanelPreS62` (`scripts/probe-leg-ordering.ts`, the
 *  `--before=s62` control arm) is a transcription of this body as it stood before Stage 6.2. Any change to the merge
 *  below — the `F4`/`F5` slot roster, `TECH_LEGS`, the raise comparison, the `onMissing`/absent-panel
 *  branch, or the 6.2 gate question — MUST re-pin that local in the SAME commit, or the arm silently
 *  measures 6.2 plus whatever else moved. */
/** ⚠ EXPORTED FOR THE WEIGHT-EDIT PREDICATE, NOT ONLY FOR THE DIAL. `scripts/probe-leg-ordering.ts`
 *  feeds these two constants to `weightEditVerdict` as the dial seam it must not certify blind — a
 *  `MEMBER_WEIGHT` cell on one of these legs, for one of these members, reaches the notify band through
 *  `memberScaledBand` WITHOUT passing the danger scalar. Read them; never re-type them there. */
export const TECH_LEGS = ["Semis", "S&P IT"] as const;
export const TECH_CONFIRMER_MEMBERS = ["F4", "F5"] as const;
export function techConfirmerFromPanel(
  families: readonly { members: readonly { id: string; state: State }[] }[],
  onMissing?: (id: string) => void,
  /** OPTIONAL HELD member map (Stage 2.1)
   *  — since Stage 6.1 this is `buildMemberStateHeld({ globalFamilies }, cissHistory)`,
   *  passed by `assembleDial`: the same merged map `computeField` builds. Since Stage 6.2's
   *  ruling 10 that also holds on the COLD-STORE path — `assembleDial` branches on the shared
   *  `noHoldDepth` predicate, so with no depth BOTH take the unheld `buildMemberState`, one
   *  fallback whole. ⚠ SCOPE THAT EQUIVALENCE TO THE PRODUCTION PATH: the engine core falls back on
   *  `noDepth || probeHoldOff` (reachable only through `computeFieldProbe`), while `assembleDial` branches
   *  on `noHoldDepth` alone. `probeHoldOff` is a
   *  probe-only control-arm seam `assembleDial` does not carry — `scripts/probe-leg-ordering.ts` never
   *  calls it, it builds its own held map and threads the flag itself — so in production, where it is
   *  unset, the two selections are identical. It carries the danger engine's HOLD onto the chip;
   *  omitted, the behaviour is byte-identical to pre-Stage-2.1. ⚠ WHO STILL OMITS IT, as of Stage 6.3
   *  (ruling 12): `src/replay.ts` (exempt by that ruling) and the ONE control arm of
   *  `scripts/probe-leg-ordering.ts` that sets `probeHoldOff` — every other arm of that probe passes a map.
   *  The `?s=` SCENARIO PATH NO LONGER OMITS IT: `api/lab.ts`'s scenario arm passes
   *  `selectMemberStateMap(...)` on every request, exactly as its legacy null-`dialState` arm does, so
   *  a what-if runs on the same hold clock as the live request beside it. (The remaining
   *  `scripts/probe-*.ts` that never adopted the map are pre-Stage-2.1-clock probes by omission.)
   *  RAISES ONLY, exactly as `buildMemberStateHeld` does — a held-over fire can lift a slot, a
   *  held-over calm can never dull a live one. `held[m] === undefined` carries NO information beyond
   *  "not observed" — it is either no map passed at all or no observation in the window, and in both
   *  cases the LIVE panel state stands. (Before the lead-precedence gate was retired
   *  a third cause existed, a
   *  gate-DELETED entry, which this function turned into a `null` slot; that population no longer
   *  exists, so the distinction is gone with it.) */
  held?: MemberStateMap,
): Parameters<typeof techConfirmerBreadth>[0] {
  const memberState = new Map(families.flatMap((f) => f.members.map((m) => [m.id, m.state] as const)));
  return TECH_CONFIRMER_MEMBERS.map((m) => {
    const s = memberState.get(m);
    const h = held?.[m];
    const heldState = h === undefined ? undefined : SEV_STATE[h.sev];
    // Rank 7 (fail-toward-calm fix): a MISSING member (its price feed dropped ⇒ absent from the
    // panel) is confirmer-NON-LIVE (a null slot), NOT a calm GREEN. `techConfirmerBreadth` already
    // treats null as absent-not-firing in the fixed /2 denominator (so the band is unchanged), but
    // the null lets the caller emit a degrade event instead of silently scoring the drop as calm.
    //
    // ⚠ `onMissing` FIRES ON THE PANEL, NOT ON THE RESOLVED SLOT. The held map can supply a band for
    // a member the panel dropped, but the drop itself is still the degrade this callback exists to
    // report — suppressing it because the hold papered over the gap would make a feed outage
    // invisible in the run record. The degrade is emitted first; the slot is filled after.
    if (s === undefined) {
      onMissing?.(m);
      return heldState === undefined ? null : memberScaledBand(m, heldState, TECH_LEGS);
    }
    const eff = heldState !== undefined && STATE_RANK[heldState] > STATE_RANK[s] ? heldState : s;
    return memberScaledBand(m, eff, TECH_LEGS);
  });
}

/** Dial tiers DERIVED from the lead-time super-groups (Stage 6.1) — single-sourced from
 *  `SUPER_GROUP_OF` (danger-ladder.ts) through the `FAMILY_OF_SIGNAL` bijection, so the dial
 *  can never drift from the 7-family taxonomy. */
const familiesOf = (sg: SuperGroup): readonly FamilyKey[] =>
  SIGNALS.filter((s) => SUPER_GROUP_OF[s] === sg).map((s) => FAMILY_OF_SIGNAL[s]);

/** Leading core = EARLY-WARN super-group (`credit`, `rates`) — these SELECT the band (they
 *  genuinely lead). **`valuation` (EARLY-WARN's third family) is deliberately EXCLUDED**, and the
 *  reason is now a JUDGEMENT, not an arithmetic constraint: the floor is derived from `LG_CAP`
 *  below, so a third leader RESCALES the floor (every world cools by the widened denominator)
 *  rather than overflowing the ladder. That rescale is a real calibration change and must be
 *  eyeballed, not absorbed silently. ⚠ The "feedless stub that can never fire on the live path"
 *  clause this comment used to carry ROTTED when `ECY` was seated (2026-08-11): valuation IS live
 *  and CAN fire today, so the exclusion is now the judgement above doing ALL the work, not a feed
 *  gap making it moot. Stage B added `T5YIFR`/
 *  `T10YIE` to the family; both are rowless, so they widen the RAG chip and the K-of-N breadth
 *  without reaching any dial term through this filter. Re-adding valuation as a third leader stays
 *  an intentional recalibration.
 *
 *  A second exclusion clause (`k !== "macro-cycle"`, USER 2026-07-16) was dropped 2026-07-17 when
 *  the `macro-cycle` key itself was removed — the clause became dead, and its removal is a no-op:
 *  EARLY-WARN is now {cr, rt, vb} ⇒ `LEADING` = [credit, rates] and `LG_CAP` = 2, exactly as before. */
const LEADING: readonly FamilyKey[] = familiesOf("EARLY-WARN").filter((k) => k !== "valuation");

/** Ceiling on L — the size of the ARM set itself (L maxes when every leader is firing). DERIVED, so
 *  the floor scale below tracks the ARM set instead of silently mis-scaling when it changes: adding
 *  a leader is an additive change again, visible as a rescaled dial rather than a rung overflow. */
const LG_CAP = LEADING.length;
/** STRESS-NOW super-group (`volatility` ⊇ old complacency, `cross-asset` = old dispersion+flight)
 *  — coincident within-band positioners: they move the ● inside the leader-selected band, never
 *  select it. These are the FIRE families (with `trend` below): any one firing sets `fired`, the
 *  second of the two keys. (Cross-asset also sources the graded systemic bump below.) */
const STRESS_NOW: readonly FamilyKey[] = familiesOf("STRESS-NOW");
/** CONFIRMING super-group (`trend`) — the within-band CONFIRMER: it deepens the ● beside the
 *  STRESS-NOW families (same coincident denominator), never selects the band — so a technical
 *  selloff can't manufacture a crisis band. (The uT RED transition GATE — blocking re-risk
 *  rotation — lives in the rotation layer, Stage 3.2, not here.) */
const CONFIRMING: readonly FamilyKey[] = familiesOf("CONFIRMING");
/** The within-band coincident denominator = STRESS-NOW + the CONFIRMING trend confirmer. Same
 *  3 family KEYS as the pre-6.1 hand list (`volatility`, `cross-asset`, `trend`), now re-derived
 *  from the super-groups — but the SEMANTICS moved with the taxonomy (all plan-decided):
 *  the old complacency legs fold into the merged `volatility`, so they now move coincidentP;
 *  `cross-asset` (the dispersion+flight merge) counts here in K/coincidentP. These three are the
 *  FIRE families: any one firing sets `fired` (the second two-key). A coincident spike alone still
 *  can NEVER select a crisis band — the two-key caps below hold rungs 7–9 to primed+fired, and the
 *  SHOCK override (vol+cross-asset+trend jointly RED) is the one structural escape, capped at 6.
 *
 *  INVARIANT "valuation multiplies severity, never arms" — the SAME explicit filter as `LEADING`
 *  above. Today valuation sits in EARLY-WARN so it is absent here anyway; the filter makes the
 *  exclusion STRUCTURAL on both sides, so a super-group reassignment in `families.ts` can never
 *  silently re-arm it through the coincident denominator. No-op as written. */
const COINCIDENT: readonly FamilyKey[] = [...STRESS_NOW, ...CONFIRMING].filter((k) => k !== "valuation");

/** D4 (family-colour-follows-danger) — dial families absent from BOTH `LEADING` and `COINCIDENT`: under
 *  D1 they score legs but can never arm, so Stage 3 paints them a distinct `no-arm` tone. DERIVED over
 *  the dial super-group universe (never hand-listed); today exactly `{valuation}`, pinned in the test. */
const DIAL_FAMILY_UNIVERSE: readonly FamilyKey[] = [
  ...new Set([...familiesOf("EARLY-WARN"), ...STRESS_NOW, ...CONFIRMING]),
];
export const NO_ARM_FAMILIES: readonly FamilyKey[] = DIAL_FAMILY_UNIVERSE.filter(
  (k) => !LEADING.includes(k) && !COINCIDENT.includes(k),
);

/** D3 (family-colour-follows-danger) — ids carrying a `MEMBER_WEIGHT` row (they move leg danger). A
 *  member chip is `live` (in `band.ids`) / `per-leg` (`PER_LEG_ONLY_MEMBERS`: scores its leg, never the
 *  dial) / `leg-only` (rowless of the band but weighted) / `grey` (neither). Derived, never hand-listed. */
export const LEG_WEIGHTED_IDS: ReadonlySet<string> = new Set(Object.keys(MEMBER_WEIGHT));
export type MemberTone = "live" | "per-leg" | "leg-only" | "grey";
export function memberTone(id: string, bandIds: readonly string[]): MemberTone {
  if (bandIds.includes(id)) return "live";
  if (PER_LEG_ONLY_MEMBERS.includes(id)) return "per-leg";
  return LEG_WEIGHTED_IDS.has(id) ? "leg-only" : "grey";
}

/** The tight band emitted to computeField (P1): `width = POSITION_SPAN + round(max(leaderSplit,
 *  coincidentSplit))` ∈ {2,3} rungs (family DISAGREEMENT on EITHER axis, W3-b Stage 3.5 + D5), so it
 *  always spans 3–4 legs. `hi` floats UP off `targetRung` at calm targets — `targetRung` is the ●,
 *  not `hi`. The DEC-B3 ARM floor still SELECTS the band via `rung`/`targetRung`; it no longer sets `lo`. */
interface Band {
  lo: number;
  hi: number;
}

export interface T1DialResult {
  /** L = live LEADING (EARLY-WARN: credit, rates) families firing, ∈ [0, LG_CAP]. Selects the band. */
  leadingFiring: number;
  /** K = live coincident (STRESS-NOW vol/cross-asset + CONFIRMING trend) families firing
   *  ∈ {0,1,2,3}. Legible headline count. */
  coincidentFiring: number;
  /** P1 fixed-width band emitted to computeField: `width = POSITION_SPAN + round(max(leaderSplit,
   *  coincidentSplit))` ∈ {2,3} rungs (family DISAGREEMENT, W3-b Stage 3.5 + D5) ⇒ always 3–4 legs;
   *  `hi` floats up off `targetRung` at calm targets. The graded DEC-B3 floor still SELECTS the band
   *  by feeding `rung`/`targetRung`, but no longer sets `lo`. */
  band: Band;
  /** leadingP ∈ [0,1] — mean depth ABOVE the amber floor over the FIRING leading families
   *  (AMBER→0, deep RED→1). The §5-step-2 tiebreak: it's what separates an amber leader
   *  (band floor) from a red one (band top). 0 when no leader is firing. */
  leadingP: number;
  /** coincidentP ∈ [0,1] — mean coarse graded contribution over the LIVE coincident families
   *  (each measured from Green, firing or not, per §5 step 2). 0 when none are live. */
  coincidentP: number;
  /** techConfirmerP ∈ [0,1] — slice-4 US-tech downside-breadth confirmer (breadth of the
   *  {SMH,NVDA,QQQ} drawdown detectors). A band-INDEPENDENT within-band deepener: it folds into
   *  positionP like a coincident input (never selects a higher band), and is 0 unless ≥2 of 3
   *  detectors fire. 0 for every caller that omits the optional param (today's two-term form). */
  techConfirmerP: number;
  /** legP ∈ [0,1] — D6 within-band deepener: max over families of the DANGER_POWER power-mean of
   *  leg-only members' coarse contribution. Enters positionP only; never arms/floors/widens. */
  legP: number;
  /** positionP ∈ [0,1] — the within-band fraction: `max(leadingP, coincidentP, techConfirmerP, legP)`
   *  (L1 Stage 2 — MAX replaced the probabilistic OR, so multiple moderate inputs no longer
   *  saturate; still monotone and ∈ [0,1]). No valuation term (`mEff` retired, O2 2026-08-11 —
   *  valuation's danger home is the `ECY` member). Deep leaders / hard confirmers / tech-downside
   *  breadth each push the ● up the band; none exceeds the top, none moves `lo`. */
  positionP: number;
  /** true when an ARM/LEADING family (credit or rates) is firing — the first two-key. Rungs 7–9
   *  require `armed && fired`; an unprimed dial caps at UNARMED_CAP (3). */
  armed: boolean;
  /** true when a FIRE/coincident family (volatility, cross-asset, trend) is firing — the second
   *  two-key. Primed-but-unfired caps at ARMED_UNFIRED_CAP (5). */
  fired: boolean;
  /** true when EVERY live coincident family (volatility, cross-asset, trend) is RED — the r = F
   *  endpoint of the graded unprimed floor, where it reaches SHOCK_RUNG (6). HEADLINE/DISPLAY ONLY:
   *  it drives the `"+ shock"` suffix and no longer gates any math (DEC-B4(i) graded the branch away
   *  — sub-full breadth now floors proportionally rather than not at all). */
  shockOverride: boolean;
  /** graded systemic bump ∈ {0, 0.5, 1} — cross-asset family AMBER/RED beside ≥1 other firing
   *  ARM∪FIRE family (isolated cross-asset ⇒ 0). Already baked into `rung` (step 3, pre-caps). */
  systemicBump: number;
  /** continuous rung — the primitive: `lo + POSITION_SPAN·positionP + systemicBump`, then the two-key caps,
   *  the graded unprimed floor, and cap-9 applied in that order. */
  rung: number;
  /** `(rung − 1) / 8` — the card's 0→1 danger score restated from the rung side. */
  dangerScore: number;
  /** `1 + round(dangerScore × 8)` — recovers the card's target-rung formula. */
  targetRung: number;
  /** Calm/Caution/Stress/Crisis on the DISPLAY axis (`DIAL_REGIME_CUTS`) — the regime
   *  a human reads: push copy, the `/lab` dial card, `headline`. */
  regime: FamilyRegime;
  /** The same label on the NOTIFY axis (`NOTIFY_REGIME_CUTS`) — what
   *  `computeAlertBandDetail` bands and `run-core.ts` persists to `alert_log.dial_band`.
   *  **Equals `regime` while the two cut sets coincide** (W3-c ships them identical;
   *  the values are a `[USER DECISION]`). Both axes run the identical Crisis gate via
   *  `applyCrisisGate`, so they can diverge in their CUTS but never in their GATING. */
  notifyRegime: FamilyRegime;
  /** legible two-key sentence: "primed (credit) + fired (volatility, trend) → Stress, rung 6"
   *  (names the firing ARM + FIRE families, or "unprimed"/"unfired"; " + shock" when overriding).
   *  The copy says PRIMED, the field stays `armed` (R5, [USER] 2026-07-31): `armed` is `/exposure`'s
   *  credit-ARM word and must not appear on this axis in prose or on screen — the on-screen half
   *  is pinned by `dial-vocabulary.test.ts`. */
  headline: string;
  /** true when EVERY LEADING∪COINCIDENT family is present AND live on the panel this run — i.e.
   *  the rung was computed over the FULL denominator, not a shrunken one. A non-live pillar is
   *  excluded from the fold (`liveOf`), which is deliberately calm-ward (danger-engine.ts:91,
   *  "a non-live pillar counts as LOW"), so `targetRung` alone cannot tell a genuinely calm close
   *  from a starved one. Consumers that must not act calm-ward on a starved read gate on this
   *  (today: the R4 cash breaker's rung-clear EXIT leg, `r4.ts`). NOT affected by the rank-7
   *  family carry: a carried family is re-marked `live` upstream in `applyFamilyCarry`, so within
   *  the CARRY_MAX_TRADING_DAYS window this stays true and the carry keeps being the single
   *  mechanism handling that case — no double-count. */
  pillarsLive: boolean;
  /** EARLY-WARN sub-signal fire (fast-breaks redesign §1): true when a fast downside break
   *  (`EARLY_WARN_MEMBERS` — DB_SMH/DB_XLK) is AMBER-or-worse AND its `RS_LEG_OF` rel-strength
   *  sibling is too (absent RS ⇒ break alone; 2026-08-15). DECOUPLED from every pillar: it does
   *  NOT enter `leadingFiring`/`leadingP`/`armed`/`fired`/`rung`/`regime` — it never selects or positions a band.
   *  Its ONLY consumer is `ewFloor` (alert-band.ts, hard-capped at WATCH) plus a Stage-3 UI surface.
   *  `computeT1Dial` always emits `false` (the pure panel fold has no DB_* row since D-D); the real
   *  value is stamped by `assembleDial` via `earlyWarnFires(readings)`, so hydrated/persisted live
   *  dials carry it and the scenario/replay recompute paths (no persisted fast-break reading) show
   *  false — matching `downsideDetectors` being live-only. */
  fastBreakEW: boolean;
  /** provenance: positionP's contribution map is coarse {0,.5,1}, not a continuous g. (The band
   *  FLOOR reads NO contribution at all since DEC-B3 — it is graded over ARM breadth, a count.) */
  graded: "coarse";
}

/**
 * W3-b measure — family DISAGREEMENT as the normalised Gini impurity of a live family set's FIRING
 * partition. 0 = the channels concur (nothing to be uncertain about), 1 = evenly split. Called for
 * BOTH band-width axes (D5, 2026-07-22): `firingSplit(leading)` = leader disagreement,
 * `firingSplit(coincident)` = coincident disagreement — one generic primitive beats two Gini copies.
 *
 * WHY THE FIRING PARTITION, not depth: `armed`/`fired`, `LG_CAP` and the DEC-B3 floor all act on
 * `firing`, so corroboration is only meaningful on that predicate. It is also **structurally
 * depth-blind** — it never reads `contribution` — which makes the Finding-F double-count (family
 * depth picking BOTH the band floor and the ● within it; see the `lo` comment below) impossible by
 * construction rather than merely absent. A lone family stepping AMBER→RED moves the ● and leaves
 * the width alone. This holds on the coincident axis too: it reads `.firing`, never coincident depth.
 *
 * The `n < 2` branch is the limit of the same reading, not a special case: with fewer than two live
 * channels there is nothing to corroborate, so a firing lone channel is maximally UNcorroborated (1)
 * and a silent one makes no claim (0). Widening admits lighter legs, i.e. it under-reacts — the
 * sanctioned direction for absent feeds.
 *
 * The `4` is the normaliser `1 / max p(1−p)`, derived — not a tuning knob. On the leading axis at
 * today's `LG_CAP = 2` this collapses to `L === 1`; the general Gini form is what makes a THIRD
 * leader (valuation, when the CAPE feed lands) — and the 3-family coincident set — an additive
 * change rather than a recalibration.
 */
export function firingSplit(
  families: readonly FamilyPanel[],
  firingOf: (f: FamilyPanel) => boolean = (f) => f.firing,
): number {
  const n = families.length;
  const l = families.filter(firingOf).length;
  if (n < 2) return l > 0 ? 1 : 0;
  const p = l / n;
  return 4 * p * (1 - p);
}

/**
 * Crisis gate (L1 Stage 5) — the top label needs credit OR volatility non-green. A Crisis-scored dial
 * with both green-or-absent (reachable: rates-only ARM + deep FIRE set → rung ≥ 7.5) reads "Stress"
 * instead. ONE implementation, applied to BOTH regime axes (display + notify) by `computeT1Dial` —
 * never a hand-mirror. Module-level and exported (rather than a closure over `byKey`) so a fixture can
 * DERIVE a dial's regime through the production gate instead of re-typing the branch; the firing
 * predicates are passed in, so it stays a pure function of the two family facts it reads.
 *
 * `rung`/`dangerScore`/`targetRung` and `dial.band` are untouched by the gate — but the ALERT BAND is
 * NOT: alert-band.ts reads the GATED regime, so this really does demote a scored-Crisis notify
 * CRITICAL to WARNING. (Whether it SHOULD apply to the notify axis is the open policy question in
 * W3-c 6/Q2; until that is ruled, both axes are gated identically.) The per-leg pillar regimes
 * (danger-engine quantizeRegime/confirmedRegime) are a different axis, not gated.
 */
export function applyCrisisGate(r: FamilyRegime, creditFiring: boolean, volatilityFiring: boolean): FamilyRegime {
  return r === "Crisis" && !creditFiring && !volatilityFiring ? "Stress" : r;
}

/**
 * The card's target rung from the 0→1 danger score: `1 + round(dangerScore × 8)`. The `8` is the
 * ladder span (`LADDER_MAX − LADDER_MIN`) written as the literal it has always been here — see the
 * SCOPE note on `lo` in `computeT1Dial`: `rungCut` divides by that same literal, so the ladder is not
 * resizable through this constant alone.
 *
 * Module-level and exported for the SAME reason as `applyCrisisGate`: a fixture must be able to
 * DERIVE a dial's `targetRung` by calling what production calls, instead of re-typing the formula
 * (`src/test-helpers.ts` `makeDial`). `computeT1Dial` is the only production caller — there is no
 * inline copy left in this file.
 */
export function targetRungFor(dangerScore: number): number {
  return 1 + Math.round(dangerScore * 8);
}

/**
 * Emitted band from the ● `targetRung` and DISAGREEMENT `split` (max over the two axes; derivation at
 * the call site in `computeT1Dial`): `width = POSITION_SPAN + round(split)` ∈ {2,3} rungs ⇒
 * `hi − lo + 1 ∈ {3,4}` legs ALWAYS — the contract `danger-deadband`'s in-band field leans on.
 * At calm targets the band extends UP off `hi`, so `hi` is NO LONGER the ● — read `targetRung` for the ●.
 * Exported for fixture derivation (`makeDial`); the width arithmetic exists exactly once.
 */
export function dialBandFor(targetRung: number, split: number): Band {
  const width = POSITION_SPAN + Math.round(split); // 2 or 3 rungs → 3 or 4 legs (the fixed-width contract)
  const hi = Math.min(LADDER_MAX, Math.max(targetRung, LADDER_MIN + width));
  return { lo: Math.max(LADDER_MIN, hi - width), hi };
}

/**
 * Reduce the already-computed family panels to the two-tier T1 dial. Only LIVE
 * families count toward L/K/p, so a missing feed (e.g. the dispersion stub) can't
 * fake calm — it is simply excluded, exactly as the flat panel excludes it from
 * its denominator.
 */
export function computeT1Dial(
  families: FamilyPanel[],
  techConfirmerP = 0,
  /** Bubble-arming bit (slow band ≥ ELEVATED) — shifts ONLY `notifyRegime` (÷ARMED_CUT_SCALE);
   *  distinct from the dial's own `armed` field (two-key leading-firing). Default off = no-op. */
  slowArmed = false,
): T1DialResult {
  const byKey = new Map(families.map((f) => [f.key, f]));
  const liveOf = (keys: readonly FamilyKey[]) =>
    keys.map((k) => byKey.get(k)).filter((f): f is FamilyPanel => !!f && f.live);

  const leading = liveOf(LEADING);
  const coincident = liveOf(COINCIDENT);

  // Liveness of the denominator itself (see `pillarsLive`): every pillar family the rung folds
  // over is present and live. Computed from the SAME `byKey` map the fold reads, so it can never
  // disagree with what was actually aggregated.
  const pillarsLive = [...LEADING, ...COINCIDENT].every((k) => byKey.get(k)?.live === true);

  const firingLeaders = leading.filter((f) => bandOf(f).firing);
  const firingCoincident = coincident.filter((f) => f.firing);
  const leadingFiring = firingLeaders.length;
  const coincidentFiring = firingCoincident.length;

  // The two keys. `armed` = an ARM/LEADING family (credit, rates) firing; `fired` = a FIRE/coincident
  // family (volatility, cross-asset, trend) firing. Rungs 7–9 need BOTH (the caps below).
  const armed = leadingFiring > 0;
  const fired = coincidentFiring > 0;

  // DEC-B3 graded floor — the ARM breadth COUNT (`leadingFiring`), not leader depth. The floor rises
  // linearly from LADDER_MIN (no leader firing) to the deepest floor the ladder admits (every leader
  // firing): LADDER_MAX − POSITION_SPAN, so the band top just reaches LADDER_MAX and never overflows.
  // That bound IS the slope — with today's geometry it reduces to 1 + 3·L ⇒ lo ∈ {1, 4, 7}.
  // WHY COUNT, NOT Lg (Finding F): summing coarse contribution let a leader's DEPTH pick the band,
  // while `leadingP` below ALSO reads that same depth to position within it — the double-count. It made
  // an Amber→Red step on one leader jump 3.5 rungs and cross a band. Under breadth, that step moves
  // exactly POSITION_SPAN (one band width, never across bands) BY CONSTRUCTION, not by tuning — in a
  // FIRED world; an unfired step may truncate against ARMED_UNFIRED_CAP (Alt A, W2-b).
  // Do NOT re-transcribe this as `1 + 3·L/2` — the 3 ALREADY contains the /LG_CAP division
  // ((9−1−2)/2 = 3); dividing again halves the slope, caps lo at 4 and makes rungs 8–9 structurally
  // unreachable. `t1dial.test.ts`'s "two RED leaders floor at 7" is the falsifier for that slip.
  // KEEP the /LG_CAP normalization — it IS the ARM-set-size guard, not a comment. LG_CAP derives from
  // LEADING.length, so a THIRD leader RESCALES the floor coherently (1 + 2·L ⇒ {1,3,5,7}) instead of
  // overflowing the ladder. That rescale is a deliberate recalibration and must be eyeballed (D-E3).
  // SCOPE — this closes ONE axis, the ARM-set size. It does NOT make the ladder resizable:
  // `dangerScore` below still divides by a literal 8 (= LADDER_MAX − LADDER_MIN), so raising
  // LADDER_MAX rescales this floor but pushes dangerScore past 1 and pins regimeFor at Crisis.
  // Coincident families never enter L, so a lone coincident spike can NEVER raise the floor.
  const lo =
    LADDER_MIN +
    (LADDER_MAX - LADDER_MIN - POSITION_SPAN) * (Math.min(leadingFiring, LG_CAP) / LG_CAP);

  // coincidentP = mean graded contribution over the live coincident families (firing or
  // not, per §5 step 2: a lone deep-Red confirmer must not jump the position on its own).
  // §3: trend's band-depth contribution is restricted to GT/GB via
  // `coincidentContribution` — F4/F5/F6 add no coincidentP DEPTH (they still fire trend's band role ⇒
  // `fired`/shockFloor). Every other coincident family keeps its full `contribution`; denominator unchanged.
  // STAND-IN AUDIT (OQ-5 Stage 3.2, fix shipped): absence PROPAGATES and is EXCLUDED, never
  // defaulted. `coincidentContribution` returns null when the trend family carries NEITHER GT nor
  // GB (§3's members are simply not observed); the pre-fix `?? 0` kept that family in the
  // DENOMINATOR while adding 0 to the numerator, so an unobserved trend regime was averaged in as
  // "no danger" and DILUTED the within-band position. It is now dropped from BOTH numerator and
  // denominator — the exact analogue of `familyShare`'s unobserved-member exclusion (danger-share.ts), the correct-exclusion
  // precedent (ruled OK in Stage 3.1). All-null (or no live coincident) ⇒ 0, the empty-set value.
  const contribs = coincident
    .map((f) => coincidentContribution(f))
    .filter((c): c is number => c !== null);
  const coincidentP =
    contribs.length === 0 ? 0 : contribs.reduce((sum, c) => sum + c, 0) / contribs.length;

  // leadingP = §5-step-2 tiebreak. The band is already chosen by leading BREADTH; within
  // it, a firing leader positions by depth ABOVE the amber floor: `(g − AMBER)/(RED − AMBER)`
  // → an AMBER leader adds 0 (band floor: it only just qualified), a deep-RED leader adds 1
  // (band top: about to escalate). Mean over the FIRING leaders only (a green leader is
  // irrelevant to the band it didn't help select). This is what makes AMBER ≠ RED.
  const leadingP =
    leadingFiring === 0
      ? 0
      : // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `firingLeaders` is filtered to FIRING families and
        // firing ⇒ live ⇒ `contribution` non-null, so this is an unreachable type guard whose
        // fallback (AMBER) contributes exactly 0 depth anyway.
        firingLeaders.reduce(
          (sum, f) => sum + ((bandOf(f).contribution ?? AMBER) - AMBER) / (RED - AMBER),
          0,
        ) / leadingFiring;

  // D6 (§6) — legP deepens the ● by the worst per-family DANGER_POWER-mean of LEG-ONLY members
  // (rowed & NO_ARM-or-not-in-bandOf.ids, never PER_LEG_ONLY_MEMBERS); enters positionP ONLY.
  const legContribution = (s: State) => (s === "RED" ? RED : s === "AMBER" ? AMBER : 0);
  const legFamilyP = (f: FamilyPanel): number | null => {
    const bandIds = bandOf(f).ids;
    const legOnly = f.members.filter(
      (m) =>
        LEG_WEIGHTED_IDS.has(m.id) &&
        !PER_LEG_ONLY_MEMBERS.includes(m.id) &&
        (NO_ARM_FAMILIES.includes(f.key) || !bandIds.includes(m.id)),
    );
    // OQ-5 correct-exclusion: a family with no leg-only member is dropped from BOTH num and den.
    if (legOnly.length === 0) return null;
    const mean =
      legOnly.reduce((sum, m) => sum + legContribution(m.state) ** DANGER_POWER, 0) / legOnly.length;
    return mean ** (1 / DANGER_POWER);
  };
  const legPerFamily = liveOf([...LEADING, ...COINCIDENT, ...NO_ARM_FAMILIES])
    .map(legFamilyP)
    .filter((v): v is number => v !== null);
  const legP = legPerFamily.length === 0 ? 0 : Math.max(...legPerFamily);

  // within-band position: MAX of leadingP, coincidentP, techConfirmerP and legP (L1 Stage 2 — max
  // REPLACES the probabilistic OR, so multiple moderate inputs no longer saturate upward; still
  // monotone and ∈ [0,1]). Each is a within-band deepener only — like coincidentP none can select a
  // higher band. techConfirmerP defaults to 0, collapsing to the leader/coincident/leg form.
  const positionRaw = Math.max(leadingP, coincidentP, techConfirmerP, legP);
  // No valuation deepening (the W1-k/`mEff` amplifier is retired, ruled O2 2026-08-11) —
  // valuation's one danger home is the `ECY` danger-engine member.
  const positionP = positionRaw;

  // Rung pipeline (order normative): floor + within-band position, then the graded systemic bump,
  // then the two-key caps, then the graded unprimed floor, then cap 9.
  // Graded systemic bump: cross-asset AMBER→+0.5 / RED→+1, gated on ≥1 OTHER ARM∪FIRE family
  // firing (cross-asset ∈ COINCIDENT, so exclude it from its own gate) — isolated cross-asset
  // breadth is a rotation, not systemic. Pre-cap, so an unprimed dial still tops at UNARMED_CAP.
  const xa = byKey.get("cross-asset");
  const otherFiring = [...firingLeaders, ...firingCoincident].some((f) => f.key !== "cross-asset");
  const systemicBump =
    !xa?.live || !otherFiring
      ? 0
      : xa.state === "RED"
        ? SYSTEMIC_BUMP_RED
        : xa.state === "AMBER"
          ? SYSTEMIC_BUMP_AMBER
          : 0;
  let rung = lo + POSITION_SPAN * positionP + systemicBump;

  // Two-key caps: unfired can't exceed rung 5, unprimed can't exceed rung 3 — so 7–9 need both keys.
  if (!fired) rung = Math.min(rung, ARMED_UNFIRED_CAP);
  if (!armed) rung = Math.min(rung, UNARMED_CAP);

  // DEC-B4(i) graded UNPRIMED FLOOR — the shock override was never a cap, it was the unprimed floor,
  // and it has the ARM floor's shape, reshaped CONVEX (Increment B, 2026-07-22): rise from LADDER_MIN
  // at zero coincident RED breadth to the deepest reach the model admits (SHOCK_RUNG) at full breadth,
  // normalized by COINCIDENT.length and raised to γ = SHOCK_CONVEXITY.
  // ⇒ shockFloor ∈ {1, 1.56, 3.22, 6} for r = 0…3. Endpoints are invariant under any γ; the linear
  // {1, 2.67, 4.33, 6} middle is COOLED to encode super-additive systemic stress (CISS/OFR-FSI),
  // softening the r=1/r=2 over-reaction the linear form flagged for eyeball.
  // Applied UNCONDITIONALLY after the two-key caps (do NOT fold it into `lo` — that would move
  // `band.lo` and change what the band MEANS for the shock world, which no ruling asked for). At
  // r = 0 the floor is inert (rung ≥ LADDER_MIN always), which is what lets the `if` branch go; at
  // r = F it reproduces the retired boolean override EXACTLY, so that override becomes an endpoint
  // rather than a hatch.
  // PREDICATE IS RED, NOT FIRING — the one place the two floors are deliberately NOT symmetric, and
  // the asymmetry is load-bearing: the ARM floor's predicate is `firing` because LG_CAP is a set size;
  // this floor's is RED because SHOCK_RUNG is ratified at RED. Absent feed ⇒ not counted (`coincident`
  // is already live-filtered) against the FIXED denominator F, per "absent feeds drop toward
  // under-reaction, never a false escalation".
  // TWO-KEY INVARIANT BY CONSTRUCTION: r ≤ F ⇒ shockFloor ≤ SHOCK_RUNG = 6 < 7, so rungs 7–9 remain
  // reachable only via `armed && fired`. That is an ARITHMETIC bound — strictly stronger than the
  // boolean branch it replaces. Retires the old M6/P3 VT partial band-selection, which could let a
  // coincident family set `armed` and breach the invariant.
  // THIS RAISES THE UNPRIMED CEILING from a flat UNARMED_CAP=3 to max(UNARMED_CAP, shockFloor(r)) =
  // {3, 3, 3.22, 6} — DEC-B4(i)'s literal ask ("a cap that rises with firing-coincident breadth"),
  // convex per Increment B. At r=1 the floor (1.56) now sits BELOW the computed base, so the base binds
  // and the floor is inert there too (only r ≥ 2 lifts the ceiling).
  // The pre-DEC-B4(i) property "an unprimed dial can NEVER leave the Calm band" is therefore RETIRED at r ≥ 2
  // (3.22 > the Calm cut at rung 3): a coincident-only world can now reach Caution — but never the
  // two-key 7–9.
  const coincidentRed = coincident.filter((f) => f.state === "RED").length;
  const shockFloor =
    LADDER_MIN + (SHOCK_RUNG - LADDER_MIN) * (coincidentRed / COINCIDENT.length) ** SHOCK_CONVEXITY;
  rung = Math.max(rung, shockFloor);

  // Headline/display only — the r = F endpoint, i.e. exactly the world the retired boolean named.
  // Kept as a field because `"+ shock"` reads it; nothing outside this file's headline consumes it.
  const shockOverride = coincidentRed === COINCIDENT.length;

  rung = Math.min(rung, LADDER_MAX);

  // Single-sourced via `rungCut` (families.ts) since W3-c §6 — the notify cuts are
  // expressed as rung boundaries through the SAME helper, so the score and the cuts
  // cannot drift onto different spans. Do not re-inline the `/8`.
  const dangerScore = rungCut(rung);
  const targetRung = targetRungFor(dangerScore);

  // Crisis gate (L1 Stage 5) — the rule and its consequences live on `applyCrisisGate` above; here
  // we only resolve the two family facts it reads off THIS run's panel.
  const isFiring = (k: FamilyKey, firingOf: (f: FamilyPanel) => boolean = (f) => f.firing) => {
    const f = byKey.get(k);
    return !!f && f.live && firingOf(f);
  };
  // S4 ruling: the credit key reads its BAND role — a lone per-leg-only member (F10/F13)
  // firing no longer holds Crisis. The gate is demote-only, so this can only ever LOWER the band.
  const creditFiring = isFiring("credit", (f) => bandOf(f).firing);
  const volatilityFiring = isFiring("volatility");

  const regime = applyCrisisGate(regimeFor(dangerScore), creditFiring, volatilityFiring);
  // K1 `slowArmed` shift: score < c·f ⟺ score/f < c, so ÷ARMED_CUT_SCALE scales every notify cut ×f —
  // re-gated through the SAME crisis gate; the display `regime` axis is deliberately unshifted.
  const notifyRegime = applyCrisisGate(
    notifyRegimeFor(slowArmed ? dangerScore / ARMED_CUT_SCALE : dangerScore),
    creditFiring,
    volatilityFiring,
  );

  // W3-b Stage 3.5 + D5 (2026-07-22) — the emitted band's WIDTH is DISAGREEMENT on EITHER axis: the
  // MAX of leader disagreement and coincident disagreement, not the ARM floor.
  // Measure: `firingSplit` (Gini/2-normalised) applied to each axis, chosen as option C over the
  // plan's two rejected candidates (§1.1): (A) a DEPTH SPREAD `max(c) − min(c)` over coarse
  // contributions, and (B) a RAG DISAGREEMENT COUNT (1 iff the live families are not all in the same
  // RAG state). A fixed width was never a candidate at all — §7 puts "any minimum-width constant"
  // out of scope, and §1 forbids fitting a width constant to the hand-built scenario worlds.
  // C is the only one that reads "how much do the families agree?" while staying depth-BLIND, which
  // keeps Finding F (the depth double-count) closed on BOTH axes: neither split reads `contribution`,
  // so depth moves the ● (`targetRung`), never the width.
  //   coincident axis (D5): a coincident-only shock raises `hi` (via `targetRung`) but used to add 0
  //   to the width, pinning the band to a POINT exactly when a LONE, uncorroborated coincident mover
  //   should instead admit lighter legs. `firingSplit(coincident)` fixes that; an ALL-agree coincident
  //   set (a broad, corroborated shock) still splits to 0 ⇒ no downward slack, correctly.
  //   width = POSITION_SPAN + round(max(leaderSplit, coincidentSplit)) ∈ {2,3} rungs — a fully-split
  //   set on EITHER axis widens by one rung over the 2-rung floor, so the band ALWAYS spans 3–4 legs.
  //   hi = min(LADDER_MAX, max(targetRung, LADDER_MIN + width)). At calm targets (targetRung <
  //   LADDER_MIN + width) hi floats UP off the ●, admitting MORE-DEFENSIVE legs — the ● is `targetRung`,
  //   NOT `hi`. At primed rungs (targetRung ≥ LADDER_MIN + width) hi = targetRung, so the two-key bound
  //   (rungs 7–9 need primed AND fired) still binds the EMITTED band there.
  //   lo = max(LADDER_MIN, hi − width) — widening admits lighter legs; at calm targets lo pins at r1.
  // The DEC-B3 ARM floor (`lo` above) has NOT gone away: it still SELECTS the band by feeding
  // `rung`/`targetRung`. Its falsifiers therefore now live on the `rung` pins in t1dial.test.ts,
  // not on `band.lo` (Stage 3.4 re-anchor).
  // TWO DENOMINATORS, deliberately: the ARM floor normalises by `LG_CAP` — the ARM *set* size, a
  // calibration constant. Each split normalises by its axis's `nLive` — the count of families
  // actually LIVE, an observation count, because a dropped channel cannot corroborate anything.
  // S4 ruling: the MAX of the band-role split and
  // the unrestricted one. Routing the width wholly through `bandOf` is NOT direction-safe: at
  // LG_CAP = 2 the Gini is 1 at exactly one firing leader and 0 at zero or two, so a credit firing
  // carried only by a per-leg member would drop the split 1 → 0 and RAISE `lo` by POSITION_SPAN.
  // Under the max it can only ever widen.
  //
  // ⚠ **The two arms are provably IDENTICAL today, and have been since D1** (2026-08-20).
  // D1 set `f.firing = bandOf(f).firing` on every
  // producer (`families.ts`), so `firingSplit(leading)` and `firingSplit(leading, bandOf-firing)`
  // read the same predicate and the unrestricted arm contributes nothing. The case this docblock
  // names — a credit firing carried only by a per-leg member — CAN NO LONGER OCCUR: a member the
  // band does not seat no longer fires its family at all. The earlier wording here said "neither arm
  // is redundant"; that is retired, and its silent falsification is what let the resulting band
  // narrowing ship unnoticed (§5: `{lo 4, hi 6}` → `{lo 6, hi 6}` on a high-`targetRung` panel).
  //
  // **KEEP the max and both arms anyway.** `bandOf` is the Stage-1 seam's contract (see its
  // definition above), the identity holds only while every producer keeps `firing` band-derived, and
  // the direction-safety argument above is the reason the max — not the `bandOf` arm alone — is the
  // safe collapse if that ever changes. Identical *today, by D1* ≠ the split is dead. The emitted
  // band is pinned whole (`t1dial.test.ts`, the §5 frozen-literal `T1DialResult` pin), so a future
  // change that re-separates the arms announces itself there.
  const split = Math.max(firingSplit(leading), firingSplit(leading, (f) => bandOf(f).firing));
  const coincidentSplit = firingSplit(coincident);
  const band: Band = dialBandFor(targetRung, Math.max(split, coincidentSplit));

  const familyList = (fs: FamilyPanel[]) => fs.map((f) => f.key).join(", ");
  // ⚠ The word this template emits is single-sourced with {@link restateDialVocabulary}'s read-time
  // restatement — a change here without a change there leaves persisted rows reading the old word.
  const headline =
    `${armed ? `primed (${familyList(firingLeaders)})` : "unprimed"} + ` +
    (fired ? `fired (${familyList(firingCoincident)})` : "unfired") +
    `${shockOverride ? " + shock" : ""} → ${regime}, rung ${targetRung}`;

  return {
    leadingFiring,
    coincidentFiring,
    band,
    leadingP,
    coincidentP,
    techConfirmerP,
    legP,
    positionP,
    armed,
    fired,
    shockOverride,
    systemicBump,
    rung,
    dangerScore,
    targetRung,
    regime,
    notifyRegime,
    headline,
    pillarsLive,
    // EARLY-WARN sub-signal is stamped by assembleDial (it reads the persisted fast-break rows, which
    // are NOT panel members since D-D). The pure fold cannot see them ⇒ always false here.
    fastBreakEW: false,
    graded: "coarse",
  };
}

/**
 * Hydrate-or-compute: the "compute once, read once" seam (2026-07-21 persist-assembled-dial C1).
 *
 * `computeT1Dial` is now run ONCE on the notify path (`assembleDial`, run-cycle-dial.ts) and the WHOLE
 * `T1DialResult` is persisted to `alert_log.dial_state`. The live `/lab` read path serves the
 * PERSISTED dial verbatim — so the emitted dial is definitionally the pushed dial, not an
 * independent recompute that can drift. When `dialState` is present it is returned untouched
 * (hydrate); when it is `null`/`undefined` (a legacy pre-migration row, or the `?s=` what-if
 * scenario which has no persisted row) it falls back to a fresh `computeT1Dial(...)`.
 *
 * The recompute args mirror `computeT1Dial` exactly. Pure/synchronous — never touches the store.
 *
 * ⚠ **The dial headline is PERSISTED in `dial_state` jsonb** and `hydrateOrComputeT1Dial` restates its
 * vocabulary on READ (`restateDialVocabulary`) — never "fix" it into a full recomposition.
 */
export function hydrateOrComputeT1Dial(
  dialState: T1DialResult | null | undefined,
  families: FamilyPanel[],
  techConfirmerP = 0,
): T1DialResult {
  if (!dialState) return computeT1Dial(families, techConfirmerP);
  const headline = restateDialVocabulary(dialState.headline);
  return headline === dialState.headline ? dialState : { ...dialState, headline };
}

/** The pre-R5 spelling of `primed`/`unprimed` in a PERSISTED headline, in either polarity. */
const LEGACY_UNPRIMED = /\bunarmed\b/g;
const LEGACY_PRIMED = /\barmed\b/g;

/**
 * R5 read-time restatement (review finding, 2026-07-31): the on-screen dial word must be `primed`
 * even on a row this deploy did not write.
 *
 * `headline` is PERSISTED inside `alert_log.dial_state`, and `/lab` serves the hydrated blob
 * verbatim (see above) — so without this the board head keeps painting the old word on the live row
 * until the next cron write, and forever on every historical row. The R5 ruling's "persisted rows
 * keep the old spelling" carve-out is about the FIELD NAME (`dialState.armed`, the wire), never the
 * rendered sentence, so restating the sentence at read time is in scope.
 *
 * ⚠ Deliberately a restatement of the stored sentence, NOT a recomposition of it. A full re-derive
 * would need the FIRING FAMILY NAMES (`primed (credit, rates)`), and those are not fields of
 * `T1DialResult` — the only source for them at read time is the `families` panel argument, which is
 * built from TODAY's readings while the hydrated dial comes from the served alert ROW. When the last
 * alert row predates today's readings those are two different runs, and mixing them is exactly the
 * cross-run blend `buildLabBand`'s same-row discipline (`pushedBand`/`dialBand`) exists to forbid.
 * Restating the word touches no fact the row asserts, so it cannot blend runs.
 *
 * A freshly computed headline already reads `primed`, so this is a no-op there (identity-preserving:
 * the same object is returned when nothing changes — pinned by `probe-dial-roundtrip`'s arm A
 * ref-equality check; the old hydrate-equals-recompute oracle was retired 2026-08-16).
 */
export function restateDialVocabulary(headline: string): string {
  return headline.replace(LEGACY_UNPRIMED, "unprimed").replace(LEGACY_PRIMED, "primed");
}
