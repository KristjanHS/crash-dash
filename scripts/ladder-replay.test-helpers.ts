import { episodes, REPLAY } from "./ladder-replay.js";

/** Zigzag log returns ±CALM_A: σ > 0 so `episodes()` can open, the level never leaves [100·e^−A, 100]. */
export const CALM_A = 1e-4;

/** `n` (≥ REPLAY.VOL_N + 1) closes alternating 100·e^−A / 100, ending on the running high 100 at index n − 1. */
export const calm = (n: number = REPLAY.VOL_N + 1): number[] => Array.from({ length: n }, (_, i) => ((n - 1 - i) % 2 === 0 ? 100 : 100 * Math.exp(-CALM_A)));

/** Vol-normal fixture (`volNormal`, ladder-shock.ts), knobs BASE_N 20 / SIGMA_N 60 / BROKE_SD 3: 300 calm closes 19/21 (pre-shock median 20, 3σ ≈ 6), one spike to VOL_PEAK (its own `shockOf` opens, anchored on close 298),
 *  150 closes 34/36 ending on a rise (the rolling 250-close median 34, the shock still open: never back ≤ base 20), then `tail`. */
export const VOL_PRE_MEDIAN = 20;
export const VOL_PEAK = 40;
export const volShock = (tail: number[] = []): number[] => [...Array.from({ length: 300 }, (_, i) => (i % 2 ? 21 : 19)), VOL_PEAK, ...Array.from({ length: 150 }, (_, i) => (i % 2 ? 36 : 34)), ...tail];

/** Hybrid-guard spread (`shockOf` on BASE_N 20 / SIGMA_N 60 / BROKE_SD 3, `hybridLine` high side): 70 closes `base` ∓ `amp`, wave 1 at `peak` (close 70), a hold ×`holdN` over base (the shock stays open, anchored on close 68), then `tail`. */
export const spreadWave = (base: number, amp: number, peak: number, hold: number, tail: number[], holdN = 25): number[] => [...Array.from({ length: 70 }, (_, i) => (i % 2 ? base + amp : base - amp)), peak, ...Array.from({ length: holdN }, () => hold), ...tail];

/** Hybrid-guard ratio (`openShockStart` → `episodes()`, `hybridLine` low side): calm() to its high 100, an exit at RATIO_TROUGH, a bounce ×`n` at `ratioBounce()` (half the episode's RISE: it stays open), then `tail`. */
export const RATIO_TROUGH = 99;
export const ratioBounce = (): number => RATIO_TROUGH * (1 + episodes([...calm(), RATIO_TROUGH].map((value, i) => ({ date: new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), value })), { ...REPLAY, FROM: "" }).at(-1)!.rise / 2);
export const ratioWave = (n: number, tail: number[]): number[] => ((b) => [...calm(), RATIO_TROUGH, ...Array.from({ length: n }, () => b), ...tail])(ratioBounce());
