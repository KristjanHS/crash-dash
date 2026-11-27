import { describe, expect, test } from "vitest";
import {
  regimeToBand,
  maxBand,
  escalatorFloor,
  CREDIT_UNFIRED_FLOOR,
  deEscalationLag,
  computeAlertBand,
  computeAlertBandDetail,
  escalatorFloorDetail,
  escalatorFloorBreakdown,
  applyDivergenceBump,
  verdictHoldLegs,
  DE_ESCALATION_DAYS,
  type BandReason,
} from "./alert-band.js";
import {
  decideNotify,
  decideReassert,
  assessFreshness,
  assessIndicatorFreshness,
  lagCutFor,
  ambitionCutFor,
  LAG_THRESHOLDS,
} from "./ladder.js";
import type { AlertLevel } from "./ladder.js";
import { notifyRegimeFor, computeFamilyPanel, GLOBAL_FAMILIES, rungCut } from "./families.js";
import { computeT1Dial, ARMED_UNFIRED_CAP } from "./t1dial.js";
import { ALL_INDICATORS } from "./registry.js";
import { BAND_INERT_SCORED_IDS } from "./registry-fred.js";
import { PLACEHOLDER_STATE_IDS } from "./registry-price.js";
import { STAGE1_TRIGGER_IDS } from "./registry-geo.js";
import type { Reading } from "./domain-types.js";
import type { Cadence } from "./domain-types.js";
import type { State } from "./domain-types.js";
import { slotsOld, stampWithPeers } from "./lag-fixture.test-helpers.js";
import { STATE_RANK } from "./domain-types.js";
import type { R4Phase } from "./r4.js";
import { mkReading, mkGeoReading, mkDial, NEARHIGH_TOL } from "./alert-band.test-helpers.js";

describe("maxBand", () => {
  test("empty set → OK baseline", () => {
    expect(maxBand()).toBe("OK");
  });
  test("picks the highest rank", () => {
    expect(maxBand("OK", "WARNING", "WATCH")).toBe("WARNING");
    expect(maxBand("WATCH", "CRITICAL")).toBe("CRITICAL");
    expect(maxBand("OK", "OK")).toBe("OK");
  });
});

