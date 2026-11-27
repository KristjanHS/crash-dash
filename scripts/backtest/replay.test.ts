import { describe, expect, it } from "vitest";
import {
  CG_IND,
  maxForwardDrawdown,
  risingEdgeFires,
  T10Y2Y_IND,
  BWD_DIFF_IND,
  rawSeriesConfirmedByDate,
  backwardationDiffObs,
} from "./replay.js";
import { CONFIRM_CLOSES, type Observation } from "../../src/domain-types.js";
import { VT } from "../../src/registry-composite.js";
import { ratioSpreadReadingSeries } from "../../src/scorers-composite.js";
import { confirmedSeries as foldConfirmed } from "../../src/domain-fold.js";
import { levelBandHead } from "../../src/scorers-composite.js";
import { CG_DESCRIPTOR, VT_DESCRIPTOR } from "../../src/family-descriptor-rows.js";
import { durationOfCalmRawStateSeries } from "../../src/slow.js";

// Shrunk 2026-08-15 (test-suite audit §8 L5): only the live carve-out — `rawSeriesConfirmedByDate`
// (consumed by src/dashboard.fold.test.ts), `risingEdgeFires` (consumed by event-study.ts) and
// `maxForwardDrawdown` (consumed by emit-scoring-constants.ts) — keeps coverage here; the legacy
// verdict-engine tests went with legacy-ladder.ts/kiley.ts.

// Sequential UTC ISO dates from 2000-01-01 — the fixtures are date-keyed (alignByDate inner-joins
// copper/gold, and the calm series maps index→date), so a synthetic pair just needs matching,
// strictly-increasing dates. No calendar semantics are read; only ordering + join equality.
const day = (i: number): string => new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

describe("maxForwardDrawdown", () => {
  const ndx: Observation[] = [
    { date: "2000-01-01", value: 100 },
    { date: "2000-01-02", value: 120 }, // entry
    { date: "2000-01-03", value: 90 }, // trough within window (−25% from entry)
    { date: "2000-01-04", value: 110 },
    { date: "2000-01-05", value: 130 },
  ];

  it("returns the worst decline from the entry close within the window", () => {
    // entry=120 at idx1, win=2 covers idx1..3 (min 90) → 90/120−1 = −0.25.
    expect(maxForwardDrawdown(ndx, "2000-01-02", 2)).toBeCloseTo(-0.25, 10);
  });

  it("anchors on the first close on-or-after an entry date inside a calendar gap", () => {
    const gapped: Observation[] = [
      { date: "2000-01-01", value: 100 },
      { date: "2000-01-04", value: 120 }, // entry anchor (01-02 falls in the gap)
      { date: "2000-01-05", value: 90 },
    ];
    // entry "2000-01-02" (weekend) → anchors idx1 (120); win=1 covers idx1..2 (min 90) → −0.25.
    expect(maxForwardDrawdown(gapped, "2000-01-02", 1)).toBeCloseTo(-0.25, 10);
  });

  // Pre-fixture entry must label null (never anchor on the first close); a window past the end is
  // still-open (null, not truncated); no close on-or-after the entry → null.
  it.each([
    ["the entry predates the series start", "1999-12-31"],
    ["the forward window runs past the fixture end", "2000-01-04"],
    ["no close lands on-or-after the entry date", "2001-01-01"],
  ])("returns null when %s", (_, entry) => {
    expect(maxForwardDrawdown(ndx, entry, 2)).toBeNull();
  });
});

