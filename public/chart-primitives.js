/*
 * chart-primitives.js — DOM-free SVG primitive cluster for the Zone D detail charts.
 *
 * Extracted verbatim from app.js so the detail-chart render layer (detail-chart.js)
 * is unit-testable in a Node/vitest environment (no jsdom). Nothing here touches
 * `document`/`window` or module-external globals — pure consts + string builders.
 */

import { scale } from "./sparkline.js";

// --- Color is state, everywhere. Single source. ----------------------------
export const STATE_COLORS = {
  GREEN: "var(--state-green)",
  AMBER: "var(--state-amber)",
  RED: "var(--state-red)",
};

// The alert ladder's own colour ramp (OK/WATCH/WARNING/CRITICAL). It lives beside
// STATE_COLORS rather than in app.js because BOTH the ladder chart (ladder-chart.js) and
// app.js's accent/favicon paint read it — one table, two consumers, same rule as STATE_COLORS:
// a colour CONSTANT may reach only CSSOM or an SVG attribute, never a markup style attribute.
export const ALERT_COLORS = {
  OK: "var(--alert-ok)",
  WATCH: "var(--alert-watch)",
  WARNING: "var(--alert-warning)",
  CRITICAL: "var(--alert-critical)",
};

// The single-letter state glyph carried on every state dot (paired with STATE_COLORS
// so a bubble is never colour-only). Single source here; consumed by app.js (zone-C
// cards; VT is the one card with a bespoke glyph).
export const STATE_LETTER = { GREEN: "G", AMBER: "A", RED: "R" };

// Human phrase per winning OR-leg (SeriesPointDTO.leg) for the detail-ribbon tooltip:
// explains WHICH leg drove a cell's state so a RED whose plotted value sits inside the
// drawn effective line reads as intentional (an EVT/regime-z or off-axis velocity leg
// fired, not the drawn level/velocity cut). Absent leg ⇒ tooltip stays "date + state".
//
// KEY GRAMMAR (mirrors src/domain-legs.ts): a key is a single leg id, or a COMPOSITE — two or
// more leg ids joined by `+` in LEG_ORDER order, as the backend synthesizes when an AND-fold
// fires on several legs. Composite entries are wording OVERRIDES, not a requirement: render
// through `legPhrase` below and an unlisted composite still reads correctly.
export const LEG_PHRASE = {
  op: "level cut",
  evt: "EVT tail",
  z: "regime-z",
  "vel-op": "velocity cut",
  "vel-evt": "velocity EVT",
  "vel-z": "velocity-z",
  "vel-z-fast": "fast velocity-z",
  "vel-z-slow": "slow velocity-z",
  "vel-cusum": "sustained drift",
  "op+vel-op": "wide and widening",
};

