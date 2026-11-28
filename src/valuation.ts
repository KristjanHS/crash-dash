/**
 * Valuation context (W1-k): turn the persisted Shiller CAPE series (id `F7`) into a
 * one-sided severity multiplier + z context (`CapeValuation` DTO) for the /status CAPE card
 * and the detail-chart band degrade verdict (api/indicators.ts). Pure + fail-safe.
 *
 * Method (RULED 2026-07-18):
 *  - Baseline = a TRAILING z-score: today's CAPE vs the mean/sd of its own ~30yr trailing
 *    window (`VAL_Z_WINDOW` monthly obs, current point included) — NOT absolute cutoffs,
 *    NOT full-history percentile.
 *  - Direction = ONE-SIDED. Overvalued (z>0) ⇒ m<1 (deepens danger, "further to fall");
 *    fair/cheap (z≤0) ⇒ clamp at 1.0. NEVER m>1 (cheap valuation is not an all-clear that
 *    could pull the dial DOWN a band — it just stops amplifying).
 *  - Fail-safe = identity (m = 1.0), never an alarm: an absent / too-short / lagging series,
 *    or a degenerate (sd≈0) window, all degrade to a no-op. Unlike an index-EOD feed, a dead CAPE
 *    feed must not move the band — the §5 guard that makes the whole signal safe to ship.
 *
 * Valuation's one danger home is the `ECY` danger-engine member (valuation family) — the dial applies
 * NO valuation multiplier (`mEff` retired, ruled O2 2026-08-11); this module is display context only.
 *
 * Constants are FIRST-CUT / eyeball-tunable at D-E3
 * and pinned in `valuation.test.ts`. They are METHODOLOGICAL — a trailing window + a linear clamp —
 * NOT fitted to the dial's ~14 worlds (the repo is allergic to world-fitting).
 */

/** ~30yr of monthly obs. The trailing z-score baseline window; a full window is REQUIRED
 *  (a partial DB degrades to m=1.0 rather than z-score against a short, untrustworthy history).
 *  First-cut / eyeball-tunable (D-E3). */
export const VAL_Z_WINDOW = 360;
/** z at which the multiplier reaches its floor; z beyond this clamps. First-cut / tunable (D-E3). @internal */
export const VAL_Z_CAP = 2.0;
/** Deepest multiplier — the most a rich market amplifies within-band severity. m never drops below
 *  this, so valuation can deepen the ● but a first cut can't run away. First-cut / tunable (D-E3). @internal */
export const VAL_M_FLOOR = 0.85;
/** Lag budget (calendar days): CAPE is a MONTHLY point dated `YYYY-MM-01`, expected ≤~31d old
 *  when the feed is kept current. Beyond this (≈2 missed monthly cycles) the feed is treated as dead
 *  ⇒ m=1.0. Sized ABOVE one month deliberately: too-small would falsely degrade a healthy monthly
 *  feed, while a slightly-lagging slow-moving CAPE is near-harmless. First-cut (D-E3).
 *  CADENCE (`backfillCapeOnCron` in `run-seeds.ts`): every cron run rewrites the open month `estimated` and value-repairs
 *  the last `F7_REPAIR_MONTHS` closed months, so the budget never absorbs manual-seed gaps. It is still
 *  sized against the SOURCE's cadence, not the cron's: the source publishes ~12 CAPE points/yr, so the
 *  binding gap is the source's own ~31d month — 60d ≈ 2 missed monthly publications. Budget STANDS. @internal */
export const VAL_MAX_STALE_DAYS = 60;

/** Minimal shape shared by `Observation` (the CAPE feed) and `SeriesPoint` (store.ts). */
export type CapeObs = { date: string; value: number };

export interface CapeValuation {
  /** Severity multiplier ∈ [VAL_M_FLOOR, 1.0] — display context only, no dial consumer (O2). */
  m: number;
  /** Trailing z-score of today's CAPE, or null when degraded (for the tile's context display). */
  z: number | null;
  /** Today's (newest) CAPE value, or null when degraded. */
  value: number | null;
  /** Trailing-window MEAN CAPE — the z=0 level (the amber-onset reference the detail chart
   *  draws as CAPE's one-sided threshold line). Null when degraded. Exposed WITHOUT changing
   *  the multiplier math: it is the same `mean` already computed for the z-score below. */
  mean: number | null;
  /** true ⇒ absent / too-short / lagging / degenerate window ⇒ m forced to identity 1.0. */
  degraded: boolean;
}

const DEGRADED: CapeValuation = { m: 1.0, z: null, value: null, mean: null, degraded: true };

/** Calendar days between two ISO `YYYY-MM-DD` dates (both parse to UTC midnight). */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Compute the valuation severity multiplier from a CAPE series as of `now` (ISO `YYYY-MM-DD`).
 * Returns the identity multiplier (1.0) on every degrade path — a dead feed is a silent no-op.
 */
export function computeCapeValuation(series: readonly CapeObs[], now: string): CapeValuation {
  if (series.length === 0) return DEGRADED;

  // Defensive: sort ascending + drop any obs dated after `now` (never read the future).
  const obs = series
    .filter((o) => o.date <= now && Number.isFinite(o.value))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const newest = obs.at(-1);
  if (!newest) return DEGRADED;

  // Past its lag cut ⇒ degrade (a monthly feed that stopped publishing).
  if (daysBetween(newest.date, now) > VAL_MAX_STALE_DAYS) return DEGRADED;

  // Trailing window: the newest VAL_Z_WINDOW obs (current point included). A FULL window is
  // required — fewer means no trustworthy ~30yr baseline ⇒ degrade rather than z-score short.
  const window = obs.slice(-VAL_Z_WINDOW);
  if (window.length < VAL_Z_WINDOW) return DEGRADED;

  const n = window.length;
  const mean = window.reduce((s, o) => s + o.value, 0) / n;
  const variance = window.reduce((s, o) => s + (o.value - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  if (sd < 1e-9) return DEGRADED; // degenerate (all-equal) window — can't z-score

  const z = (newest.value - mean) / sd;

  // One-sided z→m: z≤0 ⇒ 1.0; z∈(0, VAL_Z_CAP] ⇒ linear to VAL_M_FLOOR; z>VAL_Z_CAP ⇒ VAL_M_FLOOR.
  const m = z <= 0 ? 1.0 : 1 - (1 - VAL_M_FLOOR) * (Math.min(z, VAL_Z_CAP) / VAL_Z_CAP);

  return { m, z, value: newest.value, mean, degraded: false };
}
