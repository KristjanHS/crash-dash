/**
 * Stage 1.1 falsifier for the F1 percentile-cut measurement.
 *
 * Two claims, both able to go red:
 *  1. MONOTONICITY — the trailing-5y level p66 (Amber) is strictly below p90 (Red). §2's
 *     tripwire (ii) is exactly this assertion failing.
 *  2. REPRODUCIBILITY — recomputing the quantiles from the committed vintage CSV reproduces
 *     the committed `f1_cuts.json` to 4dp. This guards the `vintageOnly` blocks, which are
 *     live-feed-independent and therefore deterministic; the `spliced` blocks move with FRED
 *     and are checked for monotonicity only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadHyOasVintageAsFiled, readVintageText, requireVintage } from "../../src/hyoas-vintage.js";
import {
  allWindows,
  asOfLadder,
  compareOverlap,
  minusYears,
  LIVE_CLAMP_YEARS,
  OVERLAP_FIXTURE_URL,
  OVERLAP_TOLERANCE_PP,
  VINTAGE_END,
  replayConfirmed,
  scoreEpisodes,
  f1Indicator,
  f1ShippedCuts,
  type WindowBlock,
} from "./f1-percentile-cuts.js";
import { rawStateSeries } from "../../src/domain-fold.js";
import { VELOCITY_WINDOW } from "../../src/domain-types.js";
import type { Observation } from "../../src/domain-types.js";
import { readCsv } from "./derive.js";
import { quantile, SLOW_HIGH_WINDOW } from "../../src/slow.js";

const committed = JSON.parse(
  readFileSync(new URL("./f1_cuts.json", import.meta.url), "utf8"),
) as {
  spliced: { primary: WindowBlock; diagnostics: Record<string, WindowBlock>; asOfLadder: WindowBlock[] };
  vintageOnly: { asOf: string; primary: WindowBlock; diagnostics: Record<string, WindowBlock>; asOfLadder: WindowBlock[] };
};

/** The HY-OAS vintage file is not distributed with this repository; the tests reading it skip without it. */
const HAS_VINTAGE = readVintageText() !== undefined;

function expectPairs(actual: WindowBlock, expected: WindowBlock): void {
  expect(actual.start).toBe(expected.start);
  expect(actual.end).toBe(expected.end);
  for (const leg of ["level", "velocity10d", "velocity20d_reportOnly", "velocity30d"] as const) {
    expect(actual[leg].n).toBe(expected[leg].n);
    expect(actual[leg].p66).toBeCloseTo(expected[leg].p66, 4);
    expect(actual[leg].p90).toBeCloseTo(expected[leg].p90, 4);
    expect(actual[leg].p66_bps).toBeCloseTo(expected[leg].p66_bps, 4);
    expect(actual[leg].p90_bps).toBeCloseTo(expected[leg].p90_bps, 4);
  }
}

describe("f1_cuts.json", () => {
  it("trailing-5y level p66 (Amber) is strictly below p90 (Red)", () => {
    for (const block of [committed.spliced.primary, committed.vintageOnly.primary]) {
      expect(block.level.p66).toBeLessThan(block.level.p90);
    }
  });

  // D-A Stage 1.1: the re-windowed 30d danger-velocity cut. Amber (p66) strictly below Red (p90)
  // and both strictly positive — a HY-OAS widening leg is a rise; a non-positive p66 would mean
  // the leg fires on a two-thirds-of-days baseline (never a shock). Derived from the artifact,
  // never a literal. Mutate-red: flip `<`→`>` or drop the artifact's velocity30d block and this
  // goes red on the emitted number.
  it("trailing-5y 30d velocity p66 (Amber) is strictly below p90 (Red), both > 0", () => {
    for (const block of [committed.spliced.primary, committed.vintageOnly.primary]) {
      expect(block.velocity30d.p66).toBeGreaterThan(0);
      expect(block.velocity30d.p90).toBeGreaterThan(0);
      expect(block.velocity30d.p66).toBeLessThan(block.velocity30d.p90);
    }
  });

  it.skipIf(!HAS_VINTAGE)("recomputes from the vintage CSV to 4dp", () => {
    const vintage = requireVintage(loadHyOasVintageAsFiled());
    const asOf = committed.vintageOnly.asOf;
    expect(vintage[vintage.length - 1]!.date).toBe(asOf);

    const recomputed = allWindows(vintage, asOf);
    expectPairs(recomputed.trailing5y, committed.vintageOnly.primary);
    expectPairs(recomputed.diagnostics.fullExpanding, committed.vintageOnly.diagnostics.fullExpanding!);
    expectPairs(recomputed.diagnostics.trailing10y, committed.vintageOnly.diagnostics.trailing10y!);

    const ladder = asOfLadder(vintage, [asOf, "2015-12-31", "2019-12-31"]);
    expect(ladder.length).toBe(committed.vintageOnly.asOfLadder.length);
    ladder.forEach((b, i) => expectPairs(b, committed.vintageOnly.asOfLadder[i]!));
  });
});

