/**
 * Shared fixtures + stub feeds for the `backfill.*.test.ts` suite (split 2026-09-05 from the
 * monolithic backfill.test.ts). NOT a `.test.ts` —
 * vitest would collect it. Holds:
 *  - the synthetic series builders (`obsSeries`/`readingSeries`/`monthlyObs`) and the hermetic
 *    `stub: BackfillDeps` every job/policy/restate suite drives (no network);
 *  - `sharedVirginRun()` — the Item-3 perf hoist: ONE memoized virgin full-stub `backfillAll`
 *    (recording deps wrapper) that the roster, R8/DFII10-consumer, VT-term-structure and
 *    sovereign-spread-depth tests all read instead of driving their own. Each consuming test file awaits it
 *    in its own `beforeAll`; the promise is module-cached, so under the shared project's
 *    `isolate: false` registry the run happens once per worker. Only the MUTATION arms
 *    (idempotent re-run, seeded skip/shrink/reshadow/deepen, and the backwardated/flaky/`only`
 *    feeds) keep a run of their own.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { DEEP_PRICE_INPUTS } from "../src/registry-price.js";
import { FEED_OF, INDICATORS, R6 } from "../src/registry-fred.js";
import { type Observation, type Reading } from "../src/domain-types.js";
import { BREADTH_MIN_CLOSES } from "../src/scorers-price.js";
import { levelBandHead, moveLegBase, oatLegBase } from "../src/scorers-composite.js";
import { BONOS_DESCRIPTOR, CG_DESCRIPTOR, ECY_MIN_OBS, HCX_SYMBOLS } from "../src/family-descriptor-rows.js";
import { HICP_SERIES } from "../src/hicp.js";
import { CONFIRM_CLOSES } from "../src/domain-types.js";
import { InMemoryStore } from "../src/store-memory.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "../src/intraday.js";
import type { StoredReading } from "../src/store.js";
import { backfillAll, isoDaysBefore, SCORED_WARMUP_DAYS, specRoster, type BackfillDeps } from "./backfill.js";
import { FRESH_MARGIN_DAYS } from "./restate-policy.js";

// A real indicator (F1) for the probe-depth Reading[]; its id is reused as the
// backfillHistory probe id so the stored indicatorId and the probe key match.
export const PROBE_IND = INDICATORS[0]!;

// Synthetic daily observations (oldest→newest). 300 points clears the deepest
// scorer window (HIGH_WINDOW=252) so every *ReadingSeries emits ≥1 reading. A mild
// ramp + sine avoids all-identical levels (keeps delta20/MA computations honest).
export function obsSeries(n: number, startISO = "2019-01-01"): Observation[] {
  const out: Observation[] = [];
  const d = new Date(`${startISO}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push({ date: d.toISOString().slice(0, 10), value: 100 + Math.sin(i / 9) * 6 + i * 0.03 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// A pre-built confirmed-state Reading[] (bypasses scoring) for the probe-depth test.
export function readingSeries(n: number, startISO = "2010-01-01"): Reading[] {
  const out: Reading[] = [];
  const d = new Date(`${startISO}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push({
      indicator: PROBE_IND,
      date: d.toISOString().slice(0, 10),
      level: 1 + i * 0.001,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Monthly first-of-month observations ("YYYY-MM-01") — K1's date-anchored YoY looks up the
// month 12 back, so daily obsSeries never lands an anchor and K1 would seed 0. 30 months gives
// 19 computable YoY readings: the first ~11 months have no in-window anchor (skipped), and the
// boundary month 2019-12-01 lands an approximate 11-month anchor via the ±1 tolerance (emits one
// benign [kiley] approximate-anchor warn). Ramp so the YoY is non-trivial.
export function monthlyObs(n: number, startYear = 2019, startMonth = 1): Observation[] {
  const out: Observation[] = [];
  for (let i = 0; i < n; i++) {
    const abs = startYear * 12 + (startMonth - 1) + i;
    const y = Math.floor(abs / 12);
    const m = abs - y * 12 + 1;
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-01`, value: 100 + i * 0.3 });
  }
  return out;
}

export const N = 300;
// Ends the Bund/sovereign-quote fakes clear of every `reshadowTailDays` window, so an idempotent re-run
// still writes nothing; the span left above `bundSince` is ~700 rows, far more than any consumer folds.
export const STUB_TAIL_GAP = 60;
// The run clock the stub feeds anchor to — shared with `opts.now` so a fake's dates and the
// `sinceDate` bounds the specs derive from `now` sit on the same timeline.
export const STUB_NOW = new Date("2024-06-01T00:00:00Z");
const SPREAD_BACKFILL_LEN = oatLegBase(BONOS_DESCRIPTOR.scorer.constants) + CONFIRM_CLOSES + 20;
/** The stub sovereign-quote leg's offset (pct points) over the shared base: DE10Y-DE is the German leg (0). */
const sovereignLegOffset = (symbol: string): number =>
  symbol === "DE10Y-DE" ? 0 : symbol === "FR10Y-FR" ? 0.5 : symbol === "GB10Y-GB" ? 1.7 : 0.8;
