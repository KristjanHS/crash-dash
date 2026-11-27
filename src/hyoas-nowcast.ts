import type { Observation } from "./domain-types.js";
import { resolveCarryWindow } from "./nowcast-carry.js";

export interface OasNowcastParams {
  spreadDurationYears: number;
  hedgeBeta: number;
}

/** Arm C (`price − β·hedge`) reverse-fit constants — hand-set off `npm run probe:f1-nowcast` (`-- --target=f2` for F2).
 *  Probe-only since E8 (failed the E6 gate): the estimate reaches neither the wire, the push nor band selection. */
export const HY_NOWCAST_PARAMS: OasNowcastParams = { spreadDurationYears: 5.31, hedgeBeta: 1.02 };
const F2_NOWCAST_PARAMS: OasNowcastParams = { spreadDurationYears: 9.06, hedgeBeta: 1.16 };

/** Indicator id → the stored price/hedge input ids + constants its nowcast runs on — the ONE map the probes read
 *  (`probe-f1-nowcast`); E8 took it off the wire and the push. */
export const OAS_NOWCAST_LEGS: Readonly<Record<"F1" | "F2", { price: string; hedge: string; params: OasNowcastParams }>> = {
  F1: { price: "HYG", hedge: "IEF", params: HY_NOWCAST_PARAMS },
  F2: { price: "LQD", hedge: "IEF", params: F2_NOWCAST_PARAMS },
};

export interface OasNowcast {
  /** The close the estimate was computed from — never later (U4). */
  date: string;
  value: number;
  /** The FRED print the estimate extends from — the ANCHOR print, which R10's walk-back allows to be older than the
   *  newest one. Since S2a both consumers hand a multi-print window, so the walk-back can anchor an older print (R10). */
  fromDate: string;
}

/** Same-day HY-OAS estimate: the last print carried over the ADJUSTED, date-ascending price/hedge closes since
 *  (`resolveCarryWindow`, R11 — the shared seam, so R9's staleness cap and R10's exact-date base bind this lane too).
 *  Null once FRED has caught up, past `NOWCAST_MAX_CARRY_DAYS`, or with no exact-date base pair in reach. */
export function nowcastHyOas(
  oas: Observation[],
  hyg: Observation[],
  ief: Observation[],
  params: OasNowcastParams,
): OasNowcast | null {
  const carry = resolveCarryWindow(oas, [hyg, ief]);
  if (!carry) return null;
  const [hygBase, iefBase] = carry.bases as [Observation, Observation];
  const [hygNow, iefNow] = carry.nows as [Observation, Observation];
  const excess = Math.log(hygNow.value / hygBase.value) - params.hedgeBeta * Math.log(iefNow.value / iefBase.value);
  return {
    date: hygNow.date,
    value: carry.print.value - (excess / params.spreadDurationYears) * 100,
    fromDate: carry.print.date,
  };
}
