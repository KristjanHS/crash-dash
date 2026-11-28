/** Euro-area HICP Δ6m (estr-hike-side-leg R5): y/y % at month t minus y/y at t−6 (pp). The ONE transform —
 *  cron, backfill and the ESTR hike-side study all fold it, so the study's "today" Δ6m equals the served value. */

import type { Observation } from "./domain-types.js";

export const HICP_SERIES = "CP0000EZ19M086NEST";
const YOY_MONTHS = 12;
const DELTA_MONTHS = 6;
/** Index months burned before the first Δ6m value. */
export const HICP_HEAD_MONTHS = YOY_MONTHS + DELTA_MONTHS;

const monthOf = (date: string): string => date.slice(0, 7);
function shiftMonth(ym: string, k: number): string {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** Month-keyed lookups (last obs in a month wins), so a gap month drops its row instead of mis-pairing. */
function byMonth(obs: readonly Observation[]): Map<string, number> {
  return new Map(obs.map((o) => [monthOf(o.date), o.value]));
}

/** y/y % change, dated the reference month's 1st (FRED's own dating). @internal */
export function hicpYoY(index: readonly Observation[]): Observation[] {
  const m = byMonth(index);
  return [...m].flatMap(([ym, v]) => {
    const prev = m.get(shiftMonth(ym, -YOY_MONTHS));
    return prev === undefined || prev === 0 ? [] : [{ date: `${ym}-01`, value: (v / prev - 1) * 100 }];
  });
}

/** y/y at month t minus y/y at t−6 (pp), dated as `hicpYoY`. ≥ 0 = inflation not falling. */
export function hicpDelta6m(index: readonly Observation[]): Observation[] {
  const yoy = hicpYoY(index);
  const m = byMonth(yoy);
  return yoy.flatMap((o) => {
    const prev = m.get(shiftMonth(monthOf(o.date), -DELTA_MONTHS));
    return prev === undefined ? [] : [{ date: o.date, value: o.value - prev }];
  });
}