describe("escalatorFloor - the 4 hard escalators (Slice 3 decisions #4/#5)", () => {
  test("no escalation → OK", () => {
    const readings = [mkReading("F1", "FIN", "GREEN"), mkReading("R1", "RATE", "GREEN")];
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("OK");
  });

  // Unfired degrades to WARNING: the W3-d two-key gate.
  test.each([
    { red: "F1", other: "GREEN", fired: true, want: "CRITICAL" },
    { red: "F1", other: "GREEN", fired: false, want: "WARNING" },
    { red: "F2", other: "AMBER", fired: true, want: "CRITICAL" },
    { red: "F2", other: "AMBER", fired: false, want: "WARNING" },
  ] as const)("credit blowout - $red RED alone, fired=$fired ⇒ $want", ({ red, other, fired, want }) => {
    const readings = [mkReading(red, "FIN", "RED"), mkReading(red === "F1" ? "F2" : "F1", "FIN", other)];
    expect(escalatorFloor(readings, 0, "equity", fired)).toBe(want);
  });

  // Small-wins §8 (ruling 2026-07-23 §6): the credit escalator reads F1 or F2 ONLY. F3 (NFCI Risk,
  // same FIN channel) keeps contributing through the normal danger score and must never reach this
  // floor. Machine-enforces what was previously prose only. Red-demo: widening the predicate at
  // `alert-band.ts` to `|| r.indicator.id === "F3"` turns both assertions below CRITICAL/WARNING.
  test("F3 RED alone cannot arm the credit escalator (F1/F2 only)", () => {
    const readings = [
      mkReading("F1", "FIN", "GREEN"),
      mkReading("F2", "FIN", "GREEN"),
      mkReading("F3", "FIN", "RED"),
    ];
    // Assert BOTH keys of the W3-d gate — F3 is below the predicate regardless of the FIRE key.
    expect(escalatorFloor(readings, 0, "equity", true)).toBe("OK");
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("OK");
  });

  test("F1/F2 AMBER (not RED) does not fire the credit escalator", () => {
    const readings = [mkReading("F1", "FIN", "AMBER"), mkReading("F2", "FIN", "AMBER")];
    // AMBER is below the predicate regardless of the FIRE key — assert both.
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("OK");
    expect(escalatorFloor(readings, 0, "equity", true)).toBe("OK");
  });

  test("GEO base 2 (two manual flags) → WARNING", () => {
    expect(escalatorFloor([], 2, "equity", false)).toBe("WARNING");
  });

  test("GEO auto oil (G1 non-GREEN on GEO channel) counts toward the base", () => {
    // one manual flag + one elevated oil reading = base 2 → WARNING
    const readings = [mkReading("G1", "GEO", "AMBER")];
    expect(escalatorFloor(readings, 1, "equity", false)).toBe("WARNING");
  });

  test("GEO auto OVX (crisis rung 2): one elevated reading + 0 manual flags → WATCH floor", () => {
    // Bind the fixture's channel to the SHIPPED descriptor (never a hand-typed "GEO" claim):
    // OVX rides the GEO channel in the registry, so a real elevated OVX reading has exactly
    // this shape on the autoGeoBase path.
    const ovx = ALL_INDICATORS.find((i) => i.id === "OVX")!;
    expect(ovx.channel).toBe("GEO");
    const readings = [mkReading("OVX", ovx.channel, "AMBER")];
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("WATCH");
  });

  test("GEO factor rule: three lit reads of the OIL factor buy ONE flag ⇒ WATCH, not WARNING", () => {
    // §11.1 (2026-08-01): `autoGeoBase` counts DISTINCT `geoFactor`s among the lit GEO readings,
    // not the readings. G1/BRENT/OVX all carry the SAME factor (oil), so the live world — BRENT
    // RED, OVX AMBER, G1 GREEN, zero manual flags, no declared stage — scores 1, not 2. Under the
    // OLD per-reading count this was base 2 ⇒ WARNING; that is the rung this inverts.
    const readings = [mkGeoReading("BRENT", "RED"), mkGeoReading("OVX", "AMBER"), mkGeoReading("G1", "GREEN")];
    const d = escalatorFloorBreakdown(readings, 0, "equity", false, false, 0);
    expect(d.band).toBe("WATCH");
    expect(d.source).toBe("geo");
    const basis = d.floors.find((f) => f.id === "geo")!.geoBasis!;
    // The addend is 1 (one factor) while the /lab id capture still NAMES both lit reads.
    expect(basis.autoFactors).toBe(1);
    expect(basis.auto).toEqual(["BRENT", "OVX"]);
    expect(basis.total).toBe(1);
  });

  test("the GEO auto leg's elevated predicate is `STATE_RANK >= AMBER` on EVERY State", () => {
    // Row 17: `autoGeoBase`'s filter moved from the ad-hoc
    // `!== "GREEN"` to the `STATE_RANK[state] >= STATE_RANK.AMBER` seam every other rollup uses.
    // What this genuinely pins is the CUT POSITION: the expected column is `>= AMBER`, and both
    // neighbouring cuts were red-demoed against it — `> AMBER` drops RED to 0, `>= GREEN` lifts
    // GREEN to 1. It also reds on a revert to `!== "GREEN"` COMBINED with a widened union.
    //
    // ⚠ It does NOT red on a widened union alone. The expectation below is the same expression
    // over the same enumerated keys as the implementation, so a 4th state added to `STATE_RANK`
    // makes this table EXERCISE it and pass, whichever side of the cut it lands on. Enumerating
    // from `STATE_RANK` buys coverage-without-hand-typing, not a decision alarm. No replay was
    // run because the predicate cannot move a day within `State` (claim-verification §28).
    const states = Object.keys(STATE_RANK) as State[];
    expect(states).toEqual(expect.arrayContaining(["GREEN", "AMBER", "RED"])); // vacuity guard
    for (const s of states) {
      const d = escalatorFloorBreakdown([mkGeoReading("G1", s)], 0, "equity", false, false, 0);
      const basis = d.floors.find((f) => f.id === "geo")!.geoBasis!;
      // Discriminating on BOTH sides of the cut: `> AMBER` would drop RED to 0, `>= GREEN`
      // would lift GREEN to 1 — neither survives this table.
      expect(basis.autoFactors, `${s} (rank ${STATE_RANK[s]}) counted wrongly`).toBe(
        STATE_RANK[s] >= STATE_RANK.AMBER ? 1 : 0,
      );
    }
  });

  test("every GEO-channel id carries a `geoFactor` (a new GEO id cannot ship untagged)", () => {
    // §11.1's owed guard: an untagged lit GEO reading falls back to counting as its own factor,
    // so a missing tag silently re-introduces the per-reading count for that id.
    const geo = ALL_INDICATORS.filter((i) => i.channel === "GEO");
    expect(geo.length).toBeGreaterThan(0); // vacuity guard: the filter must select something
    for (const i of geo) {
      expect(i.geoFactor, `${i.id} is on the GEO channel with no geoFactor`).toBeTruthy();
    }
  });

  test("GEO cap holds: one lit oil factor + 2 manual flags + stage 2 = geoBase 5, still WARNING", () => {
    // The geo floor is WARNING-capped — stacking further contributors must NOT escalate past
    // WARNING (the notify-path bound the Stage-2 plan asserts). Rebuilt off contributors that
    // still ADD after the factor rule: OVX + G1 lit together are ONE oil flag, so the stack now
    // comes from the manual term and the declared crisis stage.
    const readings = [mkGeoReading("G1", "AMBER"), mkGeoReading("OVX", "AMBER")];
    const d = escalatorFloorBreakdown(readings, 2, "equity", false, false, 2);
    expect(d.floors.find((f) => f.id === "geo")!.geoBasis!.total).toBe(5); // 2 manual + 1 oil + 2 stage
    expect(d.band).toBe("WARNING");
    expect(d.source).toBe("geo");
  });

  test("stage-ladder trigger fold: oil + T5YIFR lit are TWO distinct factors ⇒ WARNING", () => {
    // T5YIFR rides channel CONTEXT, so the pre-plan channel-GEO filter dropped it; as a
    // STAGE1_TRIGGER_IDS member with its own factor it now compounds with oil to base 2.
    const readings = [mkGeoReading("G1", "AMBER"), mkGeoReading("T5YIFR", "AMBER")];
    const d = escalatorFloorBreakdown(readings, 0, "equity", false, false, 0);
    expect(d.band).toBe("WARNING");
    expect(d.source).toBe("geo");
    const basis = d.floors.find((f) => f.id === "geo")!.geoBasis!;
    expect(basis.autoFactors).toBe(2);
    expect(basis.auto).toEqual(["G1", "T5YIFR"]);
  });

  test("auto stage-hold folds by MAX, never sum: held + a single oil print stays WATCH (base 1)", () => {
    expect(DE_ESCALATION_DAYS).toBeGreaterThanOrEqual(1); // premise guard for the -1 offsets
    const held = (readings: Reading[]) =>
      escalatorFloorBreakdown(readings, 0, "equity", false, false, 0, false, DE_ESCALATION_DAYS - 1);
    // Nothing lit but the streak is short of the dwell ⇒ the hold alone floors WATCH…
    const quiet = held([]);
    expect(quiet.band).toBe("WATCH");
    expect(quiet.source).toBe("geo");
    expect(quiet.floors.find((f) => f.id === "geo")!.geoBasis).toMatchObject({ total: 1, hold: 1 });
    // …and a lit oil factor ABSORBS the hold (max) rather than adding a second flag.
    const lit = held([mkGeoReading("G1", "AMBER")]);
    expect(lit.band).toBe("WATCH");
    expect(lit.floors.find((f) => f.id === "geo")!.geoBasis).toMatchObject({ total: 1, autoFactors: 1, hold: 0 });
    // At the dwell the hold releases: nothing lit ⇒ geo floor OK.
    expect(
      escalatorFloorBreakdown([], 0, "equity", false, false, 0, false, DE_ESCALATION_DAYS).band,
    ).toBe("OK");
  });

  test("every STAGE1_TRIGGER_IDS member carries a `geoFactor` (the litSet fold needs the tag)", () => {
    expect(STAGE1_TRIGGER_IDS.size).toBeGreaterThan(0); // vacuity guard
    for (const id of STAGE1_TRIGGER_IDS) {
      const ind = ALL_INDICATORS.find((i) => i.id === id);
      expect(ind, `${id} is not a shipped indicator`).toBeTruthy();
      expect(ind!.geoFactor, `${id} is a stage trigger with no geoFactor`).toBeTruthy();
    }
  });

  test("R4 cash phase forces CRITICAL", () => {
    expect(escalatorFloor([], 0, "cash" as R4Phase, false)).toBe("CRITICAL");
  });

  test("R4 non-cash phases do not floor", () => {
    for (const phase of ["equity", "reentry"] as R4Phase[]) {
      expect(escalatorFloor([], 0, phase, false)).toBe("OK");
    }
  });

  test("RATE stress - base score ≥ floor → WATCH", () => {
    // two AMBER (rank 1 each) = score 2 = RATE_STRESS_FLOOR
    const readings = [mkReading("R1", "RATE", "AMBER"), mkReading("R2", "RATE", "AMBER")];
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("WATCH");
  });

  test("RATE confirmer (R7) is excluded from the base score", () => {
    // one AMBER base (score 1 < floor) + a RED confirmer (excluded) → no floor
    const readings = [
      mkReading("R1", "RATE", "AMBER"),
      mkReading("R7", "RATE", "RED", true),
    ];
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("OK");
  });

  test("combined escalators take the max", () => {
    // GEO WATCH + credit CRITICAL → CRITICAL
    const readings = [mkReading("F1", "FIN", "RED"), mkReading("G1", "GEO", "AMBER")];
    expect(escalatorFloor(readings, 0, "equity", true)).toBe("CRITICAL");
    // unfired: credit WARNING still beats the geo WATCH
    expect(escalatorFloor(readings, 0, "equity", false)).toBe("WARNING");
  });
});

