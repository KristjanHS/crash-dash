import { readFileSync } from "node:fs";
import { expect, test, describe } from "vitest";
import {
  PRICE_SCORERS,
  DEEP_PRICE_INPUTS,
  BREADTH_LOOKBACK_DAYS,
  RS_LEG_IDS,
  NVDA,
  F4,
  F5,
  F6,
  F8,
  F13,
  DOWNSIDE_DETECTOR_IDS,
} from "./registry-price.js";
import {
  BREADTH_MIN_CLOSES,
  scoreSemis,
  semisReadingSeries,
  scoreBreadth,
  breadthReadingSeries,
  breadthDistSeries,
  BREADTH_AMBER_P,
  BREADTH_RED_P,
  scoreMemGate,
  memGateReadingSeries,
  scoreDownsideBreak,
  downsideBreakReadingSeries,
  downsideCuts,
  scoreRelStrengthBreak,
  relStrengthBreakReadingSeries,
  rsCuts,
  globalTrendReadingSeries,
  scoreNvdaGate,
  nvdaGateReadingSeries,
  scoreCreditAppetite,
  creditAppetiteReadingSeries,
} from "./scorers-price.js";
import { indicatorReadingSeries, oilReadingSeries } from "./scorers-core.js";
import {
  RS_CUT_OVERRIDES,
  RS_MA_WINDOW,
  RS_RED,
  RS_XLK_AMBER,
  RS_XLK_RED,
  DOWNSIDE_CUT_OVERRIDES,
  DOWNSIDE_AMBER,
  DOWNSIDE_RED,
  DOWNSIDE_XLK_AMBER,
  DOWNSIDE_XLK_RED,
  HIGH_WINDOW_SHORT,
  HYGLQD_MA,
  HYGLQD_AMBER,
  HYGLQD_RED,
  HYGLQD_RET_WINDOW,
  HYGLQD_D20_AMBER,
  HYGLQD_D20_RED,
  MA_WINDOW,
  HIGH_WINDOW,
  RELSTR_MA_WINDOW,
  RELSTR_AMBER,
  RELSTR_RED,
  RET_WINDOW,
  MU_AMBER,
  MU_RED,
  MU_MA_MULT,
} from "./family-descriptor-rows.js";
import { levelBandHead, ratioSpreadReadingSeries } from "./scorers-composite.js";
import { CG, GT } from "./registry-composite.js";
import {
  CONFIRM_CLOSES,
  type Observation,
  type Reading,
} from "./domain-types.js";
import { G1 } from "./registry-geo.js";
import { CG_DESCRIPTOR, EURGBP_DESCRIPTOR, EXSH_GATE_DESCRIPTOR, RS_SMH_DESCRIPTOR, type RsCuts } from "./family-descriptor-rows.js";
import { EURGBP } from "./registry-composite.js";
import { EXSH_GATE } from "./registry-price.js";
import { scoreReturnOrMaSpread, returnOrMaSpreadReadingSeries, exshGateReadingSeries, type ExshGateCuts } from "./scorers-price.js";
import { flatN, indicator, PN, priceSeries, f4, f5, spconc, BN, breadthClimb, utcDay } from "./dashboard.test-helpers.js";
import { breadthCutSeries, breadthClassify, breadthConfig, assertRatioVsMaWindows } from "./scorers-price.js";

// Geometric price series 100·rate^i and a too-short flat-100 series (padded dates, cold-start cases).
const px = (rate: number): Observation[] => priceSeries((i) => 100 * Math.pow(rate, i));
const shortPad = (n: number): Observation[] => priceSeries(() => 100).slice(0, n);
// Plateau with a 2-close step tail landing EXACTLY on spread s vs the trailing MA of window W.
const stepFor = (spread: number, W: number) => ((1 + spread) * (W - 2)) / (W - 2 - 2 * spread) - 1;
const numForW = (spread: number, W: number): Observation[] => {
  const d = stepFor(spread, W);
  return priceSeries((i) => (i >= PN - 2 ? 100 * (1 + d) : 100));
};

// Rung-3 hoist: the default BN=520 breadth-climb series, previously rebuilt in ~6 tests. Its qqq/qqqe
// arrays are read-only to every scorer consumer (never .push/sort/reassigned — verified 2026-09-20),
// so build it once and share.
const BREADTH_CLIMB_DEFAULT = breadthClimb(0.002);

describe("scoreSemis (F4 semis momentum - CONTEXT, surfaced not scored)", () => {
  test("rising semis with rising NVDA → GREEN (above MA200, positive 6mo return)", () => {
    const up = px(1.001);
    expect(scoreSemis(f4, up, up).state).toBe("GREEN");
  });

  test("SMH below MA200 and ~17% down/6mo, NVDA flat → AMBER (not Red: ret > −25%)", () => {
    const smh = px(0.9985); // 6mo ret ≈ −17%
    const nvda = priceSeries(() => 100); // flat → not below its MA200
    expect(scoreSemis(f4, smh, nvda).state).toBe("AMBER");
  });

  test("SMH ≥25% down/6mo AND NVDA below its MA200 → RED", () => {
    const smh = px(0.9975); // 6mo ret ≈ −27%
    const nvda = px(0.998); // falling → below MA200
    expect(scoreSemis(f4, smh, nvda).state).toBe("RED");
  });

  test("SMH ≥25% down/6mo but NVDA rising → AMBER, not RED (NVDA gate holds)", () => {
    const smh = px(0.9975);
    const nvda = px(1.001); // rising → above MA200
    expect(scoreSemis(f4, smh, nvda).state).toBe("AMBER");
  });

  test("level = latest SMH close, delta20 = its honest 20d change", () => {
    const smh = priceSeries((i) => 100 + i); // +1/day
    const r = scoreSemis(f4, smh, smh);
    expect(r.level).toBe(100 + (PN - 1));
    expect(r.delta20).toBe(20);
  });

});

describe("scoreBreadth (F5 breadth - CONTEXT, dynamic rolling-percentile band)", () => {
  // The per-day cuts the scorer applies at the LAST day: `breadthCutSeries` over the strict-prefix
  // dist (which EXCLUDES the last day), so they are the same whatever `tailReturn` we probe with.
  const lastCuts = () => {
    const { qqq } = BREADTH_CLIMB_DEFAULT; // tail placeholder; last-index cut ignores it
    const dist = breadthDistSeries(qqq.map((o) => o.value));
    return { aCut: breadthCutSeries(dist, BREADTH_AMBER_P).at(-1)!, rCut: breadthCutSeries(dist, BREADTH_RED_P).at(-1)! };
  };

  test("fixture premise: the band exists (0 < p80 < p95) so the three tails discriminate", () => {
    // Guards every band test below — if the fixture ever strands the tails on one side, red HERE.
    const { aCut, rCut } = lastCuts();
    expect(aCut).toBeGreaterThan(0);
    expect(rCut).toBeGreaterThan(aCut);
  });

  test("dist deep in the p95 tail → RED", () => {
    const { rCut } = lastCuts();
    const { qqq, qqqe } = breadthClimb(rCut * 1.5); // last-day dist well above the p95 cut
    expect(scoreBreadth(f5, qqq, qqqe).state).toBe("RED");
  });

  // Band-mapping tests assert `rawState`: the sawtooth climb's own historical raw REDs are HELD
  // by the directional fold's down buffer (2026-08-26), so the folded `state` would drag the fold
  // into a per-day-cut subject (the fold itself is pinned in `dashboard.fold.test.ts`).
  test("dist in p80..p95 → AMBER", () => {
    const { aCut, rCut } = lastCuts();
    const { qqq, qqqe } = breadthClimb((aCut + rCut) / 2); // strictly between the two cuts
    expect(scoreBreadth(f5, qqq, qqqe).rawState).toBe("AMBER");
  });

  test("dist below p80 → GREEN", () => {
    const { aCut } = lastCuts();
    const { qqq, qqqe } = breadthClimb(aCut * 0.5); // last-day dist below the p80 cut
    expect(scoreBreadth(f5, qqq, qqqe).rawState).toBe("GREEN");
  });

  test("OVERTURN: at-a-new-high AND rising but dist below p80 → GREEN now (was AMBER under atHigh∧rising)", () => {
    // Discriminates the new rule from the old: a barely-new-high day is atHigh AND rising, so the
    // dropped `atHigh∧rising` rule fired AMBER — but its dist sits below p80, so the band says GREEN.
    const { aCut } = lastCuts();
    const { qqq, qqqe } = breadthClimb(aCut * 0.5);
    const vals = qqq.map((o) => o.value);
    const priorMax = Math.max(...vals.slice(vals.length - HIGH_WINDOW, vals.length - 1));
    expect(vals.at(-1)!).toBeGreaterThanOrEqual(priorMax); // atHigh (old rule's first half)
    expect(vals.at(-1)!).toBeGreaterThan(vals.at(-21)!); // rising vs 20d ago (old rule's second half)
    expect(scoreBreadth(f5, qqq, qqqe).rawState).toBe("GREEN");
  });

});

