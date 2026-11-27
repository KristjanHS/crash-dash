/**
 * Exposure-dial episode replay (slice E2, Stage 5) — replays the SAME pure
 * `computeExposure` engine the live path runs (ARM credit key on F1 HY-OAS + FIRE
 * raw-trend key on GT) day-by-day across historical crisis windows, for the /lab
 * "Episode replay" learning view. NOT an optimizer/scoreboard: no verdict, no summary
 * statistic, no threshold change — the constants stay PROVISIONAL (see exposure.ts
 * header); E2 is the by-eye retuning instrument, so tests pin mechanics only.
 *
 * Pure leaf, IO-free: the caller (api/replay.ts, Stage 6) fetches the HY-OAS vintage
 * stitch + ^GSPC/ACWI closes and hands them in oldest→newest; this file never touches
 * the DB, a feed, or the clock. The one rule that carries over unbroken from the live
 * path: replay must call `computeExposure`, never a reimplementation of the rule math.
 */
import {
  ARM_RANGE_WINDOW,
  ARM_ROC_WINDOW,
  computeExposure,
  type Posture,
} from "./exposure.js";
import { GT } from "./registry-composite.js";
import { globalTrendReadingSeries } from "./scorers-price.js";
import type { Observation, Reading } from "./domain-types.js";
import type { SeriesPoint } from "./store.js";

/** One historical crisis window to replay. `candidate` = a deflation-focus episode the
 *  user may drop at eyeball time (marked `[CANDIDATE]` in the picker). */
export interface Episode {
  id: string;
  label: string;
  start: string; // ISO YYYY-MM-DD, inclusive
  end: string; // ISO YYYY-MM-DD, inclusive
  candidate: boolean;
  rationale: string; // one line, web-verified in the E2 spec
}

/** One replayed trading day — the wire element for /api/replay's `points[]`. */
export interface ExposureReplayPoint {
  date: string;
  /** The fire-segment close that day (^GSPC pre-splice, ACWI post-splice), 2dp. */
  price: number;
  armed: boolean; // ARM credit key
  fired: boolean; // FIRE trend key
  posture: Posture | null; // null == degraded input (never a fabricated Core)
  degraded: boolean; // == posture === null
}

/**
 * The episode set (web-verified 2026-07-16; pruned to 6 at the E3 eyeball —
 * Decision 5): core five + `2002` kept, `1998` and `2014` dropped (2014
 * superset by 2015; 1998's short-window ARM added noise, not signal).
 * Ordered chronologically by `start` — the /lab picker renders this order
 * verbatim (Rung C1); the DEFAULT selection is the most recent episode,
 * derived in exposure-view.js `defaultEpisodeId`, never "first chip".
 */
export const EPISODES: readonly Episode[] = [
  {
    id: "2002",
    label: "2002 dot-com credit blowout",
    start: "2002-03-01",
    end: "2002-12-31",
    candidate: false,
    rationale: "Dot-com disinflation credit blowout; HY-OAS peak 11.20 on 2002-10-10, S&P low 10-09.",
  },
  {
    id: "2008",
    label: "2008 GFC",
    start: "2006-10-31",
    end: "2008-11-20",
    candidate: false,
    rationale: "PRECEDENT_WINDOWS GFC window; credit led equities into the Lehman fall.",
  },
  {
    id: "2011",
    label: "2011 EU debt / US downgrade",
    start: "2010-07-26",
    end: "2011-10-04",
    candidate: false,
    rationale: "PRECEDENT_WINDOWS EU sovereign-debt + US-downgrade selloff.",
  },
  {
    id: "2015",
    label: "2015 China deval / Black Monday",
    start: "2015-06-01",
    end: "2016-03-31",
    candidate: false,
    rationale: "CNY deval 2015-08-11, Black Monday 08-24, bottom 2016-02-11 = HY-OAS peak 8.87.",
  },
  {
    id: "2020",
    label: "2020 COVID crash",
    start: "2019-02-19",
    end: "2020-03-20",
    candidate: false,
    rationale: "PRECEDENT_WINDOWS COVID crash; Core to Defensive inside ~3 weeks.",
  },
  {
    id: "2022",
    label: "2022 rate-hike bear",
    start: "2020-11-19",
    end: "2022-12-28",
    candidate: false,
    rationale: "PRECEDENT_WINDOWS rate-hike bear; must make the bond-rung cost visible.",
  },
] as const;

/** Server-authored honesty labels (rendered verbatim by the FE), the `computeReplay`
 *  notes[] idiom. Named so Stage 6 (api/replay.ts) can compose them per episode. */
export const GSPC_PROVENANCE_NOTE =
  "Price before the ACWI splice is ^GSPC (S&P 500); the two series are spliced by their own-MA200 trend reading, never mixed inside one moving average.";