// The stub feeds' monthly FRED series. `stub` serves the rest daily; `windowedStub` keeps DFII10
// daily (as in prod) and serves `isWeeklyFred` series weekly.
export const isMonthlyFred = (series: string): boolean =>
  series === "CPIAUCSL" || series === "UNRATE" || series === "DFII10" || series === HICP_SERIES;
// FRED-fed series on a WEEKLY observation grid (`obsCadence ?? cadence`): NFCIRISK (F3) today.
const WEEKLY_FRED = new Set(ALL_INDICATORS.filter((i) => (i.obsCadence ?? i.cadence) === "weekly" && !FEED_OF[i.id]).map((i) => i.series));
export const isWeeklyFred = (series: string): boolean => WEEKLY_FRED.has(series);
/** The weekday a weekly FRED row is stamped on: NFCI's week-ending FRIDAY (F3's registry `cadence` note). */
export const FRED_WEEKLY_OBS_DAY = 5;
// `isMonthlyFred` series get monthly rows (K1 exercises its real monthly YoY path); every other FRED
// series, weekly ones included, gets the ≥300-pt daily series its scorer windows need.
export const stub: BackfillDeps = {
  // DFII10 branches to a MONTHLY 300-pt series sharing fetchCape's months: ECY's inner join needs
  // > PCT_MIN_OBS prior joined months to emit at all, and R4's positional windows clear on 300
  // points of either cadence.
  fetchFred: async (series: string) =>
    !isMonthlyFred(series)
      ? obsSeries(N)
      : series === "DFII10"
        ? monthlyObs(300, 1998)
        : series === HICP_SERIES
          ? monthlyObs(60) // HICP's monthly index: clears the hicpDelta6m head + minObs
          : monthlyObs(30),
  fetchEbp: async () => obsSeries(N),
  fetchEcb: async () => obsSeries(N),
  // CG's two legs get a DEEPER series: its detrended level band (2026-08-08) emits no reading
  // until `levelBandHead` observations have passed, which is past N — the id would seed 0 rows
  // and fall out of the key-set equality below. Length DERIVED, so a trend-window retune moves
  // it. Every other symbol keeps N, so no other id's seeded span changes.
  // R6 is the same shape one family over (2026-08-31, §2 of the r6-restate plan): `moveReadingSeries`
  // emits nothing until `moveLegBase()` (255 since 2026-09-02 — the VELOCITY leg, R6's only remaining
  // warm-up) has passed — past N, so it seeded 0 and fell out of the key set. Always size off the
  // helper, never a literal: that number has moved with every level-leg change R6 has had.
  fetchPrices: async (symbol: string) =>
    (CG_DESCRIPTOR.inputs as readonly string[]).includes(symbol)
      ? obsSeries(levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES + 20)
      : symbol === R6.series
        ? obsSeries(moveLegBase() + CONFIRM_CLOSES + 20)
        : DEEP_PRICE_INPUTS.has(symbol) || (HCX_SYMBOLS as readonly string[]).includes(symbol) // breadth rows emit only ranked days
          ? obsSeries(BREADTH_MIN_CLOSES + 20)
          : obsSeries(N),
  // The sovereign-quote legs, each `sovereignLegOffset` above one shared base ⇒ POSITIVE constant spreads. BONOS's
  // velocity scorer emits no reading until its σ head passes, past N — DERIVED length so an arm retune moves it.
  // ⚠ Anchored to END at `STUB_NOW`, not at obsSeries's 2019 default: consumers slice ONE shared pull to their
  // own bounds (`sovereign`, backfill.ts), so a series dated years before them slices to NOTHING for the shallower consumer.
  fetchSovereignDaily: async (symbol: string) =>
    obsSeries(SPREAD_BACKFILL_LEN, isoDaysBefore(STUB_NOW, SPREAD_BACKFILL_LEN - 1 + STUB_TAIL_GAP)).map((o) => ({
      ...o,
      value: o.value + sovereignLegOffset(symbol),
    })),
  fetchCape: async () => monthlyObs(300, 1998),
  fetchNtfs: async () => obsSeries(N), // R8's NTFS composite (FEED_OF → indObs's ntfs branch)
};
/** Stale-store age: past the skip margin by two monthly periods (31-day months). */
export const AGE_DAYS = FRESH_MARGIN_DAYS + 2 * 31;
/** Long-feed depth: twice the deepest scored-spec warmup, plus the stale age. */
export const FEED_DAYS =
  2 * Math.max(...specRoster().map((s) => s.warmupDays ?? SCORED_WARMUP_DAYS)) + AGE_DAYS;

