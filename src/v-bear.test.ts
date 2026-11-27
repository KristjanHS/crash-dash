import { describe, expect, it } from "vitest";
import {
  BEAR_DWELL_CLOSES,
  FALL_SHAPE_CONFIDENCE_COPY,
  FALL_SHAPE_CONFIDENCE_VALUES,
  V_MIN_DRAWDOWN,
  V_VELOCITY_CUT,
  applyFallShape,
  classifyFallShape,
  creditDwellCloses,
  drawdownGateWouldFire,
  fallShapeConfidence,
  fallVelocity,
} from "./v-bear.js";
import type { FallShape, FallShapeConfidence } from "./v-bear.js";
import type { CashOverlayResult } from "./cash-overlay.js";
import { PENSION_DIP } from "./pension.js";
import { VELOCITY_WINDOW } from "./domain-types.js";
import { ARM_ROC_WINDOW } from "./exposure.js";
import type { State } from "./domain-types.js";
import type { SeriesPoint } from "./store.js";

/**
 * A fall of `dd` spread linearly over `closes` trading days, preceded by a rising `lead` so the
 * peak sits INSIDE the window (otherwise `peakClipped` fires, as it must — see the clip tests).
 * The drawdown and velocity are OUTPUTS — read them off `fallVelocity`, never hand-typed
 * beside the cut that produces them (`.claude/rules/testing-project.md`).
 */
function fallSeries(dd: number, closes: number, lead = 5): number[] {
  const out = Array.from({ length: lead }, (_, i) => 100 - (lead - 1 - i));
  for (let i = 1; i <= closes; i++) out.push(100 * (1 + (dd * i) / closes));
  return out;
}

/** `n` credit closes, oldest-first, whose newest `redTail` closes are confirmed RED. */
function creditPoints(n: number, redTail: number): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const state: State = i >= n - redTail ? "RED" : "GREEN";
    return {
      date: `2026-01-${String(i + 1).padStart(3, "0")}`,
      value: 0,
      delta20: 0,
      rawState: state,
      state,
    };
  });
}

const LONG_GREEN_CREDIT = creditPoints(BEAR_DWELL_CLOSES * 2, 0);
const LONG_RED_CREDIT = creditPoints(BEAR_DWELL_CLOSES * 2, BEAR_DWELL_CLOSES);

describe("cut derivation - by symbol, never by literal", () => {
  // The only derivation pin: the classifier boundary pair below stays green on a cut moved to
  // PENSION_DIP / 30, so only this test ties each cut to its source symbol.
  it("derives each cut from a pre-existing symbol", () => {
    expect(V_VELOCITY_CUT).toBe(PENSION_DIP / VELOCITY_WINDOW);
    expect(V_MIN_DRAWDOWN).toBe(PENSION_DIP);
    expect(BEAR_DWELL_CLOSES).toBe(ARM_ROC_WINDOW);
  });

  it("classifies a fall exactly at the derived cut as fast", () => {
    // dd = PENSION_DIP completed inside VELOCITY_WINDOW closes ⇒ velocity sits on V_VELOCITY_CUT.
    const closes = fallSeries(PENSION_DIP, VELOCITY_WINDOW);
    expect(fallVelocity(closes)!.velocity).toBeLessThanOrEqual(V_VELOCITY_CUT);
    expect(classifyFallShape(closes, LONG_GREEN_CREDIT, LONG_GREEN_CREDIT).shape).toBe("v-shaped");
  });

  it("classifies the same fall spread over twice the window as not fast", () => {
    const closes = fallSeries(PENSION_DIP, VELOCITY_WINDOW * 2);
    expect(fallVelocity(closes)!.velocity).toBeGreaterThan(V_VELOCITY_CUT);
    expect(classifyFallShape(closes, LONG_RED_CREDIT, LONG_RED_CREDIT).shape).toBe("bear");
  });
});

