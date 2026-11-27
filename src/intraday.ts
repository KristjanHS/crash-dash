import { isoDay } from "./dates.js";
/**
 * Intraday-run policy (ruled 2026-09-29). A daily-close parser
 * KEEPS today's running bar at every hour — an
 * off-schedule daytime run persists the live, in-progress price so the charts and the feed-lag
 * roster move intraday. It is overwritten at EOD for free: `readings_latest` collapses each
 * (indicator, obs_date) to the newest `run_at`, so the 22:00 UTC cron's final close supersedes it.
 *
 * What keeps a provisional price out of the alert ladder is the RUN, not the parser: a run started
 * before the cutoff is an INTRADAY run (`api/cron/run.ts` / the `npm start` CLI pass
 * `{ intraday: true }`), which pushes nothing and writes NO `alert_log` row (`run-cycle-persist.ts`), so the
 * push, the notify baseline and the scoring prev-state all stay on the last EOD run. Its re-derived
 * verdict goes to the `intraday_verdict` slot instead, which every verdict READ serves (`servedVerdict`).
 *
 * INTRADAY_CUTOFF_UTC_MIN = 21:05 UTC is a conservative all-markets-closed cutoff: the latest US
 * cash close is 21:00 UTC (winter EST, 16:00 ET); European closes (15:30–17:30 UTC) are
 * earlier. At/after it every daily bar this repo fetches is
 * final — the scheduled 22:00 cron is always a full EOD run (a feed whose own session closes earlier: `SESSION_CLOSE_UTC_MIN`). The sovereign-quote cards' daily bars lag to D+1, so their
 * EOD reading is scored off today's live-quote head and stored `estimated` (`stampEstimateSourced`) until the bar lands.
 */
export const INTRADAY_CUTOFF_UTC_MIN = 21 * 60 + 5; // 21:05 UTC

/** True when `now`'s UTC time-of-day is before the all-markets-closed cutoff — a run started now
 *  may carry an in-progress bar, so it is an intraday (silent, alert-less) run. */
export function isIntradayRun(now: Date): boolean {
  return now.getUTCHours() * 60 + now.getUTCMinutes() < INTRADAY_CUTOFF_UTC_MIN;
}

/** Is a cycle TRIGGERED at `now` intraday (cron, CLI, smoke-cron's classifier)? A UTC Sat/Sun run (the Saturday repair
 *  cron, vercel.json) is ALWAYS intraday — never a push or alert_log row; on a weekday `forceEmail` (`?email=force`,
 *  the owner's send-verify) overrides the cutoff. `isIntradayRun` stays the pure cutoff: it also classifies stored run_at. */
export function isIntradayCronRun(now: Date, forceEmail = false): boolean {
  return [0, 6].includes(now.getUTCDay()) || (!forceEmail && isIntradayRun(now));
}

/** The verdict a read surface serves (`/api/lab`, `/api/status`, `/api/exposure`): the `intraday_verdict` slot
 *  when it is NEWER than the last EOD `alert_log` row, else the EOD row — so one daytime run re-derives the
 *  whole board (ruled 2026-10-05; `?rederive=0` on the cron empties the slot instead). A stale slot (older
 *  than the EOD row) is ignored. Epoch-ms compare: PostgREST emits `+00:00`, the slot the JS `Z` form. */
export function servedVerdict<A extends { firedAt: string }>(eod: A | null, slot: A | null): A | null {
  return slot !== null && (eod === null || Date.parse(slot.firedAt) > Date.parse(eod.firedAt)) ? slot : eod;
}

/** The slot read those three surfaces share. A failed read (a synchronous throw included) degrades to null — the EOD
 *  row, never a 500 — but LOUDLY: a quietly-null slot reads exactly like "no daytime run yet", which is how an
 *  anon-ungranted slot hid the whole intraday board for days (migration 20261005120000). */
export async function readIntradaySlot<A>(
  store: { getIntradayVerdict(): Promise<A | null> },
  surface: string,
  log: (msg: string, err: unknown) => void = console.error,
): Promise<A | null> {
  try {
    return await store.getIntradayVerdict();
  } catch (err) {
    log(`[${surface}] intraday_verdict read failed - serving the EOD verdict:`, err);
    return null;
  }
}