const inWindow = (obs: Observation[], from?: string, to?: string): Observation[] =>
  obs.filter((o) => (from === undefined || o.date >= from) && (to === undefined || o.date <= to));

/** Monthly + DFII10 depth floor: ECY emits only past `ECY_MIN_OBS` joined CAPE×DFII10 months. */
const ECY_FEED_DAYS = (ECY_MIN_OBS + 12) * 31;

const NOW_ISO = STUB_NOW.toISOString().slice(0, 10);
// Mon–Fri (+ STUB_NOW itself): a 7-day stub week holds 7/5 the closes a trading-day-sized calendar lookback sees.
const weekdays = (obs: Observation[]): Observation[] =>
  obs.filter((o) => new Date(o.date).getUTCDay() % 6 !== 0 || o.date === NOW_ISO);
// Per-symbol phase shift: one shared base curve makes every ratio/spread composite flat.
const phaseOf = (key: string): number => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 89, 7);
const shapedMemo = new Map<string, Observation[]>();
const shaped = (key: string, days: number): Observation[] => {
  const k = `${key}|${days}`;
  let obs = shapedMemo.get(k);
  if (obs === undefined) {
    obs = weekdays(obsSeries(days + phaseOf(key), isoDaysBefore(STUB_NOW, days + phaseOf(key) - 1)).slice(phaseOf(key)));
    shapedMemo.set(k, obs);
  }
  return obs;
};

/** `feedDays`-deep weekday feeds ending at `STUB_NOW`, sliced to each fetch's window arg; EBP/NTFS/CAPE always full. */
export function windowedStub(feedDays: number): BackfillDeps {
  const daily = (key: string) => shaped(key, feedDays);
  // Mean-reverting about 0 like NFCI, ~6-week cycle: a trending curve tops every expanding percentile,
  // so measured and prior cuts both read RED and a shifted synth pool goes unseen.
  const weekly = (key: string) =>
    daily(key)
      .filter((x) => new Date(x.date).getUTCDay() === FRED_WEEKLY_OBS_DAY)
      .map((x, k) => ({ date: x.date, value: Math.sin((2 * Math.PI * k) / 6 + phaseOf(key)) }));
  const deepStart = isoDaysBefore(STUB_NOW, Math.max(feedDays, ECY_FEED_DAYS) - 1);
  const [sy, sm, sd] = deepStart.split("-").map(Number) as [number, number, number];
  const first = sy * 12 + sm - 1 + (sd === 1 ? 0 : 1); // first month whose 1st is >= start
  const last = STUB_NOW.getUTCFullYear() * 12 + STUB_NOW.getUTCMonth();
  const monthly = monthlyObs(last - first + 1, Math.floor(first / 12), (first % 12) + 1);
  return {
    fetchFred: async (series, o) =>
      inWindow(
        series === "DFII10"
          ? shaped(series, Math.max(feedDays, ECY_FEED_DAYS))
          : isMonthlyFred(series)
            ? monthly
            : isWeeklyFred(series)
              ? weekly(series)
              : daily(series),
        o.since,
      ),
    fetchEbp: async () => daily("EBP"),
    fetchEcb: async (series, o) => inWindow(daily(series), o?.startPeriod),
    fetchPrices: async (symbol, o) =>
      inWindow(daily(symbol), o.lookbackDays === undefined ? undefined : isoDaysBefore(STUB_NOW, o.lookbackDays)),
    fetchSovereignDaily: async (symbol, from, to) =>
      inWindow(daily(symbol), from, to).map((o) => ({ ...o, value: o.value + sovereignLegOffset(symbol) })),
    fetchCape: async () => monthly,
    fetchNtfs: async () => daily("NTFS"),
  };
}

