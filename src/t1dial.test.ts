import { describe, expect, it } from "vitest";
import type { State } from "./domain-types.js";
import type { FamilyKey, FamilyPanel } from "./families.js";
import {
  coincidentContribution,
  computeFamilyPanel,
  GLOBAL_FAMILIES,
  NOTIFY_REGIME_CUTS,
  PER_LEG_ONLY_MEMBERS,
  notifyRegimeFor,
  rungCut,
} from "./families.js";
import {
  applyCrisisGate,
  ARMED_CUT_SCALE,
  computeT1Dial,
  dialBandFor,
  earlyWarnFires,
  firingSplit,
  LADDER_MAX,
  LADDER_MIN,
  LEG_WEIGHTED_IDS,
  memberTone,
  POSITION_SPAN,
  techConfirmerBreadth,
  techConfirmerFromPanel,
} from "./t1dial.js";
import { DIAL_FAMILIES, MEMBER_WEIGHT } from "./danger-ladder.js";
import type { SignalCell } from "./danger-cell.js";
import { legRAG } from "./danger-engine.js";
import {
  build,
  buildXa,
  CONTRIB,
  dampedTrend,
  mem,
  memL,
  panel,
} from "./t1dial.test-helpers.js";

describe("computeT1Dial - two-tier band-select/graded-position (§5)", () => {
  it("all-green → L=0, floor lo=1, rung 1, Calm", () => {
    const d = computeT1Dial(build());
    expect(d.leadingFiring).toBe(0);
    expect(d.coincidentFiring).toBe(0);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0)); // split 0 ⇒ base band; targetRung 1
    expect(d.coincidentP).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.fired).toBe(false);
    expect(d.rung).toBe(1);
    expect(d.targetRung).toBe(1);
    expect(d.regime).toBe("Calm");
    expect(d.headline).toBe("unprimed + unfired → Calm, rung 1");
  });

  it("HARD CASE 1 - everything fires (armed+fired, p=1) → rung 9 (a real crisis maxes the dial)", () => {
    const d = computeT1Dial(
      build({ credit: "RED", rates: "RED", volatility: "RED", trend: "RED" }),
    );
    expect(d.leadingFiring).toBe(2);
    expect(d.coincidentFiring).toBe(2); // 2 coincident (vol, trend)
    expect(d.armed).toBe(true);
    expect(d.fired).toBe(true);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0)); // L=2 of 2 live ⇒ split 0; t=9
    // R2-1: vol at full depth + trend damped. positionP still 1 — both leaders RED ⇒ leadingP 1
    // carries the max, so the crisis endpoint survives the damping.
    expect(d.coincidentP).toBe((CONTRIB.RED + dampedTrend("RED")) / 2);
    expect(d.rung).toBe(9);
    expect(d.dangerScore).toBe(1);
    expect(d.targetRung).toBe(9);
    expect(d.regime).toBe("Crisis");
  });

  it("HARD CASE 2 - a coincident-only spike (unarmed) can reach Caution but NEVER the two-key 7-9", () => {
    // NARROWED by DEC-B4(i) (was: "stays in the Calm band 1–3 regardless of K"). The ratified
    // anti-manufacture-crisis property is that coincident breadth can never manufacture a CRISIS
    // band — it was previously enforced by the flat unarmed cap of 3, which also (incidentally) kept
    // such worlds inside Calm. The graded unarmed floor deliberately lifts that ceiling with RED
    // breadth: r=2 ⇒ 4.33, which crosses the Calm cut (rung 3) into Caution. The load-bearing half
    // survives ARITHMETICALLY, and is what this case now pins: no leader ⇒ rung < 7, always.
    const d = computeT1Dial(build({ volatility: "RED", trend: "RED" }));
    expect(d.leadingFiring).toBe(0);
    expect(d.coincidentFiring).toBe(2); // both coincident (vol, trend) scream…
    expect(d.armed).toBe(false);
    expect(d.fired).toBe(true);
    expect(d.coincidentP).toBe((CONTRIB.RED + dampedTrend("RED")) / 2); // R2-1 damping

    expect(d.rung).toBeCloseTo(3.222, 3); // …lifted to the CONVEX r=2 floor 1+5·(4/9), still > the flat cap 3 but a thinner margin (0.22 vs the old 1.33)
    expect(d.targetRung).toBe(3); // was 4 under the linear floor — the convex cooling rounds r=2 down to 3 (regime stays Caution)
    expect(d.regime).toBe("Caution"); // the notify-visible half of DEC-B4(i): OK → WATCH
    expect(d.rung).toBeLessThan(7); // THE surviving invariant: no ARM key ⇒ never a crisis rung
  });

  it("DEC-B3 slope pin - a lone firing leader floors at lo=4, whatever its depth (L=1 ⇒ 1 + 3·1)", () => {
    // The lower intermediate-breadth pin. Under DEC-B3 the floor reads the leader COUNT, so a
    // barely-AMBER leader selects the SAME band as a deep-RED one (see the AMBER-vs-RED pair below);
    // it merely sits at that band's floor. Fails on the pre-DEC-B3 Lg floor (which gave 2.5).
    const d = computeT1Dial(build({ credit: "AMBER" }));
    expect(d.leadingFiring).toBe(1);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 1)); // L=1 of 2 ⇒ split 1; t=4
    expect(d.coincidentP).toBe(0);
    expect(d.leadingP).toBe(0); // AMBER just qualified — it sits at the band floor
    // ⚠ THE ARM-FLOOR **SLOPE** FALSIFIER (W3-b Stage 3.4 re-anchor). `lo` is module-private and was
    // witnessed through `band.lo` above; W3-b re-derives band.lo from leader disagreement, so the
    // floor's witness is moved here, onto `rung`, which W3-b does not touch. It holds exactly:
    // leadingP=0, coincidentP=0, no bump, no cap binding ⇒ rung === lo. Under the unit-slipped
    // `1 + 3·L/2` this reads 2.5 ⇒ fails. Keep this assertion even if the band literal above changes.
    expect(d.rung).toBe(4); // lo 4 + 2×0, no coincident pressure
    expect(d.targetRung).toBe(4);
    expect(d.regime).toBe("Caution"); // Calm is unreachable once any ARM leader fires
  });

  it("graded p positions WITHIN [lo, lo+2]: AMBER leader (lo=4), all coincident amber", () => {
    const d = computeT1Dial(
      build({ rates: "AMBER", volatility: "AMBER", trend: "AMBER" }),
    );
    // R2-1: vol AMBER at full depth, trend AMBER damped ⇒ the mean sits BELOW the undamped 0.5,
    // which drops this world's dangerScore under the Stress cut (regime Caution, was Stress).
    const cp = (CONTRIB.AMBER + dampedTrend("AMBER")) / 2;
    expect(d.leadingFiring).toBe(1);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 1)); // L=1 ⇒ split 1; targetRung=round(4.875)=5
    expect(d.coincidentP).toBe(cp);
    expect(d.rung).toBe(4 + POSITION_SPAN * cp); // lo 4 + span × p
    expect(d.dangerScore).toBeLessThan(0.5);
    expect(d.targetRung).toBe(5);
    expect(d.regime).toBe("Caution");
  });

  it("p averages over LIVE coincident only - a dropped coincident family is excluded, not counted green", () => {
    const families = [
      panel("credit", "GREEN"),
      panel("rates", "GREEN"),
      panel("volatility", "RED"),
      panel("trend", "GREEN", false), // feed dropped this run
    ];
    const d = computeT1Dial(families);
    expect(d.coincidentFiring).toBe(1); // only the 1 live-and-firing (volatility) counts
    expect(d.coincidentP).toBe(1); // mean over the 1 live (RED), NOT diluted by the absent trend
  });

  // G1 SEAM GUARD (Stage 1.2). `trend` (uT) is a COINCIDENT family via `SUPER_GROUP_OF.uT =
  // "CONFIRMING"`; the growth pillar reads the uT cells but MUST NOT reassign that map (doing so would
  // empty CONFIRMING, drop trend from COINCIDENT, and move the dial ● + emitted band — an ADR §3.2
  // violation). Pin: with trend firing, it is COUNTED as a coincident and the emitted band reflects it.
  // Goes red if anyone reassigns `SUPER_GROUP_OF.uT` out of CONFIRMING (trend then stops counting).
  it("trend firing is COUNTED as coincident - band + coincidentFiring pin (SUPER_GROUP_OF.uT guard)", () => {
    const withTrend = computeT1Dial(build({ volatility: "RED", trend: "RED" }));
    const withoutTrend = computeT1Dial(build({ volatility: "RED" }));
    expect(withTrend.coincidentFiring).toBe(2); // vol + trend both counted
    expect(withoutTrend.coincidentFiring).toBe(1); // trend dropping out lowers the count…
    expect(withTrend.band).not.toEqual(withoutTrend.band); // …and moves the emitted band
    expect(withTrend.band).toEqual(dialBandFor(withTrend.targetRung, 0)); // no leader ⇒ split 0; targetRung 3
  });

  // §3 CURE PIN (Option C): the DIAL band reads trend DEPTH from GT/GB
  // members ONLY. A trend family firing via a US-tech proxy (DB_SMH — the 2026-07-21 false-RED
  // member) must NOT lift `coincidentP`; only GT/GB may. Goes red if `coincidentContribution`'s
  // GT/GB restriction (families.ts) is reverted — the discriminating guard the GT-seeded fixtures
  // above cannot provide (GT RED ≡ full worst-of, so they pass with or without the restriction).
  it("trend firing via DB_SMH alone does NOT lift coincidentP; GT does (§3 false-RED cure)", () => {
    const base = build().filter((f) => f.key !== "trend");
    const viaDbSmh = computeT1Dial([...base, panel("trend", "RED", true, [mem("DB_SMH", "RED")])]);
    const viaGt = computeT1Dial([...base, panel("trend", "RED", true, [mem("GT", "RED")])]);
    expect(viaDbSmh.coincidentP).toBe(0); // DB_SMH ∉ {GT,GB} ⇒ trend contributes 0 to the uniform band
    expect(viaGt.coincidentP).toBeGreaterThan(0); // GT IS the coincident regime ⇒ it lifts the band
  });

  // OQ-5 Stage 3.2 — UNOBSERVED ≠ CALM in the coincidentP mean. `coincidentContribution` returns
  // null when the trend family carries NEITHER GT nor GB: the coincident trend regime was not
  // observed at all (§3's members are missing), which is NOT the same as observing it calm. The
  // pre-fix `?? 0` kept trend in the DENOMINATOR while adding 0, halving a genuine coincident
  // signal. The fix excludes a null contribution from BOTH sides, per `familyShare`'s
  // unobserved-member exclusion precedent (danger-share.ts).
  // DISCRIMINATING FIXTURE: trend is LIVE and firing but observed only through DB_SMH (∉ GT/GB),
  // alongside a RED volatility. Old code ⇒ (1 + 0)/2 = 0.5 and targetRung 5 (Stress/WARNING);
  // new code ⇒ 1/1 = 1 and targetRung 6. RED-DEMO'd 2026-07-26 by restoring the `?? 0` form.
  it("an UNOBSERVED coincident contribution is excluded from the mean, not averaged in as 0", () => {
    const base = build({ credit: "AMBER", volatility: "RED" }).filter((f) => f.key !== "trend");
    const trendUnobserved = panel("trend", "RED", true, [mem("DB_SMH", "RED")]);
    const d = computeT1Dial([...base, trendUnobserved]);

    // Non-vacuity: the family really IS in the live coincident set (so the old code really did
    // divide by it) and its contribution really IS null (so there is something to exclude).
    expect(trendUnobserved.live).toBe(true);
    expect(coincidentContribution(trendUnobserved)).toBeNull();
    expect(d.coincidentFiring).toBe(2); // trend still counts for BREADTH — only its DEPTH is absent

    // The mean is over the ONE observed coincident (volatility RED ⇒ CONTRIB.RED = 1), not over 2.
    expect(d.coincidentP).toBe(1); // old `?? 0`: 0.5 — the dilution this stage removes
    expect(d.targetRung).toBe(6); // old: 5
  });
});

