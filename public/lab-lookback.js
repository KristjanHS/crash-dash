// The ONE /api/lab?hist= lookback (danger ROC over N closes; spec default, eyeball-tuned).
// A leaf module with ZERO imports on purpose: lab.js/overview.js (via lab-board.js), api/lab.ts
// (the {0, LAB_LOOKBACK} key-space bound, P12.b) and scripts/probe-load-budget.ts all read it, so
// the shared edge-cache key can never split — and the lambda bundle pulls this one constant, not
// lab-board.js's whole DOM module graph (api/lab.ts import budget: +1, not +25).
export const LAB_LOOKBACK = 20;
