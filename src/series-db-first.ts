/**
 * DB-first cron feed seam (§4 stage 4.1): stored history
 * + a `TAIL_DAYS` tail; shallow (< `needRows`) ⇒ deep re-fetch. Wiring is 4.2/4.3 — no call site here.
 *
 * Merge, both arms: feed wins on shared dates; stored-only dates are kept; nothing is ever deleted
 * (⚠ `docs/reference.md` §[live] — the stored `^MOVE` 2026-07-20..07-31 closes exist nowhere upstream).
 *
 * Persists ONLY feed-fetched dates, SCORED by the caller's `score` over the merged series and projected
 * through `toStoredReadings` (the `recordRun` shape); a FINAL stored row unchanged in all four persisted columns is skipped.
 * A persist failure never throws past the scored readings — it reports through `onPersistError`.
 *
 * `warmup: true` sites (CG only) ALSO persist the scorer's
 * warm-up head: fetched points dated BELOW the first emitted reading go to `readings_warmup` (raw values,
 * upsert), and the read / arm decision / `have=` count the UNION of `readings` ∪ warm-up dates (a date in
 * both ⇒ `readings` wins). Without it a scorer whose head exceeds the seed slack sits on the deep arm forever.
 */
import type { Indicator, Observation, Reading } from "./domain-types.js";
import { isProvisional } from "./intraday.js";
import { estimateDatesOf, stampEstimated } from "./estimated.js";
import { sinceDaysAgo } from "./lookback.js";
import { toStoredReadings } from "./store-project.js";
import type { Store, ReadStore } from "./store.js";
import { BACKFILL_YEARS } from "./backfill-depth.js";
import { isoDay } from "./dates.js";
import type { FeedPorts } from "./feed-ports.js";

/** Calendar days the TAIL arm fetches (§0.6) — the single touch point; never restate the literal. */
export const TAIL_DAYS = 14;

/** `fetchSeries({ since })`-shaped lower bound for the tail arm: `TAIL_DAYS` calendar days ago. */
export const tailSince14 = (now: Date): string => sinceDaysAgo(TAIL_DAYS, now);

export type DbFirstArm = "deep" | "tail";

export interface DbFirstOpts {
  /** Stored `readings` id the series lives under (§0.3: an id already storing the series, never a second one). */
  id: string;
  /** The site's own required depth in ROWS: shallow ⇔ stored rows < needRows (§0.5). */
  needRows: number;
  /** Floor on the READ cap in rows (scorer warm-up, or a consumer's history pool — R4/ECY); never moves the deep-arm trigger (`needRows`). */
  minRows?: number;
  /** The site's current deep / `fullHistory` fetch — run only on a shallow store. */
  fetchDeep: () => Promise<Observation[]>;
  /** The `TAIL_DAYS` tail fetch — run when the store is deep enough. */
  fetchTail: () => Promise<Observation[]>;
  /** The site's live series scorer over the MERGED series (e.g. `moveReadingSeries` curried on its indicator). */
  score: (points: Observation[]) => Reading[];
  /** The run's own `runAt`, verbatim — the seam stamps its rows 1 ms earlier (see `seamRunAt`). */
  runAt: string;
  /** Read-only reuse: read + merge as usual but NEVER persist (§6.2). The one departure from §0.2's
   *  persist-on-degrade — for an id another writer owns (breadth's SPY, `INPUT_SERIES` cron writer). */
  readOnly?: boolean;
  /** Called once when `recordReadings` rejects; the scored readings are still returned. */
  onPersistError?: (err: unknown) => void;
  /** Opt-in: read + persist the scorer's warm-up head via `readings_warmup` (docblock). CG only. */
  warmup?: boolean;
  /** An intraday run keeps stored provisional rows in the merge; any other run drops them (EOD never scores a stale bar). */
  intraday?: boolean;
  /** Read at persist time (after the fetch): true ⇒ a FINAL prior is never rewritten, only new / provisional / estimated dates write. */
  holdFinal?: () => boolean;
}

export interface DbFirstResult {
  /** `score(merged)` — the scored series every call site consumes next, date-ascending as the scorer emits it. */
  readings: Reading[];
  /** The MERGED raw series (stored ∪ fetched, feed wins; a fetched `estimated` obs keeps its flag), date-ascending —
   *  for sites whose consumer takes observations, not readings (R7's three legs, ECY's DFII10, the slow track's VIXCLS). */
  points: Observation[];
  /** Which fetch ran — `deep` (shallow store, §0.2 re-seed) or `tail`. */
  arm: DbFirstArm;
  /** Distinct stored dates the arm decision read (`readings` ∪ warm-up for `warmup` sites) — the `have=` field of the §4.2 arm log. */
  have: number;
}

/** `runAt - 1 ms`: `readings_latest` orders `run_at desc` with NO tie-break, so the run's own row must be strictly newer. */
export const seamRunAt = (runAt: string): string => new Date(Date.parse(runAt) - 1).toISOString();