// S4 — the two leading-family reads the credit
// roster flip left open. `panel()` emits no `band`, so every fixture above still mirrors; these two
// seed a band that DIFFERS from the family's own state, which is what the split makes reachable.
describe("computeT1Dial - the S4 leading-family reads", () => {
  const perLegOnlyCredit = (band: State): FamilyPanel => ({
    ...panel("credit", "AMBER"),
    band: { state: band, firing: band !== "GREEN", contribution: CONTRIB[band], ids: ["F1", "EBP", "F3", "F2"] },
  });
  const arm = (band: State) => [
    perLegOnlyCredit(band), panel("rates", "GREEN"), panel("volatility", "RED"), panel("trend", "RED"), panel("cross-asset", "RED"),
  ];

  it("width takes the MAX of the band and unrestricted splits - a per-leg-only firing still widens", () => {
    const d = computeT1Dial(arm("GREEN"));
    // The band arm alone splits to 0 (no leader's band fires) and so does the coincident axis (all
    // three fire), so routing the width WHOLLY through `bandOf` would collapse this to a point at
    // `hi` — i.e. RAISE `lo`. The max keeps the unrestricted arm's full one-band width.
    expect(d.band.hi - d.band.lo).toBe(POSITION_SPAN + 1); // split 1 ⇒ widened one rung over the base
    expect(d.armed).toBe(false); // the roster flip did reach the ARM key — the fixture is not inert
  });

  it("a credit firing carried only per-leg cannot reach Crisis - the gate's credit key is inert today", () => {
    // `creditFiring` reads the BAND role (S4). It is currently unfalsifiable at the dial level:
    // Crisis needs BOTH leaders firing, and with credit's band GREEN only rates can fire, so the
    // score never reaches Crisis for the gate to demote. The routing is forward-looking — a THIRD
    // leader (valuation, when CAPE lands) makes it live. This pins that inertness, so the day
    // Crisis becomes reachable with a GREEN credit band, the gate's read is re-examined.
    // volatility GREEN so the gate's OTHER key cannot hold Crisis on its own; rates RED so the one
    // surviving leader arms as hard as it can.
    const gateArm = (band: State) => [
      perLegOnlyCredit(band), panel("rates", "RED"), panel("volatility", "GREEN"), panel("trend", "RED"), panel("cross-asset", "RED"),
    ];
    expect(computeT1Dial(gateArm("GREEN")).regime).not.toBe("Crisis");
    expect(computeT1Dial(gateArm("AMBER")).regime).toBe("Crisis"); // the band-firing control DOES reach it
  });

  // Rates mirror of the S4 width arm — the split must
  // hold for rates too: a per-leg-only rates member (R6/R7/EURC/BUND) reaches the ladder per-leg only.
  const perLegOnlyRates = (band: State): FamilyPanel => ({
    ...panel("rates", "AMBER"),
    band: { state: band, firing: band !== "GREEN", contribution: CONTRIB[band], ids: ["R1", "R2", "R3", "R4"] },
  });

  it("rates: width takes the MAX of the band and unrestricted splits - a per-leg-only rates firing still widens", () => {
    const d = computeT1Dial([
      perLegOnlyRates("GREEN"), panel("credit", "GREEN"), panel("volatility", "RED"), panel("trend", "RED"), panel("cross-asset", "RED"),
    ]);
    expect(d.band.hi - d.band.lo).toBe(POSITION_SPAN + 1); // widened via the unrestricted arm's split 1
    expect(d.armed).toBe(false); // rates band GREEN ⇒ no band-leader arms
  });

  it("rates: a lone per-leg-only member firing floors nothing - leadingFiring 0, unarmed, lo at LADDER_MIN", () => {
    const d = computeT1Dial([
      perLegOnlyRates("GREEN"), panel("credit", "GREEN"), panel("volatility", "GREEN"), panel("trend", "GREEN"), panel("cross-asset", "GREEN"),
    ]);
    expect(d.leadingFiring).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.band.lo).toBe(1); // LADDER_MIN — a per-leg-only fire never lifts the floor
  });
});

describe("computeT1Dial - AMBER ≠ RED WITHIN one breadth-selected band (DEC-B3)", () => {
  it("a lone AMBER and a lone RED leader emit the SAME band WIDTH (depth moves the ●, never the width); the unfired RED truncates against ARMED_UNFIRED_CAP so the separation collapses below POSITION_SPAN", () => {
    const amber = computeT1Dial(build({ credit: "AMBER" }));
    const red = computeT1Dial(build({ credit: "RED" }));

    // DEC-B3 (Finding F): depth NO LONGER selects the band — breadth does, and both these worlds are
    // L=1 ⇒ lo=4. Depth is spent entirely on `leadingP`, positioning the ● within [4, 6] pre-cap.
    // Pre-DEC-B3 the same pair floored at 2.5 vs 4 (depth picking the band) AND positioned by depth
    // again — the double-count that made this step 3.5 rungs and cross a band boundary.
    // W2-b (Alt A): both worlds are armed-but-UNFIRED (credit is an ARM leader, no FIRE family fires),
    // so the pre-cap RED band top (6) is CLIPPED to ARMED_UNFIRED_CAP (5) — DEC-B3's exact-POSITION_SPAN
    // step holds only for FIRED worlds; the unfired step truncates against the cap.
    // W3-b Stage 3.5 RE-ANCHOR (§4.2 #11): the old pin was "SAME band.lo". Under the new emission the
    // band travels WITH the ● (both worlds are L=1-of-2 ⇒ split 1 ⇒ width 2, anchored at their own
    // targetRung), so the floors now legitimately differ (2 vs 3) — that is the ● moving, NOT a
    // double-count. The anti-double-count claim is now carried by equal WIDTH + equal ARM breadth:
    // depth changes where the band sits, never how wide it is, nor which leaders selected it.
    expect(amber.band.lo).toBe(1); // t=4, width 3 rungs
    expect(red.band.lo).toBe(2); // t=5 (pre-cap 6 clipped to ARMED_UNFIRED_CAP), width 3 rungs
    expect(red.band.hi - red.band.lo).toBe(amber.band.hi - amber.band.lo); // both 3 — depth-blind width
    expect(red.leadingFiring).toBe(amber.leadingFiring); // same ARM breadth ⇒ same band selection
    expect(amber.rung).toBe(4); // sits at the band floor: it only just qualified (cap 5 not binding)
    expect(red.rung).toBe(5); // pre-cap 4 + 2×leadingP(1) = 6, clipped to ARMED_UNFIRED_CAP (5): unfired
    expect(red.rung - amber.rung).toBe(1); // DEC-B3 narrowed: === POSITION_SPAN only when FIRED; unfired truncation collapses this to 1
    expect(amber.band).toEqual(dialBandFor(amber.targetRung, 1));
    expect(red.band).toEqual(dialBandFor(red.targetRung, 1)); // hi = capped targetRung (5), not the pre-cap 6

    // leadingP is the ONLY thing depth moves now: amber just qualified, red is deep.
    expect(amber.leadingP).toBe(0);
    expect(red.leadingP).toBe(1);
    expect(amber.targetRung).toBe(4);
    expect(red.targetRung).toBe(5); // capped
    // The regime still separates them — but from position within the band, not from band choice.
    expect(amber.regime).toBe("Caution");
    expect(red.regime).toBe("Stress");
  });

  it("partial leading depth (fired): RED + AMBER leader → L=2, floor lo=7, rung 8", () => {
    // Breadth is what floors this at 7 (BOTH leaders fire — full ARM set), not the 1.5 depth sum.
    // A firing coincident (vol AMBER) makes it fired, so the armed-unfired cap does NOT bite and the
    // partial leading depth positions the ● within [7, 9]. (Unfired, this same world caps at 6 — see
    // "two RED leaders with no FIRE family firing cap at rung 6".)
    const d = computeT1Dial(build({ credit: "RED", rates: "AMBER", volatility: "AMBER" }));
    expect(d.leadingFiring).toBe(2);
    expect(d.fired).toBe(true);
    expect(d.leadingP).toBe(0.5); // mean of red(1) + amber(0)
    expect(d.coincidentP).toBe(0.25); // vol AMBER(0.5) + trend GREEN(0) over 2 live coincident
    expect(d.positionP).toBe(0.5); // max(0.5, 0.25) — leader depth wins
    expect(d.rung).toBe(8); // 7 + 2×0.5
    // D5: leaders AGREE (both fire ⇒ leaderSplit 0), but coincident is SPLIT — vol AMBER fires while
    // trend is calm (1 of 2 live) ⇒ coincidentSplit 1 ⇒ width max(0,1)·2=2 ⇒ lo=8−2=6. hi stays 8.
    expect(d.band).toEqual(dialBandFor(d.targetRung, 1));
    expect(d.targetRung).toBe(8);
  });
});

