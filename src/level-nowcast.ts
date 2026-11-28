import type { Observation } from "./domain-types.js";
import { type CarryWindow, resolveCarryWindow, resolveCarryWindows } from "./nowcast-carry.js";

/** A same-day estimate of a level series (a yield, a spread, a breakeven) — the oil lane's `OilNowcast` shape. */
export interface LevelNowcast {
  date: string;
  value: number;
  /** The anchor print the carry extends from (R10's walk-back). */
  fromDate: string;
}

/** Additive carry over a yield-like lead: `est(t) = print(t0) + beta * [L(t) - L(t0)]`. */
export function nowcastLevelCarry(prints: Observation[], lead: Observation[], beta: number): LevelNowcast | null {
  const carry = resolveCarryWindow(prints, [lead]);
  return carry ? levelAt(carry, beta) : null;
}

/** `nowcastLevelCarry` on every lead date past the newest print (I2), oldest first. */
export function nowcastLevelCarries(prints: Observation[], lead: Observation[], beta: number): LevelNowcast[] {
  return resolveCarryWindows(prints, [lead]).map((w) => levelAt(w, beta));
}

const levelAt = (carry: CarryWindow, beta: number): LevelNowcast => ({
  date: carry.nows[0]!.date,
  value: carry.print.value + beta * (carry.nows[0]!.value - carry.bases[0]!.value),
  fromDate: carry.print.date,
});

/** The date-joined difference `a − b` (a yield spread from two legs, e.g. sovereign-quote US10Y − US3M for T10Y3M). @internal */
export function levelSpread(a: readonly Observation[], b: readonly Observation[]): Observation[] {
  const bByDate = new Map(b.map((o) => [o.date, o.value]));
  return a.flatMap((o) => {
    const v = bByDate.get(o.date);
    return v === undefined ? [] : [{ date: o.date, value: o.value - v }];
  });
}

/** Additive carry over a price RATIO's log return: `est(t) = print(t0) + beta * ln[(N(t)/N(t0)) / (D(t)/D(t0))]`. */
export function nowcastRatioCarry(prints: Observation[], num: Observation[], den: Observation[], beta: number): LevelNowcast | null {
  const carry = resolveCarryWindow(prints, [num, den]);
  return carry ? ratioAt(carry, beta) : null;
}

/** `nowcastRatioCarry` on every lead date past the newest print (I2), oldest first. */
export function nowcastRatioCarries(prints: Observation[], num: Observation[], den: Observation[], beta: number): LevelNowcast[] {
  return resolveCarryWindows(prints, [num, den]).flatMap((w) => ratioAt(w, beta) ?? []);
}

function ratioAt(carry: CarryWindow, beta: number): LevelNowcast | null {
  const [nb, db] = carry.bases as [Observation, Observation];
  const [nn, dn] = carry.nows as [Observation, Observation];
  if (nb.value <= 0 || db.value <= 0 || nn.value <= 0 || dn.value <= 0) return null;
  return { date: nn.date, value: carry.print.value + beta * Math.log(nn.value / nb.value / (dn.value / db.value)), fromDate: carry.print.date };
}

/** One US rate id's lead off its legs' series (in its registry `estimator.leads` order): the yield itself, or R1's spread. */
export function usRateLead(legs: readonly Observation[][]): Observation[] {
  return legs.length === 2 ? levelSpread(legs[0]!, legs[1]!) : (legs[0] ?? []);
}
