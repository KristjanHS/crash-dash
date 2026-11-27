import { describe, expect, it } from "vitest";
import { guardAnchor, HALF, hybridBreak, hybridCut, hybridLine, openShockStart, shockOf, SHOCK_LOW_N, shockSince, speedAt, VOL_COOL, VOL_K, volNormal } from "./ladder-shock.js";
import { episodes, REPLAY, type Pt } from "./ladder-replay.js";
import { calm, RATIO_TROUGH, ratioBounce, ratioWave, spreadWave, VOL_PEAK, VOL_PRE_MEDIAN, volShock } from "./ladder-replay.test-helpers.js";

/** A retired plan Stage 1.1 — latest period, close ≤ base / fresh crossing, anchor = lowest of the SHOCK_LOW_N closes before the crossing. */
const K = { BASE_N: 20, SIGMA_N: 60, BROKE_SD: 3 };
const t0 = Date.parse("2020-01-01T00:00:00Z");
const dateAt = (i: number): string => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
const series = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: dateAt(i), value }));
/** `n` closes alternating `lo` (even index) / `hi` (odd), indexed from `from` so the parity is the absolute index's. */
const zig = (from: number, n: number, lo: number, hi: number): number[] => Array.from({ length: n }, (_, k) => ((from + k) % 2 ? hi : lo));
const rep = (x: number, n: number): number[] => Array.from({ length: n }, () => x);

/** 70 calm closes 79/81 (base 80, 3σ ≈ 6), wave 1 to 150 ×10 (closes 70–79), 79/81 again ×40 (80–119), wave 2 to 130 ×10 (120–129). */
const TWO_WAVE = series([...zig(0, 70, 79, 81), ...rep(150, 10), ...zig(80, 40, 79, 81), ...rep(130, 10)]);

describe("shockOf — the latest shock period", () => {
  it("the anchor window is the SHOCK_LOW_N closes before the crossing: a lower close SHOCK_LOW_N back anchors, one further back does not", () => {
    const X = 2 * (SHOCK_LOW_N + K.SIGMA_N) + 80;
    const dipAt = (k: number): Pt[] => series([...zig(0, X, 79, 81).map((x, i) => (i === k ? 78 : x)), 150]);
    expect([shockOf(dipAt(X - SHOCK_LOW_N), K)!.start, shockOf(dipAt(X - SHOCK_LOW_N - 1), K)!.start]).toEqual([dateAt(X - SHOCK_LOW_N), dateAt(X - 2)]);
  });

  it("two waves: the shock anchors on wave 2 — its start, its base, its peak (130, not wave 1's 150)", () => {
    const sh = shockOf(TWO_WAVE, K)!;
    // wave 2 crosses at close 120; the lowest of closes 60–119 is 79, latest at 118
    expect([sh.start, sh.open, sh.base, sh.peak, sh.peakDate, sh.last]).toEqual([dateAt(118), true, 80, 130, dateAt(120), 130]);
  });

  it("a close ≤ base closes the period; a fresh crossing after it opens a new one", () => {
    const before = shockOf(TWO_WAVE.slice(0, 120), K)!;
    // wave 1 anchored at its last 79 (close 68); close 80 = 79 ≤ base 80 closed it — still the latest period, peak 150
    expect([before.start, before.open, before.base, before.peak]).toEqual([dateAt(68), false, 80, 150]);
    expect(shockOf(TWO_WAVE.slice(0, 80), K)!.open, "open through wave 1").toBe(true);
    expect([shockOf(TWO_WAVE, K)!.start, shockOf(TWO_WAVE, K)!.open]).toEqual([dateAt(118), true]);
  });

  it("stale trend: a step to a new level never back to base keeps the period open; a fresh crossing from the new level replaces it", () => {
    // 79/81 ×70, a step to 99/101 for closes 70–199 (never ≤ 80), then 130 ×5 from close 200
    const s = series([...zig(0, 70, 79, 81), ...zig(70, 130, 99, 101), ...rep(130, 5)]);
    const stale = shockOf(s.slice(0, 200), K)!;
    expect([stale.start, stale.open, stale.base, stale.peak]).toEqual([dateAt(68), true, 80, 101]);
    const fresh = shockOf(s, K)!;
    // the crossing at 200 anchors on the lowest of closes 140–199: 99, latest at 198; base = the new level's median, 100
    expect([fresh.start, fresh.open, fresh.base, fresh.peak]).toEqual([dateAt(198), true, 100, 130]);
  });

  it("a series that never crosses base + BROKE_SD σ — or is too short to read — returns null", () => {
    const calm = series(zig(0, 200, 79, 81));
    // a step of 6.0 sits just under 3σ (σ = 2·√(60/59) ≈ 2.017 → 3σ ≈ 6.05): no period
    const under = series([...zig(0, 70, 79, 81), ...rep(86, 20)]);
    expect([shockOf(calm, K), shockOf(under, K), shockOf(TWO_WAVE.slice(0, SHOCK_LOW_N), K), shockOf([], K)]).toEqual([null, null, null, null]);
    expect(shockOf(series([...zig(0, 70, 79, 81), ...rep(86.1, 20)]), K), "a tick over 3σ opens one").not.toBeNull();
  });

  it("closedAt = the close ≤ base that closed the period, null while open; shockSince drops only a period closed before the exit", () => {
    const closed = TWO_WAVE.slice(0, 120);
    expect([shockOf(closed, K)!.closedAt, shockOf(TWO_WAVE.slice(0, 80), K)!.closedAt, shockOf(TWO_WAVE, K)!.closedAt]).toEqual([dateAt(80), null, null]);
    expect([shockSince(closed, K, dateAt(81)), shockSince(closed, K, dateAt(80))?.closedAt, shockSince(TWO_WAVE, K, dateAt(125))?.start]).toEqual([null, dateAt(80), dateAt(118)]);
  });

  it("memoized prefixes read the same as a fresh copy of the series", () => {
    const copy = (n: number): Pt[] => TWO_WAVE.slice(0, n).map((p) => ({ ...p }));
    shockOf(TWO_WAVE, K);
    for (const n of [61, 75, 85, 119, 120, 125]) expect(shockOf(TWO_WAVE.slice(0, n), K), `prefix ${n}`).toEqual(shockOf(copy(n), K));
  });
});

