import { expect, test, describe } from "vitest";
import { loadGeoActiveCount, loadGeoInputs, type GeoFlag } from "./geo.js";

const flag = (id: string): GeoFlag => ({ id, label: id, since: "2026-06-01" });

describe("loadGeoActiveCount (manual geo-flag count → GEO_score)", () => {
  test("no-arg call reads the shipped config.json as a schema-valid count (content-agnostic)", () => {
    // Inverted from the old content pin (`=== 0`): the documented workflow raises a
    // flag by editing config.json + redeploy (geo.ts), so pinning the committed
    // content went RED the moment a flag was legitimately raised. Assert only the
    // SCHEMA — a non-negative integer count derived from the flags array — never the
    // specific flags, so a live flag never reddens `npm run check`.
    const n = loadGeoActiveCount();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("loadGeoInputs (Stage 4 - manual flags + declared crisis stage)", () => {
  test("flagCount counts the flags (absent → 0, each flag = 1); crisisStage passes through; absent stage → 0", () => {
    expect(loadGeoInputs({})).toEqual({ flagCount: 0, crisisStage: 0 });
    expect(loadGeoInputs({ flags: [flag("a"), flag("b")], crisisStage: 2 })).toEqual({ flagCount: 2, crisisStage: 2 });
  });

  for (const bad of [5, -1, 2.5, Number.NaN, 1, 3]) {
    test(`stage ${bad} throws (fail-loud - a typo'd config must break the deploy; 1 is auto-scored, 3 merged into 2)`, () => {
      expect(() => loadGeoInputs({ crisisStage: bad })).toThrow(/crisisStage/);
    });
  }

  test("the surviving declared domain is exactly {0,2,4}", () => {
    for (const ok of [0, 2, 4]) {
      expect(loadGeoInputs({ crisisStage: ok }).crisisStage).toBe(ok);
    }
  });

  test("no-arg call reads the shipped config.json schema-valid (content-agnostic, like the count pin)", () => {
    const g = loadGeoInputs();
    expect(Number.isInteger(g.crisisStage)).toBe(true);
    expect(g.crisisStage).toBeGreaterThanOrEqual(0);
    expect(g.crisisStage).toBeLessThanOrEqual(4);
    expect(g.flagCount).toBe(loadGeoActiveCount());
  });
});
