/**
 * Tests for GET /api/danger-model (api/danger-model.ts) — the static danger-model reference
 * block. Fields copied verbatim under their src/ shape carry no pin here (served === import is
 * circular); pinned are the view-built mappings (renamed keys, legRagCuts), the derived
 * relevance ⇔ weight support and the cache headers.
 */
import { describe, expect, test } from "vitest";

import { MEMBER_WEIGHT, RERISK_CONFIRM, RERISK_DWELL_DAYS } from "../src/danger-ladder.js";
import { CONC_THRESHOLD, CONC_WEIGHT, DANGER_CUTS, DERISK_DEADBAND, RERISK_DEADBAND } from "../src/danger-engine.js";
import { VINTAGE_HEADERS } from "../src/api/http.js";
import type { DangerModel } from "../src/api/types.js";

// Audit rank 14: the danger-model handler folded into the meta router; its body is dangerModelView.
import { dangerModelView as GET } from "../src/api/meta-views.js";

const res = await GET();
const body = (await res.json()) as DangerModel;

describe("GET /api/danger-model", () => {
  // R3 (2026-07-18): the tooltip's `×<weight>` suffix reads this, so it must mirror the source
  // constant exactly — the relevance MASK alone cannot reconstruct a magnitude.
  test("memberWeight mirrors MEMBER_WEIGHT and is a superset of the relevance mask", () => {
    expect(body.memberWeight).toEqual(MEMBER_WEIGHT);
    // The mask IS the non-zero support: every relevant (member, sleeve) has a non-zero weight,
    // and every non-zero weight is in the mask. Fails if either derivation drifts.
    for (const [id, sleeves] of Object.entries(body.memberRelevance)) {
      for (const s of sleeves) expect(body.memberWeight[id]?.[s]).toBeGreaterThan(0);
    }
    const nonZero = Object.entries(body.memberWeight).flatMap(([id, row]) =>
      Object.entries(row).filter(([, w]) => w > 0).map(([s]) => [id, s] as const),
    );
    expect(nonZero.length).toBeGreaterThan(0);
    for (const [id, s] of nonZero) expect(body.memberRelevance[id]).toContain(s);
  });

  test("the renamed knobs and legRagCuts map to their source constants", () => {
    expect({
      legRagCuts: body.legRagCuts,
      concThreshold: body.concThreshold,
      concWeight: body.concWeight,
      deriskDeadband: body.deriskDeadband,
      reriskDeadband: body.reriskDeadband,
      reriskConfirm: body.reriskConfirm,
      reriskDwellDays: body.reriskDwellDays,
    }).toEqual({
      legRagCuts: { amber: DANGER_CUTS.amber, red: DANGER_CUTS.red },
      concThreshold: CONC_THRESHOLD,
      concWeight: CONC_WEIGHT,
      deriskDeadband: DERISK_DEADBAND,
      reriskDeadband: RERISK_DEADBAND,
      reriskConfirm: RERISK_CONFIRM,
      reriskDwellDays: RERISK_DWELL_DAYS,
    });
  });

  test("caches with the moderate poll TTL", () => {
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(res.headers.get("Vercel-Cache-Tag")).toBe(VINTAGE_HEADERS["Vercel-Cache-Tag"]);
  });
});
