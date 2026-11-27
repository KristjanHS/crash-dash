/**
 * The VIX bottom-signal tier's `NotifyTier` spec — its single source of band
 * metadata (rank/tag/priority) + Title format + body composer. Mirrors
 * `slow_tier.ts`'s `SLOW_TIER`: one exhaustive `bands` record over `BottomState`,
 * so a new state must declare rank/tag/priority or fail to compile (no drift
 * across hand-synced maps). Consumed by tracks.ts via
 * `buildTierNotification(BOTTOM_TIER, …)` / `decideTierNotify(BOTTOM_TIER, …)`.
 *
 * Own tier, distinct from the fast LEVEL_TAGS/PRIORITY and the slow SLOW_TIER:
 * CALM is mapped for completeness but never pushes (an upward change *to* CALM is
 * impossible). Both elevated states push (the /qimpag decision — WATCH = heads-up,
 * FORMING = actionable), at WARNING-ish priority 4; neither bypasses Do-Not-Disturb
 * (a contrarian "fear may be peaking" hint is never a CRITICAL-grade alarm). The
 * Title is an HTTP header (latin1), so the prefix + transition stay ASCII (the band
 * names are ASCII; the `·`/`→` glyphs live only in the UTF-8 body).
 */

import type { NotifyTierSpec } from "./notify_tier.js";
import type { BottomState, BottomVerdict } from "./bottom.js";

export const BOTTOM_TIER: NotifyTierSpec<BottomState, BottomVerdict> = {
  id: "bottom",
  titlePrefix: "crash-dash bottom",
  bands: {
    CALM: { rank: 0, tag: "green_circle", priority: 2 },
    "CAPITULATION-WATCH": { rank: 1, tag: "warning", priority: 4 },
    "BOTTOM-FORMING": { rank: 2, tag: "large_blue_circle", priority: 4 },
  },
  bandOf: (v) => v.state,
  // `v.asOf` — the vix-term feed's own latest aligned date — NOT the run's FRED-driven
  // asOf the spec threads in. The VIX/VIX3M tail routinely lags that
  // date, so captioning these levels with the run's date pushed a real falsehood: prod
  // would have read "VIX 15.0 · VIX3M 18.6 … as of 2026-07-17" for a 2026-07-10 close.
  // Same defect as the persisted-row mis-dating (`tracks.ts`), on the notify path.
  body: (v, header) =>
    `${header}\nVIX ${v.vix.toFixed(1)} · VIX3M ${v.vix3m.toFixed(1)} · ratio ${v.ratio.toFixed(2)} → ${v.state}\nas of ${v.asOf}`,
};
