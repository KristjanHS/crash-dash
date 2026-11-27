/**
 * Exposure-dial view seam (slice E1). PURE, IO-free projection of the
 * /api/exposure ExposureResponse into small view models — the tile-members.js /
 * scoreboard-card.js pattern: exported pure functions, NO module-level DOM /
 * localStorage / fetch side effects, so vitest collects it with no jsdom.
 *
 * exposure.js (the untested thin shell) fetches /api/exposure, calls these, and
 * writes the models into the DOM. The one invariant these functions enforce: a
 * DEGRADED response (posture null) never renders as a confident Core — it always
 * reads "warming up" for the headline and "degraded" for the affected chip.
 */

/** Posture → CSS tone token. A MIRROR of `Posture` in src/exposure.ts, which the
 *  browser cannot import; `exposure-view.test.js` imports `EQUITY_PCT` and asserts
 *  key-set equality in BOTH directions, so a posture added upstream goes red here rather
 *  than silently falling through to "Warming up", and a removed one can't leave a dead key.
 *  Exported for that test only. */
export const POSTURE_TONE = {
  Full: "full",
  Core: "core",
  Reduced: "reduced",
  Defensive: "defensive",
};

/** Posture headline model: { label, tone, detail }. Null posture (degraded / empty DB)
 *  → the honest "warming up", never a fabricated Core. tone is a CSS token.
 *  `detail` carries the equity weight — the number the user actually acts on — read
 *  off the response's own `equityPct`, never re-derived from a mirrored weight table
 *  (a second copy of EQUITY_PCT here could drift into a false notify-visible number). */
export function renderPosture(resp) {
  const posture = resp && resp.posture;
  const tone = POSTURE_TONE[posture];
  if (!tone) return { label: "Warming up", tone: "warming", detail: "" };
  const pct = resp.equityPct;
  return {
    label: posture,
    tone,
    detail: pct === null || pct === undefined ? "" : `${pct}% equity`,
  };
}

/** 1 → "1st", 92 → "92nd", 11–13 → "th" (mirrors src/exposure.ts ordinal). */
function ordinal(n) {
  const t = n % 10, h = n % 100;
  return `${n}${t === 1 && h !== 11 ? "st" : t === 2 && h !== 12 ? "nd" : t === 3 && h !== 13 ? "rd" : "th"}`;
}

/** Percentile fraction (0..1) → "34th pct", or the flat-window / n/a fallbacks. */
function pctLabel(percentile) {
  if (percentile === null || percentile === undefined) return "flat window";
  return `${ordinal(Math.round(percentile * 100))} pct`;
}

/** F1 OAS ROC (in %, so 0.50 = +50bp) over the SERVED window → "+50bp/30d", or n/a.
 *
 *  ⚠ The window is `resp.thresholds.armRocWindow` (= `ARM_ROC_WINDOW`, src/registry-fred.ts), never a
 *  literal here. A retune of `ARM_ROC_WINDOW` must move EVERY number on the page, this readout included.
 *  An older/degraded payload with no thresholds block therefore renders the bare "+50bp" — the
 *  window is simply not said, rather than said wrongly from a typed fallback. */
function rocLabel(roc, window) {
  if (roc === null || roc === undefined) return "ROC n/a";
  const bp = Math.round(roc * 100);
  const per = window === null || window === undefined ? "" : `/${window}d`;
  return `${bp >= 0 ? "+" : ""}${bp}bp${per}`;
}