// F8 is CONTEXT (danger-engine-only, notify-neutral); the bespoke scorer is channel-agnostic,
// so the fixture uses a plain id-only Indicator stub, UNconfigured (absent from
// threshold-config.json) on purpose — it tests the scorer LOGIC against the raw prior
// constants, decoupled from the live tuning config (exercised separately via resolveBands
// below). F6 uses its REAL registry indicator: its cuts route per id through rsCuts.
const f8 = indicator({ id: "memgate-logic", channel: "CONTEXT", thresholds: {} });

describe("scoreRelStrengthBreak (F6 SMH/SPY ratio vs its own MA200 - CONTEXT, RED-only)", () => {
  const cuts = rsCuts(F6.id); // = F6_DESCRIPTOR.scorer.constants via RS_CUT_OVERRIDES (never restated)
  const flatSpy = priceSeries(() => 100);

  const numFor = (spread: number) => numForW(spread, cuts.maWindow);

  test("ratio above its MA200 (spread past the red cut highward) → GREEN", () => {
    expect(scoreRelStrengthBreak(F6, numFor(cuts.red! + 0.05), flatSpy).state).toBe("GREEN");
  });

  test("ratio below its MA200 (spread at/below the red cut) → RED", () => {
    expect(scoreRelStrengthBreak(F6, numFor(cuts.red! - 0.02), flatSpy).state).toBe("RED");
  });

  test("F6 has NO amber leg: every state on a crossing fixture is GREEN or RED, never AMBER", () => {
    expect(cuts.amber).toBeNull(); // the shipped row itself — the RED-only ruling, not a tuning
    const states = relStrengthBreakReadingSeries(F6, numFor(cuts.red! - 0.02), flatSpy).map((r) => r.state);
    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain("AMBER");
  });

  // The `!= null` guard is load-bearing: `s <= null` coerces to `s <= 0`. Injected row (tests
  // ONLY): amber null, red strictly below the coercion point — a spread between them (the
  // would-be amber band) must stay GREEN. Red-demo: mutate the amber guard to `s <= aB!`.
  test("a null amber leg NEVER fires - a spread between red and the s<=null coercion point stays GREEN", () => {
    const injected: RsCuts = { maWindow: cuts.maWindow, amber: null, red: RS_RED };
    const last = relStrengthBreakReadingSeries(F6, numFor(injected.red! / 2), flatSpy, injected).at(-1)!;
    expect(last.rawState).toBe("GREEN");
    expect(last.state).toBe("GREEN");
  });


  test("below the MA200 window → [] (cold-start safe)", () => {
    const short = shortPad(cuts.maWindow - 1);
    expect(relStrengthBreakReadingSeries(F6, short, short)).toEqual([]);
  });

  test("the persisted decision IS the spread: ratio ÷ its own MA200 − 1", () => {
    const target = cuts.red! - 0.02;
    const last = relStrengthBreakReadingSeries(F6, numFor(target), flatSpy).at(-1)!;
    expect(last.decision).toBeCloseTo(target, 10);
    // …and the stored level is the raw SMH/SPY ratio (single division), not the spread.
    expect(last.level).toBeCloseTo((1 + stepFor(target, cuts.maWindow)) * 100 / 100, 10);
  });
});

// id "F13": the scorer resolves its config off `RATIO_VS_MA_CONFIG_OF[indicator.id]` since the
// Stage-1 refactor, so the stub must carry the real id (was "credit-appetite-logic").
const f13 = indicator({ id: "F13", channel: "CONTEXT", thresholds: {} });

