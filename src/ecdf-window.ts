/**
 * Rolling ECDF window, in stored closes (≈2 trading years) — the window `leg-percentile.ts` ranks
 * over. A leaf with no imports, so a front-end test can pin its copy against the value without
 * loading the danger-engine graph.
 *
 * MEASURED-REACHABLE, not chosen by feel — and measured on the RIGHT axis. The metric is NOT "the
 * shallowest EW-capable member's history" (the spec's original wording, retracted 2026-07-25:
 * `EURC` holds 89 distinct obs_dates and `BUND` 85, because they entered an EW-capable family
 * recently — yet a pillar is computed from whatever members are live each day, so a short member
 * does not shorten the pillar series). It is the depth of the STORED `leg_pillars` series
 * `ewPctCell` actually reads: per `(sleeve, 'EARLY-WARN', LEG_PILLAR_GENERATOR)`, the count of
 * non-null values. Measured 2026-07-25 on the backfilled dev DB: 900 non-null closes on ALL NINE
 * legs, so 500 leaves 400 closes of margin.
 *
 * `npm run probe:leg-percentile-depth` re-asserts that against a live history-carrying DB
 * (read-only; not in the suite), so run it after raising this constant — past what the data
 * supports it exits 1 rather than every leg silently pinning at `warmup` forever.
 */
export const ECDF_WINDOW = 500;