/**
 * D-A Stage 1.1 — the MEASURED 30d velocity cuts landed in calibration.json (inert until Stage
 * 1.2 opens F1's velocity axis). This
 * pins that `section_hyoas_cuts` actually emitted the credit/hyoas_evt_vel_* rows and that Amber < Red, so a
 * regen that dropped them (harness-churn caveat) OR a non-monotone cut goes red here.
 *
 * Mutate-red demonstrated: delete the `hyoas_evt_vel_red` row from calibration.json → the
 * `find` returns undefined and the presence expectation fails (confirmed before shipping).
 */
describe("calibration.json 30d velocity rows (Stage 1.1)", () => {
  const params = (
    JSON.parse(readFileSync(new URL("./calibration.json", import.meta.url), "utf8")) as {
      params: { channel?: string; metric?: string; value: number }[];
    }
  ).params;
  const credit = (metric: string) =>
    params.find((r) => r.channel === "credit" && r.metric === metric);

  it("carries credit/hyoas_evt_vel_{amber,red} with amber strictly below red", () => {
    const amber = credit("hyoas_evt_vel_amber");
    const red = credit("hyoas_evt_vel_red");
    expect(amber, "hyoas_evt_vel_amber missing from calibration.json").toBeDefined();
    expect(red, "hyoas_evt_vel_red missing from calibration.json").toBeDefined();
    expect(amber!.value).toBeGreaterThan(0);
    expect(amber!.value).toBeLessThan(red!.value);
  });

  it("carries the operative_vel displace-fallback rows at the same values", () => {
    // The velOp fallback (W1 velEvt/velOp routing) must displace the registry convention, so it
    // rides the same measured value as the evt_vel rows — not a distinct hand-typed number.
    expect(credit("hyoas_operative_vel_amber")?.value).toBe(credit("hyoas_evt_vel_amber")?.value);
    expect(credit("hyoas_operative_vel_red")?.value).toBe(credit("hyoas_evt_vel_red")?.value);
  });
});

/**
 * Stage 1.2 — splice validation and the §2 expiry.
 *
 * **Hermeticity, stated rather than glossed.** Assertion 1 needs a second source, and the only
 * live one is a network fetch. The rest of this suite is hermetic (`src/fred.ts`'s `fetchSeries`
 * is a network shim that no unit test calls), so pulling FRED here would make the whole suite
 * flaky and offline-hostile. The second source is therefore a COMMITTED FIXTURE
 * (`data/hyoas_live_overlap.json`, the live feed's slice over the vintage overlap, written by
 * `--capture-overlap`). Real market data is not distributed with this repository: the committed copy
 * is a seeded synthetic stand-in (`npm run synth:fixtures`), and the assertions that compare it with
 * the vintage skip when the vintage CSV is absent.
 *
 * **Why this is not vacuous.** The fixture is not compared against itself: it is one source
 * (the live FRED feed) checked against a genuinely independent second source (the vintage CSV,
 * whose provenance is an Internet-Archive capture of FRED's full-table page — see
 * `data/README.md` and `scripts/fetch-hyoas-vintage.ts`). Either side can move under the test:
 *  - the VINTAGE side moves whenever the CSV is regenerated or corrupted → red immediately,
 *    continuously, on every run;
 *  - the LIVE side moves on a real FRED revision → caught at PROBE cadence by
 *    `f1-percentile-cuts.ts`, which runs `compareOverlap` against the live feed on every
 *    publish run and THROWS on a breach; the fixture is written only under an explicit
 *    `--capture-overlap` flag, precisely so it cannot auto-heal through the revision it exists
 *    to catch. Refreshing the fixture after a revision then pins the regression here.
 * Both call sites share ONE `OVERLAP_TOLERANCE_PP`, so the tolerance cannot drift apart.
 */
