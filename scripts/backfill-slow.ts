/**
 * Point-in-time backfill for the slow "bubble-state" tier — seeds a CONTINUOUS
 * metric history for `price-accel`, `complacency-vix`, `complacency-high` into
 * `readings`, shadowing the old `value=score` rows via the vintage model.
 *
 * This is a NEW script, deliberately NOT the existing
 * `scripts/backfill.ts` / `backfillHistory` seam:
 *
 *   - `backfillHistory` is INSERT-MISSING-ONLY (it filters out existing obs_dates),
 *     so for already-seeded slow dates it would write zero rows — useless here,
 *     where the whole point is to REPLACE the old `value=score` semantics.
 *   - There is no `UNIQUE(indicator_id, obs_date)` on `readings`, so a PostgREST
 *     upsert on that natural key is impossible without a migration.
 *
 * The vintage model makes it migration-free: `readings_latest` is
 * `DISTINCT ON (indicator_id, obs_date) … ORDER BY run_at DESC`, so a row inserted
 * with a NEWER `run_at` shadows the old `value=score` row in every read path. So we
 * INSERT unconditionally with one fresh `run_at` for the whole pass; re-running picks
 * a still-newer `run_at` → re-shadows → idempotent for reads. Old vintages no longer
 * accrue: the backfill runner self-prunes shadowed rows after every pass (Rung 4),
 * keeping only the vintage `readings_latest` serves.
 *
 * POINT-IN-TIME parity: at each date `t` we score with ONLY data ≤ `t`, using the
 * SAME windows the live run sees so the seeded metric matches what actually fired:
 *   - QQQ = trailing ~2 calendar years (mirrors the live closes provider `range=2y` window),
 *   - VIX = the full history ≤ t (mirrors the live `fetchSeries(.., {fullHistory})`).
 * Percentiling over the full QQQ history then slicing would be look-ahead biased and
 * disagree with the `alert_log` bands — hence the trailing window, not an expanding
 * one, for QQQ. (The planned "expanding window" is refined here: QQQ is
 * trailing, VIX is expanding, each matching its live feed.)
 *
 * Run it ON THE HOST (same posture as `scripts/backfill.ts`): `getStore()` fails loud
 * when SUPABASE_URL + SUPABASE_SERVICE_KEY are unset.
 *   - Dev / local DB:  `npm run backfill:slow` with `.env.local` — it wraps itself in
 *     `scripts/db.sh with dev` (default-DOWN stack up for the run, then back down);
 *     `backfill:slow:raw` skips the wrapper inside a held-open session.
 *   - Real prod seed:  `npm run backfill:slow:raw -- --env=prod` — the `:raw` variant is
 *     REQUIRED; the wrapped script would boot a local dev stack in front of a prod run.
 *
 * Entrypoint: `scripts/backfill/run.ts` (the reusable runner) is the sole CLI —
 * this file only exports the pure orchestration (`backfillSlow`/`liveSlowDeps`) the
 * `slow` registry job binds to.
 */
import type { Observation } from "../src/domain-types.js";
import { realFeeds } from "../src/feed-ports.js";
import { fetchDailyCloses } from "../src/prices.js";
import { slowBackfillRows } from "../src/slow.js";
import type { Store } from "../src/store.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

/** Default seed depth (years of metric history to emit). Mirrors `BACKFILL_YEARS`. */
export const SLOW_BACKFILL_YEARS = 15;

/** ISO date `years` before `now` — the seed-depth cutoff (oldest date to emit). */
export function slowIsoCutoff(now: Date, years: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return isoDay(d);
}

/** Injectable feed seam (mirrors `scripts/backfill.ts`) — the test injects stubs. */
export interface SlowBackfillDeps {
  fetchVix(): Promise<Observation[]>;
  fetchQqq(): Promise<Observation[]>;
}

/** Production feeds: VIXCLS (full history) + deep QQQ via the price feed (prices.ts). */
export const liveSlowDeps: SlowBackfillDeps = {
  fetchVix: () => realFeeds.fetchSeries("VIXCLS", { fullHistory: true, now: new Date(), env: readEnv() }),
  fetchQqq: () => fetchDailyCloses("QQQ", { deep: true, now: Date.now, env: readEnv() }),
};

export interface SlowBackfillResult {
  /** Rows inserted (one fresh vintage for the whole pass). */
  inserted: number;
  /** The `run_at` vintage stamped on this pass. */
  runAt: string;
  /** Distinct dates seeded. */
  dates: number;
  /** Indicator ids written — the runner self-prunes shadowed vintages for these. */
  ids: string[];
}

/**
 * Fetch the deep feeds, recompute the point-in-time metric series, and INSERT every
 * row under one fresh `run_at` (the vintage that shadows the old `value=score` rows).
 * Idempotent for reads: a re-run inserts a still-newer vintage → `readings_latest`
 * returns the latest metric per (id, date).
 */
export async function backfillSlow(
  store: Store,
  deps: SlowBackfillDeps,
  opts: { years?: number; now?: Date } = {},
): Promise<SlowBackfillResult> {
  const now = opts.now ?? new Date();
  const cutoff = slowIsoCutoff(now, opts.years ?? SLOW_BACKFILL_YEARS);
  const [qqq, vix] = await Promise.all([deps.fetchQqq(), deps.fetchVix()]);
  const rows = slowBackfillRows(qqq, vix, cutoff);
  const runAt = now.toISOString();
  if (rows.length > 0) await store.recordReadings(rows, runAt);
  const dates = new Set(rows.map((r) => r.date)).size;
  return { inserted: rows.length, runAt, dates, ids: [...new Set(rows.map((r) => r.indicatorId))] };
}
