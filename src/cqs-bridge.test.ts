import { expect, test, describe } from "vitest";
import { creditBridgeCutSeries, scoreCreditBridge, highBandState } from "./scorers-composite.js";
import { CQS } from "./registry-composite.js";
import { type Observation } from "./domain-types.js";
import { buildCqsChart } from "./chart-rail.js";
import { CQS_CUT_BANDS, CQS_DESCRIPTOR } from "./family-descriptor-rows.js";
import type { ChartBand } from "./api/types.js";
import { familyOf } from "./families.js";
import { MEMBER_WEIGHT, LEG_FIELD } from "./danger-ladder.js";
import { computeCells } from "./danger-engine.js";
import { buildMemberState } from "./danger-member-state.js";
import { gf } from "./danger-engine.test-helpers.js";
import { SEV_CUTS } from "./danger-concentration.js";

// 300 consecutive calendar days from 2025-01-01. Both legs share the date array (alignByDate joins
// on identical strings), so the spread is `baa − aaa` per day.
const DAYS = 300;
const dates = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(Date.UTC(2025, 0, 1 + i));
  return d.toISOString().slice(0, 10);
});
const aaa: Observation[] = dates.map((date) => ({ date, value: 1.0 }));
/** baa = 1.5 + noise; a widening ramp of +1.0 over the last 27 days lifts the spread 0.5 → ~1.5. */
const baaWiden: Observation[] = dates.map((date, i) => {
  const noise = 0.05 * Math.sin(i / 5);
  const ramp = i >= DAYS - 27 ? (1.0 * (i - (DAYS - 27))) / 27 : 0;
  return { date, value: 1.5 + noise + ramp };
});
/** Monthly EBP labels 2025-01..2025-09 (latest anchor month-END = 2025-09-30, ~27d before day 299). */
const ebp: Observation[] = Array.from({ length: 9 }, (_, m) => ({
  date: `2025-0${m + 1}-01`,
  value: 0.2,
}));