/** maSpread fraction (0.032 = +3.2%) → "+3.2% vs MA200", or n/a. */
function spreadLabel(maSpread) {
  if (maSpread === null || maSpread === undefined) return "n/a vs MA200";
  const pct = maSpread * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs MA200`;
}

/**
 * Chip footnotes (R1). Each key answers three questions, in this order: WHAT it is →
 * WHICH thresholds drive it → WHY only these metrics.
 *
 * ⚠ The middle line is built ENTIRELY from `resp.thresholds` — the cuts arrive on the wire
 * from `EXPOSURE_THRESHOLDS` (src/exposure.ts) and this file holds NO numeric copy of any
 * cut. That is the seam ruling, and `exposure-view.test.js` pins it by
 * reading the constants off the engine and asserting they appear in the rendered text.
 *
 * ⚠ The WHY lines explain the CHOICE OF METRIC and never the VALUE of a threshold — a number
 * spelled out in prose there would rebuild the exact drift class the seam ruling kills. The
 * suite guards it: the why strings must contain no digits at all.
 */
const ARM_WHAT = "What it is: is credit stressed?";
const FIRE_WHAT = "What it is: has the global equity trend broken?";

/** Rationale for the two-key design (credit ARMS, trend FIRES) plus one line per rejected candidate. */
const ARM_WHY =
  "Why only this: credit is the universal deflation leader - high-yield spreads widened ahead of " +
  "every episode in the study set, and the turn leads while the level lags. The candidates left out: " +
  "macro-cycle leaders (OECD CLI) are context only, since their lead is measured to output-gap turns " +
  "and never to equity drawdowns; funding stress and bank relative strength are left out entirely - " +
  "candidates for the credit family later, not shipped anywhere today; curve re-steepening velocity " +
  "is display-only. Every extra key here is another hand-tuned rule with no out-of-sample evidence.";
const FIRE_WHY =
  "Why only this: price is the coincident confirmation credit alone cannot give - in fast shocks the " +
  "leading families never fire before the drop, so the dial needs a trend key to act. The candidates " +
  "left out: rotating equity flavours (defensive sectors, high-dividend) is not a key, because pairwise " +
  "correlations converge in a crash and only cutting TOTAL equity defends; volatility and cross-asset " +
  "stress stay off this dial, where isolated spikes manufactured rungs on the Lab's ladder.";

/** OAS points (0.5) → "+50bp". Formats a SERVED cut; never a literal of its own. */
function cutBpLabel(points) {
  const bp = Math.round(points * 100);
  return `${bp >= 0 ? "+" : ""}${bp}bp`;
}

/** ARM threshold line — every number in it comes off `resp.thresholds`. Empty (so the line
 *  collapses) when an older/degraded payload carries no thresholds block. */
export function armCutsLine(thresholds) {
  const t = thresholds;
  if (!t) return "";
  return (
    `Thresholds: arms at rank ≥ ${pctLabel(t.armLevelPct)} of its trailing ` +
    `${t.armRangeWindow}-day window, or widening ≥ ${cutBpLabel(t.armRocBp)}/${t.armRocWindow}d; ` +
    `releases below ${pctLabel(t.armReleasePct)}; approaching from ` +
    `${cutBpLabel(t.armRocApproachBp)}/${t.armRocWindow}d.`
  );
}

/** FIRE threshold line: the fire edge is GT's own resolved band (no literal to serve), the
 *  pre-alert cushion above it is the one served number. */
export function fireCutsLine(thresholds) {
  const t = thresholds;
  if (!t) return "";
  return (
    "Thresholds: fires when GT's resolved band scores the ACWI-vs-MA200 spread non-GREEN; " +
    `approaching while the spread sits within ${Math.round(t.fireMaApproachSpread * 100)}pp above that cut.`
  );
}

/** ARM key chip model: { label, tone, detail, asOf, what, cuts, why }. tone ∈ quiet | approaching | armed | degraded.
 *  Degraded (too little F1 history) reads "data insufficient", never quiet.
 *  Precedence: degraded > armed > approaching (the pre-alert tier, E3 Stage 3.2) > quiet. */
export function armChipModel(resp) {
  const arm = (resp && resp.arm) || {};
  // The footnote is explanatory copy: it rides EVERY state, degraded included — a reader
  // looking at "data insufficient" still needs to know what the key measures.
  const foot = { what: ARM_WHAT, cuts: armCutsLine(resp && resp.thresholds), why: ARM_WHY };
  if (arm.degraded) {
    return { label: "ARM: credit", tone: "degraded", detail: "data insufficient", asOf: asOfLabel(arm.asOf), ...foot };
  }
  return {
    label: "ARM: credit",
    tone: arm.armed ? "armed" : arm.approaching ? "approaching" : "quiet",
    detail: `${pctLabel(arm.percentile)} · ${rocLabel(arm.roc, resp && resp.thresholds && resp.thresholds.armRocWindow)}`,
    asOf: asOfLabel(arm.asOf),
    ...foot,
  };
}

/** FIRE key chip model: { label, tone, detail, asOf, what, cuts, why }. tone ∈ intact | approaching | broken | degraded.
 *  Degraded (missing GT decision) reads "data missing", never intact.
 *  Precedence: degraded > broken > approaching (the pre-alert tier, E3 Stage 3.2) > intact. */
export function fireChipModel(resp) {
  const fire = (resp && resp.fire) || {};
  const foot = { what: FIRE_WHAT, cuts: fireCutsLine(resp && resp.thresholds), why: FIRE_WHY };
  if (fire.degraded) {
    return { label: "FIRE: trend", tone: "degraded", detail: "data missing", asOf: asOfLabel(fire.asOf), ...foot };
  }
  return {
    label: "FIRE: trend",
    tone: fire.fired ? "broken" : fire.approaching ? "approaching" : "intact",
    detail: spreadLabel(fire.maSpread),
    asOf: asOfLabel(fire.asOf),
    ...foot,
  };
}

/** ONE KEY's own as-of date → "as of 2026-07-16", or the honest dash when null.
 *  ⚠ Takes a DATE, not the response — each chip prints its OWN key's date, ALWAYS,
 *  and there is no page-level shared `as of` line. The two
 *  keys read different feeds and are routinely a day apart; `derivePreviousExposure`
 *  documents the same asymmetry, so the skew is signal. A date shown only on
 *  divergence would teach the reader nothing in the calm case. */
export function asOfLabel(date) {
  return date ? `as of ${date}` : "as of -";
}

/** Default episode-picker selection (Rung C1): the MOST RECENT episode by
 *  `start` — explicitly NOT "first chip", so the chronological (oldest-first)
 *  picker order never changes which episode opens. Returns its id, or null on
 *  an empty list. ISO date strings compare chronologically. */
export function defaultEpisodeId(episodes) {
  let latest = null;
  for (const ep of episodes || []) {
    if (ep && ep.start && (!latest || ep.start > latest.start)) latest = ep;
  }
  return latest ? latest.id : null;
}

/** Whole-page view model — one entry the thin shell can spread onto the DOM. */
export function exposureViewModel(resp) {
  return {
    posture: renderPosture(resp),
    arm: armChipModel(resp),
    fire: fireChipModel(resp),
  };
}