describe("techConfirmerBreadth - US-tech downside breadth (slice 4, §7b)", () => {
  // Per-leg-RAG Stage 2 (Option A): the slots are the WEIGHT-SCALED tech-leg legRAG bands of the
  // tech members. PRODUCTION now passes exactly 2 slots {F4,F5} (NVDA demoted to detail-only
  // 2026-07-22 ⇒ /2 denominator, 2-of-2 floor); these cases exercise the FUNCTION'S generic
  // fixed-denominator math over N slots (a 3-length input still divides by 3, so the monotonicity /
  // fixed-denominator properties are pinnable here without depending on the production slot count):
  // fixed-denominator mean over all N, gated to 0 below the ≥2 floor, monotonic in breadth+depth.
  it("grades by fixed-denominator mean above the ≥2-of-3 floor", () => {
    expect(techConfirmerBreadth(["AMBER", "AMBER", "GREEN"])).toBeCloseTo(0.333, 3); // AA_
    expect(techConfirmerBreadth(["AMBER", "RED", "GREEN"])).toBe(0.5); // AR_
    expect(techConfirmerBreadth(["RED", "RED", "GREEN"])).toBeCloseTo(0.667, 3); // RR_
    expect(techConfirmerBreadth(["RED", "RED", "AMBER"])).toBeCloseTo(0.833, 3); // RRA
    expect(techConfirmerBreadth(["RED", "RED", "RED"])).toBe(1); // RRR
  });

  it("hard ≥2-of-3 floor - one firing detector ⇒ 0 (one region is not systemic)", () => {
    expect(techConfirmerBreadth(["RED", "GREEN", "GREEN"])).toBe(0);
    expect(techConfirmerBreadth(["AMBER", "GREEN", "GREEN"])).toBe(0);
    expect(techConfirmerBreadth(["GREEN", "GREEN", "GREEN"])).toBe(0);
  });

  it("degrade - absent feeds count as not-firing; all absent ⇒ 0", () => {
    expect(techConfirmerBreadth([null, null, null])).toBe(0); // all feeds dropped
    expect(techConfirmerBreadth(["RED", null, undefined])).toBe(0); // only 1 present-firing < floor
    expect(techConfirmerBreadth(["RED", "AMBER", null])).toBe(0.5); // 2 fire, absent = 0 in the /3 mean
  });

  it("new sourcing - a low-weight RED tech member no longer lifts the confirmer (old flat mean did)", () => {
    // dial-assembly.ts now feeds legRAG bands, not raw states: a near-zero-weight RED bands to GREEN, so it
    // drops out of the ≥2-of-3 firing count. A lit cell whose weighted severity is `wsev` (the only
    // field legRAG reads) models one tech member's weight-scaled tech-leg contribution.
    // `observed` (OQ-5 Stage 5.2) is shape only here — `legRAG` reads `wsev`/`cellState` alone.
    const lit = (wsev: number): SignalCell => ({
      family: "uT",
      cellState: "lit",
      M: 1,
      N: 1,
      wsev,
      observed: { fresh: 1, lag: 0, absent: 0, deepLag: 0 },
      // B2 hold-window provenance: shape only — `legRAG` reads `wsev`/`cellState` alone.
      held: null,
    });
    const lowWeightRed = legRAG([lit(0.1)]); // weight-scaled RED → GREEN band (proven in leg-rag.test.ts)
    const fullWeightRed = legRAG([lit(1.0)]); // → RED band (proven in leg-rag.test.ts)
    // OLD raw sourcing: two RED detectors ⇒ ≥2-of-3 fires ⇒ ~0.667. NEW: the low-weight one bands
    // GREEN, so only ONE slot fires (< floor) ⇒ 0 — the low-weight RED no longer lifts techConfirmerP.
    expect(techConfirmerBreadth([fullWeightRed, lowWeightRed, "GREEN"])).toBe(0);
    // Sanity — two FULL-weight REDs still clear the floor exactly as before.
    expect(techConfirmerBreadth([fullWeightRed, fullWeightRed, "GREEN"])).toBeCloseTo(0.667, 3);
  });
});

describe("computeT1Dial - techConfirmerP within-band deepener (slice 4, §7b)", () => {
  it("techConfirmerP = 0 (the default) reproduces today's rung exactly - regression pin", () => {
    const base = build({ credit: "AMBER" });
    expect(computeT1Dial(base)).toEqual(computeT1Dial(base, 0));
    const d = computeT1Dial(base, 0);
    expect(d.techConfirmerP).toBe(0);
    expect(d.rung).toBe(4); // lone-firing-leader breadth floor (L=1), no within-band pressure
    expect(d.headline).toBe("primed (credit) + unfired → Caution, rung 4");
  });

  it("pushes WITHIN [lo, lo+2] when breadth is high, then truncates against the unfired cap (AMBER leader lo=4, techConfirmerP=0.667 → pre-cap 5.334, clipped to 5)", () => {
    const d = computeT1Dial(build({ credit: "AMBER" }), 0.667); // floor 4, leadingP=coincidentP=0
    expect(d.techConfirmerP).toBe(0.667);
    expect(d.positionP).toBeCloseTo(0.667, 3); // max of {0, 0, 0.667} — pre-cap position fraction
    expect(d.rung).toBe(5); // W2-b: pre-cap 4 + 2×0.667 = 5.334, clipped to ARMED_UNFIRED_CAP (5): credit AMBER is armed-but-unfired
  });

  it("CAPPED at band top - a calm-leader run (unarmed) stays rungs 1-3 no matter how deep tech-downside is", () => {
    // The anti-manufacture-crisis property: US-tech breadth can NEVER select a higher band; unarmed
    // caps at 3.
    const d = computeT1Dial(build(), 1); // no leader fires ⇒ unarmed cap 3
    expect(d.leadingFiring).toBe(0);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0)); // no leader fires ⇒ split 0; t=3
    expect(d.positionP).toBe(1);
    expect(d.rung).toBe(3); // unarmed cap, never crosses into 4+
    expect(d.targetRung).toBe(3);
  });

  it("band-independence - the same techConfirmerP folds identically regardless of which band the leaders selected", () => {
    const lo = computeT1Dial(build({ credit: "AMBER" }), 0.5); // floor 4, leadingP=coincidentP=0
    const hi = computeT1Dial(build({ credit: "RED", rates: "RED" }), 0.5); // two RED leaders, leadingP=1
    // positionP already tops out at 1 in `hi` (leadingP=1), so assert the confirmer's own term is
    // the same in the max: in `lo` it lifts positionP from 0 → 0.5 (the pure confirmer contribution).
    expect(lo.techConfirmerP).toBe(0.5);
    expect(hi.techConfirmerP).toBe(0.5);
    expect(lo.positionP).toBe(0.5); // max(0, 0, 0.5)
  });
});

describe("computeT1Dial - valuation is dial-inert (mEff retired, O2 2026-08-11)", () => {
  // Membership guard: valuation ∉ LEADING/COINCIDENT, so a MEMBERLESS valuation panel never arms and
  // never moves the dial. D6: valuation deepens via legP ONLY through a rowed leg-only member (none here).
  it("W1-g: a firing `valuation` family is inert - never arms, never moves the dial (membership guard)", () => {
    const world = build({ credit: "AMBER", volatility: "RED" });
    const withoutVal = computeT1Dial(world, 0);
    // A deeply-firing MEMBERLESS valuation family (RED): ∉ LEADING/COINCIDENT and no rowed member ⇒ legP 0.
    const withRedVal = computeT1Dial([...world, panel("valuation", "RED")], 0);

    expect(withRedVal.leadingFiring).toBe(withoutVal.leadingFiring); // did NOT become an ARM
    expect(withRedVal.armed).toBe(withoutVal.armed);
    // W3-b §4.2 #14: unchanged and still meaningful — valuation is fully inert here (no `m` applied),
    // so the whole result is identical; the `toEqual` below already covers `band` end to end.
    expect(withRedVal.band.lo).toBe(withoutVal.band.lo);
    expect(withRedVal.positionP).toBe(withoutVal.positionP); // not a within-band positioner either
    expect(withRedVal.rung).toBe(withoutVal.rung);
    expect(withRedVal).toEqual(withoutVal); // fully inert
  });
});

