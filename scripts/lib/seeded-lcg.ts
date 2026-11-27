/**
 * Seeded deterministic randomness for committed synthetic fixtures — one source shared by
 * `scripts/golden-regen.ts` (golden observations) and `scripts/backtest/synth-fixtures.ts`
 * (backtest price/FX fixtures). Pure integer arithmetic, so every Node version reproduces the
 * same stream byte-for-byte.
 */

/** Seeded LCG in [0,1). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 32-bit FNV-1a of `str` — derives a per-series sub-seed from its name. */
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = ((h ^ str.charCodeAt(i)) * 16777619) >>> 0;
  }
  return h;
}

/** Per-series stream: the global `seed` mixed with the series name (golden-regen's derivation). */
export function seriesRand(seed: number, name: string): () => number {
  return lcg((seed * 2654435761 + fnv1a(name)) >>> 0);
}
