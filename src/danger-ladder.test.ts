import { describe, expect, it } from "vitest";
import {
  FAMILY_LEG_WEIGHT,
  FAMILY_MEMBERS,
  LEG_FIELD,
  MEMBER_LABEL,
  MEMBER_WEIGHT,
  SIGNALS,
  TIMING_CLASS,
  SIGNAL_HOLD_CLOSES,
  signalHoldClosesFor,
  type SignalKey,
  type LegKey,
} from "./danger-ladder.js";
import { LADDER } from "./families.js";
import { MEMBER_HISTORY_WINDOW } from "./danger-member-state.js";
import { ALL_INDICATORS } from "./registry.js";
import { LOOKBACK } from "./danger-deadband.js";

// NOTE: no exemption list, deliberately. The plan called for exempting the STUBBED `vb` row, but that
// is both unnecessary and harmful (review 2026-07-16): `FAMILY_MEMBERS.vb` is [] ⇒ `familyReach("vb")`
// is [] ⇒ vb satisfies the coverage invariant trivially today. An exemption's ONLY effect would be to
// switch the falsifier OFF for vb's future — i.e. for precisely the moment a vb member feed lands and
// someone forgets to fill FAMILY_LEG_WEIGHT.vb, which IS the class of bug this file exists to catch.

/** Union of the legs a family's members actually reach (non-zero `MEMBER_WEIGHT` support). */
function familyReach(family: SignalKey): string[] {
  const legs = new Set<string>();
  for (const member of FAMILY_MEMBERS[family] ?? []) {
    for (const [sleeve, weight] of Object.entries(MEMBER_WEIGHT[member] ?? {})) {
      if (weight > 0) legs.add(sleeve);
    }
  }
  return [...legs].sort();
}

/** The families whose `FAMILY_LEG_WEIGHT` row is actually READ — the population both invariants below
 *  run over. Narrowed by the REASON, not by a bare exclusion list (2026-08-02):
 *
 *  `gp` is out because its row has NO READER. The table is read only by `pillarShare` (`danger-share.ts`)
 *  for `EARLY-WARN` and `STRESS-NOW`, and through `computeLegGrowth`'s `GROWTH_SIGNALS`. `gp` is its own EXOGENOUS
 *  super-group and is in none of them, so it never enters the pillar mean and no `gp` weight can
 *  change any number. The row was deleted rather than kept flat; running the pins over it would demand
 *  three dead cells for the 2026-08-02 `OVX` seating and nothing else. (`BRENT` was seated 2026-08-02,
 *  UNSEATED the same day by §7.1, and RE-SEATED 2026-08-06 at ×1.0 — but `OVX` alone reaches all nine
 *  legs in every one of those states, so the three dead cells the pins would demand are unchanged
 *  throughout.)
 *
 *  ⚠ `uT` IS NOT THE SAME CASE and is deliberately still in. It shares "out of the L2 danger mean" with
 *  `gp` and NOTHING else: `computeLegGrowth` (`src/growth.ts`) resolves `familyLegWeight("uT", sleeve)`
 *  on every leg, and `run.alert-state.test.ts`'s held-sleeve push expectation turns on `FAMILY_LEG_WEIGHT.uT`'s
 *  `EU-Fin` cell having raised that leg's `LegRow.danger`. A missing `uT` cell therefore throws in
 *  production, which is precisely the class these pins exist to catch statically. The exemption is
 *  grounded in READERSHIP — do not widen it to "families outside the mean". */
const ROW_READ: readonly Exclude<SignalKey, "gp">[] = SIGNALS.filter(
  (f): f is Exclude<SignalKey, "gp"> => f !== "gp",
);

