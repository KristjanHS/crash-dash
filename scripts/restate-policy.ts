/**
 * Restate/prune/depth/cutoff PLANNER for the backfill — peeled out of `scripts/backfill.ts`
 * 2026-09-05 (token-efficiency round 3, B2a). This module holds the pure POLICY: the common
 * backfill window (floor/depth; per-id depth lives on the registry entry), the since/cutoff resolvers, the incremental fetch
 * planner (`planFetch`), and the write/re-shadow set builders. The fetch MECHANICS (feeds,
 * `specs()`, the `backfill*` jobs, `backfillAll`, deps objects) stay in `scripts/backfill.ts`,
 * which star-re-exports this module so every existing importer keeps resolving.
 *
 * Dependency direction is ONE way: `backfill.ts` imports from this file, never the reverse.
 */
import { depthFromRegistry } from "../src/registry.js";
import { tradingToCalendarDays } from "../src/family-descriptor-core.js";
import { CURVE_DESCRIPTOR_OF } from "../src/family-descriptor-rows.js";
import { bundLegHead, readPathHeadRows } from "../src/scorers-composite.js";
import { BACKFILL_YEARS, readRowsForCalendarDays } from "../src/series-db-first.js";
import type { BackfillDepth } from "../src/domain-types.js";
import {
  BACKFILL_FLOOR_WARMUP_DAYS,
  CHART_SPAN_DAYS,
} from "../src/backfill-depth.js";
import type { Store, StoredReading } from "../src/store.js";
import { isoDay } from "../src/dates.js";


/** Seed-window depth (§9a) — lives in `src/series-db-first.ts` (the cron deep arms size off it);
 *  re-exported here (and forwarded through `scripts/backfill.ts`) for the probes/tests that
 *  import it. Per-series inception still caps individual feeds. */
export { BACKFILL_YEARS };
/**
 * Idempotency probe depth passed into `backfillHistory` (§4.5/§9a). Must exceed the deepest seeded
 * series — ECISS's daily override (`ECISS_BACKFILL_YEARS`), ~5,200 points. Without a deep probe
 * the oldest dates fall outside the probe and re-insert on every re-run (duplicate rows) — the §4.5 bug.
 */
export const DEEP_PROBE = 6000;

// --- No-waste incremental fetch (skip-current + shrink + revision re-shadow) ----
//
// Every backfill job used to fetch FULL history on every re-run, then insert-missing
// 0 rows — pure waste of free-tier feed quota once seeded. `planFetch` bounds each
// job to only what's NOT already stored, per series id, from its newest stored
// obs_date vs `now`.

/** Newest stored obs_date within `FRESH_MARGIN_DAYS` of now ⇒ the daily cron already covers
 *  the recent edge, so backfill (a manual/occasional host op) can skip the fetch entirely. */
export const FRESH_MARGIN_DAYS = 4;

/** Revision re-shadow window: for a revision-prone series, re-fetch this many recent days and
 *  re-write them under a fresh run_at (readings is append-only vintage; readings_latest serves
 *  max run_at), shadowing preliminary values that the source revised after first publication. */
