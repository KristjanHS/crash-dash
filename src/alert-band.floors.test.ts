import { describe, expect, test } from "vitest";
import {
  regimeToBand,
  escalatorFloor,
  computeAlertBandDetail,
  coverageArmed,
  escalatorFloorDetail,
  escalatorFloorBreakdown,
  EARLY_WARN_ADVISORY,
  buildLabBand,
  R4_PROXIMITY_AMBER,
  r4ProximityTone,
  STAGE_TO_FLAGS,
  DE_ESCALATION_DAYS,
  FLOOR_SOURCES,
  DIAL_RUN_BAND_REASONS,
  type BandReason,
  EW_HALF_MET_BREAK,
  EW_HALF_MET_RS,
} from "./alert-band.js";
import { R4_ENTER_RUNG, R4_VT_TAIL, R4_HY_TAIL, R4_EXIT_HY, R4_EXIT_VT } from "./r4.js";
import { loadGeoInputs } from "./geo.js";
import { ALERT_RANK } from "./ladder.js";
import type { AlertLevel } from "./ladder.js";
import { computeFamilyPanel, GLOBAL_FAMILIES } from "./families.js";
import { computeT1Dial, earlyWarnFires } from "./t1dial.js";
import { makeDial } from "./test-helpers.js";
import type { Reading } from "./domain-types.js";
import type { Cadence } from "./domain-types.js";
import type { R4Phase } from "./r4.js";
import type { T1DialResult } from "./t1dial.js";
import { mkReading, mkGeoReading, mkDial, NEARHIGH_TOL, rungWhoseRegimeIs } from "./alert-band.test-helpers.js";

