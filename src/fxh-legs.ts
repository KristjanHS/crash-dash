/**
 * FXH stored-leg read — the ONE grid both the cron scorer and the read API score/draw from.
 *
 * Why one seam (ruled [USER] 2026-09-04): `fxHavenMoveSeries`
 * indexes its 20-bar lookback POSITIONALLY, so its base date is a property of the INPUT GRID, not
 * the calendar. The cron used to fold the live closes provider grid (5 bars/week) while `api/series.ts`
 * recomputed off the stored union grid (6 bars/week wherever a Friday-evening run had persisted a
 * Friday-labelled live-quote row) — same seam, different 20-bar base, a GREEN ribbon under a 2.0%
 * worst-of line. Both callers now read the legs back through THIS function after the cron has
 * persisted them, so scorer input ≡ chart input by construction.
 *
 * Throws on a store failure (the cron's `degrade` wrapper turns that into "FXH non-live this run" —
 * never a fall-back to the live grid, which would reintroduce the drift); returns `null` when any
 * leg is EMPTY (never backfilled) so the read API can degrade to legless points. Deterministic given
 * the store — the ONLY IO here is that one bulk read.
 */
import { CHART_DESCRIPTOR_OF } from "./family-descriptor-rows.js";
import { VELOCITY_WINDOW, type Observation } from "./domain-types.js";
import { confirmClosesFor } from "./family-table.js";
import { GAP_FILL_DAYS } from "./intraday.js";
import type { Store } from "./store.js";

export type FxhLegs = { usEur: Observation[]; chfUsd: Observation[]; jpyUsd: Observation[] };

/** The three `CMP_FXH_*` store ids in leg order (EURUSD=X, CHF=X, JPY=X). */
export const FXH_LEG_IDS = CHART_DESCRIPTOR_OF.FXH!.seriesIds! as readonly [string, string, string];

/**
 * Extra stored rows read past the arithmetic minimum — absorbs calendar misalignment across the
 * three legs (each `=X` pair can miss a different holiday; `alignByDates` inner-joins them).
 */
const FXH_LEG_PAD = 10;

/** Read depth for a chart window of `limit` points: the ribbon needs a full lookback under its oldest point. */
export function fxhLegLimit(limit: number): number {
  return limit + VELOCITY_WINDOW + FXH_LEG_PAD;
}

/**
 * Read depth for the cron scorer: the gap-fill window + one full lookback + the confirmation fold's
 * raw states + the pad. `fxh-legs.test.ts` pins that the newest scores identically to a read of the
 * whole stored history, and that the carried series reaches back past `gapFillFrom`.
 */
export const FXH_SCORER_LEG_LIMIT = GAP_FILL_DAYS + VELOCITY_WINDOW + confirmClosesFor("FXH") + FXH_LEG_PAD;

export async function readFxhLegs(
  store: Pick<Store, "getSeriesBulk">,
  legLimit: number,
): Promise<FxhLegs | null> {
  const bySeries = await store.getSeriesBulk([...FXH_LEG_IDS], { limit: legLimit });
  const toObs = (id: string): Observation[] =>
    (bySeries.get(id) ?? []).map((p) => ({ date: p.date, value: p.value }));
  const legs = { usEur: toObs(FXH_LEG_IDS[0]), chfUsd: toObs(FXH_LEG_IDS[1]), jpyUsd: toObs(FXH_LEG_IDS[2]) };
  if (legs.usEur.length === 0 || legs.chfUsd.length === 0 || legs.jpyUsd.length === 0) return null;
  return legs;
}