export const REVISION_TAIL_DAYS = 7;
// --- THE COMMON BACKFILL WINDOW ------------------------------------------------
//
// [USER] 2026-08-29: every indicator must chart from a single common start. Depth used to be
// expressed three unrelated ways — a global years trim, bespoke per-feed cal-day constants, and an
// inline `isoCutoff` — so "how deep does X seed?" had no one answer. It does now: ONE object
// (`BACKFILL_WINDOW`) holding a hard FLOOR plus a default DEPTH, with each per-id depth declared
// on its registry entry (`Indicator.backfill`).
//
// ⛔ SCOPE, precisely — the earlier wording here claimed "every spec calls the resolver" and that
// is FALSE, so read this instead. Only the date-window feeds (ECB, the sovereign-yield quote feed)
// plus F7's CAPE trim call `backfillSinceDate` — `grep -n 'backfillSinceDate(' scripts/backfill.ts` is the set. EVERY OTHER indicator
// fetches `fullHistory: true` and is bounded by the `backfillAll` TRIM — which is this object's
// `depth` field (`backfillTrimYears`), so the default depth is load-bearing for ~26 ids even
// though none of them reaches the resolver. The floor is therefore a REPAIR bound for the
// short-window feeds; the other ids never needed one (their trim reaches years past it).
//
// FLOOR vs DEPTH, and why both: the floor is the date the CHART must reach; the depth is how far
// past it a seed may go for the SCORERS (expanding-percentile cuts anchor over the stored override
// window — `src/domain-cuts.ts` — and BONOS emits nothing until `oatLegBase(c)` trading days precede a date).
// A depth-only config starves those; a floor-only config leaves the deep feeds unspecified. The
// resolved bound is therefore `min(depth, floor − lead-in)` — whichever reaches FURTHER BACK.

export type { BackfillDepth } from "../src/domain-types.js";

/**
 * HARD FLOOR every indicator's backfill must reach, whatever its depth resolves to. Rolling
 * cal-day windows re-anchor FORWARD every run, so once a seeded span aged past its window the
 * earlier dates were never re-requested: EURC/BUND stored a strictly younger chart span than every
 * other member of the indicator-detail top-5 stacks (measured on prod 2026-08-29: both started
 * 2025-02-13, the 560-day mark, while every other top-5 member reached 2013 or earlier). [USER]
 * 2026-08-29: the stacks must chart from 2024-09-30. Insert-missing makes the deeper ask a one-way
 * ratchet — once seeded the rows stay, so this floor only ever has to be reachable, never re-run.
 *
 * ⚠ The ratchet holds on EVERY run only for EURC/BUND/BONOS, whose `build` callbacks take no `win`
 * at all and so always fetch from the resolved bound (and none is `SKIP_SAFE`, so `planFetch` can
 * never `skip` them). A date-window feed whose `build` takes `win` must fetch from
 * `min(win.sinceDate, resolved)` to join them — without that min its incremental plan
 * (`SCORED_WARMUP_DAYS` = 420 ⇒ ~427 cal-days) would sit well AFTER the floor and only a
 * `--restate=<id>` could re-deepen a short span.
 *
 * ⚠ NOT pinned by the unit gate — the floor is a `min` arm, so "the resolved bound reaches the
 * floor" is true by construction for any depth and asserts nothing (2026-08-29 review). What the
 * gate pins is that the floor BINDS when a depth is too shallow (`resolveBackfillSince` below);
 * what grades the real stored spans is `scripts/probe-leg-span.ts`, run on demand against prod.
 */
export const BACKFILL_FLOOR = "2024-09-30";

/** The per-id depth constants live in `src/backfill-depth.ts` (the registry entries declare
 *  `backfill` from them); re-exported here so every existing importer keeps resolving. */
export { BACKFILL_FLOOR_WARMUP_DAYS, CHART_SPAN_DAYS };

/**
 * THE common window. `depth` is the shared seed depth — it is what `backfillAll` TRIMS to, so it
 * binds every indicator without a registry `backfill` field (see `backfillTrimYears`). A per-id depth
 * is DECLARED ON THE INDICATOR (`Indicator.backfill`, `src/registry-*.ts`; read via `depthFromRegistry`)
 * — the hand-kept `overrides` list retired 2026-09-05 (descriptor-computed-backfill-depth Stage 2).
 * Feeds that need an explicit start (ECB's default is a ~60-obs window)
 * must ALSO state an explicit fetch lower bound, and `floor` is
 * the date those must reach whatever their depth resolves to. A declared depth's TRIM is
 * `backfillCutoffFor` — the reading/feed trims key on it, so declaring the field both bounds the
 * fetch and exempts the id from the shared cut.
 *
 * ⚠ `depth` is a repair BOUND, not a force: raising it never re-deepens an already-seeded id, because
 * `backfillAll` plans off the NEWEST stored date only. `--deepen[=<ids>]` is the mechanism.
 */