/** The store-facing half of one DB-first site's ask — the inputs of the ARM decision plus the site's
 *  persist flags. Each production site exports its spec (R6/CG/`r7LegFeed` in confirmers.ts,
 *  `breadthFeed`/R4 in run-dbfirst.ts, R5 in tracks.ts) and spreads it into its `dbFirstOrDirect`
 *  call, so the direct arm tests (`db-first-feeds.test.ts`) and the site read ONE object. */
export type DbFirstFeedSpec = Pick<DbFirstOpts, "id" | "needRows" | "minRows" | "warmup" | "readOnly" | "holdFinal">;

/** The arm's store-read cap in rows: `needRows`, widened by `minRows`. */
export const dbFirstReadCap = (feed: DbFirstFeedSpec): number => Math.max(feed.needRows, feed.minRows ?? 0);

/** What one arm resolution read: the decision, the stored-date count behind it (`have=` of the §4.2
 *  arm log), and the stored rows/map `dbFirstSeries` merges the fetch into (single store read). */
export interface DbFirstArmResolution {
  arm: DbFirstArm;
  have: number;
  merged: Map<string, number>;
  stored: Awaited<ReturnType<Store["getSeries"]>>;
}

/**
 * The per-feed deep-vs-tail decision, alone:
 * reads the stored series (∪ warm-up for `warmup` feeds) and ranks it against `needRows`. EVERY
 * DB-first site in `runScoringCycle` routes through this via `dbFirstSeries`; the direct tests
 * drive it with a seeded `InMemoryStore` instead of a full scoring cycle.
 */
export async function resolveDbFirstArm(store: ReadStore, feed: DbFirstFeedSpec, keepProvisional = true): Promise<DbFirstArmResolution> {
  // `getSeries` paginates past the PostgREST wire cap — a `needRows` above 5000 still reads complete.
  const cap = dbFirstReadCap(feed);
  const stored = await store.getSeries(feed.id, cap);
  // Warm-up head first, then `readings` overwrite — a date in both resolves to the scored row's value.
  const merged = new Map<string, number>();
  if (feed.warmup === true) for (const w of await store.getWarmup(feed.id, cap)) merged.set(w.date, w.value);
  for (const p of stored) merged.set(p.date, p.value);
  const have = merged.size; // depth counts every stored date; only the MERGE drops provisional rows
  // A non-intraday run never merges a provisional row: a feed lacking D must leave D unscored, not stale-final.
  if (!keepProvisional) for (const p of stored) if (isProvisional(p, feed.id)) merged.delete(p.date);
  // Every DB-first feed is PRINTS-ONLY (E2): an `estimated` row (the EOD R5/sovereign-quote head, E16/E17) never
  // merges — not even intraday — or it would score into a push (the slow track's R5 → `slowNotification`).
  for (const p of stored) if (p.estimated === true) merged.delete(p.date);
  return { arm: have < feed.needRows ? "deep" : "tail", have, merged, stored };
}