describe("W3-d - credit escalator two-key gate", () => {
  test("CREDIT_UNFIRED_FLOOR is DERIVED from ARMED_UNFIRED_CAP, not chosen", () => {
    // W3-c: reads the NOTIFY cuts. The floor is a claim about the PUSHED band, so pinning
    // it against the dial axis would let the two drift apart the moment the cuts diverge.
    expect(regimeToBand(notifyRegimeFor(rungCut(ARMED_UNFIRED_CAP)))).toBe(CREDIT_UNFIRED_FLOOR);
  });

  test("`armed` is tautological for the credit predicate - so the gate uses `fired` alone", () => {
    // F1 RED ⇒ credit family worst-state RED ⇒ firing ⇒ armed. Gating on `armed` would be a no-op.
    const panel = computeFamilyPanel(
      ALL_INDICATORS.map((i) => ({ id: i.id, state: (i.id === "F1" ? "RED" : "GREEN") as State })),
      GLOBAL_FAMILIES,
    );
    expect(computeT1Dial(panel.families).armed).toBe(true);
    expect(computeT1Dial(panel.families).fired).toBe(false); // vacuity guard: the keys really differ here
  });

  test("invariant: with no F1/F2 RED, `fired` cannot change ANY floor (GEO/R4/RATE untouched)", () => {
    const worlds: { readings: Reading[]; geoFlags: number; r4Phase: R4Phase }[] = [
      { readings: [], geoFlags: 0, r4Phase: "equity" }, // OK
      { readings: [], geoFlags: 1, r4Phase: "equity" }, // geo WATCH
      { readings: [mkReading("G1", "GEO", "AMBER")], geoFlags: 1, r4Phase: "equity" }, // geo WARNING
      { readings: [], geoFlags: 0, r4Phase: "cash" as R4Phase }, // r4 CRITICAL
      {
        readings: [mkReading("R1", "RATE", "AMBER"), mkReading("R2", "RATE", "AMBER")],
        geoFlags: 0,
        r4Phase: "equity",
      }, // rate WATCH
      { readings: [mkReading("F3", "FIN", "RED")], geoFlags: 0, r4Phase: "equity" }, // credit-family, NOT F1/F2
    ];
    const bands = new Set<AlertLevel>();
    for (const w of worlds) {
      const on = escalatorFloorDetail(w.readings, w.geoFlags, w.r4Phase, true);
      const off = escalatorFloorDetail(w.readings, w.geoFlags, w.r4Phase, false);
      expect(off).toEqual(on);
      bands.add(on.band);
    }
    // Vacuity guard: the world set must actually reach every non-credit floor tier, or the
    // equality above is trivially true over an all-OK set.
    expect([...bands].sort()).toEqual(["CRITICAL", "OK", "WARNING", "WATCH"]);
  });
});