describe("CQS EBP-bridge - Stage 2.1 falsifiers", () => {
  // Falsifier 1: the card paints the BRIDGE Δ in its own units, not the retired spread LEVEL.
  test("card paints the bridge Δ, not the Baa−Aaa spread level", () => {
    // A flat 0.5 spread: the bridge Δ (spread − anchor) ≈ 0, while the spread LEVEL is 0.5. The
    // stored `level` must be the ~0 bridge, so a scorer that stored the level (0.5) reds here.
    const flatBaa: Observation[] = dates.map((date) => ({ date, value: 1.5 }));
    const r = scoreCreditBridge(CQS, flatBaa, aaa, ebp);
    expect(Math.abs(r.level)).toBeLessThan(0.05); // Δ ≈ 0, NOT the 0.5 spread level
    // The chart draws no static amber/red LEVEL pair — the z cuts are MOVING, so since 2026-08-20
    // (U3) they ride the per-DATE `perPoint`
    // transport in Δ units instead of the retired `context-only` sentinel. Both keys are read off
    // `CQS_CUT_BANDS` and the multiples off the descriptor, so this pins the SHAPE, never a literal.
    const spec = buildCqsChart(CQS);
    expect(spec.series[0]!.fromPoint).toBe("value");
    expect(spec.bands).not.toBe("context-only");
    const bands = spec.bands as ChartBand[];
    expect(bands.map((b) => [b.level, b.source, b.fromPoint])).toEqual(
      CQS_CUT_BANDS.map((b) => [b.level, "perPoint", b.key]),
    );
    // Every cut sits on the PRIMARY (Δ) axis — a cut emitted on a second axis would draw beside a
    // z trace this chart does not plot.
    expect(bands.every((b) => b.axis === "primary")).toBe(true);
    // The caption COMPOSES its multiple off the descriptor — a literal in the label would rot on retune.
    const c = CQS_DESCRIPTOR.scorer.constants;
    expect(bands.map((b) => b.label)).toEqual(
      CQS_CUT_BANDS.map((b) => `${b.level} ${+c[b.from].toFixed(2)}σ of same-horizon Δ`),
    );
  });

  // U3 falsifier: the DRAWN cut is the SCORED cut, back-transformed. `cut = z* × σ(t)` must invert
  // the scorer's `z = Δ ÷ σ(t)` exactly, or the line and the ribbon disagree on which days fire.
  test("the drawn cut pair inverts the scorer's z on every called day, and is ABSENT on un-called ones", () => {
    const { dates: cutDates, cuts } = creditBridgeCutSeries(baaWiden, aaa, ebp);
    const [amberBand, redBand] = CQS_CUT_BANDS;
    const { zAmber, zRed } = CQS_DESCRIPTOR.scorer.constants;
    expect(cutDates).toEqual(dates);
    // Every DRAWN cut must sit above `z* × sigmaFloor`: the scorer admits a day only when
    // `σ > sigmaFloor` (R3), so a cut at or below that bound proves it was scaled by some OTHER
    // σ than the one the ribbon scored. (The two cuts' RATIO is `zRed/zAmber` algebraically, off
    // any σ whatever — it pins nothing, so it is not asserted.)
    const called = cutDates.map((_, i) => i).filter((i) => cuts[amberBand.key]![i] !== undefined);
    expect(called.length).toBeGreaterThan(0);
    for (const i of called) {
      expect(cuts[amberBand.key]![i]!).toBeGreaterThan(zAmber * CQS_DESCRIPTOR.scorer.constants.sigmaFloor);
      expect(cuts[redBand.key]![i]!).toBeGreaterThan(zRed * CQS_DESCRIPTOR.scorer.constants.sigmaFloor);
    }
    // The last day fires non-GREEN, so |Δ| must sit ABOVE the amber cut drawn on that same day —
    // the line the eye reads and the state the ribbon paints are one model.
    const last = dates.length - 1;
    const r = scoreCreditBridge(CQS, baaWiden, aaa, ebp);
    expect(r.state).not.toBe("GREEN");
    expect(Math.abs(r.level)).toBeGreaterThan(cuts[amberBand.key]![last]!);
    // End-to-end inverse: reconstruct σ(t) FROM the drawn amber cut, re-derive z, and demand the
    // ribbon's own state falls out. A cut built off a wrong multiple or a wrong σ diverges here.
    const sigmaFromCut = cuts[amberBand.key]![last]! / zAmber;
    expect(highBandState(Math.abs(r.level) / sigmaFromCut, zAmber, zRed)).toBe(r.state);
    // R5: no anchor ⇒ no σ ⇒ NO cut on any day. Absent (undefined), never 0 — a 0 would draw a cut
    // at the axis origin on precisely the days the scorer declines to call.
    const { cuts: noAnchor } = creditBridgeCutSeries(baaWiden, aaa, []);
    expect(noAnchor[amberBand.key]!.every((v) => v === undefined)).toBe(true);
    expect(noAnchor[redBand.key]!.every((v) => v === undefined)).toBe(true);
    // A DEAD-FLAT spread collapses σ below `sigmaFloor` ⇒ same absence (R3's quiet-regime guard),
    // and never an exploded cut near zero.
    const flat: Observation[] = dates.map((date) => ({ date, value: 1.5 }));
    const { cuts: flatCuts } = creditBridgeCutSeries(flat, aaa, ebp);
    expect(flatCuts[amberBand.key]!.every((v) => v === undefined)).toBe(true);
  });

  // Falsifier 2 (R5): anchor loss ⇒ silent GREEN, never scored against an improvised anchor.
  test("anchor loss (no EBP) folds GREEN, while a real anchor scores the widening", () => {
    const withAnchor = scoreCreditBridge(CQS, baaWiden, aaa, ebp);
    const noAnchor = scoreCreditBridge(CQS, baaWiden, aaa, []);
    // With a real anchor the widening is scored (non-zero Δ, and it fires non-GREEN here).
    expect(withAnchor.level).toBeGreaterThan(0.5);
    expect(withAnchor.state).not.toBe("GREEN");
    // R5: no anchor ⇒ Δ=0, GREEN — this is the line a mutation of the undefined-z guard reds.
    expect(noAnchor.level).toBe(0);
    expect(noAnchor.state).toBe("GREEN");
  });

  // The generic HIGH classifier the bridge folds z through (amber-inclusive, red-strict N1).
  test("highBandState: red-strict `>`, amber-inclusive `≥`", () => {
    expect(highBandState(2.6, 1.5, 2.5)).toBe("RED");
    expect(highBandState(2.5, 1.5, 2.5)).toBe("AMBER"); // exactly at red is AMBER (N1)
    expect(highBandState(1.5, 1.5, 2.5)).toBe("AMBER");
    expect(highBandState(1.49, 1.5, 2.5)).toBe("GREEN");
  });

});

