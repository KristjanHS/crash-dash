import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import type { State } from "./domain-types.js";
import { GLOBAL_FAMILIES, US_FAMILIES } from "./families.js";
import {
  pillarValue,
  memberWeight,
  computeCells,
  computeField,
  confirmedRegime,
  quantizeRegime,
  type LegRow,
  type FieldResult,
  type MemberStateMap,
  type MemberFreshness,
  DANGER_CUTS,
  type PillarPair,
  PILLAR_MEMBER_IDS,
} from "./danger-engine.js";
import { isLiveCell } from "./danger-cell.js";
import { buildMemberState } from "./danger-member-state.js";
import { pillarShare, TREND_GATE_FLOOR } from "./danger-share.js";
import {
  FAMILY_LEG_WEIGHT,
  FAMILY_MEMBERS,
  LEG_FIELD,
  MEMBER_RELEVANCE,
  MEMBER_WEIGHT,
  SIGNALS,
  SUPER_GROUPS,
} from "./danger-ladder.js";
import { gf, NON_PILLAR_SUPER_GROUPS, PILLAR_SUPER_GROUPS } from "./danger-engine.test-helpers.js";

describe("PILLAR_SUPER_GROUPS is derived, and non-vacuously so", () => {
  // Premise of the five loops that consume it: an empty roster leaves every one of them vacuously green.
  it("is SUPER_GROUPS minus CONFIRMING/EXOGENOUS, and non-empty", () => {
    expect(PILLAR_SUPER_GROUPS).not.toHaveLength(0);
    // …and the skip set is not aspirational: both skipped names really are super-groups.
    for (const sg of NON_PILLAR_SUPER_GROUPS) expect(SUPER_GROUPS).toContain(sg);
  });
});

describe("held-pick knobs stay DERIVED from DANGER_CUTS (D5, 2026-07-17)", () => {
  // THE POINT (D5): make the stranded-constant bug class structurally impossible. From Stage 1b to
  // 2026-07-17 these were hand-picked 0.3 literals calibrated on the pre-1b ROOT danger scale; when
  // the engine moved to the ~2.4×-colder SQUARED CISS scale they silently stopped firing on prod
  // (fail-toward-aggressive holds on the ntfy path) and CI stayed green for weeks. They must be
  // DECLARED as expressions over DANGER_CUTS: value equality alone is satisfied by a hardcoded
  // `= 0.129`, which is precisely the shape of the original bug.

  // RERISK_DEADBAND (a DISTANCE between two legs' dangers) and CONC_THRESHOLD (an absolute
  // LEVEL on the danger scale) were numerically equal until 2026-08-07 and are semantically
  // different forever; collapsing them into one symbol would silently couple two independent
  // decisions. The declaration checks below pin that both stay separate symbols over DANGER_CUTS.
  // Skipped under `npm run mutate`: Stryker instruments the source text this scan reads.
  it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)("the held-pick knobs are DECLARED over DANGER_CUTS, not as a copied literal", async () => {
    // B4 split (2026-08-15): the knobs now live across the peeled files; sweep all of them so the
    // declaration pin follows the constants rather than going vacuous on the old path.
    const src = (
      await Promise.all(
        ["./danger-engine.ts", "./danger-deadband.ts", "./danger-concentration.ts", "./danger-share.ts"].map((f) =>
          readFile(new URL(f, import.meta.url), "utf8"),
        )
      )
    ).join("\n");
    // `export?` covers MOMENTUM_DIVISOR, which is module-private (display-only, no importer).
    const declOf = (name: string) =>
      src.match(new RegExp(`^(?:export )?const ${name} = (.+);$`, "m"))?.[1];
    // Vacuity guard: the regex must actually find the declarations it claims to inspect.
    // (It fails SAFE: a reformat that breaks the match returns undefined ⇒ red, not green.)
    expect(declOf("RERISK_DEADBAND")).toBeDefined();
    expect(declOf("CONC_THRESHOLD")).toBeDefined();
    expect(declOf("MOMENTUM_DIVISOR")).toBeDefined();
    expect(declOf("RERISK_DEADBAND")).toBe("reriskDeadbandOf(DANGER_CUTS)");
    expect(src).toContain("return cuts.amber / 2;");
    expect(declOf("CONC_THRESHOLD")).toBe("concThresholdOf(DANGER_CUTS)");
    expect(declOf("RERISK_DEADBAND")).not.toBe(declOf("CONC_THRESHOLD"));
    // TREND_GATE_FLOOR is the FOURTH constant of this class — the ramp knee of `trendGateFactor`.
    // Hardcoding `= 0.129` re-strands it exactly as the reviewer's first instinct would.
    expect(declOf("TREND_GATE_FLOOR")).toBeDefined();
    expect(declOf("TREND_GATE_FLOOR")).toContain("DANGER_CUTS.amber");
    // MOMENTUM_DIVISOR (D8) is the third constant of this bug class: hardcoding
    // `Math.sqrt(0.129)` preserves today's value and keeps every test green, then rots
    // silently when the cut moves — as a VALUE failure a maintainer can "fix" by updating
    // the expectation to the hardcoded number, re-stranding it exactly as before.
    expect(declOf("MOMENTUM_DIVISOR")).toContain("DANGER_CUTS.amber");
  });
});