describe("deEscalationLag - N=2 asymmetric hold", () => {
  // Second row: the WARNING sits at index 1, outside the N−1=1 window, so the hold releases;
  // a window that wrongly reached index 1 would still return WARNING.
  test.each<{ name: string; dial: AlertLevel; recent: AlertLevel[]; n?: number; want: AlertLevel }>([
    { name: "first low run holds the prior higher band", dial: "WATCH", recent: ["WARNING"], want: "WARNING" },
    { name: "second low run steps down (prior high left the window)", dial: "OK", recent: ["OK", "WARNING"], want: "OK" },
    { name: "a dial upgrade beats a lower held band", dial: "CRITICAL", recent: ["WATCH"], want: "CRITICAL" },
    { name: "N=3 holds the prior-2 high band", dial: "OK", recent: ["WATCH", "OK"], n: 3, want: "WATCH" },
    { name: "N=3 releases over an all-OK window", dial: "OK", recent: ["OK", "OK"], n: 3, want: "OK" },
  ])("$name", ({ dial, recent, n, want }) => {
    expect(deEscalationLag(dial, recent, n)).toBe(want);
  });
});

describe("computeAlertBand - max(lagged dial, escalator floor)", () => {
  const noFloor = (over: Partial<Parameters<typeof computeAlertBand>[0]> = {}) =>
    computeAlertBand({
      dial: mkDial("Caution"),
      readings: [],
      geoFlags: 0,
      r4Phase: "equity",
      recentDialBands: [],
      ...over,
    });

  // Thin wrapper pin only — the floor/lag-hold/regime pairs live in the computeAlertBandDetail
  // describe below on the same fixtures (the detail results are supersets: band + reason).
  test("clean dial with no escalators → the dial band (Caution→WATCH)", () => {
    expect(noFloor()).toBe("WATCH");
  });

  test("escalator overrides the lag downward-hold both directions", () => {
    // lag would hold WARNING, but no live escalator + second low run → drops.
    const recent: AlertLevel[] = ["OK"]; // prior already low → window clear
    expect(noFloor({ dial: mkDial("Calm"), recentDialBands: recent })).toBe("OK");
    // and an escalator still pins up regardless of the lag
    expect(
      noFloor({
        dial: mkDial("Calm"),
        recentDialBands: recent,
        r4Phase: "cash" as R4Phase,
      }),
    ).toBe("CRITICAL");
  });
});

describe("computeAlertBandDetail - the rank-13 band reason from the deciding branch", () => {
  const detail = (over: Partial<Parameters<typeof computeAlertBandDetail>[0]> = {}) =>
    computeAlertBandDetail({
      dial: mkDial("Caution"),
      readings: [],
      geoFlags: 0,
      r4Phase: "equity",
      recentDialBands: [],
      ...over,
    });

  test("raw dial band stands ⇒ reason 'regime' (and band unchanged from computeAlertBand)", () => {
    const d = detail({ dial: mkDial("Stress") });
    expect(d.band).toBe("WARNING");
    expect(d.reason).toBe("regime");
  });

  test("an escalator lifts the band above the raw dial ⇒ reason names the floor source", () => {
    // Calm dial (OK) + F1 RED credit blowout → CRITICAL floor above the dial.
    const fired = detail({ dial: mkDial("Calm"), readings: [mkReading("F1", "FIN", "RED")] });
    expect(fired.band).toBe("CRITICAL");
    expect(fired.reason).toBe("floor:credit");
    // W3-d: the reason must SURVIVE the re-tier — an unfired credit floor is WARNING,
    // which still lifts a Calm/OK dial, so `floor:credit` is still the binding cause.
    const unfired = detail({ dial: mkDial("Calm", false), readings: [mkReading("F1", "FIN", "RED")] });
    expect(unfired.band).toBe("WARNING");
    expect(unfired.reason).toBe("floor:credit");
    // r4 cash phase floors CRITICAL.
    expect(detail({ dial: mkDial("Calm"), r4Phase: "cash" as R4Phase }).reason).toBe("floor:r4");
  });

  test("the de-escalation lag holds the band above a dropping raw dial ⇒ reason 'lag-hold'", () => {
    const d = detail({ dial: mkDial("Calm"), recentDialBands: ["WARNING"] });
    expect(d.band).toBe("WARNING");
    expect(d.reason).toBe("lag-hold");
  });

  test("W4-e Stage 4 - a stale leg holds the band above a dropping dial ⇒ reason 'verdict-hold'", () => {
    // Calm dial ⇒ computed OK; the caller passes the prior final band (WARNING) as verdictHoldFloor
    // because a leg is stale ⇒ the band cannot step down ⇒ WARNING / 'verdict-hold'.
    const held = detail({ dial: mkDial("Calm"), verdictHoldFloor: "WARNING" });
    expect(held.band).toBe("WARNING");
    expect(held.reason).toBe("verdict-hold");
    // Control 1 — no stale leg (floor omitted) ⇒ the OK dial stands (proves the hold, not the dial,
    // set the band above; mutate-red: deleting the verdictHoldFloor block drops `held` to this OK).
    expect(detail({ dial: mkDial("Calm") }).band).toBe("OK");
    // Control 2 — floor present but NOT above the computed band ⇒ does not bind, no false hold.
    const noBind = detail({ dial: mkDial("Stress"), verdictHoldFloor: "OK" });
    expect(noBind.band).toBe("WARNING");
    expect(noBind.reason).toBe("regime");
  });

  test("escalatorFloorDetail resolves ties most-severe-first (credit over geo)", () => {
    const readings = [mkReading("F1", "FIN", "RED"), mkReading("G1", "GEO", "AMBER")];
    const fd = escalatorFloorDetail(readings, 3, "equity", true);
    expect(fd.band).toBe("CRITICAL");
    expect(fd.source).toBe("credit");
    // W3-d: unfired, credit (WARNING) TIES geoBase-3's WARNING and still wins the source —
    // pins that the most-severe-first tie-break was left untouched by the gate.
    expect(escalatorFloorDetail(readings, 3, "equity", false)).toEqual({ band: "WARNING", source: "credit" });
    // no escalator fired ⇒ null source, OK band.
    expect(escalatorFloorDetail([], 0, "equity", false)).toEqual({ band: "OK", source: null });
  });
});

