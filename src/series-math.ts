/**
 * Series math leaf — bounds-checked index access for the pure core.
 *
 * ZERO imports: the sink of the scorers-* / domain-* stack, below `domain-types.ts`.
 *
 * Why: a bad index throws, so `degrade()` drops the
 * feed with a recorded event instead of `xs[i]!` letting `undefined` → NaN score a silent GREEN.
 */

/**
 * `xs[i]`, or a `RangeError` naming the index and length when `i` is not an integer in
 * `[0, xs.length)`. `ArrayLike` so typed arrays (`Float64Array` prefix sums) pass too.
 */
export function at<T>(xs: ArrayLike<T>, i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) {
    throw new RangeError(`index ${i} out of range [0, ${xs.length})`);
  }
  return xs[i] as T;
}