describe("speedAt — the max window starts at the series' own Shock.start", () => {
  it("wave 1's bigger Δ5 sits before wave 2's start, so the max is wave 2's", () => {
    const c = TWO_WAVE;
    const i = c.length - 1;
    const sh = shockOf(c, K)!;
    // Δ5 at 121 and 123 = 130 − 79 = 51 (latest on a tie: 123); wave 1's Δ5 = 150 − 79 = 71 at closes ≤ 74
    expect(speedAt(c, i, { SPEED_N: 5 }, sh.start)).toEqual({ d: 0, max: 51, maxDate: dateAt(123) });
    expect(speedAt(c, i, { SPEED_N: 5 }, dateAt(68)).max, "from wave 1's anchor the max is wave 1's").toBe(71);
  });
});

describe("openShockStart — the sliding-reference anchor", () => {
  /** Dated 2010 — before REPLAY.FROM, so a FROM filter would hide every episode. calm() ends on its high at H. */
  const H = REPLAY.VOL_N;
  const day = (i: number): string => dateAt(i - 3650);
  const px = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: day(i), value }));
  /** 95 exits off calm's 100; 96 is past RISE off that low (ends it); the restart's σ carries the −5% return, so 90 exits again; 96 ends that one. */
  const FULL = px([...calm(), 95, 96, 90, 89, 96, ...calm(5)]);
  it("premise: two episodes, the first ended, both before REPLAY.FROM", () => {
    expect(episodes(FULL, { ...REPLAY, FROM: "" }).map((e) => [e.shockStart, e.exit, e.end, e.open])).toEqual([[day(H), day(H + 1), day(H + 2), false], [day(H + 2), day(H + 3), day(H + 5), false]]);
    expect(episodes(FULL)).toEqual([]);
  });
  it("open from its exit close to the close before its end; null before the exit and from the end close on", () => {
    const at = (n: number) => openShockStart(FULL.slice(0, n).map((p) => ({ ...p })));
    expect([H + 1, H + 2, H + 3, H + 4, H + 5, H + 6].map(at)).toEqual([null, day(H), null, day(H + 2), day(H + 2), null]);
  });
  it("prefix reads off the memoized full walk, and `asOf`, equal a fresh walk of each prefix", () => {
    openShockStart(FULL);
    const got = FULL.map((_, n) => [openShockStart(FULL.slice(0, n + 1)), openShockStart(FULL, FULL[n]!.date)]);
    const fresh = FULL.map((_, n) => openShockStart(FULL.slice(0, n + 1).map((p) => ({ ...p }))));
    expect(got).toEqual(fresh.map((x) => [x, x]));
    expect(new Set(fresh), "vacuity: both anchors and a null").toEqual(new Set([null, day(H), day(H + 2)]));
  });
});