// EARLY-WARN sub-signal (fast-breaks redesign §1) — the capped ewFloor.
describe("ewFloor - capped EARLY-WARN sub-signal (fast-breaks redesign §1)", () => {
  test("a lone fast break lifts the escalator floor to WATCH, never above", () => {
    // ewFire=true, every other escalator OK ⇒ the binding floor is WATCH, source `ew`.
    const on = escalatorFloorDetail([], 0, "equity", false, true);
    expect(on.band).toBe("WATCH");
    expect(on.source).toBe("ew");
    // ewFire=false ⇒ the sub-signal contributes nothing.
    expect(escalatorFloorDetail([], 0, "equity", false, false).band).toBe("OK");
  });

  test("a real cause outranks the advisory on a tie: geo≥2 WARNING wins over ewFire", () => {
    // ewFire true but geoBase 2 (WARNING) ⇒ band WARNING, source `geo` (ew is listed last).
    const d = escalatorFloorDetail([], 2, "equity", false, true);
    expect(d.band).toBe("WARNING");
    expect(d.source).toBe("geo");
  });

  // R6 ([USER] 2026-07-31) — the PRE-FLOOR dial band ships on the DTO, separate from `chain.band`.
  test("buildLabBand: `dialBand` is the pre-floor read, and never collapses into chain.band", () => {
    // Two geo flags ⇒ the geo floor is WARNING over a Calm dial; the pushed band is that WARNING.
    const escalated = buildLabBand(makeDial(), [], 2, "equity", "WARNING", 0);
    expect(escalated.dialBand).toBe("OK"); // regimeToBand(Calm)
    expect(escalated.source).toBe("geo");
    // The discriminating pair: post-floor fields agree with each other, the pre-floor one does not.
    expect(escalated.chain.band).toBe("WARNING");
    expect(escalated.level).toBe("WARNING");
    expect(escalated.dialBand).not.toBe(escalated.chain.band);
    // Defaults off the NOTIFY regime (not the display one) when no persisted band is passed…
    // DELIBERATELY split axes, spread at the call site because `makeDial` derives both from the rung
    // and production cannot split them (DIAL_REGIME_CUTS === NOTIFY_REGIME_CUTS today). The split IS
    // the discriminator: with the axes agreeing, this assertion could not tell which one is read.
    expect(
      buildLabBand({ ...makeDial({ rung: 9 }, { creditFiring: true }), notifyRegime: "Caution" }, [], 0, "equity", "OK", 0)
        .dialBand,
    ).toBe("WATCH");
    // …and the explicit 7th argument (the handler's read off the alert row) wins over that default.
    expect(buildLabBand(makeDial(), [], 0, "equity", "OK", 0, "WARNING").dialBand).toBe("WARNING");
  });

  // /lab BAND drill-down, `ew` floor. The cell assertions were RED before 2026-07-23 (capMemberState
  // collapse + sibling-shadowing single row); the 4-row interleave is the 2026-08-15 AND-gate pin —
  // detector then its RS_LEG_OF leg, an OUT-OF-BAND literal like the membership pin (a hand-typed
  // order a flatMap-derived expectation could never red on).
  test("buildLabBand: every ew member AND its RS leg gets a row, interleaved, and RED renders RED", () => {
    const readings = ["DB_SMH", "RS_SMH", "DB_XLK", "RS_XLK"].map((id) => mkReading(id, "GLOBAL", "RED"));
    const band = buildLabBand(makeDial({ fastBreakEW: true }), readings, 0, "equity", "WATCH", 0);
    const ew = band.floors.find((f) => f.id === "ew")!;
    expect(ew.members.map((m) => m.id)).toEqual(["DB_SMH", "RS_SMH", "DB_XLK", "RS_XLK"]);
    expect(ew.members.map((m) => m.cappedState)).toEqual(["RED", "RED", "RED", "RED"]);
    // The floor itself stays WATCH-capped — the D-B safety property is display-independent.
    expect(ew.level).toBe("WATCH");
    expect(ew.cap).toBe("WATCH");
  });

  // AND-gate ruling 3 rendered (2026-08-15): a RED break vetoed by an intact RS leg keeps the floor
  // quiet, and BOTH rows of the pair carry the server-side note naming the unmet condition.
  test("buildLabBand: a RED break with a GREEN RS sibling ⇒ quiet ew floor + 'rel-strength intact' note", () => {
    const readings = [
      mkReading("DB_SMH", "GLOBAL", "RED"),
      mkReading("RS_SMH", "GLOBAL", "GREEN"),
      mkReading("DB_XLK", "GLOBAL", "GREEN"),
      mkReading("RS_XLK", "GLOBAL", "GREEN"),
    ];
    const stamped = readings.map((r) => ({ id: r.indicator.id, state: r.state }));
    const dial = makeDial({ fastBreakEW: earlyWarnFires(stamped) });
    expect(dial.fastBreakEW).toBe(false); // the gate vetoes the break on the notify path
    const band = buildLabBand(dial, readings, 0, "equity", "OK", 0);
    const ew = band.floors.find((f) => f.id === "ew")!;
    expect(ew.level).toBe("OK"); // quiet floor
    const byId = new Map(ew.members.map((m) => [m.id, m]));
    expect(byId.get("DB_SMH")!.note).toBe(EW_HALF_MET_BREAK);
    expect(byId.get("RS_SMH")!.note).toBe(EW_HALF_MET_BREAK);
    // The fully-calm XLK pair carries no note — nothing is unmet.
    expect(byId.get("DB_XLK")!.note).toBeUndefined();
    expect(byId.get("RS_XLK")!.note).toBeUndefined();
    // The inverse veto: RS breakdown alone (break not past cut) notes the OTHER unmet condition.
    const inv = buildLabBand(
      dial,
      [mkReading("DB_SMH", "GLOBAL", "GREEN"), mkReading("RS_SMH", "GLOBAL", "RED")],
      0,
      "equity",
      "OK",
      0,
    ).floors.find((f) => f.id === "ew")!;
    expect(inv.members.find((m) => m.id === "DB_SMH")!.note).toBe(EW_HALF_MET_RS);
  });

  // /lab BAND drill-down, `r4` rows: proximity tones, NOT the phase ladder ([USER] E5, 2026-07-26).
  // The `cash` phase is the discriminating fixture — under the old rule EVERY r4 row was RED there,
  // so a GREEN low-proximity row can only pass post-change. Setup derives from R4_ENTER_RUNG and
  // R4_PROXIMITY_AMBER; the tone VALUES are the out-of-band pin.
  const r4Rows = (targetRung: number, phase: R4Phase = "equity") =>
    new Map(
      buildLabBand(makeDial({ targetRung }), [], 0, phase, "OK", 0)
        .floors.find((f) => f.id === "r4")!
        .members.map((m) => [m.id, m]),
    );

  test("buildLabBand: an r4 row tones by ITS OWN proximity to ITS OWN gate, never by the phase", () => {
    const gate = R4_ENTER_RUNG;
    // Straddle the cut: the first rung at/above 0.8 of the gate vs the last one below it.
    const nearRung = Math.ceil(R4_PROXIMITY_AMBER * gate);
    expect(r4Rows(nearRung).get("r4-rung")!.state).toBe("AMBER");
    expect(r4Rows(nearRung - 1).get("r4-rung")!.state).toBe("GREEN");
    // r4 is RED-capable, so there is no cap collapse — cappedState tracks state.
    expect(r4Rows(nearRung).get("r4-rung")!.cappedState).toBe("AMBER");
    // The phase no longer reaches the rows: under `cash` the old rule painted all four RED.
    expect(r4Rows(nearRung - 1, "cash").get("r4-rung")!.state).toBe("GREEN");
    // And rows are INDEPENDENT — a hot rung row leaves the families row on its own proximity
    // (0 firing families / 3 = 0), which the phase-ladder tone could never express.
    expect(r4Rows(nearRung).get("r4-families")!.state).toBe("GREEN");
  });

  // The cut DIRECTION, pinned at `r4ProximityTone`'s own layer. The straddle test above can never
  // reach it: on the rung row the amber point is `0.8 * 8 = 6.4` and rungs are integers, so exact
  // equality is structurally unreachable there and `>=` → `>` leaves it green. Here the fixture is
  // the exact product of the two constants, so it lands ON the cut.
  test("r4ProximityTone: the proximity cut is INCLUSIVE - exactly at the fraction tones AMBER", () => {
    const threshold = R4_VT_TAIL;
    const atCut = R4_PROXIMITY_AMBER * threshold;
    // Vacuity guard: the fixture is only ON the cut if the ratio round-trips EXACTLY (it does not
    // for every threshold — 0.8 * 6.0 divides back to 0.8000000000000002, which `>` also passes,
    // so that fixture could never red-demo the direction).
    expect(atCut / threshold).toBe(R4_PROXIMITY_AMBER);
    expect(r4ProximityTone(atCut, threshold)).toBe("AMBER");
    // Just under the cut is the control (a hair below, so only the boundary itself distinguishes).
    expect(r4ProximityTone(atCut - 1e-9, threshold)).toBe("GREEN");
    // A missing feed has no readable proximity — GREEN, not a colour claiming unmeasured stress.
    expect(r4ProximityTone(null, threshold)).toBe("GREEN");
  });

  test("buildLabBand: the breaker's phase rides the r4 FLOOR head, and only that floor", () => {
    const floors = buildLabBand(makeDial(), [], 0, "cash", "OK", 0).floors;
    const r4 = floors.find((f) => f.id === "r4")!;
    expect(r4.phase).toBe("cash");
    expect(r4.phaseState).toBe("RED"); // the phase-ladder tone, unchanged — it just moved here
    expect(buildLabBand(makeDial(), [], 0, "reentry", "OK", 0).floors.find((f) => f.id === "r4")!.phaseState).toBe("AMBER");
    // No other floor has a phase machine, so neither field is served there.
    for (const f of floors.filter((x) => x.id !== "r4")) {
      expect(f.phase).toBeUndefined();
      expect(f.phaseState).toBeUndefined();
    }
  });

  // small-wins §2 ([USER] 2026-08-01, TOOLTIP ONLY): the two tail rows' `note` — band-panel.js's
  // ONLY tooltip-bound field — must state the strict-`<` EXIT thresholds beside the `≥` ENTER gate.
  // Setup is derived from the constants (`indicator-loop.md` §A retune is a ONE-place edit); the discriminating claim is
  // that the EXIT numbers differ from the ENTER ones and BOTH appear, which a note carrying only
  // the enter gate cannot satisfy. The rendered row is unaffected: `value`/`threshold`/`label` are
  // asserted equal to the ENTER pair, so a note edit can never leak into the row's own text.
  test("buildLabBand: the r4 tail rows state their strict-< EXIT thresholds in the note", () => {
    // Non-vacuity: exit and enter are DIFFERENT numbers, so "contains the exit value" is not
    // satisfied by the enter clause that was already there. (Also the standing hysteresis
    // invariant — an inverted pair would make this whole tooltip a lie.)
    expect(R4_EXIT_HY).toBeLessThan(R4_HY_TAIL);
    expect(R4_EXIT_VT).toBeLessThan(R4_VT_TAIL);

    const rows = r4Rows(1);
    const hy = rows.get("r4-hyoas")!;
    const vt = rows.get("r4-vt")!;
    // Both halves of the AND-ed tail-clear leg on both rows, with the strict `<`.
    expect(hy.note).toContain(`< ${R4_EXIT_HY.toFixed(1)}%`);
    expect(hy.note).toContain(`< ${R4_EXIT_VT.toFixed(2)}`);
    expect(vt.note).toContain(`< ${R4_EXIT_VT.toFixed(2)}`);
    expect(vt.note).toContain(`< ${R4_EXIT_HY.toFixed(1)}%`);
    // The ENTER clause survives — this ADDS to the tooltip, it does not replace it.
    expect(hy.note).toContain(`≥ ${R4_HY_TAIL.toFixed(1)}%`);
    expect(vt.note).toContain(`≥ ${R4_VT_TAIL}`);
    // …and the ROW itself is untouched: the gate a row renders (`value vs threshold`) stays the
    // ENTER threshold, so nothing about the exit reached the visible text.
    expect(hy.threshold).toBe(R4_HY_TAIL);
    expect(vt.threshold).toBe(R4_VT_TAIL);
    // The two NON-tail rows have no strict-< exit leg and must not have grown one.
    expect(rows.get("r4-rung")!.note).not.toContain("EXIT");
    expect(rows.get("r4-families")!.note).not.toContain("EXIT");
  });
});