describe("FAMILY_LEG_WEIGHT reach coverage", () => {
  // ⚰️ TOMBSTONE — "every reader-family HAS a row" (Slice 1, 2026-08-02) DELETED the same day by
  // Slice 2, and NOT because it was inconvenient: the type it stood in for is back, strictly
  // stronger. Slice 1 had to widen `FAMILY_LEG_WEIGHT`'s outer key to `Partial<Record<SignalKey, …>>`
  // to delete the `gp` row, which legalised ANY dropped row, so the pin re-asserted totality at
  // runtime. Slice 2 tightened the key to `Record<Exclude<SignalKey, "gp">, …>`, so BOTH halves of
  // that pin are now compile errors rather than test failures:
  //   • a dropped reader-family row  → "Property 'rt' is missing in type … Record<…>"
  //   • a restored `gp` row          → excess-property error at the object literal
  // A runtime re-assertion would be vacuous by construction (it can only fail if `tsc` already did),
  // and `FAMILY_LEG_WEIGHT.gp` no longer even typechecks as an expression. Verified by mutation,
  // both directions, before deletion. If the key is ever widened back to `Partial`, restore the pin
  // in the SAME commit — the two invariants below go vacuously green without it (`familyReach`
  // filtered against an empty object, `Object.keys({})`).

  // THE CLASS FALSIFIER (2026-07-16). Historically `familyLegWeight` returned `?? 1` for any live
  // cell the row omitted — an omission was not inert, it silently asserted MAXIMUM within-leg
  // importance. W5 Stage 5.1 killed that default: a SENSITIVE cell the row omits is now a hard
  // throw. This test keeps its full value under both regimes — it catches the omission STATICALLY,
  // in the table, before the runtime throw can ever reach prod (and the old silent-1.0 damage is
  // exactly why a static catch is worth having).
  // The silent form was invisible until it reordered the board: `mc` omitted EU-Fin/Health/Staples (then reached by
  // F14, not F12 — F14 has since been retired, DEC-19 2026-07-17, but the class stands and this is
  // the incident that surfaced it), so with F14 RED all three sat at EW 0.04 and outranked S&P IT.
  // A row must therefore
  // list every leg its members reach; extra keys are harmless (an `na` cell is dropped from the
  // mean anyway), so the invariant is one-directional: row keys ⊇ member reach.
  it.each(ROW_READ)(
    "%s lists every leg its members reach",
    (family) => {
      const missing = familyReach(family).filter((leg) => !(leg in FAMILY_LEG_WEIGHT[family]));
      expect(
        missing,
        `FAMILY_LEG_WEIGHT.${family} omits ${missing.join(", ")} - familyLegWeight() THROWS on a ` +
          `sensitive cell it cannot find (W5 Stage 5.1 killed the silent ?? 1 default), so the danger ` +
          `scalar would fail outright for these legs. Add an explicit weight (or 0 if truly irrelevant).`,
      ).toEqual([]);
    },
  );

  // The MIRROR of the coverage invariant (2026-07-16 sweep): a row listing a leg NO member reaches.
  // Inert for the math (the cell is `na` → dropped from the mean regardless of weight) but it rots
  // exactly like the two stale comments did — it read as "mc weighs S&P 500" when mc never touched
  // it. Allowlisted rather than deleted so a NEW dead key is caught; shrink the list, never grow it.
  //
  // NOW EMPTY (2026-07-17) — the list's intended end state, reached rather than asserted. Its only
  // ever entry was `mc`, which ballooned to all 5 legs when F12/F14/F15 were retired and then went
  // to zero when the `mc` row and key were deleted outright. Every surviving row is exactly
  // reach-covered, so the invariant below now runs with NO exemptions. Keep it empty.
  const KNOWN_DEAD: Readonly<Record<string, readonly string[]>> = {};

  // Runs over `ROW_READ` for the same reason as its sibling above: `gp` has no row to carry a dead key.
  it.each(ROW_READ)("%s lists no unreached (dead) leg", (family) => {
    const reach = new Set(familyReach(family));
    const dead = Object.keys(FAMILY_LEG_WEIGHT[family]).filter((leg) => !reach.has(leg));
    expect(dead.sort()).toEqual([...(KNOWN_DEAD[family] ?? [])].sort());
  });

  it("LEG_FIELD's sleeve list IS `LADDER`, in order - the one drift `tsc` cannot see", () => {
    // Stage 0 (2026-07-31) narrowed both weight tables' inner key to the `LADDER` union, so a
    // misspelled leg cell is now a compile error. `LEG_FIELD.sleeve` is still plain `string`,
    // however, and it carries its OWN hand-typed copy of the nine names — `ALL_LEGS` /
    // `MEMBER_RELEVANCE` / `familyReach` all derive from it, and `danger-ladder.ts`'s
    // `row[s as LegKey]` casts that string straight past the compiler.
    //
    // So renaming a sleeve in `LADDER` but not here (or the reverse) silently drops that rung from
    // every reach derivation with `tsc` green and, before this pin, the whole suite green. Found in
    // the Stage 0 review; it guarded the rung-7 rename to `EU-Fin`, which landed two stages later.
    expect(LEG_FIELD.map((l) => l.sleeve)).toEqual([...LADDER]);
  });

  it("keeps each leg's column normalized - the top live-in-mean family is exactly 1.0", () => {
    // The table's own stated invariant: "column-normalized so each leg's top LIVE family = 1.0 →
    // carries NO absolute scale". uT (confirming gate) + gp (exogenous — a per-leg weighted `max`
    // term since C1 2026-08-02, not an overlay) left the L2 mean,
    // so they are excluded here. A weight edit that demotes a column leader without promoting a
    // replacement would silently rescale that leg's whole danger mean.
    const IN_MEAN: readonly Exclude<SignalKey, "gp">[] = ["cr", "rt", "vb", "vl", "xa"];
    for (const leg of LEG_FIELD.map((l) => l.sleeve)) {
      const live = IN_MEAN.filter((f) => familyReach(f).includes(leg));
      const weights = live.map((f) => FAMILY_LEG_WEIGHT[f][leg as LegKey] ?? 1);
      expect(Math.max(...weights), `leg ${leg} has no live family at weight 1.0`).toBe(1);
    }
  });

  // DELETED 2026-07-17, the THIRD premise-death in this slot in one day — none bent to green:
  //  1. "mc reaches the three defensive legs via F14" died when F14 was retired (DEC-19); it was
  //     replaced by "mc reaches exactly F12's legs now that F14/F15 are retired".
  //  2. That replacement died hours later — F12 was retired (DEC-21), leaving mc with NO members,
  //     so "the legs F12 reaches" was not a smaller set but an undefined question. It was replaced
  //     by "mc is MEMBERLESS by construction — it reaches nothing" (`FAMILY_MEMBERS.mc` == [],
  //     `familyReach("mc")` == []), which became the falsifier.
  //  3. That pin has now died too: the `mc` key was removed from `SignalKey`, so
  //     `FAMILY_MEMBERS.mc` and `familyReach("mc")` no longer typecheck — the assertion is
  //     unconstructible, and its claim is enforced by the type system instead (strictly stronger).
  // The CLASS all three guarded (a row omitting a reached leg → silent `?? 1` MAXIMUM within-leg
  // importance; since W5 Stage 5.1 a hard throw instead) remains fully covered by the two it.each
  // invariants above, which now run over the 7 surviving keys with an EMPTY exemption list.
});

