/**
 * Registry — GEO/oil family (registry split, 2026-08-15): the oil-shock siblings G1 + BRENT
 * and the auto-stage trigger id set. (OVX rides the INDICATORS FRED loop, registry-fred.ts.)
 * Import surface: this file — edit and import here.
 */

import { type Indicator, VELOCITY_WINDOW } from "./domain-types.js";
import {
  // Stage 2b.1: cuts live on G1_DESCRIPTOR.
  G1_AMBER_RET,
  G1_RED_RET,
  // Crisis rung 3: BRENT velocity bands live on BRENT_DESCRIPTOR (its level GATE + combine mode too).
  BRENT_AMBER_ROC,
  BRENT_RED_ROC,
  // NG Henry Hub natgas velocity bands live on NG_DESCRIPTOR (scoreOil twin of G1).
  NG_AMBER_RET,
  NG_RED_RET,
} from "./family-descriptor-rows.js";
import { withMultipliedThresholds } from "./registry-fred.js";

export const G1: Indicator = withMultipliedThresholds({
  id: "G1",
  // `beta` = the oil-nowcast hold-out fit (G1 target) — re-fit and re-pin by hand on basis drift;
  // `cutPct` sits just above this id's own measured carry MAE. Never restated elsewhere.
  estimator: { kind: "carry-log", leads: ["CL=F"], beta: 0.987, cutPct: 1.0 },
  label: "WTI",
  longLabel: "WTI crude oil (DCOILWTICO)",
  series: "DCOILWTICO", // keyless FRED, daily business-day observation grid
  channel: "GEO",
  geoFactor: "oil", // WTI crude — the oil factor itself (see `geoFactor`)
  thresholds: {}, // bespoke level-gate AND percent-velocity scorer (scoreOil), not classify()
  unit: "",
  // EIA spot prices publish weekly on Wednesdays over a daily observation grid ⇒ structural max ~9d.
  // Stage-1 measured maxAge 6.
  cadence: "weekly",
  lagAfterDays: 11,
  // ⚠ RELEASE ≠ OBSERVATION, exactly as for F9/F11: the weekly publish above sits over the
  // BUSINESS-DAY `DCOILWTICO` grid named on `series`, so the 20-observation return below spans
  // TRADING DAYS. Without this field every velocity caption resolving `obsCadence ?? cadence`
  // would say "20 weeks" — a ~5× overstatement of the span. See the field's docblock
  // (`domain-types.ts`).
  obsCadence: "daily",
  // scoreOil bases its return on VELOCITY_WINDOW (20); there is no G1_RET_WINDOW. Its LEVEL leg
  // is windowed by `G1_DESCRIPTOR`'s `levelWindow`, which has no `derived`-block expression —
  // it is DRAWN instead as `GATES.G1.atTrailingPeak` (rule `atOrAboveRollingMax`, R5; the RED
  // rung only under `combine: "split"`) plus the `peakProximity` AMBER line (chart-rail.ts).
  derived: {
    kind: "return",
    window: VELOCITY_WINDOW,
    amber: G1_AMBER_RET,
    red: G1_RED_RET,
    label: "20-day return",
    unit: "%",
  },
});

// BRENT crude confirm (crisis rung 3):
// G1's GEO sibling on the Brent benchmark, scored by the SAME merged `scoreOil` (2026-08-06) —
// the 20d ROC band (below) JOINED `"split"` to the graded trailing-peak leg (`BRENT_DESCRIPTOR.combine`;
// its window is `levelWindow`). The at-peak RED rung lives in gates.ts
// (`GATES.BRENT.atTrailingPeak`, rule `atOrAboveRollingMax`) and is DRAWN via the derived-kind
// layout's existing dim/dash pass.
// PRIORS — provisional, no CALIB_MAP entry.
export const BRENT: Indicator = withMultipliedThresholds({
  id: "BRENT",
  // `beta` = the oil-nowcast hold-out fit — re-fit and re-pin by hand on basis drift; `cutPct` as G1's.
  estimator: { kind: "carry-log", leads: ["BZ=F"], beta: 0.972, cutPct: 2.0 },
  label: "Brent",
  longLabel: "Brent crude oil (DCOILBRENTEU)",
  series: "DCOILBRENTEU", // keyless FRED, daily business-day observation grid
  channel: "GEO",
  geoFactor: "oil", // Brent crude — G1's benchmark twin, the same oil factor (see `geoFactor`)
  thresholds: {}, // bespoke level-gate AND ROC scorer (scoreOil), not classify()
  unit: "",
  provisional: true,
  // Same EIA weekly-Wednesday release as G1 over a daily observation grid ⇒ structural max ~9d.
  // Stage-1 measured maxAge 6.
  cadence: "weekly",
  lagAfterDays: 11,
  // ⚠ Same RELEASE ≠ OBSERVATION split as G1: `DCOILBRENTEU` returns business-day rows, so the
  // 20-observation ROC below spans TRADING DAYS and the caption word must not come off `cadence`.
  obsCadence: "daily",
  // scoreOil bases BRENT's ROC on VELOCITY_WINDOW (20), like G1's — no BRENT_ROC_WINDOW.
  derived: {
    kind: "return",
    window: VELOCITY_WINDOW,
    amber: BRENT_AMBER_ROC,
    red: BRENT_RED_ROC,
    label: "20-day return",
    unit: "%",
  },
});

// NG Henry Hub natural gas (2026-09-22) — the SAME merged
// scoreOil as G1/BRENT (20d return band + trailing-peak level gate, `NG_DESCRIPTOR`). CONTEXT, not
// GEO: off the alert band by scope (no geoFactor, not a STAGE1 trigger). Same EIA weekly publish over
// the daily DHHNGSP grid as G1, so `obsCadence: "daily"` and the 20-obs return spans TRADING days.
export const NG: Indicator = withMultipliedThresholds({
  id: "NG",
  label: "NatGas",
  longLabel: "Henry Hub natural gas (DHHNGSP)",
  series: "DHHNGSP", // keyless FRED, daily business-day observation grid
  channel: "CONTEXT",
  thresholds: {}, // bespoke scoreOil (20d return + trailing-peak level), not classify()
  unit: "",
  cadence: "weekly",
  lagAfterDays: 11,
  obsCadence: "daily",
  derived: {
    kind: "return",
    window: VELOCITY_WINDOW,
    amber: NG_AMBER_RET,
    red: NG_RED_RET,
    label: "20-day return",
    unit: "%",
  },
});

/** The playbook §Stage ladder's four auto-stage trigger ids — the ONE set both the calm-streak
 *  (run-core.ts) and the geo escalator's litSet (alert-band.ts) read. Every member must carry a
 *  `geoFactor` (pinned in alert-band.compose.test.ts) or the litSet fold counts it per-id. */
export const STAGE1_TRIGGER_IDS: ReadonlySet<string> = new Set(["G1", "OVX", "BRENT", "T5YIFR"]);
