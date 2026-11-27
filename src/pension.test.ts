import { describe, expect, test } from "vitest";
import {
  type DatedWeights,
  type PensionBand,
  type PensionLeg,
  type PensionWeights,
  bandOf,
  drawdownSeries,
  effectiveWeights,
  pensionConfirmBand,
  portfolioSeries,
  priceLegReadingSeries,
} from "./pension.js";

/** A one-segment dated history in force over the whole fixture window. `from` is `""`
 *  rather than an ISO date because the fixture calendar is `"0"`,`"1"`,`"2"`,… — the
 *  resolver only string-compares, and `""` sorts at/below every fixture date. */
const always = (weights: PensionWeights): DatedWeights => [{ from: "", weights }];

const HALF_W: PensionWeights = { SPY: 0.5, VEA: 0.5 };
const HALF = always(HALF_W);
const ALL_IT = always({ SP500IT: 1 });

/** Build aligned EUR legs from parallel SPY / VEA arrays (dates = 0,1,2,…). `it` adds the
 *  SP500IT sleeve where the case needs the held-book blend. */
const legs = (us: number[], nx: number[], it?: number[]): PensionLeg[] =>
  us.map((u, i) => ({
    date: String(i),
    eur: { SPY: u, VEA: nx[i]!, ...(it ? { SP500IT: it[i]! } : {}) },
  }));


describe("bandOf - calibration-locked cut-points (DIP −0.15 / CORRECTION −0.20 / BEAR −0.35)", () => {
  test("each band is inclusive at its own cut and exclusive at the next one down", () => {
    const table = [
      [0, "CALM"],
      [-0.149, "CALM"],
      [-0.15, "DIP"],
      [-0.199, "DIP"],
      [-0.2, "CORRECTION"],
      [-0.349, "CORRECTION"],
      [-0.35, "BEAR"],
      [-0.6, "BEAR"],
    ] as const;
    expect(table.map(([dd]) => bandOf(dd))).toEqual(table.map(([, band]) => band));
  });
});

describe("drawdownSeries - trailing-peak", () => {
  test("monotone-rising series never draws down", () => {
    expect(drawdownSeries([100, 110, 120, 130]).every((d) => d === 0)).toBe(true);
  });
  test("peak then decline gives dd off the running max", () => {
    const dd = drawdownSeries([100, 120, 90]);
    expect(dd[0]).toBe(0);
    expect(dd[1]).toBe(0);
    expect(dd[2]).toBeCloseTo(90 / 120 - 1, 10); // −0.25
  });
  test("a new high resets the drawdown to 0", () => {
    const dd = drawdownSeries([100, 80, 130]);
    expect(dd[1]).toBeCloseTo(-0.2, 10);
    expect(dd[2]).toBe(0); // 130 is a fresh peak
  });
});

describe("effectiveWeights - the segment in force on a date (last from ≤ date)", () => {
  const BOOK: DatedWeights = [
    { from: "2020-01-01", weights: { SPY: 1 } },
    { from: "2026-07-21", weights: { SP500IT: 1 } },
  ];
  test("returns the newest segment whose from is at or before the date", () => {
    expect(effectiveWeights("2026-07-20", BOOK)).toEqual({ SPY: 1 });
    expect(effectiveWeights("2026-07-21", BOOK)).toEqual({ SP500IT: 1 }); // inclusive at from
    expect(effectiveWeights("2026-08-01", BOOK)).toEqual({ SP500IT: 1 });
  });
  test("throws below the earliest segment rather than defaulting", () => {
    expect(() => effectiveWeights("2019-12-31", BOOK)).toThrow(/no holdings segment covers/);
  });
});

describe("portfolioSeries - rebased blend over the held sleeves", () => {
  test("P_0 equals the weight sum; legs scale relative to day 0", () => {
    const p = portfolioSeries(legs([100, 120], [100, 100]), HALF);
    expect(p[0]).toBeCloseTo(1.0, 10); // 0.5·1 + 0.5·1
    expect(p[1]).toBeCloseTo(1.1, 10); // 0.5·1.2 + 0.5·1.0
  });

  // The Stage-2 switch: the book is 100% SP500IT, so P must track XLK alone — the SPY/VEA
  // sleeves are still JOINED (they carry the attribution columns) but must contribute 0.
  test("a 100%-SP500IT book tracks that sleeve alone, ignoring the joined SPY/VEA legs", () => {
    const p = portfolioSeries(legs([100, 200], [100, 200], [100, 130]), ALL_IT);
    expect(p[0]).toBeCloseTo(1.0, 10);
    expect(p[1]).toBeCloseTo(1.3, 10); // XLK's +30%, NOT the legs' +100%
  });

  // A dropped term would silently rescale P (a 100%-held sleeve missing from the join
  // yields an all-zero series that reads as a permanent flat CALM), so it must throw.
  test("a weighted sleeve absent from the aligned legs throws rather than contributing 0", () => {
    expect(() => portfolioSeries(legs([100, 120], [100, 100]), ALL_IT)).toThrow(
      /weighted sleeve SP500IT is absent/,
    );
  });

  test("a zero-weight sleeve may be absent - a segment names only what it holds", () => {
    const p = portfolioSeries(legs([100, 120], [100, 100]), always({ SPY: 1, SP500IT: 0 }));
    expect(p[1]).toBeCloseTo(1.2, 10);
  });
});

