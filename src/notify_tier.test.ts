/**
 * NotifyTier — the generic off-ladder notify scaffold (notify_tier.ts), proven
 * against both off-ladder tiers:
 *   1. SLOW: the generic + SLOW_TIER spec (slow_tier.ts) reproduce the slow tier's
 *      ntfy payload byte-for-byte. These are GOLDEN literals: before the
 *      architecture refactor the assertions compared against run.ts's
 *      `buildSlowNotification`, which proved byte-identity this session; that
 *      wrapper is now deleted (inlined onto the generic), so the once-canonical
 *      output is frozen here as a regression lock. Push is cross-checked against an
 *      INDEPENDENT rank table so a SLOW_TIER.bands rank typo can't pass silently.
 *   2. BOTTOM (now in production): the same spec shape produces a correct own-tier
 *      payload — disjoint vocabulary, own Title prefix, upward-only push.
 */

import { describe, it, expect } from "vitest";

import { buildTierNotification, decideTierNotify } from "./notify_tier.js";
import { SLOW_TIER } from "./slow_tier.js";
import { BOTTOM_TIER } from "./bottom_tier.js";
import type { SlowVerdict, SlowBand, SlowComponent } from "./slow.js";
import type { BottomVerdict } from "./bottom.js";

// The bottom tier now lives in production (bottom_tier.ts, wired into tracks.ts by the
// vix-bottom plan's Stage 4); this suite proves it fits the same generic scaffold.

// --- Fixtures --------------------------------------------------------------

function slowVerdict(band: SlowBand): SlowVerdict {
  const components: SlowComponent[] = [
    { id: "price-accel", label: "Price acceleration (QQQ 63d return %ile)", score: 1 },
    { id: "complacency", label: "Complacency (low VIX + near 252d high)", score: 1 },
  ];
  return { band, score: 2, activeCount: 2, maxScore: 4, ratio: 0.5, components };
}

const SLOW_BANDS: SlowBand[] = ["CALM", "ELEVATED", "DE-RISK"];
// Independent oracle for the upward-change rule — NOT sourced from SLOW_TIER.bands,
// so a rank regression in the spec is caught rather than mirrored.
const SLOW_RANK: Record<SlowBand, number> = { CALM: 0, ELEVATED: 1, "DE-RISK": 2 };
// The two fixed component lines for the slowVerdict fixture (both score 1/2).
const SLOW_LINES =
  "Price acceleration (QQQ 63d return %ile): 1/2\nComplacency (low VIX + near 252d high): 1/2";

// --- 1. Slow-tier golden output --------------------------------------------

describe("NotifyTier - slow tier (SLOW_TIER) golden output", () => {
  it("pushes on CALM -> ELEVATED with the exact ntfy payload", () => {
    const n = buildTierNotification(SLOW_TIER, "CALM", slowVerdict("ELEVATED"), "2026-06-28");
    expect(n).toEqual({
      push: true,
      message: {
        title: "crash-dash bubble - CALM -> ELEVATED",
        body: `CALM -> ELEVATED\nscore 2/4 (2 active) → ELEVATED\n\n${SLOW_LINES}\nas of 2026-06-28`,
        tags: "balloon",
        priority: 4,
      },
    });
  });

  it("pushes on ELEVATED -> DE-RISK with the exact ntfy payload", () => {
    const n = buildTierNotification(SLOW_TIER, "ELEVATED", slowVerdict("DE-RISK"), "2026-06-28");
    expect(n).toEqual({
      push: true,
      message: {
        title: "crash-dash bubble - ELEVATED -> DE-RISK",
        body: `ELEVATED -> DE-RISK\nscore 2/4 (2 active) → DE-RISK\n\n${SLOW_LINES}\nas of 2026-06-28`,
        tags: "rotating_light",
        priority: 5,
      },
    });
  });

  it("no-change repeat is silent but still carries the (no change) body", () => {
    const n = buildTierNotification(SLOW_TIER, "ELEVATED", slowVerdict("ELEVATED"), "2026-06-28");
    expect(n).toEqual({
      push: false,
      message: {
        title: "crash-dash bubble - ELEVATED",
        body: `bubble ELEVATED (no change)\nscore 2/4 (2 active) → ELEVATED\n\n${SLOW_LINES}\nas of 2026-06-28`,
        tags: "balloon",
        priority: 4,
      },
    });
  });

  it("matches the push/transition rule across every (last, next) band pair", () => {
    const lasts: Array<SlowBand | null> = [null, ...SLOW_BANDS];
    for (const last of lasts) {
      for (const next of SLOW_BANDS) {
        const expectedPush = SLOW_RANK[next] > SLOW_RANK[last ?? "CALM"];
        const dec = decideTierNotify(SLOW_TIER, last, next);
        expect(dec.push, `push ${last}->${next}`).toBe(expectedPush);
        expect(dec.transition, `transition ${last}->${next}`).toBe(
          expectedPush ? `${last ?? "CALM"} -> ${next}` : null,
        );
        // The full builder agrees with the decision on push. A null prior folds to the CALM
        // baseline here, and the payload is a pure function of (push, transition, verdict) — so the
        // CALM -> ELEVATED golden above is also the first-run (null prior) payload.
        const built = buildTierNotification(SLOW_TIER, last, slowVerdict(next), "2026-06-28");
        expect(built.push, `built push ${last}->${next}`).toBe(expectedPush);
      }
    }
  });

  it("degraded verdict (null) → silent, null message", () => {
    expect(buildTierNotification(SLOW_TIER, "ELEVATED", null, "2026-06-28")).toEqual({
      push: false,
      message: null,
    });
  });
});

// --- 2. Bottom-tier fit ---------------------------------------------------

describe("NotifyTier - bottom tier fits the same spec", () => {
  it("pushes on upward change with own vocabulary + Title prefix", () => {
    const v: BottomVerdict = {
      state: "BOTTOM-FORMING",
      rawState: "BOTTOM-FORMING",
      vix: 42.1,
      vix3m: 33.0,
      ratio: 1.276,
      asOf: "2026-06-28",
    };
    const n = buildTierNotification(BOTTOM_TIER, "CAPITULATION-WATCH", v, "2026-06-28");
    expect(n.push).toBe(true);
    expect(n.message?.title).toBe("crash-dash bottom - CAPITULATION-WATCH -> BOTTOM-FORMING");
    expect(n.message?.tags).toBe("large_blue_circle");
    expect(n.message?.priority).toBe(4);
    expect(n.message?.body).toContain("VIX 42.1 · VIX3M 33.0 · ratio 1.28");
  });

  it("calmest band never pushes (a downgrade to CALM is silent)", () => {
    const v: BottomVerdict = { state: "CALM", rawState: "CALM", vix: 18, vix3m: 20, ratio: 0.9, asOf: "2026-06-28" };
    expect(buildTierNotification(BOTTOM_TIER, "BOTTOM-FORMING", v, "2026-06-28").push).toBe(false);
  });
});