export const BACKFILL_WINDOW: {
  readonly floor: string;
  readonly floorWarmupDays: number;
  readonly depth: BackfillDepth;
} = {
  floor: BACKFILL_FLOOR,
  floorWarmupDays: BACKFILL_FLOOR_WARMUP_DAYS,
  depth: { years: BACKFILL_YEARS },
};

/** The depth `id` seeds to — its registry-declared `backfill`, else the shared default. */
export function backfillDepthFor(id: string): BackfillDepth {
  return depthFromRegistry(id) ?? BACKFILL_WINDOW.depth;
}

/**
 * The shared default depth as YEARS — what `backfillAll` trims every non-override indicator to.
 * This is the ONE thing that makes `BACKFILL_WINDOW.depth` load-bearing rather than decorative:
 * without it the default arm would be reachable only from a test's stand-in id.
 *
 * Throws on a `days`/`since` default: the trim is year-based (`isoCutoff`), so either form here would be
 * silently unusable. A throw at the one call site beats a rounded conversion nobody asked for.
 */
export function backfillTrimYears(): number {
  const depth = BACKFILL_WINDOW.depth;
  if (!("years" in depth)) {
    throw new Error("BACKFILL_WINDOW.depth must be a `years` form — the backfillAll trim is year-based");
  }
  return depth.years;
}

/**
 * The floor's own fetch bound: the floor date, led in by `floorWarmupDays` so the floor is the first
 * CHARTED date rather than the first FETCHED one.
 */
export function backfillFloorBound(): string {
  return isoDaysBefore(new Date(`${BACKFILL_WINDOW.floor}T00:00:00Z`), BACKFILL_WINDOW.floorWarmupDays);
}

/**
 * Resolve ONE depth against the floor: whichever reaches FURTHER BACK wins.
 *
 * Split out of `backfillSinceDate` so the floor's binding behaviour is directly testable. Asserting
 * "the resolved bound reaches the floor" against the id-keyed function proves NOTHING — a `min` is
 * ≤ its floor arm for every possible depth, so that assertion survives replacing every override with
 * `{ days: 1 }` (2026-08-29 review; it shipped as exactly that tautology). The assertion with teeth
 * is that a depth too shallow to reach the floor RESOLVES TO THE FLOOR instead of to itself, and
 * that a deeper one resolves to ITSELF — both need a depth the test supplies, i.e. this seam.
 */
export function resolveBackfillSince(depth: BackfillDepth, now: Date): string {
  const bounds = [depthSince(depth, now), backfillFloorBound(), chartSpanBound(now)];
  return bounds.reduce((a, b) => (a < b ? a : b));
}

/** The depth arm ALONE (no floor/chart-span `min`) — the bound a "seeds at least N years" check compares. */
export function depthSince(depth: BackfillDepth, now: Date): string {
  return "years" in depth ? isoCutoff(now, depth.years) : "days" in depth ? isoDaysBefore(now, depth.days) : depth.since;
}

/**
 * The ROLLING arm of the resolve: no indicator may seed shallower than its own detail chart draws
 * (`DETAIL_WINDOW_DAYS`, the ONE shared span), led in by the generic warmup so the span's first day
 * is a SCORED row rather than the first fetched one.
 *
 * ⚠ It exists because `BACKFILL_FLOOR` is a FIXED DATE and therefore ages: on 2026-08-30 the floor's
 * bound (2024-08-16) still sat below `now − DETAIL_WINDOW_DAYS`, so it masked the depth arm entirely
 * — a per-id depth constant regressed to its old value and every test stayed green. This arm re-anchors
 * every run, so the guarantee survives the floor ageing out of relevance.
 */