describe("MEMBER_LABEL derivation", () => {
  // ⛔ THE R2/R4 SHAPE-MATCH PIN (2026-08-03) IS GONE — DELETED 2026-08-04, NOT WEAKENED.
  // It asserted `MEMBER_WEIGHT.R2` deep-equals `MEMBER_WEIGHT.R4`, pinning the then-ruled state.
  // A ruling (Option A) deliberately RE-DIVERGED the rows on `Semis`, and
  // the deleted test's own docblock instructed exactly this: "a future ruling that deliberately
  // RE-DIVERGES the rows DELETES this test. It must never be satisfied by editing the rows back into
  // agreement." Do NOT restore it, and do NOT replace it with a "differs on exactly one leg" pin — the
  // rows are independent priors again, and a pin over their relationship is the thing §4 removed.
  // What SURVIVES the deletion is the 9-leg completeness check, which was the deep-equal's non-vacuity
  // anchor and is load-bearing on its own: `MEMBER_WEIGHT.R2` is one of the sparse-by-design rows that
  // must NOT be sparse (R2/R4 reach every sleeve), and `Partial` legalises omission, so the TYPES do
  // not catch a dropped cell. It is not the only thing that would: `capture-core9-baseline.snapshot.json`
  // serialises `MEMBER_WEIGHT` verbatim and `capture-core9-baseline.test.ts` deep-compares live against
  // committed, so a deleted cell reds there too — but as a snapshot DRIFT ("regenerate me"), which a
  // regeneration silently blesses. This assertion is the one that states the INVARIANT, so it survives a
  // regeneration. `?? {}` is for the type-checker only — an undefined row yields 0 keys and still reds
  // against 9.
  it("MEMBER_WEIGHT.R2 and .R4 each cover all 9 legs - no cell silently dropped from a Partial row", () => {
    expect(Object.keys(MEMBER_WEIGHT.R2 ?? {}).length).toBe(9);
    expect(Object.keys(MEMBER_WEIGHT.R4 ?? {}).length).toBe(9);
  });

  // The Indicator-detail leg picker (public/detail-tab.js) orders its options by the FIRST-SEEN key
  // union over the served `memberWeight` rows, and the ETFs picker group (families.ts
  // `CARD_ONLY_GROUPS.pension-drawdown`) is ordered to match it via `LADDER`. That only holds while
  // the first row(s) list the legs in rung order — a sparse row inserted above R1, or R1's keys
  // reordered, would silently reshuffle the leg picker. Same derivation as detail-tab.js.
  it("the first-seen MEMBER_WEIGHT key union is LADDER order (the leg picker's option order)", () => {
    const legKeys: string[] = [];
    for (const row of Object.values(MEMBER_WEIGHT))
      for (const k of Object.keys(row)) if (!legKeys.includes(k)) legKeys.push(k);
    expect(legKeys).toEqual([...LADDER]);
  });

  // BONOS left the table 2026-09-30 [USER] (card-only, §BONOS) — pinned rowless.
  it("BONOS is rowless", () => {
    expect(MEMBER_WEIGHT.BONOS, "BONOS is card-only — no row, ever, without a new ruling").toBeUndefined();
  });

  // [USER] 2026-10-12: CCC is F1's tail, so it never out-weighs F1 on any leg.
  it("CCC sits at or below F1 on every leg and has a cell on each", () => {
    expect(LEG_FIELD.length).toBeGreaterThan(0);
    for (const { sleeve } of LEG_FIELD) {
      const ccc = MEMBER_WEIGHT.CCC?.[sleeve as LegKey];
      expect(ccc, `CCC.${sleeve} cell`).toBeGreaterThan(0);
      expect(ccc, `CCC.${sleeve} vs F1`).toBeLessThanOrEqual(MEMBER_WEIGHT.F1?.[sleeve as LegKey] ?? 0);
    }
  });

  // [USER] 2026-09-26 (eufin-overlap R2/R3), re-ruled 2026-10-08: UK is EXSH's largest
  // region, the euro curve is a confirmer, BUND's 10y−2y is confirmation-only — provenance §EURC/§BUND.
  it("EU-Fin rates ordering: EURC strictly above BUND", () => {
    const euFin = (id: string) => MEMBER_WEIGHT[id]?.["EU-Fin"] ?? 0;
    expect(euFin("EURC")).toBeGreaterThan(euFin("BUND"));
    expect(euFin("BUND")).toBeGreaterThan(0);
  });

  it("is keyed exactly by the MEMBER_WEIGHT ∪ FAMILY_MEMBERS union - no orphan label", () => {
    const union = [...new Set([...Object.keys(MEMBER_WEIGHT), ...Object.values(FAMILY_MEMBERS).flat()])];
    expect(Object.keys(MEMBER_LABEL).sort()).toEqual(union.sort());
  });

  // THE ROSTER PIN (2026-08-02). The key set used to be `MEMBER_WEIGHT` alone, so a family member with
  // no weight row got NO label — BRENT (row deleted §7 2026-08-02, RE-SEATED 2026-08-06, so it is
  // weighted again today; the pin's live subjects are now T5YIFR and T10YIE, gp siblings, never weighted).
  // `src/feed-lag.ts`'s `freshnessFrom` builds a lag note for every registered feed and `feed-lag-foot.js`
  // falls back to the bare id when `memberLabel[id]` is missing, so BRENT (weekly, lagAfterDays 11)
  // would paint "BRENT" as element text once LATE/DEEP-LAG. Scoped to FAMILY_MEMBERS, NOT `CADENCE_OF`: the
  // registry legitimately carries display-only ids that belong to no family.
  it("labels every FAMILY_MEMBERS roster id, weighted or not", () => {
    const roster = [...new Set(Object.values(FAMILY_MEMBERS).flat())].sort();
    const unlabelled = roster.filter((id) => !MEMBER_LABEL[id]);
    expect(unlabelled).toEqual([]);
    // co-pin the three weightless members by VALUE — the structural check above would also pass on a
    // `?? id` fallthrough, which is exactly the bare-id render this test exists to forbid.
    expect({ BRENT: MEMBER_LABEL.BRENT, T5YIFR: MEMBER_LABEL.T5YIFR, T10YIE: MEMBER_LABEL.T10YIE }).toEqual({
      BRENT: "Brent",
      T5YIFR: "5y5y forward",
      T10YIE: "10y breakeven",
    });
  });

  // Out-of-band VALUE pin: the derivation itself is structural (any `label`-shaped field would
  // satisfy it), so 4 known pairs are typed here to pin WHICH registry field feeds the tooltip.
  // Swapping `.label` → `.longLabel` in danger-ladder.ts, or reverting to the old hand-written
  // table, reds this line. SPCONC is the one that was UNLABELLED before step 4 (it rendered as a
  // bare id in the /lab drill-down); F4/GT/VT are the three loudest renames.
  it("serves the registry's official SHORT name", () => {
    expect({
      F4: MEMBER_LABEL.F4,
      GT: MEMBER_LABEL.GT,
      VT: MEMBER_LABEL.VT,
      SPCONC: MEMBER_LABEL.SPCONC,
    }).toEqual({ F4: "SMH", GT: "ACWI trend", VT: "VIX/VIX3M", SPCONC: "SPY/RSP" });
  });
});