/**
 * Per-feed finality bound, keyed by stored id: a write made this many minutes or more past its obs date's 00:00Z is
 * final (the 2026-11-06 `isProvisional` ruling); an id absent here takes `INTRADAY_CUTOFF_UTC_MIN`.
 * the closes-feed `=X`-fed ids at 48 h: label D's settled value lands only when the bar stamped D+1 settles (`parseClosesChart`).
 * COPPER (`HG=F`) at D+1 06:00Z, a STATED margin past the observed 04:56Z settle: the closes provider swaps the EOD last trade (22:56Z) for the COMEX settle overnight.
 * Keys = the `feed: "snapshot"` `INPUT_SERIES` ids ∪ every `=X`-fed stored id ∪ COPPER (pinned in `intraday.test.ts`).
 */
const FX_SETTLED_UTC_MIN = 48 * 60;
const COMEX_SETTLED_UTC_MIN = 30 * 60;
export const SESSION_CLOSE_UTC_MIN: Readonly<Record<string, number>> = {
  F11: FX_SETTLED_UTC_MIN, // CNY=X
  F17: FX_SETTLED_UTC_MIN, // JPY=X
  FXH: FX_SETTLED_UTC_MIN, // EURUSD=X (+ CHF=X / JPY=X)
  KRW: FX_SETTLED_UTC_MIN, // KRW=X
  DEXUSEU: FX_SETTLED_UTC_MIN, // EURUSD=X
  CMP_FXH_DEXUSEU: FX_SETTLED_UTC_MIN, // EURUSD=X
  CMP_FXH_DEXSZUS: FX_SETTLED_UTC_MIN, // CHF=X
  CMP_FXH_DEXJPUS: FX_SETTLED_UTC_MIN, // JPY=X
  COPPER: COMEX_SETTLED_UTC_MIN, // HG=F
};

/** The session-close minute `isProvisional` draws for stored id `id`; no id / unmapped ⇒ the all-markets UTC cutoff. */
function sessionCloseUtcMin(id?: string): number {
  return (id === undefined ? undefined : SESSION_CLOSE_UTC_MIN[id]) ?? INTRADAY_CUTOFF_UTC_MIN;
}

/** True when the row was written before its own obs date's session close (`sessionCloseUtcMin(id)`) — an in-progress
 *  bar an EOD run will supersede. Pass the row's stored `id` wherever it is in scope: without it the UTC cutoff applies.
 *  Epoch-ms compare (Postgres emits `+00:00`); no `runAt` ⇒ false. */
export function isProvisional(p: { date: string; runAt?: string }, id?: string): boolean {
  if (p.runAt === undefined) return false;
  return Date.parse(p.runAt) < Date.parse(`${p.date}T00:00:00Z`) + sessionCloseUtcMin(id) * 60_000; // ≡ provisionalBefore, sans ISO round-trip (hot: every stored row, every cycle)
}

/** The `run_at` bound `isProvisional` draws for obs date `date` of id `id` (ISO instant): a row written earlier is provisional. */
export function provisionalBefore(date: string, id?: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + sessionCloseUtcMin(id) * 60_000).toISOString();
}

/** The stored dates an insert-missing writer may treat as done: a provisional or `estimated` row counts as
 *  missing, so the feed's final close rewrites it (A7, E3). */
export function finalDates(points: readonly { date: string; runAt?: string; estimated?: boolean }[], id?: string): Set<string> {
  return new Set(points.filter((p) => p.estimated !== true && !isProvisional(p, id)).map((p) => p.date));
}

/** B5/B7 (R7/R9): `newest` iff it is provisional AND newer than the EOD run's own row — the INTRADAY
 *  overlay a board card / `/lab` chip serves; else undefined (the EOD row stands). */
export function intradayOverlay<P extends { date: string; runAt?: string }>(newest: P | undefined, ownDate: string, id?: string): P | undefined {
  return newest !== undefined && newest.date > ownDate && isProvisional(newest, id) ? newest : undefined;
}

/**
 * Cron gap-fill window (calendar days, hand-set): how far back each run insert-misses an id's scored
 * series. The run otherwise persists ONE newest row per id, so a date that is never the newest on a
 * run — a late FRED print, a missed cron, a closes provider `=X` Friday that only surfaces as a bar once the
 * next week opens — stayed a hole until a manual backfill. Measured
 * on prod 2026-09-28: F1/R2/OVX/F11 dates first written by hand 2–7 days late. Two weeks spans a
 * long-weekend print lag plus a missed-cron week without re-scoring deep history nightly.
 */
export const GAP_FILL_DAYS = 14;

/** Relative tolerance of the official write-back's value compare: prod rows differ from a re-derived value by ~1e-14. */
export const VALUE_EPS = 1e-9;
export const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= VALUE_EPS * Math.max(1, Math.abs(b));

/** First ISO date inside the gap-fill window ending at `asOf` (inclusive). */
export function gapFillFrom(asOf: string): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - GAP_FILL_DAYS);
  return isoDay(d);
}
