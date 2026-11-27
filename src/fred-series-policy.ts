/**
 * FRED series this tree never fetches: each id's owner bars redistribution of the data FRED re-publishes.
 * `fetchSeries` refuses them with `NoFreeSourceError` before any request, so every consumer degrades through
 * its existing no-free-source path instead of fetching, storing or displaying the data.
 * Leaf on purpose: constants only, no imports.
 */
export const REFUSED_SERIES: ReadonlySet<string> = new Set([
  // the index publisher's volatility indices (VIX, VIX3M, VXN).
  "VIXCLS",
  "VXVCLS",
  "VXNCLS",
  // ICE BofA option-adjusted spreads; Moody's corporate yields.
  "BAMLH0A0HYM2",
  "BAMLC0A0CM",
  "BAMLC0A4CBBB",
  "BAMLH0A3HYC",
  "BAMLEMCBPIOAS",
  "BAA10Y",
  "AAA10Y",
]);
