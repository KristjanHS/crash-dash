// Worst-of-3 haven-move fold for the bespoke FXH detail chart. The FXH ribbon
// judges the per-point envelope = max(EUR, CHF, JPY) 20-day haven-move, so the
// bold overlaid line must be that exact same max. DOM-free so it's unit-testable
// under vitest (mirrors format.js / ladder-chart.js).
//
// `legs` is a `{ eur, chf, jpy }` object (the point's `havenLegs`); returns the
// single number the ribbon scores against. Caller guards absent `havenLegs`.
export function havenEnvelope(legs) {
  return Math.max(legs.eur, legs.chf, legs.jpy);
}
