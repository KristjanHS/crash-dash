/**
 * Tests for GET /api/series (api/series.ts) over the PENSION legs (SPY/LEGP_EXUS/DEXUSEU).
 * Drives the exported `seriesBody(() => store, req, { now })` (the full body `handle` serves) over a pre-seeded InMemoryStore.
 *
 * Contract: once the legs are registered,
 * /series serves all three, AND the latest point's delta20 is a REAL value (priceLegReadingSeries
 * computes a true 20-obs delta once ≥21 obs exist) — not a permanent 0 that would read as
 * a data-quality bug.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { seriesBody, supportsRecompute, MAX_LIMIT, putFiniteCut } from "./series.js";
import { InMemoryStore } from "../src/store-memory.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";
import { makeAlert } from "../src/test-helpers.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { breadthDistSeries } from "../src/scorers-price.js";
import type { SeriesResponse } from "../src/api/types.js";
// The percentile warmup floor, from the zero-import leaf `src/percentile.ts` — the same spelling
// `api/series.ts` uses, so the test cannot drift onto a different copy than the handler runs.
import { PCT_MIN_OBS } from "../src/percentile.js";
import { breadthCutSeries, breadthConfig, CHAIN_BREAK_RATIO, CHAIN_QUIET_RATIO } from "../src/scorers-price.js";
import { BONOS_DESCRIPTOR, CG_DESCRIPTOR, R6_DESCRIPTOR, POINT_BAND_CUTS_OF, F3_VELOCITY_BAND, BREADTH_MAX_CUT_WINDOW } from "../src/family-descriptor-rows.js";
// The REAL scorer + the REAL registry row behind the CG re-score assertions: the expected
// states are computed by the same function the handler calls, so a lattice/cut change moves
// both together and the test can never pin a transcribed verdict.
import {
  ratioSpreadReadingSeries,
  levelBandHead,
  readPathHeadRows,
  moveLegBase,
  levelBandValues,
  oatVelocityZ,
} from "../src/scorers-composite.js";
import { CG } from "../src/registry-composite.js";
import { HIGH_WINDOW } from "../src/family-descriptor-rows.js";
import { COMPOSITE_LEVEL_BAND_OF } from "../src/family-descriptor-rows.js";
import { COMPOSITE_RESTATE_OF } from "../src/scorers-composite.js";
import {
  RUN_AT,
  seedSharedStore,
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




// --- CG per-point moving band cuts + on-read re-score (2026-08-08) -------------------
// `pointBandCutSeries` replaces the store passthrough for every id in POINT_BAND_CUTS_OF.
// Three things must hold, all asserted against the seeded rows rather than eyeballed:
//   1. `rawState`/`state` are the PRODUCTION scorer's over the stored closes, NOT the stored
//      states — the defect this branch exists to close was a stored PRE-retune verdict served
//      next to live-computed cut lines (2026-08-04 painted AMBER with both legs inside their
//      drawn cuts). The seeded states are deliberately wrong so a passthrough regression reds;
//   2. `value`/`delta20`/`decision` still pass through verbatim — cut-independent, and the
//      stored `decision` came from the deep feed this path cannot see;
//   3. the pre-warmup head (shorter than `levelBandHead`) is DROPPED: the scorer
//      emits no reading there, so there is no verdict to draw and no cut to draw it against.
// Every expectation derives from `POINT_BAND_CUTS_OF` / `levelBandHead` / `levelBandValues` /
// `ratioSpreadReadingSeries`; the warmup floor is never restated here.
// The shared wire-cut emission rule every finite-gated `bandCuts` site in api/series.ts routes through:
// the handler tests below pin only that a site's cut reaches the wire; the gap rule is pinned here once.
describe("putFiniteCut", () => {
  test("a finite cut (0 and negatives included) emits its key; null/undefined/NaN/±Infinity leave it ABSENT", () => {
    const out: Record<string, number> = { kept: 1 };
    for (const [key, v] of [
      ["zero", 0],
      ["neg", -0.25],
      ["nul", null],
      ["und", undefined],
      ["nan", NaN],
      ["inf", Infinity],
      ["ninf", -Infinity],
    ] as const) putFiniteCut(out, key, v);
    expect(out).toEqual({ kept: 1, zero: 0, neg: -0.25 });
  });
});

describe("CG per-point band cuts", () => {
  // A ratio-scale series in CG's own magnitude (HG÷GC ≈ 0.0019) so the cut values are the
  // tiny numbers the FE label rule exists for, and strictly varying so the percentiles move.
  const CG_HEAD = levelBandHead(CG_DESCRIPTOR.levelBand);
  const cgRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2011, 7, 2) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "CG",
      value: 0.0019 + 0.0000005 * ((i * 37) % 101),
      delta20: 0.001 * ((i % 7) - 3),
      rawState: (i % 3 === 0 ? "AMBER" : "GREEN") as SeriesResponse["points"][number]["rawState"],
      state: (i % 3 === 0 ? "AMBER" : "GREEN") as SeriesResponse["points"][number]["state"],
      // `+ 1` keeps every non-null decision strictly negative: a `-0` would survive the store
      // but JSON-round-trip to `+0`, and `toEqual` distinguishes the two — a fixture artefact,
      // not the behaviour under test.
      decision: i % 5 === 0 ? null : -0.001 * ((i % 11) + 1),
      // Explicit null = the pre-backfill store: stored-only emission ⇒ these rows serve NO bandCuts key.
      bandCuts: null,
    }));

  /** The production scoring of a fixture, through the REAL lattice — the identity denominator
   *  seam `pointBandCutSeries` uses, never a re-implementation. */
  const scoreRows = (rows: ReturnType<typeof cgRows>) =>
    ratioSpreadReadingSeries(
      CG,
      CG_DESCRIPTOR,
      rows.map((r) => ({ date: r.date, value: r.value })),
      rows.map((r) => ({ date: r.date, value: 1 })),
    );

  test("a history shorter than the warmup floor is unscoreable - ZERO points, not stale ones", async () => {
    const headStore = new InMemoryStore();
    // EXACTLY `levelBandHead` rows: `expandingPercentile` inserts values[i] only AFTER reading
    // the cut, so the buffer first reaches its floor on the row AFTER the last one here. DERIVED
    // — the 2026-08-08 detrend widened that head by the trend window and this fixture moved with
    // it, which is the point of never restating the number.
    const rows = cgRows(CG_HEAD);
    await headStore.recordReadings(rows, RUN_AT);
    // Premise: the scorer really does emit nothing here — otherwise the assertion below pins
    // an empty payload for the wrong reason.
    expect(scoreRows(rows)).toHaveLength(0);
    const res = await withStore(headStore, () =>
      GET(new Request(`https://x/api/series?id=CG&limit=${CG_HEAD}`)),
    );
    const body = (await res.json()) as SeriesResponse;
    expect(body.points).toEqual([]);
  });

  test("past the warmup floor: states are RE-SCORED, value/delta20/decision pass through verbatim", async () => {
    const deepStore = new InMemoryStore();
    const rows = cgRows(CG_HEAD + 40);
    await deepStore.recordReadings(rows, RUN_AT);
    const res = await withStore(deepStore, () =>
      GET(new Request(`https://x/api/series?id=CG&limit=${rows.length}`)),
    );
    const body = (await res.json()) as SeriesResponse;

    // (1) RE-SCORE PROOF — every state is the production scorer's, on the same dates, and the
    // head the scorer cannot reach is absent from the payload entirely.
    const scored = scoreRows(rows);
    expect(body.points.map((p) => [p.date, p.rawState, p.state])).toEqual(
      scored.map((r) => [r.date, r.rawState, r.state]),
    );
    expect(rows.length - body.points.length).toBe(CG_HEAD);
    // Vacuity floor: the SEEDED states must disagree with the scored ones on at least one date,
    // or a passthrough regression satisfies the assertion above.
    const seeded = new Map(rows.map((r) => [r.date, r.state]));
    expect(body.points.filter((p) => seeded.get(p.date) !== p.state).length).toBeGreaterThan(0);

    // (2) PASSTHROUGH PROOF — the cut-independent half of each point still equals its stored row.
    const storedByDate = new Map(rows.map((r) => [r.date, r]));
    expect(body.points.map((p) => [p.value, p.delta20, p.decision ?? null])).toEqual(
      body.points.map((p) => {
        const r = storedByDate.get(p.date)!;
        return [r.value, r.delta20, r.decision ?? null];
      }),
    );

    // (3) NO bandCuts on the wire: these rows seed `bandCuts: null` (the pre-backfill store) and the
    // handler emits ONLY the stored scorer cut — a missing stored cut is a chart GAP, never a recompute.
    // Vacuity floor: the map still DECLARES cuts for CG, so the absence below is stored-null, not map-less.
    expect(POINT_BAND_CUTS_OF.CG!.length).toBeGreaterThan(0);
    for (const p of body.points) expect(p.bandCuts, `bandCuts at ${p.date}`).toBeUndefined();
    expect(body.points.length).toBeGreaterThan(0);
  });

  test("the STORED scorer cut is emitted verbatim: deviation-space substitution, then back-transform", async () => {
    // Seeded in DEVIATION space (the units `Reading.bandCuts` persists for CG's detrended band);
    // the wire value must be the back-transform `(value/(1+dev))·(1+seeded)`, never the raw seed.
    const seeded = { levelAmber: 0.04, levelRed: 0.08 };
    const deepStore = new InMemoryStore();
    const rows = cgRows(CG_HEAD + 40).map((r) => ({ ...r, bandCuts: seeded }));
    await deepStore.recordReadings(rows, RUN_AT);
    const body = (await (
      await withStore(deepStore, () => GET(new Request(`https://x/api/series?id=CG&limit=${rows.length}`)))
    ).json()) as SeriesResponse;
    expect(body.points.length).toBeGreaterThan(0);
    const rawValues = rows.map((r) => r.value);
    const dev = levelBandValues(rawValues, CG_DESCRIPTOR.levelBand);
    const idxByDate = new Map(rows.map((r, i) => [r.date, i]));
    let checked = 0;
    for (const p of body.points) {
      const i = idxByDate.get(p.date)!;
      const d = dev[i]!;
      if (!Number.isFinite(d)) continue;
      const base = rawValues[i]! / (1 + d);
      expect(p.bandCuts?.levelAmber, `@${p.date}`).toBe(base * (1 + seeded.levelAmber));
      expect(p.bandCuts?.levelRed, `@${p.date}`).toBe(base * (1 + seeded.levelRed));
      checked++;
    }
    expect(checked, "some served date must carry the stored-derived cut").toBeGreaterThan(0);
  });

  test("the cut is HISTORY-anchored: a narrow window serves the same cut as a deep one", async () => {
    // The trap this pins: RE-SCORING over the REQUESTED window would make the same date carry a
    // different state at limit=20 than at limit=all (cuts are per-date stored, window-invariant).
    const deepStore = new InMemoryStore();
    const rows = cgRows(CG_HEAD + 40);
    await deepStore.recordReadings(rows, RUN_AT);
    const [deep, narrow] = await withStore(deepStore, async () => [
      (await (await GET(new Request(`https://x/api/series?id=CG&limit=${rows.length}`))).json()) as SeriesResponse,
      (await (await GET(new Request("https://x/api/series?id=CG&limit=20"))).json()) as SeriesResponse,
    ]);
    expect(narrow.points).toHaveLength(20);
    expect(narrow.points).toEqual(deep.points.slice(-20));
  });

  test("the re-score base includes the persisted warmup head — the served ribbon is the cron's verdict", async () => {
    const s = new InMemoryStore();
    // Head: a steady decline ENDING at the readings' level, so its detrended devs sit far below the
    // readings' own — with it in the base, the expanding level cuts drop and near-cut days flip.
    const head = Array.from({ length: CG_HEAD }, (_, i) => ({
      date: new Date(Date.UTC(2011, 7, 2) - (CG_HEAD - i) * 86_400_000).toISOString().slice(0, 10),
      value: 0.0019 * (1 + 0.35 * (1 - i / CG_HEAD)),
    }));
    // Low-amplitude readings (±~0.3%): the 20d-return leg stays GREEN there, so state IS the level leg.
    const rows = cgRows(CG_HEAD + 40).map((r, i) => ({ ...r, value: 0.0019 + 0.0000001 * ((i * 37) % 101) }));
    await s.recordReadings(rows, RUN_AT);
    await s.recordWarmup(head.map((h) => ({ indicatorId: "CG", date: h.date, value: h.value })), RUN_AT);
    const score = (pts: ReadonlyArray<{ date: string; value: number }>) =>
      ratioSpreadReadingSeries(
        CG,
        CG_DESCRIPTOR,
        pts.map((p) => ({ date: p.date, value: p.value })),
        pts.map((p) => ({ date: p.date, value: 1 })),
      );
    const withHead = new Map(score([...head, ...rows]).map((r) => [r.date, r]));
    const withoutHead = new Map(score(rows).map((r) => [r.date, r]));
    // DISCRIMINATION floor: the head must flip at least one commonly-scored day's state, or this
    // fixture could not tell the merged base from the stored-only one.
    const flips = [...withoutHead.keys()].filter((d) => withHead.get(d) !== undefined && withHead.get(d)!.state !== withoutHead.get(d)!.state);
    expect(flips.length).toBeGreaterThan(0);
    const body = (await (
      await withStore(s, () => GET(new Request(`https://x/api/series?id=CG&limit=${rows.length}`)))
    ).json()) as SeriesResponse;
    // Every served state is the WITH-head verdict; the stored-only base would also drop CG_HEAD rows.
    expect(body.points.length).toBe(withHead.size);
    for (const p of body.points) {
      const f = withHead.get(p.date)!;
      expect([p.rawState, p.state], `state at ${p.date}`).toEqual([f.rawState, f.state]);
    }
    for (const d of flips) {
      const p = body.points.find((q) => q.date === d)!;
      expect(p.state, `flipped day ${d}`).toBe(withHead.get(d)!.state);
      expect(p.state, `flipped day ${d}`).not.toBe(withoutHead.get(d)!.state);
    }
  });

  test("a deepened id crosses MAX_LIMIT: the read deepens by the head, no visible row is truncated", async () => {
    // MAX_LIMIT + head stored rows. The visible window is MAX_LIMIT; the read must fetch the head
    // BELOW it so the re-score's own head-burn lands on stored rows, not on visible ones. Reverting
    // the read to bare MAX_LIMIT drops the oldest `head` visible rows (first served slides forward).
    const deepStore = new InMemoryStore();
    const rows = cgRows(MAX_LIMIT + CG_HEAD);
    await deepStore.recordReadings(rows, RUN_AT);
    const body = (await (
      await withStore(deepStore, () => GET(new Request(`https://x/api/series?id=CG&limit=${MAX_LIMIT}`)))
    ).json()) as SeriesResponse;
    expect(body.points).toHaveLength(MAX_LIMIT); // whole visible window served, none eaten by truncation
    expect(body.points[0]!.date).toBe(rows[CG_HEAD]!.date); // first served = first row past the head
    expect(body.points.map((p) => p.date)).toEqual(rows.slice(CG_HEAD).map((r) => r.date));
  });
});


