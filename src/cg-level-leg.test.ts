/**
 * CG's second (LEVEL) leg + the `"split"` combine.
 *
 * Three duties: the 3×3 `combineLevelVelocity` lattices (`"split"` + the generic `"or"`, one
 * site), the head guard (an uncovered `levelBandHead` head must never score GREEN), and a
 * behavioural proof that the OPTIONAL descriptor fields left VT/EURC untouched.
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { type RatioSpreadDescriptor } from "./family-descriptor-core.js";
import {
  CG_DESCRIPTOR,
  VT_DESCRIPTOR,
  EURC_DESCRIPTOR,
  POINT_BAND_CUTS_OF,
} from "./family-descriptor-rows.js";
import { combineLevelVelocity } from "./scorers-core.js";
import {
  ratioSpreadState,
  ratioSpreadReadingSeries,
  scoreRatioSpread,
  percentileLevelState,
  levelBandHead,
  levelBandValues,
} from "./scorers-composite.js";
import { CG, VT, EURC } from "./registry-composite.js";
import { CONFIRM_CLOSES, VELOCITY_WINDOW, type Observation, type State } from "./domain-types.js";
import { PCT_MIN_OBS, expandingPercentile, smaDeviation } from "./percentile.js";
import { DEEP_LOOKBACK_DAYS } from "./lookback.js";

const S = ["GREEN", "AMBER", "RED"] as const satisfies readonly State[];

describe("combineLevelVelocity - the full 3×3 lattice per mode", () => {
  // Rows = LEVEL, cols = VELOCITY. `"and"` (a gate, not a lattice) → crisis-indicators.test.ts.
  const LATTICE: Record<"or" | "split", Record<State, Record<State, State>>> = {
    // The worse of the two legs.
    or: {
      GREEN: { GREEN: "GREEN", AMBER: "AMBER", RED: "RED" },
      AMBER: { GREEN: "AMBER", AMBER: "AMBER", RED: "RED" },
      RED: { GREEN: "RED", AMBER: "RED", RED: "RED" },
    },
    // The ruled rule: RED iff BOTH legs RED;
    // AMBER iff either leg ≥ AMBER; GREEN otherwise.
    split: {
      GREEN: { GREEN: "GREEN", AMBER: "AMBER", RED: "AMBER" },
      AMBER: { GREEN: "AMBER", AMBER: "AMBER", RED: "AMBER" },
      RED: { GREEN: "AMBER", AMBER: "AMBER", RED: "RED" },
    },
  };

  test.each((["or", "split"] as const).flatMap((m) => S.flatMap((l) => S.map((v) => [m, l, v] as const))))(
    "%s level=%s velocity=%s",
    (mode, level, velocity) => {
      expect(combineLevelVelocity(mode, level, velocity)).toBe(LATTICE[mode][level][velocity]);
    },
  );
});

// ---------------------------------------------------------------------------
/** A ratio series as two legs: leg b is constant 1, so `a/b` IS the ratio. */
function legs(values: readonly number[]): { a: Observation[]; b: Observation[] } {
  const date = (i: number) => `2${String(100000 + i)}`.slice(0, 4) + `-01-01`;
  return {
    a: values.map((v, i) => ({ date: `${date(i)}#${i}`, value: v })),
    b: values.map((_, i) => ({ date: `${date(i)}#${i}`, value: 1 })),
  };
}

/** Deterministic ratio-shaped walk: a slow decline so the level leg has a real low tail. */
function walk(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 1 + Math.sin(i / 37) * 0.15 - i / (n * 4));
}

const lb = CG_DESCRIPTOR.levelBand;
/** The head the CG arm cannot score, DERIVED — the trend window's own NaN run plus the
 *  percentile's min-obs floor. Never restated: it moves with the descriptor. */
const CG_HEAD = levelBandHead(lb);