describe("computeT1Dial - two-key band arithmetic (L1 Stage 2 constants)", () => {
  it("two RED leaders floor at 7 (armed+fired reaches 9)", () => {
    // Geometry pin — the ENDPOINT only: a FULL ARM set (L = LG_CAP = 2 firing leaders) must floor at
    // exactly the deepest floor the ladder admits (LADDER_MAX − POSITION_SPAN = 7), so the band top
    // just reaches 9 and never overflows. It does NOT pin the floor's SLOPE: at L = LG_CAP the
    // `min(L, LG_CAP)/LG_CAP` ratio is 1 and the division cancels, so a step or quadratic floor
    // passes this case unchanged. The slope is pinned by the intermediate-breadth case — the lone
    // firing leader (L=1 ⇒ rung 4), above. Change one, keep the other. **Both witnesses are now
    // `rung`, not `band.lo`** (W3-b Stage 3.4): W3-b re-derives band.lo from leader disagreement, so
    // the floor must be falsifiable independently of the band it used to ride on.
    // THIS IS ALSO THE ANTI-TRANSCRIPTION FALSIFIER (DEC-B3): it passes under `lo = 1 + 3·L` and
    // FAILS under the unit-slipped `1 + 3·L/2`, which caps lo at 4 and strands rungs 8–9.
    // The ENDPOINT witness is `rung === 9` below, WITH `leadingP === 1`: rung = lo + POSITION_SPAN×1
    // ⇒ lo = 7. Under the slip lo = 4 ⇒ rung 6 ⇒ fails. (`band.lo` is the EMITTED band's floor, no
    // longer what carries the ARM-floor falsifier — the `rung`/`leadingP` pins below do.)
    // With a FIRE family firing (armed+fired) the caps don't bite and leadingP=1 rides the band top.
    const d = computeT1Dial(build({ credit: "RED", rates: "RED", volatility: "RED" }));
    expect(d.armed).toBe(true);
    expect(d.fired).toBe(true);
    // D5: leaders agree (leaderSplit 0), but the coincident set is SPLIT — vol RED fires, trend calm
    // (1 of 2 live) ⇒ coincidentSplit 1 ⇒ width 2 ⇒ the emitted band widens DOWN to 9−2=7. `max()`
    // (D3) lets coincident disagreement open slack even under a unanimous leader crisis.
    expect(d.band.lo).toBe(dialBandFor(d.targetRung, 1).lo); // split 1 ⇒ widened; targetRung 9
    expect(d.leadingP).toBe(1);
    expect(d.rung).toBe(9); // 7 + 2×1
    expect(d.targetRung).toBe(9);
    expect(d.regime).toBe("Crisis");
  });

  it("unarmed: the ceiling is max(UNARMED_CAP, shockFloor(r)) - graded by coincident RED breadth", () => {
    // DEC-B4(i) pin (was: "caps at rung 3"). No ARM family fires, so the two-key cap still pulls the
    // rung to UNARMED_CAP=3 — but the graded unarmed floor then lifts it back by coincident RED
    // BREADTH r, so the effective unarmed ceiling is max(UNARMED_CAP, shockFloor(r)), NOT a flat 3.
    // Rungs 7–9 still need both keys: shockFloor ≤ SHOCK_RUNG=6 for every r (pinned below).
    // NOTE `build()` makes only 2 coincidents live (vol, trend — cross-asset is absent), so r counts
    // out of a FIXED denominator F=3 and tops out at 2 here. That is why maxUnarmed lands on 4.33.
    const d = computeT1Dial(build({ volatility: "RED", trend: "AMBER" }));
    expect(d.armed).toBe(false);
    expect(d.fired).toBe(true);
    expect(d.coincidentP).toBe((CONTRIB.RED + dampedTrend("AMBER")) / 2); // vol RED + trend AMBER, damped (R2-1)
    // r=1 (vol RED, trend AMBER ⇒ 1 coincident RED) ⇒ CONVEX floor 1 + 5×(1/9) = 1.56, which now sits
    // BELOW the computed base (1 + span×p), so the BASE binds and the r=1 over-reaction the linear floor caused
    // is gone (Increment B): calm-ish single-RED-coincident worlds read their base, not a lifted floor.
    expect(d.rung).toBeCloseTo(1 + POSITION_SPAN * ((CONTRIB.RED + dampedTrend("AMBER")) / 2), 3);
    expect(d.regime).toBe("Calm");
    // Both live FIRE families RED ⇒ r=2 ⇒ CONVEX floor 1 + 5×(4/9) = 3.22: the unarmed ceiling is above
    // UNARMED_CAP, but still short of the 6 a FULL (r=3) coincident set would reach.
    const maxUnarmed = computeT1Dial(build({ volatility: "RED", trend: "RED" }));
    expect(maxUnarmed.armed).toBe(false);
    expect(maxUnarmed.rung).toBeCloseTo(3.222, 3);
  });

  it("two RED leaders with no FIRE family firing cap at rung 5", () => {
    // ARMED_UNFIRED_CAP=5 pin (W2-b, Alt A): armed (L=2 ⇒ lo=7, leadingP=1 ⇒ pre-cap rung 9) but no
    // coincident family fires, so the unfired cap pulls the rung — and the emitted band — down to 5.
    const d = computeT1Dial(build({ credit: "RED", rates: "RED" }));
    expect(d.armed).toBe(true);
    expect(d.fired).toBe(false);
    expect(d.rung).toBe(5); // min(9, ARMED_UNFIRED_CAP)
    expect(d.targetRung).toBe(5);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0)); // L=2 of 2 ⇒ split 0; targetRung 5
    expect(d.regime).toBe("Stress"); // dangerScore (5−1)/8 = 0.5 ⇒ Stress (≥0.5)
  });

  it("shock override: vol+cross-asset+trend jointly RED, unarmed → rung 6, never ≥7", () => {
    // THE ENDPOINT FALSIFIER (DEC-B4(i)): grading the boolean override into a floor must reproduce
    // the ratified r=F world EXACTLY — all three FIRE families live-and-RED still floor at
    // SHOCK_RUNG=6 with both leaders green, and still never reach the two-key 7–9. If this moves,
    // the re-derivation changed an endpoint it was required to preserve.
    const d = computeT1Dial(buildXa({ volatility: "RED", trend: "RED" }, "RED"));
    expect(d.armed).toBe(false);
    expect(d.shockOverride).toBe(true); // r === F, the floor's deepest reach
    expect(d.rung).toBe(6); // max(unarmed-capped 3, shockFloor(3) = SHOCK_RUNG)
    expect(d.rung).toBeLessThan(7); // 7–9 stay strictly armed+fired
    expect(d.regime).toBe("Stress");
    expect(d.headline).toContain("+ shock");
    // THE CLIFF'S PIN — this case is why DEC-B4(i) exists. vol RED + xa RED + trend AMBER ⇒ r=2:
    // under the retired boolean it fell off a cliff to the flat unarmed cap (≤3) despite two RED
    // coincidents, then jumped to 6 the instant trend turned. It now grades CONVEXLY: 1 + 5×(4/9) = 3.22.
    // Pin the EXACT value, not a range — it is the derivation's evidence, not a bound.
    const notJoint = computeT1Dial(buildXa({ volatility: "RED", trend: "AMBER" }, "RED"));
    expect(notJoint.shockOverride).toBe(false); // r=2 < F, so the headline endpoint is off…
    expect(notJoint.rung).toBeCloseTo(3.222, 3); // …but the floor still lifts, proportionally
  });

  it("the graded unarmed floor can never reach 7 - the two-key invariant, arithmetically", () => {
    // The boolean override kept 7–9 two-key by construction of its single constant. The floor keeps
    // it by ARITHMETIC (r ≤ F ⇒ shockFloor ≤ SHOCK_RUNG = 6 < 7), so assert it over EVERY r rather
    // than trusting the endpoint case above. Unarmed (both leaders green) throughout: nothing but
    // armed+fired may cross into 7.
    const worlds: Partial<Record<FamilyKey, State>>[] = [
      {}, // r=0 — floor inert
      { volatility: "RED" }, // r=1
      { volatility: "RED", trend: "RED" }, // r=2
      { volatility: "RED", trend: "RED", "cross-asset": "RED" }, // r=3 = F, the endpoint
    ];
    for (const w of worlds) {
      const xa = w["cross-asset"] ?? "GREEN";
      const d = computeT1Dial(buildXa(w, xa));
      expect(d.armed).toBe(false);
      expect(d.rung).toBeLessThan(7);
      expect(d.rung).toBeLessThanOrEqual(6); // SHOCK_RUNG is the floor's ceiling
      expect(d.band.hi).toBeLessThan(7); // two-key: an unprimed world's band top never reaches 7
    }
  });

  it("positionP does not saturate: max(leadingP .5, coincidentP) → .5, never the probabilistic OR", () => {
    // MAX replaces the old probabilistic OR: two independent moderate inputs no longer compound.
    const d = computeT1Dial(build({ credit: "RED", rates: "AMBER", volatility: "AMBER", trend: "AMBER" }));
    expect(d.leadingP).toBe(0.5); // RED(1) + AMBER(0) over 2 firing leaders
    expect(d.coincidentP).toBe((CONTRIB.AMBER + dampedTrend("AMBER")) / 2); // vol AMBER + trend AMBER, damped
    expect(d.positionP).toBe(0.5); // max(leadingP, coincidentP) — NOT 1 − (1−leadingP)(1−coincidentP)
    expect(d.positionP).toBeLessThan(1 - (1 - d.leadingP) * (1 - d.coincidentP)); // the OR would be strictly higher
    expect(d.rung).toBe(8); // lo 7 (L=2, both leaders fire) + 2×0.5
  });
});

describe("computeT1Dial - Crisis label gate (L1 Stage 5)", () => {
  it("rates-only ARM + deep FIRE set: rung 7 reads Stress, not Crisis (credit+vol both green)", () => {
    // The reachable gated case: rates RED arms (lo=4, leadingP=1 ⇒ base 6), trend RED fires,
    // cross-asset RED bumps +1 ⇒ rung 7, dangerScore 0.75 ⇒ regimeFor says Crisis — but credit AND
    // volatility are green, so the label downgrades. Label only: rung/score/band untouched.
    const d = computeT1Dial(buildXa({ rates: "RED", trend: "RED" }, "RED"));
    expect(d.rung).toBe(7);
    expect(d.targetRung).toBe(7);
    expect(d.dangerScore).toBe(0.75); // regimeFor(0.75) alone would be "Crisis"
    expect(d.regime).toBe("Stress");
    expect(d.headline).toContain("Stress");
  });

  /**
   * The W3-c AXIS-PARITY pin is gone with its families.test.ts sibling — both were
   * tripwires the cut-choice stage (§6 Q1, ruled 2026-07-18) was scheduled to delete.
   * Asserting the two emitted fields agree would forbid the very divergence the split
   * exists to allow.
   *
   * What it was ALSO covering, and what must not be lost: the Crisis gate is applied to
   * the NOTIFY axis, not just the display one. §6 Q2 ruled the gate stays on both, so
   * that is now pinned directly — a hand-mirrored gate that drifted off `notifyRegime`
   * shows up here and nowhere else.
   */
  it("the Crisis gate demotes the NOTIFY axis too (§6 Q2 - gate on both)", () => {
    // THE GATED WORLD: rates-only ARM with credit AND volatility green — scores Crisis,
    // must read Stress on the axis that decides what reaches the phone.
    const gated = computeT1Dial(buildXa({ rates: "RED", trend: "RED" }, "RED"));
    expect(gated.dangerScore).toBeGreaterThanOrEqual(NOTIFY_REGIME_CUTS.crisis);
    expect(gated.notifyRegime).toBe("Stress");
    // Ungated: credit RED, so the gate does not fire and the top tier survives.
    expect(computeT1Dial(build({ credit: "RED", rates: "RED", volatility: "RED" })).notifyRegime).toBe("Crisis");
  });

  /**
   * `dangerScore` and the notify cuts now share ONE span helper (`rungCut`, families.ts),
   * so cross-module drift is gone by construction rather than by assertion — and a test
   * that only re-checked `rungCut` against a literal here would be circular.
   *
   * What this still pins is the WIRING: that `dangerScore` is the rung restated through
   * `rungCut` and nothing else. A future edit deriving it from a different quantity (a
   * raw positionP, a pre-cap rung, a second span) goes red here — that mutation is
   * unreachable from `rungCut`'s own unit coverage.
   *
   * `toBe`, not `toBeCloseTo`: every `(r − 1) / 8` has a power-of-two denominator and is
   * exactly representable, and that exactness IS option C's premise ("cannot drift off
   * the rung grid"). A tolerance here would admit precisely the drift the design forbids.
   */
  it("the dial's dangerScore is exactly rungCut(rung), across the reachable rung span", () => {
    const worlds: Partial<Record<FamilyKey, State>>[] = [
      {}, // Calm floor — the bottom of the span
      { volatility: "AMBER" },
      { credit: "RED" }, // armed leader
      { credit: "RED", volatility: "RED" },
      { rates: "RED", trend: "RED" },
      { credit: "RED", rates: "RED", volatility: "RED" }, // the top of the span
    ];
    const rungs = new Set<number>();
    for (const w of worlds) {
      const d = computeT1Dial(build(w));
      expect(d.dangerScore, `dangerScore off-grid at ${JSON.stringify(w)}`).toBe(rungCut(d.rung));
      rungs.add(d.rung);
    }
    // Vacuity guard: the sweep must actually exercise a spread of rungs, or it would pass
    // just as well with every world stuck on the Calm floor.
    expect(rungs.size).toBeGreaterThanOrEqual(3);
    // The graded half-step too — `rung` is continuous, so the identity must hold off the
    // integer grid as well, which is where a rewritten derivation is most likely to drift.
    const half = computeT1Dial(buildXa({ credit: "RED" }, "AMBER"));
    expect(half.rung % 1).toBe(0.5); // guard: this world really is off-integer
    expect(half.dangerScore).toBe(rungCut(half.rung));
  });
});

