/**
 * Stage 1.1 — the MEASUREMENT probe
 * behind R1 (F1 / HY OAS onto measured percentile cuts).
 *
 *   npm run probe:f1-cuts               # reads data/ + live FRED, writes scripts/backtest/f1_cuts.json
 *   npm run probe:f1-cuts -- --report   # Stage 5.1: offline, writes scripts/backtest/f1_recall.json
 *
 * Emits the **unconditional** distribution of HY OAS (a) level, (b) 10d velocity,
 * (c) 20d velocity and (d) 30d velocity, at p66 (Amber) and p90 (Red) per §1.3 — over the
 * PRIMARY trailing-5y window plus, as DIAGNOSTICS ONLY, full-expanding and trailing-10y.
 * The 30d column is D-A's re-windowed danger-velocity leg (measured source for the
 * `credit/hyoas_evt_vel_*` calibration rows; inert until the axis opens in Stage 1.2).
 *
 * ⚠ **The 20d velocity column is REPORT-ONLY and explicitly NON-SELECTABLE** (§1.3 / EW-4).
 * The shipped leg is 10d, fixed a priori, regardless of which window's numbers look better.
 * Emitting both is continuity reporting, not a sweep.
 *
 * ⚠ **NO event conditioning.** This script reads no episode dates (§1.1's list is untouched
 * here). Cuts derive from the unconditional distribution; lead time vs episodes is a later
 * report, never a fitting target. Look-ahead bias is the named live trap.
 *
 * ⚠ **"Rolling" is realised at PUBLISH cadence, not per close** (§2 Conflict 1). Each run
 * re-rolls a trailing-5y window and emits a SCALAR; the shipped cut is stale between
 * publications and its window normalises away slow secular deterioration. It is not a
 * daily-rolling cut, and nothing downstream should read it as one.
 *
 * **Splice.** Live keyless FRED serves only ~793 obs from 2023-07-21 (the ~3y clamp binds,
 * EW-1 discharged), so the trailing-5y window cannot be built from the live feed alone. The
 * committed vintage CSV (7382 obs, 1996-12-31 → 2025-04-10) supplies the history and live
 * supplies the post-vintage tail; the sources overlap 2023-07-21 → 2025-04-10 and the vintage
 * WINS on shared dates (cross-source agreement over the overlap is Stage 1.2's job, not this
 * script's).
 *
 * **Determinism.** The spliced blocks move with the live feed, so the committed JSON also
 * carries `vintageOnly` blocks computed from the CSV alone (as-of its last date). Those are
 * the reproducible-to-4dp surface the Stage 1.1 falsifier recomputes.
 *
 * Reuses `quantile` (src/slow.ts) and `velocityDelta` (src/domain-fold.ts) — neither is re-encoded.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadHyOasVintageAsFiled, requireVintage } from "../../src/hyoas-vintage.js";
import { realFeeds } from "../../src/feed-ports.js";
import { quantile } from "../../src/slow.js";
import {
  velocityDelta,
  rawStateSeries,
  confirmedStateSeries,
} from "../../src/domain-fold.js";
import { resolveCuts, type CalibrationCuts } from "../../src/domain-cuts.js";
import {
  CONFIRM_CLOSES,
  VELOCITY_WINDOW,
  type Indicator,
  type State,
} from "../../src/domain-types.js";
import { ALL_INDICATORS } from "../../src/registry.js";
import { loadPublishedVintage } from "./drift-guard.js";
import type { Observation } from "../../src/domain-types.js";
import { medianOrNull } from "../lib/stats.js";
import { isoDay } from "../../src/dates.js";
import { readEnv } from "../../src/config.js";

const OUT_URL = new URL("./f1_cuts.json", import.meta.url);
const RECALL_URL = new URL("./f1_recall.json", import.meta.url);
/** Committed live-feed slice over the vintage overlap — the test's hermetic second source. */
export const OVERLAP_FIXTURE_URL = new URL("./data/hyoas_live_overlap.json", import.meta.url);
const SERIES = "BAMLH0A0HYM2";

