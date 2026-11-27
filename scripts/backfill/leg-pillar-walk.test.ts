import { describe, it, expect, beforeAll } from "vitest";
import {
  replayLegPillars,
  legPillarBasis,
  LEG_PILLAR_GENERATOR,
} from "./leg-pillar-walk.js";
import { LEG_PILLAR_GENERATOR as LIVE_GENERATOR } from "../../src/leg-percentile.js";
import type { SeriesPoint } from "../../src/store.js";

/** A tiny synthetic series: `n` consecutive weekday-ish dates at `state`, EXCEPT the last
 *  `TAIL_LEN`, which turn RED with rising values.
 *
 *  ⚠ The tail is LOAD-BEARING, not decoration. A constant series replays identically on every
 *  date, so a leaked (module-scope) cursor — the exact defect the per-call-cursor test below
 *  claims to catch — would still return identical rows and that test could never fail. Only a
 *  series the walk must resolve POSITIONALLY makes a spent cursor observable.
 *  Calibration is still not the point here (that control arm is `probe:ew --check-reference`). */
const TAIL_LEN = 10;
function fakeSeries(n: number, state: SeriesPoint["state"]): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const tail = i >= n - TAIL_LEN;
    const s: SeriesPoint["state"] = tail ? "RED" : state;
    pts.push({ date: d, value: tail ? 1 + (i - (n - TAIL_LEN)) : 1, delta20: 0, rawState: s, state: s });
  }
  return pts;
}

describe("replayLegPillars", () => {
  // ONE per-call-cursor run pair, shared by both tests below. `CLOSES` is the minimum window that
  // STRADDLES the GREEN→RED tail (40 points, TAIL_LEN=10 RED): the window is the last `CLOSES`
  // dates, so it holds `CLOSES − TAIL_LEN` GREEN dates and needs ≥1 (arithmetic floor 11); 12 keeps
  // a 2-GREEN margin. A window entirely inside the RED tail makes a spent module-scope cursor —
  // the defect the second test catches — indistinguishable from the correct walk.
  const CLOSES = 12;
  const series = fakeSeries(40, "GREEN");
  const deps = { store: { getSeries: async () => series } };
  let a: Awaited<ReturnType<typeof replayLegPillars>>;
  let b: Awaited<ReturnType<typeof replayLegPillars>>;
  beforeAll(async () => {
    a = await replayLegPillars(deps, { closes: CLOSES });
    b = await replayLegPillars(deps, { closes: CLOSES });
  });

  it("is callable with an injected fake store — no module-scope store or argv, and emits shaped rows", () => {
    expect(a.length).toBeGreaterThan(0);
    const dates = new Set(a.map((r) => r.date));
    expect(dates.size).toBe(CLOSES);
    const sgs = new Set(a.map((r) => r.superGroup));
    expect(sgs).toEqual(new Set(["EARLY-WARN", "STRESS-NOW"]));
    for (const r of a) {
      expect(typeof r.sleeve).toBe("string");
      expect(typeof r.estimated).toBe("boolean");
      expect(r.basis.length).toBeGreaterThan(0);
    }
  });

  it("uses a per-call cursor: two calls in one process return identical rows", () => {
    // The window STRADDLES the GREEN→RED tail, so the walk has to resolve each date's position: a
    // spent module-scope cursor would pin every date to the last point and the second call's rows
    // would come back all-RED.
    expect(b).toEqual(a);
    // Non-vacuity guard for the line above: the replay must actually VARY across the window, or
    // "identical rows" is satisfiable by a cursor that never moved.
    const dates = [...new Set(a.map((r) => r.date))];
    const strip = (d: string) => a.filter((r) => r.date === d).map(({ date: _d, ...rest }) => rest);
    expect(strip(dates[0]!)).not.toEqual(strip(dates.at(-1)!));
  });
});

describe("legPillarBasis", () => {
  it("differs across super-groups and lists sorted member ids", () => {
    const ew = legPillarBasis("EARLY-WARN");
    const sn = legPillarBasis("STRESS-NOW");
    expect(ew).not.toBe(sn);
    for (const b of [ew, sn]) {
      const ids = b.split(",");
      expect(ids.length).toBeGreaterThan(1);
      expect([...ids].sort()).toEqual(ids);
    }
  });
});

describe("generator re-export", () => {
  it("re-exports the LIVE generator", () => {
    // W4 Stage 4.4 retired the `"ew-v0"` literal that used to be pinned here: the vintage is now a
    // hash over the pillar-formula constants, pinned as a literal nowhere (the `stale-basis` read
    // arm catches a moved vintage). Re-typing it here would be a second source that drifts, so
    // this pins the only claim this module owns — the writer's re-export IS the reader's value.
    expect(LEG_PILLAR_GENERATOR).toBe(LIVE_GENERATOR);
  });
});
