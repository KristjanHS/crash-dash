/**
 * FXH — score and draw off ONE stored leg grid.
 *
 * `fxHavenMoveSeries` indexes its 20-bar lookback positionally, so the base date is a property of
 * the input GRID. The defect: the cron scored the live closes provider grid (Sun…Thu labels, 5/week) while the
 * read API recomputed off the stored union grid, which also carries Friday-labelled live-quote rows
 * from Friday-evening runs (6/week) — a different 20-bar base for the same newest date. The fix
 * routes BOTH through `readFxhLegs`; this file pins (1) that the defect is real on such a grid,
 * (2) that the scorer-depth read and the chart-depth read share one base, and (3) that the
 * scorer-depth read is deep enough to reproduce the full-history fold.
 */
import { describe, expect, it } from "vitest";

import { FXH_LEG_IDS, FXH_SCORER_LEG_LIMIT, fxhLegLimit, readFxhLegs } from "./fxh-legs.js";
import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import { makeStoredReading } from "./test-helpers.js";
import { fxHavenMoveSeries, fxHavenReadingSeries, scoreFxHaven } from "./scorers-composite.js";
import { confirmClosesFor } from "./family-table.js";
import { gapFillFrom } from "./intraday.js";
import { FXH } from "./registry-composite.js";
import { VELOCITY_WINDOW } from "./domain-types.js";
import type { Observation } from "./domain-types.js";

const START = Date.UTC(2026, 4, 3); // 2026-05-03, a Sunday
const iso = (d: number): string => new Date(START + d * 86_400_000).toISOString().slice(0, 10);
const dow = (d: number): number => new Date(START + d * 86_400_000).getUTCDay();
const N = 120;
// A steady 0.3%/day decline: every bar is a distinct value, so ANY base-date shift moves the 20-bar
// return — and a 20-bar drop of ~6% lands well above FXH_RED, i.e. the newest raw state is not GREEN.
const value = (d: number): number => 1.3 * Math.pow(0.997, d);

// The LIVE closes provider grid: Sun…Thu labels only (a `D T23:00Z` bar is labelled by its UTC date).
const live: Observation[] = Array.from({ length: N }, (_, d) => d)
  .filter((d) => dow(d) !== 5 && dow(d) !== 6)
  .map((d) => ({ date: iso(d), value: value(d) }));
// The STORED union grid: the live grid + the Friday-labelled live-quote rows a Friday-evening cron
// persists (kept forever — backfill is insert-missing). Ghosts in the newest 6 weeks only.
const stored: Observation[] = Array.from({ length: N }, (_, d) => d)
  .filter((d) => dow(d) !== 6 && (dow(d) !== 5 || d > N - 42))
  .map((d) => ({ date: iso(d), value: value(d) }));

async function storeWith(series: Observation[]): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const rows: StoredReading[] = FXH_LEG_IDS.flatMap((id) =>
    series.map((o) => makeStoredReading(id, { date: o.date, value: o.value })),
  );
  await store.recordReadings(rows, "2026-09-04T22:55:00.000Z");
  return store;
}

const newestMove = (l: { usEur: Observation[]; chfUsd: Observation[]; jpyUsd: Observation[] }): number =>
  fxHavenMoveSeries(l.usEur, l.chfUsd, l.jpyUsd).havenMove.at(-1)!;
const baseDate = (leg: Observation[]): string => leg.at(-1 - VELOCITY_WINDOW)!.date;

describe("readFxhLegs — one stored grid for the scorer and the chart", () => {
  it("the defect: the live grid and the stored union grid put the newest 20-bar base on different dates", async () => {
    const store = await storeWith(stored);
    const chart = (await readFxhLegs(store, fxhLegLimit(40)))!;
    expect(baseDate(chart.usEur)).not.toBe(baseDate(live));
    expect(newestMove(chart)).not.toBeCloseTo(newestMove({ usEur: live, chfUsd: live, jpyUsd: live }), 6);
  });

  it("the fix: the scorer-depth read and the chart-depth read share the base date and the worst-of move", async () => {
    const store = await storeWith(stored);
    const scorer = (await readFxhLegs(store, FXH_SCORER_LEG_LIMIT))!;
    const chart = (await readFxhLegs(store, fxhLegLimit(40)))!;
    expect(scorer.usEur.length).toBe(FXH_SCORER_LEG_LIMIT);
    expect(baseDate(scorer.usEur)).toBe(baseDate(chart.usEur));
    expect(newestMove(scorer)).toBeCloseTo(newestMove(chart), 12);
  });

  it("FXH_SCORER_LEG_LIMIT is deep enough: scoring the read-back equals scoring the whole stored history", async () => {
    const store = await storeWith(stored);
    const short = (await readFxhLegs(store, FXH_SCORER_LEG_LIMIT))!;
    const full = (await readFxhLegs(store, 10_000))!;
    expect(full.usEur.length).toBe(stored.length);
    const a = scoreFxHaven(FXH, short.usEur, short.chfUsd, short.jpyUsd);
    const b = scoreFxHaven(FXH, full.usEur, full.chfUsd, full.jpyUsd);
    expect(a.rawState).not.toBe("GREEN"); // non-vacuous: the fold has something to confirm
    expect({ date: a.date, rawState: a.rawState, state: a.state, level: a.level }).toEqual({
      date: b.date, rawState: b.rawState, state: b.state, level: b.level,
    });
  });

  it("FXH_SCORER_LEG_LIMIT covers the gap-fill window: the carried series past its fold head starts on/before gapFillFrom", async () => {
    const store = await storeWith(stored);
    const legs = (await readFxhLegs(store, FXH_SCORER_LEG_LIMIT))!;
    const series = fxHavenReadingSeries(FXH, legs.usEur, legs.chfUsd, legs.jpyUsd).slice(confirmClosesFor("FXH"));
    expect(series[0]!.date <= gapFillFrom(series.at(-1)!.date)).toBe(true);
  });

  it("returns null when any leg is empty (never backfilled) so the read API degrades to legless points", async () => {
    const store = new InMemoryStore();
    const rows: StoredReading[] = stored.map((o) => makeStoredReading(FXH_LEG_IDS[0], { date: o.date, value: o.value }));
    await store.recordReadings(rows, "2026-09-04T22:55:00.000Z");
    expect(await readFxhLegs(store, FXH_SCORER_LEG_LIMIT)).toBeNull();
  });
});
