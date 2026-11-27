/**
 * Exposure-replay engine (E2 Stage 5) — SYNTHETIC-series mechanics only: posture
 * transitions, FIRE splice integrity, the windowed-vs-full-prefix equivalence pin,
 * degrade edges, and price rounding/forward-fill. Never pins a tuning constant's
 * value (exposure.ts's constants are provisional; E2 is the retuning instrument).
 */
import { describe, expect, it } from "vitest";
import {
  ARM_LEVEL_PCT,
  ARM_MIN_OBS,
  ARM_RANGE_WINDOW,
  ARM_RELEASE_PCT,
  ARM_ROC_BP,
  ARM_ROC_WINDOW,
  FIRE_MA_APPROACH_SPREAD,
  computeExposure,
} from "./exposure.js";
import { GT } from "./registry-composite.js";
import { resolvedDerivedBands } from "./scorers-core.js";
import type { SeriesPoint } from "./store.js";
import type { Observation } from "./domain-types.js";
import {
  EPISODES,
  buildFireSeries,
  exposureReplayNotes,
  fireSpliceDate,
  replayExposure,
  GSPC_PROVENANCE_NOTE,
  FIRE_RAW_SPREAD_NOTE,
} from "./exposure-replay.js";

/** A maSpread cushion clear of BOTH GT's resolved band (which FIRE consumes since CORE-B4)
 *  and its pre-alert mark — derived, so a GT retune moves the fixtures with the rule. */
const GT_CLEAR = resolvedDerivedBands(GT).amber! + FIRE_MA_APPROACH_SPREAD + 0.01;

/** Sequential daily ISO dates from 2000-01-01 (weekends included — a synthetic axis). */
function isoDate(i: number): string {
  return new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10);
}

/** Observation[] from raw closes, oldest→newest, on the sequential axis (offset shifts the start). */
function obs(values: number[], offset = 0): Observation[] {
  return values.map((value, i) => ({ date: isoDate(i + offset), value }));
}

/** SeriesPoint[] for the ARM leg — only `value`/`date` are read by computeArm. */
function f1Series(values: number[], offset = 0): SeriesPoint[] {
  return values.map((value, i) => ({
    date: isoDate(i + offset),
    value,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
  }));
}

/** SeriesPoint[] for the FIRE leg — computeFire reads only the last point's `decision`. */
function fireSeries(decisions: number[], offset = 0): SeriesPoint[] {
  return decisions.map((decision, i) => ({
    date: isoDate(i + offset),
    value: 100 + i, // stand-in close; price echoes this
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
    decision,
  }));
}