describe("applyDivergenceBump - D-B: +1 on HY-OAS 30d rise into a QQQ near-high", () => {
  // F1 reading with a controllable 30d Δ (delta20 IS the 30d change post-Stage-1.2). State GREEN
  // so the credit floor never confounds the bump (this measures the +1 in isolation).
  const f1 = (delta20: number): Reading => ({ ...mkReading("F1", "FIN", "GREEN"), delta20 });
  const base: { band: AlertLevel; reason: BandReason } = { band: "WATCH", reason: "regime" };

  test("FIRES: Δ30d > 0 AND distToHigh ≥ tol ⇒ +1 band, reason 'divergence'", () => {
    expect(applyDivergenceBump(base, [f1(0.1)], NEARHIGH_TOL, NEARHIGH_TOL)).toEqual({
      band: "WARNING",
      reason: "divergence",
    });
  });

  test("NO bump when Δ30d ≤ 0 (credit not widening)", () => {
    expect(applyDivergenceBump(base, [f1(0)], NEARHIGH_TOL, NEARHIGH_TOL)).toEqual(base);
    expect(applyDivergenceBump(base, [f1(-0.5)], NEARHIGH_TOL, NEARHIGH_TOL)).toEqual(base);
  });

  test("NO bump when distToHigh < tol (QQQ not at the high)", () => {
    expect(applyDivergenceBump(base, [f1(0.1)], NEARHIGH_TOL - 0.01, NEARHIGH_TOL)).toEqual(base);
  });

  test("NO bump when either input is null (degraded slow feed / absent calibration row)", () => {
    expect(applyDivergenceBump(base, [f1(0.1)], null, NEARHIGH_TOL)).toEqual(base);
    expect(applyDivergenceBump(base, [f1(0.1)], NEARHIGH_TOL, null)).toEqual(base);
  });

  test("NO bump when F1 reading absent (delta defaults to 0)", () => {
    expect(applyDivergenceBump(base, [], NEARHIGH_TOL, NEARHIGH_TOL)).toEqual(base);
  });

  test("caps at CRITICAL - already at the ceiling ⇒ no bump, reason kept; from WARNING ⇒ one step", () => {
    const atTop: { band: AlertLevel; reason: BandReason } = { band: "CRITICAL", reason: "floor:credit" };
    expect(applyDivergenceBump(atTop, [f1(0.1)], NEARHIGH_TOL, NEARHIGH_TOL)).toEqual(atTop);
    expect(
      applyDivergenceBump({ band: "WARNING", reason: "regime" }, [f1(0.1)], NEARHIGH_TOL, NEARHIGH_TOL),
    ).toEqual({ band: "CRITICAL", reason: "divergence" });
  });

  test("integration - computeAlertBandDetail bumps the FINAL band (max of lag/floor), not just the floor", () => {
    const d = computeAlertBandDetail({
      dial: mkDial("Caution"), // notify WATCH
      readings: [f1(0.1)],
      geoFlags: 0,
      r4Phase: "equity",
      recentDialBands: [],
      spDistToHigh: NEARHIGH_TOL,
      nearHighTol: NEARHIGH_TOL,
    });
    expect(d).toEqual({ band: "WARNING", reason: "divergence" });
    // Control: same world, divergence OFF (below tol) ⇒ the plain WATCH/regime stands.
    expect(
      computeAlertBandDetail({
        dial: mkDial("Caution"),
        readings: [f1(0.1)],
        geoFlags: 0,
        r4Phase: "equity",
        recentDialBands: [],
        spDistToHigh: NEARHIGH_TOL - 0.01,
        nearHighTol: NEARHIGH_TOL,
      }),
    ).toEqual({ band: "WATCH", reason: "regime" });
  });
});