// --- F3 synth band cuts: stored-only emission (Stage 2.2 job 2, recompute tail dropped) ---------
// `attachSynthBandCuts` reads the persisted scorer cut per date VERBATIM; explicit-null stored rows
// (the pre-backfill store) emit NO band key at all — a chart gap, never an on-read recompute.
describe("F3 synth band cuts - stored emitted verbatim, explicit-null gaps", () => {
  const [f3Amber, f3Red] = POINT_BAND_CUTS_OF.F3!;
  // Past PCT_MIN_OBS so the tail's expanding-percentile cuts are measured, not prior fallbacks.
  const N = PCT_MIN_OBS + 60;
  const f3Rows = (bandCuts: Record<string, number> | null) =>
    Array.from({ length: N }, (_, i) => ({
      date: new Date(Date.UTC(2015, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "F3",
      // NFCIRISK-scale, strictly varying so the percentiles (level AND |Δ4| velocity) move.
      value: -0.5 + 0.003 * ((i * 29) % 173),
      delta20: 0,
      rawState: "GREEN" as SeriesResponse["points"][number]["rawState"],
      state: "GREEN" as SeriesResponse["points"][number]["state"],
      decision: null,
      bandCuts,
    }));
  test("STORED cuts are emitted verbatim: the wire serves the seeded map on every point", async () => {
    const SEED = { [f3Amber!.key]: 0.111, [f3Red!.key]: 0.222, [F3_VELOCITY_BAND.key]: 0.055 };
    const rows = f3Rows(SEED);
    const st = new InMemoryStore();
    await st.recordReadings(rows, RUN_AT);
    const body = (await (
      await withStore(st, () => GET(new Request(`https://x/api/series?id=F3&detail=1&limit=${N}`)))
    ).json()) as SeriesResponse;
    expect(body.points.length).toBeGreaterThan(0);
    for (const p of body.points) expect(p.bandCuts, `@${p.date}`).toEqual(SEED);
  });

  test("explicit-null stored cuts: NO band key on any point — a chart gap, never a recompute", async () => {
    const rows = f3Rows(null);
    const st = new InMemoryStore();
    await st.recordReadings(rows, RUN_AT);
    const body = (await (
      await withStore(st, () => GET(new Request(`https://x/api/series?id=F3&detail=1&limit=${N}`)))
    ).json()) as SeriesResponse;
    expect(body.points.length).toBeGreaterThan(0);
    // Vacuity anchor: the STORED-verbatim test above serves keys off this same fixture shape, so an
    // all-absent wire is the stored-null gap, not a fixture that never reaches the attach path.
    expect(POINT_BAND_CUTS_OF.F3!.length).toBeGreaterThan(0);
    for (const p of body.points) expect(p.bandCuts, `@${p.date}`).toBeUndefined();
  });

  // P12.a — the per-vintage synth-history memo on the `detail=1` recompute path. The key is the
  // verdict's `firedAt` (a narrow getLastAlert inside recomputedSeries — /series holds no verdict
  // of its own). Red demo: unwrap the memoByVintage call in recomputedSeries back to a bare
  // `await loadSynthHistories(store)` ⇒ the "still 1 after the second request" assertion reds.
  test("P12.a: the synth bulk read runs ONCE across two detail requests of one vintage, and AGAIN after the vintage changes", async () => {
    let bulkReads = 0; // /series reaches getSeriesBulk ONLY via loadSynthHistories
    class CountingStore extends InMemoryStore {
      override async getSeriesBulk(...args: Parameters<InMemoryStore["getSeriesBulk"]>) {
        bulkReads++;
        return super.getSeriesBulk(...args);
      }
    }
    const st = new CountingStore();
    await st.recordReadings(f3Rows(null), RUN_AT);
    await st.recordAlert(makeAlert({ firedAt: RUN_AT }));
    await withStore(st, async () => {
      expect((await GET(new Request(`https://x/api/series?id=F3&detail=1&limit=${N}`))).status).toBe(200);
      expect(bulkReads).toBe(1); // non-vacuity: the detail path DOES reach the bulk load
      expect((await GET(new Request(`https://x/api/series?id=F3&detail=1&limit=${N}`))).status).toBe(200);
      expect(bulkReads).toBe(1); // same vintage ⇒ served off the memo, no second bulk
      // A new verdict (new firedAt) is the invalidator (nightly cron in prod): the bulk is paid again.
      await st.recordAlert(makeAlert({ firedAt: "2026-06-26T21:00:00.000Z" }));
      expect((await GET(new Request(`https://x/api/series?id=F3&detail=1&limit=${N}`))).status).toBe(200);
      expect(bulkReads).toBe(2);
    });
  });
});


// --- F5 per-point breadth band cuts (2026-08-20 Stage 2b) ----------------------------
// F5/SPCONC draw their dynamic band on a DERIVED series: the per-date cut is `breadthCutSeries` (the
// scorer's own rolling percentile) over the strict-prior `dist` (`breadthDistSeries`), and the PLOTTED
// value is that SAME `dist` — one array feeds both, so line and band can never disagree (R3). No
// `RATIO_DESCRIPTOR_OF` row exists, so the branch does NOT re-score (state passthrough). Every
// expectation is DERIVED from `breadthDistSeries` / `POINT_BAND_CUTS_OF.F5` / `breadthCutSeries`;
// the cut probabilities and the warm-up floor are never transcribed here.
describe("F5/HCX per-point breadth band cuts", () => {
  // A QQQ/QQQE-scale ratio (~1.0) rising with oscillation, long enough that the rolling
  // percentile clears its `HIGH_WINDOW + BREADTH_MAX_CUT_WINDOW` warm-up on the tail — so late points
  // carry BOTH cuts and the moving band actually moves between dates.
  const N = HIGH_WINDOW + BREADTH_MAX_CUT_WINDOW + 60;
  const rowsOf = (id: string) =>
    Array.from({ length: N }, (_, i) => ({
      date: new Date(Date.UTC(2019, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: id,
      value: 1.0 + 0.0004 * i + 0.02 * Math.sin(i / 9),
      delta20: 0,
      // Seeded states are irrelevant to the band (no re-score) but must survive passthrough.
      rawState: "GREEN" as SeriesResponse["points"][number]["rawState"],
      state: "GREEN" as SeriesResponse["points"][number]["state"],
      decision: null,
    }));

  // HCX is the LOW twin: same read-path branch (`BREADTH_DIST_BANDCUT_IDS`), only the direction
  // differs — F5's pair fires highward, HCX's carries no `firesHighward` (the `<p` side). HCX is
  // chart-only (`CHART_ONLY_INDICATORS`), so its row also proves the handler's META gate admits it.
  test.each([
    { id: "F5", highward: true },
    { id: "HCX", highward: false },
  ])("$id: late points plot `dist` and carry both MOVING band-cut keys", async ({ id, highward }) => {
    const rows = rowsOf(id);
    const dist = breadthDistSeries(rows.map((r) => r.value));
    const cuts = POINT_BAND_CUTS_OF[id]!;
    const st = new InMemoryStore();
    await st.recordReadings(rows, RUN_AT);
    const body = await withStore(st, async () =>
      (await (await GET(new Request(`https://x/api/series?id=${id}&limit=${N}`))).json()) as SeriesResponse,
    );
    // Vacuity floor: the map must declare both breadth cuts, or the loops below pin nothing.
    expect(cuts.length).toBe(2);
    expect(cuts.every((c) => (c.firesHighward === true) === highward), "cut direction").toBe(true);

    // (R3) PLOTTED VALUE IS `dist`, not the raw stored ratio — recomputed here from the same pure
    // helper the handler calls, never transcribed. The warm-up head (NaN dist) emits value:null.
    const byDate = new Map(body.points.map((p) => [p.date, p]));
    for (const [i, r] of rows.entries()) {
      const d = dist[i]!;
      expect(byDate.get(r.date)!.value, `value@${r.date}`).toEqual(Number.isFinite(d) ? d : null);
    }
    // A late point past the warm-up carries BOTH keys, each equal to the expanding percentile the
    // map declares (derived, not transcribed).
    const bc = breadthConfig(id);
    const want: Record<string, number> = {};
    for (const c of cuts) {
      const v = breadthCutSeries(dist, c.p, bc.cutWindow, bc.minObs)[N - 1]!;
      if (Number.isFinite(v)) want[c.key] = v;
    }
    expect(Object.keys(want).length, "the tail must be past the warm-up floor").toBe(2);
    expect(body.points.at(-1)!.bandCuts).toEqual(want);

    // A MOVING band, not a constant: the red cut differs between the earliest ranked point and the
    // last. Any two ranked dates whose cut is identical would fail this — the point of R2.
    const ranked = body.points.filter((p) => p.bandCuts?.breadthRed !== undefined);
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked[0]!.bandCuts!.breadthRed).not.toEqual(ranked.at(-1)!.bandCuts!.breadthRed);
  });
});


// --- HCX chained-index splice on read ------------------------------------------------
describe("HCX chained-index splice on read", () => {
  const N = HIGH_WINDOW + BREADTH_MAX_CUT_WINDOW + 60;
  const hcxRows = Array.from({ length: N }, (_, i) => ({
    date: new Date(Date.UTC(2019, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
    indicatorId: "HCX",
    value: 1.0 + 0.0004 * i + 0.02 * Math.sin(i / 9),
    delta20: 0,
    rawState: "GREEN" as SeriesResponse["points"][number]["rawState"],
    state: "GREEN" as SeriesResponse["points"][number]["state"],
    decision: null,
  }));
  // HCX is a CHAINED index (`hcxBasketSeries`, `I_0 = 1` at the fetch window's start), so two cron
  // writers at different depths persist a ~17.75× base cliff inside one 12-mo window. The read path
  // splices it onto the first base BEFORE the dist, and REPORTS the repair on `chainSplices` — a
  // silent heal is the failure mode of this whole approach.
  test("a stored chained-index base break is spliced on read and surfaced via chainSplices", async () => {
    const split = N - 30; // past the 252d warm-up, inside the visible window
    const rows = Array.from({ length: N }, (_, i) => ({
      date: new Date(Date.UTC(2019, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "HCX",
      value: (1.0 + 0.0004 * i + 0.02 * Math.sin(i / 9)) * (i >= split ? 1 / 16 : 1), // a ~16× base DROP at `split`
      delta20: 0,
      rawState: "GREEN" as SeriesResponse["points"][number]["rawState"],
      state: "GREEN" as SeriesResponse["points"][number]["state"],
      decision: null,
    }));
    const st = new InMemoryStore();
    await st.recordReadings(rows, RUN_AT);
    const body = await withStore(st, async () =>
      (await (await GET(new Request(`https://x/api/series?id=HCX&limit=${N}`))).json()) as SeriesResponse,
    );
    // The repair is surfaced, never silent.
    expect(body.chainSplices).toBe(1);
    // UNSPLICED, the post-break points collapse to ≈−0.94 off the trailing (pre-break) high; SPLICED,
    // the plotted dist stays continuous — the split day is nowhere near the cliff.
    const byDate = new Map(body.points.map((p) => [p.date, p]));
    expect(byDate.get(rows[split]!.date)!.value!).toBeGreaterThan(-0.5);
  });

  test("a single-base HCX series needs no splice → chainSplices absent", async () => {
    const st = new InMemoryStore();
    await st.recordReadings(hcxRows, RUN_AT); // the clean fixture above, one base throughout
    const body = await withStore(st, async () =>
      (await (await GET(new Request(`https://x/api/series?id=HCX&limit=${N}`))).json()) as SeriesResponse,
    );
    expect(body.chainSplices).toBeUndefined();
    // The clean fixture's largest daily wiggle is well under the quiet bound, so the sub-threshold
    // surface stays absent too — a healthy payload carries neither field.
    expect(body.maxChainRatio).toBeUndefined();
  });

  // I1: a base cliff BELOW CHAIN_BREAK_RATIO prints a real chart drop but is NOT spliced — chainSplices
  // stays absent AND, before this field, the response reported the rows as healthy. `maxChainRatio` is
  // the surface that reveals it. Step magnitude derived from the constants so a gate retire can't hollow it.
  test("a sub-threshold base cliff → chainSplices absent, maxChainRatio reveals it", async () => {
    const step = (CHAIN_BREAK_RATIO + CHAIN_QUIET_RATIO) / 2; // strictly inside (quiet, break): 2.75×
    expect(step).toBeLessThan(CHAIN_BREAK_RATIO); // premise: no splice
    expect(step).toBeGreaterThan(CHAIN_QUIET_RATIO); // premise: above the emit bound ⇒ visible
    const split = N - 30; // past the 252d warm-up, inside the visible window
    // Flat junction at `split` (value = its predecessor) so the ONLY off-wiggle factor is the base
    // step, exactly `step` — the daily wiggle never reaches the quiet bound.
    const rows = hcxRows.map((r, i) => {
      const base = i === split ? hcxRows[i - 1]!.value : r.value;
      return { ...r, value: i >= split ? base / step : base };
    });
    const st = new InMemoryStore();
    await st.recordReadings(rows, RUN_AT);
    const body = await withStore(st, async () =>
      (await (await GET(new Request(`https://x/api/series?id=HCX&limit=${N}`))).json()) as SeriesResponse,
    );
    expect(body.chainSplices).toBeUndefined(); // correctly NOT a break — the silent gap
    expect(body.maxChainRatio!).toBeCloseTo(step, 2); // but the cliff is now visible on the response
  });
});


// --- BONOS read path (velocity z + a fixed absolute pair, `BONOS_DESCRIPTOR` docblock) -------------------
// BONOS's level leg is a FIXED pair off its thresholds, so the wire carries NO per-point cut. What it does
// carry: the re-score through `COMPOSITE_RESTATE_OF.BONOS` (the served ribbon is the cron's own verdict, never
// the stored column) and the velocity z. Every expectation derives from the map / `oatVelocityZ` /
// `readPathHeadRows`; nothing is restated.
describe("BONOS read path — no per-point cuts, bespoke velocity re-score", () => {
  const BONOS_IND = ALL_INDICATORS.find((i) => i.id === "BONOS")!;
  // A gently oscillating spread with the LAST day jumping — a velocity-RED day the falsifier needs
  // (every level, the jump included, stays under the absolute pair's amber, so only the velocity leg can fire).
  const spreadRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "BONOS",
      value: i === n - 1 ? BONOS_IND.thresholds.amberLevel! - 2 : 40 + 6 * Math.sin(i / 11),
      delta20: 0,
      // Stored state is deliberately GREEN on EVERY row — including the spiked last day — so it
      // CONTRADICTS the re-score; the served ribbon must be the re-score, never this column.
      rawState: "GREEN" as SeriesResponse["points"][number]["rawState"],
      state: "GREEN" as SeriesResponse["points"][number]["state"],
    }));
  const serve = async (rows: ReturnType<typeof spreadRows>) => {
    const s = new InMemoryStore();
    await s.recordReadings(rows, RUN_AT);
    return withStore(s, async () =>
      (await (await GET(new Request(`https://x/api/series?id=BONOS&limit=${rows.length}`))).json()) as SeriesResponse,
    );
  };

  test("serves NO band cuts, state RE-SCORED off the payload past the σ head", async () => {
    const rows = spreadRows(readPathHeadRows("BONOS") + 60);
    const body = await serve(rows);

    // ⛔ NO `bandCuts` ON THE WIRE — no per-DATE cut exists; the pair is a fixed chart line.
    expect(POINT_BAND_CUTS_OF.BONOS).toBeUndefined();
    expect(body.points.every((p) => p.bandCuts === undefined)).toBe(true);

    // BONOS IS re-scored: every served state is the `COMPOSITE_RESTATE_OF` verdict over the payload's OWN
    // bp values — the SAME map the handler routes through. The head (no verdict) is dropped, and the
    // head the read burns is `readPathHeadRows("BONOS")` — the velocity warm-up, nothing else.
    const fresh = new Map(COMPOSITE_RESTATE_OF.BONOS!(BONOS_IND, rows.map((r) => r.value), rows.map((r) => r.date)).map((r) => [r.date, r]));
    expect(body.points.length).toBe(fresh.size);
    expect(rows.length - body.points.length).toBe(readPathHeadRows("BONOS"));
    for (const p of body.points) {
      const f = fresh.get(p.date)!;
      expect(f, `verdict at ${p.date}`).toBeDefined();
      expect([p.rawState, p.state], `state at ${p.date}`).toEqual([f.rawState, f.state]);
    }
    // THE CONTRADICTION: the jumping last day is stored GREEN but fires on re-score (velocity z > zRed).
    expect(body.points.at(-1)!.rawState).toBe("RED");
    // …and the calm day before it is GREEN — the ribbon is not uniformly overruled.
    expect(body.points.at(-2)!.rawState).toBe("GREEN");
  });

  test("velZ is the WINNING z per date — the max of the fast and slow `oatVelocityZ` arms", async () => {
    const rows = spreadRows(readPathHeadRows("BONOS") + 60);
    const body = await serve(rows);
    // Both arms via `oatVelocityZ` (the ONE owner of velFrom + the offset); `off` = the dropped head.
    const c = BONOS_DESCRIPTOR.scorer.constants;
    const values = rows.map((r) => r.value);
    const fast = oatVelocityZ(values, c);
    const slow = oatVelocityZ(values, { ...c, velWindow: c.velSlowWindow });
    const off = rows.length - body.points.length;
    const won = { fast: 0, slow: 0 };
    for (const [i, p] of body.points.entries()) {
      const [f, sl] = [fast[off + i], slow[off + i]];
      const z = f === undefined ? sl : sl === undefined ? f : Math.max(f, sl);
      expect(p.velZ, `velZ at ${p.date}`).toBe(z !== undefined && Number.isFinite(z) ? z : undefined);
      if (f !== undefined && sl !== undefined) won[sl > f ? "slow" : "fast"]++;
    }
    // Discriminating fixture: each arm must WIN some served day, or a one-arm handler passes too.
    expect(won.slow, "the slow arm wins at least one day").toBeGreaterThan(0);
    expect(won.fast, "the fast arm wins at least one day").toBeGreaterThan(0);
  });
});

// R6's chart drew the ABSOLUTE pair alone until 2026-08-30 while `scoreMoveLevel` scored three OR'd
// legs, and `?detail=1` recomputed the ribbon level-only on top of that — so a rolling-band AMBER
// rendered as a GREEN ribbon under a lone 105 line, with MOVE sitting in the 70s. [USER]-reported.
// The percentile leg behind that mismatch was DELETED 2026-09-02, so what is pinned here now is the
// other half plus the deletion's wire consequence: the recompute EXCLUSION still holds (R6 keeps a
// bespoke multi-leg scorer), and NO per-point cut may appear on the wire.
describe("R6 read path — no per-point cuts, bespoke re-score (the two-leg MOVE chart)", () => {
  // The re-score's base is `moveLegBase()` (255, the VELOCITY leg — R6's only warm-up since its
  // percentile level leg was deleted 2026-09-02). Size the fixture off that helper, never a literal:
  // an undersized fixture emits ZERO readings and vacuously passes the length pin.
  const R6_HEAD = moveLegBase();
  const r6 = ALL_INDICATORS.find((i) => i.id === "R6")!;
  // MOVE in its own calm-regime magnitude — oscillating in the 70s, i.e. FAR below the 105 absolute
  // amber, with the last day spiked to 95. Under the deleted percentile leg that spike crossed a
  // moving cut nobody could see; under the live scorer it is the VELOCITY leg that carries it.
  const moveRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "R6",
      value: i === n - 1 ? 95 : 70 + 8 * Math.sin(i / 11),
      delta20: 0,
      // Stored AMBER on EVERY row — a stale vintage that contradicts the drawn cuts on the calm days
      // (the §1 defect, mirrored). The served ribbon must be the two-leg re-score, never this column;
      // a level-only recompute would serve GREEN on the last day (95 < the 105 absolute amber), which
      // the composite arm equally must not do.
      rawState: "AMBER" as SeriesResponse["points"][number]["rawState"],
      state: "AMBER" as SeriesResponse["points"][number]["state"],
    }));

  test("R6 is excluded from the level-only recompute — a bespoke multi-leg scorer is a different model", () => {
    expect(supportsRecompute(r6)).toBe(false);
    // Vacuity floor: the exclusion must be the COMPOSITE-RESTATE clause, not an accident of the others.
    // R6 ships a registry level pair and no `derived` block, so every other term passes. ⚠ Since the
    // 2026-09-02 percentile-leg deletion the `COMPOSITE_LEVEL_BAND_OF` clause no longer reaches R6 —
    // this test is what caught that, so keep the band assertion beside the verdict.
    expect(COMPOSITE_LEVEL_BAND_OF.R6).toBeUndefined();
    expect(COMPOSITE_RESTATE_OF.R6).toBeDefined();
    expect(r6.thresholds.amberLevel).toBeDefined();
    expect(r6.derived).toBeUndefined();
    expect(r6.postInversionCooldown).toBeUndefined();
  });

  test("?detail=1 serves NO band cuts (both level bands deleted), velocity z, state RE-SCORED", async () => {
    const s = new InMemoryStore();
    const rows = moveRows(R6_HEAD + 60);
    await s.recordReadings(rows, RUN_AT);
    const body = await withStore(s, async () =>
      (await (await GET(new Request(`https://x/api/series?id=R6&detail=1&limit=${rows.length}`))).json()) as SeriesResponse,
    );

    // The served ribbon is `COMPOSITE_RESTATE_OF.R6` over the payload's own closes — the SAME
    // two-leg worst-of (velocity ∨ absolute) the cron and backfill score — per date; the head
    // (no verdict) is dropped.
    const fresh = new Map(COMPOSITE_RESTATE_OF.R6!(r6, rows.map((r) => r.value), rows.map((r) => r.date)).map((r) => [r.date, r]));
    expect(body.points.length).toBe(fresh.size);
    for (const p of body.points) {
      const f = fresh.get(p.date)!;
      expect(f, `verdict at ${p.date}`).toBeDefined();
      expect([p.rawState, p.state], `state at ${p.date}`).toEqual([f.rawState, f.state]);
    }
    // THE CONTRADICTION, still: the stale stored AMBER is overruled on the calm days (GREEN on
    // re-score), while the spiked last day still fires — now through the VELOCITY leg, since 95 is
    // under the 105 absolute amber and there is no percentile leg left to carry it.
    expect(body.points.some((p) => p.state === "GREEN")).toBe(true);
    expect(body.points.at(-1)!.rawState).not.toBe("GREEN");

    // ⛔ NO `bandCuts` ON THE WIRE. R6's percentile leg was deleted 2026-09-02 with its
    // `POINT_BAND_CUTS_OF` row, so there is no per-DATE cut to emit — every remaining cut is a
    // registry scalar the chart spec draws from `thresholds`. A reappearing key here means the
    // deleted leg came back half-wired.
    expect(POINT_BAND_CUTS_OF.R6).toBeUndefined();
    expect(body.points.every((p) => p.bandCuts === undefined)).toBe(true);

    // …and the last day is BELOW the absolute pair, which is what makes the assertion above
    // discriminating: the fired state cannot be coming from the level leg.
    const last = body.points.at(-1)!;
    expect(last.value).toBe(95);
    expect(last.value!).toBeLessThan(r6.thresholds.amberLevel!);

    // The velocity leg's z reaches the secondary axis through the SAME `oatVelocityZ` the scorer
    // reads — the membership map (`VELOCITY_Z_CONSTANTS_OF`), which is NOT derived from the band map
    // and so survives the deletion untouched.
    const values = rows.map((r) => r.value);
    const off = rows.length - body.points.length;
    const wantVelZ = oatVelocityZ(values, R6_DESCRIPTOR.scorer.constants);
    for (const [i, p] of body.points.entries()) {
      const z = wantVelZ[off + i];
      expect(p.velZ, `velZ at ${p.date}`).toBe(z !== undefined && Number.isFinite(z) ? z : undefined);
    }
    expect(body.points.filter((p) => p.velZ !== undefined).length).toBeGreaterThan(0);
  });
});
