// Leg-chart placement seam for the detail tab's Zone-D leg stack.
//
// Zone D leg mode: `LEG_CHART_ID` maps each leg to its ONE indicator chart id, placed at a persisted,
// user-movable stack position. Pure + DOM-free; storage is PASSED IN (no `localStorage` global).
//
// Hand-kept (the FE cannot import TS at runtime); `leg-chart.test.js` pins keys both ways and every
// value against `legCloseId`/`offLadderLegCloseId` (Value ⇒ `XDEV`) and the registry.

import { TOP_N } from "./leg-top.js";

/** Leg → its indicator chart id: `legCloseId` (`LEGP_*`) EXCEPT Value, which charts the raw `XDEV`
 *  row (never `LEGP_VALUE`). Keys = `LADDER` ∪ `OFF_LADDER_LEGS`; never hand-edit one side alone. */
export const LEG_CHART_ID = {
  Semis: "LEGP_SEMIS",
  "S&P IT": "LEGP_SPIT",
  EM: "LEGP_EM",
  Value: "XDEV",
  "S&P 500": "LEGP_SPX",
  "ex-US": "LEGP_EXUS",
  "EU-Fin": "LEGP_EUFIN",
  Health: "LEGP_HEALTH",
  Staples: "LEGP_STAPLES",
  // Off-ladder (OFF_LADDER_LEGS, leg-top.js) — mirror of offLadderLegCloseId.
  Commodities: "LEGP_COMMOD",
  "AW Fundam": "LEGP_RAFI",
};

/** The valid leg-chart positions, `[1 .. TOP_N + 1]` — the stack holds `TOP_N` members plus the leg,
 *  so there are `TOP_N + 1` slots. Derived from `TOP_N` (never a literal 9): a seat-count change to
 *  `leg-top.js` moves this too. */
export const LEG_CHART_POSITIONS = Array.from({ length: TOP_N + 1 }, (_, i) => i + 1);

/** localStorage key for the persisted leg-chart position. Exported so the wiring site and the tests
 *  name it once (never a restated literal). */
export const LEG_CHART_POS_KEY = "dash.legChartPos";

/**
 * Build the ordered stack of slots with the leg chart inserted at 1-based `pos`.
 *
 * @param {string[]} ids  the member indicator ids, in stack order (`TOP_N` of them).
 * @param {unknown} pos   1-based target slot for the leg. Clamped to `1..ids.length + 1`; a
 *   non-integer, NaN, null or undefined `pos` falls back to 1.
 * @returns {Array<{ kind: "leg" } | { kind: "indicator", id: string }>}
 *   `ids.length + 1` slots: exactly one `{ kind: "leg" }` at the resolved position, the members in
 *   their given order filling the rest.
 */
export function placeLegChart(ids, pos) {
  const max = ids.length + 1;
  // Non-integer / NaN / null / undefined ⇒ 1; otherwise clamp into 1..max.
  let p = Number.isInteger(pos) ? pos : 1;
  if (p < 1) p = 1;
  if (p > max) p = max;
  const slots = [];
  let next = 0; // index into ids for the non-leg slots
  for (let slot = 1; slot <= max; slot++) {
    slots.push(slot === p ? { kind: "leg" } : { kind: "indicator", id: ids[next++] });
  }
  return slots;
}

/**
 * Read the persisted leg-chart position, defaulting to 1.
 *
 * @param {{ getItem: (k: string) => string | null }} storage  a Storage-like (passed in, never the
 *   global) — a blocked/throwing accessor is caught.
 * @returns {number} the stored position when it is a valid `LEG_CHART_POSITIONS` member; otherwise 1
 *   (missing, blocked, out of range, or non-numeric).
 */
export function readLegChartPos(storage) {
  try {
    const n = Number(storage.getItem(LEG_CHART_POS_KEY));
    if (Number.isInteger(n) && LEG_CHART_POSITIONS.includes(n)) return n;
  } catch {
    // blocked (private mode / disabled storage) ⇒ fall through to the default
  }
  return 1;
}

/**
 * Persist a leg-chart position; a no-op for an invalid `n` and for a throwing storage.
 *
 * @param {{ setItem: (k: string, v: string) => void }} storage  Storage-like (passed in).
 * @param {unknown} n  the position to store — written only when it is a `LEG_CHART_POSITIONS` member.
 */
export function writeLegChartPos(storage, n) {
  if (!Number.isInteger(n) || !LEG_CHART_POSITIONS.includes(n)) return;
  try {
    storage.setItem(LEG_CHART_POS_KEY, String(n));
  } catch {
    // blocked storage ⇒ swallow; the position simply won't survive the reload
  }
}
