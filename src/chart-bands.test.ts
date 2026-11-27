// Case 3 — chart-band completeness guard. The detail chart draws amber/red lines
// ONLY from `meta.chart.bands`; before this guard, R7/EURC/GB/DISP (and the SLOW/
// PENSION/BOTTOM identity ids) emitted a silent empty `bands: []`, so feature (3)
// threshold lines were absent with no way to tell "unbanded by design" from a bug.
// The contract (src/api/types.ts ChartBands) now forces EITHER real bands OR the
// explicit "context-only" sentinel; this test fails if any ALL_INDICATORS id emits
// neither — so a future indicator added without answering "what are your bands?"
// trips `npm run check` instead of shipping a lineless chart.
import { describe, it, expect } from "vitest";
import { ALL_INDICATORS } from "./registry.js";
import { DB_SMH, DB_XLK } from "./registry-price.js";
import { BUND } from "./registry-composite.js";
import {
  BUND_AMBER,
  BUND_RED,
  DOWNSIDE_AMBER,
  DOWNSIDE_RED,
  DOWNSIDE_XLK_AMBER,
  DOWNSIDE_XLK_RED,
} from "./family-descriptor-rows.js";
import { bundLevelState, bundVelocityState } from "./scorers-composite.js";
import { resolveBands } from "./threshold-config.js";
import { buildIndicatorChart } from "../api/indicators.js";

