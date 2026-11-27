import { describe, expect, test } from "vitest";
import type { TermPoint } from "./vix_term.js";
import type { Observation } from "./domain-types.js";
import type { Store } from "./store.js";
import { TRACKS, drainDegradeLog, resetDegradeLog, type TrackCtx } from "./tracks.js";
import { BOTTOM_TIER } from "./bottom_tier.js";
import {
  BOTTOM_DEFAULTS,
  BOTTOM_STATE_RANK,
  type BottomParams,
  MIN_BOTTOM_OBS,
  bottomRawStateSeries,
  computeBottomVerdict,
  scoreBottom,
} from "./bottom.js";

/** Build a TermPoint series from parallel vix / ratio arrays (vix3m = vix / ratio). */
const series = (vix: number[], ratio: number[]): TermPoint[] =>
  vix.map((v, i) => ({ date: String(i), vix: v, vix3m: v / ratio[i]!, ratio: ratio[i]! }));

/** `n` copies of `v`. */
const rep = (n: number, v: number): number[] => Array<number>(n).fill(v);

describe("bottom-state rules (§3.2)", () => {
  test("CALM: low VIX, contango ratio - nothing to see", () => {
    const s = series(rep(25, 15), rep(25, 0.85));
    expect(bottomRawStateSeries(s).every((x) => x === "CALM")).toBe(true);
    expect(scoreBottom(s)).toBe("CALM");
  });

  test("CAPITULATION-WATCH: VIX ≥ cap AND backwardation, still elevated (no rollover)", () => {
    // Flat-high VIX can never roll over (vix ≤ 0.9×vix is false), so this stays a
    // pure WATCH — acute panic active, not yet receding.
    const s = series(rep(25, 45), rep(25, 1.1));
    expect(bottomRawStateSeries(s).every((x) => x === "CAPITULATION-WATCH")).toBe(true);
    expect(scoreBottom(s)).toBe("CAPITULATION-WATCH");
  });

  test("BOTTOM-FORMING: capitulation reached, then spot rollover + term-structure easing", () => {
    // Calm → spike (VIX 50, ratio 1.2 = backwardation) → recede (VIX rolls off the
    // 10d high, ratio eases back below 1.0). Both facets recede → bottom forming.
    const vix = [
      ...rep(10, 15),
      42, 48, 52, 50, 47, 44, // 10-15 capitulation spike
      40, 37, 34, 32, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, // 16-29 rollover
    ];
    const ratio = [
      ...rep(10, 0.85),
      1.05, 1.15, 1.2, 1.18, 1.1, 1.05, // 10-15 backwardation
      0.98, 0.95, 0.92, 0.9, 0.88, 0.87, 0.86, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, // 16-29 easing
    ];
    const s = series(vix, ratio);
    const verdict = computeBottomVerdict(s);
    expect(verdict.state).toBe("BOTTOM-FORMING");
    expect(verdict.rawState).toBe("BOTTOM-FORMING");
    expect(verdict.asOf).toBe("29");
    expect(verdict.vix).toBe(21);
    expect(verdict.ratio).toBeCloseTo(0.85, 10);
    expect(scoreBottom(s)).toBe("BOTTOM-FORMING");
  });

  test("BOTTOM-FORMING via easedDelta alone: term structure leads spot (§2)", () => {
    // The headline §2 case: the curve un-inverts BEFORE spot fully normalises. Across
    // every scored day here the ratio stays ≥ BACKWARD_CUT (1.05) — so the
    // `ratioNow < BACKWARD_CUT` easing branch is FALSE throughout — yet it has dropped
    // ≥ EASE_DELTA over EASE_CLOSES days, so easedDelta is the SOLE enabler.
    // This also guards against a reversed subtraction in easedDelta (which would make
    // easing false and suppress every BOTTOM-FORMING here). Note the first scored day
    // (VIX=40 ≥ cap 35, ratio=1.20 ≥ cut 1.05) is ALSO in the capitulation zone, so this
    // doubles as the coexistence case: BOTTOM-FORMING outranks CAPITULATION-WATCH.
    const vix = [...rep(10, 15), ...rep(5, 52), 46, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35];
    const ratio = [...rep(10, 0.85), ...rep(5, 1.25), 1.35, 1.32, 1.29, 1.26, 1.23, 1.2, 1.17, 1.14, 1.11, 1.08, 1.05];
    const s = series(vix, ratio);
    expect(s).toHaveLength(26);
    const raw = bottomRawStateSeries(s);
    expect(raw.every((x) => x === "BOTTOM-FORMING")).toBe(true); // every scored day, ratio ≥ 1.05
    expect(scoreBottom(s)).toBe("BOTTOM-FORMING");
  });
});