// V-falseRED (fast-breaks redesign §1) — reproduce the 2026-07-21 DB_SMH-solo episode at the
// resolveCuts/dial level (NOT a sim:notify, which is blind to the cut/aggregation layers per
// research-probes.md) and prove the SHIPPED design (D-D removal + capped EW sub-signal) yields no wrong
// de-risk, then red-demo that reverting the removal reddens trend on the SAME episode.
describe("V-falseRED: the 2026-07-21 DB_SMH-solo episode (fast-breaks redesign §1)", () => {
  // DB_SMH at RED (63d break ≥15%); EVERY slow trend sibling GREEN; credit/rates (and the other
  // FIRE families) calm — the exact lone-fast-break shape that solo-tripped a false RED in prod.
  // DERIVED from the production table, not hand-typed: the fixture's claim is "EVERY slow
  // trend sibling GREEN", so a member added to GLOBAL_FAMILIES.trend (SPCONC, 2026-07-23)
  // must join the fixture automatically — a stale literal silently leaves one sibling ABSENT
  // and the "no solo-trip" assertion stops proving what its comment says.
  const slowTrend = GLOBAL_FAMILIES.find((f) => f.key === "trend")!.ids;
  const episode: Reading[] = [
    mkReading("DB_SMH", "GLOBAL", "RED"),
    ...slowTrend.map((id) => mkReading(id, "GLOBAL", "GREEN")),
    mkReading("F1", "FIN", "GREEN"), // credit calm (no blowout)
    mkReading("R1", "RATE", "GREEN"), // rates calm
    mkReading("R5", "FIN", "GREEN"), // volatility live + calm
    mkReading("CG", "GLOBAL", "GREEN"), // cross-asset live + calm
  ];
  const panelReadings = episode.map((r) => ({ id: r.indicator.id, state: r.state }));

  test("shipped design: trend does NOT solo-trip; band caps at WATCH via the EW advisory", () => {
    const globalPanel = computeFamilyPanel(panelReadings, GLOBAL_FAMILIES).families;
    const trend = globalPanel.find((f) => f.key === "trend")!;
    expect(trend.state).toBe("GREEN"); // DB_SMH left the worst-of ⇒ no lone RED
    expect(trend.firing).toBe(false);

    // Mirror assembleDial: the pure fold has no DB_SMH row (D-D), fastBreakEW is stamped from readings.
    const dial: T1DialResult = { ...computeT1Dial(globalPanel), fastBreakEW: earlyWarnFires(panelReadings) };
    expect(dial.fastBreakEW).toBe(true);
    expect(dial.armed).toBe(false);
    expect(dial.notifyRegime).toBe("Calm"); // the break never armed/positioned the dial

    const res = computeAlertBandDetail({
      dial,
      readings: episode,
      geoFlags: 0,
      r4Phase: "equity",
      recentDialBands: [],
    });
    expect(res.band).toBe("WATCH"); // capped advisory nudge — NOT a WARNING/CRITICAL de-risk
    expect(res.reason).toBe("floor:ew"); // the binding cause is the EW advisory, not a de-risk floor
    expect(EARLY_WARN_ADVISORY).toContain("do not de-risk"); // the action rule IS the copy (K-notify)
  });

  test("reverting the D-D removal seats DB_SMH OFF the trend band: its RED survives only as cannotArm", () => {
    const shipped = computeFamilyPanel(panelReadings, GLOBAL_FAMILIES).families.find((f) => f.key === "trend")!;
    // Pre-D-D roster: DB_SMH restored into the trend ids.
    const revertedDefs = GLOBAL_FAMILIES.map((f) =>
      f.key === "trend" ? { ...f, ids: [...f.ids, "DB_SMH"] } : f,
    );
    const reverted = computeFamilyPanel(panelReadings, revertedDefs).families.find((f) => f.key === "trend")!;

    // S6.3 (`BAND_DRIVING.trend`, families.ts): the band seat is a fixed roster, so a re-added member is
    // leg-only — the D-D removal and the band seat are now TWO guards on this episode, not one.
    expect(reverted.members.find((m) => m.id === "DB_SMH")?.state).toBe("RED"); // the episode's RED is present
    expect(shipped.cannotArm).toBeUndefined();
    expect(reverted.cannotArm).toEqual({ count: 1, worst: "RED", worstCount: 1 });
    expect(reverted.state).toBe("GREEN");
    expect(reverted.firing).toBe(false);
  });
});

