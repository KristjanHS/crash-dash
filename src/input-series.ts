/**
 * The read-handlers' upstream input series, persisted by the cron so the handlers can read
 * them from the store (mechanism:
 * raw GREEN-stamped rows via `priceLegReadingSeries`, the F7-CAPE / pension-leg precedent —
 * NO card, NO scorer, NO registry roster). The rows are display-less: `state=GREEN` is the
 * NOT-NULL placeholder and every panel/notify surface excludes them by omission, exactly
 * like `LEGP_*`. Missing-row rule (§6): a handler whose input rows are missing or stale
 * serves the response WITHOUT that cut/companion (200, `VINTAGE_HEADERS`,
 * `warnMissingInput` once per instance) — never an upstream fetch, never a 503.
 *
 * Zero IO besides the injected Store: the cron writer is `seedInputSeriesOnCron`
 * (src/run-seeds.ts); the CLI deep seed is `backfillInputSeries` (scripts/backfill.ts).
 */
import type { ReadStore } from "./store.js";
import type { Observation } from "./domain-types.js";
import { isProvisional } from "./intraday.js";
import { cgLookbackDays } from "./scorers-composite.js";

export interface InputSeriesSpec {
  /** Store id == upstream series id/symbol unless `symbol` is set (`readings.indicator_id` is plain
   *  text, no CHECK — the `^`-prefixed ids are fine; `LEGP_*` is the non-indicator-id precedent). */
  id: string;
  feed: "fred" | "price" | "ntfs" | "snapshot";
  /** Upstream fetch id when it differs from the store id — price ticker (`SP500IT`←`XLK`), FRED series or the DRAM snapshot source row label. */
  symbol?: string;
  /** Deep-seed window override for a price id whose handler fetches deeper than the 20y
   *  `DEEP_LOOKBACK_DAYS` default (api/replay.ts `GSPC_LOOKBACK_DAYS`/`COMPANION_LOOKBACK_DAYS`/
   *  `IEF_LOOKBACK_DAYS`, all 31y — the stitch must reach 2002). Full/first-seed fetches only. A function
   *  resolves at the seed's `now` (COPPER: CG's `cgLookbackDays`, so the price memo serves both from one fetch). */
  deepLookbackDays?: number | ((now: Date) => number);
  /** Opt this id into the cron's `TAIL_DAYS` value-diff repair (`tailValueRepairs`, run-seeds.ts):
   *  a dividend-adjusted feed rescales stored tails on an ex-div, so insert-missing keeps a stale vintage. */
  tailRepair?: boolean;
}

/** Mirrors api/replay.ts's 31y lookbacks (`^GSPC`/`^IXIC`/`IEF` must reach 2002); src must not
 *  import api/, so the literal is restated here — replay's own constants stay its source. */
const REPLAY_DEEP_LOOKBACK_DAYS = 31 * 365;
/** First-seed depth of the leg-fallback-only tickers — a few `TAIL_DAYS` windows, not the default deep history. */
const LEG_FALLBACK_LOOKBACK_DAYS = 60;

/** Newest-N cap for the stored BAMLH0A0HYM2 tail fed to `stitchHyOas` (api/replay.ts +
 *  api/lab.ts): mirrors the retired live fetch's default trailing window (src/fred.ts
 *  `FRED_LOOKBACK_DAYS` = 800 calendar days ≈ 550 trading rows — newest-800 rows reaches at
 *  least as deep), keeping the vintage overlap (and its GROSS_TOLERANCE 500) off the deep
 *  1996→ history a full-depth read would expose to routine FRED revisions. */
export const HY_LIVE_TAIL_ROWS = 800;

/**
 * Every series the read handlers (`api/series.ts`, `api/replay.ts`, `api/lab.ts`) fetched
 * upstream at request time before P1. EBP is NOT here — already a persisted indicator, read
 * from its existing rows. The `withPostInversionCut` own-series reads (`indicator.series`)
 * ARE here: R1 → T10Y3M, R8 → NTFS.
 *
 * The DB-first seam (src/series-db-first.ts callers) persists five of these series' VALUES
 * under the INDICATOR ids — T10Y3M→R1, DGS10→R2, DGS2→R3, DFII10→R4, VIXCLS→R5 — never under
 * the raw series ids, so the raw-id rows here are a separate cron-seeded copy: no id
 * collision, no vintage shadowing, and every roster id needs THIS seed to exist at all.
 *
 * The PENSION-channel rows (last block) are NOT read-handler inputs: this roster is their only cron
 * writer since J4 retired `scorePensionTrack` — pinned by `run-seeds.input-series.test.ts`.
 */