describe("splice validation (Stage 1.2)", () => {
  const fixture = JSON.parse(readFileSync(OVERLAP_FIXTURE_URL, "utf8")) as {
    n: number;
    observations: Observation[];
  };

  it.skipIf(!HAS_VINTAGE)("live feed and vintage CSV agree on every shared date within tolerance", () => {
    const vintage = requireVintage(loadHyOasVintageAsFiled());
    const report = compareOverlap(vintage, fixture.observations);

    // The overlap must actually exist — a zero-width comparison would pass vacuously.
    expect(report.matched).toBe(fixture.n);
    expect(report.matched).toBeGreaterThan(400);
    // No date the live feed carries inside the vintage's span is missing from the vintage.
    expect(report.liveOnly).toEqual([]);
    // The real assertion. Tolerance 0.02pp = 2bps; see OVERLAP_TOLERANCE_PP's docblock for
    // what magnitude of revision it catches (anything ≥ 3bps on any shared date).
    expect(report.breaches).toEqual([]);
    expect(report.maxAbsDiff).toBeLessThanOrEqual(OVERLAP_TOLERANCE_PP);
  });

  /**
   * §2 Conflict 1, "Maintainability, and its expiry": the trailing-5y window needs `t−5y → t`.
   * Live supplies `t−3y → t`; the vintage stops at 2025-04-10. They splice gap-free only while
   * `t − 3y ≤ 2025-04-10`, i.e. until ≈2028-04-10, after which the window SILENTLY shortens.
   * The plan requires that decay be loud, so it is asserted here rather than left as prose.
   */
  it.skipIf(!HAS_VINTAGE)("the spliced 5y window is still gap-free, and fails loudly once the splice expires", () => {
    const today = new Date().toISOString().slice(0, 10);
    const liveReach = minusYears(today, LIVE_CLAMP_YEARS);
    expect(
      liveReach <= VINTAGE_END,
      `SPLICE EXPIRED: the live feed now reaches back only to ${liveReach}, past the vintage end ` +
        `${VINTAGE_END} — the trailing-5y window has a hole and F1's published cut is computed ` +
        `over a silently shortened window. Extend the vintage CSV (scripts/fetch-hyoas-vintage.ts) ` +
        `or re-source the history.`,
    ).toBe(true);

    // Gap-free on the vintage side too: no hole in the vintage's own trailing-5y-relevant tail
    // that the live feed could not have papered over anyway.
    const vintage = requireVintage(loadHyOasVintageAsFiled());
    const tail = vintage.filter((o) => o.date >= minusYears(VINTAGE_END, 5));
    let maxGapDays = 0;
    let gapAt = "";
    for (let i = 1; i < tail.length; i++) {
      const days = (Date.parse(tail[i]!.date) - Date.parse(tail[i - 1]!.date)) / 86_400_000;
      if (days > maxGapDays) {
        maxGapDays = days;
        gapAt = tail[i]!.date;
      }
    }
    // Daily business-day series: weekends + a stacked holiday give at most a few days.
    expect(maxGapDays, `largest vintage gap ${maxGapDays}d ending ${gapAt}`).toBeLessThanOrEqual(6);
  });
});

describe("recall and lead-time report (Stage 5.1)", () => {
  it.skipIf(!HAS_VINTAGE)("respects the 2-close confirmation buffer — raw crossings would detect earlier", () => {
    const vintage = requireVintage(loadHyOasVintageAsFiled());
    const cuts = f1ShippedCuts();
    const confirmed = scoreEpisodes(replayConfirmed(f1Indicator(), vintage, cuts));
    const raw = rawStateSeries(f1Indicator(), vintage, cuts).map((state, k) => ({
      date: vintage[k + VELOCITY_WINDOW]!.date,
      state,
    }));
    const rawEpisodes = scoreEpisodes(raw);

    // Never EARLIER than raw — confirmation can only delay a detection.
    const bothDetected = confirmed.flatMap((c, i) => {
      const r = rawEpisodes[i]!.detectedAt;
      return c.detectedAt !== null && r !== null ? [[c.detectedAt, r] as const] : [];
    });
    expect(bothDetected.length).toBeGreaterThan(0);
    for (const [c, r] of bothDetected) expect(c >= r).toBe(true);
    // And it must actually bite somewhere, else the report is scoring raw crossings.
    const delayed = confirmed.filter((c, i) => c.detectedAt !== rawEpisodes[i]!.detectedAt);
    expect(delayed.length).toBeGreaterThan(0);
  });
});