// --- Stage 4 — GEO crisis-stage count-fold (Option A, RULED 2026-07-24) --------------------
describe("escalatorFloor - GEO crisis-stage count-fold (Stage 4, Option A)", () => {
  // Boundary cells of the count-fold (reduced from the {2,3}×{0,1,2}×{0,1} sweep). The first three
  // sit at total-flag 2 (geo WATCH→WARNING boundary) so a fold that misapplies STAGE_TO_FLAGS
  // reds the equivalence — flags 0 keeps the manual term from saturating the fold on its own
  // (flags≥2 alone already pins WARNING, blinding the stage term). EXPECTED derived from the exported
  // mapping constant, never hand-typed — a declared stage must behave EXACTLY like STAGE_TO_FLAGS[stage]
  // extra manual flags through the SAME production floor, so the fold (not a restated table) is
  // exercised. The 4th is the cap sentinel: max escalation, pinning geo ≤ WARNING. Stages 1
  // (auto-scored) and 4 (streak-gated) have their own pairs below.
  for (const { stage, flags, auto } of [
    { stage: 2, flags: 0, auto: 0 }, // stage-2 fold at the WATCH/WARNING boundary
    { stage: 3, flags: 0, auto: 0 }, // stage-3 fold at the same boundary
    { stage: 2, flags: 0, auto: 1 }, // auto=1 arm, still fold-sensitive
    { stage: 3, flags: 2, auto: 1 }, // cap sentinel: max escalation ⇒ geo ≤ WARNING
  ] as const) {
    test(`stage ${stage} + ${flags} manual flag(s) + ${auto} elevated auto reading(s) ≡ ${
      flags + STAGE_TO_FLAGS[stage]
    } flags + ${auto} auto (count-fold); geo never exceeds its WARNING cap`, () => {
      const readings = auto ? [mkReading("G1", "GEO", "AMBER")] : [];
      const withStage = escalatorFloorDetail(readings, flags, "equity", false, false, stage);
      const equivalent = escalatorFloorDetail(readings, flags + STAGE_TO_FLAGS[stage], "equity", false, false, 0);
      expect(withStage).toEqual(equivalent);
      // Geo-only world ⇒ the geo WARNING cap bounds the whole table — never CRITICAL from geo.
      expect(ALERT_RANK[withStage.band]).toBeLessThanOrEqual(ALERT_RANK.WARNING);
    });
  }

  test("declared stage 1 contributes nothing - the auto heldStage1 machine replaced it", () => {
    // loadGeoInputs throws on a committed 1 (geo.test.ts); reached directly, the term is 0.
    expect(escalatorFloorDetail([], 0, "equity", false, false, 1)).toEqual({ band: "OK", source: null });
  });

  test("declared-4 release: held one close short of the dwell, 0 at the dwell (streak-gated)", () => {
    expect(DE_ESCALATION_DAYS).toBeGreaterThanOrEqual(1); // premise guard: the offsets below need a real dwell
    const at = (streak: number) => escalatorFloorDetail([], 0, "equity", false, false, 4, false, streak);
    expect(at(DE_ESCALATION_DAYS - 1)).toEqual({ band: "WATCH", source: "geo" });
    expect(at(DE_ESCALATION_DAYS)).toEqual({ band: "OK", source: null });
    // Streak-less callers assume calm ⇒ a declared 4 reads RELEASED by default.
    expect(escalatorFloorDetail([], 0, "equity", false, false, 4)).toEqual({ band: "OK", source: null });
  });

  test("out-of-range stages throw (fail-loud): too-high, negative, non-integer", () => {
    for (const bad of [5, -1, 2.5]) {
      expect(() => escalatorFloor([], 0, "equity", false, false, bad)).toThrow(/crisisStage/);
    }
  });

  test("computeAlertBandDetail threads crisisStage into the floor (stage 2, calm dial ⇒ floor:geo)", () => {
    const base = { dial: makeDial(), readings: [], geoFlags: 0, r4Phase: "equity" as R4Phase, recentDialBands: [] };
    expect(computeAlertBandDetail(base)).toEqual({ band: "OK", reason: "regime" });
    expect(computeAlertBandDetail({ ...base, crisisStage: 2 })).toEqual({ band: "WARNING", reason: "floor:geo" });
  });

  test("buildLabBand threads crisisStage into the geo floor row (WARNING cap intact)", () => {
    const geo = (stage: number) => buildLabBand(makeDial(), [], 0, "equity", "OK", stage).floors.find((f) => f.id === "geo")!;
    expect(geo(0).level).toBe("OK");
    expect(geo(2)).toMatchObject({ level: "WARNING", cap: "WARNING" });
  });

  // --- R9: the geo floor prints its count arithmetic ([USER] 2026-07-31) ------------------------
  // The geo floor's level is the only one that does NOT follow from reading its member rows: it is a
  // SUM (manual flags + elevated auto readings + stage), so a WARNING used to read as "someone set a
  // flag". `basis` (the lead, `formatGeoBasisLead`) carries the sum and `basisDetail`
  // (`formatGeoBasis`) spells the addends out — SPLIT 2026-08-05 ([USER]) because the one-line form
  // made the geo block the widest on /lab; the FE hangs the detail off a ⓘ. Both halves are pinned
  // below: a regression that folds the arithmetic back into `basis` reds the lead assertions.
  const geoFloorOf = (readings: Reading[], flags: number, stage = 0, streak?: number) =>
    buildLabBand(makeDial(), readings, flags, "equity", "OK", stage, undefined, undefined, undefined, streak)
      .floors.find((f) => f.id === "geo")!;

  test("R9 FALSIFIER - one manual flag with every auto GEO reading GREEN is WATCH and prints `base 1`", () => {
    // The plan's own falsifier (R9): the walkthrough claimed a lone manual flag reached WARNING.
    // It does not, and the row must now SAY so — base 1, one addend, no auto term at all.
    const allGreen = [mkGeoReading("G1", "GREEN"), mkGeoReading("OVX", "GREEN"), mkGeoReading("BRENT", "GREEN")];
    const geo = geoFloorOf(allGreen, 1);
    expect(geo.level).toBe("WATCH");
    expect(geo.basis).toBe("geo base 1");
    expect(geo.basisDetail).toBe("geo base 1 = 1 manual");
  });

  test("R9: the WARNING case names the auto reading that made the second flag", () => {
    // 1 manual + OVX RED (a live market indicator), G1/BRENT calm ⇒ base 2. One lit oil read, so
    // the printed auto TERM (`autoFactors`) and the named id list coincide here; the factor rule
    // separates them only when two reads of one factor are lit — pinned by the GEO factor-rule
    // test in `alert-band.compose.test.ts`, not here.
    const geo = geoFloorOf([mkGeoReading("G1", "GREEN"), mkGeoReading("OVX", "RED"), mkGeoReading("BRENT", "GREEN")], 1);
    expect(geo.level).toBe("WARNING");
    expect(geo.basis).toBe("geo base 2");
    expect(geo.basisDetail).toBe("geo base 2 = 1 manual + 1 auto (OVX)");
    // §11.1: two lit reads of the OIL factor print `1 auto (BRENT, OVX)` — the TERM is the factor
    // count, the parenthetical still names every lit id, and the terms still sum to `base`.
    expect(geoFloorOf([mkGeoReading("BRENT", "RED"), mkGeoReading("OVX", "AMBER")], 1).basisDetail).toBe(
      "geo base 2 = 1 manual + 1 auto (BRENT, OVX)",
    );
    // A declared crisis stage is its own addend, and zero addends are omitted rather than `+ 0`.
    expect(geoFloorOf([], 0, 4, DE_ESCALATION_DAYS - 1).basisDetail).toBe("geo base 1 = 1 stage");
    expect(geoFloorOf([], 0, 0).basisDetail).toBe("geo base 0 - nothing flagged");
    // The stand-down dwell renders as its own addend, progress derived from the constant…
    expect(geoFloorOf([], 0, 0, DE_ESCALATION_DAYS - 1).basisDetail).toBe(
      `geo base 1 = 1 stage-hold (dwell ${DE_ESCALATION_DAYS - 1}/${DE_ESCALATION_DAYS})`,
    );
    // …and a RELEASED declared 4 is OMITTED, not printed as `+ 0 stage`.
    expect(geoFloorOf([], 0, 4, DE_ESCALATION_DAYS).basisDetail).toBe("geo base 0 - nothing flagged");
    // The lead is the SUM alone on every one of those shapes — no addend may leak back into it.
    expect([geoFloorOf([], 0, 4, DE_ESCALATION_DAYS - 1).basis, geoFloorOf([], 0, 0).basis]).toEqual(["geo base 1", "geo base 0"]);
  });

  test("A1: the declared-stage addend is a member ROW, toned by whether it adds anything", () => {
    const stageRowOf = (floor: ReturnType<typeof geoFloorOf>) => floor.members.find((m) => m.id === "GEO_STAGE")!;
    // Declared stage 2 ⇒ +2: AMBER, note off the SAME GeoBasis the ⓘ footnote prints.
    expect(stageRowOf(geoFloorOf([], 0, 2))).toMatchObject({
      state: "AMBER",
      cappedState: "AMBER",
      note: "adds 2 to the geo base",
    });
    // Stand-down hold (released 4, dwell running) ⇒ +1 with the dwell clause.
    expect(stageRowOf(geoFloorOf([], 0, 0, DE_ESCALATION_DAYS - 1)).note).toBe(
      `adds 1 to the geo base - includes the stand-down hold (dwell ${DE_ESCALATION_DAYS - 1}/${DE_ESCALATION_DAYS})`,
    );
    // Nothing declared ⇒ GREEN with an explicit zero addend — the row is always present.
    expect(stageRowOf(geoFloorOf([], 0, 0))).toMatchObject({ state: "GREEN", note: "adds 0 to the geo base" });
  });

  test("R9: `basis` carries the SUM only - never the floor's cut-points - and only the geo floor has one", () => {
    // The round-2 ruling: printing `≥1 WATCH / ≥2 WARNING` would hand-copy a threshold into display
    // copy. Scan every basis string this builder can emit for a restated cut or band word.
    const lit = geoFloorOf([mkReading("OVX", "GEO", "RED")], 2, 2);
    const empty = geoFloorOf([], 0, 0);
    const bases = [lit.basis!, lit.basisDetail!, empty.basis!, empty.basisDetail!];
    for (const b of bases) {
      expect(b).not.toMatch(/≥|>=|WATCH|WARNING|CRITICAL/);
    }
    // Every other floor omits BOTH fields — they have no count to explain — and the two ship
    // together, so the FE never has a lead with no footnote behind its ⓘ (or the reverse).
    const floors = buildLabBand(makeDial(), [], 1, "equity", "OK", 0).floors;
    expect(floors.filter((f) => f.basis !== undefined).map((f) => f.id)).toEqual(["geo"]);
    expect(floors.filter((f) => f.basisDetail !== undefined).map((f) => f.id)).toEqual(["geo"]);
  });

  test("buildLabBand defaults crisisStage to the committed config (loadGeoInputs), not 0 - the untouched /lab handler stays in step with the cron", () => {
    // Content-agnostic: compares the no-arg default against the explicit config stage. Today
    // (config stage 1 ≠ 0) this discriminates the default source; if config later returns to 0
    // the pin goes quiet, not red — acceptable for a default-source pin.
    const dial = makeDial();
    expect(buildLabBand(dial, [], 0, "equity", "OK")).toEqual(
      buildLabBand(dial, [], 0, "equity", "OK", loadGeoInputs().crisisStage),
    );
  });
});