describe("computeT1Dial - graded systemic bump (L1 Stage 3 constants)", () => {
  it("cross-asset AMBER + second firing family → +0.5", () => {
    // SYSTEMIC_BUMP_AMBER=0.5 pin: credit RED arms (lo=4, leadingP=1 ⇒ base 6); cross-asset AMBER
    // beside that firing leader adds the graded half-step.
    const d = computeT1Dial(buildXa({ credit: "RED" }, "AMBER"));
    expect(d.systemicBump).toBe(0.5);
    expect(d.rung).toBe(6.5); // 4 + 2×1 + 0.5
  });

  it("cross-asset RED + second firing family → +1", () => {
    // SYSTEMIC_BUMP_RED=1 pin: same armed+fired base 6, full-step bump.
    const d = computeT1Dial(buildXa({ credit: "RED" }, "RED"));
    expect(d.systemicBump).toBe(1);
    expect(d.rung).toBe(7); // 4 + 2×1 + 1 — armed+fired, so the caps don't bite
  });

  it("isolated cross-asset RED → bump 0", () => {
    // Second-family gate pin: no OTHER ARM∪FIRE family fires, so cross-asset RED alone is a
    // rotation, not systemic — bump 0 (and no +1 manufactured, the pre-Stage-3 notify defect).
    const d = computeT1Dial(buildXa({}, "RED"));
    expect(d.systemicBump).toBe(0);
    // The bump is what this pins; the rung is a bystander since DEC-B4(i) — xa RED is r=1, so the
    // CONVEX unarmed floor (1.56) now sits BELOW the computed base 1.67 (Increment B), so the rung
    // reads the BASE, not the floor. Assert the gate's own primitive, and keep the rung only as the
    // "no +1 was manufactured" witness: 1.67 IS the base, whereas a leaked bump would put it at 1.67 + 1.
    expect(d.rung).toBeCloseTo(1 + 2 / 3, 5); // the r=1 base exactly — floor inert here, no bump folded in
  });

  it("bump cannot lift an unarmed dial past the unarmed ceiling - the cap still bites pre-floor", () => {
    // Pipeline-order pin (retitled by DEC-B4(i): the ceiling is no longer the flat UNARMED_CAP).
    // The bump still lands BEFORE the two-key caps, and that ordering is what this pins: vol RED
    // gates the bump on ⇒ pre-cap 1 + 2×(2/3) + 1 = 3.33, which the unarmed cap pulls to 3 — the
    // bump buys NOTHING. The CONVEX floor then re-lifts to the r=2 value (vol RED + xa RED ⇒ 3.22),
    // which is the floor's doing, not the bump's: a leaked bump would read 4.22.
    const d = computeT1Dial(buildXa({ volatility: "RED" }, "RED"));
    expect(d.armed).toBe(false);
    expect(d.systemicBump).toBe(1);
    expect(d.rung).toBeCloseTo(3.222, 3); // = shockFloor(2), NOT 3.33+1 — the cap ate the bump
  });
});

describe("computeT1Dial - Stage 6.1 tiers (super-group-derived: EARLY-WARN selects, STRESS-NOW + trend confirm)", () => {
  /** All 6 non-exogenous families as the live path serves them: 5 live (GREEN unless
   *  overridden) + the valuation family non-live. */
  const fullBuild = (overrides: Partial<Record<FamilyKey, State>> = {}): FamilyPanel[] => {
    const live: FamilyKey[] = ["credit", "rates", "volatility", "cross-asset", "trend"];
    return [
      ...live.map((k) => panel(k, overrides[k] ?? "GREEN")),
      panel("valuation", "GREEN", false), // feedless stub — never live on the live path
    ];
  };

  it("STRESS-NOW-only firing positions the ● and now grades ABOVE calm, but never reaches the two-key 7-9", () => {
    // NARROWED by DEC-B4(i) (was: "can NEVER leave the calm band"). Two live-and-RED STRESS-NOW
    // families (vol, xa) ⇒ r=2 ⇒ the CONVEX unarmed floor lifts to 3.22, crossing into Caution.
    // What STRESS-NOW breadth still cannot do is manufacture a CRISIS band — that needs an
    // EARLY-WARN leader, and this case pins the surviving bound arithmetically.
    const d = computeT1Dial(fullBuild({ volatility: "RED", "cross-asset": "RED" }));
    expect(d.leadingFiring).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.shockOverride).toBe(false); // trend not RED ⇒ r=2 < F, so not the floor's endpoint
    expect(d.coincidentP).toBeCloseTo(2 / 3, 5); // 2 RED over 3 live coincident (vol, xa, trend)
    // pre-floor: 1 + 2×(2/3) + 1 (systemic bump: xa RED beside firing vol) = 3.333 → unarmed-capped
    // at 3 → the r=2 convex floor re-lifts it to 3.22. Regime Caution, and 7–9 remain unreachable.
    expect(d.systemicBump).toBe(1);
    expect(d.rung).toBeCloseTo(3.222, 3);
    expect(d.targetRung).toBe(3); // was 4 under the linear floor — convex r=2 rounds down to 3 (regime stays Caution)
    expect(d.rung).toBeLessThan(7); // no EARLY-WARN leader ⇒ no crisis band, still by construction
  });

  it("trend (CONFIRMING) deepens the ● and carries the band with it, but never changes the band's WIDTH or which leaders selected it", () => {
    const without = computeT1Dial(fullBuild({ credit: "AMBER" }));
    const withTrend = computeT1Dial(fullBuild({ credit: "AMBER", trend: "RED" }));
    expect(without.rung).toBe(4); // lone-firing-leader breadth floor (L=1), no within-band pressure
    expect(withTrend.leadingFiring).toBe(1); // trend never counts as a leader
    expect(withTrend.fired).toBe(true); // …but it IS a FIRE family
    // W3-b §4.2 #15 — the claim is GENUINELY NARROWED, not bent to green. Under the new emission the
    // band is anchored to the ●, and this confirmer DOES move the ● (t=4 → 5), so `band.lo` moves with
    // it (2 → 3). What a CONFIRMING family still cannot do is change the band's WIDTH (leader
    // disagreement is its sole input) or its SELECTION (`leadingFiring`, pinned at :580).
    expect(withTrend.band.hi - withTrend.band.lo).toBe(without.band.hi - without.band.lo); // both 2
    expect(withTrend.leadingFiring).toBe(without.leadingFiring);
    // 1 RED (trend, DAMPED per R2-1) over 3 live coincident
    const cp = dampedTrend("RED") / 3;
    expect(withTrend.coincidentP).toBeCloseTo(cp, 5);
    expect(withTrend.rung).toBeCloseTo(4 + POSITION_SPAN * cp, 5); // ● pushed up within [lo, lo+2] only
  });

  it("valuation is EXCLUDED from LEADING - a present+RED valuation (scenario `?s=`) cannot select the band", () => {
    // The scenario path makes the feedless stub PRESENT-when-set; if valuation counted as a leader
    // it would widen LG_CAP to 3, rescaling the floor under every world (a real calibration change,
    // no longer a rung overflow — the floor derives from the ARM set). Guard the exclusion.
    const withVal = [...fullBuild().filter((f) => f.key !== "valuation"), panel("valuation", "RED")];
    const d = computeT1Dial(withVal);
    expect(d.leadingFiring).toBe(0); // valuation fires nowhere in the dial
    expect(d.coincidentFiring).toBe(0);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0));
    expect(d.rung).toBe(1);
  });

  // DELETED 2026-07-17 — "macro-cycle RED neither arms nor lifts the floor (L unchanged) — ARM =
  // credit + rates only" [USER 2026-07-16, L1 qimpag round]. It guarded the explicit
  // `k !== "macro-cycle"` exclusion clause in t1dial.ts's `LEADING`: a firing mc must not change L.
  // The `macro-cycle` key was removed, which made that clause dead code; it went too,
  // so the test cannot be constructed (`panel("macro-cycle", …)` no longer typechecks) and its
  // subject no longer exists. NOT bent to green.
  //
  // What the clause's removal had to preserve — `LEADING` = [credit, rates] ⇒ `LG_CAP` = 2 — is NOT
  // left uncovered: `LEADING`/`LG_CAP` are module-private, but the pair is pinned BEHAVIORALLY by
  // the two-key band arithmetic above ("a lone firing leader ⇒ lo 4" for the slope + "two RED
  // leaders floor at 7" for the endpoint). Those bracket LG_CAP exactly: the floor is
  // `1 + (9−1−2)·min(L,LG_CAP)/LG_CAP`, so an LG_CAP that drifted to 3 (mc or valuation leaking
  // back into the ARM set) would put L=2 at lo = 1 + 6·(2/3) = 5, not 7, and fail that test.
});

