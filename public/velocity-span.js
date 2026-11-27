/*
 * Velocity-span copy — the ONE front-end composer for "how far back does this card's Δ reach".
 *
 * Both halves of the caption are PER ID and neither is guessable from the card face:
 *
 *   • the SPAN is `meta.velocityWindow` (absent ⇒ the global default, mirrored below);
 *   • the unit WORD is `meta.obsCadence ?? meta.cadence` — the OBSERVATION grid, never `cadence`
 *     alone. F9/F11 declare `cadence: "weekly"` for the FRED H.10 RELEASE schedule while their
 *     underlying series return business-day rows, so a bare `cadence` read captions F9's
 *     60-trading-day change "60 weeks", a 5× error.
 *
 * The detail CHART does not use this module: its caption arrives pre-composed from the server as
 * the primary axis' `label` (`velocitySpanWord`, `src/chart-rail.ts`). The card has no `ChartSpec`
 * in hand, so it composes locally — and `velocity-span.test.js` pins the two composers to agree
 * id-by-id off the real builder, so the split can never drift into two different answers.
 *
 * DOM-free by construction (`app.js` is not vitest-importable — see its header).
 */

/** The global default velocity span, for an id that declares no `velocityWindow` of its own.
 *  Mirrors `VELOCITY_WINDOW` (`src/domain-types.ts`); `velocity-span.test.js` imports the TS
 *  constant and pins the equality, so the mirror cannot drift. */
export const DEFAULT_VELOCITY_WINDOW = 20;

/** Per-observation vocabulary, keyed by the OBSERVATION grid. `word` matches the server's
 *  `obsWord` letter exactly (the chart caption and the card chip must read the same); `noun` is
 *  the tooltip's plural, and `series` the honest "this is not a daily series" clause the three
 *  original LEGEND variants carried — kept, not collapsed. */
const OBS_GRID = {
  daily: { word: "d", noun: "trading days", series: "" },
  weekly: { word: "w", noun: "weeks", series: " (this is a weekly series)" },
  monthly: { word: "mo", noun: "months", series: " (this is a monthly series)" },
  // No live quarterly carrier today; the arm stays for the next sparse feed, matching the
  // wire's `cadence` enum.
  quarterly: { word: "q", noun: "quarters", series: " (this is a quarterly series)" },
};

/**
 * Resolve an indicator meta's velocity span into `{ window, word, noun, series }`.
 * Tolerates a partial/old meta: an absent window falls back to the global default and an absent
 * or unknown grid to daily, matching the wire's documented absent-means-default convention.
 */
export function velocitySpan(meta) {
  const window = meta?.velocityWindow ?? DEFAULT_VELOCITY_WINDOW;
  const grid = OBS_GRID[meta?.obsCadence ?? meta?.cadence] ?? OBS_GRID.daily;
  return { window, ...grid };
}

/** The card chip's leading token — `"Δ60d"` for F9, `"Δ4w"` for F3, `"Δ20d"` for a default-window
 *  daily id. Identical by construction to the detail chart's primary-axis label. */
export function velocityChipLabel(meta) {
  const { window, word } = velocitySpan(meta);
  return `Δ${window}${word}`;
}

/** The chip's tooltip — spells the span out, and names the grid whenever it is not daily so a
 *  20-month move is never read as a 20-trading-day one. */
export function velocityTip(meta) {
  const { window, noun, series } = velocitySpan(meta);
  return `${velocityChipLabel(meta)} - change in the value versus ${window} ${noun} ago${series}.`;
}
