/**
 * Shared ladder read forms (jobs) — a pure leaf: no imports, so every leg's probe can call it. Forms move here
 * verbatim; per-leg calibrations stay in the probes.
 */

/** Any close row — a probe's `Pt` satisfies it structurally. Read as `c[i]!.value!` (the probes' `v()`): callers pass finals only. */
export type Close = { value: number | null };
/** A close row with its date — what `offHigh` reports the high's date from; every probe `Pt` satisfies it. */
export type Dated = Close & { date: string };
export type Side = "high" | "low";
/** `speed` knobs: z of own Δn over the trailing `window`, quiet once z < `zMax` for `quiet` consecutive closes. */
export type SpeedParams = { n: number; window: number; zMax: number; quiet: number };

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
/** Sample sd (n − 1) — the same estimator as the scorer's σ (`velocitySigmaZSeries`, domain-fold.ts). */
const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, x) => acc + (x - m) ** 2, 0) / (a.length - 1));
};

/** z of the Δn at close `i` against the sample sd of the prior Δn over the trailing `window`; null on short history or a flat window. */
export function speedZ(c: readonly Close[], i: number, p: Pick<SpeedParams, "n" | "window">): number | null {
  if (i < p.n + 2) return null;
  const dn = (k: number): number => c[k]!.value! - c[k - p.n]!.value!;
  const hist: number[] = [];
  for (let k = Math.max(p.n, i - p.window); k < i; k++) hist.push(dn(k));
  const s = sd(hist);
  return s > 0 ? dn(i) / s : null;
}

/** Consecutive closes ending at the last one that pass `ok`, counted up to `need`. */
export function quietRun(c: readonly Close[], need: number, ok: (i: number) => boolean): number {
  let n = 0;
  for (let i = c.length - 1; n < need && i >= 0 && ok(i); i--) n++;
  return n;
}

/** z at the last close + the quiet streak (`speedZ < zMax`, a null z breaks it) capped at `quiet`. */
export function speedQuiet(c: readonly Close[], p: SpeedParams): { z: number | null; got: number } {
  const ok = (i: number): boolean => {
    const z = speedZ(c, i, p);
    return z !== null && z < p.zMax;
  };
  return { z: speedZ(c, c.length - 1, p), got: quietRun(c, p.quiet, ok) };
}

/**
 * `relative` form A: is close `i` a new `n`-close extreme — strictly above the max (`"high"`) / below the min (`"low"`) of the
 * `n` closes BEFORE it, `c.slice(i − n, i)`. `guard: true` is the EU-Fin convention (`i >= n &&`, false on short history);
 * `guard: false` is the Value / S&P IT / Semis convention, kept verbatim: with `i < n` the slice is empty when `c.length ≥ n`
 * (→ `Math.max()` = −∞ → true) and a clamped non-empty prefix when `c.length < n`. Every unguarded caller gates on length first.
 */
export function newExtreme(c: readonly Close[], i: number, n: number, side: Side, o: { guard: boolean }): boolean {
  if (o.guard && !(i >= n)) return false;
  const w = c.slice(i - n, i).map((p) => p.value!);
  return side === "high" ? c[i]!.value! > Math.max(...w) : c[i]!.value! < Math.min(...w);
}

/** spit's yen escalation gate (`probe-spit-tranches.ts` ESC_JPY_N/ESC_JPY_DROP defaults): USD/JPY ≤ −`drop`
 *  off its `n`-close high. ONE source — the F17 detail chart draws the same line off it (`chart-rail.ts`). */
export const SPIT_YEN_GATE = { n: 60, drop: 0.03 } as const;

/** semis' move / vxsmh escalation reads (`probe-semis-tranches.ts` ESC_VOL_MED_N × ESC_MOVE_MED_K / ESC_VOL_MED_K).
 *  ONE source — retune HERE; the R6 / VXSMH median lines draw off it (`chart-rail.ts` MOVE_MEDIAN / VOL_MEDIAN). */
export const SEMIS_MOVE_MEDIAN = { window: 250, mult: 1.3 } as const;
export const SEMIS_VOL_MEDIAN = { window: 250, mult: 1.2 } as const;

/** The extreme close (latest on a tie) of the `pts` given, with its date; null when empty. */
export const extremeOf = (pts: readonly Dated[], side: Side): { value: number; date: string } | null =>
  pts.reduce<{ value: number; date: string } | null>((m, p) => (m === null || (side === "high" ? p.value! >= m.value : p.value! <= m.value) ? { value: p.value!, date: p.date } : m), null);
/** The max / min of the `n` closes before the newest — the line a new `n`-close high / low crosses. */
export const priorExt = (c: readonly Dated[], n: number, side: Side): { value: number; date: string } | null => (c.length > n ? extremeOf(c.slice(-n - 1, -1), side) : null);

/** `relative` form B: the last close against the max of the trailing `n` closes INCLUDING it (first max wins a tie); null on an empty series. */
export function offHigh(c: readonly Dated[], n: number): { dd: number; high: number; highDate: string } | null {
  const w = c.slice(-n);
  if (!w.length) return null;
  const top = w.reduce((a, b) => (b.value! > a.value! ? b : a));
  return { dd: w.at(-1)!.value! / top.value! - 1, high: top.value!, highDate: top.date };
}

/** A shock's peak and pre-shock base — `scripts/ladder-shock.ts` `Shock` satisfies it. */
export type Peaked = { peak: number; base: number };
/** `recovery` form A: the close a `frac` retrace of the shock reaches. */
export const retraceLine = (sh: Peaked, frac: number): number => sh.peak - frac * (sh.peak - sh.base);
/** Close `i` at or under the retrace `line`; `eps` is the leg's tolerance (Semis / S&P IT `1e-9`, Value / EU-Fin `0`). */
export const retraced = (c: readonly Close[], i: number, line: number, o: { eps: number }): boolean => c[i]!.value! <= line + o.eps;

/** `recovery` form B: close `i` (on/after `since`) is strictly below every close on/after `since` before it — a post-shock low. */
export const postShockLow = (c: readonly Dated[], i: number, since: string): boolean => c[i]!.date >= since && c.slice(0, i).every((p) => p.date < since || p.value! > c[i]!.value!);
/** The lowest close on/after `since`, the newest excluded (latest on a tie); null when none. */
export const lowSince = (c: readonly Dated[], since: string): { value: number; date: string } | null => extremeOf(c.slice(0, -1).filter((p) => p.date >= since), "low");
/** Closes in a row with no post-`since` low, capped at `n`, and that low; null with no `since` or no close on/after it. */
export function noLowRun(c: readonly Dated[], since: string | undefined, n: number): { got: number; low: { value: number; date: string } | null } | null {
  if (since === undefined || !c.some((p) => p.date >= since)) return null;
  return { got: quietRun(c, n, (i) => !postShockLow(c, i, since)), low: lowSince(c, since) };
}

/** `regime` primitives: the mean of the last `n` closes, null short of `n`. */
export const ma = (c: readonly Close[], n: number): number | null => (c.length >= n ? c.slice(-n).map((p) => p.value!).reduce((a, b) => a + b, 0) / n : null);
/** `ma` now and `lag` closes ago. */
export const maPair = (c: readonly Close[], n: number, lag: number): [number | null, number | null] => [ma(c, n), ma(c.slice(0, c.length - lag), n)];
/** The last close minus the one `n` closes before it, null short of `n + 1`. */
export const delta = (c: readonly Close[], n: number): number | null => (c.length > n ? c.at(-1)!.value! - c.at(-1 - n)!.value! : null);