export async function dbFirstSeries(store: Store, opts: DbFirstOpts): Promise<DbFirstResult> {
  const { arm, have, merged, stored } = await resolveDbFirstArm(store, opts, opts.intraday === true);
  const fetched = arm === "deep" ? await opts.fetchDeep() : await opts.fetchTail();

  // Feed wins on shared dates; stored-only dates survive (never deleted — see the docblock).
  for (const f of fetched) merged.set(f.date, f.value);
  const estDates = new Set(estimateDatesOf(fetched));
  const points: Observation[] = [...merged]
    .map(([date, value]) => (estDates.has(date) ? { date, value, estimated: true as const } : { date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const readings = opts.score(points);

  // §6.2 read-only reuse (breadth's SPY): merge for the freshest series but persist NOTHING — the
  // id's own cron writer owns it (`INPUT_SERIES`), and a second writer is exactly what §0.3/§0.8 forbid.
  if (opts.readOnly !== true) {
    const fetchedDates = new Set(fetched.map((f) => f.date));
    const prior = new Map(stored.map((p) => [p.date, p]));
    // A row scored off a fetched `estimated` obs (a Treasury head) is stored `estimated`, never FINAL.
    const scored = stampEstimated(toStoredReadings(readings.filter((r) => fetchedDates.has(r.date))), estDates);
    // R1: a held feed never rewrites a FINAL prior.
    const held = opts.holdFinal?.() === true;
    const rows = scored.filter((row) => {
      const p = prior.get(row.date);
      return (
        p === undefined ||
        isProvisional(p, opts.id) || // an intraday row is rewritten even at the same value, so EOD finalizes it
        p.estimated === true || // likewise an estimate: the print lands as a FINAL row even when its value matches
        (!held &&
          (p.value !== row.value ||
            p.delta20 !== row.delta20 ||
            p.rawState !== row.rawState ||
            p.state !== row.state))
      );
    });
    if (rows.length > 0) {
      try {
        await store.recordReadings(rows, seamRunAt(opts.runAt));
      } catch (err) {
        opts.onPersistError?.(err);
      }
    }
    if (opts.warmup === true) {
      // The head the scorer burned: fetched points below the first emitted reading. Empty by construction
      // on the tail arm (nothing fetched dates below a deep store's first reading) ⇒ idempotent.
      const first = readings[0]?.date;
      const head = fetched
        .filter((f) => first === undefined || f.date < first)
        .map((f) => ({ indicatorId: opts.id, date: f.date, value: f.value }));
      if (head.length > 0) {
        try {
          await store.recordWarmup(head, seamRunAt(opts.runAt));
        } catch (err) {
          opts.onPersistError?.(err);
        }
      }
    }
  }
  return { readings, points, arm, have };
}

/**
 * Stored rows a full `days`-calendar-day window is expected to hold (§0.5's "rows ≥ days × 0.69",
 * bounded honestly): 252 trading days a year LESS ~10 exchange holidays and a ~2-obs feed-gap
 * allowance = 240 rows/yr. The plan's bare 252/365 sits ABOVE what a full window actually yields
 * (1500 calendar days of ^MOVE ≈ 1,028 closes vs 1,035 asked), which would rank a FULL store shallow
 * on every run — the deep arm forever, the tail arm never. Single touch point; never restate.
 */
const NEED_ROWS_PER_CALENDAR_DAY = 240 / 365;
export const needRowsForCalendarDays = (days: number): number => Math.floor(days * NEED_ROWS_PER_CALENDAR_DAY);
/** Rows a READ of a `days`-calendar-day window must cap at to see all of it: `needRowsForCalendarDays` +10% clears every weekday (5/7). Never the shallow check. */
export const readRowsForCalendarDays = (days: number): number => Math.ceil(needRowsForCalendarDays(days) * 1.1);

/** The run-scoped handle a call site needs to go DB-first: the cron's `Store` + the run's own `runAt`. */
export interface DbFirstCtx {
  store: Store;
  runAt: string;
  /** The run is intraday (`RunCycleOptions.intraday`) — forwarded as `DbFirstOpts.intraday`. */
  intraday?: boolean;
  /**
   * The run's SERIES-form scorer for a registry (FRED-loop) id — what a site that reads ANOTHER id's
   * stored series (R7 over R1/R2/R3, ECY over R4, the slow track over R5) hands the seam as `score`, so
   * the rows it persists under that id carry the same vintage the core loop writes (`scoreWithCutsSeries`,
   * `confirmers.ts`, curried on the run's `calib`/`synthHistories`/short leg by `run-cycle-fred.ts`).
   * Absent (a ctx built without it) ⇒ such a site takes the direct arm and persists nothing.
   */
  seriesScorerFor?: (indicator: Indicator) => Promise<(points: Observation[]) => Reading[]>;
  /** The run's feed ports (`RunBase.feeds`); absent ⇒ `realFeeds`. */
  feeds?: FeedPorts;
}

/**
 * DB-first when the caller holds a run context, the site's plain deep fetch when it does not (an
 * offline/backtest caller with no store): the direct arm runs `fetchDeep` and scores it, persisting
 * nothing — the pre-4.2 behaviour, byte-for-byte.
 */
export async function dbFirstOrDirect(
  ctx: DbFirstCtx | undefined,
  opts: Omit<DbFirstOpts, "runAt">,
  log: (line: string) => void = console.log,
): Promise<Omit<DbFirstResult, "arm"> & { arm: DbFirstArm | "direct" }> {
  if (ctx === undefined) {
    const points = await opts.fetchDeep();
    // Direct arm has no store to count: `have=-` distinguishes "no store" from a real 0-row store.
    // The returned `have` is a sentinel 0 (unread by every consumer — they take `points`/`readings`).
    log(`[db-first] ${opts.id} arm=direct have=- need=${opts.needRows}`);
    return { readings: opts.score(points), points, arm: "direct" as const, have: 0 };
  }
  const result = await dbFirstSeries(ctx.store, { ...opts, runAt: ctx.runAt, intraday: ctx.intraday });
  // ONE line per DB-arm site (the deep|tail arm's real stored-row count) — `vercel logs` grep:
  // an `arm=deep` on run ≥ 2 means the prior run's persist rejected (§4.2 "Arm log", ruling 2).
  log(`[db-first] ${opts.id} arm=${result.arm} have=${result.have} need=${opts.needRows}`);
  return result;
}

/** Seed-window depth — DEFINED in `src/backfill-depth.ts` (the registry entries derive their `backfill`
 *  from it without importing this module's store/fred layer); the deep arms below size off it. */
export { BACKFILL_YEARS };

/** Stored rows a full seed-depth window is expected to hold — the deep arms' shallow check. */
export const needRowsForSeedDepth = (): number => needRowsForCalendarDays(BACKFILL_YEARS * 365);

/** Calendar days the deep arm fetches BEYOND the seed depth — one year of warm-up for the FRED ids on
 *  this arm. BONOS is NOT on it (its spread legs fetch their own depth), so `oatLegBase` never binds it. */
const DEEP_ARM_WARMUP_DAYS = 365;

/** The deep arm's `since` bound as of `now`: seed depth + warm-up back — bounded, never inception. */
export function deepArmSince(now: Date): string {
  return isoDay(new Date(now.getTime() - (BACKFILL_YEARS * 365 + DEEP_ARM_WARMUP_DAYS) * 86_400_000));
}
