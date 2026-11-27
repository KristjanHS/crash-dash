/*
 * Tiny inline-SVG chart primitives — no dependency, no build (repo charter).
 *
 * Shared by the Zone D detail/ladder charts (M4): a couple of pure functions that
 * turn arrays of numbers into SVG geometry.
 * Everything here is stateless and returns a string the caller drops into
 * innerHTML — same data-down discipline as app.js.
 */

/** [min, max] of a numeric array; [0, 1] for an empty array (avoids /0). */
export function extent(nums) {
  if (nums.length === 0) return [0, 1];
  let lo = nums[0];
  let hi = nums[0];
  for (const n of nums) {
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  return [lo, hi];
}

/**
 * Map a value from a domain to a pixel range. A zero-width domain (all points
 * equal) maps to the range midpoint so a flat series draws as a centered line
 * rather than collapsing to an edge or dividing by zero.
 */
export function scale(v, d0, d1, r0, r1) {
  if (d1 === d0) return (r0 + r1) / 2;
  return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** Build an SVG path `d` from [x, y] pixel points ("M … L …"). */
export function pathD(points) {
  return points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
}

/** `pathD`'s staircase variant (`ChartSeries.style: "step"`): each hop holds the prior y to the new x, then rises. */
export function stepPathD(points) {
  return points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : `L${x.toFixed(1)} ${points[i - 1][1].toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)}`))
    .join(" ");
}