describe("portfolioSeries - chain-linked across a holdings switch (Stage 3)", () => {
  // SPY-only until day "2", then 100% SP500IT. SPY rises 10% on day 1 (under the old
  // book); XLK doubles on day 2 and adds 10% on day 3 (under the new one).
  const SWITCH: DatedWeights = [
    { from: "", weights: { SPY: 1 } },
    { from: "2", weights: { SP500IT: 1 } },
  ];
  const spine = legs([100, 110, 110, 110], [100, 100, 100, 100], [100, 100, 200, 220]);

  test("the level carries across the switch - no restart, no step", () => {
    const p = portfolioSeries(spine, SWITCH);
    expect(p[1]).toBeCloseTo(1.1, 10); // old book earned +10%…
    // …and the new book compounds ON TOP of it rather than rebasing to 1.0.
    expect(p[2]).toBeCloseTo(2.2, 10); // 1.1 · (200/100)
    expect(p[3]! / p[2]!).toBeCloseTo(1.1, 10); // XLK's day-3 +10%, undiluted by SPY
  });

  // The reason chain-linking (not per-segment scoring) is the §14-correct construction:
  // a drawdown opened under the old book must still be visible after the switch.
  test("a drawdown opened before the switch survives it (the trailing peak spans both)", () => {
    const falling = legs([100, 150, 120, 120], [100, 100, 100, 100], [100, 100, 100, 100]);
    const late: DatedWeights = [
      { from: "", weights: { SPY: 1 } },
      { from: "3", weights: { SP500IT: 1 } },
    ];
    const dd = drawdownSeries(portfolioSeries(falling, late));
    // Peak 1.5 (day 1, old book); the new book is flat, so the −20% persists.
    expect(dd.at(-1)).toBeCloseTo(-0.2, 10);
  });

  // The dark-base guard. At the chain-link base the INCOMING sleeve is still unweighted, so
  // the weighted-only join only left-joins it — and the venues differ (`EU-Fin` on Xetra vs
  // `SP500IT` on NYSE), so the base day can legitimately carry no incoming close.
  test("a switch whose base day is DARK for the incoming sleeve still scores (walks back)", () => {
    // Three segments: SPY → SP500IT (day 2) → EU-Fin (day 4). Day 3 — the natural base for
    // the day-4 switch — has NO EU-Fin value (Xetra holiday), so the base walks back to day 2.
    const THREE: DatedWeights = [
      { from: "", weights: { SPY: 1 } },
      { from: "2", weights: { SP500IT: 1 } },
      { from: "4", weights: { "EU-Fin": 1 } },
    ];
    const dark: PensionLeg[] = [
      { date: "0", eur: { SPY: 100, SP500IT: 100, "EU-Fin": 100 } },
      { date: "1", eur: { SPY: 110, SP500IT: 100, "EU-Fin": 100 } },
      { date: "2", eur: { SPY: 110, SP500IT: 100, "EU-Fin": 50 } },
      { date: "3", eur: { SPY: 110, SP500IT: 200 } }, // Xetra dark — no EU-Fin close
      { date: "4", eur: { SPY: 110, SP500IT: 200, "EU-Fin": 55 } },
    ];
    const p = portfolioSeries(dark, THREE);
    expect(p[1]).toBeCloseTo(1.1, 10); // old book's +10%
    expect(p[3]).toBeCloseTo(2.2, 10); // SP500IT doubled off its day-1 base, on 1.1
    // Day 4 rebases onto day 2 (the newest day pricing EU-Fin): level 1.1 · (55/50) = 1.21.
    expect(p[4]).toBeCloseTo(1.21, 10);
  });

  // The no-prior-day-prices-it fallback: base = the switch day itself, level carried from the
  // day before, so only that day's own return is forfeited — never the whole track.
  test("an incoming sleeve priced ONLY from the switch day forfeits one day, not the track", () => {
    const LATE: DatedWeights = [
      { from: "", weights: { SPY: 1 } },
      { from: "2", weights: { "EU-Fin": 1 } },
    ];
    const late: PensionLeg[] = [
      { date: "0", eur: { SPY: 100 } },
      { date: "1", eur: { SPY: 110 } },
      { date: "2", eur: { SPY: 110, "EU-Fin": 80 } }, // EU-Fin's history starts here
      { date: "3", eur: { SPY: 110, "EU-Fin": 40 } },
    ];
    const p = portfolioSeries(late, LATE);
    expect(p[2]).toBeCloseTo(1.1, 10); // level continuous — no reset to 1.0
    expect(p[3]).toBeCloseTo(0.55, 10); // EU-Fin halved off its day-2 base
    expect(drawdownSeries(p).at(-1)).toBeCloseTo(-0.5, 10);
  });
});

