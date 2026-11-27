/** The served estimate slot (`estimateSlot`): the read path SERVES the stored
 *  `estimated` tail rather than recomputing a nowcast. Pure, zero imports — `api/series.ts` feeds it the response's own
 *  wire points, so the slot is the same row the chart draws, for every id. */

/** Wire shape of `SeriesResponse.oilEst` (name kept on the wire): the newest estimated point and the print it extends. */
export interface EstimateSlot {
  /** The newest `estimated` point's date. */
  date: string;
  /** That point's own value, in the units the response's points carry. */
  value: number;
  /** The newest NON-estimate point's date — the print the estimate tail extends from. */
  fromDate: string;
  /** The newest point is `provisional` (an intraday run's estimate); absent ⇒ an EOD one. */
  provisional?: true;
}

/** The slot off a date-ascending point list: null unless the NEWEST point is `estimated: true` with a finite value AND a
 *  non-estimate point precedes the estimated tail (a multi-day tail anchors on the print before ALL of it). */
export function estimateSlot(
  points: readonly { date: string; value: number | null; estimated?: boolean; provisional?: boolean }[],
): EstimateSlot | null {
  const newest = points.at(-1);
  if (newest?.estimated !== true || typeof newest.value !== "number" || !Number.isFinite(newest.value)) return null;
  const anchor = points.findLast((p) => p.estimated !== true);
  if (!anchor) return null;
  return { date: newest.date, value: newest.value, fromDate: anchor.date, ...(newest.provisional === true ? { provisional: true as const } : {}) };
}
