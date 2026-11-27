/**
 * Tests for the 6-family danger panel (src/families.ts) — the graded per-family
 * state/contribution, the stub-excluded denominator, and the breadth counts the
 * board shows. The flat magnitude/veto roll-up (dangerScore/targetRung/heldRung/
 * vetoPath/regime) was retired with the flat /lab engine; the score→rung/regime
 * mapping now lives on the T1 dial (src/t1dial.test.ts).
 */
import { describe, expect, test } from "vitest";

import {
  computeFamilyPanel,
  computeFamilyPanelFromStates,
  US_FAMILIES,
  GLOBAL_FAMILIES,
  DASHBOARD_FAMILIES,
  familyOf,
  applyFamilyCarry,
  COINCIDENT_TREND_MEMBERS,
  diffusionLabel,
  LADDER,
  rungOfSleeve,
  canonicalSleeve,
  tradingDaysBetween,
  CARRY_MAX_TRADING_DAYS,
  type FamilyDef,
  type FamilyPanel,
  type LastKnownFamily,
} from "./families.js";
import { SIGNAL_OF } from "./families.js";
import { CONFIRM_TIERS, confirmClosesFor } from "./families.js";
import { cardGroupOf, CARD_ONLY_GROUPS } from "./families.js";
import { legCloseId, OFF_LADDER_LEG_KEYS, offLadderLegCloseId } from "./scoreboard.js";
import { computeT1Dial } from "./t1dial.js";
import { computeAlertBandDetail } from "./alert-band.js";
import type { Reading } from "./domain-types.js";
import { FAMILY_MEMBERS, MEMBER_RELEVANCE } from "./danger-ladder.js";
import { ALL_INDICATORS } from "./registry.js";
import { META } from "./api/http.js";
import { DIAL_FAMILIES } from "./danger-ladder.js";
import { notifyRegimeFor, rungCut, BAND_RESTRICTED_KEYS, PER_LEG_ONLY_MEMBERS } from "./families.js";
import { LEG_FIELD } from "./danger-ladder.js";
import { computeCells, memberWeight } from "./danger-engine.js";
import { buildMemberState, SEV_NUM } from "./danger-member-state.js";
import { STATE_RANK } from "./domain-types.js";
import type { State } from "./domain-types.js";
import { rows, FAMILY_TABLES, redLastKnown } from "./families.test-helpers.js";

const LIVE_IDS = US_FAMILIES.flatMap((f) => f.ids); // all live member ids across the 7 live families

function allReadings(state: State) {
  return rows(LIVE_IDS, state);
}

/**
 * The W3-c parity SENTINEL is gone — it was a tripwire scheduled for deletion by the
 * cut-choice stage (§6 Q1 ruled 2026-07-18), not an invariant. The two axes are now
 * free to diverge; asserting they agree would BLOCK the next cut move.
 *
 * What survives is the notify axis's own behaviour: `notifyRegimeFor` must tier at the
 * RULED rungs (3 / 5 / 7). This is not a restatement of the constant — it drives the
 * fold, so a strictness flip (`<` vs `<=`) or a rung typo goes red here.
 */
describe("notifyRegimeFor - tiers at the ruled rung boundaries (W3-c §6 Q1, option C)", () => {
  test("each tier begins exactly at its rung, and the rung below still reads lower", () => {
    // Drive the fold, not the table: one score just under each cut and one exactly on it.
    const eps = 1e-9;
    expect(notifyRegimeFor(rungCut(3) - eps)).toBe("Calm");
    expect(notifyRegimeFor(rungCut(3))).toBe("Caution");
    expect(notifyRegimeFor(rungCut(5) - eps)).toBe("Caution");
    expect(notifyRegimeFor(rungCut(5))).toBe("Stress");
    expect(notifyRegimeFor(rungCut(7) - eps)).toBe("Stress");
    expect(notifyRegimeFor(rungCut(7))).toBe("Crisis");
    // The reachable extremes, so the sweep is not confined to the boundaries.
    expect(notifyRegimeFor(rungCut(1))).toBe("Calm");
    expect(notifyRegimeFor(rungCut(9))).toBe("Crisis");
  });
});

describe("confirmClosesFor - speed-tiered confirmation (L1 Stage 4)", () => {
  test("confirmClosesFor resolves every member id to its family tier", () => {
    for (const f of DASHBOARD_FAMILIES) {
      for (const id of f.ids) {
        expect(confirmClosesFor(id), `${id} (${f.key})`).toBe(CONFIRM_TIERS[f.key]);
      }
    }
    // Every tier is 2 (2026-08-26 directional fold), so the loop above cannot see a resolver
    // that ignores the family. Synthetic tier: it must reach that family's members, no one else's.
    const prev = CONFIRM_TIERS.geopolitics;
    try {
      CONFIRM_TIERS.geopolitics = prev + 2;
      expect(confirmClosesFor("G1")).toBe(prev + 2); // geopolitics member takes ITS family's tier
      expect(confirmClosesFor("F1")).toBe(CONFIRM_TIERS.credit); // another family's member is unmoved
    } finally {
      CONFIRM_TIERS.geopolitics = prev;
    }
  });

  // One-speed layer (2026-08-26 directional fold): an id in NO family takes the same down
  // buffer 2 as a family member — never a separate slow-tier fallback (the live fold users
  // outside the family tables are the display-only context cards NVDA / DB_SMH / DB_XLK — CQS
  // LEFT this set when it was seated as a credit member, 2026-08-16 Stage 3.1).
  test("an id in no family takes the same down buffer 2 (one-speed layer)", () => {
    expect(confirmClosesFor("G1")).toBe(2); // geopolitics member — resolves via the family
    expect(confirmClosesFor("SPY")).toBe(2); // pension leg — no dashboard family
    expect(confirmClosesFor("nope")).toBe(2); // unknown id
  });

});

describe("computeFamilyPanel - breadth endpoints", () => {
  test("all-green → 7 live families, nothing firing (valuation live via ECY since 2026-08-11)", () => {
    const p = computeFamilyPanel(allReadings("GREEN"));
    expect(p.liveFamilyCount).toBe(7);
    expect(p.firingCount).toBe(0);
    expect(p.ladder[0]).toBe("Semis");
    expect(p.ladder[8]).toBe("Staples");
  });

  test("all-red → all 7 live families firing", () => {
    const p = computeFamilyPanel(allReadings("RED"));
    expect(p.firingCount).toBe(7);
    expect(p.liveFamilyCount).toBe(7);
  });
});

describe("computeFamilyPanel - family state & contribution", () => {
  test("family state = worst confirmed member; amber contributes 0.5 and fires", () => {
    // Credit = {F1 GREEN, F2 AMBER, EBP GREEN}, everything else green.
    const p = computeFamilyPanel([
      { id: "F1", state: "GREEN" },
      { id: "F2", state: "AMBER" },
      { id: "EBP", state: "GREEN" },
      ...rows(US_FAMILIES.slice(1).flatMap((f) => f.ids), "GREEN"),
    ]);
    const credit = p.families.find((f) => f.key === "credit")!;
    expect(credit.state).toBe("AMBER");
    expect(credit.contribution).toBe(0.5);
    expect(credit.firing).toBe(true);
    // only credit is amber, every other family green → one family firing.
    expect(p.firingCount).toBe(1);
  });

  test("geopolitics + merged volatility (⊇ complacency) are live families with members present", () => {
    const p = computeFamilyPanel(allReadings("AMBER"));
    const geo = p.families.find((f) => f.key === "geopolitics")!;
    const vol = p.families.find((f) => f.key === "volatility")!;
    expect(geo.live).toBe(true);
    // Membership DERIVED from the live table — the id sequences are owned by §"E6(a) impact
    // order" below (geopolitics via the shared-by-reference GLOBAL pin), never restated here.
    const usIds = (key: string) => [...US_FAMILIES.find((f) => f.key === key)!.ids];
    expect(geo.members.map((m) => m.id)).toEqual(usIds("geopolitics"));
    expect(vol.live).toBe(true);
    expect(vol.members.map((m) => m.id)).toEqual(usIds("volatility"));
  });

});

describe("computeFamilyPanel - anti-fake-calm denominator", () => {
  test("a live family with zero present members drops from the denominator", () => {
    // Omit every Credit id this run → Credit is no longer live; denom = 5, not 6.
    const ids = LIVE_IDS.filter((id) => !["F1", "F2", "F3", "EBP"].includes(id));
    const p = computeFamilyPanel(rows(ids, "RED"));
    expect(p.families.find((f) => f.key === "credit")!.live).toBe(false);
    expect(p.liveFamilyCount).toBe(6); // 7 live minus the dropped credit
  });
});

// ---------------------------------------------------------------------------
// IS-7 (§17.1/§17.2) — the member-level diffusion count. `absent` is the roster ids
// that did NOT report this run; `members` is ALREADY filtered to the present ids, so
// the count is unrecoverable downstream, which is why it is served rather than derived.
// Synthetic FamilyDefs (not US_FAMILIES) so the roster size is a free variable here —
// the point of every case below is present-vs-roster, not any real family's membership.
// ---------------------------------------------------------------------------
const ROSTER_8 = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
// A non-BAND_DRIVING key (D1): the fold must be over the FULL roster for this present-vs-roster test.
// `credit`/`rates` would seat none of C1–C8, folding to a null band state — off-point here.
const wideDefs: FamilyDef[] = [{ key: "volatility", label: "Vol", ids: ROSTER_8 }];
const narrowDefs: FamilyDef[] = [{ key: "volatility", label: "Vol", ids: ROSTER_8.slice(0, 6) }];
/** The single family of `defs`, folded from whichever roster ids the map gives a state. */
const oneFamily = (states: Record<string, State>, defs: FamilyDef[] = wideDefs): FamilyPanel =>
  computeFamilyPanel(
    Object.entries(states).map(([id, state]) => ({ id, state })),
    defs,
  ).families[0]!;