describe("volNormal — vol-normal rungs", () => {
  const N = 250;
  const at = (tail: number[]) => volNormal(series(volShock(tail)), K, N)!;
  const cut = VOL_K * VOL_PRE_MEDIAN;
  const line = (1 - VOL_COOL) * VOL_PEAK;

  it("premise: the fixture's VIX opens its own shock (real `shockOf`) — anchored on close 298, peak 40, still open", () => {
    const sh = shockOf(series(volShock([cut - 0.01])), K)!;
    expect([sh.start, sh.open, sh.peak]).toEqual([dateAt(298), true, VOL_PEAK]);
  });

  it("shock open: the median of the N closes strictly before Shock.start (20), not the rolling one (34); cut = VOL_K × it", () => {
    const n = at([cut - 0.01]);
    expect([n.anchored, n.median, n.n, n.cut, n.shock?.start]).toEqual([true, VOL_PRE_MEDIAN, N, cut, dateAt(298)]);
  });

  it("cooling: last ≤ (1 − VOL_COOL) × peak and falling ×2 — at the line met, a tick over not; one fall (or a flat step) not", () => {
    expect([at([31, 30.5, line]), at([31, 30.5, line + 0.01]), at([30.5, 30.5, line]), at([31, line, line])].map((n) => n.cooling)).toEqual([true, false, false, false]);
    expect(at([cut - 0.01]).cooling, "under the cut, the step from a rising 34→36 is one fall").toBe(false);
  });

  it("no shock open → the rolling median of the last N closes, cooling off", () => {
    const closed = volNormal(series(volShock([31, 30.5, 19])), K, N)!;
    expect([closed.shock?.open, closed.anchored, closed.median, closed.cooling]).toEqual([false, false, 34, false]);
    const none = volNormal(series(Array.from({ length: 300 }, (_, i) => (i % 2 ? 21 : 19))), K, N)!;
    expect([none.shock, none.anchored, none.median, none.n]).toEqual([null, false, VOL_PRE_MEDIAN, N]);
  });

  it("the window keeps its length and ends at the anchor: one pre-anchor close short of N → n = N − 1; empty → null", () => {
    expect(volNormal(series(volShock([cut - 0.01])).slice(298 - N + 1), K, N)?.n).toBe(N - 1);
    expect(volNormal([], K, N)).toBeNull();
  });
});

describe("hybrid guards — HALF line since the series' own shock", () => {
  /** spreadWave: calm 79/81, wave 1 at 150 (close 70), a hold at 100 ×25 (closes 71–95), then the tail from close 96. */
  const [PEAK, HOLD] = [150, 100];
  const LINE = HOLD + HALF * (PEAK - HOLD);
  const wave = (tail: number[]): Pt[] => series(spreadWave(80, 1, PEAK, HOLD, tail));
  const at = (tail: number[]) => ((c) => hybridBreak(c, c.length - 1, "high", guardAnchor(c, true, K)))(wave(tail));

  it("premise: the spread's own shock is open, anchored on close 68 (before wave 1)", () => {
    expect([shockOf(wave([LINE]), K)?.open, guardAnchor(wave([LINE]), true, K)]).toEqual([true, dateAt(68)]);
  });

  it("wave 2: a tick short of turn + HALF·(ext − turn) holds, a tick past breaks; the cut reads the line, dated at the since-shock extreme", () => {
    expect([at([LINE - 0.01]), at([LINE + 0.01])]).toEqual([false, true]);
    expect(hybridLine(wave([LINE]), 96, "high", dateAt(68))).toEqual({ line: LINE, ext: PEAK, extDate: dateAt(70), turn: HOLD });
    expect(hybridCut(wave([LINE]), "high", dateAt(68))).toEqual({ value: LINE, date: dateAt(70) });
  });

  it("no turn yet (the close right after the extreme): the line is the extreme — a new since-shock extreme breaks, a tick under holds", () => {
    const c = series([...spreadWave(80, 1, PEAK, HOLD, [], 0), PEAK + 0.01]);
    expect(hybridLine(c, 71, "high", dateAt(68))).toEqual({ line: PEAK, ext: PEAK, extDate: dateAt(70), turn: null });
    expect([hybridBreak(c, 71, "high", dateAt(68)), hybridBreak(series([...spreadWave(80, 1, PEAK, HOLD, [], 0), PEAK - 0.01]), 71, "high", dateAt(68))]).toEqual([true, false]);
  });

  it("a retest that ties the extreme becomes the extreme (latest on a tie): the next close's line restarts at it, so a close past the old HALF line holds", () => {
    const c = wave([PEAK, LINE + 0.01]);
    expect(hybridLine(c, 97, "high", dateAt(68))).toEqual({ line: PEAK, ext: PEAK, extDate: dateAt(96), turn: null });
    expect(hybridBreak(c, 97, "high", dateAt(68))).toBe(false);
  });

  it("low side mirrored: the line sits HALF of the way down from the bounce to the trough", () => {
    const c = (last: number): Pt[] => series(ratioWave(25, [last]));
    const line = ratioBounce() + HALF * (RATIO_TROUGH - ratioBounce());
    const lo = (last: number) => ((s) => hybridBreak(s, s.length - 1, "low", guardAnchor(s, true)))(c(last));
    expect(guardAnchor(c(line), true), "premise: the ratio's episode is open").toBe(openShockStart(c(line)));
    expect(guardAnchor(c(line), true)).not.toBeNull();
    expect([lo(line + 0.001), lo(line - 0.001)]).toEqual([false, true]);
  });

  it("no start, a close at/before it, the switch off or the shock closed → null (the caller's rolling read)", () => {
    const c = wave([LINE + 0.01]);
    // close 69 (81) is the first after the start: hybrid, and over the since-start extreme (close 68's 79)
    expect([hybridBreak(c, 96, "high", null), hybridBreak(c, 68, "high", dateAt(68)), hybridBreak(c, 69, "high", dateAt(68))]).toEqual([null, null, true]);
    const closed = wave([LINE + 0.01, 79]);
    expect([guardAnchor(c, false, K), shockOf(closed, K)?.open, guardAnchor(closed, true, K)]).toEqual([null, false, null]);
  });
});