describe("CQS EBP-bridge - Stage 3.1 seat falsifiers", () => {
  // (i) The bridge can never out-weigh the member it front-runs: every CQS cell ≤ 0.7× EBP's.
  // Derived from the two live rows — never a restated number — so a retune of either reds here.
  // Red demo: bump any CQS cell above 0.7× its EBP twin (e.g. Semis 0.7 → 0.8) ⇒ reds.
  test("every CQS cell is ≤ 0.7× the corresponding EBP cell", () => {
    const ebp = MEMBER_WEIGHT.EBP!;
    const cqs = MEMBER_WEIGHT.CQS!;
    for (const [leg, w] of Object.entries(cqs)) {
      const cap = 0.7 * (ebp[leg as keyof typeof ebp] ?? 0);
      expect(w, `CQS.${leg}=${w} exceeds 0.7×EBP.${leg}=${cap}`).toBeLessThanOrEqual(cap);
    }
    // EU-Fin is DROPPED (a US quality spread does not reach a European-financials rung), never zeroed.
    expect(cqs).not.toHaveProperty("EU-Fin");
  });

  // (ii) A full-RED bridge scales to its max cell, which must sit below the RED severity cut — so the
  // seat is AMBER-capable but can NEVER solo-RED a leg. Compared against the live SEV_CUTS.red, not 0.75.
  // Red demo: lift the CQS max (Semis) to ≥ SEV_CUTS.red (0.75) ⇒ reds.
  test("max(CQS row) < SEV_CUTS.red - the bridge can never solo-RED a leg", () => {
    const maxCell = Math.max(...Object.values(MEMBER_WEIGHT.CQS!));
    expect(maxCell).toBeLessThan(SEV_CUTS.red);
  });

  // (iii) A seat that moves only `familyOf` is not wired. CQS must ALSO enter the leg's
  // reached population — computeCells folds it. Drive the real cell fold with ONLY CQS firing among
  // credit members on a leg it reaches (Semis): the `cr` cell must light on CQS alone.
  // Red demo: drop CQS from `GLOBAL_FAMILIES.credit` (family-table.ts) ⇒ CQS is no longer a relevant
  // `cr` member, the CQS-only fixture leaves the cell `calm`/M=0, and both assertions red.
  test("familyOf(CQS)=credit AND CQS alone lights Semis' cr cell", () => {
    expect(familyOf("CQS")).toBe("credit");
    const st = buildMemberState(gf([{ id: "CQS", state: "RED" }]));
    const semis = LEG_FIELD.find((l) => l.sleeve === "Semis")!;
    const cr = computeCells(semis, st).find((c) => c.family === "cr")!;
    expect(cr.cellState).toBe("lit"); // CQS alone lit the credit cell ⇒ it was reached + folded
    expect(cr.M).toBeGreaterThanOrEqual(1);
  });
});