// The 6 present members shared by the neutrality pair: worst-of = RED, 1 red, 3 amber-or-worse.
const PRESENT_6: Record<string, State> = {
  C1: "RED",
  C2: "AMBER",
  C3: "AMBER",
  C4: "GREEN",
  C5: "GREEN",
  C6: "GREEN",
};

describe("computeFamilyPanel - `absent` (IS-7 §17.2)", () => {
  test("counts the roster ids that did not report, and is 0 when every id reports", () => {
    expect(oneFamily(PRESENT_6).absent).toBe(2); // 8 roster ids, 6 reported
    const all = Object.fromEntries(ROSTER_8.map((id) => [id, "GREEN" as State]));
    expect(oneFamily(all).absent).toBe(0);
  });

  test("a fully-dropped family reports its WHOLE roster dark", () => {
    const f = oneFamily({});
    expect(f.live).toBe(false);
    expect(f.members).toEqual([]);
    expect(f.absent).toBe(8);
  });

  test("the scenario path synthesizes every roster id ⇒ nothing is ever dark", () => {
    const p = computeFamilyPanelFromStates({ credit: "RED" });
    expect(p.families.every((f) => f.absent === 0)).toBe(true);
  });

  // NEUTRALITY, owed by §16.2: `absent` is ADDITIVE ONLY — the worst-of fold does not move.
  // Discriminating because the two panels share the SAME present members and differ ONLY in
  // roster size, so `absent` is 2 vs 0 while every folded field must stay equal.
  test("is additive only - the same present members fold identically under a wider roster", () => {
    const wide = oneFamily(PRESENT_6, wideDefs);
    const narrow = oneFamily(PRESENT_6, narrowDefs);
    expect([wide.absent, narrow.absent]).toEqual([2, 0]); // the inputs really do differ
    const fold = (f: FamilyPanel) => ({
      state: f.state,
      live: f.live,
      firing: f.firing,
      contribution: f.contribution,
    });
    expect(fold(wide)).toEqual(fold(narrow));
    // Pinned out-of-band (read off PRESENT_6 by hand), not off either panel.
    expect(fold(wide)).toEqual({ state: "RED", live: true, firing: true, contribution: 1 });
    expect(wide.members).toEqual(narrow.members);
  });
});

// ---------------------------------------------------------------------------
// R5/B2 — `coverageDegraded`: the family's verdict is HELD (or tied) by data that is not live.
// A claim about SIGHT, never about danger — it moves no state/contribution/firing flag, and its
// only consumer arms the WATCH-capped coverage floor. `stale` arrives on the reading rows already
// resolved through the ONE cut (`lagCutFor`, ladder.ts); nothing here declares a threshold.
// ---------------------------------------------------------------------------
const COV_ROSTER = ["C1", "C2", "C3"];
// keyed `cross-asset`: it carries NO band restriction (unlike credit AND now rates, whose band sets
// would blank the synthetic C1/C2/C3 roster) and no coverage special-case (unlike trend), so the
// fixture exercises the generic coverage rule where band ids ARE the full roster.
const covDefs: FamilyDef[] = [{ key: "cross-asset", label: "Cross-asset", ids: COV_ROSTER }];
const covFamily = (
  rows: { id: string; state: State; lag?: boolean }[],
  defs: FamilyDef[] = covDefs,
): FamilyPanel => computeFamilyPanel(rows, defs).families[0]!;

