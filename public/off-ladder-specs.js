/*
 * off-ladder-specs.js — the band COPY constants for the three off-ladder panels
 * (VIX-bottom / pension-drawdown / slow bubble-state). Pure data — zero DOM, zero
 * module-level side effects, zero imports.
 */

// --- Bottom-signal panel (contrarian off-ladder VIX capitulation read) ------

// The active states + their copy. CALM / null fall through to a muted panel
// (always visible — the panel teaches that the track exists). The one-line risk
// framing ("downside risk remains") is mandatory on every active read.
export const BOTTOM_META = {
  "CAPITULATION-WATCH": {
    label: "Capitulation watch",
    sub: "Acute panic active - a heads-up, not a buy. Downside may continue.",
    cls: "bottom-watch",
  },
  "BOTTOM-FORMING": {
    label: "Bottom forming",
    sub: "Spike cresting + term structure normalising - a contrarian re-risk hint.",
    cls: "bottom-forming",
  },
};

// --- Bubble-state panel (slow off-ladder bubble-fuel read) ------------------

// Slow-band copy + an ESCALATING-alarm palette (CALM muted → ELEVATED amber →
// DE-RISK red). A DISTINCT map from the G/A/R STATE_COLORS — its own vocabulary
// — but single-sourced on the existing --state-* alarm vars. CALM / null fall
// through to a muted panel (always visible — teaches the track exists), so only
// the two active bands carry copy here. SlowBand "ELEVATED" displays as the
// fuller "ELEVATED-BUBBLE-STATE" vocabulary.
export const SLOW_BAND_META = {
  ELEVATED: {
    label: "Elevated bubble state",
    sub: "Speculative fuel is building - a heads-up, not a crash call.",
    cls: "slow-elevated",
  },
  "DE-RISK": {
    label: "De-risk",
    sub: "Bubble fuel near the top of its range - consider trimming risk.",
    cls: "slow-derisk",
  },
};