describe("regime quantize + 2-close confirmation fold", () => {
  const P = (ew: number, ewLive: boolean, sn: number, snLive: boolean): PillarPair => ({
    ew: { value: ew, live: ewLive },
    sn: { value: sn, live: snLive },
  });
  // low = < DANGER_CUTS.amber, hi = ≥ it; the 0.1 / 0.4 probes straddle it (premise guarded below).

  it("all four quadrants at the AMBER cut", () => {
    expect([0.1 < DANGER_CUTS.amber, 0.4 >= DANGER_CUTS.amber]).toEqual([true, true]);
    expect(quantizeRegime(P(0.1, true, 0.1, true))).toBe("calm"); // both low
    expect(quantizeRegime(P(0.4, true, 0.1, true))).toBe("deter"); // EW hi, SN lo
    expect(quantizeRegime(P(0.4, true, 0.4, true))).toBe("stress"); // both hi
    expect(quantizeRegime(P(0.1, true, 0.4, true))).toBe("recov"); // EW lo, SN hi
    // Exactly AT the cut counts as hi (≥). DERIVED from the constant, not re-typed: what this line
    // pins is the `>=`-vs-`>` RELATION, which must sit on the live cut to bite at all — a hand-typed
    // edge silently becomes an ordinary interior probe the moment the cut moves (it did, 2026-07-25).
    expect(quantizeRegime(P(DANGER_CUTS.amber, true, 0.1, true))).toBe("deter");
    // …and a hair BELOW the cut is low — the pair is what makes the `>=` boundary non-vacuous.
    expect(quantizeRegime(P(DANGER_CUTS.amber - 1e-9, true, 0.1, true))).toBe("calm");
  });

  it("a non-live pillar counts as LOW", () => {
    // EW hot but SN not live ⇒ SN low ⇒ DETER (not STRESS).
    expect(quantizeRegime(P(0.9, true, 0.9, false))).toBe("deter");
    // both not live ⇒ CALM regardless of stale values.
    expect(quantizeRegime(P(0.9, false, 0.9, false))).toBe("calm");
  });

  it("confirmedRegime: single-close series confirms degenerately (raw = confirmed)", () => {
    expect(confirmedRegime([P(0.4, true, 0.4, true)])).toBe("stress");
    expect(confirmedRegime([])).toBe("calm"); // empty ⇒ calm, never throws
  });

  it("2-close fold: a 1-close blip does NOT flip the confirmed regime", () => {
    // A calm run with a single STRESS blip at the end never adopts stress (needs 2 consecutive).
    const series = [P(0, true, 0, true), P(0, true, 0, true), P(0.4, true, 0.4, true)];
    expect(confirmedRegime(series)).toBe("calm");
    // …but two consecutive STRESS closes DO confirm the flip.
    const flipped = [P(0, true, 0, true), P(0.4, true, 0.4, true), P(0.4, true, 0.4, true)];
    expect(confirmedRegime(flipped)).toBe("stress");
  });
});