describe("chart band completeness (Case 3)", () => {
  it("every ALL_INDICATORS id declares real bands or explicit context-only - never a silent empty", () => {
    const undeclared = ALL_INDICATORS.filter((i) => {
      const b = buildIndicatorChart(i).bands;
      const hasRealBands = Array.isArray(b) && b.length > 0;
      const isContextOnly = b === "context-only";
      return !hasRealBands && !isContextOnly;
    }).map((i) => i.id);
    expect(undeclared).toEqual([]);
  });

  // §7b — the allowlist that closes the sentinel's escape hatch. The completeness guard above
  // PASSED on the very bug it was written to catch: BUND fell through the band-less identity path
  // INTO "context-only", and the guard read the defect as a design choice. So the sentinel is not
  // self-justifying — an id may only claim it by being named here, with the reason it has no
  // thresholds to draw. A new bespoke composite with `thresholds: {}` now fails `npm run check`
  // instead of shipping a lineless chart under the sentinel.
  //
  // Pinned in BOTH directions on purpose: an unlisted id taking the sentinel fails (the BUND
  // shape), AND a listed id that gained real bands fails (so the list cannot rot into a
  // permanent excuse). Adding an entry is a deliberate act — state why it is unbandable.
  const CONTEXT_ONLY_ALLOWLIST: Record<string, string> = {
    DEXUSEU: "PENSION leg - raw USD-per-EUR level, thresholds: {}, never scored",
    F7: "Shiller CAPE - value-only context card, thresholds: {}, never scored (feeds the display-only CAPE multiplier, not a firing band or any dial term)",
    SP500IT: "PENSION display leg - raw price series (S&P 500 IT via XLK), thresholds: {}, never scored",
    LEGP_EUFIN: "PENSION held-sleeve leg - chained EUR level (EXSH.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_HEALTH: "PENSION sleeve leg - chained EUR level (QDVG.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_COMMOD: "off-ladder commodities detail leg - chained EUR level (LYTR.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_RAFI: "off-ladder AW-Fundamental detail leg - chained EUR level (PSWD.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_SEMIS: "PENSION ladder leg - chained EUR level (SMH, USD÷FX, scoreboard-owned), thresholds: {}, never scored",
    LEGP_SPIT: "PENSION ladder leg - chained EUR level (QDVE.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_EM: "PENSION ladder leg - chained EUR level (IS3N.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_SPX: "PENSION ladder leg - chained EUR level (SXR8.DE, scoreboard-owned), thresholds: {}, never scored",
    LEGP_EXUS: "PENSION ladder leg - chained EUR level (VEA, USD÷FX, scoreboard-owned), thresholds: {}, never scored",
    LEGP_STAPLES: "PENSION ladder leg - chained EUR level (ZPDS.DE, scoreboard-owned), thresholds: {}, never scored",
    SPY: "PENSION drawdown leg - raw price series, thresholds: {}, never scored",
    VWO: "PENSION comparator leg - raw price series, thresholds: {}, never scored (unweighted, display-only)",
    VGK: "PENSION comparator leg - raw price series, thresholds: {}, never scored (unweighted, display-only)",
    XDEV: "PENSION comparator leg - raw EUR close (Xtrackers MSCI World Value), thresholds: {}, never scored (unweighted; distinct from the ladder's chained LEGP_VALUE level on the same ticker)",
    HYNIX: "PENSION comparator-shape value-ladder input - raw 000660.KS close, thresholds: {}, never scored (probe:value-tranches prints it, display only)",
    AMAT: "PENSION comparator-shape value-ladder input - raw AMAT adj close, thresholds: {}, never scored (probe:value-tranches prints it, display only)",
    KRW: "PENSION comparator-shape value-ladder input - raw KRW=X close, thresholds: {}, never scored (probe:value-tranches prints it, display only)",
    COPPER: "PENSION comparator-shape value-ladder input - raw HG=F close, thresholds: {}, never scored (probe:value-tranches prints it, display only)",
    BBB: "value-only CONTEXT card - raw FRED BAMLC0A4CBBB level, thresholds: {}, never scored (semis drawdown-watch confirmer reads it)",
    VIX: "raw level - the scored legs are the VIX-derived composites, not VIX itself",
    VIX3M: "raw level - feeds the term-structure composite, never scored on its own",
    // ⚠ The other three SLOW ids LEFT this list 2026-08-30 (`price-accel`, `complacency-vix`,
    // `complacency-high`): each stores a `metric` — a percentile rank or a price fraction — that
    // its slow.ts cut is stated on, so the lines are drawable and are now drawn (chart-rail.ts,
    // `slowLegChart`). The claim below is therefore NOT "a slow leg has no cut" — it is narrower.
    "complacency-duration":
      "duration-of-calm - the metric IS the run length divided by SLOW_CALM_RUN_MIN, so its cut is the constant 1.0 the axis is normalised by; drawable, deliberately undrawn (the leg folds CONFIRM_CLOSES before it fires, so the bare line under-promises)",
  };

  it("only allowlisted ids may claim the context-only sentinel (both directions)", () => {
    const actual = ALL_INDICATORS.filter((i) => buildIndicatorChart(i).bands === "context-only")
      .map((i) => i.id)
      .sort();
    expect(actual).toEqual(Object.keys(CONTEXT_ONLY_ALLOWLIST).sort());
  });

  // BUND (`scoreBundCurve`, BUND S2): every drawn line must sit EXACTLY on an edge its scorer leg
  // flips at — probed through the leg functions themselves, never a restated cut. The velocity
  // leg is two-sided, so each cut owes a line at BOTH signs; the level leg caps at AMBER, so a
  // RED level line would name a state it can never produce and must be absent.
  it("BUND draws the level amber edge + the two-sided velocity pair, each on a scorer edge", () => {
    const bands = buildIndicatorChart(BUND).bands;
    if (!Array.isArray(bands)) throw new Error("BUND chart must be banded");
    const prim = bands.filter((b) => b.axis === "primary");
    const sec = bands.filter((b) => b.axis === "secondary");
    const { amber } = resolveBands("BUND", BUND_AMBER, BUND_RED, false);
    expect(prim.map((b) => [b.level, b.value])).toEqual([["amber", amber]]);
    // Strict `<`: AMBER just below the drawn line, GREEN on it.
    expect(bundLevelState(amber - 1e-9, amber)).toBe("AMBER");
    expect(bundLevelState(amber, amber)).toBe("GREEN");
    // Velocity: one line per (level, sign); each value is the inclusive edge of its level —
    // ON the line scores that level, a hair toward zero scores the rung below it.
    const below = { amber: "GREEN", red: "AMBER" } as const;
    expect(sec.map((b) => `${b.level}${Math.sign(b.value!)}`).sort()).toEqual(["amber-1", "amber1", "red-1", "red1"]);
    for (const b of sec) {
      const v = b.value!;
      expect(bundVelocityState(v), `${b.label} on-line`).toBe(b.level.toUpperCase());
      expect(bundVelocityState(v - Math.sign(v) * 1e-9), `${b.label} inside`).toBe(below[b.level]);
    }
  });

  // The completeness guard above is satisfied by the "context-only" sentinel, so it is BLIND to a
  // banded composite that silently falls through to the band-less identity path (how BUND shipped
  // lineless, 2026-07-18) — or draws the wrong line. The drawdown detectors' failure mode is PER-ID:
  // the DB_* band lines were hardcoded to the DB_SMH module constants for BOTH detectors, so DB_XLK's
  // 2026-07-23 retune to its own −5/−8 moved the state ribbon while the drawn line stayed at the
  // then-shared −8/−15. The out-of-band assertion here used to be "XLK strictly tighter than SMH"; that
  // DIVERGENCE is gone since DB_SMH's 2026-07-23 retune onto the same −5/−8, so this reads the per-id
  // CONSTANTS directly (never `downsideCuts`, which would move with a neutered seam) — the drawn line
  // must trace its OWN detector's constants, which re-arms as a divergence pin the moment either pair
  // moves again. (A neutered `downsideCuts` is caught at the SCORER seam, where the table is
  // injectable — dashboard.price-scorers.test.ts "routes per id".) Every id's drawn values are also
  // pinned byte-exact by golden-pins.test.ts's chart specs.
  it("each detector draws its own module constants, and red stays the deeper leg", () => {
    const drawn = (ind: typeof DB_SMH) => {
      const bands = buildIndicatorChart(ind).bands as { level: string; value?: number }[];
      return {
        amber: bands.find((b) => b.level === "amber")!.value!,
        red: bands.find((b) => b.level === "red")!.value!,
      };
    };
    const smh = drawn(DB_SMH);
    const xlk = drawn(DB_XLK);
    // × 100: the chart axis is a percent drawdown. Multiplier config is all-1.0, so the drawn
    // value is the constant itself — a non-1.0 DB_* override would be a deliberate re-pin here.
    expect(smh).toEqual({ amber: DOWNSIDE_AMBER * 100, red: DOWNSIDE_RED * 100 });
    expect(xlk).toEqual({ amber: DOWNSIDE_XLK_AMBER * 100, red: DOWNSIDE_XLK_RED * 100 });
    // …and each detector's own red is still the deeper of its pair (LOW-is-bad).
    expect(smh.red).toBeLessThan(smh.amber);
    expect(xlk.red).toBeLessThan(xlk.amber);
  });
});