/** §1.3 (EW-2): Amber = p66, Red = p90 — applied to BOTH the level and velocity legs. */
export const AMBER_P = 0.66;
export const RED_P = 0.9;
/** §1.3 (EW-4): the SHIPPED velocity lookback. 20 is report-only. */
export const VELOCITY_LOOKBACK = 10;
/** Report-only continuity column — never selectable as the shipped leg. */
export const REPORT_ONLY_LOOKBACK = 20;
/**
 * D-A: the re-windowed
 * danger-velocity lookback. F1's velocity leg moves 10d→30d; these p66/p90 become the MEASURED
 * `credit/hyoas_evt_vel_*` cuts. Emitted here inert — nothing resolves them until Stage 1.2
 * opens `legs.velocity` for F1.
 */
export const VELOCITY_30D_LOOKBACK = 30;

export interface CutPair {
  /** Distribution size the quantiles were taken over. */
  n: number;
  /** p66 — Amber, in percentage points (the unit F1's registry cuts use). */
  p66: number;
  /** p90 — Red, in percentage points. */
  p90: number;
  /** p66 in basis points (= p66 × 100), for the §2 tripwire read. */
  p66_bps: number;
  /** p90 in basis points. */
  p90_bps: number;
}

export interface WindowBlock {
  window: string;
  start: string;
  end: string;
  level: CutPair;
  /** 10d velocity — the SHIPPED lookback (EW-4). */
  velocity10d: CutPair;
  /** 20d velocity — REPORT-ONLY, explicitly non-selectable (§1.3). */
  velocity20d_reportOnly: CutPair;
  /** 30d velocity — D-A's re-windowed danger-velocity leg; MEASURED source for `hyoas_evt_vel_*`. */
  velocity30d: CutPair;
}

/** ISO date `years` before `iso`, clamped by Date's own month/day normalisation. */
export function minusYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return isoDay(new Date(Date.UTC(y - years, m - 1, d)));
}

