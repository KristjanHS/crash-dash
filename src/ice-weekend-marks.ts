// Pure leaf (zero imports bar a type): shared by the live FRED fetch (src/fred.ts) and the committed-archive
// readers (src/hyoas-vintage.ts, scripts/backfill/fred-archive.ts) — a read handler bundling the vintage must
// never reach the feed module itself (api/no-upstream-fetch.test.ts, scripts/arch-rules.test.ts).
import type { Observation } from "./domain-types.js";

/**
 * ICE BofA series (`BAML*`: F1/F2/F10/CCC OAS + yields) print a month-end mark on a
 * Saturday/Sunday — not a trading close (F1 Sat 2026-02-28 was that episode's only raw RED).
 * Every BAML id is daily, so the weekend drop is safe here; it must NOT widen to all FRED ids:
 * weekly ICSA is dated Saturday and monthly series are dated the 1st, which can be a weekend.
 */
export function dropWeekendMarks(series: string, obs: Observation[]): Observation[] {
  if (!series.startsWith("BAML")) return obs;
  return obs.filter((o) => {
    const dow = new Date(`${o.date}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });
}
