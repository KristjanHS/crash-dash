// Stitch the committed HY-OAS vintage (src/hyoas-vintage.ts, history through 2025-04) with the
// live keyless FRED tail (src/fred.ts — clamped to ~3 years, see the FRED_LOOKBACK_DAYS comment).
// Pure; fail-loud only for GROSS disagreement: a sub-gross vintage/live mismatch is a routine FRED
// revision (bps-scale) — prefer the live value and warn; beyond GROSS_TOLERANCE it's vintage
// corruption, and a gap means the live window shrank or the vintage aged out — both throw.
import type { Observation } from "./domain-types.js";

/** Vintage/live disagreement (percent points) worth noting — above this, warn via onDisagree. */
const OVERLAP_TOLERANCE = 0.01;
/** Disagreement beyond this (percent points) is vintage corruption, not a revision — throw. */
const GROSS_TOLERANCE = 0.25;
/** Max calendar days the live tail may start after the day following the vintage's last row. */
const MAX_GAP_DAYS = 7;

const DAY_MS = 86_400_000;

export function stitchHyOas(
  vintage: Observation[],
  liveTail: Observation[],
  onDisagree: (msg: string) => void = (msg) => console.warn(msg),
): Observation[] {
  const lastVintage = vintage[vintage.length - 1];
  if (!lastVintage) throw new Error("hy-oas stitch: empty vintage");
  const firstLive = liveTail[0];
  if (!firstLive) throw new Error("hy-oas stitch: empty live tail");

  const gapDays = (Date.parse(firstLive.date) - Date.parse(lastVintage.date)) / DAY_MS - 1;
  if (gapDays > MAX_GAP_DAYS) {
    throw new Error(
      `hy-oas stitch: ${gapDays}-day gap between vintage end ${lastVintage.date} and live start ${firstLive.date}`,
    );
  }

  const live = new Map(liveTail.map((o) => [o.date, o.value]));
  const stitched: Observation[] = [];
  for (const obs of vintage) {
    const liveValue = live.get(obs.date);
    if (liveValue !== undefined) {
      const disagreement = Math.abs(liveValue - obs.value);
      if (disagreement > GROSS_TOLERANCE) {
        throw new Error(
          `hy-oas stitch: vintage ${obs.value} ≠ live ${liveValue} on ${obs.date} (gross tolerance ${GROSS_TOLERANCE})`,
        );
      }
      if (disagreement > OVERLAP_TOLERANCE) {
        onDisagree(
          `hy-oas stitch: vintage ${obs.value} ≠ live ${liveValue} on ${obs.date} - live value used (FRED revision?)`,
        );
      }
    }
    // On overlap prefer the live value (fresher revisions).
    stitched.push(liveValue !== undefined ? { date: obs.date, value: liveValue } : obs);
  }
  for (const obs of liveTail) {
    if (obs.date > lastVintage.date) stitched.push(obs);
  }
  return stitched;
}