/**
 * D-B Stage 2.1 — the MEASURED QQQ near-high tolerance (`equity/qqq_nearhigh_tol`).
 * Emitted by the retired harness.py `section_qqq_nearhigh` (report.py), INERT until the D-B escalator
 * (Stage 2.2) wires it. The row = p90 of the QQQ trailing-252d distFraction distribution.
 *
 * distFraction_t = close_t / max(close over the trailing SLOW_HIGH_WINDOW closes INCLUDING t),
 * exactly as src/slow.ts:291-294 computes the near-high leg metric. This TS recompute is an
 * INDEPENDENT port of the retired harness.py's np.quantile(dists, 0.90): np's default (linear/type-7) and
 * src/slow.ts `quantile` are the same interpolation. The committed row was measured on real QQQ closes;
 * the committed `qqq.csv` is a seeded synthetic fixture, so this suite pins the recompute's mechanics
 * (domain + liveness), not the row's value.
 */
function distFractions(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = SLOW_HIGH_WINDOW - 1; i < closes.length; i++) {
    let high = closes[i - SLOW_HIGH_WINDOW + 1]!;
    for (let j = i - SLOW_HIGH_WINDOW + 2; j <= i; j++) if (closes[j]! > high) high = closes[j]!;
    out.push(closes[i]! / high);
  }
  return out;
}
function nearHighTol(closes: number[]): number {
  return quantile([...distFractions(closes)].sort((a, b) => a - b), 0.9);
}

describe("D-B Stage 2.1 — equity/qqq_nearhigh_tol calibration row", () => {
  const calibration = JSON.parse(
    readFileSync(new URL("./calibration.json", import.meta.url), "utf8"),
  ) as { params: Array<{ channel: string; metric: string; value: number }> };
  const row = calibration.params.find((r) => r.channel === "equity" && r.metric === "qqq_nearhigh_tol");

  it("the committed row and the qqq.csv recompute are both distFraction quantiles in (0, 1]", () => {
    // `qqq.csv` is a seeded synthetic fixture (`synth-fixtures.ts`) — real market data is not
    // distributed with this repository — so the committed value cannot be re-derived from it here;
    // this pins the row's domain and that the recompute runs over the fixture end-to-end.
    // Mutate-red: set the committed calibration.json value above 1 (or ≤ 0) and this reds.
    const closes = readCsv("qqq").map((o) => o.value);
    expect(closes.length).toBeGreaterThan(SLOW_HIGH_WINDOW);
    for (const v of [row!.value, nearHighTol(closes)]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("nearHighTol is LIVE — perturbing an input close moves the tolerance (amber-of-one)", () => {
    // The real-data p90 sits at the 1.0 mass point, where a single perturbation cannot move it —
    // so liveness is proven on a crafted series whose p90 falls in a smooth region. 252 rising
    // closes (peak 351 at idx 251) + 10 tail days below the peak: the trailing max stays 351, so
    // the 11 distFractions are [1.0, tail/351…], p90 = sorted[9] = (largest tail)/351.
    const crafted = (topTail: number): number[] => {
      const closes: number[] = [];
      for (let i = 0; i < SLOW_HIGH_WINDOW; i++) closes.push(100 + i); // 100..351, max 351 @ idx 251
      closes.push(topTail, 338, 336, 334, 332, 330, 328, 326, 324, 322); // all < 351, topTail is the max tail
      return closes;
    };
    expect(nearHighTol(crafted(340))).toBeCloseTo(340 / 351, 12);
    expect(nearHighTol(crafted(348))).toBeCloseTo(348 / 351, 12);
    // Moving that one input moves the tolerance — the recompute genuinely reads the data.
    expect(nearHighTol(crafted(348))).not.toBeCloseTo(nearHighTol(crafted(340)), 6);
  });
});