describe("dual-facet falling-knife guard (§2) - ONE facet alone never forms a bottom", () => {
  test("rollover WITHOUT term-structure easing → never BOTTOM-FORMING", () => {
    // Capitulation + a steep VIX rollover, but the curve stays backwarded (ratio flat
    // ≥ 1.0): fear hasn't drained from the near term → not a bottom.
    const vix = [...rep(10, 15), ...rep(5, 50), 42, 40, 38, 36, 34, 32, 30, 28, 26, 24];
    const ratio = rep(25, 1.1);
    expect(bottomRawStateSeries(series(vix, ratio))).not.toContain("BOTTOM-FORMING");
  });

  test("term-structure easing WITHOUT a prior capitulation → never BOTTOM-FORMING", () => {
    // A calm-market dip from a sub-cap (VIX < cap 35) high with easing ratio: never
    // entered the capitulation zone, so a re-risk hint would be a false positive.
    const vix = [...rep(10, 15), ...rep(5, 33), 30, 28, 26, 24, 22, 20, 18, 17, 16, 15];
    const ratio = [...rep(15, 0.95), ...rep(10, 0.85)];
    expect(bottomRawStateSeries(series(vix, ratio))).not.toContain("BOTTOM-FORMING");
  });
});

describe("confirmation buffer (CONFIRM_CLOSES reuse)", () => {
  // Flat VIX=45 (never rolls over) with a ratio toggle drives a clean CALM↔WATCH raw
  // series, isolating the buffer from the rollover/easing rules.
  test("a one-day WATCH head-fake at the end stays CALM", () => {
    const ratio = [...rep(24, 0.85), 1.1]; // raw tail: CALM,CALM,CALM,CALM,WATCH (1 day)
    expect(scoreBottom(series(rep(25, 45), ratio))).toBe("CALM");
  });

  test("two consecutive WATCH closes confirm WATCH", () => {
    const ratio = [...rep(23, 0.85), 1.1, 1.1]; // raw tail: …,WATCH,WATCH (2 days)
    expect(scoreBottom(series(rep(25, 45), ratio))).toBe("CAPITULATION-WATCH");
  });
});

describe("guards & ranking", () => {
  test("scoreBottom throws below MIN_BOTTOM_OBS", () => {
    expect(() => scoreBottom(series(rep(MIN_BOTTOM_OBS - 1, 15), rep(MIN_BOTTOM_OBS - 1, 0.85)))).toThrow(
      /need/,
    );
  });

  test("computeBottomVerdict degrades a short/empty feed to CALM (never throws)", () => {
    expect(computeBottomVerdict([]).state).toBe("CALM");
    expect(computeBottomVerdict(series(rep(5, 15), rep(5, 0.85))).state).toBe("CALM");
  });

  test("ranks are strictly ascending for notify-on-upward-change", () => {
    expect(BOTTOM_STATE_RANK.CALM).toBeLessThan(BOTTOM_STATE_RANK["CAPITULATION-WATCH"]);
    expect(BOTTOM_STATE_RANK["CAPITULATION-WATCH"]).toBeLessThan(BOTTOM_STATE_RANK["BOTTOM-FORMING"]);
  });
});

