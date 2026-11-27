import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { R6_MOVE_LOOKBACK_DAYS, R7_LEG_IDS, scoreWithCuts, scoreWithCutsSeries, scoreWithCutsSeriesPerDay } from "./confirmers.js";
import { POINT_BAND_CUTS_OF } from "./family-descriptor-rows.js";
import { synthCutSeries, priorThresholds, SYNTH_VEL_WINDOW } from "./synth-cuts.js";
import { CG } from "./registry-composite.js";
import { INDICATORS } from "./registry-fred.js";
import { VELOCITY_WINDOW, type Observation, type Reading } from "./domain-types.js";
import { CG_DESCRIPTOR, R6_DESCRIPTOR, SMOOTHED_LEVEL_OF } from "./family-descriptor-rows.js";
import {
  latestRatioSpread,
  levelBandHead,
  moveLegBase,
  moveScoreRows,
  ratioSpreadPoints,
  ratioSpreadReadingSeriesFromValues,
  scoreRatioSpread,
} from "./scorers-composite.js";
import { CONFIRM_CLOSES } from "./domain-types.js";
import { withNewest } from "./scorers-core.js";
import { needRowsForCalendarDays } from "./series-db-first.js";

// R6's rolling-detrended level band is only as honest as the history it ranks against, and its
// cron fetch is the ONLY thing that sizes that base. Shipped 2026-08-30 as
// `{ lookbackDays: 1500 }` with NO `deep` — and `lookbackDays` is deep-only, so the ask was
// dropped for `range=2y` (497 obs) and the band ranked a 2-year calm window: the p75 amber cut sat
// at dev -0.0262 instead of -0.0024 and 2026-08-28 painted AMBER at MOVE 70.97, BELOW its own 200d
// trend. `prices.ts` now throws on that pairing; this pins the R6 half — the ask must be deep AND
// deep enough to clear the band's head.
describe("R6's cron fetch supplies the level band's history", () => {
  // Source-level for the same reason CG's twin is (src/cg-level-leg.test.ts): the confirmer's fetch
  // options are not observable from a pure call. Comments stripped FIRST — the R6 entry's docblock
  // names `deep: true`, so an unstripped grep would pass on the prose and could never fail.
  const R6_ENTRY = readFileSync(new URL("./confirmers.ts", import.meta.url), "utf8")
    .split('id: "R6"')[1]!
    .split('id: "R7"')[0]!
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join(" ")
    .replace(/\s+/g, " ");
  // The ask is the named constant, not a literal (`indicator-loop.md` §A retune is a ONE-place edit): the source pin
  // asserts the deep-arm fetch names it, and the depth test below derives from the constant itself.
  const asked = R6_MOVE_LOOKBACK_DAYS;

  test("^MOVE is fetched deep, with the named lookback, on the DB-first deep arm", () => {
    // Vacuity floor: the slice really is the R6 confirmer's CODE, not just its comments.
    expect(R6_ENTRY).toContain("latestMove(R6");
    expect(R6_ENTRY).toContain('fetchDeep: () => fetchDailyCloses("^MOVE", { deep: true, lookbackDays: R6_MOVE_LOOKBACK_DAYS, now: () => Date.parse(ctx.runAt), env: ctx.env })');
    expect(R6_ENTRY).not.toMatch(/lookbackDays:\s*\d/); // no restated literal anywhere in the entry
  });

  test("the lookback clears the scorer's warm-up with room to score, and the DB-first shallow cap a tail-exact recompute", () => {
    // Calendar days → trading days at the NYSE's ~252/365, then the floor `scoreMoveLevel` needs before
    // it emits its first reading — `moveLegBase()` (255, the VELOCITY leg). Since R6's percentile level
    // leg was deleted (2026-09-02) that leg is the ONLY warm-up left. Derived from the scorer, never restated.
    const tradingDays = asked * (252 / 365);
    const head = moveLegBase() + CONFIRM_CLOSES;
    expect(head).toBeGreaterThan(0); // the head is real, not a NaN passing >= vacuously
    expect(tradingDays).toBeGreaterThan(head * 2); // a year-plus of scored days past warm-up
    // Tail-exact = the deepest live leg's full history. R6 has carried NO percentile level band since
    // 2026-09-02, so the VELOCITY leg is the only term — and the descriptor must stay band-less for
    // `moveScoreRows()` to be complete, which the band-less assertion is here to catch.
    expect("levelBand" in R6_DESCRIPTOR).toBe(false);
    expect(needRowsForCalendarDays(asked)).toBeGreaterThanOrEqual(moveScoreRows());
  });
});

