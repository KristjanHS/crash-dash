/**
 * Tests for GET /api/series (api/series.ts) over the PENSION legs (SPY/LEGP_EXUS/DEXUSEU).
 * Drives the exported `seriesBody(() => store, req, { now })` (the full body `handle` serves) over a pre-seeded InMemoryStore.
 *
 * Contract: once the legs are registered,
 * /series serves all three, AND the latest point's delta20 is a REAL value (priceLegReadingSeries
 * computes a true 20-obs delta once ≥21 obs exist) — not a permanent 0 that would read as
 * a data-quality bug.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { seriesBody, withPostInversionCut } from "./series.js";
import { InMemoryStore } from "../src/store-memory.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";
import { priceLegReadingSeries } from "../src/pension.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import { type Observation, type Indicator } from "../src/domain-types.js";
import type { SeriesPointDTO, SeriesResponse } from "../src/api/types.js";
import { POST_INVERSION_BAND, R8_MEAN_CUT_BANDS, SMOOTHED_LEVEL_OF } from "../src/family-descriptor-rows.js";
// The REAL scorer + the REAL registry row behind the CG re-score assertions: the expected
// states are computed by the same function the handler calls, so a lattice/cut change moves
// both together and the test can never pin a transcribed verdict.
import {
  drawdownCutSeries,
  shortMoveSeries,
  steepenerEscalationSeries,
  smoothedLevelReadingSeries,
} from "../src/scorers-core.js";
import { T10Y3M_POST_INVERSION, T10Y3M_DRAWDOWN, ECY as ECY_IND } from "../src/registry-fred.js";
import { ecyReadingSeries, ecyExpensiveCutSeries } from "../src/scorers-composite.js";
import { ECY_MIN_OBS, CHART_DESCRIPTOR_OF } from "../src/family-descriptor-rows.js";
import { R1_DRAWDOWN_BAND } from "../src/family-descriptor-rows.js";
// The DB_* downside-gate assertions run the HANDLER's own seams — the MA/rolling-high builders
// behind the flag and its drawn line, the detector's cut pair, and the scorer that persists it.
import { maValues, inclusiveRollingMax } from "../src/gates.js";
import { downsideBreakReadingSeries, downsideCuts } from "../src/scorers-price.js";
import { HIGH_WINDOW_SHORT } from "../src/family-descriptor-rows.js";
import { PRICE_WINDOWS } from "../src/family-descriptor-rows.js";
import { toStoredReadings } from "../src/run-core.js";
import {
  RUN_AT,
  seedSharedStore,
  headersOf,
  RAW_CARRIER,
  rawPoints,
  seedRaw,
  REDMEAN_FIXTURE_ID,
  REDMEAN_WIN,
  REDMEAN_REDWIN,
  REDMEAN_CARRIER,
} from "../src/api-series.test-helpers.js";

// The store `GET` hands the handler. Defaults to the shared `store`; `withStore` swaps it
// for one call so a test needing its OWN history (the CG warmup-head fixture, which must be
// SHORTER than the deep one for the same id) cannot contaminate the shared seed.
const store = new InMemoryStore();
let activeStore: InMemoryStore = store;
const withStore = async <T>(s: InMemoryStore, fn: () => Promise<T>): Promise<T> => {
  activeStore = s;
  try {
    return await fn();
  } finally {
    activeStore = store;
  }
};

// P1 staleness (readInputSeries, INPUT_MAX_STALE_DAYS vs `now`): pin `now` BEFORE every fixture date,
// so no seeded input can read as stale here (a future-dated newest row has negative age). Stale
// behavior itself is unit-tested in src/input-series.test.ts.
const NOW = new Date("1999-01-01T00:00:00Z");
// R7: these suites pin the FULL body ⇒ every request reads `seriesBody`, before the response rule redacts it.
const GET = async (req: Request): Promise<Response> => {
  const body = await seriesBody(() => activeStore, req, { now: NOW });
  return body instanceof Response ? body : Response.json(body);
};

// P12.a: the vintage memo is MODULE-LEVEL state inside api/series.ts — clear it per test, or a
// cached synth promise from one test's store would be served against the next test's.
beforeEach(() => resetVintageMemo());
afterEach(() => resetVintageMemo());

await seedSharedStore(store);

const serve = async (id: string): Promise<{ status: number; body: SeriesResponse }> => {
  const res = await GET(new Request(`https://x/api/series?id=${id}`));
  return { status: res.status, body: (await res.json()) as SeriesResponse };
};



// --- R1 post-inversion amber floor (Stage 2, 2026-08-12; mean space since 2026-08-31) -----------
// `withPostInversionCut` attaches `bandCuts[POST_INVERSION_BAND.key]` read VERBATIM from the
// persisted scorer cut, joined onto the stored points BY DATE — a null/absent stored cut emits NO
// key (a chart gap), never an on-read recompute.
describe("GET /api/series - R1 post-inversion amber floor", () => {
  const PI = T10Y3M_POST_INVERSION;
  const r1 = ALL_INDICATORS.find((i) => i.id === "R1")!;
  const r8 = ALL_INDICATORS.find((i) => i.id === "R8")!;
  const { window: r1Win, redWindow: r1RedWin } = SMOOTHED_LEVEL_OF[r1.id]!;
  // Straddles the rung: a green head, a qualifying inversion (> qualifyN inverted closes), then
  // an un-inverted tail BELOW floorLevel (never releases) — so armed and unarmed days BOTH reach
  // the store. The inversion is DEEP and LONG (−0.5 × qualifyN+25) so the 21-obs MEAN (R1's AND
  // R8's) also inverts for a qualifying run — which is what makes both smoothed tests below
  // discriminate the mean-space arms rather than pass because the mean never armed.
  const piObs: Observation[] = Array.from({ length: 30 + PI.qualifyN + 25 + 30 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: i >= 30 && i < 30 + PI.qualifyN + 25 ? -0.5 : PI.floorLevel - 0.05,
  }));
  const meansOf = (win: number): { means: number[]; meanDates: string[] } => {
    const means: number[] = [];
    const meanDates: string[] = [];
    for (let i = win - 1; i < piObs.length; i++) {
      means.push(piObs.slice(i - win + 1, i + 1).reduce((s, o) => s + o.value, 0) / win);
      meanDates.push(piObs[i]!.date);
    }
    return { means, meanDates };
  };

  const seeded = async (ind: Indicator, bandCuts: Record<string, number> | null = null): Promise<InMemoryStore> => {
    const { window, redWindow } = SMOOTHED_LEVEL_OF[ind.id]!;
    const piStore = new InMemoryStore();
    await piStore.recordReadings(
      smoothedLevelReadingSeries(ind, piObs, window, undefined, redWindow).map((r) => ({
        date: r.date,
        indicatorId: r.indicator.id,
        value: r.level,
        delta20: r.delta20,
        rawState: r.rawState,
        state: r.state,
        // Explicit null = the pre-backfill store (⇒ no key on the wire); a map = the persisted scorer cut.
        bandCuts,
      })),
      RUN_AT,
    );
    return piStore;
  };
  const seededR1Store = (bandCuts: Record<string, number> | null = null) => seeded(r1, bandCuts);
  // P1.2: the overlay reads the carrier's UPSTREAM series (r1 T10Y3M / r8 NTFS) from the store.
  const withInputs = async (s: InMemoryStore, ind: Indicator): Promise<InMemoryStore> => {
    await s.recordReadings(priceLegReadingSeries(ind.series, piObs), RUN_AT);
    return s;
  };

  // Vacuity anchor: the STORED-verbatim tests below serve these keys off the SAME fixture when the
  // store carries a cut — so an all-absent wire here is the stored-null gap, not an arm that never ran.
  test.each([
    { id: "R1", ind: r1, keys: [POST_INVERSION_BAND.key] },
    { id: "R8", ind: r8, keys: [...R8_MEAN_CUT_BANDS.map((b) => b.key), POST_INVERSION_BAND.key] },
  ])("$id explicit-null stored cuts: NO cut key on any point — a chart gap, never a recompute", async ({ id, ind, keys }) => {
    const body = await withStore(
      await withInputs(await seeded(ind), ind),
      async () => (await (await GET(new Request(`https://x/api/series?id=${id}`))).json()) as SeriesResponse,
    );
    expect(body.points.length).toBeGreaterThan(0);
    for (const p of body.points) {
      for (const k of keys) expect(p.bandCuts?.[k], `@${p.date} null store must carry NO ${k}`).toBeUndefined();
    }
  });

  test("redMean rides every full-window day, valued by the redWindow trailing mean; ABSENT on the warm-up head", async () => {
    const piStore = await seededR1Store();
    const body = await withStore(
      await withInputs(piStore, r1),
      async () => (await (await GET(new Request("https://x/api/series?id=R1"))).json()) as SeriesResponse,
    );
    // Oracle: the redWindow-obs trailing mean of the SAME feed, joined by date — the handler's join.
    const { means, meanDates } = meansOf(r1RedWin!);
    const redByDate = new Map(meanDates.map((d, k) => [d, means[k]!]));
    const head = body.points.filter((p) => !redByDate.has(p.date));
    const full = body.points.filter((p) => redByDate.has(p.date));
    for (const p of head) expect(p.redMean, `@${p.date} pre-window head carries NO redMean`).toBeUndefined();
    for (const p of full) expect(p.redMean, `@${p.date}`).toBeCloseTo(redByDate.get(p.date)!, 12);
    expect(full.length, "some served day is past the redWindow warm-up").toBeGreaterThan(0);
    expect(head.length, "the redWindow warm-up head must exist").toBeGreaterThan(0);
    // Discriminating: redMean is the redWindow mean, NOT the shorter window mean (the plotted value).
    const shortByDate = new Map(meansOf(r1Win).meanDates.map((d, k) => [d, meansOf(r1Win).means[k]!]));
    const disagree = body.points.some((p) => p.redMean !== undefined && Math.abs(p.redMean - shortByDate.get(p.date)!) > 1e-9);
    expect(disagree, "redMean must differ from the window mean on at least one day").toBe(true);
  });

  test("a redWindow-less carrier (R8) serves NO redMean key on any point", async () => {
    expect(SMOOTHED_LEVEL_OF[r8.id]!.redWindow, "premise: R8 declares no redWindow").toBeUndefined();
    const body = await withStore(
      await withInputs(await seeded(r8), r8),
      async () => (await (await GET(new Request("https://x/api/series?id=R8"))).json()) as SeriesResponse,
    );
    expect(body.points.length).toBeGreaterThan(0);
    for (const p of body.points) expect(p.redMean, `@${p.date} R8 carries NO redMean`).toBeUndefined();
  });

  test("missing T10Y3M input (P1.2): 200 + headers unchanged vs the healthy path, points served with no post-inversion key", async () => {
    // Seeded WITH a stored cut: the degrade arm returns before the stored-cut join reaches the wire.
    const bare = await seededR1Store({ [POST_INVERSION_BAND.key]: PI.floorLevel + 0.37 });
    const res = await withStore(bare, () => GET(new Request("https://x/api/series?id=R1")));
    expect(res.status).toBe(200);
    const healthy = await withStore(await withInputs(await seededR1Store(), r1), () =>
      GET(new Request("https://x/api/series?id=R1")),
    );
    expect(headersOf(res)).toEqual(headersOf(healthy)); // never no-store/503 on the missing-row path
    // Vacuity anchor: the STORED-verbatim test below serves the key off this SAME seeded fixture when
    // the feed is up — so an all-absent key here is the degrade arm, not a store without a cut.
    const body = (await res.json()) as SeriesResponse;
    expect(body.points.length).toBeGreaterThan(0);
    for (const p of body.points) expect(p.bandCuts?.[POST_INVERSION_BAND.key], `@${p.date}`).toBeUndefined();
  });

  test("R1: the STORED scorer cut is emitted verbatim, on every stamped date", async () => {
    // Premise pair: R1 carries the shared rung object AND the two-window smoothed row — the arm
    // this overlay dispatches on (a plain smoothed id without `redWindow` gets NO line).
    expect(r1.postInversionCooldown).toBe(PI);
    expect(r1RedWin).toBeDefined();
    const SEEDED = PI.floorLevel + 0.37;
    const piStore = await seededR1Store({ [POST_INVERSION_BAND.key]: SEEDED });
    const body = await withStore(
      await withInputs(piStore, r1),
      async () => (await (await GET(new Request("https://x/api/series?id=R1"))).json()) as SeriesResponse,
    );
    expect(body.points.length).toBeGreaterThan(0);
    // Every served date carries the STORED value — including days the scorer's rung was unarmed:
    // the wire is a verbatim per-date join on the stored map; nothing else emits this key.
    for (const p of body.points) {
      expect(p.bandCuts?.[POST_INVERSION_BAND.key], `@${p.date} stored cut must reach the wire`).toBe(SEEDED);
    }
    // Discriminating seed: differs from the scorer's flat floorLevel, so a resurrected recompute
    // tail could not satisfy the loop above.
    expect(SEEDED).not.toBe(PI.floorLevel);
  });

  test("R8: STORED scorer cuts are emitted verbatim — the seeded red key reaches the wire despite warm-up", async () => {
    const [amberBand, redBand] = R8_MEAN_CUT_BANDS;
    const SEED = { [amberBand.key]: -0.91, [redBand.key]: -1.37 };
    // Premise pair: R8 carries its OWN mean-space rung AND is the smoothed id — the `levelCuts` arm
    // of `withPostInversionCut`, not the R1 emitter.
    expect(r8.postInversionCooldown!.levelCuts).toBeDefined();
    expect(SMOOTHED_LEVEL_OF[r8.id]).toBeDefined();
    const body = await withStore(
      await withInputs(await seeded(r8, SEED), r8),
      async () => (await (await GET(new Request("https://x/api/series?id=R8"))).json()) as SeriesResponse,
    );
    expect(body.points.length).toBeGreaterThan(0);
    // The scorer holds the red cut ABSENT under `cutWarmupObs` at this pool size, so a served red
    // value is only reachable through the stored map — the discriminating half of this pair.
    for (const p of body.points) {
      expect(p.bandCuts?.[amberBand.key], `@${p.date}`).toBe(SEED[amberBand.key]);
      expect(p.bandCuts?.[redBand.key], `@${p.date}`).toBe(SEED[redBand.key]);
    }
  });
});

describe("withPostInversionCut raw arm - the regime-relative drawdown cut on a fixture carrier", () => {
  const DD = T10Y3M_DRAWDOWN;
  const r1 = RAW_CARRIER;
  // A rising ramp longer than the window: the drawdown key rides every window-filled day and the
  // head is warm-up. Positive throughout ⇒ the post-inversion rung NEVER arms, isolating the leg.
  const ddObs: Observation[] = Array.from({ length: DD.window + 60 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: 1.0 + i * 0.005,
  }));

  test("the drawdown key rides exactly the window-filled days, valued by the exported cut series", async () => {
    // Premise pair: the fixture is a RAW carrier (no smoothed row) wearing the leg — and live R1
    // is not (the leg is un-wired there), which is why this arm needs a fixture at all.
    expect(SMOOTHED_LEVEL_OF[r1.id]).toBeUndefined();
    expect(r1.drawdownLeg).toBe(DD);
    expect(ALL_INDICATORS.find((i) => i.id === "R1")!.drawdownLeg, "live R1 carries no drawdown leg").toBeUndefined();
    // Short leg seeded too (the carrier's rung declares one): keeps this test off the missing-row path.
    const body = {
      points: await withPostInversionCut(r1, rawPoints(ddObs), undefined, {
        store: await seedRaw(ddObs, { [T10Y3M_POST_INVERSION.shortLegSeries]: ddObs }),
        now: NOW,
      }),
    };
    // Oracle: the SAME exported function over the SAME feed, joined BY DATE — the handler's own join.
    const cuts = drawdownCutSeries(ddObs.map((o) => o.value), DD);
    const cutByDate = new Map<string, number>();
    ddObs.forEach((o, i) => {
      if (cuts[i] !== null) cutByDate.set(o.date, cuts[i]!);
    });
    const warmupDays = body.points.filter((p) => !cutByDate.has(p.date));
    const filledDays = body.points.filter((p) => cutByDate.has(p.date));
    for (const p of warmupDays) {
      expect(p.bandCuts?.[R1_DRAWDOWN_BAND.key], `@${p.date} warm-up day must carry NO drawdown key`).toBeUndefined();
    }
    for (const p of filledDays) expect(p.bandCuts?.[R1_DRAWDOWN_BAND.key], `@${p.date}`).toBe(cutByDate.get(p.date));
    for (const p of body.points) {
      // The rung never arms on a positive ramp, so the post-inversion floor key rides no day here —
      // which is what makes this a clean isolation of the drawdown leg.
      expect(p.bandCuts?.[POST_INVERSION_BAND.key], `@${p.date} rung unarmed ⇒ no floor key`).toBeUndefined();
    }
    // Vacuity, both arms: the fixture straddles the warm-up boundary.
    expect(filledDays.length, "some date must carry the drawdown cut").toBeGreaterThan(0);
    expect(warmupDays.length, "the warm-up head must exist (served rows before the window fills)").toBeGreaterThan(0);
    // …and the line MOVES (trailing max − dropPp over a rising ramp), never the flat floor.
    const emitted = body.points.map((p) => p.bandCuts?.[R1_DRAWDOWN_BAND.key]).filter((v) => v !== undefined);
    expect(new Set(emitted).size, "the drawdown cut is a moving line").toBeGreaterThan(1);
  });
});


// --- RAW arm: the short-leg gate line (2026-08-30) -------------------------------------------
// Reported defect: prod painted then-raw R1 RED on 105 of 400 served days with the plotted spread
// ABOVE the drawn red line (up to 0.6pp above it) — every one an armed-rung day whose bull-steepener
// escalation fired off a SECOND series that the chart never drew. The raw arm ships that gate's own
// decision variable as `shortMove`, off the SAME walk the scorer gates on. Pinned on `RAW_CARRIER`
// (R1 scores no escalation since 2026-08-31, so its response carries no `shortMove` — asserted
// below); `chart-rail.test.ts` pins the bounds drawn against it.
describe("withPostInversionCut raw arm - the short-leg gate line on a fixture carrier", () => {
  const PI = T10Y3M_POST_INVERSION;
  const r1 = RAW_CARRIER;
  // A positive ramp (rung never arms — the gate line is emitted rung-INDEPENDENTLY, which is the
  // point: it must be on screen before the escalation it explains can fire).
  const obs: Observation[] = Array.from({ length: PI.shortLegWindow + 40 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: 1.0 + i * 0.005,
  }));
  // The short leg falls, then rises — so the emitted line changes SIGN inside the window and a
  // single-sign fixture cannot pass by accident.
  const short: Observation[] = obs.map((o, i) => ({
    date: o.date,
    value: i < obs.length / 2 ? 4.0 - i * 0.02 : 4.0 - (obs.length - i) * 0.02,
  }));
  const serve = async (feed: Record<string, Observation[]>, carrier: Indicator = r1) => ({
    points: await withPostInversionCut(carrier, rawPoints(obs), undefined, { store: await seedRaw(obs, feed), now: NOW }),
  });

  test("live R1 (smoothed two-window arm) ships NO `shortMove` even with the short leg up", async () => {
    // Discriminating premise: the SAME fixture puts `shortMove` on the raw carrier (next test), so
    // an all-absent key here is the smoothed arm declining the wire, not a feed that never filled.
    const live = ALL_INDICATORS.find((i) => i.id === "R1")!;
    expect(SMOOTHED_LEVEL_OF[live.id]?.redWindow).toBeDefined();
    const body = await serve({ [PI.shortLegSeries]: short }, live);
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.points.every((p) => p.shortMove === undefined), "no shortMove on the smoothed arm").toBe(true);
    expect(body.points.every((p) => p.bandCuts?.[R1_DRAWDOWN_BAND.key] === undefined), "no drawdown key either").toBe(true);
  });

  test("`shortMove` rides exactly the window-filled days, valued by the exported walk", async () => {
    const body = await serve({ [PI.shortLegSeries]: short });
    // Oracle: the SAME exported function over the SAME two feeds, joined BY DATE.
    const moves = shortMoveSeries(obs, short, PI.shortLegWindow);
    const byDate = new Map<string, number>();
    obs.forEach((o, i) => {
      if (moves[i] !== null) byDate.set(o.date, moves[i]!);
    });
    const warmup = body.points.filter((p) => !byDate.has(p.date));
    const filled = body.points.filter((p) => byDate.has(p.date));
    for (const p of warmup) expect(p.shortMove, `@${p.date} unfilled window must carry NO shortMove key`).toBeUndefined();
    for (const p of filled) expect(p.shortMove, `@${p.date}`).toBe(byDate.get(p.date));
    expect(filled.length, "some date must carry the gate line").toBeGreaterThan(0);
    expect(warmup.length, "the warm-up head must exist (served rows before the window fills)").toBeGreaterThan(0);
    // Both signs present ⇒ the fixture actually exercises a sign flip, not a constant.
    const emitted = body.points.map((p) => p.shortMove).filter((v): v is number => v !== undefined);
    expect(emitted.some((v) => v < 0), "the short leg falls somewhere in the window").toBe(true);
    expect(emitted.some((v) => v > 0), "…and rises somewhere else").toBe(true);
  });

  test("the drawn line and the scorer's escalation flag are ONE walk (a flag iff the line crosses)", async () => {
    const body = await serve({ [PI.shortLegSeries]: short });
    const flags = steepenerEscalationSeries(obs, short, PI);
    const flagByDate = new Map(obs.map((o, i) => [o.date, flags[i]!]));
    let crossings = 0;
    for (const p of body.points) {
      // The drawn RED bound is `-shortLegDropBp / 100` (chart-rail.ts) — a fall past it IS the flag.
      const crosses = p.shortMove !== undefined && p.shortMove <= -PI.shortLegDropBp / 100;
      expect(crosses, `@${p.date} the drawn crossing must equal the scored flag`).toBe(flagByDate.get(p.date));
      if (crosses) crossings++;
    }
    expect(crossings, "the fixture must actually cross the bound").toBeGreaterThan(0);
  });

  test("missing short-leg rows degrade to NO gate line - never a drawn zero", async () => {
    // DGS3MO never seeded ⇒ the overlay's missing-row arm (P1.2) omits `shortMove`.
    const body: { points: SeriesPointDTO[] } = await serve({});
    expect(body.points.every((p) => p.shortMove === undefined), "no shortMove key survives missing rows").toBe(true);
    // …and NOTHING else moves: the gate line is purely additive, so the degraded payload is the
    // armed one with only that key stripped. (`value`/`state`/`bandCuts` all ride the value axis,
    // which the short leg never touches.)
    const armed = await serve({ [PI.shortLegSeries]: short });
    expect(body.points).toEqual(armed.points.map(({ shortMove: _drop, ...rest }) => rest));
  });
});

describe("withPostInversionCut - redMean on a rung-less redWindow fixture carrier", () => {
  // Quadratic ⇒ the redWindow(63) trailing mean differs from the window(21) one, so the served value
  // discriminates the two windows rather than passing on a flat feed.
  const obs: Observation[] = Array.from({ length: REDMEAN_REDWIN + 30 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: (i * i) * 0.001,
  }));
  const trailingMeanByDate = (win: number): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = win - 1; i < obs.length; i++) {
      m.set(obs[i]!.date, obs.slice(i - win + 1, i + 1).reduce((s, o) => s + o.value, 0) / win);
    }
    return m;
  };

  beforeAll(() => {
    (SMOOTHED_LEVEL_OF as Record<string, { window: number; redWindow?: number }>)[REDMEAN_FIXTURE_ID] = {
      window: REDMEAN_WIN,
      redWindow: REDMEAN_REDWIN,
    };
  });
  afterAll(() => {
    delete (SMOOTHED_LEVEL_OF as Record<string, { window: number; redWindow?: number }>)[REDMEAN_FIXTURE_ID];
  });

  test("emits redMean (the redWindow trailing mean) though the carrier declares NO postInversionCooldown", async () => {
    // Discriminating premises: the carrier has a redWindow row but no rung, so the OLD cfg-gated
    // guard would emit nothing — and the redWindow ≠ window, so the emitted line is the RED mean.
    expect(REDMEAN_CARRIER.postInversionCooldown, "premise: no rung").toBeUndefined();
    expect(SMOOTHED_LEVEL_OF[REDMEAN_FIXTURE_ID]!.redWindow).toBe(REDMEAN_REDWIN);
    expect(REDMEAN_REDWIN).not.toBe(REDMEAN_WIN);
    const points = await withPostInversionCut(REDMEAN_CARRIER, rawPoints(obs), undefined, { store: await seedRaw(obs), now: NOW });
    const redByDate = trailingMeanByDate(REDMEAN_REDWIN);
    const head = points.filter((p) => !redByDate.has(p.date));
    const full = points.filter((p) => redByDate.has(p.date));
    for (const p of head) expect(p.redMean, `@${p.date} pre-window head carries NO redMean`).toBeUndefined();
    for (const p of full) expect(p.redMean, `@${p.date}`).toBeCloseTo(redByDate.get(p.date)!, 12);
    expect(full.length, "some served day is past the redWindow warm-up").toBeGreaterThan(0);
    expect(head.length, "the redWindow warm-up head must exist").toBeGreaterThan(0);
    // The line is the redWindow mean, NOT the shorter window mean — the whole reason redWindow feeds it.
    const shortByDate = trailingMeanByDate(REDMEAN_WIN);
    const disagree = points.some((p) => p.redMean !== undefined && Math.abs(p.redMean - shortByDate.get(p.date)!) > 1e-9);
    expect(disagree, "redMean must differ from the window mean on at least one day").toBe(true);
  });
});


// --- The DB_* downside branch's MA50 trend gate (2026-08-18) ----------------------------
//
// Reported defect: prod served DB_SMH GREEN on 2026-08-17 at a −11.2% drawdown, i.e. well past
// the −8% red cut its detail chart draws, because SMH had crossed back above its 50-day MA — the
// AND-half of `downsideBreakReadingSeries` that the plotted drawdown cannot show. The fix wires
// the detector into the Case-4 gate contract (`GATES.DB_SMH`), so the branch now ships the
// per-point flag AND the gate's own line in drawdown space. These tests pin BOTH the mechanism
// and the reported scenario; every expectation is COMPUTED from the same seams the handler runs
// (`maValues`, `inclusiveRollingMax`, `downsideCuts`), never transcribed.
describe("GET /api/series - DB_* downside gate", () => {
  const DB_SMH_I = CHART_ONLY_INDICATORS.concat(ALL_INDICATORS).find((i) => i.id === "DB_SMH")!;
  // A V-shaped fixture: a long climb to a peak, a 12-session crash (deep drawdown, price far under
  // its MA50 ⇒ gate ON ⇒ RED), then a snap-back that clears the MA50 while the drawdown is STILL
  // past the red cut — the exact prod signature above.
  // ⚠ The climb is long because the store only ever holds what the CRON persisted, which starts at
  // the scorer's own `baseOffset` (HIGH_WINDOW_SHORT−1), and the read path then re-scores THOSE
  // rows: the fixture loses 62 rows to the first fold and another 63+49 to the re-score's rolling
  // high + MA window before a single gate flag can be emitted. A short fixture serves 0 points and
  // every for-of assertion below passes vacuously.
  const dbCloses: Observation[] = [
    ...Array.from({ length: 140 }, (_, i) => 100 + i), // 100 → 239 (peak)
    ...Array.from({ length: 12 }, (_, i) => 239 - (i + 1) * 7), // 232 → 155: the crash
    ...Array.from({ length: 35 }, (_, i) => 155 + (i + 1) * 2), // 157 → 225: the snap-back
  ].map((value, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), value }));
  // What the cron actually persists (value = the close), through the SAME `toStoredReadings`
  // projection `recordRun` uses — the handler's whole input.
  const storedReadings = downsideBreakReadingSeries(DB_SMH_I, dbCloses);

  const serveDb = async () => {
    const s = new InMemoryStore();
    await s.recordReadings(toStoredReadings(storedReadings), RUN_AT);
    return withStore(s, () => serve("DB_SMH"));
  };

  test("the gate flag + its drawn line are the SAME condition, on every served point", async () => {
    const { status, body } = await serveDb();
    expect(status).toBe(200);
    expect(body.points.length, "premise: the fixture must survive both folds").toBeGreaterThan(0);
    // The downside branch still wins the dispatch (it now carries a GATES entry, which the gate
    // branch is checked BEFORE): the plotted value is the DRAWDOWN (≤ 0, in %), never the raw
    // close the gate branch would have served verbatim.
    expect(body.points.every((p) => p.value! <= 0)).toBe(true);

    // Oracle over the STORED closes — the handler's own input, not the raw fixture.
    // `Reading.level` IS the close; `toStoredReadings` is what renames it to the row's `value`.
    const closes = storedReadings.map((r) => r.level);
    const mas = maValues(closes, PRICE_WINDOWS.maShort);
    const highs = inclusiveRollingMax(closes, HIGH_WINDOW_SHORT);
    const byDate = new Map(storedReadings.map((r, i) => [r.date, { close: r.level, ma: mas[i], hi: highs[i] }] as const));
    let flagged = 0;
    for (const p of body.points) {
      const { close, ma, hi } = byDate.get(p.date)!;
      // Every SERVED point sits at stored index ≥ HIGH_WINDOW_SHORT−1 (62), which covers both the
      // MA (50) and the rolling high (63) — so both keys are present on ALL of them. The handler's
      // absent-key arms are a degrade for a future window retune, and this is what pins that they
      // are not silently swallowing today's line.
      expect(ma, `@${p.date} premise: a served point's MA window is covered`).not.toBeNull();
      expect(hi, `@${p.date} premise: a served point's rolling high is covered`).not.toBeNull();
      expect(p.gates?.belowMA50, `@${p.date} flag = the scorer's own gate`).toBe(close < ma!);
      // The line IS the flag, drawn: dd < gateLine ⟺ close < ma50 (both ÷ the same positive high).
      expect(p.gateLine).toBeCloseTo((ma! / hi! - 1) * 100, 10);
      expect(p.value! < p.gateLine!, `@${p.date} line and flag agree`).toBe(p.gates!.belowMA50);
      if (p.gates!.belowMA50) flagged++;
    }
    expect(flagged, "the crash leg must have the gate ON somewhere").toBeGreaterThan(0);
    expect(flagged, "the recovery leg must have it OFF somewhere").toBeLessThan(body.points.length);
  });

  test("reproduces the reported prod signature: past the red cut, gate off ⇒ GREEN", async () => {
    const { body } = await serveDb();
    const red = downsideCuts("DB_SMH").red * 100;
    // The defect's own shape — a point the drawn red line says is breached, served GREEN.
    const defect = body.points.filter((p) => p.value! <= red && p.state === "GREEN");
    expect(defect.length, "the fixture must contain the reported case").toBeGreaterThan(0);
    // …and it is EXPLAINED, not just tolerated: every such point ships the gate flag FALSE, so the
    // renderer dims that stretch instead of leaving a silent contradiction.
    expect(defect.every((p) => p.gates?.belowMA50 === false)).toBe(true);
    // Conversely a breach WITH the gate on does reach RED (vacuity guard on the arm above).
    const gated = body.points.filter((p) => p.value! <= red && p.gates?.belowMA50 === true);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.some((p) => p.state === "RED")).toBe(true);
  });
});


// ECY (2026-09-05) — the drawn amber cut is the SCORER's strict-prefix boundary over the F7×DFII10
// JOIN, not an expanding percentile over the stored ECY rows. The seeded ECY store is deliberately
// a SHORT tail of the join (6 rows vs 150 ranked months): the retired stored-rows arm could not
// even reach its floor here, let alone rank against the right base — so this fixture reds on a
// regression to it. Every expectation derives from `ecyReadingSeries` / `ecyExpensiveCutSeries`.
describe("GET /api/series - ECY join-derived expensive cut (ribbon ⇔ line parity)", () => {
  const ecyMonth = (i: number): string => `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
  const months = ECY_MIN_OBS + 30;
  // Varied grid; the 6 stored months alternate deep-cheap / deep-expensive so both ribbon colours
  // are exercised against the line.
  const vals = Array.from({ length: months }, (_, i) =>
    i >= months - 6 ? (i % 2 === 0 ? 0.1 : 0.0001) : 0.005 + 0.001 * ((i * 37) % 53),
  );
  const f7Obs: Observation[] = vals.map((v, i) => ({ date: ecyMonth(i), value: 1 / v }));
  const dfii10Obs: Observation[] = vals.map((_, i) => ({ date: ecyMonth(i), value: 0 }));
  const scored = ecyReadingSeries(ECY_IND, f7Obs, dfii10Obs);
  const cutByDate = new Map(ecyExpensiveCutSeries(f7Obs, dfii10Obs).map((c) => [c.date, c.cut]));
  const ecyRows = scored.slice(-6).map((r) => ({
    date: r.date,
    indicatorId: "ECY",
    value: r.level,
    delta20: 0,
    rawState: r.rawState,
    state: r.state,
    decision: r.decision,
    bandCuts: null,
  }));
  const f7Rows = f7Obs.map((o) => ({
    date: o.date,
    indicatorId: "F7",
    value: o.value,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
    decision: null,
    bandCuts: null,
  }));
  const seedEcy = async (withDfii = true): Promise<InMemoryStore> => {
    const s = new InMemoryStore();
    await s.recordReadings([...f7Rows, ...ecyRows], RUN_AT);
    if (withDfii) await s.recordReadings(priceLegReadingSeries("DFII10", dfii10Obs), RUN_AT);
    return s;
  };

  test("fixture premise: the store is a short tail of the join, and both colours are present", () => {
    expect(months).toBeGreaterThan(ecyRows.length * 10); // the ranking base is the join, not the store
    expect(new Set(ecyRows.map((r) => r.state))).toEqual(new Set(["AMBER", "GREEN"]));
  });

  test("every served month carries the join-derived cut, and AMBER ⇔ value < cut", async () => {
    const s = await seedEcy();
    const { status, body } = await withStore(s, () => serve("ECY"));
    expect(status).toBe(200);
    expect(body.points).toHaveLength(6);
    for (const p of body.points) {
      const cut = cutByDate.get(p.date)!;
      expect(Number.isFinite(cut)).toBe(true);
      expect(p.bandCuts).toEqual({ ecyAmber: cut });
      expect(p.state).toBe((p.value as number) < cut ? "AMBER" : "GREEN");
    }
  });

  // Amber key resolved from the descriptor, never a literal (Slice 3.2 single-touch-point).
  const ecyAmberKey = CHART_DESCRIPTOR_OF["ECY"]!.bandCuts!.find((c) => c.level === "amber")!.key;
  // Cron's persisted cut differs from THIS read's join re-derivation — the whole point of persisting it.
  const storedCut = (date: string): number => cutByDate.get(date)! + 1;

  test("a row missing band_cuts falls back per-row to the re-derived join cut", async () => {
    // Mixed store keyed by date: even months carry the persisted cut, odd months (legacy) carry none.
    const withStoredCut = new Set(ecyRows.filter((_, i) => i % 2 === 0).map((r) => r.date));
    const mixed = ecyRows.map((r) => (withStoredCut.has(r.date) ? { ...r, bandCuts: { [ecyAmberKey]: storedCut(r.date) } } : r));
    const s = new InMemoryStore();
    await s.recordReadings([...f7Rows, ...mixed], RUN_AT);
    await s.recordReadings(priceLegReadingSeries("DFII10", dfii10Obs), RUN_AT);
    const { status, body } = await withStore(s, () => serve("ECY"));
    expect(status).toBe(200);
    expect(body.points).toHaveLength(6);
    expect([...withStoredCut].length).toBeGreaterThan(0); // both arms exercised
    expect(body.points.some((p) => !withStoredCut.has(p.date))).toBe(true);
    for (const p of body.points) {
      const expected = withStoredCut.has(p.date) ? storedCut(p.date) : cutByDate.get(p.date)!;
      expect(p.bandCuts).toEqual({ [ecyAmberKey]: expected });
    }
  });

  test("missing DFII10 rows (P1.2): 200 + unchanged headers, stored passthrough", async () => {
    const s = await seedEcy(false); // DFII10 ABSENT from the store
    const res = await withStore(s, () => GET(new Request("https://x/api/series?id=ECY")));
    expect(res.status).toBe(200);
    const healthy = await withStore(await seedEcy(), () => GET(new Request("https://x/api/series?id=ECY")));
    expect(headersOf(res)).toEqual(headersOf(healthy)); // never no-store/503 on the missing-row path
    const body = (await res.json()) as SeriesResponse;
    expect(body.points.map((p) => p.state)).toEqual(ecyRows.map((r) => r.state));
    for (const p of body.points) expect(p.bandCuts).toBeUndefined();
  });
});


// --- CQS credit-bridge overlay: store-only inputs + the P1.2 missing-row rule ----------------
// `withCreditBridgeCuts` reads BAA10Y/AAA10Y (raw input rows) + EBP (the persisted indicator)
// from the store; a missing input serves the stored points unchanged — 200, same headers.
describe("GET /api/series - credit-bridge overlay missing-row rule (P1.2)", () => {
  const cqs = ALL_INDICATORS.find((i) => i.id === "CQS")!;
  const bridgeDates = Array.from({ length: 8 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10),
  );
  const cqsRows = bridgeDates.map((date, i) => ({
    date,
    indicatorId: cqs.id,
    value: 0.1 * i,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
    decision: null,
    bandCuts: null,
  }));
  const seedCqs = async (withInputs: boolean): Promise<InMemoryStore> => {
    const s = new InMemoryStore();
    await s.recordReadings(cqsRows, RUN_AT);
    if (withInputs) {
      const daily = bridgeDates.map((date, i) => ({ date, value: 3 + 0.01 * i }));
      await s.recordReadings(priceLegReadingSeries("BAA10Y", daily), RUN_AT);
      await s.recordReadings(priceLegReadingSeries("AAA10Y", daily.map((o) => ({ ...o, value: o.value - 1 }))), RUN_AT);
      await s.recordReadings(priceLegReadingSeries("EBP", [{ date: bridgeDates[0]!, value: 0.2 }]), RUN_AT);
    }
    return s;
  };

  test("missing bridge inputs: 200 + unchanged headers, points unchanged", async () => {
    expect(cqs, "premise: CQS is a registry id (the cutOverlay carrier)").toBeDefined();
    const s = await seedCqs(false); // all three input ids ABSENT from the store
    const res = await withStore(s, () => GET(new Request("https://x/api/series?id=CQS")));
    expect(res.status).toBe(200);
    const healthy = await withStore(await seedCqs(true), () => GET(new Request("https://x/api/series?id=CQS")));
    expect(headersOf(res)).toEqual(headersOf(healthy)); // never no-store/503 on the missing-row path
    const body = (await res.json()) as SeriesResponse;
    expect(body.points).toHaveLength(cqsRows.length);
    for (const p of body.points) expect(p.bandCuts).toBeUndefined();
  });
});
