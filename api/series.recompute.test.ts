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

import { seriesBody, supportsRecompute, lookbackPadFor } from "./series.js";
import { InMemoryStore } from "../src/store-memory.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";
import { makeStoredReading } from "../src/test-helpers.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { indicatorReadingSeries } from "../src/scorers-core.js";
import { resolveCuts } from "../src/domain-cuts.js";
import { cusumParams } from "../src/domain-legs.js";
import type { SeriesResponse } from "../src/api/types.js";
import { SIGMA_REF_KEY } from "../src/family-descriptor-rows.js";
import {
  RUN_AT,
  seedSharedStore,
  R2,
  F1,
  F11,
  F11_N,
  F9,
  F9_SIGMA,
  F9_CUSUM,
  F9_W,
  F9_N,
  f9raw,
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

const serveDetail = async (id: string, limit: number): Promise<SeriesResponse> => {
  const res = await GET(new Request(`https://x/api/series?id=${id}&detail=1&limit=${limit}`));
  return (await res.json()) as SeriesResponse;
};

const servePension = async (s: InMemoryStore, qs: string): Promise<SeriesResponse> =>
  withStore(s, async () => (await (await GET(new Request(`https://x/api/series?${qs}`))).json()) as SeriesResponse);

describe("GET /api/series - ?detail=1 recomputed state ribbon", () => {
  test("recomputes each point's state under the shared/null-row cuts; LOOKBACK_PAD holds at the left edge", async () => {
    // Oracle: recompute over UNBOUNDED history (max pad) with the SAME cell-less cuts the notify
    // path resolves — the endpoint's padded/sliced window must match it at EVERY visible point,
    // incl. the left edge (pad sufficient).
    const calib = await store.getCalibration();
    const cuts = resolveCuts("R2", calib, "HIGH");
    const full = await store.getSeries("R2", 4000);
    const byDate = new Map(
      indicatorReadingSeries(
        R2,
        full.map((p) => ({ date: p.date, value: p.value })),
        cuts,
      ).map((r) => [r.date, r.state]),
    );

    const detail = await serveDetail("R2", 40);
    expect(detail.points).toHaveLength(40);
    for (const p of detail.points) expect(p.state).toBe(byDate.get(p.date));
    // The ramp actually exercises a transition (not a constant ribbon).
    expect(new Set(detail.points.map((p) => p.state)).size).toBeGreaterThan(1);
  });

  test("detail-less call returns the stored shared-state series byte-identical (invariant 2 contract)", async () => {
    const stored = await store.getSeries("R2", 365);
    const { status, body } = await serve("R2");
    expect(status).toBe(200);
    // Minus `bandCuts` (stripStoredCuts) and store-only `runAt` (stripRunAt): both stay off the wire.
    expect(body.points).toEqual(stored.map(({ bandCuts: _s, runAt: _r, ...rest }) => rest));
  });

  test("an out-of-scope indicator ignores ?detail=1 (serves the stored series)", async () => {
    // SPY is bands-less (thresholds {}) ⇒ its ribbon is correctly recompute-invariant, so the
    // flag is ignored rather than producing a bogus all-Green recompute.
    const paramless = await serve("SPY");
    const res = await GET(new Request("https://x/api/series?id=SPY&detail=1"));
    const body = (await res.json()) as SeriesResponse;
    expect(body.points).toEqual(paramless.body.points);
  });

  // F1/F2 were held OUT of the recompute branch by a `!usesProxyZ(...)` term, back when their
  // proxy-z leg needed a BAA10Y fetch this endpoint doesn't do. The 2026-08-06 retirement left no
  // id carrying that leg, so the term went with the rest of the path and the branch OPENS for them — a
  // behavioural EXPANSION, which is what this pins. The two contrast ids keep it from riding an
  // all-true predicate: the other two exclusions (`derived`, GEO-HYBRID) must still bite, or a
  // future edit that neuters the whole guard would leave the F1/F2 half green.
  test("supportsRecompute is true for F1/F2 - the proxy-z exclusion is gone", () => {
    const ind = (id: string) => ALL_INDICATORS.find((i) => i.id === id)!;
    for (const id of ["F1", "F2"]) {
      expect(supportsRecompute(ind(id)), `${id} must recompute`).toBe(true);
    }
    expect(supportsRecompute(ind("F4")), "F4 is `derived` - still excluded").toBe(false);
    expect(supportsRecompute(ind("OVX")), "OVX is GEO-HYBRID - still excluded").toBe(false);
    // Cooldown carriers: the windowed recompute never sees the arming inversion, so its ribbon
    // drops the armed AMBER floor (2026-08-13 — all-green R1 detail ribbon in prod).
    expect(supportsRecompute(ind("R1")), "R1 carries the post-inversion floor - excluded").toBe(false);
    expect(supportsRecompute(ind("R8")), "R8 rides the same cooldown object - excluded").toBe(false);
  });
});


describe("GET /api/series - F1 per-mode recompute (the proxy-z exclusion's response half)", () => {
  test("serves a RECOMPUTED ribbon plus effAmber/effRed/scorerLegs, not the stored shared state", async () => {
    const body = await serveDetail("F1", 40);
    expect(body.points).toHaveLength(40);
    // 1. The ribbon is re-scored: the stored series is all-GREEN, the served one is not.
    const states = new Set(body.points.map((p) => p.state));
    expect(states.size, "the recompute must disagree with the stored all-GREEN lie").toBeGreaterThan(1);
    expect(states).toContain("AMBER");
    // 2. The cut-line scalars ride the envelope — ABSENT on the fallback path this id used to take.
    //    F1 has no CALIB_MAP entry, so the resolved cuts are the registry pair (derived, not typed).
    expect(body.effAmber).toBe(F1.thresholds.amberLevel);
    expect(body.effRed).toBe(F1.thresholds.redLevel);
    // 3. The leg legend names F1's two convention legs (`op` level OR `vel-op` velocity).
    expect(body.scorerLegs).toEqual(["op", "vel-op"]);
    // 4. …and the paramless call is untouched: still the stored shared-state series.
    const paramless = await serve("F1");
    expect(new Set(paramless.body.points.map((p) => p.state))).toEqual(new Set(["GREEN"]));
    expect(paramless.body.effAmber).toBeUndefined();
    expect(paramless.body.scorerLegs).toBeUndefined();
  });

  test("left-edge fidelity at velocityWindow=30: the padded window matches an unbounded-history oracle", async () => {
    // Same oracle as the R2 case above (max pad = the whole stored history), now at w=30 — the
    // regime that had ZERO pad margin until 2026-08-06. F1 resolves no calibration row, so the
    // cell cuts are the registry pair; the oracle re-scores through the SAME production seam.
    const cuts = resolveCuts("F1", await store.getCalibration(), "HIGH");
    const full = await store.getSeries("F1", 4000);
    const byDate = new Map(
      indicatorReadingSeries(F1, full.map((p) => ({ date: p.date, value: p.value })), cuts).map((r) => [
        r.date,
        r.state,
      ]),
    );
    const body = await serveDetail("F1", 40);
    for (const p of body.points) expect(p.state, `@${p.date}`).toBe(byDate.get(p.date));
    // Vacuity: the FIRST visible days are the ones an undersized pad gets wrong, so the window's
    // head must actually carry the elevated state (an all-GREEN head would pass under any pad).
    expect(body.points[0]!.state).toBe("AMBER");
    expect(body.points.at(-1)!.state).toBe("GREEN");
  });
});


describe("GET /api/series - F11 per-mode recompute at velocityWindow=60", () => {
  test("left-edge fidelity at velocityWindow=60: the padded window matches an unbounded-history oracle", async () => {
    // Same oracle shape as the R2 (w=20) and F1 (w=30) cases, now at the widest velocity window on
    // the branch. F11 left the synth seam and no vintage publishes a `fx/dexchus_*` row, so both the
    // oracle and the handler resolve an EMPTY cut set and score off the registry σ pair. Routed
    // through `resolveCuts` anyway so a future CALIB_MAP change moves both sides together.
    const cuts = resolveCuts("F11", await store.getCalibration(), "HIGH");
    const full = await store.getSeries("F11", F11_N * 2);
    const byDate = new Map(
      indicatorReadingSeries(F11, full.map((p) => ({ date: p.date, value: p.value })), cuts).map((r) => [
        r.date,
        r.state,
      ]),
    );
    const body = await serveDetail("F11", 40);
    expect(body.points).toHaveLength(40);
    // EXACT, per point: the pad grants a full estimator window of Δ60s ahead of the first visible
    // point, so the padded read's σ is the same number the unbounded oracle estimates.
    const off: string[] = [];
    for (const p of body.points) {
      const want = byDate.get(p.date)!;
      if (p.state !== want) off.push(`@${p.date}: ${p.state} vs oracle ${want}`);
    }
    expect(
      off.length,
      `the padded ribbon must equal the unbounded oracle on EVERY visible day: ${off.join(", ")}`,
    ).toBe(0);
    // Vacuity, and the exact thing an undersized pad destroys: the σ leg must actually FIRE inside
    // the visible window, and fall back off it once the step leaves the tail's own Δ60 lookback.
    expect(body.points[0]!.state, "the window head must be elevated").not.toBe("GREEN");
    expect(body.points.at(-1)!.state, "the step is out of the tail's lookback").toBe("GREEN");
    // Premise guard: the pad must stay a STRICT subset of the stored history, or the oracle above
    // degenerates into the same array the handler read and the case proves nothing.
    expect(40 + lookbackPadFor(F11), "fixture must out-run the pad").toBeLessThan(F11_N);
    // F11 is speed-only: its CUSUM knobs never resolve, so no point may carry a `cusum` key.
    expect(cusumParams(F11.thresholds.velocitySigma!), "F11 must stay CUSUM-less").toBeUndefined();
    expect(
      body.points.filter((p) => p.cusum !== undefined).map((p) => p.date),
      "a speed-only σ id must emit NO cusum wire key",
    ).toEqual([]);
  });
});


describe("GET /api/series - F9 per-mode recompute with a rolling-σ velocity axis", () => {
  test("left-edge fidelity under the σ-depth pad: the padded window matches an unbounded-history oracle", async () => {
    // F9 left the synth seam 2026-08-08 and no vintage publishes an `fx/dtwexbgs_*` row, so both
    // the oracle and the handler resolve an EMPTY cut set and score off the registry σ pair. Routed
    // through `resolveCuts` anyway so a future CALIB_MAP change moves both sides together.
    const cuts = resolveCuts("F9", await store.getCalibration(), "HIGH");
    const full = await store.getSeries("F9", F9_N * 2);
    const byDate = new Map(
      indicatorReadingSeries(F9, full.map((p) => ({ date: p.date, value: p.value })), cuts).map((r) => [
        r.date,
        r.state,
      ]),
    );
    const body = await serveDetail("F9", 40);
    expect(body.points).toHaveLength(40);
    // ⚠ **EXACT, per point** (§3.5b, 2026-08-09). The pad grants `window + w` of σ depth — a FULL
    // estimator window of Δw values ahead of the first visible point — so the padded read estimates
    // σ over exactly as many deltas as the unbounded oracle does and the two z's are the same
    // number. Before that (`minObs + w`) the padded σ was estimated over fewer deltas and the two
    // z's diverged, so a day whose z landed inside that gap was served one band off; the case then
    // asserted only an adjacent-band bound, which let a QUARTER of the window sit one band off and
    // would pass under a partial pad regression. It is pinned exact here because the contract is
    // now exact, not because the cuts happen to sit far from every visible z: an undersized pad
    // puts visible points below the σ floor (GREEN against an elevated oracle) and reds this line
    // on the first such day. Exact equality subsumes the adjacent-band bound this replaced, so the
    // rank arithmetic is gone rather than kept alongside a strictly stronger assertion.
    const off: string[] = [];
    for (const p of body.points) {
      const want = byDate.get(p.date)!;
      if (p.state !== want) off.push(`@${p.date}: ${p.state} vs oracle ${want}`);
    }
    expect(
      off.length,
      `the padded ribbon must equal the unbounded oracle on EVERY visible day: ${off.join(", ")}`,
    ).toBe(0);
    // Vacuity, and the exact thing an undersized pad destroys: the σ leg must actually FIRE inside
    // the visible window. Under the pre-fix pad every one of these reads GREEN.
    expect(body.points[0]!.state, "the window head must be elevated").not.toBe("GREEN");
    // ⚠ THE TAIL, and the third contract it has carried. Pinned GREEN until 2026-08-08; then
    // NOT-GREEN, because the un-reset accumulator ratcheted past `h` and decayed by only `cusumK`
    // per close, holding the window elevated long after the step left the head's Δ60 lookback.
    // ON-ALARM RESTART (2026-08-09 §3.3; FIR h_red/2 since 2026-08-11) ends that hold by
    // construction: S⁺ restarts BELOW the warning limit the day it fires, so an alarm is a
    // SINGLE-DAY event and the tail falls back to GREEN once the step is out of its own Δ60
    // window (calm closes decay the head-start since k exceeds the in-control median). That is
    // the ruled, accepted consequence of the reset — so the tail is re-pinned to it rather than
    // the fixture being bent to keep the old reading, and this line reds if the accumulator
    // ever ratchets again.
    expect(
      body.points.at(-1)!.state,
      "on-alarm restart ⇒ the alarm cannot persist into the tail",
    ).toBe("GREEN");
    // Premise guard: the pad must stay a STRICT subset of the stored history, or the oracle above
    // degenerates into the same array the handler read and the case proves nothing.
    expect(40 + lookbackPadFor(F9), "fixture must out-run the pad").toBeLessThan(F9_N);
  });

  // §3.5b, 2026-08-09. The fidelity case above is an END-TO-END consequence; this one pins the pad
  // ARITHMETIC directly, so a regression names its own cause instead of surfacing as a drifting band.
  // ⛔ Both sides are DERIVED from the registry σ config — restating 1260/60/312/1320 anywhere here
  // would make the pin blind to exactly the retune it exists to catch.
  test("the σ pad admits a FULL estimator window of deltas, not merely the emit floor", () => {
    // A pad of P leading observations yields P − w usable Δw values ahead of the first visible
    // point (a Δw costs `w` leading observations). `velocitySigmaZSeries` estimates σ over up to
    // `window` historical deltas, so the chart matches the scorer only when that many are reachable.
    const deltasAheadOfFirstVisible = lookbackPadFor(F9) - F9_W;
    expect(
      deltasAheadOfFirstVisible,
      "the pad must reach the estimator WINDOW, not just `minObs`",
    ).toBeGreaterThanOrEqual(F9_SIGMA.window);
    // Vacuity anchor, and the red demo's target: the OLD expression (`minObs + w`) must FAIL this
    // bound, or the assertion would pass on the very defect it is here to catch. `minObs < window`
    // is what makes the two expressions distinguishable at all — a config that ever set them equal
    // would silently hollow this test, so the gap is pinned rather than assumed.
    expect(F9_SIGMA.minObs, "premise: the emit floor sits BELOW the estimator window").toBeLessThan(
      F9_SIGMA.window,
    );
    // Reconstructed as a DELTA off the live pad — the σ term is the only part that moved, so this
    // needs neither the margin nor the velocity arm restated here.
    const oldPad = lookbackPadFor(F9) - (F9_SIGMA.window - F9_SIGMA.minObs);
    expect(oldPad - F9_W, "the retired `minObs + w` pad must NOT clear the window").toBeLessThan(
      F9_SIGMA.window,
    );
  });
});


// The MOVING velocity cut line (`withSigmaBandCuts`, Stage 3 ruling 6). The wire keys were pinned
// by the chart SPEC and the golden, but no test had ever asserted an emitted VALUE — so the
// alignment the emitter depends on (`sigma[i - VELOCITY_WINDOW]`, the GLOBAL 20, NOT F9's own 60)
// was unguarded, and reading F9's own window there silently slides every drawn cut by `w - VELOCITY_WINDOW` days.
describe("GET /api/series - F9 per-day σ band cuts", () => {
  /**
   * INDEPENDENT ORACLE for σ at observation index `i`, transcribed from the CONTRACT in
   * `velocitySigmaZSeries`' docblock (sample SD of the STRICTLY historical Δw values at delta
   * indices `j ∈ [max(w, i − cfg.window), i − 1]`, `undefined` below `minObs` or at a degenerate
   * scale) — a naive O(n·window) scan, not a second copy of the shipped prefix-sum implementation.
   * Every parameter is read off the registry, so an F9 retune moves the oracle with the emitter.
   */
  const oracleSigma = (values: number[], i: number): number | undefined => {
    const ds: number[] = [];
    for (let j = Math.max(F9_W, i - F9_SIGMA.window); j <= i - 1; j++) ds.push(values[j]! - values[j - F9_W]!);
    if (ds.length < F9_SIGMA.minObs) return undefined;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const variance = ds.reduce((a, b) => a + (b - mean) ** 2, 0) / (ds.length - 1);
    return variance > 0 ? Math.sqrt(variance) : undefined;
  };

  test("every emitted bandCut equals σ(t) × the registry multiple; the warm-up head carries NO key", async () => {
    // Ask for the WHOLE fixture so the handler's anchored read (`points.length + lookbackPadFor`,
    // ending at the last point's date) necessarily spans all of `f9raw` — `cfg.window` is a CAP,
    // so a shallower read would legitimately produce a different σ and the oracle could not be
    // stated over the fixture array alone.
    const res = await GET(new Request(`https://x/api/series?id=F9&limit=${F9_N}`));
    const body = (await res.json()) as SeriesResponse;
    // Premise: the served span IS the fixture, in order — the oracle indexes by position.
    expect(body.points.map((p) => p.date)).toEqual(f9raw.map((o) => o.date));

    const values = f9raw.map((o) => o.value);
    const amber = F9.thresholds.amberVelocity!;
    const red = F9.thresholds.redVelocity!;
    const sigmaOf = body.points.map((p, i) => ({ p, s: oracleSigma(values, i) }));
    const omitted = sigmaOf.filter(({ s }) => s === undefined);
    const drawn = sigmaOf.flatMap(({ p, s }) => (s === undefined ? [] : [{ p, s }]));
    // OMIT, never 0 — a 0 would paint a false cut along the axis' zero line.
    for (const { p } of omitted) expect(p.bandCuts, `@${p.date} pre-warmup must carry no bandCuts key at all`).toBeUndefined();
    for (const { p, s } of drawn) {
      const cuts = p.bandCuts;
      expect(cuts, `@${p.date}`).toBeDefined();
      expect(cuts!.velSigmaAmber, `@${p.date} amber`).toBeCloseTo(s * amber, 10);
      expect(cuts!.velSigmaRed, `@${p.date} red`).toBeCloseTo(s * red, 10);
    }
    // Vacuity, both directions: the fixture must straddle the σ warm-up boundary, or one arm of
    // the assertion above never runs and the offset stops being discriminating.
    expect(drawn.length, "some date must carry a drawn cut").toBeGreaterThan(0);
    expect(omitted.length, "the warm-up head must exist").toBeGreaterThan(0);
    // F9 declares no `dualAxis.refSigma` ⇒ the display-only reference key never rides its wire.
    expect(body.points.filter((p) => p.bandCuts?.[SIGMA_REF_KEY] !== undefined)).toEqual([]);
  });

  // Stage C (2026-08-09): the SAME overlay pass also emits the day's CUSUM accumulator `S⁺` for
  // the secondary axis. Both overlays fold the one deep read, so they are defined on exactly the
  // same days — which is what makes "cusum present ⇔ bandCuts present" a real alignment pin and
  // not a restatement of the emitter.
  test("`cusum` rides the same anchored read: present exactly where σ is, omitted (never 0) elsewhere", async () => {
    const res = await GET(new Request(`https://x/api/series?id=F9&limit=${F9_N}`));
    const body = (await res.json()) as SeriesResponse;
    for (const p of body.points) {
      // z and σ are undefined TOGETHER (`velocitySigmaZSeries` pushes both or neither), and the
      // accumulator emits `undefined` on an undefined z — so the two keys must co-occur exactly.
      expect(p.cusum !== undefined, `@${p.date} cusum/bandCuts must co-occur`).toBe(p.bandCuts !== undefined);
    }
    const withCusum = body.points.flatMap((p) => (p.cusum === undefined ? [] : [{ date: p.date, cusum: p.cusum }]));
    const withoutCusum = body.points.filter((p) => p.cusum === undefined);
    for (const p of withCusum) {
      expect(Number.isFinite(p.cusum), `@${p.date}`).toBe(true);
      expect(p.cusum, `@${p.date} S⁺ is non-negative by construction`).toBeGreaterThanOrEqual(0);
    }
    // Vacuity, both arms: the fixture must straddle the σ warm-up boundary.
    expect(withCusum.length, "some date must carry an S⁺ reading").toBeGreaterThan(0);
    expect(withoutCusum.length, "the warm-up head must omit the key entirely").toBeGreaterThan(0);
    // ...and the emitted series must actually MOVE — an all-zero S⁺ (the shape a broken z read or
    // a `?? 0` fallback produces) would satisfy every assertion above.
    expect(new Set(body.points.map((p) => p.cusum).filter((v) => v !== undefined)).size).toBeGreaterThan(1);
    // The step in the fixture drives the accumulator over the leg's own bound at least once, so
    // the drawn `h` band has something to be crossed by. Bound read off the ONE reader of `cusumH`.
    const h = F9_CUSUM.alarm;
    expect(body.points.some((p) => (p.cusum ?? 0) >= h), "S⁺ must reach `h` somewhere in the window").toBe(true);
  });

  // `S⁺` folds from the head of whatever the handler read (`points.length + lookbackPadFor`), so a
  // shallow and a deep read agree on the shared dates only while the σ pad covers the fold's lead-in.
  // ⛔ Bit-equality, never a tolerance — both reads run the same recurrence over the same z.
  test("read depth does not move S⁺ - the σ pad covers the fold's lead-in", async () => {
    const shallow = (await (await GET(new Request("https://x/api/series?id=F9&limit=40"))).json()) as SeriesResponse;
    const deep = (await (
      await GET(new Request(`https://x/api/series?id=F9&limit=${F9_N}`))
    ).json()) as SeriesResponse;
    const deepByDate = new Map(deep.points.map((p) => [p.date, p]));
    // Premise: the two reads really do differ in depth while sharing the tail dates.
    expect(shallow.points).toHaveLength(40);
    expect(deep.points.length).toBeGreaterThan(shallow.points.length * 2);
    let cusumDiffs = 0;
    let compared = 0;
    for (const p of shallow.points) {
      const d = deepByDate.get(p.date)!;
      expect(d, `@${p.date} must exist in both reads`).toBeDefined();
      expect(p.state, `@${p.date} state must not depend on read depth`).toBe(d.state);
      if (p.cusum === undefined && d.cusum === undefined) continue;
      compared++;
      if (p.cusum === undefined || d.cusum === undefined || Math.abs(p.cusum - d.cusum) > 1e-9) cusumDiffs++;
    }
    expect(compared, "the shared window must carry S⁺ on both sides").toBeGreaterThan(0);
    expect(cusumDiffs, `S⁺ differed on ${cusumDiffs}/${compared} shared dates between read depths`).toBe(0);
  });
});


// The display-only `?mult=` what-if multiplier at the wire edge (2026-07-15 threshold-multiplier
// design, Stage 4). The seeded R2 recomputes on the ?detail=1 branch, so this pins the
// ENVELOPE contract (garbage⇒OFF, off-grid⇒400 no-store (P12.b), echo, omission). The composition
// math itself (earlierCut on the resolved cuts) is proved against the engine in src/threshold-config.
describe("GET /api/series - ?mult what-if multiplier", () => {
  const raw = async (q: string): Promise<{ status: number; text: string; body: SeriesResponse }> => {
    const res = await GET(new Request(`https://x/api/series?${q}`));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as SeriesResponse };
  };
  const CELL = "id=R2&detail=1&limit=40";

  test("absent ⇒ byte-identical payload, and no `mult` field", async () => {
    const base = await raw(CELL);
    expect(base.status).toBe(200);
    expect(base.body.mult).toBeUndefined();
  });

  test("invalid input resolves to OFF - never a 400, byte-identical to absent", async () => {
    const base = await raw(CELL);
    for (const bad of ["abc", "", "-5", "0", "NaN", "Infinity"]) {
      const res = await raw(`${CELL}&mult=${encodeURIComponent(bad)}`);
      expect(res.status, `mult=${bad} must not 400`).toBe(200);
      expect(res.text, `mult=${bad} must be OFF`).toBe(base.text);
    }
  });

  test("echoes an on-grid multiplier; off-grid is a 400 no-store, never clamped (P12.b)", async () => {
    expect((await raw(`${CELL}&mult=1`)).body.mult).toBe(1);
    expect((await raw(`${CELL}&mult=0.75`)).body.mult).toBe(0.75);
    // Rejected, not clamped — a clamp still minted a fresh caller-selectable edge-cache key per
    // distinct raw value (`?mult=0.51`, `?mult=0.52`, …) with the full recompute behind every
    // MISS. The client (public/app.js) snaps to the grid before emitting, so no shipped URL 400s.
    for (const off of ["0.6", "0.1", "2.5", "3", "1e9"]) {
      const res = await GET(new Request(`https://x/api/series?${CELL}&mult=${off}`));
      expect(res.status, `mult=${off} must 400`).toBe(400);
      expect(res.headers.get("Cache-Control"), `mult=${off} must be no-store`).toBe("no-store");
    }
  });

  test("omitted on the detail-less path - the stored series was never touched", async () => {
    // No ?detail=1 ⇒ no recompute branch ⇒ nothing to shift. Echoing here would badge an
    // untouched payload. `mult` is inert on detail-less reads by exactly this construction.
    const res = await raw("id=R2&mult=0.75&limit=40");
    expect(res.status).toBe(200);
    expect(res.body.mult).toBeUndefined();
  });

  test("m≠1 actually MOVES the effective-cut band values vs unset (real applyMult→scaleCuts seam)", async () => {
    // R2 resolves a real shared/null-row velocity operative pair (0.1/0.2). A HIGH-firing
    // multiplier m>1 loosens (moves the velocity cuts UP), so effAmber/effRed must strictly rise
    // vs the unset payload — proving the what-if executes end-to-end through the shared transform,
    // not just echoes a badge. (m=1.5, above 1.0, keeps the payload well inside the clamp band.)
    const base = await raw(CELL);
    const loosened = await raw(`${CELL}&mult=1.5`);
    expect(loosened.body.mult).toBe(1.5);
    expect(typeof base.body.effAmber).toBe("number");
    expect(typeof loosened.body.effAmber).toBe("number");
    // Velocity cuts are highward ⇒ m>1 moves them UP (later-firing).
    expect(loosened.body.effAmber!).toBeGreaterThan(base.body.effAmber!);
    expect(loosened.body.effRed!).toBeGreaterThan(base.body.effRed!);
    // And the moved band actually re-colours the ribbon (fewer/equal elevated cells once looser).
    const elevated = (b: SeriesResponse) => b.points.filter((p) => p.state !== "GREEN").length;
    expect(elevated(loosened.body)).toBeLessThanOrEqual(elevated(base.body));
    expect(elevated(base.body)).toBeGreaterThan(0); // the base cell actually has colour to lose
  });
});

describe("GET /api/series - oilEst serves the STORED `estimated` tail, any id (estimateSlot)", () => {
  const P_1 = "2026-06-22";
  const P0 = "2026-06-23"; // newest stored FINAL print
  const D1 = "2026-06-24"; // the one anchored estimate session
  const row = (id: string, date: string, value: number, estimated = false) => makeStoredReading(id, { date, value, estimated });
  const seed = async (rows: ReturnType<typeof row>[], runAt = RUN_AT) => {
    const s = new InMemoryStore();
    await s.recordReadings(rows, runAt);
    return s;
  };

  test("a non-oil id (R2) with an estimated tail serves oilEst too, fromDate = its newest final", async () => {
    const s = await seed([row("R2", P_1, 4.1), row("R2", P0, 4.2), row("R2", D1, 4.35, true)]);
    const body = await servePension(s, "id=R2");
    expect(body.oilEst).toEqual({ date: D1, value: 4.35, fromDate: P0 });
  });
});