function pair(values: number[]): CutPair {
  const sorted = [...values].sort((a, b) => a - b);
  const p66 = quantile(sorted, AMBER_P);
  const p90 = quantile(sorted, RED_P);
  return {
    n: sorted.length,
    p66: round4(p66),
    p90: round4(p90),
    p66_bps: round4(p66 * 100),
    p90_bps: round4(p90 * 100),
  };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * Velocity observations dated by their LATER endpoint. `velocityDelta` returns an array whose
 * index `k` is observation `k + window` (see its docblock) — this is the alignment that trap
 * §2 Conflict 2 names; it is applied once, here, rather than assumed.
 */
export function velocityObservations(obs: Observation[], window: number): Observation[] {
  const deltas = velocityDelta(obs.map((o) => o.value), window);
  return deltas.map((value, k) => ({ date: obs[k + window]!.date, value }));
}

function slice(obs: Observation[], start: string, end: string): Observation[] {
  return obs.filter((o) => o.date >= start && o.date <= end);
}

/**
 * One window block. Velocity is computed over the FULL series and then sliced by date, so the
 * window's first `window` days are not silently dropped from the velocity distribution.
 */
export function windowBlock(
  label: string,
  all: Observation[],
  start: string,
  end: string,
): WindowBlock {
  const lvl = slice(all, start, end);
  if (lvl.length === 0) throw new Error(`window ${label}: empty slice ${start}..${end}`);
  const v10 = slice(velocityObservations(all, VELOCITY_LOOKBACK), start, end);
  const v20 = slice(velocityObservations(all, REPORT_ONLY_LOOKBACK), start, end);
  const v30 = slice(velocityObservations(all, VELOCITY_30D_LOOKBACK), start, end);
  return {
    window: label,
    start: lvl[0]!.date,
    end: lvl[lvl.length - 1]!.date,
    level: pair(lvl.map((o) => o.value)),
    velocity10d: pair(v10.map((o) => o.value)),
    velocity20d_reportOnly: pair(v20.map((o) => o.value)),
    velocity30d: pair(v30.map((o) => o.value)),
  };
}

/** The three windows of §4 Stage 1.1: trailing-5y (PRIMARY) + two diagnostics. */
export function allWindows(all: Observation[], asOf: string): {
  trailing5y: WindowBlock;
  diagnostics: { fullExpanding: WindowBlock; trailing10y: WindowBlock };
} {
  return {
    trailing5y: windowBlock("trailing-5y", all, minusYears(asOf, 5), asOf),
    diagnostics: {
      fullExpanding: windowBlock("full-expanding", all, all[0]!.date, asOf),
      trailing10y: windowBlock("trailing-10y", all, minusYears(asOf, 10), asOf),
    },
  };
}

/**
 * EW-7 input: what p66/p90 imply as of each reference date, each evaluated against THAT date's
 * own trailing-5y window (never today's). 2015/2019 are point-in-time reads, not backtests.
 */
export function asOfLadder(all: Observation[], asOfDates: string[]): WindowBlock[] {
  return asOfDates.map((d) => {
    const b = windowBlock(`trailing-5y @ ${d}`, all, minusYears(d, 5), d);
    return b;
  });
}

/**
 * Stage 1.2 — cross-source agreement tolerance, in PERCENTAGE POINTS.
 *
 * HY OAS is published to 2dp in percent, i.e. 1bp resolution, so two faithful copies of the
 * same series should agree EXACTLY. Measured 2026-07-20 over all 451 shared dates: max abs
 * diff = 0.0000. The 0.02pp (2bp) tolerance is therefore pure headroom for a rounding or
 * last-digit convention difference between the Internet-Archive capture the vintage came from
 * and today's feed — it is NOT sized to absorb a restatement. **It catches any revision of 3bps
 * or more on any shared date**, which is well below the magnitude of a real ICE methodology
 * restatement (tens of bps). Tightening it to 0 would still pass today; the headroom exists so
 * a benign last-digit wobble does not page, not to hide a revision.
 */
export const OVERLAP_TOLERANCE_PP = 0.02;

/** Vintage end date — the fixed hinge the §2 expiry is measured against. */
export const VINTAGE_END = "2025-04-10";
/** The live keyless FRED window (~3y rolling clamp, EW-1). */
export const LIVE_CLAMP_YEARS = 3;

export interface OverlapReport {
  /** Shared dates compared. */
  matched: number;
  /** Live dates inside the vintage's span that the vintage does NOT carry (should be 0). */
  liveOnly: string[];
  maxAbsDiff: number;
  maxAbsDiffDate: string | null;
  /** Dates whose disagreement exceeds OVERLAP_TOLERANCE_PP. */
  breaches: { date: string; vintage: number; other: number }[];
}

/**
 * Compare the vintage against ANOTHER source of the same series on their shared dates. Used
 * twice with two different second sources — the LIVE feed (in `main`, at probe cadence, where
 * it fails loud) and the committed overlap fixture (in the test, hermetically). Single
 * definition so the tolerance cannot drift between the two call sites.
 */
export function compareOverlap(vintage: Observation[], other: Observation[]): OverlapReport {
  const vm = new Map(vintage.map((o) => [o.date, o.value]));
  const end = vintage[vintage.length - 1]!.date;
  const start = vintage[0]!.date;
  const inSpan = other.filter((o) => o.date >= start && o.date <= end);
  const report: OverlapReport = { matched: 0, liveOnly: [], maxAbsDiff: 0, maxAbsDiffDate: null, breaches: [] };
  for (const o of inSpan) {
    const v = vm.get(o.date);
    if (v === undefined) {
      report.liveOnly.push(o.date);
      continue;
    }
    report.matched++;
    const diff = Math.abs(o.value - v);
    if (diff > report.maxAbsDiff) {
      report.maxAbsDiff = diff;
      report.maxAbsDiffDate = o.date;
    }
    if (diff > OVERLAP_TOLERANCE_PP) report.breaches.push({ date: o.date, vintage: v, other: o.value });
  }
  return report;
}

/** Vintage ∪ live, vintage winning on shared dates, ascending. */
export function splice(vintage: Observation[], live: Observation[]): Observation[] {
  const last = vintage[vintage.length - 1]!.date;
  const tail = live.filter((o) => o.date > last);
  return [...vintage, ...tail].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Stage 5.1 — recall and lead-time REPORT (a result, never a fitting target)
// ---------------------------------------------------------------------------

/**
 * §1.1's PRE-REGISTERED drawdown episode list. Written before any measurement ran and
 * **frozen**: it may not be extended, trimmed or reweighted after seeing results. Peak/trough
 * are reference dates for the lead-time REPORT only — no episode date reaches the
 * cut-selection path (§5 do-not-break checklist).
 */
export const EPISODES: ReadonlyArray<{ id: string; name: string; peak: string; trough: string }> = [
  { id: "E1", name: "Russia / LTCM", peak: "1998-07-17", trough: "1998-08-31" },
  { id: "E2", name: "Dot-com bust", peak: "2000-03-24", trough: "2002-10-09" },
  { id: "E3", name: "Global financial crisis", peak: "2007-10-09", trough: "2009-03-09" },
  { id: "E4", name: "Euro crisis / US downgrade", peak: "2011-04-29", trough: "2011-10-03" },
  { id: "E5", name: "China deval / oil-and-credit bust", peak: "2015-05-21", trough: "2016-02-11" },
  { id: "E6", name: "Q4-2018 tightening", peak: "2018-09-20", trough: "2018-12-24" },
  { id: "E7", name: "COVID", peak: "2020-02-19", trough: "2020-03-23" },
  { id: "E8", name: "2022 inflation / rates", peak: "2022-01-03", trough: "2022-10-12" },
];

/** §1.2: the signalling window opens 63 trading days before the peak. */
export const LEAD_WINDOW_TRADING_DAYS = 63;
/** §1.2 / EW-6: ≥50% of the 8 named episodes ⇒ ≥4. */
export const RECALL_FLOOR = Math.ceil(EPISODES.length / 2);

export interface EpisodeResult {
  id: string;
  name: string;
  peak: string;
  trough: string;
  /** First scored close at/after the peak — the lead-time origin. */
  peakClose: string;
  /** First close of the signalling window, `peak − 63` trading days. */
  windowStart: string;
  detected: boolean;
  /** First close inside the window whose CONFIRMED state is Amber or worse. */
  detectedAt: string | null;
  /** Trading days from `detectedAt` to `peakClose`. Positive = early warning. */
  leadTradingDays: number | null;
  /**
   * `detectedAt === windowStart`, i.e. F1 was ALREADY firing when the signalling window
   * opened. Such a "detection" carries no information about the episode — the lead time is
   * pinned at the window cap by construction and would be larger if the window were wider.
   * Reported so a high recall cannot be read as a high-quality result (see `baseRateAmberOrWorse`).
   */
  alreadyFiringAtWindowOpen: boolean;
}

/**
 * Replay F1's SHIPPED scoring over a history and return the per-close **confirmed** state.
 *
 * Scoring path: `rawStateSeries` (F1's registry thresholds OR'd with the published measured cuts,
 * at F1's own `velocityWindow`) followed by `confirmedStateSeries` at `CONFIRM_CLOSES = 2`.
 *
 * ⚠ **The SYMMETRIC 2-close buffer is this harness's own, NOT the live indicator fold.** Since
 * 2026-08-26 the indicator tier folds DIRECTIONALLY (instant-up, 2-close stand-down —
 * `CONFIRM_TIERS`, `FOLD_BY_SITE.indicator` in `src/domain-fold.ts`); this harness is the
 * `backtestHarness` entry of that same table, at the
 * old symmetric buffer. Direction of the resulting bias: a symmetric 2-close fold adopts a WORSE state only after it
 * has held for two closes, so every detection here lands up to 2 trading days LATER than the live
 * board would have produced it, and each reported lead time is **pessimistic by up to 2 days**.
 * (Raw crossings would bias the other way — optimistically, which §5's checklist forbids; this
 * harness sits on the conservative side of that.) Retuning the buffer moves every measured lead
 * time, so it is a deliberate choice to revisit, not an incidental constant.
 *
 * ⚠ The proxy z-leg is NOT exercised: it is defined against the borrowed `baa10y` reference
 * and `run.ts` threads its series at runtime, which this offline replay does not reconstruct.
 * Every reported recall/lead figure is therefore a **lower bound** on the shipped scorer.
 */
export function replayConfirmed(
  indicator: Indicator,
  obs: Observation[],
  calib: CalibrationCuts,
): { date: string; state: State }[] {
  const raw = rawStateSeries(indicator, obs, calib);
  const confirmed = confirmedStateSeries(raw, CONFIRM_CLOSES);
  return confirmed.map((state, k) => ({ date: obs[k + VELOCITY_WINDOW]!.date, state }));
}

/** §1.2: detected ⇔ confirmed state reaches Amber or worse inside `[peak − 63, trough]`. */
export function scoreEpisodes(
  series: { date: string; state: State }[],
  episodes: ReadonlyArray<{ id: string; name: string; peak: string; trough: string }> = EPISODES,
): EpisodeResult[] {
  return episodes.map((e) => {
    const peakIdx = series.findIndex((s) => s.date >= e.peak);
    if (peakIdx < 0) throw new Error(`episode ${e.id}: peak ${e.peak} is past the scored history`);
    const startIdx = Math.max(0, peakIdx - LEAD_WINDOW_TRADING_DAYS);
    let troughIdx = -1;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i]!.date <= e.trough) {
        troughIdx = i;
        break;
      }
    }
    if (troughIdx < peakIdx) throw new Error(`episode ${e.id}: trough ${e.trough} precedes its peak close`);
    let hitIdx = -1;
    for (let i = startIdx; i <= troughIdx; i++) {
      if (series[i]!.state !== "GREEN") {
        hitIdx = i;
        break;
      }
    }
    return {
      id: e.id,
      name: e.name,
      peak: e.peak,
      trough: e.trough,
      peakClose: series[peakIdx]!.date,
      windowStart: series[startIdx]!.date,
      detected: hitIdx >= 0,
      detectedAt: hitIdx >= 0 ? series[hitIdx]!.date : null,
      leadTradingDays: hitIdx >= 0 ? peakIdx - hitIdx : null,
      alreadyFiringAtWindowOpen: hitIdx === startIdx,
    };
  });
}