describe("EPISODES table", () => {
  it("carries the decided set (E3 Decision 5) with the required shape", () => {
    expect(EPISODES.filter((e) => e.candidate)).toEqual([]); // eyeball decided — no open candidates
    // Chronological picker order (eyeball feedback Rung C1): oldest episode first.
    for (let i = 1; i < EPISODES.length; i++) {
      expect(EPISODES[i - 1]!.start < EPISODES[i]!.start).toBe(true); // ISO strings sort chronologically
    }
    for (const e of EPISODES) {
      expect(e.start <= e.end).toBe(true); // ISO strings sort chronologically
      expect(e.rationale.length).toBeGreaterThan(0);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
});

describe("buildFireSeries", () => {
  it("splices at ACWI's first full-MA reading, never mixing the two price series", () => {
    // gspc closes ~4000 (dates 0..259); acwi closes ~70 (dates 60..319).
    const gspc = obs(
      Array.from({ length: 260 }, (_, i) => 4000 + (i % 5)),
      0,
    );
    const acwi = obs(
      Array.from({ length: 260 }, (_, i) => 70 + (i % 5)),
      60,
    );
    const splice = fireSpliceDate(acwi);
    expect(splice).not.toBeNull();

    const fire = buildFireSeries(gspc, acwi);

    // ascending, unique dates.
    const dates = fire.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);

    // Every pre-splice point comes from ^GSPC (~4000), every at/after point from ACWI (~70).
    const pre = fire.filter((p) => p.date < splice!);
    const post = fire.filter((p) => p.date >= splice!);
    expect(pre.length).toBeGreaterThan(0);
    expect(post.length).toBeGreaterThan(0);
    for (const p of pre) expect(p.value).toBeGreaterThan(1000);
    for (const p of post) expect(p.value).toBeLessThan(1000);
    // The splice boundary is exactly ACWI's first reading date.
    expect(fire.find((p) => p.date >= splice!)!.date).toBe(splice);
  });

  it("falls back to all ^GSPC when ACWI is too short for any MA reading", () => {
    const gspc = obs(Array.from({ length: 260 }, (_, i) => 4000 + (i % 5)));
    const acwi = obs(Array.from({ length: 100 }, (_, i) => 70 + (i % 5)), 60); // < MA_WINDOW
    expect(fireSpliceDate(acwi)).toBeNull();

    const fire = buildFireSeries(gspc, acwi);
    expect(fire.length).toBeGreaterThan(0);
    for (const p of fire) expect(p.value).toBeGreaterThan(1000); // all ^GSPC scale
  });
});

describe("replayExposure - windowed vs full-prefix equivalence", () => {
  // The equivalence pin and the latch pin below consume the SAME deadband fixture and the SAME
  // 900-point full-prefix computeExposure walk — memoized lazily so the dominant loop runs once (2026-08-15 §9 SPEED).
  const DEADBAND_N = 900;
  let deadbandMemo: {
    f1: SeriesPoint[];
    fire: SeriesPoint[];
    full: ReturnType<typeof computeExposure>[];
  } | null = null;
  const deadband = () => {
    if (!deadbandMemo) {
      // Ramp to a peak, then decline slowly enough that rank sits in the deadband:
      // each close is under the window max (no raw arm) but above the ramp's low tail
      // (holds the release cut), so the latch carries back many steps.
      const f1vals = Array.from({ length: DEADBAND_N }, (_, i) =>
        i < 300 ? 1.0 + i * (4 / 300) : 5.0 - (i - 300) * 0.002,
      );
      const fireDec = Array.from({ length: DEADBAND_N }, (_, i) =>
        i < 500 ? 0.05 : 0.05 - (i - 500) * 0.001,
      );
      const f1 = f1Series(f1vals);
      const fire = fireSeries(fireDec);
      const full = Array.from({ length: DEADBAND_N }, (_, i) =>
        computeExposure(f1.slice(0, i + 1), fire.slice(0, i + 1)),
      );
      deadbandMemo = { f1, fire, full };
    }
    return deadbandMemo;
  };

  /**
   * The equivalence pin, on a deadband fixture rather than a monotone ramp. A ramp makes
   * every close its own window maximum (rank 1.0 everywhere), so a truncated slice still
   * ranks the same; this fixture's ranks depend on the whole trailing window, so
   * windowed-vs-full-prefix agreement is a real constraint. The fixture outruns
   * ARM_RANGE_WINDOW + slack, so the bounded slice truly cuts. It does NOT pin the slice's slack (a slack-sized shrink stays green here) —
   * the single-day latch test below pins it to ≥ ARM_ROC_WINDOW − 4.
   *
   * ⚠ It pins ONLY that equivalence. It says nothing about the ARM latch's depth or even
   * its presence: both sides of the comparison run the same `scanArmLatch`, so an
   * equivalence framing can never observe the latch. The latch is pinned directly by
   * "arms days the raw rule does not" below.
   */
  it("gives the same posture/armed/fired as a full-prefix computeExposure at every day, where rank depends on the whole window", () => {
    const { f1, fire, full: fullByIdx } = deadband();

    const points = replayExposure(f1, fire, { start: isoDate(0), end: isoDate(DEADBAND_N - 1) });
    expect(points).toHaveLength(DEADBAND_N);
    const byDate = new Map(f1.map((p, i) => [p.date, i]));
    for (const pt of points) {
      const i = byDate.get(pt.date)!;
      const full = fullByIdx[i]!;
      expect({ date: pt.date, armed: pt.armed, fired: pt.fired, posture: pt.posture }).toEqual({
        date: pt.date,
        armed: full.arm.armed,
        fired: full.fire.fired,
        posture: full.posture,
      });
    }
    // The fixture actually exercises multiple postures (not a degenerate all-null run).
    expect(new Set(points.map((p) => p.posture)).size).toBeGreaterThan(1);

    // Vacuity guard: the fixture must actually ARM somewhere, else "equivalent"
    // is the trivial both-false agreement and the latch is untested.
    expect(points.some((p) => p.armed)).toBe(true);
  });

  it("keeps full rank windows through ARM_ROC_WINDOW latch steps - pins slack >= ARM_ROC_WINDOW - 4", () => {
    // Head + R prior closes rank just above the release cut; close R+1 back raw-arms; less slack truncates those ranks below it.
    const W = ARM_RANGE_WINDOW;
    const R = ARM_ROC_WINDOW;
    const high = Math.floor((1 - ARM_RELEASE_PCT) * W);
    const n = W + R + 40;
    const f1 = f1Series(Array.from({ length: n }, (_, i) => (i >= n - 1 - R ? 5 : i >= n - 1 - R - high ? 10 : 1)));
    const fire = fireSeries(Array<number>(n).fill(0.05));
    const day = isoDate(n - 1);
    const [pt] = replayExposure(f1, fire, { start: day, end: day });
    const full = computeExposure(f1, fire);
    // Premise: the head is latch-only (deadband rank, no raw ROC), else this pins nothing.
    expect(full.arm.percentile).toBeGreaterThanOrEqual(ARM_RELEASE_PCT);
    expect(full.arm.percentile).toBeLessThan(ARM_LEVEL_PCT);
    expect(full.arm.roc).toBeLessThan(ARM_ROC_BP);
    expect(full.arm.armed).toBe(true);
    expect({ armed: pt!.armed, posture: pt!.posture }).toEqual({ armed: true, posture: full.posture });
  });

  /**
   * The DIRECT latch pin — the thing no equivalence test can express. On the deadband
   * fixture there must exist many days where ARM is on while the day's OWN metrics do not
   * raw-arm (rank below `ARM_LEVEL_PCT`, ROC below `ARM_ROC_BP`): those days are armed by
   * the latch carrying back to an earlier raw arm and nothing else.
   *
   * Goes RED if `scanArmLatch` is reduced to `isRawArmed(head)` (count collapses to 0) and
   * RED on a monotone-ramp fixture (every close ranks 1.0 ⇒ raw-armed ⇒ count 0) — both
   * demonstrated 2026-07-20.
   */
  it("arms days the raw rule does not - the latch alone carries them", () => {
    const { full } = deadband();

    let rawArmedDays = 0;
    let latchOnlyDays = 0;
    for (let i = 0; i < DEADBAND_N; i++) {
      const { arm } = full[i]!;
      if (arm.degraded) continue;
      // Mirror of exposure.ts's (unexported) isRawArmed, over the HEAD day's own metrics.
      const raw =
        (arm.percentile !== null && arm.percentile >= ARM_LEVEL_PCT) ||
        (arm.roc !== null && arm.roc >= ARM_ROC_BP);
      if (raw) rawArmedDays++;
      else if (arm.armed) latchOnlyDays++;
    }

    // Both regimes present: the fixture raw-arms at the peak, then holds in the deadband.
    expect(rawArmedDays).toBeGreaterThan(0);
    // Substantial, not incidental — the latch carries ARM across a deadband run.
    // ⚠ The floor SCALES WITH THE DEADBAND WIDTH and is therefore retuned, not fitted: this
    // fixture decays the rank at a fixed rate, so the run's length is set by how long the head
    // spends inside `[ARM_RELEASE_PCT, ARM_LEVEL_PCT)`. At the pre-2026-07-31 cut 0.60 (band
    // 0.25 wide) it measured >50; the tighten to 0.80 (band 0.05, 5× narrower) measures 18.
    // 10 keeps the discriminating power intact — BOTH red demos in the docblock above collapse
    // the count to 0, not to a number near the floor.
    expect(latchOnlyDays).toBeGreaterThan(10);
  });
});

describe("replayExposure - posture transitions", () => {
  it("walks Full -> Reduced -> Defensive as FIRE fires then ARM arms", () => {
    const warm = ARM_MIN_OBS + 10; // clear the degrade floor before the window opens
    const phaseA = 20; // calm credit + trend up  -> Full
    const phaseB = 20; // calm credit + trend down -> Reduced (1 key)
    const phaseC = 40; // credit ramps up + trend down -> Defensive (2 keys)

    const f1vals = [
      ...Array<number>(warm + phaseA + phaseB).fill(1.0), // flat = calm
      ...Array.from({ length: phaseC }, (_, i) => 1.0 + (i + 1) * 0.1), // ramp arms ROC/level
    ];
    const fireDec = [
      ...Array<number>(warm + phaseA).fill(GT_CLEAR), // cushion clear of GT's cut -> quiet
      ...Array<number>(phaseB + phaseC).fill(-0.05), // below GT's red -> fired
    ];
    const f1 = f1Series(f1vals);
    const fire = fireSeries(fireDec);

    const window = { start: isoDate(warm), end: isoDate(f1vals.length - 1) };
    const points = replayExposure(f1, fire, window);

    // Consecutive distinct postures over the window.
    const runs = points
      .map((p) => p.posture)
      .filter((p, i, a) => i === 0 || p !== a[i - 1]);
    // K5: phase A is quiet with neither key approaching, so the opening posture is Full.
    expect(runs).toEqual(["Full", "Reduced", "Defensive"]);
    expect(points[0]!.posture).toBe("Full");
    expect(points.at(-1)!.posture).toBe("Defensive");
  });
});

describe("replayExposure - degrade edge", () => {
  it("marks every day degraded (posture null) when the ARM prefix never clears ARM_MIN_OBS", () => {
    const short = 100; // < ARM_MIN_OBS
    const f1 = f1Series(Array<number>(short).fill(1.0));
    const fire = fireSeries(Array<number>(short).fill(0.05));
    const points = replayExposure(f1, fire, { start: isoDate(0), end: isoDate(short - 1) });

    expect(points).toHaveLength(short);
    for (const p of points) {
      expect(p.degraded).toBe(true);
      expect(p.posture).toBeNull();
    }
    expect(ARM_RANGE_WINDOW).toBeGreaterThan(short); // sanity: the slice can't backfill obs
  });
});

describe("replayExposure - price", () => {
  it("rounds to 2dp and forward-fills the fire close on an F1-only union day", () => {
    const f1 = f1Series([1, 1, 1], 0); // dates 0,1,2
    const fire: SeriesPoint[] = [
      { date: isoDate(0), value: 12.345, delta20: 0, rawState: "GREEN", state: "GREEN", decision: 0.1 },
      { date: isoDate(2), value: 88.0, delta20: 0, rawState: "GREEN", state: "GREEN", decision: 0.1 },
    ];
    const points = replayExposure(f1, fire, { start: isoDate(0), end: isoDate(2) });

    const byDate = new Map(points.map((p) => [p.date, p]));
    expect(byDate.get(isoDate(0))!.price).toBe(12.35); // rounded
    expect(byDate.get(isoDate(1))!.price).toBe(12.35); // F1-only day -> forward-filled fire[0]
    expect(byDate.get(isoDate(2))!.price).toBe(88.0);
  });
});

describe("exposureReplayNotes", () => {
  it("adds the ^GSPC provenance note when the window opens before the splice, always the raw-spread note", () => {
    const e2002 = EPISODES.find((e) => e.id === "2002")!; // opens 2002 — before any 2009 splice
    const e2020 = EPISODES.find((e) => e.id === "2020")!; // opens 2019 — after the splice
    expect(exposureReplayNotes(e2002, "2009-01-05")).toEqual([GSPC_PROVENANCE_NOTE, FIRE_RAW_SPREAD_NOTE]);
    expect(exposureReplayNotes(e2020, "2009-01-05")).toEqual([FIRE_RAW_SPREAD_NOTE]);
    // Null splice (ACWI unavailable) → provenance note still applies.
    expect(exposureReplayNotes(e2020, null)).toEqual([GSPC_PROVENANCE_NOTE, FIRE_RAW_SPREAD_NOTE]);
  });
});
