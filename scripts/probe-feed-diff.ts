/**
 * Feed-provenance diff probe: recompute EVERY backfill job's history from the CURRENT feed
 * stack and diff it against what the DB already holds
 * (rows seeded by earlier feed stacks).
 *
 * DIAGNOSTIC ONLY — writes NOTHING. It answers "would a feed change alter any stored number?"
 * without touching a row. Exits 1 when any job failed, so a failed run never reads as all-clear.
 *
 * Mechanism: the real `REGISTRY` jobs run against a proxy Store that
 *   - reports every id as UNSEEDED (`getSeries` → [], `getSeriesBulk` → empty Map), so each job
 *     takes its `full` deep-fetch plan and rebuilds the WHOLE series rather than the tail;
 *   - intercepts `recordReadings` and, instead of writing, compares each row to the DB's real
 *     value on that same date (lazily read once per id through the underlying store);
 *   - no-ops `pruneShadowedReadings`.
 *
 * Because the tally is driven by the writes, it sees only dates the RECOMPUTE produced. The
 * per-id STALE PREFIX line (`stalePrefixes`) prints the size of the population that leaves out:
 * stored rows older than the fetch's earliest date, which no counter here can ever compare.
 *
 *   Run:  bash scripts/with-prod-config.sh tsx scripts/probe-feed-diff.ts [job ...]
 *         (default: every job in REGISTRY)
 */
import { DEEP_PROBE } from "./backfill.js";
import { REGISTRY, findJob } from "./backfill/registry.js";
import { resolveStore } from "./backfill/resolve-store.js";
import type { ReadStore, SeriesPoint, SeriesRange, Store, StoredReading } from "../src/store.js";
import { median } from "./lib/stats.js";
import { isoDay } from "../src/dates.js";

/** Relative difference below which two closes are "the same number" (feeds round differently). */
const EPS = 1e-9;

/**
 * Depth of the DB baseline read, per id — at least the deepest probe any job uses.
 *
 * `getSeries(id, n)` returns the NEWEST n rows, so reading the baseline shallower than the job
 * under comparison silently drops the OLDEST rows out of the baseline; the recompute still emits
 * them and they land in the `feed-only date(s)` bucket instead of being compared — and those rows
 * are the oldest in the series, where back-adjustment divergence is largest by construction.
 * (`LEGS_DEEP_PROBE`, this constant's original second arm, retired 2026-09-05 with the legs' own
 * deeper window — every job probes `DEEP_PROBE` now.)
 *
 * A baseline deeper than the job needs is harmless: the tally only walks dates the RECOMPUTE
 * produced, so surplus baseline rows are never examined and can never manufacture a difference.
 */
export const BASELINE_PROBE = DEEP_PROBE;

interface Diff {
  id: string;
  date: string;
  dbValue: number;
  feedValue: number;
  rel: number;
  stateChanged: boolean;
  /**
   * Row-offset of `date` from this id's FIRST stored date (0 = first row), or -1 when unknown.
   * Used by `bucketReport` to test OQ-1: flips clustered at small offsets ⇒ warm-up/cold-start
   * probe artifact; spread evenly ⇒ real backfill-vs-cron divergence.
   */
  offset?: number;
}

interface Tally {
  /** Rows the recompute produced that the DB also has on that date. */
  compared: number;
  /** Rows on dates the DB has no row for (feed reaches further back / forward). */
  onlyInFeed: number;
  diffs: Diff[];
  ids: Set<string>;
  /** Earliest date this run's recompute emitted, per id — the floor of the compared population. */
  minFetched: Map<string, string>;
}

/**
 * The MIRROR of `onlyInFeed`: stored rows the recompute cannot reach, per id.
 *
 * The tally only walks dates the RECOMPUTE produced, so a stored row on a date the current fetch
 * never emits is never examined and no counter reports it. That is live rather than hypothetical:
 * the leg jobs trim at `isoCutoff(now, BACKFILL_YEARS)`, a cutoff that advances every day, so a
 * row seeded by an earlier pass and now older than today's cutoff keeps its original (possibly
 * mixed-vintage) value permanently while `readings_latest` still serves it per date. A "0 differing"
 * result therefore certifies single-vintage only over the intersection of the fetch's dates and the
 * stored history — this check prints the size of what falls outside it.
 *
 * CHEAP variant by ruling: a per-id prefix count, not a full
 * `db-only date(s)` bucket.
 */