// Rank 7 (fail-toward-calm): a MISSING tech-confirmer member is confirmer-non-live (a null slot
// that fires the onMissing degrade hook), NOT a silent calm GREEN. `techConfirmerBreadth` treats
// null == not-firing in the fixed /2 denominator, so the number is unchanged — the null just makes
// the drop observable (the run loop emits a degrade event) instead of scoring it as calm.
// The confirmer is {F4,F5} since NVDA was demoted to detail-only 2026-07-22 (denominator /2, 2-of-2).
describe("techConfirmerFromPanel - missing member is non-live, not GREEN (rank 7)", () => {
  it("returns null for an absent member and calls onMissing with its id", () => {
    // Only F4 present (RED); F5 dropped from the panel.
    const families = [{ members: [mem("F4", "RED")] }];
    const missing: string[] = [];
    const slots = techConfirmerFromPanel(families, (id) => missing.push(id));
    expect(slots).toEqual(["RED", null]); // memberScaledBand(F4,RED)=RED (0.8 weight bands to RED), F5 null
    expect(missing.sort()).toEqual(["F5"]);
  });

  it("both present + firing ⇒ 2-of-2 clears the floor; one missing drops below it ⇒ 0", () => {
    const both = [{ members: [mem("F4", "RED"), mem("F5", "RED")] }];
    const slots = techConfirmerFromPanel(both);
    // ⚠ ASYMMETRIC SINCE THE 2026-08-30 F5 DEMOTION: both members are RED on the panel, but the slots
    // are `memberScaledBand`, not raw states. F4 (0.8 on Semis) still scales to RED; F5's demoted row
    // scales BELOW `SEV_CUTS.red`, so its slot reads AMBER. Both still COUNT as firing, so the 2-of-2
    // floor is met and the denominator is still /2 — what moved is the depth, not the gate.
    expect(slots).toEqual(["RED", "AMBER"]);
    expect(techConfirmerBreadth(slots)).toBe(0.75); // (1+0.5)/2 — the /2 denominator stands
    // F5 missing → one slot null (< floor 2) ⇒ 0, and the null is observable (degrade), not calm.
    const oneMissing = techConfirmerFromPanel([{ members: [mem("F4", "RED")] }]);
    expect(oneMissing).toEqual(["RED", null]);
    expect(techConfirmerBreadth(oneMissing)).toBe(0);
  });

  it("all present + GREEN differs from all missing only in the missing count (both breadth 0)", () => {
    const allGreen = [{ members: [mem("F4", "GREEN"), mem("F5", "GREEN")] }];
    const missGreen: string[] = [];
    expect(techConfirmerFromPanel(allGreen, (id) => missGreen.push(id))).toEqual(["GREEN", "GREEN"]);
    expect(missGreen).toEqual([]); // present-GREEN is NOT a miss
    const none: string[] = [];
    expect(techConfirmerFromPanel([{ members: [] }], (id) => none.push(id))).toEqual([null, null]);
    expect(none.sort()).toEqual(["F4", "F5"]); // both missing → both fire the hook
  });

  // D-C (2026-07-21 fast-breaks EARLY-WARN redesign) REVERTED the B5 F4→DB_SMH swap: F4's confirmed
  // RED casts the semis slot vote again, and DB_SMH's does NOT (DB_SMH left the trend panel in D-D
  // and now feeds the EARLY-WARN sub-signal instead). This pins BOTH directions of the revert on the
  // panel-read path (V-noStrand: F4 resolves off the panel, the slot is not stranded).
  it("revert - F4 RED counts in the confirmer; DB_SMH RED does not", () => {
    // F4 RED + F5 RED ⇒ 2-of-2 fires (0.75 post-demotion). Swap F4's id to DB_SMH with the SAME states and the
    // semis slot goes MISSING (DB_SMH is not a slot) ⇒ breadth 0. That contrast is the revert.
    const withF4 = techConfirmerFromPanel([
      { members: [mem("F4", "RED"), mem("F5", "RED")] },
    ]);
    expect(withF4).toEqual(["RED", "AMBER"]); // F5's slot is AMBER post-demotion; it still FIRES
    expect(techConfirmerBreadth(withF4)).toBe(0.75);

    const missedIds: string[] = [];
    const withDbSmhInstead = techConfirmerFromPanel(
      [{ members: [mem("DB_SMH", "RED"), mem("F5", "RED")] }],
      (id) => missedIds.push(id),
    );
    // F4 slot missing, DB_SMH ignored; F5's slot is AMBER (not RED) since the 2026-08-30 demotion.
    expect(withDbSmhInstead).toEqual([null, "AMBER"]);
    expect(missedIds).toContain("F4"); // the semis slot now reads F4, not DB_SMH
    expect(missedIds).not.toContain("DB_SMH");
    expect(techConfirmerBreadth(withDbSmhInstead)).toBe(0); // 1-of-2 firing < floor
  });
});

// [USER DECISION 2026-07-22 — LOCKED: BOTH] — the {F4,F5} 2-of-2 collapse (NVDA demoted to
// detail-only). The {F4,F5} slot shape (2 slots, NVDA never looked up) is pinned by the
// `techConfirmerFromPanel` describe above — its exact `toEqual` slot arrays and onMissing sets carry
// no 3rd slot. This pins the FLOOR at exactly 2, from BOTH directions of the arithmetic below.
describe("techConfirmer - {F4,F5} 2-of-2 collapse is LOCKED (NVDA demote 2026-07-22)", () => {
  it("2-of-2 arithmetic over the /2 denominator: 1 firing ⇒ 0 (either slot), both fire ⇒ /2 mean", () => {
    // The breadth denominator IS states.length, so a 2-length input divides by 2 by construction.
    // Below FLOOR: one firing slot (amber-or-worse) ⇒ 0 in BOTH orderings. Bumping TECH_CONFIRMER_FLOOR
    // to 3 reddens the two-firing rows below; dropping it to 1 reddens these four — both directions
    // bind the FLOOR at exactly 2.
    for (const one of [
      ["RED", "GREEN"],
      ["GREEN", "RED"],
      ["AMBER", "GREEN"],
      ["GREEN", "AMBER"],
    ] as State[][]) {
      expect(techConfirmerBreadth(one)).toBe(0);
    }
    // FLOOR cleared (both fire): full-weight non-zero deepener, and the /2 mean once cleared.
    expect(techConfirmerBreadth(["RED", "RED"])).toBe(1); // (1+1)/2 — both RED, full depth
    expect(techConfirmerBreadth(["AMBER", "RED"])).toBe(0.75); // (0.5+1)/2 — the /2 mean, FLOOR cleared
    expect(techConfirmerBreadth(["AMBER", "AMBER"])).toBe(0.5); // (0.5+0.5)/2 — smallest firing set that scores
  });
});

// W3-b Stage 3.1 — the measure, asserted standalone before it is wired to any emission.
// The table below IS the anti-double-count argument: split is constant across the {A,G}→{R,G} DEPTH
// step and non-monotone in leadingP (0 → 1 → 0 down the rows), which a depth-spread measure could
// not be. Any change making {A,G} ≠ {R,G} has re-introduced Finding F.
describe("firingSplit - corroboration on the FIRING partition (W3-b)", () => {
  const lead = (credit: State, rates: State) => [panel("credit", credit), panel("rates", rates)];

  it("the 6 reachable N=2 leader worlds: split=1 iff exactly one leader fires", () => {
    expect(firingSplit(lead("GREEN", "GREEN"))).toBe(0);
    expect(firingSplit(lead("AMBER", "GREEN"))).toBe(1);
    expect(firingSplit(lead("RED", "GREEN"))).toBe(1); // depth-blind: same as AMBER,GREEN
    expect(firingSplit(lead("AMBER", "AMBER"))).toBe(0);
    expect(firingSplit(lead("RED", "AMBER"))).toBe(0); // both fire ⇒ they AGREE, despite the depth gap
    expect(firingSplit(lead("RED", "RED"))).toBe(0);
  });

  it("N<2: a lone firing channel is maximally uncorroborated, a silent one makes no claim", () => {
    expect(firingSplit([panel("credit", "AMBER")])).toBe(1);
    expect(firingSplit([panel("credit", "RED")])).toBe(1); // still depth-blind
    expect(firingSplit([panel("credit", "GREEN")])).toBe(0);
    expect(firingSplit([])).toBe(0);
  });
});

describe("computeT1Dial - the EMITTED band's width is leader disagreement (W3-b Stage 3.5)", () => {
  it("depth-blind width - a lone leader stepping AMBER→RED moves the ● one rung and leaves the width at 3", () => {
    // THE direct Finding-F guard on the new axis. Both worlds are L=1 of 2 live ⇒ split 1 ⇒ width 3 rungs.
    // Depth is spent entirely on the ● (targetRung 4 → 5); if depth ever leaked into the width, this
    // is where it would show. Fails under any width that reads leader DEPTH (e.g. a Lg-spread measure).
    const amber = computeT1Dial(build({ credit: "AMBER" }));
    const red = computeT1Dial(build({ credit: "RED" }));
    expect(red.targetRung - amber.targetRung).toBe(1); // the ● moved…
    expect(amber.band.hi - amber.band.lo).toBe(3);
    expect(red.band.hi - red.band.lo).toBe(3); // …the width did not
  });

  it("unanimity is depth-blind too - {A,A} and {R,R} both emit the base width despite leadingP 0 vs 1", () => {
    // Both worlds are FIRED (volatility RED), so ARMED_UNFIRED_CAP doesn't bite and the ● is free to
    // separate — which it does (leadingP 0 vs 1). The width stays 0 in both: two leaders that agree
    // leave nothing to be ambiguous about, however deep the agreement runs.
    // trend RED too (D5): holds the COINCIDENT axis unanimous (vol+trend both fire ⇒ coincidentSplit
    // 0) so this case isolates the LEADER-unanimity claim — otherwise a lone volatility firing would
    // widen via the new coincident axis and this would stop testing leader agreement.
    // The width stays at the base in both: two leaders that agree leave nothing ambiguous.
    const shallow = computeT1Dial(build({ credit: "AMBER", rates: "AMBER", volatility: "RED", trend: "RED" }));
    const deep = computeT1Dial(build({ credit: "RED", rates: "RED", volatility: "RED", trend: "RED" }));
    expect(shallow.leadingP).toBe(0);
    expect(deep.leadingP).toBe(1);
    expect(shallow.band.hi - shallow.band.lo).toBe(POSITION_SPAN);
    expect(deep.band.hi - deep.band.lo).toBe(POSITION_SPAN);
    expect(shallow.band).toEqual(dialBandFor(shallow.targetRung, 0));
    expect(deep.band).toEqual(dialBandFor(deep.targetRung, 0));
  });

  it("degrade branch pins the TWO DENOMINATORS - split over nLive, ARM floor over LG_CAP", () => {
    // credit AMBER with rates NON-LIVE. The split sees nLive=1, L=1 ⇒ 1 ⇒ width 2 (a lone unopposed
    // channel is maximally uncorroborated). The ARM floor still divides by LG_CAP=2, NOT by nLive —
    // a dropped feed must not inflate the floor to the full-ARM-set depth of 7. Floor 4, leadingP 0,
    // unfired ⇒ rung 4. If the floor were renormalised to nLive it would read 7 and this goes red.
    const d = computeT1Dial([
      panel("credit", "AMBER"),
      panel("rates", "GREEN", false), // feed dropped this run
      panel("volatility", "GREEN"),
      panel("trend", "GREEN"),
    ]);
    expect(d.leadingFiring).toBe(1);
    expect(d.leadingP).toBe(0);
    expect(d.rung).toBe(4); // ARM floor over LG_CAP=2 ⇒ 1 + 3·1
    expect(d.targetRung).toBe(4);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 1)); // split 1 over nLive=1 ⇒ fixed-width band
  });

  it("D5: a LONE coincident firing (cross-asset only) widens the band by one leg over the calm control", () => {
    // The coincident-axis analogue of the lone-leader guard. cross-asset RED firing while vol+trend
    // are calm ⇒ coincident firing partition p=1/3 ⇒ split 4·(1/3)(2/3)=0.89 (rounds to 1) ⇒ width
    // POSITION_SPAN+1 = 3 rungs (4 legs); no leader fires. Depth-blind: cross-asset RED vs AMBER gives
    // the SAME split. Band derived from the formula, never re-typed.
    const d = computeT1Dial(buildXa({}, "RED"));
    expect(d.leadingFiring).toBe(0);
    expect(d.coincidentFiring).toBe(1);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0.89)); // the world's coincident split
    // Control: the SAME world with cross-asset calm ⇒ split 0 ⇒ the base 3-leg band. If the width read
    // coincident DEPTH instead of the firing partition, this control would also widen.
    const pinned = computeT1Dial(buildXa({}, "GREEN"));
    expect(pinned.band).toEqual(dialBandFor(pinned.targetRung, 0));
    expect(d.band.hi - d.band.lo).toBeGreaterThan(pinned.band.hi - pinned.band.lo); // firing opened a leg
  });

  it("D5: ALL THREE coincident firing (broad, corroborated shock) keeps the coincident width at the base", () => {
    // vol+cross-asset+trend all RED firing ⇒ coincident p=1 ⇒ split 0 ⇒ NO extra slack — a
    // corroborated shock must not open the band beyond its base width. (No leader fires ⇒ leaderSplit 0.)
    const d = computeT1Dial(buildXa({ volatility: "RED", trend: "RED" }, "RED"));
    expect(d.coincidentFiring).toBe(3);
    expect(d.band).toEqual(dialBandFor(d.targetRung, 0)); // both axes unanimous ⇒ base band
  });

  it("dialBandFor always spans 3 or 4 legs, inside [LADDER_MIN, LADDER_MAX] - the fixed-width contract", () => {
    // The step-1 guarantee: width = POSITION_SPAN + round(split) ∈ {2,3} rungs, so hi−lo+1 ∈ {3,4}
    // legs for EVERY (targetRung, split), and both clamps hold. Reverting dialBandFor's body reds this.
    for (let targetRung = LADDER_MIN; targetRung <= LADDER_MAX; targetRung++) {
      for (const split of [0, 0.3, 0.5, 0.8, 1]) {
        const b = dialBandFor(targetRung, split);
        const legs = b.hi - b.lo + 1;
        expect(legs, `targetRung=${targetRung} split=${split}`).toBeGreaterThanOrEqual(3);
        expect(legs, `targetRung=${targetRung} split=${split}`).toBeLessThanOrEqual(4);
        expect(b.lo).toBeGreaterThanOrEqual(LADDER_MIN);
        expect(b.hi).toBeLessThanOrEqual(LADDER_MAX);
      }
    }
  });
});