describe("verdictHoldLegs - per-cadence lag for the notify FLAG (W4-e Stage 2)", () => {
  // ⚠ SINCE SLICE 3 (2026-09-09) `verdictHoldLegs` COMPUTES NO FRESHNESS — it reads the
  // `stampFreshness` stamp off each Reading and lost its `today` parameter. So every fixture here
  // must be STAMPED FIRST, through `stampWithPeers`, which supplies the independent daily peers a
  // publication grid needs. An UNSTAMPED reading is "not assessed" and is silently never flagged,
  // which would make every "…is excluded"/"…returns []" assertion below pass for the wrong reason;
  // `stampWithPeers` throws instead of returning an unstamped daily row, so that trap stays shut.
  //
  // ⚠ AND EVERY FIXTURE DATE IS DERIVED FROM `lagCutFor`, never typed: `slotsOld(n)` is the date
  // exactly `n` publication days before the pinned `SLOT_TODAY`.
  const DAILY_CUT = lagCutFor({ cadence: "daily" });
  const WEEKLY_CUT = lagCutFor({ cadence: "weekly" });
  // One age that separates the two tiers: past the daily cut, still inside the weekly one. The
  // whole file's discriminating pairs rest on that separation, so it is asserted below, not assumed.
  const STALE_AGE = WEEKLY_CUT;
  const STALE = slotsOld(STALE_AGE);
  const FRESH_DATE = slotsOld(0);

  // A Reading double with an explicit date + cadence (mkReading pins date + omits cadence).
  const leg = (id: string, label: string, date: string, cadence?: Cadence): Reading => ({
    indicator: { id, label, longLabel: label, series: id, channel: "FIN", thresholds: {}, ...(cadence ? { cadence } : {}) },
    date,
    level: 1,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
  });
  const held = (readings: Reading[]) => verdictHoldLegs(stampWithPeers(readings));

  test("the fixture's stale age really separates the daily and weekly cuts", () => {
    expect(STALE_AGE).toBeGreaterThan(DAILY_CUT);
    expect(STALE_AGE).toBeLessThanOrEqual(WEEKLY_CUT);
  });

  test("flags a stale daily leg but not a same-age weekly leg, nor a fresh daily leg", () => {
    const result = held([
      leg("DLY", "Daily feed", STALE), // past the daily cut → STALE
      leg("WKLY", "Weekly feed", STALE, "weekly"), // same age, inside the weekly cut → fresh
      leg("FRESH", "Fresh daily", FRESH_DATE), // 0 slots old → fresh
    ]);
    expect(result).toEqual([{ id: "DLY", label: "Daily feed", ageDays: STALE_AGE, cadence: "daily" }]);
  });

  test("empty when every leg is within its cadence threshold", () => {
    expect(held([leg("WKLY", "Weekly feed", STALE, "weekly")])).toEqual([]);
  });

  // E7 Stage 3.2 — the per-indicator override must reach the FLAG, not just /status. Both
  // directions on ONE leg shape: an age past the daily tier (so it flags today); the same leg with
  // a looser `lagAfterDays` must go quiet. The pair is the discriminator — resolving the cut off
  // the tier alone instead of through `lagCutFor` reds the first assertion only.
  test("a per-indicator lagAfterDays overrides the cadence cut for the notify flag", () => {
    const base = leg("OVR", "Overridden feed", STALE, "daily");
    const withOverride: Reading = { ...base, indicator: { ...base.indicator, lagAfterDays: STALE_AGE + 1 } };
    expect(held([withOverride])).toEqual([]);
    expect(held([base])).toEqual([{ id: "OVR", label: "Overridden feed", ageDays: STALE_AGE, cadence: "daily" }]);
  });

  // BAND-CRITICAL (2026-08-05). `verdictHoldLegs` feeds `verdictHoldFloor` in run-core.ts, which floors the
  // final band at the prior persisted band while ≥1 leg is stale — so a leg counted here can make the
  // notify band monotone non-decreasing. The failure mode that forced the exclusion: a display-only
  // card whose feed freezes without throwing keeps emitting a Reading with an old date, and an
  // UNSCORED card that contributes nothing to any band would have latched the band forever.
  // The DISCRIMINATING pair is co-present in one call at the SAME age: an id-agnostic
  // implementation cannot separate them, and deleting the `PLACEHOLDER_STATE_IDS` filter reds the
  // first assertion while leaving the second green.
  test("a value-only leg never counts as stale, while a scored leg the same age does", () => {
    const both = held([leg("SPY", "SPY", STALE), leg("DLY", "Daily feed", STALE)]);
    expect(both.map((l) => l.id)).toEqual(["DLY"]);
  });

  // Whole-set walk, so a NEW value-only id (a second CONTEXT card, another pension leg) inherits the
  // exclusion instead of quietly re-arming the hold. Derived from the registry set, never re-typed.
  test("every PLACEHOLDER_STATE_IDS id is excluded, over the whole set", () => {
    // Vacuity anchor: the set must be populated AND these fixtures must be stale by the cut — the
    // scored control below proves that same age/cut combination really does flag.
    expect(PLACEHOLDER_STATE_IDS.size).toBeGreaterThan(1);
    const readings = [...PLACEHOLDER_STATE_IDS].map((id) => leg(id, id, STALE));
    expect(held(readings)).toEqual([]);
    expect(held([...readings, leg("DLY", "Daily feed", STALE)])).toHaveLength(1);
  });

  // VTP/G1/BRENT carry `thresholds: {}` too — but that only means "bespoke scorer, not classify()".
  // They ARE scored, so their blindness is real and must still hold the band. This is what stops the
  // exclusion being widened to "empty thresholds", which would have silenced ~30 genuinely-scored ids.
  test("a bespoke-scored id with empty thresholds is still flagged (VTP is not value-only)", () => {
    expect(PLACEHOLDER_STATE_IDS.has("VTP")).toBe(false);
    expect(held([leg("VTP", "VIX backwardation", STALE)])).toHaveLength(1);
  });

  // BAND_INERT_SCORED_IDS (registry.ts): genuinely scored ids with no family seat and no
  // MEMBER_WEIGHT row — nothing they see can move a band, so their blindness cannot pin one.
  // Whole-set walk like the PLACEHOLDER one above; VTP must NOT drift into this set (its
  // non-exclusion is the pinned ruling in the two tests around this one).
  // The set is EMPTY today (CCC, its last member, seated 2026-10-12) — the walk below is then vacuous
  // but the control leg still bites.
  test("every BAND_INERT_SCORED_IDS id is excluded, over the whole set (and VTP is not in it)", () => {
    expect(BAND_INERT_SCORED_IDS.has("VTP")).toBe(false);
    const readings = [...BAND_INERT_SCORED_IDS].map((id) => leg(id, id, STALE));
    expect(held(readings)).toEqual([]);
    // Scored control at the same age/cut: the exclusion, not the fixture, is what empties the result.
    expect(held([...readings, leg("DLY", "Daily feed", STALE)])).toHaveLength(1);
  });

  // ⚠ NOT ASSESSED IS NOT LAGGING (alert-band.ts's third ⚠): a reading whose grid could not be built
  // carries no stamp, and this seam must fail toward NOT holding the band — the whole-run
  // calendar-day heartbeat is the backstop for the case where nothing published at all. Fed the RAW
  // (deliberately unstamped) fixture, with the stamped control proving the age itself would flag.
  test("an UNSTAMPED reading is never flagged - not assessed fails toward not holding", () => {
    expect(verdictHoldLegs([leg("DLY", "Daily feed", STALE)])).toEqual([]);
    expect(held([leg("DLY", "Daily feed", STALE)])).toHaveLength(1);
  });
});

