/**
 * Tests for GET /api/config (api/config.ts) — the served alert-rank + scoring constants
 * the browser renders but must never redefine (D0 single-source).
 *
 * The drift-guard is the anti-mirror test crossing the `src/ ↔ served` boundary: it
 * imports the SAME src/ exports app.js used to hardcode and asserts the served
 * `scoringCuts` equals them. If a cut moves in src/ but the handler
 * isn't updated (or vice-versa), this fails — so app.js can trust /api/config as the
 * single source with no parallel copy to drift.
 */
import { describe, expect, test } from "vitest";

import { PENSION_DIP, PENSION_CORRECTION, PENSION_BEAR } from "../src/pension.js";
import { CONFIRM_CLOSES } from "../src/domain-types.js";
import { LADDER } from "../src/families.js";
import { legCloseId } from "../src/scoreboard.js";
import { ACCEL_AMBER_PCTILE, ACCEL_RED_PCTILE, VIX_LOW_PCTILE, NEAR_HIGH_FRAC } from "../src/slow.js";
import { VT_AMBER_RATIO, VT_RED_RATIO } from "../src/family-descriptor-rows.js";
import { ALERT_RANK } from "../src/ladder.js";
import { CACHE_STATIC } from "../src/api/http.js";

// Audit rank 14: the config handler folded into the meta router; its body is configView.
import { configView as GET } from "../src/api/meta-views.js";

const body = (await (await GET()).json()) as {
  alertRank: unknown;
  ladder: unknown;
  legIds: unknown;
  scoringCuts: { pension: unknown; slow: unknown; vt: unknown };
};

describe("GET /api/config", () => {
  test("still serves the alert rank verbatim from ladder.ts", () => {
    expect(body.alertRank).toEqual(ALERT_RANK);
  });

  test("serves the ladder in rung order, verbatim from families.ts", () => {
    expect(body.ladder).toEqual([...LADDER]);
  });

  test("serves the rung-ordered LEGP_* ids from scoreboard.ts, never a re-typed slug list", () => {
    expect(body.legIds).toEqual(LADDER.map((sleeve) => legCloseId(sleeve)));
  });

  test("caches hard (static, moves only on deploy)", async () => {
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe(CACHE_STATIC);
  });

  test("scoringCuts drift-guard - served === src/ exports (VT served for completeness; not render-consumed)", () => {
    expect(body.scoringCuts).toEqual({
      pension: { dip: PENSION_DIP, correction: PENSION_CORRECTION, bear: PENSION_BEAR, confirmCloses: CONFIRM_CLOSES },
      slow: { accelAmber: ACCEL_AMBER_PCTILE, accelRed: ACCEL_RED_PCTILE, vixLow: VIX_LOW_PCTILE, nearHigh: NEAR_HIGH_FRAC },
      vt: { amber: VT_AMBER_RATIO, red: VT_RED_RATIO },
    });
  });
});