describe("Stage-7 parameterization - overrides shift the rule", () => {
  test("a higher vixCap suppresses a fire the default would emit", () => {
    // VIX flat at 45 + backwardation = WATCH under the default cap (35) — the exact series the
    // CAPITULATION-WATCH rule test pins; raise the cap above 45 and the same series never enters
    // the capitulation zone → all CALM.
    const s = series(rep(25, 45), rep(25, 1.1));
    const stricter: BottomParams = { ...BOTTOM_DEFAULTS, vixCap: 50 };
    expect(bottomRawStateSeries(s, stricter).every((x) => x === "CALM")).toBe(true);
    expect(scoreBottom(s, stricter)).toBe("CALM");
  });

  test("a higher backwardCut withholds the capitulation zone (ratio no longer 'backwarded enough')", () => {
    // VIX 45 + ratio flat 1.05: WATCH under the default cut (1.05). Raise backwardCut above
    // 1.05 and the ratio no longer clears it → never in the cap zone → all CALM. Proves the
    // backwardCut field is wired (not transposed with another axis).
    const s = series(rep(25, 45), rep(25, 1.05));
    expect(scoreBottom(s)).toBe("CAPITULATION-WATCH");
    const stricter: BottomParams = { ...BOTTOM_DEFAULTS, backwardCut: 1.1 };
    expect(bottomRawStateSeries(s, stricter).every((x) => x === "CALM")).toBe(true);
  });

  test("a looser rolloverK lets a shallow rollover form a bottom the default would miss", () => {
    // Capitulation (VIX 52, ratio 1.2) then a SHALLOW recede to 47 (only 0.90× the 52 high)
    // with the ratio easing below 1.05. The default rolloverK=0.9 needs VIX ≤ 0.9×52=46.8,
    // so 47 does NOT roll over → no BOTTOM-FORMING. Loosen rolloverK to 0.95 (≤ 49.4) and the
    // same shallow recede now qualifies → BOTTOM-FORMING. Proves rolloverK is wired.
    const vix = [...rep(10, 15), ...rep(6, 52), ...rep(10, 47)];
    const ratio = [...rep(10, 0.85), ...rep(6, 1.2), 1.05, 1.0, 0.97, ...rep(7, 0.95)];
    const s = series(vix, ratio);
    expect(bottomRawStateSeries(s)).not.toContain("BOTTOM-FORMING");
    const looser: BottomParams = { ...BOTTOM_DEFAULTS, rolloverK: 0.95 };
    expect(bottomRawStateSeries(s, looser)).toContain("BOTTOM-FORMING");
  });

  test("a non-default bundle with highWin > lookback throws (window-ordering guard)", () => {
    const s = series(rep(25, 45), rep(25, 1.1));
    const bad: BottomParams = { ...BOTTOM_DEFAULTS, highWin: BOTTOM_DEFAULTS.lookback + 1 };
    expect(() => bottomRawStateSeries(s, bad)).toThrow(/highWin/);
    const badEase: BottomParams = { ...BOTTOM_DEFAULTS, easeCloses: BOTTOM_DEFAULTS.lookback + 1 };
    expect(() => bottomRawStateSeries(s, badEase)).toThrow(/easeCloses/);
  });
});

/**
 * Regression pin for the stale-VIX mis-dating bug (2026-07-19).
 * `tracks.ts` stamped the RUN's FRED-driven `asOf` onto the vix-term feed's latest
 * point, so a lagging vix-term tail persisted an old close under a date it
 * never belonged to — prod wrote 2026-07-10's values under obs_date 2026-07-17 three
 * times running, silently and with no degrade entry. The rows must carry the feed's
 * OWN latest aligned date (`BottomVerdict.asOf`).
 *
 * Vacuity guard: the fixture's feed date (07-10) and the run's asOf (07-17) DIFFER, so
 * flipping `v.asOf` back to the `asOf` parameter turns this red. Verified by mutation.
 */