// The ONE renderer for a served `leg` token — hand-kept mirror of `legPhrase` in
// src/domain-legs.ts (a browser module cannot import from `src/`): table hit wins; otherwise
// split on `+`, map each part through LEG_PHRASE (unmapped part ⇒ the raw part) and join with
// " and ". Every FE wording surface (ribbon tooltip, scorer legend, member-chip badge) routes
// here, so a future composite leg needs no table entry on either side.
export function legPhrase(leg) {
  const hit = LEG_PHRASE[leg];
  if (hit !== undefined) return hit;
  return String(leg)
    .split("+")
    .map((part) => LEG_PHRASE[part] ?? part)
    .join(" and ");
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// Currency units are a PREFIX symbol on a 2-dp amount (the Xetra legs' EUR closes), unlike the
// "%" suffix. Kept as a set so a future "$" leg needs no formatter change.
const CURRENCY_UNITS = new Set(["€", "$"]);

/** `%` -> 2 dp suffix; currency -> symbol + 2 dp; unitless -> ~4 sig figs; missing -> em dash. */
export function formatValue(value, unit) {
  if (value == null) return "-";
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (CURRENCY_UNITS.has(unit)) return `${unit}${value.toFixed(2)}`;
  return value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

/**
 * Magnitude formatter for a bare reading/threshold: 2 decimals, widened to ~3 significant
 * figures ONLY when 2dp would lose all signal (|v| < 0.005) — CG's HG÷GC ≈ 0.0019 otherwise
 * renders the false "0.00".
 *
 * ⚠ SAME RULE, second implementation by necessity, NOT a second rule: the server-side original
 * is `formatMagnitude` in `src/notify_format.ts` (which carries the reasoning). No production
 * `public/*.js` module imports from `src/` — the browser loads these files unbundled — so the
 * rule is re-stated here rather than shared. Change one, change both.
 */
export function formatMagnitude(value) {
  if (value !== 0 && Math.abs(value) < 0.005) {
    return value.toFixed(2 - Math.floor(Math.log10(Math.abs(value))));
  }
  return value.toFixed(2);
}

/** Derived-axis formatter: a "%" unit means the value is a FRACTION (-0.15) to
 *  render as a percent (-15.0%); anything else is shown to ~4 sig figs. */
export function formatDerived(value, unit) {
  if (value == null) return "-";
  if (unit === "%") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

// --- SVG chart frame geometry (shared by ladder + detail charts) ------------
export const DETAIL_LIMIT = 510; // observation dates pulled for the detail chart — pinned === family-descriptor DETAIL_WINDOW (chart-primitives.test.js)
// The detail tab's `5y` window chip (trading days). The ONE chip wider than DETAIL_LIMIT: it EXPANDS
// the fetch + draw past each id's own window instead of tightening it. Stored depth decides how much
// actually paints — EU-Fin's and Semis' legs + top seats seed 5y, bar a seat whose source is younger (src/backfill-depth.ts EUFIN_/SEMIS_BACKFILL_YEARS).
export const LONG_WINDOW = 1260;

// SVG chart frame (user units; CSS scales width to 100%). Generous left margin
// for y-labels, bottom margin for x-dates + (detail) the state ribbon.
// Width is deliberately UNCHANGED — the viewBox renders at width:100%, so only the aspect
// ratio (and thus the on-screen height) moves; `h` gives detail charts room to separate cut lines.
export const CH = { w: 680, h: 300, ml: 50, mr: 16, mt: 14, mb: 34 };
/** Squat detail-compare frame (≥1 compare slot filled): same margins, h 170; ribbon stays RIBBON_H. */
export const COMPACT_CH = { ...CH, h: 170 };
/** Stack plot-band height — the ONE knob if the band should later shrink. */
export const STACK_PLOT_H = 122;
const stackMt = 4,
  stackMb = 18; // mb floor: ribbon at mt+plotH+4 with RIBBON_H below leaves 2 units slack
/** Margin-lane model. A rotated (-90) label's glyph band runs ~[x - 0.78·size, x + 0.22·size] —
 *  ascenders toward -x — so a 9px name occupies ~[x-7, x+2]; `NAME_BAND_L`/`NAME_BAND_R` are that
 *  band, and `LANE_GAP` the clearance every pair of lanes keeps. One model, used by both margins
 *  and by the tests that pin the lanes, so no lane x is ever justified by eye. */
export const NAME_BAND_L = 7,
  NAME_BAND_R = 2,
  LANE_GAP = 2;
/** Modelled width of a right-anchored y-tick label: 7 glyphs of 10px tabular digits (~6 units
 *  each) — "-12.34%", the longest string the live formatters produce for a percent or level axis.
 *  ⚠ NOT a hard bound: `formatValue`'s 4-significant-figure branch can reach 8-9 glyphs on a
 *  sub-unit ratio ("0.001881"), which still grazes the axis-name lane. Sizing `ml` for THAT costs
 *  another ~12 units of plot width on every stack chart, which the rare case does not earn. */
export const TICK_LABEL_W = 42;
/** x of the rotated stack name, the innermost left lane. */
export const STACK_NAME_X = 11;
/** x of the rotated PRIMARY-axis name — its own lane just right of the chart name, still inside
 *  `ml`. Derived from the band model so the two lanes cannot touch. */
export const STACK_AXIS_X = STACK_NAME_X + NAME_BAND_R + LANE_GAP + NAME_BAND_L;
/** Flush stack frame (compare/leg stacks): the chart's name is drawn ROTATED in the left margin,
 *  centred on the primary axis (`showHead` — chartOpen emits it; renderers drop the bottom axis-x
 *  dates and carry the date span in their legend instead). `mt` is bare top padding, not a head
 *  band: a 3- or 5-chart stack pays no per-chart height for its own name. */
export const STACK_CH = {
  ...CH,
  mt: stackMt,
  mb: stackMb,
  h: stackMt + STACK_PLOT_H + stackMb,
  showHead: true,
  // Wider than CH's 50, and DERIVED, not eyeballed: the left margin carries three lanes — chart
  // name, primary axis name, then the y-tick labels right-anchored at `ml - 8`. `ml` is whatever
  // pushes a modelled tick's left edge clear of the axis-name lane. At CH's 50 a tick printed
  // straight over both rotated names.
  ml: STACK_AXIS_X + NAME_BAND_R + LANE_GAP + TICK_LABEL_W + 8,
  // Wider than CH's 16: the right margin carries TWO rotated labels (the mirrored chart name at
  // `stackNameRightX`, then the secondary-axis name at `w - 3`), and at mr=16 the name's own glyph
  // band reached back over the plot edge and printed on the last few samples. Costs plot WIDTH
  // only — `h` is untouched, so a 5-chart stack still fits one screen.
  mr: 28,
};
/** Mirror of the left-margin chart name in the RIGHT margin — the same name repeated so a phone
 *  pinch-zoomed into the right half of the plot still has the chart's identity on screen. Its own
 *  inset, NOT `STACK_NAME_X`: this lane is squeezed between the plot edge (`w - mr`) and the
 *  secondary-axis name at `w - 3`, and only clears both at STACK_CH's wider `mr`.
 *  ⚠ It also shares x with `genericSingle`'s moving-cut chip lane (`geo.ml + plotW + 2`, whose
 *  2-glyph chips run rightward into this band). That overlap is the SAME one the secondary axis
 *  name already accepts: the chips carry a `--bg` halo and are emitted last, so the chip stays
 *  readable over either label. Widening `mr` to separate them costs plot width the case (an
 *  R7-shaped moving-cut id, inside a stack) does not earn. */
export const STACK_NAME_RIGHT_INSET = 15;
export const stackNameRightX = (g = CH) => g.w - STACK_NAME_RIGHT_INSET;
/** Plot width/height for a geometry (default = the shared CH frame). */
export const plotW = (g = CH) => g.w - g.ml - g.mr;
export const plotH = (g = CH) => g.h - g.mt - g.mb;
export const PLOT_W = plotW();
export const PLOT_H = plotH();
export const RIBBON_H = 12; // detail-chart state ribbon, drawn inside the bottom margin
/** Top edge of that ribbon — 4 units under the plot floor, inside the bottom margin. The ONE
 *  definition of where the colour bar starts: `stateRibbon` draws from it and app.js's
 *  `paintChip` parks the travelling readout directly above it, so the two can never drift. */
export const ribbonTop = (g = CH) => g.mt + plotH(g) + 4;
/** Baseline of a rotated axis NAME: 2 units INSIDE the plot floor. Rotated -90 and
 *  anchored `start` (CSS, `.axis-name`), the text runs bottom-up FROM here, so both axis names sit
 *  flush with the bottom of the plot while the chart name stays vertically centred. */
export const axisNameY = (g = CH) => g.mt + plotH(g) - 2;

/** User units between the travelling readout chip's BOTTOM edge and the state ribbon's top edge
 *  (`ribbonTop`). ONE definition — app.js's `paintChip` and `parkY` below both derive the floor
 *  from it, so the pinned chip and the parking walk can never disagree on where the floor sits. */
export const CHIP_LIFT = 2;

/**
 * Pure vertical park for the travelling readout chip: returns the chip's TOP y in the plot's user
 * units. DOM-free (no SVG/DOM APIs), so it unit-tests without jsdom.
 *
 * The FLOOR is the preferred, STABLE park: the chip's bottom edge sits `CHIP_LIFT` above the state
 * ribbon (`floor = ribbonTop(geo) - CHIP_LIFT`), so a scrubbing finger never drags the readout up
 * and down the plot — the exact instability the floor pin was chosen to remove. parkY only LEAVES
 * the floor when the floor band (`floorTop .. floor`, one chip tall) is occupied by a drawn line at
 * the hovered column: then it walks the gaps between the sorted occupied y's (with the frame top and
 * the floor as sentinels) and centres the chip in the WIDEST gap that fits `chipH + 4`. No gap fits
 * ⇒ back to the floor pin, where the chip's opaque backdrop wins the overlap.
 *
 * `ys` = every drawn series/band y at the hovered column, unioned by the caller with the chart's
 * static band y's. The ribbon band (`ribbonTop .. + RIBBON_H`) is always EXCLUDED territory — it
 * sits below the floor sentinel, so it can never be a candidate gap.
 */
export function parkY({ ys, geo = CH, chipH }) {
  const floor = ribbonTop(geo) - CHIP_LIFT; // chip bottom can descend no further
  const floorTop = floor - chipH; // the pinned chip's TOP y
  const top = geo.mt; // plot frame top — the upper walk sentinel
  // In-frame occupied lines only (strictly between the frame top and the floor); a null/NaN y,
  // or a y already at/below the floor, contributes nothing to the walk.
  const occ = (ys ?? [])
    .filter((y) => Number.isFinite(y) && y > top && y < floor)
    .sort((a, b) => a - b);
  // Floor band CLEAR ⇒ the stable pin (chip bottom at the floor).
  if (!occ.some((y) => y >= floorTop)) return floorTop;
  // Floor band occupied ⇒ walk the gaps between consecutive occupied y's, framed by top and floor.
  const need = chipH + 4; // 2px padding above and below the chip
  let best = null;
  let prev = top;
  for (const y of [...occ, floor]) {
    const gap = y - prev;
    if (gap >= need && (best === null || gap > best.gap)) best = { gap, center: prev + gap / 2 };
    prev = y;
  }
  if (best) return best.center - chipH / 2;
  return floorTop; // nothing fits — fall back to the floor pin, opaque backdrop wins
}

/** x for sample i of n, spread across the plot (single sample → centered). */
export const xAt = (i, n, g = CH) => g.ml + (n <= 1 ? plotW(g) / 2 : (i / (n - 1)) * plotW(g));
/** y for value v in [lo, hi], inverted so high sits near the top. */
export const yAt = (v, lo, hi, g = CH) => g.mt + (plotH(g) - scale(v, lo, hi, 0, plotH(g)));

/** Client x → SVG user x, letterbox-corrected (the `xMidYMid meet` viewBox centres the drawing
 *  inside a wider rect). The ONE inverse `scrubIndex` builds on. */
export function userXAt(clientX, rect, g = CH) {
  const drawnW = Math.min(rect.width, rect.height * (g.w / g.h));
  const xPad = (rect.width - drawnW) / 2;
  return ((clientX - rect.left - xPad) / drawnW) * g.w;
}

/** Inverse of xAt: client x → reading index in [0, n-1], letterbox-corrected. */
export function scrubIndex(clientX, rect, n, g = CH) {
  const userX = userXAt(clientX, rect, g);
  return Math.max(0, Math.min(n - 1, Math.round(((userX - g.ml) / plotW(g)) * (n - 1))));
}

/** The sole `<svg>` opener. On a `showHead` geometry (STACK_CH) with `head = { name }`, the chart's
 *  name is written ROTATED (bottom-up) in the left margin, centred on the primary axis — margin
 *  width the frame already spends, so a stacked chart costs no extra height to be named, and
 *  MIRRORED in the right margin (`stackNameRightX`) so a phone pinch-zoomed into the right half
 *  of the plot still sees which chart it is looking at. The
 *  first→last dates it used to sit beside now ride the chart's legend (`spanLegend`). */
export function chartOpen(label, g = CH, head = null) {
  const open = `<svg class="chart" viewBox="0 0 ${g.w} ${g.h}" width="100%"
      preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}">`;
  if (!g.showHead || !head) return open;
  const cy = (g.mt + plotH(g) / 2).toFixed(1);
  const rx = stackNameRightX(g);
  const name = esc(head.name);
  return `${open}
    <text class="chart-name" x="${STACK_NAME_X}" y="${cy}" text-anchor="middle"
      transform="rotate(-90 ${STACK_NAME_X} ${cy})">${name}</text>
    <text class="chart-name" x="${rx}" y="${cy}" text-anchor="middle"
      transform="rotate(-90 ${rx} ${cy})">${name}</text>`;
}

/** Initially-hidden pointer-readout group (crosshair + dot + backdropped text).
 *  `top`/`height` default to `geo`'s plot frame (geo defaults to CH); pass both to overlay a
 *  chart with its own vertical geometry (exposure-replay-chart's price panel). */
export function hoverLayer({ geo = CH, top = geo.mt, height = plotH(geo), chip = false } = {}) {
  // `chip` swaps the corner-pinned `hover-read` pair for a group that RIDES the crosshair, so the
  // readout is on screen under browser pinch-zoom. Opt-in, not the default: replay-chart.js,
  // exposure-replay-chart.js and lab.js's two painters querySelector(".hover-read") and would
  // null-throw — they inherit the chip in S5, on their own terms.
  const read = chip
    ? `<g class="hover-chip">
      <rect x="0" y="0" width="0" height="0" rx="2" />
      <text x="0" y="0" text-anchor="start"></text>
    </g>`
    : `<rect class="hover-read-bg" x="${geo.ml + 2}" y="${top + 1}" height="14" width="0" rx="2" />
    <text class="hover-read" x="${geo.ml + 4}" y="${top + 11}" text-anchor="start"></text>`;
  return `<g class="hover-layer" visibility="hidden">
    <line class="xhair" x1="0" y1="${top}" x2="0" y2="${top + height}" />
    <circle class="hover-dot" r="3.5" />
    ${read}
  </g>`;
}

/** The full pointer readout no longer rides under each chart — it lives in ONE viewport-pinned
 *  bar (`#hover-bar`, static markup in index.html so it survives Zone D's innerHTML re-render;
 *  painted by app.js's `paintBar`). Kept out of the per-chart block deliberately: a `.hover-strip`
 *  under every chart reserved ~55px EACH, which on a 5-chart stack cost ~275px of permanent
 *  whitespace and pushed the stack off one screen. The SVG chip stays the travelling short form.
 *  Nothing is exported here — the bar is markup + CSS, not a generated string. */

/** ISO `YYYY-MM-DD` → the 2-digit-year `YY-MM-DD` a travelling chip carries ([USER], 2026-08-29: the
 *  year-free `MM-DD` form left a scrub across a multi-year window ambiguous). Only the CENTURY is
 *  dropped — 3 glyphs cheaper than the full ISO date, which matters because the chip travels
 *  inside the plot. The full first/last dates stay on the x-axis (or the stack legend's span
 *  clause). A non-ISO string passes through untouched. Lives here, not in detail-chart.js, because
 *  the ladder chart's chip (ladder-chart.js) must read the SAME date form as the detail charts'. */
export const compactDate = (date) => (/^\d{4}-\d{2}-\d{2}/.test(date ?? "") ? date.slice(2, 10) : (date ?? ""));