// `scoreWithCutsSeries` is what a DB-first site persists ANOTHER registry id's history through
// (R7 over R1/R2/R3), so its last element must be the reading `scoreWithCuts` — the core loop's
// scalar — emits for the same inputs; otherwise the seam's rows and the loop's rows disagree by day.
describe("scoreWithCutsSeries ≡ scoreWithCuts on the latest day (DB-first stage 4.2)", () => {
  const ramp = (n: number, from: number, to: number): Observation[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      value: from + ((to - from) * i) / (n - 1),
    }));
  const key = (r: Reading) => ({ d: r.date, l: r.level, s: r.state, r: r.rawState, v: r.delta20 });
  // Generic (R1/R3/R2), geo-hybrid (OVX → oil branch) and smoothed-level (R8) — all three branches.
  test.each([...R7_LEG_IDS, "OVX", "R8"])("%s: series tail equals the scalar (state, rawState, level, delta20, date)", (id) => {
    const ind = INDICATORS.find((i) => i.id === id)!;
    const obs = ramp(400, 3.5, -0.8);
    const series = scoreWithCutsSeries(ind, obs, []);
    expect(series.length).toBeGreaterThan(1);
    expect(key(series.at(-1)!)).toEqual(key(scoreWithCuts(ind, obs, [])));
  });
  // The property the seam relies on: the loop scores a BOUNDED window, the seam the FULL stored series,
  // and the day's row must agree — a leg whose state depended on the pool depth could not go DB-first.
  test.each(R7_LEG_IDS)("%s: the scalar over a bounded window equals the series tail over the full history", (id) => {
    const ind = INDICATORS.find((i) => i.id === id)!;
    const full = ramp(400, 3.5, -0.8);
    // The bound must clear the widest window the id's scorer reads: the velocity window, or — for a
    // `SMOOTHED_LEVEL_OF` carrier (R1: 21/63) — its RED mean. Derived from the descriptor, never restated.
    const smoothed = SMOOTHED_LEVEL_OF[id];
    const widest = Math.max(VELOCITY_WINDOW, smoothed?.redWindow ?? smoothed?.window ?? 0);
    const bounded = full.slice(-(widest + CONFIRM_CLOSES + 40));
    expect(key(scoreWithCutsSeries(ind, full, []).at(-1)!)).toEqual(key(scoreWithCuts(ind, bounded, [])));
  });
});

// RESTATE twin (a retired plan rung 1): a synthPriors id's
// restated row i must carry THAT day's expanding cut, not today's — else `readings.band_cuts` flattens
// the drawn line and the parity probe's per-date arm fails on every historical row (prod, 2026-09-02).
describe("scoreWithCutsSeriesPerDay stamps each day with its own expanding cut (F3)", () => {
  const F3 = INDICATORS.find((i) => i.id === "F3")!;
  const obs: Observation[] = Array.from({ length: 320 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value: Math.sin(i / 7) * 0.4 - 0.3 + (i % 5) * 0.01,
  }));
  const amberKey = POINT_BAND_CUTS_OF.F3!.find((b) => b.level === "amber")!.key;
  test("row i's stamped level cut equals synthCutSeries at i, and the stamp is NOT constant", () => {
    const perDay = scoreWithCutsSeriesPerDay(F3, obs, []);
    expect(perDay.length).toBe(obs.length - (obs.length - scoreWithCutsSeries(F3, obs, []).length));
    // The history the cron sees is the STORED readings — from the first emitted date, not the feed's head.
    const emitted = obs.filter((o) => o.date >= perDay[0]!.date);
    expect(emitted.length).toBeLessThan(obs.length); // premise: the scorer has a warm-up to burn
    const expected = synthCutSeries(emitted.map((o) => o.value), priorThresholds(F3), F3.velocityWindow ?? SYNTH_VEL_WINDOW);
    const byDate = new Map(perDay.map((r) => [r.date, r]));
    const stamped = emitted
      .map((o, i) => ({ got: byDate.get(o.date)?.bandCuts?.[amberKey], want: expected.levelAmber?.[i] }))
      .filter((x) => x.want !== undefined && Number.isFinite(x.want));
    expect(stamped.length).toBeGreaterThan(20);
    for (const x of stamped) expect(x.got).toBeCloseTo(x.want!, 12);
    expect(new Set(stamped.map((x) => x.got)).size).toBeGreaterThan(1);
  });
  // Pins the tail re-score: red if the sync `run` drops below `confirmClosesFor`, `lookback` below the 3× twin's
  // velocity window, or the tail stops doubling (each spike's alternating tail holds the fold past the base tail).
  test.each([
    ["F3", F3],
    ["F3 at a 3× velocity window", { ...F3, velocityWindow: 3 * VELOCITY_WINDOW }],
  ])("%s: sampled rows + the last spike cycle equal the whole-prefix re-score", (_, ind) => {
    const CYCLE = 25; // spike period
    let seed = 7;
    const noise = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5;
    const noisy = obs.map((o, i) => {
      const v = Math.sin(i / 11) * 0.3 + noise() * 0.6;
      return { date: o.date, value: i % CYCLE === 0 ? 1.2 : i % CYCLE < 9 ? (i % 2 ? -0.6 : 0.4) : v };
    });
    const perDay = scoreWithCutsSeriesPerDay(ind, noisy, []);
    const pool = (i: number) => noisy.slice(0, i + 1).filter((p) => p.date >= perDay[0]!.date).map((p) => p.value);
    const want = (i: number) => scoreWithCutsSeries(ind, noisy.slice(0, i + 1), [], undefined, new Map([["F3", pool(i)]])).at(-1);
    expect(perDay.filter((r) => r.state !== r.rawState).length).toBeGreaterThan(5); // fold memory is live
    const head = noisy.findIndex((o) => o.date === perDay[0]!.date);
    expect([want(head - 1), perDay.length]).toEqual([undefined, noisy.length - head]); // warm-up edge + one row per day after it
    // 8 rows at stride 13 (coprime with CYCLE) + the last full spike cycle: each of the 3 mutations above reds ≥ 4 rows.
    const idx = [head, head + 1, ...Array.from({ length: 8 }, (_, k) => head + 2 + 13 * k), ...Array.from({ length: CYCLE }, (_, k) => noisy.length - CYCLE + k)];
    for (const i of new Set(idx.filter((i) => i < noisy.length))) expect(perDay[i - head], `row ${i}`).toEqual(want(i));
  });
});