// years=100 + a fixed `now` pushes the trim cutoff to ~1924 so the 2019 synthetic
// dates all survive — the test exercises orchestration, not the trim boundary.
export const opts = { years: 100, now: STUB_NOW };

// A raw stored row for a given id/date (bypasses scoring) — enough for latestStoredDate.
export async function seedRow(store: InMemoryStore, id: string, date: string): Promise<void> {
  const row: StoredReading = { date, indicatorId: id, value: 100, delta20: 0, rawState: "GREEN", state: "GREEN" };
  // Stamped AT the date's cutoff: a final EOD vintage, never `isProvisional` (A2 would rewrite it).
  await store.recordReadings([row], new Date(Date.parse(`${date}T00:00:00Z`) + INTRADAY_CUTOFF_UTC_MIN * 60_000).toISOString());
}

// ── Item-3 perf hoist: ONE shared virgin full-stub run ────────────────────────────────────────
// Everything the recording deps wrapper captures during the single virgin `backfillAll`.
// `recNtfs` is snapshotted AFTER the run completes, so it is a plain number here.
export interface SharedVirginRun {
  sharedStore: InMemoryStore;
  sharedFirst: Awaited<ReturnType<typeof backfillAll>>;
  recFred: string[]; //        every fetchFred series, in call order
  recPrice: string[]; //       every fetchPrices symbol, in call order
  recNtfs: number; //          fetchNtfs call count
  recSovereignFrom: Map<string, string>; //    sovereign-quote symbol → its resolved `from`
  recSovereignCalls: Map<string, number>; //   sovereign-quote symbol → request count
}

let sharedRun: Promise<SharedVirginRun> | undefined;

export function sharedVirginRun(): Promise<SharedVirginRun> {
  sharedRun ??= (async () => {
    const sharedStore = new InMemoryStore();
    const recFred: string[] = [];
    const recPrice: string[] = [];
    let recNtfs = 0;
    const recSovereignFrom = new Map<string, string>();
    const recSovereignCalls = new Map<string, number>();
    const recStub: BackfillDeps = {
      ...stub,
      fetchFred: async (series, o) => {
        recFred.push(series);
        return stub.fetchFred(series, o as never);
      },
      fetchPrices: async (symbol, o) => {
        recPrice.push(symbol);
        return stub.fetchPrices(symbol, o as never);
      },
      fetchNtfs: async () => {
        recNtfs++;
        return stub.fetchNtfs();
      },
      fetchSovereignDaily: async (symbol, from, to) => {
        recSovereignFrom.set(symbol, from);
        recSovereignCalls.set(symbol, (recSovereignCalls.get(symbol) ?? 0) + 1);
        return stub.fetchSovereignDaily(symbol, from, to);
      },
    };
    const sharedFirst = await backfillAll(sharedStore, recStub, opts);
    return { sharedStore, sharedFirst, recFred, recPrice, recNtfs, recSovereignFrom, recSovereignCalls };
  })();
  return sharedRun;
}