export function chartSpanBound(now: Date): string {
  return isoDaysBefore(now, CHART_SPAN_DAYS);
}

/**
 * THE fetch lower bound for one indicator: its depth OR the floor's lead-in, whichever reaches
 * further back. Single touch point — every spec that needs an explicit `since`/`startDate`, and
 * every test and probe that asserts one, derives from this rather than re-deriving a window.
 */
export function backfillSinceDate(id: string, now: Date): string {
  return resolveBackfillSince(backfillDepthFor(id), now);
}

/** The reading/feed trim cutoff for ONE id: the DEEPER of the caller's shared `defaultCutoff` and the
 *  id's declared bound — a deep declaration (F3/CG/F7) escapes the shared cut, a shallow one
 *  never trims MORE than the default. */
export function backfillCutoffFor(id: string, defaultCutoff: string, now: Date): string {
  if (depthFromRegistry(id) === undefined) return defaultCutoff;
  const own = backfillSinceDate(id, now);
  return own < defaultCutoff ? own : defaultCutoff;
}

/** `backfillAll`'s per-id floors off its shared `cutoff`: `idCutoff` (depth-resolved) and THE reading `trimFloor`. */
export function backfillFloorsFor(id: string, cutoff: string, now: Date): { idCutoff: string; trimFloor: string } {
  const idCutoff = backfillCutoffFor(id, cutoff, now);
  return { idCutoff, trimFloor: specCutoff(id, idCutoff, now) };
}

/** `backfillHistory`'s idempotency probe for rows trimmed at `floor`: their trading-row read cap, never below `DEEP_PROBE`. */
export function probeFor(floor: string, now: Date): number {
  return Math.max(DEEP_PROBE, readRowsForCalendarDays((now.getTime() - Date.parse(`${floor}T00:00:00Z`)) / 86_400_000));
}
/**
 * STORED indicator ids whose values are published FINAL end-of-day and never revised, so backfill
 * may TRULY skip them (0 requests) when current. Everything NOT here is revision-prone (the default)
 * and gets a `REVISION_TAIL_DAYS` re-shadow instead of a skip. Registry-verified basis:
 *   R1=T10Y3M, R2=DGS10, R3=DGS2, R4=DFII10 (Treasury H.15 constant-maturity), R5=VIXCLS (VIX
 *   close), R7=bull-steepener over T10Y3M/DGS2/DGS10. Revision-prone (absent): F1/F2 ICE OAS, all
 *   adjusted-close prices (div/split retroactive + preliminary close), DCOILWTICO (EIA), the H.10 FX
 *   legs, CAPE, the ^VIX/^VIX3M/^MOVE price feeds. Keys on the STORED id, not the FRED series.
 */
export const SKIP_SAFE_IDS: ReadonlySet<string> = new Set(["R1", "R2", "R3", "R4", "R5", "R7"]);

export type FetchPlan =
  | { mode: "skip" }
  | { mode: "full" }
  | { mode: "since"; sinceDate: string; lookbackDays: number; reshadowTailDays?: number };

/** ISO date (YYYY-MM-DD) `days` before `now` — the `since`/re-shadow lower bound. */
/** The EARLIER of two ISO `YYYY-MM-DD` dates — i.e. the bound that reaches FURTHER BACK. Same
 *  fixed-width lexicographic compare the resolver and every `trim` cutoff use. */
export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

export function isoDaysBefore(now: Date, days: number): string {
  return isoDay(new Date(now.getTime() - days * 86_400_000));
}

/**
 * Decide how much history to fetch for one series from its newest stored obs_date:
 *   - `maxDate == null` (nothing stored) → `full` (first seed).
 *   - within `freshMargin` of now → `skip` if KNOWN-final (`!revises`), else re-shadow just the
 *     recent tail (`since` over `REVISION_TAIL_DAYS + warmupDays` so a SCORED spec can rebuild the
 *     tail's confirmed-states; only `reshadowTailDays` = `REVISION_TAIL_DAYS` is written back).
 *   - older → `since` back `gap + warmup` days; revision-prone series also re-shadow the recent tail.
 * `revises` = `!SKIP_SAFE_IDS.has(id)` at the call site.
 */