// CG's DB-first site (stage 4.2) re-scores its STORED ratio through the identity-denominator seam
// (`ratioSpreadReadingSeriesFromValues`) rather than the two live legs, then picks the latest via
// `latestRatioSpread`. That path must agree with the pre-4.2 scalar `scoreRatioSpread(CG, legs)` on the
// same input — otherwise the cron reading and a two-leg re-score disagree by day (§0.3).
describe("CG stored-ratio re-score ≡ two-leg scoreRatioSpread on the latest day (DB-first stage 4.2)", () => {
  const key = (r: Reading) => ({ d: r.date, l: r.level, s: r.state, r: r.rawState, v: r.delta20 });
  test("the identity-denominator re-score of the stored ratio equals the two-leg scalar", () => {
    // Two synthetic legs long enough to clear CG's level-band head, with a real ratio shape (not a flat 1).
    const n = levelBandHead(CG_DESCRIPTOR.levelBand) + CONFIRM_CLOSES + 30;
    const date = (i: number) => new Date(Date.UTC(2013, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const hg = Array.from({ length: n }, (_, i) => ({ date: date(i), value: 3 + 0.4 * Math.sin(i / 23) - i / (n * 6) }));
    const gc = Array.from({ length: n }, (_, i) => ({ date: date(i), value: 1800 + 6 * i }));
    const points = ratioSpreadPoints(CG_DESCRIPTOR, hg, gc); // the stored `readings.value` unit
    const series = ratioSpreadReadingSeriesFromValues(CG, CG_DESCRIPTOR, points);
    expect(series.length).toBeGreaterThan(1); // vacuity: the head cleared and the seam emitted a real series
    const viaStored = latestRatioSpread(CG, CG_DESCRIPTOR, series, points.length);
    expect(key(viaStored)).toEqual(key(scoreRatioSpread(CG, CG_DESCRIPTOR, hg, gc)));
  });
});

describe("withNewest - the confirmer series carried to the gap-fill sweep", () => {
  const row = (date: string, level: number): Reading => ({ indicator: CG, date, level, delta20: 0, rawState: "GREEN", state: "GREEN" });
  test("keeps the scalar's row as the newest and drops twin rows dated >= it", () => {
    const twin = [row("2026-09-28", 1), row("2026-09-29", 2), row("2026-09-30", 3), row("2026-10-01", 4)];
    const scalar: Reading = { ...row("2026-09-30", 99), state: "AMBER" };
    expect(withNewest(twin, scalar)).toEqual([twin[0], twin[1], scalar]);
  });
});