// R4 Stage 3.1 — the COVERAGE floor
// exists but is WIRED OFF: every caller defaults `coverageArmed = false`, so it can only ever read
// OK today. What is pinned here is the SHAPE the arming stage (3.2) will switch on: the floor is
// LAST in the tie order, WATCH-capped, and adding it moved no existing band.
describe("coverage floor (R4) - appended last, wired OFF by default", () => {
  const ratesRed = (): Reading[] => [
    mkReading("R1", "RATE", "RED"),
    mkReading("R2", "RATE", "RED"),
  ];

  test("the floor is LAST, WATCH-capped, and OK for every default caller", () => {
    const d = escalatorFloorBreakdown([], 0, "equity", false, false, 0);
    expect(d.floors.map((f) => f.id)).toEqual(["credit", "r4", "geo", "rate", "ew", "coverage"]);
    expect(d.floors.at(-1)).toEqual({ id: "coverage", level: "OK", cap: "WATCH" });
    // Behaviour pin (Stage 3.1's whole claim): the band an existing caller gets is byte-identical
    // to the pre-coverage derivation — an all-OK floor set still bands OK with no source.
    expect({ band: d.band, source: d.source }).toEqual({ band: "OK", source: null });
  });

  test("armed ⇒ WATCH and `floor:coverage`, and it can never exceed WATCH", () => {
    const armed = escalatorFloorBreakdown([], 0, "equity", true, false, 0, true);
    expect(armed.floors.at(-1)!.level).toBe("WATCH");
    expect({ band: armed.band, source: armed.source }).toEqual({ band: "WATCH", source: "coverage" });
    // The cap is STRUCTURAL: `fired`, a stage and a live dial cannot push this floor higher.
    expect(escalatorFloorBreakdown([], 0, "equity", true, true, 4, true).floors.at(-1)!.level).toBe("WATCH");
    // The wrappers thread it through unchanged (same band from all three entry points).
    expect(escalatorFloor([], 0, "equity", false, false, 0, true)).toBe("WATCH");
    expect(escalatorFloorDetail([], 0, "equity", false, false, 0, true)).toEqual({
      band: "WATCH",
      source: "coverage",
    });
  });

  test("on a WATCH tie every REAL cause wins `source` - coverage says only `we cannot see`", () => {
    // rate at WATCH (RATE base ≥ RATE_STRESS_FLOOR) + coverage armed: the tie must name `rate`.
    const withRate = escalatorFloorBreakdown(ratesRed(), 0, "equity", false, false, 0, true);
    expect(withRate.band).toBe("WATCH");
    expect(withRate.source).toBe("rate");
    // Even the ADVISORY ew nudge outranks it — coverage is last of all.
    const withEw = escalatorFloorBreakdown([], 0, "equity", false, true, 0, true);
    expect(withEw.band).toBe("WATCH");
    expect(withEw.source).toBe("ew");
  });

  test("buildLabBand: the floor renders last, empty and OK by default; armed it names the degraded FAMILIES", () => {
    const quiet = buildLabBand(makeDial(), [], 0, "equity", "OK", 0);
    expect(quiet.floors.map((f) => f.id)).toEqual(["credit", "r4", "geo", "rate", "ew", "coverage"]);
    expect(quiet.floors.at(-1)).toEqual({ id: "coverage", level: "OK", cap: "WATCH", members: [] });

    // A panel with one degraded family (an absent roster member) and one clean one. The rows are
    // SYNTHETIC: id = FamilyKey, AMBER under the WATCH cap, and the note names what is not reporting.
    const panel = [
      {
        key: "rates" as const,
        label: "rates",
        state: "GREEN" as const,
        live: true,
        firing: false,
        contribution: 0,
        members: [{ id: "R1", label: "R1", state: "GREEN" as const }],
        absent: 1,
        absentIds: ["R6"],
        coverageDegraded: true,
      },
      {
        key: "credit" as const,
        label: "credit",
        state: "GREEN" as const,
        live: true,
        firing: false,
        contribution: 0,
        members: [{ id: "F1", label: "F1", state: "GREEN" as const }],
        absent: 0,
        absentIds: [],
        coverageDegraded: false,
      },
    ];
    const band = buildLabBand(makeDial(), [], 0, "equity", "WATCH", 0, "OK", true, panel);
    const floor = band.floors.at(-1)!;
    expect(floor.level).toBe("WATCH");
    expect(band.source).toBe("coverage");
    // ONLY the degraded family gets a row — a clean family is not evidence of blindness.
    expect(floor.members.map((m) => m.id)).toEqual(["rates"]);
    expect(floor.members[0]!.cappedState).toBe("AMBER");
    expect(floor.members[0]!.note).toContain("computed without R6 (not reporting)");
  });
});