describe("CG level leg - the SCORED SCALAR is the detrend, not the raw level", () => {
  test("levelBandValues on the CG arm IS smaDeviation over the descriptor's trend window", () => {
    // The plan's whole change in one assertion: what the percentile is taken OVER.
    const values = walk(CG_HEAD + 60);
    expect(lb.kind).toBe("detrended-expanding-percentile");
    expect(levelBandValues(values, lb)).toEqual(smaDeviation(values, lb.trendWindow));
    // ...and the detrend is NOT the identity — a fixture whose deviation equalled its level
    // would pass every assertion below under the RETIRED raw-level arm too.
    expect(levelBandValues(values, lb).slice(lb.trendWindow)).not.toEqual(values.slice(lb.trendWindow));
  });

  test("the leading NaNs never enter the percentile's own base", () => {
    // The trap: a NaN inserted into the sorted buffer corrupts every later quantile. Proof by
    // equivalence — the cut over the padded deviation series equals the cut over its finite
    // tail alone, re-padded.
    const values = walk(CG_HEAD + 60);
    const dev = levelBandValues(values, lb);
    const first = dev.findIndex(Number.isFinite);
    expect(first).toBe(lb.trendWindow - 1); // premise: there really ARE leading NaNs
    const padded = expandingPercentile(dev, lb.amberP);
    const tail = expandingPercentile(dev.slice(first), lb.amberP);
    expect(padded.slice(first)).toEqual(tail);
    expect(padded.slice(0, first).every(Number.isNaN)).toBe(true);
  });
});

// The `"expanding-percentile"` (PLAIN, undetrended) arm has NO shipped member — CG is on the
// detrended one — so nothing above reaches that branch of `levelBandHead`/`levelBandValues` and
// only `tsc` would notice it rotting. Pinned here on a SYNTHETIC descriptor band, deliberately
// not wired into any indicator.
describe("the plain (undetrended) levelBand arm - percentile-floor head, raw-series scalar", () => {
  const plain = { kind: "expanding-percentile", amberP: 0.15, redP: 0.075 } as const satisfies
    NonNullable<RatioSpreadDescriptor["levelBand"]>;

  test("its head is the bare percentile floor - no trend window is paid", () => {
    expect(levelBandHead(plain)).toBe(PCT_MIN_OBS);
    // ...and that really is SHORTER than the detrended arm's, or the assertion above would hold
    // under a levelBandHead that ignored `kind` entirely.
    expect(levelBandHead(plain)).toBeLessThan(levelBandHead(lb));
  });

  test("its scored scalar is the RAW series - a copy, never a detrend", () => {
    const values = walk(PCT_MIN_OBS + 40);
    const out = levelBandValues(values, plain);
    expect(out).toEqual(values);
    expect(out).not.toBe(values); // a copy: the caller's array is never handed back to mutate
    // Discriminating: the detrend of the SAME fixture differs, so this cannot pass on a
    // levelBandValues that always detrended.
    expect(out).not.toEqual(smaDeviation(values, 200));
  });
});

