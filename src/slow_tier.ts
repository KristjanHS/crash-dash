/**
 * The slow bubble tier's `NotifyTier` spec — its single source of band metadata
 * (rank/tag/priority) + Title format + body composer. Collapses the three
 * formerly hand-synced maps (`SLOW_BAND_RANK` + `SLOW_BAND_TAGS` +
 * `SLOW_BAND_PRIORITY`) into one exhaustive `bands` record: a new `SlowBand` must
 * declare rank/tag/priority or fail to compile. Consumed by tracks.ts via
 * `buildTierNotification(SLOW_TIER, …)` / `decideTierNotify(SLOW_TIER, …)`.
 *
 * Own tier, distinct from the fast LEVEL_TAGS/PRIORITY:
 * CALM is mapped for completeness but never pushes (an upward change *to* CALM is
 * impossible). ELEVATED ≈ WARNING priority, DE-RISK ≈ CRITICAL (bypasses
 * Do-Not-Disturb) — a confirmed bubble de-risk signal warrants it. The Title is an
 * HTTP header (latin1), so the prefix + transition stay ASCII.
 */

import type { NotifyTierSpec } from "./notify_tier.js";
import type { SlowBand, SlowVerdict } from "./slow.js";

export const SLOW_TIER: NotifyTierSpec<SlowBand, SlowVerdict> = {
  id: "bubble",
  titlePrefix: "crash-dash bubble",
  bands: {
    CALM: { rank: 0, tag: "green_circle", priority: 2 },
    ELEVATED: { rank: 1, tag: "balloon", priority: 4 },
    "DE-RISK": { rank: 2, tag: "rotating_light", priority: 5 },
  },
  bandOf: (v) => v.band,
  body: (v, header, asOf) => {
    const lines = v.components.map((c) => `${c.label}: ${c.score}/2`).join("\n");
    return `${header}\nscore ${v.score}/${v.maxScore} (${v.activeCount} active) → ${v.band}\n\n${lines}\nas of ${asOf}`;
  },
};
