import { describe, expect, test } from "vitest";

import { FAMILY_OF } from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import {
  BOTTOM_INDICATORS,
  DOWNSIDE_DETECTOR_IDS,
  PENSION_INDICATORS,
  SLOW_INDICATORS,
} from "./registry-price.js";
import { VTP, CHART_ONLY_INDICATORS } from "./registry-composite.js";

// VTP straggler: it lives in the registry (Stage 2b.4) but is DELIBERATELY absent from
// ALL_INDICATORS and from every dial family (EW-13's surviving notify-exclusion half), so the
// census universe has to name it explicitly — the indicator ARRAYS unioned below cannot reach it.
// It IS scored and persisted since 2026-07-31 (tail of `FAST_CONFIRMERS`, confirmers.ts — option B);
// that table is keyed by id, not by `Indicator`, so it
// still contributes nothing to this universe. Id read off the registry entry — never hardcoded
// (feedback_tests-no-hardcoded-constants).
const VTP_ID = VTP.id;

// Universe derived from PRODUCTION exports — Set-union dedupes the double-homed ids
// (DB_SMH/DB_XLK and F7 appear in two sources).
const universe = new Set<string>([
  ...ALL_INDICATORS.map((i) => i.id),
  ...SLOW_INDICATORS.map((i) => i.id),
  ...PENSION_INDICATORS.map((i) => i.id),
  ...BOTTOM_INDICATORS.map((i) => i.id),
  ...DOWNSIDE_DETECTOR_IDS,
  VTP_ID,
  // Chart-only ids (CHART_ONLY_INDICATORS) get a FAMILY_OF tag too — HCX/FDX (Stage 1) are
  // price-derived, and the "no phantoms" check below would red without them in the universe.
  ...CHART_ONLY_INDICATORS.map((i) => i.id),
]);

describe("FAMILY_OF census bijection (Stage 1.1)", () => {
  test("every production id has a FAMILY_OF entry", () => {
    const missing = [...universe].filter((id) => !(id in FAMILY_OF));
    expect(missing, `ids missing from FAMILY_OF: ${missing.join(", ")}`).toEqual([]);
  });

  test("every FAMILY_OF key is a production id (no phantoms)", () => {
    const phantoms = Object.keys(FAMILY_OF).filter((id) => !universe.has(id));
    expect(phantoms, `phantom FAMILY_OF ids: ${phantoms.join(", ")}`).toEqual([]);
  });

  // The velocity-window sub-family is DERIVED from the registry, never a hardcoded id list: the
  // `family-descriptor-rows.ts` census no longer enumerates carriers or their values (2026-08-07), and
  // a literal list here would reproduce exactly the rot that removed it — it went stale the moment
  // an id was ADDED. `Object.hasOwn` (not `!= null`) so a carrier declaring `velocityWindow: 0`
  // stays IN the population and reds below, instead of quietly leaving it.
  test("every registry velocityWindow carrier is a fred-level-velocity id with a positive window", () => {
    const carriers = ALL_INDICATORS.filter((i) => Object.hasOwn(i, "velocityWindow"));
    // Vacuity floor: the population must be non-empty, or the loop asserts nothing. Anchored on
    // "at least one carrier exists" — a fact no fix to this sub-family drains.
    expect(carriers.length, "no ALL_INDICATORS entry declares velocityWindow").toBeGreaterThan(0);
    for (const entry of carriers) {
      expect(FAMILY_OF[entry.id], `${entry.id} family`).toBe("fred-level-velocity");
      expect(entry.velocityWindow, `${entry.id} registry velocityWindow`).toBeGreaterThan(0);
    }
  });
});