describe("computeFamilyPanel - coverageDegraded (R5/B2)", () => {
  test("(a) a stale member BELOW the verdict does not arm - the verdict is still measured", () => {
    const f = covFamily([
      { id: "C1", state: "RED", lag: false },
      { id: "C2", state: "GREEN", lag: true }, // dark, but nothing rests on it
      { id: "C3", state: "AMBER", lag: false },
    ]);
    expect(f.state).toBe("RED"); // the verdict the stale member is BELOW
    expect(f.coverageDegraded).toBe(false);
  });

  test("(b) a stale member AT the verdict arms - including a TIE with a fresh peer", () => {
    expect(
      covFamily([
        { id: "C1", state: "RED", lag: true },
        { id: "C2", state: "GREEN", lag: false },
        { id: "C3", state: "AMBER", lag: false },
      ]).coverageDegraded,
    ).toBe(true);
    // TIE: a fresh member also sits at RED, so the verdict is not SOLELY held by the stale one —
    // it is still tied by it, which is the ruled predicate (`at V`, not `uniquely at V`).
    expect(
      covFamily([
        { id: "C1", state: "RED", lag: false },
        { id: "C2", state: "GREEN", lag: false },
        { id: "C3", state: "RED", lag: true },
      ]).coverageDegraded,
    ).toBe(true);
  });

  test("(c) an ABSENT roster member arms - absence stays out of the worst-of, but now ACTS", () => {
    const f = covFamily([
      { id: "C1", state: "RED", lag: false },
      { id: "C2", state: "GREEN", lag: false },
    ]);
    expect(f.absentIds).toEqual(["C3"]);
    expect(f.state).toBe("RED"); // R5 changes NOTHING about the fold
    expect(f.coverageDegraded).toBe(true);
  });

  test("a NON-LIVE family (nothing reported) is not degraded - it votes on nothing", () => {
    const f = covFamily([]);
    expect(f.live).toBe(false);
    expect(f.coverageDegraded).toBe(false);
  });

  test("lag left UNASSESSED (undefined) never arms - no clock, no claim", () => {
    // Every row omits `stale` — the shape every non-run caller passes. `undefined` is NOT
    // "fresh" (domain-types.ts), and it must not be read as stale either: fail toward not arming.
    const f = covFamily(rows(COV_ROSTER, "AMBER"));
    expect(f.coverageDegraded).toBe(false);
  });

  test("an UNMEASURED member (lag key ABSENT) AT the verdict does not arm - flips iff lag===true", () => {
    // feed-lag: an ungriddable feed now serves `unmeasured` (no `lag` key) instead of a fabricated
    // `lag: true`; `verdictHoldIds` filters on `?.lag === true`, so a lag-absent member at the
    // verdict must NOT arm coverage. Discriminating fixture: C1 sits AT the RED verdict.
    const unmeasuredAtVerdict = covFamily([
      { id: "C1", state: "RED" }, // lag key absent = UNMEASURED
      { id: "C2", state: "GREEN", lag: false },
      { id: "C3", state: "AMBER", lag: false },
    ]);
    expect(unmeasuredAtVerdict.state).toBe("RED");
    expect(unmeasuredAtVerdict.verdictHoldIds).toEqual([]);
    expect(unmeasuredAtVerdict.coverageDegraded, "lag-absent at the verdict must not arm").toBe(false);
    // Non-vacuity: the SAME member as `lag: true` DOES arm (mirrors (b)) - the pin is not empty-true.
    expect(
      covFamily([
        { id: "C1", state: "RED", lag: true },
        { id: "C2", state: "GREEN", lag: false },
        { id: "C3", state: "AMBER", lag: false },
      ]).coverageDegraded,
    ).toBe(true);
  });

  // (d) B2's DISCRIMINATING PAIR, over the REAL trend roster (derived from GLOBAL_FAMILIES, never
  // hand-typed): the coverage roster for `trend` is COINCIDENT_TREND_MEMBERS, so a dark GT arms
  // and a dark F4 — a real trend member, but a per-leg-only US-tech proxy — does not.
  describe("(d) trend restricts its coverage roster to the coincident members", () => {
    const trendDef = GLOBAL_FAMILIES.find((f) => f.key === "trend")!;
    const trendRows = (mutate: (id: string) => { id: string; state: State; lag?: boolean } | null) =>
      computeFamilyPanel(
        trendDef.ids.flatMap((id) => {
          const row = mutate(id);
          return row ? [row] : [];
        }),
        [trendDef],
      ).families[0]!;
    const fresh = (id: string) => ({ id, state: "GREEN" as State, lag: false });

    test("the fixture really does separate the two ids (non-vacuity)", () => {
      for (const id of COINCIDENT_TREND_MEMBERS) expect(trendDef.ids).toContain(id);
      expect(trendDef.ids).toContain("F4");
      expect(COINCIDENT_TREND_MEMBERS).not.toContain("F4");
    });

    test("a STALE GT arms; a STALE F4 does not", () => {
      expect(trendRows((id) => (id === "GT" ? { ...fresh(id), lag: true } : fresh(id))).coverageDegraded).toBe(true);
      expect(trendRows((id) => (id === "F4" ? { ...fresh(id), lag: true } : fresh(id))).coverageDegraded).toBe(false);
    });

    // B4: the same restriction, read off the ID SET the trace and the /lab note consume — the
    // boolean above could stay right while the set named the wrong member.
    test("verdictHoldIds NAMES the stale GT and never the stale F4", () => {
      expect(trendRows((id) => (id === "GT" ? { ...fresh(id), lag: true } : fresh(id))).verdictHoldIds).toEqual(["GT"]);
      expect(trendRows((id) => (id === "F4" ? { ...fresh(id), lag: true } : fresh(id))).verdictHoldIds).toEqual([]);
    });

    test("an ABSENT GT arms; an ABSENT F4 does not", () => {
      expect(trendRows((id) => (id === "GT" ? null : fresh(id))).coverageDegraded).toBe(true);
      const noF4 = trendRows((id) => (id === "F4" ? null : fresh(id)));
      expect(noF4.absentIds).toEqual(["F4"]); // it IS dark — just not on the coverage roster
      expect(noF4.coverageDegraded).toBe(false);
    });
  });

  // (e) TOTALITY — the pin that stands in for required-field `tsc` enforcement (the fields are
  // optional on the interface so ~18 existing FamilyPanel literals stay untouched). Every family
  // of every shipped table, out of all three producers, must CARRY both keys.
  test("(e) all three producers emit both fields for every family of every table", () => {
    let checked = 0;
    for (const [name, defs] of FAMILY_TABLES) {
      const ids = [...new Set(defs.flatMap((f) => f.ids))];
      const live = computeFamilyPanel(rows(ids, "GREEN"), defs).families;
      const scenario = computeFamilyPanelFromStates({}, defs).families;
      // The carry arm has to REACH the carried return, not just re-run computeFamilyPanel's emission
      // a third time: with `lastKnown: {}` every family exits at `if (!lk) return f` UNCHANGED, and
      // the literal that emits the three fields on the carried branch is never executed. So seed a
      // non-GREEN last-known for EVERY key, dated one trading day before `asOf` (inside
      // CARRY_MAX_TRADING_DAYS ⇒ carried, not aged out), and prove the branch ran below.
      const lastKnown = redLastKnown(defs);
      const carry = applyFamilyCarry(computeFamilyPanel([], defs).families, lastKnown, "2026-07-23");
      const carried = carry.panel;
      // Non-vacuity: every family on the table really took the carried branch (a fully-dark panel
      // makes each one a candidate), so the assertions below read the carried literal's own fields.
      expect(tradingDaysBetween("2026-07-22", "2026-07-23")).toBeLessThanOrEqual(CARRY_MAX_TRADING_DAYS);
      expect(carry.carried.length, `${name}: the carry arm never entered the carried branch`).toBe(defs.length);
      expect(carry.dropped).toEqual([]);
      // …and the carried branch's own VALUE contract (B4), which `Object.hasOwn` below cannot see:
      // the return SPREADS the panel row, so mere presence of the three keys is inherited from
      // `computeFamilyPanel` no matter what the branch writes. A carried family has ZERO present
      // members, so it can never name a present-but-stale holder — that `[]` is the branch's claim.
      for (const f of carried) expect(f.verdictHoldIds, `${name}.${f.key} carried`).toEqual([]);
      for (const [producer, panel] of [["live", live], ["scenario", scenario], ["carry", carried]] as const) {
        expect(panel.length, `${name} ${producer} panel is non-empty`).toBeGreaterThan(0);
        for (const f of panel) {
          expect(Object.hasOwn(f, "coverageDegraded"), `${name}.${f.key} via ${producer}: coverageDegraded`).toBe(true);
          expect(Object.hasOwn(f, "absentIds"), `${name}.${f.key} via ${producer}: absentIds`).toBe(true);
          expect(Object.hasOwn(f, "verdictHoldIds"), `${name}.${f.key} via ${producer}: verdictHoldIds`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0); // the loops really ran
  });

  // (e-band) Stage-1 seam: `band` totality + zero-delta. Same three-producer construction as (e),
  // with every family carried (RED last-known) so `applyFamilyCarry`'s re-marked branch is exercised.
  let _bandPanelsMemo: { name: string; producer: string; panel: FamilyPanel[]; roster: Map<string, string[]> }[] | undefined;
  const bandProducerPanels = () => {
    if (_bandPanelsMemo) return _bandPanelsMemo; // memoized: two tests share the same construction
    const out: { name: string; producer: string; panel: FamilyPanel[]; roster: Map<string, string[]> }[] = [];
    for (const [name, defs] of FAMILY_TABLES) {
      const ids = [...new Set(defs.flatMap((f) => f.ids))];
      const roster = new Map(defs.map((d) => [d.key, [...d.ids]]));
      const live = computeFamilyPanel(rows(ids, "GREEN"), defs).families;
      const scenario = computeFamilyPanelFromStates({}, defs).families;
      const lastKnown = redLastKnown(defs);
      const carry = applyFamilyCarry(computeFamilyPanel([], defs).families, lastKnown, "2026-07-23");
      expect(carry.carried.length, `${name}: carry arm never entered the carried branch`).toBe(defs.length);
      // carriedOnly arm: every member present but `carried:true` ⇒ carriedOnly ⇒ carry's :1017 branch.
      const carriedBase = computeFamilyPanel(ids.map((id) => ({ id, state: "RED" as State, carried: true })), defs).families;
      expect(carriedBase.every((f) => f.carriedOnly === true), `${name}: carriedOnly base not all carried`).toBe(true);
      const carriedOnly = applyFamilyCarry(carriedBase, lastKnown, "2026-07-23").panel;
      for (const [producer, panel] of [["live", live], ["scenario", scenario], ["carry", carry.panel], ["carriedOnly", carriedOnly]] as const) {
        out.push({ name, producer, panel, roster });
      }
    }
    _bandPanelsMemo = out;
    return out;
  };

  // (e-band-delta) D1 (family-colour-follows-danger): a family's OWN state/firing/contribution ARE the
  // band role, for EVERY family and producer — so band === f.* now holds for credit/rates too (it was
  // the deliberate exception before D1). `band.ids` still narrows for every BAND_RESTRICTED_KEYS family
  // (pinned by (e-band-credit)/(e-band-rates)/(e-band-trend)), so the FULL-roster ids check skips them.
  test("(e-band-delta) f.state/firing/contribution === band role, every family, every producer", () => {
    let checked = 0;
    let idsChecked = 0;
    for (const { name, producer, panel, roster } of bandProducerPanels()) {
      for (const f of panel) {
        const label = `${name}.${f.key} via ${producer}`;
        expect(f.band!.firing, `${label}: band.firing`).toBe(f.firing);
        expect(f.band!.contribution, `${label}: band.contribution`).toBe(f.contribution);
        expect(f.band!.state, `${label}: band.state`).toBe(f.state);
        checked++;
      }
      for (const f of panel.filter((x) => !BAND_RESTRICTED_KEYS.includes(x.key))) {
        expect(f.band!.ids, `${name}.${f.key} via ${producer}: band.ids`).toEqual(roster.get(f.key));
        idsChecked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(idsChecked).toBeGreaterThan(0);
  });

  // (e-band-credit) R1/R3 — the credit band roster, its bridge, and the per-leg demotion.
  const gCredit = (rows: { id: string; state: State; lag?: boolean }[]) =>
    computeFamilyPanel(rows, GLOBAL_FAMILIES).families.find((f) => f.key === "credit")!;
  const GREEN_CREDIT = rows(GLOBAL_FAMILIES.find((f) => f.key === "credit")!.ids, "GREEN");

  test("(e-band-credit) band.ids seats CQS beside EBP, and CQS SUBSTITUTES (once) while EBP is not speaking", () => {
    // U2 (2026-08-20): CQS rides the band every day, so the speaking-EBP roster is five, not four.
    expect(gCredit(GREEN_CREDIT).band!.ids).toEqual(["F1", "EBP", "CQS", "F3", "F2"]);
    // EBP past its lag cut ⇒ the nowcast takes its seat — and appears EXACTLY ONCE (the dedupe: it is
    // both a seated member and the bridge, so a naive substitution would list it twice on the wire).
    expect(gCredit(GREEN_CREDIT.map((r) => (r.id === "EBP" ? { ...r, lag: true } : r))).band!.ids)
      .toEqual(["F1", "CQS", "F3", "F2"]);
    // EBP absent entirely ⇒ same substitution.
    expect(gCredit(GREEN_CREDIT.filter((r) => r.id !== "EBP")).band!.ids).toEqual(["F1", "CQS", "F3", "F2"]);
    // US_FAMILIES has no CQS on the roster, so the bridge can never seat there.
    const us = computeFamilyPanel([{ id: "F1", state: "GREEN" }], US_FAMILIES).families.find((f) => f.key === "credit")!;
    expect(us.band!.ids).toEqual(["F1", "EBP", "F3", "F2"]);
  });

  // U2's cap — the band analogue of the ledger's never-solo-RED ceiling. Three falsifiers.
  test("(e-band-credit) a RED CQS caps the band at AMBER beside a speaking EBP, uncapped as the bridge", () => {
    const redCqs = GREEN_CREDIT.map((r) => (r.id === "CQS" ? { ...r, state: "RED" as State } : r));
    // (i) EBP speaking ⇒ CQS is a capped member: it may arm the band, never escalate it past AMBER.
    const capped = gCredit(redCqs);
    expect(capped.band!.state).toBe("AMBER");
    expect(capped.band!.firing).toBe(true);
    // (ii) Under D1 the family verdict IS the band role, so `state` reads the capped AMBER; only the raw
    // MEMBER ROW still carries the true RED (the danger ledger reads member state, never `f.state`).
    expect(capped.state).toBe("AMBER");
    expect(capped.members.find((m) => m.id === "CQS")!.state).toBe("RED");
    // (iii) EBP dark ⇒ CQS SUBSTITUTES and speaks with the full voice it replaces: cap dropped.
    const bridged = gCredit(redCqs.map((r) => (r.id === "EBP" ? { ...r, lag: true } : r)));
    expect(bridged.band!.state).toBe("RED");
  });

  test("(e-band-credit) a lone per-leg-only member fires NEITHER the family NOR the band (D1)", () => {
    for (const id of ["F10", "F13"]) {
      const f = gCredit(GREEN_CREDIT.map((r) => (r.id === id ? { ...r, state: "AMBER" as State } : r)));
      expect(f.firing, `${id}: family firing (band-driven since D1)`).toBe(false);
      expect(f.state, `${id}: family state`).toBe("GREEN");
      expect(f.band!.firing, `${id}: band firing`).toBe(false);
      expect(f.band!.state, `${id}: band state`).toBe("GREEN");
      expect(f.cannotArm, `${id}: cannot-arm mark`).toEqual({ count: 1, worst: "AMBER", worstCount: 1 });
    }
    // …and the F1|F2 escalator tautology survives: a RED band member still fires the band.
    for (const id of ["F1", "F2"]) {
      expect(gCredit(GREEN_CREDIT.map((r) => (r.id === id ? { ...r, state: "RED" as State } : r))).band!.firing).toBe(true);
    }
  });

  test("(e-band-credit) coverage is judged over the BAND roster, not the full one (R2's B2 analogue)", () => {
    expect(gCredit(GREEN_CREDIT.filter((r) => r.id !== "F10")).coverageDegraded).toBe(false);
    expect(gCredit(GREEN_CREDIT.filter((r) => r.id !== "F3")).coverageDegraded).toBe(true);
  });

  test("(e-band-credit) CCC is SEATED on credit on all nine legs and off every card-only overlay", () => {
    expect(familyOf("CCC")).toBe("credit");
    expect([...(MEMBER_RELEVANCE.CCC ?? [])].sort()).toEqual(LEG_FIELD.map((l) => l.sleeve).sort());
    expect(CARD_ONLY_GROUPS.filter((g) => g.ids.includes("CCC"))).toEqual([]);
  });

  // (e-band-rates) R1/R3 — the rates band roster, its R8→R1 bridge, and the per-leg demotion.
  const gRates = (rows: { id: string; state: State; lag?: boolean }[]) =>
    computeFamilyPanel(rows, GLOBAL_FAMILIES).families.find((f) => f.key === "rates")!;
  const GREEN_RATES = rows(GLOBAL_FAMILIES.find((f) => f.key === "rates")!.ids, "GREEN");

  test("(e-band-rates) band.ids is R1's four, with R8 bridged in only while R1 is not speaking", () => {
    expect(gRates(GREEN_RATES).band!.ids).toEqual(["R1", "R2", "R3", "R4"]);
    // R1 past its lag cut ⇒ the smoothed NTFS spine takes its seat, and never both curve reads at once.
    expect(gRates(GREEN_RATES.map((r) => (r.id === "R1" ? { ...r, lag: true } : r))).band!.ids)
      .toEqual(["R8", "R2", "R3", "R4"]);
    // R1 absent entirely ⇒ same substitution.
    expect(gRates(GREEN_RATES.filter((r) => r.id !== "R1")).band!.ids).toEqual(["R8", "R2", "R3", "R4"]);
    // R1 and R8 are NEVER both on the band the same day.
    for (const rows of [GREEN_RATES, GREEN_RATES.map((r) => (r.id === "R1" ? { ...r, lag: true } : r))]) {
      const ids = gRates(rows).band!.ids;
      expect(ids.includes("R1") && ids.includes("R8")).toBe(false);
    }
  });

  test("(e-band-rates) a lone per-leg-only member fires NEITHER the family NOR the band (D1)", () => {
    for (const id of ["R6", "R7", "EURC", "BUND"]) {
      const f = gRates(GREEN_RATES.map((r) => (r.id === id ? { ...r, state: "AMBER" as State } : r)));
      expect(f.firing, `${id}: family firing (band-driven since D1)`).toBe(false);
      expect(f.state, `${id}: family state`).toBe("GREEN");
      expect(f.band!.firing, `${id}: band firing`).toBe(false);
      expect(f.band!.state, `${id}: band state`).toBe("GREEN");
      expect(f.cannotArm, `${id}: cannot-arm mark`).toEqual({ count: 1, worst: "AMBER", worstCount: 1 });
    }
    // …and a band-driving member still fires the band.
    for (const id of ["R1", "R2", "R3", "R4"]) {
      expect(gRates(GREEN_RATES.map((r) => (r.id === id ? { ...r, state: "RED" as State } : r))).band!.firing).toBe(true);
    }
  });

  test("(e-band-rates) coverage is judged over the BAND roster, not the full one (R5's B2 analogue)", () => {
    expect(gRates(GREEN_RATES.filter((r) => r.id !== "R6")).coverageDegraded).toBe(false);
    expect(gRates(GREEN_RATES.filter((r) => r.id !== "R2")).coverageDegraded).toBe(true);
  });

  // [USER] 2026-09-24: PER_LEG_ONLY_MEMBERS never move the dial — not the band, not `legP`. Pre-fix
  // (legP read them) the pair RED alone gave rung 3 / WATCH in a calm world.
  test("(e-band-trend) PER_LEG_ONLY_MEMBERS RED leaves the whole dial, notify band + cannot-arm marks equal to GREEN; EU-Fin leg danger still moves", () => {
    const run = (states: Record<string, State>) => {
      const panel = computeFamilyPanelFromStates({}, DIAL_FAMILIES, states);
      const dial = computeT1Dial(panel.families);
      const readings: Reading[] = Object.entries(states).map(([id, state]) => ({
        indicator: ALL_INDICATORS.find((i) => i.id === id)!, date: "2026-09-24", level: 0, delta20: 0, rawState: state, state,
      }));
      const notify = computeAlertBandDetail({ dial, readings, geoFlags: 0, r4Phase: "equity", recentDialBands: [] });
      const euFin = LEG_FIELD.find((l) => l.sleeve === "EU-Fin")!;
      const cells = computeCells(euFin, buildMemberState({ globalFamilies: panel.families }));
      return { dial, notify: notify.band, cells, cannotArm: panel.families.map((f) => [f.key, f.cannotArm]) };
    };
    // Each member's own family cell on EU-Fin (uT for the RS pair, cr for AT1/CCC) — read off FAMILY_MEMBERS.
    const cellOf = (r: ReturnType<typeof run>, id: string) =>
      r.cells.find((c) => FAMILY_MEMBERS[c.family]?.includes(id))!.wsev ?? 0;
    const subsets = [...PER_LEG_ONLY_MEMBERS.map((id) => [id]), [...PER_LEG_ONLY_MEMBERS]];
    for (const world of [{}, { F1: "RED", R1: "RED" }] as Record<string, State>[]) {
      for (const ids of subsets) {
        const label = `${JSON.stringify(world)} + ${ids.join("+")}`;
        const green = run({ ...world, ...Object.fromEntries(ids.map((id) => [id, "GREEN"])) });
        const red = run({ ...world, ...Object.fromEntries(ids.map((id) => [id, "RED"])) });
        expect(red.dial, `${label}: dial`).toEqual(green.dial);
        expect(red.notify, `${label}: notify`).toBe(green.notify);
        expect(red.cannotArm, `${label}: no "deepens the dial" mark`).toEqual(green.cannotArm);
        // Per-leg path untouched: the cell is a plain weighted max, so RED lifts it to ≥ the member's own reach
        // (above GREEN's 0 in the calm world; armed, CCC's 0.5 only ties F1's 0.5 on EU-Fin — no breadth bonus).
        for (const id of ids) {
          const reach = memberWeight(id, "EU-Fin") * SEV_NUM.lit;
          expect(reach, `${id}: seated on EU-Fin`).toBeGreaterThan(0);
          expect(cellOf(red, id), `${label}: EU-Fin ${id} cell wsev`).toBeGreaterThanOrEqual(Math.max(cellOf(green, id), reach));
        }
      }
    }
    // Discriminator: a band-seated trend member in the armed world DOES move the dial — the fixture reaches it.
    const armed = { F1: "RED", R1: "RED" } as Record<string, State>;
    expect(run({ ...armed, F6: "RED" }).dial).not.toEqual(run({ ...armed, F6: "GREEN" }).dial);
  });

  test("(f) absentIds IS the roster-minus-present set, and its length is `absent`", () => {
    const f = covFamily([{ id: "C2", state: "AMBER" }]);
    expect(f.absentIds).toEqual(["C1", "C3"]); // roster order, present id removed
    expect(f.absentIds!.length).toBe(f.absent);
    // The other end of the same field: a fully-reporting family reports [] / 0, not "unknown".
    const all = covFamily(rows(COV_ROSTER, "GREEN"));
    expect(all.absentIds).toEqual([]);
    expect(all.absent).toBe(0);
    // …and the scenario path synthesizes every roster id, so it is [] there too.
    for (const s of computeFamilyPanelFromStates({ credit: "RED" }).families) expect(s.absentIds).toEqual([]);
  });

  // (g) B4 — `verdictHoldIds` is `absentIds`' twin: the PRESENT-but-stale members AT the verdict.
  // The `m.state === rosterVerdict` clause is what separates the two rows below; without it the
  // below-the-verdict stale member would be named as a holder of a verdict it does not hold.
  test("(g) verdictHoldIds names only the stale members sitting AT the verdict", () => {
    expect(
      covFamily([
        { id: "C1", state: "RED", lag: true },
        { id: "C2", state: "GREEN", lag: true }, // stale, but BELOW the RED verdict
        { id: "C3", state: "RED", lag: true }, // ties it — also a holder
      ]).verdictHoldIds,
    ).toEqual(["C1", "C3"]);
    // No stale member at all ⇒ [], not "unknown"; and the two synthetic producers can never claim
    // a present-but-stale holder (no lag input / zero present members).
    expect(covFamily(COV_ROSTER.map((id) => ({ id, state: "AMBER" as State, lag: false }))).verdictHoldIds).toEqual([]);
    for (const s of computeFamilyPanelFromStates({ credit: "RED" }).families) expect(s.verdictHoldIds).toEqual([]);
    const dropped = { ...covFamily([]), firing: true };
    const carried = applyFamilyCarry([dropped], { "cross-asset": { state: "RED", date: "2026-06-25" } }, "2026-06-26").panel[0]!;
    expect(carried.coverageDegraded).toBe(true);
    expect(carried.verdictHoldIds).toEqual([]);
  });
});

/**
 * I2 — COMPILE-TIME half of the state-union guard for the browser twin.
 *
 * `diffusionLabel` folds via `STATE_RANK[m.state] >= STATE_RANK.AMBER`, but its byte-identical
 * `/lab` twin (`public/diffusion-label.js`) cannot import `STATE_RANK` and hardcodes the two
 * amber-or-worse literals below (plus `=== "RED"` for the red count). `public/**` is outside
 * `tsc`, and a `.js` test file is invisible to it too, so the twin's own suite can only guard the
 * union at RUNTIME (`public/diffusion-label.test.js`, `STATE_VALUES`). This block is the missing
 * compile-time direction: widen `State` and `tsc` fails HERE, naming the twin to update.
 */
const TWIN_ELEVATED_STATES = ["AMBER", "RED"] as const;
const TWIN_KNOWN_STATES = ["GREEN", ...TWIN_ELEVATED_STATES] as const;
type UncoveredState = Exclude<State, (typeof TWIN_KNOWN_STATES)[number]>;
const _stateExhaustive: UncoveredState extends never ? true : never = true;
void _stateExhaustive;

describe("diffusionLabel - the formatter of record (IS-7 §17.1)", () => {
  test("the browser twin's hardcoded amber-or-worse literals ARE the STATE_RANK predicate", () => {
    // Runtime companion to the `UncoveredState` block above: pins the LIST's contents against the
    // rank table, so a state re-ranked (AMBER dropped below the fold, or GREEN raised into it)
    // reds here even though the union itself is unchanged and the compile-time guard is silent.
    const elevatedByRank = (Object.keys(STATE_RANK) as State[]).filter(
      (s) => STATE_RANK[s] >= STATE_RANK.AMBER,
    );
    expect(elevatedByRank.sort()).toEqual([...TWIN_ELEVATED_STATES].sort());
  });

  test("prints the nested pair over the PRESENT denominator, and states the shrink", () => {
    expect(diffusionLabel(oneFamily(PRESENT_6))).toBe("1 red / 3 elevated of 6 (2 dark)");
  });

  test("omits the `(N dark)` suffix entirely when nothing is dark", () => {
    const label = diffusionLabel(oneFamily(PRESENT_6, narrowDefs));
    expect(label).toBe("1 red / 3 elevated of 6");
    expect(label).not.toContain("dark");
  });

  test("all-calm reads 0 / 0 - an absent member is never folded into the calm count", () => {
    expect(diffusionLabel(oneFamily({ C1: "GREEN", C2: "GREEN", C3: "GREEN" }))).toBe(
      "0 red / 0 elevated of 3 (5 dark)",
    );
  });

  test("red === elevated when every elevated member is RED (the pair is nested, never a sum)", () => {
    // If `elevated` were amber-ONLY this would read `2 red / 0 elevated`, i.e. elevated < red.
    const label = diffusionLabel(oneFamily({ C1: "RED", C2: "RED", C3: "GREEN" }));
    expect(label).toBe("2 red / 2 elevated of 3 (5 dark)");
  });

  test("a single-member family still reads as a count, not a state", () => {
    expect(diffusionLabel(oneFamily({ C1: "RED" }, [{ key: "credit", label: "Credit", ids: ["C1"] }]))).toBe(
      "1 red / 1 elevated of 1",
    );
  });

  test("three reads of ONE factor count as one signal - the real `geopolitics` roster", () => {
    // R2: G1/OVX/BRENT are three reads
    // of the SAME oil factor, so counting MEMBERS printed `2 red / 3 elevated of 3` on the push and
    // on /lab — a breadth claim asserting three independent signals agree. Driven through the REAL
    // producer + the REAL registry tags, so it pins the collapse AND `computeFamilyPanel`'s half of
    // the threading (a reading-row `factor` that never reaches the member reds here). It does NOT
    // reach the CALLERS' half — `run-cycle-dial.ts`'s `r.indicator.geoFactor` on the cron dial and
    // `api/lab.ts`'s `FACTOR_OF` on the served panel are wired, not pinned, here.
    const gpDef = GLOBAL_FAMILIES.find((f) => f.key === "geopolitics")!;
    const factorOf = new Map(ALL_INDICATORS.map((i) => [i.id, i.geoFactor]));
    // Non-vacuity: the roster really is >1 id and they really do share one tag — otherwise the
    // collapse below would hold for an unrelated reason.
    expect(gpDef.ids.length).toBeGreaterThan(1);
    expect(new Set(gpDef.ids.map((id) => factorOf.get(id))).size).toBe(1);
    const states: State[] = ["RED", "RED", "AMBER"];
    const readings = gpDef.ids.map((id, i) => ({ id, state: states[i]!, factor: factorOf.get(id) }));
    const panel = computeFamilyPanel(readings, GLOBAL_FAMILIES).families.find((f) => f.key === "geopolitics")!;
    expect(diffusionLabel(panel)).toBe("1 red / 1 elevated of 1");
    // …and the SAME states with the tag stripped still count per member, so a missing tag is only
    // ever as loud as before (the fallback half of `distinctFactorCount`).
    const untagged = computeFamilyPanel(
      gpDef.ids.map((id, i) => ({ id, state: states[i]! })),
      GLOBAL_FAMILIES,
    ).families.find((f) => f.key === "geopolitics")!;
    expect(diffusionLabel(untagged)).toBe("2 red / 3 elevated of 3");
  });

  test("a family with NO present members says so rather than counting 0 of 0", () => {
    // Reachable on the push: applyFamilyCarry re-marks a fully dropped family live+firing off
    // its last-known state, with zero present members — a `0 red / 0 elevated of 0` there would
    // read as measured calm on a family that is carrying RED.
    const dropped = oneFamily({});
    const carried = applyFamilyCarry([dropped], { volatility: { state: "RED", date: "2026-06-25" } }, "2026-06-26")
      .panel[0]!;
    expect(carried.firing).toBe(true);
    expect(diffusionLabel(carried)).toBe("no members reporting (8 dark)");
  });
});

describe("computeFamilyPanelFromStates - scenario seeding rule", () => {
  test("seeds the 7 live families GREEN; only overrides move them (denom 7)", () => {
    // Only Credit passed → the other 6 live families (valuation included, fed since the ECY
    // seat 2026-08-11) default GREEN — a live family can never be "off" in a scenario.
    const p = computeFamilyPanelFromStates({ credit: "RED" });
    expect(p.liveFamilyCount).toBe(7);
    expect(p.firingCount).toBe(1);
    const green = p.families.filter((f) => f.key !== "credit");
    expect(green.every((f) => f.state === "GREEN" && f.live)).toBe(true);
  });

  // The `memberStates` override (the `?s=F2:AMBER` segment), pinned at its own layer; api/lab.test.ts
  // keeps only the wire assertion that the parsed members reach this argument.
  test.each([
    { name: "a lone member override reddens its family (worst-of), siblings stay GREEN", states: {}, members: { F1: "RED" as State }, f1: "RED", f2: "GREEN" },
    { name: "a member override wins over the family base for its leg only", states: { credit: "RED" as State }, members: { F2: "AMBER" as State }, f1: "RED", f2: "AMBER" },
  ])("$name", ({ states, members, f1, f2 }) => {
    const p = computeFamilyPanelFromStates(states, GLOBAL_FAMILIES, members);
    const credit = p.families.find((f) => f.key === "credit")!;
    const stateOf = (id: string) => credit.members.find((m) => m.id === id)!.state;
    expect([stateOf("F1"), stateOf("F2")]).toEqual([f1, f2]);
    expect(credit.state).toBe("RED"); // worst-of the resolved members
    expect(p.firingCount).toBe(1); // only credit fires
  });

  test("no feedless family remains ⇒ the absent-able branch has no instance (premise pin)", () => {
    // Reds if a family goes feedless again — re-arm the absent-able tests with it.
    expect(US_FAMILIES.every((f) => f.ids.length > 0)).toBe(true);
    expect(GLOBAL_FAMILIES.every((f) => f.ids.length > 0)).toBe(true);
  });
});

describe("computeFamilyPanel - parameterized family defs ([USER DECISION] = B scaffold)", () => {
  const R: State = "RED";
  const A: State = "AMBER";
  const readings = [
    { id: "F1", state: R },
    { id: "R5", state: A },
    { id: "F4", state: A },
  ];

  test("re-point: GLOBAL rates gains EURC+BUND, credit gains F10, cross-asset → FXH/CG/DISP, trend → GT/GB; US_FAMILIES stays frozen", () => {
    // The alias is BROKEN — GLOBAL diverges from US at the re-pointed families.
    expect(GLOBAL_FAMILIES).not.toBe(US_FAMILIES);
    const globalRates = GLOBAL_FAMILIES.find((f) => f.key === "rates")!;
    const usRates = US_FAMILIES.find((f) => f.key === "rates")!;
    const globalCredit = GLOBAL_FAMILIES.find((f) => f.key === "credit")!;
    const usCredit = US_FAMILIES.find((f) => f.key === "credit")!;
    const globalXa = GLOBAL_FAMILIES.find((f) => f.key === "cross-asset")!;
    const usXa = US_FAMILIES.find((f) => f.key === "cross-asset")!;
    const globalTrend = GLOBAL_FAMILIES.find((f) => f.key === "trend")!;
    const usTrend = US_FAMILIES.find((f) => f.key === "trend")!;
    // One membership-diff per re-pointed family: GLOBAL carries a leg the US veto panel omits.
    expect(globalRates.ids).toContain("EURC"); // euro rates leg
    expect(globalRates.ids).toContain("BUND"); // German 10y−2y curve — ADDED alongside EURC (2026-07-18)
    // Anti-drift half: appending to the GLOBAL copy must not reach US_FAMILIES's ids. `not.toBe`
    // above only pins reference identity — a spread that leaked would still be a distinct object.
    expect(usRates.ids).not.toContain("BUND");
    expect(usRates.ids).not.toContain("EURC");
    expect(globalCredit.ids).toContain("F10"); // per-leg-only context member
    expect(globalXa.ids).toContain("FXH"); // FX-haven (⊇ old flight+dispersion)
    expect(globalTrend.ids).toContain("GB"); // global breadth leg
    // Each re-pointed GLOBAL family is a fresh object (the deep copy), so the append can't
    // alias-mutate US — the veto panel (US_FAMILIES) stays frozen.
    expect(globalRates).not.toBe(usRates);
    expect(globalCredit).not.toBe(usCredit);
    expect(globalXa).not.toBe(usXa);
    expect(globalTrend).not.toBe(usTrend);
    // The families NOT re-pointed (geopolitics, the unscored valuation family, volatility) are SHARED by
    // reference — the whole point of breaking the alias per-family rather than deep-copying.
    for (const key of ["geopolitics", "valuation", "volatility"] as const) {
      expect(GLOBAL_FAMILIES.find((f) => f.key === key)).toBe(US_FAMILIES.find((f) => f.key === key));
    }
    // The default arg is still US_FAMILIES (the veto panel), NOT the global table.
    expect(computeFamilyPanel(readings)).toEqual(computeFamilyPanel(readings, US_FAMILIES));
  });

  test("coverage: every board registry id lands in EXACTLY one of the 7 families (macro-cycle retired W1)", () => {
    // The union table the board/Dashboard groups by. Enumerate every member id and assert it
    // belongs to exactly one family (no id shared across two), and that familyOf agrees.
    const owningFamilies = (id: string) => DASHBOARD_FAMILIES.filter((f) => f.ids.includes(id));
    const allIds = DASHBOARD_FAMILIES.flatMap((f) => f.ids);
    // No duplicate id within one family.
    expect(allIds.length).toBe(new Set(allIds).size);
    for (const id of new Set(allIds)) {
      const owners = owningFamilies(id);
      expect(owners, `${id} must be in exactly one family, got [${owners.map((f) => f.key)}]`).toHaveLength(1);
      expect(familyOf(id)).toBe(owners[0]!.key);
    }
    // …and the SIGNAL_OF bijection covers exactly the 8 family keys.
    expect(Object.keys(SIGNAL_OF).sort()).toEqual(DASHBOARD_FAMILIES.map((f) => f.key).sort());
  });

  test("the scenario builder is parameterized too (distinct table → distinct denominator)", () => {
    const tiny = [
      { key: "credit", label: "Credit", ids: ["F1"] },
      { key: "rates", label: "Rates & curve", ids: ["R1"] },
    ] satisfies readonly FamilyDef[];
    const p = computeFamilyPanelFromStates({ credit: "RED" }, tiny);
    expect(p.families).toHaveLength(2);
    expect(p.liveFamilyCount).toBe(2); // both live-seeded, denom 2 (not the default 5)
  });

  // TOMBSTONE 2026-07-17 — DELETED: "macro-cycle is dead by construction on GLOBAL_FAMILIES: no
  // ids, never live, state null" (an earlier falsifier). It
  // asserted that the mc
  // family could not be lit by ANY id the codebase can emit. Its premise died with the key removal: the
  // `macro-cycle` key no longer exists in `FamilyKey`, so there is nothing left to be non-live —
  // the claim is now enforced by the TYPE SYSTEM (a `macro-cycle` panel is unconstructable), which
  // is strictly stronger than the runtime assertion. Not restated: a test that mc is absent from
  // an enum it was deleted from tests the deletion, not behavior.
});

// ---------------------------------------------------------------------------
// All-indicators card overlay (2026-07-22) — invariant guardrails. The display-only
// `cardGroupOf` overlay (CARD_ONLY_GROUPS) must NEVER feed the dial/panel tables, the Lab
// board, or `confirmClosesFor` (which resolves via `familyOf`, so table exclusion IS the guard). Each assertion below owes a mutate-and-confirm-red demo.
// ---------------------------------------------------------------------------
describe("card overlay invariant guardrails", () => {
  // The overlay's display-only ids — the FULL CARD_ONLY_GROUPS membership, NOT filtered by
  // `familyOf(id) === undefined`. That filter would be self-defeating: the instant an id leaked
  // INTO a panel family it would drop out of this set, so the "must not be a panel member" checks
  // below could never catch the very leak they guard (vacuous by construction). These ids are
  // display-only BY DESIGN and must stay out of every dial/panel/lab fold — pin the static list.
  const OVERLAY_ONLY_IDS = CARD_ONLY_GROUPS.flatMap((g) => g.ids);

  test("(a) US/GLOBAL/DIAL panel member-id sets are unchanged and hold no overlay-only id", () => {
    // Vacuity guard: the overlay must actually carry panel-foreign ids, else the checks below pass
    // for free.
    expect(OVERLAY_ONLY_IDS.length).toBeGreaterThan(0);
    for (const [name, table] of [
      ["US", US_FAMILIES],
      ["GLOBAL", GLOBAL_FAMILIES],
      ["DIAL", DIAL_FAMILIES],
    ] as const) {
      const ids = new Set(table.flatMap((f) => f.ids));
      for (const oid of OVERLAY_ONLY_IDS) {
        expect(ids.has(oid), `${oid} must NOT be a ${name} panel member`).toBe(false);
      }
    }
    // Membership snapshot (US only): any add/remove/reorder of a US panel id moves this. GLOBAL is
    // owned per-family by §"E6(a) impact order"; DIAL is derived from GLOBAL in dial-assembly.test.ts.
    expect(US_FAMILIES.flatMap((f) => f.ids)).toMatchInlineSnapshot(`
      [
        "F1",
        "EBP",
        "F3",
        "F2",
        "R1",
        "R6",
        "R7",
        "R4",
        "R3",
        "R2",
        "R8",
        "ECY",
        "T5YIFR",
        "T10YIE",
        "VT",
        "R5",
        "complacency-vix",
        "complacency-duration",
        "complacency-high",
        "price-accel",
        "CG",
        "SPCONC",
        "F5",
        "F4",
        "G1",
        "OVX",
        "BRENT",
      ]
    `);
  });

  // Stage B — the inflation breakevens moved from
  // `rates` (a LEADING/ARM family) into `valuation` (filtered out of LEADING/COINCIDENT), so they gain
  // a family home + RAG chip while staying dial-inert.
  test("(Stage B) a breakeven RED lights valuation's chip but moves NO dial term", () => {
    const green = rows(GLOBAL_FAMILIES.flatMap((f) => f.ids), "GREEN");
    const withBreakevenRed = green.map((r) => (r.id === "T10YIE" ? { ...r, state: "RED" as State } : r));
    const base = computeFamilyPanel(green, GLOBAL_FAMILIES);
    const bumped = computeFamilyPanel(withBreakevenRed, GLOBAL_FAMILIES);
    // VACUITY GUARD: the breakeven really reaches valuation's worst-of (else the invariance is trivial
    // because the member was silently dropped, not because the family is dial-inert).
    expect(base.families.find((f) => f.key === "valuation")!.state).toBe("GREEN");
    expect(bumped.families.find((f) => f.key === "valuation")!.state).toBe("RED");
    // ...yet the dial is byte-identical: valuation is filtered out of LEADING/COINCIDENT (t1dial.ts).
    expect(computeT1Dial(bumped.families)).toEqual(computeT1Dial(base.families));
  });

  test("(e) cardGroupOf maps each overlay id + F7 to its display group", () => {
    const expected: Record<string, string> = {
      VIX: "volatility",
      VIX3M: "volatility",
      DB_SMH: "trend",
      DB_XLK: "trend",
      F7: "valuation",
      SPY: "pension-drawdown",
      LEGP_EXUS: "pension-drawdown",
      DEXUSEU: "pension-drawdown",
      SP500IT: "pension-drawdown",
    };
    for (const [id, group] of Object.entries(expected)) {
      expect(cardGroupOf(id), id).toBe(group);
    }
    // A panel id still resolves to its panel family — the overlay is a FALLBACK, not an override.
    expect(cardGroupOf("F1")).toBe("credit");
    // An id in neither the panel nor the overlay maps to nothing (no card).
    expect(cardGroupOf("nope")).toBeUndefined();
  });

  test("(f) the ETFs group lists the legs in LADDER rung order, then off-ladder, then comparators", () => {
    const ids = CARD_ONLY_GROUPS.find((g) => g.key === "pension-drawdown")!.ids;
    const legRows = LADDER.map((s) => (s === "Value" ? "XDEV" : legCloseId(s)));
    expect(ids.slice(0, legRows.length)).toEqual(legRows);
    expect(ids.slice(legRows.length, legRows.length + OFF_LADDER_LEG_KEYS.length)).toEqual(
      OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId),
    );
  });
});

// ---------------------------------------------------------------------------
// Card → Indicator-detail link guardrail (2026-07-22). Every Dashboard card must resolve an
// Indicator-detail graph: `/api/indicators` draws a card for each id with a `cardGroupOf`
// meta, and clicking it hits `GET /api/series?id=<id>`, which 400s unless the id is in the
// `/api/series` META set (`new Map(ALL_INDICATORS...)`, src/api/http.ts). A future value-only /
// synthetic card added to CARD_ONLY_GROUPS but never to ALL_INDICATORS would render a card that
// dead-ends on a 400 — this pins that it can't. Ids derived from source (never a copied list).
// ---------------------------------------------------------------------------
describe("card → /api/series detail-link guardrail", () => {
  // Every id that produces a Dashboard card: the CARD_ONLY_GROUPS display-only ids PLUS every
  // ALL_INDICATORS id `cardGroupOf` groups (the panel-family cards) — exactly the ids
  // `/api/indicators` stamps a `family` onto. Derived from the production source, per the repo's
  // testing rule (no hand-copied id list that could drift).
  const CARD_IDS = new Set<string>([
    ...CARD_ONLY_GROUPS.flatMap((g) => g.ids),
    ...ALL_INDICATORS.filter((i) => cardGroupOf(i.id) !== undefined).map((i) => i.id),
  ]);

  test("every card id resolves an Indicator-detail graph (present in /api/series META)", () => {
    const missing = [...CARD_IDS].filter((id) => !META.has(id));
    expect(missing, `card ids with no /api/series detail graph: ${missing.join(", ")}`).toEqual([]);
  });

  // REVERSE DIRECTION — the test above walks
  // card id → detail graph. Nothing walked registry id → card group, so an indicator that
  // is in `ALL_INDICATORS` but in NO panel family and NO `CARD_ONLY_GROUPS` row resolves
  // `cardGroupOf === undefined`, `/api/indicators` stamps it no `family`, and `app.js`'s
  // `if (i.family && …)` zone build silently drops it: a live, fetched, scored, persisted
  // indicator that draws NOTHING. EU2 shipped in exactly that state.
  test("every ALL_INDICATORS id resolves a card group (nothing is registered but undrawn)", () => {
    // Exemptions are named individually, never as a predicate (NVDA left 2026-10-25: a card-only trend row beside F4).
    // HYNIX / AMAT (value-ladder inputs [USER]): the probe's two display-only
    // comparator reads — ruled NO card, so no card group by design. (KBE / CCC left this set 2026-10-09:
    // KBE a card-only `credit` row, CCC seated cr 2026-10-12.) KRW / COPPER: its two display lines — no card either.
    const EXEMPT = new Set(["HYNIX", "AMAT", "KRW", "COPPER"]);
    const undrawn = ALL_INDICATORS.map((i) => i.id)
      .filter((id) => !EXEMPT.has(id))
      .filter((id) => cardGroupOf(id) === undefined);
    expect(
      undrawn,
      `registered but undrawn - no panel family and no CARD_ONLY_GROUPS row: ${undrawn.join(", ")}`,
    ).toEqual([]);
    // Vacuity guard: every exemption must still be a REAL ungrouped id — a grouped one is dead weight masking a regression.
    for (const id of EXEMPT) expect(cardGroupOf(id), `${id} is grouped now - drop the stale exemption`).toBeUndefined();
    expect(cardGroupOf("NVDA"), "NVDA shares F4's group so COMBO_GROUPS boxes them").toBe(cardGroupOf("F4"));
  });
});

// ---------------------------------------------------------------------------
// Rank 7 (fail-toward-calm): age-limited last-known-state carry for a firing
// family whose feed goes non-live. `applyFamilyCarry` is the pure seam BOTH the
// notify path (dial-assembly.ts) and /lab reach through, so a dropped feed can't silently
// decay the dial band (a crash + a closes provider rate-limit no longer decays WARNING→WATCH).
// ---------------------------------------------------------------------------
function mkPanel(key: FamilyPanel["key"], live: boolean, state: State | null = null): FamilyPanel {
  const firing = live && state !== null && state !== "GREEN";
  const st = live ? state : null;
  const contribution = live && state !== null ? ({ GREEN: 0, AMBER: 0.5, RED: 1 } as const)[state] : null;
  return {
    key,
    label: key,
    state: st,
    live,
    firing,
    contribution,
    members: [],
    absent: 0,
    absentIds: [],
    // What `computeFamilyPanel` emits for a family with nothing dark and nothing stale — so the
    // carry pair below asserts against the real pre-carry value, not against `undefined`.
    coverageDegraded: false,
    band: { state: st, firing, contribution, ids: [] },
  };
}

describe("tradingDaysBetween - weekday count (holidays ignored)", () => {
  test("0 when to <= from", () => {
    expect(tradingDaysBetween("2026-07-16", "2026-07-16")).toBe(0);
    expect(tradingDaysBetween("2026-07-16", "2026-07-10")).toBe(0);
  });
  test("counts weekdays, skips the weekend", () => {
    // Thu 2026-07-16 → next Thu 2026-07-23 = 5 trading days (Fri,Mon,Tue,Wed,Thu).
    expect(tradingDaysBetween("2026-07-16", "2026-07-23")).toBe(5);
    // Fri → the following Mon = 1 trading day (Sat/Sun skipped).
    expect(tradingDaysBetween("2026-07-17", "2026-07-20")).toBe(1);
  });
});

describe("applyFamilyCarry - age-limited firing carry", () => {
  const asOf = "2026-07-23"; // Thursday

  test("carries a recently-firing non-live family (≤ limit) as live+firing", () => {
    const panel = [mkPanel("credit", false), mkPanel("rates", true, "GREEN")];
    // last-known RED 5 trading days ago (2026-07-16) → within CARRY_MAX_TRADING_DAYS.
    const lastKnown: Partial<Record<FamilyPanel["key"], LastKnownFamily>> = {
      credit: { state: "RED", date: "2026-07-16" },
    };
    const { panel: out, carried, dropped } = applyFamilyCarry(panel, lastKnown, asOf);
    expect(carried).toEqual(["credit"]);
    expect(dropped).toEqual([]);
    const credit = out.find((f) => f.key === "credit")!;
    expect(credit.live).toBe(true);
    expect(credit.firing).toBe(true);
    expect(credit.state).toBe("RED");
    expect(credit.contribution).toBe(1);
  });

  test("drops (with a degrade signal) once the last live obs is older than the limit", () => {
    const panel = [mkPanel("credit", false)];
    // 6 trading days back (2026-07-15 Wed → 2026-07-23 Thu = 6) > CARRY_MAX_TRADING_DAYS (5).
    const lastKnown: Partial<Record<FamilyPanel["key"], LastKnownFamily>> = {
      credit: { state: "RED", date: "2026-07-15" },
    };
    expect(tradingDaysBetween("2026-07-15", asOf)).toBe(6);
    const { panel: out, carried, dropped } = applyFamilyCarry(panel, lastKnown, asOf);
    expect(carried).toEqual([]);
    expect(dropped).toEqual(["credit"]);
    expect(out.find((f) => f.key === "credit")!.live).toBe(false); // stays excluded
  });

  test("exactly at the limit still carries (≤, not <)", () => {
    const panel = [mkPanel("credit", false)];
    const at = { credit: { state: "AMBER" as State, date: "2026-07-16" } }; // 5 trading days
    expect(tradingDaysBetween("2026-07-16", asOf)).toBe(CARRY_MAX_TRADING_DAYS);
    expect(applyFamilyCarry(panel, at, asOf).carried).toEqual(["credit"]);
  });

  test("a non-live family that was NOT firing (GREEN / no history) is neither carried nor dropped", () => {
    const panel = [mkPanel("credit", false), mkPanel("rates", false)];
    const lastKnown = { credit: { state: "GREEN" as State, date: "2026-07-22" } }; // rates has no history
    const { carried, dropped, panel: out } = applyFamilyCarry(panel, lastKnown, asOf);
    expect(carried).toEqual([]);
    expect(dropped).toEqual([]);
    expect(out.find((f) => f.key === "credit")!.live).toBe(false);
  });

  // B1's ⚠ (ruled): a CARRIED family
  // reported ZERO members, so its entire re-marked verdict is last-known data — exactly the
  // "not live" claim the coverage floor makes. A dropped one is excluded from the denominator
  // and votes on nothing, so it claims nothing either.
  test("a carried family is coverageDegraded; a live one passes through untouched", () => {
    const panel = [mkPanel("credit", false), mkPanel("rates", true, "GREEN")];
    const lastKnown: Partial<Record<FamilyPanel["key"], LastKnownFamily>> = {
      credit: { state: "RED", date: "2026-07-16" },
    };
    const out = applyFamilyCarry(panel, lastKnown, asOf).panel;
    expect(out.find((f) => f.key === "credit")!.coverageDegraded).toBe(true);
    expect(out.find((f) => f.key === "rates")!.coverageDegraded).toBe(false);
  });

  test("an aged-out (dropped) family stays NOT degraded", () => {
    const panel = [mkPanel("credit", false)];
    const lastKnown: Partial<Record<FamilyPanel["key"], LastKnownFamily>> = {
      credit: { state: "RED", date: "2026-07-15" }, // 6 trading days > the limit
    };
    const { panel: out, dropped } = applyFamilyCarry(panel, lastKnown, asOf);
    expect(dropped).toEqual(["credit"]); // it really did take the drop branch
    expect(out.find((f) => f.key === "credit")!.coverageDegraded).toBe(false);
  });

  test("a live family is never touched", () => {
    const panel = [mkPanel("credit", true, "AMBER")];
    const lastKnown = { credit: { state: "RED" as State, date: "2026-07-16" } };
    const out = applyFamilyCarry(panel, lastKnown, asOf).panel;
    expect(out[0]!.state).toBe("AMBER"); // real present state wins, not the stale RED
  });

  // Stage C: a CARRIED-ONLY family (live
  // but every present member arrived via the absent-member carry) is NOT exempt — its state is
  // worse-of(carried fold, fresh last-known) and it NEVER drops. Ages derive from CARRY_MAX_TRADING_DAYS.
  describe("carried-only worse-of (Stage C)", () => {
    // cross-asset [C1,C2,C3] with ONLY C1 present as a CARRIED row ⇒ carriedOnly, C2/C3 dark.
    const carriedOnlyPanel = (foldState: State) =>
      computeFamilyPanel([{ id: "C1", state: foldState, carried: true }], covDefs).families;
    const fresh = "2026-07-16"; // inside CARRY_MAX_TRADING_DAYS of asOf (asserted below)

    test("precondition: computeFamilyPanel marks the all-carried family carriedOnly + degraded", () => {
      const f = carriedOnlyPanel("GREEN")[0]!;
      expect(f.carriedOnly).toBe(true);
      expect(f.live).toBe(true); // still on the board
      expect(f.coverageDegraded).toBe(true); // whole verdict rests on carried data
    });

    test("last-known WORSE than the carried fold wins (GREEN fold, RED last-known ⇒ RED, firing)", () => {
      expect(tradingDaysBetween(fresh, asOf)).toBeLessThanOrEqual(CARRY_MAX_TRADING_DAYS);
      const out = applyFamilyCarry(carriedOnlyPanel("GREEN"), { "cross-asset": { state: "RED", date: fresh } }, asOf).panel[0]!;
      expect(out.state).toBe("RED");
      expect(out.firing).toBe(true);
      expect(out.coverageDegraded).toBe(true);
    });

    test("carried fold WORSE than last-known wins (RED fold, AMBER last-known ⇒ RED)", () => {
      const out = applyFamilyCarry(carriedOnlyPanel("RED"), { "cross-asset": { state: "AMBER", date: fresh } }, asOf).panel[0]!;
      expect(out.state).toBe("RED"); // the live-carried RED is not pulled down to the milder last-known
      expect(out.firing).toBe(true);
    });

    test("last-known aged out ⇒ the carried fold stands alone; the family does NOT drop", () => {
      const aged = "2026-07-15"; // strictly older than CARRY_MAX_TRADING_DAYS (asserted below)
      expect(tradingDaysBetween(aged, asOf)).toBeGreaterThan(CARRY_MAX_TRADING_DAYS);
      const { panel, dropped } = applyFamilyCarry(carriedOnlyPanel("GREEN"), { "cross-asset": { state: "RED", date: aged } }, asOf);
      const f = panel[0]!;
      expect(f.state).toBe("GREEN"); // aged last-known ignored; the carried fold survives
      expect(f.live).toBe(true);
      expect(dropped).toEqual([]); // still has carried members — never dropped
      expect(f.coverageDegraded).toBe(true);
    });
  });
});

/**
 * E6(a) IMPACT ORDER (2026-07-26) — the member sequence all four surfaces paint.
 *
 * These are VALUE pins, deliberately: the order is a USER ruling backed by a literature search,
 * not something derivable
 * from any constant in the tree. A derived assertion here would track any reshuffle and could
 * never disagree — the exact failure mode `testing-project.md` warns about. Re-ranking is therefore a deliberate two-site edit: the array and this
 * pin. Adding a MEMBER also lands here, which is the point — the rank must be chosen, not appended.
 */
describe("E6(a) impact order", () => {
  const idsOf = (fams: readonly FamilyDef[], key: string) => fams.find((f) => f.key === key)!.ids;

  // US_FAMILIES needs its OWN value pin for `volatility`: since GLOBAL's volatility became an
  // explicit literal, a US reorder no longer propagates there, so the GLOBAL pin below cannot see
  // it. Its only other cover is the US `toMatchInlineSnapshot`, which `-u` regenerates silently.
  // /lab's frozen veto panel paints this table, so its order is on screen.
  test("US_FAMILIES volatility carries the ranked order independently of GLOBAL", () => {
    expect(idsOf(US_FAMILIES, "volatility")).toEqual([
      "VT", "R5", "complacency-vix", "complacency-duration", "complacency-high", "price-accel",
    ]);
  });

  test("GLOBAL_FAMILIES carries the ranked order - the table the /lab board and dashboard read", () => {
    // EU2 left the roster on the 2026-08-15 band-inert demotion.
    // CQS (Baa−Aaa nowcast bridge over EBP) seated in the context tail beside F10. Tail rank
    // F10 · CQS · F13 — see the `GLOBAL_FAMILIES` credit branch in `family-table.ts`. AT1 appended after F13
    // 2026-09-26 (eufin-overlap R7); CCC between F13 and AT1 2026-10-12 (ccc-credit-seat).
    // BONOS LEFT for the card-only credit row 2026-09-30 [USER].
    expect(idsOf(GLOBAL_FAMILIES, "credit")).toEqual(["F1", "EBP", "F3", "F2", "F10", "CQS", "F13", "CCC", "AT1"]);
    expect(idsOf(GLOBAL_FAMILIES, "rates")).toEqual([
      "R1", "R6", "R7", "R4", "R3", "R2", "R8", "EURC", "BUND", "ESTR",
    ]);
    // Stage B — the breakevens moved OUT of rates into valuation, ranking LAST (rowless ⇒ decorative).
    // valuation is SHARED by reference (no re-point branch), so US and GLOBAL carry the same order.
    expect(idsOf(GLOBAL_FAMILIES, "valuation")).toEqual(["ECY", "T5YIFR", "T10YIE"]);
    expect(idsOf(US_FAMILIES, "valuation")).toEqual(["ECY", "T5YIFR", "T10YIE"]);
    expect(idsOf(GLOBAL_FAMILIES, "volatility")).toEqual([
      "VT", "R5", "complacency-vix", "complacency-duration", "complacency-high", "price-accel",
    ]);
    expect(idsOf(GLOBAL_FAMILIES, "cross-asset")).toEqual(["F9", "FXH", "F11", "F17", "CG", "DISP"]);
    expect(idsOf(GLOBAL_FAMILIES, "trend")).toEqual(["GT", "GB", "SPCONC", "F6", "F5", "F4", "F8", "KBE_RS", "EXSH_GATE", "INS_RS"]);
    expect(idsOf(GLOBAL_FAMILIES, "geopolitics")).toEqual(["G1", "OVX", "BRENT"]);
  });

  // F9 is the discriminating case and the reason this test exists: it is GLOBAL-only and ranks
  // 1st in cross-asset, ahead of the US member CG, so under the OLD US-first union it landed after CG
  // on the dashboard while /lab painted it 1st. Flipping the union to GLOBAL-first is what makes the two agree.
  test("DASHBOARD_FAMILIES equals GLOBAL_FAMILIES order, F9 at rank 1 and not appended", () => {
    for (const g of GLOBAL_FAMILIES) {
      expect(idsOf(DASHBOARD_FAMILIES, g.key), g.key).toEqual([...g.ids]);
    }
    expect(idsOf(DASHBOARD_FAMILIES, "cross-asset")[0]).toBe("F9");
  });

  // SURFACE PIN (b) — the /lab tiles iterate
  // `d.globalFamilies[].members`, which `api/lab.ts` builds via `computeFamilyPanel`. Pinning the
  // producer covers that surface. ⚠ It does NOT cover an "indicator detail list" — an earlier
  // comment here claimed it covered both, but the two detail/compare `<select>` pickers read
  // `/api/indicators` and `INDICATOR_DESC`, never this panel; they are pinned separately in
  // `public/picker-groups.test.js`. Non-vacuous because the readings are fed in REVERSE
  // ids order: a producer that echoed its input would fail.
  test("computeFamilyPanel emits members in ids order, not in readings order", () => {
    const readings = rows([...GLOBAL_FAMILIES.flatMap((f) => f.ids)].reverse(), "GREEN");
    const panel = computeFamilyPanel(readings, GLOBAL_FAMILIES);
    for (const g of GLOBAL_FAMILIES) {
      const served = panel.families.find((p) => p.key === g.key)!;
      expect(served.members.map((m) => m.id), g.key).toEqual([...g.ids]);
    }
  });

  // The union flip is only safe while GLOBAL ⊇ US. A future US-only member would otherwise be
  // appended after every ranked id with no rank of its own — silently, since the `...u.ids` tail
  // keeps it visible. This reds instead.
  test("every US member is also a GLOBAL member (what makes the GLOBAL-first union safe)", () => {
    for (const u of US_FAMILIES) {
      const global = new Set(idsOf(GLOBAL_FAMILIES, u.key));
      expect(u.ids.filter((id) => !global.has(id)), u.key).toEqual([]);
    }
  });
});

/**
 * `rungOfSleeve` — the ONE sleeve-name → rung map every surface reads a persisted
 * `alert_log.held_sleeve` through (`api/exposure.ts`, `run-core.ts` ×2, `api/lab.ts`,
 * `rotation-commit.ts`, `notify_format.ts`).
 *
 * The absent case is the load-bearing one and it is NOT hypothetical: the EU-Fin design
 * renamed rung-7 to `EU-Fin`, and any
 * name LADDER does not contain must read as rung-BLIND (null) — a `0` sentinel would be
 * arithmetic-indistinguishable from a rung (`effectiveEquityRisk(15, 0)` = 16.7, which silently
 * CLEARS the compound floor). The pre-rename spelling itself is mapped forward upstream by
 * `canonicalSleeve` at the single hydration seam, so it is not the case this pin exercises.
 */
describe("rungOfSleeve", () => {
  test("every LADDER member maps to its 1-based rung", () => {
    // Derived from LADDER, never hand-typed (testing-project.md fixture discipline).
    for (const [i, sleeve] of LADDER.entries()) {
      expect(rungOfSleeve(sleeve), sleeve).toBe(i + 1);
    }
    expect(rungOfSleeve(LADDER[0]!)).toBe(1);
    expect(rungOfSleeve(LADDER[LADDER.length - 1]!)).toBe(LADDER.length);
  });

  test("a sleeve outside LADDER is null - never 0, never a fabricated rung", () => {
    // Spelled as a name LADDER does not contain. NOT the bare pre-rename string: that one is
    // canonicalised upstream (`canonicalSleeve`) and would pin the alias, not rung-blindness.
    const renamedOut = "High-Div (pre-EU-Fin)";
    expect(LADDER as readonly string[]).not.toContain(renamedOut); // vacuity guard
    // Not "EU-Fin" itself: it BECOMES a member on rename day and would red this spuriously.
    for (const absent of [renamedOut, "", "staples", " Staples", null]) {
      expect(rungOfSleeve(absent), String(absent)).toBeNull();
    }
  });
});

/**
 * `canonicalSleeve` — the rung-7 rename's legacy-name alias, applied at exactly ONE site (the
 * `ALERT_COLS.heldSleeve` row mapper in `store.ts`). Display/history scope: it restores the LABEL
 * on pre-rename `alert_log` rows; it is not part of any rung or notify decision.
 */
describe("canonicalSleeve", () => {
  test("maps the pre-rename rung-7 name onto the current member, and only that name", () => {
    const legacy = "High-Div";
    expect(LADDER as readonly string[]).not.toContain(legacy); // vacuity: the rename really landed
    expect(canonicalSleeve(legacy)).toBe("EU-Fin");
    expect(rungOfSleeve(canonicalSleeve(legacy))).toBe(7);
    // Every current member and any other string passes through untouched.
    for (const sleeve of [...LADDER, "High-Div (pre-EU-Fin)", ""]) {
      expect(canonicalSleeve(sleeve), sleeve).toBe(sleeve);
    }
  });
});