export interface StalePrefix {
  id: string;
  /** Earliest date the DB holds for this id **within the `BASELINE_PROBE` window** — the DB's own
   *  earliest only while `saturated` is false. */
  minStored: string;
  /** Earliest date this run's recompute emitted for this id. */
  minFetched: string;
  /**
   * Stored rows strictly older than `minFetched` — unreachable by this recompute, so never compared.
   *
   * `"unknown"` when the baseline read SATURATED (see `saturated`): the window's earliest date is
   * then not the DB's earliest, so a `0` here would be a claim the measurement cannot support.
   */
  rows: number | "unknown";
  /** Calendar days from `minStored` to `minFetched`; 0 when the stored history starts at or after it
   *  — and 0, meaninglessly, when `saturated`, where `rows` is the field to read. */
  days: number;
  /**
   * The baseline read came back FULL (`dates.length >= BASELINE_PROBE`). `getSeries(id, n)` returns
   * the NEWEST n rows, so a full window means the DB may hold older rows this probe never saw, and
   * `dates[0]` is the window's floor rather than the series'. Safe today only because 20y ≈ 5040
   * rows < 6500 — the guard exists so a longer series degrades to `unknown`, not to a false zero.
   */
  saturated: boolean;
}

/**
 * Per-id assertion "min stored date ≥ min fetched date", expressed as the size of the violation.
 * Returns a row for EVERY id with both a stored history and a recompute, so a zero is a printed
 * measurement rather than an absence of output.
 */
export function stalePrefixes(minFetched: Map<string, string>, orderedDates: Map<string, string[]>): StalePrefix[] {
  const out: StalePrefix[] = [];
  for (const [id, floor] of [...minFetched].sort()) {
    const dates = orderedDates.get(id);
    if (!dates || dates.length === 0) continue; // id unseeded in the DB — nothing stored to strand
    const minStored = dates[0]!;
    // The baseline is the NEWEST `BASELINE_PROBE` rows. A full window means `minStored` is the
    // WINDOW's floor, not the series' — every older row is invisible here, so the honest answer
    // is "unknown", never "0". (Review finding, 2026-08-01.)
    if (dates.length >= BASELINE_PROBE) {
      out.push({ id, minStored, minFetched: floor, rows: "unknown", days: 0, saturated: true });
      continue;
    }
    const older = dates.filter((d) => d < floor);
    const days = older.length === 0 ? 0 : Math.round((Date.parse(floor) - Date.parse(minStored)) / 86_400_000);
    out.push({ id, minStored, minFetched: floor, rows: older.length, days, saturated: false });
  }
  return out;
}

/** Print the stale-prefix measurement in the same indented per-id idiom as the diff report. */
export function reportStalePrefixes(rows: StalePrefix[]): void {
  if (rows.length === 0) return;
  const unknown = rows.filter((r) => r.saturated);
  if (unknown.length > 0) {
    console.log(
      `    stale prefix: UNKNOWN for ${unknown.length} id(s) — the DB baseline read returned a FULL ` +
        `${BASELINE_PROBE}-row window (getSeries serves the NEWEST n), so its earliest date is the ` +
        `window's floor, not the series' — older stored rows cannot be counted: ${unknown.map((r) => r.id).join(", ")}`,
    );
  }
  const known = rows.filter((r) => !r.saturated);
  const bad = known.filter((r) => (r.rows as number) > 0);
  if (bad.length === 0) {
    if (known.length > 0) {
      console.log(`    stale prefix: 0 row(s) — min stored date ≥ min fetched date for all ${known.length} id(s)`);
    }
    return;
  }
  const total = bad.reduce((a, r) => a + (r.rows as number), 0);
  console.log(`    stale prefix: ${total} stored row(s) older than the fetch floor across ${bad.length}/${known.length} id(s) — NEVER compared:`);
  for (const r of bad) {
    console.log(`      ${r.id.padEnd(14)} ${String(r.rows).padStart(5)} row(s)  stored from ${r.minStored}  fetch floor ${r.minFetched}  gap ${r.days}d`);
  }
}