describe("CG level leg - the head emits NO reading, never a silent GREEN", () => {
  // The exact index at which the expanding cuts first go finite — derived, never restated.
  const firstFiniteCut = (n: number): number =>
    expandingPercentile(levelBandValues(walk(n), lb), lb.amberP).findIndex(Number.isFinite);

  test("levelBandHead is the head length (premise for the fixtures below)", () => {
    expect(firstFiniteCut(CG_HEAD + 50)).toBe(CG_HEAD);
  });

  test("a series shorter than the covered head yields ZERO readings (not GREEN ones)", () => {
    const n = CG_HEAD; // one short of the first finite cut
    const { a, b } = legs(walk(n));
    const out = ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b);
    expect(out).toHaveLength(0);
    expect(out.map((r) => r.state)).not.toContain("GREEN");
  });

  test("scoreRatioSpread THROWS on that same short series", () => {
    const { a, b } = legs(walk(CG_HEAD));
    expect(() => scoreRatioSpread(CG, CG_DESCRIPTOR, a, b)).toThrow();
  });

  test("the first emitted reading sits at the first FINITE cut, so no NaN cut is ever scored", () => {
    const n = CG_HEAD + 40;
    const { a, b } = legs(walk(n));
    const out = ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b);
    expect(out).toHaveLength(n - Math.max(CG_HEAD, VELOCITY_WINDOW));
    expect(out[0]!.date).toBe(a[firstFiniteCut(n)]!.date);
  });

  test("percentileLevelState refuses a non-finite cut instead of returning GREEN", () => {
    expect(() => percentileLevelState("CG", 0.5, NaN, NaN)).toThrow(/not finite/);
    expect(() => percentileLevelState("CG", 0.5, 0.4, NaN)).toThrow(/not finite/);
    // ...and still classifies normally when the cuts ARE finite (LOW, both edges strict).
    expect(percentileLevelState("CG", 0.3, 0.5, 0.4)).toBe("RED");
    expect(percentileLevelState("CG", 0.4, 0.5, 0.4)).toBe("AMBER"); // at the red cut = safe side
    expect(percentileLevelState("CG", 0.5, 0.5, 0.4)).toBe("GREEN"); // at the amber cut = safe side
  });

  test("percentileLevelState HIGH is amber-inclusive / red-strict, and refuses a non-finite cut", () => {
    // Edge test — amber/red are arbitrary ascending LOCAL probes; only the ≥/> boundaries are under test.
    const AMBER_CUT = 66;
    const RED_CUT = 73.7;
    expect(percentileLevelState("R6", RED_CUT + 1, AMBER_CUT, RED_CUT, "HIGH")).toBe("RED"); // > red
    expect(percentileLevelState("R6", RED_CUT, AMBER_CUT, RED_CUT, "HIGH")).toBe("AMBER"); // at red = not RED
    expect(percentileLevelState("R6", AMBER_CUT, AMBER_CUT, RED_CUT, "HIGH")).toBe("AMBER"); // at amber = inclusive
    expect(percentileLevelState("R6", AMBER_CUT - 1, AMBER_CUT, RED_CUT, "HIGH")).toBe("GREEN");
    expect(() => percentileLevelState("R6", AMBER_CUT + 1, NaN, RED_CUT, "HIGH")).toThrow(/not finite/);
    expect(() => percentileLevelState("R6", AMBER_CUT + 1, AMBER_CUT, NaN, "HIGH")).toThrow(/not finite/);
  });
});

