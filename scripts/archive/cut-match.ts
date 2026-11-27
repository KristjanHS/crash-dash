/**
 * cut-match.ts — percentile-preserving cut selection for `probe-danger-cut-percentile.ts --engine=share`.
 * Pure; a separate module only because the probe loads the store at top level and cannot be imported.
 */
import { ledgerBand } from "./ledger-band.js";
import type { State } from "../../src/domain-types.js";

type Cuts = Readonly<{ amber: number; red: number }>;

/** Fraction of `arr` strictly below `cut` — exactly the GREEN-side share `ledgerBand`'s `>=` bands under it. */
export function fracBelow(arr: readonly number[], cut: number): number {
  return arr.length ? arr.filter((x) => x < cut).length / arr.length : NaN;
}

/** Samples sitting exactly at `v` (e.g. the gp term pinned at the input amber). */
export function massAt(arr: readonly number[], v: number): number {
  return arr.filter((x) => x === v).length;
}

export interface CutMatch {
  cut: number;
  /** `fracBelow(arr, cut)` at the chosen cut. */
  fracBelow: number;
}

/** The cut above `floor` whose `fracBelow` on `arr` is closest to `target`. Candidates = each distinct value
 *  plus 1 (a cut between two values bands like the upper one, so these are every reachable split); tie ⇒ lower. */
export function matchCut(arr: readonly number[], target: number, floor = -Infinity): CutMatch {
  const candidates = [...new Set([...arr, 1])].filter((v) => v > floor).sort((a, b) => a - b);
  let best: CutMatch = { cut: NaN, fracBelow: NaN };
  for (const cut of candidates) {
    const f = fracBelow(arr, cut);
    if (Number.isNaN(best.cut) || Math.abs(f - target) < Math.abs(best.fracBelow - target)) best = { cut, fracBelow: f };
  }
  return best;
}

/** G/A/R share (0–1) of `arr` banded by `ledgerBand` at `cuts`. */
export function bandSplit(arr: readonly number[], cuts: Cuts): Record<State, number> {
  const t: Record<State, number> = { GREEN: 0, AMBER: 0, RED: 0 };
  for (const v of arr) t[ledgerBand(v, cuts)]++;
  const n = arr.length || 1;
  return { GREEN: t.GREEN / n, AMBER: t.AMBER / n, RED: t.RED / n };
}

/** Converged ⇔ every band's share is within `tolPp` percentage points of the reference split. */
export function splitConverged(a: Record<State, number>, ref: Record<State, number>, tolPp = 1): boolean {
  return (["GREEN", "AMBER", "RED"] as const).every((b) => Math.abs(100 * (a[b] - ref[b])) <= tolPp);
}