export interface RecallReport {
  confirmCloses: number;
  leadWindowTradingDays: number;
  scored: { n: number; start: string; end: string };
  /**
   * Fraction of ALL scored closes at Amber-or-worse. The interpretive control on recall: a
   * cut that is Amber most of the time detects every episode trivially, so recall is only
   * informative read against this base rate. Reported, never tuned against.
   */
  baseRateAmberOrWorse: number;
  episodes: EpisodeResult[];
  detected: number;
  total: number;
  recall: number;
  recallFloor: number;
  clearsFloor: boolean;
  medianLeadTradingDays: number | null;
  /** How many of the `detected` episodes were already firing when the window opened. */
  detectionsAtWindowOpen: number;
}

export function recallReport(
  indicator: Indicator,
  obs: Observation[],
  calib: CalibrationCuts,
): RecallReport {
  const series = replayConfirmed(indicator, obs, calib);
  const episodes = scoreEpisodes(series);
  const detected = episodes.filter((e) => e.detected).length;
  const fired = series.filter((s) => s.state !== "GREEN").length;
  return {
    confirmCloses: CONFIRM_CLOSES,
    leadWindowTradingDays: LEAD_WINDOW_TRADING_DAYS,
    scored: { n: series.length, start: series[0]!.date, end: series[series.length - 1]!.date },
    baseRateAmberOrWorse: round4(fired / series.length),
    episodes,
    detected,
    total: episodes.length,
    recall: round4(detected / episodes.length),
    recallFloor: RECALL_FLOOR,
    clearsFloor: detected >= RECALL_FLOOR,
    medianLeadTradingDays: medianOrNull(
      episodes.flatMap((e) => (e.leadTradingDays === null ? [] : [e.leadTradingDays])),
    ),
    detectionsAtWindowOpen: episodes.filter((e) => e.alreadyFiringAtWindowOpen).length,
  };
}