// B4 — the /lab coverage note now names BOTH halves of the claim, because `FamilyPanel` carries
// both id sets. An EMPTY set is OMITTED, never printed as an empty clause: the shapes below are the
// complete case split, and the `held` prefix is identical in all of them. ⚠ The LAST one
// (both sets empty) is NOT production-reachable — a coverage-degraded family with no stale holder is
// a CARRIED one, and a carried family always carries a FULL `absentIds` roster (see the
// defensive-only note in alert-band.ts). It is pinned as the fail-safe's formatting only (no
// dangling ` — ` separator), never as a shape /lab can render.
describe("coverage floor note (B4) - names the stale AND the absent members", () => {
  const HELD = "this family's RED verdict";
  const noteFor = (absentIds: string[], verdictHoldIds: string[]) => {
    const panel = [
      {
        key: "rates" as const,
        label: "rates",
        state: "RED" as const,
        live: true,
        firing: true,
        contribution: 1,
        members: [{ id: "R1", label: "R1", state: "RED" as const }],
        absent: absentIds.length,
        absentIds,
        coverageDegraded: true,
        verdictHoldIds,
      },
    ];
    return buildLabBand(makeDial(), [], 0, "equity", "WATCH", 0, "OK", true, panel).floors.at(-1)!.members[0]!.note;
  };

  test("both sets ⇒ held-by-lagging first, then computed-without, separated by '; '", () => {
    expect(noteFor(["R6"], ["R1"])).toBe(`${HELD} - held by lagging R1; computed without R6 (not reporting)`);
  });

  test("stale only ⇒ no computed-without clause", () => {
    expect(noteFor([], ["R1", "R2"])).toBe(`${HELD} - held by lagging R1, R2`);
  });

  test("absent only ⇒ no held-by-lagging clause", () => {
    expect(noteFor(["R6", "R7"], [])).toBe(`${HELD} - computed without R6, R7 (not reporting)`);
  });

  test("neither ⇒ the bare last-known sentence, with no dangling separator (defensive-only shape)", () => {
    expect(noteFor([], [])).toBe(`${HELD} rests on last-known data`);
  });
});