describe("decideNotify (notify-on-upward-change §6.5)", () => {
  test("T1: null -> OK is silent (green first run)", () => {
    expect(decideNotify(null, "OK")).toEqual({ push: false, transition: null });
  });
  test("T2: null -> WARNING pushes from an OK baseline (elevated first run)", () => {
    expect(decideNotify(null, "WARNING")).toEqual({ push: true, transition: "OK -> WARNING" });
  });
  test("T4: WATCH -> WATCH same-level repeat is silent", () => {
    expect(decideNotify("WATCH", "WATCH")).toEqual({ push: false, transition: null });
  });
  test("T5: WARNING -> WATCH downgrade is silent", () => {
    expect(decideNotify("WARNING", "WATCH")).toEqual({ push: false, transition: null });
  });
  test("T7: WATCH -> CRITICAL skip-level up pushes", () => {
    expect(decideNotify("WATCH", "CRITICAL")).toEqual({
      push: true,
      transition: "WATCH -> CRITICAL",
    });
  });
});

describe("assessFreshness (heartbeat §6.5, Phase 3)", () => {
  // REWRITTEN 2026-08-03 from "stale once past 3d". The heartbeat's own boundary moved with
  // STALE_AFTER_DAYS: 4d is the Monday reading of a healthy T+1 business-day feed (Thursday's
  // value — Friday's is unpublished), so treating it as the alarm edge was the false-stale. The
  // pin keeps BOTH halves so the edge is still pinned, one day later.
  test("fresh at the 4d boundary (the Monday read of a T+1 feed)", () => {
    expect(assessFreshness("2026-06-19", "2026-06-23")).toEqual({ lag: false, ageDays: 4, unit: "days" });
  });
  test("stale once past 4d", () => {
    expect(assessFreshness("2026-06-19", "2026-06-24")).toEqual({ lag: true, ageDays: 5, unit: "days" });
  });
  test("respects a custom threshold", () => {
    expect(assessFreshness("2026-06-19", "2026-06-22", 2)).toEqual({ lag: true, ageDays: 3, unit: "days" });
  });
});

/**
 * THE PUBLICATION CALENDAR (2026-08-03) — the regime the cuts have to survive.
 *
 * These fixtures are REAL DATES, not ages, and that is the point: they encode the publisher's
 * grid (R1) rather than restating a threshold, so a future retune moves the cut without being
 * able to move what "a healthy feed on a Monday" means. Each pair is discriminating — the first
 * half red-demos the false-stale the cut was raised to remove, the second half proves the cut did
 * not go so far that a genuinely missed publication slips through.
 *
 * Before this rung the daily cut was 3, which no T+1-published business-day feed could satisfy on
 * a Monday. Measured over 3 years of real FRED release dates against the live cron (`0 22 * * 1-5`):
 * Mon 4d on 151/151 days, Tue 4d on 139/151 — 27.5% of ALL days stale with every feed healthy.
 */
describe("lag against the real publication calendar", () => {
  // F3 (NFCI) stamps the week-ending FRIDAY and releases it the following WEDNESDAY (T+5); a row
  // stays the newest available until its SUCCESSOR lands, so its age peaks the day before that.
  //
  // HOLIDAY WEEK — the regime that sizes the cut, and the only one that reaches 12. Obs
  // 2025-10-31 (Fri); its successor 2025-11-07 slipped to THURSDAY 2025-11-13 (Veterans Day fell
  // on the Monday), so this row was still the newest on Wed 2025-11-12 at 12d old. 22 of 157
  // scanned Wednesdays slip like this, never by more than one day.
  //
  // The two halves are what make it discriminating: the SAME row is fresh against F3's own
  // resolved cut and stale against the bare weekly TIER, so deleting `lagAfterDays` from the
  // registry entry reds line 1 while a tier move would red line 2. Dropping the cut to the
  // F9/F11/FXH value of 11 also reds line 1 — which is the whole reason F3 does not share it.
  test("F3's own cut covers the holiday-week peak; the bare weekly tier does not", () => {
    const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
    expect(assessIndicatorFreshness("2025-10-31", "2025-11-12", "weekly", lagCutFor(f3!))).toEqual({
      lag: false,
      ageDays: 12,
      unit: "days",
    });
    expect(assessIndicatorFreshness("2025-10-31", "2025-11-12", "weekly").lag).toBe(true);
  });
  // 2025-11-13 is the day the successor ACTUALLY landed, so a feed still stamped 2025-10-31 that
  // morning has genuinely missed a release — the case the cut must not silence.
  test("...and F3 IS flagged once it misses the release that ends that peak", () => {
    const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
    expect(assessIndicatorFreshness("2025-10-31", "2025-11-13", "weekly", lagCutFor(f3!))).toEqual({
      lag: true,
      ageDays: 13,
      unit: "days",
    });
  });

  // The AMBITION table is the display-only reference the alarm cut left behind: the Monday row
  // (a T+1 daily feed read Thu→Mon) is PAST the 3d target, which is exactly the population the
  // tracking overview exists to keep visible. Reading it must never change a stale verdict.
  //
  // ⚠ THE CROSS-TABLE `ambition < LAG_THRESHOLDS.daily` COMPARISON IS RETIRED (slice 3), not
  // relaxed: `AMBITION_THRESHOLDS` is CALENDAR days across the board — `impliedCadenceFor` reads it
  // to bucket observation SPACING — while `LAG_THRESHOLDS.daily` is a PUBLICATION-SLOT cut. "a calendar-day
  // span is tighter than a slot count" is not a well-formed claim, and asserting it would be the exact
  // unit-mixing this slice deletes. The POPULATION claim below is entirely within calendar days and
  // is the half the overview actually depends on, so that is what survives.
  test("the Monday row is past the daily ambition, so the overview has a population", () => {
    const monday = assessIndicatorFreshness("2026-07-30", "2026-08-03", "daily");
    expect(monday.unit).toBe("days"); // both sides of the comparison below are calendar days
    expect(monday.ageDays).toBeGreaterThan(ambitionCutFor({ cadence: "daily" }));
  });
  // A per-feed `lagAfterDays` must NOT drag the ambition with it — F3 rides past the 9d target
  // every week and would vanish from the overview if this read the resolved cut.
  test("a per-feed lagAfterDays raises the alarm cut but never the ambition", () => {
    const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
    expect(lagCutFor(f3!)).toBeGreaterThan(ambitionCutFor(f3!));
  });
});