/** F1's registry entry — the indicator the report replays. */
export function f1Indicator(): Indicator {
  const f1 = ALL_INDICATORS.find((i) => i.id === "F1");
  if (!f1) throw new Error("F1 missing from ALL_INDICATORS");
  return f1;
}

/** F1's SHIPPED cuts, resolved through the production resolver off the published vintage. */
export function f1ShippedCuts(): CalibrationCuts {
  return resolveCuts("F1", loadPublishedVintage(), f1Indicator().direction ?? "HIGH");
}

/**
 * `npm run probe:f1-cuts -- --report` — writes `f1_recall.json`.
 *
 * Deliberately **vintage-only** (no live tail): every §1.1 episode ends by 2022-10-12, well
 * inside the vintage, so splicing the moving live tail would only make a committed report
 * irreproducible. The CUT still comes from the shipped published vintage, which was measured
 * over the spliced series.
 */
function reportMain(): void {
  const vintage = requireVintage(loadHyOasVintageAsFiled());
  const cuts = f1ShippedCuts();
  const report = recallReport(f1Indicator(), vintage, cuts);
  const out = {
    generated: isoDay(new Date()),
    stage: "5.1",
    series: SERIES,
    source: { file: "data/BAMLH0A0HYM2-vintage.csv", n: vintage.length },
    note:
      "RESULT, never a fitting target (EW-6). " +
      "The episode list is pre-registered in §1.1 " +
      "and frozen; no window, percentile or lookback was swept. The proxy z-leg is not replayed " +
      "offline, so recall and leads are LOWER bounds.",
    shippedCuts: cuts,
    ...report,
  };
  writeFileSync(RECALL_URL, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nrecall: ${report.detected}/${report.total} (floor ${report.recallFloor}) — ${report.clearsFloor ? "CLEARS" : "BELOW"} EW-6`);
  console.log(`base rate Amber+ over ${report.scored.n} closes: ${(report.baseRateAmberOrWorse * 100).toFixed(1)}%`);
  for (const e of report.episodes) {
    console.log(
      `  ${e.id} ${e.name.padEnd(34)} ${e.detected ? `detected ${e.detectedAt} lead ${e.leadTradingDays}d${e.alreadyFiringAtWindowOpen ? " (already firing at window open — uninformative)" : ""}` : "NOT DETECTED"}`,
    );
  }
  console.log(`median lead: ${report.medianLeadTradingDays}d`);
  console.log(`wrote ${RECALL_URL.pathname}`);
}

async function main(): Promise<void> {
  const env = readEnv();
  if (process.argv.includes("--report")) {
    reportMain();
    return;
  }
  const vintage = requireVintage(loadHyOasVintageAsFiled());
  const vintageEnd = vintage[vintage.length - 1]!.date;
  console.log(`vintage: ${vintage.length} obs, ${vintage[0]!.date} → ${vintageEnd}`);

  const live = await realFeeds.fetchSeries(SERIES, { fullHistory: true, now: new Date(), env });
  if (live.length === 0) throw new Error(`live FRED ${SERIES} returned 0 obs — cannot splice`);
  console.log(`live:    ${live.length} obs, ${live[0]!.date} → ${live[live.length - 1]!.date}`);

  // Stage 1.2, LIVE half: at probe cadence the two sources are compared for real. A FRED
  // revision surfaces HERE, loudly, on the next publish run — the committed test's fixture
  // half (below) cannot see a revision until the fixture is recaptured, so this throw is the
  // continuously-live detector and the test is the regression pin.
  const overlap = compareOverlap(vintage, live);
  console.log(
    `overlap: ${overlap.matched} shared dates, maxAbsDiff=${overlap.maxAbsDiff.toFixed(4)}pp` +
      `${overlap.maxAbsDiffDate ? ` @ ${overlap.maxAbsDiffDate}` : ""}, liveOnly=${overlap.liveOnly.length}`,
  );
  if (overlap.breaches.length > 0) {
    throw new Error(
      `live FRED disagrees with the vintage beyond ${OVERLAP_TOLERANCE_PP}pp on ` +
        `${overlap.breaches.length} date(s) — FRED revised ${SERIES} or the vintage is corrupt. ` +
        `First: ${JSON.stringify(overlap.breaches[0])}`,
    );
  }
  // `npm run probe:f1-cuts -- --capture-overlap` refreshes the committed fixture the test
  // reads. Deliberately NOT written on every run: an auto-healing fixture would go green
  // through the very revision it exists to catch.
  if (process.argv.includes("--capture-overlap")) {
    const slice = live.filter((o) => o.date <= vintageEnd);
    writeFileSync(OVERLAP_FIXTURE_URL, `${JSON.stringify({ series: SERIES, captured: isoDay(new Date()), source: "live keyless FRED", n: slice.length, observations: slice }, null, 2)}\n`);
    console.log(`captured overlap fixture: ${slice.length} obs`);
  }

  const all = splice(vintage, live);
  const asOf = all[all.length - 1]!.date;
  const overlapDays = live.filter((o) => o.date <= vintageEnd).length;
  console.log(`spliced: ${all.length} obs → ${asOf} (overlap ${overlapDays} live days, vintage wins)`);

  const spliced = allWindows(all, asOf);
  const vintageOnly = allWindows(vintage, vintageEnd);

  const out = {
    generated: isoDay(new Date()),
    series: SERIES,
    units: "percentage points (bps = ×100)",
    percentiles: { amber: AMBER_P, red: RED_P },
    velocity: {
      shippedLookbackDays: VELOCITY_LOOKBACK,
      reportOnlyLookbackDays: REPORT_ONLY_LOOKBACK,
      note:
        "20d is emitted for reporting continuity only and is NOT selectable " +
        "(EW-4).",
    },
    method:
      "Unconditional distribution; trailing-5y re-rolled at PUBLISH cadence, NOT per close. " +
      "No event conditioning.",
    sources: {
      vintage: { file: "data/BAMLH0A0HYM2-vintage.csv", n: vintage.length, start: vintage[0]!.date, end: vintageEnd },
      live: { n: live.length, start: live[0]!.date, end: live[live.length - 1]!.date },
      spliceRule: "vintage wins on shared dates; live supplies dates > vintage end",
      overlapLiveDays: overlapDays,
      overlapAgreement: {
        tolerancePp: OVERLAP_TOLERANCE_PP,
        matched: overlap.matched,
        maxAbsDiffPp: round4(overlap.maxAbsDiff),
        maxAbsDiffDate: overlap.maxAbsDiffDate,
        breaches: overlap.breaches.length,
      },
    },
    spliced: {
      asOf,
      n: all.length,
      primary: spliced.trailing5y,
      diagnostics: spliced.diagnostics,
      // EW-7: p66/p90 in bps today / 2015 / 2019, each vs its own trailing-5y window.
      asOfLadder: asOfLadder(all, [asOf, "2015-12-31", "2019-12-31"]),
    },
    // Deterministic, live-feed-independent surface — what the Stage 1.1 falsifier recomputes.
    vintageOnly: {
      asOf: vintageEnd,
      n: vintage.length,
      primary: vintageOnly.trailing5y,
      diagnostics: vintageOnly.diagnostics,
      asOfLadder: asOfLadder(vintage, [vintageEnd, "2015-12-31", "2019-12-31"]),
    },
  };

  writeFileSync(OUT_URL, `${JSON.stringify(out, null, 2)}\n`);

  const p = spliced.trailing5y;
  console.log(`\ntrailing-5y (${p.start} → ${p.end})`);
  console.log(`  level      p66=${p.level.p66_bps}bps  p90=${p.level.p90_bps}bps`);
  console.log(`  velocity10 p66=${p.velocity10d.p66_bps}bps p90=${p.velocity10d.p90_bps}bps`);
  console.log(`  velocity20 (report-only) p66=${p.velocity20d_reportOnly.p66_bps}bps p90=${p.velocity20d_reportOnly.p90_bps}bps`);
  console.log(`  velocity30 (D-A danger leg) p66=${p.velocity30d.p66}pp p90=${p.velocity30d.p90}pp`);
  // §2 tripwires (i) and (ii) — reported, never auto-actioned.
  if (p.level.p66 >= 4.5) console.log(`  ⚠ TRIPWIRE (i): measured Amber ${p.level.p66} ≥ registry 4.5`);
  if (p.level.p66 >= p.level.p90) console.log(`  ⚠ TRIPWIRE (ii): Amber ≥ Red (non-monotone)`);
  console.log(`\nwrote ${OUT_URL.pathname}`);
}

// Run only when invoked as a script — the test imports the pure helpers above and must not
// trigger a live FRED fetch or a write to the committed JSON.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