describe("computeField - fixture-parity (regression pin for the ported engine)", () => {
  // Fire ONLY F1 (US HY) RED → lit; every other member is ABSENT from the panel. Since OQ-5 Stage
  // 5.2 an absent member is EXCLUDED from its cell's severity max rather than imputed calm — and
  // because 0 is the identity of a max over non-negatives, every hand-derived number below is
  // UNCHANGED. That non-move is the point, not an oversight
  // (the inertness argument).
  const d = gf([{ id: "F1", state: "RED" }]);
  const band = { lo: 1, hi: 3, label: "aggressive" };

  // W0 coverage (F2). EARLY-WARN's capable set is {cr, rt, vb} since the 2026-08-11 ECY seat —
  // capable = 3. All three count LIVE on the F1-RED fixture: cr sensitive-and-lit, rt live-and-calm,
  // and vb SENSITIVE (ECY reaches both defensive legs) with cellState "calm" even fully-unobserved —
  // `isSensitiveState` reads the cellState, which Stage 5.3 A2 deliberately HELD at "calm".
  // Red demo: empty `valuation.ids` ⇒ vb classifies `na` on every leg ⇒ {live: 2, capable: 2} reds this.
  it("computeCoverage pins Health EARLY-WARN at live 3 / capable 3", () => {
    const { legRows } = computeField(d, band);
    const covOf = (sleeve: string) => legRows.find((r) => r.sleeve === sleeve)!.coverage!["EARLY-WARN"];
    expect(covOf("Health")).toEqual({ live: 3, capable: 3 });
  });

  // An observed family with no FAMILY_LEG_WEIGHT entry is a hard error, never a silent 1.0.
  // Red demo: drop the `flw === undefined` throw in `pillarShare` ⇒ no throw.
  it("F-KILL-throw: pillarShare throws on an observed-but-unlisted family (vl×Staples)", () => {
    const vlRow = FAMILY_LEG_WEIGHT.vl! as Record<string, number | undefined>;
    const hadStaples = Object.hasOwn(vlRow, "Staples");
    const orig = vlRow.Staples;
    const vlOnStaples = FAMILY_MEMBERS.vl.find((m) => memberWeight(m, "Staples") > 0)!;
    expect(vlOnStaples).toBeDefined(); // precondition: a vl member reaches Staples, so the family is observed
    delete vlRow.Staples;
    try {
      const state = { [vlOnStaples]: { sev: "lit" as const } };
      expect(() => pillarShare("STRESS-NOW", "Staples", state, 0)).toThrow(/no FAMILY_LEG_WEIGHT entry/);
    } finally {
      if (hadStaples) vlRow.Staples = orig; // restore shared module state
    }
  });

  it("computeCells rolls the now-live uT trend cell calm (all members absent) and the credit cell lit", () => {
    const memberState = buildMemberState(d);
    const semis = LEG_FIELD.find((l) => l.sleeve === "Semis")!;
    const cells = computeCells(semis, memberState);
    const uT = cells.find((c) => c.family === "uT")!;
    // FULLY-UNOBSERVED cell: no uT member is on the panel at all. Its cellState still reports `calm`
    // — HELD by Stage 5.2 and, deliberately, by Stage 5.3's Option A2 too (the state machine is out of
    // that stage's scope). What 5.3 DID change is the severity: `wsev` is now `null`, not a fabricated
    // 0. The census is what makes the fact reachable to a reader.
    expect(uT.cellState).toBe("calm");
    expect(uT.wsev).toBeNull(); // OQ-5 Stage 5.3 — absent ≠ calm at the severity layer
    expect(uT.N).toBe(7); // GT,GB,F4,F5,F6,F8,SPCONC reach Semis (D-D removed DB_SMH → EARLY-WARN sub-signal; NVDA demoted to detail-only 2026-07-22; SPCONC joined trend 2026-07-23)
    expect(cells.find((c) => c.family === "cr")!.cellState).toBe("lit");
    expect(cells.find((c) => c.family === "cr")!.N).toBe(8); // F1,F2,F3,EBP,F13,F10,CQS,CCC reach Semis (CCC seated 2026-10-12, ccc-credit-seat; CQS seated 2026-08-16, Stage 3.1; BONOS unseated 2026-09-30)
  });

  it("a trend-family member RED (F5's new band) reaches the uT worst-of", () => {
    // Stage 2 pin: F5 can now emit RED, so a
    // trend-family RED must light the uT cell — the worst-of that a breadth break drives into the dial.
    const semis = LEG_FIELD.find((l) => l.sleeve === "Semis")!;
    const uTof = (field: State) => {
      const cells = computeCells(semis, buildMemberState(gf([{ id: "F5", state: field }])));
      return cells.find((c) => c.family === "uT")!;
    };
    const lit = uTof("RED");
    expect(lit.cellState).toBe("lit");
    expect(lit.wsev).toBeGreaterThan(0);
    expect(uTof("GREEN").cellState).not.toBe("lit"); // red demo: member GREEN drops uT out of lit
  });

  // ── OQ-5 Stage 5.2 — the two mandated absent/stale tests ──
  // Fixture arithmetic is DERIVED from `memberWeight` (the live cut), never hand-typed; the only
  // literal is `lit ⇒ 1`, which is `SignalCell.wsev`'s own documented contract ("lit→1"), independent
  // of `SEV_NUM` (`danger-member-state.ts`) by design.
  const CR_LEG = "S&P IT"; // unique-argmax credit leg — see the uniqueness guard below
  const crRelevant = FAMILY_MEMBERS.cr.filter((m) => memberWeight(m, CR_LEG) > 0);
  const crLeg = LEG_FIELD.find((l) => l.sleeve === CR_LEG)!;
  const crCellOf = (memberState: MemberStateMap) =>
    computeCells(crLeg, memberState).find((c) => c.family === "cr")!;

  it("Stage 5.2 (a): an ABSENT relevant member is censused as absent and LEAVES the wsev quasi-max", () => {
    // Arrange: every relevant cr member observed `lit`/`fresh` EXCEPT the single heaviest one, which
    // is simply not a key in the map — the OQ-5 §0 definition of ABSENT (feed failed / gap), as
    // opposed to a member the old `memberState[m] ?? "calm"` invented a calm reading for.
    const weights = crRelevant.map((m) => memberWeight(m, CR_LEG));
    const topWeight = Math.max(...weights);
    // Discrimination guard: the omitted member must be the STRICT argmax, else "the max over the
    // remaining" and "the max over all" coincide and the wsev assertion below pins nothing.
    expect(weights.filter((w) => w === topWeight).length).toBe(1);
    const omitted = crRelevant[weights.indexOf(topWeight)]!;
    const memberState: MemberStateMap = {};
    for (const m of crRelevant) {
      if (m === omitted) continue; // ABSENT: no key, not a calm value
      memberState[m] = { sev: "lit", obs: "fresh" };
    }

    // (i) the fact survives the cell layer instead of being destroyed at the max.
    expect(crCellOf(memberState).observed).toEqual({
      fresh: crRelevant.length - 1,
      lag: 0,
      absent: 1,
      deepLag: 0,
      // absentIds NAMES the dark member (the /lab footnote's "what to investigate" list) — always
      // emitted, so `toEqual` also pins totality for the FamilyPanel-precedent optional field.
      absentIds: [omitted],
    });
    // (ii) wsev folds the REMAINING members only: at least their max, below the absent one's weight.
    const remainingXs = crRelevant.filter((m) => m !== omitted).map((m) => memberWeight(m, CR_LEG));
    expect(crCellOf(memberState).wsev!).toBeGreaterThanOrEqual(Math.max(...remainingXs));
    // …and STRICTLY below what the absent member would have contributed had it been HELD at its
    // last lit state (the S-2 misapplication: S-2 holds a STALE reading, never an absent one).
    expect(crCellOf(memberState).wsev!).toBeLessThan(topWeight);
    // N stays the STRUCTURAL relevant count; only the census knows one member never reported.
    expect(crCellOf(memberState).N).toBe(crRelevant.length);
  });

  it("§I9.6 item 3: `deepLag` is a REACHABLE SUBSET of `stale` - the three-way total is untouched", () => {
    // Three stale members, differing only in their lag classification: one dark against its own
    // rhythm (DEEP-LAG), one merely behind (LATE), one never lag-measured at all. Only the first is rot.
    expect(crRelevant.length).toBeGreaterThanOrEqual(4); // the fixture needs 3 stale + ≥1 fresh
    const [rotted, late, unmeasured, ...rest] = crRelevant as [string, string, string, ...string[]];
    const memberState: MemberStateMap = {
      [rotted]: { sev: "lit", obs: "lag", lag: "DEEP-LAG" },
      [late]: { sev: "calm", obs: "lag", lag: "LAG" },
      [unmeasured]: { sev: "calm", obs: "lag" }, // no lag ⇒ plain stale, never an invented "UNKNOWN"
    };
    for (const m of rest) memberState[m] = { sev: "calm", obs: "fresh" };

    const cell = crCellOf(memberState);
    // (i) REACHABLE: rot > 0 — a census that can only ever print 0 would make the marker vacuous.
    expect(cell.observed.deepLag).toBe(1);
    // (ii) a SUBSET, not a fourth bucket: LATE and unmeasured stayed stale-only.
    expect(cell.observed.deepLag).toBeLessThanOrEqual(cell.observed.lag);
    expect(cell.observed.lag).toBe(3);
    // (iii) the pre-existing three-way invariant is UNCHANGED by rot's arrival.
    const { fresh, lag, absent } = cell.observed;
    expect(fresh + lag + absent).toBe(cell.N);
    expect(fresh).toBe(crRelevant.length - 3);
    expect(absent).toBe(0);
  });

  it("Stage 5.2 (b): a STALE member still contributes its held severity (S-2), absent-treatment reds", () => {
    // S-2: a stale reading is HELD AT ITS
    // LAST STATE. So the heaviest member, lit but stale, must still carry the cell — the whole cell
    // goes quiet (wsev 0, cellState calm) the moment `stale` is folded into `absent`.
    const weights = crRelevant.map((m) => memberWeight(m, CR_LEG));
    const topWeight = Math.max(...weights);
    const heaviest = crRelevant[weights.indexOf(topWeight)]!;
    const memberState: MemberStateMap = {};
    for (const m of crRelevant) {
      memberState[m] = m === heaviest ? { sev: "lit", obs: "lag" } : { sev: "calm", obs: "fresh" };
    }
    const cell = crCellOf(memberState);
    expect(cell.observed).toEqual({
      fresh: crRelevant.length - 1,
      lag: 1,
      absent: 0,
      deepLag: 0,
      absentIds: [],
    });
    // The stale member is the ONLY non-calm one: every other member contributes `w × 0 = 0`, so
    // both of these collapse (to `calm` / 0) if stale is treated as absent.
    expect(cell.cellState).toBe("lit");
    expect(cell.M).toBe(1);
    expect(cell.wsev).toBeCloseTo(topWeight, 12);
    expect(cell.wsev!).toBeGreaterThan(0); // non-vacuity: the held severity is a POSITIVE number
  });

  // ── OQ-5 Stage 5.3 — the fully-unobserved cell, Option A2 ──
  // The mutation-sensitive assertion is LAST in each test, so no earlier assertion masks its witness.

  it("Stage 5.3 (a): a FULLY-UNOBSERVED measured cell has NO severity (`wsev: null`) - cellState held", () => {
    // EMPTY member map = every member's feed dark. The A2 scope limit is the point of the first
    // assertion: the CellState machine is byte-identical to pre-5.3 (options B/C —
    // a fourth `CellState` member — were REJECTED), and only the severity goes honest.
    const cell = crCellOf({});
    expect(cell.cellState).toBe("calm"); // HELD — not a new state, not `insensitive`
    // DISCRIMINATION: an OBSERVED calm member still yields a real, scored 0 — so `null` here means
    // "nothing was observed", not "this engine now nulls everything". Without this anchor an
    // implementation that returned `null` unconditionally would satisfy the pin below.
    const oneCalm = crCellOf({ [crRelevant[0]!]: { sev: "calm", obs: "fresh" } });
    expect(oneCalm.wsev).toBe(0);
    // ← RED DEMO (a): `observedWeightedMax`'s `return null` → `return 0` makes this `0`.
    expect(cell.wsev).toBeNull();
  });

  it("trend.value is the uT trend share (`trendShare`, not the cell's max wsev); null when no uT member is observed", () => {
    const empty = computeField(gf([]), { lo: 1, hi: 9 }).legRows[0]!;
    const uT = empty.cells.find((c) => c.family === "uT")!;
    expect(uT.wsev).toBeNull();
    expect(isLiveCell(uT)).toBe(true);
    expect(empty.trend).toEqual({ value: null, counting: false });
    // Semis, GT RED + GB GREEN: share = w_GT / (w_GT + w_GB); the cell's max wsev is w_GT alone.
    const mixed = computeField(gf([{ id: "GT", state: "RED" }, { id: "GB", state: "GREEN" }]), { lo: 1, hi: 9 });
    const semis = mixed.legRows.find((r) => r.sleeve === "Semis")!;
    const share = MEMBER_WEIGHT.GT!.Semis! / (MEMBER_WEIGHT.GT!.Semis! + MEMBER_WEIGHT.GB!.Semis!);
    expect(semis.cells.find((c) => c.family === "uT")!.wsev).not.toBeCloseTo(share, 6); // fixture discriminates
    expect(semis.trend.value).toBeCloseTo(share, 12);
  });

  // DELETED 2026-07-17 — two successive premise-deaths in this slot, neither bent to green:
  //  1. "mc (macro-cycle, NEW 8th family) is a live EARLY-WARN cell on the legs F12 reaches" died
  //     WHOLESALE with F12 (DEC-21): the test fired F12 RED to light mc's cell, asserted mc's N on
  //     Semis, and pinned that a lit mc ENTERS the EW form. With F12 deleted there was no member
  //     to fire, no N to count, and no mc cell to enter anything.
  //  2. Its replacement — "mc is `na` on EVERY leg — a memberless family is out of the mean, not a
  //     calm cell in it" — pinned the distinction the EW denominator is sensitive to (`na` leaves
  //     the denominator; a *calm* cell would stay and dilute). The `mc` key was then removed, so
  //     `computeCells` emits no mc cell at all and `SUPER_GROUP_OF.mc` no longer typechecks: the
  //     "out of the mean" property is now structural — mc is not a cell that is excluded, it is
  //     not a cell. The EW denominator over the surviving keys is covered by the fixture-parity
  //     block above, whose numbers already absorbed mc's departure at Stage 1.2.

  // G1 GATED-TREND CONTRACT (Option C). uT is CONFIRMING: pre-2026-07-21
  // it NEVER entered the danger scalar. It now enters via `gatedTrend`, scaled by `trendGateFactor` over
  // the leg's share EW/SN — 0 with both at 0, partial (can win the max) below the knee. Two halves, both fixtures fixed here:
  // DERIVED — the comment below claims "firing EVERY uT member", which a hand-typed list stops
  // proving the moment a member joins the trend family (SPCONC did, 2026-07-23).
  const uTMembers = [...GLOBAL_FAMILIES.find((f) => f.key === "trend")!.ids];
  const uTRed = () => uTMembers.map((id) => ({ id, state: "RED" as State }));
  const uTcell = (f: FieldResult) =>
    f.legRows.find((r) => r.sleeve === "Semis")!.cells.find((c) => c.family === "uT")!.cellState;

  // (1) GATE CLOSED — on a CALM base (no EW/SN stress) firing every uT member RED is BYTE-IDENTICAL to
  //     the uT-calm base: the gate holds trend to 0. This is ALSO the growth-leak red-demo — a
  //     `1 − growth` leak would floor danger high on aggressive AND na-defensive legs even with no
  //     EW/SN stress, so the equality goes red under any mutation routing growth into the scalar.
  it("gate CLOSED: uT RED is inert on a CALM base (danger/subDangers/held byte-identical; growth-leak demo)", () => {
    const calmBase = computeField(gf([]), band);
    const calmUtRed = computeField(gf(uTRed()), band);
    // The trend term goes unobserved (null) → observed-but-gated (0); every other term is identical.
    const project = (r: LegRow) => ({
      sleeve: r.sleeve,
      danger: r.danger,
      subDangers: { ...r.subDangers, trend: r.subDangers.trend ?? 0 },
      regime: r.regime,
    });
    expect(calmUtRed.legRows.map(project)).toEqual(calmBase.legRows.map(project));
    expect(calmUtRed.legRows.map((r) => r.subDangers.trend)).toEqual(calmUtRed.legRows.map(() => 0));
    expect(calmUtRed.held?.sleeve).toBe(calmBase.held?.sleeve);
    expect(uTcell(calmBase)).toBe("calm"); // non-vacuity: uT state DID change…
    expect(uTcell(calmUtRed)).toBe("lit"); // …yet danger held — the gate closed it
  });

  // The share EW pillar; `null` = no EW family observed on the leg.
  const ewOf = (f: FieldResult, sleeve: string) => pillarValue(f.legRows.find((x) => x.sleeve === sleeve)!.subDangers.earlyWarn);

  // (3) Ledger Trend column: `trend.value` = the raw (ungated) uT read, never zeroed by the gate;
  //     `trend.counting` = `trendGateFactor > 0` — false only where neither pillar is lit.
  const trendRow = (f: FieldResult, sleeve: string) => f.legRows.find((r) => r.sleeve === sleeve)!;

  it("§5 trend column: raw uT read exposed; COUNTING on an EW-stressed leg, gated-off on a calm leg (value never zeroed)", () => {
    const calmUtRed = computeField(gf(uTRed()), band);
    const openUtRed = computeField(
      gf([
        { id: "R4", state: "RED" as State },
        { id: "F1", state: "RED" as State },
        ...uTRed(),
      ]),
      band,
    );
    // CALM leg (Semis under uT-only RED): no EW/SN family observed; uT lit ⇒ a positive raw read, NOT counting.
    const calmSemis = trendRow(calmUtRed, "Semis");
    expect([ewOf(calmUtRed, "Semis"), pillarValue(calmSemis.subDangers.stressNow)]).toEqual([null, null]);
    expect(calmSemis.trend.value!).toBeGreaterThan(0);
    expect(calmSemis.trend.counting).toBe(false); // both pillars 0 → gated off
    // STRESSED leg (S&P IT: R4+F1 RED): EW at/above the ramp knee ⇒ the same raw read, now COUNTING.
    const openIT = trendRow(openUtRed, "S&P IT");
    expect(ewOf(openUtRed, "S&P IT")!).toBeGreaterThanOrEqual(TREND_GATE_FLOOR);
    expect(openIT.trend.value!).toBeGreaterThan(0);
    expect(openIT.trend.counting).toBe(true); // EW clears the floor → the trend deepens danger
    // Value is STABLE across the gate — the calm-base S&P IT carries the same raw wsev, only gated off.
    expect(trendRow(calmUtRed, "S&P IT").trend.value).toBe(openIT.trend.value);
    expect(trendRow(calmUtRed, "S&P IT").trend.counting).toBe(false);
  });
});