// EARLY-WARN sub-signal fire (fast-breaks redesign §1) — K-threshold=AMBER, K-breadth=any-single.
describe("earlyWarnFires - the capped fast-break sub-signal (fast-breaks redesign §1)", () => {
  // ONE truth table (K-threshold=AMBER, K-breadth=any-single, the RS AND-gate). Rows that carry a
  // ruling: DB_XLK fires the floor ALONE with DB_SMH calm (SP500IT coverage rung 1, 2026-07-23 — no
  // N-of-M gate; reverting EARLY_WARN_MEMBERS to ["DB_SMH"] reds those rows); the ew AND-gate (2026-08-15
  // plan Stage 2) — a member fires only when its break AND its RS_LEG_OF rel-strength sibling are both
  // AMBER+, RS alone never fires (it is not a member), and an ABSENT RS leg degrades to break-only (gate
  // OPEN — ew is a safety signal, data loss must not silence it).
  it.each([
    ["DB_SMH AMBER (AMBER = fire)", true, [mem("DB_SMH", "AMBER")]],
    ["DB_SMH RED", true, [mem("DB_SMH", "RED")]],
    ["DB_SMH GREEN (calm)", false, [mem("DB_SMH", "GREEN")]],
    ["absent reading (fail-toward-calm)", false, []],
    ["non-member RED never fires", false, [mem("F1", "RED")]],
    ["DB_XLK AMBER alone, DB_SMH calm", true, [mem("DB_SMH", "GREEN"), mem("DB_XLK", "AMBER")]],
    ["DB_XLK RED alone, DB_SMH calm", true, [mem("DB_SMH", "GREEN"), mem("DB_XLK", "RED")]],
    ["both detectors GREEN", false, [mem("DB_SMH", "GREEN"), mem("DB_XLK", "GREEN")]],
    ["AND-gate: DB_SMH AMBER, RS_SMH GREEN vetoes", false, [mem("DB_SMH", "AMBER"), mem("RS_SMH", "GREEN")]],
    ["AND-gate: DB_SMH RED + RS_SMH AMBER", true, [mem("DB_SMH", "RED"), mem("RS_SMH", "AMBER")]],
    ["AND-gate: RS_SMH RED alone (not a member)", false, [mem("DB_SMH", "GREEN"), mem("RS_SMH", "RED")]],
    ["AND-gate: XLK pair past cut, SMH pair calm", true, [mem("DB_SMH", "GREEN"), mem("RS_SMH", "GREEN"), mem("DB_XLK", "AMBER"), mem("RS_XLK", "AMBER")]],
    ["AND-gate: XLK break, its OWN RS intact vetoes", false, [mem("DB_SMH", "GREEN"), mem("RS_SMH", "GREEN"), mem("DB_XLK", "AMBER"), mem("RS_XLK", "GREEN")]],
    ["absent RS leg: DB_XLK RED degrades to break-only", true, [mem("DB_XLK", "RED")]],
  ] as const)("%s ⇒ fires %s", (_label, fires, members) => {
    expect(earlyWarnFires([...members])).toBe(fires);
  });

});

describe("computeT1Dial - slowArmed regime-conditioning (bubble-arming K1)", () => {
  // A dangerScore strictly inside the armed-shift window (cut·ARMED_CUT_SCALE ≤ score < cut),
  // derived FROM the constants: one AMBER leader → lo=4, leadingP=coincidentP=0, so
  // rung = 4 + POSITION_SPAN·techP; rungCut is linear with rungCut(2)−rungCut(1) per rung.
  const cut = NOTIFY_REGIME_CUTS.stress;
  const score = (cut * (1 + ARMED_CUT_SCALE)) / 2;
  const rungAt = 1 + score / (rungCut(2) - rungCut(1));
  const techP = (rungAt - 4) / POSITION_SPAN;

  it("armed shifts the notifyRegime across a cut the unarmed dial sits just below", () => {
    const unarmed = computeT1Dial(build({ credit: "AMBER" }), techP);
    // fixture premise guard — the score really is between cut·scale and cut
    expect(unarmed.dangerScore).toBeGreaterThanOrEqual(cut * ARMED_CUT_SCALE);
    expect(unarmed.dangerScore).toBeLessThan(cut);
    const armed = computeT1Dial(build({ credit: "AMBER" }), techP, true);
    expect(armed.notifyRegime).not.toBe(unarmed.notifyRegime);
    // the exact ruled mechanism: notifyRegimeFor(score / f), re-gated (credit fires here)
    expect(armed.notifyRegime).toBe(
      applyCrisisGate(notifyRegimeFor(unarmed.dangerScore / ARMED_CUT_SCALE), true, false),
    );
    // ONLY the notify axis moves — band/rung/regime/dangerScore/headline all byte-identical
    expect({ ...armed, notifyRegime: unarmed.notifyRegime }).toEqual(unarmed);
  });

  it("slowArmed=false (explicit or default) is byte-identical", () => {
    expect(computeT1Dial(build({ credit: "AMBER" }), techP, false)).toEqual(
      computeT1Dial(build({ credit: "AMBER" }), techP),
    );
    expect(computeT1Dial(build(), 0, false)).toEqual(computeT1Dial(build()));
  });

  it("the armed shift is re-gated: a crossing into Crisis without credit/vol firing is demoted", () => {
    // rates RED (arm) + trend RED (fire) + cross-asset AMBER bump lands the score inside the
    // CRISIS shift window; credit and volatility both quiet ⇒ the crisis gate holds the line.
    const crisis = NOTIFY_REGIME_CUTS.crisis;
    const world = () => buildXa({ rates: "RED", trend: "RED" }, "AMBER");
    const unarmed = computeT1Dial(world());
    expect(unarmed.dangerScore).toBeGreaterThanOrEqual(crisis * ARMED_CUT_SCALE);
    expect(unarmed.dangerScore).toBeLessThan(crisis);
    // the UN-gated shift would cross into Crisis…
    expect(notifyRegimeFor(unarmed.dangerScore / ARMED_CUT_SCALE)).toBe("Crisis");
    // …but the gate demotes it, so armed = unarmed here
    const armed = computeT1Dial(world(), 0, true);
    expect(armed.notifyRegime).toBe(unarmed.notifyRegime);
    expect(armed.notifyRegime).toBe("Stress");
  });
});

describe("D1 pin + D3/D4 derivations", () => {
  // The reproduction as a fixture: a non-seated credit
  // member RED must not move the dial.
  // credit RED-via-F10 (band-green) + cross-asset RED-via-FXH + valuation AMBER-via-ECY.
  const reproPanel = () => {
    const rows = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].map((id) => {
      const state: State = id === "F10" || id === "FXH" ? "RED" : id === "ECY" ? "AMBER" : "GREEN";
      return { id, state };
    });
    return computeFamilyPanel(rows, DIAL_FAMILIES).families;
  };

  it("a non-seated credit member DEEPENS via legP (D6) but never ARMS (D1 pin)", () => {
    const d = computeT1Dial(reproPanel());
    // D1 invariant intact: F10/ECY still do not arm (leadingFiring 0, armed false). D6 now DEEPENS —
    // legP √½ lifts positionP above coincidentP 0.333 ⇒ rung 1.667→2.414, dangerScore 0.0833→0.1768.
    expect(d.leadingFiring).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.coincidentFiring).toBe(1); // cross-asset only
    expect(d.coincidentP).toBeCloseTo(1 / 3, 10);
    expect(d.legP).toBeCloseTo(Math.SQRT1_2, 12); // F10 RED alone of the two off-band rowed credit members
    expect(d.rung).toBeCloseTo(1 + POSITION_SPAN * Math.SQRT1_2, 12); // 1 + POSITION_SPAN×legP
    expect(d.dangerScore).toBeCloseTo(0.17678, 5);
    expect(d.regime).toBe("Calm");
  });

  it("credit reads its BAND role: green + a cannot-arm RED, firingCount drops (D1/D2)", () => {
    const { families, firingCount } = computeFamilyPanel(
      [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].map((id) => ({
        id,
        state: (id === "F10" ? "RED" : "GREEN") as State,
      })),
      DIAL_FAMILIES,
    );
    const credit = families.find((f) => f.key === "credit")!;
    expect(credit.state).toBe("GREEN"); // seated members are green; F10 is not seated
    expect(credit.firing).toBe(false);
    expect(credit.band!.firing).toBe(false);
    expect(credit.cannotArm).toEqual({ count: 1, worst: "RED", worstCount: 1 }); // F10: amber-or-worse, off the band
    expect(firingCount).toBe(0); // no family fires; denominator (liveFamilyCount) is untouched
  });

  // D3 §4.5: the grey set = {ids in a family roster} \ {ids in MEMBER_WEIGHT}. leg-only = the rest bar PER_LEG_ONLY_MEMBERS.
  it("member tone: grey = roster ids without a MEMBER_WEIGHT row, leg-only = with one", () => {
    const rosterIds = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];
    const weighted = new Set(Object.keys(MEMBER_WEIGHT));
    const grey = rosterIds.filter((id) => !weighted.has(id));
    const legOnly = rosterIds.filter((id) => weighted.has(id));
    expect(grey.length).toBeGreaterThan(0); // vacuity guard: some roster id is rowless
    expect(legOnly.length).toBeGreaterThan(0);
    for (const id of grey) expect(memberTone(id, []), `${id} grey`).toBe("grey");
    for (const id of legOnly) {
      const want = PER_LEG_ONLY_MEMBERS.includes(id) ? "per-leg" : "leg-only";
      expect(memberTone(id, []), `${id} ${want}`).toBe(want);
    }
    expect(PER_LEG_ONLY_MEMBERS.every((id) => legOnly.includes(id))).toBe(true); // the pair is rostered + weighted
    // an id in the band-driving set is `live` regardless of its MEMBER_WEIGHT row.
    expect(memberTone(legOnly[0]!, [legOnly[0]!])).toBe("live");
    expect(LEG_WEIGHTED_IDS.has(legOnly[0]!)).toBe(true);
  });
});