/** Stays local: 4 decimals. `lib/stats.js`'s `pct`/`pct2` are 1dp/2dp, and its `fmt4` prints no
 *  `%` sign — a feed-disagreement share needs all four digits to stay visible. */
function pct(x: number): string {
  return `${(x * 100).toFixed(4)}%`;
}

/**
 * Wrap the live store so the jobs recompute full history and their writes become comparisons.
 * Deny-by-default like the dry-run store: an unclassified method throws before it reaches the DB.
 */
export function makeCompareStore(real: ReadStore): { store: Store; tally: Tally; orderedDates: Map<string, string[]> } {
  const tally: Tally = { compared: 0, onlyInFeed: 0, diffs: [], ids: new Set(), minFetched: new Map() };
  /** DB baseline per id, read once through the REAL store (the proxy hides it from the jobs). */
  const baseline = new Map<string, Promise<Map<string, SeriesPoint>>>();
  /** Chronologically ordered stored dates per id, so a date maps to its row-offset from row 0. */
  const orderedDates = new Map<string, string[]>();

  const loadBaseline = (id: string): Promise<Map<string, SeriesPoint>> => {
    let p = baseline.get(id);
    if (!p) {
      p = real.getSeries(id, BASELINE_PROBE).then((pts) => {
        orderedDates.set(id, pts.map((pt) => pt.date).sort());
        return new Map(pts.map((pt) => [pt.date, pt]));
      });
      baseline.set(id, p);
    }
    return p;
  };

  /** Row-offset of `date` within `id`'s stored history (0 = first row), or -1 if absent. */
  const offsetOf = (id: string, date: string): number => {
    const dates = orderedDates.get(id);
    return dates ? dates.indexOf(date) : -1;
  };

  // The target is a blank object, never `real`: a `getStore("ro")` handle is frozen, and a Proxy over a frozen
  // target may not answer its own read methods with a different function (the planning stubs below).
  const proxy = new Proxy({} as Store, {
    get(_target, prop) {
      // --- writes → compare, never execute ---------------------------------
      if (prop === "recordReadings") {
        return async (rows: StoredReading[]) => {
          for (const r of rows) {
            tally.ids.add(r.indicatorId);
            const seen = tally.minFetched.get(r.indicatorId);
            if (seen === undefined || r.date < seen) tally.minFetched.set(r.indicatorId, r.date);
            const db = (await loadBaseline(r.indicatorId)).get(r.date);
            if (!db) {
              tally.onlyInFeed += 1;
              continue;
            }
            tally.compared += 1;
            const rel = db.value === 0 ? (r.value === 0 ? 0 : Infinity) : Math.abs(r.value - db.value) / Math.abs(db.value);
            const stateChanged = r.state !== db.state;
            if (rel > EPS || stateChanged) {
              tally.diffs.push({ id: r.indicatorId, date: r.date, dbValue: db.value, feedValue: r.value, rel, stateChanged, offset: offsetOf(r.indicatorId, r.date) });
            }
          }
        };
      }
      if (prop === "pruneShadowedReadings") return async () => 0;

      // --- reads the jobs use for PLANNING → report "unseeded" so they rebuild fully ---
      if (prop === "getSeries") return async () => [];
      if (prop === "getSeriesBulk") return async () => new Map();

      const value: unknown = Reflect.get(real, prop);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && /^(get|checkSchema$|maxRowsProbe$)/.test(prop)) return value.bind(real);
      throw new Error(`[feed-diff] refusing unclassified Store method \`${String(prop)}\` — this probe must write nothing`);
    },
  });
  return { store: proxy, tally, orderedDates };
}