// D4/E3: wiring the stamp onto `/lab` is ZERO danger-path change.
describe("computeField - a `freshness` stamp moves the census, never a leg's numbers", () => {
  it("no stamp ⇒ fresh 0 on every cell; a stale/fresh/unassessed stamp lifts it and moves no danger or pillar", () => {
    const ids = Object.keys(MEMBER_RELEVANCE);
    const d = gf(ids.map((id, i) => ({ id, state: (["RED", "AMBER", "GREEN", "AMBER"] as const)[i % 4]! })));
    const mixed: MemberFreshness[] = ids.flatMap((id, i) =>
      i % 3 === 0 ? [{ id, lag: true }] : i % 3 === 1 ? [{ id, lag: false }] : i % 6 === 2 ? [{ id }] : [],
    );
    const band = { lo: 1, hi: 9, label: "all" };
    const fresh = (f: FieldResult) => f.legRows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.observed.fresh, 0), 0);
    const nums = (f: FieldResult) =>
      f.legRows.map((r) => [r.sleeve, r.danger, ...[r.subDangers.earlyWarn, r.subDangers.stressNow].flatMap((p) => [p.kind, pillarValue(p)])]);
    const [without, withMixed] = [computeField(d, band), computeField({ ...d, freshness: mixed }, band)];
    expect(new Set(without.legRows.map((r) => r.danger)).size).toBeGreaterThan(1);
    expect([fresh(without), fresh(withMixed) > 0]).toEqual([0, true]);
    expect(nums(withMixed)).toEqual(nums(without));
  });
});