// R4/R5 Stage 3.2 — the floor is now ARMED on the notify path: `coverageArmed(panel, rows)` resolves
// the claim and `computeAlertBandDetail` threads it into the floor. Stage 3.1 pinned the floor's own
// shape through `escalatorFloorBreakdown`; what is pinned HERE is the arming predicate itself and the
// threading through the band seam — dropping either leaves 3.1's tests green.
describe("coverage floor (R4/R5) - arming on the notify path", () => {
  const degradedPanel = [
    {
      key: "rates" as const,
      label: "rates",
      state: "GREEN" as const,
      live: true,
      firing: false,
      contribution: 0,
      members: [{ id: "R1", label: "R1", state: "GREEN" as const }],
      absent: 1,
      absentIds: ["R6"],
      coverageDegraded: true,
    },
  ];
  const cleanPanel = [{ ...degradedPanel[0]!, absent: 0, absentIds: [], coverageDegraded: false }];

  /** Band the notify seam the way run-core does: the arming claim resolved, then threaded. */
  const bandWith = (
    panel: typeof degradedPanel,
    rows: readonly { cadence?: Cadence; lag?: boolean }[],
    over: Partial<Parameters<typeof computeAlertBandDetail>[0]> = {},
  ) =>
    computeAlertBandDetail({
      dial: mkDial("Calm"),
      readings: [],
      geoFlags: 0,
      r4Phase: "equity",
      recentDialBands: [],
      coverageArmed: coverageArmed(panel, rows),
      ...over,
    });

  test("(a) a degraded family + a fresh DAILY peer ⇒ the band lifts to WATCH, reason floor:coverage", () => {
    const d = bandWith(degradedPanel, [{ cadence: "daily", lag: false }, { cadence: "daily", lag: true }]);
    expect(d).toEqual({ band: "WATCH", reason: "floor:coverage" });
    // The panel half is load-bearing too: the same fresh-peer world with nothing degraded stays put.
    expect(bandWith(cleanPanel, [{ cadence: "daily", lag: false }]).band).toBe("OK");
  });

  test("(b) divergence, not age - the SAME panel with EVERY daily feed stale does not arm", () => {
    // The market-holiday / whole-run-outage world: blindness is global, so it is not evidence that
    // THIS family lost sight of anything. Band unchanged from the raw Calm dial.
    const d = bandWith(degradedPanel, [{ cadence: "daily", lag: true }, { cadence: "daily", lag: true }]);
    expect(d).toEqual({ band: "OK", reason: "regime" });
    // `stale === undefined` (never assessed) is NOT freshness — no clock lives in this seam.
    expect(bandWith(degradedPanel, [{ cadence: "daily" }]).band).toBe("OK");
  });

  test("(c) daily-only - a fresh WEEKLY peer alone cannot arm the floor", () => {
    // A weekly series reads fresh by its own cut for days at a stretch, so it says nothing about
    // whether the world is reporting TODAY (the retired `flowing` guard's weekly-peer pin).
    const d = bandWith(degradedPanel, [{ cadence: "weekly", lag: false }, { cadence: "daily", lag: true }]);
    expect(d).toEqual({ band: "OK", reason: "regime" });
    // Discriminating pair: swap that weekly peer for a daily one and the SAME panel arms.
    expect(bandWith(degradedPanel, [{ cadence: "daily", lag: false }, { cadence: "daily", lag: true }]).band)
      .toBe("WATCH");
  });

  test("(d) the WATCH cap survives the band seam - coverage alone can never push past WATCH", () => {
    // Structural: a coverage claim is not a market reading, so it must be incapable of producing the
    // WARNING/CRITICAL bands an actual danger score reaches. Crank every other knob the floor sees.
    const armedRows = [{ cadence: "daily" as Cadence, lag: false }];
    expect(bandWith(degradedPanel, armedRows, { dial: mkDial("Calm", true) }).band).toBe("WATCH");
    // And it never LOWERS a genuinely elevated band either — max composition, both directions.
    expect(bandWith(degradedPanel, armedRows, { dial: mkDial("Crisis") }).band).toBe("CRITICAL");
  });

  test("(e) on a WATCH tie a REAL cause keeps `source` - the reason names `rate`, not `coverage`", () => {
    // Same band from either floor, so only the PERSISTED REASON discriminates: the audit row must
    // name the actionable cause. (The tie order itself is pinned at the floor seam by Stage 3.1;
    // what is new here is that `computeAlertBandDetail` reports it once coverage can actually arm.)
    const withRate = bandWith(degradedPanel, [{ cadence: "daily", lag: false }], {
      readings: [mkReading("R1", "RATE", "RED"), mkReading("R2", "RATE", "RED")],
    });
    expect(withRate).toEqual({ band: "WATCH", reason: "floor:rate" });
  });
});