describe("fallVelocity", () => {
  it("returns null with no closes - never a number from no data", () => {
    expect(fallVelocity([])).toBeNull();
  });

  it("measures velocity as drawdown per close since the peak", () => {
    const fall = fallVelocity(fallSeries(-0.34, 23))!;
    expect(fall.closesSincePeak).toBe(23);
    expect(fall.velocity).toBeCloseTo(fall.dd / fall.closesSincePeak, 12);
  });

  it("reports no fall at a fresh peak", () => {
    const fall = fallVelocity([100, 110, 120])!;
    expect(fall.dd).toBe(0);
    expect(fall.closesSincePeak).toBe(0);
    expect(fall.velocity).toBe(0);
  });

  it("takes the TRAILING peak, not the first one", () => {
    // Falls, recovers to a NEW high, then falls again: the peak is the new high.
    const closes = [100, 80, 100, 130, 120, 110];
    const fall = fallVelocity(closes)!;
    expect(fall.closesSincePeak).toBe(2);
    expect(fall.dd).toBeCloseTo(110 / 130 - 1, 12);
  });

  it("clipping the peak shallows dd but INFLATES |velocity| - the plan's stated direction is wrong", () => {
    const full = fallSeries(-0.55, 350);
    const clipped = full.slice(-275); // the 400-day lookback cannot hold a 350-close grind + peak
    const fullFall = fallVelocity(full)!;
    const clippedFall = fallVelocity(clipped)!;
    expect(clippedFall.dd).toBeGreaterThan(fullFall.dd); // shallower — this half of the claim holds
    // ...but closesSincePeak drops faster than dd does, pushing velocity TOWARD the cut.
    expect(clippedFall.velocity).toBeLessThan(fullFall.velocity);
    expect(Math.abs(clippedFall.velocity / fullFall.velocity)).toBeGreaterThan(1.1);
  });

  it("flags a window that opens on its own high as peakClipped", () => {
    expect(fallVelocity(fallSeries(-0.55, 350).slice(-275))!.peakClipped).toBe(true);
    expect(fallVelocity(fallSeries(-0.55, 350))!.peakClipped).toBe(false);
  });

  it("sends a clipped peak to indeterminate - today's behaviour, structurally", () => {
    const clipped = fallSeries(-0.55, 350).slice(-275);
    const verdict = classifyFallShape(clipped, LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(verdict.shape).toBe("indeterminate");
    expect(verdict.reason).toMatch(/clipped/);
  });
});

describe("creditDwellCloses", () => {
  it("returns null when neither id has BEAR_DWELL_CLOSES rows - short history is never a number", () => {
    const short = creditPoints(BEAR_DWELL_CLOSES - 1, BEAR_DWELL_CLOSES - 1);
    expect(creditDwellCloses(short, short)).toBeNull();
  });

  it("counts consecutive RED closes at the newest end", () => {
    expect(creditDwellCloses(creditPoints(BEAR_DWELL_CLOSES * 2, 7), LONG_GREEN_CREDIT)).toBe(7);
  });

  it("takes the max over F1/F2 - matching creditBlowout's EITHER predicate", () => {
    const f1 = creditPoints(BEAR_DWELL_CLOSES * 2, 3);
    const f2 = creditPoints(BEAR_DWELL_CLOSES * 2, 11);
    expect(creditDwellCloses(f1, f2)).toBe(11);
    expect(creditDwellCloses(f2, f1)).toBe(11);
  });

  // ⚠ The dangerous direction, and the one an earlier per-id filter got wrong: a short id that is
  // ALL RED carries the evidence for `bear`, and excluding it reported "RED only 0 closes" ⇒
  // v-shaped. Both orders, because the bug was asymmetric in the argument position.
  it("nulls when EITHER id is short - a short all-RED id must never be excluded", () => {
    const shortAllRed = creditPoints(BEAR_DWELL_CLOSES - 1, BEAR_DWELL_CLOSES - 1);
    const longGreen = creditPoints(BEAR_DWELL_CLOSES * 2, 0);
    expect(creditDwellCloses(longGreen, shortAllRed)).toBeNull();
    expect(creditDwellCloses(shortAllRed, longGreen)).toBeNull();
    // The whole point: this combination must not reach the behaviour-changing class.
    expect(classifyFallShape(fallSeries(-0.34, 23), longGreen, shortAllRed).shape).toBe(
      "indeterminate",
    );
    expect(classifyFallShape(fallSeries(-0.34, 23), shortAllRed, longGreen).shape).toBe(
      "indeterminate",
    );
  });
});

/**
 * ⚠ REGRESSION PIN, **NOT VALIDATION**. These three shapes are DEC-3's stated episodes. Passing
 * proves only that the shipped cut has not silently moved — it is ZERO evidence that the
 * V-vs-bear hypothesis is true. DEC-3 says so itself: *"Do not let the table's cleanliness read as
 * evidence."* n≈6. Only D-E3 episode replay can validate; no constant here may EVER be re-derived
 * from a replay result — if a replay disagrees, surface the disagreement (§3.2).
 *
 * The two grinds are fed UNCLIPPED here, as DEC-3 states them. In prod the 400-day window would
 * clip both and `peakClipped` would send them to `indeterminate` — also today's behaviour, so the
 * pin and the live path agree on "not v-shaped" by two different routes.
 */
describe("DEC-3 episode regression pin", () => {
  const EPISODES: Array<{ name: string; dd: number; closes: number; expected: string; credit: SeriesPoint[] }> = [
    { name: "2020 - fast crash", dd: -0.34, closes: 23, expected: "v-shaped", credit: LONG_GREEN_CREDIT },
    { name: "2008 - long grind", dd: -0.55, closes: 350, expected: "bear", credit: LONG_RED_CREDIT },
    { name: "2022 - long grind", dd: -0.25, closes: 282, expected: "bear", credit: LONG_RED_CREDIT },
  ];

  for (const ep of EPISODES) {
    it(`still classifies ${ep.name} as ${ep.expected}`, () => {
      const closes = fallSeries(ep.dd, ep.closes);
      // The velocity is an OUTPUT of the fixture, never hand-typed beside the cut.
      const measured = fallVelocity(closes)!.velocity;
      expect(classifyFallShape(closes, ep.credit, ep.credit).shape).toBe(ep.expected);
      // The message names the number against the cut, so a failure is not a bare "false to be true".
      expect(measured <= V_VELOCITY_CUT, `velocity ${measured} vs cut ${V_VELOCITY_CUT}`).toBe(ep.expected === "v-shaped");
    });
  }
});

describe("classifyFallShape", () => {
  it("is indeterminate with no closes", () => {
    expect(classifyFallShape([], LONG_RED_CREDIT, LONG_RED_CREDIT).shape).toBe("indeterminate");
  });

  it("is indeterminate for a fall shallower than V_MIN_DRAWDOWN", () => {
    const closes = fallSeries(V_MIN_DRAWDOWN / 2, 5);
    expect(classifyFallShape(closes, LONG_GREEN_CREDIT, LONG_GREEN_CREDIT).shape).toBe(
      "indeterminate",
    );
  });

  it("is indeterminate on a short credit history, even with a fast fall", () => {
    const short = creditPoints(BEAR_DWELL_CLOSES - 1, 0);
    const verdict = classifyFallShape(fallSeries(-0.34, 23), short, short);
    expect(verdict.shape).toBe("indeterminate");
    expect(verdict.dwell).toBeNull();
  });

  it("is v-shaped on a fast fall with credit RED for less than the dwell window", () => {
    const verdict = classifyFallShape(fallSeries(-0.34, 23), LONG_GREEN_CREDIT, LONG_GREEN_CREDIT);
    expect(verdict.shape).toBe("v-shaped");
    expect(verdict.dwell).toBe(0);
  });

  it("is bear on a slow fall with credit grinding past the dwell window", () => {
    const verdict = classifyFallShape(fallSeries(-0.55, 350), LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(verdict.shape).toBe("bear");
    expect(verdict.dwell).toBe(BEAR_DWELL_CLOSES);
  });

  it("is indeterminate when the inputs disagree - fast fall, grinding credit", () => {
    expect(classifyFallShape(fallSeries(-0.34, 23), LONG_RED_CREDIT, LONG_RED_CREDIT).shape).toBe(
      "indeterminate",
    );
  });

  it("is indeterminate when the inputs disagree - slow fall, fresh credit", () => {
    expect(
      classifyFallShape(fallSeries(-0.55, 350), LONG_GREEN_CREDIT, LONG_GREEN_CREDIT).shape,
    ).toBe("indeterminate");
  });
});

/**
 * Stage 5.1 — `fallShapeConfidence`, the four-valued WHY behind a persisted `indeterminate`.
 *
 * ⚠ VACUITY HAZARD, and why four of the five rows below drive the REAL `classifyFallShape`: the
 * function is a 4-line ladder over the persisted triple, so a suite that only fed it hand-typed
 * triples would pin the ladder against itself and could not see the mapping disagree with the
 * classifier it describes. Each row here CONSTRUCTS the branch through the real classifier and
 * then reads the key off that verdict's own triple. The enumerated 12-combination table is the
 * separate totality duty — it is allowed to be hand-typed, because the input product is the claim.
 *
 * Red demo (run 2026-07-26): changing the `conflicting` row's return to `"no-fall"` reddens
 * "reads `conflicting` when the two axes DISAGREE …" on the disagreement verdict.
 */
describe("fallShapeConfidence (Stage 5.1 - the persisted triple's own confidence)", () => {
  it("reads `measured` for both classified shapes, through the real classifier", () => {
    const v = classifyFallShape(fallSeries(-0.34, 23), LONG_GREEN_CREDIT, LONG_GREEN_CREDIT);
    expect(v.shape).toBe("v-shaped");
    expect(fallShapeConfidence(v.shape, v.velocity, v.dwell)).toBe("measured");

    const b = classifyFallShape(fallSeries(-0.55, 350), LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(b.shape).toBe("bear");
    expect(fallShapeConfidence(b.shape, b.velocity, b.dwell)).toBe("measured");
  });

  // THE discriminating row: the ONE `indeterminate` branch that carries live evidence on both
  // axes. `dwell != null` is reachable only from here (the four "nothing measured" branches all
  // return `dwell: null` before `creditDwellCloses` is consulted), which is what makes this key
  // derivable from the triple at all.
  it("reads `conflicting` when the two axes DISAGREE - a fast fall on grinding credit", () => {
    const v = classifyFallShape(fallSeries(-0.34, 23), LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(v.shape).toBe("indeterminate");
    // Fixture guard: this is the disagreement branch, not one of the four absence branches.
    expect(v.dwell).not.toBeNull();
    expect(v.reason).toContain("disagree");
    expect(fallShapeConfidence(v.shape, v.velocity, v.dwell)).toBe("conflicting");
  });

  it("reads `no-fall` on a fall too shallow to classify - velocity measured, dwell never consulted", () => {
    const v = classifyFallShape(fallSeries(V_MIN_DRAWDOWN / 2, 5), LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(v.shape).toBe("indeterminate");
    expect(v.velocity).not.toBeNull();
    expect(v.dwell).toBeNull();
    expect(fallShapeConfidence(v.shape, v.velocity, v.dwell)).toBe("no-fall");
  });

  // The short-credit-history branch is an ABSENCE too, not a conflict: `creditDwellCloses` nulls
  // the whole verdict, so the triple is (indeterminate, velocity, null) exactly like the shallow
  // and clipped rows. Same key — which is the point of the table being over the TRIPLE.
  it("reads `no-fall` on a short credit history and on a clipped peak", () => {
    const short = creditPoints(BEAR_DWELL_CLOSES - 1, 0);
    const s = classifyFallShape(fallSeries(-0.34, 23), short, short);
    expect(s.dwell).toBeNull();
    expect(fallShapeConfidence(s.shape, s.velocity, s.dwell)).toBe("no-fall");

    const c = classifyFallShape(fallSeries(-0.55, 350).slice(-275), LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(c.shape).toBe("indeterminate");
    expect(fallVelocity(fallSeries(-0.55, 350).slice(-275))!.peakClipped).toBe(true);
    expect(fallShapeConfidence(c.shape, c.velocity, c.dwell)).toBe("no-fall");
  });

  it("reads `dark` when the feed is down - no closes, so neither axis exists", () => {
    const v = classifyFallShape([], LONG_RED_CREDIT, LONG_RED_CREDIT);
    expect(v.reason).toBe("no closes");
    expect(v.velocity).toBeNull();
    expect(fallShapeConfidence(v.shape, v.velocity, v.dwell)).toBe("dark");
  });

  /**
   * totality over the input product — all 12 `(shape, velocity==null?, dwell==null?)` combinations,
   * ENUMERATED rather than sampled, so no combination can fall through to `undefined` and no future
   * row can be reordered silently. Hand-typed on purpose: the product IS the claim here.
   */
  const totality: Array<[FallShape, number | null, number | null, FallShapeConfidence]> = [
    ["v-shaped", -0.012, 3, "measured"],
    ["v-shaped", -0.012, null, "measured"],
    ["v-shaped", null, 3, "measured"],
    ["v-shaped", null, null, "measured"],
    ["bear", -0.001, 40, "measured"],
    ["bear", -0.001, null, "measured"],
    ["bear", null, 40, "measured"],
    ["bear", null, null, "measured"],
    // `dwell != null` outranks the velocity row — see the ordering note on the function.
    ["indeterminate", -0.012, 40, "conflicting"],
    ["indeterminate", -0.012, null, "no-fall"],
    ["indeterminate", null, 40, "conflicting"],
    ["indeterminate", null, null, "dark"],
  ];

  it("is TOTAL over all 12 (shape, velocity-null, dwell-null) combinations", () => {
    // Vacuity guards: the table really is the full product, and it exercises every key — a table
    // that had lost rows (or only ever hit `measured`) would still pass the loop below.
    expect(totality.length).toBe(12);
    expect(new Set(totality.map(([s, v, d]) => `${s}|${v == null}|${d == null}`)).size).toBe(12);
    expect(new Set(totality.map((r) => r[3]))).toEqual(new Set(FALL_SHAPE_CONFIDENCE_VALUES));

    for (const [shape, velocity, dwell, expected] of totality) {
      const got = fallShapeConfidence(shape, velocity, dwell);
      expect(got, `${shape} / velocity ${velocity} / dwell ${dwell}`).toBe(expected);
      expect(FALL_SHAPE_CONFIDENCE_VALUES).toContain(got);
    }
  });

  // `0` is a LEGAL value on both axes — a v-shaped fall pins `dwell: 0`, and a close sitting AT the
  // trailing peak pins `velocity: 0`. A truthiness test (`if (dwell)`) would misroute both.
  it("discriminates null from a falsy 0 on both axes", () => {
    expect(fallShapeConfidence("indeterminate", -0.012, 0)).toBe("conflicting");
    expect(fallShapeConfidence("indeterminate", 0, null)).toBe("no-fall");
  });

  it("gives every key copy that cannot be read as reassurance", () => {
    for (const key of FALL_SHAPE_CONFIDENCE_VALUES) {
      expect(FALL_SHAPE_CONFIDENCE_COPY[key]!.length, key).toBeGreaterThan(0);
    }
    // Distinct copy per key: a shared string would make the four-valued wire key undisplayable.
    expect(new Set(Object.values(FALL_SHAPE_CONFIDENCE_COPY)).size).toBe(4);
    // The ruling, literally: the two axes DISAGREE, and a bear is NOT excluded.
    expect(FALL_SHAPE_CONFIDENCE_COPY.conflicting).toContain("DISAGREE");
    expect(FALL_SHAPE_CONFIDENCE_COPY.conflicting).toContain("NOT excluded");
    // The two absence keys must each DENY the all-clear reading rather than merely omitting it.
    expect(FALL_SHAPE_CONFIDENCE_COPY["no-fall"]).toContain("not an all-clear");
    expect(FALL_SHAPE_CONFIDENCE_COPY.dark).toContain("not a calm read");
  });
});

/**
 * Stage 2.1 — the influence seam (wired at Stage 5.1 by `run-core.ts`'s single `applyFallShape` call on
 * the cash overlay's output). The falsifier this rung owes is a PAIR: the flag
 * off must be the byte-identical identity, and the flag on must actually suppress. Deleting the
 * `!enabled` term from the guard turns the first red; deleting the `shape !== "v-shaped"` term
 * turns the bear/indeterminate rows red. (Demonstrated: both mutations were run and went red.)
 */
describe("applyFallShape (W5-d influence seam)", () => {
  const partial: CashOverlayResult = {
    level: "partial",
    since: "2026-06-27T00:00:00Z",
    reason: "target rung 3→5 (+2) within 3 closes",
    nonEquityPct: null,
    recentTargetRungs: [3, 4, 5],
  };

  it("is the identity on every shape while the flag is off - same object, nothing copied", () => {
    for (const shape of ["v-shaped", "bear", "indeterminate"] as const) {
      // `toBe`, not `toEqual`: the plan's "byte-identical to x" is an identity claim, and a
      // structural check would pass on a clone that had silently dropped a future field.
      expect(applyFallShape(partial, shape, false)).toBe(partial);
    }
    // The SHIPPED default (flag now true) is the identity for the two non-diverging shapes only —
    // `v-shaped` is the one class that changes behaviour, pinned by the suppression test below.
    for (const shape of ["bear", "indeterminate"] as const) {
      expect(applyFallShape(partial, shape)).toBe(partial);
    }
  });

  it("suppresses the overlay on a v-shaped fall once the flag is on", () => {
    const out = applyFallShape(partial, "v-shaped", true);
    expect(out.level).toBe("off");
    // `level: "off"` ⇒ `since: null` is a repo-wide invariant (see computeCashOverlay's off
    // branches) — a suppressed overlay must not render as "partial since …".
    expect(out.since).toBeNull();
    expect(out.reason).toContain("v-shaped fall - early overlay suppressed");
    // The original reason survives inside it, so /lab can still say WHAT was suppressed.
    expect(out.reason).toContain(partial.reason);
  });

  it("passes recentTargetRungs through untouched (faithful pass-through of the opaque result)", () => {
    // The suppression rewrites level/since/reason and NOTHING else. `recentTargetRungs` is not
    // persisted (the window is rebuilt each run from `dial_target_rung`), but a caller reading it
    // must see the same value it would have seen without the suppression.
    expect(applyFallShape(partial, "v-shaped", true).recentTargetRungs).toEqual([3, 4, 5]);
  });

  it("leaves bear and indeterminate alone even with the flag on - only ONE class diverges", () => {
    expect(applyFallShape(partial, "bear", true)).toBe(partial);
    expect(applyFallShape(partial, "indeterminate", true)).toBe(partial);
  });

  it("never mutates its input (mirrors computeCashOverlay's pinned purity property)", () => {
    const before = structuredClone(partial);
    applyFallShape(partial, "v-shaped", true);
    expect(partial).toEqual(before);
  });
});

/**
 * W5-e — the drawdown-gate PROBE. Measurement only; nothing here steers behaviour, and no assertion
 * below may become a behaviour claim.
 *
 * ⚠ VACUITY HAZARD: on a calm fixture the v-bear path is a total no-op — every shape is
 * `indeterminate` and every probe arm reads `false`, so a suite built there would pin only the `off`
 * branch and pass identically with the predicate inverted. The totality row below pins BOTH arms of
 * the one-liner; the shapes that reach its `true` arm (bear on a grinding unclipped decline, v-shaped
 * on a fast fall, indeterminate on a clipped peak or no closes) are the `classifyFallShape` block's own
 * pins, so they are not re-driven here.
 *
 * (Demonstrated red by mutation — but see the shallow arm's own note: the mutation the plan's table
 * originally named for it does NOT kill it, and the comment there names the two that do.)
 */
describe("drawdownGateWouldFire (W5-e probe)", () => {
  it("is total over FallShape - only indeterminate reads false", () => {
    expect(drawdownGateWouldFire("v-shaped")).toBe(true);
    expect(drawdownGateWouldFire("bear")).toBe(true);
    expect(drawdownGateWouldFire("indeterminate")).toBe(false);
  });

  // The §4 implication, driven through the REAL classifier: the dd gate IS classifyFallShape's own
  // first substantive branch, so a fall just SHALLOWER than the cut must read false. Pinning the
  // one-liner instead would prove nothing.
  // ⚠ What kills this: DELETING the dd branch, or loosening the cut by ~1pp. What does NOT:
  // moving that branch's `>` to `>=` — the fixture sits at dd ≈ -0.149, and the two operators
  // differ only at dd === -0.15 exactly, which no fixture here reaches. The plan's table named the
  // `>=` mutation; it was wrong, and this note is the correction (2026-07-20 review, finding 1).
  // ⚠ The credit arm is GREEN and the fall is FAST deliberately: with the dd branch removed this
  // fixture classifies `v-shaped` ⇒ probe TRUE, so the assertion goes red on exactly that branch.
  // Fed grinding credit instead it would land on the disagreement row and stay `indeterminate`
  // under BOTH the real and the mutated classifier — a mutation the test could never see.
  it("reads false for a fall just shallower than V_MIN_DRAWDOWN", () => {
    const shallow = fallSeries(V_MIN_DRAWDOWN + 0.001, 5);
    expect(fallVelocity(shallow)!.dd).toBeGreaterThan(V_MIN_DRAWDOWN);
    expect(fallVelocity(shallow)!.velocity).toBeLessThanOrEqual(V_VELOCITY_CUT);
    const verdict = classifyFallShape(shallow, LONG_GREEN_CREDIT, LONG_GREEN_CREDIT);
    expect(verdict.shape).toBe("indeterminate");
    expect(drawdownGateWouldFire(verdict.shape)).toBe(false);
  });
});