/**
 * OQ-1 discriminator: bucket every state-flip by its row-offset from its id's first stored date.
 * Flips clustered at small offsets (regardless of series length) ⇒ the probe's cold-start fold
 * diverges only in each series' warm-up window ⇒ harmless probe artifact. Flips spread across the
 * whole range ⇒ a real backfill-vs-cron fold divergence. Value-only diffs are ignored here — OQ-1
 * is about the ~8.7k *state* flips at 0.0000% value difference.
 */
function bucketReport(diffs: Diff[], seriesLen: Map<string, number>): void {
  const flips = diffs.filter((d) => d.stateChanged && (d.offset ?? -1) >= 0);
  if (flips.length === 0) {
    console.log("\n[feed-diff] OFFSET BUCKETS: no state flips with a known row-offset to bucket.");
    return;
  }
  const bounds = [0, 10, 25, 50, 100, 250, 500, 1000, Infinity];
  const counts = new Array(bounds.length - 1).fill(0);
  for (const d of flips) {
    const off = d.offset!;
    counts[bounds.findIndex((lo, i) => off >= lo && off < bounds[i + 1]!)] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  console.log(`\n[feed-diff] STATE-FLIP OFFSET BUCKETS (rows from each id's first stored date) — ${flips.length} flip(s):`);
  for (let i = 0; i < counts.length; i++) {
    const hi = bounds[i + 1]!;
    const label = hi === Infinity ? `${bounds[i]}+` : `${bounds[i]}-${hi - 1}`;
    console.log(`    off ${label.padStart(9)}  ${String(counts[i]).padStart(6)}  ${"█".repeat(Math.round((counts[i] / maxCount) * 40))}`);
  }
  const byId = new Map<string, number[]>();
  for (const d of flips) byId.set(d.id, [...(byId.get(d.id) ?? []), d.offset!]);
  console.log("    per id: [min..max flip offset] / series length");
  for (const [id, offs] of [...byId].sort()) {
    console.log(`      ${id.padEnd(14)} [${Math.min(...offs)}..${Math.max(...offs)}] / ${seriesLen.get(id) ?? "?"}  (${offs.length} flip)`);
  }
  const WARMUP = 60; // display heuristic only — NOT a test assertion
  const early = flips.filter((d) => d.offset! < WARMUP).length;
  const frac = early / flips.length;
  console.log(
    `\n[feed-diff] OQ-1 read: ${early}/${flips.length} (${(frac * 100).toFixed(1)}%) flips within the first ${WARMUP} rows → ` +
      (frac >= 0.9
        ? "clustered in warm-up ⇒ likely COLD-START PROBE ARTIFACT (harmless)."
        : frac <= 0.5
          ? "spread across the series ⇒ likely REAL backfill-vs-cron divergence (own bug)."
          : "mixed — inspect the per-id spread above before concluding."),
  );
}

/** One arm's recomputed rows: id → date → the row the job would have written. */
export type Arm = Map<string, Map<string, { value: number; state: string; estimated?: true }>>;

const clampTo = (range: SeriesRange | undefined, to: string): SeriesRange => ({ ...range, to: range?.to != null && range.to < to ? range.to : to });

/** Capture-only proxy (unseeded planning, `recordReadings` records, no baseline read). `tailFrom`:
 *  planning reads see the REAL store through the day before it, so each job tail-fetches from there, never a full rebuild. */
export function makeCaptureStore(real: ReadStore, opts: { tailFrom?: string } = {}): { store: Store; arm: Arm } {
  const arm: Arm = new Map();
  const before = opts.tailFrom === undefined ? undefined : isoDay(new Date(Date.parse(`${opts.tailFrom}T00:00:00Z`) - 86_400_000));
  // The target is a blank object, never `real`: a `getStore("ro")` handle is frozen, and a Proxy over a frozen
  // target may not answer its own read methods with a different function (the planning stubs below).
  const proxy = new Proxy({} as Store, {
    get(_target, prop) {
      if (prop === "recordReadings") {
        return async (rows: StoredReading[]) => {
          for (const r of rows) {
            let byDate = arm.get(r.indicatorId);
            if (!byDate) arm.set(r.indicatorId, (byDate = new Map()));
            byDate.set(r.date, { value: r.value, state: r.state, ...(r.estimated === true ? { estimated: true as const } : {}) });
          }
        };
      }
      if (prop === "pruneShadowedReadings") return async () => 0;
      if (prop === "getSeries") {
        return before === undefined ? async () => [] : (id: string, limit: number, range?: SeriesRange) => real.getSeries(id, limit, clampTo(range, before));
      }
      if (prop === "getSeriesBulk") {
        return before === undefined
          ? async () => new Map()
          : (ids: string[], o: { limit: number; range?: SeriesRange }) => real.getSeriesBulk(ids, { ...o, range: clampTo(o.range, before) });
      }
      const value: unknown = Reflect.get(real, prop);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && /^(get|checkSchema$|maxRowsProbe$)/.test(prop)) return value.bind(real);
      throw new Error(`[feed-diff] refusing unclassified Store method \`${String(prop)}\` — this probe must write nothing`);
    },
  });
  return { store: proxy, arm };
}