// CLAUDE.md's "the dial band IS the notify band (`run.ts`)" — what that sentence actually claims.
// NOT field equality: run-core.ts persists `dialBand` (the raw notify-axis regime→band) and the final
// `level` as SEPARATE fields, and run.alert-state.test.ts's idempotency fixture holds them at OK vs CRITICAL in the
// same row. The claim is that both sit on ONE axis with the dial band as its FLOOR:
//   (i)  ALERT_RANK[band] >= ALERT_RANK[regimeToBand(dial.notifyRegime)] on EVERY path — the lag, the
//        escalator floors, the divergence bump and the verdict hold can only RAISE. This is the
//        "INVARIANT (production)" asserted in families.ts's `dialBand` docblock, which the FE leans on;
//        prose-only until here.
//   (ii) `reason: "regime"` is EXACTLY the case where the two coincide — the only branch in which the
//        pushed band literally IS the dial band.
// Read-only pin (audit stage L3): it composes the shipped mechanisms, it does not constrain any of them
// individually. Each mechanism's own shape is pinned elsewhere: the escalator floors above in this file;
// `deEscalationLag`, `applyDivergenceBump` and `verdictHoldLegs` in `alert-band.compose.test.ts`.
describe("the dial band is the FLOOR of the notify band (one axis, raise-only)", () => {
  const dialBandOf = (d: T1DialResult) => regimeToBand(d.notifyRegime);
  /** GREEN so the credit floor never confounds the D-B bump; delta20 IS the 30d change (Stage 1.2). */
  const f1Widening: Reading = { ...mkReading("F1", "FIN", "GREEN"), delta20: 0.1 };
  const arm = (over: Partial<Parameters<typeof computeAlertBandDetail>[0]> = {}) => ({
    dial: mkDial("Caution"),
    readings: [] as Reading[],
    geoFlags: 0,
    r4Phase: "equity" as R4Phase,
    recentDialBands: [] as AlertLevel[],
    ...over,
  });

  // One arm per reason `computeAlertBandDetail` can emit — ALL SIX escalator floors
  // (`FLOOR_SOURCES`: credit, r4, geo, rate, ew, coverage), the de-escalation lag, the divergence
  // bump and the verdict hold — plus the two resting `regime` cases (calm-ish and top-of-ladder),
  // so the invariant is measured where each mechanism actually binds rather than on a single quiet
  // input. `no-dial` is the one reason absent, and unreachable here by construction: it is written
  // by `run-core.ts` on the dial-less path, which never calls this function.
  const ARMS: { name: string; input: Parameters<typeof computeAlertBandDetail>[0] }[] = [
    { name: "clean dial, nothing escalating", input: arm() },
    { name: "elevated dial, nothing escalating", input: arm({ dial: mkDial("Crisis") }) },
    { name: "de-escalation lag", input: arm({ dial: mkDial("Calm"), recentDialBands: ["WARNING"] }) },
    { name: "credit escalator floor", input: arm({ dial: mkDial("Calm"), readings: [mkReading("F1", "FIN", "RED")] }) },
    { name: "r4 cash floor", input: arm({ dial: mkDial("Calm"), r4Phase: "cash" as R4Phase }) },
    { name: "crisis-stage geo floor", input: arm({ dial: mkDial("Calm"), crisisStage: 2 }) },
    // The three WATCH-capped floors. Each is driven through its OWN input so a tie can never let
    // one stand in for another: rate off RATE-channel readings, ew off the dial's `fastBreakEW`,
    // coverage off the caller-resolved boolean.
    {
      name: "rate-stress floor",
      input: arm({
        dial: mkDial("Calm"),
        readings: [mkReading("R1", "RATE", "RED"), mkReading("R2", "RATE", "RED")],
      }),
    },
    {
      name: "early-warn (ew) floor",
      input: arm({
        dial: makeDial(
          { rung: rungWhoseRegimeIs("Calm"), armed: true, fired: true, fastBreakEW: true },
          { creditFiring: true },
        ),
      }),
    },
    { name: "coverage floor", input: arm({ dial: mkDial("Calm"), coverageArmed: true }) },
    {
      name: "divergence bump",
      input: arm({ readings: [f1Widening], spDistToHigh: NEARHIGH_TOL, nearHighTol: NEARHIGH_TOL }),
    },
    { name: "verdict hold", input: arm({ dial: mkDial("Calm"), verdictHoldFloor: "WARNING" }) },
  ];

  test("(i) no mechanism can put the notify band BELOW the dial band", () => {
    for (const { name, input } of ARMS) {
      const { band } = computeAlertBandDetail(input);
      const dialBand = dialBandOf(input.dial);
      expect(ALERT_RANK[band], `${name}: band ${band} sits below dial band ${dialBand}`).toBeGreaterThanOrEqual(
        ALERT_RANK[dialBand],
      );
    }
    // Non-vacuity: `>=` is satisfied trivially by an arm set where nothing ever escalates. Pin that
    // every raising mechanism is REPRESENTED and still binds — an arm that silently stopped
    // escalating (or a reason renamed at the seam) reds here instead of quietly hollowing the loop.
    // DERIVED, never hand-typed: the expected set is built from the two exported enumerations the
    // `BandReason` type itself is made of, so adding a `FloorSource` (or a non-floor reason) without
    // an arm above fails HERE rather than silently widening the union past the coverage.
    const expected = new Set<BandReason>([
      ...FLOOR_SOURCES.map((f): BandReason => `floor:${f}`),
      ...DIAL_RUN_BAND_REASONS,
    ]);
    expect(new Set(ARMS.map((a) => computeAlertBandDetail(a.input).reason))).toEqual(expected);
  });

  test("(ii) `reason: 'regime'` is exactly the case where the notify band IS the dial band", () => {
    let coincide = 0;
    for (const { name, input } of ARMS) {
      const { band, reason } = computeAlertBandDetail(input);
      const isDialBand = ALERT_RANK[band] === ALERT_RANK[dialBandOf(input.dial)];
      expect(reason === "regime", `${name}: reason ${reason} with band ${band}`).toBe(isDialBand);
      if (isDialBand) coincide++;
    }
    // Both sides of the biconditional must occur, or it is half-tested: some arms rest ON the dial
    // band and some are pushed above it.
    expect(coincide).toBeGreaterThan(0);
    expect(coincide).toBeLessThan(ARMS.length);
  });
});