describe("TIMING_CLASS coverage", () => {
  // THE GUARD. `TIMING_CLASS` is
  // HAND-SET and keyed by plain `string` — exactly like `MEMBER_WEIGHT`/`MEMBER_LABEL`, because this repo
  // has NO member-id union type. So `tsc` cannot see a member that never got a class, nor a class key that
  // matches no member. Stage 2's `SIGNAL_HOLD_CLOSES` derives per-member windows from this table, so an
  // unclassified member would silently take whatever the lookup's default turns out to be. These two pins are the ONLY completeness guard the table has; do not weaken
  // either to a subset check.
  const union = () => [...new Set([...Object.keys(MEMBER_WEIGHT), ...Object.values(FAMILY_MEMBERS).flat()])];

  it("is keyed exactly by the MEMBER_WEIGHT ∪ FAMILY_MEMBERS union - no orphan class, no unclassified member", () => {
    expect(Object.keys(TIMING_CLASS).sort()).toEqual(union().sort());
  });

  // The union pin above is structural: it says nothing about whether the keys are REAL. This one closes
  // the second half, over BOTH hand-set tables. `MEMBER_LABEL` is derived from `ALL_INDICATORS[].label`
  // with a silent `?? id` fallthrough: an unmatched MEMBER_WEIGHT id would ship a RAW ID ("SPCONC") as
  // the human name into /api/meta's `memberLabel` and the /lab drill-down tooltip — so the fallthrough
  // must be unreachable. TIMING_CLASS widens the same check to the weightless roster ids.
  it("every MEMBER_WEIGHT and TIMING_CLASS key resolves to a real ALL_INDICATORS id", () => {
    const registered = new Set(ALL_INDICATORS.map((i) => i.id));
    for (const [table, keys] of [["MEMBER_WEIGHT", Object.keys(MEMBER_WEIGHT)], ["TIMING_CLASS", Object.keys(TIMING_CLASS)]] as const) {
      expect(keys.filter((id) => !registered.has(id)), table).toEqual([]);
    }
  });

  // Out-of-band VALUE pin: the three checks above are all structural. These four are the anchors the
  // classification was DERIVED from — each a rationale recorded in `danger-ladder.ts`/the provenance doc
  // (F6 `coin` since 2026-09-02 E4: the `lead` velocity leg fails OOS, §TC.F6; F1 "coincident/lagging",
  // R5/VT "coincident vol", F9's damage over reporting quarters). Re-classifying one of them means
  // overturning its recorded rationale, so it must red here rather than pass silently.
  it("pins the four classes derived from the pre-existing recorded rationales", () => {
    expect({ F6: TIMING_CLASS.F6, F1: TIMING_CLASS.F1, R5: TIMING_CLASS.R5, F9: TIMING_CLASS.F9 }).toEqual({
      F6: "coin",
      F1: "coin",
      R5: "coin",
      F9: "lag",
    });
  });

  // Stage 2.1: the table is no longer inert — `signalHoldClosesFor` resolves it into a per-member hold
  // window. This pin is the union pin's SECOND half: it is not enough that every member has a class,
  // every WINDOW must also be reached by some member. An unseated window is a constant nothing
  // exercises. It is also the partition's NON-VACUITY pin: the three windows are distinct, so a table
  // collapsed onto fewer classes seats fewer windows and reds here (no count pin — counts would red on
  // every legitimate re-classification, which is a plan ruling, not a defect).
  it("signalHoldClosesFor seats every SIGNAL_HOLD_CLOSES window across the member union", () => {
    // ← RED DEMO (run 2026-08-04): `signalHoldClosesFor`'s `cls === undefined ? 0 : SIGNAL_HOLD_CLOSES[cls]` →
    // `cls === undefined || cls === "lead" ? 0 : …` (a class that resolves to no window of its own)
    // ⇒ "expected [ +0, 3 ] to deeply equal [ +0, 3, 10 ]".
    const holds = [...new Set(union().map((m) => signalHoldClosesFor(m)))].sort((a, b) => a - b);
    expect(holds).toEqual([...new Set(Object.values(SIGNAL_HOLD_CLOSES))].sort((a, b) => a - b));
  });

  // THE SANITY BOUND, derived from the two
  // constants themselves — never
  // typed. A window at or above the fetched history depth lights its member PERMANENTLY, and the
  // monotonicity invariant in `danger-engine.growth-hold.test.ts` still PASSES in that state (more hold is more
  // lit, forever), so a too-large window is one-sided-verifiable and needs its own bound. Lives here
  // rather than beside the constant because `danger-engine.ts` imports `danger-ladder.ts` and the
  // reverse import would close a cycle; the test file can see both.
  it("bounds every SIGNAL_HOLD_CLOSES window by the history the engine actually has", () => {
    // ← RED DEMO (run 2026-08-04): `SIGNAL_HOLD_CLOSES.lead` 10 → 21 (one close past `LOOKBACK`) ⇒
    // "lead vs LOOKBACK: expected 21 to be less than or equal to 20".
    for (const [cls, h] of Object.entries(SIGNAL_HOLD_CLOSES)) {
      expect(h, `${cls} vs LOOKBACK`).toBeLessThanOrEqual(LOOKBACK);
      expect(h, `${cls} vs MEMBER_HISTORY_WINDOW`).toBeLessThan(MEMBER_HISTORY_WINDOW);
    }
  });
});
