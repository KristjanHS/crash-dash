/**
 * The `/api/series` (and `/api/replay?companion=`) `from`/`to` grid: a bound must be a
 * month-start (`YYYY-MM-01`) exactly, else the edge 400s (api/series.ts `parseRange`, P5).
 * Both callers that emit a range — the detail-chart date anchor (detail-tab.js) and the
 * episode companion (exposure-replay-chart.js `companionSeriesUrl`) — snap here at
 * construction so a live chart's window can never mint a 400. A `from` floors (widen back,
 * never drop a leading day); an inclusive `to` ceils (widen forward, never drop the tail
 * month). The renderer slices to its own day-precise domain client-side, so the coarser
 * server window is transparent on screen.
 */

/** Floor an ISO `YYYY-MM-DD` to its month-start (`YYYY-MM-01`). */
export function floorMonthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

/** Ceil an ISO `YYYY-MM-DD` to a month-start: the 1st of the SAME month when already there,
 *  else the 1st of the following month (so an inclusive upper bound never drops its tail). */
export function ceilMonthStart(iso) {
  if (iso.endsWith("-01")) return iso;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}