describe("portfolioSeries - chain-linked across BOTH 2026 switch dates (Stage 9.4)", () => {
  // Three segments, mirroring the live book's shape: SPY → SP500IT → EU-Fin.
  const BOOK3: DatedWeights = [
    { from: "", weights: { SPY: 1 } },
    { from: "2", weights: { SP500IT: 1 } },
    { from: "4", weights: { "EU-Fin": 1 } },
  ];
  const legs3 = (spy: number[], it: number[], eufin: number[]): PensionLeg[] =>
    spy.map((u, i) => ({ date: String(i), eur: { SPY: u, SP500IT: it[i]!, "EU-Fin": eufin[i]! } }));

  test("the level carries across BOTH switches - no restart, no step", () => {
    const p = portfolioSeries(
      legs3([100, 110, 110, 110, 110, 110], [100, 100, 200, 220, 220, 220], [100, 100, 100, 100, 100, 110]),
      BOOK3,
    );
    expect(p[1]).toBeCloseTo(1.1, 10); // SPY's +10% under segment 1
    expect(p[2]).toBeCloseTo(2.2, 10); // segment 2 compounds on top (1.1 × 200/100)
    expect(p[3]).toBeCloseTo(2.42, 10);
    expect(p[4]).toBeCloseTo(2.42, 10); // segment 3 opens flat — a per-segment rebase gives 1.0
    expect(p[5]).toBeCloseTo(2.662, 10); // EU-Fin's +10%, compounded on the carried level
  });

  // 9.4: `dd(P)` is the PORTFOLIO's drawdown, never the held sleeve's own. The peak was
  // reached two books ago and must still be the yardstick after the 2026-07-31 switch.
  test("the trailing peak survives both switches - dd(P) is not the held sleeve's own dd", () => {
    const eufin = [100, 100, 100, 100, 100, 100];
    const spine = legs3([100, 150, 150, 150, 150, 150], [100, 100, 100, 80, 80, 80], eufin);
    const dd = drawdownSeries(portfolioSeries(spine, BOOK3));
    expect(dd.at(-1)).toBeCloseTo(-0.2, 10); // 1.2 / 1.5 − 1, a peak two books old
    expect(drawdownSeries(eufin).at(-1)).toBe(0); // the held sleeve's OWN dd — a different number
  });
});

describe("pensionConfirmBand - the 2-close fold over raw bands", () => {
  test("a 1-day dip does NOT confirm (head-fake) - the prior band holds", () => {
    // Two closes required: one lone DIP after CALM stays CALM.
    expect(pensionConfirmBand(["CALM", "CALM", "DIP"], 2)).toBe("CALM");
  });
  test("two consecutive closes at the new band confirm it", () => {
    expect(pensionConfirmBand(["CALM", "DIP", "DIP"], 2)).toBe("DIP");
  });
  test("throws on an empty series (bootstrap needs ≥1 day)", () => {
    expect(() => pensionConfirmBand([] as PensionBand[], 2)).toThrow();
  });
});

describe("priceLegReadingSeries - raw StoredReading projection", () => {
  test("carries value, GREEN placeholder state, and a real delta20 once 20 obs exist", () => {
    const series = Array.from({ length: 22 }, (_, i) => ({ date: String(i), value: 100 + i }));
    const rows = priceLegReadingSeries("SPY", series);
    expect(rows).toHaveLength(22);
    expect(rows[0]).toMatchObject({ indicatorId: "SPY", value: 100, delta20: 0, state: "GREEN", decision: null });
    // The 21st obs (index 20) is the first with a 20-back predecessor: 120 − 100 = 20.
    expect(rows[20]!.delta20).toBe(20);
    expect(rows[21]!.delta20).toBe(20);
  });
});
