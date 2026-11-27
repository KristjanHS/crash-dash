import type { Observation, State } from "./domain-types.js";
import { type CarryWindow, resolveCarryWindow, resolveCarryWindows } from "./nowcast-carry.js";

export interface OilNowcast {
  /** The future close the estimate was computed from — never later (F1's U4). */
  date: string;
  value: number;
  /** The print the estimate extends from — the ANCHOR print, not necessarily the newest one (R10's walk-back). */
  fromDate: string;
  /** The head row's own state — set only on a notify-dial estimate head (`notifyHeadEstimates`). */
  state?: State;
}

/** Same-day spot estimate: the anchor print carried over the future's log return,
 *  `est(t) = spot(t0) * exp(beta * [ln F(t) - ln F(t0)])`.
 *
 *  Multiplicative because spot is a price, where F1's OAS is in pp and carries additively. Only the RETURN transfers:
 *  Dated Brent is not ICE Brent and the basis blows out in a physical shock (spot/future ran 1.002 -> 1.203 over four
 *  weeks in 2026), so a level copy is not an option. Residual risk is directional — BRENT's h=3 bias is -0.66%, i.e. the
 *  carry UNDER-shoots while the basis widens, understating an oil shock rather than crying one (R7).
 *
 *  A multi-session gap accumulates with no extra loop, a log return being the sum of the intervening daily ones.
 *  Null once the print series has caught up, past `NOWCAST_MAX_CARRY_DAYS` (R9), with no exact-date base in reach (R10),
 *  or on a non-positive price: WTI printed below zero in 2020-04, and neither a log return nor a percent divergence
 *  survives that. Display-only — this value never reaches band selection, scoring, or the `atTrailingPeak` gates (R3). */
export function nowcastOilSpot(spot: Observation[], future: Observation[], beta: number): OilNowcast | null {
  const carry = resolveCarryWindow(spot, [future]);
  return carry ? oilSpotAt(carry, beta) : null;
}

/** `nowcastOilSpot` on every futures date past the newest print (a retired plan I2). */
export function nowcastOilSpots(spot: Observation[], future: Observation[], beta: number): OilNowcast[] {
  return resolveCarryWindows(spot, [future]).flatMap((w) => oilSpotAt(w, beta) ?? []);
}

function oilSpotAt(carry: CarryWindow, beta: number): OilNowcast | null {
  const base = carry.bases[0]!;
  const now = carry.nows[0]!;
  if (carry.print.value <= 0 || base.value <= 0 || now.value <= 0) return null;
  return {
    date: now.date,
    value: carry.print.value * Math.exp(beta * Math.log(now.value / base.value)),
    fromDate: carry.print.date,
  };
}

/** Non-null only when the estimate diverges from the print by MORE than the id's OWN `cutPct` (R6) — both directions.
 *  Percent rather than absolute, because the cut is: the same dollar gap is noise on Brent and a signal on a $20 WTI. */
export function oilEstDivergence(
  printValue: number,
  est: OilNowcast | null,
  cutPct: number,
): { est: OilNowcast; deltaPct: number } | null {
  if (est === null || printValue <= 0) return null;
  const deltaPct = ((est.value - printValue) / printValue) * 100;
  return Math.abs(deltaPct) > cutPct ? { est, deltaPct } : null;
}
