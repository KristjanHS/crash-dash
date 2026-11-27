/**
 * PostgREST pagination + truncation guards, split out of `store.ts` 2026-08-09 (audit round 3,
 * R7) alongside `store-rows.ts`. Ergonomic only: no behaviour change.
 *
 * Pure and IO-free — every DB call is passed in as a `fetchPage` callback — which is why these
 * three are unit-tested without a database (`store.pure-seams.test.ts`).
 */
import { POSTGREST_MAX_ROWS } from "./postgrest-limits.js";
import type { SeriesPoint } from "./store.js";

/**
 * Throw if a deep read came back with EXACTLY `max_rows` rows — the fingerprint of a
 * PostgREST silent truncation. Only fires when the caller did NOT deliberately request
 * exactly the cap (an unbounded read passes `requestedLimit` undefined; a bounded read
 * that legitimately asks for `POSTGREST_MAX_ROWS` is not a truncation). A loud throw
 * naming the query beats a silently short result feeding the dwell/scoreboard gates.
 */
export function assertNotTruncated(rowCount: number, query: string, requestedLimit?: number): void {
  if (rowCount >= POSTGREST_MAX_ROWS && requestedLimit !== POSTGREST_MAX_ROWS) {
    throw new Error(
      `Supabase read ${query} returned ${rowCount} rows == PostgREST max_rows (${POSTGREST_MAX_ROWS}) - ` +
        `the result was silently truncated at the wire cap. Paginate or narrow this query; do not trust the rows.`,
    );
  }
}

/**
 * Page a `.range()`-based read to completeness: call `fetchPage(offset, count)` for
 * successive windows until we have `want` rows or a short page signals the source is
 * exhausted — so a deep read returns EVERY row regardless of the `max_rows` wire cap.
 * `pageSize` defaults to the cap (one page = the biggest PostgREST will serve); tests
 * inject a smaller value to exercise the stitch loop without a real DB.
 */
export async function paginateRows<T>(
  fetchPage: (offset: number, count: number) => Promise<T[]>,
  want: number,
  pageSize: number = POSTGREST_MAX_ROWS,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (all.length < want) {
    const count = Math.min(pageSize, want - all.length);
    const page = await fetchPage(offset, count);
    all.push(...page);
    if (page.length < count) break; // short page ⇒ source exhausted
    offset += page.length;
  }
  return all;
}

/**
 * Which requested ids came back SHORT of `limit` after `getSeriesBulk`'s global-window
 * bucketing — the ids that must be re-fetched per-id to honor the "each id exactly as
 * getSeries would" contract. The single `newest ids.length*limit` global window is correct
 * for DENSE daily calendars (≈ one row per id per date), but a sparse-cadence member (EBP
 * monthly; the quarterly F12 that surfaced this was retired 2026-07-17) has its newest
 * `limit` obs_dates spread across a span far wider
 * than the dense-day window covers, so its bucket is starved to a handful of rows — which
 * `buildMemberStateAt` (danger-member-state.ts) then reads as ABSENT at the deeper lookbacks (OQ-5 Stage
 * 5.2 — before it, the same starved bucket was imputed CALM). Either way the bias is toward calm:
 * an absent member is EXCLUDED from the severity max, and 0 is that max's identity, so a starved
 * sparse-cadence member still silently quiets the live dial. Re-fetching is the fix, not the
 * severity rule. A genuinely short series is also flagged; it re-fetches once and still returns
 * short (correct), and the re-fetch is cheap because only the few sparse/short ids trigger it.
 * Pure + exported so the shortfall decision is unit-testable without a DB.
 */
export function bucketShortfallIds(
  ids: string[],
  bucketed: Map<string, SeriesPoint[]>,
  limit: number,
): string[] {
  return ids.filter((id) => (bucketed.get(id)?.length ?? 0) < limit);
}

/** `getEstimateDates`' shape off its raw (id, date) rows, shared by both stores: per id, sorted and deduped. */
export function estimateDatesById(rows: readonly (readonly [string, string])[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const [id, date] of rows) out.set(id, (out.get(id) ?? new Set<string>()).add(date));
  return new Map([...out].map(([id, ds]) => [id, [...ds].sort()]));
}

/** Max `.in(col, list)` values per PostgREST request — the edge rejects an over-long URL. */
const IN_LIST_CHUNK = 200;

/** `xs` split into consecutive slices of at most `size`; `[]` for an empty list. */
export function chunk<T>(xs: readonly T[], size: number = IN_LIST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