describe("copper/gold rising-edge fire (framing (a))", () => {
  // gold flat = 1 ⇒ ratio = copper. Copper holds 100 for 40 days then drops to `dropTo`. The 20d
  // ratio return at index i reads ratio[i]/ratio[i−20]−1; raw states emit from VELOCITY_WINDOW=20
  // (raw index m = i−20). readings[m].date = dates[VELOCITY_WINDOW+m].
  //
  // CG gained an expanding-percentile LEVEL leg 2026-08-08 and DETRENDED it the same day, so the
  // fixture had to grow past `levelBandHead` AND stop being uniformly flat: a flat history has
  // deviation 0 everywhere, which puts its own amber cut ON the baseline and would make EVERY
  // drop a RED level leg — turning these velocity/fold mechanics tests into level-leg tests.
  //
  // The shape that keeps the level leg out of the way: a periodic `DIP_LEN`-day dip to `LOW`,
  // i.e. ~-15% below the 200d trend, on `PERIOD`-day centres. That fills the deviation
  // distribution's low tail well BELOW ~-6% off trend (level GREEN) and well ABOVE the deep 78
  // drop of the first test (~-22% ⇒ level RED, which is what `combine: "split"` needs for a RED).
  // The dip PHASE is anchored on the head so the scored-but-pre-drop window is always dip-free —
  // otherwise a stray dip inside it would add a rising edge and the hand-derived fire dates would
  // stop being the only ones.
  const LOW = 85;
  const PERIOD = 100;
  // The dip's SHARE of days must exceed `amberP`, or the amber cut lands above the LOW tail.
  // Derived from the shipped percentile (never restated), with a 10pp margin over it.
  const DIP_LEN = Math.round(PERIOD * (CG_DESCRIPTOR.levelBand.amberP + 0.1));
  const HEAD = levelBandHead(CG_DESCRIPTOR.levelBand);
  const DROP_AT = HEAD + 40; // the first dropped close, comfortably past the head
  const inDip = (i: number): boolean => (((i - HEAD) % PERIOD) + PERIOD) % PERIOD >= PERIOD - DIP_LEN;
  function pair(dropTo: number): { hg: Observation[]; gc: Observation[] } {
    const n = DROP_AT + 5;
    const hg = Array.from({ length: n }, (_, i) => ({
      date: day(i),
      value: i < DROP_AT ? (inDip(i) ? LOW : 100) : dropTo,
    }));
    const gc = Array.from({ length: n }, (_, i) => ({ date: day(i), value: 1 }));
    return { hg, gc };
  }

  it("fires on the +2 confirm of a 20d ratio drop crossing −0.10 (AMBER) and −0.20 (RED)", () => {
    // Copper 100→78 ⇒ 20d return −0.22, ≤ −0.20 (RED, so it also crosses −0.10). Raw RED from
    // the first dropped close; the CONFIRM_CLOSES=2 fold flips CONFIRMED one close later.
    const { hg, gc } = pair(78);
    // Bands pinned explicitly (−0.10, −0.20) — this is a fold/rising-edge MECHANICS test with
    // hand-derived dates; the shipped defaults (amber 0.0) now score a flat baseline AMBER.
    const readings = ratioSpreadReadingSeries(CG_IND, CG_DESCRIPTOR, hg, gc, -0.1, -0.2);
    const confirmed = foldConfirmed(readings.map((r) => r.rawState), CONFIRM_CLOSES);
    expect(risingEdgeFires(confirmed, readings.map((r) => r.date))).toEqual([day(DROP_AT + 1)]);
  });
});

describe("slow-calm duration-of-calm fire (framing (a))", () => {
  it("fires once after the +2 confirm of an engineered ≥63-day sub-median run", () => {
    // 5 high closes (100) then 70 calm closes (10): median over 75 values = 10, so the calm cut
    // is 10; closes of 10 (≤ cut) extend the run, 100 (> cut) resets it. Run length hits
    // SLOW_CALM_RUN_MIN=63 at index 5+62=67 (index 5 is run=1) ⇒ raw AMBER at m=67..74. The
    // CONFIRM_CLOSES=2 fold flips CONFIRMED AMBER at m=68 (no VELOCITY_WINDOW offset — the calm
    // series emits from index 0), so the single fire lands on day(68).
    const vix: Observation[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ date: day(i), value: 100 })),
      ...Array.from({ length: 70 }, (_, i) => ({ date: day(5 + i), value: 10 })),
    ];
    const confirmed = foldConfirmed(durationOfCalmRawStateSeries(vix), CONFIRM_CLOSES);
    const fires = risingEdgeFires(confirmed, vix.map((o) => o.date));
    expect(fires).toEqual([day(68)]);
  });
});

// No-mock, hand-computed: synthetic feeds run through the REAL scorer/stub + the production
// CONFIRM_CLOSES=2 fold, with every fire date derived by hand. rawStateSeries emits from
// VELOCITY_WINDOW=20, so raw/confirmed index k maps to obs[VELOCITY_WINDOW + k].date; the
// CONFIRM_CLOSES=2 fold flips CONFIRMED on the SECOND consecutive raw close of a new state.