describe("bottom track storedSeries - dates rows by the FEED, not the run", () => {
  /** Daily closes on the given ISO dates. */
  const obs = (dates: string[], value: number): Observation[] => dates.map((date) => ({ date, value }));

  const FEED_LATEST = "2026-07-10";
  /** MIN_BOTTOM_OBS consecutive days ending FEED_LATEST — the shortest history that scores a verdict. */
  const FEED_DATES = Array.from({ length: MIN_BOTTOM_OBS }, (_, i) =>
    new Date(Date.parse(FEED_LATEST) - (MIN_BOTTOM_OBS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const RUN_ASOF = "2026-07-17"; // FRED-driven, a full week AHEAD of the lagging feed

  const bottomTrack = TRACKS.find((t) => t.baselineField === "bottomState")!;

  test("a feed lagging the run's asOf persists the feed's date, and keeps the leg", async () => {
    const ctx = {
      store: {} as Store, // the bottom track never touches the store
      qqq: [],
      vixFront: obs(FEED_DATES, 15.03),
      vix3mBack: obs(FEED_DATES, 18.57),
      runAt: `${RUN_ASOF}T22:00:00.000Z`,
      env: {},
    } satisfies TrackCtx;

    const scored = await bottomTrack.score(ctx);
    const rows = [...scored.storedSeries(RUN_ASOF).values()].map((s) => s.at(-1)!);

    expect(rows.map((r) => r.indicatorId).sort()).toEqual(["VIX", "VIX3M"]);
    // The whole point: NOT RUN_ASOF.
    expect(rows.every((r) => r.date === FEED_LATEST)).toBe(true);
    expect(rows.some((r) => r.date === RUN_ASOF)).toBe(false);
    // A lagging feed is the normal weekend/holiday case — the leg stays live.
    expect(rows.find((r) => r.indicatorId === "VIX")?.value).toBe(15.03);
    expect(rows.find((r) => r.indicatorId === "VIX3M")?.value).toBe(18.57);
  });

  test("delta20 is computed over the real aligned history, not pinned to 0", async () => {
    // Review I-1: the builder was handed a ONE-element array, so its `i >= 20` branch was
    // unreachable and every live-written date carried delta20 0 forever — unrepairable,
    // because backfillBottom skips any date the live path already wrote. 25 points with a
    // +1/day ramp ⇒ the latest row's delta20 must be exactly 20.
    const dates = Array.from({ length: 25 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
    const ctx = {
      store: {} as Store,
      qqq: [],
      vixFront: dates.map((date, i) => ({ date, value: 10 + i })),
      vix3mBack: dates.map((date, i) => ({ date, value: 20 + i })),
      runAt: `${RUN_ASOF}T22:00:00.000Z`,
      env: {},
    } satisfies TrackCtx;

    const rows = [...(await bottomTrack.score(ctx)).storedSeries(RUN_ASOF).values()].map((s) => s.at(-1)!);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.date === dates.at(-1))).toBe(true);
    expect(rows.find((r) => r.indicatorId === "VIX")?.delta20).toBe(20);
    expect(rows.find((r) => r.indicatorId === "VIX3M")?.delta20).toBe(20);
  });

  test.each([
    ["an empty leg", [], obs(FEED_DATES, 18.57)],
    ["non-empty legs with zero overlapping dates", obs(FEED_DATES, 20), obs(["2026-03-02", "2026-03-03"], 20)],
    ["an aligned history one short of MIN_BOTTOM_OBS", obs(FEED_DATES.slice(1), 20), obs(FEED_DATES.slice(1), 18)],
  ])("%s ⇒ a null verdict + a [bottom] degrade event, never an indistinguishable CALM", async (_, vixFront, vix3mBack) => {
    expect(MIN_BOTTOM_OBS).toBeGreaterThan(1);
    resetDegradeLog();
    const scored = await bottomTrack.score({ store: {} as Store, qqq: [], vixFront, vix3mBack, runAt: "2026-07-17T22:00:00.000Z", env: {} });
    expect(scored.alertFields).toEqual({ bottomState: null, vix: null, vix3m: null, ratio: null });
    expect(scored.notification(null, RUN_ASOF).push).toBe(false);
    expect(scored.storedSeries(RUN_ASOF).size).toBe(0);
    expect(drainDegradeLog().map((e) => e.scope)).toEqual(["[bottom] vix-term track unavailable - bottom verdict null this run"]);
  });

  test("the ntfy body captions the levels with the FEED's date too (review I-2)", () => {
    const v = {
      state: "CALM" as const,
      rawState: "CALM" as const,
      vix: 15.03,
      vix3m: 18.57,
      ratio: 15.03 / 18.57,
      asOf: FEED_LATEST,
    };

    const body = BOTTOM_TIER.body(v, "header", RUN_ASOF);

    expect(body).toContain(`as of ${FEED_LATEST}`);
    expect(body).not.toContain(RUN_ASOF);
  });
});