describe("scoreCreditAppetite (F13 HYG/LQD credit appetite - CONTEXT, %-spread vs MA50, LOW-is-bad)", () => {
  const lqdFlat = priceSeries(() => 100);

  // A pure geometric ratio r^i has a CONSTANT %-spread-vs-MA50 across every day (the MA
  // scales with the level), so the whole series sits in one band and confirms cleanly.
  // Bisect r for the target s — every fixture below targets an s expressed RELATIVE to the
  // imported cuts (never a literal), so retuning HYGLQD_AMBER/HYGLQD_RED can't break them.
  // r spans BOTH sides of 1 so a non-negative Amber cut is still reachable from the GREEN side.
  const maSpreadOf = (r: number) =>
    Math.abs(r - 1) < 1e-12
      ? 0
      : (HYGLQD_MA * Math.pow(r, HYGLQD_MA - 1) * (r - 1)) / (Math.pow(r, HYGLQD_MA) - 1) - 1;
  const rateForS = (target: number) => {
    let lo = 0.8;
    let hi = 1.2;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (maSpreadOf(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const BAND_MARGIN = 0.01; // one clear band-width away from a cut, in maSpread units
  const S_GREEN = HYGLQD_AMBER + BAND_MARGIN; // safely on the calm side of Amber
  const S_AMBER = (HYGLQD_AMBER + HYGLQD_RED) / 2; // mid-band
  const ratioAtS = (target: number) => px(rateForS(target));

  // --- two-leg helpers (2026-08-08 ruling) --------------------------------
  // On a geometric ratio r^i BOTH legs are constant: ms50 = maSpreadOf(r) and
  // d20 = r^HYGLQD_RET_WINDOW − 1. They therefore move TOGETHER along r, so a geometric
  // fixture can never separate them — the truth-table test below uses shaped series instead.
  const rateForD20 = (target: number) => Math.pow(1 + target, 1 / HYGLQD_RET_WINDOW);
  /** Both legs of the shipped rule, read off a ratio series' LAST day. */
  const legsAt = (ratio: number[]) => {
    const last = ratio.length - 1;
    let sum = 0;
    for (let j = last - HYGLQD_MA + 1; j <= last; j++) sum += ratio[j]!;
    return { ms: ratio[last]! / (sum / HYGLQD_MA) - 1, d20: ratio[last]! / ratio[last - HYGLQD_RET_WINDOW]! - 1 };
  };

  test("ratio clear of the AMBER cut → GREEN (s > HYGLQD_AMBER)", () => {
    expect(scoreCreditAppetite(f13, ratioAtS(S_GREEN), lqdFlat).state).toBe("GREEN");
  });

  test("ratio mid-band below its MA50 → AMBER (HYGLQD_AMBER ≥ s > HYGLQD_RED)", () => {
    expect(scoreCreditAppetite(f13, ratioAtS(S_AMBER), lqdFlat).state).toBe("AMBER");
  });

  test("ratio below BOTH legs' Red cuts → RED (d20 ≤ HYGLQD_D20_RED AND ms50 ≤ HYGLQD_RED)", () => {
    // RED is an AND, so the fixture is driven from the leg that binds — d20 — and the MA50 leg
    // is ASSERTED to follow rather than assumed. A geometric decay steep enough to clear the d20
    // Red cut also parks the level well below its own MA50, but that is a derived fact about the
    // two cuts' relative size, so it gets a premise assertion: if a future retune ever loosens
    // HYGLQD_RED past it, this reds here with a readable message instead of in the state assert.
    const r = rateForD20(HYGLQD_D20_RED - BAND_MARGIN);
    const hyg = px(r);
    const legs = legsAt(hyg.map((o) => o.value / 100));
    expect(legs.d20).toBeLessThanOrEqual(HYGLQD_D20_RED);
    expect(legs.ms).toBeLessThanOrEqual(HYGLQD_RED); // premise: the AND's other half really trips
    expect(scoreCreditAppetite(f13, hyg, lqdFlat).state).toBe("RED");
  });

  // The combine rule itself — `AMBER = d20 ≤ dA OR ms ≤ aA`, `RED = d20 ≤ dR AND ms ≤ rR`.
  // The lattice is not novel (it is `combineLevelVelocity`'s "split", shipped on CG) but this
  // scorer OPEN-CODES it over two numeric legs, so it gets a truth table over SHAPED series that
  // put each leg where the geometric fixtures above cannot. Each row pins its own DISCRIMINATING
  // PREMISE — which leg is clear — because a row only tests the OR (or only the AND) when the
  // other leg is clear; without the premise, a fixture that drifted out of its cell after a
  // `stepDown`/`PN`/`retWindow` edit would still pass both existing expects while silently
  // testing nothing.
  describe("two-leg combine rule (OR at Amber, AND at Red)", () => {
    /** Rises for the first stretch, then decays for the last `tail` days. */
    const shaped = (upRate: number, downRate: number, tail: number) =>
      priceSeries((i) => {
        const turn = PN - tail;
        return i <= turn ? 100 * Math.pow(upRate, i) : 100 * Math.pow(upRate, turn) * Math.pow(downRate, i - turn);
      });
    /** Flat at 100 until `ago` days from the end, then a one-step drop, flat after. */
    const stepDown = (drop: number, ago: number) => priceSeries((i) => (i < PN - ago ? 100 : 100 * (1 - drop)));

    /**
     * `premise` pins WHY this row discriminates — which leg sits clear of its cut, so the row
     * really exercises the OR (or the AND) and not both legs at once. It runs FIRST: if the
     * fixture drifts out of its intended cell, the row reds on the premise, not on the state.
     */
    const row = (
      name: string,
      hyg: ReturnType<typeof priceSeries>,
      expected: string,
      premise: (legs: { ms: number; d20: number }) => void,
    ) => {
      test(name, () => {
        const legs = legsAt(hyg.map((o) => o.value / 100));
        premise(legs);
        const d20Trips = legs.d20 <= HYGLQD_D20_AMBER;
        const msTrips = legs.ms <= HYGLQD_AMBER;
        const redTrips = legs.d20 <= HYGLQD_D20_RED && legs.ms <= HYGLQD_RED;
        // Fixture-placement guard: the fixture really lands in the cell this row names. It pins
        // neither the cuts nor the combine — the COMBINE is pinned solely by the expect below,
        // which drives the real scorer.
        expect(redTrips ? "RED" : d20Trips || msTrips ? "AMBER" : "GREEN").toBe(expected);
        expect(scoreCreditAppetite(f13, hyg, lqdFlat).state).toBe(expected);
      });
    };

    // ms50 tripped, d20 clear: the drop happened 25 days ago and the ratio has been FLAT since,
    // so the 20-day return is exactly 0 while the MA50 still carries the pre-drop level.
    // Under an AND-at-Amber rule this would be GREEN — that is what the row discriminates.
    row(
      "ms50 alone below its Amber cut → AMBER (the OR half the old AND-rule would miss)",
      stepDown(0.02, 25),
      "AMBER",
      (legs) => expect(legs.d20).toBeGreaterThan(HYGLQD_D20_AMBER), // premise: only the OR is under test
    );

    // d20 tripped hard, ms50 clear: a steep multi-month climb with a modest 20-day pullback
    // leaves the level ABOVE its own MA50 while the 20-day return clears even the d20 RED cut.
    // Red must NOT fire (the AND's ms50 half is clear) — the row that discriminates AND from OR.
    row(
      "d20 past its RED cut but ms50 clear → AMBER, never RED (the AND half)",
      shaped(1.004, 0.998, 20),
      "AMBER",
      (legs) => expect(legs.ms).toBeGreaterThan(HYGLQD_RED), // premise: only the AND is under test
    );

    // No clear-GREEN row here: both legs miles clear of both cuts discriminates nothing the
    // `S_GREEN` geometric test above does not already cover.
  });

  test("below the MA50 window → [] (cold-start safe, no MA lookback)", () => {
    const short = shortPad(HYGLQD_MA - 1);
    expect(creditAppetiteReadingSeries(f13, short, short)).toEqual([]);
  });

  // Case 2 — the persisted decision variable is single-sourced at cron. The REAL F13 registry
  // indicator carries the `derived` {kind:"maSpread", window:50} descriptor, so buildReadings
  // stamps each Reading's `decision` = the SAME %-spread-vs-MA50 the scorer's bands read (one
  // transform of the plotted HYG/LQD ratio level), so the ribbon and the chart can't drift.
  test("persisted F13 decision = %-spread of HYG/LQD ratio vs its MA50 (single-source)", () => {
    const hyg = px(1.002);
    const lqd = px(1.001); // non-constant → real ratio
    const last = creditAppetiteReadingSeries(F13, hyg, lqd).at(-1)!;

    const ratioAt = (i: number) => hyg[i]!.value / lqd[i]!.value; // ONE division → the stored `level`
    const iLast = PN - 1;
    let sum = 0;
    for (let j = iLast - HYGLQD_MA + 1; j <= iLast; j++) sum += ratioAt(j);
    const ma = sum / HYGLQD_MA;
    const expected = ratioAt(iLast) / ma - 1;

    expect(last.level).toBeCloseTo(ratioAt(iLast), 10); // stored level IS the HYG/LQD ratio
    expect(last.decision).toBeCloseTo(expected, 10); // persisted decision = %-spread vs MA50
  });
});

describe("decision variable persisted per point (Case 2, single-source at cron)", () => {
  const lastDecision = (series: Reading[]) => series.at(-1)!.decision;

  // Every PRICE_SCORERS row runs inside run-dbfirst.ts's ONE `degrade()` wrapper, so a row that throws
  // on a short/absent symbol takes the WHOLE price batch down with it — F4/F5/F6/F8/F13 AND both
  // DB_* detectors, on exactly the run where a feed is unhealthy. SPCONC's RSP is the repo's
  // newest symbol (no fetch history at all), so its row is guard-light: it must return `[]`,
  // never throw. Red-demo: revert the row to `[scoreBreadth(SPCONC, s.SPY!, s.RSP!)]` and this
  // goes red on the `latest()` throw (`scorers-price.ts` HIGH_WINDOW + CONFIRM_CLOSES guard).
  // The SAME guard for F5, added after the bare row shipped and FIRED in prod (2026-08-20 →
  // 08-21): `scoreBreadth` needs `BREADTH_MIN_CLOSES` aligned closes since the dynamic band, the live fetch window
  // (`LOOKBACK_DAYS` = 400 calendar days) yields ~275, so every run threw and the degrade wrapper
  // dropped the whole price batch — including DB_*/RS_*, which darkened /lab's `ew` column.
  // Red-demo: revert the row to `[scoreBreadth(F5, s.QQQ!, s.QQQE!)]` and the short/absent cases
  // go red on the `latest()` throw.
  test.each([
    { id: "SPCONC", a: "SPY", b: "RSP" },
    { id: "F5", a: "QQQ", b: "QQQE" },
  ] as const)("the $id price-scorer row degrades to [] on an absent/short $b instead of throwing", ({ id, a, b }) => {
    const row = PRICE_SCORERS.find((s) => s.indicator.id === id)!;
    expect(row.inputs).toEqual([a, b]);
    expect(row.series({ [a]: px(1.0004), [b]: [] })).toEqual([]); // absent b
    expect(row.series({ [a]: px(1.0004), [b]: px(1.0002).slice(-10) })).toEqual([]); // short b
    expect(row.series({})).toEqual([]); // both symbols missing
    // I-1: the 252–505 MIDDLE window (cut still NaN) degrades to []; `breadthReadingSeries` emits no
    // unranked day here, so the `breadthBandRanked` guard is not what this line pins.
    const mid = breadthClimb(0.002, 300); // ~300 aligned closes: past HIGH_WINDOW, under the 506 floor
    expect(row.series({ [a]: mid.qqq, [b]: mid.qqqe })).toEqual([]);
    // ...and it DOES score once the RANKABLE window is satisfied (BN=520 ≥ 506), so the [] above
    // isn't unconditional. (px is PN=260 — itself inside the middle window, so it too now drops.)
    const ranked = BREADTH_CLIMB_DEFAULT;
    expect(row.series({ [a]: ranked.qqq, [b]: ranked.qqqe })).not.toHaveLength(0);
  });

  test("every soft price-scorer row degrades to [] on absent inputs instead of throwing", () => {
    const soft = PRICE_SCORERS.filter((r) => r.soft);
    expect(soft.length).toBeGreaterThan(0);
    for (const s of soft) expect(s.series({}), s.indicator.id).toEqual([]);
  });

  test("all 8 derived ids stamp a finite decision; a non-derived id stamps none", () => {
    // Each of the 8 through its REAL registry `derived` descriptor + live cron scorer. CG
    // (T2.2) + GT (slice 1b) were added after Case 2's "six" doc scope, but ride the SAME
    // generic buildReadings→decisionAt gate, so they persist a populated decision too.
    expect(lastDecision(semisReadingSeries(F4, px(1.0005), px(1.0003)))).toBeTypeOf("number"); // F4 6-mo return
    expect(lastDecision(breadthReadingSeries(F5, BREADTH_CLIMB_DEFAULT.qqq, BREADTH_CLIMB_DEFAULT.qqqe))).toBeTypeOf("number"); // F5 highDist (PN is unranked → [])
    expect(lastDecision(relStrengthBreakReadingSeries(F6, px(1.0006), px(1.0001)))).toBeTypeOf("number"); // F6 MA200 spread
    expect(lastDecision(memGateReadingSeries(F8, px(0.999)))).toBeTypeOf("number"); // F8 6-mo return
    expect(lastDecision(oilReadingSeries(G1, px(1.001)))).toBeTypeOf("number"); // G1 20d return
    expect(lastDecision(nvdaGateReadingSeries(NVDA, px(1.0007)))).toBeTypeOf("number"); // NVDA MA200 spread
    // CG gets its OWN, longer pair: the 2026-08-08 detrend pushed its head past `PN`, so the
    // shared `px` helper now emits zero readings for it. Length DERIVED from the scorer's head.
    const cgPx = (rate: number): Observation[] =>
      Array.from({ length: levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES + 20 }, (_, i) => ({
        date: `d${String(i).padStart(4, "0")}`,
        value: 100 * Math.pow(rate, i),
      }));
    expect(lastDecision(ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, cgPx(1.0005), cgPx(1.0003)))).toBeTypeOf("number"); // CG 20d ratio return
    expect(lastDecision(globalTrendReadingSeries(GT, px(1.001)))).toBeTypeOf("number"); // GT MA200 spread

    // A non-derived FRED level+velocity indicator has no `derived` descriptor → no decision.
    const r1 = indicator({ id: "R1", thresholds: { amberVelocity: 0.4, redVelocity: 0.7 } });
    const fred = indicatorReadingSeries(r1, priceSeries((i) => 100 + i)).at(-1)!;
    expect(fred.decision ?? null).toBeNull();
  });
});

describe("scoreMemGate (F8 Micron memory-cycle - CONTEXT, compound MA200 AND-gate)", () => {
  // Band fixtures: a HIGH plateau (6× the trough) through day 119, then a geometric ramp
  // whose per-day rate is derived from the band constants (rate^RET_WINDOW − 1 = target), so
  // retuning MU_AMBER/MU_RED carries the fixtures with it. The ramp is >RET_WINDOW long, so
  // every scored tail day's 6-mo return is EXACTLY `target`; the plateau keeps the trailing
  // mean high enough that the ramp's end stays under MA200·MU_MA_MULT (gate ON).
  const RAMP_START = 120;
  const muRamp = (target: number) =>
    priceSeries((i) =>
      i < RAMP_START ? 600 : 100 * Math.pow(Math.pow(1 + target, 1 / RET_WINDOW), i - RAMP_START),
    );

  test("below the MA200 gate line AND mid-band 6mo ret → AMBER (MU_AMBER ≥ ret > MU_RED)", () => {
    expect(scoreMemGate(f8, muRamp((MU_AMBER + MU_RED) / 2)).state).toBe("AMBER");
  });

  test("below the MA200 gate line AND below the RED band 6mo ret → RED (ret ≤ MU_RED)", () => {
    expect(scoreMemGate(f8, muRamp(MU_RED * 0.9)).state).toBe("RED");
  });

  test("AND-gate: below the MA200 gate line but a 6mo ret above MU_AMBER → GREEN, not AMBER", () => {
    expect(scoreMemGate(f8, muRamp(MU_AMBER * 1.5)).state).toBe("GREEN");
  });

  test("MU_MA_MULT headroom: a price ABOVE its bare MA200 but under MA200·MU_MA_MULT still fires", () => {
    // The +10% headroom's own red-demo: a slow drift ends ~4% above its 200-day mean, so the
    // pre-2026-07-23 `< MA200` gate was OFF (GREEN) and only the ×MU_MA_MULT line fires it.
    const mu = px(1.0004);
    const tail = mu.slice(-MA_WINDOW).map((o) => o.value);
    const ma = tail.reduce((a, b) => a + b, 0) / MA_WINDOW;
    const last = mu.at(-1)!.value;
    expect(last).toBeGreaterThan(ma); // bare-MA gate OFF …
    expect(last).toBeLessThan(ma * MU_MA_MULT); // … but inside the +10% headroom
    expect(scoreMemGate(f8, mu).state).toBe("RED"); // ret ≤ MU_RED, gate now ON
  });

  test("AND-gate: deep −23%/6mo return but ABOVE the MA200 gate line (recovered) → GREEN", () => {
    // A spike to 130 exactly 126 days before the last close (deep ret6), a mostly-80 baseline
    // (so MA200 ≈ 84), and a recovery to 100 for the tail → 100 > MA200·MU_MA_MULT ≈ 92.
    const mu = priceSeries((i) => (i >= 128 && i <= 138 ? 130 : i >= 245 ? 100 : 80));
    expect(scoreMemGate(f8, mu).state).toBe("GREEN");
  });
});

describe("scoreDownsideBreak (slice-2 drawdown-from-3mo-high + MA50 gate, per-symbol)", () => {
  // A per-symbol US-tech proxy fixture (id label only — the scorer is channel-agnostic).
  const dbg = indicator({ id: "SMH", channel: "CONTEXT", thresholds: {} });

  test("MA50 trend gate: a −20% drop that RECOVERED above its MA50 stays GREEN", () => {
    // V-shape in the trailing 63-day window: a 125 peak, a decline to an 80 trough,
    // then a recovery to 100. At the last close the high is 125 → dd = −20% (≤ Red),
    // but 100 sits ABOVE its rising MA50 (dominated by the trough+recovery) → the
    // trend gate holds → GREEN despite the deep drawdown.
    const recoveryV = (): Observation[] => {
      const peakEnd = PN - 63; // window start = the 125 peak
      const troughAt = PN - 30;
      const vals: number[] = [];
      for (let i = 0; i < PN; i++) {
        let v: number;
        if (i <= peakEnd) v = 125;
        else if (i <= troughAt) v = 125 + ((i - peakEnd) / (troughAt - peakEnd)) * (80 - 125);
        else v = 80 + ((i - troughAt) / (PN - 1 - troughAt)) * (100 - 80);
        vals.push(v);
      }
      return vals.map((value, i) => ({ date: `d${String(i).padStart(3, "0")}`, value }));
    };
    const r = scoreDownsideBreak(dbg, recoveryV());
    expect(r.state).toBe("GREEN");
  });

  test("guard-light: fewer than HIGH_WINDOW_SHORT closes → [] (no readings)", () => {
    const short = flatN(100, HIGH_WINDOW_SHORT - 1);
    expect(downsideBreakReadingSeries(dbg, short)).toEqual([]);
  });

  // Per-detector cuts (2026-07-23): the pair is resolved PER ID via `downsideCuts`, DB_XLK
  // carrying its own entry. The old fixture here discriminated by VALUE (one drawdown, AMBER on
  // DB_SMH, RED on DB_XLK); that stopped being possible when DB_SMH was retuned onto the same
  // −5/−8, and a value fixture would now pass under a seam that ignores the id entirely. So the
  // routing is pinned through the INJECTED override table instead: it goes red the moment
  // `downsideCuts` stops dispatching on `id`, regardless of what the shipped pairs happen to be.
  test("downsideCuts routes per id - an override table entry wins, an absent id takes the default", () => {
    const table = { DB_XLK: { amber: -0.11, red: -0.22 } };
    expect(downsideCuts("DB_XLK", table)).toEqual(table.DB_XLK);
    expect(downsideCuts("DB_SMH", table)).toEqual({ amber: DOWNSIDE_AMBER, red: DOWNSIDE_RED });
    // …and DB_XLK is REGISTERED in the shipped table. Registration, not value: its constants
    // equal the default pair today, so a value-only assertion passes on an EMPTIED table — i.e.
    // deleting the per-id seam from prod would be undetectable.
    expect(Object.hasOwn(DOWNSIDE_CUT_OVERRIDES, "DB_XLK")).toBe(true);
    expect(DOWNSIDE_CUT_OVERRIDES.DB_XLK).toEqual({ amber: DOWNSIDE_XLK_AMBER, red: DOWNSIDE_XLK_RED });
    // A prototype key must NOT resolve as an override (it would hand the scorer undefined cuts).
    expect(downsideCuts("toString")).toEqual({ amber: DOWNSIDE_AMBER, red: DOWNSIDE_RED });
  });

  // …and the shipped cuts actually bite at the scorer: a drawdown past red on BOTH detectors'
  // current pair confirms RED, while one between amber and red confirms AMBER. Depths derive from
  // the constants, so a retune carries the fixture with it.
  test("the shipped per-id cuts bite: amber-band depth → AMBER, past-red depth → RED", () => {
    const stepObs = (depth: number): Observation[] =>
      [...Array.from({ length: PN - 2 }, () => 100), 100 * (1 + depth), 100 * (1 + depth)].map((value, i) => ({
        date: `d${String(i).padStart(3, "0")}`,
        value,
      }));
    for (const id of DOWNSIDE_DETECTOR_IDS) {
      const ind = indicator({ id, channel: "GLOBAL", thresholds: {} });
      const cuts = downsideCuts(id);
      const mid = (cuts.amber + cuts.red) / 2; // strictly between the two legs
      expect(scoreDownsideBreak(ind, stepObs(mid)).state, `${id} amber band`).toBe("AMBER");
      expect(scoreDownsideBreak(ind, stepObs(cuts.red - 0.005)).state, `${id} past red`).toBe("RED");
    }
  });
});

describe("scoreRelStrengthBreak (EW rel-strength leg - X/SPY ratio vs its own MA50, LOW-is-bad)", () => {
  const rsg = indicator({ id: "RS_SMH", channel: "GLOBAL", thresholds: {} });
  const cuts = rsCuts(rsg.id);
  const flatSpy = priceSeries(() => 100);

  const numFor = (spread: number) => numForW(spread, RS_MA_WINDOW);

  test("ratio above its MA50 → GREEN", () => {
    // A stepped-UP tail puts the ratio above its trailing MA50 (positive spread > the amber cut).
    expect(scoreRelStrengthBreak(rsg, numFor(0.05), flatSpy).state).toBe("GREEN");
  });

  test("guard-light: fewer than RS_MA_WINDOW aligned closes → [] (no readings)", () => {
    const short = shortPad(RS_MA_WINDOW - 1);
    expect(relStrengthBreakReadingSeries(rsg, short, short)).toEqual([]);
  });

  test("the persisted decision IS the spread: ratio ÷ its own MA50 − 1", () => {
    const target = (cuts.amber! + cuts.red!) / 2;
    const last = relStrengthBreakReadingSeries(rsg, numFor(target), flatSpy).at(-1)!;
    expect(last.decision).toBeCloseTo(target, 10);
  });

  // Per-id routing mirror of the downsideCuts injected-table test: pinned through the INJECTED
  // override table (the shipped pairs are equal, so a value fixture could not see the seam die).
  test("rsCuts routes per id - an override table entry wins, an absent id takes the default", () => {
    const table = { RS_XLK: { maWindow: 63, amber: -0.11, red: -0.22 } };
    expect(rsCuts("RS_XLK", table)).toEqual(table.RS_XLK);
    expect(rsCuts("RS_SMH", table)).toEqual({ ...RS_SMH_DESCRIPTOR.scorer.constants });
    // …and RS_XLK + F6 are REGISTERED in the shipped table (registration, not value — the DB_XLK lesson).
    expect(Object.hasOwn(RS_CUT_OVERRIDES, "RS_XLK")).toBe(true);
    expect(RS_CUT_OVERRIDES.RS_XLK).toEqual({ maWindow: RS_MA_WINDOW, amber: RS_XLK_AMBER, red: RS_XLK_RED });
    expect(Object.hasOwn(RS_CUT_OVERRIDES, "F6")).toBe(true);
    expect(RS_CUT_OVERRIDES.F6).toEqual({ maWindow: RELSTR_MA_WINDOW, amber: RELSTR_AMBER, red: RELSTR_RED });
    // A prototype key must NOT resolve as an override.
    expect(rsCuts("toString")).toEqual({ ...RS_SMH_DESCRIPTOR.scorer.constants });
  });

  // …and the shipped per-id cuts bite at the scorer for EVERY RS leg id.
  test("the shipped per-id cuts bite: amber-band spread → AMBER, past-red spread → RED", () => {
    for (const id of RS_LEG_IDS) {
      const ind = indicator({ id, channel: "GLOBAL", thresholds: {} });
      const c = rsCuts(id);
      expect(scoreRelStrengthBreak(ind, numFor((c.amber! + c.red!) / 2), flatSpy).state, `${id} amber band`).toBe("AMBER");
      expect(scoreRelStrengthBreak(ind, numFor(c.red! - 0.005), flatSpy).state, `${id} past red`).toBe("RED");
    }
  });
});

describe("scoreNvdaGate / nvdaGateReadingSeries (NVDA vs its own MA200 - CONTEXT gate)", () => {
  test("rising NVDA (above MA200) → GREEN, and rawState === state (no buffer)", () => {
    const up = px(1.001);
    const r = scoreNvdaGate(NVDA, up);
    expect(r.state).toBe("GREEN");
    expect(r.rawState).toBe(r.state);
  });

  test("falling NVDA (below MA200) → AMBER, never RED, rawState === state", () => {
    const down = px(0.998);
    const r = scoreNvdaGate(NVDA, down);
    expect(r.state).toBe("AMBER");
    expect(r.rawState).toBe("AMBER");
  });

});

// --- the breadth band's FETCH DEPTH (2026-08-21) ----------------------------------------
//
// `scoreBreadth` needs BREADTH_MIN_CLOSES aligned closes before its dynamic band can form; the
// default fetch window (`LOOKBACK_DAYS` = 400 calendar days, ~275 closes) cannot supply them, so
// F5/SPCONC scored GREEN forever behind the guard-light row. The repair is a PER-SYMBOL deep fetch
// for the four breadth legs. These pin the headroom and the roster; the run-cycle call site is
// pinned by source substring below because `scorePriceIndicators` is module-private (the
// `cg-level-leg.test.ts` deep-fetch precedent) — a weaker instrument, stated rather than hidden.
describe("breadth band fetch depth", () => {
  test("BREADTH_LOOKBACK_DAYS buys strictly more closes than the band needs", () => {
    const closes = Math.floor((BREADTH_LOOKBACK_DAYS * 252) / 365);
    expect(closes).toBeGreaterThan(BREADTH_MIN_CLOSES);
    // The shallow closes-feed fetch is hard-coded `range=2y` (~500 closes). Since the rolling-window retune
    // (2026-08-29) the floor sits BELOW that, so the deep fetch is no longer the difference between
    // scoring and throwing — it is the rank headroom that keeps a live run off its first finite cut
    // day. Keep it: on ~500 closes the band would run with none.
    expect(BREADTH_MIN_CLOSES).toBeLessThan(500);
  });

  test("DEEP_PRICE_INPUTS is exactly the two breadth rows' inputs — no more, no less", () => {
    const breadthInputs = new Set(
      PRICE_SCORERS.filter((s) => s.indicator.id === "F5" || s.indicator.id === "SPCONC").flatMap(
        (s) => s.inputs,
      ),
    );
    expect(breadthInputs.size).toBe(4);
    expect([...DEEP_PRICE_INPUTS].sort()).toEqual([...breadthInputs].sort());
    // Every OTHER fetched symbol stays shallow — a deep leg is a superset, so the scorers that
    // SHARE one (F6 SMH-SPY, RS_*) are unmoved only because their other leg is still shallow.
    for (const spec of PRICE_SCORERS) {
      if (spec.indicator.id === "F5" || spec.indicator.id === "SPCONC") continue;
      const deepened = spec.inputs.filter((i) => DEEP_PRICE_INPUTS.has(i));
      expect(deepened.length, `${spec.indicator.id} must keep at least one shallow leg`).toBeLessThan(
        spec.inputs.length,
      );
    }
  });

  test("run-dbfirst fetches the DEEP_PRICE_INPUTS symbols deep (DB-first, §6.2) and the rest shallow", () => {
    const src = readFileSync(new URL("./run-dbfirst.ts", import.meta.url), "utf8");
    // The deep arm now routes through `resolveBreadthCloses` (DB-first), the shallow arm is its early return.
    expect(src).toContain("if (!DEEP_PRICE_INPUTS.has(sym)) return fetchShallow(sym);"); // shallow arm survives
    expect(src).toContain("fetchDailyCloses(sym, { deep: true, lookbackDays: BREADTH_LOOKBACK_DAYS, now: () => Date.parse(runAt), env })"); // deep-arm fetch
    expect(src).toContain("(s) => fetchDailyCloses(s, { now: () => Date.parse(runAt), env })"); // shallow default reads the run's clock
  });
});

// --- Stage-1 refactor: generalize breadth + ratio-vs-MA scorers (behavior-preserving) --------
//
// These pin that lifting the F5/SPCONC/F13 module constants onto per-id descriptor configs is a
// PURE lift — the readings must be byte-for-byte identical to the pre-refactor output captured on
// deterministic fixtures (`d897e831` rolling-126 p85/p98 band, which SPCONC still carries). The
// golden strings/objects below were captured from the code AT the refactor commit; a
// percentile/window/direction slip reds them. F5 left that triple on 2026-08-30 (rolling-63
// p88/p98.5) and carries its OWN capture plus the discriminating pin that the two configs differ.
describe("Stage-1 breadth/ratio-vs-MA generalization — parity + new direction ladder", () => {
  const SPCONC_STATES =
    "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAA";
  const SPCONC_RAWS =
    "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAG";
  const statesOf = (rs: Reading[]) => rs.map((r) => r.state[0]).join("");
  const rawsOf = (rs: Reading[]) => rs.map((r) => r.rawState[0]).join("");

  // F5's rolling-63 capture (2026-08-30). Its value as a pin is regression-only, so it is paired
  // with the discriminating assertion below: the shorter window must fire EARLIER than SPCONC's.
  const F5_STATES =
    "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARRGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAAA";
  const F5_RAWS =
    "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAARGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAAAAAAAG";

  test("F5 breadth readings are byte-for-byte its captured rolling-63 golden", () => {
    const { qqq, qqqe } = BREADTH_CLIMB_DEFAULT; // default BN=520
    const rs = breadthReadingSeries(f5, qqq, qqqe);
    // The golden's first `minObs` days are the unranked (NaN-cut) warm-up the series no longer emits.
    const warm = breadthConfig("F5").minObs;
    expect(rs.length).toBe(269 - warm);
    expect(statesOf(rs)).toBe(F5_STATES.slice(warm));
    expect(rawsOf(rs)).toBe(F5_RAWS.slice(warm));
    const last = rs.at(-1)!;
    expect(last.level).toBeCloseTo(114186.60917285022, 6);
    expect(last.state).toBe("AMBER");
    expect(last.rawState).toBe("GREEN");
  });

  test("SPCONC keeps the rolling-126 golden F5 left behind (the configs are NOT shared)", () => {
    const { qqq, qqqe } = BREADTH_CLIMB_DEFAULT;
    const warm = breadthConfig("SPCONC").minObs;
    expect(statesOf(breadthReadingSeries(spconc, qqq, qqqe))).toBe(SPCONC_STATES.slice(warm));
    expect(rawsOf(breadthReadingSeries(spconc, qqq, qqqe))).toBe(SPCONC_RAWS.slice(warm));
  });

  // 2026-10-03: backfill's incremental plan fed ~294 closes (past HIGH_WINDOW, short of a finite cut) and its
  // tail re-shadow persisted the NaN-cut GREENs over the cron's RED rows. Emit only ranked days.
  test("breadthReadingSeries emits no unranked (NaN-cut) day on a short feed", () => {
    const mid = breadthClimb(0.002, 300);
    expect(breadthReadingSeries(f5, mid.qqq, mid.qqqe)).toEqual([]);
    expect(breadthReadingSeries(spconc, mid.qqq, mid.qqqe)).toEqual([]);
  });

  test("F5's shorter window fires EARLIER than SPCONC's on the same fixture", () => {
    const { qqq, qqqe } = BREADTH_CLIMB_DEFAULT;
    const firstFire = (rs: Reading[]) => rs.findIndex((r) => r.state !== "GREEN");
    const f5First = firstFire(breadthReadingSeries(f5, qqq, qqqe));
    const spconcFirst = firstFire(breadthReadingSeries(spconc, qqq, qqqe));
    expect(f5First).toBeGreaterThan(-1);
    expect(f5First).toBeLessThan(spconcFirst); // re-merging the two configs reds this
  });

  const F13_STATES =
    "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR";
  test("F13 ratio-vs-MA readings are byte-for-byte the captured pre-refactor golden", () => {
    // climb then a steep decay so BOTH legs cross their cuts (a G→R transition the pin locks).
    const PN2 = 260;
    const shaped = (upRate: number, downRate: number, tail: number) =>
      priceSeries((i) => {
        const turn = PN2 - tail;
        return i <= turn ? 100 * Math.pow(upRate, i) : 100 * Math.pow(upRate, turn) * Math.pow(downRate, i - turn);
      });
    const lqdFlat = priceSeries(() => 100);
    const rs = creditAppetiteReadingSeries(F13, shaped(1.001, 0.99, 60), lqdFlat);
    expect(rs.length).toBe(211);
    expect(statesOf(rs)).toBe(F13_STATES);
    const last = rs.at(-1)!;
    expect(last.decision).toBeCloseTo(-0.22642199197315782, 12);
    expect(last.delta20).toBeCloseTo(-0.15027318283751534, 12);
    expect(last.state).toBe("RED");
  });

  // The new `direction: "low"` ladder, tested DIRECTLY on a fixture so it is not dead-by-
  // construction (nothing seats on it until Stage 2's LOW twin). Mirror of the HIGH ladder:
  // RED before AMBER on the `<=` side; NaN → GREEN survives.
  test("breadthClassify direction 'low' is the mirrored <= ladder (RED before AMBER, NaN→GREEN)", () => {
    const dist = [0.0, -0.02, -0.06, NaN];
    const amberCut = [-0.01, -0.01, -0.01, -0.01];
    const redCut = [-0.05, -0.05, -0.05, -0.05];
    expect(breadthClassify(0, dist, amberCut, redCut, "low")).toBe("GREEN"); // 0 above the amber cut
    expect(breadthClassify(1, dist, amberCut, redCut, "low")).toBe("AMBER"); // ≤ amber, > red
    expect(breadthClassify(2, dist, amberCut, redCut, "low")).toBe("RED"); // ≤ red (checked first)
    expect(breadthClassify(3, dist, amberCut, redCut, "low")).toBe("GREEN"); // NaN → GREEN
    // Same deep-negative point scores GREEN under "high" — the two directions genuinely diverge.
    expect(breadthClassify(2, dist, amberCut, redCut, "high")).toBe("GREEN");
    expect(breadthClassify(0, dist, amberCut, redCut, "high")).toBe("RED"); // 0 ≥ red cut(-0.05)
  });

  // The per-descriptor `maWindow > retWindow` guard: a violating config must THROW (silent-GREEN
  // failure mode otherwise). Tested on the exported guard so module load stays green.
  // Only maWindow/retWindow are load-bearing here; every cut field is SENTINEL so no reader can
  // mistake this fixture for either id's live cuts (their descriptors are the only source).
  const SENTINEL = -1;
  test("assertRatioVsMaWindows throws when maWindow ≤ retWindow, passes when it exceeds", () => {
    expect(() =>
      assertRatioVsMaWindows("FDX", { maWindow: 20, amber: SENTINEL, red: SENTINEL, retWindow: 50, d20Amber: SENTINEL, d20Red: SENTINEL }),
    ).toThrow(/must exceed/);
    expect(() =>
      assertRatioVsMaWindows("F13", { maWindow: 50, amber: SENTINEL, red: SENTINEL, retWindow: 20, d20Amber: SENTINEL, d20Red: SENTINEL }),
    ).not.toThrow();
  });
});

// EURGBP worst-of: 20d % move (`derived` return) OR % vs MA — both HIGH, cuts off the descriptor only.
describe("scoreReturnOrMaSpread (EURGBP)", () => {
  const C = EURGBP_DESCRIPTOR.scorer.constants;
  const W = EURGBP.derived!.window!;
  const M = C.maWindow;
  const PREFIX = 2 * M;
  const obs = (vals: number[]) => vals.map((value, i) => ({ date: `d${String(i).padStart(3, "0")}`, value }));
  const maSpread = (v: number[], i: number) => v[i]! / (v.slice(i - M + 1, i + 1).reduce((a, b) => a + b, 0) / M) - 1;
  const move = (v: number[], i: number) => v[i]! / v[i - W]! - 1;
  // prefix at `a`, W closes at `lo`, then 2 closes at `hi` (the two confirming closes).
  const vShape = (a: number, lo: number, hi: number) => [
    ...Array<number>(PREFIX).fill(a),
    ...Array<number>(W).fill(lo),
    hi,
    hi,
  ];
  // prefix at 1, then `level` held for W+2 closes — the 20d move reads 0 on the two last closes.
  const plateau = (level: number) => [...Array<number>(PREFIX).fill(1), ...Array<number>(W + 2).fill(level)];
  // Plateau level whose last-close MA spread is `t` (M−W−2 prefix closes + W+2 plateau closes in the window).
  const plateauFor = (t: number) => ((M - W - 2) * (1 + t)) / (M - (W + 2) * (1 + t));
  const lastTwo = (v: number[]) => [v.length - 2, v.length - 1];

  test.each([
    ["AMBER", (C.retAmber + C.retRed) / 2],
    ["RED", C.retRed * 1.2],
  ] as const)("return leg alone -> %s (MA spread stays under its amber)", (want, s) => {
    const v = vShape(1, 1 / (1 + s), 1);
    for (const i of lastTwo(v)) {
      expect(maSpread(v, i)).toBeLessThan(C.maAmber);
      expect(move(v, i)).toBeCloseTo(s, 12);
    }
    const r = scoreReturnOrMaSpread(EURGBP, obs(v));
    expect(r.state).toBe(want);
    expect(r.leg).toBe("return");
  });

  test.each([
    ["AMBER", (C.maAmber + C.maRed) / 2],
    ["RED", C.maRed * 1.2],
  ] as const)("MA leg alone -> %s (20d move is zero)", (want, t) => {
    const v = plateau(plateauFor(t));
    for (const i of lastTwo(v)) expect(move(v, i)).toBe(0);
    const band = want === "RED" ? [C.maRed, Infinity] : [C.maAmber, C.maRed];
    for (const i of lastTwo(v)) {
      expect(maSpread(v, i)).toBeGreaterThanOrEqual(band[0]!);
      expect(maSpread(v, i)).toBeLessThan(band[1]!);
    }
    const r = scoreReturnOrMaSpread(EURGBP, obs(v));
    expect(r.state).toBe(want);
    expect(r.decision).toBe(0);
    expect(r.leg).toBe(`ma${M}`); // the card names the MA leg the 20d line cannot show
  });

  test("worst-of: return RED + MA AMBER -> RED", () => {
    const s = C.retRed * 1.2;
    const t = (C.maAmber + C.maRed) / 2;
    const hi = 1 + s;
    // Solve the prefix level so the last close's MA spread is `t`.
    const a = (M * hi / (1 + t) - W - 2 * hi) / (M - W - 2);
    const v = vShape(a, 1, hi);
    for (const i of lastTwo(v)) {
      expect(move(v, i)).toBeGreaterThanOrEqual(C.retRed);
      expect(maSpread(v, i)).toBeGreaterThanOrEqual(C.maAmber);
      expect(maSpread(v, i)).toBeLessThan(C.maRed);
    }
    const r = scoreReturnOrMaSpread(EURGBP, obs(v));
    expect(r.state).toBe("RED");
    expect(r.leg).toBe("return");
  });

  test("worst-of mirrored: MA RED + return AMBER -> RED", () => {
    const s = (C.retAmber + C.retRed) / 2;
    const t = C.maRed * 1.2;
    const hi = 1 + s;
    const a = (M * hi / (1 + t) - W - 2 * hi) / (M - W - 2);
    const v = vShape(a, 1, hi);
    for (const i of lastTwo(v)) {
      expect(move(v, i)).toBeGreaterThanOrEqual(C.retAmber);
      expect(move(v, i)).toBeLessThan(C.retRed);
      expect(maSpread(v, i)).toBeGreaterThanOrEqual(C.maRed);
    }
    const r = scoreReturnOrMaSpread(EURGBP, obs(v));
    expect(r.state).toBe("RED");
    expect(r.leg).toBe(`ma${M}`);
  });

  test("falling series (sterling rallying) -> GREEN on every scored day", () => {
    const v = Array.from({ length: PREFIX + W + 2 }, (_, i) => (1 - C.retRed) ** (i / W));
    const rs = returnOrMaSpreadReadingSeries(EURGBP, obs(v));
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((r) => r.rawState === "GREEN")).toBe(true);
  });

});

describe("PRICE_SCORERS `series` (gap-fill carry)", () => {
  // One deterministic, non-flat walk per input symbol, deep enough for the breadth rows' rankable window.
  const bySymbol: Record<string, Observation[]> = Object.fromEntries(
    [...new Set(PRICE_SCORERS.flatMap((s) => s.inputs))].map((sym, k) => [
      sym,
      Array.from({ length: BN }, (_, i) => ({
        date: `d${String(i).padStart(3, "0")}`,
        value: 100 + 12 * Math.sin(i / (6 + k)) + 0.04 * (k - 5) * i,
      })),
    ]),
  );

  test("every row carries its history to the gap-fill sweep", () => {
    for (const spec of PRICE_SCORERS) {
      const dates = spec.series(bySymbol).map((r) => r.date);
      expect(dates.length, spec.indicator.id).toBeGreaterThan(1);
      expect(dates, spec.indicator.id).toEqual([...new Set(dates)].sort());
    }
  });
});

// EXSH_GATE ([USER] rule B, 2026-10-06): RED iff close ≤ its MA200 cross; else AMBER iff close vs MA50 OR the
// EXSH/EXSA ratio vs ITS MA50 fails; else GREEN. Driven through the REAL PRICE_SCORERS row (EXSH.DE + EXSA.DE wiring,
// the registry red band). Every fixture sits at a spread chosen RELATIVE to the descriptor constants — never a price —
// and a fixture guard pins the OTHER two checks clear, so each case flips exactly one check.
describe("EXSH_GATE - rule B: MA200 red cross, MA50 / EXSH-vs-EXSA MA50 amber crosses", () => {
  const C = EXSH_GATE_DESCRIPTOR.scorer.constants;
  const row = PRICE_SCORERS.find((s) => s.indicator.id === EXSH_GATE.id)!;
  const day = utcDay(2024);
  const N = C.trendWindow + 20;
  const EPS = 1e-3;
  const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const spread = (v: number[], w: number) => v.at(-1)! / avg(v.slice(-w)) - 1;
  // Replace v's last entry so `spread(v, w) === s`: with the other w−1 trailing entries averaging m,
  // MA = ((w−1)m + L)/w, so L = (1+s)(w−1)m / (w − (1+s)).
  const withLast = (v: number[], s: number, w: number) => {
    const m = avg(v.slice(-w, -1));
    return [...v.slice(0, -1), ((1 + s) * (w - 1) * m) / (w - (1 + s))];
  };
  const geo = (rate: number) => Array.from({ length: N }, (_, i) => 100 * rate ** i);
  const obs = (v: number[]) => v.map((value, i) => ({ date: day(i), value }));
  // The parent is close ÷ ratio, so the EXSH/EXSA ratio is set independently of the close.
  const inputs = (close: number[], ratio: number[]) => ({
    "EXSH.DE": obs(close),
    "EXSA.DE": obs(close.map((c, i) => c / ratio[i]!)),
  });
  const head = (close: number[], ratio: number[]) => row.series(inputs(close, ratio)).at(-1)!;
  const checks = (close: number[], ratio: number[]) => ({
    ma200: spread(close, C.trendWindow) <= C.red,
    ma50: spread(close, C.maShortWindow) <= C.amberMa,
    rs: spread(ratio, C.rsWindow) <= C.amberRs,
  });
  const up = geo(1.002); // close above both MAs, ratio above its MA — every check clear
  // Long flat run, a maShortWindow-deep dip, then the last close set vs MA200: above its MA50, so ONLY the MA200 check moves.
  const dip = (s: number) =>
    withLast([...Array(N - C.maShortWindow).fill(100), ...Array(C.maShortWindow).fill(80)], s, C.trendWindow);

  test("premise: the registry draws the descriptor's red cut and no amber band", () => {
    expect(EXSH_GATE.derived).toMatchObject({ window: C.trendWindow, red: C.red });
    expect(EXSH_GATE.derived?.amber).toBeNull();
  });
  test("baseline: every check clear → GREEN; the value is close % vs MA200", () => {
    expect(checks(up, up)).toEqual({ ma200: false, ma50: false, rs: false });
    expect(head(up, up).rawState).toBe("GREEN");
    expect(head(up, up).decision!).toBeCloseTo(spread(up, C.trendWindow), 10);
  });
  test("MA200 alone flips GREEN ↔ RED (MA50 + RS held clear)", () => {
    expect(checks(dip(C.red - EPS), up)).toEqual({ ma200: true, ma50: false, rs: false });
    expect(checks(dip(C.red + EPS), up)).toEqual({ ma200: false, ma50: false, rs: false });
    expect(head(dip(C.red - EPS), up).rawState).toBe("RED");
    expect(head(dip(C.red + EPS), up).rawState).toBe("GREEN");
  });
  test("close vs MA50 alone flips GREEN ↔ AMBER (MA200 + RS held clear)", () => {
    const below = withLast(up, C.amberMa - EPS, C.maShortWindow);
    const above = withLast(up, C.amberMa + EPS, C.maShortWindow);
    expect(checks(below, up)).toEqual({ ma200: false, ma50: true, rs: false });
    expect(checks(above, up)).toEqual({ ma200: false, ma50: false, rs: false });
    expect(head(below, up).rawState).toBe("AMBER");
    expect(head(above, up).rawState).toBe("GREEN");
  });
  test("EXSH/EXSA vs its MA50 alone flips GREEN ↔ AMBER (both close checks held clear)", () => {
    const below = withLast(up, C.amberRs - EPS, C.rsWindow);
    const above = withLast(up, C.amberRs + EPS, C.rsWindow);
    expect(checks(up, below)).toEqual({ ma200: false, ma50: false, rs: true });
    expect(checks(up, above)).toEqual({ ma200: false, ma50: false, rs: false });
    expect(head(up, below).rawState).toBe("AMBER");
    expect(head(up, above).rawState).toBe("GREEN");
  });
  test("MA200 takes precedence: all three failing reads RED, not AMBER", () => {
    const down = geo(0.998);
    expect(checks(down, down)).toEqual({ ma200: true, ma50: true, rs: true });
    expect(head(down, down).rawState).toBe("RED");
  });
  // Edges are INCLUSIVE (`spread ≤ cut` fires). A flat close + flat ratio makes all three spreads EXACTLY 0; a cut
  // placed on that 0 fires its leg, a cut just below it does not (the other two legs parked out of reach at −1).
  test("edge inclusivity: a spread sitting exactly ON a cut fires that check", () => {
    const flat = Array(N).fill(100);
    const one = Array(N).fill(1);
    const { "EXSH.DE": exsh, "EXSA.DE": exsa } = inputs(flat, one);
    const state = (cuts: Partial<ExshGateCuts>) =>
      exshGateReadingSeries(EXSH_GATE, exsh, exsa, { ...C, red: -1, amberMa: -1, amberRs: -1, ...cuts }).at(-1)!.rawState;
    expect(state({ red: 0 })).toBe("RED");
    expect(state({ amberMa: 0 })).toBe("AMBER");
    expect(state({ amberRs: 0 })).toBe("AMBER");
    expect(state({ red: -EPS, amberMa: -EPS, amberRs: -EPS })).toBe("GREEN");
  });
  test("fewer than trendWindow aligned closes → [] (guard-light); exactly trendWindow → one reading", () => {
    const short = up.slice(0, C.trendWindow - 1);
    expect(row.series(inputs(short, short))).toEqual([]);
    const exact = up.slice(0, C.trendWindow);
    expect(row.series(inputs(exact, exact))).toHaveLength(1);
  });
});
