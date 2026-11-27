/**
 * `GET /api/series` for the chained display lines with no registry row (`chainedDisplayIds` outside `META`):
 * `LEGP_VALUE` (the chained EUR Value-leg level the relative-strength chain reads — its chart is `XDEV`) and the
 * `SB_STRAT` / `SB_BENCH` NAV pair. Their stored rows (`readings`, written by `seedLegClosesOnCron` /
 * `scoreboardNavRows`) carry no band, score or fold: `state` is the placeholder GREEN `navReadingRow` stamps, so the
 * body is `valueOnly` and has no `confirmCloses`, cuts or recompute (`detail`/`mult` are inert). Served so the
 * estimate-anchor rule (`ANCHOR_ROSTER`) reads every bound id over plain HTTP (`scripts/probe-series-holes.ts --tail`).
 * The id is outside the registry, so `isLicensedId` fails closed: its served body is redacted (dates + flags only).
 */
import type { SeriesPoint, SeriesRange, ReadStore } from "../store.js";
import type { SeriesResponse } from "../api/types.js";
import { ANCHOR_ROSTER, unanchoredEstimateDates } from "../estimated.js";
import { LEG_TICKER, legCloseId, legProxy, SB_BENCH_ID, SB_STRAT_ID } from "../scoreboard.js";

type Head = Pick<SeriesResponse, "label" | "longLabel" | "unit">;

/** The served chained-only ids and their wire names — exactly these; any other non-registry id still 400s. */
export const CHAINED_SERIES_HEAD: ReadonlyMap<string, Head> = new Map<string, Head>([
  [legCloseId("Value"), { label: "Value (chained)", longLabel: `Value leg - ${LEG_TICKER.Value.ticker} chained EUR level (relative-strength chain; chart: XDEV)`, unit: "€" }],
  [SB_STRAT_ID, { label: "Strategy NAV", longLabel: "Scoreboard strategy NAV - chain-linked EUR index (base 100)", unit: "" }],
  [SB_BENCH_ID, { label: "Benchmark NAV", longLabel: "Scoreboard benchmark NAV - chain-linked EUR index (base 100)", unit: "" }],
]);

/** The stored rows of a chained-only `id` in `[range]` (newest `limit`), less each estimate `estimateAnchored` rejects —
 *  the same store passthrough + anchor filter a registry id rides. `points` keep the store-only `runAt`/`estimated`
 *  (the handler's `flagProvisional` serializes them). */
export async function chainedSeries(
  store: ReadStore,
  id: string,
  limit: number,
  range: SeriesRange | undefined,
): Promise<Omit<SeriesResponse, "points"> & { points: Omit<SeriesPoint, "bandCuts">[] }> {
  const head = CHAINED_SERIES_HEAD.get(id);
  if (!head) throw new Error(`chainedSeries: ${id} is not a chained-only series id`);
  const stored = (await store.getSeries(id, limit, range)).map(({ bandCuts: _cuts, ...rest }) => rest);
  const unanchored = new Set(ANCHOR_ROSTER.includes(id) ? unanchoredEstimateDates(id, stored) : []);
  const proxy = legProxy(id);
  return {
    indicatorId: id,
    ...head,
    points: unanchored.size === 0 ? stored : stored.filter((p) => !unanchored.has(p.date)),
    valueOnly: true,
    ...(proxy ? { proxy: { source: proxy.ticker, until: proxy.until } } : {}),
  };
}