describe("D6 legP - per-leg / no-arm members deepen the dial", () => {
  const weighted = new Set(Object.keys(MEMBER_WEIGHT));

  it("legP counts rowed off-band members only, plus every rowed NO_ARM (valuation) member", () => {
    // vacuity: a rowless id and rowed ids are present so each excluded arm would move legP if leaked.
    expect(weighted.has("T5YIFR")).toBe(false);
    expect(weighted.has("F1") && weighted.has("F10") && weighted.has("ECY")).toBe(true);

    // Panel A — credit wins the max: F10 rowed+off-band (in), F1 rowed+on-band (excluded), T5YIFR
    // rowless (excluded) ⇒ legP √¼=0.5. Leaking F1 (drop ∖bandIds) or T5YIFR (drop rowed) ⇒ 0.79.
    const credit: FamilyPanel = {
      ...panel("credit", "GREEN"),
      band: { state: "GREEN", firing: false, contribution: 0, ids: ["F1"] },
      members: [
        memL("F10", "AMBER"),
        memL("F1", "RED"),
        memL("T5YIFR", "RED"),
      ],
    };
    const panelA = [credit, panel("rates", "GREEN"), panel("volatility", "GREEN"), panel("trend", "GREEN")];
    expect(computeT1Dial(panelA).legP).toBe(0.5);

    // Panel B — valuation (∈ NO_ARM) wins: ECY rowed+on-band still leg-only ⇒ legP 1. Dropping the
    // NO_ARM arm would exclude the in-band ECY ⇒ legP 0.
    const valuation: FamilyPanel = {
      ...panel("valuation", "GREEN"),
      band: { state: "RED", firing: true, contribution: 1, ids: ["ECY"] },
      members: [memL("ECY", "RED")],
    };
    const panelB = [valuation, panel("credit", "GREEN"), panel("rates", "GREEN"), panel("volatility", "GREEN"), panel("trend", "GREEN")];
    expect(computeT1Dial(panelB).legP).toBe(1);
  });

  it("motivating panel: legP √½, dangerScore 0.0833→0.1768, armed false, lo 1, band WIDTH byte-unchanged vs legP=0", () => {
    const rowsFor = (redAmber: boolean): FamilyPanel[] => {
      const rows = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].map((id) => {
        const on = redAmber ? id === "F10" || id === "FXH" || id === "ECY" : id === "FXH";
        const state: State = on ? (id === "ECY" ? "AMBER" : "RED") : "GREEN";
        return { id, state };
      });
      return computeFamilyPanel(rows, DIAL_FAMILIES).families;
    };
    const d = computeT1Dial(rowsFor(true)); // credit RED-via-F10 + cross-asset RED-via-FXH + valuation AMBER-via-ECY
    const zero = computeT1Dial(rowsFor(false)); // same panel, leg-only firers neutralized ⇒ legP 0
    expect(d.legP).toBeCloseTo(Math.SQRT1_2, 12); // credit √½ (F10 RED alone of two off-band) > valuation {ECY AMBER} 0.5
    expect(zero.legP).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.band.lo).toBe(1);
    expect(d.dangerScore).toBeCloseTo(0.17678, 5); // was 0.0833 (zero.dangerScore); D6 deepened it
    expect(zero.dangerScore).toBeCloseTo(0.08333, 5);
    // band WIDTH is split-driven, never legP — byte-unchanged though hi may move with the score.
    expect(d.band.hi - d.band.lo).toBe(zero.band.hi - zero.band.lo);
  });

  it("hard-ceiling: every leg-only member RED, nothing armed ⇒ rung 3, dangerScore 0.25 (UNARMED_CAP)", () => {
    // credit band GREEN (unarmed) with F10 RED off-band ⇒ legP 1; vol AMBER + xa RED ⇒ fired, systemicBump 1.
    // Pre-cap rung = 1 + 2×1 + 1 = 4; the !armed UNARMED_CAP pulls it to 3. Red demo: drop the clamp ⇒ 4.
    const d = computeT1Dial([
      { ...panel("credit", "GREEN"), band: { state: "GREEN", firing: false, contribution: 0, ids: [] }, members: [memL("F10", "RED")] },
      panel("rates", "GREEN"),
      panel("volatility", "AMBER"),
      panel("cross-asset", "RED"),
      panel("trend", "GREEN"),
    ]);
    expect(d.legP).toBe(1);
    expect(d.armed).toBe(false);
    expect(d.rung).toBe(3);
    expect(d.dangerScore).toBe(0.25);
  });

  it("two-key survives: no legP value reaches rung ≥ 7 without armed && fired", () => {
    const legOnlyCredit = (bandFires: boolean): FamilyPanel => ({
      ...panel("credit", "GREEN"),
      band: { state: bandFires ? "RED" : "GREEN", firing: bandFires, contribution: bandFires ? 1 : 0, ids: bandFires ? ["F1"] : [] },
      members: bandFires
        ? [memL("F1", "RED"), memL("F10", "RED")]
        : [memL("F10", "RED")],
    });
    // armed (BOTH leaders' bands fire ⇒ lo 7) but UNFIRED ⇒ ARMED_UNFIRED_CAP 5; legP maxed cannot
    // cross 7 (removing the unfired cap would let lo 7 + 2×legP reach 9 — the two-key breach).
    const armedUnfired = computeT1Dial([legOnlyCredit(true), panel("rates", "RED"), panel("volatility", "GREEN"), panel("cross-asset", "GREEN"), panel("trend", "GREEN")]);
    expect(armedUnfired.legP).toBe(1);
    expect(armedUnfired.armed && !armedUnfired.fired).toBe(true);
    expect(armedUnfired.rung).toBeLessThan(7);
    // unarmed but fired, legP maxed ⇒ UNARMED_CAP 3.
    const unarmedFired = computeT1Dial([legOnlyCredit(false), panel("rates", "GREEN"), panel("volatility", "RED"), panel("cross-asset", "GREEN"), panel("trend", "GREEN")]);
    expect(unarmedFired.legP).toBe(1);
    expect(unarmedFired.armed).toBe(false);
    expect(unarmedFired.rung).toBeLessThan(7);
  });
});

describe("§5 pin - the WHOLE T1DialResult is frozen on a high-targetRung panel", () => {
  /**
   * §5's finding: the original D1 pin asserted `leadingFiring`/`armed`/`coincidentP`/`rung`/
   * `dangerScore`/`regime` and NOT `band` — the one field D1 moved. On the motivating prod panel
   * `targetRung ≈ 2`, where the `LADDER_MIN` clamp masked it; on a panel whose `targetRung` is high
   * enough to clear the clamp, `dial.band` went `{lo 4, hi 6}` → `{lo 6, hi 6}`. `dial.band` feeds
   * `computeField` (`run-core.ts`), whose `field.held.sleeve` is the pushed and persisted
   * `held_sleeve`, so that is rotation guidance, not paint.
   *
   * The pin is a FROZEN LITERAL `toEqual`, ruled R1 (§6.2), NOT `toMatchInlineSnapshot`: a snapshot
   * re-blesses under `vitest -u` in one keystroke, which is the exact silent-drift mode this pin
   * exists to close. Any field moving here must be re-typed by hand, deliberately.
   */
  const highRungPanel = (): FamilyPanel[] => [
    // credit fires ONLY via a per-leg member: F10 RED, band GREEN ⇒ leg-only, cannot arm (D1).
    {
      ...panel("credit", "GREEN"),
      band: { state: "GREEN", firing: false, contribution: 0, ids: ["F1"] },
      members: [
        memL("F1", "GREEN"),
        memL("F10", "RED"),
      ],
    },
    panel("rates", "GREEN"), // NO second leader fires ⇒ leaders are 0-of-2, the split collapses
    // a coincident selloff lifting targetRung
    panel("volatility", "RED"),
    panel("cross-asset", "RED"),
    panel("trend", "RED"),
  ];

  it("frozen literal: every field, band included (re-type by hand, never `vitest -u`)", () => {
    // §5 panel: credit cannot fire ⇒ leaders 0-of-2 ⇒ split 0 ⇒ fixed-width base band. Under the
    // fixed-width geometry that is `{lo 4, hi 6}` (targetRung 6 = hi; width POSITION_SPAN = 2 rungs ⇒
    // 3 legs). `targetRung` 6 clears `LADDER_MIN + width`, so `hi` = the ● and the clamp cannot mask `lo`.
    expect(computeT1Dial(highRungPanel())).toEqual({
      leadingFiring: 0,
      coincidentFiring: 3,
      band: { lo: 4, hi: 6 },
      leadingP: 0,
      coincidentP: 11 / 12,
      techConfirmerP: 0,
      legP: 1,
      positionP: 1,
      armed: false,
      fired: true,
      shockOverride: true,
      systemicBump: 1,
      rung: 6,
      dangerScore: 0.625,
      targetRung: 6,
      regime: "Stress",
      notifyRegime: "Stress",
      headline: "unprimed + fired (volatility, cross-asset, trend) + shock \u2192 Stress, rung 6",
      pillarsLive: true,
      fastBreakEW: false,
      graded: "coarse",
    });
  });
});