async function main(): Promise<number> {
  const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const jobs = names.length > 0 ? names.map((n) => findJob(n) ?? (() => { throw new Error(`unknown job: ${n}`); })()) : REGISTRY;

  const real = await resolveStore("prod", "ro");
  console.log(`[feed-diff] comparing ${jobs.length} job(s) — current feed stack vs stored DB values. NOTHING IS WRITTEN.\n`);

  const allDiffs: Diff[] = [];
  const failed: string[] = [];
  const seriesLen = new Map<string, number>();
  for (const job of jobs) {
    const { store, tally, orderedDates } = makeCompareStore(real);
    try {
      await job.run(store);
    } catch (err) {
      console.error(`[feed-diff] ${job.name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      failed.push(job.name);
      continue;
    }
    for (const [id, dates] of orderedDates) seriesLen.set(id, dates.length);
    const byId = new Map<string, Diff[]>();
    for (const d of tally.diffs) byId.set(d.id, [...(byId.get(d.id) ?? []), d]);
    console.log(
      `${job.name}: ${tally.compared} row(s) compared across ${tally.ids.size} id(s), ` +
        `${tally.onlyInFeed} feed-only date(s), ${tally.diffs.length} differing`,
    );
    reportStalePrefixes(stalePrefixes(tally.minFetched, orderedDates));
    for (const [id, ds] of [...byId].sort()) {
      const rels = ds.map((d) => d.rel);
      const worst = ds.reduce((a, b) => (b.rel > a.rel ? b : a));
      const flips = ds.filter((d) => d.stateChanged).length;
      console.log(
        `    ${id.padEnd(14)} ${String(ds.length).padStart(5)} diff  max ${pct(Math.max(...rels)).padStart(10)}` +
          `  median ${pct(median(rels)).padStart(10)}  worst ${worst.date} db=${worst.dbValue} feed=${worst.feedValue}` +
          (flips > 0 ? `  ⚠ ${flips} state flip(s)` : ""),
      );
    }
    allDiffs.push(...tally.diffs);
  }

  const flips = allDiffs.filter((d) => d.stateChanged);
  console.log(
    `\n[feed-diff] TOTAL ${allDiffs.length} differing row(s); ${flips.length} with a CHANGED confirmed state` +
      (flips.length > 0 ? ` → ${[...new Set(flips.map((f) => f.id))].join(", ")}` : "") +
      (failed.length > 0 ? `; ${failed.length} job(s) FAILED → ${failed.join(", ")}` : ""),
  );
  bucketReport(allDiffs, seriesLen);
  return failed.length > 0 ? 1 : 0;
}

const isMain = process.argv[1]?.endsWith("probe-feed-diff.ts") ?? false;
if (isMain) {
  main().then((c) => process.exit(c)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
