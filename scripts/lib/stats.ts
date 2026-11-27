/**
 * Shared descriptive statistics for `scripts/` probes.
 *
 * Every function here was lifted VERBATIM from the probe copies it replaces — the point of
 * the module is to stop the copies drifting, not to improve them. Where the copies had
 * already drifted, BOTH forms survive under distinct names (see `quantile*` and `median*`);
 * silently collapsing them would move a printed number in some probe, which is the one
 * outcome a consolidation may not cause.
 *
 * ⚠ These are presentation/summary helpers. A probe's *control arm* — the thing under
 * measurement — stays in-probe as a literal.
 */

/** Arithmetic mean. Empty → NaN (`0/0`), matching every call site this replaced. */
export const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** POPULATION standard deviation (divides by `n`, not `n-1`) — the form both copies used. */
export const sd = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

/** Median; empty → NaN. Sorts a copy — the input is not mutated. */
export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Median with an empty → `null` contract, used where the caller distinguishes "no
 * observations" from "computed NaN" (`probe-db-lead-core.ts`, `f1-percentile-cuts.ts`).
 */
export const medianOrNull = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : median(xs);

/**
 * Nearest-rank quantile over an ALREADY-SORTED array.
 * Picks an actual observation; never interpolates.
 */
export const quantileNearest = (sorted: readonly number[], q: number): number =>
  sorted.length === 0
    ? NaN
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/**
 * Linearly-interpolated quantile over an ALREADY-SORTED array — `probe-leader-split.ts`'s
 * form. Differs from `quantileNearest` off the exact ranks; the two are NOT interchangeable
 * and the split is deliberate, not an oversight to be tidied away.
 */
export const quantileLinear = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/**
 * Pearson correlation over the first `min(|a|,|b|)` pairs. The truncation is the form 4 of
 * the 5 copies used; `probe-bund-eurc.ts` assumed equal length and is left on its own copy
 * rather than have this one silently change its denominator.
 */
export const pearson = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.min(a.length, b.length);
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db);
};

/**
 * Fractional (average) ranks, 1-based, ties sharing the mean of the ranks they span.
 * `[10, 20, 20, 30]` → `[1, 2.5, 2.5, 4]`. `spearman`'s transform; the average-rank tie rule is
 * what keeps a tied cross-section from inventing an ordering. Exported only so `stats.test.ts` can
 * pin the tie block directly — `spearman` is its sole production caller.
 *
 * ⚠ NOT NaN-safe on its own: the sort comparator returns NaN for a NaN operand and the tie test
 * `===` is false for NaN, so every NaN would take a DISTINCT rank and `pearson` would then return a
 * perfectly plausible finite number. `spearman` therefore rejects non-finite input before calling
 * here — see its docblock. Never call this directly on unfiltered data.
 */
export const averageRanks = (xs: readonly number[]): number[] => {
  const order = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const ranks = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const r = (i + j) / 2 + 1; // 1-based mean rank over the tie block [i, j]
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = r;
    i = j + 1;
  }
  return ranks;
};

/**
 * Spearman rank correlation over the first `min(|a|,|b|)` pairs — `pearson` on the average-rank
 * transform of each arm, so it inherits that function's truncation contract.
 *
 * **Returns `NaN` when EITHER arm has zero rank variance** — every value in that arm tied, hence
 * every rank identical — and for `n < 2`. It is never the case that only the x arm can produce a
 * `NaN`; a caller counting non-finite returns may not label them a property of one arm.
 *
 * **PINNED: throws on a non-finite input** (`NaN` / `±Infinity` in either arm, inside the truncated
 * window). The alternative was measured and rejected: `averageRanks` gives each `NaN` a distinct
 * rank (its comparator returns `NaN`, its `===` tie test is false), so a silent, entirely plausible
 * finite rho would flow into measured prose. In a helper whose output is quoted as evidence, a
 * fabricated number is the worse failure — filter the arms at the call site. Pinned by
 * `stats.test.ts`.
 */
export const spearman = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.min(a.length, b.length);
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  for (const v of [...x, ...y])
    if (!Number.isFinite(v))
      throw new Error(
        `spearman: non-finite input (${v}) — averageRanks would give it a distinct rank and return a ` +
          `plausible finite rho. Filter the arms to finite values at the call site.`,
      );
  return pearson(averageRanks(x), averageRanks(y));
};

/** `0.1234` → `"12.3%"`. Takes a SHARE (0–1), not an already-scaled percentage. */
export const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** Two-decimal `pct`, for sub-1% shares where one decimal collapses distinct counts. */
export const pct2 = (share: number): string => `${(share * 100).toFixed(2)}%`;

/** `n/d` as a percentage, with an em-dash for a zero denominator. */
export const pctOf = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

/** 4dp fixed, printing `"NaN"` rather than `"NaN.0000"` for a non-finite input. */
export const fmt4 = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : "NaN");

/** Frequency table, descending by count — the `count()` helper several probes declare inline. */
export const countBy = <T,>(xs: readonly T[]): [T, number][] =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort(
    (a, b) => b[1] - a[1],
  );