describe("LegRow.familiesLit — the share arm's per-pillar lit/of counts", () => {
  const ALL_IDS = [...new Set(SIGNALS.flatMap((f) => FAMILY_MEMBERS[f]))];
  const FULL = { lo: 1, hi: 9 };

  it("every member RED ⇒ every leg's observed EW/SN families are all lit; all GREEN ⇒ none", () => {
    const at = (state: State) => computeField(gf(ALL_IDS.map((id) => ({ id, state }))), FULL).legRows;
    const counts = (rows: LegRow[]) => rows.flatMap((r) => [r.familiesLit.earlyWarn, r.familiesLit.stressNow]);
    expect(counts(at("RED")).filter((c) => c.of === 0 || c.lit !== c.of)).toEqual([]);
    expect(counts(at("GREEN")).filter((c) => c.of === 0 || c.lit !== 0)).toEqual([]);
  });
});

describe("PILLAR_MEMBER_IDS (served dangerRoster.pillarIds) is the engine's real fold roster", () => {
  it("a member lit RED alone moves some leg's EW/SN pillar, uT trend or gp exogenous term iff it is in the set", () => {
    // Universe = every id a board or weight table can show, not just the fold's own input.
    const ALL = [...new Set([...GLOBAL_FAMILIES, ...US_FAMILIES].flatMap((f) => f.ids).concat(Object.keys(MEMBER_WEIGHT), SIGNALS.flatMap((f) => FAMILY_MEMBERS[f])))];
    const FULL = { lo: 1, hi: 9 };
    const parts = (r: LegRow) => [
      pillarValue(r.subDangers.earlyWarn),
      pillarValue(r.subDangers.stressNow),
      ...r.cells.filter((c) => c.family === "uT" || c.family === "gp").map((c) => c.wsev),
    ];
    const world = (lit: string | null) =>
      computeField(gf(ALL.map((id) => ({ id, state: (id === lit ? "RED" : "GREEN") as State }))), FULL).legRows.map(parts);
    const base = JSON.stringify(world(null));
    const inSet = new Set(PILLAR_MEMBER_IDS);
    const wrong = ALL.filter((id) => (JSON.stringify(world(id)) !== base) !== inSet.has(id));
    expect(wrong).toEqual([]);
    // Non-vacuity on both arms: a named rowless family member and a SLOW display leg sit outside, F1 inside.
    expect(ALL.filter((id) => !inSet.has(id))).toEqual(expect.arrayContaining(["R8", "price-accel", "NVDA"]));
    expect(inSet.has("F1")).toBe(true);
  });
});
