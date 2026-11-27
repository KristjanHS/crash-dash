import type { Observation } from "./domain-types.js";

/** Calendar days between two ISO `YYYY-MM-DD` dates. */
export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);

/** Past this much print staleness a carry is DROPPED, never extrapolated.
 *  ONE constant for both lanes: the oil-nowcast hold-out study validated the oil carry to h=9, the structural EIA hole, and F1's
 *  worst case is a long weekend — 14 clears both with headroom, and is deliberately NOT pinned at the measurement. Fixtures
 *  derive from it; never restate the value. */
export const NOWCAST_MAX_CARRY_DAYS = 14;

/** The close on `date` EXACTLY, or undefined — never the nearest earlier one (R10). */
const atDate = (s: Observation[], date: string): Observation | undefined => {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i]!.date === date) return s[i];
    if (s[i]!.date < date) return undefined;
  }
  return undefined;
};

/** The window a same-day nowcast carries over. `series[0]` is the LEAD: the estimate takes its newest date and never
 *  post-dates it (F1's U4), and every other input is pinned to that same date. */
export interface CarryWindow {
  /** The anchor print the carry extends from — not necessarily the newest print (R10's walk-back). */
  print: Observation;
  /** Per input, in the order handed in, its close on `print.date` exactly (R10). */
  bases: Observation[];
  /** Per input, in the same order, its close on the lead's newest date. */
  nows: Observation[];
}

/** Resolve the carry window both nowcast lanes share (R11). Null when:
 *  the prints have caught up with the lead close (the estimate is dropped, never blended); an input has no close on the
 *  lead's newest date; no print within `NOWCAST_MAX_CARRY_DAYS` of that close has an exact-date base in EVERY input.
 *
 *  The exact-date base is R10: a base allowed to slide earlier than its print would re-count a move the print already
 *  contains. On a miss the walk steps back a print rather than sliding the base, so a one-day feed hole lengthens the
 *  carry instead of corrupting it — and the cap, measured from the ANCHOR print, bounds how far back that can reach. */
export function resolveCarryWindow(prints: Observation[], series: Observation[][]): CarryWindow | null {
  const leadNow = series[0]?.at(-1);
  const newestPrint = prints.at(-1);
  if (!leadNow || !newestPrint || leadNow.date <= newestPrint.date) return null;
  return carryWindowOn(prints, series, leadNow.date);
}

/** One window per lead date past the newest print (a retired plan I2), each resolved
 *  as `resolveCarryWindow` resolves the newest; a date some input has no exact close on is skipped, never slid. */
export function resolveCarryWindows(prints: Observation[], series: Observation[][]): CarryWindow[] {
  const newestPrint = prints.at(-1);
  if (!newestPrint) return [];
  return (series[0] ?? []).filter((o) => o.date > newestPrint.date).flatMap((o) => carryWindowOn(prints, series, o.date) ?? []);
}

function carryWindowOn(prints: Observation[], series: Observation[][], date: string): CarryWindow | null {
  const nows = series.map((s) => atDate(s, date));
  if (!nows.every((n): n is Observation => n !== undefined)) return null;
  for (let i = prints.length - 1; i >= 0; i--) {
    const print = prints[i]!;
    if (daysBetween(print.date, date) > NOWCAST_MAX_CARRY_DAYS) return null;
    const bases = series.map((s) => atDate(s, print.date));
    if (bases.every((b): b is Observation => b !== undefined)) return { print, bases, nows };
  }
  return null;
}