export function planFetch(
  maxDate: string | null,
  warmupDays: number,
  now: Date,
  revises: boolean,
  freshMargin = FRESH_MARGIN_DAYS,
): FetchPlan {
  if (maxDate === null) return { mode: "full" };
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(`${maxDate}T00:00:00Z`)) / 86_400_000));
  if (age <= freshMargin) {
    if (!revises) return { mode: "skip" };
    // Fetch the re-shadow tail PLUS `warmupDays` of lead-in: a SCORED spec (warmup=420) must
    // re-derive confirmed-states for the tail dates, and a bare REVISION_TAIL_DAYS window sits
    // below every scorer lookback (slice(VELOCITY_WINDOW) / minLength≥63), which would build `[]`
    // and leave the re-shadow INERT. Raw legs (warmup≈7) get a harmless ~14d window; either way
    // only the last `REVISION_TAIL_DAYS` are written back (`reshadowTailDays`).
    const lookbackDays = REVISION_TAIL_DAYS + warmupDays;
    return {
      mode: "since",
      sinceDate: isoDaysBefore(now, lookbackDays),
      lookbackDays,
      reshadowTailDays: REVISION_TAIL_DAYS,
    };
  }
  const lookbackDays = age + warmupDays;
  return {
    mode: "since",
    sinceDate: isoDaysBefore(now, lookbackDays),
    lookbackDays,
    reshadowTailDays: revises ? REVISION_TAIL_DAYS : undefined,
  };
}

/** Newest stored obs_date across `ids`, or `null` if ANY id is unseeded (forces a full first seed).
 *  One bulk round-trip; `getSeries`/`getSeriesBulk` return oldest→newest, so `limit:1` is the newest. */
export async function latestStoredDate(store: Store, ids: string[]): Promise<string | null> {
  const bulk = await store.getSeriesBulk(ids, { limit: 1 });
  let newest: string | null = null;
  for (const id of ids) {
    const d = (bulk.get(id) ?? []).at(-1)?.date ?? null;
    if (d === null) return null; // an unseeded id forces `full` (planFetch(null))
    if (newest === null || d > newest) newest = d;
  }
  return newest;
}

/** `reshadowTailDays` of a `since` plan, else undefined (full/skip never re-shadow). */
export function reshadowDays(plan: Exclude<FetchPlan, { mode: "skip" }>): number | undefined {
  return plan.mode === "since" ? plan.reshadowTailDays : undefined;
}

/**
 * The rows to WRITE from a projected series: dates absent from `existing` (insert-missing), PLUS —
 * when `reshadowTailDays` is set — stored dates within that window of `now`. The tail dates re-insert
 * under a fresh run_at, shadowing preliminary values (append-only vintage; readings_latest serves the
 * newest). Without `reshadowTailDays` this is exactly the prior insert-missing date-diff.
 */
export function writeSet(
  rows: StoredReading[],
  existing: Set<string>,
  now: Date,
  reshadowTailDays: number | undefined,
  reshadowAll = false,
): StoredReading[] {
  // FULL re-shadow (`--reshadow-all=<id>`): re-write EVERY projected row, not just the tail — the
  // whole stored history is rebuilt under a fresh vintage (the runner's self-prune then drops what
  // it shadowed). Load-bearing pairing: the caller must ALSO force a `full` fetch plan, else `rows`
  // holds only the recent `since` window and this re-writes just that.
  if (reshadowAll) return rows;
  if (reshadowTailDays === undefined) return rows.filter((r) => !existing.has(r.date));
  const tailFloor = isoDaysBefore(now, reshadowTailDays);
  return rows.filter((r) => !existing.has(r.date) || r.date >= tailFloor);
}

