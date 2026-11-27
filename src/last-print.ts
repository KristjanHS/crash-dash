import type { Cadence } from "./domain-types.js";
import { ALL_INDICATORS } from "./registry.js";
import { CADENCE_OF } from "./feed-lag.js";
import { daysBetween } from "./nowcast-carry.js";
import { recentMarketDay } from "./source-holidays.js";

/** E22: the `last print D-n` card tag, served by
 *  `/api/status` (`ReadingDTO.lastPrint`) and `/api/lab` (family member `lastPrint`). */
export interface LastPrintTag {
  /** the newest stored PRINT's obs date (never an `estimated` row). */
  date: string;
  /** calendar days from `date` to the payload's reference date (`asOf`), floored at 0. */
  days: number;
  /** the registry RELEASE cadence (`CADENCE_OF`) — the tag's suffix. */
  cadence: Cadence;
  /** why the card holds a print: `cadence` = held between releases (E4); `cap` = a daily id's print behind its recent market day. */
  reason: "cadence" | "cap";
}

/** PENSION/BOTTOM rows are raw input or leg closes (`INPUT_SERIES`, `LEGP_*`, the VIX bottom legs), not scored readings. */
const NON_READING_CHANNELS: ReadonlySet<string> = new Set(["PENSION", "BOTTOM"]);
/** E4: R8's weekly GSW post holds its own cadence ("last print D-n") despite its business-day obs grid. */
const HELD_ON_CADENCE: ReadonlySet<string> = new Set(["R8"]);

/** E24: every persisted registry id observed on a business-day grid (`obsCadence ?? cadence`, so oil's weekly release counts). */
export const DAILY_ROSTER: readonly string[] = ALL_INDICATORS.filter(
  (i) => (i.obsCadence ?? i.cadence ?? "daily") === "daily" && !NON_READING_CHANNELS.has(i.channel ?? "") && !HELD_ON_CADENCE.has(i.id),
).map((i) => i.id);

const DAILY = new Set(DAILY_ROSTER);

/** `head` = the id's newest STORED row. Held-on-cadence ids (non-daily, off `DAILY_ROSTER`): always (E4); a daily id: a print
 *  dated before its `recentMarketDay`, at once. An `estimated` head ⇒ undefined — the EST mark owns that card. */
export function lastPrintTag(
  id: string,
  head: { date: string; estimated?: boolean } | undefined,
  refDate: string,
): LastPrintTag | undefined {
  if (head === undefined || head.estimated === true) return undefined;
  const cadence = CADENCE_OF.get(id) ?? "daily";
  // Floored: a head dated past `asOf` (a later intraday write) is "printed today", never a negative age.
  const days = Math.max(0, daysBetween(head.date, refDate));
  const daily = cadence === "daily" || DAILY.has(id);
  if (daily && head.date >= recentMarketDay(id, refDate)) return undefined;
  return { date: head.date, days, cadence, reason: daily ? "cap" : "cadence" };
}