describe("CG level leg - wired end to end, folded as ONE combined state", () => {
  test("the emitted state equals split(levelLeg, velocityLeg) recomputed independently", () => {
    const n = CG_HEAD + 120;
    const values = walk(n);
    const { a, b } = legs(values);
    // The level leg scores the DETRENDED scalar against percentiles of that same detrend —
    // recomputed here from the descriptor, so a units mismatch on either side reds.
    const dev = levelBandValues(values, lb);
    const amberCuts = expandingPercentile(dev, lb.amberP);
    const redCuts = expandingPercentile(dev, lb.redP);
    const out = ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b);
    const base = Math.max(CG_HEAD, VELOCITY_WINDOW);
    expect(out.length).toBeGreaterThan(0);
    // Assert on rawState so this pins the COMBINE, not the fold (under the directional tier
    // raw ≠ confirmed on stand-down cells, so the confirmed series would drag the fold in).
    out.forEach((r, k) => {
      const i = base + k;
      const velocity = ratioSpreadState(
        values[i]! / values[i - VELOCITY_WINDOW]! - 1,
        CG_DESCRIPTOR,
        CG_DESCRIPTOR.amber,
        CG_DESCRIPTOR.red,
      );
      const level = percentileLevelState("CG", dev[i]!, amberCuts[i]!, redCuts[i]!);
      expect(r.rawState, `${r.date}`).toBe(combineLevelVelocity("split", level, velocity));
    });
  });

  test("a levelBand id with no POINT_BAND_CUTS_OF rows stamps no bandCuts (never an `undefined` key)", () => {
    const { a, b } = legs(walk(CG_HEAD + 120));
    expect(POINT_BAND_CUTS_OF[VT.id]).toBeUndefined();
    // Vacuity: the same fixture under CG's own wire keys does stamp finite cuts.
    expect(ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b).some((r) => r.bandCuts != null)).toBe(true);
    expect(ratioSpreadReadingSeries(VT, CG_DESCRIPTOR, a, b).filter((r) => r.bandCuts != null)).toEqual([]);
  });

  test("a return-only RED without a depressed level is DOWNGRADED to AMBER (the whole point)", () => {
    const n = CG_HEAD + 120;
    const values = walk(n);
    const { a, b } = legs(values);
    const { levelBand: _lb, combine: _c, ...returnOnly } = CG_DESCRIPTOR;
    const before = ratioSpreadReadingSeries(CG, returnOnly as RatioSpreadDescriptor, a, b);
    const after = ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b);
    const byDate = new Map(before.map((r) => [r.date, r.rawState]));
    const downgraded = after.filter(
      (r) => byDate.get(r.date) === "RED" && r.rawState === "AMBER",
    );
    expect(downgraded.length).toBeGreaterThan(0);
    // and nothing is UPGRADED past what either leg alone could justify
    expect(after.filter((r) => r.rawState === "RED" && byDate.get(r.date) !== "RED")).toHaveLength(0);
  });

  test("each reading STAMPS the per-day level cut it scored against, under CG's wire keys (Stage 2.2)", () => {
    const n = CG_HEAD + 120;
    const values = walk(n);
    const { a, b } = legs(values);
    // The SAME expanding-percentile cuts `percentileLevelState` scored (recomputed from the
    // descriptor, so a units/index mismatch on either side reds), keyed off the wire keys
    // `api/series.ts` reads back — never a restated literal.
    const dev = levelBandValues(values, lb);
    const amberCuts = expandingPercentile(dev, lb.amberP);
    const redCuts = expandingPercentile(dev, lb.redP);
    const rows = POINT_BAND_CUTS_OF.CG!;
    const amberKey = rows.find((r) => r.level === "amber")!.key;
    const redKey = rows.find((r) => r.level === "red")!.key;
    const out = ratioSpreadReadingSeries(CG, CG_DESCRIPTOR, a, b);
    const base = Math.max(CG_HEAD, VELOCITY_WINDOW);
    let stamped = 0;
    out.forEach((r, k) => {
      const i = base + k;
      // The threaded cut is the number the scorer classified this row against — exact, not a re-derivation.
      expect(r.bandCuts?.[amberKey], `${r.date} amber`).toBe(amberCuts[i]);
      expect(r.bandCuts?.[redKey], `${r.date} red`).toBe(redCuts[i]);
      if (r.bandCuts != null) stamped++;
    });
    // Vacuity guard: the fixture must reach the regime where a finite cut is actually stamped.
    expect(stamped).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("the optional fields left the other ratio-spread ids untouched", () => {
  const OTHERS = {
    VT: [VT, VT_DESCRIPTOR],
    EURC: [EURC, EURC_DESCRIPTOR],
  } as const;

  // BEHAVIOURAL, not a field check: every emitted state must still be the bare
  // `ratioSpreadState` of that day's scalar, starting at the UNWIDENED baseOffset.
  test.each(Object.entries(OTHERS))("%s scores exactly as the single-leg stack did", (id, [ind, desc]) => {
    const d = desc as RatioSpreadDescriptor;
    const n = CG_HEAD + 60; // longer than CG's head, so a widened baseOffset would show
    const values = walk(n).map((v) => (d.cutKind === "spread" ? v : v + 0.5));
    const { a, b } = legs(values);
    const raw = d.cutKind === "spread" ? values.map((v) => v - 1) : values;
    const out = ratioSpreadReadingSeries(ind, d, a, b);
    expect(out, `${id} start offset`).toHaveLength(n - VELOCITY_WINDOW);
    out.forEach((r, k) => {
      const i = VELOCITY_WINDOW + k;
      const scalar = d.cutKind === "return" ? raw[i]! / raw[i - VELOCITY_WINDOW]! - 1 : raw[i]!;
      expect(r.rawState, `${id} ${r.date}`).toBe(ratioSpreadState(scalar, d, d.amber, d.red));
    });
  });
});

// ---------------------------------------------------------------------------
test("POINT_BAND_CUTS_OF.CG derives its percentiles from CG_DESCRIPTOR.levelBand", () => {
  const cuts = POINT_BAND_CUTS_OF.CG!;
  expect(cuts.find((c) => c.level === "amber")!.p).toBe(CG_DESCRIPTOR.levelBand.amberP);
  expect(cuts.find((c) => c.level === "red")!.p).toBe(CG_DESCRIPTOR.levelBand.redP);
  // ...and the drawn pair is ordered the way the LOW-direction level leg reads it.
  expect(CG_DESCRIPTOR.levelBand.redP).toBeLessThan(CG_DESCRIPTOR.levelBand.amberP);
});

// ---------------------------------------------------------------------------
// An EXPANDING percentile is a function of the history its CALLER passes, and nothing in
// `ratioSpreadReadingSeries` can enforce that. The default (shallow) price fetch is
// `range=2y`, which would silently turn CG's "expanding" level cut into a ROLLING ~2-year
// percentile AND leave `scoreRatioSpread`'s `levelBandHead + CONFIRM_CLOSES` floor covered by
// only ~2x — a holiday-thinned window or an inner-join mismatch between HG=F and GC=F could
// then drop CG from the run behind its `degrade()` with only a log line. Both are pinned here.
describe("CG's cron fetch supplies the level leg's history", () => {
  // Source-level, deliberately: the confirmer's fetch options are not observable from a pure
  // call, and the alternative (a vitest spy on the price module) would move this file into
  // the isolated vitest project for one assertion.
  const CONFIRMERS_SRC = readFileSync(new URL("./confirmers.ts", import.meta.url), "utf8");
  // Comment lines stripped FIRST — the CG entry's own docblock names `{ deep: true }`, so an
  // unstripped grep would pass on the prose alone and could never fail on the code.
  const CG_ENTRY = CONFIRMERS_SRC.slice(
    CONFIRMERS_SRC.indexOf('id: "CG"'),
    CONFIRMERS_SRC.indexOf('id: "VT"'),
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join(" ")
    .replace(/\s+/g, " ");

  test("both legs are fetched with { deep: true }", () => {
    // Vacuity floor: the slice really is the CG confirmer's CODE, not just its comments. The DB-first
    // seam (stage 4.2) replaced the direct `scoreRatioSpread` call with `latestRatioSpread` over the
    // seam's readings; the deep arm's `{ deep: true }` fetch is what this test still pins below.
    expect(CG_ENTRY).toContain("latestRatioSpread(CG, CG_DESCRIPTOR");
    for (const symbol of CG_DESCRIPTOR.inputs) {
      expect(CG_ENTRY, `${symbol} deep fetch`).toContain(`fetchDailyCloses("${symbol}", { deep: true, lookbackDays: cgLookbackDays(new Date(ctx.runAt)), now: () => Date.parse(ctx.runAt), env: ctx.env })`);
    }
  });

  test("the deep window clears the level leg's min-obs floor with room to spare", () => {
    // `scoreRatioSpread` throws below this many ALIGNED closes once a levelBand is present.
    // DERIVED from the descriptor: the detrend (2026-08-08) roughly doubled this floor by adding
    // the trend window's NaN run on top of PCT_MIN_OBS, which is exactly why it is re-pinned here.
    const floor = levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES;
    // Trading days a DEEP_LOOKBACK_DAYS calendar window is guaranteed to contain (~252/365).
    const deepTradingDays = Math.floor(DEEP_LOOKBACK_DAYS * (252 / 365));
    // 10× was true of the pre-detrend floor and is still true of this one (5,040 vs 453) — but
    // the margin is now ~11×, not ~20×, so a second trend-window-sized widening would bind.
    expect(deepTradingDays).toBeGreaterThan(floor * 10);
    // Measured 2026-08-08 against the live closes provider: deep HG=F = 5,030 closes and
    // GC=F = 5,027, inner-joining to 5,026 aligned closes from 2006-08-14 — comfortably past
    // this derived floor and past CG's ~3,776 stored rows (2011-08-02 on), which is the depth
    // `/api/series` draws the same cut over. The SHALLOW fetch measured 503 aligned closes.
    expect(deepTradingDays).toBeGreaterThan(4000);
  });
});