/**
 * Validate & set-ify a job's `--reshadow-all` ids, failing LOUD on an unknown id (mirrors
 * `backfillDownsideBreaks`'s restate guard). This op runs once to rebuild history, so a no-op that
 * reports success — leaving a replay reading the retired vintage — is the expensive failure.
 */
export function reshadowAllSet(ids: readonly string[] | undefined, known: Iterable<string>, label: string): Set<string> {
  const knownSet = new Set(known);
  const unknown = (ids ?? []).filter((id) => !knownSet.has(id));
  if (unknown.length > 0) {
    throw new Error(`reshadow-all: unknown ${label} id(s) ${unknown.join(", ")} — known: ${[...knownSet].join(", ")}`);
  }
  return new Set(ids ?? []);
}

/** ISO date (YYYY-MM-DD) `years` before `now` — the client-side trim cutoff (design §4.5 NOTE). */
export function isoCutoff(now: Date, years: number): string {
  // UTC-safe: build the date in UTC so the year arithmetic and the toISOString()
  // formatting agree (mixing local setFullYear with UTC formatting can drift the
  // cutoff a day near the UTC boundary — immaterial for a multi-year window, but free).
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return isoDay(d);
}

/** Slack added to a read-path head when deepening the central reading-trim: the sole home of the
 *  `+days` beyond the exact trading→calendar ratio, so no doc/test restates it (`specCutoff`). */
export const SPEC_CUTOFF_SLACK_DAYS = 30;

/** Trading days → calendar days (×365/252, rounded up). RE-EXPORT of the sole home, which moved to
 *  `src/family-descriptor-rows.ts` so `DETAIL_WINDOW_DAYS` could derive from it without `src/` importing
 *  `scripts/`; the importers (the probes, the tests — via `scripts/backfill.ts`'s star
 *  re-export) keep their spelling. */
export { tradingToCalendarDays };

/** The central reading-trim cutoff for one spec: `cutoff` for a plain id, pushed BACK by the read
 *  path's stored-head warmup (`readPathHeadRows` trading days → calendar) for an id api/series.ts
 *  re-scores (CG), so its chart's left edge lands ON `cutoff`. `now` unused — the shift is cutoff-relative. */
export function specCutoff(id: string, cutoff: string, now: Date): string {
  void now;
  const head = readPathHeadRows(id);
  if (head === 0) return cutoff;
  return headLedSince(cutoff, head);
}

/** `cutoff` led in by `headRows` trading days (→ calendar, + SPEC_CUTOFF_SLACK_DAYS) — the ONE head lead-in
 *  expression: `specCutoff`'s read-path head and BUND's feed floor (`bundLegHead`, backfill.ts) both ride it. */
export function headLedSince(cutoff: string, headRows: number): string {
  return isoDaysBefore(new Date(`${cutoff}T00:00:00Z`), tradingToCalendarDays(headRows) + SPEC_CUTOFF_SLACK_DAYS);
}

/** A curve card's (BUND) FEED floor: its bound led in by the curve scorer's full lookback (`bundLegHead`), so leg
 *  (c)'s inversion memory burns BELOW the bound. `backfill.ts` and `sovereignFeedSince` both read it. */
export function curveFeedSince(id: keyof typeof CURVE_DESCRIPTOR_OF, now: Date): string {
  return headLedSince(backfillSinceDate(id, now), bundLegHead(CURVE_DESCRIPTOR_OF[id].scorer.constants));
}

/** Floor of the ONE shared sovereign-quote pull (BONOS/BUND legs) — the deepest head-led feed floor.
 *  `backfill.ts` reads it, so every rebuild sees one base. */
export function sovereignFeedSince(now: Date): string {
  const floors = [
    specCutoff("BONOS", backfillSinceDate("BONOS", now), now),
    curveFeedSince("BUND", now),
  ];
  return floors.reduce((a, b) => (a < b ? a : b));
}