describe("level-band default fire (framing (a))", () => {
  // MOVE: SYNTHETIC `R6-syn` amber 120 / red 150, HIGH (NOT R6's shipped cuts). T10Y2Y: stub amber 0.5 / red 0.0, LOW.
  const MOVE_SYN = { ...CG_IND, id: "R6-syn", channel: "COINCIDENT", direction: "HIGH", thresholds: { amberLevel: 120, redLevel: 150 } } as const;
  it.each([
    ["MOVE", MOVE_SYN, 100, 130, 160],
    ["T10Y2Y", T10Y2Y_IND, 1.0, 0.3, -0.2],
  ] as const)("%s confirms AMBER at +2 on the amber cross and RED at +2 on the red cross", (_, ind, calm, amber, red) => {
    // i<25 calm (GREEN); 25..27 raw AMBER → CONFIRMED at k=6 → day(26); i≥28 raw RED → CONFIRMED at k=9 → day(29).
    const obs: Observation[] = Array.from({ length: 32 }, (_, i) => ({
      date: day(i),
      value: i < 25 ? calm : i < 28 ? amber : red,
    }));
    const { state } = rawSeriesConfirmedByDate(ind, obs);
    expect(state.get(day(24))).toBe("GREEN");
    expect(state.get(day(25))).toBe("GREEN"); // first raw AMBER — confirm still pending
    expect(state.get(day(26))).toBe("AMBER"); // +2 confirm
    expect(state.get(day(28))).toBe("AMBER"); // first raw RED — confirm still pending
    expect(state.get(day(29))).toBe("RED"); // +2 confirm
  });
});

describe("backwardation RATIO + DIFF from one VIX/VIX3M pair (framing (a))", () => {
  // One synthetic pair drives BOTH emitters. Three phases (dates shared, so alignByDate keeps all):
  //   G (i<25):   vix 15 / vix3m 18 → ratio 0.833 (GREEN, below the amber cut), diff −3 (GREEN, not > −1)
  //   A (25..27): vix 17.4 / vix3m 18 → ratio 0.967 (AMBER, in-band), diff −0.6 (AMBER, > −1, ≤0)
  //   R (i≥28):   vix 19 / vix3m 18 → ratio 1.056 (RED, above the red cut), diff +1 (RED, >0)
  // The AMBER phase was 17.5 (ratio 0.972) until the 2026-07-29 VT retune moved red below it.
  // Both emit from VELOCITY_WINDOW=20 over the same aligned dates. L1 Stage 4 split their fire
  // dates: VT ∈ volatility ⇒ tier 0 (confirmed = raw, RATIO fires day(25)); the DIFF stub id is
  // in no family ⇒ slow-tier 2 (fires day(26), the old shared date).
  const n = 32;
  const vix: Observation[] = Array.from({ length: n }, (_, i) => ({ date: day(i), value: i < 25 ? 15 : i < 28 ? 17.4 : 19 }));
  const vix3m: Observation[] = Array.from({ length: n }, (_, i) => ({ date: day(i), value: 18 }));

  it("RATIO fires once on day(25) — vol tier confirms same-day — honouring AMBER-inclusive / RED-strict edges", () => {
    const readings = ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, vix, vix3m); // the SHIPPED pair, asymmetric edges
    const confirmed = readings.map((r) => r.state); // buildReadings folds the speed-tiered buffer
    const dates = readings.map((r) => r.date);
    expect(risingEdgeFires(confirmed, dates)).toEqual([day(25)]);
    const byDate = new Map(readings.map((r) => [r.date, r.state] as const));
    expect(byDate.get(day(25))).toBe("AMBER"); // first raw AMBER confirms same-day (vol tier 0)
    expect(byDate.get(day(26))).toBe("AMBER"); // 0.967 is at/above the amber cut (inclusive)
    expect(byDate.get(day(29))).toBe("RED"); // 1.056 is strictly above the red cut
  });

  it("DIFF fires once on day(26) via the strict-both stub, matching the RATIO date", () => {
    const diff = backwardationDiffObs(vix, vix3m);
    // Sanity: the diff series really is vix−vix3m on the shared dates.
    expect(diff[25]!.date).toBe(day(25));
    expect(diff[25]!.value).toBeCloseTo(-0.6); // vix 17.4 − vix3m 18 (float, so not an exact pin)
    const { dates, state } = rawSeriesConfirmedByDate(BWD_DIFF_IND, diff);
    const confirmed = dates.map((d) => state.get(d)!);
    expect(risingEdgeFires(confirmed, dates)).toEqual([day(26)]);
    expect(state.get(day(26))).toBe("AMBER"); // −0.5 > −1 (strict), not > 0
    expect(state.get(day(29))).toBe("RED"); // +1 > 0 (strict)
  });
});
