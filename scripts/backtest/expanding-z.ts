/**
 * Point-in-time (expanding-window) z-score — the look-ahead-clean elevation
 * measure the credit-into-replay wiring needs (2026-06-30 credit→calibration
 * wireback plan, Stage 1a / Option 3).
 *
 * A straight TypeScript port of the now-deleted `harness.py`'s `expanding_z` (Welford running
 * mean/variance): `z_t = (v_t − mean_{<t}) / sd_{<t}`, computed strictly from
 * PRE-t observations, so the value on day t is exactly the threshold a live run
 * would have seen that day — no in-sample leakage. The replay folds the harness's
 * own measured cuts back into itself only via convention/point-in-time legs
 * (`replay.ts` look-ahead guard), and this is the point-in-time one.
 *
 * The value pins live OUTSIDE `expanding-z.test.ts` — it holds only the point-in-time
 * invariants, having dropped its fixture-parity test as circular (it read INPUT and
 * GOLDEN from a fixture this same function emitted, so it could not fail). The one
 * non-circular anchor is `emit-scoring-constants.test.ts` (emitted output == a hand-kept
 * golden; the Python parity anchors were deleted with the harness 2026-08-15).
 *
 * `NaN` until two prior observations exist (sample sd undefined with <2 points),
 * mirroring the Python `count > 1` gate. Callers gate on `Number.isFinite`.
 */
export function expandingZ(values: readonly number[]): number[] {
  const n = values.length;
  const z = new Array<number>(n).fill(NaN);
  let mean = 0;
  let m2 = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (count > 1) {
      // SAMPLE sd (n−1), computed incrementally from Welford's `m2` — deliberately NOT
      // `lib/stats.ts`'s `sd`, which is POPULATION (n) and needs the whole array; the divisor
      // and the streaming shape are both pinned by the `emit-scoring-constants.test.ts` golden (docblock above).
      const sd = Math.sqrt(m2 / (count - 1));
      if (sd > 0) z[i] = (v - mean) / sd;
    }
    count += 1;
    const delta = v - mean;
    mean += delta / count;
    m2 += delta * (v - mean);
  }
  return z;
}