// Audit rank 6 — per-cadence lag: one frozen feed must not hide behind the run-wide
// max-date, and a weekly feed's normal release lag must NOT read as rot.
describe("assessIndicatorFreshness (per-cadence lag, audit rank 6)", () => {
  // The wrapper's own delta (cadence routing) is what the weekly row + the default-cadence row
  // below discriminate.
  test("weekly feed at 5d is NOT flagged (normal H.10 / NFCI release lag)", () => {
    expect(assessIndicatorFreshness("2026-06-19", "2026-06-24", "weekly")).toEqual({ lag: false, ageDays: 5, unit: "days" });
  });
  test("cadence defaults to daily when unspecified", () => {
    expect(assessIndicatorFreshness("2026-06-19", "2026-06-24")).toEqual({ lag: true, ageDays: 5, unit: "days" });
  });
});

// E7 Stage 3.1 — `lagCutFor` is the ONE resolution point every consumption site routes
// through. Both directions are asserted because each red-demos a different degenerate
// implementation: ignoring the override (assertion 1) and ignoring the cadence table
// (assertion 2). 14 is deliberately NOT any LAG_THRESHOLDS value, so assertion 1 cannot
// pass by coincidence; assertion 2 reads the table rather than restating 9.
describe("lagCutFor (E7 per-source lag cut)", () => {
  test("a per-indicator lagAfterDays wins over the cadence tier", () => {
    expect(lagCutFor({ cadence: "weekly", lagAfterDays: 14 })).toBe(14);
  });
  test("no override falls back to the cadence tier", () => {
    expect(lagCutFor({ cadence: "weekly" })).toBe(LAG_THRESHOLDS.weekly);
  });
  test("no cadence and no override falls back to the daily tier (the Indicator default)", () => {
    expect(lagCutFor({})).toBe(LAG_THRESHOLDS.daily);
  });
});

describe("decideReassert (weekly re-assert §5 pre-mortem, Phase 3)", () => {
  const now = "2026-06-26T22:00:00.000Z";
  test("below WARNING never re-asserts, even after a long silence", () => {
    expect(decideReassert("OK", "2026-01-01T00:00:00.000Z", now)).toBe(false);
    expect(decideReassert("WATCH", "2026-01-01T00:00:00.000Z", now)).toBe(false);
  });
  test("elevated but never pushed (null) re-asserts now", () => {
    expect(decideReassert("WARNING", null, now)).toBe(true);
    expect(decideReassert("CRITICAL", null, now)).toBe(true);
  });
  test("elevated, last push 6d ago: not yet (boundary just under 7d)", () => {
    expect(decideReassert("CRITICAL", "2026-06-20T22:00:00.000Z", now)).toBe(false);
  });
  test("elevated, last push exactly 7d ago: re-asserts", () => {
    expect(decideReassert("WARNING", "2026-06-19T22:00:00.000Z", now)).toBe(true);
  });
  test("lastPushFailed re-fires immediately, below WARNING and inside the interval (rank 1)", () => {
    // A WATCH push that failed to deliver yesterday must re-fire today — even though WATCH is
    // below the weekly-re-assert floor and only 1d has passed since the (failed) push attempt.
    expect(decideReassert("WATCH", "2026-06-25T22:00:00.000Z", now, { lastPushFailed: true })).toBe(true);
    expect(decideReassert("CRITICAL", "2026-06-25T22:00:00.000Z", now, { lastPushFailed: true })).toBe(true);
  });
  test("lastPushFailed does NOT re-fire once the band has dropped to OK (extras 1.1)", () => {
    // A WARNING push failed yesterday, but the band has since dropped to OK — the missed
    // push is moot; re-firing would push an all-clear-level "alert" the ladder never sends.
    expect(decideReassert("OK", "2026-06-25T22:00:00.000Z", now, { lastPushFailed: true })).toBe(false);
  });
  test("lastPushFailed=false keeps the plain weekly-re-assert behavior", () => {
    expect(decideReassert("WATCH", null, now, { lastPushFailed: false })).toBe(false);
    expect(decideReassert("CRITICAL", "2026-06-25T22:00:00.000Z", now, { lastPushFailed: false })).toBe(false);
  });
});