export const INPUT_SERIES: readonly InputSeriesSpec[] = [
  // R7 bull-steepener legs (api/series.ts `bullSteepenerSeries`).
  { id: "T10Y3M", feed: "fred" },
  { id: "DGS2", feed: "fred" },
  { id: "DGS10", feed: "fred" },
  // Post-inversion short leg (api/series.ts `withPostInversionCut`, `cfg.shortLegSeries`).
  { id: "DGS3MO", feed: "fred" },
  // Post-inversion OWN series of R8 (`indicator.series`, FEED_OF.R8 = "ntfs" → src/gsw.ts, always
  // full-history by construction). R1's own series is T10Y3M (above).
  { id: "NTFS", feed: "ntfs" },
  // ECY join (api/series.ts `ecyJoinSeries`).
  { id: "DFII10", feed: "fred" },
  // Credit bridge (api/series.ts `withCreditBridgeCuts`).
  { id: "BAA10Y", feed: "fred" },
  { id: "AAA10Y", feed: "fred" },
  // BBB OAS card (registry-fred.ts `BBB`, never scored): store id = card id, read by the semis watch `bbb` confirmer.
  { id: "BBB", feed: "fred", symbol: "BAMLC0A4CBBB" },
  // Replay stitch + companions (api/replay.ts; api/lab.ts reads BAMLH0A0HYM2 too).
  { id: "BAMLH0A0HYM2", feed: "fred" },
  { id: "VIXCLS", feed: "fred" },
  { id: "T10Y2Y", feed: "fred" },
  { id: "DCOILWTICO", feed: "fred" },
  { id: "^GSPC", feed: "price", deepLookbackDays: REPLAY_DEEP_LOOKBACK_DAYS },
  { id: "ACWI", feed: "price" },
  // IEF + HYG are `nowcastHyOas` legs (log-return vs a stored base close): an ex-div rescales the
  // provider's earlier adjusted closes, so their stored tails must be re-synced to the fresh vintage.
  { id: "IEF", feed: "price", deepLookbackDays: REPLAY_DEEP_LOOKBACK_DAYS, tailRepair: true },
  { id: "^IXIC", feed: "price", deepLookbackDays: REPLAY_DEEP_LOOKBACK_DAYS },
  // F1 / F2 OAS nowcast legs (src/hyoas-nowcast.ts; E8: probe-only); IEF above is the hedge leg.
  { id: "HYG", feed: "price", tailRepair: true },
  { id: "LQD", feed: "price", tailRepair: true },
  // BRENT / G1 same-day oil nowcast futures (the registry rows' `carry-log` leads): keyless-only by the `=F` suffix.
  // `tailRepair`: the stored close can predate the closes provider's settlement price (up to ~$1.2 off).
  { id: "BZ=F", feed: "price", tailRepair: true },
  { id: "CL=F", feed: "price", tailRepair: true },
  // SPY is NOT a read-handler input — it rides this roster solely to give the breadth path's
  // READ-ONLY SPY store a live cron writer. J4 retired `scorePensionTrack`, the writer that kept the
  // (pension-owned) SPY id fresh; with no writer the DB-first TAIL arm (`resolveBreadthCloses`,
  // readOnly) fetches only a 14-day tail and merges it onto a FROZEN deep base, opening a widening
  // gap that corrupts SPCONC (SPY/RSP) and F6 (SMH·SPY)'s trailing-252-close high. Removing this row
  // re-breaks that — pinned by `run-seeds.input-series.test.ts`'s BREADTH_READ_ONLY-writer guard.
  { id: "SPY", feed: "price" },
  // ETFs-card PENSION inputs (`LEGP_*` legs excepted — `seedLegClosesOnCron` writes them). VEA/SMH are NOT card rows and no
  // longer a leg fallback (`LEGP_SEMIS`/`LEGP_EXUS` read SEC0.DE/CHSI.DE below); SMH feeds F4/F6/FDX, VEA the pension `SleeveId`.
  { id: "DEXUSEU", feed: "price", symbol: "EURUSD=X" },
  { id: "VEA", feed: "price" },
  { id: "SP500IT", feed: "price", symbol: "XLK" },
  { id: "SMH", feed: "price" },
  { id: "VWO", feed: "price" },
  { id: "VGK", feed: "price" },
  { id: "XDEV", feed: "price", symbol: "XDEV.DE" },
  // Value-ladder inputs: comparator rows read by `probe:value-tranches`, never scored.
  { id: "KBE", feed: "price" },
  // SK Hynix (KRX, keyless-only by suffix) + Applied Materials: the probe's two display-only comparator reads (never a criterion).
  { id: "HYNIX", feed: "price", symbol: "000660.KS" },
  { id: "AMAT", feed: "price" },
  // USD/KRW + copper front-month (keyless-only by suffix): the probe's two display-only change lines (never a criterion).
  { id: "KRW", feed: "price", symbol: "KRW=X" },
  { id: "COPPER", feed: "price", symbol: "HG=F", deepLookbackDays: cgLookbackDays },
  // EXSH_GATE (EXSH.DE/EXSA.DE), INS_RS (EXH5.DE/EXSA.DE) + AT1 (XAT1.DE/EXHA.DE) legs are NOT read-handler inputs either — they ride this roster so
  // the run's live price batch can fill the closes provider's Xetra D-1 null bar from a stored close (`withStoredLegs`, run-dbfirst.ts;
  // Defect 3). keyless-only by suffix and dividend-paying ETFs read as ratio/MA
  // inputs, so they take the same ex-div tail repair as `HYG`.
  { id: "EXSH.DE", feed: "price", tailRepair: true },
  { id: "EXSA.DE", feed: "price", tailRepair: true },
  { id: "EXH5.DE", feed: "price", tailRepair: true },
  { id: "XAT1.DE", feed: "price", tailRepair: true },
  { id: "EXHA.DE", feed: "price", tailRepair: true },
  // The `.DE` ladder + off-ladder leg tickers XDEV.DE does not already cover ([USER] 2026-10-05): stored so
  // `seedLegClosesOnCron` fills a leg's Xetra close the live closes feed lacks from its settled evening row (`withStoredLegs`, `head`).
  // Read only as a `TAIL_DAYS` fallback, so the unseeded deep fetch is shallow. No tail repair: a hole fill rescales to
  // the live vintage, and a head fill is written `estimated` until a live fetch re-chains it.
  { id: "QDVE.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "IS3N.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "SXR8.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "SEC0.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "CHSI.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "QDVG.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "ZPDS.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "LYTR.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
  { id: "PSWD.DE", feed: "price", deepLookbackDays: LEG_FALLBACK_LOOKBACK_DAYS },
];

/** Newest-row age (days vs `now`) beyond which a stored input is treated as ABSENT: 45 covers
 *  a monthly first-of-month print plus holidays, while a quietly-dark daily series degrades. */
const INPUT_MAX_STALE_DAYS = 45;

/** Per-id staleness overrides (readInputSeries also serves non-roster ids). EBP — the persisted
 *  monthly indicator the credit bridge reads — dates rows first-of-month and releases ~a month
 *  late (~65d old on a NORMAL cadence), so 100 ≈ one further missed release before it degrades. */
const MAX_STALE_DAYS_BY_ID: Readonly<Record<string, number>> = { EBP: 100 };

const DAY_MS = 86_400_000;

/**
 * Read a batch of persisted input series as `Observation[]` (ascending by date, the shape the
 * stitch/cut seams consume). ONE `getSeriesBulk` round trip; an id with no stored rows — or
 * whose newest row is older than its max-stale-days cap vs `opts.now` (required)
 * — is ABSENT from the map (the caller applies the missing-row rule above).
 */
export async function readInputSeries(
  store: ReadStore,
  ids: readonly string[],
  limit: number,
  opts: { now: Date; keep?: (id: string, p: { date: string; runAt?: string; estimated?: boolean }) => boolean; warn?: (...args: unknown[]) => void },
): Promise<Map<string, Observation[]>> {
  const { now } = opts;
  const bulk = await store.getSeriesBulk([...ids], { limit });
  const out = new Map<string, Observation[]>();
  for (const id of ids) {
    const stored = bulk.get(id) ?? [];
    if (stored.length === 0) continue;
    const points = opts.keep ? stored.filter((p) => opts.keep!(id, p)) : stored;
    // Staleness off the newest KEPT row when `keep` names the settled closes (an EU evening quote row is one — settledClose);
    // otherwise off the newest non-estimate row — an estimate-only head (E3) must not mask a stale series.
    const newest = (opts.keep ? points.at(-1) : points.findLast((p) => p.estimated !== true))?.date;
    const maxStale = MAX_STALE_DAYS_BY_ID[id] ?? INPUT_MAX_STALE_DAYS;
    const ageDays = newest === undefined ? Infinity : (now.getTime() - Date.parse(newest)) / DAY_MS;
    if (ageDays > maxStale) {
      warnMissingInput(id, newest === undefined ? "stale: no kept non-estimate row" : `stale: newest row ${newest} is ${Math.floor(ageDays)}d old > ${maxStale}d`, opts.warn);
      continue;
    }
    out.set(id, points.map((p) => ({ date: p.date, value: p.value })));
  }
  return out;
}

/** Ids already warned about this instance, per sink — module-level so a hot lambda warns once, not per
 *  request. Keyed by sink so an injected one (a handler's `warn` seam) starts its own once-set; every
 *  default caller shares the single `console.warn` set. */
const warnedInputs = new WeakMap<(...args: unknown[]) => void, Set<string>>();

/** Warn ONCE per id per instance (per sink) that an input series is missing/stale (the §6 missing-row
 *  rule's observability half — the response still serves, without that cut/companion). */
export function warnMissingInput(id: string, where: string, warn: (...args: unknown[]) => void = console.warn): void {
  let warned = warnedInputs.get(warn);
  if (!warned) warnedInputs.set(warn, (warned = new Set<string>()));
  if (warned.has(id)) return;
  warned.add(id);
  warn(`[input-series] ${id} missing/stale in the store (${where}) — serving without it`);
}

/** UTC minute after which an intraday write of an EU listing's date is its CLOSE: clears the winter closing auction
 *  (16:30–16:35 UTC) plus the closes provider's ~15-min EU delay; keeps the 17:30 / 18:31 runs. */
const EU_SETTLED_UTC_MIN = 17 * 60 + 5;
const EU_LISTING = /\.(DE|AS|L|PA|MI)$/;

/**
 * Whether a stored price row may fill a live-feed hole (`fillLiveHoles`) — [USER] ruling 2026-10-02,
 * re-affirmed 2026-10-07: a FINAL print always; an EU listing's row written after its exchange closed (`EU_SETTLED_UTC_MIN`) always — that
 * evening write is a settled close and the only stored copy when the live closes feed lacks D (its null-closed D bar is
 * closed by `closesMetaClose`, prices.ts), and since the quote-label change it is stored `estimated` (`source: quote`), which changes its
 * label, not its value. Every other symbol's estimate or provisional row (US, `=X`
 * FX, `=F` futures trade past the last intraday run — a pre-close value) is never a base.
 */
export function settledClose(symbol: string, p: { date: string; runAt?: string; estimated?: boolean }, id?: string): boolean {
  const eu = EU_LISTING.test(symbol);
  if (p.estimated === true && !eu) return false; // a non-EU estimate is never a base close (E3)
  if (!isProvisional(p, id) && p.estimated !== true) return true; // `id`: the stored id's own session close
  if (!eu) return false;
  return Date.parse(p.runAt!) >= Date.parse(`${p.date}T00:00:00Z`) + EU_SETTLED_UTC_MIN * 60_000;
}

/** A spec's resolved `deepLookbackDays` at `now`, undefined ⇒ the 20y deep default. */
export function inputDeepLookbackDays(spec: InputSeriesSpec, now: Date): number | undefined {
  const d = spec.deepLookbackDays;
  return typeof d === "function" ? d(now) : d;
}

/** The fetch symbol an `INPUT_SERIES` store id reads (`XDEV`→`XDEV.DE`); the id itself when unrostered. */
export function inputSeriesSymbolOf(id: string): string {
  const spec = INPUT_SERIES.find((s) => s.id === id);
  return spec?.symbol ?? id;
}

/** The `INPUT_SERIES` store id a price-feed symbol persists under (`XDEV.DE`→`XDEV`), or undefined when unrostered. */
export function inputSeriesIdOf(symbol: string): string | undefined {
  return INPUT_SERIES.find((s) => s.feed === "price" && (s.symbol ?? s.id) === symbol)?.id;
}

/**
 * Live closes with their HOLES filled from stored closes — the `series-db-first.ts` merge rule (live wins per
 * date) bounded — without `head` — to dates strictly BEFORE the live feed's newest close: a stored row only fills a
 * date the live feed skipped (the closes provider's EU/FX D-1 null bar), so
 * the live feed alone defines "now". An empty live feed stays empty either way. Pure.
 *
 * `head: true` (the `LEGP_*` leg seed ONLY, [USER] 2026-10-05) lifts the newest bound: a stored row dated past the
 * live newest extends the series too. When the live feed lacks a Xetra listing's D bar (the closes provider null-closes it until the next
 * session; `closesMetaClose` now closes it from `meta`), without it a Friday close waits for Monday's EOD; `settledClose` (the caller's filter) keeps a pre-close row out. A head row is
 * the STORED price scaled at an earlier shared date, not the live adjusted vintage — the caller marks it an estimate.
 *
 * A filled value is rescaled by live/stored at the nearest shared date (later first): an ex-div rescales the
 * provider's adjusted history, and a hole date the feed never serves again would otherwise keep the old scale.
 */
export function fillLiveHoles(
  live: readonly Observation[],
  stored: readonly Observation[],
  { head = false }: { head?: boolean } = {},
): Observation[] {
  const newest = live.at(-1)?.date;
  if (newest === undefined) return [];
  const liveBy = new Map(live.map((l) => [l.date, l.value]));
  const shared = stored.filter((s) => liveBy.has(s.date) && s.value !== 0);
  const scaleAt = (date: string): number => {
    const ref = shared.find((s) => s.date > date) ?? shared.filter((s) => s.date < date).at(-1);
    return ref ? liveBy.get(ref.date)! / ref.value : 1;
  };
  const merged = new Map<string, Observation>();
  for (const s of stored) if ((head || s.date < newest) && !liveBy.has(s.date)) merged.set(s.date, { date: s.date, value: s.value * scaleAt(s.date) });
  for (const l of live) merged.set(l.date, { ...l }); // a live obs keeps its `estimated` flag (the closes feed's meta close)
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Wrap a live `(symbol) => closes` feed so each rostered symbol's holes fill from its stored `INPUT_SERIES` rows
 * (`fillLiveHoles`), using only `settledClose` rows. The stored rows come from ONE lazy `readInputSeries` bulk read of `symbols`, newest `limit`
 * rows each, shared across calls (staleness judged at `opts.now`, the run's clock). `opts.head` → `fillLiveHoles`. A store
 * failure degrades to the live feed as is, warned and handed to `onFail`; a live failure still throws.
 * `onFail` is required: each caller picks its channel — a scoring caller `recordDegrade(…, "notify")`, a step after `recordRun` a no-op.
 */
export function withStoredLegs(
  store: ReadStore,
  symbols: readonly string[],
  fetchLive: (symbol: string) => Promise<Observation[]>,
  limit: number,
  { head, warn = console.warn, onFail, ...opts }: { now: Date; head?: boolean; warn?: (...args: unknown[]) => void; onFail: (scope: string, reason: string) => void },
): (symbol: string) => Promise<Observation[]> {
  const idOf = new Map(symbols.flatMap((sym) => { const id = inputSeriesIdOf(sym); return id ? [[sym, id] as const] : []; }));
  let storedP: Promise<Map<string, Observation[]>> | undefined;
  const stored = (): Promise<Map<string, Observation[]>> =>
    (storedP ??= readInputSeries(store, [...new Set(idOf.values())], limit, { ...opts, warn, keep: (id, p) => settledClose(inputSeriesSymbolOf(id), p, id) }).catch((err: unknown) => {
      const scope = `[input-series] ${[...new Set(idOf.values())].join(",")} stored legs unreadable — live feed only`;
      const reason = err instanceof Error ? err.message : String(err);
      warn(`${scope}: ${reason}`);
      onFail(scope, reason);
      return new Map<string, Observation[]>();
    }));
  return async (symbol) => {
    const live = await fetchLive(symbol);
    const id = idOf.get(symbol);
    if (id === undefined) return live;
    return fillLiveHoles(live, (await stored()).get(id) ?? [], { head });
  };
}