export const FIRE_RAW_SPREAD_NOTE =
  "FIRE reads the raw ACWI/^GSPC MA200 spread (the GT decision variable), matching the value the live GT leg persists - no confirmation-buffer divergence to hide.";

/**
 * The FIRE splice date: the first date ACWI has enough observations for a full-MA200
 * trend reading (~2009-01). Before it the price/trend line is ^GSPC, at/after it ACWI.
 * `null` when ACWI is too short for any reading. Exported so the notes composer can
 * decide whether an episode's window touches the ^GSPC segment.
 */
export function fireSpliceDate(acwi: Observation[]): string | null {
  return globalTrendReadingSeries(GT, acwi)[0]?.date ?? null;
}

/** The honesty notes that apply to one episode (splice date from `fireSpliceDate`). */
export function exposureReplayNotes(episode: Episode, spliceDate: string | null): string[] {
  const notes: string[] = [];
  // ^GSPC provenance is relevant whenever the window opens before ACWI takes over.
  if (spliceDate === null || episode.start < spliceDate) notes.push(GSPC_PROVENANCE_NOTE);
  notes.push(FIRE_RAW_SPREAD_NOTE);
  return notes;
}

const toFirePoint = (r: Reading): SeriesPoint => ({
  date: r.date,
  value: r.level,
  delta20: r.delta20,
  rawState: r.rawState,
  state: r.state,
  decision: r.decision ?? null,
});

/**
 * Per-day FIRE input for `computeExposure`: each price segment scored INDEPENDENTLY via
 * `globalTrendReadingSeries` (its per-day `decision` IS the maSpread `computeFire`
 * consumes), then spliced at the first date ACWI has a full-MA200 reading. Splicing the
 * READING series (not raw closes) guarantees the two price series never mix inside one
 * MA200. No episode straddles the splice (~2009-01; the `2008` window ends 2008-11-20).
 */
export function buildFireSeries(gspc: Observation[], acwi: Observation[]): SeriesPoint[] {
  const gspcReadings = globalTrendReadingSeries(GT, gspc);
  const acwiReadings = globalTrendReadingSeries(GT, acwi);
  const spliceDate = acwiReadings[0]?.date ?? null;
  if (spliceDate === null) return gspcReadings.map(toFirePoint); // ACWI too short → all ^GSPC
  return [
    ...gspcReadings.filter((r) => r.date < spliceDate).map(toFirePoint),
    ...acwiReadings.map(toFirePoint), // acwiReadings[0].date === spliceDate → contiguous, no overlap
  ];
}

/** 2dp round, matching the wire contract's price precision. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Replay `computeExposure` per union trading day D in `window`. For each D, ARM sees the
 * F1 vintage on a BOUNDED trailing slice ending at D (`ARM_RANGE_WINDOW + slack` points; the
 * slack keeps the first `slack` latch-scan steps on full rank windows, deeper steps rank
 * truncated ones) and FIRE sees the fire-segment slice ending at D — O(n·w). Equality with the
 * live full-array call is per fixture, not by construction: pinned by the windowed-vs-full-prefix
 * tests (the single-day latch test pins only slack ≥ ARM_ROC_WINDOW − 4).
 * `price` is the fire-segment close that day (forward-filled on an F1-only union day).
 */
export function replayExposure(
  f1: SeriesPoint[],
  fire: SeriesPoint[],
  window: { start: string; end: string },
): ExposureReplayPoint[] {
  const slack = ARM_ROC_WINDOW;
  const unionDates = [...new Set([...f1, ...fire].map((p) => p.date))]
    .filter((d) => d >= window.start && d <= window.end)
    .sort();

  const points: ExposureReplayPoint[] = [];
  let fi = -1; // latest f1 index with date ≤ D (monotone in ascending D)
  let gi = -1; // latest fire index with date ≤ D
  for (const d of unionDates) {
    while (fi + 1 < f1.length && f1[fi + 1]!.date <= d) fi++;
    while (gi + 1 < fire.length && fire[gi + 1]!.date <= d) gi++;
    if (gi < 0) continue; // no fire close yet → can't price the day

    const f1Slice = f1.slice(Math.max(0, fi - ARM_RANGE_WINDOW + 1 - slack), fi + 1);
    const fireSlice = fire.slice(Math.max(0, gi - ARM_RANGE_WINDOW + 1 - slack), gi + 1);
    const exp = computeExposure(f1Slice, fireSlice);
    points.push({
      date: d,
      price: round2(fire[gi]!.value),
      armed: exp.arm.armed,
      fired: exp.fire.fired,
      posture: exp.posture,
      degraded: exp.posture === null,
    });
  }
  return points;
}
