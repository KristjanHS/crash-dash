/**
 * Golden family tests (Stage 3 slice 3.3, design §3.4).
 *
 * One describe per FamilyId. Membership rows derive from `FAMILY_OF` (production source);
 * per-family-class assertions check each member resolves its descriptor instance /
 * non-empty registry thresholds. Cut-shape rows derive expectations from the descriptor —
 * SHAPE, not VALUE (testing-project.md fixture-from-the-cut rule): the synthetic inputs are built
 * FROM the cut, so a retune moves the fixture with it. No test pins a constant's VALUE.
 *
 * Tree reconciliation (2026-07-24, observed — the spec's class table was a prediction):
 * price-derived members F5 / SPCONC / NVDA have NO `*_DESCRIPTOR` instance in
 * family-descriptor-rows.ts; their scorer wiring lives in the registry's `PRICE_SCORERS`
 * table (scorer-as-data). The census test below therefore splits price-derived into
 * descriptor-backed ∪ registry-wired and pins that the split is exhaustive.
 */
import { describe, expect, test } from "vitest";

import type { State } from "./domain-types.js";
import {
  type BespokeRef,
  type CompositeScorerRef,
  VELOCITY_MEASURES,
  type FamilyId,
  type RatioSpreadDescriptor,
} from "./family-descriptor-core.js";
import {
  CQS_DESCRIPTOR,
  BONOS_DESCRIPTOR,
  R6_DESCRIPTOR,
  BRENT_DESCRIPTOR,
  OVX_DESCRIPTOR,
  BUND_DESCRIPTOR,
  CG_DESCRIPTOR,
  DB_SMH_DESCRIPTOR,
  RS_SMH_DESCRIPTOR,
  RS_XLK_DESCRIPTOR,
  KBE_RS_DESCRIPTOR,
  INS_RS_DESCRIPTOR,
  EXSH_GATE_DESCRIPTOR,
  AT1_DESCRIPTOR,
  DB_XLK_DESCRIPTOR,
  DISP_DESCRIPTOR,
  ECY_DESCRIPTOR,
  EURC_DESCRIPTOR,
  EPATH_DESCRIPTOR,
  ESTR_DESCRIPTOR,
  EURGBP_DESCRIPTOR,
  F13_DESCRIPTOR,
  F4_DESCRIPTOR,
  F6_DESCRIPTOR,
  F8_DESCRIPTOR,
  FAMILY_OF,
  FXH_DESCRIPTOR,
  G1_DESCRIPTOR,
  NG_DESCRIPTOR,
  GB_DESCRIPTOR,
  GT_DESCRIPTOR,
  R7_DESCRIPTOR,
  VT_DESCRIPTOR,
  VXNT_DESCRIPTOR,
  VTP_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";
import { DOWNSIDE_DETECTOR_IDS, PRICE_SCORERS } from "./registry-price.js";
import * as scorersCore from "./scorers-core.js";
import * as scorersPrice from "./scorers-price.js";
import * as scorersComposite from "./scorers-composite.js";
import { ratioSpreadState } from "./scorers-composite.js";
import { VIX_SYMBOL, VIX3M_SYMBOL } from "./vix_term.js";

/** Every export of the three scorer split files — a BespokeRef must name a function in one of them. */
const scorers: Record<string, unknown> = { ...scorersCore, ...scorersPrice, ...scorersComposite };

const membersOf = (family: FamilyId): string[] =>
  Object.entries(FAMILY_OF)
    .filter(([, tag]) => tag === family)
    .map(([id]) => id);

const byId = new Map(ALL_INDICATORS.map((i) => [i.id, i]));

/** BespokeRef class assertion: `ref` names an exported FUNCTION of a src/scorers-{core,price,composite}.ts split file and
 *  every tunable in `constants` is a finite number OR null (a null cut leg is a DISARMED band —
 *  F6's RED-only row; NaN/undefined still red) OR a `VELOCITY_MEASURES` member. Number.isFinite(-0) is true, so the F13
 *  negative-zero amber passes — the -0 identity itself is golden-covered, not pinned here.
 *  Soft asserts: each family's per-member rows run as ONE looped test, and a red still names every failing member. */
function expectBespokeRef(id: string, ref: BespokeRef | CompositeScorerRef): void {
  expect.soft(
    typeof scorers[ref.ref],
    `${id}: scorer.ref "${ref.ref}" must name an exported function of src/scorers-{core,price,composite}.ts`,
  ).toBe("function");
  for (const [key, value] of Object.entries(ref.constants)) {
    const ok =
      value === null ||
      (typeof value === "string" ? (VELOCITY_MEASURES as readonly string[]).includes(value) : Number.isFinite(value));
    expect.soft(ok, `${id}: scorer constant "${key}" must be finite, null or a VELOCITY_MEASURES member`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
describe("family golden: fred-level-velocity", () => {
  const members = membersOf("fred-level-velocity");

  test("membership census is non-empty", () => {
    expect(members.length).toBeGreaterThan(0);
  });

  test("every member: registry Indicator with non-empty finite thresholds", () => {
    const sigmas: { id: string; cfg: { window: number; minObs: number } }[] = [];
    for (const id of members) {
      const ind = byId.get(id);
      expect.soft(ind, `${id} must be in ALL_INDICATORS`).toBeDefined();
      if (!ind) continue;
      // Read the PRE-multiplier pair when a ThresholdConfig scaled the live one.
      const t = ind.rawThresholds ?? ind.thresholds;
      const entries = Object.entries(t).filter(([, v]) => v != null);
      expect.soft(entries.length, `${id} thresholds must be non-empty`).toBeGreaterThan(0);
      // `velocitySigma` (2026-08-08) is the one NON-scalar member of `Thresholds` — a
      // {window, minObs} config that declares the velocity pair's UNITS, not a cut. Check its
      // own shape rather than exempting it, else a malformed σ config passes this census.
      for (const [key, value] of entries.filter(([k]) => k !== "velocitySigma")) {
        expect.soft(Number.isFinite(value), `${id} thresholds.${key} must be finite`).toBe(true);
      }
      for (const [, value] of entries.filter(([k]) => k === "velocitySigma")) sigmas.push({ id, cfg: value as { window: number; minObs: number } });
    }
    expect(sigmas.length).toBeGreaterThan(0);
    for (const { id, cfg } of sigmas) {
      expect.soft(Number.isFinite(cfg.window) && cfg.window > 0, `${id} velocitySigma.window`).toBe(true);
      expect.soft(Number.isFinite(cfg.minObs) && cfg.minObs > 0, `${id} velocitySigma.minObs`).toBe(true);
      expect.soft(cfg.minObs <= cfg.window, `${id} velocitySigma.minObs must fit inside its window`).toBe(true);
    }
  });

});

// ---------------------------------------------------------------------------
describe("family golden: price-derived", () => {
  const DESCRIPTOR_BACKED = {
    F4: F4_DESCRIPTOR,
    F6: F6_DESCRIPTOR,
    F8: F8_DESCRIPTOR,
    F13: F13_DESCRIPTOR,
    DB_SMH: DB_SMH_DESCRIPTOR,
    DB_XLK: DB_XLK_DESCRIPTOR,
    RS_SMH: RS_SMH_DESCRIPTOR,
    RS_XLK: RS_XLK_DESCRIPTOR,
    KBE_RS: KBE_RS_DESCRIPTOR,
    INS_RS: INS_RS_DESCRIPTOR,
    EXSH_GATE: EXSH_GATE_DESCRIPTOR,
    AT1: AT1_DESCRIPTOR,
  } as const;
  // Reconciled against the tree (see file docblock): these five have no descriptor instance; their scorer
  // wiring is the registry PRICE_SCORERS row (MU_RS borrows the rsCuts default, JPT GT's cuts).
  const REGISTRY_WIRED = ["F5", "SPCONC", "NVDA", "MU_RS", "JPT"] as const;
  // Chart-only price-derived legs (Stage 1, AVGO idiosyncratic legs): NOT in ALL_INDICATORS and
  // NOT in PRICE_SCORERS — they score off run-cycle-feeds.ts's GLOBAL_FEEDS table, so the two census
  // buckets above cannot reach them. A third, INDEPENDENT literal (not derived from FAMILY_OF), so
  // it reds if a chart-only price-derived id is added/removed without updating this list.
  const CHART_ONLY_WIRED = ["HCX", "FDX"] as const;

  test("census: descriptor-backed ∪ registry-wired ∪ chart-only = FAMILY_OF members, exactly", () => {
    const covered = [...Object.keys(DESCRIPTOR_BACKED), ...REGISTRY_WIRED, ...CHART_ONLY_WIRED].sort();
    expect(covered).toEqual(membersOf("price-derived").sort());
  });

  test("every member: chart-only rows off ALL_INDICATORS/PRICE_SCORERS; descriptor BespokeRefs resolve; registry rows are PRICE_SCORERS rows", () => {
    const chartOnlyIds = CHART_ONLY_INDICATORS.map((i) => i.id);
    const priceScorerIds = PRICE_SCORERS.map((s) => s.indicator.id);
    for (const id of CHART_ONLY_WIRED) {
      expect.soft(chartOnlyIds, `${id} must be chart-only`).toContain(id);
      expect.soft(byId.has(id), `${id} must be ABSENT from ALL_INDICATORS`).toBe(false);
      expect.soft(priceScorerIds, `${id} must NOT be a PRICE_SCORERS row`).not.toContain(id);
    }
    for (const [id, desc] of Object.entries(DESCRIPTOR_BACKED)) {
      expect.soft(desc.family, `${id} family`).toBe("price-derived");
      expectBespokeRef(id, desc.scorer);
    }
    for (const id of REGISTRY_WIRED) expect.soft(priceScorerIds, `${id} must be a PRICE_SCORERS row`).toContain(id);
  });

  // Iterates the derived id set (review I-1: no hand-typed DB pair); asserts the seam
  // the census above does NOT — each detector id resolves a DB_* descriptor whose
  // BespokeRef is a real scorers-*.ts export (review N-1: linkage, not membership).
  test("DB_* detectors are wired via DOWNSIDE_DETECTORS", () => {
    const DB_DESCRIPTORS: Record<string, { scorer: BespokeRef }> = {
      DB_SMH: DB_SMH_DESCRIPTOR,
      DB_XLK: DB_XLK_DESCRIPTOR,
    };
    expect(Object.keys(DB_DESCRIPTORS).sort()).toEqual([...DOWNSIDE_DETECTOR_IDS].sort());
    for (const id of DOWNSIDE_DETECTOR_IDS) {
      expectBespokeRef(id, DB_DESCRIPTORS[id]!.scorer);
    }
  });
});

// ---------------------------------------------------------------------------
describe("family golden: ratio-spread", () => {
  const DESCRIPTORS: Record<string, RatioSpreadDescriptor> = {
    CG: CG_DESCRIPTOR,
    VT: VT_DESCRIPTOR,
    VXNT: VXNT_DESCRIPTOR,
    EURC: EURC_DESCRIPTOR,
    EPATH: EPATH_DESCRIPTOR,
    BUND: BUND_DESCRIPTOR,
  };

  test("census: descriptor instances = FAMILY_OF members, exactly", () => {
    expect(Object.keys(DESCRIPTORS).sort()).toEqual(membersOf("ratio-spread").sort());
  });

  // VT's inputs are a numerator/denominator PAIR: the ratio is VIX ÷ VIX3M, so ORDER is
  // semantic, not cosmetic. Swapping it inverts the ratio (~0.93 → ~1.08, crossing the 0.97
  // red cut) for every DESCRIPTOR-sourced consumer while the live scalar — fetching
  // `VIX_SYMBOL`/`VIX3M_SYMBOL` positionally (`fetchVixTermLegs`) — stays correct. Pinned against
  // vix_term.ts's own constants (single-source, not a literal restated here), order included.
  test("VT: inputs are [front, back] = vix_term's VIX_SYMBOL, VIX3M_SYMBOL - in that order", () => {
    expect(VT_DESCRIPTOR.inputs).toEqual([VIX_SYMBOL, VIX3M_SYMBOL]);
  });

  /** Cut-shape rows (fixture-from-the-cut): synthetic decision values built FROM the
   *  descriptor's own cuts; expectations follow each cutKind's documented edge semantics
   *  (return: both `≤` inclusive; level + `direction: "HIGH"` spread: RED strict `>`, AMBER `≥`; spread: both strict `<`).
   *  A retune moves the fixtures with the cut. */
  function highwardCases(desc: RatioSpreadDescriptor): ReadonlyArray<readonly [number, State]> {
    // red > amber (rising-is-risk); RED edge strict, AMBER inclusive.
    const eps = (desc.red - desc.amber) / 4;
    return [
      [desc.red + eps, "RED"],
      [desc.red, "AMBER"],
      [desc.amber, "AMBER"],
      [desc.amber - eps, "GREEN"],
    ];
  }
  function cutShapeCases(desc: RatioSpreadDescriptor): ReadonlyArray<readonly [number, State]> {
    switch (desc.cutKind) {
      case "return": {
        // amber > red (drop-is-risk); boundaries inclusive.
        const eps = (desc.amber - desc.red) / 4;
        return [
          [desc.red, "RED"],
          [desc.red + eps, "AMBER"],
          [desc.amber, "AMBER"],
          [desc.amber + eps, "GREEN"],
        ];
      }
      case "level":
        return highwardCases(desc);
      case "spread": {
        if (desc.direction === "HIGH") return highwardCases(desc);
        // amber > red (falling-is-risk); both edges strict — at-the-cut is the safe side.
        const eps = (desc.amber - desc.red) / 4;
        return [
          [desc.red - eps, "RED"],
          [desc.red, "AMBER"],
          [desc.amber - eps, "AMBER"],
          [desc.amber, "GREEN"],
        ];
      }
    }
  }

  test("every member: two inputs, finite amber/red, and the band flips exactly at desc.amber/desc.red", () => {
    for (const [id, desc] of Object.entries(DESCRIPTORS)) {
      expect.soft(desc.family, `${id} family`).toBe("ratio-spread");
      expect.soft(desc.inputs, `${id} inputs`).toHaveLength(2);
      for (const symbol of desc.inputs) expect.soft(typeof symbol, `${id} input symbol`).toBe("string");
      expect.soft(Number.isFinite(desc.amber), `${id} amber finite`).toBe(true);
      expect.soft(Number.isFinite(desc.red), `${id} red finite`).toBe(true);
      if (desc.scorer) expectBespokeRef(id, desc.scorer);
      for (const [value, expected] of cutShapeCases(desc)) {
        expect.soft(ratioSpreadState(value, desc, desc.amber, desc.red), `${id} (${desc.cutKind}) value=${value}`).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("family golden: composite", () => {
  const DESCRIPTORS = {
    R7: R7_DESCRIPTOR,
    FXH: FXH_DESCRIPTOR,
    GT: GT_DESCRIPTOR,
    GB: GB_DESCRIPTOR,
    DISP: DISP_DESCRIPTOR,
    VTP: VTP_DESCRIPTOR,
    CQS: CQS_DESCRIPTOR,
    BONOS: BONOS_DESCRIPTOR,
    ECY: ECY_DESCRIPTOR,
    R6: R6_DESCRIPTOR,
    ESTR: ESTR_DESCRIPTOR,
    EURGBP: EURGBP_DESCRIPTOR,
  } as const;

  test("census: descriptor instances = FAMILY_OF members, exactly", () => {
    expect(Object.keys(DESCRIPTORS).sort()).toEqual(membersOf("composite").sort());
  });

  test("every member: BespokeRef resolves a scorers-*.ts export", () => {
    for (const [id, desc] of Object.entries(DESCRIPTORS)) {
      expect.soft(desc.family, `${id} family`).toBe("composite");
      expectBespokeRef(id, desc.scorer);
    }
  });
});

// ---------------------------------------------------------------------------
describe("family golden: geo-hybrid", () => {
  test("census: G1 + OVX + BRENT + NG are the members, descriptor-backed", () => {
    expect(membersOf("geo-hybrid")).toEqual(["G1", "OVX", "BRENT", "NG"]);
    expectBespokeRef("G1", G1_DESCRIPTOR.scorer);
    expectBespokeRef("BRENT", BRENT_DESCRIPTOR.scorer);
    expectBespokeRef("OVX", OVX_DESCRIPTOR.scorer);
    expectBespokeRef("NG", NG_DESCRIPTOR.scorer);
  });
});
